# Dogs (design, not implemented)

Some households keep a dog. It goes out with them on walks, runs about in the park,
waits by the door, now and then gets lost. This note is the design to build it on: who
gets a dog, how it is saved, how it moves and is drawn, what it costs, and the order to
build it in. It sits on the activity layer (`src/sim/gatherings.js` ACTIVITIES, layouts,
pickers, wanders), the leisure outings (`src/sim/leisure.js`) and the walker pipeline
(`src/sim/people.js`), and changes none of their contracts.

## 1. Who gets a dog, and why

A household decides once a year (the households yearly pass, `src/sim/households.js`),
with a probability from its traits, never from `Math.random`:

| factor | effect |
|---|---|
| household type `family-with-children` | ×1.8 (children ask for one) |
| life stage `elder`, size 1 | ×1.4 (company) |
| wealth band (`state.bands.wealth`) | poor ×0.5, middle ×1, rich ×1.3 (and rich keep two, rarely) |
| trade `farm` | ×2.5 (working dogs), `labour`/`craft` ×1, `gentry` ×1.2 |
| home | rural (a farm or a home with a garden plot, outside the dense centre: `sites.js localDensity` low) ×1.5; a dense terrace in the centre ×0.6 |
| town policy | a "dog licence" rule (later, governance) ×0.7 |

The base rate is about 6% a year, capped so that at most about 30% of households have a
dog. A dog lives 10 to 14 years. When it dies there is a chronicle line, and no new
dog for a year or two. A household that moves takes its dog with it; when a household
splits, the dog stays with the original household.

## 2. Ownership persistence (the save)

The dog belongs to the household. Its record is saved with the household:
`h.dog = {id, born, name, look, breed, size}`.
- `id` comes from `nextId`.
- `look` is a hash-chosen palette index plus an ear and tail variant.
- `size` is 0 small, 1 medium or 2 large; it sets speed and mesh scale.
- `breed` is cosmetic, plus a speed factor.
- Names come from a small deterministic list hashed by `id`.

The record is small, plain JSON and versioned with the save (a missing `dog` means
none). Its effects on the town (wellbeing +, a little looks −, noise) are left to the
balance pass.

A visible dog exists only while a walker of its household is outside with it: a
*follower* (§4) attached to the walker's task (`task.dog = 1`). No dog agents are saved
beyond `h.dog` and that flag. A dog at home is not simulated.

## 3. Dog walks as activities

These are new `ACTIVITIES` entries and new `OUTINGS` rows. They follow the same rules
as every other leisure choice: weights by season, weather and day phase, a stable habit
per walker, and a modest share of leisure trips.

