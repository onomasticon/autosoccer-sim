#!/usr/bin/env bun
/**
 * Blue vs Red batch: N seeded full matches between two controller scripts.
 *   bun run bvr [--matches 100] [--start 1] [--blue …] [--red …] [--json out/bvr.json]
 * Fails (exit 1) on any hang, uncaught error or controller failure.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeId } from "@autosoccer/telemetry";
import { runControllerMatch } from "./controllers.ts";
import type { TeamStats } from "./stats.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const n = Number(arg("matches") ?? 100);
const start = Number(arg("start") ?? 1);
const bluePath = arg("blue") ?? "examples/controllers/blue-possession.js";
const redPath = arg("red") ?? "examples/controllers/red-counter.js";
const blue = readFileSync(bluePath, "utf8");
const red = readFileSync(redPath, "utf8");

const totals: Record<"blue" | "red", Record<string, number>> = { blue: {}, red: {} };
const results = { blueWins: 0, redWins: 0, draws: 0, goals: { blue: 0, red: 0 } };
const problems: string[] = [];
let completed = 0;
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const seed = start + i;
  try {
    const r = await runControllerMatch({ seed, blue: { source: blue }, red: { source: red }, maxTicks: 40_000 });
    const m = r.state.match;
    if (m.period !== "fullTime") problems.push(`seed ${seed}: did not finish (${m.period}/${m.phase} at tick ${r.state.tick})`);
    else completed++;
    for (const d of r.diagnostics) if (["error", "timeout", "out-of-memory", "invalid-output", "disabled"].includes(d.kind)) problems.push(`seed ${seed}: ${d.team} ${d.kind}: ${d.message}`);
    results.goals.blue += m.score.blue;
    results.goals.red += m.score.red;
    if (m.score.blue > m.score.red) results.blueWins++;
    else if (m.score.red > m.score.blue) results.redWins++;
    else results.draws++;
    for (const t of ["blue", "red"] as const) for (const [k, v] of Object.entries(r.profile[t] as TeamStats)) totals[t][k] = (totals[t][k] ?? 0) + v;
  } catch (err) {
    problems.push(`seed ${seed}: uncaught ${String(err)}`);
  }
  if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${n}\n`);
}
const wall = performance.now() - t0;
const mean = (t: "blue" | "red") => Object.fromEntries(Object.entries(totals[t]).map(([k, v]) => [k, +(v / n).toFixed(2)]));
const out = { runtime: runtimeId(), matches: n, completed, problems, results, meanPerMatch: { blue: mean("blue"), red: mean("red") }, wallMs: wall };
console.log(`runtime     ${out.runtime}`);
console.log(`matches     ${n} (seeds ${start}…${start + n - 1})  completed ${completed}  problems ${problems.length}`);
console.log(`results     blue ${results.blueWins} W · ${results.draws} D · ${results.redWins} L red   goals ${results.goals.blue}–${results.goals.red}`);
const rows = ["possession", "passes", "passesCompleted", "avgPassLength", "forwardPassShare", "shots", "shotsOnTarget", "avgShotDistance", "dribbleTouches", "tackles", "interceptions", "keeperCatches", "restartsTaken", "restartFallbacks", "avgTeamHeight", "fouls", "goals"];
console.log(`per match   ${"".padEnd(18)} ${"blue".padStart(8)} ${"red".padStart(8)}`);
for (const k of rows) console.log(`            ${k.padEnd(18)} ${String(out.meanPerMatch.blue[k]).padStart(8)} ${String(out.meanPerMatch.red[k]).padStart(8)}`);
console.log(`wall time   ${(wall / 1000).toFixed(1)} s (${(wall / n).toFixed(0)} ms/match)`);
for (const p of problems.slice(0, 20)) console.log(`  ! ${p}`);
const json = arg("json");
if (json) {
  mkdirSync(dirname(json), { recursive: true });
  writeFileSync(json, JSON.stringify(out, null, 2));
}
if (problems.length || completed !== n) process.exit(1);
