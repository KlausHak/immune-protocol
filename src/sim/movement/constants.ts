/**
 * [movement] Tuning constants for pathfinding, steering and vision. Distances in world units (= tiles),
 * times in seconds. Exported so other modules/tests can reason about the movement contract.
 */

// ── path requests ──
/** Path-planning work per tick (≈ A-star / Dijkstra node expansions + LOS tile visits). ~1–2 ms of CPU. */
export const PATH_BUDGET = 14000;
/** Always serve at least this many queued requests per tick, even over budget. */
export const MIN_PATHS_PER_TICK = 2;
/** Group members (same command, same size class) still waiting for a path before a shared Dijkstra field
 *  is built instead of one A* each. */
export const GROUP_FIELD_MIN = 8;
/** Cached Dijkstra fields (LRU). */
export const FIELD_POOL = 6;
/** Extra distance searched past the farthest group member (covers members that moved a little). */
export const FIELD_SLACK = 10;
/** Straight-line shortcut is tried before queuing a search when the goal is closer than this. */
export const DIRECT_MAX = 48;
/** Unreachable goal → closest reachable node by dist(goal) + UNREACHABLE_BIAS · dist(unit): near-ties go to
 *  the unit's side (click in a lake → near shore, not around to the far one). */
export const UNREACHABLE_BIAS = 0.25;
/** Search radius for an admissible start node when a unit stands in a spot too tight for its class. */
export const START_SEARCH_R = 2.5;

// ── steering ──
/** Default arrive distance for moveTo (centre within this of the goal). */
export const DEFAULT_ARRIVE = 0.1;
/** moveTo/moveToEntity again with a target this close to the current one keeps the current request. */
export const SAME_TARGET = 0.3;
/** A unit pushed less than this from where it arrived stays "arrived" when re-ordered to the same spot. */
export const REARRIVE_R = 1.0;
/** Intermediate waypoint reached within this distance. */
export const WAYPOINT_TOL = 0.4;
/** Radians/sec turn rate = TURN_BASE / (0.5 + radius): infantry ≈ 13, mechs ≈ 8, bosses ≈ 5. */
export const TURN_BASE = 12;
/** Speed scales down while the heading is off by more than START (rad), to MIN_FACTOR at FULL. */
export const TURN_SLOW_START = 0.35;
export const TURN_SLOW_FULL = 1.9;
export const TURN_MIN_FACTOR = 0.2;

// ── collisions ──
/** Two circles closer than (r1 + r2 + CONTACT) are "touching" (bump arrival). */
export const CONTACT = 0.06;
/** Idle friend pushed by a unit passing through: its share of the mass (it steps aside). */
export const YIELD_MASS = 0.08;
/** Mass multiplier for units holding / attacking / building / casting (hard to shove). */
export const ANCHOR_MASS = 6;
/** Mass multiplier for units pinned against a wall (others slide around them instead). */
export const WALL_MASS = 4;
/** Sideways component for an idle friend stepping out of a mover's lane. */
export const LATERAL = 0.9;
/** Tangential slide for a mover deflected by an obstacle ahead (prevents head-on deadlocks). */
export const SLIDE = 0.6;
/** Air units only resolve this fraction of an overlap per iteration (mild separation, no hard collision). */
export const AIR_RELAX = 0.3;

// ── arrival / give-up ──
/** A mover touching a stationary friend whose last goal lies within this of its own goal also arrives. */
export const CHAIN_R = 1.0;
/** How long (s) a unit's last goal is remembered for chain arrival. */
export const CHAIN_MEMORY = 30;
/** Entity approach: touching a stationary friend this close (edge distance beyond range) counts as arrived. */
export const ENTITY_BUMP_R = 2.5;
/** Progress sampling window and the fraction of nominal speed that counts as progress. */
export const PROGRESS_WINDOW = 0.5;
export const PROGRESS_FRACTION = 0.15;
/** Blocked this long → re-plan (once per cooldown). */
export const REPATH_BLOCKED = 1.0;
export const REPATH_COOLDOWN = 2.0;
/** Blocked this long near the goal / anywhere → stop and report arrived (gave up). */
export const GIVE_UP_NEAR = 1.5;
export const GIVE_UP_FAR = 5.0;
/** At the end of the path but still not in range for this long → gave up (target unreachable). */
export const END_PATIENCE = 0.4;

// ── follow order ──
/** Follow: (re)start approaching when farther than this (edge distance); approach to FOLLOW_RANGE. */
export const FOLLOW_START = 2.0;
export const FOLLOW_RANGE = 1.0;

// ── vision ──
/** Fog recomputed every N ticks per player (20 Hz / 4 = 5 Hz), players staggered across ticks. */
export const VISION_INTERVAL = 4;
