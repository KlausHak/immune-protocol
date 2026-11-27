/**
 * [campaign] Mission 3 — "Strain Omega" (map meilahti, nordic_dusk). OWNER: campaign agent.
 *
 * Protect the Children's Hospital (obj_childrens_hospital at childrens_hospital_center, player-owned).
 * Probing waves hit it from the west/north/east; at 6:00 Strain Omega (path_strain_omega, scriptTag 'boss')
 * erupts at omega_spawn with escorts and marches on it, kept on course by an assertive shepherd. Destroying
 * the Infection Core early wakes Omega immediately.
 * Win: Strain Omega and the Infection Core destroyed.  Lose: the Children's Hospital or the Central Hospital falls.
 */
import { angleOf, sub } from '../../core/math';
import type { Entity, Vec2 } from '../../core/types';
import type { MissionInfo } from '../index';
import {
  byDifficulty, line, mergeComposition, polar, scaleComposition, ScriptedMission, type Composition,
} from '../script';

export const M3_INFO: MissionInfo = {
  id: 'm3', order: 3, title: 'Strain Omega', subtitle: 'Mission 3', mapId: 'meilahti',
  briefing: [
    'A week of quiet, and then the seismographs under the old laundry began to twitch. Whatever has been growing down there is very large, and it is coming up.',
    "The New Children's Hospital cannot be evacuated in this weather: four hundred young patients, their families and a ward full of incubators. Lt. Mäkelä's team holds the doors.",
    'SISU has a name for the source signal: Strain Omega, the original patient zero, mutated past anything in the literature. When it surfaces, it will go straight for the most vulnerable building on campus.',
    "Fortify the Children's Hospital, kill Strain Omega, then end the outbreak by destroying the Infection Core.",
  ],
  objectivesPreview: [
    "Protect the Children's Hospital",
    'Destroy Strain Omega when it emerges (about 6:00)',
    'Destroy the Infection Core',
    'The Central Hospital must not fall',
  ],
};

interface ScriptedWave { at: number; gate: string; comp: Composition }

export const M3_TUNING = {
  /** mission second at which Strain Omega erupts */
  omegaAt: 360,
  startSupplies: 500,
  startPower: 150,
  waves: [
    { at: 105, gate: 'wave_spawn_west', comp: { path_phage: 4, path_bacillus: 1 } },
    { at: 210, gate: 'wave_spawn_north', comp: { path_phage: 5, path_bacillus: 2, path_spirochete: 1 } },
    { at: 300, gate: 'wave_spawn_east', comp: { path_phage: 4, path_bacillus: 2, path_flu_drifter: 1 } },
  ] as ScriptedWave[],
  omegaEscort: { path_phage: 6, path_bacillus: 4, path_spirochete: 2 } as Composition,
  /** extra escort on hard/brutal */
  omegaEscortHard: { path_superbug: 1, path_fungal_mortar: 1 } as Composition,
  /** waves that keep coming at the Children's Hospital while Omega lives */
  pressureEvery: { easy: 150, normal: 120, hard: 100, brutal: 85 },
  pressure: { path_phage: 4, path_bacillus: 2, path_spirochete: 1 } as Composition,
  turrets: { easy: 3, normal: 2, hard: 1, brutal: 1 },
  /** multiplier on the AI's own gather rate (balance-probed) */
  aiGatherMul: { easy: 0.45, normal: 0.65, hard: 0.85, brutal: 1 },
  /** Strain Omega surfaces wounded from its climb (fraction of max hp; balance-probed) */
  omegaHpFrac: { easy: 0.5, normal: 0.55, hard: 0.8, brutal: 1 },
  /** Macrophage Mechs in the starting army (full damage vs Omega) */
  startMechs: { easy: 4, normal: 3, hard: 2, brutal: 1 },
  /** the AI starts its own attack waves (on the Children's Hospital) when Omega emerges */
  aiAttacksAfterOmega: { easy: false, normal: true, hard: true, brutal: true },
};

const GATES = ['wave_spawn_west', 'wave_spawn_north', 'wave_spawn_east'];
const GATE_NAMES: Record<string, string> = { wave_spawn_west: 'west', wave_spawn_north: 'north', wave_spawn_east: 'east' };

