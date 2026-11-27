/**
 * [ai] OWNER: AI agent. The Contagion's opponent AI. Plays through world.issue(...) exactly like a human
 * (same costs, rules and fog), except where a difficulty explicitly grants a bonus (player.gatherMul).
 */
import type { Difficulty, PlayerId, Vec2 } from '../core/types';
import type { World } from '../sim/World';

export interface AiFlags {
  economy: boolean;   // train workers, gather, build supply/energy
  build: boolean;     // construct tech/production buildings
  army: boolean;      // train combat units
  attack: boolean;    // launch attack waves on its own schedule
  expand: boolean;    // take new resource sites
  defend: boolean;    // respond to attacks on its bases
}

export interface AiController {
  readonly playerId: PlayerId;
  difficulty: Difficulty;
  /** Called once per sim tick (before world.step). Throttle internally. */
  update(dt: number): void;
  setFlags(flags: Partial<AiFlags>): void;
  getFlags(): AiFlags;
  /** Campaign hooks */
  sendWave(composition: Record<string, number>, spawnAt: Vec2, target: Vec2): number[]; // spawns units for free (scripted) and attack-moves them; returns ids
  attackNow(target?: Vec2): void;     // launch the current army immediately
  setAttackTarget(target: Vec2 | null): void;
  /** Debug/telemetry for HUD & tests */
  describe(): string;
}

class StubAi implements AiController {
  private flags: AiFlags = { economy: true, build: true, army: true, attack: true, expand: true, defend: true };
  constructor(private world: World, readonly playerId: PlayerId, public difficulty: Difficulty) {}
  update(): void {}
  setFlags(f: Partial<AiFlags>): void { Object.assign(this.flags, f); }
  getFlags(): AiFlags { return { ...this.flags }; }
  sendWave(composition: Record<string, number>, spawnAt: Vec2, target: Vec2): number[] {
    const ids: number[] = [];
    for (const [defId, n] of Object.entries(composition)) for (let i = 0; i < n; i++) {
      const p = this.world.movement.nearestWalkable({ x: spawnAt.x + (i % 4) - 1.5, y: spawnAt.y + Math.floor(i / 4) }) ?? spawnAt;
      ids.push(this.world.spawnUnit(defId, this.playerId, p).id);
    }
    this.world.issue({ type: 'attackMove', playerId: this.playerId, unitIds: ids, target });
    return ids;
  }
  attackNow(): void {}
  setAttackTarget(): void {}
  describe(): string { return 'stub AI (idle)'; }
}

export function createAi(world: World, playerId: PlayerId, opts: { difficulty: Difficulty }): AiController {
  return new StubAi(world, playerId, opts.difficulty);
}
