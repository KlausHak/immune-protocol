/**
 * [qa] Manual inspection tool (skipped unless INSPECT=1): run ONE match with full output — summary, timeline,
 * violations, exceptions and (BOTLOG=1) the bot's decision log. Writes $QA_OUT/inspect.json.
 *
 *   INSPECT=1 npx vitest run tests/integration/inspect.test.ts --silent=false
 *   INSPECT=1 QA_MAP=meilahti QA_DIFF=hard QA_BOT=strong QA_MINUTES=12 QA_SEED=3 QA_BOTLOG=1 npx vitest run tests/integration/inspect.test.ts --silent=false
 *   INSPECT=1 QA_MODE=campaign QA_MISSION=m2 QA_MINUTES=8 npx vitest run tests/integration/inspect.test.ts --silent=false
 * QA_BOT=none runs without the scripted player; QA_AI=0 disables the pathogen AI. (QA_ prefix: Vite owns MODE.)
 */
import { it } from 'vitest';
import type { Difficulty } from '../../src/core/types';
import type { BotStrength } from '../helpers/hospitalBot';
import { describeSummary, formatExceptions, formatProfile, formatTimeline, formatViolations, runMatch, saveSummary } from '../helpers/match';

const env = process.env;
it.skipIf(env.INSPECT !== '1')('inspect one match (INSPECT=1)', () => {
  const bot = env.QA_BOT === 'none' ? null : { strength: (env.QA_BOT ?? 'medium') as BotStrength, log: env.QA_BOTLOG === '1' };
  const mode = env.QA_MODE === 'campaign' ? 'campaign' : 'skirmish';
  const s = runMatch({
    mode, mapId: env.QA_MAP, missionId: env.QA_MISSION, difficulty: (env.QA_DIFF ?? 'normal') as Difficulty,
    seed: Number(env.QA_SEED ?? 1), minutes: Number(env.QA_MINUTES ?? 10), bot, enemyAi: env.QA_AI !== '0', profile: true,
  });
  console.log(describeSummary(s));
  console.log(formatProfile(s));
  console.log(formatTimeline(s));
  console.log(formatViolations(s, 40));
  console.log(formatExceptions(s, 20));
  if (s.mission) console.log(JSON.stringify(s.mission, null, 1));
  if (s.botLog) console.log(s.botLog.join('\n'));
  console.log(`events ${JSON.stringify(s.events)}\nreport → ${saveSummary('inspect', s)}`);
}, 1_800_000);
