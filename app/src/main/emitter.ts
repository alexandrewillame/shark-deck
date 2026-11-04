/**
 * The part of Node's `EventEmitter` the device layer uses — `on`, `off` and
 * `emit` — without importing `node:events`, so the same classes run in the
 * browser edition (src/web/), where Vite would swap that module for an empty
 * stub and `class X extends EventEmitter` would throw on import.
 *
 * Semantics follow Node's for what is kept: listeners run synchronously, in
 * registration order, with every argument `emit` was given; a listener added
 * during an `emit` does not run in that same `emit`. Unlike Node, emitting
 * `'error'` with no listener is not special — nothing here emits it.
 */
type Listener = (...args: any[]) => void;

export class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  off(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    const at = list.lastIndexOf(listener);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.listeners.get(event);
    if (!list?.length) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}
