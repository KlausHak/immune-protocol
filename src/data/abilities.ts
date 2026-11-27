import type { AbilityDef } from '../core/types';

/** Ability definitions. Implementations live in src/sim/combat (abilities registry). OWNER: combat module may tune/extend. */
export const ABILITIES: AbilityDef[] = [
  { id: 'uv_flare', name: 'UV Flare', description: 'Detonate a burst of UV-C light at a target area: 30 damage (+30 vs viral) in radius 2.5.', hotkey: 'F', target: 'point', cooldown: 25, range: 7, radius: 2.5, damage: 30, damageType: 'uv', bonus: { viral: 30 } },
  { id: 'emergency_supply', name: 'Emergency Supply Drop', description: 'A medical helicopter drops an emergency crate: +100 Supplies.', hotkey: 'E', target: 'none', cooldown: 120, amount: 100 },
  { id: 'viral_burst', name: 'Viral Burst', description: 'Passive: bursts on death, dealing 6 toxin damage to enemies within 1.3.', hotkey: '', target: 'passive', cooldown: 0, radius: 1.3, damage: 6, damageType: 'toxin' },
  { id: 'omega_spawn', name: 'Mitotic Spawn', description: 'Passive: every 18 seconds Strain Omega sheds 3 Phages.', hotkey: '', target: 'passive', cooldown: 18, amount: 3 },
];
