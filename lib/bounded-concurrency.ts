export const NEXUS_MARKET_ANALYSIS_CONCURRENCY = 4;

/**
 * Preserve input order while limiting the number of simultaneously retained
 * analysis tasks. The mapper owns error handling when a failed item should be
 * degradable instead of failing the whole batch.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!values.length) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workerCount = Math.min(
    values.length,
    Math.max(1, Math.trunc(concurrency) || 1),
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
