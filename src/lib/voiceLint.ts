import { supabase } from "../supabase";

// voice_lint_rules is not in database.types.ts (added by migration 012). Untyped
// bridge, same pattern as the other post-0001 reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ---------------------------------------------------------------------------
// Deterministic voice lint: scans generated cards for known AI-tells / overused
// phrases. The RULES live in the DB (voice_lint_rules); this is the ENGINE.
// Advisory only — it returns hits, never throws, and never blocks generation.
// ---------------------------------------------------------------------------

export type LintSeverity = "error" | "warn";

export type LintHit = {
  ruleKey: string;
  type: string;
  severity: LintSeverity;
  card: number;        // 1-based card index; 0 = segment-scope (limit/repeat totals)
  match: string;       // the offending phrase
  count?: number;      // occurrences, for limit / repeat
  message: string;
};

type Rule = {
  rule_key: string;
  type: "ban" | "opener" | "limit" | "conditional" | "repeat";
  pattern: string | null;
  max: number | null;
  scope: "card" | "segment" | null;
  requires: string | null;
  within_chars: number | null;
  min_words: number | null;
  severity: LintSeverity;
  message: string;
};

type LintCard = { title?: string | null; content: string };

// Normalize for matching: straighten curly quotes/apostrophes, collapse
// whitespace, lowercase. (Reporting uses the rule's own pattern text.)
function normalize(s: string): string {
  return s
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-phrase, word-boundary matches of `pattern` in already-normalized `text`.
function phraseRegex(pattern: string): RegExp {
  return new RegExp(`\\b${escapeRe(pattern)}\\b`, "g");
}

function countMatches(text: string, pattern: string): number {
  const re = phraseRegex(pattern);
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function wordsOf(text: string): string[] {
  return text.split(/[^a-z0-9']+/i).filter(Boolean);
}

// Validate a rule row carries the fields its type needs; skip (don't crash) if not.
function isUsable(r: Rule): boolean {
  switch (r.type) {
    case "ban":
    case "opener":      return !!r.pattern;
    case "limit":       return !!r.pattern && typeof r.max === "number" && !!r.scope;
    case "conditional": return !!r.pattern && !!r.requires && typeof r.within_chars === "number";
    case "repeat":      return typeof r.min_words === "number" && r.min_words >= 2;
    default:            return false;
  }
}

const MAX_REPEAT_HITS = 12; // cap noisy generic-repeat output

export function lintCards(cards: LintCard[], rules: Rule[]): LintHit[] {
  const hits: LintHit[] = [];
  // Lint the card BODY only. Titles are short and the tells we target live in the
  // body; including the title would also break `opener` ("starts with") detection.
  const texts = cards.map((c) => normalize(c.content));

  for (const r of rules) {
    if (!isUsable(r)) {
      console.warn(`[voiceLint] skipping malformed rule "${r.rule_key}" (type ${r.type})`);
      continue;
    }
    const pat = r.pattern ? normalize(r.pattern) : "";

    if (r.type === "ban") {
      texts.forEach((t, i) => {
        const n = countMatches(t, pat);
        if (n > 0) hits.push({ ruleKey: r.rule_key, type: r.type, severity: r.severity, card: i + 1, match: r.pattern!, count: n, message: r.message });
      });
    } else if (r.type === "opener") {
      texts.forEach((t, i) => {
        const start = t.replace(/^[\s>#*_-]+/, "");
        if (start.startsWith(pat)) hits.push({ ruleKey: r.rule_key, type: r.type, severity: r.severity, card: i + 1, match: r.pattern!, message: r.message });
      });
    } else if (r.type === "limit") {
      if (r.scope === "segment") {
        const total = texts.reduce((s, t) => s + countMatches(t, pat), 0);
        if (total > (r.max as number)) hits.push({ ruleKey: r.rule_key, type: r.type, severity: r.severity, card: 0, match: r.pattern!, count: total, message: r.message });
      } else {
        texts.forEach((t, i) => {
          const n = countMatches(t, pat);
          if (n > (r.max as number)) hits.push({ ruleKey: r.rule_key, type: r.type, severity: r.severity, card: i + 1, match: r.pattern!, count: n, message: r.message });
        });
      }
    } else if (r.type === "conditional") {
      const req = normalize(r.requires as string);
      const win = r.within_chars as number;
      texts.forEach((t, i) => {
        const re = phraseRegex(pat);
        let m: RegExpExecArray | null;
        while ((m = re.exec(t)) !== null) {
          const after = t.slice(m.index + m[0].length, m.index + m[0].length + win);
          if (!after.includes(req)) {
            hits.push({ ruleKey: r.rule_key, type: r.type, severity: r.severity, card: i + 1, match: r.pattern!, message: r.message });
            break; // one hit per card is enough
          }
        }
      });
    } else if (r.type === "repeat") {
      const n = r.min_words as number;
      const cardsByGram = new Map<string, Set<number>>();
      texts.forEach((t, i) => {
        const w = wordsOf(t);
        for (let k = 0; k + n <= w.length; k++) {
          const gram = w.slice(k, k + n).join(" ");
          if (!cardsByGram.has(gram)) cardsByGram.set(gram, new Set());
          cardsByGram.get(gram)!.add(i);
        }
      });
      let pushed = 0;
      for (const [gram, cardSet] of cardsByGram) {
        if (cardSet.size >= 2) {
          hits.push({ ruleKey: r.rule_key, type: r.type, severity: r.severity, card: 0, match: gram, count: cardSet.size, message: r.message });
          if (++pushed >= MAX_REPEAT_HITS) break;
        }
      }
    }
  }

  return hits;
}

async function loadVoiceRules(): Promise<Rule[]> {
  const { data, error } = await db
    .from("voice_lint_rules")
    .select("rule_key, type, pattern, max, scope, requires, within_chars, min_words, severity, message")
    .eq("is_active", true);
  if (error) {
    console.warn(`[voiceLint] failed to load rules: ${error.message}`);
    return [];
  }
  return (data ?? []) as Rule[];
}

// Load active rules and lint the cards. Never throws — a lint failure must not
// break generation; on any error it returns an empty hit list.
export async function lintSegmentCards(cards: LintCard[]): Promise<LintHit[]> {
  try {
    const rules = await loadVoiceRules();
    if (rules.length === 0) return [];
    return lintCards(cards, rules);
  } catch (err) {
    console.warn(`[voiceLint] lint failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
