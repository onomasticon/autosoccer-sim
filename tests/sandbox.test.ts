import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildObservation, translateActions, MAX_ACTIONS_PER_UPDATE, SDK_VERSION } from "@autosoccer/controller-sdk";
import { CommandRunner, createSandboxedController, type SandboxedController } from "@autosoccer/controller-runtime";
import { runControllerMatch } from "@autosoccer/match-runner";
import { createWorld, hashState, makeConfig, Simulation, step, type WorldState } from "@autosoccer/sim-core";

const ex = (p: string) => readFileSync(new URL(`../examples/controllers/${p}`, import.meta.url), "utf8");
/** Short halves keep sandboxed full matches fast in tests. */
const SHORT = { halfDurationSec: 20 };
const openWorld = (): WorldState => step(createWorld(1), [{ type: "debugSetMatch", period: "firstHalf", phase: "openPlay" }]).state;

async function run(blue: string, red: string, seed = 42, config = SHORT) {
  return runControllerMatch({ seed, blue: { source: blue }, red: { source: red }, config });
}
const kinds = (c: SandboxedController) => c.diagnostics.map((d) => d.kind);

describe("SDK: observation", () => {
  it("is plain JSON, team-relative, and versioned", () => {
    const w = openWorld();
    const o = buildObservation(w, "red");
    expect(JSON.parse(JSON.stringify(o))).toEqual(o);
    expect(o.schemaVersion).toBe("1.0");
    expect(o.team).toBe("red");
    expect(o.attackingDirection).toBe(-1);
    expect(o.teammates.map((p) => p.id)).toEqual(["red-1", "red-2", "red-3", "red-4", "red-5"]);
    expect(o.opponents.every((p) => p.id.startsWith("blue"))).toBe(true);
    expect(o.teammates[0]).toHaveProperty("intent");
    expect(o.opponents[0]).not.toHaveProperty("intent");
  });

  it("carries the pending restart with ownership, readiness and fallback countdown", () => {
    const sim = new Simulation(3);
    sim.run(61);
    const team = sim.state.match.restart!.team;
    const o = buildObservation(sim.state, team);
    expect(o.restart).toMatchObject({ type: "kickoff", ours: true, ready: true });
    expect(o.restart!.decisionsUntilFallback).toBeGreaterThan(50);
  });
});

describe("SDK: action translation and validation", () => {
  const w = openWorld();
  it("accepts player numbers or own IDs, rejects opponents, unknown types, bad values", () => {
    const t = translateActions(
      [
        { type: "moveTo", player: 4, x: 1, y: 2 },
        { type: "moveTo", player: "blue-5", x: 1, y: 2, sprint: true },
        { type: "moveTo", player: "red-5", x: 0, y: 0 },
        { type: "warp", player: 2 },
        { type: "kick", player: 3, direction: { x: 0, y: 0 }, power: 0.5 },
        { type: "kick", player: 3, direction: { x: 1, y: 0 }, power: 1.5 },
        { type: "moveTo", player: 7, x: 0, y: 0 },
        42,
      ],
      "blue",
      w,
    );
    expect(t.commands).toEqual([
      { type: "moveTo", playerId: "blue-4", x: 1, y: 2, sprint: false, dribble: false },
      { type: "moveTo", playerId: "blue-5", x: 1, y: 2, sprint: true, dribble: false },
    ]);
    expect(t.rejected.map((r) => r.reason)).toEqual([
      "not your player: red-5",
      "unknown action type: warp",
      "kick needs a non-zero finite direction {x, y}",
      "power must be a number in [0, 1]",
      "invalid player reference: 7",
      "action must be an object",
    ]);
  });

  it("conflicts: last movement wins, one ball action per player, sprint modifies movement", () => {
    const t = translateActions(
      [
        { type: "moveTo", player: 2, x: 1, y: 1 },
        { type: "stop", player: 2 },
        { type: "kick", player: 4, direction: { x: 1, y: 0 }, power: 0.5 },
        { type: "tackle", player: 4 },
        { type: "moveTo", player: 3, x: 5, y: 5 },
        { type: "sprint", player: 3, on: true },
        { type: "catchBall", player: 1 },
        { type: "releaseBall", player: 1, direction: { x: 1, y: 0 }, power: 0.4 },
      ],
      "blue",
      w,
    );
    expect(t.commands).toEqual([
      { type: "stop", playerId: "blue-2" },
      { type: "moveTo", playerId: "blue-3", x: 5, y: 5, sprint: true, dribble: false },
      { type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 0.5 },
      { type: "catch", playerId: "blue-1" },
    ]);
    expect(t.rejected.map((r) => r.reason)).toEqual(["only one ball action per player per update (blue-4)", "only one ball action per player per update (blue-1)"]);
  });

  it("sprint alone re-targets the current movement, or is rejected without one", () => {
    let s = step(w, [{ type: "moveTo", playerId: "blue-4", x: 3, y: 4 }]).state;
    expect(translateActions([{ type: "sprint", player: 4, on: true }], "blue", s).commands).toEqual([{ type: "moveTo", playerId: "blue-4", x: 3, y: 4, sprint: true, dribble: false }]);
    s = step(s, [{ type: "stop", playerId: "blue-4" }]).state;
    expect(translateActions([{ type: "sprint", player: 4, on: true }], "blue", s).rejected[0]!.reason).toMatch(/no movement target/);
  });

  it("accepts { actions } objects, undefined; rejects other shapes and floods", () => {
    expect(translateActions({ actions: [{ type: "stop", player: 1 }] }, "blue", w).commands).toHaveLength(1);
    expect(translateActions(undefined, "blue", w)).toMatchObject({ commands: [], rejected: [] });
    expect(translateActions("go", "blue", w).rejected[0]!.reason).toMatch(/must return an array/);
    const flood = translateActions(Array.from({ length: 100 }, () => ({ type: "stop", player: 1 })), "blue", w);
    expect(flood.rejected).toHaveLength(100 - MAX_ACTIONS_PER_UPDATE);
  });
});

