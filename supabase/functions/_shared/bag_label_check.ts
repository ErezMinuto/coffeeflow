// Letter-by-letter check of the text on a rendered bag label.
//
// The vision critic reads the whole image and sometimes waves through a label
// that is one letter off ("Daye 8ensa", "Daye Benso", "Gafé Roestery"). This
// check asks a vision model only to TRANSCRIBE the label as drawn, then
// compares the transcription with what the real bag prints, in code.
//
// It flags only a near miss: text that is close to an expected name but not
// equal to it. Expected text that is absent (cropped, turned away, too small
// or blurred to read) is never a failure, so a small or soft bag cannot make
// the QA loop retry forever.

export const LABEL_TRANSCRIBE_PROMPT = `You transcribe the text printed on a coffee bag in a photo, exactly as it appears, for a spell-check.

Find the coffee bag. Copy each line of LARGE, sharp text on its front (brand wordmark, the line under it, the product name) letter by letter, exactly as drawn, INCLUDING any mistakes: wrong letters, digits in place of letters, missing or extra letters, odd symbols. Never correct or complete a word, never write what the text "should" say.

Skip text you cannot read with confidence because it is small, blurred, out of focus, cut off or at a steep angle. Skip fine print.

Output STRICT JSON only:
{"bag_visible": true|false, "lines": ["each legible line exactly as drawn"]}`

export interface LabelTranscript {
  bag_visible: boolean
  lines:       string[]
}

export interface LabelCheck {
  ok:          boolean
  misspelled:  Array<{ expected: string; found: string }>
}

// Lowercase, strip accents (Café → cafe), turn everything but letters and
// digits into single spaces. Digits stay, so "8ensa" never equals "bensa".
export function normalizeLabelText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return prev[b.length]
}

// Near miss = within about a third of the expected length, but not equal.
// "daye bensa" (10 chars) allows up to 3 edits; "minuto" (6) allows 2.
function maxEdits(expected: string): number {
  return Math.max(1, Math.floor(expected.length / 3))
}

export function checkLabelText(transcript: LabelTranscript, expected: string[]): LabelCheck {
  if (!transcript.bag_visible) return { ok: true, misspelled: [] }
  const lines = transcript.lines.map(normalizeLabelText).filter(Boolean)
  const misspelled: LabelCheck['misspelled'] = []
  for (const exp of expected) {
    const want = normalizeLabelText(exp)
    if (!want) continue
    const n = want.split(' ').length
    // Every run of n consecutive words, on each line, is a candidate.
    const windows = lines.flatMap(line => {
      const w = line.split(' ')
      return w.length < n ? [line] : w.slice(0, w.length - n + 1).map((_, i) => w.slice(i, i + n).join(' '))
    })
    if (windows.some(c => c === want)) continue
    let best: { found: string; d: number } | null = null
    for (const c of windows) {
      const d = levenshtein(c, want)
      if (d > 0 && d <= maxEdits(want) && (!best || d < best.d)) best = { found: c, d }
    }
    if (best) misspelled.push({ expected: exp, found: best.found })
  }
  return { ok: misspelled.length === 0, misspelled }
}
