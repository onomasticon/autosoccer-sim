/**
 * Restart handling and a minimal "safe" controller, built only on engine
 * commands and the observable match state (no engine internals).
 */
import type { CommandSource } from "@autosoccer/controller-sdk";
import type { EngineCommand, PlayerState, SimConfig, TeamId, WorldState } from "@autosoccer/sim-core";
import { attackSign, dcos, DEFAULT_CONFIG, dhypot, dsin, FORMATION, formationSpot, inOwnPenaltyArea, isRestartPhase, Rng } from "@autosoccer/sim-core";

/** Best simple target for a restart: nearest outfield teammate at least 3 m away, else up the pitch. */
function restartTarget(state: WorldState, taker: PlayerState, cfg: SimConfig): { x: number; y: number } {
  const r = state.match.restart!;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.team !== taker.team || p.id === taker.id || p.role === "GK") continue;
    const d = dhypot(p.x - r.x, p.y - r.y);
    if (d >= 3 && d < bestD) {
      bestD = d;
      best = { x: p.x, y: p.y };
    }
  }
  return best ?? { x: attackSign(taker.team, state.match) * (cfg.pitch.length / 2), y: 0 };
}

/**
 * Walk behind the ball (going round it if needed) so the player ends up facing
 * `dir`, then kick. Mirrors the engine's range and facing-cone checks so it
 * doesn't produce commands that would just be rejected.
 */
export function approachAndKick(
  p: PlayerState,
  bx: number,
  by: number,
  dirX: number,
  dirY: number,
  power: number,
  cfg: SimConfig = DEFAULT_CONFIG,
  sprint = false,
): EngineCommand[] {
  const l = dhypot(dirX, dirY) || 1;
  const dx = dirX / l;
  const dy = dirY / l;
  const relx = p.x - bx;
  const rely = p.y - by;
  const d = dhypot(relx, rely);
  const along = relx * dx + rely * dy; // > 0: player is on the wrong (target) side of the ball
  const facing = dcos(p.heading) * dx + dsin(p.heading) * dy;
  const standOff = cfg.player.radius + cfg.ball.radius + 0.12;
  if (d <= cfg.action.kickRange - 0.05 && along < 0.15 && facing > dcos(cfg.action.kickMaxAngle) + 0.15) {
    return [{ type: "kick", playerId: p.id, dirX: dx, dirY: dy, power }];
  }
  if (along > -standOff * 0.5) {
    // Go round the ball on the side the player is already on.
    const px = -dy;
    const py = dx;
    const s = relx * px + rely * py >= 0 ? 1 : -1;
    return [{ type: "moveTo", playerId: p.id, x: bx - dx * 1.1 + px * s * 1.1, y: by - dy * 1.1 + py * s * 1.1, sprint }];
  }
  if (d < standOff + 0.35) {
    // Behind the ball but not yet facing: step through it to turn toward the target.
    return [{ type: "moveTo", playerId: p.id, x: bx + dx * 0.6, y: by + dy * 0.6 }];
  }
  return [{ type: "moveTo", playerId: p.id, x: bx - dx * standOff, y: by - dy * standOff, sprint }];
}

/**
 * Commands for the designated taker of a pending restart (if it belongs to
 * `team`): walk to a spot just behind the ball in line with the target, then
 * kick once within range.
 */
export function restartCommands(state: WorldState, team: TeamId | "both", cfg: SimConfig = DEFAULT_CONFIG): EngineCommand[] {
  const m = state.match;
  const r = m.restart;
  if (!r || !isRestartPhase(m.phase)) return [];
  if (team !== "both" && r.team !== team) return [];
  const taker = state.players.find((p) => p.id === r.taker)!;
  const target = restartTarget(state, taker, cfg);
  const dx = target.x - r.x;
  const dy = target.y - r.y;
  const dl = dhypot(dx, dy) || 1;
  const d = dhypot(taker.x - r.x, taker.y - r.y);
  const cmds = approachAndKick(taker, r.x, r.y, dx, dy, Math.min(0.75, dl / 45 + 0.15), cfg, d > 6);
  // Before the ball is placed, only walk.
  return state.tick >= r.readyTick ? cmds : cmds.filter((c) => c.type !== "kick");
}

/**
 * Safe baseline controller: takes every restart, sends the nearest outfield
 * player at the ball (kicking it toward the opponents' goal when in range),
 * lets the keeper catch in its area and throw out, and keeps everyone else
 * near their formation spot for the current half. Used for soak tests.
 */
