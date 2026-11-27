# QA log — IMMUNE PROTOCOL integration watch

Maintained by the QA / test-infrastructure engineer. Each entry: timestamp (UTC, from `date`), what was run,
then observations with **module / file**, the **exact error**, and a **repro** command. Other agents' files are
never edited by QA — problems are only logged here. See `TESTING.md` for the commands.

Legend: 🔴 breaks the build/tests/game · 🟠 wrong behaviour / contract problem · 🟡 flaky / slow / cosmetic · 🟢 OK

---

## 2026-11-27 09:45 UTC — baseline (architect skeleton, commit 1bce749)
- `npx vitest run` → 2 files / 3 tests passed (0.8 s). `npx tsc --noEmit -p .` → clean.
- Dev server http://localhost:5173 up (HTTP 200).
- 🟢 Skeleton (stubs everywhere) runs headless and in the browser.

## 2026-11-27 10:05 UTC — first smoke run (harness bring-up)
- `node scripts/smoke.mjs` → menu renders (buttons "Mission 1: Patient Zero", "Skirmish (Normal)"); skirmish started
  **through the UI** (click "Skirmish (Normal)"); 1741 ticks in 30 s at speed 4 (53 ticks/s); both players alive;
  0 page errors, 0 console errors. Screenshots `/tmp/smoke/*.png`.
- 🟠 **HUD (src/ui/Hud.ts, stub)** — campaign m1: no dialogue element and no objectives panel in the DOM.
  `Hud.showDialogue` only appends a toast that is removed after 6 s; `Hud.setObjectives` is a no-op.
  Expected until the HUD agent lands. Repro: `node scripts/smoke.mjs` → `steps.campaign.dialogueEls = 0, objectiveEls = 0`.
  **Request (HUD):** give the dialogue box and objectives panel stable hooks, e.g. `data-testid="dialogue"` /
  `data-testid="objectives"` (smoke also accepts any id/class containing `dialog`/`objective`).
- 🟡 `?autostart=campaign&mission=m1` runs on map `test` (meilahti not registered yet) — `getMap('meilahti')`
  silently falls back to the test map (src/map/index.ts `getMap`).

