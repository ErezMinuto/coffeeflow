import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  buildOutboundMessages,
  formatCatalog,
  hmacSha256Hex,
  maskWaId,
  parseEchoes,
  parseBotReply,
  parseInbound,
  sanitizeButtons,
  parseWaIdList,
  splitForWhatsApp,
  toGeminiContents,
  verifyHandshake,
  verifyMetaSignature,
} from './lib.ts'

const enc = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>

Deno.test('signature: accepts Meta-style sha256= header over the raw body', async () => {
  const body = enc('{"object":"whatsapp_business_account"}')
  const sig = await hmacSha256Hex('app-secret', body)
  assert(await verifyMetaSignature('app-secret', `sha256=${sig}`, body))
  assert(await verifyMetaSignature('app-secret', `sha256=${sig.toUpperCase()}`, body))
})

Deno.test('signature: rejects missing, malformed, wrong-secret and tampered', async () => {
  const body = enc('{"a":1}')
  const sig = await hmacSha256Hex('app-secret', body)
  assertEquals(await verifyMetaSignature('app-secret', null, body), false)
  assertEquals(await verifyMetaSignature('app-secret', sig, body), false)              // no sha256= prefix
  assertEquals(await verifyMetaSignature('other-secret', `sha256=${sig}`, body), false)
  assertEquals(await verifyMetaSignature('app-secret', `sha256=${sig}`, enc('{"a":2}')), false)
  assertEquals(await verifyMetaSignature('', `sha256=${sig}`, body), false)           // unset secret fails closed
})

Deno.test('handshake: echoes challenge only for the right token', () => {
  const ok = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '123' })
  assertEquals(verifyHandshake(ok, 'tok'), '123')
  assertEquals(verifyHandshake(ok, 'other'), null)
  assertEquals(verifyHandshake(ok, ''), null)
  const badMode = new URLSearchParams({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1' })
  assertEquals(verifyHandshake(badMode, 'tok'), null)
})

const sample = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '972500000000', phone_number_id: 'PNID' },
        contacts: [{ profile: { name: 'Dana' }, wa_id: '972541234567' }],
        messages: [
          {
            from: '972541234567', id: 'wamid.1', timestamp: '1760000000', type: 'text',
            text: { body: '  שלום, אני מחפש/ת קפה טורקי  ' },
            referral: { source_id: 'AD123', source_type: 'ad', headline: 'קפה שחור' },
          },
          { from: '972541234567', id: 'wamid.2', type: 'interactive', interactive: { button_reply: { id: 'b', title: 'מריר' } } },
          { from: '972541234567', id: 'wamid.3', type: 'image', image: { id: 'm' } },
        ],
      },
    }],
  }],
}

Deno.test('parseInbound: text, button reply, media, referral', () => {
  const msgs = parseInbound(sample)
  assertEquals(msgs.length, 3)
  assertEquals(msgs[0].text, 'שלום, אני מחפש/ת קפה טורקי')
  assertEquals(msgs[0].profileName, 'Dana')
  assertEquals(msgs[0].phoneNumberId, 'PNID')
  assertEquals((msgs[0].referral as any).source_id, 'AD123')
  assertEquals(msgs[1].text, 'מריר')
  assertEquals(msgs[2].text, null)
  assertEquals(msgs[2].type, 'image')
})

Deno.test('parseInbound: status callbacks and foreign payloads yield nothing', () => {
  const statuses = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] }] }
  assertEquals(parseInbound(statuses), [])
  assertEquals(parseInbound({ object: 'page', entry: [] }), [])
  assertEquals(parseInbound(null), [])
})

Deno.test('toGeminiContents: merges same-side runs and starts on a user turn', () => {
  const c = toGeminiContents([
    { direction: 'out', body: 'greeting' },
    { direction: 'in', body: 'a' },
    { direction: 'in', body: 'b' },
    { direction: 'out', body: 'c' },
    { direction: 'in', body: 'd' },
  ])
  assertEquals(c.map(x => x.role), ['user', 'model', 'user'])
  assertEquals(c[0].parts[0].text, 'a\nb')
})

Deno.test('formatCatalog: drops off-brand and out-of-stock, keeps facts only from the row', () => {
  const out = formatCatalog([
    { name: 'אתיופיה סידמו', price: '72', permalink: 'https://minuto.co.il/p/1', stock_status: 'instock', short_description: 'תווים של יסמין', description: null },
    { name: 'קפה ירוק קולומביה', price: '60', permalink: null, stock_status: 'instock', short_description: null, description: null },
    { name: 'Veneto Espresso', price: '50', permalink: null, stock_status: 'instock', short_description: null, description: null },
    { name: 'ברזיל', price: '65', permalink: null, stock_status: 'outofstock', short_description: null, description: null },
    { name: 'תערובת הבית', price: '68', permalink: null, stock_status: 'instock', short_description: null, description: null },
  ])
  assert(out.includes('אתיופיה סידמו'))
  assert(out.includes('תווים של יסמין'))
  assert(!out.includes('ירוק'))
  assert(!out.includes('Veneto'))
  assert(!out.includes('ברזיל'))
  assert(out.includes('אל תמציאו'))   // undescribed product carries the no-invention marker
})

