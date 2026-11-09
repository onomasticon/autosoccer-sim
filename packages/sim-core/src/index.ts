/**
 * @autosoccer/sim-core — headless deterministic 5v5 soccer simulation.
 * No DOM, no timers, no Math.random: everything is driven by `step`.
 */
export const ENGINE_VERSION = "0.3.0";

export * from "./config.ts";
export * from "./prng.ts";
export * from "./dmath.ts";
export * from "./vec.ts";
export * from "./types.ts";
export * from "./commands.ts";
export * from "./world.ts";
export * from "./physics.ts";
export * from "./actions.ts";
export * from "./match.ts";
export * from "./invariants.ts";
export * from "./step.ts";
export * from "./hash.ts";
export * from "./simulation.ts";
