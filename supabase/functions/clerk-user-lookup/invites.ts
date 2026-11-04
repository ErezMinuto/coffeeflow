// Role invitations through Clerk.
//
// An admin adds someone in Settings → roles who has no Clerk account yet.
// createInvite() asks Clerk to email them a sign-up link, with the chosen
// role (and an expiry) in the invitation's public_metadata. Clerk copies that
// metadata onto the user it creates when they accept. On their first
// sign-in the app sees the metadata and calls claim-invite, and
// claimInvite() turns it into the user_roles row.
//
// Why this is safe:
//   • public_metadata can be written only with the secret key (this
//     function), never by the user, so a claimed role is one an admin set.
//   • It expires: an invited role is good for INVITE_TTL_DAYS from the
//     invitation, then ignored.
//   • It is used once and never overrides an admin: claim clears it, and if
//     the user already has a user_roles row it is cleared without touching
//     the row. Any manual role change in Settings also clears it
//     (clearInvitedRole), so deleting a role cannot later revive an old
//     invitation.
//   • It is never invisible: listInvites() shows pending invitations AND
//     people who accepted but have not signed in to CoffeeFlow yet, while
//     their role is still claimable; both can be cancelled.

// deno-lint-ignore-file no-explicit-any

export const INVITE_ROLES = ["employee", "schedule_manager", "admin", "bookkeeper"] as const;
export type InviteRole = typeof INVITE_ROLES[number];
/** public_metadata keys carrying the invited role and when it stops counting (epoch ms). */
export const META_KEY = "coffeeflow_role";
export const META_EXP = "coffeeflow_role_expires";
export const INVITE_TTL_DAYS = 30;

const CLERK = "https://api.clerk.com/v1";
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function isInviteRole(r: unknown): r is InviteRole {
  return typeof r === "string" && (INVITE_ROLES as readonly string[]).includes(r);
}

