import type { HoarderConfig, StorageTarget } from "./configuration.js";

export interface TargetSelectionOperations {
  config(): HoarderConfig | undefined;
  cancelReplication(): void;
  persist(target: StorageTarget): Promise<void>;
  apply(target: StorageTarget): void;
  refreshDurableStatus(): Promise<void>;
  activate(target: StorageTarget): void;
  assertCurrent(): void;
  recordLocalSelectionFailure(error: unknown): void;
}

/** Preserves the detach-before-await storage transition and durable refresh ordering. */
export class TargetSelectionService {
  constructor(private readonly operations: TargetSelectionOperations) {}

  async select(target: StorageTarget): Promise<string> {
    const config = this.operations.config();
    if (!config) throw new Error("Session Hoarder configuration is unavailable.");
    if (target === "s3" && !config.s3) {
      throw new Error("No S3 target is configured in the global Session Hoarder config.");
    }

    if (target === "local") this.operations.cancelReplication();
    try {
      await this.operations.persist(target);
    } catch (error) {
      if (target === "local") this.operations.recordLocalSelectionFailure(error);
      throw error;
    }
    this.operations.assertCurrent();
    this.operations.apply(target);
    await this.operations.refreshDurableStatus();
    this.operations.assertCurrent();
    this.operations.activate(target);

    const selected = this.operations.config();
    return target === "s3" ? `s3:${selected!.s3!.targetId}` : "local";
  }
}
