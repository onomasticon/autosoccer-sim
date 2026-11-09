# Architecture (M6)

```
            ┌────────────────────┐        ┌──────────────────────┐
 debug /    │ controller-runtime │ submit │  sim-core Simulation  │  step() — pure, 60 Hz
 scripts ──▶│  CommandRunner     │───────▶│  queue → 10 Hz tick   │──────────▶ WorldState
 keyboard   │  (error isolation) │        │  command log, hashes  │
            └────────────────────┘        └──────────┬───────────┘
                                                     │ same class
                         ┌───────────────────────────┼────────────────────────┐
                         ▼                                                     ▼
               match-runner (headless CLI)                         apps/viewer (React + PixiJS)
               + telemetry JSONL                                   renders state, never writes it
```

## Contracts

- **`step(state, commands, config) → { state, rejected }`** is pure. It never mutates its input
  (tests deep-freeze the input). Commands are validated, then applied in stable player-ID order
  (last one wins per player), so the order commands arrive in for different players doesn't matter.
- **`Simulation`** queues `submit()`ed commands and applies them only on decision ticks
  (`tick % (tickRate / controllerRate) === 0`, i.e. every 6th tick). It records accepted commands
  as `CommandLogEntry { tick, commands }`. That log is the full input stream:
  `Simulation.replay(seed, log, toTick)` reproduces the state without any script or keyboard.
- **`hashState(state)`** is a 64-bit FNV-1a-style hash over the exact IEEE-754 bits of all state.
- **`step` order of operations:** commands → cooldowns → phase permissions → one-shot actions
  (arbitrated) → restart taken? → player movement, collisions and restart distances → automatic
  touches (open play only) → locked, held or free ball → `updateMatch` (timers, clock, goal, fouls,
  out of play, restart fallbacks). The match logic lives in `sim-core/src/match.ts`. Each tick's `SimEvent`s are in `state.events`. `Simulation.events` logs them with tick and
  ball position, and `Simulation.rejections` logs rejected commands with reasons.
- **Scenario harness:** `controller-runtime/src/scenarios.ts` holds scripted command sources (debug
  placement, then ordinary commands at given times or conditions). The viewer, tests and walkthrough
  all use the same scenarios.
- **Baseline controllers** (`controller-runtime/src/restarts.ts`): `restartCommands` and
  `approachAndKick` helpers, plus safe, idle and chaos controllers used by `bun run soak`
  (`match-runner/src/soak.ts`).
- **Controllers (M4):** `controller-sdk` builds team-relative JSON observations and validates and
  translates actions (SDK 1.0). `controller-runtime/src/sandbox.ts` runs each script in its own
  QuickJS/WASM runtime with memory and deterministic CPU limits, failure diagnostics and a safe
  fallback. `CommandRunner` gives every source the same pre-decision state plus its events and
  engine rejections since its previous decision. It drops any team-source command for the other
  team's players or of a debug type, and calls `onMatchEnd` at full time.
- **Versioning:** `ENGINE_VERSION` is `0.3.0` (unchanged in M4).
  `SDK_VERSION` is `1.1.0` (adds the `Soccer` helpers and the optional `debug` trace), with observation and action schemas still at `1.0`.
- **Featured controllers (M5):** `examples/controllers/blue-possession.js` and `red-counter.js` (see `docs/tactics.md`). Statistics and profiles live in `match-runner/src/stats.ts`, the batch runner is `bun run bvr`, and `scripts/api-coverage.ts` writes `docs/api-coverage.md`.

## Determinism

1. All randomness comes from the seeded sfc32 PRNG (`prng.ts`), whose state is part of `WorldState`.
2. Fixed timestep; no wall-clock input to the engine. The viewer uses an accumulator to decide *how
   many* ticks to run per frame, never *how long* a tick is.
3. Stable iteration and collision order (players in ID order, pairs `i < j`).
4. **Deterministic math** (`dmath.ts`). `Math.sin/cos/atan2/hypot` aren't correctly rounded and
   differ between V8 (Node/Chrome) and JavaScriptCore (Bun). Using them gave three different hashes
   for the same run on Bun, Node and Chrome. sim-core and command sources use `dsin/dcos/datan2/dhypot`,
   built only from `+ − × ÷ sqrt`, which IEEE-754 requires to be exact. `tests/golden.json` holds
   hashes generated under Bun; Vitest checks them under Node, and the walkthrough checks them in Chrome.

## Replays (M6)

`telemetry/src/replay.ts` defines the replay file format (v1), `ReplayRecorder` (snapshots every
600 ticks, hashes every 60) and `ReplayPlayer` (seek and verify). `match-runner/src/record.ts`
turns a run plus its sandboxed controllers into a replay. The viewer records every live run and
plays replays through the same `PitchView`, controller inspector, action log and timeline;
replay mode never executes controllers. See [replays.md](replays.md).