Deno.test('splitForWhatsApp: respects the 4096 limit and loses nothing', () => {
  assertEquals(splitForWhatsApp('short'), ['short'])
  assertEquals(splitForWhatsApp('   '), [])
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
  const parts = splitForWhatsApp(long)
  assert(parts.length > 1)
  assert(parts.every(p => p.length <= 4096))
  assertEquals(parts.join('\n').replace(/\s+/g, ''), long.replace(/\s+/g, ''))
})

Deno.test('maskWaId keeps only the last four digits', () => {
  assertEquals(maskWaId('972541234567'), '********4567')
})

Deno.test('parseEchoes: team replies from the Business app, other fields ignored', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'W', changes: [
      { field: 'smb_message_echoes', value: {
        metadata: { phone_number_id: 'PNID' },
        message_echoes: [
          { from: '972500000000', to: '972541234567', id: 'wamid.e1', timestamp: '1', type: 'text', text: { body: 'היי, כאן ארז' } },
          { from: '972500000000', to: '972541234567', id: 'wamid.e2', type: 'image', image: { id: 'm' } },
        ],
      } },
      { field: 'messages', value: { metadata: { phone_number_id: 'PNID' }, messages: [{ from: '1', id: 'x', type: 'text', text: { body: 'hi' } }] } },
      { field: 'history', value: { history: [] } },
    ] }],
  }
  const e = parseEchoes(payload)
  assertEquals(e.length, 2)
  assertEquals(e[0].waId, '972541234567')
  assertEquals(e[0].text, 'היי, כאן ארז')
  assertEquals(e[1].text, null)
  assertEquals(parseInbound(payload).length, 1)   // echoes never look like customer messages
})

Deno.test('parseWaIdList: normalises formatting, drops junk', () => {
  const s = parseWaIdList(' +972-54-123 4567 , 972500000000,, 123 ')
  assertEquals([...s].sort(), ['972500000000', '972541234567'])
  assertEquals(parseWaIdList(undefined).size, 0)
})

Deno.test('parseBotReply: JSON with buttons, plain-text fallback', () => {
  const r = parseBotReply('{"text":"איזה טעם?","buttons":["חזק ושוקולדי","מתקתק ואגוזי","פירותי וקליל"]}')
  assertEquals(r.text, 'איזה טעם?')
  assertEquals(r.buttons.length, 3)
  assertEquals(parseBotReply('שלום').buttons, [])
  assertEquals(parseBotReply('שלום').text, 'שלום')
  assertEquals(parseBotReply('{"buttons":["x"]}').buttons, [])   // no text → treated as plain text
})

Deno.test('sanitizeButtons: max 3, max 20 chars, unique, non-empty', () => {
  const b = sanitizeButtons(['a', ' a ', '', 'x'.repeat(30), 'c', 'd', 5])
  assertEquals(b, ['a', 'x'.repeat(20), 'c'])
  assertEquals(sanitizeButtons('nope'), [])
})

Deno.test('buildOutboundMessages: interactive when buttons fit, text otherwise', () => {
  const [m] = buildOutboundMessages('972541234567', { text: 'איך מכינים?', buttons: ['פינג׳אן', 'בוץ'] })
  assertEquals((m.body as any).type, 'interactive')
  assertEquals((m.body as any).interactive.action.buttons[1].reply, { id: 'opt2', title: 'בוץ' })
  const [t] = buildOutboundMessages('972541234567', { text: 'המלצה', buttons: [] })
  assertEquals((t.body as any).type, 'text')
  // Body over the 1024 interactive limit: buttons dropped, text still sent.
  const long = buildOutboundMessages('1', { text: 'x '.repeat(700), buttons: ['a'] })
  assert(long.every(x => (x.body as any).type === 'text'))
})

Deno.test('parseBotReply: link only if it is a catalog permalink (encoded or decoded)', () => {
  const enc = 'https://www.minuto.co.il/product/%d7%a4%d7%95%d7%9c%d7%99-sertao/'
  const ok = parseBotReply(JSON.stringify({ text: 'הבחירה: Sertão\nאפשר להזמין בכפתור למטה', link: 'https://minuto.co.il/product/פולי-sertao' }), [enc])
  assertEquals(ok.link, enc)
  assertEquals(ok.rejectedLink, undefined)
  const bad = parseBotReply(JSON.stringify({ text: 'x', link: 'https://minuto.co.il/product/made-up' }), [enc])
  assertEquals(bad.link, null)
  assertEquals(bad.rejectedLink, 'https://minuto.co.il/product/made-up')
  // URL echoed inside the text is removed when it goes out as a button.
  const inText = parseBotReply(JSON.stringify({ text: `כאן: ${enc}`, link: enc }), [enc])
  assert(!inText.text.includes('minuto.co.il'))
})

Deno.test('buildOutboundMessages: link → cta_url button, buttons suppressed', () => {
  const [m] = buildOutboundMessages('1', { text: 'הבחירה: Sertão', buttons: ['a'], link: 'https://minuto.co.il/p/x' })
  const b = m.body as any
  assertEquals(b.interactive.type, 'cta_url')
  assertEquals(b.interactive.action.parameters, { display_text: 'להזמנה באתר', url: 'https://minuto.co.il/p/x' })
  assert('להזמנה באתר'.length <= 20)
  // Too long for an interactive body: the link is appended as text instead.
  const long = buildOutboundMessages('1', { text: 'x '.repeat(700), buttons: [], link: 'https://minuto.co.il/p/x' })
  assert(long.at(-1)!.text.endsWith('https://minuto.co.il/p/x'))
})
