# Architecture (M1)

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
- **Versioning:** `ENGINE_VERSION` (sim-core) and `SDK_VERSION` (controller-sdk) are `0.1.0`. The
  M1 command schema (`moveTo`, `stop`) is internal/debug; the public controller action schema is M4.

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
