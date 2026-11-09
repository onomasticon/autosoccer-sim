# autosoccer-sim

Deterministic 5v5 2D soccer simulation with scriptable team controllers.
Headless TypeScript engine, Bun workspace, React + PixiJS viewer.

> **Status: M5**: Blue possession vs Red counterattack, two complete, tactically distinct sandboxed controllers (on top of M1–M4).
> Roadmap: see the milestone issues (M1–M7).

![viewer](docs/media/m5/02-blue-passing.png)

## Quickstart

Requires **Bun 1.2.19** (pinned in `.bun-version` / `packageManager`). Node ≥ 20 is used by Vitest and Playwright.

```sh
bun install
bun run demo                      # one command: viewer opens and plays Blue vs Red at 4×
bun run dev                       # viewer at http://127.0.0.1:5173/?seed=42
bun run headless --seed 42 --verify --out out/run-42.jsonl
bun run test                      # Vitest (Node/V8) + golden hashes under Bun/JSC
bun run soak --matches 1000       # 1,000 seeded full matches: must all reach full time
bun run match --blue examples/controllers/blue-possession.js --red examples/controllers/red-counter.js --verify
bun run bvr --matches 100         # 100 seeded Blue vs Red matches + action profiles
bun run coverage:api              # regenerates docs/api-coverage.md
bun run typecheck
```

Viewer controls: **Space** play/pause · **.** single step · click a player to inspect (shows its
kick/tackle/catch ranges) · **Run scenario** plays a scripted demo of one action (pass, dribble,
interception, tackle, shot/goal, keeper catch & release, rejected kicks, rejected catches) ·
**Manual** mode: **WASD/arrows** move the selected player, **Shift** sprint, **E** toggle dribble,
**J** kick (Shift = hard), **K** tackle, **L** catch/release · **Verify determinism** replays the
recorded command stream and compares state hashes. The event log shows executed actions and
rejected commands with reasons.

## Writing a controller

```js
defineController({
  name: "my-team",
  update(obs) {
    return obs.teammates.map((p) => ({ type: "moveTo", player: p.id, x: obs.ball.x, y: obs.ball.y }));
  },
});
```

See [docs/controller-sdk.md](docs/controller-sdk.md), [docs/tactics.md](docs/tactics.md) and `examples/controllers/`.

## Layout

| Package | Purpose |
| --- | --- |
| `packages/sim-core` | Pure deterministic engine: config, seeded PRNG, deterministic math, world state, `step`, state hash, `Simulation` driver. No DOM/timers/`Math.random`. |
| `packages/controller-sdk` | **Public, versioned controller API** (SDK 1.0): observation/action schemas, validation and translation. See [docs/controller-sdk.md](docs/controller-sdk.md). |
| `packages/controller-runtime` | Runs controllers at 10 Hz: the **QuickJS/WASM sandbox** for untrusted scripts, baseline (safe/idle/chaos) controllers, scenarios, playground, keyboard. |
| `packages/match-runner` | Headless runner + CLI (`bun run headless`). |
| `packages/telemetry` | Run metadata, hash checkpoints, command stream → JSONL. |
| `apps/viewer` | React + PixiJS viewer; uses the same `Simulation` class as the headless runner. |
| `tests/` | Vitest suites + cross-runtime golden hashes (`tests/golden.json`). |

See [docs/architecture.md](docs/architecture.md) and [docs/simulation.md](docs/simulation.md).

## Walkthrough recording

`bun run dev` in one terminal, then `bun run walkthrough` records `docs/media/m5/walkthrough.mp4`,
a GIF preview and screenshots by driving the real viewer with Playwright (`walkthrough:m1` to
`walkthrough:m4` re-record earlier milestones). The script fails if an expected scenario event/rejection is missing or if
browser and headless hashes differ.
