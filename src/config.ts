/**
 * Global constants & branding. Headless-safe (no DOM / three.js).
 * The campaign setting is the HUS (Helsinki University Hospital) Meilahti campus, fictionalised.
 * Rename the setting here and in src/campaign mission text if desired.
 */
export const GAME_TITLE = 'IMMUNE PROTOCOL';
export const GAME_SUBTITLE = 'Outbreak at the HUS Campus';
export const CAMPAIGN_NAME = 'Code Red: Meilahti';
export const HOSPITAL_ORG = 'HUS';
export const SETTING_NAME = 'HUS Meilahti Hospital Campus';

/** Fixed simulation rate. The renderer interpolates between ticks using entity.prevPos. */
export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;

export const MAX_POP = 150;
/** World-unit height of one terrain level (cliff height). */
export const LEVEL_HEIGHT = 1.6;
/** Default render altitude for air units if def.flyHeight is missing. */
export const DEFAULT_FLY_HEIGHT = 3;

export const PLAYER_COLORS: number[] = [0xc8c8c8, 0x2fd6c6, 0xd64bff, 0xffb23b, 0x4b8bff];

export const STARTING_RESOURCES = { matter: 150, energy: 0 };
export const STARTING_WORKERS = 5;
