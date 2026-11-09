#!/usr/bin/env bun
/**
 * bun run replay <file.replay.json[.gz]> [--verify] [--timeline] [--at <tick|goal:N|restart:N>]
 * Loads a replay without running any controller.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { hashState } from "@autosoccer/sim-core";
import { parseReplay, ReplayPlayer, timelineMarkers } from "@autosoccer/telemetry";

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: bun run replay <file.replay.json> [--verify] [--timeline] [--at <tick|goal:N|restart:N>]");
  process.exit(2);
}
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const raw = readFileSync(file);
const replay = parseReplay(file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
const player = new ReplayPlayer(replay);
const fmt = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor((t / 60) % 60)).padStart(2, "0")}`;
const c = replay.controllers;
console.log(`replay    ${file}`);
console.log(`engine    ${replay.engineVersion} · sdk ${replay.sdkVersion} · recorded on ${replay.runtime} · seed ${replay.seed}`);
for (const t of ["blue", "red"] as const) if (c[t]) console.log(`${t.padEnd(9)} ${c[t]!.name}${c[t]!.version ? ` v${c[t]!.version}` : ""} (${c[t]!.label}, source ${c[t]!.sourceHash})`);
console.log(`result    ${replay.result.period} · ${replay.result.score.blue}–${replay.result.score.red} · ${replay.finalTick} ticks`);
console.log(`contents  ${replay.commands.length} command batches · ${replay.events.length} events · ${replay.decisions.length} decisions · ${replay.snapshots.length} snapshots · ${replay.hashes.length} hashes`);
const markers = timelineMarkers(replay.events);
if (process.argv.includes("--timeline")) {
  for (const m of markers.filter((x) => x.kind !== "catch" && x.kind !== "tackle")) console.log(`  ${String(m.tick).padStart(6)}  ${fmt(m.tick)}  ${m.kind.padEnd(8)} ${m.label}`);
}
const at = arg("at");
if (at) {
  let tick = Number(at);
  const m = /^(goal|restart|foul):(\d+)$/.exec(at);
  if (m) {
    const list = markers.filter((x) => x.kind === m[1]);
    const pick = list[Number(m[2]) - 1];
    if (!pick) throw new Error(`no ${m[1]} #${m[2]} (have ${list.length})`);
    tick = pick.tick + 1;
  }
  const t0 = performance.now();
  const s = player.seek(tick);
  const recorded = replay.hashes.find((h) => h.tick === s.tick);
  console.log(`seek      tick ${s.tick} in ${(performance.now() - t0).toFixed(0)} ms → ${s.match.period}/${s.match.phase} ${s.match.score.blue}–${s.match.score.red} ball (${s.ball.x.toFixed(2)}, ${s.ball.y.toFixed(2)}) hash ${hashState(s)}${recorded ? ` (recorded ${recorded.hash} ${recorded.hash === hashState(s) ? "✔" : "✘"})` : ""}`);
}
if (process.argv.includes("--verify")) {
  const t0 = performance.now();
  const v = player.verify();
  console.log(`verify    ${v.ok ? "OK" : "FAILED"} · ${v.checked} hash checkpoints · initial ${v.initialOk ? "✔" : "✘"} · final ${v.finalOk ? "✔" : "✘"} · ${v.mismatches.length} mismatches · ${(performance.now() - t0).toFixed(0)} ms (no controllers executed)`);
  if (!v.ok) {
    console.log(JSON.stringify(v.mismatches.slice(0, 5)));
    process.exit(1);
  }
}
