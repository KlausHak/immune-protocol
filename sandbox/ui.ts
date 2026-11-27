/**
 * [ui] UI sandbox: a REAL World on the test map (createWorld + spawnMapResources + spawnSkirmishStart, no
 * renderer) with a fake GameContext — fake camera / renderer / controls that return a representative
 * command card and selection — so every HUD state can be iterated on and screenshotted quickly.
 * See sandbox/ui.html for the query flags. Debug handles: window.__hud, window.__sb.
 */
import { AudioEngine } from '../src/audio/AudioEngine';
import { TICK_DT } from '../src/config';
import type { Command, Difficulty, Entity, EntityId, MapData, TilePos, Vec2 } from '../src/core/types';
import type { CameraApi, EndScreenResult, GameUi, ObjectiveView, PortraitId } from '../src/core/ui';
import { ABILITY_DEFS, BUILDING_DEFS, UNIT_DEFS, UPGRADE_DEFS } from '../src/data';
import type { AppApi, CommandButton, ControlMode, GameContext, LaunchConfig, SelectionApi } from '../src/game/contracts';
import { DEFAULT_SETTINGS, saveSettings, type CampaignProgress, type Settings } from '../src/game/settings';
import { SaveStore } from '../src/game/saves';
import type { SaveGame, SaveMeta } from '../src/sim/save';
import type { Controls } from '../src/input/Controls';
import { getMap } from '../src/map';
import type { GameRenderer } from '../src/render/core/GameRenderer';
import { createWorld, spawnMapResources, spawnSkirmishStart } from '../src/sim/setup';
import type { World } from '../src/sim/World';
import { Hud } from '../src/ui/Hud';
import { MainMenu } from '../src/ui/MainMenu';
import { iconHtml, iconKeys } from '../src/ui/icons';
import { renderTerrain } from '../src/ui/mapRender';
import { portraitSvg } from '../src/ui/portraits';
import { ensureUiStyles } from '../src/ui/styles';

const q = new URLSearchParams(location.search);
const flag = (k: string) => q.has(k) && q.get(k) !== '0';
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const bg = document.getElementById('bg') as HTMLCanvasElement;

// ───────────────────────── app shell ─────────────────────────
const settings: Settings = { ...DEFAULT_SETTINGS, showFps: flag('fps'), quality: (q.get('quality') as Settings['quality'] | null) ?? DEFAULT_SETTINGS.quality };
const progress: CampaignProgress = { completed: (q.get('done') ?? 'm1').split(',').filter(Boolean) };
const app: AppApi = {
  settings,
  audio: new AudioEngine(settings),
  progress,
  startGame: (cfg: LaunchConfig) => console.log('[sandbox] startGame', JSON.stringify(cfg)),
  quitToMenu: () => console.log('[sandbox] quitToMenu'),
  restartGame: () => console.log('[sandbox] restartGame'),
  saveSettings: () => saveSettings(settings),
  markMissionComplete: (id: string) => { if (!progress.completed.includes(id)) progress.completed.push(id); },
  saves: new SaveStore(),
  loadGame: async (src: string | SaveGame) => { console.log('[sandbox] loadGame', typeof src === 'string' ? src : src.meta.slot); },
};


// ───────────────────────── HUD sandbox ─────────────────────────
class FakeCamera implements CameraApi {
  target: Vec2;
  constructor(t: Vec2, private map: MapData) { this.target = { ...t }; }
  lookAt(p: Vec2): void { this.target = { x: Math.max(0, Math.min(this.map.width, p.x)), y: Math.max(0, Math.min(this.map.height, p.y)) }; }
  panTo(p: Vec2): void { this.lookAt(p); }
  getTarget(): Vec2 { return { ...this.target }; }
  /** Perspective-ish trapezoid like the real RTS camera (wider at the far/top edge). */
  getViewPolygon(): Vec2[] {
    const t = this.target;
    return [{ x: t.x - 19, y: t.y - 13 }, { x: t.x + 19, y: t.y - 13 }, { x: t.x + 12, y: t.y + 9 }, { x: t.x - 12, y: t.y + 9 }];
  }
  shake(): void {}
}

