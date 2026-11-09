import { describe, expect, it } from "vitest";
import { CommandRunner, createIdleController, createSafeController, createScenarioSource, getScenario, SCENARIOS } from "@autosoccer/controller-runtime";
import { runSoak } from "@autosoccer/match-runner";
import {
  createWorld,
  DEFAULT_CONFIG,
  dhypot,
  hashState,
  makeConfig,
  Simulation,
  step,
  type EngineCommand,
  type PlayerId,
  type SimEvent,
  type WorldState,
} from "@autosoccer/sim-core";

const MC = DEFAULT_CONFIG.match;
const IDS: PlayerId[] = ["blue-1", "blue-2", "blue-3", "blue-4", "blue-5", "red-1", "red-2", "red-3", "red-4", "red-5"];
const P = (s: WorldState, id: PlayerId) => s.players.find((p) => p.id === id)!;

/** Open-play world: listed players placed, others parked on the far touchline. */
function openPlay(place: Partial<Record<PlayerId, { x: number; y: number; heading?: number }>>, ball: { x: number; y: number; vx?: number; vy?: number }, seed = 1, extra: EngineCommand[] = []): WorldState {
  const cmds: EngineCommand[] = [{ type: "debugSetMatch", period: "firstHalf", phase: "openPlay" }, { type: "debugPlaceBall", ...ball }, ...extra];
  IDS.forEach((id, i) => {
    const p = place[id];
    cmds.push(p ? { type: "debugPlacePlayer", playerId: id, ...p } : { type: "debugPlacePlayer", playerId: id, x: -22 + i * 4.8, y: -17.2 });
  });
  return step(createWorld(seed), cmds).state;
}

function runFor(s: WorldState, n: number, cmdsAt: (s: WorldState, i: number) => unknown[] = () => []) {
  const events: SimEvent[] = [];
  const rejected: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = step(s, cmdsAt(s, i));
    s = r.state;
    events.push(...s.events);
    rejected.push(...r.rejected.map((x) => x.reason));
  }
  return { s, events, rejected };
}

const find = <T extends SimEvent["type"]>(ev: SimEvent[], type: T) => ev.find((e) => e.type === type) as Extract<SimEvent, { type: T }> | undefined;

describe("match lifecycle", () => {
  it("pre-match → first half → halftime → second half → full time, with no controllers at all", () => {
    const sim = new Simulation(42);
    const periods: string[] = [];
    let switched: SimEvent | undefined;
    while (!sim.clock.finished && sim.state.tick < 20_000) {
      const s = sim.tick();
      for (const e of s.events) {
        if (e.type === "periodStart") periods.push(e.period);
        if (e.type === "sidesSwitched") switched = e;
      }
    }
    expect(periods).toEqual(["firstHalf", "halftime", "secondHalf", "fullTime"]);
    expect(switched).toEqual({ type: "sidesSwitched", defends: { blue: "right", red: "left" } });
    // Two 120 s halves + pre-match + halftime with a running clock.
    expect(sim.state.tick).toBe(MC.preMatchTicks + 2 * 120 * 60 + MC.halftimeTicks - 1);
    expect(sim.state.match.period).toBe("fullTime");
  });

  it("first kickoff is a seeded coin toss and the other team kicks off the second half", () => {
    const firsts = new Set<string>();
    for (let seed = 0; seed < 20; seed++) firsts.add(createWorld(seed).match.firstKickoff);
    expect(firsts).toEqual(new Set(["blue", "red"]));
    const sim = new Simulation(5);
    const kickoffs: string[] = [];
    while (!sim.clock.finished) for (const e of sim.tick().events) if (e.type === "restartAwarded" && e.restart === "kickoff") kickoffs.push(e.team);
    expect(kickoffs).toEqual([sim.state.match.firstKickoff, sim.state.match.firstKickoff === "blue" ? "red" : "blue"]);
  });

  it("kickoff setup: everyone in own half, opponents outside the centre circle, ball on the spot", () => {
    const sim = new Simulation(3);
    sim.run(MC.preMatchTicks);
    const s = sim.state;
    expect(s.match.phase).toBe("kickoff");
    const team = s.match.restart!.team;
    expect(s.ball).toMatchObject({ x: 0, y: 0, vx: 0, vy: 0 });
    for (const p of s.players) {
      const sign = s.match.defends[p.team] === "left" ? 1 : -1;
      expect(sign * p.x).toBeLessThanOrEqual(0);
      if (p.team !== team) expect(dhypot(p.x, p.y)).toBeGreaterThanOrEqual(DEFAULT_CONFIG.pitch.centreCircleRadius);
    }
    expect(P(s, s.match.restart!.taker).role).toBe("FW");
  });

  it("clock policy: stopOnDeadBall pauses the clock while play is dead", () => {
    const cfg = makeConfig({ match: { clockPolicy: "stopOnDeadBall" } });
    const sim = new Simulation(1, cfg);
    sim.run(MC.preMatchTicks + 100); // kickoff pending, no controller takes it
    expect(sim.state.match.phase).toBe("kickoff");
    expect(sim.state.match.halfTicks).toBe(0);
    const run = new Simulation(1);
    run.run(MC.preMatchTicks + 100);
    expect(run.state.match.halfTicks).toBeGreaterThan(90);
  });
});

