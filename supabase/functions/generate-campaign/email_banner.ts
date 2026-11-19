// Designed hero banners for campaign emails.
//
// Owner, 2026-11-18/19: photoreal scenes with bags placed in a setting (#79,
// #80) are "not design"; a code-built layout with a pasted bag cut-out was "a
// really bad image". The banner he liked (his own test on Gemini) was ONE
// coherent image: an airy wide banner, bags rendered in the scene, a calm area
// for the type. So a banner is made like that:
//
//   1. Concept: the art director (Claude Opus 5.5) writes the idea for THIS
//      campaign and the image prompt for the whole banner, which side holds the
//      type, which 1-2 bags. Gemini 3.1 Pro scores the concept against an
//      expert-designer bar; a weak one goes back with the critique once.
//   2. Image: Nano Banana Pro renders the full 21:9 banner with the bags' shop product
//      images from the shop as references (so the bags sit in the scene's light and
//      perspective; pasted cut-outs read as stickers, memory
//      ig_visual_architecture) and the type side left calm and empty. Two
//      candidates in parallel.
//   3. Checks per candidate: a label transcription (Gemini 3.1 Pro writes
//      down each bag's text; code checks the lockup letter by letter) and a
//      Gemini 3.1 Pro check (type side empty, no
//      letters outside the bag labels, bags sealed and upright, nothing
//      floating, beans roasted) gate it; a design question ranks the rest.
//   4. Type in code: the approved Hebrew (offer line or headline, optionally
//      the kicker) is set in Heebo, RTL, in the empty side, in dark or light
//      ink by that area's measured brightness. Image models garble Hebrew, so
//      they never draw a letter.
//   5. Final QA on the finished banner (text exact and legible); a failure
//      buys a smaller type size, then the next candidate.
//
// It runs in the background after the draft is saved (render-draft), so the
// chat's 150 s request idle timeout never applies to it.

import { initWasm, Resvg } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { callClaude } from "../seo-agent/claude.ts";
import { AD_MODEL, AD_CRITIC_MODEL, criticUserMessage, parseCritic } from "../_shared/art_director.ts";
import { fetchRef, isTrustedImageUrl } from "./scene_image.ts";

const IMAGE_MODEL = "gemini-3-pro-image";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
export const BANNER_VERSION = "email-banner-v2";
export const BANNER_BUDGET_MS = 330_000;   // background task; wall clock is 400 s
export const CONCEPT_PASS_SCORE = 7;
export const CANDIDATES = 2;

export const W = 1400, H = 600;           // 21:9, shown 520-600 px wide in the email
export const TEXT_ZONE = 0.42;            // share of the width kept empty for the type

export interface BannerCopy { subject: string; headline: string; kicker: string; offerTitle: string; offerText: string; preheader: string; body: string }
export interface BannerProduct { woo_id: number | string; short: string; description: string; image_url: string; jar: boolean }

export type Line = "kicker" | "offer" | "headline";
export function lineText(copy: BannerCopy, l: Line | "none"): string {
  return l === "kicker" ? copy.kicker : l === "offer" ? copy.offerTitle : l === "headline" ? copy.headline : "";
}

export interface Concept {
  idea: string;
  why: string;
  text_side: "left" | "right" | "overlay";
  title: Line;               // the big bold line
  support: Line | "none";    // the smaller line beneath it
  type: TypeSpec;
  bags: string[];
  prompt: string;
  alt: string;
}

// Hebrew typefaces from Google Fonts the art director may pair (all carry Hebrew).
export const TYPEFACES: Record<string, { style: string; weights: number[] }> = {
  "Frank Ruhl Libre": { style: "classic Hebrew serif, elegant", weights: [300, 500, 700, 900] },
  "Bellefair": { style: "refined high-contrast serif", weights: [400] },
  "David Libre": { style: "traditional book serif", weights: [400, 500, 700] },
  "Suez One": { style: "bold display serif", weights: [400] },
  "Secular One": { style: "bold rounded display sans", weights: [400] },
  "Heebo": { style: "clean modern sans", weights: [100, 300, 400, 700, 800] },
  "IBM Plex Sans Hebrew": { style: "precise modern sans, beautiful in thin weights", weights: [100, 200, 300, 500, 700] },
  "Assistant": { style: "light humanist sans", weights: [300, 400, 700] },
  "Rubik": { style: "soft geometric sans", weights: [300, 500, 700] },
  "Karantina": { style: "tall condensed display sans", weights: [300, 700] },
};
export const INKS: Record<string, string> = { ink: "#26301D", olive: "#3C4A2C", gold: "#9C7A3C", white: "#FFFFFF", lime: "#DCE79A" };

export interface TypeSpec { title_font: string; title_weight: number; support_font: string; support_weight: number; color: string; accent: "gold_rule" | "lime_rule" | "none"; align: "center" | "right"; tracking: number }
export const TRACKING: Record<string, number> = { tight: 0, normal: 0.02, wide: 0.12, extra_wide: 0.3 };

