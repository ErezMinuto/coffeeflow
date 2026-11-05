// delegate_to_agent — the brain chat's hand-off to the agents that make the work.
//
// Two routes, both draft-only (nothing is ever sent, scheduled or published):
//   • email + final_copy → generate-campaign 'render-draft': the owner's
//     approved words, rendered in the house template, saved as a campaigns
//     draft. No AI and no critic, so the copy stays word for word.
//   • everything else → a strategic_recommendations row already 'approved'
//     (the owner said yes in chat), which strategist-executor drafts on its
//     next tick through the existing email / blog / IG pipelines.

import { checkBlogProducts } from "../_shared/blog_products.ts";
import { fetchMinutoCoffeeCatalog } from "../seo-agent/services/cmsApi.ts";
import { critiqueOn, readLoopConfig } from "../_shared/strategist_loop.ts";

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const COFFEEFLOW_USER_ID = Deno.env.get("COFFEEFLOW_USER_ID") ?? "";

const ACTION_TYPE = { email: "email_campaign", blog: "content_blog", instagram: "content_ig" } as const;
type Agent = keyof typeof ACTION_TYPE;

// deno-lint-ignore no-explicit-any
type Db = any;
export interface DelegateResult { text: string; data: Record<string, unknown> | null }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
const refused = (why: string): DelegateResult => ({
  text: `NOT delegated: ${why} Nothing was created, so no draft will arrive. Fix it or tell the owner.`,
  data: { ok: false, error: why },
});

// deno-lint-ignore no-explicit-any
export async function delegateToAgent(supabase: Db, input: Record<string, any>): Promise<DelegateResult> {
  const agent = str(input.agent) as Agent;
  if (!(agent in ACTION_TYPE)) return refused(`agent must be one of email, blog, instagram (got "${input.agent}").`);
  const title = str(input.title);
  if (!title) return refused("title is required.");
  const rationale = str(input.rationale);
  const finalCopy = input.final_copy && typeof input.final_copy === "object" ? input.final_copy : null;
  const brief = input.brief && typeof input.brief === "object" ? input.brief : {};

  if (finalCopy) {
    if (agent !== "email") return refused("final_copy is for email only. For blog or Instagram pass a brief.");
    return await renderEmailDraft(finalCopy);
  }
  return await queueForAgent(supabase, agent, title, rationale, brief);
}

// deno-lint-ignore no-explicit-any
async function renderEmailDraft(c: Record<string, any>): Promise<DelegateResult> {
  if (!COFFEEFLOW_USER_ID) return refused("COFFEEFLOW_USER_ID is not set, so the draft has no owner.");
  if (!str(c.subject) || !str(c.body)) return refused("final_copy needs subject and body.");
  const res = await fetch(`${SUPA_URL}/functions/v1/generate-campaign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPA_KEY}`, "apikey": SUPA_KEY },
    body: JSON.stringify({
      action: "render-draft",
      userId: COFFEEFLOW_USER_ID,
      campaignType: "brain",
      // Passed through untouched: the copy is the owner's, word for word.
      subject: c.subject, preheader: c.preheader, body: c.body, ctaText: c.cta_text, ctaUrl: c.cta_url,
      // Design around the words (the words never change): real products, an
      // image built around their real bags, and the offer's last day.
      products: strList(c.products).slice(0, 4), sceneBrief: str(c.scene_brief), promoDeadline: str(c.promo_deadline),
    }),
  });
  let out: Record<string, any> = {};
  try { out = await res.json(); } catch { /* non-JSON error body */ }
  const id = out?.campaign?.id;
  if (!res.ok || !out?.ok || id == null) {
    return { text: `Email draft FAILED: ${out?.error ?? `HTTP ${res.status}`}. Nothing was created. Tell the owner what went wrong.`, data: { ok: false, error: out?.error ?? `HTTP ${res.status}` } };
  }
  const sc = out?.scene;
  const sceneNote = !sc ? ""
    : sc.used ? ` A scene image built around the real bags passed the label check (attempt ${sc.attempts}) and is the hero.`
    : ` The scene image did NOT pass (${(sc.issues ?? []).slice(-2).join(" / ") || "no image"}), so the real product photo is the hero instead. Tell the owner.`;
  return {
    text: `Email DRAFT ${out.existed ? "already existed (same copy, created minutes ago; nothing new was made)" : "created"}: campaign id ${id}, subject "${out.campaign.subject}". The copy is word for word as approved; the only addition is the legal " | פרסומת" subject suffix. It is in Marketing → History.${sceneNote} NOTHING was sent or scheduled: the owner picks the audience and sends it from there.`,
    data: { ok: true, kind: "email_draft", campaign_id: id, existed: !!out.existed, link: "/marketing?tab=history", scene_used: sc?.used ?? null },
  };
}

