import type { ActionContext } from "./actions.ts";
import { resolveActions, resolveAutoTouches, updateHeldBall } from "./actions.ts";
import type { ActionCommand, CommandRejection, DebugCommand, EngineCommand } from "./commands.ts";
import { isActionCommand, isDebugCommand, validateCommand } from "./commands.ts";
import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { MatchContext, MutMatch } from "./match.ts";
import { enforceRestartConstraints, filterActionsForPhase, inPlayPeriod, isBallLocked, lockBall, noteRestartTaken, updateMatch } from "./match.ts";
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
 *   1. validate commands; apply debug commands, then movement intents
 *      (stable player-ID order, last one wins per player)
 *   2. tick down cooldowns
 *   3. phase permissions (dead ball / stopped play / designated taker), then
 *      one-shot actions with deterministic arbitration
 *      (catch → release → tackle → kick; nearest-to-ball first)
 *   4. integrate players, resolve collisions, enforce restart distances
 *   5. automatic touches (traps/interceptions, dribble) in open play only
 *   6. ball: locked at a restart spot, held by a keeper, or free (sub-stepped)
 *   7. match update: clock, goals, out of play, fouls, restarts, periods
 * All randomness comes from the seeded RNG carried in the state.
 */
export function step(state: WorldState, commands: readonly unknown[] = [], config: SimConfig = DEFAULT_CONFIG): StepResult {
  const dt = 1 / config.tickRate;
  const rejected: CommandRejection[] = [];
  const events: SimEvent[] = [];
  const rng = new Rng(state.rng);

  const players: MutPlayer[] = state.players.map((p) => ({ ...p }));
  const ball: MutBall = { ...state.ball };
  const match: MutMatch = { ...state.match };
  const index = new Map(players.map((p, i) => [p.id, i] as const));
  const mctx: MatchContext = { tick: state.tick, match, players, ball, cfg: config, events };

  const valid: EngineCommand[] = [];
  for (const c of commands) {
    const reason = validateCommand(c);
    if (reason) rejected.push({ command: c, reason });
    else valid.push(c as EngineCommand);
  }
  // Stable sort by playerId (Array.prototype.sort is stable); world-level debug commands sort first.
  valid.sort((a, b) => (cmdKey(a) < cmdKey(b) ? -1 : cmdKey(a) > cmdKey(b) ? 1 : 0));

  const actions: ActionCommand[] = [];
  for (const c of valid.filter(isDebugCommand)) applyDebug(c, players, ball, match, index);
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

  if (isBallLocked(match, state.tick)) lockBall(mctx);
  const ctx: ActionContext = { players, ball, cfg: config, rng, events, rejected, ballPlayed: false, match };
  resolveActions(ctx, filterActionsForPhase(mctx, actions, rejected));
  noteRestartTaken(mctx);

  const counts: ContactCounts = { playerPlayer: 0, playerBall: 0, ballWall: 0 };
  for (const p of players) integratePlayer(p, config, dt);
  // Two relaxation passes keep clusters of players from overlapping.
  resolvePlayerCollisions(players, config, counts);
  resolvePlayerCollisions(players, config, counts);
  enforceRestartConstraints(mctx);

  const live = inPlayPeriod(match.period) && match.phase === "openPlay";
  if (live) resolveAutoTouches(ctx);
  if (isBallLocked(match, state.tick)) lockBall(mctx);
  else if (ball.heldBy !== null) updateHeldBall(ctx);
  else integrateBall(ball, players, config, dt, counts, events);

  updateMatch(mctx);
  // A restart that becomes ready this tick shows the ball on its spot immediately.
  if (isBallLocked(match, state.tick + 1)) lockBall(mctx);

  return {
    state: {
      seed: state.seed,
      tick: state.tick + 1,
      rng: rng.state,
      players: players as PlayerState[],
      ball,
      contacts: counts,
      events,
      match,
    },
    rejected,
  };
}

function applyDebug(c: DebugCommand, players: MutPlayer[], ball: MutBall, match: MutMatch, index: Map<string, number>): void {
  if (c.type === "debugSetMatch") {
    if (c.period !== undefined) match.period = c.period;
    if (c.phase !== undefined) {
      match.phase = c.phase;
      match.restart = null;
    }
    if (c.halfTicks !== undefined) match.halfTicks = c.halfTicks;
    if (c.score !== undefined) match.score = { ...c.score };
    return;
  }
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
