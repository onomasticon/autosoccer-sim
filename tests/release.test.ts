import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CommandRunner, createChaosController, createIdleController, createSafeController } from "@autosoccer/controller-runtime";
import { runControllerMatch, runSeriesMatch } from "@autosoccer/match-runner";
import { checkInvariants, createWorld, makeConfig, Rng, Simulation, step, type WorldState } from "@autosoccer/sim-core";

const ex = (p: string) => readFileSync(new URL(`../examples/controllers/${p}`, import.meta.url), "utf8");

describe("simulation invariants (regression)", () => {
  it("hold on every tick for safe / idle / chaos matchups under both clock policies", () => {
    for (const policy of ["running", "stopOnDeadBall"] as const) {
      const cfg = makeConfig({ halfDurationSec: 40, match: { clockPolicy: policy } });
      for (const [i, mk] of [
        () => [createSafeController("blue", cfg), createSafeController("red", cfg)],
        () => [createIdleController("blue"), createSafeController("red", cfg)],
        () => [createChaosController("blue", 5), createChaosController("red", 6)],
      ].entries()) {
        const sim = new Simulation(10 + i, cfg);
        const runner = new CommandRunner(sim, mk());
        let guard = 0;
        while (!sim.clock.finished && guard++ < 30_000) {
          const s = runner.tick();
          const v = checkInvariants(s, cfg);
          if (v.length) throw new Error(`tick ${s.tick}: ${v.join("; ")}`);
        }
        expect(sim.clock.finished).toBe(true);
      }
    }
  }, 60_000);

  it("hold under random engine commands (including debug placements)", () => {
    const rng = new Rng(4);
    let s = step(createWorld(4), [{ type: "debugSetMatch", period: "firstHalf", phase: "openPlay" }]).state;
    const ids = s.players.map((p) => p.id);
    for (let t = 0; t < 4000; t++) {
      const cmds: unknown[] = [];
      if (t % 6 === 0) {
        for (const id of ids) {
          const r = rng.float();
          if (r < 0.3) cmds.push({ type: "moveTo", playerId: id, x: rng.range(-30, 30), y: rng.range(-20, 20), sprint: rng.bool(), dribble: rng.bool() });
          else if (r < 0.45) cmds.push({ type: "kick", playerId: id, dirX: rng.range(-1, 1), dirY: rng.range(-1, 1), power: rng.float() });
          else if (r < 0.5) cmds.push({ type: "tackle", playerId: id });
          else if (r < 0.55) cmds.push({ type: "catch", playerId: id });
        }
        if (rng.bool(0.02)) cmds.push({ type: "debugPlaceBall", x: rng.range(-24, 24), y: rng.range(-15, 15), vx: rng.range(-20, 20), vy: rng.range(-20, 20) });
      }
      s = step(s, cmds).state;
      const v = checkInvariants(s);
      if (v.length) throw new Error(`tick ${s.tick}: ${v.join("; ")}`);
    }
  });

  it("detect corrupted states", () => {
    const w = createWorld(1);
    const bad = (f: (s: WorldState) => WorldState) => checkInvariants(f(JSON.parse(JSON.stringify(w)) as WorldState));
    expect(bad((s) => ({ ...s, ball: { ...s.ball, x: Number.NaN } }))).toContain("ball.x not finite");
    expect(bad((s) => ({ ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, x: 99 } : p)) })).join()).toMatch(/outside the world/);
    expect(bad((s) => ({ ...s, ball: { ...s.ball, heldBy: "blue-4" } }))).toContain("ball held by non-keeper blue-4");
    expect(bad((s) => ({ ...s, match: { ...s.match, phase: "kickIn", restart: null } })).join()).toMatch(/without a restart/);
    expect(bad((s) => ({ ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, x: s.players[0]!.x, y: s.players[0]!.y } : p)) })).join()).toMatch(/overlap/);
  });
});

describe("release batch pieces", () => {
  it("a series match checks completion, invariants, determinism and replay verification", async () => {
    const { summary, replay } = await runSeriesMatch(25, {
      blue: { label: "blue-possession.js", source: ex("blue-possession.js") },
      red: { label: "red-counter.js", source: ex("red-counter.js") },
      determinismEvery: 25,
      replayEvery: 25,
    });
    expect(summary).toMatchObject({ seed: 25, finished: true, deterministic: true, replayVerified: true, failures: [], invariantViolations: [] });
    expect(summary.realtime).toBeGreaterThan(10);
    expect(replay?.finalHash).toBe(summary.hash);
  }, 120_000);
});

describe("docs", () => {
  it("the README's controller snippet runs as-is", async () => {
    const md = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const code = /## Write a controller\n\n```js\n([\s\S]*?)```/.exec(md)?.[1];
    expect(code).toBeTruthy();
    const r = await runControllerMatch({ seed: 3, blue: { source: code! }, red: { source: ex("dumb.js") }, config: { halfDurationSec: 30 } });
    expect(r.state.match.period).toBe("fullTime");
    expect(r.blue.disabled).toBe(false);
    expect(r.stats.blue.kicks).toBeGreaterThan(3);
  }, 60_000);

  it("the tutorial controller in docs/writing-a-controller.md plays a full match cleanly", async () => {
    const md = readFileSync(new URL("../docs/writing-a-controller.md", import.meta.url), "utf8");
    const code = /```js tutorial\n([\s\S]*?)```/.exec(md)?.[1];
    expect(code).toBeTruthy();
    const r = await runControllerMatch({ seed: 7, blue: { source: code!, label: "tutorial" }, red: { source: ex("red-counter.js") } });
    expect(r.state.match.period).toBe("fullTime");
    expect(r.blue.name).toBe("tutorial");
    expect(r.blue.disabled).toBe(false);
    expect(r.diagnostics.filter((d) => d.team === "blue" && ["error", "timeout", "invalid-output", "disabled"].includes(d.kind))).toEqual([]);
    expect(r.stats.blue.kicks).toBeGreaterThan(10);
    expect(r.profile.blue.restartsTaken).toBeGreaterThan(2);
    expect(r.blue.diagnostics.some((d) => d.kind === "log" && d.message.startsWith("tutorial finished"))).toBe(true);
  }, 120_000);
});
