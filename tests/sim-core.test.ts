import { describe, expect, it } from "vitest";
import {
  clockOf,
  createWorld,
  DEFAULT_CONFIG,
  hashState,
  makeConfig,
  nextUint32,
  Rng,
  seedRng,
  Simulation,
  step,
  type EngineCommand,
  type PlayerId,
  type WorldState,
} from "@autosoccer/sim-core";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function player(s: WorldState, id: PlayerId) {
  return s.players.find((p) => p.id === id)!;
}

/** World with all players parked far from each other and a custom placement for some. */
function isolatedWorld(overrides: Partial<Record<PlayerId, { x: number; y: number }>> = {}, ball = { x: 0, y: 14, vx: 0, vy: 0 }): WorldState {
  const base = createWorld(1);
  return {
    ...base,
    players: base.players.map((p, i) => ({ ...p, x: -22 + i * 4.5, y: -14, ...overrides[p.id] })),
    ball,
  };
}

describe("prng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const c = new Rng(8);
    const sa = Array.from({ length: 50 }, () => a.float());
    expect(Array.from({ length: 50 }, () => b.float())).toEqual(sa);
    expect(Array.from({ length: 50 }, () => c.float())).not.toEqual(sa);
    expect(sa.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("is a pure function of its state", () => {
    const s = seedRng(123);
    expect(nextUint32(s)).toEqual(nextUint32(s));
  });

  it("has a roughly uniform distribution", () => {
    const r = new Rng(99);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) buckets[Math.floor(r.float() * 10)]++;
    for (const b of buckets) expect(Math.abs(b - 10_000)).toBeLessThan(500);
  });
});

describe("world", () => {
  it("creates 10 players with stable IDs and a centred ball", () => {
    const w = createWorld(42);
    expect(w.players.map((p) => p.id)).toEqual([
      "blue-1", "blue-2", "blue-3", "blue-4", "blue-5",
      "red-1", "red-2", "red-3", "red-4", "red-5",
    ]);
    expect(w.players.filter((p) => p.role === "GK")).toHaveLength(2);
    expect(w.ball).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
    for (const p of w.players) {
      expect(Math.abs(p.x)).toBeLessThan(DEFAULT_CONFIG.pitch.length / 2);
      expect(Math.abs(p.y)).toBeLessThan(DEFAULT_CONFIG.pitch.width / 2);
      // Each team starts in its own half.
      expect(p.team === "blue" ? p.x < 0 : p.x > 0).toBe(true);
    }
  });

  it("seed changes formation jitter (and hash) but not structure", () => {
    expect(hashState(createWorld(1))).not.toBe(hashState(createWorld(2)));
    expect(hashState(createWorld(1))).toBe(hashState(createWorld(1)));
  });

  it("rejects invalid config", () => {
    expect(() => makeConfig({ controllerRate: 7 })).toThrow();
    expect(() => makeConfig({ playersPerTeam: 6 })).toThrow();
  });
});

describe("step", () => {
  it("never mutates its input state", () => {
    const w = deepFreeze(createWorld(3));
    const cmd: EngineCommand = { type: "moveTo", playerId: "blue-4", x: 0, y: 0, sprint: true };
    expect(() => step(w, [cmd])).not.toThrow();
    expect(w.tick).toBe(0);
  });

  it("rejects malformed commands and reports them", () => {
    const w = createWorld(3);
    const { rejected } = step(w, [
      { type: "moveTo", playerId: "green-1", x: 0, y: 0 },
      { type: "moveTo", playerId: "blue-1", x: Number.NaN, y: 0 },
      { type: "teleport", playerId: "blue-1" },
      null,
      { type: "stop", playerId: "red-2" },
    ]);
    expect(rejected).toHaveLength(4);
  });

  it("result is independent of command order across players", () => {
    const w = createWorld(5);
    const a: EngineCommand = { type: "moveTo", playerId: "blue-2", x: 3, y: 3 };
    const b: EngineCommand = { type: "moveTo", playerId: "red-3", x: -3, y: -3, sprint: true };
    expect(hashState(step(w, [a, b]).state)).toBe(hashState(step(w, [b, a]).state));
  });
});

