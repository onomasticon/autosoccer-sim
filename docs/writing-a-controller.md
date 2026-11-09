# Writing a controller (tutorial)

This walks you through a complete team script built only from the public docs: the
[SDK reference](controller-sdk.md) plus this page. The final code below is tested. The test suite
extracts it from this file and plays a full match with it (`tests/release.test.ts`).

## 1. The shape

A controller is one JavaScript file that calls `defineController`. It runs in a sandbox: no
imports, no network, no timers. You get a plain JSON `obs` ten times per simulated second and
return a list of actions.

```js
defineController({
  update(obs) {
    return []; // players keep doing what they were doing
  },
});
```

Save it as `my-team.js` and run it:

```sh
bun run match --blue my-team.js --red examples/controllers/dumb.js --seed 1 --log
```

## 2. Know where you're attacking

Coordinates are in metres, with the centre spot at (0, 0). `obs.attackingDirection` is `+1` when
you attack toward +x, and it flips at halftime. `Soccer.oppGoal(obs)` gives the centre of the goal
you attack, and `Soccer.ownGoal(obs)` the one you defend.

## 3. Kick legally

A kick only works when:
- the ball is within `rules.kickRange` (0.85 m);
- the kick direction is within the player's facing cone;
- the player's touch cooldown is 0.

`Soccer.approachAndKick(player, ball, target, power, rules)` handles all of that. It walks the
player round behind the ball, and only returns a `kick` once the kick would be legal.

## 4. Take your restarts

When `obs.restart` is set and `obs.restart.ours` is true, only `obs.restart.taker` may play the
ball, by kicking, once `obs.restart.ready` is true. If you don't, the engine takes it for you after
about 6 s (`decisionsUntilFallback`). `Soccer.ourTaker(obs)` gives you the taker.

## 5. Keepers

A goalkeeper (`role: "GK"`) may `catchBall` only inside its own penalty area
(`Soccer.inOwnBox`), with the ball within `rules.catchReach`. While holding, it must `releaseBall`
within 6 s.

## 6. The complete tutorial team

```js tutorial
// Tutorial team: one presser, two holding players, one forward, a keeper.
let rules = null;

defineController({
  name: "tutorial",
  version: "1.0.0",

  initialize(info) {
    rules = info.rules; // physical limits the engine enforces
  },

  update(obs) {
    const actions = [];
    const ball = obs.ball;
    const goal = Soccer.oppGoal(obs);
    const own = Soccer.ownGoal(obs);
    const dir = obs.attackingDirection;
    const keeper = obs.teammates.find((p) => p.role === "GK");
    const field = obs.teammates.filter((p) => p.role !== "GK");

    // Restarts: our taker plays it to the nearest teammate.
    const taker = Soccer.ourTaker(obs);
    if (taker) {
      const mate = Soccer.nearest(field.filter((p) => p.id !== taker.id), ball);
      const kick = Soccer.approachAndKick(taker, { x: obs.restart.x, y: obs.restart.y }, mate, 0.4, rules);
      for (const a of kick) if (a.type !== "kick" || obs.restart.ready) actions.push(a);
    }

    // Keeper: catch in the box, throw it out, otherwise guard the goal line.
    if (ball.heldBy === keeper.id) {
      actions.push({ type: "releaseBall", player: keeper.id, direction: { x: dir, y: 0.5 }, power: 0.5 });
    } else {
      if (obs.phase === "openPlay" && Soccer.inOwnBox(obs, ball) && Soccer.dist(keeper, ball) < rules.catchReach) {
        actions.push({ type: "catchBall", player: keeper.id });
      }
      actions.push({ type: "moveTo", player: keeper.id, x: own.x + dir * 1.5, y: Soccer.clamp(ball.y, -1.8, 1.8) });
    }

    if (obs.phase === "openPlay") {
      // Presser: the outfield player nearest the ball attacks it and shoots or drives at goal.
      const presser = Soccer.nearest(field, ball);
      const shooting = Soccer.dist(ball, goal) < 18;
      actions.push(...Soccer.approachAndKick(presser, ball, shooting ? Soccer.shotTarget(obs) : goal, shooting ? 1 : 0.35, rules));

      // Everyone else holds a simple shape relative to the ball.
      const others = field.filter((p) => p.id !== presser.id);
      const spots = [
        { x: ball.x - dir * 8, y: -6 },
        { x: ball.x - dir * 8, y: 6 },
        { x: ball.x + dir * 6, y: ball.y > 0 ? -5 : 5 },
      ];
      others.forEach((p, i) => {
        const s = spots[i];
        actions.push({ type: "moveTo", player: p.id, x: Soccer.clamp(s.x, -23, 23), y: s.y });
      });
    }
    return actions;
  },

  onMatchEnd(result) {
    console.log(`tutorial finished: ${result.outcome} ${result.score.own}-${result.score.opponent}`);
  },
});
```

Run it against a featured team, then open the viewer to watch it:

```sh
bun run match --blue my-team.js --red examples/controllers/red-counter.js --seed 7 --log --verify
bun run dev   # Controllers mode → Edit script → paste → Apply & restart match
```

## 7. Debugging

- `console.log` output shows up in `--log` and in the viewer's controller panel.
- Rejected actions come back in `obs.rejected`, with reasons such as "ball out of kick range" or
  "only the designated taker…".
- Return `{ actions, debug: { mode, notes, lines } }` to see your decisions drawn on the pitch.
- See [troubleshooting.md](troubleshooting.md) for common problems.
