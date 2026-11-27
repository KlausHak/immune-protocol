# IMMUNE PROTOCOL — Outbreak at the HUS Campus

A full 3D real-time strategy game for the browser (TypeScript + three.js). The player commands the
**Hospital Defense Corps** of a fictionalised **HUS Meilahti hospital campus** (Helsinki University
Hospital) against **The Contagion** — an AI-driven outbreak of viruses, bacteria and fungi trying to
overrun the campus. Classic RTS mechanics: workers gather, base building, supply cap, tech tree,
production queues, upgrades, micro-control, fog of war, minimap, an opponent AI, and a 3-mission
campaign on the campus map plus skirmish.

## 0. Originality (hard rule)
We borrow **genre mechanics only**. No names, units, factions, art, UI look, music, sounds, maps or
story from StarCraft or any other existing game. Our identity is our own: clean medical-tech vs.
glowing, translucent micro-biology. Do **not** use the Red Cross emblem (a protected emblem): medical
symbols are a **white plus on teal**, a **green pharmacy cross**, or the hospital's own teal "+" logo.

## 1. Factions (data: `src/data/*.ts` — single source of truth for ids & stats)
| | Hospital Defense Corps (player) | The Contagion (AI) |
|---|---|---|
| Resources (sim key) | Supplies (`matter`), Power (`energy`) | Biomass (`matter`), Toxin (`energy`) |
| Population | Beds | Colony |
| Worker | Orderly Bot `hosp_orderly` | Spore Drone `path_spore_drone` |
| HQ (5×5) | Central Hospital `hosp_hq` (+10 pop, +0.25 energy/s, dropoff, Emergency Supply ability) | Infection Core `path_hive` (+10 pop, regen) |
| Pop building (2×2) | Patient Ward `hosp_ward` +8 | Spore Nest `path_nest` +8 |
| Energy building (2×2) | Backup Generator `hosp_generator` +0.6/s | Fermentation Vat `path_fermenter` +0.6/s |
| Tier-1 production (3×3) | Pharmacy `hosp_pharmacy`: Sanitizer, Field Medic, UV Lancer* | Replication Pod `path_replicator`: Phage, Bacillus Brute, Spirochete Lasher* |
| Research (3×3) | Research Lab `hosp_lab` | Mutation Pit `path_mutation_pit` |
| Tier-2 production (4×4) | Ambulance Depot `hosp_vehicle_bay`: Antibiotic Launcher, Macrophage Mech, Sterilizer Drone (air) | Biofilm Spire `path_biofilm_spire`: Fungal Mortar, Superbug, Influenza Drifter (air) |
| Defence (2×2) | UV Turret `hosp_uv_turret` | Toxin Spitter `path_toxin_spitter` |
| Wall (2×2) | Quarantine Barricade `hosp_barricade` | — |
| Special | `obj_childrens_hospital` (6×6 campaign objective) | `path_strain_omega` (campaign boss) |

Asymmetry: pathogens are cheaper, faster, regenerate (`hpRegen`); hospital units have range,
healing (Field Medic heals bio **and** mech units), repair (Orderlies repair mech units & structures)
and damage-type counters (UV ↔ viral, antibiotic ↔ bacterial). Superbug resists antibiotics.

## 2. Rules
* **Tick:** fixed 20 Hz (`TICK_DT = 0.05`). The renderer interpolates `prevPos → pos` with `alpha`.
* **Damage:** `dealt = max(0.5, raw × resist[type] − armor)`, `raw = (weapon.damage + Σ bonus[tag]) ×
  attacker.stats.damageMul (+ damageAdd)`. Splash falls off linearly to 50% at the edge. Friendly
  fire off. Ranges are **edge-to-edge** — always use `world.edgeDistance(a, b)` (buildings use their
  rectangular footprint).
* **Targets:** weapons list `targets: ['ground','air']`. Air units ignore terrain and buildings.
* **Auto-acquire:** idle armed units engage enemies within `sight`; target priority: units that can
  attack > other units > structures; prefer closest / already-damaged; workers are low priority.
