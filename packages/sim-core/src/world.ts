import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG, validateConfig } from "./config.ts";
import { Rng } from "./prng.ts";
import type { PlayerId, PlayerState, Role, TeamId, WorldState } from "./types.ts";

/**
 * Kickoff formation for the team defending the left (-x) goal, as fractions of
 * the half-length / half-width. Mirrored for the right side.
 */
const FORMATION: ReadonlyArray<{ number: number; role: Role; fx: number; fy: number }> = [
  { number: 1, role: "GK", fx: -0.92, fy: 0 },
  { number: 2, role: "DF", fx: -0.58, fy: -0.42 },
  { number: 3, role: "DF", fx: -0.58, fy: 0.42 },
  { number: 4, role: "MF", fx: -0.32, fy: 0 },
  { number: 5, role: "FW", fx: -0.12, fy: 0.3 },
];

export const TEAMS: readonly TeamId[] = ["blue", "red"];

/** Which goal a team defends (no side switch until M3). */
export function defendedSide(team: TeamId): "left" | "right" {
  return team === "blue" ? "left" : "right";
}

export function playerId(team: TeamId, n: number): PlayerId {
  return `${team}-${n}` as PlayerId;
}

/** Create the initial world for a seed. Pure and deterministic. */
export function createWorld(seed: number, config: SimConfig = DEFAULT_CONFIG): WorldState {
  validateConfig(config);
  const rng = new Rng(seed);
  const halfL = config.pitch.length / 2;
  const halfW = config.pitch.width / 2;
  const players: PlayerState[] = [];
  for (const team of TEAMS) {
    const side = team === "blue" ? 1 : -1; // blue defends -x at kickoff
    for (const slot of FORMATION) {
      const jitter = slot.role === "GK" ? 0 : config.formationJitter;
      const jx = rng.range(-jitter, jitter);
      const jy = rng.range(-jitter, jitter);
      players.push({
        id: playerId(team, slot.number),
        team,
        number: slot.number,
        role: slot.role,
        x: side * slot.fx * halfL + jx,
        y: slot.fy * halfW + jy,
        vx: 0,
        vy: 0,
        heading: team === "blue" ? 0 : Math.PI,
        stamina: 1,
        intent: { targetX: null, targetY: null, sprint: false, dribble: false },
        touchCooldown: 0,
        tackleCooldown: 0,
        catchCooldown: 0,
        stunned: 0,
      });
    }
  }
  return {
    seed,
    tick: 0,
    rng: rng.state,
    players,
    ball: { x: 0, y: 0, vx: 0, vy: 0, heldBy: null, holdTicks: 0, lastTouch: null, inGoal: null },
    contacts: { playerPlayer: 0, playerBall: 0, ballWall: 0 },
    events: [],
  };
}