describe("player kinematics", () => {
  it("accelerates gradually up to the jog cap and never teleports", () => {
    let s = isolatedWorld({ "blue-4": { x: -20, y: 0 } });
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: 20, y: 0 }]).state;
    const cfg = DEFAULT_CONFIG.player;
    const dt = 1 / 60;
    let prev = player(s, "blue-4");
    let maxSpeed = 0;
    for (let i = 0; i < 240; i++) {
      s = step(s).state;
      const p = player(s, "blue-4");
      const moved = Math.hypot(p.x - prev.x, p.y - prev.y);
      expect(moved).toBeLessThanOrEqual(cfg.sprintSpeed * dt + 1e-9);
      const dv = Math.hypot(p.vx - prev.vx, p.vy - prev.vy);
      expect(dv).toBeLessThanOrEqual(Math.max(cfg.acceleration, cfg.deceleration) * dt + 1e-9);
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vy));
      prev = p;
    }
    expect(maxSpeed).toBeGreaterThan(cfg.maxSpeed * 0.99);
    expect(maxSpeed).toBeLessThanOrEqual(cfg.maxSpeed + 1e-9);
  });

  it("sprinting is faster and drains stamina, which recovers afterwards", () => {
    let s = isolatedWorld({ "blue-4": { x: -20, y: 0 } });
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: 22, y: 0, sprint: true }]).state;
    let maxSpeed = 0;
    for (let i = 0; i < 180; i++) {
      s = step(s).state;
      maxSpeed = Math.max(maxSpeed, Math.hypot(player(s, "blue-4").vx, player(s, "blue-4").vy));
    }
    expect(maxSpeed).toBeGreaterThan(DEFAULT_CONFIG.player.maxSpeed + 1);
    const drained = player(s, "blue-4").stamina;
    expect(drained).toBeLessThan(1);
    s = step(s, [{ type: "stop", playerId: "blue-4" }]).state;
    for (let i = 0; i < 300; i++) s = step(s).state;
    expect(player(s, "blue-4").stamina).toBeGreaterThan(drained);
  });

  it("cannot sprint below the stamina threshold", () => {
    const base = isolatedWorld({ "blue-4": { x: -20, y: 0 } });
    let s: WorldState = { ...base, players: base.players.map((p) => (p.id === "blue-4" ? { ...p, stamina: 0 } : p)) };
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: 22, y: 0, sprint: true }]).state;
    let maxSpeed = 0;
    // 2.5 s of jogging recovers 0.125 stamina: still below the 0.15 sprint threshold.
    for (let i = 0; i < 150; i++) {
      s = step(s).state;
      maxSpeed = Math.max(maxSpeed, Math.hypot(player(s, "blue-4").vx, player(s, "blue-4").vy));
    }
    expect(maxSpeed).toBeLessThanOrEqual(DEFAULT_CONFIG.player.maxSpeed + 1e-9);
  });

  it("turns with a bounded turn rate", () => {
    let s = isolatedWorld({ "blue-4": { x: 0, y: 0 } }); // heading 0 (facing +x)
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: -10, y: 0 }]).state;
    const h1 = player(s, "blue-4").heading;
    expect(Math.abs(h1)).toBeLessThanOrEqual(DEFAULT_CONFIG.player.turnRate / 60 + 1e-9);
  });

  it("arrives at and stops near its target", () => {
    let s = isolatedWorld({ "blue-4": { x: -5, y: 0 } });
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: 5, y: 0 }]).state;
    for (let i = 0; i < 400; i++) s = step(s).state;
    const p = player(s, "blue-4");
    expect(Math.hypot(p.x - 5, p.y)).toBeLessThan(0.5);
    expect(Math.hypot(p.vx, p.vy)).toBeLessThan(0.05);
  });

  it("stays inside pitch + run-off", () => {
    let s = isolatedWorld({ "blue-4": { x: 0, y: 0 } });
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: 0, y: 100, sprint: true }]).state;
    for (let i = 0; i < 600; i++) s = step(s).state;
    expect(player(s, "blue-4").y).toBeLessThanOrEqual(16 + 2 - 0.4 + 1e-9);
  });
});

