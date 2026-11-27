# Testing IMMUNE PROTOCOL

Everything runs from the project root (`/workshop/immune-protocol`). Node tests use Vitest (node env, config in
`vite.config.ts`); browser checks use `playwright-core` + headless Chromium with WebGL via SwiftShader. No
`package.json` scripts are needed beyond the existing `npm test` / `npm run typecheck` — the commands below call
the tools directly. The machine is shared (4 CPUs, many agents): limit workers, run one browser at a time.

## 1. Type check
```bash
npx tsc --noEmit -p .                                              # whole project
npx tsc --noEmit -p . 2>&1 | grep -E "tests/integration|tests/helpers|scripts/"   # QA files only
```

## 2. Vitest — fast suite (default)
```bash
npx vitest run --maxWorkers=2                 # everything (all areas); [slow] tests are skipped
npx vitest run tests/integration              # integration suite only (< 60 s, typically a few seconds)
npx vitest run tests/core                     # architect's core tests
npx vitest run tests/<area>                   # one area: combat, economy, movement, ai, map, campaign, ...
npx vitest run tests/integration/smoke.test.ts --silent=false   # show console output (summaries, timelines)
```
Vitest hides `console.log` of passing tests by default — add `--silent=false` to see match summaries.
Budget note: the three campaign files each simulate 5 min on meilahti; at the current sim cost (~6–8 ms/tick there,
mostly the `orders`/`movement`/`economy` systems) each takes ~35–50 s, so the integration suite is ~55–75 s wall on an
idle box. `QA_CAMPAIGN_MINUTES=2 npx vitest run tests/integration` gives a quicker pre-commit check.

| file (`tests/integration/`) | what it proves |
|---|---|
| `smoke.test.ts` | bot (medium) vs AI (normal) on `test`, 5 simulated min: no exceptions, no swallowed `console.error`, all invariants hold |
| `harness.test.ts` | the invariant checker catches planted bugs (NaN, hp>max, zombie, lingering dead, unit in water, bad projectile); the bot only acts through `world.issue()`; spiral placement is valid; vs an idle enemy the bot builds the full tech tree + army (economy/production integration) |
| `determinism.test.ts` | same seed → identical summary **and** world-state hash (catches `Math.random`, `Date.now`, leaking module globals) |
| `campaign-m1/m2/m3.test.ts` | each mission sets up and runs 5 simulated min with the bot (medium): no exceptions / console errors / invariant errors, objectives well-formed, won/lost ⇒ game over. One file per mission so they run in parallel; skipped while a mission or its map isn't registered |
| `campaign.test.ts` | m1–m3 registered; MissionRunner contract (`autoDefeat=false` after setup, both sides spawned, `createMission(id)` honours the id, briefing/preview present); runs any extra mission beyond m3 |
| `contracts.test.ts` | every registered map is well-formed, `getMap()` returns fresh arrays, slots + HQ footprints buildable, skirmish start spawns HQ + 5 gathering workers on walkable tiles, starts reachable by ground; meilahti has every DESIGN §6 region/point and its expansions are reachable; missions reference registered maps |
| `full-matches.slow.test.ts` | **[slow]** full matches, see below |
| `inspect.test.ts` | manual tool (skipped unless `INSPECT=1`): one match with full output + per-system profile, see §4 |

## 3. Vitest — [slow] full matches
Gated behind `SLOW=1` (otherwise reported as skipped). Bot vs AI easy/normal/hard on `test` and `meilahti`
(meilahti skipped until registered), up to 25 simulated minutes each. Asserts only "no exceptions / invariants
hold" and **records outcomes**: console table + `/tmp/immune-qa/full-<map>-<difficulty>.json` +
`/tmp/immune-qa/full-matches.json`.
```bash
SLOW=1 npx vitest run tests/integration/full-matches.slow.test.ts --silent=false          # whole matrix
SLOW=1 npx vitest run tests/integration -t "\[slow\] test map vs hard" --silent=false      # one match (-t = name filter)
SLOW=1 QA_MAPS=meilahti QA_BOT=strong QA_MINUTES=15 QA_SEED=4 npx vitest run tests/integration/full-matches.slow.test.ts --silent=false
```
Knobs: `QA_MINUTES` (25), `QA_BOT` (`weak|medium|strong`, default medium), `QA_SEED` (1), `QA_MAPS` (`test,meilahti`),
`QA_OUT` (report dir, default `/tmp/immune-qa`).

