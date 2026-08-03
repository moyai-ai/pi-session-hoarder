import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import sessionHoarder from "../../src/index.js";

describe("session hoarder extension", () => {
  it("registers lifecycle hooks and one user command without LLM-callable tools", () => {
    const registrations = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      registerShortcut: vi.fn(),
      registerTool: vi.fn(),
    };

    expect(sessionHoarder).toBeTypeOf("function");
    expect(() => sessionHoarder(registrations as unknown as ExtensionAPI)).not.toThrow();
    expect(registrations.on.mock.calls.map(([event]) => event)).toEqual([
      "session_start",
      "message_end",
      "agent_settled",
      "session_info_changed",
      "session_compact",
      "session_tree",
      "session_shutdown",
    ]);
    expect(registrations.registerCommand).toHaveBeenCalledOnce();
    expect(registrations.registerCommand).toHaveBeenCalledWith("hoarder", expect.any(Object));
    expect(registrations.registerFlag).not.toHaveBeenCalled();
    expect(registrations.registerShortcut).not.toHaveBeenCalled();
    expect(registrations.registerTool).not.toHaveBeenCalled();
  });
});
