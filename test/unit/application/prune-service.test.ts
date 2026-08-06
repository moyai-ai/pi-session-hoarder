import { describe, expect, it, vi } from "vitest";

import { PruneApplicationService } from "../../../src/application/prune-service.js";
import { SerializedMaintenanceExclusion } from "../../../src/application/maintenance-exclusion.js";
import type { ObjectReference } from "../../../src/domain/model.js";

function object(digest: string, storedBytes: number): ObjectReference {
  return { algorithm: "sha256", digest, encoding: "gzip", logicalBytes: 100, storedBytes };
}

function setup(overrides: Partial<ConstructorParameters<typeof PruneApplicationService>[0]> = {}) {
  const a = object("a".repeat(64), 10);
  const b = object("b".repeat(64), 20);
  const cache = {
    inventory: vi.fn(async () => [
      { digest: a.digest, encodedBytes: 10, allocatedBytes: 512 },
      { digest: b.digest, encodedBytes: 20, allocatedBytes: 512 },
    ]),
    remove: vi.fn(async () => 512),
  };
  const dependencies = {
    cache,
    receipts: {
      list: vi.fn(async () => ({
        receipts: [
          { object: a, key: `prefix/objects/sha256/${a.digest}.gz` },
          { object: { ...b, storedBytes: 21 }, key: `prefix/objects/sha256/${b.digest}.gz` },
        ],
        invalidRecords: 1,
      })),
    },
    receiptPolicy: { matches: vi.fn(() => true) },
    exclusion: new SerializedMaintenanceExclusion(),
    ...overrides,
  };
  return { service: new PruneApplicationService(dependencies), cache, a, b };
}

describe("PruneApplicationService", () => {
  it("previews exact receipt-backed eligibility and removes confirmed objects", async () => {
    const { service, cache, a } = setup();
    const confirm = vi.fn(async () => true);
    await expect(service.prune("backup", { confirm })).resolves.toEqual({
      localObjects: 2,
      eligibleObjects: 1,
      skippedObjects: 1,
      eligibleEncodedBytes: 10,
      eligibleAllocatedBytes: 512,
      invalidReceiptRecords: 1,
      confirmed: true,
      removedObjects: 1,
      recoveredBytes: 512,
      failedObjects: 0,
      interrupted: false,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(cache.remove).toHaveBeenCalledWith(
      { digest: a.digest, encodedBytes: 10, allocatedBytes: 512 },
      undefined,
    );
  });

  it("leaves cache untouched when confirmation is declined", async () => {
    const { service, cache } = setup();
    await expect(service.prune("backup", { confirm: async () => false })).resolves.toMatchObject({
      confirmed: false,
      removedObjects: 0,
    });
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it("continues after independent deletion failures", async () => {
    const left = object("a".repeat(64), 10);
    const right = object("b".repeat(64), 20);
    const remove = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce(1024);
    const { service } = setup({
      cache: {
        inventory: async () => [
          { digest: left.digest, encodedBytes: 10, allocatedBytes: 512 },
          { digest: right.digest, encodedBytes: 20, allocatedBytes: 1024 },
        ],
        remove,
      },
      receipts: {
        list: async () => ({
          receipts: [
            { object: left, key: "left" },
            { object: right, key: "right" },
          ],
          invalidRecords: 0,
        }),
      },
    });
    await expect(service.prune("backup")).resolves.toMatchObject({
      removedObjects: 1,
      failedObjects: 1,
      recoveredBytes: 1024,
    });
  });

  it("returns partial progress when interrupted", async () => {
    const controller = new AbortController();
    const { service } = setup({
      cache: {
        inventory: async () => [
          { digest: "a".repeat(64), encodedBytes: 10, allocatedBytes: 512 },
          { digest: "b".repeat(64), encodedBytes: 20, allocatedBytes: 512 },
        ],
        remove: vi.fn(async () => {
          controller.abort();
          return 512;
        }),
      },
      receipts: {
        list: async () => ({
          receipts: [
            { object: object("a".repeat(64), 10), key: "left" },
            { object: object("b".repeat(64), 20), key: "right" },
          ],
          invalidRecords: 0,
        }),
      },
    });
    await expect(service.prune("backup", undefined, controller.signal)).resolves.toMatchObject({
      removedObjects: 1,
      recoveredBytes: 512,
      interrupted: true,
    });
  });

  it("does not confirm an empty plan and rejects an empty target", async () => {
    const confirm = vi.fn();
    const { service } = setup({ cache: { inventory: async () => [], remove: vi.fn() } });
    await expect(service.prune("backup", { confirm })).resolves.toMatchObject({
      eligibleObjects: 0,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(() => service.prune("")).toThrow("selected remote target");
  });
});
