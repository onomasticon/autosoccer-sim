#!/usr/bin/env bun
/**
 * Tournaments.
 *
 * Series (default): N seeded full matches between two controllers, spread over
 * parallel worker processes, with per-tick invariant checks, determinism
 * re-runs and verified replays. Writes results.jsonl, summary.json,
 * summary.md and replays/ to --out.
 *
 *   bun run tournament --matches 1000 [--blue …] [--red …] [--workers 6]
 *                      [--start 1] [--out out/tournament] [--determinism-every 25] [--replay-every 100]
 *
 * Round-robin: every listed controller plays every other, home and away.
 *
 *   bun run tournament --round-robin [--matches 2] a.js b.js c.js …
 *
 * Exits non-zero on any hang, controller failure, invariant violation,
 * determinism divergence or replay verification failure.
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runtimeId } from "@autosoccer/telemetry";
import { runControllerMatch } from "./controllers.ts";
import { summarize, type MatchSummary, type SeriesReport } from "./batch.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};

const roundRobin = flag("round-robin");
const matches = Number(opt("matches") ?? (roundRobin ? 2 : 100));
const outDir = resolve(opt("out") ?? "out/tournament");
mkdirSync(outDir, { recursive: true });

if (roundRobin) {
  const files = argv.length ? argv : ["examples/controllers/blue-possession.js", "examples/controllers/red-counter.js", "examples/controllers/zonal.js", "examples/controllers/chaser.js"];
  const teams = files.map((f) => ({ name: basename(f, ".js"), source: readFileSync(f, "utf8") }));
  type Row = { p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number; failures: number };
  const table = new Map(teams.map((t) => [t.name, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, failures: 0 } as Row]));
  const games: Array<{ blue: string; red: string; seed: number; score: string; finished: boolean }> = [];
  let seed = 1;
  for (const a of teams)
    for (const b of teams) {
      if (a === b) continue;
      for (let k = 0; k < matches; k++, seed++) {
        const r = await runControllerMatch({ seed, blue: { source: a.source, label: a.name }, red: { source: b.source, label: b.name } });
        const s = r.state.match.score;
        games.push({ blue: a.name, red: b.name, seed, score: `${s.blue}-${s.red}`, finished: r.state.match.period === "fullTime" });
        const A = table.get(a.name)!, B = table.get(b.name)!;
        A.p++; B.p++; A.gf += s.blue; A.ga += s.red; B.gf += s.red; B.ga += s.blue;
        if (s.blue > s.red) { A.w++; B.l++; A.pts += 3; } else if (s.red > s.blue) { B.w++; A.l++; B.pts += 3; } else { A.d++; B.d++; A.pts++; B.pts++; }
        A.failures += r.stats.blue.failures;
        B.failures += r.stats.red.failures;
        process.stdout.write(`  ${a.name} ${s.blue}–${s.red} ${b.name} (seed ${seed})\n`);
      }
    }
  const rows = [...table.entries()].sort((x, y) => y[1].pts - x[1].pts || y[1].gf - y[1].ga - (x[1].gf - x[1].ga));
  console.log(`\n${"team".padEnd(18)}  P  W  D  L  GF GA  Pts  failures`);
  for (const [n, r] of rows) console.log(`${n.padEnd(18)} ${String(r.p).padStart(2)} ${String(r.w).padStart(2)} ${String(r.d).padStart(2)} ${String(r.l).padStart(2)} ${String(r.gf).padStart(3)} ${String(r.ga).padStart(2)} ${String(r.pts).padStart(4)}  ${r.failures}`);
  writeFileSync(join(outDir, "round-robin.json"), JSON.stringify({ table: Object.fromEntries(rows), games }, null, 2));
  console.log(`\n${games.length} matches · ${games.filter((g) => g.finished).length} finished · results in ${outDir}`);
  process.exit(games.every((g) => g.finished) ? 0 : 1);
}

// ── series ──
const bluePath = opt("blue") ?? "examples/controllers/blue-possession.js";
const redPath = opt("red") ?? "examples/controllers/red-counter.js";
const start = Number(opt("start") ?? 1);
const workers = Math.max(1, Number(opt("workers") ?? Math.max(1, Math.min(8, cpus().length - 2))));
const determinismEvery = Number(opt("determinism-every") ?? 25);
const replayEvery = Number(opt("replay-every") ?? 100);
const spec = {
  blue: { label: bluePath, source: readFileSync(bluePath, "utf8") },
  red: { label: redPath, source: readFileSync(redPath, "utf8") },
  determinismEvery,
  replayEvery,
  checkInvariants: true,
  outDir,
};
const specPath = join(outDir, "spec.json");
writeFileSync(specPath, JSON.stringify(spec));
const seeds = Array.from({ length: matches }, (_, i) => start + i);
console.log(`tournament ${basename(bluePath)} vs ${basename(redPath)} · ${matches} matches (seeds ${start}…${start + matches - 1}) · ${workers} workers · ${runtimeId()}`);

const results: MatchSummary[] = [];
const jsonl: string[] = [];
const t0 = performance.now();
const worker = new URL("./batch-worker.ts", import.meta.url).pathname;
await Promise.all(
  Array.from({ length: workers }, async (_, w) => {
    const mine = seeds.filter((_, i) => i % workers === w);
    if (!mine.length) return;
    const proc = spawn(process.execPath, [worker, specPath, ...mine.map(String)], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<number>((res) => proc.on("close", (c) => res(c ?? 1)));
    let buf = "";
    for await (const chunk of proc.stdout!) {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as MatchSummary;
        results.push(m);
        jsonl.push(line);
        if (results.length % 50 === 0 || results.length === matches) process.stdout.write(`  ${results.length}/${matches} (${((performance.now() - t0) / 1000).toFixed(0)} s)\n`);
      }
    }
    const code = await exited;
    if (code !== 0) console.error(`worker ${w} exited with ${code}`);
  }),
);
results.sort((a, b) => a.seed - b.seed);
const report: SeriesReport = summarize(basename(bluePath), basename(redPath), results, performance.now() - t0);
writeFileSync(join(outDir, "results.jsonl"), jsonl.join("\n") + "\n");
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ runtimeId: runtimeId(), workers, ...report }, null, 2));

const b = report.meanPerMatch.blue, r = report.meanPerMatch.red;
const rows = ["goals", "possession", "passes", "passesCompleted", "avgPassLength", "shots", "shotsOnTarget", "tackles", "interceptions", "keeperCatches", "restartsTaken", "restartFallbacks", "fouls", "avgTeamHeight"];
const md = [
  `# Tournament: ${report.blue} vs ${report.red}`,
  "",
  `- Runtime: ${runtimeId()} · ${workers} workers · seeds ${start}–${start + matches - 1}`,
  `- **Completed ${report.completed}/${report.matches}** · hangs ${report.hangs.length} · controller failures ${report.failures.length} · invariant violations ${report.invariantViolations.length}`,
  `- Determinism re-runs: ${report.determinismChecked} checked, **${report.determinismDiverged.length} diverged** · replays verified: ${report.replaysVerified}, failed: ${report.replaysFailed.length}`,
  `- Results: ${report.blue} ${report.results.blueWins} W · ${report.results.draws} D · ${report.results.redWins} L ${report.red} · goals ${report.results.goals.blue}–${report.results.goals.red}`,
  `- Runtime: ${(report.runtime.totalWallMs / 1000).toFixed(1)} s wall · ${report.runtime.meanMatchMs.toFixed(0)} ms per match per worker · real-time factor mean ${report.runtime.meanRealtime.toFixed(0)}× (min ${report.runtime.minRealtime.toFixed(0)}×)`,
  "",
  `| per match | ${report.blue} | ${report.red} |`,
  "| --- | ---: | ---: |",
  ...rows.map((k) => `| ${k} | ${b[k]} | ${r[k]} |`),
  "",
  "Scorelines: " + Object.entries(report.results.scorelines).sort((x, y) => y[1] - x[1]).map(([s, n]) => `${s} ×${n}`).join(", "),
  "",
];
writeFileSync(join(outDir, "summary.md"), md.join("\n"));
console.log(md.slice(2, 7).join("\n"));
console.log(`per match   ${"".padEnd(18)} ${"blue".padStart(8)} ${"red".padStart(8)}`);
for (const k of rows) console.log(`            ${k.padEnd(18)} ${String(b[k]).padStart(8)} ${String(r[k]).padStart(8)}`);
console.log(`results → ${outDir}/{summary.md,summary.json,results.jsonl,replays/}`);
const ok = report.completed === report.matches && !report.failures.length && !report.invariantViolations.length && !report.determinismDiverged.length && !report.replaysFailed.length;
process.exit(ok ? 0 : 1);
