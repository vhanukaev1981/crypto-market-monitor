import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export type CryptoBotPrincipal = {
  subject: string;
  email: string | null;
  supabaseUserId: string;
};

export type AuthVerificationConfig = {
  issuer: string;
  audience: string;
  allowedSubjects: Set<string>;
  supabaseUserId: string;
  requiredScope: string;
};

const discoveryCache = new Map<string, Promise<JWTVerifyGetKey>>();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function authConfigFromEnv(): AuthVerificationConfig {
  return {
    issuer: requiredEnv("CRYPTOBOT_OAUTH_ISSUER").replace(/\/$/, ""),
    audience: requiredEnv("CRYPTOBOT_OAUTH_AUDIENCE"),
    allowedSubjects: new Set(
      requiredEnv("CRYPTOBOT_ALLOWED_SUBJECTS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    supabaseUserId: requiredEnv("CRYPTOBOT_SUPABASE_USER_ID"),
    requiredScope: "email",
  };
}

function scopesFromPayload(payload: JWTPayload): Set<string> {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === "string") return new Set(raw.split(/\s+/).filter(Boolean));
  if (Array.isArray(raw)) return new Set(raw.map(String));
  return new Set();
}

function principalFromPayload(payload: JWTPayload, config: AuthVerificationConfig): CryptoBotPrincipal {
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!subject || !config.allowedSubjects.has(subject)) throw new Error("principal_not_allowed");
  if (!scopesFromPayload(payload).has(config.requiredScope)) throw new Error("insufficient_scope");
  return {
    subject,
    email: typeof payload.email === "string" ? payload.email : null,
    supabaseUserId: config.supabaseUserId,
  };
}

async function discoverJwks(issuer: string): Promise<JWTVerifyGetKey> {
  const normalizedIssuer = issuer.replace(/\/$/, "");
  const existing = discoveryCache.get(normalizedIssuer);
  if (existing) return existing;

  const pending = (async () => {
    const metadataUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
    const response = await fetch(metadataUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("oauth_discovery_unavailable");
    const metadata = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
    if (metadata.issuer !== normalizedIssuer || typeof metadata.jwks_uri !== "string") {
      throw new Error("oauth_discovery_invalid");
    }
    const jwksUrl = new URL(metadata.jwks_uri);
    if (jwksUrl.protocol !== "https:") throw new Error("oauth_jwks_requires_https");
    return createRemoteJWKSet(jwksUrl);
  })();

  discoveryCache.set(normalizedIssuer, pending);
  try {
    return await pending;
  } catch (error) {
    discoveryCache.delete(normalizedIssuer);
    throw error;
  }
}

export async function verifyTokenWithKey(
  token: string,
  key: CryptoKey,
  config: AuthVerificationConfig,
): Promise<CryptoBotPrincipal> {
  const { payload } = await jwtVerify(token, key, {
    issuer: config.issuer,
    audience: config.audience,
    requiredClaims: ["sub", "exp", "iat"],
  });
  return principalFromPayload(payload, config);
}

export async function verifyBearerToken(token: string): Promise<CryptoBotPrincipal> {
  if (!token) throw new Error("authentication_required");
  const config = authConfigFromEnv();
  const jwks = await discoverJwks(config.issuer);
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.issuer,
    audience: config.audience,
    requiredClaims: ["sub", "exp", "iat"],
  });
  return principalFromPayload(payload, config);
}

export function extractBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new Error("authentication_required");
  return match[1].trim();
}