export const CONCEPT_SYSTEM = `You are the art director and lead designer of Minuto's campaign emails. Minuto is a specialty coffee roastery and espresso bar in Rehovot, Israel ("מינוטו קפה בית קלייה ספיישלטי"). For each campaign email you design the hero banner: a wide 21:9 key visual that carries one idea for this specific campaign. An image model (Nano Banana Pro) renders your prompt as one complete image, with photos of the real Minuto bags as references; the email's approved Hebrew text is then set in code in the area you leave empty.

The owner's verdicts so far (data). The liked banners show the QUALITY he wants, never a template: he does not want to see the same banner again. Every campaign gets a new idea, and a composition, palette, background treatment and type pairing different from the liked banners and from the recent banners listed with the brief.
- Rejected, 2026-11-17: four bags in a row on a black stone tile with scattered beans ("amateur").
- Rejected, 2026-11-18: two bags and a cup on a sunlit cream counter against a plain wall ("lame", a packaging mockup).
- Rejected, 2026-11-19: one bag beside an espresso on a dark bar counter under cinematic light ("taking bags and putting them on something isn't called design").
- Rejected, 2026-11-19: a hard two-colour split panel with a cut-out bag pasted across the seam ("a really bad image").
- Liked, 2026-11-19 (his own test): an airy, minimalist wide banner: very soft pastel sage-green and off-white background with a watercolour wash and a fine gold line, two white Minuto bags standing upright on one side in soft daylight, one coffee leaf and a few beans, a large calm area for the type on the other side; bright, sophisticated, clean.
- Liked, 2026-11-19 (a designer's banner he showed): a real lifestyle photograph (a person holding two Minuto bags in front of them outdoors, cropped at the chest) under a dark wash, with huge, thin, monoline lime Hebrew letters, very widely letter-spaced, set across the whole image over the photo in three lines. The typography is the design.
- Liked, 2026-11-19 (his own test): a flat, front-facing studio banner: light warm-grey background with a soft glowing gradient, two white Minuto bags in the centre on a pristine modern round podium with a thin gold ring, minimal gold accents and a few beans, subtle lighting, generous negative space, a bold title with a smaller line under it on one side.
- "Perfect", 2026-11-19 (draft #81, made by this pipeline): one confident black sumi-ink brushstroke sweeping across warm off-white handmade paper with flecks of gold leaf, two white Minuto bags standing upright in front of it, three beans; the type on the calm left side in a bold classic Hebrew serif, right-aligned, with a fine gold rule and a light sans offer line beneath. An idea (the "black" of Black Friday as a crafted art gesture), not a diagram and not bags placed on a surface.
- In the banners he liked, the type is a large display title with a smaller, lighter supporting line beneath it.
- Rejected, 2026-11-19: four watercolour circles with the fourth drawn in gold, then four dishes of beans with the fourth one gold, beside the bags: a literal diagram of the offer ("infographic"); the type was one heavy sans weight with no typographic craft ("the font is bad").

How the banner is built (fixed):
- Canvas 21:9, shown 520-600 px wide in the email and 375 px on phones, under the email's deep olive (#2F3B25) header with lime (#C9D77E) accents.
- Text placement: "left" or "right" keeps that side as calm, empty background over about ${Math.round(TEXT_ZONE * 100)}% of the width, with the bags and scene in the rest; "overlay" lets the image fill the frame under a dark wash, with the type set large across the middle over it. Code sets the email's approved words there: a big bold "title" line and an optional smaller "support" line beneath it, each one of the email's kicker, offer title or headline. You never write banner text.
- Bags: 1 or 2 of the email's products, rendered from their shop product images: white Minuto bags, sealed, standing upright with the front label facing the camera, fully visible, each at least half the image height. They are the only bags or packaging in the image. The image model keeps labels readable only that way; smaller, extra, held-at-an-angle or tilted bags come out with garbled labels and are rejected.
- Nothing in the image has letters, numbers or logos apart from the printed bag labels.

The owner's own words for what he wants (2026-11-19): "elegant, clean and creative thinking", with "real designer skills".

The bar: an expert designer's campaign key visual: one clear idea a viewer gets in one glance, belonging to THIS campaign's offer and subject, composed as one piece with the type area, and distinct from the rejected work. The image evokes the campaign's feeling; it does not diagram the offer's numbers (the words carry the numbers). The typography is chosen like a designer chooses it: a typeface pairing, weights, contrast of size and weight between title and support, alignment and colour that suit this image.

Typography you choose (set in code, Hebrew):
- Typefaces: ${Object.entries(TYPEFACES).map(([f, w]) => `${f} (${w.style}; weights ${w.weights.join("/")})`).join("; ")}.
- Colours: ${Object.entries(INKS).map(([k, v]) => `${k} ${v}`).join(", ")}. Accent: a fine gold rule, a fine lime rule, or none, under the title.
- Alignment: centred or right-aligned (overlay type is centred). Letter-spacing: tight, normal, wide or extra_wide.

Write the image prompt (80-180 words) as one flowing description of the whole banner: the background and its colours, where the bags stand and how they are lit, the few props, the light, the mood and style. Describe only what should be in the image, all positively; do not use the words "no", "not", "never", "without" or "avoid".

Reply with JSON only:
{"concepts": ["three genuinely different one-line ideas"], "choice": 0, "idea": "the chosen idea, one sentence", "why": "one sentence", "text_side": "left" | "right" | "overlay", "title": "kicker" | "offer" | "headline", "support": "kicker" | "offer" | "headline" | "none", "type": {"title_font": "<typeface>", "title_weight": <number>, "support_font": "<typeface>", "support_weight": <number>, "color": "${Object.keys(INKS).join('" | "')}", "accent": "gold_rule" | "lime_rule" | "none", "align": "center" | "right", "tracking": "tight" | "normal" | "wide" | "extra_wide"}, "bags": ["product name as listed"], "prompt": "...", "alt": "Hebrew alt text: what the banner shows plus its text"}`;

