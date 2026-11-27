/**
 * [campaign] Mission 1 — "Patient Zero" (map meilahti, nordic_dusk). OWNER: campaign agent.
 *
 * Tutorial-paced opener. Sequential objectives with dialogue and hints that react to what the player
 * has (or hasn't) done:
 *   gather 300 Supplies → build a Patient Ward + a Pharmacy → train 6 Sanitizers → survive the first wave
 *   → destroy the Infection Core.   Bonus: reach the paramedic station and rescue Lt. Mäkelä's team.
 * Scripted waves from wave_spawn_north / wave_spawn_east at 2:30, 5:00 and 7:30 (difficulty-scaled), then
 * light probes on normal/hard. The AI only defends and grows its garrison (attack: false).
 * Lose: no Central Hospital left.  Win: every Infection Core destroyed.
 */
import { angleOf, sub } from '../../core/math';
import { NEUTRAL_PLAYER, type Entity, type Vec2 } from '../../core/types';
import type { MissionInfo } from '../index';
import {
  byDifficulty, formatClock, line, polar, refOf, regionCenter, scaleComposition, ScriptedMission, type Composition, type SavedRef,
} from '../script';

export const M1_INFO: MissionInfo = {
  id: 'm1', order: 1, title: 'Patient Zero', subtitle: 'Mission 1', mapId: 'meilahti',
  briefing: [
    'Meilahti, late November. Dark by four in the afternoon, sleet coming in off the bay, and a night shift that thought it had seen everything.',
    'At 15:52 the sensors in the old laundry — the shuttered plant north of the Tower Hospital — logged a biological signature that matches nothing in the HUS databases. By 16:30 it had grown a structure. By 16:40 it had a pulse.',
    'Dr. Aino Virtanen has activated the Hospital Defense Corps. SISU, the campus defence AI, has the orderly bots, the Pharmacy stores and the full authority of a Code Red.',
    'Learn the ropes fast: build up the ER plaza, hold it against the first probing waves, then burn the Infection Core out of the laundry.',
  ],
  objectivesPreview: [
    'Gather Supplies, then build a Patient Ward and a Pharmacy',
    'Train Sanitizers and survive the first wave',
    'Destroy the Infection Core at the old laundry',
    'Bonus: rescue Lt. Mäkelä\'s paramedic team',
    'The Central Hospital must not fall',
  ],
};

/** Tunables (enemy counts are authored for 'normal'; the toolkit scales them by difficulty). */
export const M1_TUNING = {
  startSupplies: 200,
  gatherGoal: 300,
  sanitizerGoal: 6,
  /** scripted wave times (mission seconds) and the warning lead time */
  waveTimes: [150, 300, 450] as readonly number[],
  waveWarning: 15,
  /** "Survive the first wave" also completes this long after the wave spawned, if the hospital stands */
  surviveTimeout: 120,
  rescueCallAt: 50,
  rescueReminderAt: 600,
  /** light probing waves after the scripted three (mission seconds; Infinity = none) */
  probeStart: { easy: Infinity, normal: 630, hard: 600 },
  probeEvery: { easy: Infinity, normal: 180, hard: 150 },
};

/** Per scripted wave: one composition per gate (see M1_WAVE_GATES). */
export const M1_WAVES: Composition[][] = [
  [{ path_phage: 4 }],
  [{ path_phage: 5, path_bacillus: 2 }],
  [{ path_phage: 4, path_bacillus: 2 }, { path_phage: 3, path_bacillus: 1, path_spirochete: 1 }],
];
export const M1_WAVE_GATES: string[][] = [['wave_spawn_north'], ['wave_spawn_east'], ['wave_spawn_north', 'wave_spawn_east']];

