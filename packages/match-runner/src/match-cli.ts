#!/usr/bin/env bun
/**
 * bun run match --blue examples/controllers/blue-possession.js --red examples/controllers/red-counter.js
 *               [--seed 42] [--verify] [--log] [--record out/match.replay.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashState, Simulation } from "@autosoccer/sim-core";
import { runtimeId } from "@autosoccer/telemetry";
import { runControllerMatch } from "./controllers.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const bluePath = arg("blue") ?? "examples/controllers/blue-possession.js";
const redPath = arg("red") ?? "examples/controllers/red-counter.js";
const recordPath = arg("record");
const seed = Number(arg("seed") ?? 42);
const r = await runControllerMatch({ seed, blue: { source: readFileSync(bluePath, "utf8"), label: bluePath }, red: { source: readFileSync(redPath, "utf8"), label: redPath }, record: !!recordPath });
const m = r.state.match;
console.log(`runtime   ${runtimeId()} · seed ${seed}`);
console.log(`blue      ${r.blue.name}${r.blue.version ? ` v${r.blue.version}` : ""}  (${bluePath})`);
console.log(`red       ${r.red.name}${r.red.version ? ` v${r.red.version}` : ""}  (${redPath})`);
console.log(`result    ${m.period} · blue ${m.score.blue} – ${m.score.red} red · ${r.state.tick} ticks · ${r.wallMs.toFixed(0)} ms`);
for (const t of ["blue", "red"] as const) console.log(`${t.padEnd(9)} ${JSON.stringify(r.stats[t])}`);
const important = r.diagnostics.filter((d) => d.kind !== "engine-rejected" && d.kind !== "invalid-action" && d.kind !== "log");
for (const d of important.slice(0, 20)) console.log(`  [${d.team} t=${d.tick}] ${d.kind}: ${d.message}`);
if (process.argv.includes("--log")) for (const d of r.diagnostics.filter((x) => x.kind === "log").slice(0, 40)) console.log(`  [${d.team} t=${d.tick}] ${d.message}`);
console.log(`hash      ${r.finalHash}`);
if (process.argv.includes("--verify")) {
  const h = hashState(Simulation.replay(seed, r.sim.log, r.state.tick, r.sim.config));
  console.log(`replay    ${h}  ${h === r.finalHash ? "MATCH (no controllers executed)" : "MISMATCH"}`);
  if (h !== r.finalHash) process.exit(1);
}
if (recordPath && r.replay) {
  mkdirSync(dirname(recordPath), { recursive: true });
  const text = JSON.stringify(r.replay);
  writeFileSync(recordPath, text);
  console.log(`replay    ${recordPath} (${(text.length / 1024).toFixed(0)} KB · ${r.replay.snapshots.length} snapshots · ${r.replay.hashes.length} hashes · ${r.replay.events.length} events · ${r.replay.decisions.length} decisions)`);
}