export const CONCEPT_CRITIC_SYSTEM = `You are an executive creative director reviewing a junior art director's concept for a premium specialty coffee roastery's campaign email banner, before it is produced. You are given the owner's verdicts on earlier banners; his own words for what he wants are "elegant, clean and creative thinking". Score the concept 1-10 as a key visual for THIS campaign: 10 = an expert designer's concept the owner would approve; 6 or less = generic, a product placed in a setting, a stock coffee image, an idea that does not carry the offer, close to the rejected work, or a repeat of any earlier banner (liked or recent) in idea, background treatment, composition or type pairing; the owner wants something new every time. Reply with JSON only: {"score": 1-10, "critique": "what is weak and what the concept must achieve instead, as requirements, with no replacement idea"}`;

export function conceptUserMessage(copy: BannerCopy, products: BannerProduct[], recent: string[], artNote: string): string {
  return [
    "THE EMAIL'S PRODUCTS (bags you may show; JAR = special edition, never shown as a bag):",
    ...products.map((p) => `- ${p.short}${p.jar ? " (JAR)" : ""}: ${p.description.slice(0, 180) || "(no description)"}`),
    "", "RECENT BANNERS (newest first; their idea, background, layout and typography; this banner must differ in all of them):",
    recent.length ? recent.map((s) => `- ${s}`).join("\n") : "- (none yet)",
    ...(artNote ? ["", `THE OWNER'S NOTE FOR THIS BANNER: ${artNote}`] : []),
    "", "THE APPROVED EMAIL:",
    `subject: ${copy.subject}`,
    `kicker: ${copy.kicker || "(none)"}`,
    `headline: ${copy.headline || "(none)"}`,
    `offer title: ${copy.offerTitle || "(none)"}`,
    copy.offerText ? `offer text: ${copy.offerText}` : "",
    copy.preheader ? `preheader: ${copy.preheader}` : "",
    `body: ${copy.body.slice(0, 1200)}`,
  ].filter(Boolean).join("\n");
}

const NEGATION = /\b(no|not|never|without|avoid)\b/i;

export function parseConcept(text: string, products: BannerProduct[], copy: BannerCopy):
  { ok: true; value: Concept; warnings: string[] } | { ok: false; errors: string[] } {
  let d: Record<string, unknown>;
  try {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    d = JSON.parse(text.slice(s, e + 1));
  } catch {
    return { ok: false, errors: ["the reply was not valid JSON"] };
  }
  const errors: string[] = [], warnings: string[] = [];
  const side = d.text_side === "left" || d.text_side === "right" || d.text_side === "overlay" ? d.text_side : null;
  if (!side) errors.push('text_side must be "left", "right" or "overlay"');
  const LINES = ["kicker", "offer", "headline"];
  const title = LINES.includes(String(d.title)) ? d.title as Line : null;
  const support = LINES.includes(String(d.support)) ? d.support as Line : d.support === "none" || d.support == null ? "none" : null;
  if (!title) errors.push('title must be "kicker", "offer" or "headline"');
  else if (!lineText(copy, title)) errors.push(`this email has no ${title}; pick another title`);
  if (!support) errors.push('support must be "kicker", "offer", "headline" or "none"');
  else if (support !== "none" && !lineText(copy, support)) errors.push(`this email has no ${support}; pick another support line or "none"`);
  if (title && support === title) errors.push("title and support must be different lines");
  const t = (d.type && typeof d.type === "object" ? d.type : {}) as Record<string, unknown>;
  const tf = String(t.title_font ?? ""), sf = String(t.support_font ?? "");
  const tw = Number(t.title_weight), sw = Number(t.support_weight);
  if (!TYPEFACES[tf]) errors.push(`type.title_font must be one of ${Object.keys(TYPEFACES).join(", ")}`);
  else if (!TYPEFACES[tf].weights.includes(tw)) errors.push(`type.title_weight for ${tf} must be one of ${TYPEFACES[tf].weights.join(", ")}`);
  if (!TYPEFACES[sf]) errors.push(`type.support_font must be one of ${Object.keys(TYPEFACES).join(", ")}`);
  else if (!TYPEFACES[sf].weights.includes(sw)) errors.push(`type.support_weight for ${sf} must be one of ${TYPEFACES[sf].weights.join(", ")}`);
  const color = String(t.color ?? "");
  if (!INKS[color]) errors.push(`type.color must be one of ${Object.keys(INKS).join(", ")}`);
  const accent = t.accent === "gold_rule" || t.accent === "lime_rule" ? t.accent : "none";
  const align = t.align === "right" && side !== "overlay" ? "right" : "center";
  const tracking = TRACKING[String(t.tracking ?? "normal")] ?? TRACKING.normal;
  const names = products.filter((p) => !p.jar).map((p) => p.short);
  const bags = Array.isArray(d.bags) ? [...new Set(d.bags.map((b) => String(b).trim()).filter(Boolean))] : [];
  if (bags.length < 1 || bags.length > 2) errors.push("bags must hold 1 or 2 product names");
  for (const b of bags) if (!names.includes(b)) errors.push(`bag "${b}" is not one of the email's bag products (${names.join(", ")})`);
  const idea = String(d.idea ?? "").trim();
  if (!idea) errors.push("idea is missing");
  const prompt = String(d.prompt ?? "").trim();
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words < 40) errors.push(`prompt has ${words} words; write 80-180`);
  if (words > 260) errors.push(`prompt has ${words} words; keep it under 180`);
  if (NEGATION.test(prompt)) warnings.push(`prompt uses a negation word ("${prompt.match(NEGATION)![0]}")`);
  const alt = String(d.alt ?? "").trim();
  if (!alt) errors.push("alt is missing");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true, warnings,
    value: { idea, why: String(d.why ?? "").trim(), text_side: side!, title: title!, support: support!,
      type: { title_font: tf, title_weight: tw, support_font: sf, support_weight: sw, color, accent, align, tracking }, bags, prompt, alt: alt.slice(0, 300) },
  };
}