export const M1_LINES = {
  intro: [
    line('sisu', 'SISU online. Code Red declared on the Meilahti campus. Biological breach at the old laundry, north sector.'),
    line('cmo', "Virtanen here. Whatever grew in that laundry isn't in any textbook I own. We hold the ER plaza, then we burn it out."),
    line('cmo', 'First, supplies. Put the Orderly Bots to work on the Supply Caches. I want 300 Supplies in stock.'),
  ],
  gathered: [line('cmo', 'Good. Now beds and medicine: a Patient Ward to house more staff, and a Pharmacy to equip them.')],
  wardDone: line('sisu', 'Patient Ward online. Eight more beds. Statistically, you will need them.'),
  built: [line('engineer', "Korhonen here. The Pharmacy's up. Please don't lean on the walls, the sealant is still curing.")],
  train: [line('cmo', 'Train Sanitizers. Six more sprayers and the plaza becomes a very unfriendly place to be a germ.')],
  trained: line('sisu', 'Sanitizer squad at strength. Morale nominal. Smell of disinfectant: considerable.'),
  waveWarn: [
    line('sisu', 'Movement at the north gate. Small signatures, fast and numerous. Put your Sanitizers between them and the hospital.'),
    line('sisu', 'East gate. A bigger group, with bacillus brutes. They spit acid at anything with a circuit board.'),
    line('sisu', "Two contacts, north and east at once. It's learning to flank."),
  ],
  waveSpawn: [
    line('sisu', 'Contact. Phages inbound from the north.'),
    line('sisu', 'Contact at the east gate.'),
    line('engineer', "UV turrets on the approaches would be lovely. Ideally yesterday."),
  ],
  waveCleared: line('cmo', 'Plaza holding. That was only a probe. It was counting our sprayers.'),
  probe: [
    line('sisu', 'Another probe on the perimeter. It keeps testing the fence.'),
    line('sisu', 'Hostiles on the move again. Persistent little things.'),
    line('cmo', "It's throwing more at us. Hold the line and push north when you can."),
  ],
  core: [
    line('cmo', 'Now we take the fight to it. The Infection Core sits on the laundry plateau. Gather everyone you can spare and burn it out.'),
    line('sisu', 'Recommendation: attack-move. Units engage every hostile on the way instead of politely walking past it.'),
  ],
  coreHit: line('sisu', "Direct hits on the core. It regenerates, so keep up the pressure and don't let it breathe."),
  rescueCall: [
    line('paramedic', "Mäkelä, paramedics, on the radio. We're pinned down at the station in the birch park. Two medics, three sprayers, no coffee."),
    line('cmo', "Lieutenant Mäkelä's team is in the birch park, south-west. Get any unit to the paramedic station and they're ours."),
  ],
  rescueReminder: line('paramedic', 'Still here. Still pinned. Still no coffee. Just so everyone is aware.'),
  rescued: [
    line('paramedic', 'About time! We were starting to name the phages. Team, fall in. We work for the Doctor now.'),
  ],
  victory: [
    line('cmo', 'The core is down. Good work, all of you. Now somebody tell me where this thing came from.'),
    line('sisu', 'Analysing. Doctor... the core was not the origin. It was a delivery.'),
  ],
  defeat: [line('cmo', "We've lost the Central Hospital. All staff, evacuate towards Töölö. Go. Now.")],
};

