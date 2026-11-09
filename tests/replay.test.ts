import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runControllerMatch } from "@autosoccer/match-runner";
import { hashState, Simulation } from "@autosoccer/sim-core";
import { parseReplay, ReplayPlayer, ReplayRecorder, timelineMarkers, type ReplayFile } from "@autosoccer/telemetry";

const ex = (p: string) => readFileSync(new URL(`../examples/controllers/${p}`, import.meta.url), "utf8");

let cached: ReplayFile | null = null;
async function recorded(): Promise<ReplayFile> {
  if (cached) return cached;
  // First seed (deterministically) whose match has a goal, so goal seeking can be tested.
  let r!: Awaited<ReturnType<typeof runControllerMatch>>;
  for (const seed of [42, 7, 3, 1, 2, 5, 8, 11]) {
    r = await runControllerMatch({ seed, blue: { source: ex("blue-possession.js"), label: "blue-possession.js" }, red: { source: ex("red-counter.js"), label: "red-counter.js" }, record: true });
    if (r.state.match.score.blue + r.state.match.score.red > 0) break;
  }
  cached = JSON.parse(JSON.stringify(r.replay)) as ReplayFile; // through JSON, like a file
  expect(cached.finalHash).toBe(r.finalHash);
  return cached;
}

describe("replay recording + playback", () => {
  it("records versions, seed, config, controller identities, commands, events, decisions, snapshots and hashes", async () => {
    const r = await recorded();
    expect(r).toMatchObject({ format: "autosoccer-replay", formatVersion: 1, engineVersion: "0.3.0", sdkVersion: "1.2.0", result: { period: "fullTime" } });
    expect(r.controllers.blue).toMatchObject({ name: "blue-possession", version: "1.0.0", label: "blue-possession.js" });
    expect(r.controllers.red!.sourceHash).toMatch(/^[0-9a-f]{8}$/);
    expect(r.snapshots[0]!.tick).toBe(0);
    expect(r.snapshots.length).toBe(Math.floor(r.finalTick / 600) + 1);
    expect(r.hashes.length).toBeGreaterThan(240);
    expect(r.decisions.filter((d) => d.team === "blue").length).toBe(2400);
    expect(r.decisions.some((d) => d.mode && d.lines && d.lines.length > 0)).toBe(true);
    expect(r.events.some((e) => e.event.type === "goalScored")).toBe(true);
  }, 120_000);

  it("re-simulates the whole match from the command stream alone and reproduces every recorded hash", async () => {
    const r = await recorded();
    const v = new ReplayPlayer(parseReplay(JSON.stringify(r))).verify();
    expect(v).toMatchObject({ ok: true, initialOk: true, finalOk: true, mismatches: [] });
    expect(v.checked).toBe(r.hashes.length);
  }, 120_000);

  it("seeks to goals and restarts (forward, backward, across snapshots) with state hashes matching the recording", async () => {
    const r = await recorded();
    const p = new ReplayPlayer(r);
    const markers = timelineMarkers(r.events);
    const goals = markers.filter((m) => m.kind === "goal");
    const restarts = markers.filter((m) => m.kind === "restart");
    expect(goals.length).toBeGreaterThan(0);
    expect(restarts.length).toBeGreaterThan(5);
    const expected = new Map(r.hashes.map((h) => [h.tick, h.hash]));
    const targets = [goals[0]!.tick + 1, restarts[3]!.tick + 1, 60, goals[goals.length - 1]!.tick + 1, 0, restarts[1]!.tick + 1, r.finalTick];
    for (const t of targets) {
      const s = p.seek(t);
      expect(s.tick).toBe(t);
      // Compare against a from-scratch replay of the command log…
      expect(hashState(s)).toBe(hashState(Simulation.replay(r.seed, r.commands, t, r.config)));
      // …and, on hash ticks, against the recorded hash.
      const near = Math.floor(t / r.hashEvery) * r.hashEvery;
      expect(hashState(p.seek(near))).toBe(expected.get(near));
    }
    // After seeking to a goal, the state shows it.
    const g = p.seek(goals[0]!.tick + 1);
    expect(g.match.phase).toBe("goalScored");
  }, 120_000);

  it("finds the decision active at any tick, and the timeline lists periods, goals, fouls and restarts", async () => {
    const r = await recorded();
    const p = new ReplayPlayer(r);
    const d = p.decisionAt("blue", 1000)!;
    expect(d.tick).toBeLessThanOrEqual(1000);
    expect(1000 - d.tick).toBeLessThan(6);
    expect(p.decisionAt("red", 0)).toBeNull(); // no decisions during pre-match
    expect(p.decisionAt("red", r.decisions.find((x) => x.team === "red")!.tick)).toBeTruthy();
    const kinds = new Set(timelineMarkers(r.events).map((m) => m.kind));
    for (const k of ["goal", "restart", "period"]) expect(kinds.has(k as never)).toBe(true);
  }, 120_000);

  it("detects tampering and refuses replays from another engine version", async () => {
    const r = await recorded();
    const bad = JSON.parse(JSON.stringify(r)) as ReplayFile;
    const entry = bad.commands.find((e) => e.commands.some((c) => c.type === "kick"))!;
    const kick = entry.commands.find((c) => c.type === "kick") as { power: number };
    kick.power = kick.power > 0.5 ? 0.1 : 0.9;
    const v = new ReplayPlayer(bad).verify();
    expect(v.ok).toBe(false);
    expect(v.mismatches.length).toBeGreaterThan(0);
    expect(() => parseReplay(JSON.stringify({ ...r, engineVersion: "9.9.9" }))).toThrow(/engine 9.9.9/);
    expect(() => parseReplay(JSON.stringify({ ...r, format: "something-else" }))).toThrow(/not an autosoccer replay/);
  }, 120_000);

  it("records controller failures and fallbacks so they can be inspected offline", async () => {
    const m = await runControllerMatch({ seed: 1, blue: { source: ex("adversarial/crashes.js") }, red: { source: ex("dumb.js") }, config: { halfDurationSec: 5 }, record: true });
    const r = m.replay!;
    expect(r.diagnostics.filter((d) => d.team === "blue" && d.kind === "error")).toHaveLength(3);
    expect(r.diagnostics.some((d) => d.kind === "disabled")).toBe(true);
    expect(r.decisions.some((d) => d.team === "blue" && d.status === "fallback")).toBe(true);
    expect(r.controllers.blue!.disabled).toBe(true);
    expect(new ReplayPlayer(r).verify().ok).toBe(true);
  }, 60_000);

  it("the recorder works for any run (no controllers) and snapshots round-trip exactly through JSON", () => {
    const sim = new Simulation(3);
    const rec = new ReplayRecorder(300, 30);
    rec.observe(sim.state);
    for (let i = 0; i < 2000; i++) rec.observe(sim.tick());
    const file = rec.finish({ seed: 3, config: sim.config, state: sim.state, commands: sim.log, engineRejections: [], events: sim.events });
    const back = JSON.parse(JSON.stringify(file)) as ReplayFile;
    for (const snap of back.snapshots) expect(hashState(snap.state)).toBe(file.hashes.find((h) => h.tick === snap.tick)!.hash);
    expect(new ReplayPlayer(back).verify().ok).toBe(true);
  });
});
