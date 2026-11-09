// Adversarial: hangs forever after 3 updates.
let n = 0;
defineController({ name: "infinite-loop", update(obs) { if (++n > 3) { while (true) {} } return [{ type: "moveTo", player: 4, x: 0, y: 0 }]; } });