export const M3_LINES = {
  intro: [
    line('cmo', "The Children's Hospital is full: four hundred patients we can't move in this sleet. Whatever comes tonight, it does not get through that door."),
    line('sisu', 'Anomalous signal beneath the old laundry. One organism. Very large. Growing.'),
    line('engineer', "I've run power to the turret mounts around the Children's Hospital. Build more UV Turrets there and they'll be fed."),
    line('paramedic', "My team's on the doors. Anything that wants in will have to take a number and wait."),
  ],
  wave: (gate: string) => line('sisu', `Hostiles converging on the Children's Hospital from the ${GATE_NAMES[gate] ?? 'north'}.`),
  seismic: line('sisu', 'Seismic activity under the laundry. Something is coming up through the floor.'),
  emerge: [
    line('omega', 'h e l l o, caretakers. ▒▒ we have read your charts. all of them. you write so many charts.'),
    line('cmo', "That... is patient zero. All units, protect the Children's Hospital!"),
    line('omega', 'the little ones are warm. ░ warm is where we grow. l e t  u s  i n'),
  ],
  emergeEarly: [
    line('cmo', "The core is gone, but SISU's signal just doubled. Whatever was down there is awake now."),
    line('omega', 'you burned our cradle. ▓▒ so we will make a new one. somewhere w a r m.'),
  ],
  omega66: line('omega', 'you cut. we multiply. ▓▒░ it is the only arithmetic we know.'),
  omega33: [
    line('omega', 'c o l d . . . why is everything here so c o l d'),
    line('sisu', "Strain Omega's integrity is failing. Do not let it reach the doors."),
  ],
  omegaDown: [
    line('omega', 'we are not ending. we are s p o r u l a t i ▒▒▒▒'),
    line('cmo', 'Strain Omega is down. Now the Infection Core. Finish it, and this outbreak is over.'),
  ],
  coreDown: line('sisu', 'Infection Core destroyed. Strain Omega remains. It is... upset.'),
  doors: [
    line('paramedic', "They're at the Children's Hospital doors! I need sprayers here, now!"),
    line('paramedic', 'Doors are holding, but not for long. Send help!'),
    line('paramedic', "Another push on the entrance. We're stacking beds against the glass!"),
  ],
  half: line('cmo', "The Children's Hospital is at half integrity. Orderlies can repair it. Get them there."),
  quarter: line('paramedic', "Walls are cracking in the east wing! We're moving the incubators to the basement!"),
  victory: [
    line('cmo', "It's over. The children are safe, and Meilahti still stands."),
    line('sisu', 'Outbreak status: contained. Campus status: sisu.'),
    line('paramedic', 'Somebody put the coffee on. A big pot. The biggest pot.'),
  ],
  defeatChildren: [line('cmo', "The Children's Hospital is overrun. Evacuation teams, go! Get every child out through the tunnels!")],
  defeatHq: [line('cmo', "The Central Hospital has fallen. Without it we can't hold the campus. Fall back to Töölö.")],
};

export const M3_HINTS = {
  turrets: "UV Turrets (B, T) near the Children's Hospital soften every wave before it reaches the doors.",
  repair: "Orderly Bots can repair the Children's Hospital: select them and right-click it.",
  omega: 'Strain Omega resists UV and antibiotics. Sanitizers and Macrophage Mechs hit it at full strength.',
  depot: 'Your Ambulance Depot builds Macrophage Mechs (needs the Research Lab): heavy melee that shreds armour.',
};

export class StrainOmega extends ScriptedMission {
  private hq: Entity | null = null;
  private childrens: Entity | null = null;
  private core: Entity | null = null;
  private omega: Entity | null = null;
  private omegaSpawned = false;
  private doorLine = 0;

  /** Strain Omega once it has emerged (tests / debugging). */
  get boss(): Entity | null { return this.omega; }

