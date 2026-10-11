// What a message handler knows about the connection it's serving.

import type { AuthenticatedUser } from "../auth/token.verifier.js";
import type { ServerMessage } from "./protocol.js";

export interface ConnectionContext {
  // Who this connection authenticated as (from the token, never the client).
  user: AuthenticatedUser;
  // Sends a message to this connection only.
  reply(message: ServerMessage): void;
}
