import type { FactionId } from '../core/types';

export interface FactionInfo {
  id: FactionId;
  name: string;
  short: string;
  resourceNames: { matter: string; energy: string };
  popName: string;
  worker: string;      // worker unit id
  hq: string;          // HQ building id
  color: number;       // default team colour
  accent: number;
}

export const FACTIONS: Record<FactionId, FactionInfo> = {
  hospital: {
    id: 'hospital', name: 'Hospital Defense Corps', short: 'Hospital',
    resourceNames: { matter: 'Supplies', energy: 'Power' }, popName: 'Beds',
    worker: 'hosp_orderly', hq: 'hosp_hq', color: 0x2fd6c6, accent: 0xe8f6ff,
  },
  pathogen: {
    id: 'pathogen', name: 'The Contagion', short: 'Pathogens',
    resourceNames: { matter: 'Biomass', energy: 'Toxin' }, popName: 'Colony',
    worker: 'path_spore_drone', hq: 'path_hive', color: 0xd64bff, accent: 0x9dff4a,
  },
  neutral: {
    id: 'neutral', name: 'Neutral', short: 'Neutral',
    resourceNames: { matter: 'Matter', energy: 'Energy' }, popName: 'Pop',
    worker: '', hq: '', color: 0xc8c8c8, accent: 0xffffff,
  },
};
