/**
 * `Soccer` — the SDK's standard helper library, evaluated inside every
 * controller sandbox before the controller script (SDK ≥ 1.1). Pure,
 * deterministic JavaScript; nothing here touches the host. Documented in
 * docs/controller-sdk.md#helpers.
 */
export const HELPERS_SOURCE = String.raw`
(function () {
  "use strict";
  // Engine ball friction (see docs/simulation.md): dv/dt = -(A + B v).
  const A = 0.9, B = 0.25;
  const S = {};

  S.len = (x, y) => Math.hypot(x, y);
  S.dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  S.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  S.lerp = (a, b, t) => a + (b - a) * t;
  S.norm = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };

  /** Goal centres for the observing team this half. */
  S.oppGoal = (obs) => ({ x: obs.attackingDirection * 25, y: 0 });
  S.ownGoal = (obs) => ({ x: -obs.attackingDirection * 25, y: 0 });
  /** Distance "up the pitch" for the observing team: + is toward the opponents' goal. */
  S.forward = (obs, p) => p.x * obs.attackingDirection;
  S.inOwnBox = (obs, p) => -S.forward(obs, p) > 25 - 6 && Math.abs(p.y) < 7;
  S.inOppBox = (obs, p) => S.forward(obs, p) > 25 - 6 && Math.abs(p.y) < 7;

  /** Where a free-rolling ball will be after t seconds (ignores collisions). */
  S.ballAt = (ball, t) => {
    const v0 = Math.hypot(ball.vx, ball.vy);
    if (v0 < 1e-6) return { x: ball.x, y: ball.y, speed: 0 };
    const tStop = Math.log((v0 + A / B) / (A / B)) / B;
    const tt = Math.min(t, tStop);
    const s = ((v0 + A / B) * (1 - Math.exp(-B * tt))) / B - (A / B) * tt;
    const speed = Math.max(0, (v0 + A / B) * Math.exp(-B * tt) - A / B);
    return { x: ball.x + (ball.vx / v0) * s, y: ball.y + (ball.vy / v0) * s, speed };
  };

  /** Rolling distance of a ball kicked at speed v0 before it slows to vEnd. */
  S.rollDistance = (v0, vEnd) => {
    if (v0 <= vEnd) return 0;
    const t = Math.log((v0 + A / B) / (vEnd + A / B)) / B;
    return ((v0 + A / B) * (1 - Math.exp(-B * t))) / B - (A / B) * t;
  };

  /** Kick power so the ball still has ~arriveSpeed m/s after travelling distance d. */
  S.kickPowerFor = (d, arriveSpeed, rules) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const v0 = rules.minKickSpeed + (rules.maxKickSpeed - rules.minKickSpeed) * mid;
      if (S.rollDistance(v0, arriveSpeed) < d) lo = mid; else hi = mid;
    }
    return S.clamp(hi, 0, 1);
  };

  /** Rough seconds for player p to reach point q (straight line at top speed, plus a turn penalty). */
  S.timeToReach = (p, q, rules, sprint) => {
    const d = S.dist(p, q);
    const dir = Math.atan2(q.y - p.y, q.x - p.x);
    let turn = Math.abs(dir - p.heading) % (2 * Math.PI);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return d / (sprint ? rules.sprintSpeed : rules.maxSpeed) + turn * 0.12 + 0.15;
  };

  /** Earliest point on the ball's path that player p can reach first (or null within maxT s). */
  S.interceptPoint = (p, ball, rules, maxT) => {
    maxT = maxT || 3;
    for (let t = 0; t <= maxT; t += 0.1) {
      const b = S.ballAt(ball, t);
      if (Math.abs(b.x) > 25.5 || Math.abs(b.y) > 16.5) return null;
      if (S.timeToReach(p, b, rules, true) <= t + 0.05) return { x: b.x, y: b.y, t };
    }
    return null;
  };

  /** Smallest distance from any opponent to the segment from→to (opponents behind 'from' ignored). */
  S.laneClearance = (from, to, opponents) => {
    const dx = to.x - from.x, dy = to.y - from.y, L2 = dx * dx + dy * dy || 1;
    let best = Infinity;
    for (const o of opponents) {
      const t = ((o.x - from.x) * dx + (o.y - from.y) * dy) / L2;
      if (t < 0.05 || t > 1.05) continue;
      const px = from.x + dx * t, py = from.y + dy * t;
      // Opponents further along the lane have more time to close it.
      const d = Math.hypot(o.x - px, o.y - py) - t * 0.15 * Math.sqrt(L2) * 0.25;
      if (d < best) best = d;
    }
    return best;
  };

  /** Distance from p to the closest of the given players. */
  S.pressure = (p, players) => players.reduce((m, o) => Math.min(m, S.dist(p, o)), Infinity);

  S.nearest = (players, pt) => players.reduce((best, p) => (!best || S.dist(p, pt) < S.dist(best, pt) ? p : best), null);

  S.facingOk = (p, dx, dy, rules) => {
    const l = Math.hypot(dx, dy) || 1;
    return (Math.cos(p.heading) * dx + Math.sin(p.heading) * dy) / l > Math.cos(rules.kickMaxAngleRad) + 0.15;
  };

  /**
   * Move round behind the ball so the player faces 'target', then kick it
   * there with 'power'. Mirrors the engine's range/facing checks.
   * Returns actions for this player (movement and/or kick).
   */
  S.approachAndKick = (p, ball, target, power, rules, opts) => {
    opts = opts || {};
    const d0 = S.norm(target.x - ball.x, target.y - ball.y), dx = d0.x, dy = d0.y;
    const relx = p.x - ball.x, rely = p.y - ball.y, d = Math.hypot(relx, rely);
    const along = relx * dx + rely * dy;
    const standOff = 0.63;
    const acts = [];
    if (d <= rules.kickRange - 0.05 && along < 0.15 && p.cooldowns.touch === 0 && S.facingOk(p, dx, dy, rules)) {
      acts.push({ type: "kick", player: p.id, direction: { x: dx, y: dy }, power });
      return acts;
    }
    let goal;
    if (along > -standOff * 0.5) {
      const s = relx * -dy + rely * dx >= 0 ? 1 : -1;
      goal = { x: ball.x - dx * 1.1 - dy * s * 1.1, y: ball.y - dy * 1.1 + dx * s * 1.1 };
    } else if (d < standOff + 0.35) goal = { x: ball.x + dx * 0.6, y: ball.y + dy * 0.6 };
    else goal = { x: ball.x - dx * standOff, y: ball.y - dy * standOff };
    acts.push({ type: "moveTo", player: p.id, x: goal.x, y: goal.y, sprint: !!opts.sprint && d > 3, dribble: false });
    return acts;
  };

  /** Who controls the ball: { side: "own"|"opp"|null, player } — nearest player within 1.2 m. */
  S.possession = (obs) => {
    const b = obs.ball;
    if (b.heldBy) return { side: b.heldBy.startsWith(obs.team) ? "own" : "opp", player: obs.teammates.concat(obs.opponents).find((p) => p.id === b.heldBy) };
    let best = null, bd = 1.2;
    for (const p of obs.teammates) { const d = S.dist(p, b); if (d < bd && p.stunned === 0) { bd = d; best = { side: "own", player: p }; } }
    for (const p of obs.opponents) { const d = S.dist(p, b); if (d < bd && p.stunned === 0) { bd = d; best = { side: "opp", player: p }; } }
    return best || { side: null, player: null };
  };

  /** A target inside the opponents' goal, toward the side away from their keeper. */
  S.shotTarget = (obs) => {
    const gx = obs.attackingDirection * 25.3;
    const gk = obs.opponents.find((p) => p.role === "GK");
    const side = gk && gk.y > 0 ? -1 : 1;
    return { x: gx, y: side * 1.4 };
  };

  /** Our pending restart's taker (object) or null. */
  S.ourTaker = (obs) => (obs.restart && obs.restart.ours ? obs.teammates.find((p) => p.id === obs.restart.taker) : null);

  globalThis.Soccer = Object.freeze(S);
})();
`;
