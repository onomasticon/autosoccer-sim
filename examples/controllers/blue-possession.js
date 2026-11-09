// ─────────────────────────────────────────────────────────────────────────────
// BLUE · possession (SDK 1.1)
//
// With the ball: patient build-up through short passes. The carrier scores
// every teammate by lane clearance, space and forward progress and only plays
// forward when the lane is open; otherwise it dribbles into space. Two players
// offer wide support, one stays as a deep pivot and the forward makes runs in
// behind the last defender. Shots only from good positions.
// Without the ball: high press — the nearest player hunts the carrier and
// tackles, the second cuts the most likely passing lane, the rest mark goal-side.
// Adapts: chasing the game late → shoots from further and presses higher;
// protecting a lead late → keeps the ball and plays safer.
// Uses only the public SDK: observations in, actions out (+ optional debug).
// ─────────────────────────────────────────────────────────────────────────────

let R = null; // engine rules from initialize()
const memory = {
  mode: "kickoff",
  passesTried: 0,
  passesCompleted: 0,
  shots: 0,
  tackles: 0,
  lastKicker: null,
  modeChanges: 0,
};

// ── tactical helpers ────────────────────────────────────────────────────────

/** Game-state adaptation from score and clock. */
function urgency(obs) {
  const late = obs.clock.half === 2 && obs.clock.secondsInHalf > obs.clock.halfDurationSec * 0.4;
  if (obs.clock.half === 2 && obs.score.own < obs.score.opponent) return "chase";
  if (late && obs.score.own > obs.score.opponent) return "protect";
  return "normal";
}

/** Score a pass from the ball to teammate m; null when the pass isn't on. */
function passValue(obs, ball, m, style) {
  const d = Soccer.dist(ball, m);
  if (d < 4 || d > (style === "chase" ? 26 : 20)) return null;
  const lane = Soccer.laneClearance(ball, m, obs.opponents);
  if (lane < 1.1) return null;
  const progress = Soccer.forward(obs, m) - Soccer.forward(obs, ball);
  const space = Math.min(Soccer.pressure(m, obs.opponents), 7);
  const fwdWeight = style === "chase" ? 1.0 : style === "protect" ? 0.2 : 0.55;
  return progress * fwdWeight + space * 0.8 + Math.min(lane, 4) * 0.5 - d * 0.05 - (m.role === "GK" ? 3 : 0);
}

function bestPass(obs, ball, carrier, style) {
  let best = null;
  for (const m of obs.teammates) {
    if (m.id === carrier.id) continue;
    const v = passValue(obs, ball, m, style);
    if (v !== null && (!best || v > best.value)) best = { mate: m, value: v };
  }
  return best;
}

/** Lead the receiver slightly so the ball arrives where they are going. */
function leadPoint(m) {
  return { x: m.x + m.vx * 0.35, y: m.y + m.vy * 0.35 };
}

/** Greedy role assignment: each slot gets the nearest unassigned player. */
function assign(players, slots) {
  const free = players.slice();
  const out = [];
  for (const s of slots) {
    if (!free.length) break;
    let bi = 0;
    for (let i = 1; i < free.length; i++) if (Soccer.dist(free[i], s) < Soccer.dist(free[bi], s)) bi = i;
    out.push({ player: free[bi], slot: s });
    free.splice(bi, 1);
  }
  return out;
}

/** Push a support spot away from the nearest opponent so it's actually open. */
function opened(obs, spot) {
  const o = Soccer.nearest(obs.opponents, spot);
  if (!o) return spot;
  const d = Soccer.dist(o, spot);
  if (d > 3) return spot;
  const n = Soccer.norm(spot.x - o.x, spot.y - o.y);
  return { x: spot.x + n.x * (3 - d), y: Soccer.clamp(spot.y + n.y * (3 - d), -15, 15) };
}

const clampPitch = (p) => ({ x: Soccer.clamp(p.x, -23.5, 23.5), y: Soccer.clamp(p.y, -15, 15) });

// ── controller ──────────────────────────────────────────────────────────────

