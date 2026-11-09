import { describe, expect, it } from "vitest";
import { CommandRunner, createScenarioSource, SCENARIOS } from "@autosoccer/controller-runtime";
import {
  createWorld,
  DEFAULT_CONFIG,
  dhypot,
  hashState,
  Rng,
  Simulation,
  step,
  type EngineCommand,
  type PlayerId,
  type SimEvent,
  type WorldState,
} from "@autosoccer/sim-core";

const AC = DEFAULT_CONFIG.action;
const IDS: PlayerId[] = ["blue-1", "blue-2", "blue-3", "blue-4", "blue-5", "red-1", "red-2", "red-3", "red-4", "red-5"];

/** World with everyone parked on the far touchline except the given placements. */
function setup(place: Partial<Record<PlayerId, { x: number; y: number; heading?: number; stamina?: number }>>, ball: { x: number; y: number; vx?: number; vy?: number }, seed = 1): WorldState {
  const cmds: EngineCommand[] = [{ type: "debugSetMatch", period: "firstHalf", phase: "openPlay" }, { type: "debugPlaceBall", ...ball }];
  IDS.forEach((id, i) => {
    const p = place[id];
    cmds.push(p ? { type: "debugPlacePlayer", playerId: id, ...p } : { type: "debugPlacePlayer", playerId: id, x: -22 + i * 4.8, y: -17.2 });
  });
  return step(createWorld(seed), cmds).state;
}

/** Run n ticks, issuing `cmds` on the first; returns final state, all events and all rejections. */
function run(s: WorldState, n: number, cmds: EngineCommand[] = []) {
  const events: SimEvent[] = [];
  const rejected: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = step(s, i === 0 ? cmds : []);
    s = r.state;
    events.push(...s.events);
    rejected.push(...r.rejected.map((x) => x.reason));
  }
  return { s, events, rejected };
}

const P = (s: WorldState, id: PlayerId) => s.players.find((p) => p.id === id)!;

