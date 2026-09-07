type RuntimeSlot = { generation: symbol; instance: unknown };
const globalStore = globalThis as typeof globalThis & { __nexusModuleRuntimes?: Map<string, RuntimeSlot> };

/**
 * Module-scoped runtime singleton that automatically rebuilds when its owning
 * module is re-executed (dev hot reload / code change). Each runtime module
 * passes a module-scope `generation` symbol: a fresh symbol on re-execution
 * forces a rebuild, while stable module scope reuses the cached instance.
 */
export function moduleRuntime<T>(key: string, generation: symbol, build: () => T): T {
  const store = globalStore.__nexusModuleRuntimes ??= new Map<string, RuntimeSlot>();
  const slot = store.get(key);
  if (slot?.generation === generation) return slot.instance as T;
  const instance = build();
  store.set(key, { generation, instance });
  return instance;
}
