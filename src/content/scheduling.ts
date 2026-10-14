interface SchedulerLike {
  yield?: () => Promise<void>;
}

/**
 * Cede el hilo principal para que la página siga respondiendo entre lotes de trabajo.
 * Usa `scheduler.yield()` (Chrome 129+) y cae a `setTimeout(0)`.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}
