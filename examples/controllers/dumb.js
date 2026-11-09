// Minimal controller (SDK 1.0): everyone runs at the ball; whoever reaches it
// kicks toward the opponents' goal. Takes restarts only by accident — the
// engine's restart fallback covers the rest.
defineController({
  name: "dumb",
  version: "1.0.0",
  update(obs) {
    const goalX = obs.attackingDirection * 25;
    return obs.teammates.flatMap((p) => {
      const d = Math.hypot(obs.ball.x - p.x, obs.ball.y - p.y);
      const acts = [{ type: "moveTo", player: p.id, x: obs.ball.x, y: obs.ball.y }];
      if (d < 0.8) acts.push({ type: "kick", player: p.id, direction: { x: goalX - obs.ball.x, y: -obs.ball.y }, power: 0.6 });
      return acts;
    });
  },
});