## 4. The harness (`tests/helpers/`) — use it in your own tests
```ts
import { runMatch, describeSummary, errorViolations, formatViolations, formatExceptions } from '../helpers/match';
const s = runMatch({ mapId: 'test', difficulty: 'hard', seed: 3, minutes: 10, bot: 'strong' });
expect(s.exceptions, formatExceptions(s)).toEqual([]);
expect(errorViolations(s), formatViolations(s)).toEqual([]);
console.log(describeSummary(s));            // winner, end time, per-player counts, bot report, AI describe()
```
- `runMatch(opts)` — mirrors `Game.stepOnce()` (bot → AI → mission → `world.step()`), each phase in try/catch
  (exceptions are recorded with phase + tick), captures `console.error/warn` emitted during the match (World and
  EventBus swallow exceptions into `console.error`). Options: `mode: 'skirmish'|'campaign'`, `mapId`, `map`,
  `missionId`, `difficulty`, `seed`, `minutes`, `bot` (`'weak'|'medium'|'strong'` or `{ strength, overrides, log }`,
  `null` = no bot), `enemyAi`, `invariants` (options or `false`), `stopOnGameOver`, `timelineEvery`, `onSetup`, `onTick`.
- Summary: `winner` (`hospital|pathogen|draw|timeout`), `winnerTeam`, `reason`, `endTime`, `players[id]`
  (stats, resources, pop, units/workers/army/buildings by type, upgrades), `timeline` (every 60 s: workers, army,
  army pop, buildings, resources, pop), `exceptions`, `consoleErrors`, `violations` + `violationCounts`, event counts,
  mission state + objectives, `ai` (`describe()`), `botReport`/`botStats`/`botLog`, `stateHash`, `wallMs`, `msPerTick`.
  `fingerprint(s)` = summary without wall-clock fields; `saveSummary(name, s)` writes JSON to `$QA_OUT`.
- Invariants (`tests/helpers/invariants.ts`, every 20 ticks by default; each (check, entity) recorded once,
  `violationCounts` has totals). **error**: `position-finite`, `position-bounds`, `hp-finite`, `hp-over-max`,
  `zombie` (alive with hp ≤ 0), `stats-sane`, `velocity-finite`, `goal-finite`, `path-finite`, `combat-finite`,
  `resources-finite`, `resources-negative`, `pop-finite`, `pop-cap-max`, `pop-over-cap` (alive + queued pop > highest
  cap seen + slack), `queue-overflow`, `queue-progress`, `construction-progress`, `resource-amount`, `carry-capacity`,
  `owner-valid`, `store-consistency` (list ↔ entities map), `dead-lingering` (alive=false still in `world.entities`
  2+ ticks later), `unit-in-blocked-tile` (ground unit centre ≥ 0.3 tiles deep in static-blocked terrain for ≥ 1.5 s),
  `projectile-finite`, `projectile-id`, `projectile-owner`, `projectile-leak` (alive > 30 s), `defeat-missing`,
  `game-over-consistency`. **warn**: `pop-accounting` (popUsed ≠ alive + queued for 3 checks), `unit-in-footprint`
  (ground unit inside a building/cache footprint ≥ 1.5 s), `projectile-count`, `projectile-t`, `clock`.
  Use `new InvariantChecker({...}).check(world)` directly in unit tests; `throwOnViolation: true` throws with context.
- `runMatch({ ..., profile: true })` adds `summary.profile` (ms per tick for `world.step`, every sim system, AI,
  mission, bot, invariants); `formatProfile(s)` prints it.
- Inspect one match without writing a test:
  ```bash
  INSPECT=1 QA_MAP=meilahti QA_DIFF=hard QA_BOT=strong QA_MINUTES=12 QA_SEED=3 QA_BOTLOG=1 npx vitest run tests/integration/inspect.test.ts --silent=false
  INSPECT=1 QA_MODE=campaign QA_MISSION=m2 QA_MINUTES=8 npx vitest run tests/integration/inspect.test.ts --silent=false
  ```
  (`QA_BOT=none` = no scripted player, `QA_AI=0` = no pathogen AI; the `QA_` prefix is needed because Vite owns `MODE`.)
- `createHospitalBot(world, { strength, overrides, log })` (`tests/helpers/hospitalBot.ts`) — a scripted hospital
  player using only `world.issue()` + public services; `bot.update()` once per tick before `world.step()`.
  Presets `weak` (10 workers, 1 Pharmacy, sanitizers/medics, attacks at 10 units after 7:00, never retreats),
  `medium` (16 workers, up to 3 Pharmacies/5 Generators, Lab + Depot, 2 turrets, weapons/armour/logistics/UV
  research, attacks at 18 units after 5:00, retreats below 35 %), `strong` (20 workers, 2–4 Pharmacies, all research,
  3 turrets, assists construction, attacks at 24). Override anything: `{ strength: 'medium', overrides: { attackArmySize: 30 } }`.
  `bot.describe()` / `bot.stats` / `bot.log` (with `log: true`) explain its decisions.