* **Economy:** workers carry 5 matter per trip from Supply Caches (2×2 neutral nodes, 1500 each) to
  a drop-off (HQ). ~2 workers per cache is efficient; more queue. Energy is passive income.
  Pop cap max 150. Production queues max 5; cancel = full refund; cancelling construction refunds 75%.
* **Construction:** worker walks to site, foundation is placed (cost paid) and the worker stays to
  construct (hp grows with progress). Extra workers can assist (`construct` order) for speed.
* **Defeat (skirmish):** a player with no buildings is defeated. Campaign missions set their own rules.
* **Fog of war:** unexplored = black, explored = dimmed (buildings remembered), visible = clear.
  High ground: units on a lower level cannot see up a cliff unless a unit is on that level.
* **Upgrades** apply via `entity.stats` (never read `def` stats directly in systems).

## 3. Controls (implemented by `src/input` + camera in `src/render/core`)
* Left-click select · drag box-select (own units preferred over buildings) · Shift add/remove ·
  Ctrl-click / double-click selects all of that type on screen · Tab cycles subgroup.
* Right-click: smart command (move / attack / gather / return / construct / repair / follow /
  set rally when a building is selected). Shift queues.
* Command hotkeys: **A** attack-move (then click), **M** move, **S** stop, **H** hold, **P** patrol,
  **G** gather, **C** return cargo, **R** repair, **B** build menu, **V** advanced build menu,
  **Esc** cancel/back/pause menu. Building card: unit/upgrade hotkeys from data (`hotkey`).
* Control groups: **Ctrl+1–9** assign, **1–9** select, double-tap to centre camera. **F1** idle
  worker, **Backspace** cycle bases, **Space** jump to last alert, **F10** menu.
* Camera: arrow keys, screen-edge scroll, middle-drag pan, wheel zoom, **Alt+wheel** / **Alt+middle-drag**
  rotate, minimap click/drag. Game speed **+ / −** (skirmish).

## 4. Screen layout (DOM over the canvas)
Top bar: resources (icon + value, red flash on "not enough"), pop, game time, menu button.
Bottom: **minimap** (left), **selection panel** (centre: portrait/stats for one, grid for many,
production queue with progress & cancel, construction %), **command card** (right, 5×3 grid,
hotkey letter in the corner, cost tooltip). Left side: objectives panel (campaign). Centre-top:
mission timer. Dialogue box (portrait + name + typed text) above the bottom panel. Alerts list
top-left. Style: dark glass panels, teal accents (hospital), crisp sans-serif, subtle ECG-line motif.

## 5. Campaign: "Code Red: Meilahti" (map `meilahti`)
Cast: **Dr. Aino Virtanen** (Chief Medical Officer, portrait `cmo`), **SISU** (the campus defence
AI, `sisu`), **Lt. Joonas Mäkelä** (paramedic team leader, `paramedic`), **Chief Engineer Leena
Korhonen** (`engineer`), **Strain Omega** (`omega`, glitchy text).
1. **M1 "Patient Zero"** (nordic_dusk, tutorial-paced). Start: Central Hospital + 6 Orderlies + 4
   Sanitizers, 200 Supplies. Enemy: Infection Core at `enemy_core` with nests, a Replication Pod and
   Toxin Spitters; AI `attack:false` (defends/builds), scripted waves from `wave_spawn_north` /
   `wave_spawn_east` at ~2:30, 5:00, 7:30 (difficulty-scaled). Objectives (sequential, with
   dialogue + hints): gather 300 Supplies → build a Patient Ward and a Pharmacy → train 6 Sanitizers
   → survive the first wave → **destroy the Infection Core**. Bonus: reach `paramedic_station` to
   rescue Lt. Mäkelä's team (+2 Field Medics, +3 Sanitizers). Lose if the Central Hospital falls.
