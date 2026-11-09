/**
 * @autosoccer/controller-sdk — public types for anything that issues commands
 * to the simulation.
 *
 * M1 scope: only debug/scripted command sources that issue movement commands
 * (`moveTo`, `stop`). The full versioned observation/action schema and the
 * initialize/update/onMatchEnd lifecycle arrive in M4; this module is where
 * they will live, and `SDK_VERSION` will be bumped accordingly.
 */
import type { EngineCommand, TeamId, WorldState } from "@autosoccer/sim-core";

export const SDK_VERSION = "0.1.0";

export type { EngineCommand, PlayerId, TeamId } from "@autosoccer/sim-core";

export interface DecisionContext {
  /** Physics tick at which the returned commands will be applied. */
  readonly tick: number;
  /** Read-only snapshot of the world before this decision tick. */
  readonly state: WorldState;
}

/**
 * A debug command source: called once per 10 Hz decision tick and returns
 * engine commands. `team` restricts which players it may command; commands
 * for other players are dropped by the runtime and reported.
 */
export interface CommandSource {
  readonly name: string;
  readonly team: TeamId | "both";
  decide(ctx: DecisionContext): readonly EngineCommand[];
}
