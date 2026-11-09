/**
 * Scripted debug scenarios for the interactive playground and tests. Each
 * scenario places players/ball with debug commands, then issues ordinary
 * engine commands at given times or when a condition holds. Outcomes still
 * come from the engine (range checks, seeded success rolls), so a scenario can
 * legitimately end differently on different seeds.
 */
import type { CommandSource } from "@autosoccer/controller-sdk";
import type { EngineCommand, PlayerId, WorldState } from "@autosoccer/sim-core";
import { dhypot } from "@autosoccer/sim-core";
import { restartCommands } from "./restarts.ts";

export interface ScenarioStep {
  readonly label: string;
  /** Fire at `startTick + at` (rounded up to a decision tick)… */
  readonly at?: number;
  /** …or the first decision tick where this holds (after the previous step). */
  readonly when?: (s: WorldState) => boolean;
  readonly commands: (s: WorldState) => EngineCommand[];
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly place: Partial<Record<PlayerId, { x: number; y: number; heading?: number }>>;
  readonly ball: { x: number; y: number; vx?: number; vy?: number };
  /** Match period to start in (default first half, open play). */
  readonly period?: "firstHalf" | "secondHalf";
  /** Clock position to start from (ticks into the half), e.g. to demo the whistle. */
  readonly halfTicks?: number;
  /** Let designated takers walk to the ball and take restarts automatically. */
  readonly autoRestarts?: boolean;
  /** Group shown in the viewer's scenario picker. */
  readonly group?: "M2 actions" | "M3 match flow";
  readonly steps: readonly ScenarioStep[];
  /** Ticks after which the scenario is considered finished. */
  readonly durationTicks: number;
}

const ALL_IDS: PlayerId[] = ["blue-1", "blue-2", "blue-3", "blue-4", "blue-5", "red-1", "red-2", "red-3", "red-4", "red-5"];
const PI = 3.141592653589793;

