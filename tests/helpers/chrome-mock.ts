export interface ChromeMock {
  store: Map<string, unknown>;
  /** Simula la recarga de la extensión: `chrome.runtime.id` desaparece. */
  invalidate(): void;
}

export function installChromeMock(): ChromeMock {
  const store = new Map<string, unknown>();
  const runtime: { id: string | undefined } = { id: "test-extension" };
  const area = {
    async get(key: string) {
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
    async remove(key: string) {
      store.delete(key);
    }
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime, storage: { local: area } };
  return { store, invalidate: () => { runtime.id = undefined; } };
}
