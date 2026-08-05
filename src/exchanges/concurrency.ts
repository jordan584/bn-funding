export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const results = new Array<R>(items.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let cursor = 0;
  let stopped = false;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        stopped = true;
        failures.push({ index, error });
      }
    }
  });
  await Promise.all(runners);
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0]!.error;
  }
  return results;
}