2. **M2 "Containment Breach"** (night). Full AI with attacks. Destroy the satellite cores at
   `enemy_east_nest` and `enemy_west_nest`, then the main core, before the 20:00 contamination
   timer expires. Bonus: keep the Research Lab alive.
3. **M3 "Strain Omega"** (nordic_dusk). Protect the Children's Hospital (`obj_childrens_hospital`
   at region `childrens_hospital`); at ~6:00 **Strain Omega** emerges at `omega_spawn` and marches on
   it with escorts. Win: destroy Strain Omega and the Infection Core. Lose: Children's Hospital or
   Central Hospital destroyed.

## 6. Map `meilahti` — the HUS Meilahti campus (fictionalised), ~128×128 tiles, north = −y
* **West:** the sea bay (water, shoreline rocks, reeds, a pier) — impassable; air units can cross.
* **South-east:** player start — Central Hospital site at `player_start` on the ER plaza; logistics
  dock with 6–8 Supply Caches; helipad; ambulances. Natural expansion at the **parking garage**
  (east, raised level with ramps).
* **Centre:** the main hospital complex — large non-playable blocks (`hospital_tower`,
  `hospital_wing`, `research_lab` "Biomedicum", `skybridge`) with roads/plazas between them forming
  2–3 lanes and chokepoints; birch park in the south-west with `paramedic_station`; open flat site
  `childrens_hospital` (≥ 8×8 buildable) west of centre.
* **North:** the old laundry & waste plant (`old_laundry`, `water_tower`), contaminated ground —
  pathogen main base on a raised plateau (`enemy_core`, `enemy_start`) with 2 ramps; satellite
  sites `enemy_east_nest` (sewer outflow, NE) and `enemy_west_nest` (waste depot, W), each with caches.
* Required **regions**: `player_base`, `player_natural`, `enemy_core`, `enemy_natural`,
  `enemy_east_nest`, `enemy_west_nest`, `childrens_hospital`, `paramedic_station`, `center`,
  `north_gate`, `east_gate`. Required **points**: `player_start`, `enemy_start`, `wave_spawn_north`,
  `wave_spawn_east`, `wave_spawn_west`, `omega_spawn`, `rally_center`, `helipad`,
  `east_nest_core`, `west_nest_core` (Infection Core centres for M2), `childrens_hospital_center`.
* Slots: 1 = hospital at `player_start`, 2 = pathogen at `enemy_start` (skirmish uses these).
* Every start/expansion must be reachable by ground; keep chokepoints ≥ 4 tiles wide.

### Doodad nominal sizes (footprint w×h tiles at scale 1, height in units; model forward = +X = w)
hospital_tower 14×10 h14 · hospital_wing 12×6 h6 · childrens_hospital 6×6 h5 · research_lab 10×8 h7 ·
parking_garage 12×10 h4 · old_laundry 10×8 h6 (chimney) · water_tower 3×3 h10 · skybridge 8×2 h4 ·
ambulance 2×1 · car 2×1 · bus 4×1 · helicopter_pad 4×4 (flat, walkable) · street_lamp 1×1 h3.5 ·
bench 1×1 · bus_stop 2×1 · traffic_cone ≤0.4 (walkable) · barrier 2×1 · fence 2×0.3 · sign_er 1×1 ·
dumpster 2×1 · flag_pole 1×1 h6 · tree_birch 1×1 h5 · tree_pine 1×1 h6 · bush (walkable) ·
rock_granite 2×2 · snow_pile (walkable) · reeds (walkable) · pier 2×6 · biohazard_barrel 1×1 ·
goo_puddle (walkable) · sewer_grate (walkable, flat) · infected_growth 2×2 · spore_vent 1×1 ·
waste_container 2×1.

## 7. Art direction
* **Style:** stylised, clean low-poly with soft PBR (MeshStandard/Physical), strong silhouettes
  readable from an RTS camera (~35 units away, 45° FOV, ~56° pitch). Emissive accents + bloom.
