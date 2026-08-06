import { describe, expect, it } from "vitest";

import type {
  EncodedObjectPayload,
  ReplicaObjectRepository,
} from "../../src/application/replication-ports.js";
import type { ObjectReference } from "../../src/domain/model.js";

export interface ReplicaObjectRepositoryContractHarness {
  repository: ReplicaObjectRepository;
  object: ObjectReference;
  payload(): EncodedObjectPayload;
}

export function replicaObjectRepositoryContract(
  name: string,
  createHarness: () => Promise<ReplicaObjectRepositoryContractHarness>,
): void {
  describe(`${name} ReplicaObjectRepository contract`, () => {
    it("publishes and revalidates a trusted encoded object receipt", async () => {
      const harness = await createHarness();

      const result = await harness.repository.put({
        object: harness.object,
        ...harness.payload(),
      });
      expect(result.state).toBe("uploaded");
      if (result.state !== "uploaded") throw new Error("expected uploaded result");

      await expect(harness.repository.inspect(harness.object)).resolves.toMatchObject({
        state: "untrusted-present",
      });
      await expect(
        harness.repository.verifyTrustedReceipt(harness.object, result.receipt),
      ).resolves.toEqual({ valid: true });
    });

    it("reports duplicate publication as an untrusted conditional conflict", async () => {
      const harness = await createHarness();

      const first = await harness.repository.put({
        object: harness.object,
        ...harness.payload(),
      });
      const second = await harness.repository.put({
        object: harness.object,
        ...harness.payload(),
      });

      expect(first.state).toBe("uploaded");
      expect(second).toMatchObject({
        state: "conflict",
        observation: { state: "untrusted-present" },
      });
    });

    it("does not verify a trusted receipt for different logical metadata", async () => {
      const harness = await createHarness();
      const result = await harness.repository.put({
        object: harness.object,
        ...harness.payload(),
      });
      if (result.state !== "uploaded") throw new Error("expected uploaded result");

      await expect(
        harness.repository.verifyTrustedReceipt(
          { ...harness.object, logicalBytes: harness.object.logicalBytes + 1 },
          result.receipt,
        ),
      ).resolves.toEqual({ valid: false });
    });

    it("honors cancellation before remote work starts", async () => {
      const harness = await createHarness();
      const controller = new AbortController();
      controller.abort();

      await expect(
        harness.repository.put({ object: harness.object, ...harness.payload() }, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });
}