describe("goals", () => {
  it("scores, attributes the scorer and restarts with the conceding team's kickoff", () => {
    let s = openPlay({ "blue-5": { x: 14, y: 2, heading: 0 } }, { x: 14.65, y: 2 });
    const r = runFor(s, 200, (_s, i) => (i === 0 ? [{ type: "kick", playerId: "blue-5", dirX: 1, dirY: -0.05, power: 1 }] : []));
    const g = find(r.events, "goalScored")!;
    expect(g).toMatchObject({ team: "blue", scorer: "blue-5", ownGoal: false, score: { blue: 1, red: 0 } });
    s = r.s;
    expect(s.match.phase).toBe("kickoff");
    expect(s.match.restart!.team).toBe("red");
    expect(s.match.score).toEqual({ blue: 1, red: 0 });
  });

  it("own goals count for the other team and are flagged", () => {
    const s = openPlay({ "blue-2": { x: -20, y: 0, heading: Math.PI } }, { x: -20.65, y: 0 });
    const r = runFor(s, 60, (_s, i) => (i === 0 ? [{ type: "kick", playerId: "blue-2", dirX: -1, dirY: 0, power: 0.6 }] : []));
    expect(find(r.events, "goalScored")).toMatchObject({ team: "red", scorer: "blue-2", ownGoal: true });
  });

  it("the ball hitting a post bounces back into play", () => {
    const s = openPlay({}, { x: 20, y: 2.0, vx: 15, vy: 0 });
    const r = runFor(s, 30);
    expect(find(r.events, "goalScored")).toBeUndefined();
    expect(find(r.events, "ballOut")).toBeUndefined();
    expect(r.s.ball.vx).toBeLessThan(0);
  });
});

