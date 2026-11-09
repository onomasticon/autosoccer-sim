# Controller SDK reference (v1.0)

`SDK_VERSION 1.0.0` · observation schema `1.0` · action schema `1.0` · engine `0.3.0`

A controller is a plain JavaScript file that drives one team's five players through this API. It
runs in a sandbox. Everything it sees is JSON built from the world state, and everything it returns
is validated before the engine executes it.

```js
defineController({
  name: "my-team",        // optional, shown in the viewer
  version: "1.0.0",       // optional
  initialize(info) {},    // once, before the first update
  update(obs) { return [ /* actions */ ]; },  // 10 times per simulated second
  onMatchEnd(result) {},  // once, at full time
});
```

Run a headless match:

```sh
bun run match --blue examples/controllers/chaser.js --red my-team.js --seed 42 --verify --log
```

In the viewer (`bun run dev`), choose **Controllers** mode, pick a preset, or click **Edit
script**, paste your code and click **Apply & restart match**.

## Lifecycle and timing

| Call | When | Argument | Budget |
| --- | --- | --- | --- |
| `initialize(info)` | First decision tick | `MatchInfo` | 400 units |
| `update(obs)` | Every decision tick (6 physics ticks = 0.1 s) while a half is in play | `Observation` | 80 units |
| `onMatchEnd(result)` | Once, at full time | `MatchResult` | 80 units |

- Both teams get the same pre-update state on each decision tick. Their actions are applied
  together at that tick.
- Use script globals or closures for memory that persists across updates. Each match gets a fresh
  sandbox.
- Movement is persistent. A `moveTo` keeps running until you send another movement action, so you
  don't need to resend it every update.

## `MatchInfo`

`sdkVersion`, `engineVersion`, `team` (`"blue"|"red"`), `seed`, `players` (`{id, number, role}`),
`pitch` (`length` 50, `width` 32, `goalWidth` 4, `penaltyAreaDepth` 6, `penaltyAreaWidth` 14),
`timing` (`tickRate` 60, `decisionRate` 10, `halfDurationSec`), and `rules`: `maxSpeed`,
`sprintSpeed`, `sprintThreshold`, `kickRange`, `kickMaxAngleRad`, `minKickSpeed`, `maxKickSpeed`,
`tackleReach`, `catchReach`, `restartDistance` and `restartTimeoutDecisions`.

## `Observation` (schema 1.0)

Coordinates are metres, with the origin at the centre spot and +x to the right. `attackingDirection`
is `+1` if you attack toward +x this half. It flips at halftime.

| Field | Meaning |
| --- | --- |
| `tick`, `team`, `attackingDirection`, `period`, `phase` | `period`: `preMatch`, `firstHalf`, `halftime`, `secondHalf` or `fullTime`. `phase`: `kickoff`, `openPlay`, `goalScored`, `kickIn`, `corner`, `goalKick`, `freeKick` or `stopped` |
| `clock` | `{ half, secondsInHalf, halfDurationSec }` |
| `score` | `{ own, opponent, blue, red }` |
| `ball` | `{ x, y, vx, vy, heldBy, lastTouch }` |
| `teammates[]` | your 5 players: `id, number, role, x, y, vx, vy, heading, stamina, cooldowns {touch, tackle, catch}, stunned, intent {target, sprint, dribble}` |
| `opponents[]` | the same fields, without `intent` |
| `restart` | `null`, or `{ type, team, ours, x, y, taker, ready, decisionsUntilFallback }` |
| `events[]` | engine events since your last update, each with a `tick`: `kick`, `trap`, `tackle`, `catch`, `release`, `goalScored`, `ballOut`, `foul`, `restartAwarded`, `restartTaken`, `periodStart`, `periodEnd`, `sidesSwitched`, … |
| `rejected[]` | your actions the **engine** rejected since your last update: `{ action, reason, tick }` |

The observation is a deep-frozen copy. Writing to it has no effect.

## Actions (schema 1.0)

Return an array (or `{ actions: [...] }`) of up to 32 actions. `player` may be a shirt number
(`4`) or one of your own IDs (`"blue-4"`).

