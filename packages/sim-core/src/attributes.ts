/**
 * Player attributes (engine 0.6, opt-in). Each player may carry ten ratings from 1 to 99; 60 is
 * the reference player the base config describes, so a 60 in everything plays exactly like a
 * player without attributes. Ratings live in the match config (`config.players`), so replays
 * carry them and re-step identically. A player with no entry uses the base config unchanged.
 */
import type { PlayerPhysicsConfig, SimConfig } from "./config.ts";

export const ATTRIBUTE_NAMES = [
  "pace",
  "acceleration",
  "agility",
  "stamina",
  "control",
  "passing",
  "shooting",
  "power",
  "tackling",
  "goalkeeping",
] as const;
export type AttributeName = (typeof ATTRIBUTE_NAMES)[number];
export type PlayerAttributes = Readonly<Record<AttributeName, number>>;

export const NEUTRAL_RATING = 60;
export const MIN_RATING = 1;
export const MAX_RATING = 99;

/** How far a rating is from the reference player: 0 at 60, +0.975 at 99, −1.475 at 1. */
export function ratingDelta(cfg: SimConfig, id: string, name: AttributeName): number {
  const a = cfg.players?.[id];
  return a ? (a[name] - NEUTRAL_RATING) / 40 : 0;
}

/** Multiplier `1 + spread × delta` (exactly 1 for a player without attributes). */
export function attrScale(cfg: SimConfig, id: string, name: AttributeName, spread: number): number {
  const a = cfg.players?.[id];
  return a ? 1 + spread * ((a[name] - NEUTRAL_RATING) / 40) : 1;
}

const physicsCache = new WeakMap<SimConfig, Map<string, PlayerPhysicsConfig>>();

/**
 * A player's movement physics: pace scales top speeds (±12% at the extremes), acceleration the
 * acceleration and braking, agility the turn rates, stamina the drain and recovery. Returns the
 * shared base object for players without attributes.
 */
export function playerPhysics(cfg: SimConfig, id: string): PlayerPhysicsConfig {
  if (!cfg.players?.[id]) return cfg.player;
  let byId = physicsCache.get(cfg);
  if (!byId) physicsCache.set(cfg, (byId = new Map()));
  const hit = byId.get(id);
  if (hit) return hit;
  const pc = cfg.player;
  const s = (n: AttributeName, spread: number) => attrScale(cfg, id, n, spread);
  const out: PlayerPhysicsConfig = {
    ...pc,
    maxSpeed: pc.maxSpeed * s("pace", 0.12),
    sprintSpeed: pc.sprintSpeed * s("pace", 0.12),
    acceleration: pc.acceleration * s("acceleration", 0.2),
    deceleration: pc.deceleration * s("acceleration", 0.1),
    turnRate: pc.turnRate * s("agility", 0.25),
    turnRateAtSprint: pc.turnRateAtSprint * s("agility", 0.25),
    staminaDrain: pc.staminaDrain * s("stamina", -0.3),
    staminaRecovery: pc.staminaRecovery * s("stamina", 0.25),
  };
  byId.set(id, out);
  return out;
}

/** Validation for `config.players`; returns an error message or null. */
export function attributesError(players: SimConfig["players"]): string | null {
  if (players === undefined) return null;
  for (const [id, a] of Object.entries(players)) {
    for (const n of ATTRIBUTE_NAMES) {
      const r = (a as Record<string, unknown>)[n];
      if (typeof r !== "number" || !Number.isInteger(r) || r < MIN_RATING || r > MAX_RATING)
        return `players.${id}.${n} must be an integer from ${MIN_RATING} to ${MAX_RATING}`;
    }
  }
  return null;
}
