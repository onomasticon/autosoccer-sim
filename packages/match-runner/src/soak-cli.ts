#!/usr/bin/env bun
/** bun run soak [--matches 1000] [--start 1] [--json out/soak.json] */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeId } from "@autosoccer/telemetry";
import { runSoak } from "./soak.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const matches = Number(arg("matches") ?? 1000);
const r = runSoak({ matches, startSeed: Number(arg("start") ?? 1), onProgress: (i) => i % 100 === 0 && process.stdout.write(`  ${i}/${matches}\n`) });
console.log(`runtime        ${runtimeId()}`);
console.log(`matches        ${r.matches}  completed ${r.completed}  deadlocks ${r.deadlocks.length}  uncaught errors ${r.errors.length}`);
for (const [k, v] of Object.entries(r.byMatchup)) console.log(`  ${k.padEnd(14)} ${v.completed}/${v.matches}`);
console.log(`restarts       ${Object.entries(r.restarts).map(([k, v]) => `${k} ${v.taken}+${v.fallback} fallback`).join(" · ")}`);
console.log(`goals ${r.goals} · fouls ${r.fouls} · rejected commands ${r.rejectedCommands} · controller errors ${r.controllerErrors}`);
console.log(`max ticks      ${r.maxTicks}`);
console.log(`wall time      ${(r.wallMs / 1000).toFixed(1)} s (${(r.wallMs / r.matches).toFixed(1)} ms/match)`);
const json = arg("json");
if (json) {
  mkdirSync(dirname(json), { recursive: true });
  writeFileSync(json, JSON.stringify(r, null, 2));
}
if (r.deadlocks.length || r.errors.length) {
  console.error(JSON.stringify({ deadlocks: r.deadlocks.slice(0, 10), errors: r.errors.slice(0, 10) }, null, 2));
  process.exit(1);
}
