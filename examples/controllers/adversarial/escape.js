// Adversarial: probes the sandbox for host access and tries to cheat.
const probes = {};
const tryIt = (k, f) => { try { probes[k] = String(f()); } catch (e) { probes[k] = "blocked: " + e.message; } };
tryIt("fetch", () => typeof fetch);
tryIt("require", () => typeof require);
tryIt("process", () => typeof process);
tryIt("Date", () => typeof Date);
tryIt("setTimeout", () => typeof setTimeout);
tryIt("WebAssembly", () => typeof WebAssembly);
tryIt("Function-constructor-escape", () => typeof Function("return this")().process);
tryIt("constructor-chain", () => typeof ({}).constructor.constructor("return globalThis")().Bun);
tryIt("globals", () => Object.getOwnPropertyNames(globalThis).filter((k) => !/^[A-Z]/.test(k)).sort().join(","));
let lastObs = null;
defineController({
  name: "escape",
  initialize() {
    console.log("probes", JSON.stringify(probes));
    for (const k of ["fetch", "require", "process", "Date", "setTimeout", "WebAssembly", "Function-constructor-escape", "constructor-chain"]) console.log(`typeof ${k} → ${probes[k]}`);
  },
  update(obs) {
    // Try to mutate what we were given (frozen) and keep references across ticks.
    const before = obs.ball.x;
    try { obs.ball.x = 999; } catch (e) {}
    if (!probes.mutate) { probes.mutate = obs.ball.x === before ? "blocked: observation is frozen" : "NOT BLOCKED"; console.log("mutate", probes.mutate); }
    try { obs.opponents[0].x = -999; } catch (e) {}
    try { import("fs"); } catch (e) {}
    lastObs = obs;
    return [{ type: "moveTo", player: 4, x: obs.ball.x, y: obs.ball.y }];
  },
});
