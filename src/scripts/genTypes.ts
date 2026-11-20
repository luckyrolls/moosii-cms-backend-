import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// npm run gen:types
//
// Regenerates src/types/database.types.ts from the MOOSII schema. Three things this does that a
// one-line pipeline cannot, each of them a trap the repo has already been bitten by:
//
//  1. NEVER REDIRECTS ONTO THE REAL FILE. `cmd > src/types/database.types.ts` truncates the file
//     BEFORE the command runs, so a failed generation leaves nothing behind. Everything happens in
//     a temp dir and the file is replaced only after the output passes the sanity checks below.
//  2. FORMATS. The Supabase CLI stopped formatting its own output: it emits one enormous line per
//     block and prints "format it with oxfmt". Unformatted, the file is unreviewable and every
//     future schema change is an unreadable diff. oxfmt is pinned EXACTLY in devDependencies
//     because a formatter version bump would silently reformat the whole file.
//  3. WRITES CRLF. The committed file is CRLF (core.autocrlf=true, index LF / worktree CRLF); the
//     CLI and oxfmt both emit LF.
//
// Reads MOOSII_DB_URL from .env. Read-only: `gen types` only queries catalogs. The --project-id
// path would need a SUPABASE_ACCESS_TOKEN, which this repo deliberately does not store.

// Both tools are PINNED EXACTLY in devDependencies and invoked as their real Node entry points
// with process.execPath, never through npx or a .bin shim: Node 24 on Windows refuses to spawn a
// .cmd without a shell (EINVAL), and shell:true would concatenate the connection string into a
// command line instead of passing an argv. Pinning also stops an unrelated release from turning
// into a 4000-line diff on someone else's branch — oxfmt because a formatter bump reformats the
// whole file, the CLI because its surrounding helper types have changed shape between versions.
const SUPABASE_BIN = "node_modules/supabase/dist/supabase.js";
const OXFMT_BIN = "node_modules/oxfmt/bin/oxfmt";
const TARGET = "src/types/database.types.ts";

// The output must match all of these, or something went wrong in a way a diff would not make
// obvious (an error page, an empty schema, the wrong database). The key quoting differs between
// CLI versions and between the raw and formatted forms, so each pattern tolerates both.
const MUST_MATCH: Array<[string, RegExp]> = [
  ["the Database type", /export type Database = \{/],
  ["the public schema", /"?public"?\s*:\s*\{/],
  ["the lessons table", /"?lessons"?\s*:\s*\{/],
  ['the "user" table', /"?user"?\s*:\s*\{/],
  ["the reset_test_account RPC (127)", /"?reset_test_account"?\s*:/],
];
const MIN_BYTES = 200_000;

function fail(msg: string): never {
  console.error(`gen:types: ${msg}`);
  process.exit(1);
}

const dbUrl = process.env.MOOSII_DB_URL;
if (!dbUrl) fail("MOOSII_DB_URL is not set (.env)");

for (const bin of [SUPABASE_BIN, OXFMT_BIN]) {
  if (!existsSync(bin)) fail(`${bin} is missing — run \`npm install\` first`);
}

const work = mkdtempSync(join(tmpdir(), "gen-types-"));
const raw = join(work, "database.types.ts");

try {
  console.log("gen:types: generating from MOOSII (read-only) ...");
  const generated = execFileSync(
    process.execPath,
    [SUPABASE_BIN, "gen", "types", "typescript", "--db-url", dbUrl],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );

  for (const [what, re] of MUST_MATCH) {
    if (!re.test(generated)) fail(`generated output is missing ${what} — not written`);
  }
  writeFileSync(raw, generated, "utf8");

  console.log("gen:types: formatting with oxfmt ...");
  execFileSync(process.execPath, [OXFMT_BIN, raw], { stdio: "inherit" });

  const formatted = readFileSync(raw, "utf8");
  if (Buffer.byteLength(formatted) < MIN_BYTES) {
    fail(`formatted output is only ${Buffer.byteLength(formatted)} bytes — refusing to replace ${TARGET}`);
  }
  for (const [what, re] of MUST_MATCH) {
    if (!re.test(formatted)) fail(`formatted output is missing ${what} — not written`);
  }

  // CRLF, to match the committed file.
  writeFileSync(TARGET, formatted.replace(/\r?\n/g, "\r\n"), "utf8");
  console.log(`gen:types: wrote ${TARGET} (${Buffer.byteLength(formatted)} bytes, CRLF)`);
  console.log("gen:types: now run `npx tsc --noEmit` and `npm test`, and read the diff.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
