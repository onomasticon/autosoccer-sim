/**
 * Headless matches between two sandboxed controller scripts.
 */
import { CommandRunner, createSandboxedController, type ControllerDiagnostic, type SandboxedController, type SandboxLimits } from "@autosoccer/controller-runtime";
import type { ConfigOverrides, LoggedEvent, WorldState } from "@autosoccer/sim-core";
import { makeConfig, Simulation } from "@autosoccer/sim-core";

export interface ControllerMatchOptions {
  seed: number;
  blue: { source: string; label?: string };
  red: { source: string; label?: string };
  config?: ConfigOverrides;
  limits?: Partial<SandboxLimits>;
  /** Stop early after this many ticks (default: until full time). */
  maxTicks?: number;
}

export interface ControllerMatchResult {
  sim: Simulation;
  state: WorldState;
  blue: SandboxedController;
  red: SandboxedController;
  diagnostics: ControllerDiagnostic[];
  finalHash: string;
  wallMs: number;
  stats: Record<"blue" | "red", { kicks: number; tackles: number; catches: number; goals: number; engineRejected: number; invalidActions: number; failures: number; disabled: boolean; avgOps: number }>;
}

export async function runControllerMatch(o: ControllerMatchOptions): Promise<ControllerMatchResult> {
  const config = makeConfig(o.config);
  const blue = await createSandboxedController({ team: "blue", source: o.blue.source, label: o.blue.label, config, limits: o.limits, seed: o.seed });
  const red = await createSandboxedController({ team: "red", source: o.red.source, label: o.red.label, config, limits: o.limits, seed: o.seed });
  const sim = new Simulation(o.seed, config);
  const runner = new CommandRunner(sim, [blue, red]);
  const t0 = performance.now();
  const max = o.maxTicks ?? 200_000;
  while (!sim.clock.finished && sim.state.tick < max) runner.tick();
  const wallMs = performance.now() - t0;
  runner.dispose();
  const team = (id: string | null | undefined) => (id?.startsWith("blue") ? "blue" : "red");
  const ev = sim.events as readonly LoggedEvent[];
  const stat = (t: "blue" | "red", c: SandboxedController) => ({
    kicks: ev.filter((e) => e.event.type === "kick" && team(e.event.playerId) === t).length,
    tackles: ev.filter((e) => e.event.type === "tackle" && team(e.event.playerId) === t).length,
    catches: ev.filter((e) => e.event.type === "catch" && e.event.success && team(e.event.playerId) === t).length,
    goals: sim.state.match.score[t],
    engineRejected: c.diagnostics.filter((d) => d.kind === "engine-rejected").length,
    invalidActions: c.diagnostics.filter((d) => d.kind === "invalid-action").length,
    failures: c.diagnostics.filter((d) => ["error", "timeout", "out-of-memory", "invalid-output"].includes(d.kind)).length,
    disabled: c.disabled,
    avgOps: c.updates ? c.totalOps / c.updates : 0,
  });
  return {
    sim,
    state: sim.state,
    blue,
    red,
    diagnostics: [...blue.diagnostics, ...red.diagnostics].sort((a, b) => a.tick - b.tick),
    finalHash: sim.hash(),
    wallMs,
    stats: { blue: stat("blue", blue), red: stat("red", red) },
  };
}
