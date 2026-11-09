import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG, ticksPerDecision } from "./config.ts";
import type { CommandRejection, EngineCommand } from "./commands.ts";
import { hashState } from "./hash.ts";
import { step } from "./step.ts";
import type { WorldState } from "./types.ts";
import { createWorld } from "./world.ts";

/** Commands accepted at a specific decision tick. This is the input stream. */
export interface CommandLogEntry {
  readonly tick: number;
  readonly commands: readonly EngineCommand[];
}

export interface MatchClock {
  /** 1-based half; equals `halves + 1` once the match time has elapsed. */
  readonly half: number;
  readonly secondsInHalf: number;
  readonly totalSeconds: number;
  readonly finished: boolean;
}

export function clockOf(tick: number, cfg: SimConfig = DEFAULT_CONFIG): MatchClock {
  const totalSeconds = tick / cfg.tickRate;
  const halfIdx = Math.floor(totalSeconds / cfg.halfDurationSec);
  const finished = halfIdx >= cfg.halves;
  return {
    half: Math.min(halfIdx, cfg.halves) + 1,
    secondsInHalf: finished ? cfg.halfDurationSec : totalSeconds - halfIdx * cfg.halfDurationSec,
    totalSeconds,
    finished,
  };
}

export function isDecisionTick(tick: number, cfg: SimConfig = DEFAULT_CONFIG): boolean {
  return tick % ticksPerDecision(cfg) === 0;
}

/**
 * Stateful driver around the pure `step` function, shared by the headless
 * runner and the viewer. Commands submitted between decision ticks are queued
 * and applied on the next 10 Hz decision tick, which is what makes the input
 * stream (and therefore the state hash sequence) reproducible.
 */
export class Simulation {
  readonly config: SimConfig;
  state: WorldState;
  private pending: unknown[] = [];
  private _log: CommandLogEntry[] = [];
  private _rejections: Array<CommandRejection & { tick: number }> = [];

  constructor(seed: number, config: SimConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.state = createWorld(seed, config);
  }

  get seed(): number {
    return this.state.seed;
  }
  get log(): readonly CommandLogEntry[] {
    return this._log;
  }
  get rejections(): ReadonlyArray<CommandRejection & { tick: number }> {
    return this._rejections;
  }
  get clock(): MatchClock {
    return clockOf(this.state.tick, this.config);
  }
  hash(): string {
    return hashState(this.state);
  }

  /** Queue commands for the next decision tick. */
  submit(commands: readonly unknown[]): void {
    this.pending.push(...commands);
  }

  /** Advance one physics tick. Returns the new state. */
  tick(): WorldState {
    let cmds: unknown[] = [];
    if (isDecisionTick(this.state.tick, this.config) && this.pending.length > 0) {
      cmds = this.pending;
      this.pending = [];
    }
    const { state, rejected } = step(this.state, cmds, this.config);
    if (cmds.length > 0) {
      const rejectedSet = new Set(rejected.map((r) => r.command));
      const accepted = cmds.filter((c) => !rejectedSet.has(c)) as EngineCommand[];
      if (accepted.length > 0) this._log.push({ tick: this.state.tick, commands: accepted });
      for (const r of rejected) this._rejections.push({ ...r, tick: this.state.tick });
    }
    this.state = state;
    return state;
  }

  run(ticks: number): WorldState {
    for (let i = 0; i < ticks; i++) this.tick();
    return this.state;
  }

  reset(seed: number = this.state.seed): void {
    this.state = createWorld(seed, this.config);
    this.pending = [];
    this._log = [];
    this._rejections = [];
  }

  /**
   * Re-run a recorded command stream from a fresh world, without any
   * controllers, up to `toTick`. Used to verify determinism.
   */
  static replay(seed: number, log: readonly CommandLogEntry[], toTick: number, config: SimConfig = DEFAULT_CONFIG): WorldState {
    let state = createWorld(seed, config);
    let li = 0;
    while (state.tick < toTick) {
      let cmds: readonly EngineCommand[] = [];
      const entry = log[li];
      if (entry && entry.tick === state.tick) {
        cmds = entry.commands;
        li++;
      }
      state = step(state, cmds, config).state;
    }
    return state;
  }
}
