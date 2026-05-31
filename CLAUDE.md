# CLAUDE.md — Moosii CMS Content-Generation Backend

## What this is
The content-generation backend for Moosii's CMS (phase 2). Moosii is a parenting-
education mobile app; this backend powers the internal admin tool that creates and
approves the content the app delivers. This service specifically owns AI-assisted
content generation (starting with lesson images, expanding to lesson/quiz content).

It is an INTERNAL ADMIN TOOL: ~3 trusted users, desktop, not a public product.
Priorities, in order: fast to build, easy to maintain, easy to debug. Scale,
concurrency, and hardening against untrusted users are explicitly NOT priorities.
Solo developer who leans on AI assistance and values control, visibility, and
debuggability over managed convenience.

## The founding rule: no BuildShip, ever
The previous CMS used BuildShip (a visual workflow platform) for AI orchestration.
It was abandoned because it was an opaque, hard-to-debug black box. NEVER suggest,
add, or reintroduce BuildShip or any equivalent visual-workflow platform. Everything
is code the developer owns and can read, version, and debug. This is non-negotiable.

## Stack
- Express + TypeScript, deployed on Render (paid Starter tier — must stay warm, not
  the free spin-down tier, because in-process jobs would be orphaned on sleep).
- Supabase: Postgres (data) + Storage (image files). Backend uses the SERVICE-ROLE
  key and intentionally bypasses RLS.
- Build: `npm install && npm run build`; start: `npm start`. Render injects PORT.
- Auto-deploys on push to `main`.

## Architecture: async job pattern
Long AI work (image gen 15–30s, LLM 5–60s, chains 1–3 min) does NOT fit Supabase
Edge Functions, so it lives in this service. The pattern:
- POST /jobs inserts a `queued` row and returns a job_id IMMEDIATELY (202). It does
  NOT hold the connection open while work runs.
- Work runs fire-and-forget in-process (direct kickoff). A stale-job reaper marks
  any job `running` > 10 min as `failed` on startup (handles orphaned jobs from
  restarts). No external queue, no worker process — not needed at this scale.
- Status is tracked on the `jobs` row. Frontend polls (or reads Supabase directly).
- Jobs are WHOLE-UNIT: a job succeeds or fails atomically. On failure, retry the
  whole job. NO partial-resume / step-checkpoint machinery. (If retry cost ever
  becomes painful, that's the signal to consider a durable workflow tool like
  Trigger.dev — but not before.)

## Job granularity
ONE JOB PER IMAGE. "Generate all images for a lesson" (typically 5–8) is a FRONTEND
concern that fans out into N independent jobs. The backend has no concept of a
lesson batch. Each image has its own independent lifecycle (generate, review,
approve/reject, retry) without affecting the others.

(Content-generation jobs are different — a single content job is itself a chained
multi-step bundle; see the content roadmap below.)

