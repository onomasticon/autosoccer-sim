import type { SimConfig } from "./config.ts";
import type { BallState, PlayerState, SimEvent } from "./types.ts";
import { datan2, dcos, dhypot, dsin } from "./dmath.ts";
import { clamp, wrapAngle } from "./vec.ts";

/** Mutable scratch copies used inside a single step; never escape `step`. */
export type MutPlayer = { -readonly [K in keyof PlayerState]: PlayerState[K] };
export type MutBall = { -readonly [K in keyof BallState]: BallState[K] };

export interface ContactCounts {
  playerPlayer: number;
  playerBall: number;
  ballWall: number;
}

/** Max ball travel per sub-step (m); well under the 0.51 m contact distance, so no tunnelling. */
const MAX_SUBSTEP_TRAVEL = 0.1;
const NET_RESTITUTION = 0.15;
/** Per-tick velocity factor while the ball is inside a goal net. */
const NET_DAMPING = 0.8;

/**
 * Kinematic player model: the player turns its heading toward the target at a
 * speed-dependent turn rate and accelerates along its heading. Velocity
 * changes are capped per tick, so players can never teleport.
 */
export function integratePlayer(p: MutPlayer, cfg: SimConfig, dt: number): void {
  const pc = cfg.player;
  const speed = dhypot(p.vx, p.vy);
  let desiredVx = 0;
  let desiredVy = 0;
  let sprinting = false;

  if (p.stunned === 0 && p.intent.targetX !== null && p.intent.targetY !== null) {
    const dx = p.intent.targetX - p.x;
    const dy = p.intent.targetY - p.y;
    const d = dhypot(dx, dy);
    if (d > pc.arriveRadius) {
      sprinting = p.intent.sprint && p.stamina > pc.sprintThreshold;
      const top = sprinting ? pc.sprintSpeed : pc.maxSpeed;
      // Arrive behaviour: never plan to overshoot the target.
      const arriveSpeed = Math.sqrt(2 * pc.deceleration * Math.max(0, d - pc.arriveRadius));
      const want = Math.min(top, arriveSpeed);

      const desiredHeading = datan2(dy, dx);
      const t = clamp(speed / pc.sprintSpeed, 0, 1);
      const rate = pc.turnRate + (pc.turnRateAtSprint - pc.turnRate) * t;
      const diff = wrapAngle(desiredHeading - p.heading);
      const maxTurn = rate * dt;
      p.heading = wrapAngle(p.heading + clamp(diff, -maxTurn, maxTurn));

      // Moving well away from the facing direction is slow: scale by alignment.
      const align = dcos(wrapAngle(desiredHeading - p.heading));
      const k = want * Math.max(0.15, align);
      desiredVx = dcos(p.heading) * k;
      desiredVy = dsin(p.heading) * k;
    }
  }

  // Steer velocity toward desired velocity with bounded acceleration.
  const ddx = desiredVx - p.vx;
  const ddy = desiredVy - p.vy;
  const dmag = dhypot(ddx, ddy);
  const desiredSpeed = dhypot(desiredVx, desiredVy);
  const limit = (desiredSpeed >= speed ? pc.acceleration : pc.deceleration) * dt;
  if (dmag > limit) {
    p.vx += (ddx / dmag) * limit;
    p.vy += (ddy / dmag) * limit;
  } else {
    p.vx = desiredVx;
    p.vy = desiredVy;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // Stamina: drain only while actually sprinting above jog speed.
  const newSpeed = dhypot(p.vx, p.vy);
  if (sprinting && newSpeed > pc.maxSpeed * 0.8) {
    p.stamina = Math.max(0, p.stamina - pc.staminaDrain * dt);
  } else {
    p.stamina = Math.min(1, p.stamina + pc.staminaRecovery * dt);
  }

  // Players stay within pitch + run-off.
  const lx = cfg.pitch.length / 2 + cfg.pitch.runOff - pc.radius;
  const ly = cfg.pitch.width / 2 + cfg.pitch.runOff - pc.radius;
  if (p.x < -lx || p.x > lx) {
    p.x = clamp(p.x, -lx, lx);
    p.vx = 0;
  }
  if (p.y < -ly || p.y > ly) {
    p.y = clamp(p.y, -ly, ly);
    p.vy = 0;
  }
}

/**
 * Resolve player-player overlaps. Equal masses; pairs are visited in stable
 * (i < j) index order, which is stable ID order, so results are deterministic.
 */
export function resolvePlayerCollisions(players: MutPlayer[], cfg: SimConfig, counts: ContactCounts): void {
  const r2 = cfg.player.radius * 2;
  const restitution = 0.2;
  for (let i = 0; i < players.length; i++) {
    const a = players[i]!;
    for (let j = i + 1; j < players.length; j++) {
      const b = players[j]!;
      let nx = b.x - a.x;
      let ny = b.y - a.y;
      let d = dhypot(nx, ny);
      if (d >= r2) continue;
      if (d < 1e-9) {
        // Perfectly coincident: separate along a deterministic axis.
        nx = 1;
        ny = 0;
        d = 0;
      } else {
        nx /= d;
        ny /= d;
      }
      const overlap = r2 - d;
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn < 0) {
        const jImp = (-(1 + restitution) * vn) / 2;
        a.vx -= jImp * nx;
        a.vy -= jImp * ny;
        b.vx += jImp * nx;
        b.vy += jImp * ny;
      }
      counts.playerPlayer++;
    }
  }
}

