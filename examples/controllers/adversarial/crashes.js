// Adversarial: throws on every update.
defineController({ name: "crashes", update(obs) { throw new Error("boom at tick " + obs.tick); } });
