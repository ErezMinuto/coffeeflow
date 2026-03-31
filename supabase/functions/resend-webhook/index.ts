/**
 * Resend Webhook Handler
 * Receives email events from Resend (opens, clicks, bounces, etc.)
 * and stores them in campaign_events table + updates campaign stats.
 *
 * Register this URL in Resend dashboard:
 *   https://<project>.supabase.co/functions/v1/resend-webhook
 *
 * Events handled: email.sent, email.delivered, email.opened,
 *   email.clicked, email.bounced, email.complained
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

// Map ALL Resend event types to our stored types
const EVENT_MAP: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delayed",
  "email.failed": "failed",
  "email.scheduled": "scheduled",
  "email.suppressed": "suppressed",
  "email.received": "received",
  // Contact events (from Resend's audience/contacts feature)
  "contact.created": "contact_created",
  "contact.updated": "contact_updated",
  "contact.deleted": "contact_deleted",
  // Domain events
  "domain.created": "domain_created",
  "domain.updated": "domain_updated",
  "domain.deleted": "domain_deleted",
};

// Which events increment which campaign counter
const STAT_COLUMN: Record<string, string> = {
  opened: "open_count",
  clicked: "click_count",
  bounced: "bounce_count",
};

serve(async (req) => {
  // Allow any origin for webhooks (Resend POSTs directly)
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    console.log("Resend webhook:", payload.type, JSON.stringify(payload.data?.email_id || "").slice(0, 50));

    const eventType = EVENT_MAP[payload.type];
    if (!eventType) {
      console.log("Ignoring unhandled event type:", payload.type);
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = payload.data || {};
    const resendEmailId = data.email_id || data.id || null;
    const recipientEmail = Array.isArray(data.to) ? data.to[0] : (data.to || "");

    if (!resendEmailId) {
      console.log("No email_id in payload, skipping");
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Look up the original send event to find campaign_id and user_id
    const { data: sendEvent } = await supabase
      .from("campaign_events")
      .select("campaign_id, user_id")
      .eq("resend_email_id", resendEmailId)
      .eq("event_type", "sent")
      .limit(1)
      .single();

    const campaignId = sendEvent?.campaign_id || null;
    const userId = sendEvent?.user_id || "unknown";

    // 2. Dedup check — don't insert duplicate events
    if (eventType !== "sent") {
      const { data: existing } = await supabase
        .from("campaign_events")
        .select("id")
        .eq("resend_email_id", resendEmailId)
        .eq("event_type", eventType)
        .limit(1);

      if (existing && existing.length > 0) {
        console.log("Duplicate event, skipping:", resendEmailId, eventType);
        return new Response(JSON.stringify({ ok: true, duplicate: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 3. Build event data (extra info depending on event type)
    const eventData: Record<string, unknown> = {};
    if (eventType === "clicked" && data.click?.link) {
      eventData.link = data.click.link;
    }
    if (eventType === "bounced" && data.bounce) {
      eventData.bounce_type = data.bounce.type;
      eventData.bounce_message = data.bounce.message;
    }
    if (eventType === "complained") {
      eventData.complaint = true;
    }

    // 4. Insert event
    const { error: insertErr } = await supabase
      .from("campaign_events")
      .insert({
        user_id: userId,
        campaign_id: campaignId,
        resend_email_id: resendEmailId,
        event_type: eventType,
        recipient_email: recipientEmail,
        event_data: Object.keys(eventData).length > 0 ? eventData : null,
      });

    if (insertErr) {
      console.error("Insert error:", insertErr.message);
    }

    // 5. Update campaign aggregate stats
    const statCol = STAT_COLUMN[eventType];
    if (statCol && campaignId) {
      // Fetch current value and increment
      const { data: campaign } = await supabase
        .from("campaigns")
        .select(statCol)
        .eq("id", campaignId)
        .single();

      if (campaign) {
        await supabase
          .from("campaigns")
          .update({ [statCol]: (campaign[statCol] || 0) + 1 })
          .eq("id", campaignId);
      }
    }

    // 6. Auto-unsubscribe on complaint
    if (eventType === "complained" && recipientEmail) {
      console.log("Auto-unsubscribing complained email:", recipientEmail);
      await supabase
        .from("marketing_contacts")
        .update({ opted_in: false, updated_at: new Date().toISOString() })
        .eq("email", recipientEmail.toLowerCase().trim());
    }

    // 7. Auto-unsubscribe on hard bounce
    if (eventType === "bounced" && recipientEmail) {
      const bounceType = data.bounce?.type || "";
      if (bounceType === "hard" || bounceType === "permanent") {
        console.log("Auto-unsubscribing hard-bounced email:", recipientEmail);
        await supabase
          .from("marketing_contacts")
          .update({ opted_in: false, updated_at: new Date().toISOString() })
          .eq("email", recipientEmail.toLowerCase().trim());
      }
    }

    return new Response(JSON.stringify({ ok: true, event: eventType }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("Webhook error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
