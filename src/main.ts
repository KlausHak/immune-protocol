/**
 * Entry point. URL params (for testing/screenshots):
 *   ?autostart=skirmish|campaign  &mission=m1  &difficulty=easy|normal|hard|brutal  &map=meilahti
 *   &seed=1  &reveal=1  &speed=2  &quality=low|medium|high  &as=2 (debug: play the pathogens; no AI)
 * Debug handles: window.__app, window.__game (current match: world, issue(), stepOnce(), setSpeed()).
 */
import { App } from './game/App';
import type { Difficulty } from './core/types';
import type { Quality } from './game/settings';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const app = new App(canvas, uiRoot);
(window as unknown as { __app: App }).__app = app;

const q = new URLSearchParams(location.search);
const quality = q.get('quality') as Quality | null;
if (quality) app.settings.quality = quality;
const auto = q.get('autostart');
if (auto === 'skirmish' || auto === 'campaign') {
  app.startGame({
    mode: auto,
    missionId: q.get('mission') ?? 'm1',
    mapId: q.get('map') ?? undefined,
    difficulty: (q.get('difficulty') as Difficulty | null) ?? 'normal',
    seed: q.has('seed') ? Number(q.get('seed')) : undefined,
    revealMap: q.get('reveal') === '1',
    speed: q.has('speed') ? Number(q.get('speed')) : undefined,
    debugPlayAs: q.has('as') ? Number(q.get('as')) : undefined,
  });
} else {
  app.showMenu();
}
