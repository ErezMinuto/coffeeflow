// ============================================================================
// Python literal parser
// ============================================================================
//
// Artisan saves a roast as `repr(dict)` and reads it back with
// `ast.literal_eval` (artisanlib/util.py serialize/deserialize). That is what a
// `.alog` file is — a Python literal, not JSON:
//
//   {'roastUUID': 'a1b2…', 'beans': "אתיופיה יירגצ'ף", 'mode': 'C',
//    'roastbatchnr': 1042, 'weight': [15.0, 12.6, 'Kg'], 'computed': {…}}
//
// Single quotes, True/False/None, tuples, and escapes. A regex substitution
// ("swap the quotes, replace True") mangles any string containing an apostrophe
// — which is most Hebrew bean names — so this is a real tokenizer instead.
//
// Deliberately only the literal subset `repr` can emit. No names, no operators,
// no comments, no function calls: anything else is an error rather than a guess.

export class PythonLiteralError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(`${message} (at character ${position})`);
    this.name = 'PythonLiteralError';
    this.position = position;
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '\\': '\\', "'": "'", '"': '"', '\n': '',   // backslash-newline is a line continuation
  n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v', '0': '\0',
};

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): unknown {
    this.ws();
    const value = this.value();
    this.ws();
    if (this.i < this.s.length) {
      throw new PythonLiteralError(`unexpected trailing content ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`, this.i);
    }
    return value;
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private at(text: string): boolean {
    return this.s.startsWith(text, this.i);
  }

  private value(): unknown {
    if (this.i >= this.s.length) throw new PythonLiteralError('unexpected end of input', this.i);
    const c = this.s[this.i];

    if (c === '{') return this.mapping();
    if (c === '[') return this.sequence('[', ']');
    if (c === '(') return this.sequence('(', ')');
    if (c === "'" || c === '"') return this.string();

    // b'…' — Artisan profiles have no bytes fields, but repr can emit them.
    if ((c === 'b' || c === 'B') && (this.s[this.i + 1] === "'" || this.s[this.i + 1] === '"')) {
      this.i++;
      return this.string();
    }

    if (this.at('True'))  { this.i += 4; return true; }
    if (this.at('False')) { this.i += 5; return false; }
    if (this.at('None'))  { this.i += 4; return null; }

    return this.number();
  }

  private string(): string {
    const quote = this.s[this.i++];
    let out = '';

    while (true) {
      if (this.i >= this.s.length) throw new PythonLiteralError('unterminated string', this.i);
      const c = this.s[this.i];

      if (c === quote) { this.i++; return out; }

      if (c !== '\\') { out += c; this.i++; continue; }

      // escape sequence
      this.i++;
      const e = this.s[this.i];
      if (e === undefined) throw new PythonLiteralError('unterminated escape', this.i);

      if (e === 'x' || e === 'u' || e === 'U') {
        const width = e === 'x' ? 2 : e === 'u' ? 4 : 8;
        const hex = this.s.slice(this.i + 1, this.i + 1 + width);
        if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new PythonLiteralError(`bad \\${e} escape`, this.i);
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        this.i += 1 + width;
        continue;
      }

      if (e in SIMPLE_ESCAPES) { out += SIMPLE_ESCAPES[e]; this.i++; continue; }

      // Python leaves an unknown escape as a literal backslash + character.
      out += '\\' + e;
      this.i++;
    }
  }

  private sequence(open: string, close: string): unknown[] {
    if (this.s[this.i] !== open) throw new PythonLiteralError(`expected ${open}`, this.i);
    this.i++;
    const out: unknown[] = [];

    this.ws();
    if (this.s[this.i] === close) { this.i++; return out; }

    while (true) {
      this.ws();
      out.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); if (this.s[this.i] === close) { this.i++; return out; } continue; }
      if (c === close) { this.i++; return out; }
      throw new PythonLiteralError(`expected ',' or '${close}'`, this.i);
    }
  }

  /** `{...}` is a dict in every Artisan profile; a set literal is refused rather than guessed at. */
  private mapping(): Record<string, unknown> {
    this.i++; // {
    const out: Record<string, unknown> = {};

    this.ws();
    if (this.s[this.i] === '}') { this.i++; return out; }

    while (true) {
      this.ws();
      const keyAt = this.i;
      const key = this.value();
      this.ws();

      if (this.s[this.i] !== ':') {
        throw new PythonLiteralError('expected \':\' — set literals are not supported', keyAt);
      }
      this.i++;

      this.ws();
      // Python dict keys can be non-string (Artisan uses ints in a few places);
      // JS object keys are strings anyway, so coerce the way JS would.
      out[typeof key === 'string' ? key : String(key)] = this.value();
      this.ws();

      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); if (this.s[this.i] === '}') { this.i++; return out; } continue; }
      if (c === '}') { this.i++; return out; }
      throw new PythonLiteralError('expected \',\' or \'}\'', this.i);
    }
  }

  private number(): number {
    const start = this.i;

    let sign = 1;
    if (this.s[this.i] === '-') { sign = -1; this.i++; }
    else if (this.s[this.i] === '+') { this.i++; }

    // repr(float('inf')) is 'inf'; repr(float('nan')) is 'nan'.
    if (this.at('inf')) { this.i += 3; return sign * Infinity; }
    if (this.at('nan')) { this.i += 3; return NaN; }

    const rest = this.s.slice(this.i);
    const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(rest);
    if (!m) {
      throw new PythonLiteralError(`expected a value, found ${JSON.stringify(this.s.slice(start, start + 20))}`, start);
    }
    this.i += m[1].length;

    const n = Number(m[1]);
    if (!Number.isFinite(n) && !Number.isNaN(n)) {
      throw new PythonLiteralError(`number out of range: ${m[1]}`, start);
    }
    return sign * n;
  }
}

/** Parse the Python literal subset that `repr()` emits. Tuples become arrays. */
export function parsePythonLiteral(src: string): unknown {
  return new Parser(src).parse();
}
