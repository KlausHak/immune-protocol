/**
 * [campaign] Mission 2 — "Containment Breach" (map meilahti, night). OWNER: campaign agent.
 *
 * Full AI with attacks. Two satellite Infection Cores (east_nest_core / west_nest_core, in the regions
 * enemy_east_nest / enemy_west_nest) pump a biofilm shield into the main core at enemy_start: the main
 * core is invulnerable until both satellites are destroyed. Everything must fall before the contamination
 * countdown (20:00 on normal) runs out.
 * Bonus: keep the forward Research Lab alive (it gets raided).
 * Lose: timer expires, or no Central Hospital left.  Win: both satellites and the main core destroyed.
 */
import { angleOf, dist, sub } from '../../core/math';
import type { Entity, Vec2 } from '../../core/types';
import type { MissionInfo } from '../index';
import {
  byDifficulty, line, lerpPoint, polar, refOf, scaleComposition, ScriptedMission, type Composition, type SavedRef,
} from '../script';

export const M2_INFO: MissionInfo = {
  id: 'm2', order: 2, title: 'Containment Breach', subtitle: 'Mission 2', mapId: 'meilahti',
  briefing: [
    'Three nights after Patient Zero. The laundry is ash, the wards are reopening, and the storm drains under Haartmaninkatu have started to glow.',
    'The Contagion survived by splitting. Two satellite cores have taken root, one at the sewer outflow in the north-east and one in the waste depot to the west, and they pump a protective biofilm into a rebuilt main core.',
    'SISU projects campus-wide saturation in about twenty minutes. Cut the satellites, crack the main core, and keep the forward research lab standing: its antiviral samples are the only head start we have.',
  ],
  objectivesPreview: [
    'Destroy the east and west satellite cores',
    'Destroy the main Infection Core once its shield is down',
    'Win before the contamination timer runs out',
    'Bonus: keep the Research Lab alive',
  ],
};

export const M2_TUNING = {
  /** contamination countdown, seconds */
  timer: { easy: 24 * 60, normal: 20 * 60, hard: 18 * 60, brutal: 16 * 60 },
  startSupplies: 400,
  startPower: 100,
  /** mission seconds at which a raid goes for the Research Lab */
  labRaids: { easy: [600], normal: [420, 780], hard: [360, 660, 960], brutal: [300, 540, 780, 1020] },
  labRaid: { path_phage: 5, path_bacillus: 2, path_flu_drifter: 1 } as Composition,
  retaliation: { path_phage: 5, path_bacillus: 3, path_spirochete: 1 } as Composition,
  /** multiplier on the AI's own gather rate (balance-probed) */
  aiGatherMul: { easy: 0.6, normal: 0.8, hard: 1, brutal: 1.1 },
};

const NUMBER_WORDS: Record<number, string> = { 16: 'sixteen', 18: 'eighteen', 20: 'twenty', 24: 'twenty-four' };

export const M2_LINES = {
  intro: (minutes: number) => [
    line('sisu', `02:14. Contamination is spreading through the storm drains under Haartmaninkatu. Projected campus saturation: ${NUMBER_WORDS[minutes] ?? minutes} minutes.`),
    line('cmo', 'It survived by splitting. Two satellite cores, east at the sewer outflow and west in the waste depot, feeding a new main core.'),
    line('engineer', 'Those satellites pump biofilm into the main core. While they live, you could hit it with a tram and it would say thank you.'),
    line('cmo', 'Cut both satellites, then crack the main core. And keep the research lab standing. Our only antiviral samples are in there.'),
  ],
  cue: {
    900: line('sisu', 'Fifteen minutes to saturation. The service tunnels are getting warm. That is not good news for anyone.'),
    600: line('sisu', 'Ten minutes. Spore counts in the tunnels are doubling every ninety seconds.'),
    300: line('cmo', "Five minutes. Whatever you're holding in reserve, stop holding it."),
    120: line('engineer', "Two minutes! The ventilation intakes are turning green. I'm sealing what I can."),
    60: line('sisu', 'Sixty seconds. For the record, I remained calm throughout.'),
  } as Record<number, ReturnType<typeof line>>,
  satDown: {
    east: line('sisu', 'East satellite destroyed. Biofilm flow to the main core down by half.'),
    west: line('sisu', 'West satellite destroyed. Biofilm flow to the main core down by half.'),
  },
  firstSat: line('engineer', 'Half a shield is still a shield. Keep going.'),
  retaliation: line('sisu', 'It felt that. A counter-attack is forming and heading for the hospital.'),
  shieldDown: [
    line('sisu', 'Biofilm flow terminated. The main core is exposed.'),
    line('cmo', 'Now. Everything we have, north to the core. End this before the clock does.'),
  ],
  shielded: line('sisu', 'Our shots are sliding off the main core. The biofilm shield holds while either satellite lives.'),
  labRaid: line('sisu', 'Hostiles moving on the research lab. They know exactly what is in those freezers.'),
  labHit: [
    line('engineer', 'The lab is taking hits! Get someone over there before they chew through the cold storage.'),
    line('engineer', "Lab's under attack again. Orderlies can patch it up if you get them there."),
  ],
  labLost: line('cmo', "We've lost the lab. Twelve years of samples... Focus. We grieve when this is over."),
  victory: [
    line('cmo', 'Main core neutralised. The tunnels are going quiet.'),
    line('sisu', 'Contamination receding. Recommendation: coffee. A great deal of coffee.'),
  ],
  victoryLab: line('engineer', "And the lab's still standing. The samples are safe. I've labelled them 'do not lick'."),
  defeatTimer: [line('sisu', 'Saturation threshold reached. Campus containment has failed.')],
  defeatHq: [line('cmo', "The Central Hospital has fallen. Pull everyone back across the bridge. We've lost Meilahti.")],
};

