/**
 * [movement] Order handlers owned by the movement module: 'move' and 'follow'.
 */
import type { Entity } from '../../core/types';
import type { OrderHandler } from '../services';
import { FOLLOW_RANGE, FOLLOW_START } from './constants';

export const moveHandler: OrderHandler<'move'> = {
  start(w, e, o) { w.movement.moveTo(e, o.target); },
  update(w, e) {
    if (w.movement.hasArrived(e)) {
      if (e.activity === 'moving') e.activity = 'idle';
      return 'done';
    }
    e.activity = 'moving';
    return 'running';
  },
  stop(w, e) {
    w.movement.stop(e);
    if (e.activity === 'moving') e.activity = 'idle';
  },
};

/** Per-unit follow bookkeeping (entity.ext.follow): when/where the last approach was issued. */
interface FollowExt { t: number; x: number; y: number }

function followExt(e: Entity): FollowExt {
  let f = e.ext.follow as FollowExt | undefined;
  if (!f) { f = { t: -1e9, x: 0, y: 0 }; e.ext.follow = f; }
  return f;
}

/**
 * Follow a (usually friendly) unit until it dies: approach to FOLLOW_RANGE, idle nearby, re-approach when it
 * gets farther than FOLLOW_START. A follower that stopped short because others crowd the target only
 * re-approaches once the target has moved (or after 5 s if still well out of range), so packs of followers
 * don't creep and jitter.
 */
export const followHandler: OrderHandler<'follow'> = {
  start(w, e, o) {
    const t = w.getAlive(o.targetId);
    if (!t || t.id === e.id) return;
    const f = followExt(e);
    f.t = w.time; f.x = t.pos.x; f.y = t.pos.y;
    w.movement.moveToEntity(e, t, FOLLOW_RANGE);
  },
  update(w, e, o) {
    const t = w.getAlive(o.targetId);
    if (!t || t.id === e.id) return 'done';
    const m = e.mover;
    if (!m) return 'failed';
    const d = w.edgeDistance(e, t);
    if (!m.moving && d > FOLLOW_START) {
      const f = followExt(e);
      const moved = Math.hypot(t.pos.x - f.x, t.pos.y - f.y);
      if (moved > 0.75 || (w.time - f.t > 5 && d > FOLLOW_START + 1.5)) {
        f.t = w.time; f.x = t.pos.x; f.y = t.pos.y;
        w.movement.moveToEntity(e, t, FOLLOW_RANGE);
      }
    }
    e.activity = m.moving ? 'moving' : 'idle';
    return 'running';
  },
  stop(w, e) {
    w.movement.stop(e);
    if (e.activity === 'moving') e.activity = 'idle';
  },
};
