-- whatsapp_messages: every message the WhatsApp advisor (whatsapp-bot) received
-- or sent. It is the conversation memory the model reads back, the dedup for
-- Meta's webhook retries (unique wa_message_id), and the attribution record
-- for click-to-WhatsApp ads (referral on a customer's first message).
--
-- PRIVACY. Rows hold customers' phone numbers and what they wrote. Unlike the
-- org-wide business tables, this one is NOT readable with the anon key (which
-- ships in the dashboard bundle): RLS on with no policies, and the table
-- grants are revoked, so only the service role (the edge function) touches it.
-- A dashboard view, if wanted later, goes through an admin-gated RPC.
--
-- Additive only. Apply before the function's first real message; until then
-- the function logs db.claim errors and sends nothing.

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wa_message_id text        NOT NULL UNIQUE,   -- Meta's wamid; outbound ids come from the send response
  wa_id         text        NOT NULL,          -- customer's WhatsApp id (phone number)
  direction     text        NOT NULL CHECK (direction IN ('in', 'out')),
  msg_type      text        NOT NULL,          -- text, button, interactive, image, …
  body          text,                          -- NULL for media we do not read
  profile_name  text,
  referral      jsonb,                         -- click-to-WhatsApp ad that started the chat
  run_id        uuid,                          -- system_logs correlation
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_wa_id_created_idx
  ON whatsapp_messages (wa_id, created_at DESC);

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_messages FROM anon, authenticated;
