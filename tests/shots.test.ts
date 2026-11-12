import { describe, expect, it } from "vitest";
import { analyzeMatch, goalCredit, shotOutcome } from "@autosoccer/match-runner";
import type { LoggedEvent, SimEvent } from "@autosoccer/sim-core";

const ev = (tick: number, event: SimEvent, ballX = 15, ballY = 0): LoggedEvent => ({ tick, event, ballX, ballY });
// Blue attacks +x in the first half; the red goal line is x = 25 in 5-a-side.
const shot = (tick: number, playerId = "blue-5", dirY = 0): LoggedEvent =>
  ev(tick, { type: "kick", playerId, power: 1, speed: 24, dirX: 1, dirY, errorRad: 0 } as SimEvent);
const goal = (tick: number, scorer: string, ownGoal: boolean): LoggedEvent =>
  ev(tick, { type: "goalScored", team: "blue", scorer, ownGoal, score: { blue: 1, red: 0 } } as SimEvent);

describe("shot outcomes", () => {
  it("a goal or a keeper's touch is on target; a defender's touch is a block; going out is a miss", () => {
    expect(shotOutcome([shot(10), goal(40, "blue-5", false)], 0)).toBe("goal");
    expect(shotOutcome([shot(10), ev(30, { type: "catch", playerId: "red-1", success: true, incomingSpeed: 20 } as SimEvent)], 0)).toBe("saved");
    expect(shotOutcome([shot(10), ev(30, { type: "catch", playerId: "red-1", success: false, incomingSpeed: 20 } as SimEvent)], 0)).toBe("saved");
    expect(shotOutcome([shot(10), ev(25, { type: "trap", playerId: "red-3", interception: true, incomingSpeed: 20 } as SimEvent)], 0)).toBe("blocked");
    expect(shotOutcome([shot(10), ev(50, { type: "ballOut", line: "goalLine", x: 25.2, y: 3, lastTouch: "blue-5" } as SimEvent)], 0)).toBe("off");
  });

  it("counts on-target shots from outcomes, so a blocked or missed shot is not on target", () => {
    const events = [
      shot(10),
      ev(20, { type: "trap", playerId: "red-2", interception: true, incomingSpeed: 20 } as SimEvent),
      shot(400, "blue-4", 0.1),
      ev(430, { type: "ballOut", line: "goalLine", x: 25.2, y: 3, lastTouch: "blue-4" } as SimEvent),
      shot(900),
      goal(930, "blue-5", false),
    ];
    const s = analyzeMatch(events, []);
    expect(s.blue.shots).toBe(3);
    expect(s.blue.shotsOnTarget).toBe(1);
  });
});

describe("goal credit", () => {
  it("credits the shooter when the keeper or a defender only deflects it in", () => {
    const events = [shot(10), ev(30, { type: "catch", playerId: "red-1", success: false, incomingSpeed: 20 } as SimEvent), goal(45, "red-1", true)];
    expect(goalCredit(events, 2)).toEqual({ scorer: "blue-5", ownGoal: false });
  });
  it("keeps a real own goal: the defender kicked it in", () => {
    const events = [shot(10), ev(30, { type: "kick", playerId: "red-2", power: 0.6, speed: 15, dirX: 1, dirY: 0, errorRad: 0 } as SimEvent), goal(60, "red-2", true)];
    expect(goalCredit(events, 2)).toEqual({ scorer: "red-2", ownGoal: true });
  });
  it("leaves ordinary goals alone", () => {
    expect(goalCredit([shot(10), goal(40, "blue-5", false)], 1)).toEqual({ scorer: "blue-5", ownGoal: false });
  });
});
