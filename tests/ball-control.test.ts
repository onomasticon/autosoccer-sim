import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translateActions } from "@autosoccer/controller-sdk";
import { runSeriesMatch } from "@autosoccer/match-runner";
import {
  BALL_CONTROL,
  createWorld,
  DEFAULT_CONFIG,
  ELEVEN_A_SIDE,
  type EngineCommand,
  makeConfig,
  type PlayerId,
  type SimConfig,
  type SimEvent,
  step,
  type WorldState,
} from "@autosoccer/sim-core";

const ex = (p: string) => readFileSync(new URL(`../examples/controllers/${p}`, import.meta.url), "utf8");
const IDS: PlayerId[] = ["blue-1", "blue-2", "blue-3", "blue-4", "blue-5", "red-1", "red-2", "red-3", "red-4", "red-5"];
const CONTROL = makeConfig(BALL_CONTROL);

/** 5-a-side world in open play with everyone parked on the far touchline except the given placements. */
function setup(
  cfg: SimConfig,
  place: Partial<Record<PlayerId, { x: number; y: number; heading?: number }>>,
  ball: { x: number; y: number; vx?: number; vy?: number },
  seed: number,
): WorldState {
  const cmds: EngineCommand[] = [{ type: "debugSetMatch", period: "firstHalf", phase: "openPlay" }, { type: "debugPlaceBall", ...ball }];
  IDS.forEach((id, i) => {
    const p = place[id];
    cmds.push(p ? { type: "debugPlacePlayer", playerId: id, ...p } : { type: "debugPlacePlayer", playerId: id, x: -22 + i * 4.8, y: -17.2 });
  });
  return step(createWorld(seed, cfg), cmds, cfg).state;
}

function run(cfg: SimConfig, s: WorldState, n: number, cmds: (tick: number, s: WorldState) => EngineCommand[] = () => []) {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    s = step(s, cmds(i, s), cfg).state;
    events.push(...s.events);
  }
  return { s, events };
}

const ballSpeed = (s: WorldState) => Math.hypot(s.ball.vx, s.ball.vy);
const dist = (s: WorldState, id: PlayerId) => {
  const p = s.players.find((q) => q.id === id)!;
  return Math.hypot(p.x - s.ball.x, p.y - s.ball.y);
};

/** blue-4 sprints onto a still ball 4 m ahead and keeps running to a point 10 m beyond it. */
function runOnto(cfg: SimConfig, seed: number, watch: (s: WorldState) => void = () => {}) {
  const s0 = setup(cfg, { "blue-4": { x: -6, y: 0, heading: 0 } }, { x: -2, y: 0 }, seed);
  return run(cfg, s0, 90, (i, s) => {
    watch(s);
    return i === 0 ? [{ type: "moveTo", playerId: "blue-4", x: 8, y: 0, sprint: true }] : [];
  });
}

