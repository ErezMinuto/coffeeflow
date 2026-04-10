# Inbound Unsubscribe (Gmail Apps Script)

This document explains how to set up automatic unsubscribe-by-reply for the
`info@minuto.co.il` inbox. When a recipient replies to a Minuto marketing
email with exactly `הסר` (in the subject OR as the first line of the body),
this poller will:

1. Call the `generate-campaign` edge function's `inbound-unsubscribe` action
2. Which PATCHes the contact to `unsubscribed: true` in Resend (source of truth)
3. Mirrors `opted_in = false` in `marketing_contacts`
4. Marks the Gmail message as read so it's not processed again

No Cloud Console setup, no service account, no IMAP credentials — everything
runs inside the Google Workspace account that owns the inbox.

---

## Setup (one-time, ~5 minutes)

### 1. Create the Supabase shared secret

Generate a random string (≥ 32 chars) and store it as an edge function env var:

```bash
# pick any strong random value
SECRET="$(openssl rand -hex 32)"

# set it on the prod project
/opt/homebrew/bin/supabase secrets set \
  --project-ref ytydgldyeygpzmlxvpvb \
  INBOUND_UNSUBSCRIBE_SECRET="$SECRET"
```

Keep `$SECRET` handy — you'll paste it into the Apps Script in step 3.

### 2. Open Google Apps Script

Sign in to the same Google account that owns `info@minuto.co.il`, then open
https://script.google.com/ and click **New project**.

Rename the project to `Minuto Unsubscribe Poller` (top-left).

### 3. Paste the script

Replace the default `Code.gs` contents with the script below. Replace
`PASTE_YOUR_SECRET_HERE` with the value of `$SECRET` from step 1.

```javascript
// ─── Config ─────────────────────────────────────────────────────────────────
const WEBHOOK_URL = 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/generate-campaign';
const SHARED_SECRET = 'PASTE_YOUR_SECRET_HERE';
const TRIGGER_WORD = 'הסר';
const MAX_THREADS_PER_RUN = 50;
// Safety rail: never unsubscribe these addresses even if they reply with הסר
const NEVER_UNSUBSCRIBE = ['info@minuto.co.il'];

// ─── Main entry point (called by the time-based trigger) ───────────────────
function pollUnsubscribeInbox() {
  // Search unread messages in the inbox that contain the trigger word.
  // Gmail's search operator handles Hebrew.
  const query = 'is:unread in:inbox "' + TRIGGER_WORD + '"';
  const threads = GmailApp.search(query, 0, MAX_THREADS_PER_RUN);

  let processed = 0;
  let skipped = 0;

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const msg of messages) {
      if (!msg.isUnread()) continue;

      const subject = (msg.getSubject() || '').trim();
      const plainBody = (msg.getPlainBody() || '').trim();
      // First non-empty, non-quoted line of the body
      const firstLine = firstNonEmptyLine(plainBody);

      const isExactMatch =
        subject === TRIGGER_WORD ||
        firstLine === TRIGGER_WORD;

      if (!isExactMatch) { skipped++; continue; }

      const senderEmail = extractEmail(msg.getFrom() || '');
      if (!senderEmail) { skipped++; continue; }
      if (NEVER_UNSUBSCRIBE.indexOf(senderEmail.toLowerCase()) !== -1) {
        msg.markRead();
        skipped++;
        continue;
      }

      const ok = postUnsubscribe(senderEmail);
      if (ok) {
        msg.markRead();
        processed++;
      } else {
        // leave unread so the next run can retry
      }
    }
  }

  Logger.log('pollUnsubscribeInbox done: processed=' + processed + ' skipped=' + skipped);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function firstNonEmptyLine(body) {
  if (!body) return '';
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip blank lines and Gmail's quoted-reply lines ("> ...") / "On ... wrote:"
    if (!trimmed) continue;
    if (trimmed.charAt(0) === '>') continue;
    if (/^On .+wrote:$/.test(trimmed)) continue;
    if (/^ב־.+ כתב/.test(trimmed)) continue; // Hebrew "on X wrote"
    return trimmed;
  }
  return '';
}

function extractEmail(fromHeader) {
  // "Name <email@example.com>" or just "email@example.com"
  const match = fromHeader.match(/<([^>]+)>/);
  const candidate = (match ? match[1] : fromHeader).trim().toLowerCase();
  return candidate.indexOf('@') !== -1 ? candidate : null;
}

function postUnsubscribe(email) {
  try {
    const res = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        action: 'inbound-unsubscribe',
        email: email,
        secret: SHARED_SECRET,
      }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return true;
    Logger.log('Webhook non-2xx for ' + email + ': ' + code + ' ' + res.getContentText().slice(0, 200));
    return false;
  } catch (e) {
    Logger.log('Webhook threw for ' + email + ': ' + e.message);
    return false;
  }
}

// Optional: run this once by hand to verify the script can read mail and
// reach the webhook without actually unsubscribing anyone. It just logs.
function dryRun() {
  const query = 'is:unread in:inbox "' + TRIGGER_WORD + '"';
  const threads = GmailApp.search(query, 0, MAX_THREADS_PER_RUN);
  Logger.log('Found ' + threads.length + ' matching threads');
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      Logger.log('subject=' + msg.getSubject() + ' from=' + msg.getFrom() + ' firstLine=' + firstNonEmptyLine(msg.getPlainBody()));
    }
  }
}
```

### 4. Authorize the script

Click **Save** (💾), then in the dropdown next to ▶ **Run**, select
`dryRun` and click **Run**. Google will prompt you to grant the script
access to Gmail (`GmailApp`) and external URLs (`UrlFetchApp`). Approve
both. After approval the `dryRun` log should list any unread messages
that contain `הסר` without touching them.

### 5. Install the time trigger

In the left sidebar click the clock icon (**Triggers**) → **Add Trigger**:

- **Choose which function to run:** `pollUnsubscribeInbox`
- **Choose which deployment should run:** `Head`
- **Select event source:** `Time-driven`
- **Select type of time-based trigger:** `Minutes timer`
- **Select minute interval:** `Every 5 minutes`
- **Failure notification:** `Notify me immediately`

Click **Save**. Done.

---

## Testing

1. Reply to any marketing email with the single word `הסר` in the body
2. Wait up to 5 minutes
3. Check the Apps Script **Executions** tab — you should see
   `pollUnsubscribeInbox done: processed=1 skipped=0`
4. Verify the contact shows as unsubscribed in the Resend dashboard
5. Verify `marketing_contacts.opted_in = false` for that address

## Troubleshooting

- **`401 Invalid secret`** — `SHARED_SECRET` in the script doesn't match
  `INBOUND_UNSUBSCRIBE_SECRET` in Supabase.
- **`500 Server not configured`** — the Supabase env var is missing. Run
  step 1 again.
- **Messages aren't matched** — the sender might have signature/quoted
  text as the first line. Check `dryRun` log; expand the match rule in
  `firstNonEmptyLine` if needed.
- **Contact not found in Resend audience** — the inbound webhook still
  runs, and `handleInboundUnsubscribe` will fall through to the
  `marketing_contacts` mirror but log the Resend miss. Usually this means
  the sender never signed up through Resend in the first place.
