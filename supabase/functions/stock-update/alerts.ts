// Owner email for store sales of bags the system did not have.
//
// apply_mflow_sells records one stock_unlogged_alerts row per product per
// Israel day when a store (POS / back-office) sale goes past an empty shelf.
// Bags the store sold must have existed, so someone packed and did not log it.
//
// Rows stay emailed_at = NULL until an email for them actually went out, so a
// Resend outage only delays the alert to the next */15 run, never drops it.
// Later sales of the same coffee on the same day add to the row but do not
// send a second email.

import { sendOwnerEmail } from "../_shared/email.ts";

export interface PendingAlert {
  id: number;
  product_id: number;
  alert_date: string;
  units_unlogged: number;
  sell_ids: number[];
  first_sell_at: string | null;
  last_sell_at: string | null;
  product_name: string;
  product_size: number | null;
  packed_stock_now: number | null;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const ilTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" }) : "?";

export function buildUnloggedEmail(rows: PendingAlert[]): { subject: string; html: string } {
  const bags = rows.reduce((a, r) => a + r.units_unlogged, 0);
  const subject = rows.length === 1
    ? `📦 Store sold ${bags} bag${bags === 1 ? "" : "s"} of ${rows[0].product_name} that were never logged as packed`
    : `📦 Store sold ${bags} bags across ${rows.length} coffees that were never logged as packed`;

  const body = rows.map((r) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee" dir="auto">${esc(r.product_name)}${r.product_size ? ` ${esc(r.product_size)}g` : ""}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center"><b>${esc(r.units_unlogged)}</b></td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(ilTime(r.first_sell_at))}${r.last_sell_at && r.last_sell_at !== r.first_sell_at ? ` to ${esc(ilTime(r.last_sell_at))}` : ""}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px;color:#666">${r.sell_ids.map(esc).join(", ")}</td>
    </tr>`).join("");

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:640px;color:#222">
    <p>The store sold coffee that CoffeeFlow showed as <b>out of packed stock</b>.
    Those bags were on the shelf, so someone packed them and did not log the packing
    (coffee bot or the Packaging page).</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="background:#f6f1eb;text-align:left">
        <th style="padding:6px 10px">Coffee</th>
        <th style="padding:6px 10px;text-align:center">Unlogged bags</th>
        <th style="padding:6px 10px">Sold (Israel time)</th>
        <th style="padding:6px 10px">MFlow doc</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p style="font-size:13px;color:#555">What to do: ask who packed it and log the packing.
    Website orders are not included here: the website never runs out, those bags are
    counted as owed and paid off by the next packing.</p>
    <p style="font-size:12px;color:#888">You get one email per coffee per day. Later sales the same day are added to the record but do not email again.</p>
  </div>`;
  return { subject, html };
}

// deno-lint-ignore no-explicit-any
type Db = any;

/** Email every un-emailed alert row once. Never throws; returns a status for the log. */
export async function sendPendingUnloggedAlerts(supabase: Db): Promise<{ pending: number; status: string }> {
  const { data, error } = await supabase
    .from("stock_unlogged_alerts")
    .select("id, product_id, alert_date, units_unlogged, sell_ids, first_sell_at, last_sell_at, products(name, size, packed_stock)")
    .is("emailed_at", null)
    .order("alert_date", { ascending: true })
    .limit(50);
  if (error) return { pending: 0, status: `read failed: ${error.message}` };
  if (!data?.length) return { pending: 0, status: "none" };

  const rows: PendingAlert[] = data.map((r: any) => ({
    id: Number(r.id), product_id: Number(r.product_id), alert_date: r.alert_date,
    units_unlogged: Number(r.units_unlogged), sell_ids: (r.sell_ids ?? []).map(Number),
    first_sell_at: r.first_sell_at, last_sell_at: r.last_sell_at,
    product_name: r.products?.name ?? `product #${r.product_id}`,
    product_size: r.products?.size ?? null, packed_stock_now: r.products?.packed_stock ?? null,
  }));

  const { subject, html } = buildUnloggedEmail(rows);
  const status = await sendOwnerEmail({ subject, html, fromName: "CoffeeFlow Stock" });
  if (!status.startsWith("sent")) return { pending: rows.length, status };

  const { error: upErr } = await supabase
    .from("stock_unlogged_alerts")
    .update({ emailed_at: new Date().toISOString() })
    .in("id", rows.map((r) => r.id));
  return { pending: rows.length, status: upErr ? `${status}; mark failed: ${upErr.message}` : status };
}