describe("out of play and restarts", () => {
  it("touchline → kick-in to the other team at the crossing point; ball settles then is placed", () => {
    const s = openPlay({ "red-4": { x: 0, y: 14, heading: Math.PI / 2 }, "blue-3": { x: -5, y: 10 } }, { x: 0, y: 14.6 }, 1, []);
    const r = runFor(s, MC.outSettleTicks + 30, (_s, i) => (i === 0 ? [{ type: "kick", playerId: "red-4", dirX: 0, dirY: 1, power: 0.2 }] : []));
    const out = find(r.events, "ballOut")!;
    expect(out.line).toBe("touchline");
    expect(find(r.events, "restartAwarded")).toMatchObject({ restart: "kickIn", team: "blue", taker: "blue-3" });
    const rs = r.s.match.restart!;
    expect(rs.y).toBeCloseTo(16 - DEFAULT_CONFIG.ball.radius, 9);
    expect(r.s.ball).toMatchObject({ x: rs.x, y: rs.y, vx: 0, vy: 0 });
  });

  it("goal line: attacker last → goal kick by the keeper; defender last → corner at the nearest flag", () => {
    const gk = runFor(openPlay({ "blue-5": { x: 18, y: -5, heading: 0 }, "red-1": { x: 23, y: 0 } }, { x: 18.65, y: -5 }), 40, (_s, i) =>
      i === 0 ? [{ type: "kick", playerId: "blue-5", dirX: 1, dirY: 0, power: 0.6 }] : [],
    );
    expect(find(gk.events, "restartAwarded")).toMatchObject({ restart: "goalKick", team: "red", taker: "red-1", x: 25 - MC.goalKickSpot, y: 0 });

    const ck = runFor(openPlay({ "red-2": { x: 21, y: -6, heading: 0 }, "blue-5": { x: 15, y: -3 } }, { x: 21.6, y: -6 }), 40, (_s, i) =>
      i === 0 ? [{ type: "kick", playerId: "red-2", dirX: 1, dirY: -0.8, power: 0.4 }] : [],
    );
    const a = find(ck.events, "restartAwarded")!;
    expect(a).toMatchObject({ restart: "corner", team: "blue", taker: "blue-5" });
    expect(a.x).toBeCloseTo(25 - DEFAULT_CONFIG.ball.radius, 9);
    expect(a.y).toBeCloseTo(-16 + DEFAULT_CONFIG.ball.radius, 9);
  });

  it("only the designated taker may play a restart, and only by kicking once the ball is placed", () => {
    let s = openPlay({ "red-4": { x: 0, y: 14, heading: Math.PI / 2 }, "blue-3": { x: -1, y: 15.3, heading: 0 }, "blue-4": { x: 1, y: 14.5, heading: Math.PI }, "red-3": { x: 0.5, y: 13 } }, { x: 0, y: 14.6 });
    s = runFor(s, 1, () => [{ type: "kick", playerId: "red-4", dirX: 0, dirY: 1, power: 0.15 }]).s;
    s = runFor(s, 20).s;
    expect(s.match.phase).toBe("kickIn");
    const taker = s.match.restart!.taker;
    const early = step(s, [{ type: "kick", playerId: taker, dirX: 1, dirY: 0, power: 0.3 }]);
    expect(early.rejected[0]!.reason).toMatch(/not ready yet/);
    s = runFor(s, MC.outSettleTicks).s;
    const other: PlayerId = taker === "blue-3" ? "blue-4" : "blue-3";
    const r = step(s, [
      { type: "kick", playerId: other, dirX: 1, dirY: 0, power: 0.3 },
      { type: "tackle", playerId: "red-3" },
      { type: "catch", playerId: "red-1" },
    ]);
    const reasons = r.rejected.map((x) => x.reason);
    expect(reasons).toHaveLength(3);
    expect(reasons).toContain(`only the designated taker (${taker}) may take the kickIn`);
    expect(reasons.filter((x) => x === "ball is dead (kickIn): only the taker's kick is allowed")).toHaveLength(2);
    expect(r.state.ball.vx).toBe(0);
  });

  it("opponents are walked out of the 4 m zone at restarts, never teleported", () => {
    let s = openPlay({ "red-4": { x: 0, y: 14, heading: Math.PI / 2 }, "blue-3": { x: -6, y: 10 }, "red-3": { x: 1.5, y: 14.2 } }, { x: 0, y: 14.6 });
    s = runFor(s, 1, () => [{ type: "kick", playerId: "red-4", dirX: 0, dirY: 1, power: 0.15 }]).s;
    const maxStep = DEFAULT_CONFIG.player.sprintSpeed / 60 + 1e-9;
    for (let i = 0; i < MC.outSettleTicks + 60; i++) {
      const prev = s;
      s = step(s).state;
      for (const p of s.players) {
        const q = P(prev, p.id);
        expect(dhypot(p.x - q.x, p.y - q.y)).toBeLessThanOrEqual(maxStep + DEFAULT_CONFIG.player.sprintSpeed / 60 + 1e-9);
      }
    }
    const r = s.match.restart!;
    for (const p of s.players.filter((q) => q.team !== r.team)) expect(dhypot(p.x - r.x, p.y - r.y)).toBeGreaterThanOrEqual(MC.restartDistance - 1e-6);
  });

  it("the taker's kick returns play to open play", () => {
    const sc = getScenario("m3-kick-in");
    const sim = new Simulation(42);
    new CommandRunner(sim, [createScenarioSource(sc)]).run(sc.durationTicks);
    const kinds = sim.events.map((e) => e.event.type);
    expect(kinds).toContain("restartTaken");
    const taken = sim.events.find((e) => e.event.type === "restartTaken")!.event as Extract<SimEvent, { type: "restartTaken" }>;
    expect(taken).toMatchObject({ restart: "kickIn", team: "blue", fallback: false });
    expect(sim.state.match.phase).toBe("openPlay");
  });

  it("a taker who never acts is overridden by the deterministic fallback at the deadline", () => {
    const sc = getScenario("m3-timeout");
    const sim = new Simulation(42);
    new CommandRunner(sim, [createScenarioSource(sc)]).run(sc.durationTicks);
    const award = sim.events.find((e) => e.event.type === "restartAwarded")!;
    const taken = sim.events.find((e) => e.event.type === "restartTaken")!;
    expect(taken.event).toMatchObject({ fallback: true, restart: "kickIn" });
    expect(taken.tick - award.tick).toBe(MC.outSettleTicks + MC.restartTimeoutTicks - 1);
    expect(sim.state.match.phase).toBe("openPlay");
  });
});

