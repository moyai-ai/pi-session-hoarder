import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { bootstrapSessionHoarder } from "./bootstrap.js";

export default function sessionHoarder(pi: ExtensionAPI): void {
  bootstrapSessionHoarder(pi);
}