export const M1_HINTS = {
  select: 'Left-click an Orderly Bot to select it, or drag a box around several. Then right-click a Supply Cache to gather.',
  gatherAgain: 'Orderlies only earn Supplies while gathering: select them and right-click one of the Supply Caches near the hospital.',
  idle: 'You have idle Orderly Bots. Press F1 to select one, then right-click a Supply Cache.',
  moreWorkers: 'More Orderlies mean faster income: select the Central Hospital and press O to train one.',
  buildWard: 'To build: select an Orderly Bot, press B, then W for a Patient Ward. Left-click to place the foundation.',
  buildWard2: 'Still no Patient Ward. Select an Orderly, press B (build menu), choose Patient Ward, then click open ground.',
  buildPharmacy: 'Pharmacy next: select an Orderly Bot, press V (advanced build), then P. It takes a while to build.',
  assist: 'Right-click a foundation with more Orderlies selected to help: extra hands build faster.',
  train: 'Select the Pharmacy and press S to train a Sanitizer. You can queue up to five at once.',
  rally: 'With the Pharmacy selected, right-click the ground to set a rally point for newly trained units.',
  beds: 'Out of Beds. Build another Patient Ward (B, W) to raise your unit capacity.',
  supplies: 'Short on Supplies? The Central Hospital can call an Emergency Supply Drop (E) every two minutes.',
  alert: 'Press Space to jump the camera to the latest alert.',
  fightBack: 'Your units fight back on their own. Right-click an enemy to focus fire on it.',
  attackMove: 'Attack-move: select your army, press A, then left-click. Units engage everything on the way.',
  groups: 'Control groups: Ctrl+1 binds your selection to group 1, Shift+1 adds to it. Press 1 to recall, double-tap to centre.',
  medics: 'Field Medics heal wounded units nearby automatically. Keep them just behind your Sanitizers.',
  uvTurret: 'Phages are viral, and UV light shreds them. A UV Turret (B, T) beside the Pharmacy covers an approach.',
  lancers: 'UV Lancers need a Research Lab (V, L) and Power. A Backup Generator (B, G) produces Power.',
  repair: 'Orderly Bots repair damaged buildings: select them and right-click the structure.',
  rescue: 'Bonus: move any unit into the paramedic station in the birch park to rescue Lt. Mäkelä\'s team.',
};

/** Seconds between an objective completing and the next one appearing (lets the toast and line land). */
const OBJECTIVE_BEAT = 2.5;

export class PatientZero extends ScriptedMission {
  private hq: Entity | null = null;
  private core: Entity | null = null;
  private station: Vec2 = { x: 0, y: 0 };
  private sanitizersTrained = 0;
  private wave1At = -1;
  private buildShownAt = -1;
  private trainShownAt = -1;
  private probes = 0;
  private rescued = false;

  protected spawn(): void {
    const s = this.script, P = s.playerId, d = s.difficulty;
    s.spawnMapResources();
    s.setResources(P, { matter: M1_TUNING.startSupplies, energy: 0 });

    // ── Hospital: Central Hospital on the ER plaza, 6 idle Orderlies by the caches, 4 Sanitizers out front
    const start = s.refs.point('player_start');
    const enemyStart = s.refs.point('enemy_start');
    this.hq = s.spawnBuilding('hosp_hq', P, start, { exact: true, force: true, tags: ['hq'] });
    const home = this.hq?.pos ?? start;
    const toEnemy = angleOf(sub(enemyStart, home));
    const cache = s.world.spatial.nearest(home, 24, (e) => e.kind === 'resource');
    const toCache = cache ? angleOf(sub(cache.pos, home)) : toEnemy + Math.PI;
    s.spawnUnits('hosp_orderly', 6, P, polar(home, toCache, 4.8), { tags: ['starting'] });
    s.spawnUnits('hosp_sanitizer', 4, P, polar(home, toEnemy, 6), { tags: ['starting'], facing: toEnemy });

    // ── Contagion: the Infection Core on the laundry plateau, and Mäkelä's trap in the birch park
    this.buildEnemyBase(enemyStart, home);
    this.buildParamedicStation();
    s.setAiFlags({ economy: true, build: false, army: d !== 'easy', attack: false, expand: false, defend: true });
    const foe = s.world.players.get(s.enemyId);
    if (foe) foe.gatherMul *= byDifficulty(d, { easy: 0.5, normal: 0.75, hard: 1, brutal: 1.15 });
  }

  protected scriptMission(): void {
    this.script.setLighting('nordic_dusk');
    this.defineActions();
    this.scriptObjectives();
    this.scriptWaves();
    this.scriptRescue();
    this.scriptHints();
    this.scriptEndings();
  }