| Action | Fields | Engine rules |
| --- | --- | --- |
| `moveTo` | `player, x, y, sprint?, dribble?` | Accelerates and turns toward the point. Sprint needs stamina > 0.15. With `dribble`, the player takes small touches to keep a loose ball ahead. |
| `stop` | `player` | Brakes to a halt. |
| `sprint` | `player, on` | Sets sprint on this update's movement, or on the current target. |
| `kick` | `player, direction {x,y}, power 0..1` | Ball within 0.85 m and within 110° of facing. Not allowed while grounded or on touch cooldown. Speed 4–26 m/s, with seeded aim error. |
| `tackle` | `player` | Ball within 1.3 m. Success is a seeded roll, better when closer. A miss grounds the player for 0.6 s, and a miss with contact is a foul (free kick). |
| `catchBall` | `player` (goalkeeper) | Both ball and keeper inside the keeper's own penalty area, ball within 1.4 m, relative speed ≤ 28 m/s. |
| `releaseBall` | `player, direction, power` | Keeper holding the ball. A keeper must release within 6 s. |

**Conflicts within one update.** The last movement action per player wins. Each player gets at
most one ball action (`kick`, `tackle`, `catchBall` or `releaseBall`); extra ones are rejected.

**Restarts.** Only the `restart.taker` may play the ball, by kicking, once `restart.ready` is true.
Opponents are kept 4 m away (the centre circle at kickoffs). If the taker hasn't kicked within
`decisionsUntilFallback` updates, the engine takes the restart for you.

## Validation and diagnostics

Every action goes through two layers:

1. **SDK validation**, at once. The action is rejected for an unknown type, a player that isn't
   yours, a bad shape, a non-finite number, power outside [0, 1], too many actions, or a duplicate
   ball action. It appears as an `invalid-action` diagnostic.
2. **Engine rules**, at the decision tick: range, facing, cooldowns, phase, taker and keeper area.
   A rejection appears as an `engine-rejected` diagnostic and in your next `obs.rejected`.

Rejected actions never change state, and no controller can command the other team's players or
issue engine debug commands.

## Sandbox

Each controller runs in its own QuickJS runtime compiled to WebAssembly. The same code runs under
Bun, Node and in the browser viewer.

- **No host access.** There's no `fetch`, `require`, `import`, `process`, timers, DOM, filesystem
  or `WebAssembly`. Nothing is shared with the engine or the other team; data crosses the boundary
  as JSON strings only.
- **Deterministic.** `Math.random` is seeded from the match seed and your team. `Date` is removed.
  Maths runs inside WASM, so results are bit-identical on every host.
- **Limits.**
  - Memory: 16 MB heap and 256 KB stack.
  - CPU: counted in deterministic budget units (QuickJS interrupt checks, about 3,000 simple loop
    iterations each). A 250 ms wall-clock cap applies per call as a last resort.
  - Output: 64 KB of JSON per update, 200 console lines per match.
- **Failures.**

  | What happens | What the engine does |
  | --- | --- |
  | Exception, budget exceeded, non-serialisable output | Reported; that update contributes no actions, and players keep their current movement. |
  | 3 consecutive failures | The controller is **disabled**, and a built-in safe controller plays for that team for the rest of the match. |
  | Out of memory, a failing `initialize`, or a script that doesn't load | Disabled immediately. |

  The match always continues.
- `console.log` output is captured into the diagnostics (`log`), shown in the viewer and printed by
  `bun run match --log`.

## Examples (`examples/controllers/`)

| File | Purpose |
| --- | --- |
| `dumb.js` | Minimal controller: everyone chases the ball and kicks at goal. |
| `api-probe.js` | Exercises every action type and every lifecycle callback, and logs coverage. |
| `chaser.js` | Aggressive pressing and tackling, with dribbles and shots. |
| `zonal.js` | Compact shape, a single engager, forward passes. |
| `adversarial/*.js` | Infinite loop, memory hog, throws, bad `initialize`, invalid actions, escape attempts. Used by the tests and the walkthrough. |
