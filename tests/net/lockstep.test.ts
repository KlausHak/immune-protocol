/**
 * Lockstep determinism: two headless worlds driven by two Lockstep drivers over an in-memory network must stay
 * identical (stateHash) under scripted commands from both sides, latency, jitter, reordering and uneven frame
 * rates; plus the invariants (no turn without both batches), validation, desync → resync, and forfeit.
 */
import { describe, expect, it } from 'vitest';
import { Lockstep } from '../../src/net/lockstep';
import { firstDifference, stateHash } from '../../src/sim/save';
import { frame, makeClient, matchStart, runPair, scriptedBot, SimNet, type TestClient } from './helpers';

const TWO_MIN_TICKS = 2 * 60 * 20;

function expectSameHashes(a: TestClient, b: TestClient, minCommon: number): number {
  let common = 0;
  for (const [tick, h] of a.hashes) {
    const hb = b.hashes.get(tick);
    if (hb === undefined) continue;
    common++;
    if (hb !== h) throw new Error(`hash mismatch at tick ${tick}: ${h} vs ${hb}`);
  }
  expect(common).toBeGreaterThanOrEqual(minCommon);
  return common;
}

/** run both to exactly `tick` and compare the full state */
function convergeAt(net: SimNet, a: TestClient, b: TestClient, tick: number, maxMs = 600_000): void {
  a.driver.haltAtTick = tick; b.driver.haltAtTick = tick;
  runPair(net, [a, b], { maxMs, until: () => a.world.tick === tick && b.world.tick === tick });
  expect(a.world.tick).toBe(tick);
  expect(b.world.tick).toBe(tick);
  expect(firstDifference(a.world, b.world)).toBeNull();
  expect(stateHash(a.world)).toBe(stateHash(b.world));
}

describe('lockstep determinism', () => {
  it('two clients stay identical for 2+ minutes with commands from both sides (ideal network)', () => {
    const net = new SimNet();
    const a = makeClient(1, net.a), b = makeClient(2, net.b);
    const bot = scriptedBot();
    runPair(net, [a, b], { maxMs: 200_000, bot, recordHashes: true, until: () => a.world.tick >= TWO_MIN_TICKS + 100 && b.world.tick >= TWO_MIN_TICKS + 100 });
    expectSameHashes(a, b, 100);
    convergeAt(net, a, b, TWO_MIN_TICKS + 200);
    expect(a.channel.desyncs).toEqual([]);
    expect(b.channel.desyncs).toEqual([]);
    expect(a.driver.debug().hashChecks).toBeGreaterThan(100);
    // the scripted commands really did something on both sides (economy + combat)
    for (const p of [1, 2]) {
      expect(a.world.player(p).stats.matterGathered).toBeGreaterThan(0);
      expect(a.world.player(p).stats.unitsKilled).toBeGreaterThan(0);
    }
  });

  it('stays identical under latency, jitter, reordering, uneven frame rates and hitches', () => {
    const net = new SimNet({ latencyMs: 35, jitterMs: 90, reorder: true, seed: 99 });
    const a = makeClient(1, net.a), b = makeClient(2, net.b);
    const bot = scriptedBot();
    let hitches = 0;
    runPair(net, [a, b], {
      maxMs: 300_000, fps: [60, 23], bot, recordHashes: true,
      jank: (i, t) => (i === 1 && Math.floor(t / 7000) !== Math.floor((t - 50) / 7000) ? (hitches++, 450) : 0),
      until: () => a.world.tick >= TWO_MIN_TICKS + 100 && b.world.tick >= TWO_MIN_TICKS + 100,
    });
    expect(hitches).toBeGreaterThan(5);
    expectSameHashes(a, b, 100);
    convergeAt(net, a, b, TWO_MIN_TICKS + 200);
    expect(a.channel.desyncs).toEqual([]);
    expect(b.channel.desyncs).toEqual([]);
    // pacing: ~20 ticks/s of virtual time overall (stalls for latency only cost a little)
    const ticksPerSec = a.world.tick / (net.now / 1000);
    expect(ticksPerSec).toBeGreaterThan(17);
    expect(ticksPerSec).toBeLessThanOrEqual(20.5);
  });
});

