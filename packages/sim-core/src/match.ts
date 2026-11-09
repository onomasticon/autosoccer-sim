/**
 * Match flow (M3): periods, play phases, clock, score, sides, out-of-play,
 * restarts with designated takers, simplified fouls and deterministic
 * fallbacks so that no controller behaviour can stall a match.
 *
 * Called from `step` in three places:
 *   - `filterActionsForPhase` before actions resolve (phase permissions)
 *   - `enforceRestartConstraints` after player movement (distance rules)
 *   - `updateMatch` after the ball moves (detection, transitions, timers)
 */
import type { ActionCommand, CommandRejection } from "./commands.ts";
import type { SimConfig } from "./config.ts";
import { datan2, dcos, dhypot, dsin } from "./dmath.ts";
import type { MutBall, MutPlayer } from "./physics.ts";
import type { MatchState, Period, Phase, PlayerId, Restart, RestartType, SimEvent, TeamId } from "./types.ts";
import { clamp } from "./vec.ts";
import { attackSign, defendedSide, FORMATION, formationSpot, otherTeam } from "./world.ts";

export type MutMatch = { -readonly [K in keyof MatchState]: MatchState[K] };

export interface MatchContext {
  /** Tick being computed (the input state's tick). */
  tick: number;
  match: MutMatch;
  players: MutPlayer[];
  ball: MutBall;
  cfg: SimConfig;
  events: SimEvent[];
}

const RESTART_PHASES: ReadonlySet<Phase> = new Set(["kickoff", "kickIn", "corner", "goalKick", "freeKick"]);

export function isRestartPhase(p: Phase): boolean {
  return RESTART_PHASES.has(p);
}
export function inPlayPeriod(p: Period): boolean {
  return p === "firstHalf" || p === "secondHalf";
}
/** Ball is placed and locked at the restart spot, waiting for the taker. */
export function isBallLocked(m: MatchState, tick: number): boolean {
  return m.restart !== null && isRestartPhase(m.phase) && tick >= m.restart.readyTick;
}

const teamOf = (id: PlayerId): TeamId => (id.startsWith("blue") ? "blue" : "red");

// ───────────────────────────── permissions ─────────────────────────────

export function filterActionsForPhase(ctx: MatchContext, actions: readonly ActionCommand[], rejected: CommandRejection[]): ActionCommand[] {
  const { match: m, tick } = ctx;
  const out: ActionCommand[] = [];
  for (const a of actions) {
    let reason: string | null = null;
    if (!inPlayPeriod(m.period)) reason = `play is stopped (${m.period})`;
    else if (m.phase === "goalScored" || m.phase === "stopped") reason = `play is stopped (${m.phase})`;
    else if (isRestartPhase(m.phase) && m.restart) {
      const r = m.restart;
      if (a.type !== "kick") reason = `ball is dead (${r.type}): only the taker's kick is allowed`;
      else if (a.playerId !== r.taker) reason = `only the designated taker (${r.taker}) may take the ${r.type}`;
      else if (tick < r.readyTick) reason = `${r.type} not ready yet (ball is being placed)`;
    }
    if (reason) rejected.push({ command: a, reason });
    else out.push(a);
  }
  return out;
}

/** After actions resolved: did the taker's kick take the restart? */
export function noteRestartTaken(ctx: MatchContext): void {
  const { match: m, events } = ctx;
  if (!m.restart || !isRestartPhase(m.phase)) return;
  const r = m.restart;
  if (events.some((e) => e.type === "kick" && e.playerId === r.taker)) {
    events.push({ type: "restartTaken", restart: r.type, team: r.team, taker: r.taker, fallback: false });
    m.phase = "openPlay";
    m.restart = null;
  }
}

// ───────────────────────── restart constraints ─────────────────────────

/**
 * While a restart is pending, opponents are walked out of the exclusion zone
 * (no teleporting: at most sprint speed per tick), and at kickoff everyone
 * except the taker is walked back into their own half. Players are also kept
 * out of a locked ball.
 */