  protected build(): void {
    const s = this.script, P = s.playerId, E = s.enemyId, d = s.difficulty, T = M3_TUNING;
    s.setLighting('nordic_dusk');
    s.spawnMapResources();
    s.setResources(P, { matter: T.startSupplies, energy: T.startPower });
    s.setResources(E, { matter: 300, energy: 150 });

    // ── Hospital base
    const start = s.refs.point('player_start');
    const enemyStart = s.refs.point('enemy_start');
    this.hq = s.spawnBuilding('hosp_hq', P, start, { exact: true, force: true, tags: ['hq'] });
    const home = this.hq?.pos ?? start;
    const toEnemy = angleOf(sub(enemyStart, home));
    const within = 'player_base';
    s.spawnBuilding('hosp_pharmacy', P, polar(home, toEnemy + 1.0, 7.5), { within });
    s.spawnBuilding('hosp_lab', P, polar(home, toEnemy - 1.0, 7.5), { within });
    s.spawnBuilding('hosp_vehicle_bay', P, polar(home, toEnemy + Math.PI - 0.5, 8), { within });
    s.spawnBuilding('hosp_generator', P, polar(home, toEnemy + Math.PI + 0.9, 6.5), { within });
    s.spawnBuilding('hosp_ward', P, polar(home, toEnemy - 1.9, 7), { within });
    s.spawnBuilding('hosp_ward', P, polar(home, toEnemy + 1.9, 7), { within });
    const cache = s.world.spatial.nearest(home, 24, (e) => e.kind === 'resource');
    const toCache = cache ? angleOf(sub(cache.pos, home)) : toEnemy + Math.PI;
    s.spawnUnits('hosp_orderly', 8, P, polar(home, toCache, 4.8), { gather: true });

    // ── The Children's Hospital, its turrets, and Mäkelä's team on the doors
    this.childrens = s.spawnBuilding('obj_childrens_hospital', P, s.refs.point('childrens_hospital_center'),
      { exact: true, force: true, search: 8, tags: ['objective', 'childrens'] });
    const ch = this.childrens?.pos ?? s.refs.point('childrens_hospital_center');
    const chFront = angleOf(sub(enemyStart, ch));
    const turrets = byDifficulty(d, T.turrets);
    for (let i = 0; i < turrets; i++) s.spawnBuilding('hosp_uv_turret', P, polar(ch, chFront + (i - (turrets - 1) / 2) * 0.9, 6), { search: 5, tags: ['childrens_turret'] });
    const door = polar(ch, chFront, 5);
    s.spawnUnits('hosp_sanitizer', 4, P, door, { facing: chFront, tags: ['makela_team'] });
    s.spawnUnits('hosp_medic', 2, P, polar(ch, chFront, 3.6), { facing: chFront, tags: ['makela_team'] });

    // ── Main army between the base and the Children's Hospital
    const rally = polar(home, angleOf(sub(ch, home)), 7);
    s.spawnUnits('hosp_sanitizer', 10, P, rally, { facing: toEnemy });
    s.spawnUnits('hosp_medic', 3, P, polar(rally, toEnemy + Math.PI, 2.8), { facing: toEnemy });
    s.spawnUnits('hosp_uv_lancer', 3, P, polar(rally, toEnemy + Math.PI / 2, 2.8), { facing: toEnemy });
    s.spawnUnits('hosp_macrophage', byDifficulty(d, T.startMechs), P, polar(rally, toEnemy, 3), { facing: toEnemy });

    s.ensureBeds(P, 10, polar(home, toEnemy + Math.PI, 7)); // room to train from minute one

    // ── Contagion
    this.core = this.buildEnemyBase(enemyStart, home);
    // Before Omega the pressure is scripted; the AI only builds up and defends (it joins in later on normal+).
    s.setAiFlags({ economy: true, build: true, army: true, attack: false, expand: false, defend: true });
    s.setAiAttackTarget(ch);
    const foe = s.world.players.get(E);
    if (foe) foe.gatherMul *= byDifficulty(d, T.aiGatherMul);

    this.scriptObjectives();
    this.scriptWaves();
    this.scriptEndings();
  }

  protected intro(): void {
    const s = this.script;
    const ch = this.childrens?.pos ?? s.refs.point('childrens_hospital_center');
    const home = this.hq?.pos ?? s.refs.point('player_start');
    const spawn = s.refs.point('omega_spawn');
    s.lookAt(ch, true);
    s.ping(ch, 0x5cf2c8);
    const ends = M3_LINES.intro.map((l) => s.say(l));
    s.after(Math.max(0.5, ends[0]! - 0.5), () => { s.reveal(spawn, 9, 8); s.panTo(spawn, 2.5); }, 'intro-omega');
    s.after(Math.max(1, ends[1]! - 0.5), () => s.panTo(ch, 2.5), 'intro-children');
    s.after(Math.max(1.5, ends[3]! - 0.5), () => s.panTo(home, 3), 'intro-home');
    s.after(ends[3]! + 1, () => s.hint(M3_HINTS.turrets, { id: 'turrets' }), 'hint-turrets');
  }

  // ───────────────────────── setup helpers ─────────────────────────

