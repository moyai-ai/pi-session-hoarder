import { describe, expect, it, vi } from "vitest";

import { SerializedMaintenanceExclusion } from "../../../src/application/maintenance-exclusion.js";

describe("SerializedMaintenanceExclusion", () => {
  it("serializes activity and maintenance in FIFO order", async () => {
    const exclusion = new SerializedMaintenanceExclusion();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = exclusion.runActivity(async () => {
      events.push("activity:start");
      await gate;
      events.push("activity:end");
    });
    const second = exclusion.runMaintenance(async () => {
      events.push("maintenance");
    });
    await vi.waitFor(() => expect(events).toEqual(["activity:start"]));
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["activity:start", "activity:end", "maintenance"]);
  });

  it("does not let cancellation of a queued operation break exclusion", async () => {
    const exclusion = new SerializedMaintenanceExclusion();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = exclusion.runActivity(() => gate);
    const controller = new AbortController();
    const cancelled = exclusion.runMaintenance(vi.fn(), controller.signal);
    const last = vi.fn(async () => undefined);
    const third = exclusion.runActivity(last);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(last).not.toHaveBeenCalled();
    release();
    await Promise.all([first, third]);
    expect(last).toHaveBeenCalledOnce();
  });
});
