import type { ActionCommand, CommandRejection } from "./commands.ts";
import type { SimConfig } from "./config.ts";
import { datan2, dcos, dhypot, dsin } from "./dmath.ts";
import type { MutBall, MutPlayer } from "./physics.ts";
import type { Rng } from "./prng.ts";
import type { MatchState, PlayerId, SimEvent, TeamId } from "./types.ts";
import { clamp, wrapAngle } from "./vec.ts";
import { defendedSide } from "./world.ts";
import { attrScale, ratingDelta } from "./attributes.ts";

export interface ActionContext {
  players: MutPlayer[];
  ball: MutBall;
  cfg: SimConfig;
  rng: Rng;
  events: SimEvent[];
  rejected: CommandRejection[];
  /** Set once the ball has been deliberately played this tick. */
  ballPlayed: boolean;
  /** Current match state (which goal each team defends). */
  match: MatchState;
}

/**
 * Arbitration order within a tick. Lower runs first. Within a group, the
 * player nearest the ball goes first, ties broken by player ID. Once the ball
 * has been played (caught, released, tackled away or kicked) every later ball
 * action that tick is rejected — so simultaneous kicks have one deterministic
 * winner.
 */
const PRIORITY: Record<ActionCommand["type"], number> = { catch: 0, release: 1, tackle: 2, kick: 3 };

function teamOf(id: PlayerId): TeamId {
  return id.startsWith("blue") ? "blue" : "red";
}

function distToBall(p: MutPlayer, b: MutBall): number {
  return dhypot(b.x - p.x, b.y - p.y);
}

/** Is (x, y) inside the penalty area that `team` defends (this half, if `match` is given)? */
export function inOwnPenaltyArea(team: TeamId, x: number, y: number, cfg: SimConfig, match?: Pick<MatchState, "defends">): boolean {
  const halfL = cfg.pitch.length / 2;
  const side = defendedSide(team, match) === "left" ? -1 : 1;
  const fromLine = halfL - side * x; // distance from the defended goal line, ≥ 0 on pitch
  return fromLine >= 0 && fromLine <= cfg.pitch.penaltyAreaDepth && Math.abs(y) <= cfg.pitch.penaltyAreaWidth / 2;
}

/**
 * Seeded execution error: larger for harder kicks and tired players. `accuracy` scales it for the
 * kicker's passing or shooting rating (1 without attributes; 0.56 at 99, 1.66 at 1).
 */
function kickError(power: number, stamina: number, cfg: SimConfig, rng: Rng, accuracy = 1): number {
  const scale = cfg.action.kickErrorMax * power * power * (0.5 + 0.5 * (1 - stamina)) * accuracy;
  // Sum of two uniforms → triangular distribution in [-scale, scale].
  return (rng.float() + rng.float() - 1) * scale;
}

function launch(ball: MutBall, p: MutPlayer, dirX: number, dirY: number, speed: number, errorRad: number): { dirX: number; dirY: number } {
  const ang = datan2(dirY, dirX) + errorRad;
  const ux = dcos(ang);
  const uy = dsin(ang);
  // Ball leaves from the player's foot, with a fraction of the player's own velocity.
  ball.vx = ux * speed + p.vx * 0.3;
  ball.vy = uy * speed + p.vy * 0.3;
  ball.lastTouch = p.id;
  return { dirX: ux, dirY: uy };
}

export function resolveActions(ctx: ActionContext, actions: readonly ActionCommand[]): void {
  const { players, ball } = ctx;
  const byId = new Map(players.map((p) => [p.id, p] as const));
  const ordered = actions
    .map((a, i) => ({ a, i, p: byId.get(a.playerId)! }))
    .sort((x, y) => PRIORITY[x.a.type] - PRIORITY[y.a.type] || distToBall(x.p, ball) - distToBall(y.p, ball) || (x.a.playerId < y.a.playerId ? -1 : x.a.playerId > y.a.playerId ? 1 : x.i - y.i));

  for (const { a, p } of ordered) {
    const reason = executeAction(ctx, a, p);
    if (reason) ctx.rejected.push({ command: a, reason });
  }
}

