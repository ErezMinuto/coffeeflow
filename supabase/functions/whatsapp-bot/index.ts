// Minuto WhatsApp Advisor — Meta WhatsApp Cloud API webhook.
//
// Customers arrive from a click-to-WhatsApp ad for black/Turkish coffee. The
// bot asks about their taste and recommends Minuto roasted coffee from the
// live catalog, using Gemini. CLAUDE.md "Bot Architecture" fixes its scope:
// no packing, stock, schedule or task logic lives here.
//
//   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → handshake
//   POST (Meta-signed)                                            → messages
//
// AUTH. Deployed --no-verify-jwt, so verifyMetaSignature is the only gate.
// Unsigned or wrongly signed POSTs get 401 before anything else runs, and an
// unset WHATSAPP_APP_SECRET refuses everything (fails closed).
//
// SHARED NUMBER (coexistence). The number also runs the WhatsApp Business app
// on the shop's phone, so regulars, suppliers and B2B write to it too. The bot
// therefore answers ONLY ad leads: a chat whose first message carried a
// click-to-WhatsApp `referral` within the last LEAD_DAYS. Other chats are not
// answered and not stored. And the moment a team member replies to a lead
// from the app (an smb_message_echoes webhook), the chat is the human's: the
// bot never replies there again.
//
// TIMING. Meta retries a webhook that does not answer 200 promptly, so the
// handler acknowledges at once and replies in EdgeRuntime.waitUntil. Retries
// that still arrive are dropped by the unique wa_message_id in
// whatsapp_messages: a message is answered at most once.
//
// Secrets (supabase secrets set, never in chat): WHATSAPP_APP_SECRET,
// WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
// GEMINI_API_KEY. Optional: WHATSAPP_MODEL (default gemini-2.5-flash),
// WHATSAPP_TEST_WA_IDS (comma-separated phone numbers treated as ad leads, for
// testing from a staff phone and for Meta's App Review screencast).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { createLogger, type Logger } from '../_shared/logger.ts'
import {
  buildOutboundMessages,
  formatCatalog,
  isOffBrand,
  maskWaId,
  MINUTO_COFFEE_CATEGORIES,
  parseBotReply,
  parseInbound,
  toGeminiContents,
  verifyHandshake,
  verifyMetaSignature,
  parseEchoes,
  parseWaIdList,
  type BotReply,
  type CatalogProduct,
  type EchoMessage,
  type InboundMessage,
  type StoredMessage,
} from './lib.ts'
import { buildSystemPrompt } from './prompt.ts'

const FN = 'whatsapp-bot'

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const APP_SECRET       = Deno.env.get('WHATSAPP_APP_SECRET') ?? ''
const VERIFY_TOKEN     = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? ''
const ACCESS_TOKEN     = Deno.env.get('WHATSAPP_ACCESS_TOKEN') ?? ''
const PHONE_NUMBER_ID  = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? ''
const GEMINI_API_KEY   = Deno.env.get('GEMINI_API_KEY') ?? ''
// Verified against the live model list on 2026-10-17. Ids are not guessable
// from marketing names (see seo-agent/claude.ts), so check before overriding.
const MODEL            = Deno.env.get('WHATSAPP_MODEL')?.trim() || 'gemini-2.5-flash'
// Overridable only so the local end-to-end harness can stand in for Meta.
const GRAPH_BASE       = Deno.env.get('WHATSAPP_GRAPH_BASE') || 'https://graph.facebook.com/v23.0'

const HISTORY_LIMIT    = 30      // messages of context per reply
const HISTORY_DAYS     = 7       // an older conversation starts fresh
const LEAD_DAYS        = 7       // an ad click makes a chat the bot's for this long
// Phones the bot treats as leads without an ad click. Keep it to staff phones.
const TEST_WA_IDS      = parseWaIdList(Deno.env.get('WHATSAPP_TEST_WA_IDS'))
const DAILY_REPLY_CAP  = 40      // per customer; bounds Gemini spend if someone loops the bot

// Customer-facing fallbacks. Gender-inclusive, no em dashes.
const UNSUPPORTED_TYPE_REPLY = 'כרגע אפשר לענות כאן רק על הודעות טקסט. אפשר לכתוב לנו במילים?'
const ERROR_REPLY = 'סליחה, משהו השתבש אצלנו. אפשר לנסות שוב בעוד רגע.'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

