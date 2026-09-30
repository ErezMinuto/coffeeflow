// Tests for python_literal.ts — the .alog reader.
//
//   deno run --allow-read supabase/functions/_shared/python_literal_test.ts
//
// The bulk of this is a DIFFERENTIAL test: testdata/python_repr_cases.jsonl
// pairs real `repr()` output from python3 with the JSON-equivalent value, so
// the parser is checked against Python itself rather than against fixtures I
// wrote by hand and could have got wrong in the same direction twice.
//
// Regenerate the corpus with the python3 heredoc recorded in this file's git
// history (commit that added testdata/python_repr_cases.jsonl).
import { parsePythonLiteral, PythonLiteralError } from './python_literal.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}
function throws(name: string, fn: () => unknown) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, e instanceof PythonLiteralError, `threw ${e}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── differential against python3's own repr() ───────────────────────────────
{
  const path = new URL('./testdata/python_repr_cases.jsonl', import.meta.url);
  const lines = Deno.readTextFileSync(path).trim().split('\n');
  check('corpus loaded', lines.length >= 20, `${lines.length} cases`);

  let mismatches = 0;
  for (const line of lines) {
    const { repr, json } = JSON.parse(line) as { repr: string; json: unknown };
    let got: unknown;
    try { got = parsePythonLiteral(repr); }
    catch (e) { console.log(`   ↳ threw on ${repr.slice(0, 60)}: ${e}`); mismatches++; continue; }
    if (!eq(got, json)) {
      console.log(`   ↳ ${repr.slice(0, 70)}\n     want ${JSON.stringify(json)}\n     got  ${JSON.stringify(got)}`);
      mismatches++;
    }
  }
  check(`all ${lines.length} python repr cases round-trip`, mismatches === 0, `${mismatches} mismatched`);
}

// ── the cases that break a regex approach ───────────────────────────────────
{
  // repr switches to double quotes when the string contains an apostrophe.
  const a = parsePythonLiteral(`{'beans': "אתיופיה יירגצ'ף"}`) as Record<string, string>;
  check('apostrophe inside a double-quoted string', a.beans === "אתיופיה יירגצ'ף", a.beans);

  // …and escapes it when it does not.
  const b = parsePythonLiteral(`{'beans': 'Yirga\\'cheffe'}`) as Record<string, string>;
  check("escaped \\' inside a single-quoted string", b.beans === "Yirga'cheffe", b.beans);

  // A quote character must not end the string when it is the other kind.
  const c = parsePythonLiteral(`{'x': 'has " inside', 'y': 2}`) as Record<string, unknown>;
  check('unescaped double quote inside single quotes', c.x === 'has " inside' && c.y === 2);

  // Braces and brackets inside strings must not be treated as structure.
  const d = parsePythonLiteral(`{'note': 'a {dict} and [list] and (tuple)', 'n': 1}`) as Record<string, unknown>;
  check('structural characters inside a string', d.note === 'a {dict} and [list] and (tuple)' && d.n === 1);

  // The literal text True/False/None inside a string stays text.
  const e = parsePythonLiteral(`{'note': 'True means None', 'v': True}`) as Record<string, unknown>;
  check('keyword text inside a string is not converted', e.note === 'True means None' && e.v === true);

  // A trailing backslash before the closing quote.
  const f = parsePythonLiteral(`{'p': 'ends\\\\'}`) as Record<string, string>;
  check('string ending in an escaped backslash', f.p === 'ends\\', JSON.stringify(f.p));
}

// ── Python scalars JSON cannot express ──────────────────────────────────────
{
  const v = parsePythonLiteral(`{'a': inf, 'b': -inf, 'c': nan}`) as Record<string, number>;
  check('inf', v.a === Infinity);
  check('-inf', v.b === -Infinity);
  check('nan', Number.isNaN(v.c));
}

// ── shapes ──────────────────────────────────────────────────────────────────
{
  check('tuples become arrays', eq(parsePythonLiteral('(1, 2, 3)'), [1, 2, 3]));
  check('single-element tuple', eq(parsePythonLiteral('(42,)'), [42]));
  check('trailing comma in a list', eq(parsePythonLiteral('[1, 2, 3,]'), [1, 2, 3]));
  check('trailing comma in a dict', eq(parsePythonLiteral(`{'a': 1,}`), { a: 1 }));
  check('empty containers', eq(parsePythonLiteral(`{'a': [], 'b': {}, 'c': ()}`), { a: [], b: {}, c: [] }));
  check('whitespace and newlines are ignored', eq(parsePythonLiteral(`{\n  'a' :  1 ,\n  'b': 2\n}`), { a: 1, b: 2 }));
  check('int dict keys become strings', eq(parsePythonLiteral(`{1: 'a', 2: 'b'}`), { '1': 'a', '2': 'b' }));
  check('bytes literal is read as text', parsePythonLiteral(`b'abc'`) === 'abc');
  check('escape sequences', parsePythonLiteral(`'a\\nb\\tc\\x41\\u00e9'`) === 'a\nb\tc\Aé');
}

// ── a realistic .alog head ──────────────────────────────────────────────────
{
  const alog = `{'version': '3.4.0', 'roastUUID': 'a1b2c3d4', 'mode': 'C', ` +
    `'roastisodate': '2026-09-27', 'roasttime': '14:32:07', 'roastepoch': 1790778727, ` +
    `'beans': "אתיופיה יירגצ'ף", 'weight': [15.0, 12.6, 'Kg'], 'roastbatchnr': 1042, ` +
    `'timex': [0.0, 1.0, 2.0], 'temp1': [195.0, 194.2, 193.1], 'temp2': [92.4, 93.0, 94.2], ` +
    `'computed': {'CHARGE_ET': 195.0, 'CHARGE_BT': 92.4, 'DROP_ET': 210.5, 'DROP_BT': 208.3, ` +
    `'totaltime': 1020.0, 'weight_loss': 16.0}, 'flags': [True, False, None]}`;
  const p = parsePythonLiteral(alog) as Record<string, any>;
  check('realistic .alog parses', p.roastUUID === 'a1b2c3d4');
  check('  bean name with apostrophe survives', p.beans === "אתיופיה יירגצ'ף", p.beans);
  check('  charge ET readable', p.computed.CHARGE_ET === 195.0);
  check('  drop BT readable', p.computed.DROP_BT === 208.3);
  check('  weight tuple/list', eq(p.weight, [15.0, 12.6, 'Kg']));
  check('  booleans and None', eq(p.flags, [true, false, null]));
}

// ── refuse rather than guess ────────────────────────────────────────────────
{
  throws('a set literal is refused', () => parsePythonLiteral(`{1, 2, 3}`));
  throws('an unterminated string is refused', () => parsePythonLiteral(`{'a': 'oops}`));
  throws('an unclosed dict is refused', () => parsePythonLiteral(`{'a': 1`));
  throws('trailing junk is refused', () => parsePythonLiteral(`{'a': 1} garbage`));
  throws('a bare name is refused', () => parsePythonLiteral(`{'a': undefined_name}`));
  throws('an expression is refused', () => parsePythonLiteral(`{'a': 1 + 2}`));
  throws('empty input is refused', () => parsePythonLiteral(``));
  // JSON happens to be valid Python-ish, but a .json file goes through JSON.parse.
  check('JSON-shaped input still parses', eq(parsePythonLiteral(`{"a": 1}`), { a: 1 }));
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
if (failures > 0) Deno.exit(1);