/** Returns a rejection reason, or null if the action executed (successfully or not). */
function executeAction(ctx: ActionContext, a: ActionCommand, p: MutPlayer): string | null {
  const { ball, cfg, rng, events } = ctx;
  const ac = cfg.action;
  if (p.stunned > 0) return "player is grounded after a failed tackle";
  const d = distToBall(p, ball);

  switch (a.type) {
    case "kick": {
      if (ctx.ballPlayed) return "ball already played this tick";
      if (ball.heldBy !== null) return ball.heldBy === p.id ? "goalkeeper must use release while holding the ball" : "ball is held by a goalkeeper";
      if (p.touchCooldown > 0) return `touch cooldown (${p.touchCooldown} ticks)`;
      if (d > ac.kickRange) return `ball out of kick range (${d.toFixed(2)} m > ${ac.kickRange} m)`;
      const angle = Math.abs(wrapAngle(datan2(a.dirY, a.dirX) - p.heading));
      if (angle > ac.kickMaxAngle) return `kick direction ${((angle * 180) / Math.PI).toFixed(0)}° from facing (max ${((ac.kickMaxAngle * 180) / Math.PI).toFixed(0)}°)`;
      // Attributes: shot power scales the top kick speed; passing (soft kicks) or shooting (hard) the error.
      const maxKick = ac.maxKickSpeed * attrScale(cfg, p.id, "power", 0.12);
      const speed = ac.minKickSpeed + (maxKick - ac.minKickSpeed) * a.power;
      const accuracy = attrScale(cfg, p.id, a.power >= 0.75 ? "shooting" : "passing", -0.45);
      const err = kickError(a.power, p.stamina, cfg, rng, accuracy);
      const dir = launch(ball, p, a.dirX, a.dirY, speed, err);
      p.touchCooldown = ac.kickCooldownTicks;
      ctx.ballPlayed = true;
      events.push({ type: "kick", playerId: p.id, power: a.power, speed, dirX: dir.dirX, dirY: dir.dirY, errorRad: err });
      return null;
    }
    case "tackle": {
      if (ctx.ballPlayed) return "ball already played this tick";
      if (ball.heldBy !== null) return "cannot tackle a goalkeeper holding the ball";
      if (p.tackleCooldown > 0) return `tackle cooldown (${p.tackleCooldown} ticks)`;
      if (d > ac.tackleReach) return `ball out of tackle reach (${d.toFixed(2)} m > ${ac.tackleReach} m)`;
      // The opponent nearest the ball (if any is close) is the tackle's victim.
      let victim: MutPlayer | null = null;
      let vd = 1.2;
      for (const q of ctx.players) {
        if (q.team === p.team) continue;
        const qd = distToBall(q, ball);
        if (qd < vd) {
          vd = qd;
          victim = q;
        }
      }
      // Attributes: ±12 points of success chance for tackling at the extremes.
      let pSuccess = clamp(0.25 + 0.7 * (1 - d / ac.tackleReach) + 0.12 * ratingDelta(cfg, p.id, "tackling"), 0.05, 0.95);
      // Ball control: a player with the ball at their feet shields it (better on the ball, better shield).
      const control = ac.controlChance ?? 0;
      if (control > 0 && victim && ball.lastTouch === victim.id && vd <= ac.dribbleRange)
        pSuccess *= 1 - 0.4 * control * attrScale(cfg, victim.id, "control", 0.3);
      p.tackleCooldown = ac.tackleCooldownTicks;
      if (rng.float() < pSuccess) {
        // Poke the ball away from the tackler, through the ball.
        let ux = ball.x - p.x;
        let uy = ball.y - p.y;
        const l = dhypot(ux, uy) || 1;
        ux /= l;
        uy /= l;
        ball.vx = ux * ac.tackleKnockSpeed + p.vx * 0.5;
        ball.vy = uy * ac.tackleKnockSpeed + p.vy * 0.5;
        ball.lastTouch = p.id;
        p.touchCooldown = ac.kickCooldownTicks;
        if (victim) victim.touchCooldown = Math.max(victim.touchCooldown, ac.kickCooldownTicks);
        ctx.ballPlayed = true;
        events.push({ type: "tackle", playerId: p.id, success: true, victim: victim?.id ?? null });
      } else {
        p.stunned = ac.tackleFailStunTicks;
        events.push({ type: "tackle", playerId: p.id, success: false, victim: victim?.id ?? null });
      }
      return null;
    }
    case "catch": {
      if (p.role !== "GK") return "only goalkeepers can catch";
      if (ctx.ballPlayed) return "ball already played this tick";
      if (ball.heldBy !== null) return "ball already held";
      if (p.catchCooldown > 0) return `catch cooldown (${p.catchCooldown} ticks)`;
      if (!inOwnPenaltyArea(p.team, ball.x, ball.y, cfg, ctx.match)) return "ball is outside the goalkeeper's own penalty area";
      if (!inOwnPenaltyArea(p.team, p.x, p.y, cfg, ctx.match)) return "goalkeeper is outside own penalty area";
      // Attributes: goalkeeping scales reach (±15%) and adds up to ±10 points of catch chance.
      const reach = ac.catchReach * attrScale(cfg, p.id, "goalkeeping", 0.15);
      if (d > reach) return `ball out of catch reach (${d.toFixed(2)} m > ${reach.toFixed(2)} m)`;
      const rel = dhypot(ball.vx - p.vx, ball.vy - p.vy);
      if (rel > ac.catchMaxSpeed) return `ball too fast to catch (${rel.toFixed(1)} m/s)`;
      const pSuccess = clamp(
        0.97 - (rel / ac.catchMaxSpeed) * 0.5 - (d / reach) * 0.15 + 0.1 * ratingDelta(cfg, p.id, "goalkeeping"),
        0.2,
        0.97,
      );
      p.catchCooldown = ac.catchCooldownTicks;
      if (rng.float() < pSuccess) {
        ball.heldBy = p.id;
        ball.holdTicks = 0;
        ball.vx = p.vx;
        ball.vy = p.vy;
        ball.lastTouch = p.id;
        ctx.ballPlayed = true;
        events.push({ type: "catch", playerId: p.id, success: true, incomingSpeed: rel });
      } else {
        // Fumble: parry the ball away from goal at reduced speed.
        const awayX = defendedSide(p.team, ctx.match) === "left" ? 1 : -1;
        ball.vx = awayX * Math.max(3, rel * 0.35);
        ball.vy = ball.vy * 0.3;
        ball.lastTouch = p.id;
        ctx.ballPlayed = true;
        events.push({ type: "catch", playerId: p.id, success: false, incomingSpeed: rel });
      }
      return null;
    }
    case "release": {
      if (ball.heldBy !== p.id) return "player is not holding the ball";
      const speed = Math.min(ac.maxReleaseSpeed, ac.minKickSpeed + (ac.maxKickSpeed - ac.minKickSpeed) * a.power);
      const err = kickError(a.power * 0.7, p.stamina, cfg, rng, attrScale(cfg, p.id, "passing", -0.45));
      ball.heldBy = null;
      ball.holdTicks = 0;
      launch(ball, p, a.dirX, a.dirY, speed, err);
      p.touchCooldown = ac.kickCooldownTicks;
      p.catchCooldown = ac.catchCooldownTicks;
      ctx.ballPlayed = true;
      events.push({ type: "release", playerId: p.id, auto: false });
      return null;
    }
  }
}

