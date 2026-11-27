/**
 * Browser save storage (IndexedDB, with an in-memory fallback). OWNER: architect.
 * Slots: 'quick' (F5/F9), 'auto' (autosave every 3 min of game time), 'slot1'…'slot8' (manual).
 * Full saves live in the 'saves' store; a small 'meta' store keeps list() cheap.
 */
import { SAVE_VERSION, type SaveGame, type SaveMeta } from '../sim/save';

export const MANUAL_SLOTS = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8'] as const;
export const QUICK_SLOT = 'quick';
export const AUTO_SLOT = 'auto';
export const AUTOSAVE_INTERVAL = 180; // seconds of game time

const DB_NAME = 'immune-protocol';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export class SaveStore {
  private db: Promise<IDBDatabase | null>;
  private memory = new Map<string, SaveGame>();

  constructor() {
    this.db = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => { console.warn('[saves] IndexedDB unavailable, saves are kept in memory only', open.error); resolve(null); };
    });
  }

  /** All saves' metadata, newest first. */
  async list(): Promise<SaveMeta[]> {
    const db = await this.db;
    const metas = db
      ? await req(db.transaction('meta').objectStore('meta').getAll() as IDBRequest<SaveMeta[]>)
      : [...this.memory.values()].map((s) => s.meta);
    return metas.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  }

  async latest(): Promise<SaveMeta | null> { return (await this.list())[0] ?? null; }

  async get(slot: string): Promise<SaveGame | null> {
    const db = await this.db;
    if (!db) return this.memory.get(slot) ?? null;
    return (await req(db.transaction('saves').objectStore('saves').get(slot) as IDBRequest<SaveGame | undefined>)) ?? null;
  }

  async put(save: SaveGame): Promise<void> {
    const db = await this.db;
    if (!db) { this.memory.set(save.meta.slot, save); return; }
    const tx = db.transaction(['saves', 'meta'], 'readwrite');
    tx.objectStore('saves').put(save, save.meta.slot);
    tx.objectStore('meta').put(save.meta, save.meta.slot);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Save aborted (storage full?)'));
    });
  }

  async delete(slot: string): Promise<void> {
    const db = await this.db;
    if (!db) { this.memory.delete(slot); return; }
    const tx = db.transaction(['saves', 'meta'], 'readwrite');
    tx.objectStore('saves').delete(slot);
    tx.objectStore('meta').delete(slot);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  }

  /** First empty manual slot, or null if all eight are used. */
  async freeManualSlot(): Promise<string | null> {
    const used = new Set((await this.list()).map((m) => m.slot));
    return MANUAL_SLOTS.find((s) => !used.has(s)) ?? null;
  }

  /** Download a save as a .json file. */
  exportFile(save: SaveGame): void {
    const blob = new Blob([JSON.stringify(save)], { type: 'application/json' });
    const a = document.createElement('a');
    const date = save.meta.savedAt.slice(0, 16).replace(/[:T]/g, '-');
    a.href = URL.createObjectURL(blob);
    a.download = `immune-protocol-${save.meta.mode}-${save.meta.missionId ?? save.meta.mapId}-${date}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Parse & validate a save file. Does not store it (caller picks a slot and calls put()). */
  async importFile(file: File): Promise<SaveGame> {
    let data: SaveGame;
    try { data = JSON.parse(await file.text()) as SaveGame; } catch { throw new Error('Not a valid save file (JSON parse failed).'); }
    if (!data || typeof data !== 'object' || !data.meta || !data.world || !data.launch) throw new Error('Not an IMMUNE PROTOCOL save file.');
    if (data.version !== SAVE_VERSION) throw new Error(`This save was made by a different game version (save v${data.version}, game v${SAVE_VERSION}).`);
    return data;
  }
}