  protected intro(): void {
    const s = this.script;
    const corePos = this.core?.pos ?? s.refs.point('enemy_start');
    const home = this.hq?.pos ?? s.refs.point('player_start');
    s.reveal(corePos, 13, 14);
    s.lookAt(corePos, true);
    s.ping(corePos);
    const first = s.say(M1_LINES.intro[0]!);
    s.after(Math.max(1, first - 0.6), () => s.panTo(home, 3), 'intro-pan');
    s.say(M1_LINES.intro.slice(1));
    s.hintLater(10, M1_HINTS.select, 'select');
  }

  protected saveState(): Record<string, unknown> {
    return {
      hq: refOf(this.hq), core: refOf(this.core), station: { ...this.station }, sanitizersTrained: this.sanitizersTrained,
      wave1At: this.wave1At, buildShownAt: this.buildShownAt, trainShownAt: this.trainShownAt, probes: this.probes, rescued: this.rescued,
    };
  }

  protected loadState(d: Record<string, unknown>): void {
    this.hq = this.deref(d.hq as SavedRef);
    this.core = this.deref(d.core as SavedRef);
    this.station = { ...(d.station as Vec2) };
    this.sanitizersTrained = d.sanitizersTrained as number;
    this.wave1At = d.wave1At as number;
    this.buildShownAt = d.buildShownAt as number;
    this.trainShownAt = d.trainShownAt as number;
    this.probes = d.probes as number;
    this.rescued = d.rescued as boolean;
  }

  /** Delayed steps scheduled from triggers (named, so they survive save/load). */
  private defineActions(): void {
    const s = this.script;
    s.defineAction('revealBuild', () => {
      s.revealObjective('build');
      this.buildShownAt = s.time;
      s.hint(M1_HINTS.buildWard, { id: 'build-ward' });
    });
    s.defineAction('revealTrain', () => {
      s.revealObjective('train');
      this.trainShownAt = s.time;
      s.hint(M1_HINTS.train, { id: 'train' });
    });
    s.defineAction('revealCore', () => {
      const corePos = this.core?.pos ?? s.refs.point('enemy_start');
      s.revealObjective('core');
      s.reveal(corePos, 10, 8);
      s.ping(corePos);
      s.hint(M1_HINTS.attackMove, { id: 'attack-move' });
      s.hintLater(25, M1_HINTS.groups, 'groups');
    });
    s.defineAction('revealRescue', () => {
      if (this.rescued) return;
      s.revealObjective('rescue');
      s.reveal(this.station, 7, 10);
      s.ping(this.station, 0x5cf2c8);
      s.hint(M1_HINTS.rescue, { id: 'rescue' });
    });
  }

  // ───────────────────────── setup helpers ─────────────────────────

  private buildEnemyBase(at: Vec2, playerPos: Vec2): void {
    const s = this.script, E = s.enemyId, d = s.difficulty;
    this.core = s.spawnBuilding('path_hive', E, at, { exact: true, force: true, tags: ['core', 'objective'] });
    const c = this.core?.pos ?? at;
    const front = angleOf(sub(playerPos, c));
    const within = 'enemy_core';
    s.spawnBuilding('path_replicator', E, polar(c, front + 1.45, 7), { within, tags: ['base'] });
    s.spawnBuilding('path_nest', E, polar(c, front + Math.PI - 0.7, 6.5), { within, tags: ['base'] });
    s.spawnBuilding('path_nest', E, polar(c, front + Math.PI + 0.7, 6.5), { within, tags: ['base'] });
    if (d === 'hard' || d === 'brutal') s.spawnBuilding('path_fermenter', E, polar(c, front - 1.6, 7), { within, tags: ['base'] });
    const spitters = byDifficulty(d, { easy: 1, normal: 2, hard: 3, brutal: 4 });
    for (let i = 0; i < spitters; i++) {
      s.spawnBuilding('path_toxin_spitter', E, polar(c, front + (i - (spitters - 1) / 2) * 0.6, 8), { within, tags: ['base'] });
    }
    s.spawnUnits('path_spore_drone', 4, E, polar(c, front + Math.PI, 4.5), { gather: true });
    for (const [id, n] of Object.entries(scaleComposition({ path_phage: 3, path_bacillus: 2 }, d))) {
      s.spawnUnits(id, n, E, polar(c, front, 5), { facing: front }); // untagged: the AI defends with them
    }
  }