class FakeSelection implements SelectionApi {
  ids: EntityId[] = [];
  private fns = new Set<(ids: readonly EntityId[]) => void>();
  constructor(private world: World) {}
  set(ids: EntityId[]): void { this.ids = [...new Set(ids)]; for (const f of this.fns) f(this.ids); }
  add(ids: EntityId[]): void { this.set([...this.ids, ...ids]); }
  remove(ids: EntityId[]): void { const r = new Set(ids); this.set(this.ids.filter((i) => !r.has(i))); }
  clear(): void { this.set([]); }
  primary(): Entity | undefined { return this.entities()[0]; }
  entities(): Entity[] { return this.ids.map((id) => this.world.getAlive(id)).filter((e): e is Entity => !!e); }
  onChange(fn: (ids: readonly EntityId[]) => void): () => void { this.fns.add(fn); return () => this.fns.delete(fn); }
}

class FakeControls {
  readonly selection: FakeSelection;
  mode: ControlMode = 'normal';
  private sub: 'root' | 'build' | 'build2' = 'root';
  constructor(private game: SandboxGame) { this.selection = new FakeSelection(game.world); this.selection.onChange(() => { this.sub = 'root'; }); }

  getCommandCard(): CommandButton[] {
    const g = this.game, w = g.world, e = this.selection.primary();
    if (!e || e.owner !== g.localPlayerId) return [];
    const me = w.player(g.localPlayerId);
    const b = (slot: number, id: string, label: string, hotkey: string, icon: string, o: Partial<CommandButton> = {}): CommandButton =>
      ({ id, label, hotkey, icon, slot, enabled: true, tooltip: '', activate: () => console.log('[sandbox] activate', id), ...o });
    const afford = (c: { matter?: number; energy?: number }) => me.resources.matter >= (c.matter ?? 0) && me.resources.energy >= (c.energy ?? 0);
    if (e.construction) return [b(14, 'cmd.cancel', 'Cancel construction', 'Esc', 'cmd.cancel', { tooltip: 'Stop construction and recover 75% of the cost.', activate: () => g.issue({ type: 'cancelConstruction', playerId: 1, buildingId: e.id }) })];
    if (e.kind === 'building') {
      const out: CommandButton[] = [];
      const def = BUILDING_DEFS[e.defId]!;
      def.trains.forEach((u, i) => {
        const ud = UNIT_DEFS[u]!;
        const missing = w.economy.missingRequirements(1, ud.requires);
        out.push(b(i, `train.${u}`, `Train ${ud.name}`, ud.hotkey, u, {
          cost: { ...ud.cost, pop: ud.pop }, time: ud.buildTime, enabled: missing.length === 0 && afford(ud.cost),
          disabledReason: missing.length ? `Requires ${missing.map((m) => BUILDING_DEFS[m]?.name ?? m).join(', ')}` : !afford(ud.cost) ? 'Not enough resources' : undefined,
          activate: () => g.issue({ type: 'train', playerId: 1, buildingId: e.id, defId: u }),
        }));
      });
      def.researches.forEach((r, i) => {
        const ud = UPGRADE_DEFS[r]!;
        const busy = me.researching.has(r) || me.upgrades.has(r);
        out.push(b(5 + i, `research.${r}`, ud.name, ud.hotkey, r, {
          cost: ud.cost, time: ud.researchTime, enabled: !busy && afford(ud.cost), disabledReason: busy ? 'Already researched or in progress' : undefined,
          activate: () => g.issue({ type: 'research', playerId: 1, buildingId: e.id, upgradeId: r }),
        }));
      });
      def.abilities.forEach((a, i) => {
        const ad = ABILITY_DEFS[a]!;
        const cd = (e.cooldowns[a] ?? 0) / Math.max(1, ad.cooldown);
        out.push(b(10 + i, `ability.${a}`, ad.name, ad.hotkey, a, { cooldown: cd, enabled: cd <= 0, disabledReason: cd > 0 ? 'Recharging' : undefined, activate: () => g.issue({ type: 'buildingAbility', playerId: 1, buildingId: e.id, abilityId: a }) }));
      });
      if (def.trains.length) out.push(b(14, 'cmd.rally', 'Set rally point', 'Y', 'cmd.rally', { tooltip: 'Newly trained units gather at the rally point.' }));
      return out;
    }
    const ud = UNIT_DEFS[e.defId]!;
    if (this.sub !== 'root' && ud.builds) {
      const list = ud.builds.filter((id) => (this.sub === 'build' ? ['hosp_hq', 'hosp_ward', 'hosp_generator', 'hosp_pharmacy', 'hosp_barricade'] : ['hosp_lab', 'hosp_vehicle_bay', 'hosp_uv_turret']).includes(id));
      const out = list.map((id, i) => {
        const bd = BUILDING_DEFS[id]!;
        const missing = w.economy.missingRequirements(1, bd.requires);
        return b(i, `build.${id}`, `Build ${bd.name}`, bd.hotkey, id, { cost: bd.cost, time: bd.buildTime, enabled: !missing.length && afford(bd.cost), disabledReason: missing.length ? `Requires ${missing.map((m) => BUILDING_DEFS[m]?.name ?? m).join(', ')}` : undefined });
      });
      out.push(b(14, 'menu.back', 'Back', 'Esc', 'menu.back', { activate: () => { this.sub = 'root'; } }));
      return out;
    }
    const out: CommandButton[] = [
      b(0, 'cmd.move', 'Move', 'M', 'cmd.move', { tooltip: 'Move to a location. Ignores enemies on the way.' }),
      b(1, 'cmd.stop', 'Stop', 'S', 'cmd.stop', { tooltip: 'Stop and cancel all orders.', activate: () => g.issue({ type: 'stop', playerId: 1, unitIds: [...this.selection.ids] }) }),
      b(2, 'cmd.hold', 'Hold position', 'H', 'cmd.hold', { tooltip: 'Stay in place and fire at enemies in range.' }),
      b(3, 'cmd.patrol', 'Patrol', 'P', 'cmd.patrol', { tooltip: 'Walk back and forth, engaging enemies.' }),
      b(4, 'cmd.attack', 'Attack-move', 'A', 'cmd.attack', { tooltip: 'Move and engage every enemy on the way.', active: flag('targeting') }),
    ];
    if (ud.gather) {
      out.push(b(5, 'cmd.gather', 'Gather', 'G', 'cmd.gather', { tooltip: 'Collect Supplies from a Supply Cache.' }));
      out.push(b(6, 'cmd.return', 'Return cargo', 'C', 'cmd.return', { tooltip: 'Bring carried Supplies to the Central Hospital.', enabled: (e.gatherer?.carrying ?? 0) > 0, disabledReason: 'Not carrying anything' }));
      out.push(b(7, 'cmd.repair', 'Repair', 'R', 'cmd.repair', { tooltip: 'Repair a damaged machine or structure.' }));
      out.push(b(10, 'menu.build', 'Build structure', 'B', 'menu.build', { tooltip: 'Basic structures.', activate: () => { this.sub = 'build'; } }));
      out.push(b(11, 'menu.build2', 'Advanced structures', 'V', 'menu.build2', { tooltip: 'Research and vehicle structures, defences.', activate: () => { this.sub = 'build2'; } }));
    }
    for (const [i, a] of ud.abilities.entries()) {
      const ad = ABILITY_DEFS[a]!;
      const cd = (e.cooldowns[a] ?? 0) / Math.max(1, ad.cooldown);
      out.push(b(10 + i, `ability.${a}`, ad.name, ad.hotkey, a, { cooldown: cd, enabled: cd <= 0, disabledReason: cd > 0 ? 'Recharging' : undefined }));
    }
    return out;
  }
  update(): void {}
  dispose(): void {}
}

