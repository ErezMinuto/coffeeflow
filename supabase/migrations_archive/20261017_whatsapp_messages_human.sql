-- whatsapp_messages: allow direction = 'human'.
--
-- The WhatsApp number is shared with the Business app on the shop's phone
-- (Meta "coexistence"). When a team member replies to an ad lead from the app,
-- Meta sends an smb_message_echoes webhook and whatsapp-bot stores it as a
-- 'human' row. Any 'human' row in a chat means the team owns it and the bot
-- stays silent there for good.
--
-- Additive: widens a CHECK constraint, no data changes. Apply BEFORE the
-- function that writes 'human' is deployed, or takeovers fail to record (the
-- bot then keeps replying in chats a person has taken).

ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_direction_check;
ALTER TABLE whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_direction_check CHECK (direction IN ('in', 'out', 'human'));