Deno.serve(async (req) => {
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const challenge = verifyHandshake(url.searchParams, VERIFY_TOKEN)
    return challenge === null
      ? new Response('forbidden', { status: 403 })
      : new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }

  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  // Raw bytes first: the signature is over exactly what Meta sent.
  const raw = new Uint8Array(await req.arrayBuffer())
  if (!(await verifyMetaSignature(APP_SECRET, req.headers.get('x-hub-signature-256'), raw))) {
    return new Response('invalid signature', { status: 401 })
  }

  let payload: unknown
  try { payload = JSON.parse(new TextDecoder().decode(raw)) }
  catch { return new Response('bad json', { status: 400 }) }

  // Ignore traffic for any other number on the same WhatsApp Business Account.
  const ours = (id: string) => !PHONE_NUMBER_ID || id === PHONE_NUMBER_ID
  const messages = parseInbound(payload).filter(m => ours(m.phoneNumberId))
  const echoes = parseEchoes(payload).filter(e => ours(e.phoneNumberId))
  // Status callbacks, history sync, contact sync, other numbers: nothing to do.
  if (!messages.length && !echoes.length) return json({ ok: true, messages: 0 })

  const log = createLogger(FN)
  const work = handleMessages(messages, echoes, log)
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work)
  else await work   // local `deno run`: no waitUntil, finish before answering
  return json({ ok: true, messages: messages.length, echoes: echoes.length, run_id: log.runId })
})

async function handleMessages(messages: InboundMessage[], echoes: EchoMessage[], log: Logger): Promise<void> {
  try {
    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID || !GEMINI_API_KEY) {
      log.error('config.missing', 'whatsapp-bot is missing secrets', {
        access_token: !!ACCESS_TOKEN, phone_number_id: !!PHONE_NUMBER_ID, gemini: !!GEMINI_API_KEY,
      })
      await log.finish('error')
      return
    }
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE)
    // Echoes first: a team reply in the same batch must silence the bot.
    let takeovers = 0
    for (const e of echoes) {
      if (await handleEcho(sb, e, log)) takeovers++
    }
    let replied = 0
    for (const m of messages) {
      if (await handleOne(sb, m, log)) replied++
    }
    await log.finish('success', { received: messages.length, replied, echoes: echoes.length, takeovers })
  } catch (err) {
    log.error('run.fail', 'unhandled error', {}, err)
    await log.finish('error')
  }
}

/** A team member wrote to a customer from the Business app. If that customer
 *  is a lead, record it: from then on the chat is the human's. Echoes in any
 *  other chat are none of the bot's business and are not stored. Returns true
 *  when this echo took a lead over. */
async function handleEcho(sb: SupabaseClient, e: EchoMessage, log: Logger): Promise<boolean> {
  const who = maskWaId(e.waId)
  const { count, error } = await sb
    .from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .eq('wa_id', e.waId)
  if (error) { log.error('db.echo', 'could not check echo chat', { who }, error); return false }
  if (!count) return false

  // ignoreDuplicates: a message the bot itself sent is already stored under
  // this id, so if Meta ever echoes an API send it cannot trigger a takeover.
  const { data, error: insErr } = await sb
    .from('whatsapp_messages')
    .upsert({
      wa_message_id: e.waMessageId,
      wa_id: e.waId,
      direction: 'human',
      msg_type: e.type,
      body: e.text,
      run_id: log.runId,
    }, { onConflict: 'wa_message_id', ignoreDuplicates: true })
    .select('id')
  if (insErr) { log.error('db.echo', 'could not record team reply', { who }, insErr); return false }
  if (!data?.length) return false
  log.info('chat.takeover', 'team replied from the app, bot is now silent in this chat', { who })
  return true
}

async function isLead(sb: SupabaseClient, waId: string): Promise<boolean> {
  const since = new Date(Date.now() - LEAD_DAYS * 24 * 3600 * 1000).toISOString()
  const { count, error } = await sb
    .from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .eq('wa_id', waId).eq('direction', 'in').not('referral', 'is', null).gte('created_at', since)
  if (error) throw new Error(`lead check: ${error.message}`)
  return (count ?? 0) > 0
}

async function humanOwns(sb: SupabaseClient, waId: string): Promise<boolean> {
  const { count, error } = await sb
    .from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .eq('wa_id', waId).eq('direction', 'human')
  if (error) throw new Error(`takeover check: ${error.message}`)
  return (count ?? 0) > 0
}