/**
 * Ball boundaries. Touchlines and goal lines are *not* walls: the ball can
 * leave play (the match layer awards the restart). Physical obstacles are:
 * the posts, the goal nets (a box behind each mouth that the ball may enter
 * only through the mouth) and the boards around the run-off area.
 * `px`/`py` are the ball position at the start of the sub-step.
 */
function collideBoundaries(ball: MutBall, px: number, py: number, cfg: SimConfig, counts: ContactCounts): void {
  const r = cfg.ball.radius;
  const e = cfg.ball.wallRestitution;
  const halfL = cfg.pitch.length / 2;
  const halfW = cfg.pitch.width / 2;
  const gw2 = cfg.pitch.goalWidth / 2;
  const depth = cfg.pitch.goalDepth;
  const sx = ball.x < 0 ? -1 : 1;
  const pax = Math.abs(px);
  const wasInNet = pax > halfL && Math.abs(py) < gw2;

  // Crossing the goal-line plane: through the mouth, onto a post, or wide.
  if (pax <= halfL && Math.abs(ball.x) > halfL) {
    const ay = Math.abs(ball.y);
    if (ay >= gw2 - r && ay <= gw2 + r) {
      ball.x = sx * (halfL - (Math.abs(ball.x) - halfL));
      ball.vx = -ball.vx * e;
      counts.ballWall++;
    }
  }

  const ax = Math.abs(ball.x);
  if (ax > halfL) {
    const inNet = wasInNet || (pax <= halfL && Math.abs(ball.y) < gw2 - r);
    if (inNet) {
      const back = halfL + depth - r;
      if (ax > back) {
        ball.x = sx * back;
        ball.vx = -ball.vx * NET_RESTITUTION;
        counts.ballWall++;
      }
      if (Math.abs(ball.y) > gw2 - r) {
        ball.y = (ball.y < 0 ? -1 : 1) * (gw2 - r);
        ball.vy = -ball.vy * NET_RESTITUTION;
        counts.ballWall++;
      }
    } else if (Math.abs(ball.y) < gw2 + r && ax < halfL + depth + r) {
      // Outside the goal, bumping into the side or back of the net.
      if (Math.abs(py) >= gw2 + r - 1e-9) {
        ball.y = (py < 0 ? -1 : 1) * (gw2 + r);
        ball.vy = -ball.vy * NET_RESTITUTION;
      } else {
        ball.x = sx * (halfL + depth + r);
        ball.vx = -ball.vx * NET_RESTITUTION;
      }
      counts.ballWall++;
    }
  }

  // Boards around the run-off.
  const lx = halfL + cfg.pitch.runOff - r;
  const ly = halfW + cfg.pitch.runOff - r;
  if (Math.abs(ball.x) > lx) {
    ball.x = sx * lx;
    ball.vx = -ball.vx * e * 0.5;
    counts.ballWall++;
  }
  if (Math.abs(ball.y) > ly) {
    ball.y = (ball.y < 0 ? -1 : 1) * ly;
    ball.vy = -ball.vy * e * 0.5;
    counts.ballWall++;
  }
}

