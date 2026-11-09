# Simulation rules (M2)

Units: metres, seconds, m/s, radians. Origin at the pitch centre, +x toward the right goal, +y down.
Blue defends −x at kickoff. All values live in `DEFAULT_CONFIG` (`packages/sim-core/src/config.ts`).

| Quantity | Value |
| --- | --- |
| Pitch | 50 × 32 m, goals 4 m wide, keeper area 6 × 14 m, 2 m run-off |
| Timing | 60 Hz physics, 10 Hz decisions (6 ticks), 2 × 120 s halves (configurable) |
| Teams | 5v5, shirt 1 = goalkeeper; IDs `blue-1..5`, `red-1..5` |

## Players

- Circle, radius 0.4 m, mass 75 kg.
- **Intent:** `moveTo(x, y, sprint?)` or `stop`. The intent persists until it's replaced.
- **Turning:** heading rotates toward the target at most `turnRate` rad/s (10 at rest, falling
  linearly to 3.5 at sprint speed).
- **Speed:** jog 6 m/s, sprint 8.5 m/s. Desired speed is scaled by alignment
  `max(0.15, cos(heading error))`, so players turn before they run. Arrival behaviour slows the
  player so it doesn't overshoot.
- **Acceleration:** each tick, velocity changes by at most 7 m/s² (accelerating) or 10 m/s²
  (braking), so players can't teleport.
- **Stamina** ∈ [0, 1]: drains 0.12/s while sprinting above 80% of jog speed, otherwise recovers
  0.05/s. Sprinting needs stamina > 0.15.
- Players are clamped inside the pitch plus run-off.

## Ball

- Radius 0.11 m, mass 0.43 kg. The ball is always a free body and is never attached to a player.
- Friction: speed −= (0.9 + 0.25·speed)·dt; below 0.05 m/s it stops.
- Integrated with adaptive sub-steps (≤ 0.1 m travel each), so a 26 m/s shot can't tunnel through
  the 0.51 m player–ball contact distance.
- **Boundaries (M2):** touchlines and the goal line outside the goal mouth are walls (restitution
  0.6). Out-of-play and restarts come in M3.
- **Goal:** inside the 4 m mouth the ball may cross the goal line into a 1.2 m-deep net
  (restitution 0.15, heavy damping). A goal is the *whole* ball beyond the line (`|x| > 25 + r`)
  with `|y| < 2`. It produces one `goal` event, and `ball.inGoal` stays set until the ball is
  placed again.

## Collisions

- **Player–player:** positional separation split equally between the two players, plus a normal
  impulse (restitution 0.2). Two relaxation passes, visiting pairs in stable `i < j` order.
- **Player–ball:** the ball is pushed out of the player and its relative normal velocity is
  reflected (restitution 0.55), treating the player as infinite mass. The contact sets
  `ball.lastTouch`.

## Ball actions (M2)

Commands: `kick(dir, power)`, `tackle`, `catch`, `release(dir, power)`, plus `moveTo(…, dribble)`.
Every attempt is either **executed** (producing an event, possibly an unsuccessful one) or **rejected**
with a reason; rejected commands never change state. All randomness is drawn from the seeded world RNG.

| Action | Constraint | Result |
| --- | --- | --- |
| **kick** | ball ≤ 0.85 m, not held, direction within 110° of facing, touch cooldown 0, not grounded | ball speed `4 + 22·power` m/s plus 30% of the player's velocity; seeded angular error up to `0.12·power²·(0.5+0.5·fatigue)` rad; 12-tick touch cooldown |
| **dribble** (intent) | free ball ≤ 0.9 m and ahead of the player, cooldown 0 | a touch sets the ball to the player's speed + 0.9 m/s along the heading; 10-tick cooldown |
| **trap** (automatic) | moving ball (≥ 1.5 m/s, also relative) approaching within 0.85 m | if relative speed > 22 m/s → `trapMiss`; otherwise success with p = `1 − 0.8·(v/22)²`; a successful trap cushions the ball to the player's velocity; flagged as an **interception** if the last touch was by the other team |
| **tackle** | ball ≤ 1.3 m, not held, tackle cooldown 0 | success p = `0.25 + 0.7·(1 − d/1.3)`: ball poked away at 7 m/s, the nearest opponent gets a touch cooldown; failure grounds the tackler for 36 ticks (no movement or actions); 45-tick cooldown |
| **catch** | goalkeeper only; ball *and* keeper inside the keeper's own penalty area; ball ≤ 1.4 m, relative speed ≤ 28 m/s; catch cooldown 0 | success p decreases with speed and distance → ball **held**; failure parries the ball away from goal |
| **release** | keeper is holding | throw/kick like a kick (max 22 m/s); 30-tick catch cooldown |

While holding, the ball sits at the keeper's hands. Opponents can't kick or tackle it, the keeper is
clamped inside its area, and the keeper must release within 360 ticks (6 s) or the ball is dropped
automatically.

**Arbitration** (deterministic): within one tick, actions resolve catch → release → tackle → kick.
Inside each group the player nearest the ball goes first, with ties broken by player ID. Once the
ball has been played, later ball actions that tick are rejected ("ball already played this tick").
Automatic touches (traps, then dribble touches) run after player movement, nearest player first.

**Debug commands** `debugPlaceBall` / `debugPlacePlayer` exist for the scenario harness and tests
only. They are recorded in the command stream, so scenarios replay exactly. Sandboxed controllers
won't be able to issue them (M4).
