/**
 * clerk-user-lookup
 * Looks up a Clerk user by email and returns their user_id.
 * Requires CLERK_SECRET_KEY set in Supabase Edge Function secrets.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CLERK_SECRET = Deno.env.get("CLERK_SECRET_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { email } = await req.json();
    if (!email) return new Response(JSON.stringify({ error: "email required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

    const res = await fetch(
      `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: `Bearer ${CLERK_SECRET}` } }
    );

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: err }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const users = await res.json();
    if (!users.length) {
      return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const u = users[0];
    return new Response(JSON.stringify({
      user_id:   u.id,
      email:     u.email_addresses?.[0]?.email_address ?? email,
      full_name: [u.first_name, u.last_name].filter(Boolean).join(" "),
    }), { headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