export const M2_HINTS = {
  shield: 'The main core is shielded until both satellite cores are destroyed. Strike the satellites first.',
  lab: 'The Research Lab is a bonus objective. Orderly Bots can repair it, and a UV Turret beside it helps.',
  depot: 'An Ambulance Depot (V, V) builds Antibiotic Launchers: long-range splash that ruins bacteria.',
  power: 'Advanced units need Power. Backup Generators (B, G) keep it flowing.',
};

export class ContainmentBreach extends ScriptedMission {
  private hq: Entity | null = null;
  private lab: Entity | null = null;
  private mainCore: Entity | null = null;
  private sats: Record<'east' | 'west', Entity | null> = { east: null, west: null };
  private satsDown = 0;
  private labHits = 0;

  protected spawn(): void {
    const s = this.script, P = s.playerId, E = s.enemyId, d = s.difficulty, T = M2_TUNING;
    s.spawnMapResources();
    s.setResources(P, { matter: T.startSupplies, energy: T.startPower });
    s.setResources(E, { matter: 300, energy: 100 });

    // ── Hospital base (already established after Mission 1)
    const start = s.refs.point('player_start');
    const enemyStart = s.refs.point('enemy_start');
    this.hq = s.spawnBuilding('hosp_hq', P, start, { exact: true, force: true, tags: ['hq'] });
    const home = this.hq?.pos ?? start;
    const toEnemy = angleOf(sub(enemyStart, home));
    const within = 'player_base';
    s.spawnBuilding('hosp_pharmacy', P, polar(home, toEnemy + 1.0, 7.5), { within });
    s.spawnBuilding('hosp_generator', P, polar(home, toEnemy + Math.PI - 0.9, 6.5), { within });
    s.spawnBuilding('hosp_ward', P, polar(home, toEnemy - 1.3, 6.5), { within });
    s.spawnBuilding('hosp_ward', P, polar(home, toEnemy - 1.9, 7), { within });
    s.spawnBuilding('hosp_uv_turret', P, polar(home, toEnemy, 8.5), { within });
    // The forward lab sits a third of the way towards the campus centre: exposed, on purpose.
    this.lab = s.spawnBuilding('hosp_lab', P, lerpPoint(home, s.refs.point('rally_center'), 0.32), { search: 12, tags: ['lab', 'objective'] });

    const cache = s.world.spatial.nearest(home, 24, (e) => e.kind === 'resource');
    const toCache = cache ? angleOf(sub(cache.pos, home)) : toEnemy + Math.PI;
    s.spawnUnits('hosp_orderly', 8, P, polar(home, toCache, 4.8), { gather: true });
    const rally = polar(home, toEnemy, 6.5);
    s.spawnUnits('hosp_sanitizer', 8, P, rally, { facing: toEnemy });
    s.spawnUnits('hosp_medic', 2, P, polar(rally, toEnemy + Math.PI, 2.6), { facing: toEnemy });
    s.spawnUnits('hosp_uv_lancer', 2, P, polar(rally, toEnemy + Math.PI / 2, 2.6), { facing: toEnemy });
    if (this.lab) s.spawnUnits('hosp_sanitizer', byDifficulty(d, { easy: 4, normal: 3, hard: 2 }), P, polar(this.lab.pos, toEnemy, 3.5), { facing: toEnemy, tags: ['lab_guard'] });

    s.ensureBeds(P, 10, polar(home, toEnemy + Math.PI, 7)); // room to train from minute one

    // ── Contagion: main core (shielded) + two satellites
    this.mainCore = this.buildMainBase(enemyStart, home);
    this.sats.east = this.buildSatellite('east', home);
    this.sats.west = this.buildSatellite('west', home);
    // The satellites already give the Contagion three mining bases: slow its harvest and only let it expand on hard+.
    s.setAiFlags({ economy: true, build: true, army: true, attack: true, expand: d === 'hard' || d === 'brutal', defend: true });
    const foe = s.world.players.get(E);
    if (foe) foe.gatherMul *= byDifficulty(d, M2_TUNING.aiGatherMul);
  }

