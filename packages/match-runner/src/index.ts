/**
 * @autosoccer/match-runner — headless execution of the simulation using the
 * exact same sim-core the viewer uses.
 */
import { CommandRunner, createPlaygroundScript } from "@autosoccer/controller-runtime";
import type { CommandLogEntry, ConfigOverrides, SimConfig } from "@autosoccer/sim-core";
import { makeConfig, Simulation } from "@autosoccer/sim-core";
import { TelemetryRecorder } from "@autosoccer/telemetry";

export interface HeadlessOptions {
  seed: number;
  /** Simulated seconds to run. Defaults to the full configured match. */
  seconds?: number;
  config?: ConfigOverrides;
  checkpointEvery?: number;
}

export interface HeadlessResult {
  seed: number;
  ticks: number;
  finalHash: string;
  checkpoints: Array<{ tick: number; hash: string }>;
  log: readonly CommandLogEntry[];
  telemetry: TelemetryRecorder;
  config: SimConfig;
  wallMs: number;
  realtimeFactor: number;
}

export function runHeadless(opts: HeadlessOptions): HeadlessResult {
  const config = makeConfig(opts.config);
  const seconds = opts.seconds ?? config.halfDurationSec * config.halves;
  const ticks = Math.round(seconds * config.tickRate);
  const sim = new Simulation(opts.seed, config);
  const runner = new CommandRunner(sim, [createPlaygroundScript(opts.seed)]);
  const telemetry = new TelemetryRecorder(opts.seed, config, opts.checkpointEvery ?? config.tickRate);
  telemetry.observe(sim.state);
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) telemetry.observe(runner.tick());
  const wallMs = performance.now() - t0;
  const summary = telemetry.finish(sim.state, sim.log, wallMs);
  return {
    seed: opts.seed,
    ticks,
    finalHash: summary.finalHash,
    checkpoints: telemetry.checkpoints(),
    log: sim.log,
    telemetry,
    config,
    wallMs,
    realtimeFactor: seconds / (wallMs / 1000),
  };
}

export * from "./soak.ts";
export * from "./controllers.ts";
export * from "./stats.ts";
export * from "./record.ts";
