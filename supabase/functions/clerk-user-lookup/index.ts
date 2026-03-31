/**
 * clerk-user-lookup
 * Looks up Clerk users by email OR by user_id (or bulk by user_ids array).
 * Requires CLERK_SECRET_KEY set in Supabase Edge Function secrets.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CLERK_SECRET = Deno.env.get("CLERK_SECRET_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatUser(u: any) {
  return {
    user_id:   u.id,
    email:     u.email_addresses?.[0]?.email_address ?? "",
    full_name: [u.first_name, u.last_name].filter(Boolean).join(" "),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();

    // Bulk lookup by user_ids array
    if (body.user_ids && Array.isArray(body.user_ids)) {
      const params = body.user_ids.map((id: string) => `user_id=${encodeURIComponent(id)}`).join("&");
      const res = await fetch(`https://api.clerk.com/v1/users?${params}&limit=100`, {
        headers: { Authorization: `Bearer ${CLERK_SECRET}` },
      });
      if (!res.ok) throw new Error(await res.text());
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
        { headers: { Authorization: `Bearer ${CLERK_SECRET}` } }
      );
      if (!res.ok) throw new Error(await res.text());
      const users = await res.json();
      if (!users.length) return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404, headers: { ...CORS, "Content-Type": "application/json" },
      });
      return new Response(JSON.stringify(formatUser(users[0])), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "email, user_id, or user_ids required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
