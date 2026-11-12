// "Zonal": keeps a compact 2-2 shape relative to the ball, only the nearest
// player engages, and wins the ball by intercepting; passes forward to the
// most advanced teammate.
const R = { kickRange: 0.85 };
// 6 and 7 are only used in 7-a-side.
const SHAPE = { 2: [-10, -5], 3: [-10, 5], 4: [-3, 0], 5: [4, 3], 6: [-3, -9], 7: [-3, 9] };
function behind(p, bx, by, dx, dy) {
  const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
  const along = (p.x - bx) * dx + (p.y - by) * dy;
  if (along > -0.3) { const s = ((p.x - bx) * -dy + (p.y - by) * dx) >= 0 ? 1 : -1; return { x: bx - dx * 1.1 - dy * s * 1.1, y: by - dy * 1.1 + dx * s * 1.1 }; }
  return { x: bx - dx * 0.5, y: by - dy * 0.5 };
}
const facing = (p, dx, dy) => Math.cos(p.heading) * dx + Math.sin(p.heading) * dy > 0.3 * Math.hypot(dx, dy);
defineController({
  name: "zonal",
  version: "1.0.0",
  initialize(info) { R.kickRange = info.rules.kickRange; },
  update(obs) {
    const dir = obs.attackingDirection, b = obs.ball, out = [], mates = obs.teammates;
    const shapeX = Math.max(-18, Math.min(14, b.x * dir * 0.6)) * dir;
    const field = mates.filter((p) => p.role !== "GK");
    const engager = field.reduce((a, c) => (Math.hypot(c.x - b.x, c.y - b.y) < Math.hypot(a.x - b.x, a.y - b.y) ? c : a));
    for (const p of field) {
      if (obs.restart && obs.restart.ours && p.id === obs.restart.taker) continue;
      if (p.id === engager.id && !obs.restart) {
        const fwd = field.filter((q) => q.id !== p.id && (q.x - p.x) * dir > 2).sort((q, r) => (r.x - q.x) * dir)[0];
        const tgt = fwd ? { x: fwd.x + dir * 2, y: fwd.y } : { x: dir * 25, y: 0 };
        const dx = tgt.x - b.x, dy = tgt.y - b.y, d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < R.kickRange - 0.1 && p.cooldowns.touch === 0 && facing(p, dx, dy)) out.push({ type: "kick", player: p.id, direction: { x: dx, y: dy }, power: Math.min(0.8, Math.hypot(dx, dy) / 40 + 0.15) });
        out.push({ type: "moveTo", player: p.id, ...behind(p, b.x, b.y, dx, dy) });
      } else {
        const [sx, sy] = SHAPE[p.number];
        out.push({ type: "moveTo", player: p.id, x: shapeX + sx * dir, y: sy + b.y * 0.3 });
      }
    }
    if (obs.restart && obs.restart.ours) {
      const t = mates.find((p) => p.id === obs.restart.taker);
      const mate = field.filter((q) => q.id !== t.id).sort((q, r) => Math.hypot(q.x - b.x, q.y - b.y) - Math.hypot(r.x - b.x, r.y - b.y))[0];
      const dx = mate.x - b.x, dy = mate.y - b.y;
      if (obs.restart.ready && Math.hypot(t.x - b.x, t.y - b.y) < R.kickRange - 0.1 && facing(t, dx, dy)) out.push({ type: "kick", player: t.id, direction: { x: dx, y: dy }, power: Math.min(0.7, Math.hypot(dx, dy) / 40 + 0.15) });
      else out.push({ type: "moveTo", player: t.id, ...behind(t, b.x, b.y, dx, dy) });
    }
    const gk = mates[0];
    if (b.heldBy === gk.id) out.push({ type: "releaseBall", player: gk.id, direction: { x: dir, y: -0.3 }, power: 0.5 });
    else if (!obs.restart && !b.heldBy && Math.hypot(b.x - gk.x, b.y - gk.y) < 1.3 && gk.cooldowns.catch === 0) out.push({ type: "catchBall", player: gk.id });
    out.push({ type: "moveTo", player: gk.id, x: -dir * 23.6, y: Math.max(-1.8, Math.min(1.8, b.y * 0.25)) });
    return out;
  },
});
