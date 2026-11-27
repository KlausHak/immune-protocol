/** [qa] FAST: campaign mission m3 sets up and runs 5 simulated minutes with the bot (skipped until registered). */
import { describe } from 'vitest';
import { missionCase } from '../helpers/campaignCase';

describe('campaign m3 (fast)', () => missionCase('m3'));