- **`dog-walk`.** Out and back along a trail, the woods' edge or the river bank, using
  `loopRoute` and the existing `edge`/`view` places. The household's adult takes the
  dog, on a leash in town and *off the leash* on open ground (`fp.field` lawn or no road
  tier, away from the river's edge: `bankDistance > 3`). Dog owners take two or three
  times the base share of outings, and walks happen morning and evening
  (`daylight.js isMorning`/`isEvening`), even in rain (×0.8, where a picnic is ×0.1).
- **`dog-park`.** Ball and stick games on a park lawn. The `lawn` layout is unchanged.
  The owner stands at an appealing spot (pose `point` or a new `throw`), and the dog
  runs a loop out to a point and back (a new wander, `fetch`). Several dogs on the same
  lawn chase each other: a `chase` wander picks a target from the dogs on the lawn
  (from the kin index's sibling map of dogs) and runs a short pursuit curve.
- **`dog-door`.** When the household is home, the dog sits by the door now and then
  (the `yard` layout, a `sit` pose for the dog) for a short dwell: life in the street.

## 4. Separate agents or attached followers? Followers.

**Recommendation: followers, not separate agents.** A dog is a few floats attached to
its owner's walker, advanced along the owner's own route. It never runs its own A*.

- **On the leash.** The dog trails `LEASH` (1.2) behind and `0.4` to the side of the
  owner, measured along the owner's smoothed route: the arc length `s` along
  `task.route`, minus the leash. Its position is the route point at that arc length,
  offset to the side (as `laneOffset`, with the opposite sign to the owner's lane).
  - It runs entirely on legs the pipeline already made: walls, water and decks were
    checked when the route was built.
  - On a deck it keeps to the deck line, as `alongDecks` does.
  - It costs one arc-length interpolation per dog per tick, and nothing at all while
    the owner stands (the dog sits).
- **Off the leash.** The dog runs a small loop ahead of the owner along the same
  route, up to `ROAM` (4) units ahead, plus a sideways sway. Each sway point is
  checked once against the stand rules (`standable` and `stepClear` from the current
  dog point), and dropped back to the leash line if it fails. It is never out of
  reach of the owner's corridor, so it never needs a path of its own.
- **In a park.** `fetch` and `chase` loops are `loopRoute` wanders: every leg is
  checked, within the park bounds. Dogs at a lawn claim no spots; they pass through
  people, as walkers do.

Separate agents (own tasks, A*, routes) would double the walker pipeline's cost per dog
and need a second set of rules for every place. The only real gain would be dogs wandering
on their own, and that is cover for the lost-dog event (§8), which can be scripted as a
short follower of an invisible target.

## 5. Crowds and density

- Dogs are left out of the standing hash (they take no spots) and out of the density
  grid (`density.js` counts walkers only). A dog never makes a park "full".
- In a focal gathering a dog sits at its owner's feet: the follower offset clamped to
  0.5 behind the owner's facing, so the crowd's fan stays readable.
- Dogs show up in the crowd-aware place choice through a small penalty: a dog owner
  avoids `crush` gatherings and dense markets (×0.3 on those outings).

## 6. Rendering

- **A separate instanced mesh** in `src/render/dogs.js`, beside `people.js`. It is a
  boxy quadruped of about 40 triangles: a body, head, snout, two ears, a tail, and four
  legs as single boxes. Vertex-shader gait: a trot, with diagonal leg pairs at 2.5×
  the walker's step frequency; a gallop off the leash; a sit pose; and tail wag as a
  sine on the tail bone. It uses the same bone and part scheme as the villagers, and
  the same palette approach (6 coat colours, 2 ear variants, scale by size).
- **Rows.** A second render-view buffer of 12 floats per dog: x, y, z, vx, vz, t0,
  phase, gait, pose, coat, scale and heading. It is written by the sim's render view
  only when the dog's velocity or pose changes, as walker rows are. The walker row
  layout stays unchanged. The leash is a single thin quad drawn from the owner's hand
  (the row's `action` gains no new id: the leash is a separate tiny instanced line
  between the two rows, enabled by a flag in the dog's row).
- **Shadows.** The same blob-shadow draw as walkers (contact plus sun-aware cast),
  scaled down to the dog's length.
- **LOD.** Beyond the villagers' `uLodNear` the dog is one box. Beyond `uLodFar` it is
  culled. Dogs are never drawn while their owner is indoors.

## 7. Cost at 3,000 walkers

At a 30% household share there are about 280 dogs in the 3,000-walker city fixture, but
only those with an owner out on a dog activity are visible: typically 5–15% of them,
about 15–40 dogs.
- **Sim.** Under 1 µs per dog per tick for the follower interpolation (no allocation:
  scratch on the task), plus the odd `stepClear` for off-leash sway points: about
  0.02–0.05 ms per tick in all, against the current 2.2–2.6 ms mean.
- **Render.** 40 dogs × 40 triangles is 1.6k triangles plus the shadow quads.
  Negligible next to 3,000 villagers at about 114 triangles each.
- **Save.** About 60 bytes per dog record.

## 8. Places and events

- **Dog parks.** The park lawn (`lawn` layout). A wild park (a nature reserve) allows
  dogs only on the lead, using the leash rule on the reserve walk. A future "dog field"
  building would be a park variant with no flower beds.
- **The river bank.** Paddling at a shallow calm reach in summer is a dog-only pose
  (`swim`). This needs a shallow bank depth test and a water-surface height from
  `render/water.js waterSurfaceAt`, mirrored in the sim. Left until paddling people
  exist.
- **Lost dog** (`events.js`, a small crowd event). A dog slips its owner on an
  off-leash walk. Rendered as a follower of an invisible target that runs a `loopRoute`
  wander for a few minutes. The owner's household and its neighbours get "search"
  tasks: the `mingle` layout round the dog's last point, which turns into an
  `edge`/`view` walk. It ends with "found" (most often) or a chronicle line. All
  outcomes are deterministic from `rng(state)`.
- **Dog show** at a fair. A `ceremony` gathering round a ring (the focal fan on the
  open side), with dogs following their owners on short loops in the middle. It reuses
  `cluster` for the spectators who drift.

## 9. Save and determinism

- Every choice (adopting, names, looks, which walker takes the dog, leash on or off,
  sway points) comes from `hash32`/`hashUnit` of ids, `rev` and `tick`, or from the
  saved rng in the yearly pass. Nothing uses wall-clock time or `Math.random`.
- Follower positions are a pure function of the owner's task (its route, `seg` and
  dwell) and the dog's id. So a save carries only `h.dog` and `task.dog`; a restored
  town re-derives every visible dog on its first tick. The "saved mid-walk continues
  exactly" test extends naturally.
- The render rows are not saved, as now.

## 10. Phased plan

1. **Ownership.** The yearly adoption pass, `h.dog` in the save, a chronicle line, and
   a household inspector line in the UI. Tests: adoption probability by traits, and
   save round-trip.
2. **Followers on the leash.** `task.dog` on outings (`dog-walk` as a `trail-walk` or
   `wood-walk` with a dog), arc-length follower, and the dog row buffer. Tests: the dog
   stays within the leash of its owner's route, is always on walkable ground or a
   deck, never in water, and replays the same.
3. **Rendering.** `render/dogs.js` mesh, gait shader, blob shadow, LOD, the leash line.
   A screenshot check; triangle budget test.
4. **Off the leash and parks.** Off-lead rules, the `fetch` and `chase` wanders on the
   `lawn` layout, the `dog-park` outing. Tests: dogs keep inside park bounds, legs
   clear, no stacked claims.
5. **Events.** Lost dog and the dog show. Tests: event placement, determinism.
6. **Balance.** Wellbeing and looks effects, a dog-licence policy, and the share of
   households, tuned against the city fixture.

## 11. Open questions (with recommendations)

- **Should dogs get their own A\*?** No: followers only (§4). Revisit only if dogs must
  roam with no owner (strays). Even then, recommend a scripted follower of an invisible
  target over a second agent type.
- **How many visible at once?** Cap at 60 visible dogs (lowest ids first) to bound the
  render buffer. With today's leisure shares we expect 15–40.
- **Leash geometry.** One thin quad per dog in a second instanced draw. Recommend it,
  not adding vertices to the villager mesh, which is at its 116-triangle budget.
- **Does a dog affect the owner's pose?** When it is on the lead, yes: the walker's
  `action` becomes a new `walk-dog` pose, with one arm forward and the leash hand at
  hip height. This is a new ACTION id (13) in the same row slot. Recommended.
- **Stray dogs in a poor, crowded town?** Possibly later, as a pressure-driven event
  (unrest or health). Recommend deferring until phase 6.
- **Dogs in the save of old towns?** A missing `h.dog` means none, and adoption starts
  at the next yearly pass. No migration needed.
