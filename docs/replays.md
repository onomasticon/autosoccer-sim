# Replays and the viewer timeline (M6)

## What a replay contains (`format: "autosoccer-replay"`, version 1)

| Field | Purpose |
| --- | --- |
| `engineVersion`, `sdkVersion`, `runtime`, `seed`, `config` | Everything needed to rebuild the world. A replay is refused if the engine version differs. |
| `controllers.{blue,red}` | `name`, `version`, file `label` and an FNV-1a `sourceHash` of the exact script. |
| `commands` | The **validated command stream** the engine accepted, by decision tick. This alone reproduces the match. |
| `engineRejections` | Commands the engine refused, with tick and reason (issued but not executed). |
| `events` | Every engine event, with its tick and the ball position. |
| `decisions` | Per team and decision: issued actions, SDK-validation rejections, status, `mode`, `notes` and decision `lines`. |
| `diagnostics` | Controller diagnostics: errors, timeouts, disables, logs. |
| `snapshots` | A full `WorldState` every 600 ticks (10 s), used for fast seeking. |
| `hashes` | The state hash every 60 ticks, plus initial and final hashes, used for verification. |

A full Blue vs Red match is about 5 MB of JSON.

## Seeking and verification

`ReplayPlayer.seek(t)` loads the nearest snapshot at or before `t` and steps the engine forward
with the recorded commands. It takes milliseconds, and **no controller runs**.
`ReplayPlayer.verify()` re-simulates the whole match from the seed and compares every recorded
hash. A tampered command shows up as a mismatch (tested).

## Viewer

- **Live** (Controllers mode): every run is recorded. **💾 Save replay** downloads it.
- **📂 Load replay** switches to replay mode:
  - The same renderer, overlays, decision lines, controller inspector and event log as live play.
  - The **timeline** shows half-time, goals (gold), fouls, restarts, keeper catches and tackles,
    plus the playhead. Click the track or a chip, or drag the slider, to seek.
  - **Verify replay hashes** re-simulates the whole match in the browser.
- **Issued vs executed** (inspector, for the selected player): what the controller **ISSUED**,
  what SDK validation rejected (**INVALID**), what the engine **REJECTED**, and what actually
  **EXECUTED** (engine events). It works the same live and in replays.
- **Playback:** 0.25×–8×, pause and single-tick step, and **Fit to window**. Goal rings and a
  ball trail are shown.

## CLI

```sh
bun run match --blue examples/controllers/blue-possession.js --red examples/controllers/red-counter.js --seed 42 --record out/m.replay.json
bun run replay out/m.replay.json --timeline           # periods, goals, fouls, restarts
bun run replay out/m.replay.json --at goal:1          # seek to the first goal (also restart:N, foul:N, or a tick)
bun run replay out/m.replay.json --verify             # every hash checkpoint, without running controllers
bun run tournament --matches 2 a.js b.js c.js         # round-robin table
```
