import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMatchInfo } from "@autosoccer/controller-sdk";
import { runSeriesMatch } from "@autosoccer/match-runner";
import {
  ATTRIBUTE_NAMES,
  BALL_CONTROL,
  createWorld,
  ELEVEN_A_SIDE,
  type EngineCommand,
  hashState,
  makeConfig,
  type PlayerAttributes,
  type PlayerId,
  type SimConfig,
  type SimEvent,
  step,
  type WorldState,
} from "@autosoccer/sim-core";

const ex = (p: string) => readFileSync(new URL(`../examples/controllers/${p}`, import.meta.url), "utf8");
const IDS: PlayerId[] = ["blue-1", "blue-2", "blue-3", "blue-4", "blue-5", "red-1", "red-2", "red-3", "red-4", "red-5"];
const rated = (r: number, over: Partial<Record<(typeof ATTRIBUTE_NAMES)[number], number>> = {}): PlayerAttributes =>
  ({ ...Object.fromEntries(ATTRIBUTE_NAMES.map((n) => [n, r])), ...over }) as PlayerAttributes;
const withPlayers = (players: Record<string, PlayerAttributes>) => makeConfig({ ...BALL_CONTROL, players });

function setup(cfg: SimConfig, place: Partial<Record<PlayerId, { x: number; y: number; heading?: number }>>, ball: { x: number; y: number }, seed: number): WorldState {
  const cmds: EngineCommand[] = [{ type: "debugSetMatch", period: "firstHalf", phase: "openPlay" }, { type: "debugPlaceBall", ...ball }];
  IDS.forEach((id, i) => {
    const p = place[id];
    cmds.push(p ? { type: "debugPlacePlayer", playerId: id, ...p } : { type: "debugPlacePlayer", playerId: id, x: -22 + i * 4.8, y: -17.2 });
  });
  return step(createWorld(seed, cfg), cmds, cfg).state;
}
function run(cfg: SimConfig, s: WorldState, n: number, cmds: (i: number) => EngineCommand[] = () => []) {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    s = step(s, cmds(i), cfg).state;
    events.push(...s.events);
  }
  return { s, events };
}
const player = (s: WorldState, id: PlayerId) => s.players.find((p) => p.id === id)!;