/** What code adds to the art director's prompt: the bags' rules and the empty type side. */
export function renderRules(c: Concept, bagNames: string[]): string {
  const side = c.text_side, other = side === "left" ? "right" : "left";
  const bagRule = `Show ${bagNames.length === 1 ? "the reference bag" : `each of the ${bagNames.length} reference bags`} exactly once (${bagNames.join(", ")}), sealed, upright with its front label facing the camera, fully visible, with its exact shape, stag logo, "MINUTO Café Roastery" wordmark and label artwork from its reference. ${bagNames.length === 1 ? "It is the only bag" : "They are the only bags"} or packaging in the image. Each bag is large in the frame, at least half the image height, so its label reads clearly.`;
  if (side === "overlay") {
    return `${bagRule} The scene fills the whole frame; it will sit under a dark wash with large headline typography set across the middle, so its composition stays simple with the bags clearly readable. The image carries no letters, words, numbers or logos anywhere except the printed bag labels. Coffee beans, when shown, are roasted medium brown. Wide 21:9 banner.`;
  }
  return `${bagRule} The bags and every prop sit in the ${other} ${100 - Math.round(TEXT_ZONE * 100)}% of the frame. The background, its colours, washes and light continue seamlessly across the whole frame, edge to edge, as one continuous surface; the ${side} ${Math.round(TEXT_ZONE * 100)}% of the frame simply holds nothing but that same background, calm and uncluttered, because headline typography is added there afterwards. The image carries no letters, words, numbers or logos anywhere except the printed bag labels. Coffee beans, when shown, are roasted medium brown. Wide 21:9 banner.`;
}

// Labels: transcribe, then compare in code. The shared yes/no label check
// (also used by Instagram) passed "Actdo" for Aristo and "Café Noostery" in a
// test render, so the email banner asks the stronger model to write down what
// each bag actually says and checks the lockup letter by letter here.
export function labelTranscribePrompt(names: string[]): string {
  return `The first images are the real reference coffee bags (${names.join(", ")}). The last image is a generated banner.
For EVERY coffee bag visible in the generated banner, left to right, read the large wordmark, the small line under it, and the product name on the label one letter at a time, exactly as rendered. Image generators often get single letters wrong, so do not assume the intended word: spell each line letter by letter first, then write the word from those letters. Then say whether that bag's product name and label artwork match one of the reference bags.
Reply with JSON only: {"bags": [{"wordmark_letters": "M-I-N-U-T-O", "wordmark": "...", "subline_letters": "...", "subline": "...", "name_letters": "...", "name": "...", "matches_reference": true | false, "sealed_upright": true | false}]}`;
}

const norm = (t: unknown) => String(t ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

/** Code verdict on the transcription: right count, exact lockup, names match references. */
export function judgeLabels(text: string, expected: number): { pass: boolean; issues: string[] } {
  let bags: Array<Record<string, unknown>> = [];
  try {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    const j = JSON.parse(text.slice(s, e + 1));
    bags = Array.isArray(j?.bags) ? j.bags : [];
  } catch { return { pass: false, issues: ["label transcription unreadable"] }; }
  const issues: string[] = [];
  if (bags.length !== expected) issues.push(`expected ${expected} bag(s), saw ${bags.length}`);
  bags.forEach((b, i) => {
    if (norm(b.wordmark) !== "MINUTO") issues.push(`bag ${i + 1} wordmark reads "${norm(b.wordmark)}"`);
    if (!/^caf[ée] roastery$/i.test(norm(b.subline))) issues.push(`bag ${i + 1} line under the wordmark reads "${norm(b.subline)}"`);
    if (b.matches_reference !== true) issues.push(`bag ${i + 1} label "${norm(b.name)}" does not match its reference`);
    if (b.sealed_upright !== true) issues.push(`bag ${i + 1} is not sealed and upright`);
  });
  return { pass: issues.length === 0, issues };
}

export const IMAGE_BLOCKING = (side: string) => side === "overlay" ? [
  "Apart from the printed labels on the coffee bags, is the image free of any letters, words, numbers or logos?",
  "Is every coffee bag sealed and standing upright with its front label facing the camera, none open, torn, lying down or spilling?",
  "Is every object resting on a surface or held, with nothing visibly floating in the air?",
  "Are all coffee beans roasted brown, none green? (yes if no beans)",
] : [
  `Is the ${side} part of the image (about ${Math.round(TEXT_ZONE * 100)}% of the width) calm, empty background, free of bags, props and busy detail, so headline text can sit there?`,
  "Does the background run continuously across the whole image, with no visible panel, box, rectangle, frame edge or colour block marking off an area?",
  "Apart from the printed labels on the coffee bags, is the image free of any letters, words, numbers or logos?",
  "Is every coffee bag sealed and standing upright with its front label facing the camera, none open, torn, lying down or spilling?",
  "Is every object resting on a surface or held, with nothing visibly floating in the air?",
  "Are all coffee beans roasted brown, none green? (yes if no beans)",
];
export const DESIGN_NOTES = [
  "Would an expert designer present this as a premium campaign banner: one clear idea, bright and sophisticated, composed as one piece with room for the headline?",
  "Do the bags sit naturally in the scene's light and perspective, rather than looking pasted in?",
];

const CHECK_SYSTEM = `You are checking a wide email banner image for Minuto, a specialty coffee roastery, as it will be seen on a phone. Answer every numbered question "yes" or "no". Answer "no" only for a defect a viewer would notice at phone size. When a question's subject is not in the image, answer "yes".
Reply with JSON only: {"description": "one sentence", "answers": [{"n": 1, "answer": "yes" | "no", "why": "short"}], "correction": ""}`;

// ── Type in code ─────────────────────────────────────────────────────────────

let wasmReady: Promise<void> | null = null;
const fontCache = new Map<string, Promise<Uint8Array[]>>();

/** resvg wasm, loaded once per worker. */
export function loadWasm(): Promise<void> {
  wasmReady ??= initWasm(fetch("https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm")).catch((e) => { wasmReady = null; throw e; });
  return wasmReady;
}

/** TrueType files for one Google Fonts family at the given weights (cached). */
export function loadFamily(family: string, weights: number[]): Promise<Uint8Array[]> {
  const key = `${family}:${[...new Set(weights)].sort().join(",")}`;
  let p = fontCache.get(key);
  if (!p) {
    p = (async () => {
      const q = `family=${encodeURIComponent(family).replace(/%20/g, "+")}${TYPEFACES[family]?.weights.length === 1 ? "" : `:wght@${[...new Set(weights)].sort((x, y) => x - y).join(";")}`}`;
      // No browser user agent: Google Fonts then serves full TrueType files.
      const css = await (await fetch(`https://fonts.googleapis.com/css2?${q}`)).text();
      const urls = [...css.matchAll(/url\((https:[^)]+\.ttf)\)/g)].map((m) => m[1]);
      if (!urls.length) throw new Error(`no TrueType files for ${family}`);
      const files = await Promise.all(urls.map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())));
      for (const f of files) {
        const n = fontFamilyName(f);
        if (n) FACE_NAMES.set(`${family}:${n.weight}`, n.name);
      }
      return files;
    })();
    p.catch(() => fontCache.delete(key));
    fontCache.set(key, p);
  }
  return p;
}

