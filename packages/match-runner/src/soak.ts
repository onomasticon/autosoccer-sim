/**
 * Soak runner: many seeded full matches with a mix of safe, idle and chaos
 * controllers under both clock policies. A match that doesn't reach full time
 * within a generous tick budget counts as a deadlock.
 */
import type { CommandSource } from "@autosoccer/controller-sdk";
import { CommandRunner, createChaosController, createIdleController, createSafeController } from "@autosoccer/controller-runtime";
import type { ConfigOverrides } from "@autosoccer/sim-core";
import { makeConfig, Simulation } from "@autosoccer/sim-core";

export type Matchup = "safe-vs-safe" | "safe-vs-idle" | "chaos-vs-safe" | "idle-vs-idle";
export const MATCHUPS: readonly Matchup[] = ["safe-vs-safe", "safe-vs-idle", "chaos-vs-safe", "idle-vs-idle"];

export interface SoakResult {
  matches: number;
  completed: number;
  deadlocks: Array<{ seed: number; matchup: Matchup; policy: string; period: string; phase: string }>;
  errors: Array<{ seed: number; error: string }>;
  restarts: Record<string, { taken: number; fallback: number }>;
  goals: number;
  fouls: number;
  rejectedCommands: number;
  controllerErrors: number;
  maxTicks: number;
  wallMs: number;
  byMatchup: Record<string, { matches: number; completed: number }>;
}

function sources(m: Matchup, seed: number): CommandSource[] {
  switch (m) {
    case "safe-vs-safe":
      return [createSafeController("blue"), createSafeController("red")];
    case "safe-vs-idle":
      return [createSafeController("blue"), createIdleController("red")];
    case "chaos-vs-safe":
      return [createChaosController("blue", seed), createSafeController("red")];
    case "idle-vs-idle":
      return [createIdleController("blue"), createIdleController("red")];
  }
}

export function runSoak(opts: { matches: number; startSeed?: number; config?: ConfigOverrides; onProgress?: (i: number) => void }): SoakResult {
  const res: SoakResult = { matches: 0, completed: 0, deadlocks: [], errors: [], restarts: {}, goals: 0, fouls: 0, rejectedCommands: 0, controllerErrors: 0, maxTicks: 0, wallMs: 0, byMatchup: {} };
  const t0 = performance.now();
  for (let i = 0; i < opts.matches; i++) {
    const seed = (opts.startSeed ?? 1) + i;
    const matchup = MATCHUPS[i % MATCHUPS.length]!;
    // Every other cycle uses the stop-on-dead-ball clock, where only the restart fallback prevents stalls.
    const policy = Math.floor(i / MATCHUPS.length) % 2 === 0 ? "running" : "stopOnDeadBall";
    const config = makeConfig({ ...opts.config, match: { ...opts.config?.match, clockPolicy: policy } });
    // Budget: full time with a running clock is ~14.6k ticks; dead-ball pauses can add a lot more.
    const budget = 60_000;
    res.matches++;
    const mu = (res.byMatchup[matchup] ??= { matches: 0, completed: 0 });
    mu.matches++;
    try {
      const sim = new Simulation(seed, config);
      const runner = new CommandRunner(sim, sources(matchup, seed));
      let t = 0;
      while (!sim.clock.finished && t < budget) {
        runner.tick();
        t++;
      }
      res.maxTicks = Math.max(res.maxTicks, t);
      for (const e of sim.events) {
        const ev = e.event;
        if (ev.type === "restartTaken") {
          const r = (res.restarts[ev.restart] ??= { taken: 0, fallback: 0 });
          if (ev.fallback) r.fallback++;
          else r.taken++;
        } else if (ev.type === "goalScored") res.goals++;
        else if (ev.type === "foul") res.fouls++;
      }
      res.rejectedCommands += sim.rejections.length;
      res.controllerErrors += runner.diagnostics.filter((d) => d.kind === "error").length;
      if (sim.clock.finished) {
        res.completed++;
        mu.completed++;
      } else res.deadlocks.push({ seed, matchup, policy, period: sim.state.match.period, phase: sim.state.match.phase });
    } catch (err) {
      res.errors.push({ seed, error: String(err) });
    }
    opts.onProgress?.(i + 1);
  }
  res.wallMs = performance.now() - t0;
  return res;
}
