// Child-process entry for the hang-fix proof: `node --import tsx runCase.ts <before|after> <case>`.
// Prints ONE line of JSON: { ok: true, output } or { ok: false, error: { name, message, trackIds } }.
// A case that hangs never prints — the parent's kill timeout is the observation.

import { cases } from "./fixtures";

async function main() {
  const [, , which, name] = process.argv;
  const input = cases[name];
  if (!input) throw new Error(`unknown case ${name}`);
  const mod = which === "before" ? await import("./generateFullMLP.before") : await import("../generateFullMLP");
  try {
    const output = mod.generateFullMLP(input);
    process.stdout.write(JSON.stringify({ ok: true, output }) + "\n");
  } catch (e) {
    const err = e as Error & { trackIds?: string[] };
    process.stdout.write(JSON.stringify({ ok: false, error: { name: err.name, message: err.message, trackIds: err.trackIds ?? null } }) + "\n");
  }
}

main().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(2);
});
