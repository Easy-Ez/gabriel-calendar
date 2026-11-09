import { setTimeout as delay } from "node:timers/promises";

export async function observeVisibility<T>(read: (signal: AbortSignal) => Promise<T>,
  visible: (value: T) => boolean, { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let lastAbsentAtMs: number | null = null;
  let samples = 0;
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const value = await read(signal);
      const finishedAt = Date.now();
      samples++;
      if (visible(value)) return { value, lastAbsentAtMs, firstVisibleAtMs: finishedAt, samples };
      // The provider evaluated the negative result sometime after this request started.
      lastAbsentAtMs = startedAt;
      await delay(intervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
      break;
    }
  }
  return { lastAbsentAtMs, firstVisibleAtMs: null, samples };
}
