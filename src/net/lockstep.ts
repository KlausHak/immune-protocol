/**
 * Deterministic lockstep driver for LAN 1v1. OWNER: net. Headless-safe (runs in the Node tests).
 *
 * Turns: turn k covers world ticks [startTick + k·T, startTick + (k+1)·T) with T = MatchStart.turnTicks.
 * When a client STARTS turn k it sends its batch for turn k + D (D = inputDelayTurns) — every turn, empty or not.
 * Batches for turns < D are implicitly empty. Turn k may only start when BOTH batches for k are held; its
 * commands are issued at the turn's first tick, ordered by player slot, then submission order. Both the local
 * and the remote batch pass through sanitizeCommand() with the sender's slot (playerId forced), from the same
 * canonical JSON, so both clients execute byte-identical command streams.
 *
 * Pacing: ticksReady() accumulates real time at 20 ticks/s, never beyond the last turn with both batches; when
 * the opponent is ≥ 2 turns ahead it runs 15 % faster (50 % at ≥ 6) to catch up. A stall > 300 ms sets
 * waitingReason.
 *
 * Desync: every `hashEveryTurns` turns (default 10 = 1 s) both send stateHash(world) at the turn boundary and
 * compare. On mismatch both emit 'desync'; the HOST then captures a snapshot (captureMatch) at its next turn
 * boundary, sends it, and both restart from it as a new epoch: MatchStart { startTick: snapshot tick,
 * epoch: +1 } (turn numbering restarts at 0 there; batches of the old epoch are dropped — commands issued in the
 * ~D turns around a resync may be lost). In the browser the restart is
 * app.startGame({ mode: 'multiplayer', difficulty: 'normal', net: <new NetMatch>, load: snapshot }).
 *
 * Opponent gone: on 'left'/'disconnected' the sim stalls and waitingReason shows a countdown; if the opponent
 * returns in time both resend missing batches (`sync`) and play on. Otherwise, after `forfeitMs` (60 s;
 * `leftForfeitMs` = 10 s for an explicit leave) the driver turns SOLO — a local-only, deterministic end: at the
 * next turn boundary (where it was stalled, i.e. after every turn that had both batches) it issues its own
 * scheduled batch plus { type: 'surrender', playerId: opponent }, and from then on runs free at 20 Hz with local
 * commands applied directly. The opponent's client (if it still runs somewhere) is no longer authoritative.
 */
import { TICK_RATE } from '../config';
import type { Command, PlayerId } from '../core/types';
import type { World } from '../sim/World';
import { captureMatch, stateHash, type SaveGame } from '../sim/save';
import type { GameChannel, PeerEvent } from './channel';
import type { PeerMsg } from './protocol';
import type { LockstepDebug, LockstepDriver, LockstepHost, MatchStart } from './types';
import { MAX_COMMANDS_PER_TURN, sanitizeBatch } from './validate';

export interface LockstepOptions {
  start: MatchStart;
  channel: GameChannel;
  /** Called after this driver disposed itself for a resync: start the next epoch from `save`. */
  onRestart?: (next: MatchStart, save: SaveGame, host: LockstepHost | null) => void;
  /** ms clock for forfeit timers (default performance.now) */
  now?: () => number;
  hashEveryTurns?: number;
  forfeitMs?: number;
  leftForfeitMs?: number;
  maxResyncs?: number;
  stallNoticeMs?: number;
}

/** own batches kept for resending after a reconnect (3000 turns = 5 min) */
const OWN_HISTORY_TURNS = 3000;
const RECENT_HASHES = 30;

export class Lockstep implements LockstepDriver {
  readonly start: MatchStart;
  haltAtTick: number | null = null;
  private readonly ch: GameChannel;
  private readonly T: number;
  private readonly D: number;
  private readonly startTick: number;
  private readonly mid: string;
  private readonly epoch: number;
  private readonly local: PlayerId;
  private readonly remote: PlayerId;
  private readonly remoteName: string;
  private readonly isHost: boolean;
  private readonly now: () => number;
  private readonly hashEvery: number;
  private readonly forfeitMs: number;
  private readonly leftForfeitMs: number;
  private readonly maxResyncs: number;
  private readonly stallNoticeMs: number;