/** Wasm plus the two families this banner's type uses. */
export async function loadRenderer(type: TypeSpec): Promise<Uint8Array[]> {
  await loadWasm();
  const same = type.title_font === type.support_font;
  const sets = await Promise.all(same
    ? [loadFamily(type.title_font, [type.title_weight, type.support_weight])]
    : [loadFamily(type.title_font, [type.title_weight]), loadFamily(type.support_font, [type.support_weight])]);
  return sets.flat();
}

export const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const RLM = "&#x200F;";
// resvg matches only the FIRST name in a font-family list, and static Google
// font files differ in how they name themselves (IBM Plex: "IBM Plex Sans
// Hebrew Light"; Heebo: "Heebo" + weight). So each loaded file's own family
// name is read from its name table and used verbatim.
const FACE_NAMES = new Map<string, string>();
export const familyAttr = (family: string, weight: number) => escXml(FACE_NAMES.get(`${family}:${weight}`) ?? family);

/** The family name resvg will match: name ID 16 (typographic family) if present, else ID 1. */
export function fontFamilyName(bytes: Uint8Array): { name: string; weight: number } | null {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = v.getUint16(4);
    let nameOff = 0, os2Off = 0;
    for (let i = 0; i < tables; i++) {
      const r = 12 + i * 16;
      const tag = String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3));
      if (tag === "name") nameOff = v.getUint32(r + 8);
      if (tag === "OS/2") os2Off = v.getUint32(r + 8);
    }
    if (!nameOff) return null;
    const count = v.getUint16(nameOff + 2), strOff = nameOff + v.getUint16(nameOff + 4);
    const got: Record<number, string> = {};
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12;
      const pid = v.getUint16(r), nid = v.getUint16(r + 6), len = v.getUint16(r + 8), o = v.getUint16(r + 10);
      if (pid !== 3 || (nid !== 1 && nid !== 16) || got[nid]) continue;
      let t = "";
      for (let j = 0; j < len; j += 2) t += String.fromCharCode(v.getUint16(strOff + o + j));
      got[nid] = t;
    }
    const name = got[16] || got[1];
    return name ? { name, weight: os2Off ? v.getUint16(os2Off + 4) : 400 } : null;
  } catch { return null; }
}

const fontOpts = (fonts: Uint8Array[]) => ({ font: { fontBuffers: fonts, loadSystemFonts: false } });

