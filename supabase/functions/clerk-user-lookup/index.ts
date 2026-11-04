/**
 * clerk-user-lookup
 * Looks up Clerk users by email OR by user_id (or bulk by user_ids array).
 *
 * Role invitations (Settings → roles, for someone with no Clerk account yet):
 *   { action: "invite", email, role }    admin: Clerk emails them a sign-up
 *                                        link; the role rides along in the
 *                                        invitation's public_metadata.
 *   { action: "list-invites" }           admin: pending invitations, and
 *                                        accepted ones not yet claimed.
 *   { action: "revoke-invite", id, user_id? }  admin: cancel one (user_id for
 *                                        an accepted one: clears its role).
 *   { action: "clear-invited-role", user_id }  admin: Settings calls this on
 *                                        every manual role change, so an old
 *                                        invitation can never override it.
 *   { action: "claim-invite" }           ANY signed-in user, about themselves:
 *                                        if their Clerk public_metadata carries
 *                                        a live invited role and they have no
 *                                        user_roles row, the row is created;
 *                                        either way the metadata is cleared.
 *   public_metadata is writable only with CLERK_SECRET_KEY, so a user cannot
 *   grant themselves a role; invited roles expire after 30 days. See invites.ts.
 *
 * Requires:
 *   - An admin's Clerk token (or the service role) in Authorization — except
 *     claim-invite, which needs a genuine signed-in Clerk token (any role)
 *   - CLERK_SECRET_KEY set in Edge Function secrets
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callerRole, forbidden, hasRole, jwtSub } from "../_shared/role_caller.ts";
import { claimInvite, clearInvitedRole, createInvite, listInvites, revokeInvite } from "./invites.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";

const CLERK_SECRET = Deno.env.get("CLERK_SECRET_KEY")           ?? "";
const SUPA_URL     = Deno.env.get("SUPABASE_URL")               ?? "";
const SUPA_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")  ?? "";

const APP_ORIGIN   = Deno.env.get("COFFEEFLOW_ORIGIN")          ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

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
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  // ── claim-invite: a signed-in user picks up the role they were invited with.
  // callerRole() asks the database WITH the caller's token, so a non-null
  // answer means the token is genuine and its `sub` is who they are. The
  // service role is nobody, and is refused.
  if (body?.action === "claim-invite") {
    const role = await callerRole(req);
    const token = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    const sub = token ? jwtSub(token) : null;
    if (!role || role === "service" || !sub) return forbidden(CORS);
    try {
      return reply(await claimInvite(sub, { supabase, clerkSecret: CLERK_SECRET }));
    } catch (err: any) {
      console.error("claim-invite error:", err?.message ?? err);
      return reply({ claimed: false, error: "claim failed" }, 500);
    }
  }

  // verify_jwt is off, so the caller is checked here. Returns users' emails and names. Only the admin Settings page calls it.
  if (!(await hasRole(req, ["admin"]))) return forbidden(CORS);

  try {
    // ── role invitations (admin) ─────────────────────────────────────────────
    if (body.action === "invite") {
      const r = await createInvite(body.email, body.role, { clerkSecret: CLERK_SECRET, redirectUrl: APP_ORIGIN });
      return reply(r.ok ? r : { error: r.error }, r.ok ? 200 : r.status);
    }
    if (body.action === "list-invites") {
      return reply({ invites: await listInvites({ clerkSecret: CLERK_SECRET }) });
    }
    if (body.action === "revoke-invite") {
      const r = await revokeInvite(body.id, body.user_id, { clerkSecret: CLERK_SECRET });
      return reply(r.ok ? r : { error: r.error }, r.ok ? 200 : r.status);
    }
    if (body.action === "clear-invited-role") {
      const r = await clearInvitedRole(body.user_id, { clerkSecret: CLERK_SECRET });
      return reply(r.ok ? r : { error: r.error }, r.ok ? 200 : r.status);
    }

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
      if (!res.ok) {
        const errText = await res.text();
        console.error("Clerk API error:", res.status, errText);
        throw new Error(`Clerk API error ${res.status}: ${errText}`);
      }
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

  } catch (err: any) {
    console.error("clerk-user-lookup error:", err);
    return new Response(
      JSON.stringify({ error: err?.message ?? String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
