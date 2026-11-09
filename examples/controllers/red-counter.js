// ─────────────────────────────────────────────────────────────────────────────
// RED · counterattack (SDK 1.1)
//
// Without the ball: a compact low block. Two defenders and a midfielder hold
// two narrow lines in front of our box, shifted toward the ball; only the
// block player nearest the ball engages (tackle / interception). The forward
// stays high on the far side as the outlet.
// On winning the ball: fast transition for 4 s — a direct, leading pass into
// the forward's run if the lane is open, otherwise the carrier drives forward
// at speed; the midfielder sprints up in support. Shots early, from range.
// Keeper: catches and releases long and quickly to the forward.
// Adapts: chasing the game → block pushes up and the midfielder presses;
// protecting a lead → deeper block.
// ─────────────────────────────────────────────────────────────────────────────

let R = null;
const memory = {
  phase: "block", // "block" | "counter" | "settled"
  counterUntil: 0,
  counters: 0,
  directPasses: 0,
  interceptions: 0,
  shots: 0,
  hadBall: false,
};

const clampPitch = (p) => ({ x: Soccer.clamp(p.x, -23.5, 23.5), y: Soccer.clamp(p.y, -15, 15) });

function urgency(obs) {
  if (obs.clock.half === 2 && obs.score.own < obs.score.opponent) return "chase";
  if (obs.clock.half === 2 && obs.score.own > obs.score.opponent) return "protect";
  return "normal";
}

/** Block line depths (metres from our goal line) for the current game state. */
function blockDepth(obs, style) {
  const ballUp = Soccer.forward(obs, obs.ball); // > 0 means the ball is in their half
  const push = Soccer.clamp(ballUp * 0.25, -3, 4) + (style === "chase" ? 6 : style === "protect" ? -2 : 0);
  return { defence: 9 + push, midfield: 15 + push };
}

function blockSlots(obs, style) {
  const dir = obs.attackingDirection;
  const { defence, midfield } = blockDepth(obs, style);
  const shift = Soccer.clamp(obs.ball.y * 0.45, -5, 5);
  const xAt = (depth) => (-25 + depth) * dir;
  return [
    { role: "DF", x: xAt(defence), y: shift - 4 },
    { role: "DF", x: xAt(defence), y: shift + 4 },
    { role: "MF", x: xAt(midfield), y: shift },
  ];
}