class SandboxGame implements GameContext {
  readonly net = null; // [architect] multiplayer field (single-player sandbox)
  readonly app = app;
  readonly config: LaunchConfig = { mode: 'skirmish', mapId: 'test', difficulty: 'normal' as Difficulty };
  readonly world: World;
  readonly map: MapData;
  readonly localPlayerId = 1;
  readonly enemyPlayerId = 2;
  readonly settings = settings;
  readonly renderer: GameRenderer;
  readonly controls: Controls;
  ui!: GameUi;
  readonly audio = app.audio;
  readonly ais = [];
  readonly mission = null;
  paused = false;
  speed = 1;
  readonly camera: FakeCamera;
  constructor() {
    this.map = getMap('test');
    this.world = createWorld(this.map, [
      { id: 1, faction: 'hospital', team: 1, controller: 'human' },
      { id: 2, faction: 'pathogen', team: 2, controller: 'ai', difficulty: 'normal' },
    ], 1337);
    spawnMapResources(this.world);
    spawnSkirmishStart(this.world);
    this.camera = new FakeCamera(this.world.player(1).startPos, this.map);
    this.renderer = {
      cameraCtl: this.camera,
      three: { domElement: bg },
      showCommandMarker: (p: Vec2, k: string) => console.log('[sandbox] marker', k, p.x.toFixed(1), p.y.toFixed(1)),
      setSelection: () => {},
    } as unknown as GameRenderer;
    this.controls = new FakeControls(this) as unknown as Controls;
  }
  issue(cmd: Command): void { this.world.issue(cmd); }
  canSave(): boolean { return !this.world.rules.gameOver; }
  /** Sandbox: stores a metadata-only fake save so the Save/Load panels have content. */
  async saveGame(slot: string, name?: string): Promise<SaveMeta> {
    const meta: SaveMeta = { slot, name: name || `Test Grounds · ${Math.floor(this.world.time / 60)}m`, savedAt: new Date().toISOString(), mode: 'skirmish', mapId: 'test', mapName: this.map.name, difficulty: 'normal', gameTime: this.world.time, version: 1 };
    const save = { version: 1, meta, launch: { mode: 'skirmish', mapId: 'test', difficulty: 'normal', seed: 1 }, world: {}, modules: {}, ai: {}, mission: null } as SaveGame;
    await app.saves.put(save);
    return meta;
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  setSpeed(s: number): void { this.speed = s; }
  quitToMenu(): void { console.log('[sandbox] game.quitToMenu'); }
  restart(): void { console.log('[sandbox] game.restart'); }
}

function startHudSandbox(): void {
  const game = new SandboxGame();
  const w = game.world;
  const me = w.player(1);
  // a lived-in base: warm up the economy, then add structures and an army
  w.runFor(20);
  me.resources.matter = 1185; me.resources.energy = 340;
  const tile = (x: number, y: number): TilePos => ({ x, y });
  w.spawnBuilding('hosp_ward', 1, tile(25, 81), { complete: true });
  w.spawnBuilding('hosp_ward', 1, tile(28, 81), { complete: true });
  w.spawnBuilding('hosp_generator', 1, tile(25, 69), { complete: true });
  const pharmacy = w.spawnBuilding('hosp_pharmacy', 1, tile(28, 72), { complete: true });
  const lab = w.spawnBuilding('hosp_lab', 1, tile(32, 77), { complete: false });
  lab.construction!.progress = lab.construction!.total * 0.42;
  lab.hp = lab.stats.maxHp * 0.45;
  const army: Entity[] = [];
  const put = (id: string, x: number, y: number, hp = 1) => { const e = w.spawnUnit(id, 1, { x, y }); e.hp = e.stats.maxHp * hp; army.push(e); return e; };
  [[36, 66, 1], [37.2, 66.4, 0.8], [38.4, 66, 1], [36.4, 67.6, 0.45], [37.6, 67.8, 1], [38.8, 67.5, 0.25]].forEach(([x, y, h]) => put('hosp_sanitizer', x!, y!, h));
  put('hosp_medic', 35.5, 69.2); put('hosp_medic', 37, 69.6, 0.7);
  const lancer = put('hosp_uv_lancer', 39.8, 69.2, 0.9);
  lancer.cooldowns.uv_flare = 9;
  put('hosp_macrophage', 41.5, 67, 0.62); put('hosp_sterilizer_drone', 40, 64.5); put('hosp_antibiotic_launcher', 34, 64.5, 0.15);
  const enemy = w.spawnUnit('path_bacillus', 2, { x: 50, y: 58 });
  enemy.hp = enemy.stats.maxHp * 0.55;
  w.spawnUnit('path_phage', 2, { x: 52, y: 57 }); w.spawnUnit('path_phage', 2, { x: 51, y: 59.5 }); w.spawnUnit('path_spirochete', 2, { x: 53.5, y: 59 });
  const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
  w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
  w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
  w.issue({ type: 'research', playerId: 1, buildingId: hq.id, upgradeId: 'up_hosp_logistics' });
  w.issue({ type: 'train', playerId: 1, buildingId: pharmacy.id, defId: 'hosp_sanitizer' });
  hq.cooldowns.emergency_supply = 41;
  hq.rally = { pos: { x: 30, y: 68 } };
  // two idle orderlies for the idle-worker button
  const workers = w.entitiesOf(1, (e) => !!e.gatherer);
  for (const k of workers.slice(0, 2)) { w.setOrders(k, []); w.movement.stop(k); k.activity = 'idle'; }
  w.step();
  for (let i = 0; i < 40; i++) w.step();

  const hud = new Hud(uiRoot, game);
  game.ui = hud;
  (window as unknown as { __hud: Hud; __sb: SandboxGame }).__hud = hud;
  (window as unknown as { __sb: SandboxGame }).__sb = game;

  // selection
  const sel = game.controls.selection;
  const kind = q.get('sel') ?? 'worker';
  const cache = w.list.find((e) => e.kind === 'resource' && e.alive);
  if (flag('multi')) sel.set([...army.map((e) => e.id), ...workers.slice(2, 5).map((e) => e.id)]);
  else if (kind === 'hq') sel.set([hq.id]);
  else if (kind === 'pharmacy') sel.set([pharmacy.id]);
  else if (kind === 'enemy') sel.set([enemy.id]);
  else if (kind === 'construct') sel.set([lab.id]);
  else if (kind === 'cache' && cache) sel.set([cache.id]);
  else if (kind === 'lancer') sel.set([lancer.id]);
  else if (kind !== 'none') { const k = workers.find((x) => x.activity === 'gathering' || x.activity === 'carrying') ?? workers[3]!; sel.set([k.id]); }
  game.camera.lookAt({ x: 31, y: 72 });

  if (flag('objectives')) {
    const objs: ObjectiveView[] = [
      { id: 'gather', text: 'Gather 300 Supplies', state: 'done', primary: true },
      { id: 'build', text: 'Build a Patient Ward and a Pharmacy', state: 'done', primary: true },
      { id: 'train', text: 'Train 6 Sanitizers', state: 'active', primary: true, progress: '4/6' },
      { id: 'core', text: 'Destroy the Infection Core', state: 'active', primary: true },
      { id: 'rescue', text: 'Rescue Lt. Mäkelä’s team at the paramedic station', state: 'active', primary: false },
      { id: 'lab', text: 'Keep the Research Lab alive', state: 'failed', primary: false },
    ];
    hud.setObjectives(objs);
  }
  if (flag('dialogue')) {
    const lines: Array<[string, string, PortraitId, number?]> = [
      ['Dr. Aino Virtanen, Chief Medical Officer', 'The samples from the old laundry are spreading faster than anything we have on file. Get the Orderlies hauling supplies — we need beds, and we need them now.', 'cmo', 30],
      ['SISU, Campus Defence AI', 'Containment perimeter at 62%. Recommend a Pharmacy near the east gate. I will keep the lights on.', 'sisu'],
      ['Strain Omega', 'You disinfect. I adapt. Every wall you raise is just another surface to grow on.', 'omega'],
    ];
    for (const [speaker, text, portrait, duration] of lines) hud.showDialogue({ speaker, text, portrait, duration });
  }
  if (flag('toasts')) {
    hud.notify('Not enough Power', 'warning');
    hud.notify('Research complete: Hazmat Plating', 'success');
    hud.notify('Our base is under attack', 'alert');
    hud.pingMinimap({ x: 44, y: 60 });
    hud.pingMinimap({ x: 24, y: 70 }, 0xffc94d);
    w.events.emit('constructionComplete', { building: pharmacy });
    w.events.emit('notEnough', { playerId: 1, kind: 'matter', message: 'Not enough matter' });
  }
  let timerLeft = 1200 - 7 * 60 - 18;
  if (flag('timer')) hud.setMissionTimer('Contamination spreads in', timerLeft);
  if (flag('pause') || flag('settings')) {
    hud.openPauseMenu();
    if (flag('settings')) {
      const btn = [...document.querySelectorAll<HTMLButtonElement>('.ip-pause-card .ip-btn')].find((x) => /Settings/.test(x.textContent ?? ''));
      btn?.click();
    }
  }
  const endKind = q.get('end');
  if (endKind) {
    const victory = endKind !== 'defeat';
    const result: EndScreenResult = {
      victory, title: victory ? 'OUTBREAK CONTAINED' : 'CAMPUS LOST', subtitle: victory ? 'Mission 1: Patient Zero' : 'The Central Hospital has fallen',
      missionId: 'm1', nextMissionId: victory ? 'm2' : null, timeSeconds: 14 * 60 + 37,
      stats: [
        { label: 'Units trained', you: 46, enemy: 71 }, { label: 'Units lost', you: 19, enemy: 64 },
        { label: 'Enemies destroyed', you: 77, enemy: 23 }, { label: 'Structures built', you: 14, enemy: 11 },
        { label: 'Resources gathered', you: 6420, enemy: 5830 }, { label: 'Upgrades researched', you: 4, enemy: 3 },
      ],
    };
    hud.showEndScreen(result);
  }

  // loop: fixed-step sim + HUD + a cheap 2D stand-in for the 3D view
  const view = new FakeView(game);
  let last = performance.now(), acc = 0, timerAcc = 0;
  // freeze=<ms>: stop the loop after a while (headless screenshots need the main thread to go idle)
  const freezeAt = q.has('freeze') ? performance.now() + Number(q.get('freeze') || 2500) : Infinity;
  const frame = (now: number) => {
    if (now > freezeAt) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!game.paused) {
      acc += dt * game.speed;
      while (acc >= TICK_DT) { w.step(); acc -= TICK_DT; }
      if (flag('timer')) { timerAcc += dt; if (timerAcc >= 1) { timerAcc = 0; timerLeft = Math.max(0, timerLeft - 1); hud.setMissionTimer('Contamination spreads in', timerLeft); } }
    }
    hud.update(dt);
    view.draw(dt);
  };
  requestAnimationFrame(frame);
}

