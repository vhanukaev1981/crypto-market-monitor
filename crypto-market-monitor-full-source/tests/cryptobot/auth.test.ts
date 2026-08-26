import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { verifyTokenWithKey, type AuthVerificationConfig } from "../../mcp/auth.ts";

const ISSUER = "https://auth.example.test";
const AUDIENCE = "https://cryptobot.example.test";
const SUBJECT = "user:owner";
const USER_ID = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const config: AuthVerificationConfig = {
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedSubjects: new Set([SUBJECT]),
    supabaseUserId: USER_ID,
    requiredScope: "cryptobot.read",
  };
  const sign = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: SUBJECT,
      scope: "cryptobot.read",
      email: "owner@example.test",
      iat: now,
      exp: now + 300,
      ...overrides,
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);
  };
  return { publicKey, config, sign };
}

test("valid token resolves a scoped CryptoBot principal", async () => {
  const { publicKey, config, sign } = await setup();
  const principal = await verifyTokenWithKey(await sign(), publicKey, config);
  assert.deepEqual(principal, {
    subject: SUBJECT,
    email: "owner@example.test",
    supabaseUserId: USER_ID,
  });
});

test("wrong issuer is rejected", async () => {
  const { publicKey, config, sign } = await setup();
  await assert.rejects(() => verifyTokenWithKey(await sign({ iss: "https://evil.test" }), publicKey, config));
});

test("wrong audience is rejected", async () => {
  const { publicKey, config, sign } = await setup();
  await assert.rejects(() => verifyTokenWithKey(await sign({ aud: "https://other.test" }), publicKey, config));
});

test("expired token is rejected", async () => {
  const { publicKey, config, sign } = await setup();
  const past = Math.floor(Date.now() / 1000) - 60;
  await assert.rejects(() => verifyTokenWithKey(await sign({ exp: past }), publicKey, config));
});

test("disallowed subject is rejected", async () => {
  const { publicKey, config, sign } = await setup();
  await assert.rejects(
    () => verifyTokenWithKey(await sign({ sub: "user:not-allowed" }), publicKey, config),
    /principal_not_allowed/,
  );
});

test("missing required read scope is rejected", async () => {
  const { publicKey, config, sign } = await setup();
  await assert.rejects(
    () => verifyTokenWithKey(await sign({ scope: "profile" }), publicKey, config),
    /insufficient_scope/,
  );
});
