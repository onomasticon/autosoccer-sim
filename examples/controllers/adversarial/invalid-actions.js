// Adversarial: returns a mix of invalid / illegal / forbidden actions every update.
defineController({
  name: "invalid-actions",
  update(obs) {
    const other = obs.team === "blue" ? "red" : "blue";
    return [
      { type: "moveTo", player: other + "-4", x: 0, y: 0 },          // opponent's player
      { type: "teleport", player: 4, x: 0, y: 0 },                    // unknown action
      { type: "debugPlaceBall", x: 25.5, y: 0 },                      // engine debug command
      { type: "kick", player: 4, direction: { x: NaN, y: 1 }, power: 1 }, // NaN
      { type: "kick", player: 5, direction: { x: 1, y: 0 }, power: 7 },   // power out of range
      { type: "kick", player: 2, direction: { x: 1, y: 0 }, power: 1 },   // legal shape, but ball far away → engine rejects
      { type: "catchBall", player: 3 },                               // outfield catch → engine rejects
      { type: "moveTo", player: 9, x: 0, y: 0 },                      // no such player
      "nonsense",
    ];
  },
});
