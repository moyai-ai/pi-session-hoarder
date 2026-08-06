export interface TimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export async function awaitBounded(
  work: Promise<unknown>,
  timeoutMs: number,
  scheduler: TimeoutScheduler,
): Promise<void> {
  let timeoutHandle: unknown;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = scheduler.setTimeout(resolve, timeoutMs);
  });
  await Promise.race([work.then(() => undefined), timeout]);
  if (timeoutHandle !== undefined) scheduler.clearTimeout(timeoutHandle);
}
