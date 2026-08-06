export interface MaintenanceExclusion {
  runActivity<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  runMaintenance<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** FIFO session-scoped exclusion between ordinary object work and destructive maintenance. */
export class SerializedMaintenanceExclusion implements MaintenanceExclusion {
  private tail: Promise<void> = Promise.resolve();

  runActivity<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(operation, signal);
  }

  runMaintenance<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(operation, signal);
  }

  private async enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = false;
    try {
      await waitForTurn(previous, signal);
      acquired = true;
      signal?.throwIfAborted();
      return await operation();
    } finally {
      if (acquired) release();
      else void previous.finally(release);
    }
  }
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  await Promise.race([
    previous,
    new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void previous.finally(() => signal.removeEventListener("abort", abort));
    }),
  ]);
}
