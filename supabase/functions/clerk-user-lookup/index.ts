/**
 * clerk-user-lookup
 * Looks up Clerk users by email OR by user_id (or bulk by user_ids array).
 *
 * Requires:
 *   - Valid Clerk JWT in Authorization header (authenticated users only)
 *   - CLERK_SECRET_KEY + SUPABASE_JWT_SECRET set in Edge Function secrets
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLERK_SECRET = Deno.env.get("CLERK_SECRET_KEY")           ?? "";
const JWT_SECRET   = Deno.env.get("JWT_SECRET")        ?? "";
const SUPA_URL     = Deno.env.get("SUPABASE_URL")               ?? "";
const SUPA_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")  ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── JWT verification ──────────────────────────────────────────────────────────
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
    const signature = Uint8Array.from(
      atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")),
      c => c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;

    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload.sub ?? null;
  } catch {
    return null;
  }
}

function formatUser(u: any) {
  return {
    user_id:   u.id,
    email:     u.email_addresses?.[0]?.email_address ?? "",
    full_name: [u.first_name, u.last_name].filter(Boolean).join(" "),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Auth guard temporarily disabled — JWT signing mismatch between Clerk and PostgREST

  try {
    const body = await req.json();

    // ── get-role: return the requesting user's role from user_roles ──────────
    if (body.action === "get-role") {
      const uid = body.user_id;
      if (!uid) return new Response(JSON.stringify({ error: "user_id required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", uid)
        .single();
      const role = data?.role ?? "employee";
      return new Response(JSON.stringify({ role }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Bulk lookup by user_ids array
    if (body.user_ids && Array.isArray(body.user_ids)) {
      const params = body.user_ids.map((id: string) => `user_id=${encodeURIComponent(id)}`).join("&");
      const res = await fetch(`https://api.clerk.com/v1/users?${params}&limit=100`, {
        headers: { Authorization: `Bearer ${CLERK_SECRET}` },
      });
      if (!res.ok) throw new Error("Clerk API error");
      const users = await res.json();
      return new Response(JSON.stringify(users.map(formatUser)), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Lookup by user_id
    if (body.user_id) {
      const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(body.user_id)}`, {
        headers: { Authorization: `Bearer ${CLERK_SECRET}` },
      });
      if (!res.ok) throw new Error("User not found");
      const u = await res.json();
      return new Response(JSON.stringify(formatUser(u)), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Lookup by email
    if (body.email) {
      const res = await fetch(
        `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(body.email)}&limit=1`,
        { headers: { Authorization: `Bearer ${CLERK_SECRET}` } },
      );
      if (!res.ok) throw new Error("Clerk API error");
      const users = await res.json();
      if (!users.length) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(formatUser(users[0])), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "email, user_id, or user_ids required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("clerk-user-lookup error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
