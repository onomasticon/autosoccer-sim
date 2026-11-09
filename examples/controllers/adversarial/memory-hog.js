// Adversarial: allocates until the sandbox runs out of memory.
const hoard = [];
defineController({ name: "memory-hog", update() { for (;;) hoard.push(new Array(100000).fill(Math.random())); } });