describe('lockstep pacing & invariants', () => {
  it('never runs a turn without both batches (silent opponent → stalls at turn D, waitingReason)', () => {
    const net = new SimNet();
    net.b.up = false; // opponent never sends anything
    const a = makeClient(1, net.a, { squads: false });
    let t = 0;
    for (let i = 0; i < 300; i++) { t += 16; net.advance(16); frame(a, 16); }
    const s = a.driver.start;
    expect(a.world.tick).toBe(s.inputDelayTurns * s.turnTicks); // implicit empty turns only
    expect(a.driver.ticksReady(0.1)).toBe(0);
    expect(a.driver.waitingReason).toMatch(/Waiting for Joonas/);
    // forcing a tick past the available turns violates the invariant
    expect(() => a.driver.beforeTick(a.world)).toThrow(/invariant/);
  });

  it('runs at 20 ticks/s, catches up when behind, and resumes after a stall without a burst', () => {
    const net = new SimNet();
    const a = makeClient(1, net.a, { squads: false }), b = makeClient(2, net.b, { squads: false });
    runPair(net, [a, b], { maxMs: 10_000, fps: [60, 60] });
    expect(a.world.tick).toBeGreaterThanOrEqual(190);
    expect(a.world.tick).toBeLessThanOrEqual(203);
    // b freezes for 3 s (tab hidden); a stalls (it can't run more than D turns ahead)
    const before = a.world.tick;
    for (let i = 0; i < 3000 / 4; i++) { net.advance(4); if (i % 4 === 0) frame(a, 16); }
    expect(a.world.tick - before).toBeLessThanOrEqual(6);
    expect(a.driver.waitingReason).toMatch(/Waiting/);
    // b resumes: it is behind, so it runs faster than real time until both are level again
    const bBefore = b.world.tick;
    runPair(net, [a, b], { maxMs: 1000 });
    expect(b.world.tick - bBefore).toBeGreaterThan(21);
    runPair(net, [a, b], { maxMs: 3000 });
    expect(Math.abs(a.world.tick - b.world.tick)).toBeLessThanOrEqual(4);
    expect(a.driver.waitingReason).toBeNull();
    let maxPerFrame = 0;
    // after the stall every frame runs ≤ a few ticks (no burst of banked time)
    for (let i = 0; i < 100; i++) { net.advance(16); maxPerFrame = Math.max(maxPerFrame, frame(a, 16)); frame(b, 16); }
    expect(maxPerFrame).toBeLessThanOrEqual(2);
  });

  it('a client can only command its own player (playerId forced, malformed commands dropped)', () => {
    const net = new SimNet({ latencyMs: 20 });
    const a = makeClient(1, net.a, { squads: false }), b = makeClient(2, net.b, { squads: false });
    runPair(net, [a, b], { maxMs: 2000 });
    const victims = a.world.entitiesOf(1, (e) => !!e.gatherer).map((e) => e.id);
    expect(victims.length).toBeGreaterThan(0);
    // player 2 tries to stop player 1's workers, spoofing playerId, plus garbage
    b.submit({ type: 'stop', playerId: 1, unitIds: victims });
    b.driver.submit({ type: 'nuke', playerId: 1 } as never);
    b.driver.submit({ type: 'move', playerId: 2, unitIds: 'all', target: { x: 1, y: 1 } } as never);
    b.driver.submit({ type: 'surrender', playerId: 1 });
    runPair(net, [a, b], { maxMs: 2000 });
    for (const c of [a, b]) {
      // a stop would have cleared their orders: they are still gathering
      for (const id of victims) expect(c.world.getAlive(id)?.orders.length).toBeGreaterThan(0);
      // the spoofed surrender was executed as player 2's own surrender
      expect(c.world.player(1).defeated).toBe(false);
      expect(c.world.player(2).defeated).toBe(true);
    }
    expect(b.driver.debug().rejectedCommands).toBe(2); // filtered before sending…
    expect(a.driver.debug().rejectedCommands).toBe(0); // …so the opponent's batch was clean
    convergeAt(net, a, b, a.world.tick + 20);
  });
});

describe('desync detection & resync', () => {
  for (const tampered of [2, 1] as const) {
    it(`detects a tampered ${tampered === 1 ? 'host' : 'guest'} world and the host resyncs both to identical state`, () => {
      const net = new SimNet({ latencyMs: 25, jitterMs: 30, reorder: true, seed: tampered });
      const a = makeClient(1, net.a), b = makeClient(2, net.b);
      const bot = scriptedBot();
      runPair(net, [a, b], { maxMs: 30_000, bot, until: () => a.world.tick >= 400 && b.world.tick >= 400 });
      expect(a.channel.desyncs.length + b.channel.desyncs.length).toBe(0);
      const victim = tampered === 1 ? a : b;
      victim.world.player(victim.slot).resources.matter += 123; // cheat / bug
      runPair(net, [a, b], { maxMs: 10_000, bot, until: () => a.restarts > 0 && b.restarts > 0 });
      expect(a.channel.desyncs.length).toBe(1);
      expect(b.channel.desyncs.length).toBe(1);
      expect(a.channel.desyncs[0]!.resyncing).toBe(true);
      expect(a.channel.desyncs[0]!.localHash).not.toBe(a.channel.desyncs[0]!.remoteHash);
      expect(a.restarts).toBe(1);
      expect(b.restarts).toBe(1);
      expect(a.driver.start.epoch).toBe(1);
      expect(b.driver.start.epoch).toBe(1);
      expect(b.driver.start.localPlayerId).toBe(2);
      expect(a.driver.start.startTick).toBe(b.driver.start.startTick);
      // both continue in lockstep from the snapshot, identical
      a.hashes.clear(); b.hashes.clear();
      const target = a.world.tick + 600;
      runPair(net, [a, b], { maxMs: 60_000, bot, recordHashes: true, until: () => a.world.tick >= target && b.world.tick >= target });
      expectSameHashes(a, b, 20);
      convergeAt(net, a, b, target + 40);
      expect(a.channel.desyncs.length).toBe(1);
      expect(b.channel.desyncs.length).toBe(1);
      // the cheat is gone on both: the host's state won
      expect(a.world.player(victim.slot).resources.matter).toBe(b.world.player(victim.slot).resources.matter);
    });
  }
});

