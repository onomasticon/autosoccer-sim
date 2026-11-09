/**
 * Golden hashes for cross-runtime determinism. Runs identically under Bun
 * (`bun scripts/golden.ts`) and Node/Vitest (tests/golden.test.ts) and in the
 * browser (walkthrough). `--write` regenerates tests/golden.json.
 */
import { readFileSync } from "node:fs";
import { runControllerMatch, runHeadless } from "@autosoccer/match-runner";

export const GOLDEN_CASES = [
  { seed: 42, seconds: 10 },
  { seed: 7, seconds: 10 },
  { seed: 1, seconds: 240 },
] as const;

export async function computeGolden(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of GOLDEN_CASES) out[`seed=${c.seed},seconds=${c.seconds}`] = runHeadless(c).finalHash;
  // Sandboxed controllers (QuickJS/WASM) must be bit-identical across hosts too.
  const src = (f: string) => readFileSync(new URL(`../examples/controllers/${f}`, import.meta.url), "utf8");
  const m = await runControllerMatch({ seed: 42, blue: { source: src("chaser.js") }, red: { source: src("zonal.js") }, config: { halfDurationSec: 30 } });
  out["controllers:chaser-vs-zonal,seed=42,half=30s"] = m.finalHash;
  // Same pairing with the default config, first 600 ticks (checked in the browser walkthrough too).
  const m600 = await runControllerMatch({ seed: 42, blue: { source: src("chaser.js") }, red: { source: src("zonal.js") }, maxTicks: 600 });
  out["controllers:chaser-vs-zonal,seed=42,ticks=600"] = m600.finalHash;
  return out;
}

const isMain = typeof process !== "undefined" && process.argv[1]?.endsWith("golden.ts");
if (isMain) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const file = new URL("../tests/golden.json", import.meta.url);
  const got = await computeGolden();
  const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
  if (process.argv.includes("--write")) {
    writeFileSync(file, JSON.stringify(got, null, 2) + "\n");
    console.log("wrote", got);
  } else {
    const want = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    let ok = true;
    for (const [k, v] of Object.entries(want)) {
      const match = got[k] === v;
      ok &&= match;
      console.log(`[${runtime}] ${k.padEnd(22)} ${got[k]}  ${match ? "OK" : `MISMATCH (golden ${v})`}`);
    }
    if (!ok) process.exit(1);
  }
}
