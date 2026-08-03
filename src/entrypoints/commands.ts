import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatDetailedStatus } from "../application/status.js";
import type { HoarderController } from "./lifecycle.js";

export function registerHoarderCommands(pi: ExtensionAPI, controller: HoarderController): void {
  pi.registerCommand("hoarder", {
    description: "Inspect or synchronize the local Session Hoarder archive",
    handler: async (args, ctx) => {
      const subcommand = args.trim() || "status";
      if (subcommand === "status") {
        ctx.ui.notify(formatDetailedStatus(controller.getStatusSnapshot()), "info");
        return;
      }
      if (subcommand === "sync") {
        try {
          const result = await controller.sync(ctx.sessionManager.getSessionId());
          if (!result) {
            ctx.ui.notify("Session Hoarder did not run a checkpoint.", "warning");
          } else if (result.changed) {
            ctx.ui.notify(`Session Hoarder committed revision ${result.record.revision}.`, "info");
          } else {
            ctx.ui.notify(
              `Session Hoarder is already current at revision ${result.record.revision}.`,
              "info",
            );
          }
        } catch (error) {
          ctx.ui.notify(`Session Hoarder sync failed: ${errorMessage(error)}`, "error");
        }
        return;
      }
      ctx.ui.notify("Usage: /hoarder status | /hoarder sync", "warning");
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