export function createSafeController(team: TeamId, cfg: SimConfig = DEFAULT_CONFIG): CommandSource {
  return {
    name: `safe-${team}`,
    team,
    decide({ state }) {
      const m = state.match;
      if (m.period !== "firstHalf" && m.period !== "secondHalf") return [];
      const out: EngineCommand[] = restartCommands(state, team, cfg);
      const busy = new Set(out.map((c) => ("playerId" in c ? c.playerId : "")));
      const mine = state.players.filter((p) => p.team === team && !busy.has(p.id));
      const ball = state.ball;
      const s = attackSign(team, m);
      const side = m.defends[team];

      if (m.phase === "openPlay") {
        const chaser = mine.filter((p) => p.role !== "GK").sort((a, b) => dhypot(a.x - ball.x, a.y - ball.y) - dhypot(b.x - ball.x, b.y - ball.y) || (a.id < b.id ? -1 : 1))[0];
        for (const p of mine) {
          const d = dhypot(ball.x - p.x, ball.y - p.y);
          if (p.role === "GK") {
            if (ball.heldBy === p.id) {
              if (ball.holdTicks > 45) out.push({ type: "release", playerId: p.id, dirX: s, dirY: 0.3, power: 0.55 });
              continue;
            }
            if (ball.heldBy === null && p.catchCooldown === 0 && d <= cfg.action.catchReach && inOwnPenaltyArea(team, ball.x, ball.y, cfg, m)) {
              out.push({ type: "catch", playerId: p.id });
            }
            const goalX = -s * (cfg.pitch.length / 2 - 1);
            out.push({ type: "moveTo", playerId: p.id, x: goalX, y: Math.max(-2, Math.min(2, ball.y * 0.2)) });
            continue;
          }
          if (p.id === chaser?.id) {
            if (ball.heldBy !== null) {
              out.push({ type: "moveTo", playerId: p.id, x: ball.x + s * 6, y: ball.y });
              continue;
            }
            const cmds = approachAndKick(p, ball.x, ball.y, s * (cfg.pitch.length / 2) - ball.x, -ball.y, 0.55, cfg, d > 4);
            out.push(...(p.touchCooldown > 0 ? cmds.filter((c) => c.type !== "kick") : cmds));
            continue;
          }
          const slot = FORMATION.findIndex((f) => f.number === p.number);
          const home = formationSpot(slot, side, cfg);
          out.push({ type: "moveTo", playerId: p.id, x: home.x + ball.x * 0.3, y: home.y + ball.y * 0.2 });
        }
      }
      return out;
    },
  };
}

/** Does nothing at all: every restart for this team must time out and fall back. */
export function createIdleController(team: TeamId): CommandSource {
  return { name: `idle-${team}`, team, decide: () => [] };
}

/**
 * Adversarial baseline: random (often invalid or illegal) commands for its own
 * players every decision tick, plus occasional garbage and commands for the
 * opponents (which the runtime drops). Used to prove the match can't be broken.
 */
export function createChaosController(team: TeamId, seed: number): CommandSource {
  const rng = new Rng(seed ^ 0xc4a05);
  const ids = [1, 2, 3, 4, 5].map((n) => `${team}-${n}`);
  const other = team === "blue" ? "red" : "blue";
  return {
    name: `chaos-${team}`,
    team,
    decide({ state }) {
      const out: unknown[] = [];
      for (const id of ids) {
        const r = rng.float();
        const b = state.ball;
        if (r < 0.3) out.push({ type: "moveTo", playerId: id, x: b.x + rng.range(-3, 3), y: b.y + rng.range(-3, 3), sprint: rng.bool(), dribble: rng.bool() });
        else if (r < 0.45) out.push({ type: "kick", playerId: id, dirX: rng.range(-1, 1), dirY: rng.range(-1, 1), power: rng.float() });
        else if (r < 0.5) out.push({ type: "tackle", playerId: id });
        else if (r < 0.55) out.push({ type: "catch", playerId: id });
        else if (r < 0.58) out.push({ type: "release", playerId: id, dirX: rng.range(-1, 1), dirY: 1, power: rng.float() });
        else if (r < 0.6) out.push({ type: "kick", playerId: id, dirX: Number.NaN, dirY: 0, power: 3 });
        else if (r < 0.62) out.push({ type: "teleport", playerId: id, x: 0, y: 0 });
        else if (r < 0.63) out.push({ type: "stop", playerId: `${other}-1` });
        else if (r < 0.64) out.push(null);
      }
      return out as EngineCommand[];
    },
  };
}