describe("player attributes", () => {
  it("a player rated 60 in everything plays exactly like a player without attributes", () => {
    const plain = makeConfig(BALL_CONTROL);
    const sixty = withPlayers(Object.fromEntries(IDS.map((id) => [id, rated(60)])));
    const script = (i: number): EngineCommand[] =>
      i === 0
        ? [
            { type: "moveTo", playerId: "blue-4", x: 10, y: 3, sprint: true, dribble: true },
            { type: "moveTo", playerId: "red-3", x: -2, y: 0, sprint: true },
          ]
        : i === 50
          ? [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0.1, power: 0.9 }, { type: "tackle", playerId: "red-3" }]
          : [];
    const place = { "blue-4": { x: -1, y: 0, heading: 0 }, "red-3": { x: 4, y: 1, heading: Math.PI } };
    const a = run(plain, setup(plain, place, { x: -0.4, y: 0 }, 9), 240, script).s;
    const b = run(sixty, setup(sixty, place, { x: -0.4, y: 0 }, 9), 240, script).s;
    expect(hashState(b)).toBe(hashState(a));
  });

  it("pace: a quick player outruns a slow one", () => {
    const cfg = withPlayers({ "blue-4": rated(60, { pace: 92 }), "blue-5": rated(60, { pace: 30 }) });
    const s0 = setup(cfg, { "blue-4": { x: -20, y: -4, heading: 0 }, "blue-5": { x: -20, y: 4, heading: 0 } }, { x: 0, y: 14 }, 1);
    const { s } = run(cfg, s0, 180, (i) =>
      i === 0
        ? [
            { type: "moveTo", playerId: "blue-4", x: 20, y: -4, sprint: true },
            { type: "moveTo", playerId: "blue-5", x: 20, y: 4, sprint: true },
          ]
        : [],
    );
    expect(player(s, "blue-4").x - player(s, "blue-5").x).toBeGreaterThan(2);
  });

  it("stamina: a fit player tires more slowly", () => {
    const cfg = withPlayers({ "blue-4": rated(60, { stamina: 95 }), "blue-5": rated(60, { stamina: 25 }) });
    const s0 = setup(cfg, { "blue-4": { x: -20, y: -4, heading: 0 }, "blue-5": { x: -20, y: 4, heading: 0 } }, { x: 0, y: 14 }, 1);
    const { s } = run(cfg, s0, 240, (i) =>
      i === 0
        ? [
            { type: "moveTo", playerId: "blue-4", x: 22, y: -4, sprint: true },
            { type: "moveTo", playerId: "blue-5", x: 22, y: 4, sprint: true },
          ]
        : [],
    );
    expect(player(s, "blue-4").stamina).toBeGreaterThan(player(s, "blue-5").stamina + 0.05);
  });

  it("agility: a nimble player turns faster", () => {
    const cfg = withPlayers({ "blue-4": rated(60, { agility: 95 }), "blue-5": rated(60, { agility: 25 }) });
    const s0 = setup(cfg, { "blue-4": { x: -5, y: -4, heading: 0 }, "blue-5": { x: -5, y: 4, heading: 0 } }, { x: 0, y: 14 }, 1);
    const { s } = run(cfg, s0, 5, (i) =>
      i === 0
        ? [
            { type: "moveTo", playerId: "blue-4", x: -15, y: -4 },
            { type: "moveTo", playerId: "blue-5", x: -15, y: 4 },
          ]
        : [],
    );
    const turned = (id: PlayerId) => Math.abs(player(s, id).heading);
    expect(turned("blue-4")).toBeGreaterThan(turned("blue-5") * 1.3);
  });

  it("shooting and power: good strikers hit it harder and straighter", () => {
    const strike = (r: number, seed: number) => {
      // Without ball control, so the striker doesn't collect the ball (and start a touch cooldown) during setup.
      const cfg = makeConfig({ players: { "blue-4": rated(60, { shooting: r, power: r }) } });
      const s0 = setup(cfg, { "blue-4": { x: -0.6, y: 0, heading: 0 } }, { x: 0, y: 0 }, seed);
      const e = step(s0, [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 1 }], cfg).state.events.find((x) => x.type === "kick")!;
      return e as Extract<SimEvent, { type: "kick" }>;
    };
    let errGood = 0;
    let errPoor = 0;
    for (let seed = 1; seed <= 200; seed++) {
      errGood += Math.abs(strike(95, seed).errorRad);
      errPoor += Math.abs(strike(25, seed).errorRad);
    }
    expect(errGood).toBeLessThan(errPoor * 0.6);
    expect(strike(95, 1).speed).toBeGreaterThan(strike(25, 1).speed + 3);
  });

  it("tackling and goalkeeping: better defenders win more tackles, better keepers reach further", () => {
    const tackles = (r: number) => {
      let won = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const cfg = withPlayers({ "red-3": rated(60, { tackling: r }) });
        const s0 = setup(cfg, { "blue-4": { x: -3, y: 3 }, "red-3": { x: 0.9, y: 0 } }, { x: 0, y: 0 }, seed);
        if (step(s0, [{ type: "tackle", playerId: "red-3" }], cfg).state.events.some((e) => e.type === "tackle" && e.success)) won++;
      }
      return won;
    };
    expect(tackles(95)).toBeGreaterThan(tackles(25) + 30);

    const reach = (r: number) => {
      const cfg = withPlayers({ "blue-1": rated(60, { goalkeeping: r }) });
      const s0 = setup(cfg, { "blue-1": { x: -22, y: 0 } }, { x: -22, y: 1.5 }, 1);
      return step(s0, [{ type: "catch", playerId: "blue-1" }], cfg).rejected.length === 0;
    };
    expect(reach(95)).toBe(true); // 1.5 m: beyond the 1.4 m base reach
    expect(reach(40)).toBe(false);
  });

  it("validates ratings", () => {
    expect(() => withPlayers({ "blue-4": rated(100) })).toThrow(/players\.blue-4\.pace/);
    expect(() => withPlayers({ "blue-4": rated(0) })).toThrow(/1 to 99/);
    expect(() => withPlayers({ "blue-4": { ...rated(60), passing: 55.5 } })).toThrow(/passing/);
    const { tackling: _, ...missing } = rated(60);
    expect(() => withPlayers({ "blue-4": missing as PlayerAttributes })).toThrow(/tackling/);
  });

  it("controllers see their own players' ratings, and an 11-a-side match with ratings replays exactly", async () => {
    const players = Object.fromEntries(
      [...Array(11)].flatMap((_, i) => [
        [`blue-${i + 1}`, rated(40 + i * 5)],
        [`red-${i + 1}`, rated(85 - i * 4)],
      ]),
    );
    const cfg = makeConfig({ ...ELEVEN_A_SIDE, ...BALL_CONTROL, players });
    const info = buildMatchInfo(createWorld(1, cfg), "blue", cfg);
    expect(info.players.find((p) => p.id === "blue-3")!.attributes).toEqual(rated(50));

    const { summary, replay } = await runSeriesMatch(3, {
      blue: { label: "zonal", source: ex("zonal.js") },
      red: { label: "chaser", source: ex("chaser.js") },
      config: { ...ELEVEN_A_SIDE, ...BALL_CONTROL, players, halfDurationSec: 20 },
      replayEvery: 1,
      determinismEvery: 1,
      checkInvariants: true,
    });
    expect(summary.finished).toBe(true);
    expect(summary.failures).toEqual([]);
    expect(summary.invariantViolations).toEqual([]);
    expect(summary.deterministic).toBe(true);
    expect(summary.replayVerified).toBe(true);
    expect(replay!.config.players!["red-1"]).toEqual(rated(85));
  }, 60_000);
});
