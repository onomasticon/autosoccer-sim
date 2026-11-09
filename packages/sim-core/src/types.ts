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
  /** While true, the player takes small touches to keep a loose ball ahead of it. */
  readonly dribble: boolean;
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
  /** Ticks until this player may kick/touch/trap the ball again. */
  readonly touchCooldown: number;
  /** Ticks until this player may attempt another tackle. */
  readonly tackleCooldown: number;
  /** Ticks until this goalkeeper may attempt another catch. */
  readonly catchCooldown: number;
  /** Ticks the player is grounded after a failed tackle (cannot move or act). */
  readonly stunned: number;
}

export interface BallState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Goalkeeper currently holding the ball, or null when the ball is free. */
  readonly heldBy: PlayerId | null;
  /** Ticks the current keeper has held the ball. */
  readonly holdTicks: number;
  /** Last player to deliberately play or touch the ball. */
  readonly lastTouch: PlayerId | null;
  /** Set once the ball has fully crossed a goal line between the posts. */
  readonly inGoal: "left" | "right" | null;
}

/** Things that happened during a tick. Derived output; not part of the hash. */
export type SimEvent =
  | { readonly type: "kick"; readonly playerId: PlayerId; readonly power: number; readonly speed: number; readonly dirX: number; readonly dirY: number; readonly errorRad: number }
  | { readonly type: "dribbleTouch"; readonly playerId: PlayerId }
  | { readonly type: "trap"; readonly playerId: PlayerId; readonly interception: boolean; readonly incomingSpeed: number }
  | { readonly type: "trapMiss"; readonly playerId: PlayerId; readonly incomingSpeed: number }
  | { readonly type: "tackle"; readonly playerId: PlayerId; readonly success: boolean; readonly victim: PlayerId | null }
  | { readonly type: "catch"; readonly playerId: PlayerId; readonly success: boolean; readonly incomingSpeed: number }
  | { readonly type: "release"; readonly playerId: PlayerId; readonly auto: boolean }
  | { readonly type: "goal"; readonly side: "left" | "right" };

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
  /** Events produced by the most recent tick. */
  readonly events: readonly SimEvent[];
}
