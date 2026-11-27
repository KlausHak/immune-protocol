/**
 * [economy] Tunables. Distances are edge-to-edge world units (see World.edgeDistance) unless noted.
 */

// ── gathering ──
/** A worker works a Supply Cache / hands cargo to a drop-off once within this edge distance. */
export const GATHER_RANGE = 0.3;
export const DROPOFF_RANGE = 0.3;
/** Extra distance accepted when the mover reports "arrived" but stopped a little short (crowding, rounding). */
export const ARRIVE_SLACK = 0.35;
/** Seconds a worker spends handing its load over at the drop-off. Tuned so 12 workers on the 6 caches next to the
 *  test-map HQ make ≈ 600 matter/min (1 worker ≈ 50/min, 6 ≈ 300/min). */
export const DROPOFF_TIME = 1.5;
/** Seconds a cache's gathering spot stays blocked after a worker leaves it (the next worker steps in). Only matters
 *  when workers queue, so a 3rd worker per cache adds little (≈ +15%) — "~2 per cache is efficient; more queue". */
export const SLOT_HANDOFF = 0.4;
/** A worker waiting at a busy cache looks for a free cache within this many tiles of it. */
export const BOUNCE_RADIUS = 10;
/** Seconds between bounce re-evaluations while waiting. */
export const WAIT_RECHECK = 0.5;
/** Max bounces per trip (prevents ping-pong between two busy caches). */
export const MAX_BOUNCES = 2;
/** When a cache is depleted / unreachable, workers switch to the best cache within this radius of it. */
export const SWITCH_RADIUS = 12;
/** Group gather orders are spread across the caches within this radius of the clicked cache. */
export const SPREAD_RADIUS = 13;
/** Score penalty (≈ tiles of extra walking) per worker already assigned to a cache, when picking caches. */
export const SATURATION_PENALTY = 3;
/** Movement retries per leg before a worker gives up on a target. */
export const LEG_RETRIES = 3;

// ── construction & repair ──
/** Builders work on a site/foundation within this edge distance. */
export const BUILD_RANGE = 1.0;
export const MAX_BUILDERS = 3;
/** Each extra builder adds this fraction of the base construction speed. */
export const ASSIST_BONUS = 0.6;
export const CANCEL_REFUND = 0.75;
/** Seconds a builder keeps retrying when the site is temporarily blocked (enemy unit standing on it). */
export const SITE_BLOCKED_PATIENCE = 4;
export const REPAIR_RANGE = 0.8;
/** A full 0 → max repair costs this fraction of the target's matter cost. */
export const REPAIR_COST_FRACTION = 0.25;
/** Repair speed per repairer, hp/s = clamp(maxHp / buildTime, MIN, MAX). */
export const REPAIR_RATE_MIN = 4;
export const REPAIR_RATE_MAX = 25;
/** Seconds between batched entityHealed events while repairing (avoids 20 Hz event spam). */
export const HEAL_EVENT_INTERVAL = 0.5;

// ── placement ──
/** An HQ footprint must keep at least this many tiles of clearance from every Supply Cache footprint. */
export const HQ_RESOURCE_GAP = 3;
/** findBuildSpot: resource caches within this radius of a drop-off define worker lanes to keep clear. */
export const LANE_RADIUS = 13;
/** findBuildSpot: half-width (tiles) of a worker lane between a drop-off and a cache. */
export const LANE_HALF_WIDTH = 1.25;

// ── income tracking ──
/** incomeRate() default rolling window (seconds). */
export const INCOME_WINDOW = 60;
/** Seconds of samples kept for incomeRate(). */
export const INCOME_HISTORY = 180;