  protected scriptMission(): void {
    const s = this.script;
    s.setLighting('night');
    s.defineAction('retaliation', () => {
      if (s.finished) return;
      s.sendWave(M2_TUNING.retaliation, 'wave_spawn_north', { name: 'm2-retaliation', tags: ['retaliation'] });
      s.bark(M2_LINES.retaliation, 15);
    });
    this.scriptObjectives();
    this.scriptTimer();
    this.scriptRaids();
    this.scriptEndings();
  }

  protected intro(): void {
    const s = this.script;
    const east = this.sats.east?.pos ?? s.refs.point('east_nest_core');
    const west = this.sats.west?.pos ?? s.refs.point('west_nest_core');
    const main = this.mainCore?.pos ?? s.refs.point('enemy_start');
    const home = this.hq?.pos ?? s.refs.point('player_start');
    for (const p of [east, west, main]) { s.reveal(p, 10, 16); s.ping(p); }
    s.lookAt(main, true);
    const lines = M2_LINES.intro(Math.round(byDifficulty(s.difficulty, M2_TUNING.timer) / 60));
    const ends = lines.map((l) => s.say(l));
    s.after(Math.max(0.5, ends[0]! - 0.5), () => s.panTo(east, 2.5), 'intro-east');
    s.after(Math.max(1, ends[1]! - 2.5), () => s.panTo(west, 2.5), 'intro-west');
    s.after(Math.max(1.5, ends[2]! - 0.5), () => s.panTo(home, 3), 'intro-home');
    s.hintLater(ends[3]! + 0.5, M2_HINTS.shield, 'shield');
  }

  protected saveState(): Record<string, unknown> {
    return {
      hq: refOf(this.hq), lab: refOf(this.lab), mainCore: refOf(this.mainCore), east: refOf(this.sats.east), west: refOf(this.sats.west),
      satsDown: this.satsDown, labHits: this.labHits,
    };
  }

  protected loadState(d: Record<string, unknown>): void {
    this.hq = this.deref(d.hq as SavedRef);
    this.lab = this.deref(d.lab as SavedRef);
    this.mainCore = this.deref(d.mainCore as SavedRef);
    this.sats = { east: this.deref(d.east as SavedRef), west: this.deref(d.west as SavedRef) };
    this.satsDown = d.satsDown as number;
    this.labHits = d.labHits as number;
  }

  // ───────────────────────── setup helpers ─────────────────────────

