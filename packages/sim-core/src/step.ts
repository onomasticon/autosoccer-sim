import type { ActionContext } from "./actions.ts";
import { resolveActions, resolveAutoTouches, updateHeldBall } from "./actions.ts";
import type { ActionCommand, CommandRejection, DebugCommand, EngineCommand } from "./commands.ts";
import { isActionCommand, isDebugCommand, validateCommand } from "./commands.ts";
import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { ContactCounts, MutBall, MutPlayer } from "./physics.ts";
import { integrateBall, integratePlayer, resolvePlayerCollisions } from "./physics.ts";
import { Rng } from "./prng.ts";
import type { PlayerState, SimEvent, WorldState } from "./types.ts";

export interface StepResult {
  readonly state: WorldState;
  readonly rejected: readonly CommandRejection[];
}

const cmdKey = (c: EngineCommand): string => ("playerId" in c ? c.playerId : "");

/**
 * Advance the world by exactly one fixed physics tick.
 *
 * Pure: the input state is never mutated. Order of operations:
 *   1. validate commands; apply debug placements, then movement intents
 *      (stable player-ID order, last one wins per player)
 *   2. tick down cooldowns
 *   3. resolve one-shot actions with deterministic arbitration
 *      (catch → release → tackle → kick; nearest-to-ball first)
 *   4. integrate players, resolve player collisions
 *   5. automatic touches (traps/interceptions, dribble touches)
 *   6. held ball follows keeper, or free ball integrates (sub-stepped)
 * All randomness comes from the seeded RNG carried in the state.
 */
export function step(state: WorldState, commands: readonly unknown[] = [], config: SimConfig = DEFAULT_CONFIG): StepResult {
  const dt = 1 / config.tickRate;
  const rejected: CommandRejection[] = [];
  const events: SimEvent[] = [];
  const rng = new Rng(state.rng);

  const players: MutPlayer[] = state.players.map((p) => ({ ...p }));
  const ball: MutBall = { ...state.ball };
  const index = new Map(players.map((p, i) => [p.id, i] as const));

  const valid: EngineCommand[] = [];
  for (const c of commands) {
    const reason = validateCommand(c);
    if (reason) rejected.push({ command: c, reason });
    else valid.push(c as EngineCommand);
  }
  // Stable sort by playerId (Array.prototype.sort is stable); debug ball placement sorts first.
  valid.sort((a, b) => (cmdKey(a) < cmdKey(b) ? -1 : cmdKey(a) > cmdKey(b) ? 1 : 0));

  const actions: ActionCommand[] = [];
  for (const c of valid.filter(isDebugCommand)) applyDebug(c, players, ball, index);
  for (const c of valid) {
    if (isDebugCommand(c)) continue;
    const i = index.get(c.playerId);
    if (i === undefined) {
      rejected.push({ command: c, reason: "unknown player" });
      continue;
    }
    const p = players[i]!;
    if (c.type === "moveTo") p.intent = { targetX: c.x, targetY: c.y, sprint: c.sprint ?? false, dribble: c.dribble ?? false };
    else if (c.type === "stop") p.intent = { targetX: null, targetY: null, sprint: false, dribble: false };
    else if (isActionCommand(c)) actions.push(c);
  }

  for (const p of players) {
    if (p.touchCooldown > 0) p.touchCooldown--;
    if (p.tackleCooldown > 0) p.tackleCooldown--;
    if (p.catchCooldown > 0) p.catchCooldown--;
    if (p.stunned > 0) p.stunned--;
  }

  const ctx: ActionContext = { players, ball, cfg: config, rng, events, rejected, ballPlayed: false };
  resolveActions(ctx, actions);

  const counts: ContactCounts = { playerPlayer: 0, playerBall: 0, ballWall: 0 };
  for (const p of players) integratePlayer(p, config, dt);
  // Two relaxation passes keep clusters of players from overlapping.
  resolvePlayerCollisions(players, config, counts);
  resolvePlayerCollisions(players, config, counts);

  resolveAutoTouches(ctx);
  if (ball.heldBy !== null) updateHeldBall(ctx);
  else integrateBall(ball, players, config, dt, counts, events);

  return {
    state: {
      seed: state.seed,
      tick: state.tick + 1,
      rng: rng.state,
      players: players as PlayerState[],
      ball,
      contacts: counts,
      events,
    },
    rejected,
  };
}

function applyDebug(c: DebugCommand, players: MutPlayer[], ball: MutBall, index: Map<string, number>): void {
  if (c.type === "debugPlaceBall") {
    Object.assign(ball, { x: c.x, y: c.y, vx: c.vx ?? 0, vy: c.vy ?? 0, heldBy: null, holdTicks: 0, inGoal: null, lastTouch: null });
    return;
  }
  const p = players[index.get(c.playerId)!]!;
  if (ball.heldBy === p.id) Object.assign(ball, { heldBy: null, holdTicks: 0 });
  Object.assign(p, {
    x: c.x,
    y: c.y,
    vx: 0,
    vy: 0,
    heading: c.heading ?? p.heading,
    stamina: c.stamina ?? p.stamina,
    intent: { targetX: null, targetY: null, sprint: false, dribble: false },
    touchCooldown: 0,
    tackleCooldown: 0,
    catchCooldown: 0,
    stunned: 0,
  });
}
