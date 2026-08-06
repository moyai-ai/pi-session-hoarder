import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { RetrievalApplicationService } from "../../../src/application/retrieval-service.js";
import { SerializedMaintenanceExclusion } from "../../../src/application/maintenance-exclusion.js";

function fixture() {
  const logical = Buffer.from("remote logical object");
  const encoded = gzipSync(logical);
  const object = {
    algorithm: "sha256" as const,
    digest: createHash("sha256").update(logical).digest("hex"),
    encoding: "gzip" as const,
    logicalBytes: logical.length,
    storedBytes: encoded.length,
  };
  return {
    object,
    receipt: { object, key: `objects/sha256/${object.digest}.gz` },
    payload: {
      contentLength: encoded.length,
      checksumSha256: createHash("sha256").update(encoded).digest("base64"),
      body: (async function* () {
        yield encoded;
      })(),
    },
  };
}

describe("RetrievalApplicationService", () => {
  it("returns local objects without remote work", async () => {
    const value = fixture();
    const remote = { retrieve: vi.fn() };
    const service = new RetrievalApplicationService({
      local: { has: async () => true, install: vi.fn() },
      remote,
      confirmation: { confirm: vi.fn() },
      confirmationThresholdBytes: 0,
      exclusion: new SerializedMaintenanceExclusion(),
    });
    await expect(service.hydrate(value)).resolves.toEqual({
      hydrated: false,
      alreadyLocal: true,
      declined: false,
    });
    expect(remote.retrieve).not.toHaveBeenCalled();
  });

  it("previews large retrieval and honors decline", async () => {
    const value = fixture();
    const confirm = vi.fn(async () => false);
    const remote = { retrieve: vi.fn() };
    const service = new RetrievalApplicationService({
      local: { has: async () => false, install: vi.fn() },
      remote,
      confirmation: { confirm },
      confirmationThresholdBytes: 1,
      exclusion: new SerializedMaintenanceExclusion(),
    });
    await expect(service.hydrate(value)).resolves.toMatchObject({ declined: true });
    expect(confirm).toHaveBeenCalledWith({
      objectCount: 1,
      encodedBytes: value.object.storedBytes,
    });
    expect(remote.retrieve).not.toHaveBeenCalled();
  });

  it("hydrates only on explicit demand and converges concurrent requests", async () => {
    const value = fixture();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    const retrieve = vi.fn(async () => {
      await gate;
      return value.payload;
    });
    const install = vi.fn(async () => undefined);
    const service = new RetrievalApplicationService({
      local: { has: async () => false, install },
      remote: { retrieve },
      confirmation: { confirm: async () => true },
      confirmationThresholdBytes: Number.MAX_SAFE_INTEGER,
      exclusion: new SerializedMaintenanceExclusion(),
    });
    expect(retrieve).not.toHaveBeenCalled();
    const left = service.hydrate(value);
    const right = service.hydrate(value);
    resolve();
    await expect(Promise.all([left, right])).resolves.toEqual([
      { hydrated: true, alreadyLocal: false, declined: false },
      { hydrated: true, alreadyLocal: false, declined: false },
    ]);
    expect(retrieve).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
  });

  it("rejects mismatched receipts and cancellation before remote work", async () => {
    const value = fixture();
    const service = new RetrievalApplicationService({
      local: { has: async () => false, install: vi.fn() },
      remote: { retrieve: vi.fn() },
      confirmation: { confirm: async () => true },
      confirmationThresholdBytes: 0,
      exclusion: new SerializedMaintenanceExclusion(),
    });
    expect(() =>
      service.hydrate({
        ...value,
        receipt: { ...value.receipt, object: { ...value.object, logicalBytes: 1 } },
      }),
    ).toThrow("does not match");
    const controller = new AbortController();
    controller.abort();
    expect(() => service.hydrate(value, controller.signal)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });
});