  /** next world tick to run (== world.tick between ticks) */
  private tick: number;
  private own = new Map<number, Command[]>();
  private remoteBatches = new Map<number, Command[]>();
  private ownSent: number;
  /** highest turn k such that the remote batches of all turns ≤ k are (or were) held */
  private remoteHave: number;
  private pending: unknown[] = [];
  private localHashes = new Map<number, { tick: number; h: string }>();
  private remoteHashes = new Map<number, string>();
  private recent: Array<[number, number, string]> = [];
  private acc = 0;
  private stalledMs = 0;
  private gone: { name: string; reason: string; since: number } | null = null;
  private solo = false;
  private forfeitPending = false;
  private forfeited = false;
  private desynced = false;
  private resyncPending = false;
  private ended = false;
  private hashChecks = 0;
  private desyncs = 0;
  private rejected = 0;
  private host: LockstepHost | null = null;
  private disposed = false;
  private unsubs: Array<() => void> = [];

  constructor(private readonly opts: LockstepOptions) {
    const s = opts.start;
    this.start = s;
    this.ch = opts.channel;
    this.T = Math.max(1, Math.floor(s.turnTicks));
    this.D = Math.max(1, Math.floor(s.inputDelayTurns));
    this.startTick = s.startTick;
    this.tick = s.startTick;
    this.mid = s.matchId ?? 'local';
    this.epoch = s.epoch ?? 0;
    this.local = s.localPlayerId;
    const other = s.players.find((p) => p.id !== s.localPlayerId);
    this.remote = other?.id ?? (s.localPlayerId === 1 ? 2 : 1);
    this.remoteName = other?.name || 'opponent';
    this.isHost = s.localPlayerId === Math.min(...s.players.map((p) => p.id));
    this.now = opts.now ?? (() => performance.now());
    this.hashEvery = Math.max(1, opts.hashEveryTurns ?? 10);
    this.forfeitMs = opts.forfeitMs ?? 60_000;
    this.leftForfeitMs = opts.leftForfeitMs ?? 10_000;
    this.maxResyncs = opts.maxResyncs ?? 5;
    this.stallNoticeMs = opts.stallNoticeMs ?? 300;
    this.ownSent = this.D - 1;
    this.remoteHave = this.D - 1;

    // messages for this epoch that arrived before we existed (reordering / resync race)
    const early = this.ch.stash.splice(0).filter((m) => 'mid' in m && m.mid === this.mid && m.e >= this.epoch);
    this.unsubs.push(this.ch.onPeer((e) => this.onPeer(e)));
    for (const m of early) this.onMessage(m);
    this.unsubs.push(this.ch.onMessage((m) => this.onMessage(m)));
  }

  // ───────────────────────── LockstepDriver ─────────────────────────
  get waitingReason(): string | null {
    if (this.disposed || this.solo) return null;
    if (this.gone) {
      const secs = Math.max(0, Math.ceil((this.forfeitAt() - this.now()) / 1000));
      return this.gone.reason === 'left'
        ? `${this.gone.name} left the match — victory in ${secs} s`
        : `${this.gone.name} disconnected — waiting… (victory by forfeit in ${secs} s)`;
    }
    if (this.stalledMs < this.stallNoticeMs) return null;
    if (!this.ch.connected) return 'Connection to the relay lost — reconnecting…';
    if (this.desynced) return 'Out of sync — resynchronising…';
    return `Waiting for ${this.remoteName}…`;
  }

  get opponentGone(): { name: string; reason: string; forfeitAt: number } | null {
    return this.gone && !this.solo ? { name: this.gone.name, reason: this.gone.reason, forfeitAt: this.forfeitAt() } : null;
  }

  get pingMs(): number { return this.ch.pingMs; }

  attach(host: LockstepHost): void { this.host = host; }

  ticksReady(dtReal: number): number {
    if (this.disposed) return 0;
    if (!this.solo && this.gone && this.now() >= this.forfeitAt()) {
      this.solo = true;
      this.forfeitPending = !this.ended;
    }
    let avail: number;
    let rate = 1;
    if (this.solo) {
      avail = Number.POSITIVE_INFINITY;
    } else {
      avail = this.startTick + (this.remoteHave + 1) * this.T - this.tick;
      // the opponent has started turn remoteHave − D; how far ahead of us is that?
      const behind = this.remoteHave - this.D - this.turnOf(this.tick);
      if (behind >= 6) rate = 1.5; else if (behind >= 2) rate = 1.15;
    }
    if (this.haltAtTick !== null) avail = Math.min(avail, Math.max(0, this.haltAtTick - this.tick));
    this.acc += Math.max(0, dtReal) * TICK_RATE * rate;
    let n = Math.floor(this.acc);
    if (n > avail) {
      n = avail;
      this.acc = Math.min(this.acc - n, 1); // don't bank stalled time (no burst after the stall)
    } else {
      this.acc -= n;
    }
    if (n === 0 && avail === 0 && !this.solo) this.stalledMs += dtReal * 1000;
    else if (n > 0) this.stalledMs = 0;
    return n;
  }