describe("collisions", () => {
  it("players never overlap after a head-on collision", () => {
    let s = isolatedWorld({ "blue-4": { x: -5, y: 0 }, "red-4": { x: 5, y: 0 } });
    s = step(s, [
      { type: "moveTo", playerId: "blue-4", x: 5, y: 0, sprint: true },
      { type: "moveTo", playerId: "red-4", x: -5, y: 0, sprint: true },
    ]).state;
    let collided = false;
    for (let i = 0; i < 180; i++) {
      s = step(s).state;
      if (s.contacts.playerPlayer > 0) collided = true;
      const a = player(s, "blue-4");
      const b = player(s, "red-4");
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * DEFAULT_CONFIG.player.radius - 1e-6);
    }
    expect(collided).toBe(true);
  });

  it("a running player pushes the ball, which then rolls free and stops by friction", () => {
    let s = isolatedWorld({ "blue-4": { x: -4, y: 0 } }, { x: 0, y: 0, vx: 0, vy: 0 });
    s = step(s, [{ type: "moveTo", playerId: "blue-4", x: 6, y: 0, sprint: true }]).state;
    let touched = false;
    for (let i = 0; i < 90; i++) {
      s = step(s).state;
      if (s.contacts.playerBall > 0) touched = true;
      const p = player(s, "blue-4");
      expect(Math.hypot(s.ball.x - p.x, s.ball.y - p.y)).toBeGreaterThanOrEqual(0.51 - 1e-6);
    }
    expect(touched).toBe(true);
    expect(s.ball.x).toBeGreaterThan(1);
    // Stop the player: the ball keeps rolling ahead (no attachment), then comes to rest.
    s = step(s, [{ type: "stop", playerId: "blue-4" }]).state;
    const p0 = player(s, "blue-4");
    for (let i = 0; i < 1200; i++) s = step(s).state;
    expect(s.ball.vx).toBe(0);
    expect(s.ball.vy).toBe(0);
    expect(s.ball.x - player(s, "blue-4").x).toBeGreaterThan(s.ball.x - p0.x - 10);
  });

  it("ball friction monotonically slows a free ball", () => {
    let s = isolatedWorld({}, { x: -10, y: 0, vx: 8, vy: 0 });
    let prev = 8;
    for (let i = 0; i < 120; i++) {
      s = step(s).state;
      const v = Math.hypot(s.ball.vx, s.ball.vy);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBeLessThan(8);
  });

  it("ball bounces off boundaries and stays on the pitch", () => {
    let s = isolatedWorld({}, { x: 22, y: 5, vx: 15, vy: 9 });
    let walls = 0;
    for (let i = 0; i < 600; i++) {
      s = step(s).state;
      walls += s.contacts.ballWall;
      expect(Math.abs(s.ball.x)).toBeLessThanOrEqual(25);
      expect(Math.abs(s.ball.y)).toBeLessThanOrEqual(16);
    }
    expect(walls).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  it("hash uses both 32-bit lanes and is sensitive to a 1-ulp change", () => {
    const w = createWorld(42);
    const h = hashState(w);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h.slice(8)).not.toBe("00000000");
    const nudged = { ...w, ball: { ...w.ball, x: Number.MIN_VALUE } };
    const h2 = hashState(nudged);
    expect(h2.slice(0, 8)).not.toBe(h.slice(0, 8));
    expect(h2.slice(8)).not.toBe(h.slice(8));
  });

  it("same seed + command stream ⇒ identical hash sequence; replay matches", () => {
    const run = () => {
      const sim = new Simulation(42);
      const hashes: string[] = [];
      for (let t = 0; t < 1200; t++) {
        if (t % 30 === 0) {
          const k = t / 30;
          sim.submit([
            { type: "moveTo", playerId: "blue-4", x: Math.sin(k) * 10, y: Math.cos(k) * 6, sprint: k % 2 === 0 },
            { type: "moveTo", playerId: "red-4", x: 0, y: 0, sprint: true },
            { type: "moveTo", playerId: "red-5", x: -2, y: 1 },
          ]);
        }
        sim.tick();
        hashes.push(sim.hash());
      }
      return { sim, hashes };
    };
    const a = run();
    const b = run();
    expect(b.hashes).toEqual(a.hashes);
    const replayed = Simulation.replay(42, a.sim.log, a.sim.state.tick);
    expect(hashState(replayed)).toBe(a.hashes.at(-1));
  });

  it("commands only take effect on 10 Hz decision ticks", () => {
    const sim = new Simulation(1);
    sim.run(3); // tick 3: not a decision tick
    sim.submit([{ type: "moveTo", playerId: "blue-4", x: 0, y: 10 }]);
    sim.run(2); // ticks 3,4
    expect(sim.state.players.find((p) => p.id === "blue-4")!.intent.targetX).toBeNull();
    sim.run(2); // tick 5 → 6 boundary, then 6 is a decision tick
    expect(sim.log[0]!.tick).toBe(6);
  });

  it("match clock runs two 120 s halves", () => {
    expect(clockOf(0).half).toBe(1);
    expect(clockOf(60 * 119).half).toBe(1);
    expect(clockOf(60 * 120).half).toBe(2);
    expect(clockOf(60 * 240).finished).toBe(true);
    const short = makeConfig({ halfDurationSec: 10 });
    expect(clockOf(60 * 20, short).finished).toBe(true);
  });
});
