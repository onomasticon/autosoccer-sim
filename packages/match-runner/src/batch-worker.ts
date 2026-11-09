#!/usr/bin/env bun
/**
 * Worker process for `bun run tournament`: runs the seeds it is given and
 * prints one JSON line per match ({summary}); writes replays to --out.
 *   bun batch-worker.ts <spec.json> <seed> [<seed> …]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { runSeriesMatch, type SeriesSpec } from "./batch.ts";

const [specPath, ...seedArgs] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath!, "utf8")) as SeriesSpec & { outDir: string };
for (const s of seedArgs) {
  const seed = Number(s);
  const { summary, replay } = await runSeriesMatch(seed, spec);
  if (replay) {
    const dir = join(spec.outDir, "replays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `seed-${seed}.replay.json.gz`), gzipSync(JSON.stringify(replay)));
  }
  process.stdout.write(JSON.stringify(summary) + "\n");
}
