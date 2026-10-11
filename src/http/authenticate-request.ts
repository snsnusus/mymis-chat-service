// Verifies the access token on an HTTP request. The HTTP counterpart of the socket's
// AUTH message: same verifier, same results, different place to find the token.

import type { Request } from "express";
import type {
  TokenVerificationResult,
  TokenVerifier,
} from "../auth/token.verifier.js";

export async function authenticateRequest(
  req: Request,
  verifyToken: TokenVerifier,
): Promise<TokenVerificationResult> {
  const header = req.headers.authorization;
  // A missing header, or one that isn't "Bearer <token>", counts as an invalid token.
  if (!header?.startsWith("Bearer ")) {
    return { ok: false, reason: "invalid" };
  }
  return verifyToken(header.slice("Bearer ".length));
}