/** Top-down 2D stand-in for the 3D scene so glass panels have something to sit on. */
class FakeView {
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement;
  private acc = 1;
  constructor(private game: SandboxGame) {
    this.ctx = bg.getContext('2d')!;
    this.terrain = renderTerrain(game.map, 96 * 8).canvas;
  }
  draw(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.5) return; // canvas uploads are expensive under SwiftShader; 2 Hz is plenty for a backdrop
    this.acc = 0;
    const W = bg.clientWidth, H = bg.clientHeight;
    if (bg.width !== W || bg.height !== H) { bg.width = W; bg.height = H; }
    const ctx = this.ctx, t = this.game.camera.target, ppt = 26; // pixels per tile
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#071015'; ctx.fillRect(0, 0, W, H);
    const ox = W / 2 - t.x * ppt, oy = H / 2 - t.y * ppt;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrain, ox, oy, 96 * ppt, 96 * ppt);
    const sel = new Set(this.game.controls.selection.ids);
    for (const e of this.game.world.list) {
      if (!e.alive) continue;
      const x = ox + e.pos.x * ppt, y = oy + e.pos.y * ppt;
      const col = e.owner === 1 ? '#2fd6c6' : e.owner === 2 ? '#d64bff' : '#ffc94d';
      if (e.kind === 'unit') {
        ctx.beginPath(); ctx.arc(x, y, e.radius * ppt, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
        if (sel.has(e.id)) { ctx.strokeStyle = '#46ff9a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, e.radius * ppt + 4, 0, Math.PI * 2); ctx.stroke(); }
      } else {
        const r = this.game.world.footRect(e)!;
        ctx.fillStyle = e.kind === 'resource' ? '#c9962e' : e.owner === 1 ? '#d9e6e6' : '#5a1e66';
        ctx.globalAlpha = e.construction ? 0.5 : 1;
        ctx.fillRect(ox + r.x * ppt + 2, oy + r.y * ppt + 2, r.w * ppt - 4, r.h * ppt - 4);
        ctx.fillStyle = col; ctx.fillRect(ox + r.x * ppt + 2, oy + r.y * ppt + 2, r.w * ppt - 4, 5);
        ctx.globalAlpha = 1;
        if (sel.has(e.id)) { ctx.strokeStyle = '#46ff9a'; ctx.lineWidth = 2; ctx.strokeRect(ox + r.x * ppt, oy + r.y * ppt, r.w * ppt, r.h * ppt); }
      }
    }
  }
}

