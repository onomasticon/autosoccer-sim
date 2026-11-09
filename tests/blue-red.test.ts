import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CommandRunner, createSandboxedController } from "@autosoccer/controller-runtime";
import { runControllerMatch } from "@autosoccer/match-runner";
import { hashState, makeConfig, Simulation } from "@autosoccer/sim-core";

const ex = (p: string) => readFileSync(new URL(`../examples/controllers/${p}`, import.meta.url), "utf8");
const BLUE = ex("blue-possession.js");
const RED = ex("red-counter.js");
const FAILURES = ["error", "timeout", "out-of-memory", "invalid-output", "disabled"];

describe("Blue possession vs Red counterattack", () => {
  it("plays complete full matches with every kind of action, deterministically, with no failures", async () => {
    const a = await runControllerMatch({ seed: 42, blue: { source: BLUE }, red: { source: RED } });
    const b = await runControllerMatch({ seed: 42, blue: { source: BLUE }, red: { source: RED } });
    expect(a.state.match.period).toBe("fullTime");
    expect(b.finalHash).toBe(a.finalHash);
    expect(hashState(Simulation.replay(42, a.sim.log, a.state.tick, a.sim.config))).toBe(a.finalHash);
    expect(a.diagnostics.filter((d) => FAILURES.includes(d.kind))).toEqual([]);
    for (const t of ["blue", "red"] as const) {
      const p = a.profile[t];
      expect(p.passesCompleted, `${t} passes`).toBeGreaterThan(3);
      expect(p.shots, `${t} shots`).toBeGreaterThan(0);
      expect(p.tackles + p.interceptions, `${t} defensive actions`).toBeGreaterThan(3);
      expect(p.restartsTaken, `${t} restarts`).toBeGreaterThan(3);
      expect(p.restartFallbacks, `${t} fallbacks`).toBe(0);
    }
    expect(a.profile.blue.keeperCatches + a.profile.red.keeperCatches).toBeGreaterThan(0);
    // Both lifecycle ends were reached.
    for (const c of [a.blue, a.red]) expect(c.lifecycleCalls).toMatchObject({ initialize: 1, onMatchEnd: 1 });
  }, 120_000);

  it("the two teams have clearly different action profiles", async () => {
    const seeds = [1, 2, 3];
    const runs = await Promise.all(seeds.map((seed) => runControllerMatch({ seed, blue: { source: BLUE }, red: { source: RED } })));
    const mean = (t: "blue" | "red", k: keyof (typeof runs)[0]["profile"]["blue"]) => runs.reduce((s, r) => s + r.profile[t][k], 0) / runs.length;
    // Blue keeps the ball with short passes and a high line…
    expect(mean("blue", "possession")).toBeGreaterThan(0.55);
    expect(mean("blue", "passes")).toBeGreaterThan(mean("red", "passes") * 1.5);
    expect(mean("blue", "avgPassLength")).toBeLessThan(mean("red", "avgPassLength") * 0.75);
    expect(mean("blue", "avgTeamHeight")).toBeGreaterThan(mean("red", "avgTeamHeight") + 3);
    // …Red sits deeper and goes direct, carrying the ball more.
    expect(mean("red", "dribbleTouches")).toBeGreaterThan(mean("blue", "dribbleTouches"));
  }, 180_000);

  it("controllers expose their decisions (mode + notes + lines) and adapt when losing in the second half", async () => {
    const cfg = makeConfig({ halfDurationSec: 30 });
    const sim = new Simulation(5, cfg);
    const blue = await createSandboxedController({ team: "blue", source: BLUE, seed: 5, config: cfg });
    const red = await createSandboxedController({ team: "red", source: RED, seed: 5, config: cfg });
    // Harness: once the second half starts, put blue 0–2 down (debug command; not available to controllers).
    let forced = false;
    const harness = {
      name: "harness",
      team: "both" as const,
      decide: ({ state }: { state: import("@autosoccer/sim-core").WorldState }) => {
        if (!forced && state.match.period === "secondHalf") {
          forced = true;
          return [{ type: "debugSetMatch" as const, score: { blue: 0, red: 2 } }];
        }
        return [];
      },
    };
    const runner = new CommandRunner(sim, [harness, blue, red]);
    const modes = { blue: new Set<string>(), red: new Set<string>() };
    while (!sim.clock.finished) {
      runner.tick();
      for (const c of [blue, red]) if (c.last?.debug?.mode) modes[c.team].add(c.last.debug.mode);
    }
    expect([...modes.blue].some((m) => m.includes("chase"))).toBe(true);
    expect([...modes.red].some((m) => m.includes("protect"))).toBe(true);
    expect([...modes.blue].some((m) => /build-up|keep-ball/.test(m))).toBe(true);
    expect([...modes.blue].some((m) => m.startsWith("high press"))).toBe(true);
    expect([...modes.red].some((m) => m.startsWith("low block"))).toBe(true);
    expect([...modes.red].some((m) => m.startsWith("COUNTER"))).toBe(true);
    expect(blue.last?.debug?.notes?.length).toBeGreaterThan(0);
    runner.dispose();
  }, 120_000);

  it("featured controllers use only the public SDK surface", () => {
    for (const s of [BLUE, RED]) {
      expect(s).toMatch(/defineController\(/);
      // No engine internals or host escapes: only obs/Soccer/console/Math are referenced as globals.
      expect(s).not.toMatch(/__call|__meta|__seed|globalThis|require\(|import\(|debugPlace|debugSetMatch/);
    }
  });

  it("the random baseline is robust against both featured teams", async () => {
    for (const [b, r] of [[ex("random.js"), RED], [BLUE, ex("random.js")]] as const) {
      const m = await runControllerMatch({ seed: 9, blue: { source: b }, red: { source: r }, config: { halfDurationSec: 40 } });
      expect(m.state.match.period).toBe("fullTime");
      expect(m.diagnostics.filter((d) => FAILURES.includes(d.kind))).toEqual([]);
    }
  }, 120_000);
});
