// "Chaser": aggressive, ball-focused. Two players hunt the ball and tackle;
// the ball carrier dribbles straight at goal and shoots from 18 m.
const S = { kickRange: 0.85, tackle: 1.3 };
function behind(p, bx, by, dx, dy) {
  const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
  const along = (p.x - bx) * dx + (p.y - by) * dy;
  if (along > -0.3) { const s = ((p.x - bx) * -dy + (p.y - by) * dx) >= 0 ? 1 : -1; return { x: bx - dx * 1.1 - dy * s * 1.1, y: by - dy * 1.1 + dx * s * 1.1 }; }
  return { x: bx - dx * 0.5, y: by - dy * 0.5 };
}
const facing = (p, dx, dy) => Math.cos(p.heading) * dx + Math.sin(p.heading) * dy > 0.3 * Math.hypot(dx, dy);
defineController({
  name: "chaser",
  version: "1.0.0",
  initialize(info) { S.kickRange = info.rules.kickRange; S.tackle = info.rules.tackleReach; },
  update(obs) {
    const dir = obs.attackingDirection, b = obs.ball, out = [];
    const goal = { x: dir * 25, y: 0 };
    const mates = obs.teammates;
    if (obs.restart && obs.restart.ours) {
      const t = mates.find((p) => p.id === obs.restart.taker);
      const dx = dir * 10, dy = -obs.restart.y * 0.3;
      if (obs.restart.ready && Math.hypot(t.x - b.x, t.y - b.y) < S.kickRange - 0.1 && facing(t, dx, dy)) out.push({ type: "kick", player: t.id, direction: { x: dx, y: dy }, power: 0.45 });
      else out.push({ type: "moveTo", player: t.id, ...behind(t, b.x, b.y, dx, dy) });
    }
    const field = mates.filter((p) => p.role !== "GK" && !(obs.restart && p.id === obs.restart.taker));
    field.sort((a, c) => Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(c.x - b.x, c.y - b.y));
    field.forEach((p, i) => {
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (i < 2 && !obs.restart) {
        const toGoal = Math.hypot(goal.x - b.x, goal.y - b.y);
        if (d < S.kickRange - 0.1 && p.cooldowns.touch === 0 && toGoal < 18 && facing(p, goal.x - b.x, goal.y - b.y)) out.push({ type: "kick", player: p.id, direction: { x: goal.x - b.x, y: goal.y - b.y + (Math.random() - 0.5) * 2 }, power: 0.95 });
        else if (i === 0 && obs.opponents.some((o) => Math.hypot(o.x - b.x, o.y - b.y) < 1) && d < S.tackle && p.cooldowns.tackle === 0) out.push({ type: "tackle", player: p.id });
        const s = behind(p, b.x, b.y, goal.x - b.x, goal.y - b.y);
        out.push({ type: "moveTo", player: p.id, x: s.x, y: s.y, sprint: p.stamina > 0.4, dribble: i === 0 });
      } else out.push({ type: "moveTo", player: p.id, x: b.x - dir * 6 + (i - 2) * 3 * dir, y: (i % 2 ? -1 : 1) * 6 });
    });
    const gk = mates[0];
    if (b.heldBy === gk.id) out.push({ type: "releaseBall", player: gk.id, direction: { x: dir, y: 0.3 }, power: 0.6 });
    else if (!obs.restart && !b.heldBy && Math.hypot(b.x - gk.x, b.y - gk.y) < 1.3 && gk.cooldowns.catch === 0) out.push({ type: "catchBall", player: gk.id });
    out.push({ type: "moveTo", player: gk.id, x: -dir * 23.6, y: Math.max(-1.8, Math.min(1.8, b.y * 0.25)) });
    return out;
  },
});