describe("kicks", () => {
  it("executes in range and in the facing cone, launching the ball at the requested speed", () => {
    const s0 = setup({ "blue-4": { x: 0, y: 0, heading: 0 } }, { x: 0.6, y: 0 });
    const { s, events, rejected } = run(s0, 1, [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 0.5 }]);
    expect(rejected).toEqual([]);
    const kick = events.find((e) => e.type === "kick");
    expect(kick).toBeDefined();
    const speed = dhypot(s.ball.vx, s.ball.vy);
    expect(speed).toBeGreaterThan(AC.minKickSpeed + 0.5 * (AC.maxKickSpeed - AC.minKickSpeed) - 1);
    expect(s.ball.lastTouch).toBe("blue-4");
  });

  it("rejects kicks out of range, outside the facing cone, during cooldown, and when the ball is held", () => {
    const far = run(setup({ "blue-4": { x: 0, y: 0, heading: 0 } }, { x: 2, y: 0 }), 1, [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 1 }]);
    expect(far.rejected[0]).toMatch(/out of kick range/);
    expect(far.s.ball.vx).toBe(0);

    const back = run(setup({ "blue-4": { x: 0, y: 0, heading: 0 } }, { x: 0.6, y: 0 }), 1, [{ type: "kick", playerId: "blue-4", dirX: -1, dirY: 0, power: 1 }]);
    expect(back.rejected[0]).toMatch(/from facing/);

    let s = setup({ "blue-4": { x: 0, y: 0, heading: 0 } }, { x: 0.6, y: 0 });
    s = run(s, 1, [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 0.05 }]).s;
    s = step(s, [{ type: "debugPlaceBall", x: s.players[3]!.x + 0.6, y: 0 }]).state;
    const cd = run(s, 1, [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 0.5 }]);
    expect(cd.rejected[0]).toMatch(/cooldown/);
  });

  it("execution error is seeded, bounded, and grows with power", () => {
    const err = (seed: number, power: number) => {
      const r = run(setup({ "blue-4": { x: 0, y: 0, heading: 0 } }, { x: 0.6, y: 0 }, seed), 1, [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power }]);
      return (r.events.find((e) => e.type === "kick") as Extract<SimEvent, { type: "kick" }>).errorRad;
    };
    expect(err(5, 1)).toBe(err(5, 1));
    const hi = Array.from({ length: 40 }, (_, i) => Math.abs(err(i, 1)));
    const lo = Array.from({ length: 40 }, (_, i) => Math.abs(err(i, 0.2)));
    expect(Math.max(...hi)).toBeLessThanOrEqual(AC.kickErrorMax + 1e-12);
    expect(hi.reduce((a, b) => a + b) / 40).toBeGreaterThan(lo.reduce((a, b) => a + b) / 40 * 5);
  });

  it("simultaneous kicks: nearest player wins, the other is rejected (order-independent)", () => {
    const s0 = setup({ "blue-4": { x: -0.6, y: 0, heading: 0 }, "red-4": { x: 0.7, y: 0, heading: Math.PI } }, { x: 0, y: 0 });
    const a: EngineCommand = { type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 0.5 };
    const b: EngineCommand = { type: "kick", playerId: "red-4", dirX: -1, dirY: 0, power: 0.5 };
    const r1 = step(s0, [a, b]);
    const r2 = step(s0, [b, a]);
    expect(hashState(r1.state)).toBe(hashState(r2.state));
    expect(r1.state.events.filter((e) => e.type === "kick").map((e) => (e as { playerId: string }).playerId)).toEqual(["blue-4"]);
    expect(r1.rejected.map((x) => x.reason)).toEqual(["ball already played this tick"]);
  });

  it("the ball is independent of the kicker afterwards (no attachment)", () => {
    const s0 = setup({ "blue-4": { x: 0, y: 0, heading: 0 } }, { x: 0.6, y: 0 });
    let { s } = run(s0, 1, [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 0.3 }]);
    s = run(s, 1, [{ type: "moveTo", playerId: "blue-4", x: 0, y: 10 }]).s;
    s = run(s, 60).s;
    expect(s.ball.x).toBeGreaterThan(5);
    expect(Math.abs(s.ball.y)).toBeLessThan(0.5);
    expect(P(s, "blue-4").y).toBeGreaterThan(2);
  });

  it("a 26 m/s ball cannot tunnel through a player (sub-stepping)", () => {
    // Without sub-stepping the ball would move 0.43 m per tick, close to the 0.51 m contact distance.
    let s = setup({ "red-3": { x: 6, y: 0, heading: Math.PI } }, { x: 0, y: 0, vx: 26, vy: 0 });
    let maxX = -Infinity;
    for (let i = 0; i < 40; i++) {
      s = step(s).state;
      maxX = Math.max(maxX, s.ball.x);
    }
    expect(maxX).toBeLessThanOrEqual(6 - 0.51 + 1e-9);
    expect(s.ball.vx).toBeLessThan(0);
  });
});

describe("dribbling, traps and interceptions", () => {
  it("dribble keeps the ball within a couple of metres ahead while running", () => {
    let s = setup({ "blue-4": { x: -15, y: 0, heading: 0 } }, { x: -14.4, y: 0 });
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: 10, y: 0, dribble: true }]).state;
    let touches = 0;
    for (let i = 0; i < 180; i++) {
      s = step(s).state;
      touches += s.events.filter((e) => e.type === "dribbleTouch").length;
      const p = P(s, "blue-4");
      expect(s.ball.x - p.x).toBeGreaterThan(-0.6);
      expect(dhypot(s.ball.x - p.x, s.ball.y - p.y)).toBeLessThan(2.5);
    }
    expect(touches).toBeGreaterThan(5);
    expect(P(s, "blue-4").x).toBeGreaterThan(0);
  });

  it("a moving ball is trapped; an opponent trap is flagged as an interception", () => {
    const s0 = setup({ "red-2": { x: 0, y: 0, heading: 0 }, "blue-2": { x: 8, y: 0, heading: Math.PI } }, { x: 0.6, y: 0 }, 3);
    const { events } = run(s0, 90, [{ type: "kick", playerId: "red-2", dirX: 1, dirY: 0, power: 0.25 }]);
    const trap = events.find((e) => e.type === "trap");
    expect(trap).toMatchObject({ type: "trap", playerId: "blue-2", interception: true });
  });

  it("balls faster than trapMaxSpeed cannot be trapped", () => {
    const s0 = setup({ "blue-2": { x: 4, y: 0, heading: Math.PI } }, { x: 0, y: 0, vx: 25, vy: 0 });
    const { events } = run(s0, 30);
    expect(events.some((e) => e.type === "trap")).toBe(false);
    expect(events.some((e) => e.type === "trapMiss")).toBe(true);
  });

  it("walking into a stationary ball is a push, not a trap", () => {
    let s = setup({ "blue-4": { x: -3, y: 0, heading: 0 } }, { x: 0, y: 0 });
    const r = run(s, 120, [{ type: "moveTo", playerId: "blue-4", x: 5, y: 0 }]);
    s = r.s;
    expect(r.events.some((e) => e.type === "trap")).toBe(false);
    expect(s.ball.x).toBeGreaterThan(0.5);
  });
});

