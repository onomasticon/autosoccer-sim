import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG, ticksPerDecision } from "./config.ts";
import type { CommandRejection, EngineCommand } from "./commands.ts";
import { hashState } from "./hash.ts";
import { step } from "./step.ts";
import type { Period, Phase, SimEvent, WorldState } from "./types.ts";
import { createWorld } from "./world.ts";

/** Commands accepted at a specific decision tick. This is the input stream. */
export interface CommandLogEntry {
  readonly tick: number;
  readonly commands: readonly EngineCommand[];
}

/** An event with the tick it happened on and where the ball was at the start of that tick. */
export interface LoggedEvent {
  readonly tick: number;
  readonly event: SimEvent;
  readonly ballX: number;
  readonly ballY: number;
}

export interface MatchClock {
  /** 1 during pre-match and the first half, 2 from halftime on. */
  readonly half: 1 | 2;
  /** Match-clock seconds elapsed in the current half. */
  readonly secondsInHalf: number;
  /** Simulated seconds since world creation (wall-clock of the sim, incl. pauses). */
  readonly totalSeconds: number;
  readonly period: Period;
  readonly phase: Phase;
  readonly finished: boolean;
}

export function clockOf(state: Pick<WorldState, "tick" | "match">, cfg: SimConfig = DEFAULT_CONFIG): MatchClock {
  const m = state.match;
  const half = m.period === "preMatch" || m.period === "firstHalf" ? 1 : 2;
  const full = cfg.halfDurationSec;
  const secondsInHalf = m.period === "halftime" || m.period === "fullTime" ? full : Math.min(full, m.halfTicks / cfg.tickRate);
  return { half, secondsInHalf, totalSeconds: state.tick / cfg.tickRate, period: m.period, phase: m.phase, finished: m.period === "fullTime" };
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
  private _events: LoggedEvent[] = [];

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
  get events(): readonly LoggedEvent[] {
    return this._events;
  }
  get clock(): MatchClock {
    return clockOf(this.state, this.config);
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
    for (const e of state.events) this._events.push({ tick: this.state.tick, event: e, ballX: this.state.ball.x, ballY: this.state.ball.y });
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
    this._events = [];
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