const pos = (s: WorldState, id: PlayerId) => s.players.find((p) => p.id === id)!;
const ballDist = (s: WorldState, id: PlayerId) => {
  const p = pos(s, id);
  return dhypot(s.ball.x - p.x, s.ball.y - p.y);
};
const aim = (s: WorldState, x: number, y: number) => ({ dirX: x - s.ball.x, dirY: y - s.ball.y });

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "pass",
    title: "Pass and trap",
    description: "B4 plays a firm ground pass to B5, who traps the incoming ball.",
    place: { "blue-4": { x: -6, y: 0, heading: 0 }, "blue-5": { x: 4, y: 3, heading: PI } },
    ball: { x: -5.35, y: 0 },
    steps: [
      { label: "B4 kicks to B5 (power 0.32)", at: 30, commands: (s) => [{ type: "kick", playerId: "blue-4", ...aim(s, 4, 3), power: 0.32 }] },
    ],
    durationTicks: 180,
  },
  {
    id: "shoot",
    title: "Shot → goal-line crossing",
    description: "B5 shoots at full power past R1; the ball fully crosses the goal line between the posts.",
    place: { "blue-5": { x: 14, y: 2, heading: 0 }, "red-1": { x: 23.6, y: -1.4, heading: PI } },
    ball: { x: 14.65, y: 2 },
    steps: [
      { label: "B5 shoots (power 1.0) at the far post", at: 30, commands: (s) => [{ type: "kick", playerId: "blue-5", ...aim(s, 25, 1.3), power: 1 }] },
    ],
    durationTicks: 150,
  },
  {
    id: "dribble",
    title: "Dribble",
    description: "B4 runs with dribble on, taking small touches to keep the ball ahead, then turns.",
    place: { "blue-4": { x: -14, y: -4, heading: 0 } },
    ball: { x: -13.4, y: -4 },
    steps: [
      { label: "B4 dribbles toward (4, −4)", at: 6, commands: () => [{ type: "moveTo", playerId: "blue-4", x: 4, y: -4, dribble: true }] },
      { label: "B4 turns and dribbles toward (8, 6)", at: 200, commands: () => [{ type: "moveTo", playerId: "blue-4", x: 8, y: 6, dribble: true }] },
    ],
    durationTicks: 360,
  },
  {
    id: "tackle",
    title: "Tackle",
    description: "R4 dribbles at B3; B3 tackles when the ball is in reach. Success is a seeded roll; a miss grounds B3.",
    place: { "red-4": { x: 6, y: 0, heading: PI }, "blue-3": { x: -4, y: 1.1, heading: -PI / 2 } },
    ball: { x: 5.4, y: 0 },
    steps: [
      { label: "R4 dribbles toward B3", at: 6, commands: () => [{ type: "moveTo", playerId: "red-4", x: -12, y: 0, dribble: true }] },
      { label: "B3 tackles", when: (s) => ballDist(s, "blue-3") < 1.3, commands: () => [{ type: "tackle", playerId: "blue-3" }] },
    ],
    durationTicks: 240,
  },
  {
    id: "intercept",
    title: "Interception",
    description: "R2 passes to R5; B2 steps into the passing lane and traps the ball (interception).",
    place: { "red-2": { x: 8, y: -6, heading: PI }, "red-5": { x: -8, y: -6, heading: 0 }, "blue-2": { x: 0, y: -7.4, heading: PI / 2 } },
    ball: { x: 7.35, y: -6 },
    steps: [
      { label: "B2 steps toward the lane", at: 6, commands: () => [{ type: "moveTo", playerId: "blue-2", x: 0, y: -6, sprint: true }] },
      { label: "R2 passes to R5 (power 0.3)", at: 18, commands: (s) => [{ type: "kick", playerId: "red-2", ...aim(s, -8, -6), power: 0.3 }] },
    ],
    durationTicks: 180,
  },
  {
    id: "keeper",
    title: "Keeper catch & release",
    description: "R5 shoots at B1; B1 catches inside the area, holds, then throws to B2.",
    place: { "red-5": { x: -15, y: 1, heading: PI }, "blue-1": { x: -23.4, y: 0, heading: 0 }, "blue-2": { x: -14, y: -8, heading: PI } },
    ball: { x: -15.65, y: 1 },
    steps: [
      { label: "R5 shoots at goal (power 0.3)", at: 30, commands: (s) => [{ type: "kick", playerId: "red-5", ...aim(s, -25, 0.4), power: 0.3 }] },
      { label: "B1 catches", when: (s) => ballDist(s, "blue-1") < 1.3, commands: () => [{ type: "catch", playerId: "blue-1" }] },
      { label: "B1 releases to B2", when: (s) => s.ball.heldBy === "blue-1" && s.ball.holdTicks >= 90, commands: (s) => {
        const b2 = pos(s, "blue-2");
        const k = pos(s, "blue-1");
        return [{ type: "release", playerId: "blue-1", dirX: b2.x - k.x, dirY: b2.y - k.y, power: 0.35 }];
      } },
    ],
    durationTicks: 300,
  },
  {
    id: "illegal-kick",
    title: "Rejected kicks",
    description: "B4 tries to kick a ball 2.4 m away (out of range), then backwards (outside facing cone); both are rejected. Then a legal kick.",
    place: { "blue-4": { x: -5, y: 0, heading: 0 } },
    ball: { x: -2.6, y: 0 },
    steps: [
      { label: "B4 kicks — ball out of range", at: 30, commands: () => [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 0.6 }] },
      { label: "Ball placed at B4's feet", at: 90, commands: () => [{ type: "debugPlaceBall", x: -4.4, y: 0 }] },
      { label: "B4 kicks backwards — outside facing cone", at: 120, commands: () => [{ type: "kick", playerId: "blue-4", dirX: -1, dirY: 0, power: 0.6 }] },
      { label: "B4 kicks forwards — legal", at: 180, commands: () => [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0.1, power: 0.5 }] },
    ],
    durationTicks: 270,
  },
  {
    id: "illegal-catch",
    title: "Rejected catches",
    description: "B1 tries to catch outside the penalty area and outfield B4 tries to catch; both rejected. Then a legal catch.",
    place: { "blue-1": { x: -18.2, y: 0, heading: 0 }, "blue-4": { x: -14, y: 5, heading: 0 } },
    ball: { x: -17.4, y: 0 },
    steps: [
      { label: "B1 catches — ball outside own area", at: 30, commands: () => [{ type: "catch", playerId: "blue-1" }] },
      { label: "Ball placed at B4's feet", at: 70, commands: () => [{ type: "debugPlaceBall", x: -13.4, y: 5 }] },
      { label: "B4 (outfield) catches — not a goalkeeper", at: 90, commands: () => [{ type: "catch", playerId: "blue-4" }] },
      { label: "B1 back in goal, ball inside the area", at: 140, commands: () => [{ type: "debugPlacePlayer", playerId: "blue-1", x: -22.2, y: 0, heading: 0 }, { type: "debugPlaceBall", x: -21.1, y: 0.4 }] },
      { label: "B1 catches — legal", at: 200, commands: () => [{ type: "catch", playerId: "blue-1" }] },
    ],
    durationTicks: 280,
  },
  // ───────────── M3: match flow ─────────────
  {
    id: "m3-goal-kickoff",
    group: "M3 match flow",
    title: "Goal → score → kickoff",
    description: "B5 scores; the goal is attributed, the score updates, and after the celebration red (conceding) kicks off with everyone back in their own half.",
    place: { "blue-5": { x: 14, y: 2, heading: 0 }, "red-1": { x: 23.6, y: -1.4, heading: PI } },
    ball: { x: 14.65, y: 2 },
    autoRestarts: true,
    steps: [{ label: "B5 shoots", at: 30, commands: (s) => [{ type: "kick", playerId: "blue-5", ...aim(s, 25, 1.3), power: 1 }] }],
    durationTicks: 330,
  },
  {
    id: "m3-kick-in",
    group: "M3 match flow",
    title: "Touchline → kick-in",
    description: "R4 dribbles the ball over the touchline; blue is awarded a kick-in at the crossing point and the nearest blue player takes it. Red must stand 4 m away.",
    place: { "red-4": { x: 0, y: 11, heading: PI / 2 }, "blue-3": { x: -6, y: 8, heading: 0 }, "blue-4": { x: 6, y: 6, heading: PI }, "red-3": { x: 3, y: 13, heading: PI } },
    ball: { x: 0, y: 11.6 },
    autoRestarts: true,
    steps: [{ label: "R4 dribbles over the touchline", at: 6, commands: () => [{ type: "moveTo", playerId: "red-4", x: 0, y: 20, dribble: true }] }],
    durationTicks: 330,
  },
  {
    id: "m3-corner",
    group: "M3 match flow",
    title: "Defender's touch over own goal line → corner",
    description: "R2 clears the ball over its own goal line; blue gets a corner at the nearest corner flag.",
    place: { "red-2": { x: 21, y: -6, heading: 0 }, "blue-5": { x: 16, y: -2, heading: 0 }, "red-1": { x: 23.6, y: 0, heading: PI }, "blue-4": { x: 18, y: 3, heading: 0 } },
    ball: { x: 21.6, y: -6 },
    autoRestarts: true,
    steps: [{ label: "R2 clears over its own goal line", at: 30, commands: (s) => [{ type: "kick", playerId: "red-2", ...aim(s, 26, -10), power: 0.45 }] }],
    durationTicks: 330,
  },
  {
    id: "m3-goal-kick",
    group: "M3 match flow",
    title: "Attacker's shot wide → goal kick",
    description: "B5 shoots wide of the post; red gets a goal kick, taken by its goalkeeper from the goal-kick spot.",
    place: { "blue-5": { x: 12, y: -5, heading: 0 }, "red-1": { x: 23.6, y: 0, heading: PI }, "red-3": { x: 12, y: 6, heading: PI } },
    ball: { x: 12.65, y: -5 },
    autoRestarts: true,
    steps: [{ label: "B5 shoots wide", at: 30, commands: (s) => [{ type: "kick", playerId: "blue-5", ...aim(s, 25, -5), power: 0.7 }] }],
    durationTicks: 360,
  },
  {
    id: "m3-foul",
    group: "M3 match flow",
    title: "Foul → free kick",
    description: "B3 lunges from the edge of tackle reach and misses, making contact with R4: a foul. Red gets a free kick at the ball; blue must retreat 4 m.",
    place: { "red-4": { x: 0.2, y: 0.55, heading: PI }, "blue-3": { x: -0.5, y: 1.1, heading: -PI / 4 }, "red-5": { x: -6, y: -4, heading: PI } },
    ball: { x: 0, y: 0 },
    autoRestarts: true,
    steps: [{ label: "B3 tackles from 1.2 m", at: 30, commands: () => [{ type: "tackle", playerId: "blue-3" }] }],
    durationTicks: 270,
  },
  {
    id: "m3-halftime",
    group: "M3 match flow",
    title: "Halftime whistle → sides switch → second-half kickoff",
    description: "The clock is set 3 s before the end of the first half. At 2:00 the whistle goes, then after the break the teams swap ends and the other team kicks off.",
    place: { "blue-4": { x: -4, y: 0, heading: 0 }, "red-4": { x: 4, y: 0, heading: PI } },
    ball: { x: 0, y: 3 },
    halfTicks: 120 * 60 - 180,
    autoRestarts: true,
    steps: [],
    durationTicks: 520,
  },
  {
    id: "m3-full-time",
    group: "M3 match flow",
    title: "Final whistle",
    description: "Second half, 3 s left. The final whistle ends the match; further actions are rejected.",
    place: { "blue-4": { x: -0.7, y: 0, heading: 0 }, "red-4": { x: 6, y: 0, heading: PI } },
    ball: { x: 0, y: 0 },
    period: "secondHalf",
    halfTicks: 120 * 60 - 180,
    steps: [
      { label: "B4 dribbles", at: 6, commands: () => [{ type: "moveTo", playerId: "blue-4", x: 20, y: 0, dribble: true }] },
      { label: "B4 shoots after the whistle — rejected", at: 230, commands: () => [{ type: "kick", playerId: "blue-4", dirX: 1, dirY: 0, power: 1 }] },
    ],
    durationTicks: 260,
  },
  {
    id: "m3-timeout",
    group: "M3 match flow",
    title: "Restart timeout → engine fallback",
    description: "Blue is awarded a kick-in but its taker never moves. After 6 s the engine takes the restart itself (pass to the nearest teammate), so a bad controller can't stall the match.",
    place: { "red-4": { x: 0, y: 11, heading: PI / 2 }, "blue-3": { x: -5, y: 9, heading: 0 }, "blue-4": { x: 6, y: 6, heading: PI } },
    ball: { x: 0, y: 11.6 },
    steps: [
      { label: "R4 dribbles over the touchline", at: 6, commands: () => [{ type: "moveTo", playerId: "red-4", x: 0, y: 20, dribble: true }] },
      { label: "Blue taker idles…", at: 60, commands: () => [{ type: "stop", playerId: "red-4" }] },
    ],
    durationTicks: 560,
  },
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
}

