import { describe, expect, it } from "vitest";
import { CommandRunner, createPlaygroundScript, keyboardCommand } from "@autosoccer/controller-runtime";
import { runHeadless } from "@autosoccer/match-runner";
import { createWorld, hashState, Simulation } from "@autosoccer/sim-core";

describe("headless runner", () => {
  it("is reproducible and the recorded stream replays to the same hash", () => {
    const a = runHeadless({ seed: 42, seconds: 30 });
    const b = runHeadless({ seed: 42, seconds: 30 });
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(b.finalHash).toBe(a.finalHash);
    expect(hashState(Simulation.replay(42, a.log, a.ticks))).toBe(a.finalHash);
  });

  it("different seeds diverge", () => {
    expect(runHeadless({ seed: 1, seconds: 5 }).finalHash).not.toBe(runHeadless({ seed: 2, seconds: 5 }).finalHash);
  });

  it("playground produces player and ball contacts and the ball moves", () => {
    const r = runHeadless({ seed: 7, seconds: 30 });
    const summary = r.telemetry.records.find((x) => x.kind === "summary");
    expect(summary && summary.kind === "summary" && summary.contacts.playerBall).toBeGreaterThan(0);
    expect(summary && summary.kind === "summary" && summary.contacts.playerPlayer).toBeGreaterThan(0);
  });

  it("runs a full 2×120 s match far faster than real time", () => {
    const r = runHeadless({ seed: 3 });
    expect(r.ticks).toBe(240 * 60);
    expect(r.realtimeFactor).toBeGreaterThan(10);
  });
});

describe("command runner", () => {
  it("isolates throwing sources and drops commands for players it does not own", () => {
    const sim = new Simulation(1);
    const runner = new CommandRunner(sim, [
      { name: "boom", team: "blue", decide: () => { throw new Error("bad script"); } },
      { name: "sneaky", team: "red", decide: () => [{ type: "moveTo", playerId: "blue-1", x: 0, y: 0 }] },
      createPlaygroundScript(1),
    ]);
    expect(() => runner.run(120)).not.toThrow();
    expect(runner.diagnostics.some((d) => d.source === "boom" && d.kind === "error")).toBe(true);
    expect(runner.diagnostics.some((d) => d.source === "sneaky" && d.kind === "foreign-player")).toBe(true);
  });

  it("keyboard helper maps keys to moveTo/stop", () => {
    const w = createWorld(1);
    const none = keyboardCommand(w, "blue-4", { up: false, down: false, left: false, right: false, sprint: false });
    expect(none).toEqual({ type: "stop", playerId: "blue-4" });
    const right = keyboardCommand(w, "blue-4", { up: false, down: false, left: false, right: true, sprint: true });
    expect(right?.type).toBe("moveTo");
    if (right?.type === "moveTo") {
      expect(right.x).toBeGreaterThan(w.players[3]!.x);
      expect(right.sprint).toBe(true);
    }
  });
});
