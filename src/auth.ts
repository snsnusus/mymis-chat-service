// Verifies access tokens issued by mymis-api. This is the Node equivalent of the
// TokenValidationParameters in mymis-api's Program.cs: same key, algorithm, issuer,
// audience and zero clock skew, so a token valid there is valid here and vice versa.

import { errors, jwtVerify } from "jose";
import { z } from "zod";
import type { Config } from "./config.js";

// Who the token says the caller is, in the shape the rest of the service uses.
export interface AuthenticatedUser {
  userId: string; // from `sub` (the employee id)
  username: string; // from `name`
  role: string; // from `role`
  expiresAt: number; // from `exp`, converted to milliseconds since epoch (JS Date units)
}

// Expected failures are RETURNED, not thrown: a bad or expired token is a normal event
// for a server, not an exceptional one. 'expired' is separated from 'invalid' because the
// client should react differently: refresh and reconnect vs. give up.
export type TokenVerificationResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "expired" | "invalid" };

// The claims we rely on. jose has already checked the signature, exp, iss and aud by the time
// this runs, but it types the payload loosely ({ [key: string]: unknown }), so zod confirms the
// fields we use exist with the right types, the same "validate, then trust" rule as protocol.ts.
// Claims we don't use (departmentId, permission) are ignored; z.object drops unknown keys.
const claimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string(),
  role: z.string(),
  exp: z.number(),
});

// Config['jwt'] is an "indexed access type": the type of the jwt property of Config,
// i.e. { key: string; issuer: string; audience: string }. Only that part is needed here.
export function createTokenVerifier(jwt: Config["jwt"]) {
  // HMAC keys are bytes, not text. TextEncoder produces UTF-8 bytes, matching
  // .NET's Encoding.UTF8.GetBytes(_jwtOptions.Key). Computed once, not per token.
  const key = new TextEncoder().encode(jwt.key);

  return async function verifyAccessToken(
    token: string,
  ): Promise<TokenVerificationResult> {
    try {
      const { payload } = await jwtVerify(token, key, {
        // Only accept HS256. Without an explicit list, an attacker could try to switch the
        // token's "alg" header to something weaker ("algorithm confusion" attacks).
        algorithms: ["HS256"],
        issuer: jwt.issuer,
        audience: jwt.audience,
        // Zero clock skew, matching ClockSkew = TimeSpan.Zero in mymis-api.
        clockTolerance: 0,
        // Reject tokens missing these claims outright.
        requiredClaims: ["sub", "exp"],
      });

      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) {
        return { ok: false, reason: "invalid" };
      }

      return {
        ok: true,
        user: {
          userId: claims.data.sub,
          username: claims.data.name,
          role: claims.data.role,
          expiresAt: claims.data.exp * 1000, // JWT exp is in SECONDS; JS dates use milliseconds
        },
      };
    } catch (error) {
      // jose throws for every failed check. Only "expired" gets its own reason; everything
      // else (bad signature, wrong issuer/audience, malformed token, wrong algorithm) is
      // simply invalid. The client must not learn WHICH check failed.
      if (error instanceof errors.JWTExpired) {
        return { ok: false, reason: "expired" };
      }
      return { ok: false, reason: "invalid" };
    }
  };
}

// The verifier's type, so server.ts can depend on "a token verifier" and tests can fake one,
// the same pattern as PresenceStore.
export type TokenVerifier = ReturnType<typeof createTokenVerifier>;
