import type { RngState } from "./prng.ts";

export type TeamId = "blue" | "red";
export type Role = "GK" | "DF" | "MF" | "FW";

/** Stable entity IDs: "blue-1".."blue-5", "red-1".."red-5", and "ball". */
export type PlayerId = `${TeamId}-${1 | 2 | 3 | 4 | 5}`;

/** A player's current movement intent, set by (validated) commands. */
export interface PlayerIntent {
  /** Target position or null to come to a stop. */
  readonly targetX: number | null;
  readonly targetY: number | null;
  readonly sprint: boolean;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly team: TeamId;
  /** Shirt number, 1 = goalkeeper. */
  readonly number: number;
  readonly role: Role;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Facing direction in radians (0 = +x). */
  readonly heading: number;
  /** In [0, 1]. */
  readonly stamina: number;
  readonly intent: PlayerIntent;
}

export interface BallState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * The complete, serialisable world. Treat as immutable: `step` returns a new
 * object and never mutates its input. Players are kept in stable ID order.
 */
export interface WorldState {
  readonly seed: number;
  readonly tick: number;
  readonly rng: RngState;
  readonly players: readonly PlayerState[];
  readonly ball: BallState;
  /** Per-tick contact counters, useful for debugging/telemetry. */
  readonly contacts: { readonly playerPlayer: number; readonly playerBall: number; readonly ballWall: number };
}
