/**
 * @autosoccer/controller-sdk — the public, versioned contract between the
 * simulation and team controllers.
 *
 *   SDK_VERSION 1.1.0 · observation schema "1.0" · action schema "1.0"
 *   1.1: `Soccer` helper library in the sandbox; optional `debug` output from update.
 *   1.2: observation numbers rounded to 4 decimals (performance; shape unchanged).
 *   1.3: 7-a-side support: shirt refs up to the team size; `Soccer` helpers use the match pitch (`Soccer.pitch`).
 *
 * Controllers see only plain JSON observations (built here from the world
 * state; no engine references) and return plain JSON actions, which are
 * validated here and translated into engine commands for their own players
 * only. See docs/controller-sdk.md for the full reference.
 */
import type { EngineCommand, LoggedEvent, Period, Phase, PlayerId, RestartType, Role, SimConfig, SimEvent, TeamId, WorldState } from "@autosoccer/sim-core";
import { attackSign, DEFAULT_CONFIG, ENGINE_VERSION } from "@autosoccer/sim-core";

export const SDK_VERSION = "1.3.0";
/** Observation numbers are rounded to this many decimals (0.1 mm, 0.1 mm/s, 1e-4 rad). SDK ≥ 1.2. */
export const OBSERVATION_DECIMALS = 4;

/** Deterministic rounding used for every non-integer observation number. */
export function roundObs(v: number): number {
  return Number.isInteger(v) ? v : Math.round(v * 1e4) / 1e4;
}

/** JSON for an observation, with numbers rounded (much cheaper for the sandbox to parse). */
export function serializeObservation(o: Observation): string {
  return JSON.stringify(o, (_k, v) => (typeof v === "number" ? roundObs(v) : v));
}
export { HELPERS_SOURCE } from "./helpers-source.ts";
export const OBSERVATION_SCHEMA_VERSION = "1.0";
export const ACTION_SCHEMA_VERSION = "1.0";
/** Max actions accepted from one update call; extra actions are rejected. */
export const MAX_ACTIONS_PER_UPDATE = 32;

export type { EngineCommand, PlayerId, TeamId } from "@autosoccer/sim-core";

// ─────────────────────────────── observation ───────────────────────────────

export interface PlayerView {
  id: PlayerId;
  number: number;
  role: Role;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing direction, radians, 0 = +x. */
  heading: number;
  /** 0..1. Sprinting needs > rules.sprintThreshold. */
  stamina: number;
  /** Ticks until the player may touch/kick, tackle or (keeper) catch again. */
  cooldowns: { touch: number; tackle: number; catch: number };
  /** Ticks the player is grounded after a failed tackle (can't move or act). */
  stunned: number;
}

export interface OwnPlayerView extends PlayerView {
  /** The movement intent the engine is currently executing for this player. */
  intent: { target: { x: number; y: number } | null; sprint: boolean; dribble: boolean };
}

export interface Observation {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  /** Physics tick (60 Hz). Decisions happen every 6 ticks (10 Hz). */
  tick: number;
  team: TeamId;
  /** +1: you attack toward +x this half; −1: toward −x. Flips at halftime. */
  attackingDirection: 1 | -1;
  period: Period;
  phase: Phase;
  clock: { half: 1 | 2; secondsInHalf: number; halfDurationSec: number };
  score: { own: number; opponent: number; blue: number; red: number };
  ball: { x: number; y: number; vx: number; vy: number; heldBy: PlayerId | null; lastTouch: PlayerId | null };
  /** Your players (5 or 7, including the goalkeeper), in ID order. */
  teammates: OwnPlayerView[];
  opponents: PlayerView[];
  /** Pending restart, if any. Only `taker` may play it, by kicking once `ready`. */
  restart: null | {
    type: RestartType;
    team: TeamId;
    ours: boolean;
    x: number;
    y: number;
    taker: PlayerId;
    ready: boolean;
    /** Decision ticks left before the engine takes the restart itself. */
    decisionsUntilFallback: number;
  };
  /** Engine events since your previous update (kicks, tackles, goals, restarts, …). */
  events: Array<SimEvent & { tick: number }>;
  /** Your actions that were rejected since your previous update, with reasons. */
  rejected: Array<{ action: unknown; reason: string; tick: number }>;
}