* **Hospital:** ivory/white panels, brushed steel, glass with cyan emissive, **team colour (teal)**
  stripes, white "+" / green pharmacy-cross emblems, UV-violet emitters. Buildings: modern
  Nordic hospital architecture, flat roofs, glazing, rooftop HVAC, lit windows.
* **Pathogens:** organic & translucent — fresnel rim glow, pulsing nuclei, spikes (virus capsids),
  flagella, membranes; **team colour (magenta/purple)** + acid-green accents; buildings are mounds,
  sacs, vents and spires with veins; contaminated ground around them.
* **World:** late-autumn **Nordic dusk** — low warm sun, long shadows, cool blue ambient, light snow
  patches, birches, granite, dark sea; warm lit windows and street lamps.
* **Scale:** 1 unit = 1 tile. Infantry ≈ 1.2 tall (radius 0.4), mechs ≈ 2.5, buildings fill their
  footprint (2×2 ≈ 2–2.5 tall, 5×5 HQ ≈ 5–6 tall).
* **Performance budget:** 60 fps with ~200 units on a mid laptop iGPU. Share geometries & materials
  per def (build once, cache, instance per entity); ≤ 6 meshes per unit model; merge static parts
  (`BufferGeometryUtils.mergeGeometries`); InstancedMesh for repeated props; one shadow-casting sun.

## 8. Audio direction
Fully procedural WebAudio (no external files): crisp medical-tech UI blips; spray hiss, UV hum-zap,
antibiotic "thunk" + glass pop; squelchy organic pathogen sounds; construction ratchets; alarm
chimes for "under attack"; ambient campus wind/sea; adaptive music (calm → tension → battle) built
from synth pads + pulse/ECG motif. Announcer lines via short tonal stingers + text (optional
speechSynthesis, off by default for voice volume 0).

## 9. Architecture
```
src/core/      types.ts (sim contracts) · ui.ts (GameUi/CameraApi) · events · math · rng · stats · terrain
src/data/      units · buildings · upgrades · abilities · factions · index (registries/helpers)
src/sim/       World.ts (entity store, tick pipeline, commands→orders) · services.ts (interfaces)
               stubs.ts (functional fallbacks) · spatial.ts · setup.ts (createWorld, skirmish start)
  movement/    nav grid, A*/flow fields, steering & collision, vision/fog       [movement agent]
  combat/      weapons, projectiles, damage, healing, abilities, unit AI        [combat agent]
  economy/     gather, build, construct, repair, train, research, pop, income   [economy agent]
src/ai/        pathogen opponent AI (createAi)                                  [AI agent]
src/map/       map registry + meilahti campus map (+ test map)                  [map agent]
src/campaign/  mission runner, triggers, objectives, missions m1–m3             [campaign agent]
src/render/core/        GameRenderer, RTS camera, entity views, picking, selection, health bars [render-core]
src/render/environment/ terrain, water, sky, lighting presets, doodads, decals, fog overlay    [environment]
src/render/models/      hospital/ [hospital artist] · pathogen/ [pathogen artist] · index.ts (registry)
src/render/vfx/         projectiles, beams, particles, impacts, deaths                         [vfx]
src/ui/        Hud (GameUi), MainMenu, icons, minimap, styles                   [HUD agent]
src/input/     Controls: selection, commands, hotkeys, groups, command card     [controls agent]
src/audio/     AudioEngine                                                      [audio agent]
src/game/      App (menus↔matches), Game (match loop), headless.ts, contracts, settings [architect]
tests/<area>/  vitest (node) · scripts/shot.mjs (browser screenshots) · sandbox/<area>.html (visual testbeds)
```
**Tick pipeline** (`World.step`, systems by order): 0 snapshot → 5 cooldowns → 10 commands →
20 orders (per-unit handlers; idle → `world.idleBehavior`) → 25 spatial rebuild → 30 movement →
40 combat → 50 economy → 60 vision → 80 regen → 90 rules → 100 cleanup. Per frame in the browser:
`ai.update → mission.update → world.step` (×N ticks), then `controls.update → renderer.render(alpha)
→ hud.update → audio.update`.