  private buildParamedicStation(): void {
    const s = this.script;
    this.station = regionCenter(s.refs.region('paramedic_station'));
    // Lt. Mäkelä's team waits — neutral and untouchable — until a hospital unit reaches the station.
    s.spawnUnits('hosp_medic', 2, NEUTRAL_PLAYER, this.station, { tags: ['captive'], invulnerable: true });
    s.spawnUnits('hosp_sanitizer', 3, NEUTRAL_PLAYER, polar(this.station, Math.PI / 2, 2.2), { tags: ['captive'], invulnerable: true });
    // A small pack prowls between the station and the plateau.
    const toEnemy = angleOf(sub(s.refs.point('enemy_start'), this.station));
    const post = s.walkableNear(polar(this.station, toEnemy, 6));
    const lurkers: Entity[] = [];
    for (const [id, n] of Object.entries(scaleComposition({ path_phage: 2, path_bacillus: 1 }, s.difficulty))) {
      lurkers.push(...s.spawnUnits(id, n, s.enemyId, post, { tags: ['lurker', 'scripted'] }));
    }
    s.guard(lurkers, post, 7);
  }

  // ───────────────────────── objectives ─────────────────────────

  private scriptObjectives(): void {
    const s = this.script, P = s.playerId, T = M1_TUNING;
    const O = s.objectives;
    s.addObjective({ id: 'gather', text: `Gather ${T.gatherGoal} Supplies`, progress: this.gatherProgress() });
    s.addObjective({ id: 'build', text: 'Build a Patient Ward and a Pharmacy', hidden: true });
    s.addObjective({ id: 'train', text: `Train ${T.sanitizerGoal} Sanitizers at the Pharmacy`, hidden: true });
    s.addObjective({ id: 'wave', text: 'Survive the first wave', hidden: true });
    s.addObjective({ id: 'core', text: 'Destroy the Infection Core', hidden: true });
    s.addObjective({ id: 'rescue', text: "Rescue Lt. Mäkelä's paramedic team", primary: false, hidden: true });

    s.onEvent('productionComplete', (p) => p.unit.owner === P && p.unit.defId === 'hosp_sanitizer', () => { this.sanitizersTrained++; }, { repeat: true, name: 'count-sanitizers' });
    s.every(0.25, () => this.refreshProgress(), { start: 0, name: 'progress' });

    // 1 → 2: stockpile reached
    s.when(() => O.isActive('gather') && s.world.player(P).resources.matter >= T.gatherGoal, () => {
      s.completeObjective('gather');
      s.say(M1_LINES.gathered);
      s.schedule(OBJECTIVE_BEAT, 'revealBuild');
    }, { name: 'gather-done' });
    // Ward + Pharmacy
    s.when(() => s.completed(P, 'hosp_ward') > 0, () => { if (!O.isDone('build')) s.bark(M1_LINES.wardDone); }, { interval: 0.5, name: 'ward-done' });
    s.when(() => O.isActive('build') && s.completed(P, 'hosp_ward') > 0 && s.completed(P, 'hosp_pharmacy') > 0, () => {
      s.completeObjective('build');
      s.say([...M1_LINES.built, ...M1_LINES.train]);
      s.schedule(OBJECTIVE_BEAT, 'revealTrain');
    }, { interval: 0.5, name: 'build-done' });
    // Sanitizers
    s.when(() => O.isActive('train') && this.sanitizersTrained >= T.sanitizerGoal, () => {
      s.completeObjective('train');
      s.bark(M1_LINES.trained, 20);
      s.revealObjective('wave'); // if the first wave hasn't come yet, it now shows its ETA
    }, { interval: 0.25, name: 'train-done' });
    // First wave
    const waveDone = (): void => {
      if (O.isDone('wave')) return;
      s.revealObjective('wave');
      s.completeObjective('wave');
      s.bark(M1_LINES.waveCleared, 20);
    };
    s.onAllDead('wave1', waveDone, { name: 'wave1-dead' });
    s.when(() => this.wave1At >= 0 && s.time - this.wave1At >= T.surviveTimeout && s.count(P, 'hosp_hq') > 0, waveDone, { interval: 1, name: 'wave1-timeout' });
    // Final objective once the training wheels are off
    s.when(() => O.isDone('train') && O.isDone('wave') && O.isHidden('core'), () => {
      s.say(M1_LINES.core);
      s.schedule(OBJECTIVE_BEAT, 'revealCore');
    }, { interval: 0.5, name: 'core-reveal' });
    if (this.core) {
      const hit = s.onDamaged(this.core, () => { hit.cancel(); s.bark(M1_LINES.coreHit); }, { byOwner: P, cooldown: 0, name: 'core-hit' });
    }
  }

