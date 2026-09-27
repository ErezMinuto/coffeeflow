// ============================================================================
// Artisan profile parser
// ============================================================================
//
// Turns an Artisan (artisan-scope.org) JSON autosave into the shape stored in
// `artisan_profiles`. Pure — no I/O, no Supabase — so it can be unit tested and
// reused by every entry path.
//
// The format is not guessed. It is `getProfile()` dumped verbatim by
// `exportJSON()` (artisanlib/main.py), which includes
// `profile['computed'] = computedProfileInformation()`. The keys used here are
// declared in artisanlib/atypes.py as ProfileData / ComputedProfileInformation.
//
//   CHARGE_ET / CHARGE_BT  — the readings when the beans go in  (טמפ' הטענה)
//   DROP_ET   / DROP_BT    — the readings at drop               (טמפ' סיום)
//
// Everything is normalised to CELSIUS and KILOGRAMS on the way in, so nothing
// downstream ever has to ask which unit a row is in.
// ============================================================================

/** Filename grammar written by Artisan's Autosave prefix `CF_~date_long_~time_~beans_line`. */
export const FILENAME_RE = /^CF_(\d{4}-\d{2}-\d{2})_(\d{4})_(.*)\.json$/i;

export class ArtisanParseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArtisanParseError';
    this.code = code;
  }
}

export interface FilenameParts {
  date: string;   // yyyy-MM-dd, roastery local, at CHARGE
  hhmm: string;   // hhmm, roastery local, at CHARGE
  beans: string;  // first line of Artisan's Beans field, filename-sanitised
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

// Artisan strips exactly these from filenames (removeDisallowedFilenameChars).
// Spaces and Hebrew survive, so the bean segment can contain both.
const DISALLOWED_FILENAME_CHARS = /[<>:"/\\|?*]/g;

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

export function sanitiseFilenameChars(s: string): string {
  return s.replace(DISALLOWED_FILENAME_CHARS, '');
}

/** Trim, collapse inner whitespace, casefold. Used on both sides of every bean-name comparison. */
export function normaliseBeanName(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function parseFilename(name: string): FilenameParts | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = FILENAME_RE.exec(base);
  if (!m) return null;
  return { date: m[1], hhmm: m[2], beans: m[3] };
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

/**
 * Cross-check the filename against the body.
 *
 * The filename is a convenience, never the source of truth — but if the two
 * disagree, something is misconfigured and we say so loudly rather than
 * storing a row that quietly describes the wrong roast.
 *
 * Date and time are compared against `roastisodate` / `roasttime`, which
 * Artisan already renders in roastery-local time — so no timezone arithmetic,
 * and no dependence on `roasttzoffset` being set.
 */
export function crossCheck(body: Record<string, unknown>, parts: FilenameParts): void {
  const isoDate = typeof body.roastisodate === 'string' ? body.roastisodate : null;
  if (isoDate && isoDate !== parts.date) {
    throw new ArtisanParseError(
      'filename_mismatch',
      `filename says ${parts.date} but the profile was roasted on ${isoDate}`,
    );
  }

  const roastTime = typeof body.roasttime === 'string' ? body.roasttime : null;
  if (roastTime) {
    const hhmm = roastTime.slice(0, 5).replace(':', '');
    if (/^\d{4}$/.test(hhmm) && hhmm !== parts.hhmm) {
      throw new ArtisanParseError(
        'filename_mismatch',
        `filename says ${parts.hhmm} but the profile was roasted at ${roastTime}`,
      );
    }
  }

  // Compare the bean name the way the filesystem saw it.
  const bodyBeans = sanitiseFilenameChars(firstLine(body.beans) ?? '');
  if (normaliseBeanName(bodyBeans) !== normaliseBeanName(parts.beans)) {
    throw new ArtisanParseError(
      'filename_mismatch',
      `filename says beans "${parts.beans}" but the profile says "${bodyBeans}"`,
    );
  }
}

/**
 * Parse an Artisan JSON autosave body.
 *
 * When `filename` follows the CF_ grammar its fields are cross-checked against
 * the body. A filename that does not match the grammar is accepted (manual
 * uploads of a hand-exported file are allowed) but recorded as-is.
 */
export function parseProfile(raw: unknown, filename?: string): ParsedProfile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArtisanParseError('not_a_profile', 'expected an Artisan JSON profile object');
  }
  const body = raw as Record<string, unknown>;

  const artisanUuid = typeof body.roastUUID === 'string' ? body.roastUUID.trim() : '';
  if (!artisanUuid) {
    throw new ArtisanParseError(
      'missing_uuid',
      'profile has no roastUUID — is this an Artisan JSON export? (.alog is not JSON)',
    );
  }

  if (filename) {
    const parts = parseFilename(filename);
    if (parts) crossCheck(body, parts);
  }

  // Absolute instant of CHARGE. roastepoch is seconds since epoch.
  const epoch = Number(body.roastepoch);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    throw new ArtisanParseError('missing_roastepoch', 'profile has no usable roastepoch');
  }
  const roastedAt = new Date(epoch * 1000).toISOString();

  const mode = body.mode === 'F' ? 'F' : 'C';
  const computed = (body.computed && typeof body.computed === 'object' && !Array.isArray(body.computed))
    ? body.computed as Record<string, unknown>
    : null;

  // Prefer the computed block; fall back to a top-level key for older exports.
  const pick = (key: string): number | null =>
    reading(computed?.[key] ?? body[key]);

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