  private buildMainBase(at: Vec2, playerPos: Vec2): Entity | null {
    const s = this.script, E = s.enemyId, d = s.difficulty;
    const core = s.spawnBuilding('path_hive', E, at, { exact: true, force: true, tags: ['core', 'main_core', 'objective'], invulnerable: true });
    const c = core?.pos ?? at;
    const front = angleOf(sub(playerPos, c));
    const within = 'enemy_core';
    s.spawnBuilding('path_replicator', E, polar(c, front + 1.4, 7), { within });
    s.spawnBuilding('path_mutation_pit', E, polar(c, front - 1.4, 7), { within });
    s.spawnBuilding('path_nest', E, polar(c, front + Math.PI - 0.6, 6.5), { within });
    s.spawnBuilding('path_nest', E, polar(c, front + Math.PI + 0.6, 6.5), { within });
    s.spawnBuilding('path_fermenter', E, polar(c, front + Math.PI, 7.5), { within });
    const spitters = byDifficulty(d, { easy: 1, normal: 2, hard: 3, brutal: 4 });
    for (let i = 0; i < spitters; i++) s.spawnBuilding('path_toxin_spitter', E, polar(c, front + (i - (spitters - 1) / 2) * 0.55, 8.5), { within });
    s.spawnUnits('path_spore_drone', 6, E, polar(c, front + Math.PI, 4.5), { gather: true });
    for (const [id, n] of Object.entries(scaleComposition({ path_phage: 4, path_bacillus: 3, path_spirochete: 2 }, d))) {
      s.spawnUnits(id, n, E, polar(c, front, 5.5), { facing: front }); // untagged: AI-controlled
    }
    return core;
  }

  private buildSatellite(side: 'east' | 'west', playerPos: Vec2): Entity | null {
    const s = this.script, E = s.enemyId, d = s.difficulty;
    const at = s.refs.point(`${side}_nest_core`);
    const core = s.spawnBuilding('path_hive', E, at, { exact: true, force: true, tags: ['core', 'satellite', `sat_${side}`, 'objective'] });
    const c = core?.pos ?? at;
    const front = angleOf(sub(playerPos, c));
    const within = `enemy_${side}_nest`;
    s.spawnBuilding('path_nest', E, polar(c, front + Math.PI, 5.5), { within });
    const spitters = byDifficulty(d, { easy: 1, normal: 1, hard: 2, brutal: 2 });
    for (let i = 0; i < spitters; i++) s.spawnBuilding('path_toxin_spitter', E, polar(c, front + (i - (spitters - 1) / 2) * 0.8, 6.5), { within });
    s.spawnUnits('path_spore_drone', 2, E, polar(c, front + Math.PI, 4), { gather: true });
    const post = s.walkableNear(polar(c, front, 4.5));
    const garrison: Entity[] = [];
    for (const [id, n] of Object.entries(scaleComposition({ path_phage: 3, path_bacillus: 2 }, d))) {
      garrison.push(...s.spawnUnits(id, n, E, post, { tags: [`garrison_${side}`, 'scripted'], facing: front })); // script-guarded
    }
    s.guard(garrison, post, 8);
    return core;
  }

  // ───────────────────────── objectives ─────────────────────────

  private scriptObjectives(): void {
    const s = this.script, P = s.playerId;
    s.addObjective({ id: 'east', text: 'Destroy the east satellite core (sewer outflow)' });
    s.addObjective({ id: 'west', text: 'Destroy the west satellite core (waste depot)' });
    s.addObjective({ id: 'main', text: 'Destroy the main Infection Core', progress: 'Shielded' });
    if (this.lab) s.addObjective({ id: 'lab', text: 'Keep the Research Lab alive', primary: false, progress: 'Integrity 100%' });

    s.every(0.5, () => {
      const m = this.mainCore;
      if (s.objectives.isActive('main') && m) s.setProgress('main', !m.alive ? undefined : m.invulnerable ? 'Shielded' : `Exposed · ${Math.ceil((m.hp / m.stats.maxHp) * 100)}%`);
      const lab = this.lab;
      if (lab && s.objectives.isActive('lab')) s.setProgress('lab', `Integrity ${Math.max(0, Math.ceil((lab.hp / lab.stats.maxHp) * 100))}%`);
    }, { start: 0, name: 'progress' });

    for (const side of ['east', 'west'] as const) {
      s.onDeath({ tag: `sat_${side}` }, () => this.satelliteDown(side), { name: `sat-${side}` });
    }
    // Shield drops once neither satellite is alive (also covers satellites removed by other means).
    s.when(() => this.satsDead(), () => this.dropShield(), { interval: 0.25, name: 'shield-drop' });
    if (this.mainCore) {
      const shielded = s.onEvent('weaponFired', (p) => p.source.owner === P && p.target === this.mainCore && !!this.mainCore?.invulnerable, () => {
        shielded.cancel();
        s.bark(M2_LINES.shielded);
        s.hint(M2_HINTS.shield, { id: 'shield-2' });
      }, { name: 'shielded-hit' });
    }
    if (this.lab) {
      const lab = this.lab;
      s.onDamaged(lab, () => {
        if (this.labHits >= M2_LINES.labHit.length) return;
        s.bark(M2_LINES.labHit[this.labHits++]!);
        s.ping(lab.pos, 0xffb23b);
        if (this.labHits === 1) s.hint(M2_HINTS.lab, { id: 'lab' });
      }, { cooldown: 45, name: 'lab-hit' });
      s.onDeath(lab, () => {
        if (s.failObjective('lab')) s.bark(M2_LINES.labLost, 20);
      }, { name: 'lab-lost' });
    }
    s.at(150, () => s.hint(M2_HINTS.depot, { id: 'depot' }), 'hint-depot');
    s.when(() => s.world.player(P).resources.energy < 20 && s.time > 240, () => s.hint(M2_HINTS.power, { id: 'power' }), { interval: 5, name: 'hint-power' });
  }

