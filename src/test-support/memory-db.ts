import { vi } from 'vitest';

/**
 * An in-memory stand-in for app/db.ts's `tx`, for testing the stores built on it.
 *
 * jsdom has no IndexedDB. The stores' own logic — ids, timestamps, ordering, what they
 * refuse — does not need one: `tx` hands `run` an object store, and this one keeps records
 * in a Map and answers the three calls the stores make.
 */
export function memoryDb() {
  const stores = new Map<string, Map<string, unknown>>();
  const storeFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };

  const tx = vi.fn(async (name: string, _mode: string, run: (store: unknown) => unknown) => {
    const records = storeFor(name);
    const store = {
      put: (record: { id: string }) => records.set(record.id, structuredClone(record)),
      getAll: () => [...records.values()].map((record) => structuredClone(record)),
      delete: (id: string) => records.delete(id),
    };
    return run(store);
  });

  return { tx, records: storeFor };
}
