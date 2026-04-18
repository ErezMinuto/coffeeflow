/**
 * rfm-sync — computes RFM scores from woo_orders and refreshes the six
 * rfm_* contact_groups so the Marketing dashboard can target each segment.
 *
 * Pipeline:
 *   1. Pull all completed woo_orders (paid, not refunded, with a customer_email)
 *   2. Group by customer_email → compute order_count, total_spent, last_order_date,
 *      first_order_date, days_since_last
 *   3. Score each customer on R/F/M using quintile ranking across the full base
 *   4. Assign segment based on the R/F/M combination
 *   5. Upsert into customer_rfm (email PK)
 *   6. Clear + repopulate the six rfm_* contact_groups — but only with emails
 *      that also exist in marketing_contacts with opted_in=true (compliance —
 *      unsubscribed customers stay out of segments even if WooCommerce has
 *      their order history)
 *
 * Cron schedule: daily at 04:30 UTC (07:30 Israel, right after auto-sync).
 * Can also be triggered manually for testing.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  const supabase = createClient(SUPA_URL, SUPA_KEY);
  const startedAt = new Date().toISOString();

  try {
    // 1. Pull completed orders
    const { data: orders, error: ordersErr } = await supabase
      .from("woo_orders")
      .select("customer_email, order_date, total, status")
      .in("status", ["completed", "processing"])  // processing counts — paid but not yet fulfilled
      .not("customer_email", "is", null);

    if (ordersErr) throw new Error(`woo_orders fetch: ${ordersErr.message}`);
    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No orders found", customers: 0 }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // 2. Group by email
    interface CustomerRaw {
      email: string;
      orders: number;
      total: number;
      firstDate: string;
      lastDate: string;
    }
    const byEmail = new Map<string, CustomerRaw>();
    for (const o of orders) {
      const email = (o.customer_email ?? "").trim().toLowerCase();
      if (!email) continue;
      const existing = byEmail.get(email);
      if (!existing) {
        byEmail.set(email, {
          email,
          orders: 1,
          total: Number(o.total) || 0,
          firstDate: o.order_date,
          lastDate: o.order_date,
        });
      } else {
        existing.orders++;
        existing.total += Number(o.total) || 0;
        if (o.order_date < existing.firstDate) existing.firstDate = o.order_date;
        if (o.order_date > existing.lastDate)  existing.lastDate  = o.order_date;
      }
    }

    // 3. Compute scores
    const today = new Date();
    const customers = [...byEmail.values()].map(c => {
      const daysSinceLast = Math.floor(
        (today.getTime() - new Date(c.lastDate).getTime()) / (24 * 60 * 60 * 1000)
      );
      return { ...c, daysSinceLast };
    });

    // Sorted baselines for quintile ranking
    // Recency: fewer days = better → sort ascending, inverted
    const recencyBase  = [...customers].map(c => c.daysSinceLast).sort((a, b) => a - b);
    // Frequency: more orders = better → sort ascending, regular
    const frequencyBase = [...customers].map(c => c.orders).sort((a, b) => a - b);
    // Monetary: more total = better → sort ascending, regular
    const monetaryBase = [...customers].map(c => c.total).sort((a, b) => a - b);

    // 4. Upsert scored rows
    let upserted = 0;
    const segmentCounts: Record<string, number> = {};

    for (const c of customers) {
      // For recency: invert because lower days = higher score
      // Simplest: rank in descending order of "goodness"
      const rScore = 6 - quintileScore(recencyBase, c.daysSinceLast);  // flipped
      const fScore = quintileScore(frequencyBase, c.orders);
      const mScore = quintileScore(monetaryBase, c.total);
      const segment = assignSegment(rScore, fScore, mScore, c.daysSinceLast);
      segmentCounts[segment] = (segmentCounts[segment] ?? 0) + 1;

      const { error: upErr } = await supabase.from("customer_rfm").upsert({
        email:            c.email,
        first_order_date: c.firstDate,
        last_order_date:  c.lastDate,
        order_count:      c.orders,
        total_spent_ils:  Math.round(c.total * 100) / 100,
        days_since_last:  c.daysSinceLast,
        r_score:          rScore,
        f_score:          fScore,
        m_score:          mScore,
        segment,
        updated_at:       new Date().toISOString(),
      }, { onConflict: "email" });

      if (upErr) {
        console.error(`[rfm-sync] upsert fail ${c.email}: ${upErr.message}`);
      } else {
        upserted++;
      }
    }

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
      const segment = customers.find(x => x.email === c.email) ? assignSegment(
        6 - quintileScore(recencyBase, c.daysSinceLast),
        quintileScore(frequencyBase, c.orders),
        quintileScore(monetaryBase, c.total),
        c.daysSinceLast,
      ) : null;
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
      segment_counts: segmentCounts,
      opted_in_groups: groupSummary,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("[rfm-sync] error:", err?.message);
    return new Response(JSON.stringify({ success: false, error: err?.message ?? "unknown" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