  private satsDead(): boolean {
    return !this.sats.east?.alive && !this.sats.west?.alive;
  }

  private satelliteDown(side: 'east' | 'west'): void {
    const s = this.script;
    if (!s.completeObjective(side)) return;
    this.satsDown++;
    s.bark(M2_LINES.satDown[side], 20);
    if (this.satsDown === 1) {
      s.bark(M2_LINES.firstSat, 20);
      // The Contagion lashes out after losing its first satellite.
      s.schedule(20, 'retaliation');
    }
  }

  private dropShield(): void {
    const s = this.script;
    for (const side of ['east', 'west'] as const) s.completeObjective(side);
    const core = this.mainCore;
    if (!core || !core.alive) return;
    core.invulnerable = false;
    s.setProgress('main', 'Exposed');
    s.say(M2_LINES.shieldDown, { urgent: true });
    s.reveal(core.pos, 10, 10);
    s.ping(core.pos);
  }

  // ───────────────────────── timer & raids ─────────────────────────

  private scriptTimer(): void {
    const s = this.script;
    const total = byDifficulty(s.difficulty, M2_TUNING.timer);
    const cues = Object.entries(M2_LINES.cue).map(([at, l]) => ({ at: Number(at), fn: () => s.bark(l, 20) }));
    s.startTimer('Contamination', total, () => {
      s.dialogue.clear();
      s.defeat('Contamination saturated the campus', { delay: s.say(M2_LINES.defeatTimer, { urgent: true }) + 0.5 });
    }, cues);
  }

  private scriptRaids(): void {
    const s = this.script;
    const raids = byDifficulty(s.difficulty, M2_TUNING.labRaids);
    raids.forEach((t, i) => s.at(t, () => {
      const lab = this.lab;
      if (!lab || !lab.alive || s.finished) return;
      s.sendWave(M2_TUNING.labRaid, this.gateNearest(lab.pos), { name: `m2-lab-raid${i + 1}`, target: lab, tags: ['lab_raid'] });
      s.bark(M2_LINES.labRaid, 15);
      s.ping(lab.pos, 0xffb23b);
    }, `lab-raid${i + 1}`));
  }

  /** The wave gate closest to a position (deterministic tie-break by name order). */
  private gateNearest(p: Vec2): string {
    const s = this.script;
    const gates = ['wave_spawn_north', 'wave_spawn_east', 'wave_spawn_west'];
    let best = gates[0]!, bd = Infinity;
    for (const g of gates) { const d = dist(s.refs.point(g), p); if (d < bd) { bd = d; best = g; } }
    return best;
  }

  // ───────────────────────── endings ─────────────────────────

  private scriptEndings(): void {
    const s = this.script, P = s.playerId;
    s.when(() => s.count(P, 'hosp_hq') === 0, () => {
      s.dialogue.clear();
      s.defeat('The Central Hospital has fallen', { delay: s.say(M2_LINES.defeatHq, { urgent: true }) + 0.5 });
    }, { interval: 0.25, name: 'lose-hq' });
    s.when(() => !this.mainCore?.alive && this.satsDead(), () => {
      for (const id of ['east', 'west', 'main']) s.completeObjective(id);
      const labAlive = !!this.lab?.alive;
      if (labAlive) s.completeObjective('lab');
      s.dialogue.clear();
      const lines = labAlive ? [...M2_LINES.victory, M2_LINES.victoryLab] : M2_LINES.victory;
      s.victory('The main Infection Core has been destroyed', { delay: s.say(lines, { urgent: true }) + 0.5 });
    }, { interval: 0.25, name: 'win' });
  }
}
