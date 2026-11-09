// Adversarial: fails in initialize.
defineController({ name: "bad-init", initialize() { null.oops(); }, update() { return []; } });