/** Returns true when a reply was sent. */
async function handleOne(sb: SupabaseClient, m: InboundMessage, log: Logger): Promise<boolean> {
  const who = maskWaId(m.waId)

  // Shared number: only ad leads are the bot's. Anyone else is left to the
  // team in the app, and their message is not stored.
  if (!m.referral && !TEST_WA_IDS.has(m.waId)) {
    try {
      if (!(await isLead(sb, m.waId))) {
        log.debug('msg.not_lead', 'not an ad lead, leaving it to the team', { who })
        return false
      }
    } catch (err) {
      log.error('db.lead', 'lead check failed, not replying', { who }, err)
      return false
    }
  }

  // Claim the message. The unique index makes this the dedup for Meta retries.
  const { data: claimed, error: claimErr } = await sb
    .from('whatsapp_messages')
    .upsert({
      wa_message_id: m.waMessageId,
      wa_id: m.waId,
      direction: 'in',
      msg_type: m.type,
      body: m.text,
      profile_name: m.profileName,
      referral: m.referral,
      run_id: log.runId,
    }, { onConflict: 'wa_message_id', ignoreDuplicates: true })
    .select('id')
  if (claimErr) {
    log.error('db.claim', 'could not store inbound message', { who }, claimErr)
    return false
  }
  if (!claimed?.length) {
    log.info('msg.duplicate', 'already handled, skipping', { who, wa_message_id: m.waMessageId })
    return false
  }
  log.info('msg.in', 'inbound message', { who, type: m.type, from_ad: !!m.referral })

  if (await humanOwnsSafe(sb, m.waId, log)) return false

  if (!m.text) return await send(sb, m.waId, { text: UNSUPPORTED_TYPE_REPLY, buttons: [] }, log)

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { count } = await sb
    .from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .eq('wa_id', m.waId).eq('direction', 'out').gte('created_at', since)
  if ((count ?? 0) >= DAILY_REPLY_CAP) {
    log.warn('msg.capped', 'daily reply cap reached, not replying', { who, count })
    return false
  }

  let reply: BotReply
  try {
    const [history, catalog] = await Promise.all([loadHistory(sb, m.waId), loadCatalog(sb)])
    reply = await askGemini(buildSystemPrompt(formatCatalog(catalog)), history, log)
  } catch (err) {
    log.error('reply.fail', 'could not generate a reply', { who }, err)
    reply = { text: ERROR_REPLY, buttons: [] }
  }
  // A team member may have jumped in while Gemini was writing.
  if (await humanOwnsSafe(sb, m.waId, log)) return false
  return await send(sb, m.waId, reply, log)
}

/** Fails toward silence: if the check itself errors, the bot does not reply. */
async function humanOwnsSafe(sb: SupabaseClient, waId: string, log: Logger): Promise<boolean> {
  try {
    if (!(await humanOwns(sb, waId))) return false
    log.info('msg.human_owned', 'team has taken this chat, bot stays silent', { who: maskWaId(waId) })
  } catch (err) {
    log.error('db.takeover', 'takeover check failed, not replying', { who: maskWaId(waId) }, err)
  }
  return true
}

async function loadHistory(sb: SupabaseClient, waId: string): Promise<StoredMessage[]> {
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000).toISOString()
  const { data, error } = await sb
    .from('whatsapp_messages')
    .select('direction, body')
    .eq('wa_id', waId)
    .gte('created_at', since)
    .not('body', 'is', null)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error) throw new Error(`history: ${error.message}`)
  return ((data ?? []) as StoredMessage[]).reverse()
}

async function loadCatalog(sb: SupabaseClient): Promise<CatalogProduct[]> {
  const orFilter = MINUTO_COFFEE_CATEGORIES.map(c => `categories.cs.{"${c}"}`).join(',')
  const { data, error } = await sb
    .from('woo_products')
    .select('name, price, permalink, stock_status, short_description, description')
    .or(orFilter)
    .order('name')
  if (error) throw new Error(`catalog: ${error.message}`)
  return ((data ?? []) as CatalogProduct[]).filter(p => !isOffBrand(p.name))
}

async function askGemini(system: string, history: StoredMessage[], log: Logger): Promise<BotReply> {
  const contents = toGeminiContents(history)
  if (!contents.length) throw new Error('empty conversation')
  const generationConfig: Record<string, unknown> = {
    temperature: 0.6,
    maxOutputTokens: 1024,
    // Structured answer: the message plus up to 3 reply-button labels.
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING' },
        buttons: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['text'],
    },
  }
  // 2.5 models think by default and spend the output budget on it; a chat
  // reply needs no thinking and should come back fast.
  if (MODEL.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 }

  const started = Date.now()
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`gemini ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
  const cand = body?.candidates?.[0]
  const text = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim()
  log.info('gemini.done', 'reply generated', {
    model: MODEL, ms: Date.now() - started, finish: cand?.finishReason, usage: body?.usageMetadata,
  })
  if (!text) throw new Error(`gemini returned no text (finish=${cand?.finishReason})`)
  return parseBotReply(text)
}

async function send(sb: SupabaseClient, waId: string, reply: BotReply, log: Logger): Promise<boolean> {
  let sent = false
  for (const msg of buildOutboundMessages(waId, reply)) {
    const res = await fetch(`${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify(msg.body),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      log.error('wa.send', 'Cloud API rejected the reply', { who: maskWaId(waId), status: res.status, error: body?.error })
      return sent
    }
    sent = true
    // The offered buttons are kept in the stored text so the model sees, on
    // the next turn, which options the customer was choosing between.
    const stored = msg.buttons.length ? `${msg.text}\n[כפתורים: ${msg.buttons.join(' | ')}]` : msg.text
    const { error } = await sb.from('whatsapp_messages').insert({
      wa_message_id: body?.messages?.[0]?.id ?? `out-${crypto.randomUUID()}`,
      wa_id: waId,
      direction: 'out',
      msg_type: msg.buttons.length ? 'interactive' : 'text',
      body: stored,
      run_id: log.runId,
    })
    if (error) log.warn('db.out', 'reply sent but not stored', { who: maskWaId(waId) }, error)
  }
  if (sent) log.info('msg.out', 'reply sent', { who: maskWaId(waId), chars: reply.text.length, buttons: reply.buttons.length })
  return sent
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
