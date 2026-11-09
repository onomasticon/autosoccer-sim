# Featured controllers: Blue possession vs Red counterattack

Both teams are ordinary sandboxed scripts (`examples/controllers/`). They use only SDK 1.1: JSON
observations in, actions out, the `Soccer` helpers, and an optional `debug` trace. Neither has any
privileged access. Run them with:

```sh
bun run demo                                   # viewer, autoplay at 4×
bun run match --blue examples/controllers/blue-possession.js --red examples/controllers/red-counter.js --verify --log
bun run bvr --matches 100                      # seeded batch with action profiles
```

## Blue: possession (`blue-possession.js`)

| Situation | Behaviour |
| --- | --- |
| **Who has it?** | Blue compares its fastest player's `interceptPoint` time with the opponents' fastest. Mode is **build-up** (or **keep-ball** when protecting a lead) when Blue gets there first, otherwise **high press**. |
| **Ball carrier** | Shoots when within range (17 m; 21 m chasing; 13 m protecting) and the shot lane to the far side of the keeper is open. Otherwise it scores every teammate: `progress × w + space × 0.8 + lane × 0.5 − distance × 0.05`. Lanes under 1.1 m or passes outside 4–20 m are ruled out. It passes when the value is high or it's under pressure (< 2.6 m), weighted with `kickPowerFor` to arrive at about 5 m/s and led toward the receiver's motion. Otherwise it dribbles forward, bending away from the nearest defender. |
| **Support** | The forward runs in behind the last defender on the far side. Two wide supports sit about 9 m either side, slightly ahead of the ball. A deep pivot sits about 7 m behind. Spots are nudged away from nearby opponents so they're open. |
| **High press** | The nearest player hunts the ball (intercept point, sprint) and tackles in reach. The second cuts the lane to the most likely receiver. The rest mark goal-side, never dropping below a high line. |
| **Keeper** | Positions on the ball–goal line, 1.5 m out. Catches in its area and **distributes short** to the best-valued teammate. |
| **Restarts** | Kickoff to the nearest teammate. Other restarts go to the best-valued pass; the taker goes round the ball and kicks only once it's ready. |
| **Adaptation** | Second half, behind: **chase** (forward-weighted passing, longer passes and shots, higher press). Late, ahead: **protect** (keep-ball, safer passes, shorter shooting range). |
| **Memory** | Mode changes, passes tried and completed, shots and tackles, summarised in `onMatchEnd`. |

## Red: counterattack (`red-counter.js`)

| Situation | Behaviour |
| --- | --- |
| **Low block** | Two defenders and the midfielder hold two narrow lines, about 9 m and 15 m from their goal line. The lines shift toward the ball (`0.45 × ball.y`) and up or down with ball position. Only the block player nearest the ball engages (intercept or tackle), and only when the ball is near the block. |
| **Outlet** | The forward stays high on the weak side, ready for the counter. |
| **Ball won → COUNTER (4 s)** | Shoots early (< 19 m; < 22 m chasing) if the lane is open. Else it plays a **direct, leading pass into the forward's run** if that lane is clear and the forward is at least 6 m ahead. Else it drives forward at pace. The midfielder sprints up in support. |
| **Keeper** | Catches, then **launches long and quickly** to the forward. |
| **Restarts** | Goal kicks go long to the forward. Free kicks and kick-ins go to the forward if the lane is open, otherwise to the nearest teammate. |
| **Adaptation** | Second half, behind: **chase** (block 6 m higher, engage everywhere). Ahead: **protect** (block 2 m deeper). |
| **Memory** | Counter timer, plus counts of counters, direct passes, interceptions and shots, summarised in `onMatchEnd`. |

## What the numbers show

See the PR and `bun run bvr` for the 100-match profile. Across seeds, Blue has about 70% of the
ball, plays many short passes (about 6–8 m) and stands higher (team height about 25 m from its own
goal line). Red plays fewer, longer passes (about 15–19 m), carries the ball more, defends deeper
(about 17 m) and relies on interceptions and counters.