defineController({
  name: "blue-possession",
  version: "1.0.0",

  initialize(info) {
    R = info.rules;
    console.log(`blue-possession ready as ${info.team}; kickRange ${R.kickRange} m`);
  },

  update(obs) {
    const actions = [];
    const debug = { mode: "", notes: [], lines: [] };
    const dir = obs.attackingDirection;
    const ball = obs.ball;
    const gk = obs.teammates.find((p) => p.role === "GK");
    const field = obs.teammates.filter((p) => p.role !== "GK" && p.stunned === 0);
    const style = urgency(obs);
    const done = new Set();
    const act = (a) => { actions.push(a); };

    // Memory: pass completion from the event stream.
    for (const e of obs.events) {
      if (e.type === "kick" && e.playerId.startsWith(obs.team)) memory.lastKicker = e.playerId;
      else if (e.type === "trap" && memory.lastKicker) {
        if (e.playerId.startsWith(obs.team) && e.playerId !== memory.lastKicker) memory.passesCompleted++;
        memory.lastKicker = null;
      } else if (e.type === "tackle" && e.playerId.startsWith(obs.team)) memory.tackles++;
    }

    // ── restarts ──
    const taker = Soccer.ourTaker(obs);
    if (taker) {
      const r = obs.restart;
      const spot = { x: r.x, y: r.y };
      let target;
      if (r.type === "kickoff") target = Soccer.nearest(field.filter((p) => p.id !== taker.id), spot);
      else {
        const bp = bestPass(obs, spot, taker, style === "chase" ? "chase" : "normal");
        target = bp ? leadPoint(bp.mate) : Soccer.nearest(obs.teammates.filter((p) => p.id !== taker.id), spot);
      }
      const d = Soccer.dist(spot, target);
      const plan = Soccer.approachAndKick(taker, spot, target, Soccer.kickPowerFor(d, 5, R), R, { sprint: true });
      for (const a of plan) if (a.type !== "kick" || r.ready) act(a);
      done.add(taker.id);
      debug.mode = `restart: ${r.type}`;
      debug.notes.push(`${taker.id} takes ${r.type} → (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`);
      debug.lines.push({ from: spot, to: { x: target.x, y: target.y }, kind: "pass" });
    }

    // ── who gets to the ball first? ──
    const inPlay = obs.phase === "openPlay";
    const poss = Soccer.possession(obs);
    const ourReach = field.map((p) => ({ p, ip: Soccer.interceptPoint(p, ball, R, 3) })).filter((x) => x.ip).sort((a, b) => a.ip.t - b.ip.t)[0];
    const theirReach = obs.opponents.map((p) => Soccer.interceptPoint(p, ball, R, 3)).filter(Boolean).sort((a, b) => a.t - b.t)[0];
    const weHaveIt = poss.side === "own" || (poss.side === null && ourReach && (!theirReach || ourReach.ip.t <= theirReach.t));
    const mode = !inPlay ? debug.mode || "set piece" : weHaveIt ? (style === "protect" ? "keep-ball" : "build-up") : "high press";
    if (mode !== memory.mode) {
      memory.modeChanges++;
      if (memory.modeChanges <= 40) console.log(`t=${obs.tick} mode ${memory.mode} → ${mode}${style !== "normal" ? ` (${style})` : ""}`);
      memory.mode = mode;
    }
    debug.mode = mode + (style !== "normal" ? ` · ${style}` : "");

    // ── goalkeeper ──
    if (!done.has(gk.id)) {
      const own = Soccer.ownGoal(obs);
      if (ball.heldBy === gk.id) {
        const outlets = field.map((m) => ({ m, v: passValue(obs, ball, m, "protect") })).filter((x) => x.v !== null).sort((a, b) => b.v - a.v);
        const to = outlets.length ? leadPoint(outlets[0].m) : { x: ball.x + dir * 15, y: ball.y > 0 ? -8 : 8 };
        act({ type: "releaseBall", player: gk.id, direction: { x: to.x - ball.x, y: to.y - ball.y }, power: Soccer.kickPowerFor(Soccer.dist(ball, to), 5, R) });
        debug.notes.push(`GK distributes short → (${to.x.toFixed(1)}, ${to.y.toFixed(1)})`);
        debug.lines.push({ from: ball, to, kind: "pass" });
      } else {
        const close = Soccer.dist(gk, ball) <= R.catchReach - 0.05 && Soccer.inOwnBox(obs, ball) && gk.cooldowns.catch === 0;
        if (inPlay && close && !ball.heldBy) act({ type: "catchBall", player: gk.id });
        // Stand on the ball-goal line, 1.5 m off the goal line.
        const t = Soccer.clamp(1.5 / Math.max(1, Soccer.dist(ball, own)), 0, 1);
        act({ type: "moveTo", player: gk.id, x: own.x + (ball.x - own.x) * t, y: Soccer.clamp(own.y + (ball.y - own.y) * t, -1.8, 1.8) });
      }
      done.add(gk.id);
    }

    if (inPlay && weHaveIt) {
      // ── in possession ──
      const carrier = poss.side === "own" ? poss.player : ourReach.p;
      if (carrier && !done.has(carrier.id) && carrier.role !== "GK") {
        done.add(carrier.id);
        const near = Soccer.dist(carrier, ball) < 1.3;
        if (!near) {
          const ip = Soccer.interceptPoint(carrier, ball, R, 3) || ball;
          act({ type: "moveTo", player: carrier.id, x: ip.x, y: ip.y, sprint: carrier.stamina > 0.3 });
          debug.notes.push(`${carrier.id} collects the ball`);
        } else {
          const goal = Soccer.oppGoal(obs);
          const shotRange = style === "chase" ? 21 : style === "protect" ? 13 : 17;
          const shot = Soccer.shotTarget(obs);
          const pressure = Soccer.pressure(carrier, obs.opponents);
          const bp = bestPass(obs, ball, carrier, style);
          if (Soccer.dist(ball, goal) < shotRange && Soccer.laneClearance(ball, shot, obs.opponents.filter((o) => o.role !== "GK")) > 0.8) {
            for (const a of Soccer.approachAndKick(carrier, ball, shot, 1, R)) act(a);
            if (actions.some((a) => a.type === "kick" && a.player === carrier.id)) memory.shots++;
            debug.notes.push(`${carrier.id} shoots at (${shot.x.toFixed(1)}, ${shot.y.toFixed(1)})`);
            debug.lines.push({ from: ball, to: shot, kind: "shot" });
          } else if (bp && (bp.value > 3.2 || pressure < 2.6)) {
            const to = leadPoint(bp.mate);
            for (const a of Soccer.approachAndKick(carrier, ball, to, Soccer.kickPowerFor(Soccer.dist(ball, to), 5, R), R)) act(a);
            if (actions.some((a) => a.type === "kick" && a.player === carrier.id)) memory.passesTried++;
            debug.notes.push(`${carrier.id} → ${bp.mate.id} pass (value ${bp.value.toFixed(1)}, pressure ${pressure.toFixed(1)} m)`);
            debug.lines.push({ from: ball, to, kind: "pass" });
          } else {
            // Dribble toward goal, bending away from the nearest defender.
            const o = Soccer.nearest(obs.opponents, carrier);
            const away = o ? Soccer.norm(carrier.x - o.x, carrier.y - o.y) : { x: 0, y: 0 };
            const t = clampPitch({ x: carrier.x + dir * 4 + away.x * 1.5, y: carrier.y + away.y * 2 - carrier.y * 0.1 });
            act({ type: "moveTo", player: carrier.id, x: t.x, y: t.y, dribble: true, sprint: carrier.stamina > 0.5 && pressure > 3 });
            debug.notes.push(`${carrier.id} dribbles into space`);
            debug.lines.push({ from: carrier, to: t, kind: "run" });
          }
        }
      }
      // Support shape around the ball.
      const lastDef = obs.opponents.filter((o) => o.role !== "GK").reduce((m, o) => Math.max(m, Soccer.forward(obs, o)), -25);
      const runX = Soccer.clamp(lastDef + 3, -10, 20) * dir;
      const slots = [
        clampPitch({ x: runX, y: ball.y > 0 ? -5 : 5 }), // forward run in behind, far side
        opened(obs, clampPitch({ x: ball.x + dir * 2, y: ball.y + 9 })), // wide support
        opened(obs, clampPitch({ x: ball.x + dir * 2, y: ball.y - 9 })), // wide support
        opened(obs, clampPitch({ x: ball.x - dir * 7, y: ball.y * 0.5 })), // deep pivot
      ];
      const support = field.filter((p) => !done.has(p.id));
      const fwd = support.find((p) => p.role === "FW");
      const order = fwd ? [fwd].concat(support.filter((p) => p !== fwd)) : support;
      const assigned = [{ player: order[0], slot: slots[0] }].concat(assign(order.slice(1), slots.slice(1))).filter((x) => x.player);
      for (const { player, slot } of assigned) {
        act({ type: "moveTo", player: player.id, x: slot.x, y: slot.y, sprint: slot === slots[0] && player.stamina > 0.4 });
        done.add(player.id);
        if (slot === slots[0]) debug.lines.push({ from: player, to: slot, kind: "run" });
      }
    } else if (inPlay) {
      // ── high press ──
      const chasers = field.filter((p) => !done.has(p.id)).sort((a, b) => Soccer.dist(a, ball) - Soccer.dist(b, ball));
      const p1 = chasers[0];
      if (p1) {
        const ip = Soccer.interceptPoint(p1, ball, R, 2.5) || ball;
        act({ type: "moveTo", player: p1.id, x: ip.x, y: ip.y, sprint: p1.stamina > (style === "chase" ? 0.2 : 0.35) });
        const oppCarrier = poss.side === "opp" ? poss.player : null;
        if (oppCarrier && Soccer.dist(p1, ball) < R.tackleReach - 0.1 && p1.cooldowns.tackle === 0 && !ball.heldBy) {
          act({ type: "tackle", player: p1.id });
          debug.notes.push(`${p1.id} tackles ${oppCarrier.id}`);
        } else debug.notes.push(`${p1.id} presses the ball`);
        debug.lines.push({ from: p1, to: ip, kind: "press" });
        done.add(p1.id);
      }
      const carrierOpp = poss.side === "opp" ? poss.player : Soccer.nearest(obs.opponents, ball);
      const outlet = obs.opponents.filter((o) => o !== carrierOpp && o.role !== "GK").sort((a, b) => Soccer.dist(a, ball) - Soccer.dist(b, ball))[0];
      const p2 = chasers[1];
      if (p2 && outlet) {
        const cut = { x: Soccer.lerp(ball.x, outlet.x, 0.45), y: Soccer.lerp(ball.y, outlet.y, 0.45) };
        act({ type: "moveTo", player: p2.id, x: cut.x, y: cut.y, sprint: p2.stamina > 0.4 });
        debug.lines.push({ from: p2, to: cut, kind: "cover" });
        done.add(p2.id);
      }
      // Remaining players mark goal-side, holding a high line.
      const marks = obs.opponents.filter((o) => o.role !== "GK" && o !== carrierOpp && o !== outlet);
      const rest = field.filter((p) => !done.has(p.id));
      const lineFloor = (style === "chase" ? -6 : -12) * dir;
      for (const { player, slot } of assign(rest, marks.map((o) => ({ x: o.x - dir * 1.6, y: o.y })))) {
        const x = dir > 0 ? Math.max(slot.x, lineFloor) : Math.min(slot.x, lineFloor);
        act({ type: "moveTo", player: player.id, x, y: slot.y });
        done.add(player.id);
      }
    } else {
      // Dead ball (not our restart, or set-up phase): hold a compact shape, 4 m off the ball.
      const rest = field.filter((p) => !done.has(p.id));
      const base = obs.restart ? { x: obs.restart.x, y: obs.restart.y } : ball;
      const slots = [
        { x: base.x - dir * 5, y: base.y * 0.5 - 5 },
        { x: base.x - dir * 5, y: base.y * 0.5 + 5 },
        { x: base.x - dir * 9, y: 0 },
        { x: base.x + dir * 6, y: -base.y * 0.3 },
      ].map(clampPitch);
      for (const { player, slot } of assign(rest, slots)) act({ type: "moveTo", player: player.id, x: slot.x, y: slot.y });
    }

    return { actions, debug };
  },

  onMatchEnd(result) {
    console.log(`blue-possession: ${result.outcome} ${result.score.own}-${result.score.opponent} · passes ${memory.passesCompleted}/${memory.passesTried} · shots ${memory.shots} · tackles ${memory.tackles}`);
  },
});
