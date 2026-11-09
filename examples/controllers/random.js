// Naive random baseline (for robustness/regression only — not a featured team).
// Every update each player gets a random movement, and anyone near the ball
// kicks it in a random direction. Uses the seeded Math.random, so a match is
// still fully deterministic for a given seed.
defineController({
  name: "random",
  version: "1.0.0",
  update(obs) {
    const acts = [];
    for (const p of obs.teammates) {
      if (Math.random() < 0.3) acts.push({ type: "moveTo", player: p.id, x: (Math.random() - 0.5) * 48, y: (Math.random() - 0.5) * 30, sprint: Math.random() < 0.3 });
      if (Math.hypot(obs.ball.x - p.x, obs.ball.y - p.y) < 0.85) {
        const a = Math.random() * 2 * Math.PI;
        acts.push({ type: "kick", player: p.id, direction: { x: Math.cos(a), y: Math.sin(a) }, power: Math.random() });
      }
      if (Math.random() < 0.02) acts.push({ type: "tackle", player: p.id });
    }
    if (obs.ball.heldBy === obs.teammates[0].id) acts.push({ type: "releaseBall", player: 1, direction: { x: obs.attackingDirection, y: Math.random() - 0.5 }, power: 0.5 });
    else if (Math.random() < 0.2) acts.push({ type: "catchBall", player: 1 });
    return acts;
  },
});
