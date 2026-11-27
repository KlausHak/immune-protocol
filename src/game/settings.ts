export type Quality = 'low' | 'medium' | 'high';
export interface Settings {
  masterVolume: number;   // 0..1
  musicVolume: number;
  sfxVolume: number;
  voiceVolume: number;
  scrollSpeed: number;    // 0.5..2
  edgeScroll: boolean;
  quality: Quality;
  healthBars: 'always' | 'damaged' | 'selected';
  showFps: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.8, musicVolume: 0.5, sfxVolume: 0.8, voiceVolume: 0.9,
  scrollSpeed: 1, edgeScroll: true, quality: 'high', healthBars: 'damaged', showFps: false,
};
const KEY = 'immune-protocol.settings.v1';
export function loadSettings(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s: Settings): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }

const PKEY = 'immune-protocol.progress.v1';
export interface CampaignProgress { completed: string[] }
export function loadProgress(): CampaignProgress {
  try { return { completed: [], ...(JSON.parse(localStorage.getItem(PKEY) ?? '{}') as Partial<CampaignProgress>) }; } catch { return { completed: [] }; }
}
export function saveProgress(p: CampaignProgress): void { try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch { /* ignore */ } }
