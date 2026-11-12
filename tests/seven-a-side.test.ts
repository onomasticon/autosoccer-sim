import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translateActions } from "@autosoccer/controller-sdk";
import { runSeriesMatch } from "@autosoccer/match-runner";
import { createWorld, DEFAULT_CONFIG, makeConfig, SEVEN_A_SIDE } from "@autosoccer/sim-core";
import { ReplayPlayer } from "@autosoccer/telemetry";

const ex = (p: string) => readFileSync(new URL(`../examples/controllers/${p}`, import.meta.url), "utf8");
const cfg7 = makeConfig(SEVEN_A_SIDE);

describe("7-a-side", () => {
  it("is opt-in: the default stays 5v5 and other sizes are rejected", () => {
    expect(DEFAULT_CONFIG.playersPerTeam).toBe(5);
    expect(createWorld(1).players).toHaveLength(10);
    expect(() => makeConfig({ playersPerTeam: 6 })).toThrow(/playersPerTeam/);
  });

  it("creates seven players a side, in their own half and outside the centre circle", () => {
    const w = createWorld(9, cfg7);
    expect(w.players).toHaveLength(14);
    for (const team of ["blue", "red"] as const) {
      const mine = w.players.filter((p) => p.team === team);
      expect(mine.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(mine.filter((p) => p.role === "GK")).toHaveLength(1);
      for (const p of mine) {
        expect(team === "blue" ? p.x < 0 : p.x > 0).toBe(true);
        expect(Math.hypot(p.x, p.y)).toBeGreaterThan(cfg7.pitch.centreCircleRadius);
        expect(Math.abs(p.x)).toBeLessThan(cfg7.pitch.length / 2);
        expect(Math.abs(p.y)).toBeLessThan(cfg7.pitch.width / 2);
      }
    }
  });

  it("lets controllers address shirt numbers up to the team size, and no further", () => {
    const w7 = createWorld(1, cfg7);
    const ok = translateActions([{ type: "moveTo", player: 7, x: 0, y: 0 }, { type: "stop", player: "blue-6" }], "blue", w7);
    expect(ok.rejected).toEqual([]);
    expect(ok.commands.map((c) => ("playerId" in c ? c.playerId : null))).toEqual(["blue-7", "blue-6"]);
    const w5 = createWorld(1);
    const bad = translateActions([{ type: "moveTo", player: 6, x: 0, y: 0 }, { type: "stop", player: "blue-7" }], "blue", w5);
    expect(bad.commands).toEqual([]);
    expect(bad.rejected).toHaveLength(2);
  });

  it("plays sandboxed controllers to full time with no failures or invariant violations, and the replay verifies", async () => {
    for (const seed of [1, 2]) {
      const { summary, replay } = await runSeriesMatch(seed, {
        blue: { label: "zonal", source: ex("zonal.js") },
        red: { label: "chaser", source: ex("chaser.js") },
        config: { ...SEVEN_A_SIDE, halfDurationSec: 45 },
        replayEvery: 1,
        determinismEvery: 1,
        checkInvariants: true,
      });
      expect(summary.finished).toBe(true);
      expect(summary.failures).toEqual([]);
      expect(summary.invariantViolations).toEqual([]);
      expect(summary.deterministic).toBe(true);
      expect(summary.replayVerified).toBe(true);
      expect(replay!.config.playersPerTeam).toBe(7);
      // Every player takes part: no engine rejections, and shirts 6 and 7 leave their kickoff spots.
      expect(replay!.engineRejections.filter((r) => /invalid playerId|unknown player/.test(r.reason))).toEqual([]);
      const start = createWorld(seed, makeConfig({ ...SEVEN_A_SIDE, halfDurationSec: 45 }));
      const end = replay!.snapshots.at(-1)!.state;
      for (const id of ["blue-6", "blue-7", "red-6", "red-7"]) {
        const a = start.players.find((p) => p.id === id)!;
        const b = end.players.find((p) => p.id === id)!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1);
      }
      expect(new ReplayPlayer(JSON.parse(JSON.stringify(replay))).verify().ok).toBe(true);
    }
  }, 60_000);

  it("gives the SDK helpers the 7-a-side pitch", async () => {
    const probe = `
      let seen = null;
      defineController({
        name: "pitch-probe",
        initialize() {},
        update(obs) {
          if (!seen) seen = { goal: Soccer.oppGoal(obs).x * obs.attackingDirection, shot: Soccer.shotTarget(obs).y, pitch: Soccer.pitch.length };
          return { actions: [], debug: { mode: "probe", notes: [JSON.stringify(seen)] } };
        },
      });`;
    const { replay } = await runSeriesMatch(3, {
      blue: { label: "probe", source: probe },
      red: { label: "zonal", source: ex("zonal.js") },
      config: { ...SEVEN_A_SIDE, halfDurationSec: 5 },
      replayEvery: 1,
    });
    const note = replay!.decisions.find((d) => d.team === "blue" && d.notes.length)!.notes[0]!;
    expect(JSON.parse(note)).toEqual({ goal: 30, shot: expect.closeTo(1.9, 6), pitch: 60 });
  }, 30_000);
});
