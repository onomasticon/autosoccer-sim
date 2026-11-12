import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG, validateConfig } from "./config.ts";
import { Rng } from "./prng.ts";
import type { MatchState, PlayerId, PlayerState, Role, Side, TeamId, WorldState } from "./types.ts";

export type FormationSlot = { number: number; role: Role; fx: number; fy: number };

/**
 * Kickoff formation for the team defending the left (-x) goal, as fractions of
 * the half-length / half-width. Mirrored for the right side. Every slot is in
 * the team's own half and outside the centre circle. This is the 5-a-side shape.
 */
export const FORMATION: ReadonlyArray<FormationSlot> = [
  { number: 1, role: "GK", fx: -0.92, fy: 0 },
  { number: 2, role: "DF", fx: -0.58, fy: -0.42 },
  { number: 3, role: "DF", fx: -0.58, fy: 0.42 },
  { number: 4, role: "MF", fx: -0.32, fy: 0 },
  { number: 5, role: "FW", fx: -0.12, fy: 0.3 },
];

/** 7-a-side kickoff shape: keeper, two defenders, three midfielders, one forward. */
export const FORMATION_7: ReadonlyArray<FormationSlot> = [
  { number: 1, role: "GK", fx: -0.92, fy: 0 },
  { number: 2, role: "DF", fx: -0.62, fy: -0.4 },
  { number: 3, role: "DF", fx: -0.62, fy: 0.4 },
  { number: 4, role: "MF", fx: -0.4, fy: -0.55 },
  { number: 5, role: "MF", fx: -0.36, fy: 0 },
  { number: 6, role: "MF", fx: -0.4, fy: 0.55 },
  { number: 7, role: "FW", fx: -0.13, fy: 0.3 },
];

/** Kickoff shape for a team size (validated by validateConfig). */
export function formationFor(config: Pick<SimConfig, "playersPerTeam">): ReadonlyArray<FormationSlot> {
  return config.playersPerTeam === 7 ? FORMATION_7 : FORMATION;
}

export const TEAMS: readonly TeamId[] = ["blue", "red"];

export const otherTeam = (t: TeamId): TeamId => (t === "blue" ? "red" : "blue");

/** Default sides: blue defends left in the first half. */
export const FIRST_HALF_DEFENDS: { readonly blue: Side; readonly red: Side } = { blue: "left", red: "right" };

/** Which goal a team defends: from the match state if given, otherwise the first-half default. */
export function defendedSide(team: TeamId, match?: Pick<MatchState, "defends">): Side {
  return (match?.defends ?? FIRST_HALF_DEFENDS)[team];
}

/** +1 if the team attacks toward +x, −1 otherwise. */
export function attackSign(team: TeamId, match?: Pick<MatchState, "defends">): 1 | -1 {
  return defendedSide(team, match) === "left" ? 1 : -1;
}

export function playerId(team: TeamId, n: number): PlayerId {
  return `${team}-${n}` as PlayerId;
}

/** Kickoff position of a formation slot for a team defending `side`. */
export function formationSpot(slotIndex: number, side: Side, config: SimConfig): { x: number; y: number } {
  const slot = formationFor(config)[slotIndex]!;
  const s = side === "left" ? 1 : -1;
  return { x: s * slot.fx * (config.pitch.length / 2), y: slot.fy * (config.pitch.width / 2) };
}

/** Create the initial world for a seed. Pure and deterministic. */
export function createWorld(seed: number, config: SimConfig = DEFAULT_CONFIG): WorldState {
  validateConfig(config);
  const rng = new Rng(seed);
  const players: PlayerState[] = [];
  for (const team of TEAMS) {
    formationFor(config).forEach((slot, i) => {
      const jitter = slot.role === "GK" ? 0 : config.formationJitter;
      const jx = rng.range(-jitter, jitter);
      const jy = rng.range(-jitter, jitter);
      const spot = formationSpot(i, FIRST_HALF_DEFENDS[team], config);
      players.push({
        id: playerId(team, slot.number),
        team,
        number: slot.number,
        role: slot.role,
        x: spot.x + jx,
        y: spot.y + jy,
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
    });
  }
  const firstKickoff: TeamId =
    config.match.firstKickoff === "seeded" ? (rng.bool() ? "blue" : "red") : config.match.firstKickoff;
  return {
    seed,
    tick: 0,
    rng: rng.state,
    players,
    ball: { x: 0, y: 0, vx: 0, vy: 0, heldBy: null, holdTicks: 0, lastTouch: null, inGoal: null },
    contacts: { playerPlayer: 0, playerBall: 0, ballWall: 0 },
    events: [],
    match: {
      period: "preMatch",
      phase: "stopped",
      halfTicks: 0,
      resumeTick: config.match.preMatchTicks,
      score: { blue: 0, red: 0 },
      firstKickoff,
      defends: FIRST_HALF_DEFENDS,
      restart: null,
    },
  };
}