export function enforceRestartConstraints(ctx: MatchContext): void {
  const { match: m, players, ball, cfg, tick } = ctx;
  if (!m.restart || !isRestartPhase(m.phase)) return;
  const r = m.restart;
  const dt = 1 / cfg.tickRate;
  const maxMove = cfg.player.sprintSpeed * dt;
  const radius = r.type === "kickoff" ? cfg.pitch.centreCircleRadius : cfg.match.restartDistance;
  const locked = tick >= r.readyTick;

  for (const p of players) {
    if (p.id === r.taker) continue;
    if (p.team !== r.team) {
      const dx = p.x - r.x;
      const dy = p.y - r.y;
      const d = dhypot(dx, dy);
      if (d < radius) {
        const ux = d > 1e-9 ? dx / d : p.team === "blue" ? -1 : 1;
        const uy = d > 1e-9 ? dy / d : 0;
        const mv = Math.min(maxMove, radius - d);
        p.x += ux * mv;
        p.y += uy * mv;
        const vin = p.vx * ux + p.vy * uy;
        if (vin < 0) {
          p.vx -= vin * ux;
          p.vy -= vin * uy;
        }
      }
    }
    if (r.type === "kickoff") {
      const s = attackSign(p.team, m); // own half is where sign*x <= 0
      const over = s * p.x + cfg.player.radius;
      if (over > 0) {
        p.x -= s * Math.min(maxMove, over);
        if (s * p.vx > 0) p.vx = 0;
      }
    }
  }

  if (locked) {
    // Locked ball is a static obstacle.
    const contact = cfg.player.radius + cfg.ball.radius;
    for (const p of players) {
      const dx = p.x - ball.x;
      const dy = p.y - ball.y;
      const d = dhypot(dx, dy);
      if (d < contact) {
        const ux = d > 1e-9 ? dx / d : 1;
        const uy = d > 1e-9 ? dy / d : 0;
        p.x = ball.x + ux * contact;
        p.y = ball.y + uy * contact;
      }
    }
  }
}

/** Hold the ball at the restart spot once it's ready. */
export function lockBall(ctx: MatchContext): void {
  const r = ctx.match.restart!;
  Object.assign(ctx.ball, { x: r.x, y: r.y, vx: 0, vy: 0, heldBy: null, holdTicks: 0, inGoal: null });
}

// ───────────────────────────── transitions ─────────────────────────────

function chooseTaker(ctx: MatchContext, team: TeamId, type: RestartType, x: number, y: number): PlayerId {
  const wantGK = type === "goalKick";
  let best: MutPlayer | null = null;
  let bestD = Infinity;
  for (const p of ctx.players) {
    if (p.team !== team) continue;
    if (wantGK !== (p.role === "GK")) continue;
    const d = dhypot(p.x - x, p.y - y);
    if (d < bestD || (d === bestD && best && p.id < best.id)) {
      best = p;
      bestD = d;
    }
  }
  return best!.id;
}

function award(ctx: MatchContext, type: Exclude<RestartType, "kickoff">, team: TeamId, x: number, y: number, settleTicks: number): void {
  const { match: m, tick, cfg, events } = ctx;
  const taker = chooseTaker(ctx, team, type, x, y);
  const readyTick = tick + settleTicks;
  m.phase = type;
  m.restart = { type, team, x, y, taker, awardedTick: tick, readyTick, deadlineTick: readyTick + cfg.match.restartTimeoutTicks };
  events.push({ type: "restartAwarded", restart: type, team, taker, x, y });
}

/** Engine-placed kickoff: ball on the centre spot, everyone in kickoff formation for the current sides. */
function setupKickoff(ctx: MatchContext, team: TeamId): void {
  const { match: m, players, ball, cfg, tick, events } = ctx;
  for (const p of players) {
    const slot = FORMATION.findIndex((s) => s.number === p.number);
    const side = defendedSide(p.team, m);
    const spot = formationSpot(slot, side, cfg);
    const facing = attackSign(p.team, m);
    Object.assign(p, {
      x: spot.x,
      y: spot.y,
      vx: 0,
      vy: 0,
      heading: facing > 0 ? 0 : Math.PI,
      intent: { targetX: null, targetY: null, sprint: false, dribble: false },
      touchCooldown: 0,
      tackleCooldown: 0,
      catchCooldown: 0,
      stunned: 0,
    });
  }
  // The kicking team's forward stands at the ball, in its own half.
  const kicker = players.find((p) => p.team === team && p.role === "FW")!;
  const s = attackSign(team, m);
  kicker.x = -s * (cfg.player.radius + cfg.ball.radius + 0.1);
  kicker.y = 0;
  Object.assign(ball, { x: 0, y: 0, vx: 0, vy: 0, heldBy: null, holdTicks: 0, inGoal: null, lastTouch: null });
  m.phase = "kickoff";
  m.restart = { type: "kickoff", team, x: 0, y: 0, taker: kicker.id, awardedTick: tick, readyTick: tick, deadlineTick: tick + cfg.match.restartTimeoutTicks };
  events.push({ type: "restartAwarded", restart: "kickoff", team, taker: kicker.id, x: 0, y: 0 });
}

