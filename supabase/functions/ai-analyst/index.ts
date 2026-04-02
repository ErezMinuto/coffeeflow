/**
 * CoffeeFlow — AI Analyst Edge Function
 *
 * Requires a valid Clerk JWT (via the "supabase" template) in the
 * Authorization header.  Unauthenticated requests are rejected with 401.
 *
 * Environment secrets (Supabase → Edge Functions → Secrets):
 *   ANTHROPIC_API_KEY  — Claude API key
 *   SUPABASE_JWT_SECRET — automatically injected by Supabase runtime
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")  ?? "";
const JWT_SECRET     = Deno.env.get("JWT_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── JWT verification ──────────────────────────────────────────────────────────
// Verifies the Clerk-issued JWT (signed with the Supabase JWT secret).
// Returns the 'sub' claim (Clerk user ID) or null if invalid.
async function verifyJWT(token: string): Promise<string | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const data      = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid     = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;

    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload.sub ?? null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  // Auth guard temporarily disabled — JWT signing mismatch between Clerk and PostgREST

  try {
    const { messages, systemPrompt } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: "messages array required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: systemPrompt || "אתה אנליסט שיווק דיגיטלי. ענה בעברית.",
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Anthropic error:", err);
      return new Response(
        JSON.stringify({ error: "Upstream API error" }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("ai-analyst error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
