#!/usr/bin/env bun
/**
 * Round-robin tournament between controller scripts (each pairing plays home
 * and away over N seeds).
 *   bun run tournament [--matches 2] [--json out/tournament.json] a.js b.js c.js …
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { runControllerMatch } from "./controllers.ts";

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const perPair = Number(opt("matches") ?? 2);
const json = opt("json");
const files = argv.length ? argv : ["examples/controllers/blue-possession.js", "examples/controllers/red-counter.js", "examples/controllers/zonal.js", "examples/controllers/chaser.js"];
const teams = files.map((f) => ({ name: basename(f, ".js"), source: readFileSync(f, "utf8") }));
type Row = { p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number; failures: number };
const table = new Map(teams.map((t) => [t.name, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, failures: 0 } as Row]));
const games: Array<{ blue: string; red: string; seed: number; score: string; finished: boolean }> = [];
const t0 = performance.now();
let seed = 1;
for (const a of teams) for (const b of teams) {
  if (a === b) continue;
  for (let k = 0; k < perPair; k++, seed++) {
    const r = await runControllerMatch({ seed, blue: { source: a.source, label: a.name }, red: { source: b.source, label: b.name } });
    const s = r.state.match.score;
    games.push({ blue: a.name, red: b.name, seed, score: `${s.blue}-${s.red}`, finished: r.state.match.period === "fullTime" });
    const A = table.get(a.name)!, B = table.get(b.name)!;
    A.p++; B.p++; A.gf += s.blue; A.ga += s.red; B.gf += s.red; B.ga += s.blue;
    if (s.blue > s.red) { A.w++; B.l++; A.pts += 3; } else if (s.red > s.blue) { B.w++; A.l++; B.pts += 3; } else { A.d++; B.d++; A.pts++; B.pts++; }
    A.failures += r.stats.blue.failures; B.failures += r.stats.red.failures;
    process.stdout.write(`  ${a.name} ${s.blue}–${s.red} ${b.name} (seed ${seed})\n`);
  }
}
const rows = [...table.entries()].sort((x, y) => y[1].pts - x[1].pts || y[1].gf - y[1].ga - (x[1].gf - x[1].ga));
console.log(`\n${"team".padEnd(18)}  P  W  D  L  GF GA  Pts  failures`);
for (const [n, r] of rows) console.log(`${n.padEnd(18)} ${String(r.p).padStart(2)} ${String(r.w).padStart(2)} ${String(r.d).padStart(2)} ${String(r.l).padStart(2)} ${String(r.gf).padStart(3)} ${String(r.ga).padStart(2)} ${String(r.pts).padStart(4)}  ${r.failures}`);
console.log(`\n${games.length} matches · ${games.filter((g) => g.finished).length} finished · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (json) {
  mkdirSync(dirname(json), { recursive: true });
  writeFileSync(json, JSON.stringify({ table: Object.fromEntries(rows), games }, null, 2));
}
if (games.some((g) => !g.finished)) process.exit(1);