// ───────────────────────── icon gallery ─────────────────────────
function showGallery(): void {
  ensureUiStyles();
  const root = document.createElement('div');
  root.className = 'ip-root';
  root.style.cssText = 'position:absolute;inset:0;overflow:auto;pointer-events:auto;padding:18px 22px;background:radial-gradient(circle at 30% 20%,#0d2229,#04080b)';
  const keys = [...iconKeys(), 'ability.unknown_thing', 'train.hosp_new_unit', 'cmd.mystery'];
  const card = (html: string, label: string, size = 58) =>
    `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;width:${size + 34}px"><div style="width:${size}px;height:${size}px">${html}</div><div style="font-size:9.5px;color:#8fb0ad;text-align:center;word-break:break-all;line-height:1.2">${label}</div></div>`;
  const portraits = (['cmo', 'sisu', 'paramedic', 'engineer', 'nurse', 'omega', 'pathogen'] as PortraitId[])
    .map((p) => card(`<div style="width:100%;height:100%;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1.5px #35e2d0">${portraitSvg(p)}</div>`, p, 96)).join('');
  root.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px 6px">${keys.map((k) => card(iconHtml(k), k)).join('')}</div>`
    + `<div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:16px">${portraits}</div>`;
  uiRoot.appendChild(root);
}

// ───────────────────────── entry (after all declarations: classes are not hoisted) ─────────────────────────
if (flag('menu')) {
  const menu = new MainMenu(uiRoot, app);
  menu.show();
  const page = q.get('page');
  if (page) menu.openScreen(page);
  (window as unknown as { __menu: MainMenu }).__menu = menu;
} else if (flag('icons')) {
  showGallery();
} else {
  startHudSandbox();
}