## 2026-11-27 10:10 UTC — integration watch #1
Repo state: modified campaign, input, render core/env/models, combat, economy, ui icons; new ai/*, audio/*,
campaign/missions, input/*, map/{builder,dressing,shapes,validate}, render/core/EntityViews, sandbox/.

**vitest** `npx vitest run --maxWorkers=2` → 18 files: 15 passed, 1 failed, 2 skipped; 88 tests: 75 passed,
1 failed, 12 skipped; 25.7 s wall.
- 🟡 **combat — tests/combat/brawl.test.ts:88** `performance: 300 units fighting stay well under budget per tick`
  → `AssertionError: expected 13.446058505000002 to be less than 12` (log: `world.step avg 13.45 ms, worst 43.95 ms
  ... 161 attacking, 226 alive`). Wall-clock assertion on a shared 4-CPU box (load avg ≈ 13 at the time) — flaky
  by construction. Suggest measuring a ratio or relaxing under `process.env.CI`/load. Repro:
  `npx vitest run tests/combat/brawl.test.ts`.
- My suites: `tests/integration` 5 files passed, 2 skipped (meilahti / campaign missions / [slow] gated).

**tsc** (transient, owners mid-edit — not fixed by QA): `src/sim/movement/constants.ts(7,39): error TS1434:
Unexpected keyword or identifier.` (+10 more on line 7 — looks like prose pasted into code); earlier in the same
minute: 3× `src/ai/personality.ts`, 2× `src/ai/brain.ts`, 1× `src/audio/voices.ts`, 3× `sandbox/map.ts`.

**smoke** `node scripts/smoke.mjs` → FAIL, but environmental:
- 🟡 host load average 13.1 on 4 CPUs (several agents' Chromium sessions at once): the page reached only 70 ticks in
  30 s at speed 4 and a `page.screenshot` timed out after 30 s. Not a game bug. **Harness change:** smoke now
  hard-fails only when the sim is essentially stalled (< 40 ticks, `--min-ticks`), warns below 400 (`--expect-ticks`),
  and reports ticks/s, fps and host load.
- 🟡 campaign probe saw `window.__game` disappear mid-check (page reloaded — Vite HMR full reload when someone saves
  a file). **Harness change:** smoke/perf detect reloads and retry; `--private` starts a private HMR-free server.

## 2026-11-27 10:23 UTC — integration watch #2
Real combat, economy, movement (+ FogOfWar), AI (Brain), campaign m1–m3 and the meilahti map are now installed.

**vitest** `npx vitest run --maxWorkers=2` → 34 files: 28 passed, 4 failed, 2 skipped; 200 tests: 189 passed, 4 failed,
7 skipped; **375.7 s wall (6 min 18 s)**.
- 🟡 **suite time — tests/campaign/missions.test.ts** alone took **373 s** of the run. Everyone's full run is now
  dominated by it; suggest moving the long mission playthroughs behind a slow gate (`SLOW=1`, see
  tests/integration/full-matches.slow.test.ts for the pattern).
- 🔴 **ai — tests/ai/probe.test.ts:34** `TypeError: Unknown encoding: 59.9` (looks like a scratch/probe test; it
  also prints build logs such as `18.0 build path_nest at 71,25` to stdout). Repro: `npx vitest run tests/ai/probe.test.ts`.
- 🟠 **campaign — tests/campaign/missions.test.ts:255** `M2 Containment Breach > fails the bonus when the Research Lab
  dies, and raids it on schedule` → `AssertionError: expected 0 to be greater than 0`.
- 🟠 **input — tests/input/controls.test.ts:142** `click / box / shift / ctrl selection, enemies inspected alone` →
  `AssertionError: expected [ 18, 19, 20, 21, 22, 17 ] to deeply equal [ 17 ]`.
- 🟠 **map — tests/map/builder.test.ts:22** `bakes plateaus with a blocked one-tile cliff ring and a flat buildable
  top` → `AssertionError: expected 1 to be +0 // Object.is equality`.
- 🟢 tests/integration all green. With real movement the bot's build failures dropped to 0 and the
  `unit-in-footprint` warnings (1398 hits in m2 while movement was a stub with no `clearFootprint`) disappeared.

**smoke** 10:30 and 10:35 → aborted by my outer `timeout`: host load average 21 → **69.8** on 4 CPUs (all agents
running browsers/tests). The new MainMenu renders (`Campaign · 3 missions`, `Skirmish`, `Settings`, `How to Play`,
`Credits`). ~55 module requests showed `net::ERR_ABORTED` = in-flight requests cancelled by an HMR full reload.
**Harness change:** aborted requests are no longer counted as failures (only HTTP ≥ 400 / page errors / console errors).

## 2026-11-27 11:17 UTC — after the session resume
- tsc clean. `npx vitest run tests/integration` → 8 files passed, 2 skipped (inspect + [slow] gates); 24 tests passed;
  **71 s wall** at load ≈ 2.
- 🟢 Real AI active (`ai: phase: tech · army 27 … next wave gathering 27/10`); determinism holds (same seed → same
  summary + state hash), and seeds 5 vs 6 now **differ** (they were identical while everything was a stub).
- 🟢 Campaign m1–m3 each run 5 simulated minutes with the bot: 0 exceptions, 0 console errors, 0 invariant
  violations; m1 objectives gather → build → train → survive wave complete inside 5 min.
- 🟡 **perf — sim cost on meilahti campaign maps**: `world.step` 4.4–7.1 ms/tick (m2: orders 1.8–2.1, movement
  1.3–1.8, economy 0.9–1.2, vision 0.6–0.9, combat 0.5–0.8 ms/tick), vs 1.5–2.9 ms/tick on the test map. The m2 run
  without any scripted player is still 7.1 ms/tick, so it is the AI army + scripted forces, not the bot. At 20 Hz
  that is 14 % of the frame budget at ~100 units; owners: movement (`orders`/`movement` systems), economy.
  Repro: `INSPECT=1 QA_MODE=campaign QA_MISSION=m2 QA_MINUTES=5 QA_BOT=none npx vitest run tests/integration/inspect.test.ts --silent=false`.
  Consequence: my fast integration suite is ~55–75 s instead of < 60 s (three 5-minute meilahti missions);
  `QA_CAMPAIGN_MINUTES=2` shortens it.

## 2026-11-27 11:22–12:04 UTC — FINAL run
**tsc** `npx tsc --noEmit -p .` → 0 errors.

**vitest full** (11:29–11:37, `--maxWorkers=2`) → 50 files: 44 passed, 3 failed, 3 skipped; 278 tests: 261 passed,
1 failed, 16 skipped; 455.9 s wall.
- 🟢 The four failures from watch #2 (ai probe, campaign M2 lab raid, input selection, map plateau ring) are fixed.
- 🟡 `tests/ai/probe.test.ts`, `tests/map/zz-scratch.test.ts` → `Error: Cannot find module …` — scratch files deleted
  by their owners *during* the run (transient).
- 🟠→🟢 `tests/integration/campaign-m3.test.ts` → `pop-over-cap: player 1 (hospital) has 41 pop alive … > highest cap
  seen 26` at t = 1 s. **Cause:** m3 now pre-places a 41-pop starting army with 26 beds. That's legitimate for a
  scripted mission, so it was a harness false positive. **Fixed in the harness:** campaign mode baselines the pop limit on
  the starting forces (`popBaselineFromStart`). Re-run: `tests/integration` + `tests/core` 10 files passed, 27 tests,
  43.8 s at load ≈ 16. (Design note for campaign: the player starts supply-blocked in m3 until Wards go up — intended?)
- 🟡 **suite time**: full run 7 min 40 s, dominated by tests/campaign/missions.test.ts.

**[slow] bot (medium) vs AI**, `SLOW=1 npx vitest run tests/integration/full-matches.slow.test.ts` (11:21–11:28, 425.8 s): all
6 matches had 0 exceptions, 0 console errors and 0 invariant violations. JSON: `/tmp/immune-qa/full-*.json`.

| map | AI | result | notes |
|---|---|---|---|
| test | easy | HOSPITAL wins 9:16 | |
| test | normal | HOSPITAL wins 8:29 | |
| test | hard | HOSPITAL wins 9:36 | bot 75 kills / 17 losses; AI ended army 0, workers 0 |
| meilahti | easy | HOSPITAL wins 10:00 | |
| meilahti | normal | no result at 25:00 | 2 attacks, 1 retreat; kills 173u+20b vs losses 186u; AI has 0 workers, 0 income, 14 buildings left |
| meilahti | hard | no result at 25:00 | 3 attacks, 2 retreats; kills 183u+40b vs 193u; AI has 1 worker, 5 buildings left |
- 🟠 **ai balance**: a scripted mid-level bot beats `hard` on `test` in < 10 min, and difficulty barely changes the
  outcome or timing. Hard should at least survive the medium bot's first push.
- 🟡 **meilahti**: neither side can finish a game in 25 min. The AI keeps a dozen buildings scattered over the campus
  after its economy is dead. (My bot is also slow to hunt structures across the large map.)

**smoke** (11:54–11:59, private HMR-free server, `node scripts/smoke.mjs`) → **ok=true**, 0 page errors, 0 console errors.
The UI path works: "Skirmish – Free battle…" → "Start skirmish" → meilahti. Campaign m1 runs on meilahti with
`autoDefeat=false`; SISU's dialogue text and the objective text are visible.
- 🟡 **render perf under SwiftShader**: 0.5 fps and 1.4 ticks/s at speed 4 on meilahti (load 14); every page screenshot
  hit the 15 s timeout (now 60 s).
- 🟡 **HUD**: the dialogue was only detected through the cast name in the text. No element with `dialog…` or
  `objective…` in its id/class/`data-testid`. Request: add `data-testid="dialogue"` and `data-testid="objectives"`.
- Earlier smoke runs on the shared :5173 server failed with `Execution context was destroyed` (HMR full reloads on every
  save). smoke/perf now start a private no-HMR server by default (`--shared` to opt out), and boot waits are
  wait-for conditions up to `--boot-timeout 150`.

**perf** `node scripts/perf.mjs --n 0,100 --map test --seconds 6` (12:00, load ≈ 15) → ok, 0 errors. At N = 100 idle
units: `world.step` 11.9 ms avg / 17.3 p95 (`orders` 6.2, `movement` 5.1); AI 0.45 ms; HUD 1.4 ms;
**`renderer.render` ≈ 26 s per call**, so no frame completed in the window. These are relative numbers under extreme
load, but render-core/environment should profile the N = 100 case. The headless sim at similar counts is ≈ 1.5–3 ms/tick.