  beforeTick(world: World): void {
    if (this.disposed) return;
    this.tick = world.tick;
    const rel = this.tick - this.startTick;
    if (rel < 0 || rel % this.T !== 0) return;
    const k = rel / this.T;
    if (this.solo) { this.startSoloTurn(world, k); return; }
    if (k > this.remoteHave) {
      throw new Error(`[lockstep] invariant violated: turn ${k} started without the opponent's batch (have ≤ ${this.remoteHave})`);
    }
    const mine = k < this.D ? [] : this.own.get(k);
    const theirs = k < this.D ? [] : this.remoteBatches.get(k);
    if (!mine || !theirs) throw new Error(`[lockstep] invariant violated: missing ${mine ? 'remote' : 'own'} batch for turn ${k}`);
    this.flush(k + this.D);
    const bySlot = this.local < this.remote ? [mine, theirs] : [theirs, mine];
    for (const batch of bySlot) for (const cmd of batch) world.issue(cmd);
    this.remoteBatches.delete(k);
    this.own.delete(k - OWN_HISTORY_TURNS);
  }

  afterTick(world: World): void {
    if (this.disposed) return;
    this.tick = world.tick;
    if (!this.ended && world.rules.gameOver) {
      this.ended = true;
      this.ch.ended();
      if (this.gone) this.solo = true;
    }
    if (this.solo) return;
    const rel = this.tick - this.startTick;
    if (rel <= 0 || rel % this.T !== 0) return;
    const done = rel / this.T - 1;
    if ((done + 1) % this.hashEvery === 0) {
      const h = stateHash(world);
      this.localHashes.set(done, { tick: this.tick, h });
      this.recent.push([done, this.tick, h]);
      if (this.recent.length > RECENT_HASHES) this.recent.shift();
      this.ch.send({ t: 'hash', mid: this.mid, e: this.epoch, k: done, tick: this.tick, h });
      this.compare(done);
    }
    if (this.resyncPending) this.resync(world);
  }

  submit(cmd: Command): void {
    if (this.disposed) return;
    let copy: Command;
    try { copy = JSON.parse(JSON.stringify(cmd)) as Command; } catch { this.rejected++; return; }
    if (copy.playerId !== this.local) {
      // the network layer enforces it anyway (sanitizeCommand forces playerId); flag the caller's mistake
      console.warn(`[lockstep] command for player ${copy.playerId} rewritten to local player ${this.local}`, copy.type);
    }
    this.pending.push(copy);
  }