  private buildEnemyBase(at: Vec2, playerPos: Vec2): Entity | null {
    const s = this.script, E = s.enemyId, d = s.difficulty;
    const core = s.spawnBuilding('path_hive', E, at, { exact: true, force: true, tags: ['core', 'objective'] });
    const c = core?.pos ?? at;
    const front = angleOf(sub(playerPos, c));
    const within = 'enemy_core';
    s.spawnBuilding('path_replicator', E, polar(c, front + 1.4, 7), { within });
    s.spawnBuilding('path_mutation_pit', E, polar(c, front - 1.4, 7), { within });
    s.spawnBuilding('path_biofilm_spire', E, polar(c, front + Math.PI, 8), { within });
    s.spawnBuilding('path_fermenter', E, polar(c, front + Math.PI - 1.2, 7), { within });
    for (let i = 0; i < 3; i++) s.spawnBuilding('path_nest', E, polar(c, front + Math.PI + 1.0 + i * 0.6, 7), { within });
    const spitters = byDifficulty(d, { easy: 2, normal: 3, hard: 4, brutal: 5 });
    for (let i = 0; i < spitters; i++) s.spawnBuilding('path_toxin_spitter', E, polar(c, front + (i - (spitters - 1) / 2) * 0.5, 8.5), { within });
    s.spawnUnits('path_spore_drone', 6, E, polar(c, front + Math.PI, 4.5), { gather: true });
    for (const [id, n] of Object.entries(scaleComposition({ path_phage: 6, path_bacillus: 4, path_spirochete: 2, path_fungal_mortar: 1 }, d))) {
      s.spawnUnits(id, n, E, polar(c, front, 5.5), { facing: front }); // untagged: AI-controlled
    }
    return core;
  }

  // ───────────────────────── objectives ─────────────────────────

  private scriptObjectives(): void {
    const s = this.script;
    s.addObjective({ id: 'protect', text: "Protect the Children's Hospital", progress: 'Integrity 100%' });
    s.addObjective({ id: 'omega', text: 'Destroy Strain Omega', hidden: true });
    s.addObjective({ id: 'core', text: 'Destroy the Infection Core' });

    s.every(0.5, () => {
      const ch = this.childrens;
      if (ch && s.objectives.isActive('protect')) s.setProgress('protect', `Integrity ${Math.max(0, Math.ceil((ch.hp / ch.stats.maxHp) * 100))}%`);
      const o = this.omega;
      if (o && s.objectives.isActive('omega')) s.setProgress('omega', o.alive ? `Omega ${Math.ceil((o.hp / o.stats.maxHp) * 100)}%` : undefined);
      const c = this.core;
      if (c && s.objectives.isActive('core')) s.setProgress('core', c.alive ? `Core ${Math.ceil((c.hp / c.stats.maxHp) * 100)}%` : undefined);
    }, { start: 0, name: 'progress' });

    const ch = this.childrens;
    if (ch) {
      s.onDamaged(ch, () => {
        s.bark(M3_LINES.doors[this.doorLine++ % M3_LINES.doors.length]!, 10);
        s.ping(ch.pos, 0xffb23b);
      }, { cooldown: 40, name: 'doors' });
      s.onHpBelow(ch, 0.5, () => { s.bark(M3_LINES.half, 15); s.hint(M3_HINTS.repair, { id: 'repair' }); }, 'children-half');
      s.onHpBelow(ch, 0.25, () => s.bark(M3_LINES.quarter, 15), 'children-quarter');
    }
    if (this.core) s.onDeath(this.core, () => this.coreDown(), { name: 'core-down' });
    s.at(200, () => s.hint(M3_HINTS.depot, { id: 'depot' }), 'hint-depot');
  }

  // ───────────────────────── waves & Omega ─────────────────────────

  private scriptWaves(): void {
    const s = this.script, T = M3_TUNING;
    const target = (): Vec2 | null => (this.childrens?.alive ? { ...this.childrens.pos } : s.playerBaseTarget());
    T.waves.forEach((w, i) => s.at(w.at, () => {
      if (s.finished) return;
      s.sendWave(w.comp, w.gate, { name: `m3-w${i + 1}`, target, tags: ['pre_omega'] });
      s.bark(M3_LINES.wave(w.gate), 15);
    }, `m3-wave${i + 1}`));
    s.startTimer('Seismic anomaly', T.omegaAt, () => this.emergeOmega(false));
    s.at(T.omegaAt - 30, () => { if (!this.omegaSpawned) { s.bark(M3_LINES.seismic, 20); s.shake(0.35, 2.5); } }, 'seismic');
    const period = byDifficulty(s.difficulty, T.pressureEvery);
    s.every(period, () => {
      if (!this.omega?.alive || s.finished) return;
      const gate = s.world.rng.pick(GATES);
      s.sendWave(T.pressure, gate, { name: 'm3-pressure', target, tags: ['pressure'] });
      s.bark(M3_LINES.wave(gate), 12);
    }, { start: T.omegaAt + 75, name: 'pressure' });
  }

