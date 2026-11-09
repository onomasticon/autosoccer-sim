# Simulation rules (M3)

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
- **Boundaries (M3):** touchlines and goal lines aren't walls; the ball can leave play. The posts
  (at ±2 m), the goal nets (entered only through the mouth) and the boards around the 2 m run-off
  are physical obstacles.
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

## Match flow (M3)

`WorldState.match` holds the **period** (`preMatch → firstHalf → halftime → secondHalf → fullTime`).
It's tracked separately from the **phase** (`stopped`, `kickoff`, `openPlay`, `goalScored`, `kickIn`,
`corner`, `goalKick`, `freeKick`). The match state also holds the half clock, score, which goal
each team defends, the first-half kickoff team (a seeded coin toss) and the pending `restart`
(type, team, spot, designated taker, ready tick and deadline tick). All of it is hashed and
observable.

| Situation | Detection | Restart | Taker | Spot |
| --- | --- | --- | --- | --- |
| Start of a half | timers | kickoff (first half: coin-toss winner; second half: the other team) | kicking team's FW, placed at the ball | centre |
| Goal | whole ball over the goal line between the posts in open play | 2 s celebration, then kickoff by the conceding team; scorer = last touch, own goals flagged | as above | centre |
| Touchline | whole ball over (`|y| > 16 + r`) | kick-in to the team that didn't touch it last | nearest outfield player | crossing point on the line |
| Goal line, attacker last | `|x| > 25 + r`, outside the posts | goal kick | defending goalkeeper | 2.5 m in front of goal |
| Goal line, defender last | same | corner | nearest attacker | nearest corner |
| Foul | a failed tackle whose victim is within 1 m of the tackler | free kick to the fouled team (no penalties: a foul in the fouling team's area moves to the area's edge) | nearest outfield player | ball position |

**Restart lifecycle.**
1. The restart is awarded and a `restartAwarded` event is emitted.
2. The ball keeps rolling for 45 ticks (out of play) or 30 ticks (foul).
3. The ball is placed and **locked** on the spot. Players can't push it.
4. Only the designated taker may play it, and only with a kick. Other ball actions are rejected
   with a reason ("ball is dead…", "only the designated taker…", "…not ready yet").
5. Opponents inside 4 m (the centre circle at kickoffs) are walked out at sprint speed, never
   teleported. At kickoffs everyone except the taker is walked back into their own half.
6. The taker's kick returns play to `openPlay` (`restartTaken`).
7. If the taker hasn't kicked 360 ticks (6 s) after the ball is placed, the engine takes the
   restart itself: a pass to the nearest teammate (`restartTaken`, `fallback: true`). No controller
   behaviour can stall a match.

**Kickoffs** are engine-placed: everyone goes to the kickoff formation for the current ends, with
zero velocity. This is the only time the engine sets player positions directly.

**Clock.** Each half is 120 s. The default policy `running` advances the clock in every phase of a
half; `stopOnDeadBall` advances it only in open play. A half ends exactly on time, cancelling any
pending restart. Halftime lasts 3 s, then the teams swap ends (`sidesSwitched`). Keeper areas and
attacking directions follow `match.defends`.

**Permissions.** No ball actions are accepted outside the halves, during goal celebrations, or
after full time ("play is stopped (…)"). Movement commands are always accepted.

**Events:** `periodStart`, `periodEnd`, `goalScored`, `ballOut`, `foul`, `restartAwarded`,
`restartTaken` and `sidesSwitched`, in addition to the M2 action events.
