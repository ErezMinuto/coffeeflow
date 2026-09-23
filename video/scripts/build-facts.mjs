#!/usr/bin/env node
// build-facts.mjs — turn one WooCommerce product into ProductReel props.
//
// Deterministic facts (price, weight, roast, image) come straight from the public
// WooCommerce Store API. Wording facts (titles, tasting notes, farm/producer/process)
// are extracted by Claude, then VERIFIED: any string that does not appear verbatim
// in the product text is dropped. The reel may be sparser, but it never invents a fact.
//
// Usage:
//   node scripts/build-facts.mjs --woo-id 82540 [--badge "מהדורה מוגבלת"] [--format reel|story] [--out facts.json]
// Env:
//   ANTHROPIC_API_KEY   optional; without it, notes/origin are left empty
//   WOO_STORE_URL       default https://www.minuto.co.il
//   BRIEF_FACTS         optional JSON of human-confirmed props; these win over extraction

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import {betaZodOutputFormat} from '@anthropic-ai/sdk/helpers/beta/zod';
import {z} from 'zod';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const wooId = Number(args['woo-id']);
const outPath = args.out ?? 'facts.json';
const storeUrl = (process.env.WOO_STORE_URL ?? 'https://www.minuto.co.il').replace(/\/$/, '');

const fail = (msg, code = 1) => {
  console.error(`build-facts: ${msg}`);
  process.exit(code);
};

const decode = (s = '') =>
  s.replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const norm = (s = '') => decode(s).replace(/[׳']/g, "'").toLowerCase();
const appearsIn = (needle, haystack) => !!needle && norm(haystack).includes(norm(needle));

async function fetchProduct(id) {
  const res = await fetch(`${storeUrl}/wp-json/wc/store/v1/products/${id}`);
  if (!res.ok) fail(`WooCommerce Store API ${res.status} for product ${id}`);
  return res.json();
}

const attr = (product, name) => product.attributes?.find((a) => a.name === name)?.terms?.[0]?.name;

const Extracted = z.object({
  title_en: z.string().describe('English coffee name exactly as written in the product name, without the word Minuto or roastery suffixes'),
  subtitle_en: z.string().nullable().describe('Optional second English line, e.g. a process word, copied from the name'),
  title_he: z.string().nullable().describe('Hebrew name of the coffee copied from the text, or null'),
  notes: z.array(z.string()).describe('Up to 3 short Hebrew tasting-note phrases (2-3 words each) copied word for word from the text'),
  farm: z.string().nullable(),
  producer: z.string().nullable(),
  process: z.string().nullable().describe('Processing method copied word for word, Hebrew preferred'),
});

async function extract(name, text) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('build-facts: ANTHROPIC_API_KEY not set; skipping extraction');
    return null;
  }
  const client = new Anthropic();
  const response = await client.beta.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 4000,
    output_config: {effort: 'low', format: betaZodOutputFormat(Extracted)},
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system:
      'You extract facts for a coffee product video. Copy every value word for word from the product text you are given. ' +
      'If a fact is not stated, return null or leave it out. Never paraphrase, translate, or add facts.',
    messages: [{role: 'user', content: `Product name:\n${name}\n\nProduct text:\n${text}`}],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    console.error(`build-facts: extraction returned no output (stop_reason=${response.stop_reason})`);
    return null;
  }
  return response.parsed_output;
}

if (!Number.isInteger(wooId) || wooId <= 0) fail('--woo-id is required');

const product = await fetchProduct(wooId);
const name = decode(product.name);
const text = [decode(product.short_description), decode(product.description)].join('\n');

// Brand rule: reels are for roasted specialty beans only.
const categories = (product.categories ?? []).map((c) => decode(c.name));
if (!categories.some((c) => c.includes('פולי קפה'))) fail(`product ${wooId} is not a coffee-beans product (${categories.join(', ')})`, 2);

const minor = product.prices?.currency_minor_unit ?? 0;
const price = Math.round(Number(product.prices?.price) / 10 ** minor);
const grams = Number.parseInt(attr(product, 'כמות') ?? '', 10) || null;
const roast = attr(product, 'רמת קלייה');
const imageUrl = product.images?.[0]?.src;
if (!price || !imageUrl) fail(`product ${wooId} is missing a price or image`);

const x = await extract(name, text);
const keep = (value, source) => (appearsIn(value, source) ? value : null);
const dropped = [];
const verified = (value, source, label) => {
  const v = keep(value, source);
  if (value && !v) dropped.push(`${label}: ${value}`);
  return v;
};

const latinFallback = name.match(/[A-Za-z][A-Za-z\s]+[A-Za-z]/)?.[0] ?? name;
const facts = {
  titleEn: verified(x?.title_en, name, 'title_en') ?? latinFallback,
  subtitleEn: verified(x?.subtitle_en, name, 'subtitle_en'),
  titleHe: verified(x?.title_he, `${name}\n${text}`, 'title_he'),
  notes: (x?.notes ?? []).map((n) => verified(n, text, 'note')).filter(Boolean).slice(0, 3),
  detailLine: roast ? `קלייה ${roast}` : null,
  originRows: [
    ['חווה', verified(x?.farm, text, 'farm')],
    ['מגדל', verified(x?.producer, text, 'producer')],
    ['עיבוד', verified(x?.process, text, 'process')],
  ].filter(([, v]) => v).map(([label, value]) => ({label, value})),
  price,
  grams,
  imageUrl,
  badge: args.badge ?? null,
  format: args.format === 'story' ? 'story' : 'reel',
  source: {wooId, permalink: product.permalink, builtAt: new Date().toISOString()},
};

// Human-confirmed values from the dashboard form override anything extracted.
if (process.env.BRIEF_FACTS) Object.assign(facts, JSON.parse(process.env.BRIEF_FACTS));

if (dropped.length) console.error(`build-facts: dropped unverifiable values -> ${dropped.join(' | ')}`);
fs.writeFileSync(outPath, JSON.stringify(facts, null, 2));
console.error(`build-facts: wrote ${outPath} for "${facts.titleEn}" (${facts.notes.length} notes, ${facts.originRows.length} origin rows)`);
