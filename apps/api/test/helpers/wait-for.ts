/** Polls `probe` until it returns a non-undefined value (or throws on timeout). */
export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 50, label = 'condition' } = options;
  // Monotonic clock: the host wall clock can step (VM time sync) during a run.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