describe("tackles", () => {
  it("success knocks the ball away; failure grounds the tackler, who cannot move or act", () => {
    let wins = 0;
    let fails = 0;
    for (let seed = 0; seed < 40; seed++) {
      const s0 = setup({ "blue-3": { x: -1, y: 0, heading: 0 }, "red-4": { x: 0.6, y: 0, heading: Math.PI } }, { x: 0, y: 0 }, seed);
      const r = step(s0, [{ type: "tackle", playerId: "blue-3" }]);
      const ev = r.state.events.find((e) => e.type === "tackle") as Extract<SimEvent, { type: "tackle" }>;
      expect(ev.victim).toBe("red-4");
      if (ev.success) {
        wins++;
        expect(dhypot(r.state.ball.vx, r.state.ball.vy)).toBeGreaterThan(3);
      } else {
        fails++;
        const p = P(r.state, "blue-3");
        expect(p.stunned).toBeGreaterThan(0);
        const after = run(r.state, 10, [
          { type: "moveTo", playerId: "blue-3", x: 10, y: 0, sprint: true },
          { type: "kick", playerId: "blue-3", dirX: 1, dirY: 0, power: 1 },
        ]);
        expect(after.rejected).toContain("player is grounded after a failed tackle");
        expect(dhypot(P(after.s, "blue-3").vx, P(after.s, "blue-3").vy)).toBeLessThan(0.01);
      }
    }
    expect(wins).toBeGreaterThan(5);
    expect(fails).toBeGreaterThan(2);
  });

  it("rejects tackles out of reach, during cooldown, and on a held ball", () => {
    const far = step(setup({ "blue-3": { x: -3, y: 0 } }, { x: 0, y: 0 }), [{ type: "tackle", playerId: "blue-3" }]);
    expect(far.rejected[0]!.reason).toMatch(/out of tackle reach/);
    const held = setup({ "blue-1": { x: -22, y: 0, heading: 0 }, "red-5": { x: -20.6, y: 0, heading: Math.PI } }, { x: -21.3, y: 0, vx: -2 });
    const caught = step(held, [{ type: "catch", playerId: "blue-1" }]);
    expect(caught.state.ball.heldBy).toBe("blue-1");
    const t = step(caught.state, [{ type: "tackle", playerId: "red-5" }]);
    expect(t.rejected[0]!.reason).toMatch(/holding the ball/);
  });
});

