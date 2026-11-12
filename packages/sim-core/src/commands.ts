import type { Period, Phase, PlayerId } from "./types.ts";

/**
 * Engine-level commands. Movement (`moveTo`, `stop`) sets a persistent intent;
 * actions (`kick`, `tackle`, `catch`, `release`) are one-shot attempts that the
 * engine validates against physical constraints and either executes or rejects
 * with a reason. `debugPlace*` commands exist for the playground/test harness
 * only and will not be exposed to sandboxed controllers (M4).
 */
export type EngineCommand =
  | { readonly type: "moveTo"; readonly playerId: PlayerId; readonly x: number; readonly y: number; readonly sprint?: boolean; readonly dribble?: boolean }
  | { readonly type: "stop"; readonly playerId: PlayerId }
  /** Direction need not be normalised; power in [0, 1]. */
  | { readonly type: "kick"; readonly playerId: PlayerId; readonly dirX: number; readonly dirY: number; readonly power: number }
  | { readonly type: "tackle"; readonly playerId: PlayerId }
  | { readonly type: "catch"; readonly playerId: PlayerId }
  | { readonly type: "release"; readonly playerId: PlayerId; readonly dirX: number; readonly dirY: number; readonly power: number }
  | { readonly type: "debugPlaceBall"; readonly x: number; readonly y: number; readonly vx?: number; readonly vy?: number }
  | { readonly type: "debugPlacePlayer"; readonly playerId: PlayerId; readonly x: number; readonly y: number; readonly heading?: number; readonly stamina?: number }
  /** Force match flow for demos/tests (e.g. jump to open play or to near the end of a half). */
  | { readonly type: "debugSetMatch"; readonly period?: Period; readonly phase?: Phase; readonly halfTicks?: number; readonly score?: { readonly blue: number; readonly red: number } };

export type ActionCommand = Extract<EngineCommand, { type: "kick" | "tackle" | "catch" | "release" }>;
export type DebugCommand = Extract<EngineCommand, { type: "debugPlaceBall" | "debugPlacePlayer" | "debugSetMatch" }>;

export interface CommandRejection {
  readonly command: unknown;
  readonly reason: string;
}

// Any shirt 1–9; whether the player exists in this match (5- or 7-a-side) is checked when the command is applied.
const PLAYER_ID_RE = /^(blue|red)-[1-9]$/;

export function isPlayerId(v: unknown): v is PlayerId {
  return typeof v === "string" && PLAYER_ID_RE.test(v);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Structural validation; returns a rejection reason or null if valid. */
export function validateCommand(cmd: unknown): string | null {
  if (typeof cmd !== "object" || cmd === null) return "command must be an object";
  const c = cmd as Record<string, unknown>;
  if (c.type === "debugPlaceBall") {
    if (!finite(c.x) || !finite(c.y)) return "x/y must be finite numbers";
    if ((c.vx !== undefined && !finite(c.vx)) || (c.vy !== undefined && !finite(c.vy))) return "vx/vy must be finite numbers";
    return null;
  }
  if (c.type === "debugSetMatch") {
    if (c.period !== undefined && !["preMatch", "firstHalf", "halftime", "secondHalf", "fullTime"].includes(c.period as string)) return "invalid period";
    if (c.phase !== undefined && !["stopped", "openPlay"].includes(c.phase as string)) return "debugSetMatch phase must be stopped or openPlay";
    if (c.halfTicks !== undefined && (!finite(c.halfTicks) || c.halfTicks < 0)) return "halfTicks must be ≥ 0";
    return null;
  }
  if (!isPlayerId(c.playerId)) return "invalid playerId";
  switch (c.type) {
    case "moveTo":
      if (!finite(c.x)) return "x must be a finite number";
      if (!finite(c.y)) return "y must be a finite number";
      if (c.sprint !== undefined && typeof c.sprint !== "boolean") return "sprint must be boolean";
      if (c.dribble !== undefined && typeof c.dribble !== "boolean") return "dribble must be boolean";
      return null;
    case "stop":
    case "tackle":
    case "catch":
      return null;
    case "kick":
    case "release":
      if (!finite(c.dirX) || !finite(c.dirY)) return "dirX/dirY must be finite numbers";
      if (c.dirX === 0 && c.dirY === 0) return "direction must be non-zero";
      if (!finite(c.power) || c.power < 0 || c.power > 1) return "power must be in [0, 1]";
      return null;
    case "debugPlacePlayer":
      if (!finite(c.x) || !finite(c.y)) return "x/y must be finite numbers";
      if (c.heading !== undefined && !finite(c.heading)) return "heading must be finite";
      if (c.stamina !== undefined && (!finite(c.stamina) || c.stamina < 0 || c.stamina > 1)) return "stamina must be in [0, 1]";
      return null;
    default:
      return `unknown command type ${String(c.type)}`;
  }
}

export function isActionCommand(c: EngineCommand): c is ActionCommand {
  return c.type === "kick" || c.type === "tackle" || c.type === "catch" || c.type === "release";
}
export function isDebugCommand(c: EngineCommand): c is DebugCommand {
  return c.type === "debugPlaceBall" || c.type === "debugPlacePlayer" || c.type === "debugSetMatch";
}