describe("sandboxed controllers", () => {
  it("two independent scripts play a full match through the public API only, deterministically", async () => {
    const a = await run(ex("chaser.js"), ex("zonal.js"));
    const b = await run(ex("chaser.js"), ex("zonal.js"));
    expect(a.state.match.period).toBe("fullTime");
    expect(b.finalHash).toBe(a.finalHash);
    expect(a.blue.name).toBe("chaser");
    expect(a.red.name).toBe("zonal");
    expect(a.stats.blue.kicks + a.stats.red.kicks).toBeGreaterThan(5);
    expect(hashState(Simulation.replay(42, a.sim.log, a.state.tick, a.sim.config))).toBe(a.finalHash);
    for (const c of [a.blue, a.red]) {
      expect(c.disabled).toBe(false);
      expect(kinds(c)).toContain("lifecycle");
      expect(c.diagnostics.filter((d) => d.kind === "lifecycle").map((d) => d.message)).toEqual(["initialize ok", "onMatchEnd ok"]);
    }
  }, 60_000);

  it("the API probe exercises every action type and every lifecycle callback", async () => {
    const r = await runControllerMatch({ seed: 42, blue: { source: ex("api-probe.js") }, red: { source: ex("dumb.js") } });
    const logs = r.blue.diagnostics.filter((d) => d.kind === "log").map((d) => d.message);
    expect(logs[0]).toMatch(new RegExp(`^initialize blue sdk ${SDK_VERSION.replace(/\./g, "\\.")}`));
    const end = logs.find((l) => l.startsWith("onMatchEnd"))!;
    expect(end).toMatch(/catchBall,kick,moveTo,releaseBall,sprint,stop,tackle/);
  }, 60_000);

  it("both teams observe the same pre-update state on each decision tick", async () => {
    const spy = `const seen = []; defineController({ update(o) { seen.push(o.tick + ":" + o.ball.x + "," + o.ball.y + ":" + o.teammates.concat(o.opponents).map(p => p.x).join(",")); return [{ type: "moveTo", player: 4, x: o.ball.x, y: o.ball.y }]; }, onMatchEnd() { console.log(JSON.stringify(seen.slice(0, 40))); } });`;
    const spyRed = spy.replace("o.teammates.concat(o.opponents)", "o.opponents.concat(o.teammates)");
    const r = await run(spy, spyRed);
    const b = JSON.parse(r.blue.diagnostics.find((d) => d.kind === "log")!.message);
    const rd = JSON.parse(r.red.diagnostics.find((d) => d.kind === "log")!.message);
    expect(b).toHaveLength(40);
    expect(rd).toEqual(b);
  }, 60_000);

  it("Math.random is seeded per match and team; Date and host APIs are absent", async () => {
    const src = `defineController({ initialize() { console.log(JSON.stringify([Math.random(), Math.random(), typeof Date, typeof fetch, typeof require, typeof process, typeof setTimeout, typeof WebAssembly])); }, update() { return []; } });`;
    const one = await run(src, src, 7, { halfDurationSec: 1 });
    const two = await run(src, src, 7, { halfDurationSec: 1 });
    const three = await run(src, src, 8, { halfDurationSec: 1 });
    const log = (r: typeof one, t: "blue" | "red") => JSON.parse((t === "blue" ? r.blue : r.red).diagnostics.find((d) => d.kind === "log")!.message);
    expect(log(one, "blue")).toEqual(log(two, "blue"));
    expect(log(one, "blue").slice(0, 2)).not.toEqual(log(one, "red").slice(0, 2));
    expect(log(one, "blue").slice(0, 2)).not.toEqual(log(three, "blue").slice(0, 2));
    expect(log(one, "blue").slice(2)).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
  }, 60_000);

  it("escape attempts find no host access; observations are frozen", async () => {
    const r = await run(ex("adversarial/escape.js"), ex("dumb.js"), 42, { halfDurationSec: 2 });
    const probes = JSON.parse(r.blue.diagnostics.find((d) => d.message.startsWith("probes"))!.message.slice("probes ".length));
    for (const k of ["fetch", "require", "process", "Date", "setTimeout", "WebAssembly"]) expect(probes[k]).toBe("undefined");
    expect(probes["Function-constructor-escape"]).toBe("undefined");
    expect(probes["constructor-chain"]).toBe("undefined");
    expect(probes.globals).not.toMatch(/process|require|fetch|Bun|Deno|window|document/);
    expect(r.blue.diagnostics.some((d) => d.message.startsWith("mutate blocked"))).toBe(true);
    expect(r.blue.disabled).toBe(false);
  }, 60_000);

  it("teams cannot see each other's globals or memory", async () => {
    const writer = `globalThis.secret = 42; var leaked = "blue"; defineController({ update() { globalThis.secret++; return []; } });`;
    const reader = `defineController({ initialize() { console.log(typeof secret + "/" + typeof leaked); }, update() { return []; } });`;
    const r = await run(writer, reader, 1, { halfDurationSec: 1 });
    expect(r.red.diagnostics.find((d) => d.kind === "log")!.message).toBe("undefined/undefined");
  }, 30_000);

  it("invalid, foreign and forbidden actions are rejected with reasons and never affect the opponent or the ball", async () => {
    const r = await run(ex("adversarial/invalid-actions.js"), `defineController({ update() { return []; } })`, 42, { halfDurationSec: 3 });
    const reasons = r.blue.diagnostics.filter((d) => d.kind === "invalid-action").map((d) => d.message);
    for (const re of [/not your player: red-4/, /unknown action type: teleport/, /unknown action type: debugPlaceBall/, /non-zero finite direction/, /power must be/, /invalid player reference: 9/, /action must be an object/]) {
      expect(reasons.some((m) => re.test(m))).toBe(true);
    }
    const engine = r.blue.diagnostics.filter((d) => d.kind === "engine-rejected").map((d) => d.message);
    expect(engine.some((m) => /only goalkeepers can catch|play is stopped|ball is dead|out of kick range/.test(m))).toBe(true);
    // No red player ever got a moveTo to (0, 0) from blue, and the ball was never placed at x=25.5.
    expect(r.sim.log.flatMap((e) => e.commands).some((c) => "playerId" in c && c.playerId.startsWith("red") && c.type === "moveTo" && c.x === 0 && c.y === 0)).toBe(false);
    expect(r.sim.log.flatMap((e) => e.commands).some((c) => c.type.startsWith("debug"))).toBe(false);
    expect(r.blue.disabled).toBe(false);
    expect(r.state.match.period).toBe("fullTime");
  }, 60_000);

  it("an infinite loop is stopped by the deterministic CPU budget; after 3 timeouts the safe fallback takes over", async () => {
    const t0 = performance.now();
    const a = await run(ex("adversarial/infinite-loop.js"), ex("dumb.js"));
    const b = await run(ex("adversarial/infinite-loop.js"), ex("dumb.js"));
    expect(performance.now() - t0).toBeLessThan(30_000);
    const timeouts = a.blue.diagnostics.filter((d) => d.kind === "timeout");
    expect(timeouts).toHaveLength(3);
    expect(timeouts[0]!.message).toMatch(/CPU budget/);
    expect(a.blue.disabled).toBe(true);
    expect(a.blue.diagnostics.find((d) => d.kind === "disabled")!.message).toMatch(/3 consecutive failures/);
    expect(a.state.match.period).toBe("fullTime");
    expect(b.finalHash).toBe(a.finalHash); // the timeout point is deterministic
  }, 60_000);

  it("a memory hog is stopped by the heap limit and disabled", async () => {
    const r = await run(ex("adversarial/memory-hog.js"), ex("dumb.js"), 42, { halfDurationSec: 5 });
    expect(kinds(r.blue)).toContain("out-of-memory");
    expect(r.blue.disabled).toBe(true);
    expect(r.state.match.period).toBe("fullTime");
  }, 60_000);

  it("a controller that throws every update is reported and replaced; one that fails initialize is disabled immediately", async () => {
    const c = await run(ex("adversarial/crashes.js"), ex("dumb.js"), 42, { halfDurationSec: 5 });
    expect(c.blue.diagnostics.filter((d) => d.kind === "error")).toHaveLength(3);
    expect(c.blue.diagnostics.find((d) => d.kind === "error")!.message).toMatch(/boom at tick/);
    expect(c.blue.disabled).toBe(true);
    const i = await run(ex("adversarial/bad-init.js"), ex("dumb.js"), 42, { halfDurationSec: 2 });
    expect(i.blue.diagnostics[0]).toMatchObject({ kind: "error" });
    expect(i.blue.diagnostics[0]!.message).toMatch(/^initialize:/);
    expect(i.blue.disabled).toBe(true);
    expect(i.state.match.period).toBe("fullTime");
  }, 60_000);

  it("a script that doesn't load (syntax error, no defineController) is disabled and the match still completes", async () => {
    const syntax = await run("defineController({ update() { return [ }", ex("dumb.js"), 1, { halfDurationSec: 2 });
    expect(syntax.blue.disabled).toBe(true);
    expect(syntax.blue.diagnostics[0]!.message).toMatch(/failed to load script: .*SyntaxError/);
    const none = await run("var x = 1;", ex("dumb.js"), 1, { halfDurationSec: 2 });
    expect(none.blue.disabled).toBe(true);
    expect(none.state.match.period).toBe("fullTime");
  }, 60_000);

  it("unserialisable or oversized output is rejected", async () => {
    const cyc = await run(`defineController({ update() { const a = {}; a.self = a; return a; } })`, ex("dumb.js"), 1, { halfDurationSec: 1 });
    expect(cyc.blue.diagnostics.some((d) => d.kind === "error" && /circular|cyclic/i.test(d.message))).toBe(true);
    const big = await run(`defineController({ update() { return [{ type: "stop", player: 1, pad: "x".repeat(100000) }]; } })`, ex("dumb.js"), 1, { halfDurationSec: 1 });
    expect(big.blue.diagnostics.some((d) => d.kind === "invalid-output")).toBe(true);
  }, 30_000);

  it("the runner never lets a team source issue debug commands or command the other team", async () => {
    const sim = new Simulation(1, makeConfig(SHORT));
    const evil = await createSandboxedController({ team: "blue", source: `defineController({ update() { return []; } })`, seed: 1 });
    const runner = new CommandRunner(sim, [
      evil,
      { name: "rogue", team: "red", decide: () => [{ type: "debugPlaceBall", x: 25.5, y: 0 } as never, { type: "debugPlacePlayer", playerId: "red-1", x: 0, y: 0 }, { type: "stop", playerId: "blue-1" }] },
    ]);
    runner.run(200);
    expect(runner.diagnostics.filter((d) => d.kind === "forbidden-command")).not.toHaveLength(0);
    expect(runner.diagnostics.filter((d) => d.kind === "foreign-player")).not.toHaveLength(0);
    expect(sim.log.flatMap((e) => e.commands)).toEqual([]);
    runner.dispose();
  }, 30_000);
});