export function normaliseEmail(e: unknown): string | null {
  const v = typeof e === "string" ? e.trim().toLowerCase() : "";
  return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

/** The invited role in this metadata, if present and not expired. */
export function liveRole(meta: any, now: number): InviteRole | null {
  const role = meta?.[META_KEY];
  const exp = Number(meta?.[META_EXP]);
  return isInviteRole(role) && Number.isFinite(exp) && exp > now ? role : null;
}

const hasInviteKeys = (meta: any) => meta != null && (META_KEY in meta || META_EXP in meta);

interface ClerkOpts { clerkSecret: string; fetchFn?: typeof fetch; now?: number }

async function clerk(path: string, o: ClerkOpts, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  if (!o.clerkSecret) throw new Error("CLERK_SECRET_KEY is not set");
  const res = await (o.fetchFn ?? fetch)(`${CLERK}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${o.clerkSecret}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Clerk's error text, e.g. "That email address is taken." */
function clerkError(body: any): string {
  const e = body?.errors?.[0];
  return e?.long_message || e?.message || "Clerk error";
}

const listOf = (body: any): any[] => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);
const validUserId = (id: unknown): id is string => typeof id === "string" && /^user_[A-Za-z0-9]+$/.test(id);

/** Remove the invited-role keys from a user's public_metadata (a null in a merge deletes the key). */
async function clearMeta(userId: string, o: ClerkOpts): Promise<boolean> {
  const { status, body } = await clerk(`/users/${encodeURIComponent(userId)}/metadata`, o, {
    method: "PATCH", body: JSON.stringify({ public_metadata: { [META_KEY]: null, [META_EXP]: null } }),
  });
  if (status >= 400) console.error("clearing invited role failed", status, clerkError(body));
  return status < 400;
}

export interface InviteView {
  /** pending: the email has not signed up yet. accepted: signed up, not yet signed in to CoffeeFlow. */
  status: "pending" | "accepted";
  id: string;              // Clerk invitation id
  user_id: string | null;  // set when accepted
  email: string;
  role: InviteRole;
  expires: number;
}

export async function createInvite(
  email: unknown, role: unknown, o: ClerkOpts & { redirectUrl?: string },
): Promise<{ ok: true; invite: InviteView } | { ok: false; status: number; error: string }> {
  const addr = normaliseEmail(email);
  if (!addr) return { ok: false, status: 400, error: "כתובת אימייל לא תקינה" };
  if (!isInviteRole(role)) return { ok: false, status: 400, error: "תפקיד לא מוכר" };
  const expires = (o.now ?? Date.now()) + INVITE_TTL_DAYS * 86_400_000;
  const { status, body } = await clerk("/invitations", o, {
    method: "POST",
    body: JSON.stringify({
      email_address: addr,
      public_metadata: { [META_KEY]: role, [META_EXP]: expires },
      notify: true,
      expires_in_days: INVITE_TTL_DAYS,
      ...(o.redirectUrl ? { redirect_url: o.redirectUrl } : {}),
    }),
  });
  if (status >= 400) {
    // 422 covers "already has an account" and "already invited".
    return { ok: false, status: status === 422 ? 409 : 502, error: clerkError(body) };
  }
  if (!body?.id) return { ok: false, status: 502, error: "Clerk returned an unexpected invitation" };
  return { ok: true, invite: { status: "pending", id: body.id, user_id: null, email: addr, role, expires } };
}

/** Pending invitations, plus accepted ones whose role the user has not claimed yet. */
export async function listInvites(o: ClerkOpts): Promise<InviteView[]> {
  const now = o.now ?? Date.now();
  const out: InviteView[] = [];

  const pending = await clerk("/invitations?status=pending&limit=100", o);
  if (pending.status >= 400) throw new Error(`Clerk invitations ${pending.status}: ${clerkError(pending.body)}`);
  for (const inv of listOf(pending.body)) {
    const role = liveRole(inv.public_metadata, now);
    if (role) out.push({ status: "pending", id: inv.id, user_id: null, email: inv.email_address ?? "", role, expires: Number(inv.public_metadata[META_EXP]) });
  }

  // Accepted: still claimable only while the user's own metadata holds a live role.
  const accepted = await clerk("/invitations?status=accepted&limit=100", o);
  if (accepted.status >= 400) throw new Error(`Clerk invitations ${accepted.status}: ${clerkError(accepted.body)}`);
  for (const inv of listOf(accepted.body)) {
    if (!liveRole(inv.public_metadata, now) || !inv.email_address) continue;   // expired → nothing to show
    const { status, body } = await clerk(`/users?email_address=${encodeURIComponent(inv.email_address)}&limit=1`, o);
    const u = status < 400 ? listOf(body)[0] : null;
    const role = u ? liveRole(u.public_metadata, now) : null;
    if (u && role) out.push({ status: "accepted", id: inv.id, user_id: u.id, email: inv.email_address, role, expires: Number(u.public_metadata[META_EXP]) });
  }
  return out;
}

/** Cancel: revoke a pending invitation, or clear the role an accepted one left on its user. */
export async function revokeInvite(
  id: unknown, userId: unknown, o: ClerkOpts,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (userId != null) {
    if (!validUserId(userId)) return { ok: false, status: 400, error: "bad user id" };
    return (await clearMeta(userId, o)) ? { ok: true } : { ok: false, status: 502, error: "Clerk error" };
  }
  if (typeof id !== "string" || !/^[A-Za-z0-9_]+$/.test(id)) return { ok: false, status: 400, error: "bad invitation id" };
  const { status, body } = await clerk(`/invitations/${id}/revoke`, o, { method: "POST" });
  if (status >= 400) return { ok: false, status: status === 404 ? 404 : 502, error: clerkError(body) };
  return { ok: true };
}

/** An admin set, changed or removed this user's role by hand: any invited role is void. */
export async function clearInvitedRole(
  userId: unknown, o: ClerkOpts,
): Promise<{ ok: true; cleared: boolean } | { ok: false; status: number; error: string }> {
  if (!validUserId(userId)) return { ok: false, status: 400, error: "bad user id" };
  const { status, body: u } = await clerk(`/users/${encodeURIComponent(userId)}`, o);
  if (status === 404) return { ok: true, cleared: false };
  if (status >= 400) return { ok: false, status: 502, error: clerkError(u) };
  if (!hasInviteKeys(u?.public_metadata)) return { ok: true, cleared: false };
  return (await clearMeta(userId, o)) ? { ok: true, cleared: true } : { ok: false, status: 502, error: "Clerk error" };
}

/**
 * The signed-in user `userId` (already verified by the caller) picks up the
 * role they were invited with, if it is still live. Never changes an existing
 * row; always clears the invited role once looked at.
 */
export async function claimInvite(
  userId: string, o: ClerkOpts & { supabase: any },
): Promise<{ claimed: boolean; role?: string }> {
  const now = o.now ?? Date.now();
  const { status, body: u } = await clerk(`/users/${encodeURIComponent(userId)}`, o);
  if (status >= 400) throw new Error(`Clerk user ${status}: ${clerkError(u)}`);
  if (!hasInviteKeys(u?.public_metadata)) return { claimed: false };
  const role = liveRole(u.public_metadata, now);

  const { data: existing, error: exErr } = await o.supabase
    .from("user_roles").select("role").eq("user_id", userId).maybeSingle();
  if (exErr) throw new Error(`user_roles lookup failed: ${exErr.message}`);

  if (existing || !role) {
    // An admin already decided (row exists), or the invitation expired.
    await clearMeta(userId, o);
    return existing ? { claimed: false, role: existing.role } : { claimed: false };
  }

  const email = (u.email_addresses ?? []).find((e: any) => e.id === u.primary_email_address_id)?.email_address
    ?? u.email_addresses?.[0]?.email_address ?? null;
  const full_name = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;

  // ignoreDuplicates: if an admin added a row a moment ago, theirs stands.
  const { error: insErr } = await o.supabase.from("user_roles")
    .upsert({ user_id: userId, email, full_name, role }, { onConflict: "user_id", ignoreDuplicates: true });
  if (insErr) throw new Error(`user_roles insert failed: ${insErr.message}`);
  await clearMeta(userId, o);

  const { data: after } = await o.supabase.from("user_roles").select("role").eq("user_id", userId).maybeSingle();
  return { claimed: after?.role === role, role: after?.role ?? role };
}
