#!/usr/bin/env -S deno run --allow-read
// ============================================================================
// artisan-preview — read a real Artisan roast file and show what CoffeeFlow
// would record from it. Reads only; writes nothing, touches no database.
// ============================================================================
//
//   deno run --allow-read scripts/artisan-preview.ts <file.alog|file.json>
//
// The point of this is to check the reader against a REAL file from the
// roastery before trusting it. Everything the import does to a roast row is
// derived from the values printed here.

import { readArtisanFile, parseProfile, ArtisanParseError } from '../supabase/functions/_shared/artisan.ts';

const path = Deno.args[0];
if (!path) {
  console.error('usage: deno run --allow-read scripts/artisan-preview.ts <file.alog|file.json>');
  Deno.exit(2);
}

let text: string;
try {
  text = await Deno.readTextFile(path);
} catch (e) {
  console.error(`✗ cannot read ${path}: ${(e as Error).message}`);
  Deno.exit(1);
}

const name = path.split(/[\\/]/).pop() ?? path;
const ext = name.toLowerCase().split('.').pop();
const kb = (text.length / 1024).toFixed(1);

console.log(`\nfile      ${name}`);
console.log(`size      ${kb} KB`);
console.log(`read as   ${ext === 'alog' ? 'Artisan .alog (Python literal)' : ext === 'json' ? 'Artisan JSON' : 'unknown extension — sniffing'}`);

let raw: unknown;
let profile;
try {
  raw = readArtisanFile(text, name);
  profile = parseProfile(raw);
} catch (e) {
  const code = e instanceof ArtisanParseError ? ` [${e.code}]` : '';
  console.error(`\n✗ REFUSED${code}: ${(e as Error).message}`);
  console.error('\nThe import would reject this file with the same message.');
  Deno.exit(1);
}

const body = raw as Record<string, unknown>;
const t = (v: number | null) => (v === null ? '—  (Artisan recorded no reading)' : `${v.toFixed(1)} °C`);
const s = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

console.log(`\n── the roast this file describes ─────────────────────────────`);
console.log(`  Artisan version   ${s(body.version)}`);
console.log(`  roast id (UUID)   ${profile.artisan_uuid}`);
console.log(`  roasted at        ${new Date(profile.roasted_at).toLocaleString()}   (local: ${s(body.roastisodate)} ${s(body.roasttime)})`);
console.log(`  beans             ${s(profile.beans)}`);
console.log(`  title             ${s(profile.title)}`);
console.log(`  batch             ${s(profile.batch_label)}`);
console.log(`  operator          ${s(profile.operator)}`);
console.log(`  machine           ${s(body.roastertype)}`);
console.log(`  temp unit in file ${s(body.mode)}${body.mode === 'F' ? '  → converted to °C below' : ''}`);
console.log(`  weight in file    ${JSON.stringify(body.weight)}  → ${s(profile.green_kg)} kg green, ${s(profile.roasted_kg)} kg roasted`);
console.log(`  total time        ${profile.total_time_sec === null ? '—' : `${Math.floor(profile.total_time_sec / 60)}m ${Math.round(profile.total_time_sec % 60)}s`}`);

console.log(`\n── what would be written to the roast record ─────────────────`);
console.log(`  charge_et   ${t(profile.charge_et)}      ← טמפ' הטענה  (shown in the log)`);
console.log(`  drop_bt     ${t(profile.drop_bt)}      ← טמפ' סיום   (shown in the log)`);
console.log(`  charge_bt   ${t(profile.charge_bt)}`);
console.log(`  drop_et     ${t(profile.drop_et)}`);

console.log(`\n  Nothing else on the roast is touched — not weight, origin,`);
console.log(`  operator, date or batch number.`);

// Cross-check against what Artisan shows on its own screen.
const c = (profile.computed ?? {}) as Record<string, unknown>;
const extras: Array<[string, unknown]> = [
  ['first crack (BT)', c.FCs_BT], ['first crack at', c.FCs_time],
  ['drop at', c.DROP_time], ['development %', c.dtr],
  ['weight loss %', c.weight_loss],
];
const present = extras.filter(([, v]) => v !== undefined && v !== null);
if (present.length) {
  console.log(`\n── also in the file, for cross-checking against Artisan ──────`);
  for (const [label, v] of present) console.log(`  ${label.padEnd(18)}${v}`);
  console.log(`\n  (stored in artisan_profiles.computed, not shown in the log yet)`);
}

const missing = (['charge_et', 'drop_bt'] as const).filter(k => profile[k] === null);
if (missing.length) {
  console.log(`\n⚠  ${missing.join(' and ')} came out empty.`);
  console.log(`   Either Artisan never registered CHARGE/DROP for this roast, or`);
  console.log(`   the reader is looking in the wrong place. Check the numbers`);
  console.log(`   against what Artisan itself shows for this roast before trusting it.`);
} else {
  console.log(`\n✓ Both headline readings found. Compare them with what Artisan`);
  console.log(`  shows for this roast — they should match exactly.`);
}

console.log(`\n  stored profile size: ${(JSON.stringify({ computed: profile.computed, meta: profile.meta }).length / 1024).toFixed(1)} KB` +
            `  (file is ${kb} KB — curve arrays are stripped)\n`);
