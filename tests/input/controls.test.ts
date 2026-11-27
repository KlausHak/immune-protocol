/**
 * Headless test of the Controls event flows: a minimal fake DOM (Node's EventTarget as window / canvas) and a
 * fake renderer with a linear screen↔world mapping (10 px = 1 tile, no camera), driving a real headless match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Entity, EntityId, Vec2 } from '../../src/core/types';
import type { GameContext } from '../../src/game/contracts';
import { createHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';
import { Controls } from '../../src/input/Controls';

const PX = 10; // pixels per tile

interface Harness {
  m: HeadlessMatch;
  game: GameContext & { paused: boolean; speed: number };
  controls: Controls;
  canvas: EventTarget & { style: Record<string, string> };
  issued: Command[];
  looks: Vec2[];
  ghosts: Array<{ defId: string; tile: { x: number; y: number }; valid: boolean } | null>;
  markers: string[];
  hovers: Array<EntityId | null>;
  rendered: Array<readonly EntityId[]>;
  pauses: number;
  notes: string[];
  feedback: Array<{ kind: string; message: string }>;
  elements: Array<{ removed: boolean }>;
  screen(e: Entity | Vec2): { x: number; y: number };
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};

function harness(mode: 'skirmish' | 'campaign' = 'skirmish'): Harness {
  const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 4 });
  const world = m.world;
  world.vision.revealAll(1, true);
  m.step();
  const elements: Array<{ removed: boolean }> = [];
  const root = { appendChild: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  g.window = new EventTarget();
  g.document = {
    getElementById: (id: string) => (id === 'ui-root' ? root : null),
    createElement: () => { const el = { style: {} as Record<string, string>, className: '', removed: false, setAttribute() {}, remove() { el.removed = true; } }; elements.push(el); return el; },
    activeElement: null,
    body: root,
  };
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: world.map.width * PX, clientHeight: world.map.height * PX, style: {} as Record<string, string>, parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  const visible = (e: Entity) => e.alive && (e.owner === 1 || world.vision.isEntityVisible(1, e));
  const h = {} as Harness;
  Object.assign(h, { m, issued: [], looks: [], ghosts: [], markers: [], hovers: [], rendered: [], pauses: 0, notes: [], feedback: [], elements, canvas });
  const renderer = {
    three: { domElement: canvas },
    cameraCtl: { lookAt: (p: Vec2) => h.looks.push({ ...p }), panTo() {}, getTarget: () => ({ x: 0, y: 0 }), getViewPolygon: () => [], shake() {} },
    screenToGround: (sx: number, sy: number) => (sx < 0 || sy < 0 || sx > canvas.clientWidth || sy > canvas.clientHeight ? null : { x: sx / PX, y: sy / PX }),
    worldToScreen: (p: Vec2) => ({ x: p.x * PX, y: p.y * PX, visible: true }),
    pickEntity: (sx: number, sy: number) => {
      let best: Entity | null = null, bd = Infinity;
      for (const e of world.list) {
        if (!visible(e)) continue;
        const d = Math.hypot(e.pos.x - sx / PX, e.pos.y - sy / PX);
        if (d <= e.radius + 0.3 && d < bd) { bd = d; best = e; }
      }
      return best;
    },
    entitiesInScreenRect: (x0: number, y0: number, x1: number, y1: number) => world.list.filter((e) => visible(e)
      && e.pos.x * PX >= Math.min(x0, x1) && e.pos.x * PX <= Math.max(x0, x1) && e.pos.y * PX >= Math.min(y0, y1) && e.pos.y * PX <= Math.max(y0, y1)),
    setSelection: (ids: readonly EntityId[]) => h.rendered.push([...ids]),
    setHover: (id: EntityId | null) => h.hovers.push(id),
    setPlacementGhost: (gh: Harness['ghosts'][number]) => h.ghosts.push(gh ? { ...gh, tile: { ...gh.tile } } : null),
    showCommandMarker: (_p: Vec2, kind: string) => h.markers.push(kind),
  };
  const game = {
    world, map: world.map, localPlayerId: 1, enemyPlayerId: 2, renderer,
    config: { mode, difficulty: 'normal' }, paused: false, speed: 1,
    ui: { openPauseMenu: () => { h.pauses++; }, notify: (t: string) => h.notes.push(t) },
    issue: (cmd: Command) => { h.issued.push(cmd); world.issue(cmd); },
    setSpeed: (s: number) => { game.speed = s; },
  } as unknown as Harness['game'];
  world.events.on('notEnough', (e) => h.feedback.push({ kind: e.kind, message: e.message }));
  h.game = game;
  h.controls = new Controls(game);
  h.screen = (e) => { const p = 'pos' in e ? e.pos : e; return { x: p.x * PX, y: p.y * PX }; };
  return h;
}

/**
 * Dispatch a mouse event. Canvas mousemove/mouseup bubble to window in a browser: the fake DOM has no tree, so
 * those go to window with `target` pinned to the canvas.
 */
