/**
 * [combat] Tuning constants for weapons, targeting, unit combat behaviour, healing and abilities.
 * Gameplay numbers (damage, ranges, cooldowns) live in src/data; these are behavioural knobs.
 */

// ── ranges & aiming ──
/** Slack added to every "in range?" test so units that stop a hair short (collision) still fire. */
export const RANGE_TOLERANCE = 0.1;
/** While an attack is winding up the target may drift this far out of range without cancelling it. */
export const WINDUP_LEEWAY = 0.75;
/** A unit may start an attack once its facing is within this angle (radians) of the target. */
export const FIRE_ARC = 0.35;
/** Turn rates (radians / second) while aiming: normal units and heavy (large-radius) units. */
export const TURN_RATE = 12;
export const TURN_RATE_HEAVY = 6;
export const HEAVY_RADIUS = 0.9;

// ── target acquisition ──
/** Ticks between acquisition scans for units without a target (staggered by entity id). */
export const SCAN_INTERVAL = 5;
/** Ticks between re-evaluations of the current automatic target (switch if something better appears). */
export const RESCAN_INTERVAL = 10;
/** Near-first scans look this far beyond weapon range before falling back to the full sight radius. */
export const NEAR_SCAN_EXTRA = 3;
/** Score improvement required to switch automatic targets within the same priority class. */
export const SWITCH_MARGIN = 1.0;
/** Auto-chasing units give up once they are this many × sight away from where the engagement began. */
export const LEASH_MUL = 1.5;
/** After giving up on a target it is ignored by automatic targeting for this long (s). */
export const IGNORE_TIME = 3;
/** A chaser that cannot get into range while standing still this long (s) treats the target as unreachable. */
export const STUCK_TIME = 2.5;
/** Re-issue a chase / back-off move at most this often (s) while not moving. */
export const CHASE_REFRESH = 0.5;
/** Units hit within this window (s) retaliate against their attacker even beyond sight. */
export const RETALIATE_WINDOW = 3;
/** Allies within the same/adjacent help cell respond to an attack on a friend within this window (s). */
export const HELP_WINDOW = 2.5;
/** Help-call grid cell size (tiles). */
export const HELP_CELL = 8;
/** Idle units walk back to their guard position after an automatic chase if farther than this. */
export const GUARD_RETURN_DIST = 1.5;
/** Priority weights: class (threat 0 / unit 1 / worker 2 / structure 3) dominates, then distance + damage. */
export const CATEGORY_WEIGHT = 1000;
export const DAMAGED_WEIGHT = 2;
/** Bonus (score units ≈ tiles) for whoever recently attacked us / a nearby friend. */
export const RETALIATE_BONUS = 2;
export const HELP_BONUS = 1;
/** Extra query radius so rectangular footprints (corners beyond the bounding circle) are found. */
export const BUILDING_QUERY_PAD = 1.1;

// ── projectiles ──
/** Shot heights above ground (world units): buildings; ground units use 0.5 + 0.75 × radius (≈0.8 infantry). */
export const SHOT_HEIGHT_BUILDING = 1.5;
/** Projectiles older than this (s) fizzle — a homing shot that can't catch a fast target never leaks. */
export const MAX_FLIGHT = 8;
/** Arc shots without splash still hit anything within this radius of the landing point. */
export const ARC_DIRECT_RADIUS = 0.35;

// ── healing ──
/** Healers heal in pulses (one entityHealed event per pulse): amount = rate × healRateMul × HEAL_PULSE. */
export const HEAL_PULSE = 0.5;

// ── abilities ──
/** Seconds a unit stays in the 'casting' activity after casting through an 'ability' order. */
export const CAST_ANIM = 0.35;
/** Emergency Supply: resources arrive this long (s) after abilityUsed (the helicopter flight). */
export const EMERGENCY_SUPPLY_DELAY = 2;
/** Strain Omega: first brood this long (s) after it appears, then every ability cooldown. */
export const OMEGA_FIRST_DELAY = 6;
/** Strain Omega keeps at most this many of its spawned phages alive. */
export const OMEGA_MAX_BROOD = 12;
export const OMEGA_BROOD_UNIT = 'path_phage';
/** Phages spawned without a destination attack-move this far ahead of Strain Omega. */
export const OMEGA_ADVANCE = 7;