  private gatherProgress(): string {
    const m = Math.floor(this.script.world.player(this.script.playerId).resources.matter);
    return `${Math.min(m, M1_TUNING.gatherGoal)} / ${M1_TUNING.gatherGoal}`;
  }

  private refreshProgress(): void {
    const s = this.script, P = s.playerId, O = s.objectives;
    if (O.isActive('gather')) s.setProgress('gather', this.gatherProgress());
    if (O.isActive('build')) {
      const mark = (id: string) => (s.completed(P, id) > 0 ? '✓' : s.count(P, id) > 0 ? '…' : '✗');
      s.setProgress('build', `Ward ${mark('hosp_ward')}  Pharmacy ${mark('hosp_pharmacy')}`);
    }
    if (O.isActive('train')) s.setProgress('train', `${Math.min(this.sanitizersTrained, M1_TUNING.sanitizerGoal)} / ${M1_TUNING.sanitizerGoal}`);
    if (O.isActive('wave')) {
      if (this.wave1At < 0) s.setProgress('wave', `arrives in ${formatClock(M1_TUNING.waveTimes[0]! - s.time)}`);
      else s.setProgress('wave', `${s.countTagged('wave1')} hostiles left`);
    }
    if (O.isActive('core')) {
      const c = this.core;
      s.setProgress('core', c && c.alive ? `Core ${Math.ceil((c.hp / c.stats.maxHp) * 100)}%` : undefined);
    }
  }

  // ───────────────────────── waves ─────────────────────────

  private scriptWaves(): void {
    const s = this.script, T = M1_TUNING, d = s.difficulty;
    T.waveTimes.forEach((t, i) => {
      s.at(t - T.waveWarning, () => { s.bark(M1_LINES.waveWarn[i]!, 20); s.notify('Hostiles approaching the campus', 'alert'); }, `wave${i + 1}-warn`);
      s.at(t, () => this.launchWave(i), `wave${i + 1}`);
    });
    s.startTimer('Next wave', T.waveTimes[0]!, null);
    const start = byDifficulty(d, { ...T.probeStart, brutal: 540 });
    const period = byDifficulty(d, { ...T.probeEvery, brutal: 120 });
    if (Number.isFinite(start) && Number.isFinite(period)) s.every(period, () => this.probe(), { start, name: 'probe' });
  }

  private launchWave(i: number): void {
    const s = this.script, T = M1_TUNING;
    const comps = M1_WAVES[i] ?? [];
    const gates = M1_WAVE_GATES[i] ?? ['wave_spawn_north'];
    comps.forEach((comp, k) => s.sendWave(comp, gates[k % gates.length]!, { name: `m1-w${i + 1}-${k + 1}`, tags: [`wave${i + 1}`] }));
    s.bark(M1_LINES.waveSpawn[i]!, 15);
    const next = T.waveTimes[i + 1];
    if (next != null) s.startTimer('Next wave', next - s.time, null); else s.stopTimer();
    if (i === 0) {
      this.wave1At = s.time;
      s.revealObjective('wave');
      s.hint(M1_HINTS.fightBack, { id: 'fight-back' });
    }
    if (i === 2) s.hintLater(6, M1_HINTS.uvTurret, 'uv-turret');
  }

