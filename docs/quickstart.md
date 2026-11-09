# Quickstart

## Install

Requires **Bun 1.2.19** (pinned in `.bun-version`) and Node ≥ 20 (used by Vitest and Playwright).

```sh
git clone https://github.com/onomasticon/autosoccer-sim && cd autosoccer-sim
bun install
```

## One-command demos

```sh
bun run demo          # opens the viewer and plays Blue (possession) vs Red (counterattack) live at 4×
bun run demo:replay   # opens the viewer on the bundled sample replay (examples/replays/)
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Viewer at http://127.0.0.1:5173. Modes: Controllers (two sandboxed scripts), Playground, Manual, Scenarios, Replay. |
| `bun run match --blue A.js --red B.js [--seed 42] [--verify] [--log] [--record m.replay.json.gz]` | One headless match between two controller scripts. |
| `bun run replay m.replay.json.gz [--timeline] [--at goal:1] [--verify]` | Inspect, seek or verify a replay without running controllers. |
| `bun run tournament --matches 1000 [--workers 6]` | Seeded Blue vs Red series across parallel workers. Writes `out/tournament/summary.md`, `summary.json`, `results.jsonl` and `replays/`. |
| `bun run tournament --round-robin a.js b.js c.js` | Round-robin table between controllers. |
| `bun run bench [--write]` | Throughput benchmark; `--write` updates `docs/performance.md`. |
| `bun run test` | All tests (Vitest on Node) plus golden hashes on Bun. |
| `bun run soak --matches 1000` | Engine-level soak with safe, idle and chaos controllers under both clock policies. |
| `bun run coverage:api` | Regenerates `docs/api-coverage.md`, mapping every API action, callback, field and event to examples and tests. |
| `bun run walkthrough` | Re-records the release video and screenshots; needs `bun run dev` running. |

## Write your first controller

Follow [writing-a-controller.md](writing-a-controller.md). It's a tested tutorial. The full API is
in [controller-sdk.md](controller-sdk.md), and the game rules are in
[simulation.md](simulation.md).

## Where things live

| Path | Contents |
| --- | --- |
| `packages/sim-core` | Deterministic engine: physics, actions, match rules, hashing, invariants. |
| `packages/controller-sdk` | Public API: observations, actions, validation, `Soccer` helpers. |
| `packages/controller-runtime` | QuickJS/WASM sandbox, baseline controllers, scenarios. |
| `packages/match-runner` | CLIs: match, replay, tournament, bench, soak. Also stats and replay building. |
| `packages/telemetry` | Replay format, recorder, player and verification. |
| `apps/viewer` | React + PixiJS viewer. |
| `examples/controllers` | Featured teams, baselines, tutorial-style examples and adversarial scripts. |
| `docs/` | Architecture, rules, SDK, tactics, replays, performance, troubleshooting. |