function mouse(target: EventTarget, type: string, x: number, y: number, o: { button?: number; shift?: boolean; ctrl?: boolean } = {}) {
  const ev = Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button: o.button ?? 0, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, metaKey: false, altKey: false });
  const win = g.window as EventTarget;
  if (target !== win && type !== 'mousedown' && type !== 'contextmenu') {
    Object.defineProperty(ev, 'target', { value: target });
    win.dispatchEvent(ev);
  } else target.dispatchEvent(ev);
  return ev;
}
function key(k: string, o: { code?: string; shift?: boolean; ctrl?: boolean; type?: string } = {}) {
  const code = o.code ?? (k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k);
  const ev = Object.assign(new Event(o.type ?? 'keydown', { cancelable: true }), { key: k, code, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, metaKey: false, altKey: false, repeat: false });
  (g.window as EventTarget).dispatchEvent(ev);
  return ev;
}
const click = (h: Harness, x: number, y: number, o: { button?: number; shift?: boolean; ctrl?: boolean } = {}) => {
  mouse(h.canvas, 'mousedown', x, y, o);
  mouse(g.window as EventTarget, 'mouseup', x, y, o);
};
const drag = (h: Harness, x0: number, y0: number, x1: number, y1: number, shift = false) => {
  mouse(h.canvas, 'mousedown', x0, y0, { shift });
  mouse(h.canvas, 'mousemove', (x0 + x1) / 2, (y0 + y1) / 2, { shift });
  mouse(h.canvas, 'mousemove', x1, y1, { shift });
  mouse(g.window as EventTarget, 'mouseup', x1, y1, { shift });
};
const hover = (h: Harness, x: number, y: number) => { mouse(h.canvas, 'mousemove', x, y); h.controls.update(0.016); };

/** Controlled clock for double-click / double-tap timing (performance.now, ms). */
let now = 1_000_000;
const later = (ms = 1000) => { now += ms; };