/** Setup commands: involved players placed, everyone else parked along the far touchline. */
export function scenarioSetup(sc: Scenario): EngineCommand[] {
  const out: EngineCommand[] = [
    { type: "debugSetMatch", period: sc.period ?? "firstHalf", phase: "openPlay", halfTicks: sc.halfTicks ?? 0 },
    { type: "debugPlaceBall", x: sc.ball.x, y: sc.ball.y, vx: sc.ball.vx ?? 0, vy: sc.ball.vy ?? 0 },
  ];
  let park = 0;
  for (const id of ALL_IDS) {
    const p = sc.place[id];
    if (p) out.push({ type: "debugPlacePlayer", playerId: id, x: p.x, y: p.y, heading: p.heading ?? (id.startsWith("blue") ? 0 : PI), stamina: 1 });
    else out.push({ type: "debugPlacePlayer", playerId: id, x: -20 + park++ * 5, y: -17.2, heading: PI / 2, stamina: 1 });
  }
  return out;
}

export interface ScenarioSource extends CommandSource {
  readonly scenario: Scenario;
  /** Label of the most recently fired step ("setup" before the first). */
  readonly currentStep: string | null;
  readonly startTick: number | null;
  readonly done: (tick: number) => boolean;
}

export function createScenarioSource(sc: Scenario): ScenarioSource {
  let startTick: number | null = null;
  let next = 0;
  let current: string | null = null;
  return {
    name: `scenario:${sc.id}`,
    team: "both",
    scenario: sc,
    get currentStep() {
      return current;
    },
    get startTick() {
      return startTick;
    },
    done: (tick) => startTick !== null && tick - startTick >= sc.durationTicks,
    decide({ state, tick }) {
      if (startTick === null) {
        startTick = tick;
        current = "setup";
        return scenarioSetup(sc);
      }
      const auto = sc.autoRestarts ? restartCommands(state, "both") : [];
      const step = sc.steps[next];
      if (!step) return auto;
      const due = step.at !== undefined ? tick - startTick >= step.at : step.when ? step.when(state) : false;
      if (!due) return auto;
      next++;
      current = step.label;
      return [...auto, ...step.commands(state)];
    },
  };
}