## Prompt model: base + overlay
The prompt that an LLM uses to WRITE an image prompt is assembled from two layers,
concatenated and sent together every call:
- BASE (`prompts/base.md`): universal rules — brand aesthetic, color palette
  (#441C44 purple, #FC570D orange, #BEB400 yellow on white/cream), safety rules
  (bare crib, baby on back), no text, no iconography, "depict a scene/moment not a
  symbol", output format, the metadata template.
- OVERLAY (`prompts/topics/{topic_name}.md`): short, topic-specific guidance — WHO
  is in the image by default, emotional register, topic-specific traps to avoid.
  Keyed by `topics.name`. The overlay is NOT a fallback; it's the per-topic nudge
  layered onto the base.
The SEGMENT CONTENT drives the actual scene; base+overlay only shape HOW it's
depicted. Overlays are written/tuned in response to observed failure modes, not all
guessed upfront. v1 may ship with a generic overlay plus a few real ones.

Known prompt history: images regressed from "too busy" to "too sterile" (icon-on-
white-background) because rules for minimalism/single-focal-object/negative-space
compounded. The fix direction is "depict a real moment with people, restraint within
a scene, no iconography." This is empirical tuning work, best done inside the CMS.

## Model abstraction (general, multi-provider, addressed by name)
LLM access is a GENERAL primitive, not image-specific, because content generation
reuses it heavily. Build `getLLMClient(provider)` where provider is
'gemini' | 'openai' | 'anthropic' (extendable) — NOT a single getConfiguredLLM().
Reason: the cross-model critique pipeline needs MULTIPLE providers available
SIMULTANEOUSLY (generate with one, critique with another), so a single swappable
default is insufficient.
- Image prompt-writing is just ONE caller: getLLMClient(process.env.PROMPT_WRITER).
- Content steps call providers by name per step (generate → openai, critique →
  anthropic, etc.).
- Interface shape: generate(instructions, input) -> { text, raw, model, version }.
- `ImageGenerator` stays a SEPARATE interface (prompt -> image bytes); image-gen and
  text-gen are independent swappable concerns.
Both start as Gemini for images. Swapping = new implementation + factory entry + env
var (PROMPT_WRITER, IMAGE_GENERATOR). Every generated artifact (image OR content)
records which provider/model/version and which instruction version produced it —
full provenance, so regressions are diffable. (This black-box recorder is the thing
the BuildShip-era setup lacked.)

## Data model
- `jobs`: id, type (text), status (queued/running/succeeded/failed), input (jsonb),
  result (jsonb), error (jsonb), created_at/started_at/finished_at. Generic across
  job types.
- `content_images`: polymorphic across the content tree — exactly one of lesson_id /
  segment_id / sub_segment_id is set (enforced by check constraint). Holds
  storage_path, status (candidate/approved/superseded/rejected), image_prompt,
  final_prompt, prompt_writer + image_generator name/version, instruction_version
  base/overlay, topic_name (stored as text, not FK, to preserve historical
  accuracy), job_id. A partial unique index enforces at most one `approved` image
  per owner.
- Content hierarchy: lesson → segment → sub_segment. Currently 1:1 lesson:segment
  (may expand later). Existing tables: `lessons`, `segments`, `sub_segments`,
  `topics`, and the quiz tables (questions/answers/responses). The existing image
  column on `sub_segments` stays as the app's "live image" pointer; the backend
  writes to it on approval IN ADDITION to inserting into content_images. The app's
  read path is unchanged.
- (Content phase) A `content_drafts` table — to be designed — mirrors content_images
  (candidate/approved/superseded, prompts + model provenance, approval metadata) and
  holds the draft content BUNDLE until a human approves it.

## Scope
- v1: image management for EXISTING lessons — generate images per SUB-SEGMENT,
  candidate/approve flow, non-destructive (candidates don't overwrite the live image
  until approved; prior images kept as history).
- NOT in v1: questionnaire images, lesson-text generation, quiz generation,
  lesson/segment-level images. The `content_images` table is built to accommodate
  lesson/segment images later, but they're out of scope now.
- During transition the existing FlutterFlow CMS calls this backend (temporary
  frontend); a Vite + React SPA replaces it later. The /jobs and approval API
  contract is designed for the real frontend, not shortcut for FlutterFlow. An
  `auto_approve` flag lets the old CMS skip the candidate step until the review UI
  exists.

## Roadmap beyond v1: content creation (post–image-management)
After image management, this backend absorbs the remaining BuildShip content
flows. Same architecture as images — same job runner, same candidate/approve
lifecycle, same versioned-prompts-with-provenance discipline. The new work is
text-shaped handlers, text prompt files, and multi-step chaining.

### Content generation is a BUNDLE, not a single text blob
Generating a lesson also generates its QUIZ in the same act. A content-generation
job produces:
- Lesson text (sub-segment snippets — small, human-feeling; see voice rules below)
- The quiz: questions, each with multiple answer options, and a per-answer RESPONSE
  shown to the user (the explanation for each correct/incorrect choice).
Current shape: one quiz per lesson (1:1 lesson:segment model). A content job writes
to multiple tables atomically (lesson/sub_segment content + quiz tables); the
candidate/approve lifecycle must cover the whole BUNDLE, not just the prose. The
`content_drafts` table holds the draft bundle until a human approves it.

### The generate → critique → revise pipeline (chained job)
Content generation is multi-step orchestration (the workload the async-job design
was chosen for; ~1–3 min):
1. GENERATE draft with one model (currently ChatGPT) from a tight, structured
   prompt (persona + hard voice constraints).
2. CRITIQUE with a DIFFERENT model (cross-model: each model is blind to its own
   tells) playing an adversarial "skeptical reader who spots AI instantly" role,
   producing specific edits, not vague notes.
3. REVISE per critique.
4. Human does a fast voice + accuracy pass (~60s), then approves.
Add the critique pass only after proving a single strong-prompt generation isn't
enough; measure (blind-rank processed vs. raw) before adding pipeline complexity.
Over-chaining can homogenize output to "smooth" rather than human.

### Making AI content feel human (why this matters)
Goal: content must NOT read as AI — Moosii's audience (tired, emotionally raw new
parents) and the broader anti-AI-content backlash make this a trust issue, not a
nicety. Most of the fix is at the prompt level + a light human "voice pass."
Key prompt moves: specific persona with opinions; one idea per snippet (not
comprehensive); short/varied sentences, fragments OK; ban throat-clearing openers
and hedging phrases ("It's important to," "Many parents find," "At the end of the
day," etc.); make direct claims; concrete/sensory anchors; ~7th-grade conversational
voice. Detailed generation + critique prompts live in a separate May 29 chat — bring
them in when this phase starts; they are the starting point, then tune empirically.

### Risk stratification (content-phase concern, handler-level)
Content is NOT one uniform pipeline. Medical, safety-critical, and emotionally
loaded topics (SIDS, allergic reactions, when-to-call-doctor, car seats, choking,
PPD/PPA, infant loss) require a HIGHER bar: human-written-first with AI for polish
only (the reverse of the default), plus credentialed human review. AI critique
passes catch VOICE, never factual accuracy — never treat "the second AI approved it"
as accuracy review. This likely becomes a `risk_tier` on content jobs that routes
handling. Later concern; noted so it's on the record.

### Disclosure / trust (product decision, not backend)
Leaning toward disclosing AI-assisted drafting + human review, ideally with named
credentialed reviewers ("Reviewed by [name], RN, IBCLC"). Build the trust story
before launch, not after a journalist asks. Not a backend concern, but it shapes
what metadata content rows may need to carry (reviewer identity, review status).

## Secrets discipline (strict)
- `.env` is gitignored and holds real secrets locally. `.env.example` (committed) is
  the empty template.
- The Supabase SERVICE-ROLE key bypasses all RLS — it lives ONLY in `.env` and
  Render env vars. NEVER in code, NEVER committed, NEVER sent to any frontend.
- `INTERNAL_API_KEY` is a shared secret guarding the job/approval endpoints
  (Authorization: Bearer). Frontends must send it; /health is unprotected.
- Always verify staged files before committing — confirm `.env` is excluded.

## Conventions
- Build each piece as a standalone, independently-testable module; compose at the
  end. Test in isolation before wiring together (this is how each build step is
  de-risked).
- Prompt instructions are versioned SOURCE CODE (files in repo), not config.
- Prefer minimal formatting and minimal dependencies. Keep it debuggable.

## Current status
- [x] Schema: `jobs` and `content_images` tables created in Supabase (migration
      001). RLS enabled on both, no policies (service-role bypasses; add a read
      policy when the React frontend needs direct reads).
- [x] Express + TypeScript skeleton, `/health` endpoint, deployed to Render, public
      health check green. Auto-deploy from GitHub `main`.
- [x] Async job system: Supabase client, auth middleware, direct-kickoff runner,
      stale-job reaper, job registry, dummy job type, POST /jobs + GET /jobs/:id.
- [ ] Prompt assembly module (base + overlay → strings) — standalone.
- [ ] LLM client (getLLMClient, Gemini first) — standalone.
- [ ] ImageGenerator (Gemini) — standalone.
- [ ] Storage upload helper — standalone.
- [ ] Full generate_sub_segment_image handler — composition.
- [ ] POST /images/:id/approve.
- [ ] Frontend (FlutterFlow calls during transition; React SPA later).

Update this status section as steps complete.