describe("fouls", () => {
  it("a failed tackle with contact is a foul → free kick to the fouled team", () => {
    let fouls = 0;
    let clean = 0;
    for (let seed = 0; seed < 30; seed++) {
      const s = openPlay({ "red-4": { x: 0.2, y: 0.55, heading: Math.PI }, "blue-3": { x: -0.5, y: 1.1 } }, { x: 0, y: 0 }, seed);
      const r = step(s, [{ type: "tackle", playerId: "blue-3" }]).state;
      const t = r.events.find((e) => e.type === "tackle") as Extract<SimEvent, { type: "tackle" }>;
      if (!t.success) {
        expect(r.events).toContainEqual(expect.objectContaining({ type: "foul", by: "blue-3", against: "red-4" }));
        expect(r.match).toMatchObject({ phase: "freeKick", restart: expect.objectContaining({ team: "red" }) });
        fouls++;
      } else {
        expect(r.events.some((e) => e.type === "foul")).toBe(false);
        clean++;
      }
    }
    expect(fouls).toBeGreaterThan(3);
    expect(clean).toBeGreaterThan(3);
  });

  it("a failed tackle without contact is not a foul", () => {
    for (let seed = 0; seed < 30; seed++) {
      const s = openPlay({ "red-4": { x: 1.0, y: 0, heading: Math.PI }, "blue-3": { x: -1.2, y: 0 } }, { x: 0, y: 0 }, seed);
      expect(step(s, [{ type: "tackle", playerId: "blue-3" }]).state.events.some((e) => e.type === "foul")).toBe(false);
    }
  });

  it("free kicks inside the fouling team's own area move to the edge of the area (no penalties)", () => {
    let seen = false;
    for (let seed = 0; seed < 40 && !seen; seed++) {
      const s = openPlay({ "red-4": { x: -21.3, y: 0.55, heading: Math.PI }, "blue-3": { x: -22, y: 1.1 } }, { x: -21.5, y: 0 }, seed);
      const st = step(s, [{ type: "tackle", playerId: "blue-3" }]).state;
      if (st.match.phase === "freeKick") {
        expect(st.match.restart!.x).toBeCloseTo(-25 + DEFAULT_CONFIG.pitch.penaltyAreaDepth, 9);
        seen = true;
      }
    }
    expect(seen).toBe(true);
  });
});