/** Passed once to `initialize`. */
export interface MatchInfo {
  sdkVersion: string;
  engineVersion: string;
  team: TeamId;
  seed: number;
  players: Array<{ id: PlayerId; number: number; role: Role }>;
  pitch: { length: number; width: number; goalWidth: number; penaltyAreaDepth: number; penaltyAreaWidth: number };
  timing: { tickRate: number; decisionRate: number; halfDurationSec: number };
  /** Physical limits the engine enforces; use them to avoid rejected actions. */
  rules: {
    maxSpeed: number;
    sprintSpeed: number;
    sprintThreshold: number;
    kickRange: number;
    kickMaxAngleRad: number;
    minKickSpeed: number;
    maxKickSpeed: number;
    tackleReach: number;
    catchReach: number;
    restartDistance: number;
    restartTimeoutDecisions: number;
  };
}

export interface MatchResult {
  team: TeamId;
  score: { own: number; opponent: number; blue: number; red: number };
  outcome: "win" | "draw" | "loss";
  ticks: number;
}

// ───────────────────────────────── actions ─────────────────────────────────

/** `player` may be a full ID ("blue-4") or a shirt number (4). */
export type PlayerRef = PlayerId | number;
export type Vec = { x: number; y: number };

export type Action =
  /** Run toward a point (persistent until replaced). `dribble` keeps a loose ball ahead with small touches. */
  | { type: "moveTo"; player: PlayerRef; x: number; y: number; sprint?: boolean; dribble?: boolean }
  /** Stop moving. */
  | { type: "stop"; player: PlayerRef }
  /** Toggle sprint on the player's current movement target. */
  | { type: "sprint"; player: PlayerRef; on: boolean }
  /** Kick the ball: direction (any length, non-zero), power 0..1. */
  | { type: "kick"; player: PlayerRef; direction: Vec; power: number }
  | { type: "tackle"; player: PlayerRef }
  /** Goalkeeper only, inside own penalty area. */
  | { type: "catchBall"; player: PlayerRef }
  /** Goalkeeper holding the ball: throw it. */
  | { type: "releaseBall"; player: PlayerRef; direction: Vec; power: number };

export const ACTION_TYPES = ["moveTo", "stop", "sprint", "kick", "tackle", "catchBall", "releaseBall"] as const;

/**
 * Optional decision trace a controller may return alongside its actions
 * (SDK ≥ 1.1). Shown in the viewer; never affects the simulation.
 */
export interface ControllerDebug {
  /** Current tactical mode, e.g. "build-up", "press", "counter". */
  mode?: string;
  /** Short notes, e.g. "B4 → B5 pass (lane 3.1 m)". At most 6 are shown. */
  notes?: string[];
  /** Lines to draw on the pitch (pass targets, runs, press assignments). */
  lines?: Array<{ from: Vec; to: Vec; kind?: "pass" | "shot" | "run" | "press" | "cover" }>;
}

export const MAX_DEBUG_BYTES = 4096;

/** Validate/normalise a debug payload; returns null if absent or malformed. */
export function sanitizeDebug(d: unknown): ControllerDebug | null {
  if (typeof d !== "object" || d === null) return null;
  const o = d as Record<string, unknown>;
  const out: ControllerDebug = {};
  if (typeof o.mode === "string") out.mode = o.mode.slice(0, 40);
  if (Array.isArray(o.notes)) out.notes = o.notes.filter((n) => typeof n === "string").slice(0, 6).map((n) => (n as string).slice(0, 120));
  if (Array.isArray(o.lines)) {
    out.lines = o.lines
      .filter((l) => isVec((l as { from?: unknown })?.from) && isVec((l as { to?: unknown })?.to))
      .slice(0, 12)
      .map((l) => {
        const k = (l as { kind?: unknown }).kind;
        return { from: (l as { from: Vec }).from, to: (l as { to: Vec }).to, kind: (["pass", "shot", "run", "press", "cover"] as const).find((x) => x === k) ?? "run" };
      });
  }
  return out;
}