/** Deterministic fallback: the engine takes the restart on the taker's behalf. */
function fallbackRestart(ctx: MatchContext): void {
  const { match: m, players, ball, cfg, events } = ctx;
  const r = m.restart!;
  const taker = players.find((p) => p.id === r.taker)!;
  // Pass to the nearest teammate; if none sensible, play it toward the opponents' goal.
  let target: { x: number; y: number } = { x: attackSign(r.team, m) * (cfg.pitch.length / 2), y: 0 };
  let bestD = Infinity;
  for (const p of players) {
    if (p.team !== r.team || p.id === r.taker || p.role === "GK") continue;
    const d = dhypot(p.x - r.x, p.y - r.y);
    if (d > 2 && d < bestD) {
      bestD = d;
      target = { x: p.x, y: p.y };
    }
  }
  const dist = dhypot(target.x - r.x, target.y - r.y) || 1;
  const power = clamp(dist / 45 + 0.12, 0.2, 0.7);
  const speed = cfg.action.minKickSpeed + (cfg.action.maxKickSpeed - cfg.action.minKickSpeed) * power;
  const ang = datan2(target.y - r.y, target.x - r.x);
  const ux = dcos(ang);
  const uy = dsin(ang);
  ball.x = r.x;
  ball.y = r.y;
  ball.vx = ux * speed;
  ball.vy = uy * speed;
  ball.lastTouch = taker.id;
  taker.touchCooldown = cfg.action.kickCooldownTicks;
  events.push({ type: "kick", playerId: taker.id, power, speed, dirX: ux, dirY: uy, errorRad: 0 });
  events.push({ type: "restartTaken", restart: r.type, team: r.team, taker: r.taker, fallback: true });
  m.phase = "openPlay";
  m.restart = null;
}

function endHalf(ctx: MatchContext): void {
  const { match: m, tick, cfg, events } = ctx;
  events.push({ type: "periodEnd", period: m.period });
  m.restart = null;
  m.phase = "stopped";
  if (m.period === "firstHalf") {
    m.period = "halftime";
    m.resumeTick = tick + cfg.match.halftimeTicks;
    events.push({ type: "periodStart", period: "halftime" });
  } else {
    m.period = "fullTime";
    events.push({ type: "periodStart", period: "fullTime" });
  }
}

/**
 * Main per-tick match update, after the ball has moved:
 * timers → clock → goal / out-of-play / foul detection → restart readiness and fallbacks.
 */
