import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ObjectStore } from "../../src/application/ports.js";

export interface ObjectStoreContractHarness {
  store: ObjectStore;
  writeSource(contents: Uint8Array): Promise<string>;
}

export function objectStoreContract(
  name: string,
  createHarness: () => Promise<ObjectStoreContractHarness>,
): void {
  describe(`${name} ObjectStore contract`, () => {
    it("stores bytes under their uncompressed SHA-256 identity", async () => {
      const harness = await createHarness();
      const contents = Buffer.from("object-store contract\n".repeat(32));
      const source = await harness.writeSource(contents);

      const result = await harness.store.putFile(source);

      expect(result.object.digest).toBe(createHash("sha256").update(contents).digest("hex"));
      await expect(harness.store.has(result.object.digest)).resolves.toBe(true);
      await expect(harness.store.verify(result.object)).resolves.toMatchObject({ valid: true });
    });

    it("deduplicates identical logical bytes", async () => {
      const harness = await createHarness();
      const source = await harness.writeSource(Buffer.from("same logical object"));

      const first = await harness.store.putFile(source);
      const second = await harness.store.putFile(source);

      expect(second.object).toEqual(first.object);
    });

    it("detects object metadata that does not match the decoded bytes", async () => {
      const harness = await createHarness();
      const source = await harness.writeSource(Buffer.from("verified bytes"));
      const stored = await harness.store.putFile(source);

      await expect(
        harness.store.verify({
          ...stored.object,
          logicalBytes: stored.object.logicalBytes + 1,
        }),
      ).resolves.toMatchObject({ valid: false });
    });

    it("honors cancellation before storage work starts", async () => {
      const harness = await createHarness();
      const source = await harness.writeSource(Buffer.from("cancelled bytes"));
      const controller = new AbortController();
      controller.abort();

      await expect(harness.store.putFile(source, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });
}
