/**
 * The browser edition's persistence, reduced to the five operations
 * storage-web.ts needs from it, so that file's logic can be tested over a Map
 * and IndexedDB stays a thin, separately-exercised adapter.
 *
 * Two areas, mirroring the desktop's two folders: `docs` (the JSON documents
 * under config/) and `backups`. Values are JSON text.
 */
export type KvArea = 'docs' | 'backups';

export interface Kv {
  entries(area: KvArea): Promise<[string, string][]>;
  keys(area: KvArea): Promise<string[]>;
  get(area: KvArea, key: string): Promise<string | null>;
  put(area: KvArea, key: string, value: string): Promise<void>;
  delete(area: KvArea, key: string): Promise<void>;
}

const AREAS: KvArea[] = ['docs', 'backups'];
const DB_NAME = 'shark-deck';
const DB_VERSION = 1;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves once the transaction has committed — what "written" means for a put. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = fail;
    tx.onerror = fail;
  });
}

/** Storage-full errors get words a person can act on; everything else passes through. */
function explain(err: unknown): unknown {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') {
    return new Error(
      'The browser has no room left for Shark Deck’s data. Download your backups, then free some space.',
    );
  }
  return err;
}

export async function openIdbKv(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<Kv> {
  const open = factory.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const area of AREAS) if (!db.objectStoreNames.contains(area)) db.createObjectStore(area);
  };
  const db = await request(open);

  async function write(area: KvArea, fn: (store: IDBObjectStore) => void): Promise<void> {
    try {
      const tx = db.transaction(area, 'readwrite');
      fn(tx.objectStore(area));
      await committed(tx);
    } catch (err) {
      throw explain(err);
    }
  }

  return {
    async entries(area) {
      const store = db.transaction(area, 'readonly').objectStore(area);
      // One transaction for both, so keys and values are the same snapshot.
      const [keys, values] = await Promise.all([
        request(store.getAllKeys()),
        request(store.getAll()),
      ]);
      return keys.map((k, i) => [String(k), String(values[i])]);
    },
    async keys(area) {
      const store = db.transaction(area, 'readonly').objectStore(area);
      return (await request(store.getAllKeys())).map(String);
    },
    async get(area, key) {
      const store = db.transaction(area, 'readonly').objectStore(area);
      const value = await request(store.get(key));
      return typeof value === 'string' ? value : null;
    },
    put: (area, key, value) => write(area, (store) => void store.put(value, key)),
    delete: (area, key) => write(area, (store) => void store.delete(key)),
  };
}

/** A Kv over two Maps — for tests, and as the fallback when IndexedDB will not open. */
export function createMemoryKv(): Kv {
  const maps: Record<KvArea, Map<string, string>> = { docs: new Map(), backups: new Map() };
  return {
    entries: async (area) => [...maps[area].entries()],
    keys: async (area) => [...maps[area].keys()],
    get: async (area, key) => maps[area].get(key) ?? null,
    put: async (area, key, value) => {
      maps[area].set(key, value);
    },
    delete: async (area, key) => {
      maps[area].delete(key);
    },
  };
}
