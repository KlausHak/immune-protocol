/**
 * createNetMatch: glue between a LanSession, a MatchStart and the lockstep driver. OWNER: net.
 * The UI calls it on the session's 'start' event and passes the result to app.startGame({ mode: 'multiplayer',
 * difficulty: 'normal', net }). After a resync the driver builds the next NetMatch itself (same session, next
 * epoch) and restarts the match through the Game it was attached to (Game calls lockstep.attach(this)).
 */
import type { GameChannel } from './channel';
import { Lockstep } from './lockstep';
import { LanSession } from './session';
import type { LockstepHost, MatchStart, NetMatch, NetSession } from './types';

/** The GameChannel behind a NetSession (only sessions created by createLanSession have one). */
export function channelOf(session: NetSession): GameChannel {
  const ch = (session as Partial<LanSession>).channel;
  if (!ch) throw new Error('createNetMatch: session has no game channel (use createLanSession)');
  return ch;
}

export function createNetMatch(session: NetSession, start: MatchStart): NetMatch {
  const channel = channelOf(session);
  const lockstep = new Lockstep({
    start,
    channel,
    onRestart: (next, save, host: LockstepHost | null) => {
      // create the next driver NOW so it receives the next epoch's traffic; restart the Game on the next task
      // (we are inside the old Game's frame / a socket callback)
      const net = createNetMatch(session, next);
      if (!host) {
        channel.emitError('Resync needed, but the match is not attached to a running game.');
        return;
      }
      setTimeout(() => {
        try {
          host.app.startGame({ mode: 'multiplayer', difficulty: 'normal', net, load: save });
        } catch (err) {
          console.error('[net] resync restart failed', err);
          channel.emitError(`Resync failed: ${(err as Error).message}`);
        }
      }, 0);
    },
  });
  return { start, session, lockstep };
}