/**
 * Automatic, intent-driven ball contacts that happen without a one-shot
 * command: dribble touches and trapping an incoming ball (which is an
 * interception when the last touch was by the other team). Players are
 * considered nearest-first so contested balls resolve deterministically.
 */
export function resolveAutoTouches(ctx: ActionContext): void {
  const { players, ball, cfg, rng, events } = ctx;
  const ac = cfg.action;
  if (ctx.ballPlayed || ball.heldBy !== null || ball.inGoal !== null) return;
  const control = ac.controlChance ?? 0;
  // Ball control: the last player to touch the ball, still close to it and on their feet, is shielding it.
  const shielder =
    control > 0 && ball.lastTouch !== null
      ? players.find((q) => q.id === ball.lastTouch && q.stunned === 0 && distToBall(q, ball) <= ac.dribbleRange)
      : undefined;
  const order = players
    .filter((p) => p.stunned === 0 && p.touchCooldown === 0)
    .map((p) => ({ p, d: distToBall(p, ball) }))
    .filter((x) => x.d <= Math.max(ac.dribbleRange, ac.kickRange))
    .sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));

  for (const { p, d } of order) {
    const relX = ball.vx - p.vx;
    const relY = ball.vy - p.vy;
    const rel = dhypot(relX, relY);
    // Ball approaching the player?
    const approaching = (ball.x - p.x) * relX + (ball.y - p.y) * relY < 0;

    // Trapping needs a genuinely moving ball, not a player running into a still one
    // (nor, with ball control, a ball the player is already dribbling).
    const ballSpeed = dhypot(ball.vx, ball.vy);
    const ownBall = control > 0 && ball.lastTouch === p.id;
    if (!ownBall && ballSpeed >= ac.trapMinSpeed && rel >= ac.trapMinSpeed && approaching && d <= ac.kickRange) {
      const lastTeam = ball.lastTouch ? teamOf(ball.lastTouch) : null;
      const interception = lastTeam !== null && lastTeam !== p.team;
      p.touchCooldown = ac.trapCooldownTicks;
      if (rel > ac.trapMaxSpeed) {
        events.push({ type: "trapMiss", playerId: p.id, incomingSpeed: rel });
        continue;
      }
      const q = rel / ac.trapMaxSpeed;
      const pSuccess = clamp(1 - q * q * 0.8 + 0.1 * ratingDelta(cfg, p.id, "control"), 0.1, 0.97);
      if (rng.float() < pSuccess) {
        // Cushion the ball to the player's velocity, slightly ahead of them.
        ball.vx = p.vx + dcos(p.heading) * 0.4;
        ball.vy = p.vy + dsin(p.heading) * 0.4;
        ball.lastTouch = p.id;
        ctx.ballPlayed = true;
        events.push({ type: "trap", playerId: p.id, interception, incomingSpeed: rel });
        return;
      }
      events.push({ type: "trapMiss", playerId: p.id, incomingSpeed: rel });
      continue;
    }

    if (control > 0 && p.intent.dribble && d <= ac.dribbleRange) {
      // Close control: touch the ball toward where the player is going, so they can turn with it.
      let ux = dcos(p.heading);
      let uy = dsin(p.heading);
      if (p.intent.targetX !== null && p.intent.targetY !== null) {
        const tx = p.intent.targetX - p.x;
        const ty = p.intent.targetY - p.y;
        const tl = dhypot(tx, ty);
        if (tl > 0.3) {
          ux = tx / tl;
          uy = ty / tl;
        }
      }
      const rx = ball.x - p.x;
      const ry = ball.y - p.y;
      const ahead = rx * ux + ry * uy;
      if (ahead >= 0.25) {
        // Ball in front: knock it on, just ahead of the player's pace.
        const along = Math.max(0, p.vx * ux + p.vy * uy);
        // Better ball control keeps the ball closer (a smaller push ahead).
        const touchSpeed = along + ac.dribbleTouchBoost * attrScale(cfg, p.id, "control", -0.3);
        ball.vx = ux * touchSpeed;
        ball.vy = uy * touchSpeed;
        p.touchCooldown = ac.dribbleCooldownTicks;
      } else {
        // Ball beside or behind: roll it round the foot toward the new direction (a turn), via
        // the side it's already on so it never passes through the player.
        const nx = -uy;
        const ny = ux;
        const side = rx * nx + ry * ny >= 0 ? 1 : -1;
        const r = cfg.player.radius + cfg.ball.radius + 0.12;
        const aimX = ahead > -0.15 ? p.x + ux * r : p.x + nx * side * r + ux * 0.15;
        const aimY = ahead > -0.15 ? p.y + uy * r : p.y + ny * side * r + uy * 0.15;
        const gx = aimX - ball.x;
        const gy = aimY - ball.y;
        const gl = dhypot(gx, gy) || 1;
        const roll = Math.min(3, gl * 8);
        ball.vx = p.vx + (gx / gl) * roll;
        ball.vy = p.vy + (gy / gl) * roll;
        p.touchCooldown = Math.max(1, Math.round(ac.dribbleCooldownTicks / 2));
      }
      ball.lastTouch = p.id;
      ctx.ballPlayed = true;
      events.push({ type: "dribbleTouch", playerId: p.id });
      return;
    }

    if (control > 0 && d <= ac.kickRange && ball.lastTouch !== p.id && (!shielder || shielder.team === p.team)) {
      // Collect: a player reaching a loose or slow ball usually settles it at their feet.
      const lastTeam = ball.lastTouch ? teamOf(ball.lastTouch) : null;
      p.touchCooldown = ac.trapCooldownTicks;
      if (rng.float() < Math.min(0.98, control * attrScale(cfg, p.id, "control", 0.12))) {
        ball.vx = p.vx;
        ball.vy = p.vy;
        ball.lastTouch = p.id;
        ctx.ballPlayed = true;
        events.push({ type: "trap", playerId: p.id, interception: lastTeam !== null && lastTeam !== p.team, incomingSpeed: rel });
        return;
      }
      events.push({ type: "trapMiss", playerId: p.id, incomingSpeed: rel });
      continue;
    }

    if (p.intent.dribble && d <= ac.dribbleRange) {
      const hx = dcos(p.heading);
      const hy = dsin(p.heading);
      const ahead = (ball.x - p.x) * hx + (ball.y - p.y) * hy;
      if (ahead <= 0) continue; // ball is behind: run round it first
      const pSpeed = dhypot(p.vx, p.vy);
      const touchSpeed = pSpeed + ac.dribbleTouchBoost;
      ball.vx = hx * touchSpeed;
      ball.vy = hy * touchSpeed;
      ball.lastTouch = p.id;
      p.touchCooldown = ac.dribbleCooldownTicks;
      ctx.ballPlayed = true;
      events.push({ type: "dribbleTouch", playerId: p.id });
      return;
    }
  }
}