export function updateMatch(ctx: MatchContext): void {
  const { match: m, tick, cfg, ball, events, players } = ctx;
  const halfL = cfg.pitch.length / 2;
  const halfW = cfg.pitch.width / 2;
  const r = cfg.ball.radius;

  // Timed pauses.
  if (m.period === "preMatch" && tick + 1 >= m.resumeTick) {
    m.period = "firstHalf";
    m.halfTicks = 0;
    events.push({ type: "periodStart", period: "firstHalf" });
    setupKickoff(ctx, m.firstKickoff);
    return;
  }
  if (m.period === "halftime" && tick + 1 >= m.resumeTick) {
    m.period = "secondHalf";
    m.halfTicks = 0;
    m.defends = { blue: m.defends.red, red: m.defends.blue };
    events.push({ type: "sidesSwitched", defends: m.defends });
    events.push({ type: "periodStart", period: "secondHalf" });
    setupKickoff(ctx, otherTeam(m.firstKickoff));
    return;
  }
  if (!inPlayPeriod(m.period)) return;

  // Clock.
  if (cfg.match.clockPolicy === "running" || m.phase === "openPlay") m.halfTicks++;
  if (m.halfTicks >= cfg.halfDurationSec * cfg.tickRate) {
    endHalf(ctx);
    return;
  }

  if (m.phase === "goalScored") {
    if (tick + 1 >= m.resumeTick) {
      // Conceding team kicks off: the team defending the goal the ball went into.
      const conceding = m.defends.blue === ball.inGoal ? "blue" : "red";
      setupKickoff(ctx, conceding);
    }
    return;
  }

  if (m.phase === "openPlay") {
    // Goal?
    if (ball.inGoal) {
      const conceding: TeamId = m.defends.blue === ball.inGoal ? "blue" : "red";
      const scoring = otherTeam(conceding);
      const scorer = ball.lastTouch;
      m.score = { ...m.score, [scoring]: m.score[scoring] + 1 };
      m.phase = "goalScored";
      m.resumeTick = tick + cfg.match.goalCelebrationTicks;
      m.restart = null;
      events.push({ type: "goalScored", team: scoring, scorer, ownGoal: scorer !== null && teamOf(scorer) === conceding, score: m.score });
      return;
    }
    // Fouls: a failed tackle that makes contact with the victim.
    for (const e of events) {
      if (e.type !== "tackle" || e.success || !e.victim) continue;
      const by = players.find((p) => p.id === e.playerId)!;
      const vic = players.find((p) => p.id === e.victim)!;
      if (dhypot(by.x - vic.x, by.y - vic.y) > cfg.match.foulContactDistance) continue;
      events.push({ type: "foul", by: by.id, against: vic.id, x: ball.x, y: ball.y });
      let fx = clamp(ball.x, -halfL + 1, halfL - 1);
      const fy = clamp(ball.y, -halfW + 1, halfW - 1);
      // No penalties in this ruleset: a foul inside the defending team's area is taken from its edge.
      const defSide = defendedSide(by.team, m);
      const lineX = defSide === "left" ? -halfL : halfL;
      if (Math.abs(fx - lineX) < cfg.pitch.penaltyAreaDepth && Math.abs(fy) < cfg.pitch.penaltyAreaWidth / 2) {
        fx = lineX + (defSide === "left" ? 1 : -1) * cfg.pitch.penaltyAreaDepth;
      }
      award(ctx, "freeKick", vic.team, fx, fy, 30);
      return;
    }
    // Out of play: the whole ball over a line.
    const outSide = Math.abs(ball.y) > halfW + r;
    const outEnd = Math.abs(ball.x) > halfL + r;
    if (outSide || outEnd) {
      const last = ball.lastTouch ? teamOf(ball.lastTouch) : null;
      events.push({ type: "ballOut", line: outEnd ? "goalLine" : "touchline", x: ball.x, y: ball.y, lastTouch: ball.lastTouch });
      if (outEnd) {
        const side = ball.x < 0 ? "left" : "right";
        const defending: TeamId = m.defends.blue === side ? "blue" : "red";
        const sx = side === "left" ? -1 : 1;
        if (last === defending) {
          const sy = ball.y < 0 ? -1 : 1;
          award(ctx, "corner", otherTeam(defending), sx * (halfL - r), sy * (halfW - r), cfg.match.outSettleTicks);
        } else {
          award(ctx, "goalKick", defending, sx * (halfL - cfg.match.goalKickSpot), 0, cfg.match.outSettleTicks);
        }
      } else {
        // Nobody touched it (e.g. straight from a debug placement): give it to the team defending that half.
        const team: TeamId = last ? otherTeam(last) : m.defends.blue === (ball.x < 0 ? "left" : "right") ? "blue" : "red";
        const sy = ball.y < 0 ? -1 : 1;
        award(ctx, "kickIn", team, clamp(ball.x, -halfL + 0.5, halfL - 0.5), sy * (halfW - r), cfg.match.outSettleTicks);
      }
      return;
    }
    return;
  }

  // Pending restart: fall back if the taker never takes it.
  if (isRestartPhase(m.phase) && m.restart && tick + 1 >= m.restart.deadlineTick) {
    fallbackRestart(ctx);
  }
}
