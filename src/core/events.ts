/** Tiny synchronous, typed event bus. Handlers run immediately inside emit(). */
export type Handler<T> = (payload: T) => void;

export class EventBus<E extends object> {
  private handlers = new Map<keyof E, Set<Handler<any>>>();

  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn);
    return () => this.off(type, fn);
  }

  once<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    const off = this.on(type, (p) => { off(); fn(p); });
    return off;
  }

  off<K extends keyof E>(type: K, fn: Handler<E[K]>): void {
    this.handlers.get(type)?.delete(fn);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[events] handler for "${String(type)}" threw`, err); }
    }
  }

  clear(): void { this.handlers.clear(); }
}
