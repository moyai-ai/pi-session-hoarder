import { describe, expect, it, vi } from "vitest";

import type { HoarderConfig, StorageTarget } from "../../../src/application/configuration.js";
import { TargetSelectionService } from "../../../src/application/target-selection-service.js";

function config(storageTarget: StorageTarget = "s3"): HoarderConfig {
  return {
    enabled: true,
    debounceMs: 1,
    shutdownTimeoutMs: 1,
    storageRoot: "/store",
    storageTarget,
    s3: {
      targetId: "backup",
      bucket: "bucket",
      region: "us-east-1",
      prefix: "objects",
      forcePathStyle: false,
    },
    gitCatalogEnabled: false,
  };
}

describe("TargetSelectionService", () => {
  it("detaches S3 synchronously before the local config write", async () => {
    const calls: string[] = [];
    let current = config();
    const service = new TargetSelectionService({
      config: () => current,
      cancelReplication: () => calls.push("cancel"),
      persist: async () => {
        calls.push("persist");
      },
      apply: (target) => {
        calls.push("apply");
        current = { ...current, storageTarget: target };
      },
      refreshDurableStatus: async () => {
        calls.push("refresh");
      },
      activate: () => calls.push("activate"),
      assertCurrent: () => calls.push("guard"),
      recordLocalSelectionFailure: vi.fn(),
    });

    await expect(service.select("local")).resolves.toBe("local");
    expect(calls).toEqual(["cancel", "persist", "guard", "apply", "refresh", "guard", "activate"]);
  });

  it("keeps replication detached and records failure when local persistence fails", async () => {
    const cancel = vi.fn();
    const failure = vi.fn();
    const service = new TargetSelectionService({
      config: () => config(),
      cancelReplication: cancel,
      persist: async () => {
        throw new Error("read only");
      },
      apply: vi.fn(),
      refreshDurableStatus: vi.fn(),
      activate: vi.fn(),
      assertCurrent: vi.fn(),
      recordLocalSelectionFailure: failure,
    });

    await expect(service.select("local")).rejects.toThrow("read only");
    expect(cancel).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce();
  });

  it("rejects unconfigured S3 before persistence", async () => {
    const persist = vi.fn();
    const service = new TargetSelectionService({
      config: () => ({ ...config("local"), s3: undefined }),
      cancelReplication: vi.fn(),
      persist,
      apply: vi.fn(),
      refreshDurableStatus: vi.fn(),
      activate: vi.fn(),
      assertCurrent: vi.fn(),
      recordLocalSelectionFailure: vi.fn(),
    });

    await expect(service.select("s3")).rejects.toThrow("No S3 target");
    expect(persist).not.toHaveBeenCalled();
  });
});
