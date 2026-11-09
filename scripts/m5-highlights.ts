/**
 * Finds highlight moments in the seed-42 Blue vs Red match (headless) for the
 * M5 walkthrough. The viewer reproduces the same match bit-for-bit, so the
 * ticks found here are valid in the browser.  bun scripts/m5-highlights.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runControllerMatch } from "@autosoccer/match-runner";
import type { LoggedEvent } from "@autosoccer/sim-core";

const src = (f: string) => readFileSync(new URL(`../examples/controllers/${f}`, import.meta.url), "utf8");
const seed = Number(process.argv[2] ?? 42);
const r = await runControllerMatch({ seed, blue: { source: src("blue-possession.js") }, red: { source: src("red-counter.js") } });
const ev = r.sim.events as LoggedEvent[];
const team = (id: string) => (id.startsWith("blue") ? "blue" : "red");

// Blue pass chain: ≥3 consecutive completed blue passes.
let chain: { start: number; end: number; n: number } | null = null;
{
  let n = 0, start = 0, lastKicker: string | null = null;
  for (const e of ev) {
    const x = e.event;
    if (x.type === "kick") {
      if (team(x.playerId) !== "blue") { n = 0; lastKicker = null; continue; }
      if (n === 0) start = e.tick;
      lastKicker = x.playerId;
    } else if (x.type === "trap" || x.type === "dribbleTouch" || (x.type === "tackle" && x.success)) {
      if (team(x.playerId) === "blue" && lastKicker && x.playerId !== lastKicker) {
        n++;
        if (n >= 3 && (!chain || n > chain.n)) chain = { start, end: e.tick, n };
      } else if (team(x.playerId) === "red") { n = 0; lastKicker = null; }
    } else if (x.type === "ballOut" || x.type === "restartAwarded") { n = 0; lastKicker = null; }
  }
}
// Red counter: red win (interception / tackle won) followed within 5 s by a red shot or a long red pass.
let counter: { win: number; finish: number } | null = null;
for (let i = 0; i < ev.length && !counter; i++) {
  const x = ev[i]!.event;
  const won = (x.type === "trap" && x.interception && team(x.playerId) === "red") || (x.type === "tackle" && x.success && team(x.playerId) === "red");
  if (!won) continue;
  for (let j = i + 1; j < ev.length && ev[j]!.tick - ev[i]!.tick < 300; j++) {
    const y = ev[j]!.event;
    if (y.type === "kick" && team(y.playerId) === "red" && y.speed > 15) { counter = { win: ev[i]!.tick, finish: ev[j]!.tick }; break; }
    if ((y.type === "trap" || y.type === "tackle") && team((y as { playerId: string }).playerId) === "blue") break;
  }
}
// Prefer the counter that produced a red goal: last red ball-win before it.
const redGoal = ev.find((e) => e.event.type === "goalScored" && e.event.team === "red");
if (redGoal) {
  const win = [...ev].reverse().find((e) => e.tick < redGoal.tick && redGoal.tick - e.tick < 600 && ((e.event.type === "trap" && team(e.event.playerId) === "red" && (e.event.interception || true)) || (e.event.type === "tackle" && e.event.success && team(e.event.playerId) === "red") || (e.event.type === "catch" && e.event.success && team(e.event.playerId) === "red")) && !ev.some((o) => o.tick > e.tick && o.tick < redGoal.tick && ((o.event.type === "trap" || o.event.type === "kick" || o.event.type === "dribbleTouch") && team((o.event as { playerId: string }).playerId) === "blue")));
  if (win) counter = { win: win.tick, finish: redGoal.tick };
}
const first = (pred: (e: LoggedEvent) => boolean) => ev.find(pred)?.tick ?? null;
const catchTick = first((e) => e.event.type === "catch" && e.event.success);
const setPiece = first((e) => e.event.type === "restartTaken" && (e.event.restart === "corner" || e.event.restart === "kickIn") && !e.event.fallback);
const setPieceAward = setPiece === null ? null : [...ev].reverse().find((e) => e.tick <= setPiece && e.event.type === "restartAwarded")?.tick ?? null;
const goals = ev.filter((e) => e.event.type === "goalScored").map((e) => ({ tick: e.tick, ...(e.event as object) }));
const secondHalf = first((e) => e.event.type === "sidesSwitched");
const chaseLog = [...r.blue.diagnostics, ...r.red.diagnostics].find((d) => d.kind === "log" && /\((chase|protect)\)/.test(d.message));
const adaptationTick = redGoal && r.sim.events.some((e) => e.event.type === "sidesSwitched" && e.tick < redGoal.tick) ? redGoal.tick + 130 : null;
const out = { seed, adaptationTick, score: r.state.match.score, chain, counter, catchTick, setPieceAward, setPiece, goals, secondHalf, adaptation: chaseLog ? { tick: chaseLog.tick, team: chaseLog.team, message: chaseLog.message } : null, profile: r.profile };
mkdirSync(new URL("../out/", import.meta.url), { recursive: true });
writeFileSync(new URL("../out/m5-highlights.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, profile: undefined }, null, 2));