beforeEach(() => {
  saved = { window: g.window, document: g.document };
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { g.window = saved.window; g.document = saved.document; vi.restoreAllMocks(); });

describe('Controls (headless DOM)', () => {
  it('click / box / shift / ctrl selection, enemies inspected alone', () => {
    const h = harness();
    const w = h.m.world;
    const workers = w.entitiesOf(1, (e) => !!e.gatherer);
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    // box around the whole base: units preferred over the HQ
    drag(h, (hq.pos.x - 12) * PX, (hq.pos.y - 12) * PX, (hq.pos.x + 12) * PX, (hq.pos.y + 12) * PX);
    expect([...h.controls.selection.ids].sort()).toEqual(workers.map((e) => e.id).sort());
    expect(h.rendered.at(-1)!.length).toBe(workers.length);
    // click on the HQ selects it alone; shift-click a worker adds it, again removes it
    const hs = h.screen(hq);
    click(h, hs.x, hs.y);
    expect(h.controls.selection.ids).toEqual([hq.id]);
    const ws = h.screen(workers[0]!);
    later();
    click(h, ws.x, ws.y, { shift: true });
    expect([...h.controls.selection.ids].sort()).toEqual([hq.id, workers[0]!.id].sort());
    later();
    click(h, ws.x, ws.y, { shift: true });
    expect(h.controls.selection.ids).toEqual([hq.id]);
    // ctrl-click a worker: all workers on screen
    later();
    click(h, ws.x, ws.y, { ctrl: true });
    expect(h.controls.selection.ids.length).toBe(workers.length);
    // double-click (two clicks within 0.3 s) does the same
    later();
    click(h, hs.x, hs.y);
    later();
    click(h, ws.x, ws.y);
    expect(h.controls.selection.ids).toEqual([workers[0]!.id]);
    later(200);
    click(h, ws.x, ws.y);
    expect(h.controls.selection.ids.length).toBe(workers.length);
    later();
    // a box with only buildings selects the buildings; an empty box clears
    drag(h, (hq.pos.x - 1) * PX, (hq.pos.y - 1) * PX, (hq.pos.x + 1) * PX, (hq.pos.y + 1) * PX);
    expect(h.controls.selection.ids).toEqual([hq.id]);
    drag(h, 450, 450, 500, 500);
    expect(h.controls.selection.ids).toEqual([]);
    // enemy: clicking shows it; shift-clicking it into an own selection is ignored
    const hive = w.entitiesOf(2, (e) => e.defId === 'path_hive')[0]!;
    const es = h.screen(hive);
    click(h, es.x, es.y);
    expect(h.controls.selection.ids).toEqual([hive.id]);
    expect(h.controls.getCommandCard()).toEqual([]);
    click(h, hs.x, hs.y);
    click(h, es.x, es.y, { shift: true });
    expect(h.controls.selection.ids).toEqual([hq.id]);
    // clicking empty ground clears
    click(h, 450, 300);
    expect(h.controls.selection.ids).toEqual([]);
  });

  it('right click: smart command with markers; producers get a rally point', () => {
    const h = harness();
    const w = h.m.world;
    const worker = w.entitiesOf(1, (e) => !!e.gatherer)[0]!;
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    const cache = w.list.find((e) => e.kind === 'resource')!;
    const hive = w.entitiesOf(2, (e) => e.defId === 'path_hive')[0]!;
    click(h, h.screen(worker).x, h.screen(worker).y);
    click(h, h.screen(cache).x, h.screen(cache).y, { button: 2 });
    expect(h.issued.at(-1)).toMatchObject({ type: 'smart', unitIds: [worker.id], targetId: cache.id, queue: false });
    expect(h.markers.at(-1)).toBe('gather');
    click(h, 500, 300, { button: 2, shift: true });
    expect(h.issued.at(-1)).toMatchObject({ type: 'smart', target: { x: 50, y: 30 }, queue: true });
    expect(h.markers.at(-1)).toBe('move');
    click(h, h.screen(hive).x, h.screen(hive).y, { button: 2 });
    expect(h.markers.at(-1)).toBe('attack');
    // HQ selected → rally
    click(h, h.screen(hq).x, h.screen(hq).y);
    click(h, h.screen(cache).x, h.screen(cache).y, { button: 2 });
    expect(h.issued.at(-1)).toMatchObject({ type: 'setRally', buildingIds: [hq.id], targetId: cache.id });
    expect(h.markers.at(-1)).toBe('rally');
    h.m.step();
    expect(hq.rally?.targetId).toBe(cache.id);
  });

  it('card hotkeys train from the HQ; X cancels; Shift-less repeat is ignored', () => {
    const h = harness();
    const w = h.m.world;
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    click(h, h.screen(hq).x, h.screen(hq).y);
    expect(key('o').defaultPrevented).toBe(true);
    key('o');
    h.m.step();
    expect(hq.production!.queue.length).toBe(2);
    key('x');
    h.m.step();
    expect(hq.production!.queue.length).toBe(1);
    // a key that is not on the card is left alone
    expect(key('q').defaultPrevented).toBe(false);
    // arrow keys always belong to the camera
    expect(key('ArrowLeft').defaultPrevented).toBe(false);
  });

  it('build menu → placement ghost → build, with instant feedback; Esc chain → pause menu', () => {
    const h = harness();
    const w = h.m.world;
    const worker = w.entitiesOf(1, (e) => !!e.gatherer)[0]!;
    click(h, h.screen(worker).x, h.screen(worker).y);
    key('b');
    expect(h.controls.menu).toBe('build');
    key('w');
    expect(h.controls.mode).toBe('placing');
    // ghost follows the cursor, snapped to the footprint grid
    hover(h, 305, 655);
    expect(h.ghosts.at(-1)).toEqual({ defId: 'hosp_ward', tile: { x: 30, y: 65 }, valid: true });
    expect(h.canvas.style.cursor).toMatch(/copy$/);
    // invalid site (pond) → red ghost, invalid cursor, click gives feedback and builds nothing
    hover(h, 220, 480);
    expect(h.ghosts.at(-1)!.valid).toBe(false);
    expect(h.canvas.style.cursor).toMatch(/not-allowed$/);
    mouse(h.canvas, 'mousedown', 220, 480); mouse(g.window as EventTarget, 'mouseup', 220, 480);
    expect(h.feedback.at(-1)!.kind).toBe('placement');
    expect(h.issued.filter((c) => c.type === 'build')).toEqual([]);
    // unaffordable → instant notEnough, still placing
    w.player(1).resources.matter = 10;
    hover(h, 305, 655);
    mouse(h.canvas, 'mousedown', 305, 655); mouse(g.window as EventTarget, 'mouseup', 305, 655);
    expect(h.feedback.at(-1)).toEqual({ kind: 'matter', message: 'Not enough Supplies' });
    expect(h.controls.mode).toBe('placing');
    // affordable → build issued, back to normal mode + root card
    w.player(1).resources.matter = 500;
    mouse(h.canvas, 'mousedown', 305, 655); mouse(g.window as EventTarget, 'mouseup', 305, 655);
    expect(h.issued.at(-1)).toMatchObject({ type: 'build', defId: 'hosp_ward', tile: { x: 30, y: 65 }, unitIds: [worker.id] });
    expect(h.markers.at(-1)).toBe('build');
    expect(h.controls.mode).toBe('normal');
    expect(h.controls.menu).toBe('root');
    expect(h.ghosts.at(-1)).toBeNull();
    // shift-placing stays in placement; the planned site is now blocked; releasing Shift ends placement
    key('b'); key('w');
    hover(h, 355, 655);
    mouse(h.canvas, 'mousedown', 355, 655, { shift: true }); mouse(g.window as EventTarget, 'mouseup', 355, 655, { shift: true });
    expect(h.controls.mode).toBe('placing');
    h.controls.update(0.016);
    expect(h.ghosts.at(-1)).toMatchObject({ tile: { x: 35, y: 65 }, valid: false });
    key('Shift', { type: 'keyup', code: 'ShiftLeft' });
    expect(h.controls.mode).toBe('normal');
    // Esc chain: cancel mode → close sub-menu → pause menu
    key('b'); key('g');
    expect(h.controls.mode).toBe('placing');
    key('Escape');
    expect(h.controls.mode).toBe('normal');
    expect(h.controls.menu).toBe('build');
    key('Escape');
    expect(h.controls.menu).toBe('root');
    expect(h.pauses).toBe(0);
    key('Escape');
    expect(h.pauses).toBe(1);
    key('F10');
    expect(h.pauses).toBe(2);
  });

  it('targeting: A-click attack-move / attack, Shift keeps the mode, right click cancels', () => {
    const h = harness();
    const w = h.m.world;
    const san = [w.spawnUnit('hosp_sanitizer', 1, { x: 30, y: 60 }), w.spawnUnit('hosp_sanitizer', 1, { x: 31, y: 60 })];
    const drone = w.spawnUnit('path_spore_drone', 2, { x: 40, y: 50 });
    h.m.step();
    drag(h, 290, 590, 320, 610);
    expect([...h.controls.selection.ids].sort()).toEqual(san.map((e) => e.id).sort());
    key('a');
    expect(h.controls.mode).toBe('targeting');
    expect(h.controls.getCommandCard().find((b) => b.id === 'cmd.attack')!.active).toBe(true);
    hover(h, 600, 300);
    expect(h.canvas.style.cursor).toMatch(/crosshair$/);
    mouse(h.canvas, 'mousedown', 600, 300); mouse(g.window as EventTarget, 'mouseup', 600, 300);
    expect(h.issued.at(-1)).toMatchObject({ type: 'attackMove', target: { x: 60, y: 30 }, queue: false });
    expect(h.controls.mode).toBe('normal');
    expect(h.controls.selection.ids.length).toBe(2); // the click did not change the selection
    // attack a unit, shift-queued twice, then release Shift
    key('a');
    mouse(h.canvas, 'mousedown', 400, 500, { shift: true }); mouse(g.window as EventTarget, 'mouseup', 400, 500, { shift: true });
    expect(h.issued.at(-1)).toMatchObject({ type: 'attack', targetId: drone.id, queue: true });
    expect(h.controls.mode).toBe('targeting');
    mouse(h.canvas, 'mousedown', 700, 700, { shift: true }); mouse(g.window as EventTarget, 'mouseup', 700, 700, { shift: true });
    expect(h.issued.at(-1)).toMatchObject({ type: 'attackMove', queue: true });
    key('Shift', { type: 'keyup', code: 'ShiftLeft' });
    expect(h.controls.mode).toBe('normal');
    // move / patrol, right click cancels without issuing
    key('m');
    const n = h.issued.length;
    click(h, 500, 500, { button: 2 });
    expect(h.controls.mode).toBe('normal');
    expect(h.issued.length).toBe(n);
    key('p');
    click(h, 500, 520);
    expect(h.issued.at(-1)).toMatchObject({ type: 'patrol', target: { x: 50, y: 52 } });
    // stop / hold are immediate
    key('s');
    expect(h.issued.at(-1)).toMatchObject({ type: 'stop' });
    key('h', { shift: true });
    expect(h.issued.at(-1)).toMatchObject({ type: 'hold', queue: true });
  });

  it('worker G / R targeting validates targets', () => {
    const h = harness();
    const w = h.m.world;
    const worker = w.entitiesOf(1, (e) => !!e.gatherer)[0]!;
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    const cache = w.list.find((e) => e.kind === 'resource')!;
    click(h, h.screen(worker).x, h.screen(worker).y);
    key('g');
    click(h, 600, 300); // empty ground → invalid, stay in mode
    expect(h.feedback.at(-1)!.kind).toBe('invalidTarget');
    expect(h.controls.mode).toBe('targeting');
    hover(h, h.screen(cache).x, h.screen(cache).y);
    expect(h.canvas.style.cursor).toMatch(/crosshair$/);
    click(h, h.screen(cache).x, h.screen(cache).y);
    expect(h.issued.at(-1)).toMatchObject({ type: 'gather', targetId: cache.id });
    key('r');
    click(h, h.screen(hq).x, h.screen(hq).y);
    expect(h.issued.at(-1)).toMatchObject({ type: 'repair', targetId: hq.id });
  });

  it('control groups, F1 idle worker, Backspace bases, Space alerts, Tab, speed', () => {
    const h = harness();
    const w = h.m.world;
    const workers = w.entitiesOf(1, (e) => !!e.gatherer);
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    const san = w.spawnUnit('hosp_sanitizer', 1, { x: 30, y: 60 });
    h.m.step();
    // Ctrl+1 assign, Shift+1 add, 1 recall, double-tap centres the camera
    click(h, h.screen(san).x, h.screen(san).y);
    expect(key('1', { ctrl: true }).defaultPrevented).toBe(true);
    click(h, h.screen(hq).x, h.screen(hq).y);
    key('!', { code: 'Digit1', shift: true });
    click(h, 450, 300);
    expect(h.controls.selection.ids).toEqual([]);
    key('1');
    expect([...h.controls.selection.ids].sort()).toEqual([san.id, hq.id].sort());
    expect(h.looks.length).toBe(0);
    later(500);
    key('1'); // too slow for a double-tap
    expect(h.looks.length).toBe(0);
    later(200);
    key('1');
    expect(h.looks.length).toBe(1);
    expect(h.looks[0]!.x).toBeCloseTo((san.pos.x + hq.pos.x) / 2, 5);
    // Tab cycles the active subgroup (units first)
    expect(h.controls.selection.activeSubgroup()).toBe('hosp_sanitizer');
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(h.controls.selection.activeSubgroup()).toBe('hosp_hq');
    expect(h.controls.getCommandCard()[0]!.id).toBe('train.hosp_orderly');
    // F1: idle worker
    w.setOrders(workers[1]!, []);
    key('F1');
    expect(h.controls.selection.ids).toEqual([workers[1]!.id]);
    expect(h.looks.at(-1)).toEqual(workers[1]!.pos);
    // Backspace: base
    key('Backspace');
    expect(h.controls.selection.ids).toEqual([hq.id]);
    // Space: last alert
    w.events.emit('underAttack', { playerId: 1, entity: hq, pos: { x: 12, y: 34 } });
    w.events.emit('underAttack', { playerId: 2, entity: hq, pos: { x: 90, y: 90 } });
    key(' ', { code: 'Space' });
    expect(h.looks.at(-1)).toEqual({ x: 12, y: 34 });
    // speed (skirmish)
    key('+', { code: 'Equal', shift: true });
    expect(h.game.speed).toBe(1.25);
    key('-', { code: 'Minus' });
    key('-', { code: 'Minus' });
    expect(h.game.speed).toBe(0.75);
    expect(h.notes.at(-1)).toMatch(/0\.75/);
  });

  it('pause / game over / foreign handlers / dispose', () => {
    const h = harness('campaign');
    const w = h.m.world;
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    click(h, h.screen(hq).x, h.screen(hq).y);
    // campaign: no speed keys
    key('+', { code: 'Equal' });
    expect(h.game.speed).toBe(1);
    // paused: only Esc / F10
    h.game.paused = true;
    key('o');
    click(h, 450, 300);
    expect(h.controls.selection.ids).toEqual([hq.id]);
    key('Escape');
    expect(h.pauses).toBe(1);
    h.game.paused = false;
    // events already handled by someone else are ignored
    const ev = Object.assign(new Event('keydown', { cancelable: true }), { key: 'o', code: 'KeyO', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false });
    ev.preventDefault();
    (g.window as EventTarget).dispatchEvent(ev);
    h.m.step();
    expect(hq.production!.queue.length).toBe(0);
    // dead selection is pruned on update
    const san = w.spawnUnit('hosp_sanitizer', 1, { x: 30, y: 60 });
    h.controls.selection.set([san.id]);
    w.killEntity(san);
    h.controls.update(0.016);
    expect(h.controls.selection.ids).toEqual([]);
    expect(h.controls.getCommandCard()).toEqual([]);
    // game over: input ignored
    w.endGame(1, 'test');
    key('Backspace');
    expect(h.controls.selection.ids).toEqual([]);
    // dispose removes listeners + DOM
    h.controls.dispose();
    expect(h.elements.every((e) => e.removed)).toBe(true);
    w.rules.gameOver = false;
    const n = h.issued.length;
    key('Backspace');
    click(h, h.screen(hq).x, h.screen(hq).y, { button: 2 });
    expect(h.controls.selection.ids).toEqual([]);
    expect(h.issued.length).toBe(n);
    expect(() => h.controls.update(0.016)).not.toThrow();
    expect(h.controls.getCommandCard()).toEqual([]);
  });
});