  /** Light probing waves after the scripted three, until the core falls. */
  private probe(): void {
    const s = this.script;
    if (s.objectives.isDone('core')) return;
    const n = ++this.probes;
    const comp: Composition = { path_phage: Math.min(9, 3 + n), path_bacillus: Math.min(5, 1 + Math.floor(n / 2)) };
    if (n >= 3) comp.path_spirochete = Math.min(3, n - 2);
    s.sendWave(comp, s.world.rng.pick(['wave_spawn_north', 'wave_spawn_east']), { name: `m1-probe${n}`, tags: ['probe'] });
    s.bark(M1_LINES.probe[(n - 1) % M1_LINES.probe.length]!, 15);
  }

  // ───────────────────────── bonus: Mäkelä's team ─────────────────────────

  private scriptRescue(): void {
    const s = this.script, P = s.playerId, T = M1_TUNING;
    const offer = (): void => {
      if (this.rescued || !s.objectives.isHidden('rescue')) return;
      s.say(M1_LINES.rescueCall);
      s.schedule(OBJECTIVE_BEAT + 2, 'revealRescue');
    };
    s.at(T.rescueCallAt, offer, 'rescue-call');
    s.at(T.rescueReminderAt, () => { if (!this.rescued && s.objectives.isActive('rescue')) s.bark(M1_LINES.rescueReminder, 20); }, 'rescue-reminder');
    s.onEnterRegion('paramedic_station', P, () => this.rescue(), { name: 'rescue' });
  }

  private rescue(): void {
    const s = this.script, P = s.playerId;
    if (this.rescued) return;
    this.rescued = true;
    const captives = s.tagged('captive');
    const spots = captives.map((c) => ({ defId: c.defId, pos: { x: c.pos.x, y: c.pos.y } }));
    for (const c of captives) s.world.removeEntity(c);
    if (spots.length === 0) { // captives missing (should not happen) — grant the reward at the station anyway
      for (let i = 0; i < 2; i++) spots.push({ defId: 'hosp_medic', pos: this.station });
      for (let i = 0; i < 3; i++) spots.push({ defId: 'hosp_sanitizer', pos: this.station });
    }
    for (const sp of spots) s.spawnUnits(sp.defId, 1, P, sp.pos, { tags: ['makela_team'] });
    s.revealObjective('rescue');
    s.completeObjective('rescue');
    s.say(M1_LINES.rescued, { urgent: true });
    s.ping(this.station, 0x5cf2c8);
    s.hintLater(4, M1_HINTS.medics, 'medics');
  }

  // ───────────────────────── reactive hints ─────────────────────────