/** Width of a line of text in px, measured by resvg itself. */
function measure(fonts: Uint8Array[], family: string, text: string, size: number, weight: number, tracking = 0): number {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="${size * 2}"><text x="10" y="${size * 1.4}" font-family="${familyAttr(family, weight)}" font-weight="${weight}" font-size="${size}" letter-spacing="${(size * tracking).toFixed(1)}">${escXml(text)}</text></svg>`;
  const r = new Resvg(svg, fontOpts(fonts));
  const b = r.getBBox();
  r.free();
  return b ? b.width : text.length * size * 0.6;
}

/** Every way to split words into exactly n non-empty lines (words are few in a banner line). */
function splits(words: string[], n: number): string[][] {
  if (n === 1) return [[words.join(" ")]];
  const out: string[][] = [];
  for (let i = 1; i <= words.length - n + 1; i++) {
    for (const rest of splits(words.slice(i), n - 1)) out.push([words.slice(0, i).join(" "), ...rest]);
  }
  return out;
}

/** The most balanced split into n lines that all fit, with no single-word last line; null if none. */
export function balancedLines(words: string[], n: number, width: (line: string) => number, max: number, noWidow = true): string[] | null {
  if (words.length < n) return null;
  let best: string[] | null = null, bestMax = Infinity;
  for (const lines of splits(words, n)) {
    if (noWidow && n > 1 && lines[n - 1].split(" ").length < 2 && words.length > n) continue;   // no widow
    const ws = lines.map(width);
    const m = Math.max(...ws);
    if (m <= max && m < bestMax) { best = lines; bestMax = m; }
  }
  return best;
}

/** Largest size (step 4 px) at which the text sets well: fewest lines first, then balanced lines. */
export function fitText(fonts: Uint8Array[], family: string, text: string, width: number, maxLines: number, maxSize: number, minSize: number, weight: number, tracking = 0, display = false) {
  const words = text.split(/\s+/).filter(Boolean);
  // One line is preferred down to 70% of the largest size; then up to maxLines.
  for (const n of Array.from({ length: maxLines }, (_, i) => i + 1)) {
    const floor = n < maxLines ? Math.max(minSize, Math.round(maxSize * 0.7)) : minSize;
    for (let size = maxSize; size >= floor; size -= 4) {
      // A display title breaks at its most balanced point (a one-word last line
      // can be the right phrase break); running lines never end on a widow.
      const lines = balancedLines(words, n, (l) => measure(fonts, family, l, size, weight, tracking), width, !display);
      if (lines) return { size, lines };
    }
  }
  return null;
}

/** Mean brightness 0-1 of the type side, to pick dark or light ink. */
export function zoneBrightness(img: Image, side: "left" | "right" | "overlay"): number {
  if (side === "overlay") return 0;   // the dark wash goes under the type
  const x0 = side === "left" ? 0 : Math.floor(img.width * (1 - TEXT_ZONE));
  const x1 = side === "left" ? Math.floor(img.width * TEXT_ZONE) : img.width;
  let sum = 0, n = 0;
  for (let y = 1; y <= img.height; y += 6) {
    for (let x = x0 + 1; x <= x1; x += 6) {
      const c = img.getPixelAt(x, y);
      sum += (0.2126 * ((c >>> 24) & 0xff) + 0.7152 * ((c >>> 16) & 0xff) + 0.0722 * ((c >>> 8) & 0xff)) / 255;
      n++;
    }
  }
  return n ? sum / n : 1;
}

export interface BannerText { title: string; support: string }

/** The banner: the rendered image full-bleed, the type in the empty side as the art director specified. */
export function buildBannerSvg(fonts: Uint8Array[], imageDataUri: string, side: "left" | "right" | "overlay", bright: number, text: BannerText, ty: TypeSpec, scale = 1): string {
  const overlay = side === "overlay";
  // A dark area always takes white type, whatever was planned, so it stays legible.
  // Light inks (white, lime) only on a dark area; dark inks only on a light one.
  const lightInk = ty.color === "white" || ty.color === "lime";
  const fill = bright <= 0.45 ? (lightInk ? INKS[ty.color] : INKS.white) : (lightInk ? INKS.ink : INKS[ty.color] ?? INKS.ink);
  const zoneW = overlay ? W : Math.round(W * TEXT_ZONE);
  const width = overlay ? W - 220 : zoneW - 120;
  const center = overlay || ty.align === "center";
  const x = overlay ? Math.round(W / 2) : center ? (side === "left" ? Math.round(zoneW / 2) + 20 : W - Math.round(zoneW / 2) - 20) : (side === "left" ? zoneW - 40 : W - 60);
  const anchor = center ? "middle" : "end";
  const ttl = fitText(fonts, ty.title_font, text.title, width, overlay ? 3 : 2, Math.round((overlay ? 150 : 112) * scale), Math.round(40 * scale), ty.title_weight, ty.tracking, true);
  if (!ttl) throw new Error(`title text does not fit: "${text.title}"`);
  // On a 375 px phone the banner is ~330 px wide (x0.24), so the support line
  // never goes below ~50 px here (~12 px there).
  const sup = text.support ? fitText(fonts, ty.support_font, text.support, width, 2, Math.max(Math.round(60 * scale), Math.round(ttl.size * 0.5)), Math.round(50 * scale), ty.support_weight, Math.min(ty.tracking, 0.12)) : null;
  if (text.support && !sup) throw new Error(`support text does not fit: "${text.support}"`);
  const tLead = Math.round(ttl.size * 1.06), sLead = sup ? Math.round(sup.size * 1.35) : 0;
  const ruleGap = ty.accent === "none" ? 0 : Math.round(ttl.size * 0.3) + 14;
  const gap = sup ? Math.round(ttl.size * 0.28) : 0;
  const blockH = tLead * ttl.lines.length + ruleGap + gap + sLead * (sup?.lines.length ?? 0);
  let y = Math.round((H - blockH) / 2);
  const parts: string[] = [`<image href="${imageDataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`];
  if (overlay) parts.push(`<rect width="${W}" height="${H}" fill="#000" opacity="0.5"/>`);
  const line = (t: string, family: string, size: number, weight: number, tr: number) =>
    `<text x="${x}" y="${y}" font-family="${familyAttr(family, weight)}" font-weight="${weight}" font-size="${size}" letter-spacing="${(size * tr).toFixed(1)}" fill="${fill}" direction="rtl" text-anchor="${anchor}">${RLM}${escXml(t)}${RLM}</text>`;
  for (const l of ttl.lines) { y += tLead; parts.push(line(l, ty.title_font, ttl.size, ty.title_weight, ty.tracking)); }
  if (ty.accent !== "none") {
    const rw = 120, rx = center ? x - rw / 2 : x - rw;
    parts.push(`<rect x="${rx}" y="${y + Math.round(ttl.size * 0.3)}" width="${rw}" height="3" fill="${ty.accent === "gold_rule" ? "#B0894A" : "#B7C66A"}"/>`);
    y += ruleGap;
  }
  if (sup) {
    y += gap;
    for (const l of sup.lines) { y += sLead; parts.push(line(l, ty.support_font, sup.size, ty.support_weight, Math.min(ty.tracking, 0.12))); }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export async function renderJpeg(fonts: Uint8Array[], svg: string): Promise<Uint8Array> {
  const r = new Resvg(svg, { ...fontOpts(fonts), fitTo: { mode: "width", value: W } });
  const png = r.render().asPng();
  r.free();
  return await (await Image.decode(png)).encodeJPEG(86);
}

// ── Network steps ────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Part = Record<string, any>;

async function gemini(model: string, key: string, parts: Part[], generationConfig: Record<string, unknown>, timeoutMs: number): Promise<Part[]> {
  const started = Date.now();
  const call = () => fetch(`${API}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    signal: AbortSignal.timeout(Math.max(5_000, timeoutMs - (Date.now() - started))),
  });
  let res = await call();
  // Overloaded (503) or rate-limited (429): one retry after a short pause.
  if ((res.status === 503 || res.status === 429) && timeoutMs - (Date.now() - started) > 40_000) {
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 4_000));
    res = await call();
  }
  if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())?.candidates?.[0]?.content?.parts ?? [];
}
const textOf = (parts: Part[]) => parts.map((p) => p.text || "").join("");
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export interface BannerResult {
  url: string | null;
  concept: Concept | null;
  conceptScore: number | null;
  attempts: number;
  issues: string[];
  notes: string[];
}

export async function designBanner(opts: {
  copy: BannerCopy;
  products: BannerProduct[];
  recent: string[];
  artNote: string;
  geminiKey: string;
  supabaseUrl: string;
  // deno-lint-ignore no-explicit-any
  supabase: any;
  log?: (m: string) => void;
}): Promise<BannerResult> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const left = () => BANNER_BUDGET_MS - (Date.now() - started);
  const issues: string[] = [];
  const out = (r: Partial<BannerResult>): BannerResult => ({ url: null, concept: null, conceptScore: null, attempts: 0, issues, notes: [], ...r });
  if (!opts.geminiKey) return out({ issues: ["GEMINI_API_KEY not set"] });
  for (const p of opts.products) if (!isTrustedImageUrl(p.image_url, opts.supabaseUrl)) return out({ issues: [`untrusted image for ${p.short}`] });

  // 1. Concept, scored; a weak one goes back with the critique once.
  const brief = conceptUserMessage(opts.copy, opts.products, opts.recent, opts.artNote);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: brief }];
  let concept: Concept | null = null, bestScore: number | null = null, scored = 0;
  for (let round = 0; round < 3 && left() > 200_000; round++) {
    let res;
    try {
      res = await callClaude({ sourceFn: "generate-campaign", model: AD_MODEL, system: CONCEPT_SYSTEM, messages, maxTokens: 16000, effort: "high", timeoutMs: Math.min(90_000, left()) });
    } catch (e) { issues.push(`concept: ${e instanceof Error ? e.message : String(e)}`); break; }
    messages.push({ role: "assistant", content: res.text });
    const parsed = parseConcept(res.text, opts.products, opts.copy);
    if (!parsed.ok) { messages.push({ role: "user", content: `Fix these problems and reply with the full JSON again:\n- ${parsed.errors.join("\n- ")}` }); continue; }
    const cand = parsed.value;
    let score: number | null = null, critique = "";
    try {
      const j = JSON.parse(textOf(await gemini(AD_CRITIC_MODEL, opts.geminiKey,
        [{ text: CONCEPT_CRITIC_SYSTEM }, { text: `${CONCEPT_SYSTEM.split("How the banner is built")[0]}\n${brief}\n\nTHE CONCEPT:\n${JSON.stringify(cand)}` }],
        { responseMimeType: "application/json", temperature: 0 }, 60_000)));
      score = Number.isFinite(Number(j.score)) ? Number(j.score) : null;
      critique = String(j.critique ?? "");
    } catch { score = null; }
    log(`banner concept round ${round + 1}: score ${score} :: ${cand.idea}`);
    // Keep the best-scored concept; an unscorable one is accepted as is.
    if (!concept || bestScore == null || score == null || score > bestScore) { concept = cand; bestScore = score; }
    if (score == null || score >= CONCEPT_PASS_SCORE || scored >= 1) break;
    scored++;
    messages.push({ role: "user", content: `An executive creative director scored this concept ${score}/10 and wrote: ${critique}\nDesign a stronger concept that meets every point. Same JSON shape.` });
  }
  if (!concept) return out({ issues });
  const c = concept;

  // 2. Bag references: the shop's product images (owner, 2026-11-19: the
  // photographed real bags looked crumpled and garbled in banners; his own
  // banner tests on the clean shop images looked premium).
  const bagProducts = c.bags.map((name) => opts.products.find((x) => x.short === name)!);
  let refParts: Part[], fonts: Uint8Array[];
  try {
    refParts = (await Promise.all(bagProducts.map(async (p, i) => {
      const ref = await fetchRef(p.image_url);
      return [{ text: `Reference bag ${i + 1}: the real Minuto "${p.short}" coffee bag. Reproduce THIS EXACT bag.` }, { inline_data: { mime_type: ref.mime, data: ref.data } }];
    }))).flat();
    fonts = await loadRenderer(c.type);
  } catch (e) { return out({ concept: c, conceptScore: bestScore, issues: [...issues, `assets: ${e instanceof Error ? e.message : String(e)}`] }); }
  const text: BannerText = { title: lineText(opts.copy, c.title), support: lineText(opts.copy, c.support) };
  const names = bagProducts.map((p) => p.short);
  const blocking = IMAGE_BLOCKING(c.text_side);
  const questions = [...blocking, ...DESIGN_NOTES];

  // 3. Render candidates, check each, rank.
  let attempts = 0;
  let best: { url: string; notes: string[] } | null = null;
  for (let round = 0; round < 2 && !best && left() > 110_000; round++) {
    const cands = await Promise.all(Array.from({ length: CANDIDATES }, async () => {
      const n = ++attempts;
      try {
        const parts = await gemini(IMAGE_MODEL, opts.geminiKey, [...refParts, { text: `${c.prompt}\n\n${renderRules(c, names)}` }],
          { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "21:9" } }, Math.min(110_000, left()));
        const img = parts.map((p) => p.inlineData || p.inline_data).find((d) => d?.data && String(d.mimeType || d.mime_type).startsWith("image/"));
        if (!img) return { n, error: "the image model returned no image" };
        const mime = String(img.mimeType || img.mime_type);
        const imagePart = { inline_data: { mime_type: mime, data: img.data } };
        const [labels, v] = await Promise.all([
          gemini(AD_CRITIC_MODEL, opts.geminiKey, [...refParts, { text: "Generated banner:" }, imagePart, { text: labelTranscribePrompt(names) }],
            { responseMimeType: "application/json", temperature: 0 }, 60_000).then((r) => judgeLabels(textOf(r), names.length)),
          gemini(AD_CRITIC_MODEL, opts.geminiKey, [{ text: CHECK_SYSTEM }, imagePart, { text: criticUserMessage(questions) }],
            { responseMimeType: "application/json", temperature: 0 }, 60_000).then((r) => parseCritic(textOf(r), questions, blocking.length)),
        ]);
        const notes = [...labels.issues, ...[...v.failed, ...v.notes].map((f) => `${f.q} → no: ${f.why}`)];
        return { n, mime, data: img.data, passes: labels.pass && v.passes, design: DESIGN_NOTES.length - v.notes.length, notes };
      } catch (e) {
        return { n, error: e instanceof Error ? e.message : String(e) };
      }
    }));
    type Cand = { n: number; mime: string; data: string; passes: boolean; design: number; notes: string[] };
    for (const x of cands) if ("error" in x) issues.push(`attempt ${x.n}: ${x.error}`);
    const ok = cands.filter((x): x is Cand => !("error" in x));
    for (const x of ok) if (!x.passes) issues.push(`attempt ${x.n}: ${x.notes.slice(0, 3).join("; ")}`);
    const ranked = ok.filter((x) => x.passes).sort((a, b) => b.design - a.design);
    log(`banner round ${round + 1}: ${ranked.length}/${cands.length} candidates passed (${Date.now() - started}ms)`);

    // 4-5. Type in code on the best passing candidate; final QA; smaller type once.
    for (const cand of ranked) {
      const base = await Image.decode(Uint8Array.from(atob(cand.data), (ch) => ch.charCodeAt(0)));
      const bright = zoneBrightness(base, c.text_side);
      const dataUri = `data:${cand.mime};base64,${cand.data}`;
      for (const scale of [1, 0.85]) {
        let jpg: Uint8Array;
        try { jpg = await renderJpeg(fonts, buildBannerSvg(fonts, dataUri, c.text_side, bright, text, c.type, scale)); }
        catch (e) { issues.push(`type: ${e instanceof Error ? e.message : String(e)}`); continue; }
        const tq = [`Does the large Hebrew title read exactly "${text.title}"${text.support ? ` and the smaller line beneath it exactly "${text.support}"` : ""}, every letter present, clearly legible against its background, with nothing cut off or overlapping a bag or prop?`,
          "Is the typography designed with craft: a fitting typeface pairing, clear contrast of size and weight between title and support, well placed and balanced with the image, as a professional designer would set it?"];
        let passes = false, why = "";
        try {
          const v = parseCritic(textOf(await gemini(AD_CRITIC_MODEL, opts.geminiKey,
            [{ text: CHECK_SYSTEM }, { inline_data: { mime_type: "image/jpeg", data: b64(jpg) } }, { text: criticUserMessage(tq) }],
            { responseMimeType: "application/json", temperature: 0 }, 60_000)), tq, 1);
          passes = v.passes; why = [...v.failed, ...v.notes].map((f) => f.why).join("; ");
          if (passes && v.notes.length) cand.notes.push(...v.notes.map((f) => `type: ${f.why}`));
        } catch (e) { why = `text check failed to run: ${e instanceof Error ? e.message : String(e)}`; }
        if (!passes) { issues.push(`attempt ${cand.n} type at ${scale}: ${why}`); continue; }
        const path = `banners/designed-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.jpg`;
        const { error } = await opts.supabase.storage.from("marketing").upload(path, jpg, { contentType: "image/jpeg", upsert: false });
        if (error) { issues.push(`upload failed: ${error.message}`); break; }
        const { data } = opts.supabase.storage.from("marketing").getPublicUrl(path);
        if (data?.publicUrl) best = { url: data.publicUrl, notes: cand.notes };
        break;
      }
      if (best) break;
    }
  }
  log(`banner done in ${Date.now() - started}ms: ${best ? best.url : "no banner"}`);
  return out({ url: best?.url ?? null, concept: c, conceptScore: bestScore, attempts, notes: best?.notes ?? [] });
}
