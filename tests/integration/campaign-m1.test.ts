/** [qa] FAST: campaign mission m1 sets up and runs 5 simulated minutes with the bot (skipped until registered). */
import { describe } from 'vitest';
import { missionCase } from '../helpers/campaignCase';

describe('campaign m1 (fast)', () => missionCase('m1'));
