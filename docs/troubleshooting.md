# Troubleshooting

## Controllers

| Symptom | Cause and fix |
| --- | --- |
| `failed to load script: SyntaxError …`, then the controller is disabled | The script doesn't parse. Run it through `node --check my-team.js` first. Scripts are plain JavaScript: no `import`, `require` or TypeScript syntax. |
| `no controller defined` | The script must call `defineController({ update(obs) { … } })` exactly once. |
| `timeout: exceeded CPU budget (80 interrupt checks)` | An `update` did too much work: about 240k simple loop iterations, or an infinite loop. Cache results between updates (script globals persist), loop over fewer candidates, or simplify helpers. Three timeouts in a row disable the controller. |
| `out-of-memory`, then disabled | The heap is limited to 16 MB per controller. Don't keep unbounded history in globals. |
| `invalid-action: not your player: red-4` | You can only command your own players. Use `obs.teammates[i].id` or a shirt number. |
| `invalid-action: only one ball action per player per update` | Send at most one of `kick`, `tackle`, `catchBall` or `releaseBall` per player per update. |
| `engine-rejected: ball out of kick range (…)` | Kicks need the ball within `rules.kickRange` (0.85 m). Use `Soccer.approachAndKick`. |
| `engine-rejected: kick direction 150° from facing (max 110°)` | The player must roughly face the kick direction. `approachAndKick` walks round the ball first. |
| `engine-rejected: only the designated taker (blue-3) may take the kickIn` | During restarts only `obs.restart.taker` may play the ball, and only by kicking once `obs.restart.ready`. |
| `engine-rejected: play is stopped (goalScored)` | No ball actions are allowed during goal celebrations, halftime or full time. Check `obs.phase` and `obs.period`. |
| `ball is outside the goalkeeper's own penalty area` | `catchBall` works only for the keeper, inside its own area. That area switches ends at halftime; use `Soccer.inOwnBox(obs, ball)`. |
| The restart is always taken by the engine (`fallback: true`) | Your taker never kicked within `decisionsUntilFallback` updates. Make sure it walks to the ball and kicks when `restart.ready`. |
| Players keep running after I stop sending actions | Movement is persistent. Send `{ type: "stop", player }` to halt. |
| `Math.random()` gives the same values every match | That's intentional. It's seeded from the match seed and team so matches are reproducible. Change `--seed` for variety. |
| `Date is not defined` | Controllers have no wall clock. Use `obs.tick` and `obs.clock`. |

## Determinism and replays

| Symptom | Cause and fix |
| --- | --- |
| `golden hashes MISMATCH` after an engine change | Expected when physics or rules change. Review the change, then run `bun run golden:write`. Never regenerate goldens to "fix" an unexplained mismatch. |
| A replay says `recorded with engine X; this build is Y` | Replays are tied to the engine version that recorded them. Re-record with the current build. |
| `verify FAILED … mismatches` | The replay was edited, or the engine changed without a version bump. Re-record it. |
| Different hashes on different machines | Only use the deterministic maths (`dsin`, `dcos`, `datan2`, `dhypot`) in engine or command code. `Math.sin` and friends differ between JS engines. |

## Viewer and tooling

| Symptom | Cause and fix |
| --- | --- |
| The viewer shows old behaviour after editing engine files | Restart `bun run dev`. Some editors replace files in a way Vite's watcher misses. |
| `bun: command not found` | Install Bun 1.2.19: `npm i -g bun@1.2.19`. If that leaves a placeholder binary, run `node install.js` inside the global `bun` package. |
| Tournaments are slow | Use `--workers N`; each match is independent. One sandboxed match takes about 2 s on an M2 Pro. See [performance.md](performance.md). |
| Playwright can't find a browser for `bun run walkthrough` | Run `npx playwright install chromium`. |