  private scriptHints(): void {
    const s = this.script, P = s.playerId, O = s.objectives, w = s.world;
    const gathering = () => w.entitiesOf(P, (e) => !!e.gatherer && (e.orders[0]?.type === 'gather' || e.orders[0]?.type === 'returnCargo')).length;
    const idleWorkers = () => w.entitiesOf(P, (e) => !!e.gatherer && e.kind === 'unit' && s.isIdle(e)).length;

    // Economy basics — only nag if the player hasn't figured it out.
    s.at(35, () => { if (gathering() < 3) s.hint(M1_HINTS.gatherAgain, { id: 'gather-again' }); }, 'hint-gather');
    s.when(() => s.time > 60 && idleWorkers() >= 2, () => s.hint(M1_HINTS.idle, { id: 'idle', cooldown: 90 }), { repeat: true, interval: 5, cooldown: 90, name: 'hint-idle' });
    s.when(() => O.isDone('gather') && s.time > 90 && w.countOf(P, 'hosp_orderly') < 8, () => s.hint(M1_HINTS.moreWorkers, { id: 'more-workers' }), { interval: 2, name: 'hint-workers' });

    // Construction
    s.when(() => O.isActive('build') && this.buildShownAt >= 0 && s.time - this.buildShownAt > 30 && s.count(P, 'hosp_ward') === 0,
      () => s.hint(M1_HINTS.buildWard2, { id: 'build-ward-2' }), { interval: 1, name: 'hint-ward' });
    s.when(() => O.isActive('build') && s.count(P, 'hosp_ward') > 0 && s.count(P, 'hosp_pharmacy') === 0,
      () => s.hint(M1_HINTS.buildPharmacy, { id: 'build-pharmacy' }), { interval: 1, name: 'hint-pharmacy' });
    s.onEvent('constructionStarted', (p) => p.building.owner === P && p.building.defId === 'hosp_pharmacy',
      () => s.hintLater(6, M1_HINTS.assist, 'assist'), { name: 'hint-assist' });

    // Training
    s.when(() => O.isActive('train') && this.trainShownAt >= 0 && s.time - this.trainShownAt > 25,
      () => s.hint(M1_HINTS.rally, { id: 'rally' }), { interval: 1, name: 'hint-rally' });
    s.when(() => { const p = w.player(P); return s.completed(P, 'hosp_pharmacy') > 0 && p.popCap > 0 && p.popUsed >= p.popCap; },
      () => s.hint(M1_HINTS.beds, { id: 'beds', cooldown: 60 }), { repeat: true, interval: 2, cooldown: 60, name: 'hint-beds' });
    s.onEvent('notEnough', (p) => p.playerId === P && p.kind === 'pop', () => s.hint(M1_HINTS.beds, { id: 'beds', cooldown: 60 }), { repeat: true, name: 'hint-beds-2' });
    s.onEvent('notEnough', (p) => p.playerId === P && p.kind === 'matter' && s.time > 60,
      () => s.hint(M1_HINTS.supplies, { id: 'supplies', cooldown: 150 }), { repeat: true, name: 'hint-supplies' });

    // Combat
    s.onEvent('underAttack', (p) => p.playerId === P, () => s.hint(M1_HINTS.alert, { id: 'alert' }), { name: 'hint-alert' });
    s.onEvent('entityDamaged', (p) => p.entity.owner === P && p.entity.kind === 'building' && s.time > 30,
      () => s.hintLater(3, M1_HINTS.repair, 'repair'), { name: 'hint-repair' });
    s.onEvent('productionComplete', (p) => p.unit.owner === P && p.unit.defId === 'hosp_medic',
      () => s.hint(M1_HINTS.medics, { id: 'medics' }), { name: 'hint-medic' });
    s.when(() => O.isDone('wave') && s.count(P, 'hosp_uv_turret') === 0, () => s.hintLater(20, M1_HINTS.uvTurret, 'uv-turret'), { interval: 1, name: 'hint-uv-1' });
    s.when(() => s.time > 420 || s.count(P, 'hosp_uv_turret') > 0, () => s.hint(M1_HINTS.lancers, { id: 'lancers' }), { interval: 2, name: 'hint-lancers' });
  }

  // ───────────────────────── endings ─────────────────────────

  private scriptEndings(): void {
    const s = this.script, P = s.playerId, E = s.enemyId;
    s.when(() => s.count(P, 'hosp_hq') === 0, () => {
      s.dialogue.clear();
      s.defeat('The Central Hospital has fallen', { delay: s.say(M1_LINES.defeat, { urgent: true }) + 0.5 });
    }, { interval: 0.25, name: 'lose-hq' });
    s.when(() => s.count(E, 'path_hive') === 0, () => {
      s.revealObjective('core');
      s.completeObjective('core');
      s.dialogue.clear();
      s.victory('The Infection Core has been destroyed', { delay: s.say(M1_LINES.victory, { urgent: true }) + 0.5 });
    }, { interval: 0.25, name: 'win-cores' });
  }
}
