/** [qa] FAST: campaign mission m2 sets up and runs 5 simulated minutes with the bot (skipped until registered). */
import { describe } from 'vitest';
import { missionCase } from '../helpers/campaignCase';

describe('campaign m2 (fast)', () => missionCase('m2'));