/** A controller as authored: plain object with lifecycle callbacks. */
export interface ControllerDefinition {
  name?: string;
  version?: string;
  initialize?(info: MatchInfo): void;
  update(obs: Observation): Action[] | { actions: Action[]; debug?: ControllerDebug } | void;
  onMatchEnd?(result: MatchResult): void;
}

// ─────────────────────────────── host side ────────────────────────────────

export interface DecisionContext {
  /** Physics tick at which the returned commands will be applied. */
  readonly tick: number;
  /** Read-only snapshot of the world before this decision tick (same for both teams). */
  readonly state: WorldState;
  /** Events logged since this source's previous decision. */
  readonly events?: readonly LoggedEvent[];
  /** Engine rejections of this source's commands since its previous decision. */
  readonly rejected?: ReadonlyArray<{ command: unknown; reason: string; tick: number }>;
}

/**
 * Host-side interface the runtime drives at 10 Hz. Sandboxed controllers and
 * built-in baselines both implement it. `team: "both"` is reserved for
 * debug/harness sources.
 */
export interface CommandSource {
  readonly name: string;
  readonly team: TeamId | "both";
  decide(ctx: DecisionContext): readonly EngineCommand[];
  onMatchEnd?(state: WorldState): void;
  dispose?(): void;
}

// ─────────────────────────── observation builder ──────────────────────────

const r6 = (v: number) => v; // values are passed through exactly (JSON keeps full double precision)

export function buildMatchInfo(state: WorldState, team: TeamId, cfg: SimConfig = DEFAULT_CONFIG): MatchInfo {
  const a = cfg.action;
  return {
    sdkVersion: SDK_VERSION,
    engineVersion: ENGINE_VERSION,
    team,
    seed: state.seed,
    players: state.players.filter((p) => p.team === team).map((p) => ({ id: p.id, number: p.number, role: p.role })),
    pitch: { length: cfg.pitch.length, width: cfg.pitch.width, goalWidth: cfg.pitch.goalWidth, penaltyAreaDepth: cfg.pitch.penaltyAreaDepth, penaltyAreaWidth: cfg.pitch.penaltyAreaWidth },
    timing: { tickRate: cfg.tickRate, decisionRate: cfg.controllerRate, halfDurationSec: cfg.halfDurationSec },
    rules: {
      maxSpeed: cfg.player.maxSpeed,
      sprintSpeed: cfg.player.sprintSpeed,
      sprintThreshold: cfg.player.sprintThreshold,
      kickRange: a.kickRange,
      kickMaxAngleRad: a.kickMaxAngle,
      minKickSpeed: a.minKickSpeed,
      maxKickSpeed: a.maxKickSpeed,
      tackleReach: a.tackleReach,
      catchReach: a.catchReach,
      restartDistance: cfg.match.restartDistance,
      restartTimeoutDecisions: Math.floor(cfg.match.restartTimeoutTicks / (cfg.tickRate / cfg.controllerRate)),
    },
  };
}

