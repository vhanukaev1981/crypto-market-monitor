import assert from "node:assert/strict";
import test from "node:test";
import {
  oauthProtectedResourceMetadata,
  unauthorizedHeaders,
} from "../../mcp/server.ts";

test("protected-resource metadata advertises the canonical MCP resource and email-only scope", () => {
  const resourceUrl = "https://example.supabase.co/functions/v1/cryptobot-mcp/mcp";
  const issuer = "https://example.supabase.co/auth/v1";
  assert.deepEqual(oauthProtectedResourceMetadata(resourceUrl, issuer), {
    resource: resourceUrl,
    authorization_servers: [issuer],
    scopes_supported: ["email"],
    bearer_methods_supported: ["header"],
  });
});

test("unauthorized challenge points clients at OAuth protected-resource discovery", () => {
  const metadataUrl = "https://example.supabase.co/functions/v1/cryptobot-mcp/.well-known/oauth-protected-resource";
  const headers = unauthorizedHeaders(metadataUrl);
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(
    headers["www-authenticate"],
    `Bearer resource_metadata="${metadataUrl}", scope="email"`,
  );
});
