/**
 * [audio] Pure combat-intensity estimator → match music mood (Node-testable).
 *
 * Inputs (fed by the engine from world events): combat involving the local player's units/buildings
 * (weapons fired by/at them, damage taken/dealt, losses) and a periodic "threat" count of visible enemy
 * combat units near the local player's entities. The intensity decays exponentially.
 *
 * Mood rules (with hysteresis so the score doesn't flap):
 *  - battle  when intensity ≥ 2.2 (stays until it drops below 1.1 for 7 s)
 *  - tension when intensity ≥ 0.35 or any threat (stays until quiet for 10 s)
 *  - calm    otherwise
 * Upward moves are immediate (≥ 1.5 s after the last change); downward moves step one level at a time.
 */
export type MatchMood = 'calm' | 'tension' | 'battle';

const RANK: Record<MatchMood, number> = { calm: 0, tension: 1, battle: 2 };

export const MOOD_TUNING = {
  /** intensity decay time constant (s) */
  decay: 7,
  battleEnter: 2.2,
  battleExit: 1.1,
  tensionEnter: 0.35,
  tensionExit: 0.15,
  /** seconds below the exit threshold before stepping down */
  battleHold: 7,
  tensionHold: 10,
  /** minimum seconds in a mood before stepping down */
  minDwell: 10,
  maxIntensity: 12,
};

export class MoodDirector {
  intensity = 0;
  threat = 0;
  mood: MatchMood = 'calm';
  private sinceChange = 0;
  private belowFor = 0;

  reset(): void {
    this.intensity = 0; this.threat = 0; this.mood = 'calm'; this.sinceChange = 0; this.belowFor = 0;
  }

  /** Add combat activity (≈ 0.08 per shot fired near us, more for damage taken and losses). */
  addCombat(amount: number): void {
    if (!(amount > 0)) return;
    this.intensity = Math.min(MOOD_TUNING.maxIntensity, this.intensity + amount);
  }

  /** Number of visible enemy combat units near the local player's entities. */
  setThreat(n: number): void { this.threat = Math.max(0, n | 0); }

  /** What the intensity alone asks for, given the current mood (hysteresis thresholds). */
  desired(): MatchMood {
    const T = MOOD_TUNING;
    const battleT = this.mood === 'battle' ? T.battleExit : T.battleEnter;
    const tensionT = this.mood === 'calm' ? T.tensionEnter : T.tensionExit;
    if (this.intensity >= battleT) return 'battle';
    if (this.intensity >= tensionT || this.threat > 0) return 'tension';
    return 'calm';
  }

  update(dt: number): MatchMood {
    if (!(dt > 0)) return this.mood;
    const T = MOOD_TUNING;
    this.intensity *= Math.exp(-dt / T.decay);
    if (this.intensity < 1e-4) this.intensity = 0;
    this.sinceChange += dt;
    const want = this.desired();
    if (RANK[want] > RANK[this.mood]) {
      this.belowFor = 0;
      if (this.mood === 'calm' || this.sinceChange >= 1.5) this.set(want);
    } else if (RANK[want] < RANK[this.mood]) {
      this.belowFor += dt;
      const hold = this.mood === 'battle' ? T.battleHold : T.tensionHold;
      if (this.belowFor >= hold && this.sinceChange >= T.minDwell) this.set(this.mood === 'battle' ? 'tension' : 'calm');
    } else {
      this.belowFor = 0;
    }
    return this.mood;
  }

  private set(m: MatchMood): void { this.mood = m; this.sinceChange = 0; this.belowFor = 0; }
}