/** Keep a held ball in the keeper's hands; keeper stays in area; auto-drop after max hold. */
export function updateHeldBall(ctx: ActionContext): void {
  const { ball, players, cfg, events } = ctx;
  if (ball.heldBy === null) return;
  const k = players.find((p) => p.id === ball.heldBy)!;
  // Keeper may not carry the ball out of the penalty area.
  const halfL = cfg.pitch.length / 2;
  const side = defendedSide(k.team, ctx.match) === "left" ? -1 : 1;
  const r = cfg.player.radius;
  const lineX = side * halfL;
  const innerX = side * (halfL - cfg.pitch.penaltyAreaDepth);
  const minX = Math.min(lineX, innerX) + (side < 0 ? 0 : r);
  const maxX = Math.max(lineX, innerX) - (side < 0 ? r : 0);
  const ly = cfg.pitch.penaltyAreaWidth / 2;
  if (k.x < minX || k.x > maxX) {
    k.x = clamp(k.x, minX, maxX);
    k.vx = 0;
  }
  if (Math.abs(k.y) > ly) {
    k.y = clamp(k.y, -ly, ly);
    k.vy = 0;
  }
  ball.holdTicks += 1;
  const hx = dcos(k.heading);
  const hy = dsin(k.heading);
  ball.x = k.x + hx * (r + cfg.ball.radius + 0.05);
  ball.y = k.y + hy * (r + cfg.ball.radius + 0.05);
  ball.vx = k.vx;
  ball.vy = k.vy;
  if (ball.holdTicks > cfg.action.maxHoldTicks) {
    ball.heldBy = null;
    ball.holdTicks = 0;
    ball.vx = k.vx + hx * 2;
    ball.vy = k.vy + hy * 2;
    k.touchCooldown = cfg.action.kickCooldownTicks;
    k.catchCooldown = cfg.action.catchCooldownTicks;
    events.push({ type: "release", playerId: k.id, auto: true });
  }
}
