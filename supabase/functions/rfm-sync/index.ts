/**
 * rfm-sync — computes RFM scores from customer_orders and refreshes the six
 * rfm_* contact_groups so the Marketing dashboard can target each segment.
 *
 * Pipeline:
 *   1. Pull every paid web order from customer_orders (2023 onward, identities
 *      already merged into customer_id). woo_orders only starts in Jan 2026,
 *      so segments built from it called a ten-order regular "new".
 *   2. Group by customer_id → order_count, first/last order date,
 *      days_since_last, lifetime Minuto bean grams, and ₪ spend where
 *      woo_orders knows the order total (2026 onward only).
 *   3. Score R/F/M by quintile across the full base. M is lifetime Minuto
 *      BEAN grams, not ₪: beans are the business goal and customer_orders
 *      carries no totals, so a one-off machine buyer is no longer a
 *      "big_spender" ahead of a customer who buys beans every two months.
 *   4. Assign segment based on the R/F/M combination
 *   5. Upsert into customer_rfm (email PK, the customer's latest email). Rows
 *      this run did not write get segment='superseded' (never deleted).
 *   6. Clear + repopulate the six rfm_* contact_groups — but only with emails
 *      that also exist in marketing_contacts with opted_in=true (compliance —
 *      unsubscribed customers stay out of segments even if WooCommerce has
 *      their order history)
 *
 * Cron: pg_cron job rfm-sync-daily (migration 20261026d). The GitHub
 * auto-sync.yml schedule that used to call it has been off since 2026-04-21.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { isServiceCaller, unauthorized } from "../_shared/service_caller.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";

const SUPA_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Segment rules — applied in order, first match wins. Tuned for a repeat-purchase
// coffee business: short lifecycle means "at_risk" threshold is 60 days, not the
// 180-day retail default.
function assignSegment(r: number, f: number, m: number, daysSinceLast: number): string {
  // Champions — top tier on all three dims
  if (r >= 4 && f >= 4 && m >= 4) return "champion";
  // Loyal — consistent repeat buyers, good value
  if (f >= 4 && r >= 3) return "loyal";
  // Big spenders — high monetary but lower frequency (gift buyers, B2B)
  if (m >= 4 && f <= 3) return "big_spender";
  // At-risk — WAS active, now silent (R low but F was high)
  if (r <= 2 && f >= 3) return "at_risk";
  // New — first order recently (high R, low F)
  if (r >= 4 && f === 1) return "new";
  // Lost — gone for 6+ months
  if (daysSinceLast >= 180) return "lost";
  // Default bucket
  return "regular";
}

// Quintile score 1-5: higher = better. Ranked across the full customer base.
function quintileScore(sortedValues: number[], value: number, inverted = false): number {
  if (sortedValues.length === 0) return 3;
  // Position of this value in the sorted array (0-indexed)
  let position = 0;
  for (const v of sortedValues) {
    if (inverted ? (v <= value) : (v < value)) position++;
    else break;
  }
  const pct = position / sortedValues.length;
  // Map 0-1 → 1-5 (higher percentile = higher score). For inverted metrics
  // (e.g. days_since_last where lower = better) the caller pre-sorts ascending.
  const score = Math.min(5, Math.max(1, Math.floor(pct * 5) + 1));
  return score;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // verify_jwt is off, so the caller is checked here. Rebuilds the rfm_* contact groups. Only auto-sync.yml (service key) calls it.
  if (!(await isServiceCaller(req))) return unauthorized(CORS);

  const supabase = createClient(SUPA_URL, SUPA_KEY);
  const startedAt = new Date().toISOString();

  try {
    // 1. Pull paid web orders, paged (PostgREST caps a response at 1000 rows)
    interface OrderRow {
      customer_id: string; email_norm: string | null; date_created: string;
      woo_order_id: number;
      lines: { name?: string; quantity?: number; is_bean?: boolean; grams_each?: number | null }[] | null;
    }
    const orders: OrderRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("customer_orders")
        .select("customer_id, email_norm, date_created, woo_order_id, lines")
        .in("status", ["completed", "processing"])  // processing counts — paid but not yet fulfilled
        .eq("resolve_skipped", false)
        .not("customer_id", "is", null)
        .order("woo_order_id")
        .range(from, from + 999);
      if (error) throw new Error(`customer_orders fetch: ${error.message}`);
      orders.push(...((data ?? []) as OrderRow[]));
      if (!data || data.length < 1000) break;
    }
    if (orders.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No orders found", customers: 0 }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ₪ totals exist only in woo_orders (Jan 2026 onward).
    const totals = new Map<number, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("woo_orders").select("woo_order_id, total")
        .order("woo_order_id").range(from, from + 999);
      if (error) throw new Error(`woo_orders fetch: ${error.message}`);
      for (const r of (data ?? []) as Array<{ woo_order_id: number; total: number | null }>) {
        totals.set(r.woo_order_id, Number(r.total) || 0);
      }
      if (!data || data.length < 1000) break;
    }

    // Minuto's own roasted beans only: resold Veneto/Toddy and green coffee
    // are bean lines too, but they are not what the business is trying to grow.
    const NOT_MINUTO = /veneto|toddy|ירוק|green/i;
    const minutoGrams = (o: OrderRow) => (o.lines ?? [])
      .filter(l => l.is_bean && !NOT_MINUTO.test(l.name ?? ""))
      .reduce((s, l) => s + (Number(l.quantity) || 0) * (l.grams_each ?? 330), 0);  // unknown size → the standard 330 g bag

    // 2. Group by customer
    interface CustomerRaw {
      email: string;
      latestAt: string;
      orders: number;
      total: number;
      grams: number;
      firstDate: string;
      lastDate: string;
    }
    const byCustomer = new Map<string, CustomerRaw>();
    for (const o of orders) {
      const date = o.date_created.slice(0, 10);
      const grams = minutoGrams(o);
      const total = totals.get(o.woo_order_id) ?? 0;
      const c = byCustomer.get(o.customer_id);
      if (!c) {
        byCustomer.set(o.customer_id, {
          email: o.email_norm ?? "", latestAt: o.date_created,
          orders: 1, total, grams, firstDate: date, lastDate: date,
        });
        continue;
      }
      c.orders++;
      c.total += total;
      c.grams += grams;
      if (date < c.firstDate) c.firstDate = date;
      if (date > c.lastDate)  c.lastDate  = date;
      if (o.email_norm && o.date_created > c.latestAt) { c.email = o.email_norm; c.latestAt = o.date_created; }
      else if (!c.email && o.email_norm) c.email = o.email_norm;
    }

    // 3. Compute scores
    const today = new Date();
    const customers = [...byCustomer.entries()]
      .filter(([, c]) => c.email)
      .map(([customerId, c]) => {
        const daysSinceLast = Math.floor(
          (today.getTime() - new Date(c.lastDate).getTime()) / (24 * 60 * 60 * 1000)
        );
        return { ...c, customerId, daysSinceLast };
      });

    // Sorted baselines for quintile ranking
    // Recency: fewer days = better → sort ascending, inverted
    const recencyBase  = [...customers].map(c => c.daysSinceLast).sort((a, b) => a - b);
    // Frequency: more orders = better → sort ascending, regular
    const frequencyBase = [...customers].map(c => c.orders).sort((a, b) => a - b);
    // Monetary: more Minuto bean grams = better → sort ascending, regular
    const monetaryBase = [...customers].map(c => c.grams).sort((a, b) => a - b);

    // 4. Upsert scored rows, 500 per request
    let upserted = 0;
    const segmentCounts: Record<string, number> = {};
    const segmentOf = new Map<string, string>();
    const rows = customers.map(c => {
      // For recency: invert because lower days = higher score
      const rScore = 6 - quintileScore(recencyBase, c.daysSinceLast);  // flipped
      const fScore = quintileScore(frequencyBase, c.orders);
      const mScore = quintileScore(monetaryBase, c.grams);
      const segment = assignSegment(rScore, fScore, mScore, c.daysSinceLast);
      segmentCounts[segment] = (segmentCounts[segment] ?? 0) + 1;
      segmentOf.set(c.email, segment);
      return {
        email:            c.email,
        customer_id:      c.customerId,
        first_order_date: c.firstDate,
        last_order_date:  c.lastDate,
        order_count:      c.orders,
        total_spent_ils:  Math.round(c.total * 100) / 100,
        bean_grams:       Math.round(c.grams),
        days_since_last:  c.daysSinceLast,
        r_score:          rScore,
        f_score:          fScore,
        m_score:          mScore,
        segment,
        updated_at:       startedAt,
      };
    });
    // One row per email: a second row with the same key in one upsert fails the batch.
    const unique = [...new Map(rows.map(r => [r.email, r])).values()];
    for (let i = 0; i < unique.length; i += 500) {
      const batch = unique.slice(i, i + 500);
      const { error: upErr } = await supabase.from("customer_rfm").upsert(batch, { onConflict: "email" });
      if (upErr) console.error(`[rfm-sync] upsert fail (rows ${i}-${i + batch.length}): ${upErr.message}`);
      else upserted += batch.length;
    }

    // Rows from earlier runs whose email is no longer anyone's latest (or that
    // came from the old woo_orders source) would sit in the table with stale
    // scores. Mark them instead of deleting them.
    const { count: superseded, error: supErr } = await supabase
      .from("customer_rfm")
      .update({ segment: "superseded" }, { count: "exact" })
      .lt("updated_at", startedAt)
      .neq("segment", "superseded");
    if (supErr) console.error(`[rfm-sync] superseded mark fail: ${supErr.message}`);

    // 5. Refresh contact_group memberships
    // Only include emails that are in marketing_contacts + opted_in=true.
    // Customers who ordered but never opted into marketing stay out of email
    // segments (we can still target them via Meta Custom Audiences separately).
    const { data: optedIn } = await supabase
      .from("marketing_contacts")
      .select("email")
      .eq("opted_in", true);

    const optedInSet = new Set(
      ((optedIn ?? []) as Array<{ email: string }>).map(r => r.email.trim().toLowerCase())
    );

    const segmentToGroupName: Record<string, string> = {
      champion:    "rfm_champions",
      loyal:       "rfm_loyal",
      big_spender: "rfm_big_spenders",
      at_risk:     "rfm_at_risk",
      new:         "rfm_new",
      lost:        "rfm_lost",
    };

    const groupMembers: Record<string, Array<{ email: string }>> = {};
    for (const segName of Object.values(segmentToGroupName)) groupMembers[segName] = [];

    for (const c of customers) {
      if (!optedInSet.has(c.email)) continue;  // must be opted-in
      const segment = segmentOf.get(c.email);
      if (!segment) continue;
      const groupName = segmentToGroupName[segment];
      if (groupName) groupMembers[groupName].push({ email: c.email });
    }

    // Resolve group IDs, clear old memberships, insert new ones
    const groupSummary: Record<string, number> = {};
    for (const [groupName, members] of Object.entries(groupMembers)) {
      const { data: groupRow } = await supabase
        .from("contact_groups")
        .select("id")
        .eq("name", groupName)
        .maybeSingle();

      if (!groupRow) {
        console.error(`[rfm-sync] group '${groupName}' not found — skipping`);
        continue;
      }
      const groupId = (groupRow as any).id;

      // Replace-all strategy: simpler than diffing
      await supabase.from("contact_group_members").delete().eq("group_id", groupId);

      if (members.length > 0) {
        // Insert in batches of 500 to avoid oversize payloads
        const batches = [];
        for (let i = 0; i < members.length; i += 500) {
          batches.push(members.slice(i, i + 500).map(m => ({
            group_id: groupId,
            email:    m.email,
          })));
        }
        for (const batch of batches) {
          const { error: insErr } = await supabase
            .from("contact_group_members")
            .insert(batch);
          if (insErr) console.error(`[rfm-sync] member insert fail ${groupName}: ${insErr.message}`);
        }
      }
      groupSummary[groupName] = members.length;
    }

    return new Response(JSON.stringify({
      success:       true,
      started_at:    startedAt,
      finished_at:   new Date().toISOString(),
      total_customers: customers.length,
      rfm_upserted:  upserted,
      rfm_superseded: superseded ?? 0,
      segment_counts: segmentCounts,
      opted_in_groups: groupSummary,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("[rfm-sync] error:", err?.message);
    return new Response(JSON.stringify({ success: false, error: err?.message ?? "unknown" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
