/**
 * GameChannel: the lockstep driver's view of "the other player". OWNER: net. Headless-safe.
 * Implemented by the LAN session (src/net/session.ts, over the relay) and by the in-memory transport of the
 * tests (tests/net/helpers.ts). Keeping the driver behind this seam lets the tests run two drivers + two worlds
 * in one process with simulated latency, jitter and reordering.
 */
import type { NetEvents } from './types';
import type { PeerMsg } from './protocol';

export type PeerEvent =
  | { type: 'left'; name: string; reason: string }
  | { type: 'returned'; name: string }
  /** our own connection to the relay came back (resumed the room slot) */
  | { type: 'resumed' };

export interface GameChannel {
  /** best effort: dropped while disconnected (drivers recover with a `sync` after reconnecting) */
  send(m: PeerMsg): void;
  /** Messages that arrive while nobody listens are buffered and delivered to the next listener. */
  onMessage(fn: (m: PeerMsg) => void): () => void;
  onPeer(fn: (e: PeerEvent) => void): () => void;
  /** surface a desync to the UI (session 'desync' event) */
  emitDesync(e: NetEvents['desync']): void;
  /** surface a non-fatal problem to the UI (session 'error' event) */
  emitError(message: string): void;
  /** the match reached game over (informs the relay) */
  ended(): void;
  /** true while our link to the relay is up */
  readonly connected: boolean;
  /** opponent round trip, ms (NaN when unknown) */
  readonly pingMs: number;
  /** messages for a NEWER epoch than the current driver's, kept for the driver created by a resync */
  readonly stash: PeerMsg[];
}

/** Listener plumbing shared by the real and the in-memory channel. */
export abstract class ChannelBase implements GameChannel {
  readonly stash: PeerMsg[] = [];
  private msgFns = new Set<(m: PeerMsg) => void>();
  private peerFns = new Set<(e: PeerEvent) => void>();
  private buffered: PeerMsg[] = [];

  abstract send(m: PeerMsg): void;
  abstract emitDesync(e: NetEvents['desync']): void;
  abstract emitError(message: string): void;
  abstract ended(): void;
  abstract readonly connected: boolean;
  abstract readonly pingMs: number;

  onMessage(fn: (m: PeerMsg) => void): () => void {
    this.msgFns.add(fn);
    if (this.buffered.length) {
      const b = this.buffered; this.buffered = [];
      for (const m of b) fn(m);
    }
    return () => { this.msgFns.delete(fn); };
  }
  onPeer(fn: (e: PeerEvent) => void): () => void {
    this.peerFns.add(fn);
    return () => { this.peerFns.delete(fn); };
  }
  /** called by the transport for every incoming peer message */
  deliver(m: PeerMsg): void {
    if (this.msgFns.size === 0) { if (this.buffered.length < 20_000) this.buffered.push(m); return; }
    for (const fn of [...this.msgFns]) fn(m);
  }
  peerEvent(e: PeerEvent): void { for (const fn of [...this.peerFns]) fn(e); }
  /** forget buffered traffic of a previous match */
  reset(): void { this.buffered = []; this.stash.length = 0; }
}