async function queueForAgent(
  supabase: Db, agent: Agent, title: string, rationale: string,
  // deno-lint-ignore no-explicit-any
  b: Record<string, any>,
): Promise<DelegateResult> {
  let params: Record<string, unknown>;
  if (agent === "email") {
    const angle = str(b.angle);
    if (!angle) return refused("an email brief needs an angle (or pass final_copy with the finished words).");
    params = { angle, subject_he: str(b.subject_he) || undefined, products: strList(b.products), target_segment: str(b.target_segment) || undefined };
  } else if (agent === "blog") {
    const keyword = str(b.keyword), topic = str(b.topic), keyPoints = strList(b.key_points);
    const missing = [!keyword && "keyword", !topic && "topic", !keyPoints.length && "key_points"].filter(Boolean);
    if (missing.length) return refused(`a blog brief needs ${missing.join(", ")}.`);
    const lineup = (await fetchMinutoCoffeeCatalog(supabase)).map((p: { name: string }) => p.name);
    const chk = checkBlogProducts(b.products, lineup);
    if (!chk.ok) return refused(`${chk.error}. Minuto coffee lineup: ${lineup.join(" | ")}`);
    params = { keyword, topic, key_points: keyPoints, products: (chk as { products: string[] }).products, why_now: rationale || undefined };
  } else {
    const caption = str(b.caption_he);
    if (!caption) return refused("an Instagram brief needs caption_he (the approved Hebrew caption).");
    const productName = str(b.product_name);
    params = {
      caption_he: caption, hashtags: strList(b.hashtags), topic: str(b.topic) || title,
      media_type: b.media_type === "story" ? "story" : "feed_image",
      ...(productName ? { product_name: productName, render_mode: "bag_hero" } : {}),
    };
  }

  const actionType = ACTION_TYPE[agent];
  // A chat tool can fire twice for one approval: same piece within 15 minutes
  // = the same hand-off.
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: dupe } = await supabase.from("strategic_recommendations")
    .select("id, status").eq("action_type", actionType).eq("title", title).gte("created_at", since)
    .limit(1).maybeSingle();
  if (dupe) {
    return {
      text: `Already handed to the ${agent} agent minutes ago (id ${String(dupe.id).slice(0, 8)}, status ${dupe.status}). Nothing new was queued.`,
      data: { ok: true, kind: "queued", agent, rec_id: dupe.id, existed: true, link: "/admin/seo-agent?view=inbox" },
    };
  }

  const { data: row, error } = await supabase.from("strategic_recommendations").insert({
    title,
    rationale: rationale || `handed over from the marketing brain chat`,
    action_type: actionType,
    action_params: { ...params, source: "marketing_brain" },
    // The owner's yes in chat IS the approval: the executor claims 'approved'.
    status: "approved",
  }).select("id").single();
  if (error) return { text: `Hand-off FAILED: ${error.message}. Nothing was queued.`, data: { ok: false, error: error.message } };

  // With the reviewer loop on for this type the draft is critiqued (and maybe
  // revised) first, then lands in the Approvals inbox.
  const reviewed = critiqueOn(await readLoopConfig(supabase), actionType);
  const lands = reviewed
    ? "After the reviewer agent checks it, the draft lands in the Approvals inbox (SEO agent → Approvals)."
    : agent === "email"
      ? "The draft lands in Marketing → History."
      : agent === "blog"
        ? "The article lands as a WordPress draft for review."
        : "The image and post land in the Instagram review queue.";
  const link = reviewed ? "/admin/seo-agent?view=inbox" : linkFor(agent);
  return {
    text: `Handed to the ${agent} agent (id ${String(row.id).slice(0, 8)}). The agent picks it up within about 5 minutes and drafts it. ${lands} Nothing is sent or published.`,
    data: { ok: true, kind: "queued", agent, rec_id: row.id, link },
  };
}

function linkFor(agent: Agent): string {
  return agent === "email" ? "/marketing?tab=history" : "/admin/seo-agent?view=inbox";
}
