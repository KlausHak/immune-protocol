# IMMUNE PROTOCOL — Outbreak at the HUS Campus

A 3D real-time strategy game for the browser. You command the **Hospital Defense Corps** of a
fictionalised HUS Meilahti hospital campus in Helsinki against **The Contagion**: an AI-driven outbreak
of viruses, bacteria and fungi trying to overrun the campus.

> **Status: work in progress.** Built by a team of 15 Claude agents working in parallel on one codebase,
> coordinated by an architect agent. Gameplay systems, AI, campaign, models, audio and UI are in place;
> rendering performance and balance are still being tuned.

## Features
- **Two asymmetric factions.** Hospital staff, robots and vehicles (Sanitizers, Field Medics, UV Lancers,
  Antibiotic Launchers, Macrophage Mechs, Sterilizer Drones) against fast, regenerating pathogens (Phages,
  Bacillus Brutes, Spirochetes, Fungal Mortars, Superbugs, Influenza Drifters).
- **Classic RTS economy.** Workers gather Supplies, you build Wards for beds and Generators for power,
  and climb a tech tree of production buildings, research upgrades and damage-type counters (UV vs viruses,
  antibiotics vs bacteria).
- **An opponent AI that plays by the rules.** It issues the same commands a player can, sees through the
  same fog of war, has seeded personalities (swarm / balanced / tech), adapts its army to what it has
  scouted, and has four difficulty levels.
- **Campaign "Code Red: Meilahti".** Three scripted missions with objectives, dialogue and a final boss,
  Strain Omega.
- **Skirmish** on the 128×128 HUS Meilahti campus map.
- **Save and load** in skirmish and campaign: 8 named slots with thumbnails, quicksave/quickload (F5/F9),
  an autosave every 3 minutes of game time, Continue from the main menu, and export/import as `.json` files.
  Saves are full snapshots; a test checks that a loaded game plays out exactly like the original.
- **LAN 1v1 multiplayer.** Host or join from the Multiplayer menu, pick factions (hospital or pathogens,
  mirror matches allowed), lobby chat, in-game chat and ping. Both browsers run the deterministic simulation
  and exchange only commands (lockstep, 100 ms turns); state hashes are compared every second and a desync
  is repaired automatically from a host snapshot.
- **Everything is procedural.** All 3D models, textures, particle effects, sound effects and the adaptive
  music are generated in code; there are no asset files.

## Running it
Requires Node.js 22+.

```bash
npm ci
npm run dev          # http://localhost:5173
```

Useful URL parameters: `?autostart=skirmish&map=meilahti&difficulty=normal`,
`?autostart=campaign&mission=m1`, `&reveal=1` (no fog), `&quality=low|medium|high`.

Production build (relative asset paths, so it also works behind a path-prefix proxy):

```bash
npx vite build --base ./ && npx vite preview
```

## LAN multiplayer
On the machine that hosts:

```bash
npm run lan                 # builds, serves the game + relay on 0.0.0.0:8080 and prints the LAN URLs
```

Both players open the printed address (e.g. `http://192.168.1.20:8080/`), choose **Multiplayer (LAN)**,
one hosts a room and the other joins it. The dev server (`npm run dev`) also includes the relay, so
`http://<host-ip>:5173/` works for testing too. `npm run lan:e2e` runs an automated two-browser match.

## Controls (short version)
Left-click / drag to select, right-click to move, attack or gather. **A** attack-move, **S** stop,
**H** hold, **P** patrol; on workers **B** opens the basic build menu and **V** the advanced one.
**Ctrl+1–9** assigns a control group and **1–9** selects it. **F1** selects an idle worker, **Space**
jumps to the last alert, **F5** quicksaves, **F9** quickloads, **Esc** opens the menu. Move the camera with the arrow keys, the screen edges or
middle-drag; zoom with the wheel; Alt+wheel rotates.

## Tests
```bash
npx tsc --noEmit -p .                 # type-check
npx vitest run                        # unit + integration tests (headless simulation)
SLOW=1 npx vitest run tests/integration/full-matches.slow.test.ts   # full bot-vs-AI matches
node scripts/smoke.mjs                # browser smoke test (headless Chromium)
```
See [TESTING.md](TESTING.md) for details.

## Project layout
| Path | Contents |
|---|---|
| `src/core`, `src/data` | Shared types and contracts; unit, building, upgrade and ability data |
| `src/sim` | Deterministic 20 Hz simulation: movement and fog of war, combat, economy |
| `src/ai` | The pathogen opponent AI |
| `src/map`, `src/campaign` | Map builder and the Meilahti campus; mission scripting and missions |
| `src/render` | three.js renderer, camera, environment, procedural models, VFX |
| `src/ui`, `src/input`, `src/audio` | HUD and menus, controls, procedural audio |
| `tests`, `scripts`, `sandbox` | Vitest suites, browser tools, visual testbeds for each module |

[DESIGN.md](DESIGN.md) is the full game design and architecture brief the agents built against.

## Disclaimer
The campus is a fictionalised setting inspired by the HUS Meilahti hospital area. This project is not
affiliated with or endorsed by HUS Helsinki University Hospital. Medical symbols used are a white plus on
teal and a green pharmacy cross; the protected Red Cross emblem is intentionally not used.
