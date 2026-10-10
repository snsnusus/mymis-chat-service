import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { createTokenVerifier } from "./auth.js";

const TEST_JWT = {
  key: "test-signing-key-at-least-32-characters",
  issuer: "test-issuer",
  audience: "test-audience",
};

const verifyAccessToken = createTokenVerifier(TEST_JWT);

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// Everything a test may want to change about a token. Every field is optional (`?`):
// a test passes only the one thing it's testing, and the rest stays valid.
interface TokenOptions {
  claims?: Record<string, unknown>; // payload claims; replaces the default { name, role }
  subject?: string | null; // `sub`; null = leave it out entirely
  expiresAt?: number; // `exp` in epoch SECONDS
  key?: string; // signing key
  issuer?: string;
  audience?: string;
  algorithm?: string; // header `alg`
}

// Builds a token that passes every check unless an option says otherwise.
async function signToken(options: TokenOptions = {}): Promise<string> {
  // Destructuring with defaults: each default applies only when that option is UNDEFINED.
  // That's why "omit sub" is expressed as null: null is a real value, so it isn't replaced.
  const {
    claims = { name: "user1", role: "User" },
    subject = "1",
    expiresAt = nowSeconds() + 15 * 60, // 15 minutes ahead, like mymis-api
    key = TEST_JWT.key,
    issuer = TEST_JWT.issuer,
    audience = TEST_JWT.audience,
    algorithm = "HS256",
  } = options;

  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expiresAt);

  if (subject !== null) {
    builder.setSubject(subject);
  }

  // Same UTF-8 encoding as auth.ts and .NET's Encoding.UTF8.GetBytes.
  return builder.sign(new TextEncoder().encode(key));
}

describe("verifyAccessToken", () => {
  it("accepts a valid token and maps its claims to the user", async () => {
    // Arrange
    const exp = nowSeconds() + 600;
    const signed = await signToken({ expiresAt: exp });

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({
      ok: true,
      user: {
        userId: "1",
        username: "user1",
        role: "User",
        expiresAt: exp * 1000,
      },
    });
  });

  it("rejects a token that expired a minute ago as expired", async () => {
    // Arrange
    const exp = { expiresAt: nowSeconds() - 60 };
    const signed = await signToken(exp);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token that expired seconds ago", async () => {
    // Arrange
    const exp = { expiresAt: nowSeconds() - 1 };
    const signed = await signToken(exp);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token with a different key", async () => {
    // Arrange
    const key = { key: "this-is-a-32-character-wrong-key" };
    const signed = await signToken(key);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token with a different audience", async () => {
    // Arrange
    const audience = { audience: "something-else" };
    const signed = await signToken(audience);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token with a different issuer", async () => {
    // Arrange
    const issuer = { issuer: "something-else" };
    const signed = await signToken(issuer);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token with a different algorithm", async () => {
    // Arrange
    const algo = { algorithm: "HS512" };
    const signed = await signToken(algo);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token without a subject", async () => {
    // Arrange
    const sub = { subject: null };
    const signed = await signToken(sub);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token without a name claim", async () => {
    // Arrange
    const claims = { claims: { role: "User" } };
    const signed = await signToken(claims);

    // Act
    const res = await verifyAccessToken(signed);

    // Assert
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an invalid token", async () => {
    // Act
    const res = await verifyAccessToken("not-a-token");

    // Assert
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});