describe('opponent gone', () => {
  it('opponent returning within the grace period: missing batches are resent (sync) and play continues', () => {
    const net = new SimNet({ latencyMs: 20 });
    let now = 0;
    const clock = () => now;
    const a = makeClient(1, net.a, { now: clock }), b = makeClient(2, net.b, { now: clock });
    const bot = scriptedBot();
    runPair(net, [a, b], { maxMs: 5000, bot });
    // b's socket dies: messages in both directions are lost
    net.b.up = false;
    a.channel.peerEvent({ type: 'left', name: 'Joonas', reason: 'disconnected' });
    for (let i = 0; i < 500; i++) { now += 16; net.advance(16); frame(a, 16); frame(b, 16); }
    expect(a.driver.waitingReason).toMatch(/Joonas disconnected — waiting.*forfeit in 5\d s/);
    expect(a.driver.opponentGone?.reason).toBe('disconnected');
    // b comes back (resume) — each side tells the other what it holds
    net.b.up = true;
    a.channel.peerEvent({ type: 'returned', name: 'Joonas' });
    b.channel.peerEvent({ type: 'resumed' });
    expect(a.driver.opponentGone).toBeNull();
    const target = a.world.tick + 400;
    runPair(net, [a, b], { maxMs: 60_000, bot, until: () => a.world.tick >= target && b.world.tick >= target });
    convergeAt(net, a, b, target + 20);
    expect(a.channel.desyncs).toEqual([]);
  });

  it('after the forfeit timeout the remaining client wins locally (deterministic solo end)', () => {
    const net = new SimNet();
    let now = 0;
    const a = makeClient(1, net.a, { now: () => now, squads: false }), b = makeClient(2, net.b, { now: () => now, squads: false });
    runPair(net, [a, b], { maxMs: 3000 });
    net.b.up = false;
    a.channel.peerEvent({ type: 'left', name: 'Joonas', reason: 'disconnected' });
    const stalledAt = (() => { for (let i = 0; i < 100; i++) { now += 16; net.advance(16); frame(a, 16); } return a.world.tick; })();
    for (let i = 0; i < 57_000 / 16; i++) { now += 16; frame(a, 16); }
    expect(a.world.tick).toBe(stalledAt); // still waiting at ~58.6 s
    expect(a.world.rules.gameOver).toBe(false);
    let won: { winnerTeam: number | null; reason: string } | null = null;
    a.world.events.on('gameOver', (e) => { won = e; });
    for (let i = 0; i < 200; i++) { now += 16; frame(a, 16); }
    expect(now).toBeGreaterThan(60_000);
    expect(a.world.tick).toBeGreaterThan(stalledAt);
    expect(a.world.rules.gameOver).toBe(true);
    expect(won).toEqual({ winnerTeam: 1, reason: 'surrender' });
    expect(a.world.player(2).defeated).toBe(true);
    expect(a.driver.debug().forfeited).toBe(true);
    expect(a.driver.waitingReason).toBeNull();
    // and it keeps running freely afterwards (end screen, local commands applied directly)
    const t = a.world.tick;
    for (let i = 0; i < 60; i++) { now += 16; frame(a, 16); }
    expect(a.world.tick).toBeGreaterThanOrEqual(t + 18); // 0.96 s at 20 ticks/s
  });

  it('an explicit leave forfeits after the short timeout', () => {
    const net = new SimNet();
    let now = 0;
    const a = makeClient(1, net.a, { now: () => now, squads: false });
    const b = new Lockstep({ start: matchStart(2), channel: net.b, now: () => now });
    void b;
    a.channel.peerEvent({ type: 'left', name: 'Joonas', reason: 'left' });
    expect(a.driver.waitingReason).toMatch(/Joonas left the match — victory in 10 s/);
    for (let i = 0; i < 11_000 / 16; i++) { now += 16; net.advance(16); frame(a, 16); }
    expect(a.world.rules.gameOver).toBe(true);
    expect(a.world.rules.winnerTeam).toBe(1);
  });
});