describe("ball control (opt-in)", () => {
  it("is off by default: a player running onto the ball knocks it on faster than he runs", () => {
    expect(DEFAULT_CONFIG.action.controlChance).toBeUndefined();
    const ratio = (cfg: SimConfig) => {
      let worst = 0;
      runOnto(cfg, 1, (s) => {
        const p = s.players.find((q) => q.id === "blue-4")!;
        const ps = Math.hypot(p.vx, p.vy);
        if (ps > 1) worst = Math.max(worst, ballSpeed(s) / ps);
      });
      return worst;
    };
    expect(ratio(DEFAULT_CONFIG)).toBeGreaterThan(1.4);
    expect(ratio(CONTROL)).toBeLessThan(1.25);
  });

  it("with control on, a player who reaches a loose ball usually settles it and keeps it close", () => {
    let kept = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { s, events } = runOnto(CONTROL, seed);
      const collected = events.some((e) => e.type === "trap" && e.playerId === "blue-4");
      if (collected && dist(s, "blue-4") < 2) kept++;
    }
    expect(kept).toBeGreaterThanOrEqual(26); // ≈ 85% control chance, plus later touches
    expect(kept).toBeLessThan(40); // …but not always
  });

  it("dribbling turns with the ball: the ball follows a 90° change of direction", () => {
    const s0 = setup(CONTROL, { "blue-4": { x: -0.6, y: 0, heading: 0 } }, { x: 0, y: 0 }, 3);
    const { s } = run(CONTROL, s0, 120, (i) => (i === 0 ? [{ type: "moveTo", playerId: "blue-4", x: 0, y: 12, dribble: true }] : []));
    expect(s.ball.y).toBeGreaterThan(5); // carried up the y axis…
    expect(Math.abs(s.ball.x)).toBeLessThan(2.5); // …not off along the original heading
    expect(dist(s, "blue-4")).toBeLessThan(1.5);
  });

  it("an opponent can't just collect a ball a player is shielding; they have to tackle", () => {
    const s0 = setup(CONTROL, { "blue-4": { x: -0.55, y: 0, heading: 0 }, "red-3": { x: 0.6, y: 0.1, heading: Math.PI } }, { x: 0, y: 0 }, 5);
    const s1 = { ...s0, ball: { ...s0.ball, lastTouch: "blue-4" as PlayerId } };
    const { events } = run(CONTROL, s1, 10);
    expect(events.some((e) => e.type === "trap" && e.playerId === "red-3")).toBe(false);
  });

  it("tackles succeed less often against a shielding player", () => {
    const rate = (cfg: SimConfig) => {
      let won = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const s0 = setup(cfg, { "blue-4": { x: -0.5, y: 0 }, "red-3": { x: 1.0, y: 0 } }, { x: 0, y: 0 }, seed);
        const s1 = { ...s0, ball: { ...s0.ball, lastTouch: "blue-4" as PlayerId } };
        const r = step(s1, [{ type: "tackle", playerId: "red-3" }], cfg).state;
        if (r.events.some((e) => e.type === "tackle" && e.success)) won++;
      }
      return won / 200;
    };
    expect(rate(CONTROL)).toBeLessThan(rate(DEFAULT_CONFIG) * 0.8);
  });

  it("rejects an out-of-range control chance", () => {
    expect(() => makeConfig({ action: { controlChance: 1.5 } })).toThrow(/controlChance/);
  });
});

describe("11-a-side", () => {
  const cfg11 = makeConfig({ ...ELEVEN_A_SIDE, ...BALL_CONTROL });

  it("creates eleven players a side, in their own half and outside the centre circle", () => {
    const w = createWorld(4, cfg11);
    expect(w.players).toHaveLength(22);
    for (const team of ["blue", "red"] as const) {
      const mine = w.players.filter((p) => p.team === team);
      expect(mine.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(mine.filter((p) => p.role === "GK")).toHaveLength(1);
      for (const p of mine) {
        expect(team === "blue" ? p.x < 0 : p.x > 0).toBe(true);
        expect(Math.hypot(p.x, p.y)).toBeGreaterThan(cfg11.pitch.centreCircleRadius);
        expect(Math.abs(p.y)).toBeLessThan(cfg11.pitch.width / 2);
      }
    }
  });

  it("lets controllers address shirts 10 and 11, and the engine moves them", () => {
    const w = createWorld(1, cfg11);
    const t = translateActions([{ type: "moveTo", player: 11, x: 0, y: 0 }, { type: "stop", player: "blue-10" }], "blue", w);
    expect(t.rejected).toEqual([]);
    expect(step(w, t.commands, cfg11).rejected).toEqual([]);
    const bad = translateActions([{ type: "moveTo", player: 8, x: 0, y: 0 }], "blue", createWorld(1, makeConfig()));
    expect(bad.rejected).toHaveLength(1);
  });

  it("plays sandboxed controllers to full time with no failures or invariant violations, and the replay verifies", async () => {
    const { summary, replay } = await runSeriesMatch(7, {
      blue: { label: "zonal", source: ex("zonal.js") },
      red: { label: "chaser", source: ex("chaser.js") },
      config: { ...ELEVEN_A_SIDE, ...BALL_CONTROL, halfDurationSec: 30 },
      replayEvery: 1,
      determinismEvery: 1,
      checkInvariants: true,
    });
    expect(summary.finished).toBe(true);
    expect(summary.failures).toEqual([]);
    expect(summary.invariantViolations).toEqual([]);
    expect(summary.deterministic).toBe(true);
    expect(summary.replayVerified).toBe(true);
    expect(replay!.config.playersPerTeam).toBe(11);
    expect(replay!.config.action.controlChance).toBe(0.85);
  }, 60_000);
});