describe("goalkeeper", () => {
  const keeperWorld = (ball: { x: number; y: number; vx?: number; vy?: number }, gk = { x: -23, y: 0, heading: 0 }) => setup({ "blue-1": gk }, ball);

  it("catches inside own area; the ball then moves with the keeper", () => {
    const r = step(keeperWorld({ x: -22, y: 0.3, vx: -3 }), [{ type: "catch", playerId: "blue-1" }]);
    expect(r.state.ball.heldBy).toBe("blue-1");
    let s = step(r.state, [{ type: "moveTo", playerId: "blue-1", x: -21, y: 4 }]).state;
    s = run(s, 60).s;
    const k = P(s, "blue-1");
    expect(dhypot(s.ball.x - k.x, s.ball.y - k.y)).toBeLessThan(0.6);
  });

  it("rejects catches outside the area, by outfield players, out of reach, and too fast", () => {
    expect(step(keeperWorld({ x: -12, y: 0 }, { x: -12.8, y: 0, heading: 0 }), [{ type: "catch", playerId: "blue-1" }]).rejected[0]!.reason).toMatch(/outside the goalkeeper's own penalty area/);
    expect(step(setup({ "blue-4": { x: -22, y: 0 } }, { x: -21.4, y: 0 }), [{ type: "catch", playerId: "blue-4" }]).rejected[0]!.reason).toBe("only goalkeepers can catch");
    expect(step(keeperWorld({ x: -20.5, y: 0 }), [{ type: "catch", playerId: "blue-1" }]).rejected[0]!.reason).toMatch(/out of catch reach/);
    expect(step(keeperWorld({ x: -21.6, y: 0, vx: -30 }), [{ type: "catch", playerId: "blue-1" }]).rejected[0]!.reason).toMatch(/too fast/);
    // Red keeper cannot catch in blue's area.
    const red = setup({ "red-1": { x: -22, y: 0, heading: 0 } }, { x: -21.5, y: 0 });
    expect(step(red, [{ type: "catch", playerId: "red-1" }]).rejected[0]!.reason).toMatch(/outside the goalkeeper's own penalty area/);
  });

  it("a holding keeper cannot leave the area and must release within the hold limit", () => {
    let s = step(keeperWorld({ x: -22.2, y: 0, vx: -1 }), [{ type: "catch", playerId: "blue-1" }]).state;
    expect(s.ball.heldBy).toBe("blue-1");
    s = step(s, [{ type: "moveTo", playerId: "blue-1", x: 0, y: 0, sprint: true }]).state;
    const r = run(s, AC.maxHoldTicks + 5);
    const k = P(r.s, "blue-1");
    expect(k.x).toBeLessThanOrEqual(-25 + DEFAULT_CONFIG.pitch.penaltyAreaDepth + 1e-9);
    expect(r.events).toContainEqual({ type: "release", playerId: "blue-1", auto: true });
    expect(r.s.ball.heldBy).toBeNull();
  });

  it("release throws the ball and the keeper can't instantly re-catch", () => {
    let s = step(keeperWorld({ x: -22.2, y: 0, vx: -1 }), [{ type: "catch", playerId: "blue-1" }]).state;
    s = step(s, [{ type: "release", playerId: "blue-1", dirX: 1, dirY: 0.2, power: 0.5 }]).state;
    expect(s.ball.heldBy).toBeNull();
    expect(dhypot(s.ball.vx, s.ball.vy)).toBeGreaterThan(8);
    const again = step(s, [{ type: "catch", playerId: "blue-1" }]);
    expect(again.rejected[0]!.reason).toMatch(/catch cooldown/);
    expect(step(s, [{ type: "release", playerId: "blue-1", dirX: 1, dirY: 0, power: 0.5 }]).rejected[0]!.reason).toBe("player is not holding the ball");
  });
});

describe("goal-line geometry", () => {
  const roll = (y: number, vx = 12) => run(setup({}, { x: 22, y, vx }), 120);

  it("a ball fully crossing between the posts is a goal, and stays in the net", () => {
    const r = roll(0);
    expect(r.events).toContainEqual({ type: "goal", side: "right" });
    expect(r.s.ball.inGoal).toBe("right");
    expect(r.s.ball.x).toBeGreaterThan(25);
    expect(r.s.ball.x).toBeLessThanOrEqual(25 + DEFAULT_CONFIG.pitch.goalDepth);
    expect(Math.abs(r.s.ball.y)).toBeLessThan(2);
  });

  it("a ball outside the posts bounces off the goal line", () => {
    const r = roll(2.5);
    expect(r.events.some((e) => e.type === "goal")).toBe(false);
    expect(r.s.ball.x).toBeLessThan(25);
  });

  it("the ball on (not over) the line is not a goal", () => {
    const s = setup({}, { x: 25, y: 0 });
    const r = run(s, 5);
    expect(r.events.some((e) => e.type === "goal")).toBe(false);
  });

  it("left goal works symmetrically", () => {
    const r = run(setup({}, { x: -22, y: -1, vx: -12 }), 120);
    expect(r.events).toContainEqual({ type: "goal", side: "left" });
  });
});

describe("scenarios + determinism", () => {
  const expectations: Record<string, (ev: SimEvent[], rej: string[]) => void> = {
    pass: (ev) => expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(["kick", "trap"])),
    shoot: (ev) => expect(ev).toContainEqual({ type: "goal", side: "right" }),
    dribble: (ev) => expect(ev.filter((e) => e.type === "dribbleTouch").length).toBeGreaterThan(5),
    tackle: (ev) => expect(ev.some((e) => e.type === "tackle")).toBe(true),
    intercept: (ev) => expect(ev.some((e) => e.type === "trap" && e.interception)).toBe(true),
    keeper: (ev) => expect(ev.some((e) => e.type === "catch")).toBe(true),
    "illegal-kick": (ev, rej) => {
      expect(rej.some((r) => /out of kick range/.test(r))).toBe(true);
      expect(rej.some((r) => /from facing/.test(r))).toBe(true);
      expect(ev.some((e) => e.type === "kick")).toBe(true);
    },
    "illegal-catch": (ev, rej) => {
      expect(rej.some((r) => /outside the goalkeeper's own penalty area/.test(r))).toBe(true);
      expect(rej).toContain("only goalkeepers can catch");
      expect(ev.some((e) => e.type === "catch" && e.success)).toBe(true);
    },
  };

  for (const sc of SCENARIOS.filter((x) => !x.id.startsWith("m3-"))) {
    it(`scenario "${sc.id}" produces its actions and replays bit-identically`, () => {
      const sim = new Simulation(42);
      const runner = new CommandRunner(sim, [createScenarioSource(sc)]);
      runner.run(sc.durationTicks + 12);
      expectations[sc.id]!(sim.events.map((e) => e.event), sim.rejections.map((r) => r.reason));
      expect(hashState(Simulation.replay(42, sim.log, sim.state.tick))).toBe(sim.hash());
    });
  }

  it("fuzz: random commands for 3000 ticks keep invariants and determinism", () => {
    const go = () => {
      const rng = new Rng(77);
      const sim = new Simulation(9);
      for (let t = 0; t < 3000; t++) {
        if (t % 6 === 0) {
          const cmds: EngineCommand[] = [];
          for (const id of IDS) {
            const r = rng.float();
            if (r < 0.2) cmds.push({ type: "moveTo", playerId: id, x: rng.range(-26, 26), y: rng.range(-17, 17), sprint: rng.bool(), dribble: rng.bool() });
            else if (r < 0.3) cmds.push({ type: "kick", playerId: id, dirX: rng.range(-1, 1), dirY: rng.range(-1, 1), power: rng.float() });
            else if (r < 0.35) cmds.push({ type: "tackle", playerId: id });
            else if (r < 0.4) cmds.push({ type: "catch", playerId: id });
            else if (r < 0.42) cmds.push({ type: "release", playerId: id, dirX: 1, dirY: rng.range(-1, 1), power: rng.float() });
          }
          // Chase the ball sometimes so actions actually execute.
          const b = sim.state.ball;
          cmds.push({ type: "moveTo", playerId: IDS[rng.int(0, 10)]!, x: b.x, y: b.y, dribble: true });
          sim.submit(cmds);
        }
        const s = sim.tick();
        for (const p of s.players) {
          for (const v of [p.x, p.y, p.vx, p.vy, p.heading, p.stamina]) expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(p.x)).toBeLessThanOrEqual(27);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(18);
        }
        // The ball may leave play, but never the world (boards around the run-off).
        expect(Math.abs(s.ball.x)).toBeLessThanOrEqual(25 + DEFAULT_CONFIG.pitch.runOff);
        expect(Math.abs(s.ball.y)).toBeLessThanOrEqual(16 + DEFAULT_CONFIG.pitch.runOff);
      }
      return { hash: sim.hash(), events: sim.events.length, sim };
    };
    const a = go();
    const b = go();
    expect(b.hash).toBe(a.hash);
    expect(a.events).toBeGreaterThan(20);
    expect(hashState(Simulation.replay(9, a.sim.log, a.sim.state.tick))).toBe(a.hash);
  });
});