  debug(): LockstepDebug {
    return {
      tick: this.tick, turn: this.turnOf(this.tick), epoch: this.epoch, remoteTurn: this.remoteHave, ownTurn: this.ownSent,
      hashes: this.recent.map((r) => [...r] as [number, number, string]), hashChecks: this.hashChecks, desyncs: this.desyncs,
      resyncs: this.epoch, rejectedCommands: this.rejected, stalledMs: Math.round(this.stalledMs), solo: this.solo, forfeited: this.forfeited,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  // ───────────────────────── internals ─────────────────────────
  private turnOf(tick: number): number { return Math.floor((tick - this.startTick) / this.T); }

  private forfeitAt(): number {
    return this.gone ? this.gone.since + (this.gone.reason === 'left' ? this.leftForfeitMs : this.forfeitMs) : Number.POSITIVE_INFINITY;
  }

  /** Seal the pending local commands as our batch for `turn` and send it (empty batches too). */
  private flush(turn: number): void {
    const take = this.pending.splice(0, MAX_COMMANDS_PER_TURN); // the rest waits for the next turn
    const { cmds, rejected } = sanitizeBatch(take, this.local);
    this.rejected += rejected;
    this.own.set(turn, cmds);
    this.ownSent = turn;
    this.ch.send({ t: 'turn', mid: this.mid, e: this.epoch, k: turn, c: cmds });
  }

  private startSoloTurn(world: World, k: number): void {
    const mine = this.own.get(k);
    if (mine) for (const c of mine) world.issue(c);
    if (this.forfeitPending) {
      this.forfeitPending = false;
      this.forfeited = true;
      world.issue({ type: 'surrender', playerId: this.remote });
    }
    const { cmds, rejected } = sanitizeBatch(this.pending.splice(0), this.local);
    this.rejected += rejected;
    for (const c of cmds) world.issue(c);
  }

  private compare(k: number): void {
    const l = this.localHashes.get(k);
    const r = this.remoteHashes.get(k);
    if (!l || r === undefined) return;
    this.localHashes.delete(k);
    this.remoteHashes.delete(k);
    this.hashChecks++;
    if (l.h === r || this.desynced) return;
    this.desynced = true;
    this.desyncs++;
    const resyncing = this.epoch < this.maxResyncs;
    console.warn(`[lockstep] DESYNC at tick ${l.tick} (turn ${k}): local ${l.h} ≠ remote ${r}${resyncing ? (this.isHost ? ' — resyncing the guest' : ' — waiting for the host to resync') : ' — resync limit reached'}`);
    this.ch.emitDesync({ tick: l.tick, localHash: l.h, remoteHash: r, resyncing });
    if (resyncing && this.isHost) this.resyncPending = true;
  }

  /** HOST, at a turn boundary: snapshot → send → restart both clients from it as the next epoch. */
  private resync(world: World): void {
    this.resyncPending = false;
    let save: SaveGame;
    try {
      const raw = captureMatch({
        world, ais: [], mission: null,
        launch: { mode: 'skirmish', mapId: this.start.mapId, difficulty: 'normal', seed: this.start.seed },
        meta: { slot: 'net-resync', name: 'Resynchronised', savedAt: new Date().toISOString(), mapName: this.start.mapId },
      });
      save = JSON.parse(JSON.stringify(raw)) as SaveGame; // the exact bytes the guest will load
    } catch (err) {
      console.error('[lockstep] resync snapshot failed', err);
      this.ch.emitError('Resync failed: could not snapshot the match.');
      return;
    }
    const next: MatchStart = { ...this.start, startTick: world.tick, epoch: this.epoch + 1 };
    this.ch.send({ t: 'resync', mid: this.mid, e: next.epoch!, start: next, save });
    this.restart(next, save);
  }

  private restart(next: MatchStart, save: SaveGame): void {
    this.dispose();
    if (this.opts.onRestart) this.opts.onRestart(next, save, this.host);
    else this.ch.emitError('Resync requested but this match cannot restart itself.');
  }

  private onMessage(m: PeerMsg): void {
    if (this.disposed || m.t === 'ping' || m.t === 'pong' || m.mid !== this.mid) return;
    if (m.t === 'resync') {
      if (!this.isHost && m.e > this.epoch && m.save && m.start) {
        this.restart({ ...m.start, localPlayerId: this.local, epoch: m.e }, m.save);
      }
      return;
    }
    if (m.e > this.epoch) { if (this.ch.stash.length < 10_000) this.ch.stash.push(m); return; }
    if (m.e < this.epoch) return;
    switch (m.t) {
      case 'turn': {
        const k = m.k;
        if (!Number.isInteger(k) || k < this.D || k <= this.remoteHave || k > this.remoteHave + 10_000 || this.remoteBatches.has(k)) return;
        const { cmds, rejected } = sanitizeBatch(m.c, this.remote);
        this.rejected += rejected;
        this.remoteBatches.set(k, cmds);
        while (this.remoteBatches.has(this.remoteHave + 1)) this.remoteHave++;
        return;
      }
      case 'hash':
        if (Number.isInteger(m.k) && typeof m.h === 'string' && this.remoteHashes.size < 1000) { this.remoteHashes.set(m.k, m.h); this.compare(m.k); }
        return;
      case 'sync':
        if (Number.isInteger(m.have)) {
          for (let k = Math.max(m.have + 1, this.D); k <= this.ownSent; k++) {
            const c = this.own.get(k);
            if (c) this.ch.send({ t: 'turn', mid: this.mid, e: this.epoch, k, c });
          }
        }
        return;
    }
  }

  private onPeer(e: PeerEvent): void {
    if (this.disposed) return;
    if (e.type === 'left') {
      if (this.solo) return;
      // keep the first timestamp if the relay reports the same absence twice (disconnected → timeout)
      this.gone = { name: e.name || this.remoteName, reason: e.reason === 'left' ? 'left' : 'disconnected', since: this.gone?.since ?? this.now() };
      if (this.ended) this.solo = true;
    } else {
      if (e.type === 'returned') { if (this.solo) return; this.gone = null; }
      // tell the opponent which of its batches we hold; it resends the rest (lost while a socket was down)
      this.ch.send({ t: 'sync', mid: this.mid, e: this.epoch, have: this.remoteHave });
    }
  }
}