/**
 * Advance the free ball with adaptive sub-stepping (each sub-step moves at
 * most 0.1 m, so even a 26 m/s shot can't tunnel through a player). Ball
 * contacts with players treat the player as effectively infinite mass
 * (75 kg vs 0.43 kg). The ball is never attached to an outfield player.
 */
export function integrateBall(
  ball: MutBall,
  players: readonly MutPlayer[],
  cfg: SimConfig,
  dt: number,
  counts: ContactCounts,
  events: SimEvent[],
): void {
  const bc = cfg.ball;
  const speed0 = dhypot(ball.vx, ball.vy);
  const n = Math.max(2, Math.min(64, Math.ceil((speed0 * dt) / MAX_SUBSTEP_TRAVEL)));
  const h = dt / n;
  const contactDist = cfg.player.radius + bc.radius;
  const halfL = cfg.pitch.length / 2;
  const gw2 = cfg.pitch.goalWidth / 2;
  const touched = new Set<number>();

  for (let s = 0; s < n; s++) {
    const px = ball.x;
    const py = ball.y;
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
    collideBoundaries(ball, px, py, cfg, counts);

    // Goal: the whole ball has crossed the goal line between the posts.
    if (ball.inGoal === null && Math.abs(ball.x) > halfL + bc.radius && Math.abs(ball.y) < gw2) {
      ball.inGoal = ball.x < 0 ? "left" : "right";
      events.push({ type: "goal", side: ball.inGoal });
    }

    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      let nx = ball.x - p.x;
      let ny = ball.y - p.y;
      let d = dhypot(nx, ny);
      if (d >= contactDist) continue;
      if (d < 1e-9) {
        nx = dcos(p.heading);
        ny = dsin(p.heading);
        d = 0;
      } else {
        nx /= d;
        ny /= d;
      }
      ball.x = p.x + nx * contactDist;
      ball.y = p.y + ny * contactDist;
      const vn = (ball.vx - p.vx) * nx + (ball.vy - p.vy) * ny;
      if (vn < 0) {
        ball.vx -= (1 + bc.playerRestitution) * vn * nx;
        ball.vy -= (1 + bc.playerRestitution) * vn * ny;
      }
      ball.lastTouch = p.id;
      touched.add(i);
    }
    // A player against the boards can push the ball into them: the boards win.
    const bx = cfg.pitch.length / 2 + cfg.pitch.runOff - bc.radius;
    const by = cfg.pitch.width / 2 + cfg.pitch.runOff - bc.radius;
    if (Math.abs(ball.x) > bx) {
      ball.x = (ball.x < 0 ? -1 : 1) * bx;
      if (ball.x * ball.vx > 0) ball.vx = -ball.vx * bc.wallRestitution * 0.5;
    }
    if (Math.abs(ball.y) > by) {
      ball.y = (ball.y < 0 ? -1 : 1) * by;
      if (ball.y * ball.vy > 0) ball.vy = -ball.vy * bc.wallRestitution * 0.5;
    }
  }
  counts.playerBall += touched.size;

  // The net absorbs the ball: heavy damping once it is behind the goal line.
  if (Math.abs(ball.x) > halfL && Math.abs(ball.y) < gw2) {
    ball.vx *= NET_DAMPING;
    ball.vy *= NET_DAMPING;
  }

  // Rolling friction + linear drag, applied once per tick.
  const speed = dhypot(ball.vx, ball.vy);
  if (speed > 0) {
    const newSpeed = speed - (bc.rollingFriction + bc.linearDrag * speed) * dt;
    if (newSpeed <= bc.stopSpeed) {
      ball.vx = 0;
      ball.vy = 0;
    } else {
      const k = newSpeed / speed;
      ball.vx *= k;
      ball.vy *= k;
    }
  }
}
