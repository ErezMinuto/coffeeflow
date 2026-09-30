// ============================================================================
// Artisan profile parser
// ============================================================================
//
// Reads an Artisan (artisan-scope.org) roast file into the shape stored in
// `artisan_profiles`. Pure — no I/O, no Supabase — so it can be unit tested and
// reused by every entry path.
//
// TWO FORMATS, same content:
//   .alog  Artisan's own save — `repr(dict)`, a Python literal (see
//          python_literal.ts). This is the file Artisan writes by default.
//   .json  `File ▸ Export ▸ JSON`, or the Autosave "Save also" option.
//
// Both are `getProfile()` serialised (artisanlib/main.py: `serialize()` at
// L13120/L17192, `exportJSON()` at L14499), and `profile['computed']` is set
// unconditionally — so either file carries the readings:
//
//   CHARGE_ET / CHARGE_BT  — when the beans go in  (טמפ' הטענה)
//   DROP_ET   / DROP_BT    — at drop               (טמפ' סיום)
//
// Everything is normalised to CELSIUS and KILOGRAMS on the way in, so nothing
// downstream ever has to ask which unit a row is in.

import { parsePythonLiteral, PythonLiteralError } from './python_literal.ts';

export class ArtisanParseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArtisanParseError';
    this.code = code;
  }
}

export interface ParsedProfile {
  artisan_uuid: string;
  roasted_at: string;          // ISO, absolute
  beans: string | null;
  title: string | null;
  batch_label: string | null;
  operator: string | null;
  green_kg: number | null;
  roasted_kg: number | null;
  charge_et: number | null;    // all °C
  charge_bt: number | null;
  drop_et: number | null;
  drop_bt: number | null;
  total_time_sec: number | null;
  computed: Record<string, unknown> | null;
  meta: Record<string, unknown>;
}

// Curve arrays. A 17-minute roast at 1Hz is ~50KB of these; the readings we
// actually store live in `computed`. Dropped before the body is kept as `meta`.
const CURVE_KEYS = [
  'timex', 'temp1', 'temp2',
  'delta1', 'delta2',
  'extratimex', 'extratemp1', 'extratemp2',
  'extradelta1', 'extradelta2',
  'extrastemp1', 'extrastemp2',
  'stemp1', 'stemp2',
  'computed', // stored in its own column
];

// weight_units in artisanlib/util.py is ('g','Kg','lb','oz'); 1 lb = 2.20462262185 kg.
const LB_PER_KG = 2.20462262185;

/**
 * Turn the bytes of an Artisan file into a profile object.
 *
 * The extension picks the reader so the error message can be specific; an
 * unfamiliar extension tries JSON first and falls back to the Python literal,
 * since both start with `{`.
 */
export function readArtisanFile(text: string, filename?: string): unknown {
  const ext = (filename ?? '').toLowerCase().split('.').pop();

  const asJson = () => {
    try { return JSON.parse(text); }
    catch (e) {
      throw new ArtisanParseError('bad_json', `not valid JSON: ${(e as Error).message}`);
    }
  };
  const asAlog = () => {
    try { return parsePythonLiteral(text); }
    catch (e) {
      const detail = e instanceof PythonLiteralError ? e.message : String(e);
      throw new ArtisanParseError('bad_alog', `not a readable Artisan .alog: ${detail}`);
    }
  };

  if (ext === 'json') return asJson();
  if (ext === 'alog') return asAlog();

  try { return JSON.parse(text); } catch { /* fall through */ }
  return asAlog();
}

function firstLine(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const line = s.split('\n')[0].trim();
  return line === '' ? null : line;
}

/**
 * A reading Artisan could not compute is either absent or left at its 0.0
 * sentinel. No roast charges or drops at 0°, so both mean "no reading".
 */
function reading(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function toCelsius(v: number | null, mode: string): number | null {
  if (v === null) return null;
  const c = mode === 'F' ? (v - 32) * 5 / 9 : v;
  return Math.round(c * 10) / 10;
}

export function toKg(value: unknown, unit: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  const u = String(unit ?? 'Kg').trim().toLowerCase();
  let kg: number;
  switch (u) {
    case 'g':  kg = n / 1000; break;
    case 'kg': kg = n; break;
    case 'lb': kg = n / LB_PER_KG; break;
    case 'oz': kg = n / (LB_PER_KG * 16); break;
    default:
      throw new ArtisanParseError('bad_weight_unit', `unknown Artisan weight unit "${unit}"`);
  }
  return Math.round(kg * 1000) / 1000;
}

/** Parse an already-read Artisan profile object. */
export function parseProfile(raw: unknown): ParsedProfile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArtisanParseError('not_a_profile', 'expected an Artisan roast profile object');
  }
  const body = raw as Record<string, unknown>;

  const artisanUuid = typeof body.roastUUID === 'string' ? body.roastUUID.trim() : '';
  if (!artisanUuid) {
    throw new ArtisanParseError(
      'missing_uuid',
      'this file has no roastUUID — it does not look like an Artisan roast profile',
    );
  }

  // Absolute instant of CHARGE. roastepoch is seconds since epoch.
  const epoch = Number(body.roastepoch);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    throw new ArtisanParseError('missing_roastepoch', 'this profile has no usable roast date');
  }
  const roastedAt = new Date(epoch * 1000).toISOString();

  const mode = body.mode === 'F' ? 'F' : 'C';
  const computed = (body.computed && typeof body.computed === 'object' && !Array.isArray(body.computed))
    ? body.computed as Record<string, unknown>
    : null;

  // Prefer the computed block; fall back to a top-level key for older exports.
  const pick = (key: string): number | null => reading(computed?.[key] ?? body[key]);

  const weight = Array.isArray(body.weight) ? body.weight : [];
  const weightUnit = weight[2];

  const batchNr = Number(body.roastbatchnr);
  const batchPrefix = typeof body.roastbatchprefix === 'string' ? body.roastbatchprefix : '';
  const batchLabel = Number.isFinite(batchNr) && batchNr > 0 ? `${batchPrefix}${batchNr}` : null;

  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!CURVE_KEYS.includes(k)) meta[k] = v;
  }

  return {
    artisan_uuid: artisanUuid,
    roasted_at: roastedAt,
    beans: firstLine(body.beans),
    title: firstLine(body.title),
    batch_label: batchLabel,
    operator: firstLine(body.operator),
    green_kg: toKg(weight[0], weightUnit),
    roasted_kg: toKg(weight[1], weightUnit),
    charge_et: toCelsius(pick('CHARGE_ET'), mode),
    charge_bt: toCelsius(pick('CHARGE_BT'), mode),
    drop_et: toCelsius(pick('DROP_ET'), mode),
    drop_bt: toCelsius(pick('DROP_BT'), mode),
    total_time_sec: reading(computed?.totaltime ?? computed?.DROP_time),
    computed,
    meta,
  };
}

/** Read and parse in one step — what both callers actually want. */
export function parseArtisanFile(text: string, filename?: string): ParsedProfile {
  return parseProfile(readArtisanFile(text, filename));
}
