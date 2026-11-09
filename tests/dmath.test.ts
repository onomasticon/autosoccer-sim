import { describe, expect, it } from "vitest";
import { datan2, dcos, dhypot, dsin, dwrap, Rng } from "@autosoccer/sim-core";

describe("deterministic math", () => {
  const rng = new Rng(2024);
  const xs = Array.from({ length: 5000 }, () => rng.range(-50, 50));

  it("dsin/dcos match Math within 1e-9", () => {
    for (const x of xs) {
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });

  it("datan2 matches Math.atan2 within 1e-9 in every quadrant and on axes", () => {
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const [y, x] = [xs[i]!, xs[i + 1]!];
      expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-9);
    }
    for (const [y, x] of [[0, 1], [1, 0], [0, -1], [-1, 0], [0, 0], [1, 1], [-1, -1], [1e-300, -1]]) {
      expect(Math.abs(datan2(y!, x!) - Math.atan2(y!, x!))).toBeLessThan(1e-9);
    }
  });

  it("dhypot and dwrap behave", () => {
    expect(dhypot(3, 4)).toBe(5);
    for (const x of xs) {
      const w = dwrap(x);
      expect(w).toBeGreaterThan(-Math.PI - 1e-12);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(Math.sin(w) - Math.sin(x))).toBeLessThan(1e-9);
    }
  });
});
