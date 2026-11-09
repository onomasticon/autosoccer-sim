import type { PlayerId } from "./types.ts";

/**
 * Engine-level movement commands (M1). These are the only inputs the
 * simulation accepts. Higher-level controller actions (kick, tackle, …)
 * arrive in later milestones.
 */
export type EngineCommand =
  | { readonly type: "moveTo"; readonly playerId: PlayerId; readonly x: number; readonly y: number; readonly sprint?: boolean }
  | { readonly type: "stop"; readonly playerId: PlayerId };

export interface CommandRejection {
  readonly command: unknown;
  readonly reason: string;
}

const PLAYER_ID_RE = /^(blue|red)-[1-5]$/;

export function isPlayerId(v: unknown): v is PlayerId {
  return typeof v === "string" && PLAYER_ID_RE.test(v);
}

/** Structural validation; returns a rejection reason or null if valid. */
export function validateCommand(cmd: unknown): string | null {
  if (typeof cmd !== "object" || cmd === null) return "command must be an object";
  const c = cmd as Record<string, unknown>;
  if (!isPlayerId(c.playerId)) return "invalid playerId";
  switch (c.type) {
    case "moveTo":
      if (typeof c.x !== "number" || !Number.isFinite(c.x)) return "x must be a finite number";
      if (typeof c.y !== "number" || !Number.isFinite(c.y)) return "y must be a finite number";
      if (c.sprint !== undefined && typeof c.sprint !== "boolean") return "sprint must be boolean";
      return null;
    case "stop":
      return null;
    default:
      return `unknown command type ${String(c.type)}`;
  }
}
