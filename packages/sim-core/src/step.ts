import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { CommandRejection, EngineCommand } from "./commands.ts";
import { validateCommand } from "./commands.ts";
import type { ContactCounts, MutBall, MutPlayer } from "./physics.ts";
import { integrateBall, integratePlayer, resolvePlayerCollisions } from "./physics.ts";
import type { PlayerState, WorldState } from "./types.ts";

export interface StepResult {
  readonly state: WorldState;
  readonly rejected: readonly CommandRejection[];
}

/**
 * Advance the world by exactly one fixed physics tick.
 *
 * Pure: the input state is never mutated. Commands are validated, then
 * applied in stable player-ID order (submission order preserved per player,
 * last one wins), so the result does not depend on how the caller ordered
 * commands for different players.
 */
export function step(state: WorldState, commands: readonly unknown[] = [], config: SimConfig = DEFAULT_CONFIG): StepResult {
  const dt = 1 / config.tickRate;
  const rejected: CommandRejection[] = [];

  const players: MutPlayer[] = state.players.map((p) => ({ ...p }));
  const index = new Map(players.map((p, i) => [p.id, i] as const));

  const valid: EngineCommand[] = [];
  for (const c of commands) {
    const reason = validateCommand(c);
    if (reason) rejected.push({ command: c, reason });
    else valid.push(c as EngineCommand);
  }
  // Stable sort by playerId (Array.prototype.sort is stable).
  valid.sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  for (const c of valid) {
    const i = index.get(c.playerId);
    if (i === undefined) {
      rejected.push({ command: c, reason: "unknown player" });
      continue;
    }
    const p = players[i]!;
    p.intent =
      c.type === "moveTo"
        ? { targetX: c.x, targetY: c.y, sprint: c.sprint ?? false }
        : { targetX: null, targetY: null, sprint: false };
  }

  const counts: ContactCounts = { playerPlayer: 0, playerBall: 0, ballWall: 0 };
  for (const p of players) integratePlayer(p, config, dt);
  // Two relaxation passes keep clusters of players from overlapping.
  resolvePlayerCollisions(players, config, counts);
  resolvePlayerCollisions(players, config, counts);

  const ball: MutBall = { ...state.ball };
  integrateBall(ball, players, config, dt, counts);

  return {
    state: {
      seed: state.seed,
      tick: state.tick + 1,
      rng: state.rng,
      players: players as PlayerState[],
      ball,
      contacts: counts,
    },
    rejected,
  };
}
