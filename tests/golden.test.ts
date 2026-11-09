import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeGolden } from "../scripts/golden.ts";

describe("cross-runtime golden hashes", () => {
  it("Node/V8 reproduces the hashes recorded under Bun/JavaScriptCore", async () => {
    const want = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
    expect(await computeGolden()).toEqual(want);
  });
});