export function buildObservation(
  state: WorldState,
  team: TeamId,
  events: readonly LoggedEvent[] = [],
  rejected: ReadonlyArray<{ command: unknown; reason: string; tick: number; action?: unknown }> = [],
  cfg: SimConfig = DEFAULT_CONFIG,
): Observation {
  const m = state.match;
  const other: TeamId = team === "blue" ? "red" : "blue";
  const view = (p: WorldState["players"][number]): PlayerView => ({
    id: p.id,
    number: p.number,
    role: p.role,
    x: r6(p.x),
    y: r6(p.y),
    vx: p.vx,
    vy: p.vy,
    heading: p.heading,
    stamina: p.stamina,
    cooldowns: { touch: p.touchCooldown, tackle: p.tackleCooldown, catch: p.catchCooldown },
    stunned: p.stunned,
  });
  const perDecision = cfg.tickRate / cfg.controllerRate;
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    tick: state.tick,
    team,
    attackingDirection: attackSign(team, m),
    period: m.period,
    phase: m.phase,
    clock: {
      half: m.period === "preMatch" || m.period === "firstHalf" ? 1 : 2,
      secondsInHalf: m.period === "halftime" || m.period === "fullTime" ? cfg.halfDurationSec : m.halfTicks / cfg.tickRate,
      halfDurationSec: cfg.halfDurationSec,
    },
    score: { own: m.score[team], opponent: m.score[other], blue: m.score.blue, red: m.score.red },
    ball: { x: state.ball.x, y: state.ball.y, vx: state.ball.vx, vy: state.ball.vy, heldBy: state.ball.heldBy, lastTouch: state.ball.lastTouch },
    teammates: state.players
      .filter((p) => p.team === team)
      .map((p) => ({
        ...view(p),
        intent: { target: p.intent.targetX === null ? null : { x: p.intent.targetX, y: p.intent.targetY! }, sprint: p.intent.sprint, dribble: p.intent.dribble },
      })),
    opponents: state.players.filter((p) => p.team === other).map(view),
    restart: m.restart
      ? {
          type: m.restart.type,
          team: m.restart.team,
          ours: m.restart.team === team,
          x: m.restart.x,
          y: m.restart.y,
          taker: m.restart.taker,
          ready: state.tick >= m.restart.readyTick,
          decisionsUntilFallback: Math.max(0, Math.ceil((m.restart.deadlineTick - state.tick) / perDecision)),
        }
      : null,
    events: events.map((e) => ({ ...e.event, tick: e.tick })),
    rejected: rejected.map((r) => ({ action: r.action ?? r.command, reason: r.reason, tick: r.tick })),
  };
}

export function buildMatchResult(state: WorldState, team: TeamId): MatchResult {
  const other: TeamId = team === "blue" ? "red" : "blue";
  const own = state.match.score[team];
  const opp = state.match.score[other];
  return { team, score: { own, opponent: opp, blue: state.match.score.blue, red: state.match.score.red }, outcome: own > opp ? "win" : own < opp ? "loss" : "draw", ticks: state.tick };
}

// ──────────────────────────── action translation ───────────────────────────

export interface ActionRejection {
  action: unknown;
  reason: string;
}

