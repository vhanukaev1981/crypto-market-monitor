import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CryptoBotPrincipal } from "../../mcp/auth.ts";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

export type ScopedSupabase = {
  client: SupabaseClient;
  userId: string;
};

export function createScopedSupabase(principal: CryptoBotPrincipal): ScopedSupabase {
  const client = createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return { client, userId: principal.supabaseUserId };
}
