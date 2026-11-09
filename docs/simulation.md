# Simulation rules (M1)

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
- Integrated in 4 sub-steps per tick.
- **M1 boundary:** the pitch is enclosed by walls (restitution 0.6). Out-of-play, goals and
  restarts come in M3.

## Collisions

- **Player–player:** positional separation split equally between the two players, plus a normal
  impulse (restitution 0.2). Two relaxation passes, visiting pairs in stable `i < j` order.
- **Player–ball:** the ball is pushed out of the player and its relative normal velocity is
  reflected (restitution 0.55), treating the player as infinite mass. Kicks, dribbling and tackles
  are M2.