export interface TranslatedActions {
  commands: EngineCommand[];
  rejected: ActionRejection[];
  /** For each emitted command, the index of the action it came from. */
  sourceIndex: number[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): v is Vec => typeof v === "object" && v !== null && finite((v as Vec).x) && finite((v as Vec).y);

const PLAYER_REF = /^(blue|red)-([1-9])$/;

/** Resolves a shirt number or ID to one of this team's players; anything else is a rejection reason. */
function resolvePlayer(ref: unknown, team: TeamId, teamSize: number): PlayerId | string {
  if (typeof ref === "number" && Number.isInteger(ref) && ref >= 1 && ref <= teamSize) return `${team}-${ref}` as PlayerId;
  const m = typeof ref === "string" ? PLAYER_REF.exec(ref) : null;
  if (m && Number(m[2]) <= teamSize) {
    if (m[1] !== team) return `not your player: ${ref}`;
    return ref as PlayerId;
  }
  return `invalid player reference: ${JSON.stringify(ref)}`;
}

/**
 * Validate controller output and translate it into engine commands for the
 * controller's own players only. Conflict rules:
 *  - movement (`moveTo`/`stop`): the last one per player wins;
 *  - `sprint` modifies the player's movement this update (or its current target);
 *  - at most one ball action (kick/tackle/catchBall/releaseBall) per player per update.
 * Engine-level legality (range, cooldowns, phase, taker…) is checked later by
 * the engine and reported back in `Observation.rejected`.
 */
export function translateActions(output: unknown, team: TeamId, state: WorldState): TranslatedActions {
  const rejected: ActionRejection[] = [];
  let list: unknown[];
  if (output === undefined || output === null) list = [];
  else if (Array.isArray(output)) list = output;
  else if (typeof output === "object" && Array.isArray((output as { actions?: unknown }).actions)) list = (output as { actions: unknown[] }).actions;
  else return { commands: [], rejected: [{ action: output, reason: "update must return an array of actions (or { actions: [...] })" }], sourceIndex: [] };

  if (list.length > MAX_ACTIONS_PER_UPDATE) {
    for (const a of list.slice(MAX_ACTIONS_PER_UPDATE)) rejected.push({ action: a, reason: `too many actions (max ${MAX_ACTIONS_PER_UPDATE} per update)` });
    list = list.slice(0, MAX_ACTIONS_PER_UPDATE);
  }

  const teamSize = state.players.filter((p) => p.team === team).length;
  const movement = new Map<PlayerId, { cmd: EngineCommand; i: number }>();
  const sprintMod = new Map<PlayerId, boolean>();
  const ball = new Map<PlayerId, { cmd: EngineCommand; i: number }>();

  list.forEach((a, i) => {
    if (typeof a !== "object" || a === null) return rejected.push({ action: a, reason: "action must be an object" });
    const act = a as Record<string, unknown>;
    if (!ACTION_TYPES.includes(act.type as (typeof ACTION_TYPES)[number])) return rejected.push({ action: a, reason: `unknown action type: ${String(act.type)}` });
    const pid = resolvePlayer(act.player, team, teamSize);
    if (!PLAYER_REF.test(pid)) return rejected.push({ action: a, reason: pid });
    const id = pid as PlayerId;
    const ballAction = (cmd: EngineCommand) => {
      if (ball.has(id)) return rejected.push({ action: a, reason: `only one ball action per player per update (${id})` });
      ball.set(id, { cmd, i });
    };
    switch (act.type) {
      case "moveTo":
        if (!finite(act.x) || !finite(act.y)) return rejected.push({ action: a, reason: "moveTo needs finite x and y" });
        if (act.sprint !== undefined && typeof act.sprint !== "boolean") return rejected.push({ action: a, reason: "sprint must be boolean" });
        if (act.dribble !== undefined && typeof act.dribble !== "boolean") return rejected.push({ action: a, reason: "dribble must be boolean" });
        movement.set(id, { cmd: { type: "moveTo", playerId: id, x: act.x, y: act.y, sprint: (act.sprint as boolean) ?? false, dribble: (act.dribble as boolean) ?? false }, i });
        return;
      case "stop":
        movement.set(id, { cmd: { type: "stop", playerId: id }, i });
        return;
      case "sprint":
        if (typeof act.on !== "boolean") return rejected.push({ action: a, reason: "sprint needs on: boolean" });
        sprintMod.set(id, act.on);
        return;
      case "kick":
      case "releaseBall": {
        if (!isVec(act.direction) || (act.direction.x === 0 && act.direction.y === 0)) return rejected.push({ action: a, reason: `${act.type} needs a non-zero finite direction {x, y}` });
        if (!finite(act.power) || act.power < 0 || act.power > 1) return rejected.push({ action: a, reason: "power must be a number in [0, 1]" });
        const type = act.type === "kick" ? "kick" : "release";
        return ballAction({ type, playerId: id, dirX: act.direction.x, dirY: act.direction.y, power: act.power });
      }
      case "tackle":
        return ballAction({ type: "tackle", playerId: id });
      case "catchBall":
        return ballAction({ type: "catch", playerId: id });
    }
  });

  // Apply sprint modifiers to this update's movement, or to the current target.
  for (const [id, on] of sprintMod) {
    const mv = movement.get(id);
    if (mv && mv.cmd.type === "moveTo") movement.set(id, { cmd: { ...mv.cmd, sprint: on }, i: mv.i });
    else {
      const p = state.players.find((q) => q.id === id)!;
      if (p.intent.targetX === null) {
        rejected.push({ action: { type: "sprint", player: id, on }, reason: "sprint has no effect: player has no movement target" });
        continue;
      }
      movement.set(id, { cmd: { type: "moveTo", playerId: id, x: p.intent.targetX, y: p.intent.targetY!, sprint: on, dribble: p.intent.dribble }, i: -1 });
    }
  }

  const commands: EngineCommand[] = [];
  const sourceIndex: number[] = [];
  for (const [, v] of movement) {
    commands.push(v.cmd);
    sourceIndex.push(v.i);
  }
  for (const [, v] of ball) {
    commands.push(v.cmd);
    sourceIndex.push(v.i);
  }
  return { commands, rejected, sourceIndex };
}