**Plug-in points:** a module's `install*(world)` overwrites its services (`world.movement`,
`world.vision`, `world.combat`, `world.abilities`, `world.economy`, optionally `world.spatial`),
registers order handlers (`world.orderHandlers[type]`) and systems (`world.addSystem({name, order,
update})` — same name replaces the stub). Commands (human, AI, scripts) all go through
`world.issue(cmd)`; per-unit state lives in `entity.orders`. Module-private per-entity data goes in
`entity.ext.<module>`. Events: `world.events.on(type, fn)` (see `GameEvents`). Deaths:
`world.killEntity(e, killer)` (emits `entityDied` immediately; `entityRemoved` at end of tick).
Damage reporting for alerts: `world.reportDamage(...)` inside `combat.applyDamage`.

**Coordinates:** sim `Vec2 {x, y}` on the ground, 1 unit = 1 tile; three.js `(x, height, y)`;
facing 0 = +x, `root.rotation.y = -facing`; model forward = +X. Heights: `sampleHeight(map, x, y)`.

**Headless rule:** everything under `src/core`, `src/data`, `src/sim`, `src/ai`, `src/map`,
`src/campaign` must run in Node (no DOM, no three.js). Use `world.rng` — never `Math.random()` — in
the sim/AI/campaign so runs are reproducible.

## 10. Engineering rules for all agents
1. **Own your folder.** Create/edit only files in your area (see table above and your brief). Shared
   files (`src/core/**`, `src/sim/World.ts`, `services.ts`, `stubs.ts`, `setup.ts`, `src/data/**`,
   `src/game/**`, `src/render/models/index.ts|types.ts`, configs) are read-only — except a tiny,
   *additive* change when truly blocked (re-read the file right before editing, add OPTIONAL fields
   only, mark with `// [your-area]`), listed in your final report.
2. **Never** modify `package.json`/lockfile, install packages, run `git commit`/`git stash`/
   `git checkout`, or delete other people's files. Available: `three` (+ `three/examples/jsm/*`
   addons), TypeScript, Vite, Vitest, playwright-core.
3. **Keep the build green.** `npx tsc --noEmit -p .` must show no errors in your files (filter:
   `npx tsc --noEmit -p . 2>&1 | grep src/<your-area>`). Other agents are editing concurrently —
   ignore their transient errors; never "fix" their files.
4. **Tests:** `npx vitest run tests/<your-area>` (node env). Sim/AI/map/campaign need real tests.
   Use the `test` map (`createHeadlessMatch({ mapId: 'test' })` from `src/game/headless.ts`).
5. **Look at your work.** A shared dev server runs at http://localhost:5173 (if it's down,
   `scripts/shot.mjs` starts a private one). Visual agents build a testbed page
   `sandbox/<area>.html` + `sandbox/<area>.ts` and screenshot it:
   `node scripts/shot.mjs --url /sandbox/<area>.html --wait 3000 --out /tmp/<area>-1.png`, then view the
   PNG with the Read tool. The full game: `/?autostart=skirmish&map=meilahti&reveal=1`. Debug handle
   `window.__game` (world, issue(), stepOnce(), setSpeed()). Use one browser at a time, keep
   sessions short (the machine has 4 CPUs shared by 15 agents). Put screenshots in `/tmp`.
6. **Quality bar:** this ships as a complete game. Robust code (no crashes on dead/removed entities,
   empty selections, missing models), readable, typed, commented where non-obvious. Performance
   matters (see budgets). No placeholder "TODO" behaviour in your area when you finish.
7. **Final report** (your last message, ≤ 350 words): what you built, public API/contract notes,
   files, verification evidence (tsc, tests, screenshot paths), known issues, requests to others.