## 5. Browser — screenshots (`scripts/shot.mjs`, architect's tool)
```bash
node scripts/shot.mjs --url "/?autostart=skirmish&map=meilahti&reveal=1" --wait 4000 --out /tmp/a.png
node scripts/shot.mjs --url "/?autostart=skirmish&reveal=1&speed=4" --wait-for "window.__game.world.tick > 400" --out /tmp/b.png
node scripts/shot.mjs --url "/?autostart=campaign&mission=m1" --wait 6000 --out /tmp/m1.png --eval "window.__game.mission.objectives()"
node scripts/shot.mjs --url "/" --wait 1500 --out /tmp/menu.png --click 800,450 --wait 1500 --out /tmp/menu2.png
node scripts/shot.mjs --url "/sandbox/<area>.html" --wait 3000 --out /tmp/<area>-1.png
```
Actions run in order (`--url --wait --wait-for --eval --click --rclick --move --drag --key --out`); last line is
`SHOT-SUMMARY errors=<n> warnings=<n> shots=<files>`. URL params: `autostart=skirmish|campaign`, `mission`, `map`,
`difficulty`, `seed`, `reveal=1`, `speed`, `quality=low|medium|high`. Debug handles: `window.__app`,
`window.__game` (`world`, `issue()`, `stepOnce()`, `setSpeed()`, `ais`, `mission`, `renderer`, `ui`).

## 6. Browser — smoke test (`scripts/smoke.mjs`)
```bash
node scripts/smoke.mjs                         # ~1 min; screenshots + report.json in /tmp/smoke; exit 1 on failure
node scripts/smoke.mjs --out /tmp/s2 --seconds 20 --no-campaign --quiet
node scripts/smoke.mjs --shared                # use the shared :5173 server instead (it full-reloads on every save!)
```
By default smoke/perf start their **own private Vite server with HMR and file watching off** — the shared :5173
server full-reloads every open page whenever any agent saves, so slow boots never finish. `--shared` or an explicit
`--base <url>` (e.g. a `node scripts/quiet-vite.mjs 5197` server) overrides that. Boot waits are wait-for
conditions up to `--boot-timeout` (150 s; a meilahti boot takes 60–100 s at load 20–70).
Steps: menu renders (`window.__app`, clickable buttons) → skirmish started **through the UI** (clicks "Skirmish…",
then a Start/Launch/Play button if a setup screen appears; falls back to `?autostart=skirmish`) → ~30 s at speed 4
with a screenshot every ~10 s and `window.__game.world` sanity (ticks advanced, entities present, both players alive,
no game over) → `?autostart=campaign&mission=m1`: mission + objectives exist, dialogue and objectives panels in the DOM
(any element whose id/class/`data-testid` contains `dialog…` / `objective…`, or cast names / objective text visible).
Any page error, `console.error` or same-origin HTTP ≥ 400 fails. Last stdout line:
`SMOKE-SUMMARY ok=<bool> failures=<n> warnings=<n> ...`; the JSON report is printed just above it.
Options: `--base --out --seconds 30 --speed 4 --interval 10 --map --difficulty --seed --min-ticks 40 --expect-ticks 400
--mission m1 --boot-timeout 150 --no-campaign --no-ui --shared --quiet`. Under heavy host load the sim runs slower than real time — the
run only fails if it is essentially stalled (< `--min-ticks`), otherwise it warns and reports ticks/s, fps, host load.

## 7. Browser — performance probe (`scripts/perf.mjs`)
```bash
node scripts/perf.mjs                                   # N = 50,100,200 extra units, idle, default map
node scripts/perf.mjs --n 200 --mode fight --seconds 10 # combat + projectiles + VFX
node scripts/perf.mjs --n 300 --mode move --map meilahti --private --json /tmp/perf.json --shot /tmp/perf.png
```
Spawns N units (half per side, all unit types) with `world.spawnUnit`, then reports frame time (avg/p50/p95/max,
fps), `world.step` time (avg/p95/max, ticks/s), per-system averages (`movement`, `combat`, `orders`, ...), AI, render
(`renderer.render` JS time) and HUD time. Modes: `idle` (blocks near each base), `move` (blocks shuttle every 4 s),
`fight` (blocks meet mid-map). SwiftShader numbers are only meaningful **relative** to each other (N=50 vs 200,
before vs after a change); GPU raster time is not in `render` but shows up in frame time.

## 8. Integration watch
QA re-runs `npx vitest run --maxWorkers=2` + `node scripts/smoke.mjs` regularly and appends findings (timestamp,
module/file, exact error, repro) to `QA_LOG.md`.
