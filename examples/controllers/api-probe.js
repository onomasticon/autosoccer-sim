// API probe: exercises every lifecycle callback and every action type, and
// logs what it sees. Useful as a living example of the SDK surface.
let info = null;
let seen = { updates: 0, actions: new Set(), events: {}, rejected: 0 };

function behind(p, bx, by, dx, dy) {
  const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
  const along = (p.x - bx) * dx + (p.y - by) * dy;
  if (along > -0.3) { const s = ((p.x - bx) * -dy + (p.y - by) * dx) >= 0 ? 1 : -1; return { x: bx - dx * 1.1 - dy * s * 1.1, y: by - dy * 1.1 + dx * s * 1.1 }; }
  return { x: bx - dx * 0.6, y: by - dy * 0.6 };
}

defineController({
  name: "api-probe",
  version: "1.0.0",
  initialize(i) {
    info = i;
    console.log("initialize", i.team, "sdk", i.sdkVersion, "engine", i.engineVersion, "players", i.players.map((p) => p.id).join(","), "kickRange", i.rules.kickRange);
  },
  update(obs) {
    seen.updates++;
    for (const e of obs.events) seen.events[e.type] = (seen.events[e.type] || 0) + 1;
    seen.rejected += obs.rejected.length;
    const acts = [];
    const dir = obs.attackingDirection;
    const ball = obs.ball;
    const [gk, d1, d2, mf, fw] = obs.teammates;
    // Restarts: our taker goes behind the ball and kicks to the nearest mate.
    if (obs.restart && obs.restart.ours) {
      const t = obs.teammates.find((p) => p.id === obs.restart.taker);
      const tx = obs.restart.x + dir * 8, ty = obs.restart.y * 0.5;
      const spot = behind(t, obs.restart.x, obs.restart.y, tx - obs.restart.x, ty - obs.restart.y);
      if (obs.restart.ready && Math.hypot(t.x - obs.restart.x, t.y - obs.restart.y) < info.rules.kickRange - 0.1 && Math.cos(t.heading) * (tx - obs.restart.x) + Math.sin(t.heading) * (ty - obs.restart.y) > 0) {
        acts.push({ type: "kick", player: t.id, direction: { x: tx - obs.restart.x, y: ty - obs.restart.y }, power: 0.3 });
      } else acts.push({ type: "moveTo", player: t.id, ...spot });
    }
    // Keeper: catch when possible, release (throw) after a moment.
    if (ball.heldBy === gk.id) {
      if (obs.tick % 120 < 6) acts.push({ type: "releaseBall", player: gk.number, direction: { x: dir, y: 0.4 }, power: 0.5 });
    } else if (!obs.restart && !ball.heldBy && gk.cooldowns.catch === 0 && Math.hypot(ball.x - gk.x, ball.y - gk.y) < info.rules.catchReach) acts.push({ type: "catchBall", player: gk.id });
    acts.push({ type: "moveTo", player: gk.id, x: -dir * 23.5, y: Math.max(-2, Math.min(2, ball.y * 0.3)) });
    // Forward: dribble at the ball, sprinting every other second; kick when close.
    if (!obs.restart) {
      const s = behind(fw, ball.x, ball.y, dir * 25 - ball.x, -ball.y);
      acts.push({ type: "moveTo", player: fw.id, x: s.x, y: s.y, dribble: true });
      acts.push({ type: "sprint", player: fw.id, on: Math.floor(obs.tick / 60) % 2 === 0 });
      if (Math.hypot(ball.x - fw.x, ball.y - fw.y) < info.rules.kickRange - 0.1) acts.push({ type: "kick", player: fw.id, direction: { x: dir * 25 - ball.x, y: -ball.y }, power: 0.8 });
      // Midfielder: tackle opponents near the ball.
      const opp = obs.opponents.find((o) => Math.hypot(o.x - ball.x, o.y - ball.y) < 1);
      if (opp && Math.hypot(ball.x - mf.x, ball.y - mf.y) < info.rules.tackleReach) acts.push({ type: "tackle", player: mf.id });
      else acts.push({ type: "moveTo", player: mf.id, x: (ball.x + -dir * 10) / 2, y: ball.y * 0.5 });
    }
    acts.push({ type: "moveTo", player: d1.id, x: -dir * 15, y: -6 }, { type: "stop", player: d2.id });
    for (const a of acts) seen.actions.add(a.type);
    if (seen.updates % 300 === 0) console.log("probe t=" + obs.tick, "actions used:", [...seen.actions].sort().join(","), "events:", JSON.stringify(seen.events), "rejected so far:", seen.rejected);
    return acts;
  },
  onMatchEnd(result) {
    console.log("onMatchEnd", JSON.stringify(result), "action types used:", [...seen.actions].sort().join(","));
  },
});
