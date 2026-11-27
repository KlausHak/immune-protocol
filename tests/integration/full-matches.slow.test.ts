/**
 * [qa] [slow] Full matches: the hospital bot ('medium' by default) vs the pathogen AI on easy/normal/hard, on the
 * `test` map and on `meilahti` (skipped until registered), up to 25 simulated minutes each. Outcomes are
 * recorded (console table + $QA_OUT/full-<map>-<difficulty>.json + $QA_OUT/full-matches.json); the assertions
 * are only "nothing threw, invariants held" — who wins is a balance signal, not a test failure.
 *
 * Gated: runs only with SLOW=1, e.g.
 *   SLOW=1 npx vitest run tests/integration/full-matches.slow.test.ts
 *   SLOW=1 npx vitest run tests/integration -t "\[slow\] test map vs hard"
 * Knobs: QA_MINUTES (default 25), QA_BOT (weak|medium|strong), QA_SEED (default 1), QA_MAPS (comma list).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Difficulty } from '../../src/core/types';
import type { BotStrength } from '../helpers/hospitalBot';
import { describeSummary, errorViolations, formatExceptions, formatTimeline, formatViolations, mapRegistered, runMatch, saveSummary, type MatchSummary } from '../helpers/match';

const SLOW = process.env.SLOW === '1' || process.env.SLOW === 'true';
const MINUTES = Number(process.env.QA_MINUTES ?? 25);
const BOT = (process.env.QA_BOT ?? 'medium') as BotStrength;
const SEED = Number(process.env.QA_SEED ?? 1);
const MAPS = (process.env.QA_MAPS ?? 'test,meilahti').split(',').map((s) => s.trim()).filter(Boolean);
const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];
const results: Array<Pick<MatchSummary, 'mapId' | 'difficulty' | 'seed' | 'bot' | 'winner' | 'endTime' | 'reason' | 'wallMs' | 'msPerTick'> & { exceptions: number; consoleErrors: number; errors: number; warnings: number; p1: string; p2: string }> = [];

describe.skipIf(!SLOW)('[slow] full matches — bot vs AI', () => {
  for (const mapId of MAPS) {
    for (const difficulty of DIFFS) {
      const skip = !mapRegistered(mapId);
      it.skipIf(skip)(`[slow] ${mapId} map vs ${difficulty} (bot ${BOT}, ≤ ${MINUTES} min)${skip ? ' — SKIPPED: map not registered' : ''}`, () => {
        const s = runMatch({ mapId, difficulty, seed: SEED, minutes: MINUTES, bot: BOT });
        console.log(`${describeSummary(s)}\n${formatTimeline(s)}`);
        saveSummary(`full-${mapId}-${difficulty}`, s);
        const p = (id: number) => { const x = s.players[id]; return x ? `W${x.workers} A${x.army} B${x.buildings} k${x.stats.unitsKilled}/${x.stats.buildingsKilled} l${x.stats.unitsLost}/${x.stats.buildingsLost}` : '-'; };
        results.push({ mapId: s.mapId, difficulty, seed: SEED, bot: s.bot, winner: s.winner, endTime: s.endTime, reason: s.reason, wallMs: s.wallMs, msPerTick: s.msPerTick, exceptions: s.exceptions.length, consoleErrors: s.consoleErrorCount, errors: errorViolations(s).length, warnings: s.violations.length - errorViolations(s).length, p1: p(1), p2: p(2) });
        expect(s.fallback).toBeNull();
        expect(s.exceptions, formatExceptions(s)).toEqual([]);
        expect(s.consoleErrors, formatExceptions(s)).toEqual([]);
        expect(errorViolations(s), formatViolations(s)).toEqual([]);
      }, 1_800_000);
    }
  }
  afterAll(() => {
    if (!results.length) return;
    const file = saveSummary('full-matches', results);
    console.log(`\n[slow] outcomes (bot ${BOT}, seed ${SEED}) → ${file}`);
    console.table(results.map((r) => ({ map: r.mapId, ai: r.difficulty, winner: r.winner, at: `${Math.floor(r.endTime / 60)}:${String(Math.floor(r.endTime % 60)).padStart(2, '0')}`, reason: r.reason ?? '', hospital: r.p1, pathogen: r.p2, exc: r.exceptions, cerr: r.consoleErrors, viol: `${r.errors}/${r.warnings}`, 'ms/tick': r.msPerTick })));
  });
});
