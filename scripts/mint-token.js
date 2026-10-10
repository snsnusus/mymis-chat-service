// Signs test access tokens shaped like mymis-api's TokenService output.
// DEV ONLY: it uses the real signing key from .env, so never use it outside local testing.
//
// Usage: node --env-file=.env scripts/mint-token.js <userId> [mode]
//   modes: valid (default) | expired | wrong-key | wrong-audience

import { SignJWT } from "jose";

const userId = process.argv[2] ?? "1";
const mode = process.argv[3] ?? "valid";

// Same encoding as .NET's Encoding.UTF8.GetBytes(key).
const realKey = new TextEncoder().encode(process.env.JWT_KEY);
const otherKey = new TextEncoder().encode(
  "a-completely-different-key-of-32-plus-chars",
);

// exp as epoch seconds: 15 minutes ahead (like mymis-api), or 1 minute in the past.
const nowSeconds = Math.floor(Date.now() / 1000);
const exp = mode === "expired" ? nowSeconds - 60 : nowSeconds + 15 * 60;

const token = await new SignJWT({ name: `user${userId}`, role: "User" })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setSubject(userId)
  .setIssuer(process.env.JWT_ISSUER)
  .setAudience(
    mode === "wrong-audience"
      ? "some-other-audience"
      : process.env.JWT_AUDIENCE,
  )
  .setExpirationTime(exp)
  .sign(mode === "wrong-key" ? otherKey : realKey);

console.log(token);