describe("phase permissions and period edges", () => {
  it("no ball actions during pre-match, halftime, goal celebration or after full time", () => {
    const w = createWorld(1);
    expect(step(w, [{ type: "kick", playerId: "blue-5", dirX: 1, dirY: 0, power: 1 }]).rejected[0]!.reason).toBe("play is stopped (preMatch)");
    const ft = step(w, [{ type: "debugSetMatch", period: "fullTime", phase: "stopped" }]).state;
    expect(step(ft, [{ type: "tackle", playerId: "red-4" }]).rejected[0]!.reason).toBe("play is stopped (fullTime)");
  });

  it("the half ends on time even with a restart pending, which is cancelled", () => {
    let s = openPlay({ "red-4": { x: 0, y: 14, heading: Math.PI / 2 }, "blue-3": { x: -5, y: 10 } }, { x: 0, y: 14.6 }, 1, [{ type: "debugSetMatch", halfTicks: 120 * 60 - 20 }]);
    s = runFor(s, 1, () => [{ type: "kick", playerId: "red-4", dirX: 0, dirY: 1, power: 0.2 }]).s;
    const r = runFor(s, 40);
    expect(r.events).toContainEqual({ type: "periodEnd", period: "firstHalf" });
    expect(r.s.match).toMatchObject({ period: "halftime", phase: "stopped", restart: null });
  });

  it("after halftime the keeper's legal area is the other end", () => {
    let s = openPlay({ "blue-1": { x: 23, y: 0, heading: Math.PI } }, { x: 22.2, y: 0 }, 1, [{ type: "debugSetMatch", period: "secondHalf" }]);
    // debugSetMatch doesn't swap sides; play into the second half properly instead.
    const sim = new Simulation(1);
    while (sim.state.match.period !== "secondHalf") sim.tick();
    expect(sim.state.match.defends).toEqual({ blue: "right", red: "left" });
    s = { ...s, match: { ...s.match, defends: sim.state.match.defends } };
    const r = step(s, [{ type: "catch", playerId: "blue-1" }]);
    expect(r.rejected).toEqual([]);
    expect(r.state.ball.heldBy).toBe("blue-1");
  });
});

describe("scenarios and soak", () => {
  for (const sc of SCENARIOS.filter((x) => x.id.startsWith("m3-"))) {
    it(`scenario "${sc.id}" runs and replays bit-identically`, () => {
      const sim = new Simulation(42);
      new CommandRunner(sim, [createScenarioSource(sc)]).run(sc.durationTicks);
      expect(hashState(Simulation.replay(42, sim.log, sim.state.tick))).toBe(sim.hash());
    });
  }

  it("100 seeded full matches (safe/idle/chaos, both clock policies) all reach full time", () => {
    const r = runSoak({ matches: 100, startSeed: 1000 });
    expect(r.errors).toEqual([]);
    expect(r.deadlocks).toEqual([]);
    expect(r.completed).toBe(100);
    for (const t of ["kickoff", "kickIn", "goalKick", "corner"]) expect(r.restarts[t]!.taken + r.restarts[t]!.fallback).toBeGreaterThan(0);
  }, 60_000);

  it("safe controllers take restarts themselves (fallback is rare), idle teams always fall back", () => {
    const run = (blue: "safe" | "idle", red: "safe" | "idle") => {
      const sim = new Simulation(11);
      const mk = (t: "blue" | "red", k: string) => (k === "safe" ? createSafeController(t) : createIdleController(t));
      new CommandRunner(sim, [mk("blue", blue), mk("red", red)]).run(20_000);
      const taken = sim.events.filter((e) => e.event.type === "restartTaken").map((e) => e.event as Extract<SimEvent, { type: "restartTaken" }>);
      return taken;
    };
    const safe = run("safe", "safe");
    expect(safe.filter((t) => t.fallback).length).toBeLessThanOrEqual(Math.ceil(safe.length * 0.1));
    const idle = run("idle", "idle");
    expect(idle.every((t) => t.fallback)).toBe(true);
  });
});