  /** Strain Omega erupts at omega_spawn with escorts and marches on the Children's Hospital. */
  private emergeOmega(early: boolean): void {
    const s = this.script, E = s.enemyId, d = s.difficulty, T = M3_TUNING;
    if (this.omegaSpawned || s.finished) return;
    this.omegaSpawned = true;
    s.stopTimer();
    const at = s.walkableNear(s.refs.point('omega_spawn'), 14);
    const target = (): Vec2 | null => (this.childrens?.alive ? { ...this.childrens.pos } : s.playerBaseTarget(at));
    const omega = s.spawnUnits('path_strain_omega', 1, E, at, { tags: ['boss', 'omega', 'scripted'] })[0] ?? null;
    this.omega = omega;
    if (omega) omega.hp = Math.max(1, Math.round(omega.stats.maxHp * byDifficulty(d, T.omegaHpFrac)));
    const escortComp = scaleComposition(mergeComposition(T.omegaEscort, d === 'hard' || d === 'brutal' ? T.omegaEscortHard : null), d);
    const toTarget = angleOf(sub(target() ?? at, at));
    const escorts: Entity[] = [];
    for (const [id, n] of Object.entries(escortComp)) escorts.push(...s.spawnUnits(id, n, E, polar(at, toTarget + Math.PI, 4), { tags: ['omega_escort', 'scripted'] }));
    if (omega) s.march([omega], target, { name: 'omega', assertive: true });
    s.march(escorts, target, { name: 'omega-escort' });

    if (byDifficulty(d, T.aiAttacksAfterOmega)) { s.setAiFlags({ attack: true }); s.setAiAttackTarget(target()); }
    s.revealObjective('omega');
    s.reveal(at, 14, 20);
    s.ping(at, 0xd64bff);
    s.panTo(at, 2);
    s.shake(0.8, 1.8);
    s.notify('STRAIN OMEGA HAS EMERGED', 'alert');
    s.say(early ? M3_LINES.emergeEarly : M3_LINES.emerge, { urgent: true });
    s.after(12, () => s.hint(M3_HINTS.omega, { id: 'omega' }), 'hint-omega');
    if (omega) {
      s.onHpBelow(omega, 0.66, () => s.bark(M3_LINES.omega66, 15), 'omega-66');
      s.onHpBelow(omega, 0.33, () => s.say(M3_LINES.omega33, { expires: 15 }), 'omega-33');
      s.onDeath(omega, () => this.omegaDown(), { name: 'omega-down' });
    }
  }

  private omegaDown(): void {
    const s = this.script;
    s.completeObjective('omega');
    if (this.core?.alive) s.say(M3_LINES.omegaDown, { urgent: true });
  }

  private coreDown(): void {
    const s = this.script;
    s.completeObjective('core');
    if (!this.omegaSpawned) this.emergeOmega(true);
    else if (this.omega?.alive) s.bark(M3_LINES.coreDown, 15);
  }

  // ───────────────────────── endings ─────────────────────────

  private scriptEndings(): void {
    const s = this.script, P = s.playerId;
    const lose = (lines: ReturnType<typeof line>[], reason: string) => () => {
      s.dialogue.clear();
      s.defeat(reason, { delay: s.say(lines, { urgent: true }) + 0.5 });
    };
    if (this.childrens) s.onDeath(this.childrens, lose(M3_LINES.defeatChildren, "The Children's Hospital has fallen"), { name: 'lose-children' });
    s.when(() => s.count(P, 'hosp_hq') === 0, lose(M3_LINES.defeatHq, 'The Central Hospital has fallen'), { interval: 0.25, name: 'lose-hq' });
    s.when(() => this.omegaSpawned && !this.omega?.alive && !this.core?.alive, () => {
      s.completeObjective('omega');
      s.completeObjective('core');
      s.dialogue.clear();
      s.victory('Strain Omega and the Infection Core have been destroyed', { delay: s.say(M3_LINES.victory, { urgent: true }) + 0.5 });
    }, { interval: 0.25, name: 'win' });
  }
}