defineController({
  name: "red-counter",
  version: "1.0.0",

  initialize(info) {
    R = info.rules;
    console.log(`red-counter ready as ${info.team}`);
  },

  update(obs) {
    const actions = [];
    const debug = { mode: "", notes: [], lines: [] };
    const act = (a) => actions.push(a);
    const dir = obs.attackingDirection;
    const ball = obs.ball;
    const style = urgency(obs);
    const gk = obs.teammates.find((p) => p.role === "GK");
    const fw = obs.teammates.find((p) => p.role === "FW");
    const mf = obs.teammates.find((p) => p.role === "MF");
    const defs = obs.teammates.filter((p) => p.role === "DF");
    const done = new Set();
    const goal = Soccer.oppGoal(obs);
    const inPlay = obs.phase === "openPlay";

    for (const e of obs.events) {
      if (e.type === "trap" && e.interception && e.playerId.startsWith(obs.team)) memory.interceptions++;
    }

    // ── possession and transition memory ──
    const poss = Soccer.possession(obs);
    const ourReach = obs.teammates.filter((p) => p.role !== "GK").map((p) => ({ p, ip: Soccer.interceptPoint(p, ball, R, 3) })).filter((x) => x.ip).sort((a, b) => a.ip.t - b.ip.t)[0];
    const theirReach = obs.opponents.map((p) => Soccer.interceptPoint(p, ball, R, 3)).filter(Boolean).sort((a, b) => a.t - b.t)[0];
    const haveBall = poss.side === "own" || (poss.side === null && ourReach && (!theirReach || ourReach.ip.t + 0.1 < theirReach.t));
    if (inPlay && haveBall && !memory.hadBall) {
      memory.counterUntil = obs.tick + 4 * 60;
      memory.counters++;
      if (memory.counters <= 30) console.log(`t=${obs.tick} ball won → COUNTER #${memory.counters}`);
    }
    memory.hadBall = inPlay && haveBall;
    const countering = inPlay && haveBall && obs.tick < memory.counterUntil;
    debug.mode = !inPlay ? "set piece" : countering ? "COUNTER" : haveBall ? "attack (settled)" : "low block";
    if (style !== "normal") debug.mode += ` · ${style}`;

    // ── restarts ──
    const taker = Soccer.ourTaker(obs);
    if (taker) {
      const r = obs.restart;
      const spot = { x: r.x, y: r.y };
      let target;
      const fwdLane = fw.id !== taker.id ? Soccer.laneClearance(spot, fw, obs.opponents) : 0;
      if (r.type === "goalKick" || ((r.type === "freeKick" || r.type === "kickIn") && fwdLane > 1.2)) target = { x: fw.x + dir * 3, y: fw.y };
      else target = Soccer.nearest(obs.teammates.filter((p) => p.id !== taker.id && p.role !== "GK"), spot);
      const d = Soccer.dist(spot, target);
      const plan = Soccer.approachAndKick(taker, spot, target, Soccer.kickPowerFor(d, r.type === "goalKick" ? 7 : 5, R), R, { sprint: true });
      for (const a of plan) if (a.type !== "kick" || r.ready) act(a);
      done.add(taker.id);
      debug.mode = `restart: ${r.type}`;
      debug.notes.push(`${taker.id} ${r.type === "goalKick" ? "goes long" : "plays"} → (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`);
      debug.lines.push({ from: spot, to: target, kind: "pass" });
    }

    // ── goalkeeper ──
    if (!done.has(gk.id)) {
      const own = Soccer.ownGoal(obs);
      if (ball.heldBy === gk.id) {
        const to = { x: fw.x + dir * 4, y: fw.y };
        act({ type: "releaseBall", player: gk.id, direction: { x: to.x - ball.x, y: to.y - ball.y }, power: Soccer.clamp(Soccer.kickPowerFor(Soccer.dist(ball, to), 6, R), 0, 0.85) });
        debug.notes.push(`GK launches the counter → ${fw.id}`);
        debug.lines.push({ from: ball, to, kind: "pass" });
      } else {
        if (inPlay && !ball.heldBy && Soccer.dist(gk, ball) <= R.catchReach - 0.05 && Soccer.inOwnBox(obs, ball) && gk.cooldowns.catch === 0) act({ type: "catchBall", player: gk.id });
        const t = Soccer.clamp(1.2 / Math.max(1, Soccer.dist(ball, own)), 0, 1);
        act({ type: "moveTo", player: gk.id, x: own.x + (ball.x - own.x) * t, y: Soccer.clamp(ball.y * t, -1.8, 1.8) });
      }
      done.add(gk.id);
    }

    if (inPlay && haveBall) {
      // ── attack / counter ──
      const carrier = poss.side === "own" ? poss.player : ourReach.p;
      if (carrier && !done.has(carrier.id) && carrier.role !== "GK") {
        done.add(carrier.id);
        if (Soccer.dist(carrier, ball) > 1.3) {
          const ip = Soccer.interceptPoint(carrier, ball, R, 3) || ball;
          act({ type: "moveTo", player: carrier.id, x: ip.x, y: ip.y, sprint: true });
          debug.notes.push(`${carrier.id} wins the loose ball`);
        } else {
          const shot = Soccer.shotTarget(obs);
          const runTo = clampPitch({ x: fw.x + dir * 4, y: fw.y * 0.8 });
          const lane = carrier.id !== fw.id ? Soccer.laneClearance(ball, runTo, obs.opponents) : 0;
          const ahead = Soccer.forward(obs, fw) - Soccer.forward(obs, ball);
          if (Soccer.dist(ball, goal) < (style === "chase" ? 22 : 19) && Soccer.laneClearance(ball, shot, obs.opponents.filter((o) => o.role !== "GK")) > 0.7) {
            for (const a of Soccer.approachAndKick(carrier, ball, shot, 1, R)) act(a);
            if (actions.some((a) => a.type === "kick" && a.player === carrier.id)) memory.shots++;
            debug.notes.push(`${carrier.id} shoots early`);
            debug.lines.push({ from: ball, to: shot, kind: "shot" });
          } else if (carrier.id !== fw.id && lane > 1.3 && ahead > 6) {
            const power = Soccer.kickPowerFor(Soccer.dist(ball, runTo), 7, R);
            for (const a of Soccer.approachAndKick(carrier, ball, runTo, power, R)) act(a);
            if (actions.some((a) => a.type === "kick" && a.player === carrier.id)) memory.directPasses++;
            debug.notes.push(`${carrier.id} → ${fw.id} direct ball into the run (lane ${lane.toFixed(1)} m)`);
            debug.lines.push({ from: ball, to: runTo, kind: "pass" });
          } else {
            const o = Soccer.nearest(obs.opponents, carrier);
            const away = o ? Soccer.norm(carrier.x - o.x, carrier.y - o.y) : { x: 0, y: 0 };
            const t = clampPitch({ x: carrier.x + dir * 5, y: carrier.y + away.y * 2 });
            act({ type: "moveTo", player: carrier.id, x: t.x, y: t.y, dribble: true, sprint: countering && carrier.stamina > 0.25 });
            debug.notes.push(`${carrier.id} drives forward${countering ? " at pace" : ""}`);
            debug.lines.push({ from: carrier, to: t, kind: "run" });
          }
        }
      }
      if (!done.has(fw.id)) {
        // Forward runs in behind on the far side of the ball.
        const lastDef = obs.opponents.filter((o) => o.role !== "GK").reduce((m, o) => Math.max(m, Soccer.forward(obs, o)), -25);
        const run = clampPitch({ x: Soccer.clamp(lastDef + 2.5, 0, 20) * dir, y: ball.y > 0 ? -6 : 6 });
        act({ type: "moveTo", player: fw.id, x: run.x, y: run.y, sprint: countering });
        debug.lines.push({ from: fw, to: run, kind: "run" });
        done.add(fw.id);
      }
      if (!done.has(mf.id)) {
        const sup = clampPitch(countering ? { x: ball.x + dir * 3, y: ball.y > 0 ? ball.y - 7 : ball.y + 7 } : { x: ball.x - dir * 6, y: ball.y * 0.5 });
        act({ type: "moveTo", player: mf.id, x: sup.x, y: sup.y, sprint: countering && mf.stamina > 0.35 });
        done.add(mf.id);
      }
      for (const d of defs) if (!done.has(d.id)) {
        const s = blockSlots(obs, style).filter((x) => x.role === "DF")[defs.indexOf(d)];
        act({ type: "moveTo", player: d.id, x: s.x + dir * 4, y: s.y });
        done.add(d.id);
      }
    } else if (inPlay) {
      // ── low block ──
      const slots = blockSlots(obs, style);
      const block = obs.teammates.filter((p) => (p.role === "DF" || p.role === "MF") && !done.has(p.id));
      // Engage only when the ball is close to the block (or always, when chasing).
      const engageZone = Soccer.forward(obs, ball) < (style === "chase" ? 10 : -2);
      const engager = engageZone ? block.slice().sort((a, b) => Soccer.dist(a, ball) - Soccer.dist(b, ball))[0] : null;
      for (const p of block) {
        if (p === engager) {
          const ip = Soccer.interceptPoint(p, ball, R, 2.5) || ball;
          act({ type: "moveTo", player: p.id, x: ip.x, y: ip.y, sprint: Soccer.dist(p, ball) > 3 });
          if (poss.side === "opp" && Soccer.dist(p, ball) < R.tackleReach - 0.1 && p.cooldowns.tackle === 0 && !ball.heldBy) {
            act({ type: "tackle", player: p.id });
            debug.notes.push(`${p.id} steps out and tackles`);
          } else debug.notes.push(`${p.id} engages`);
          debug.lines.push({ from: p, to: ip, kind: "press" });
        } else {
          const s = p.role === "MF" ? slots[2] : slots[defs.indexOf(p)];
          act({ type: "moveTo", player: p.id, x: s.x, y: s.y });
        }
        done.add(p.id);
      }
      if (!done.has(fw.id)) {
        // Outlet: stays high on the weak side, ready for the counter.
        const out = clampPitch({ x: dir * 2, y: ball.y > 0 ? -7 : 7 });
        act({ type: "moveTo", player: fw.id, x: out.x, y: out.y });
        done.add(fw.id);
      }
    } else {
      // Dead ball: block shape with the forward as outlet.
      const slots = blockSlots(obs, style);
      for (const p of obs.teammates) {
        if (done.has(p.id)) continue;
        const s = p.role === "MF" ? slots[2] : p.role === "DF" ? slots[defs.indexOf(p)] : clampPitch({ x: dir * 2, y: ball.y > 0 ? -7 : 7 });
        act({ type: "moveTo", player: p.id, x: s.x, y: s.y });
      }
    }

    if (countering) debug.notes.unshift(`counter: ${((memory.counterUntil - obs.tick) / 60).toFixed(1)} s left`);
    return { actions, debug };
  },

  onMatchEnd(result) {
    console.log(`red-counter: ${result.outcome} ${result.score.own}-${result.score.opponent} · counters ${memory.counters} · direct passes ${memory.directPasses} · interceptions ${memory.interceptions} · shots ${memory.shots}`);
  },
});
