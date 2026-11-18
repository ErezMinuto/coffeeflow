// The art director for campaign-email hero images.
//
// Owner, 2026-11-18: the Black Friday hero was not elegant enough, and the
// AGENT must design the image, not a person. Brain used to write a one-line
// scene and Nano Banana Pro drew it. Now the same art director the owner chose
// for Instagram (Claude Opus 5.5, blind test 3/3) reads the approved email,
// invents 3 concepts, picks one and writes the photographer's prompt. Nano
// Banana Pro renders 2 candidates from Minuto's real photos (real bag photos
// for a bag shot, the photo library for a scene), and a check picks the best:
//   • bags: the label check (scene_image.ts) is a gate, because a garbled
//     label is a brand error the owner never wants sent.
//   • scene: Gemini 3.1 Pro answers the Instagram art director's objective
//     questions; as on Instagram it ranks the candidates (owner, 2026-11-07:
//     QA is an attention flag, the owner's review is the quality check).
// The result lands in a DRAFT; the owner sees it before anything is sent.

import { callClaude } from "../seo-agent/claude.ts";
import { AD_MODEL, AD_CRITIC_MODEL, AD_CRITIC_SYSTEM, criticUserMessage, parseCritic, referenceCandidates } from "../_shared/art_director.ts";
import { bagReferenceFor, storagePublicUrl } from "../_shared/bag_references.ts";
import { checkPrompt, fetchRef, isTrustedImageUrl, parseCheck } from "./scene_image.ts";

const IMAGE_MODEL = "gemini-3-pro-image";
const CHECK_MODEL = "gemini-3.5-flash";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
export const EMAIL_AD_VERSION = "email-art-director-v1";

// render-draft runs inside a Brain chat turn (edge wall clock 400 s, and the
// chat itself needs time before and after). No new work starts after this.
export const EMAIL_AD_BUDGET_MS = 170_000;
export const EMAIL_AD_CANDIDATES = 2;

export interface AdProduct { woo_id: number | string; name: string; short: string; description: string; image_url: string; jar: boolean }

export interface EmailCopy {
  subject: string; preheader: string; headline: string; kicker: string;
  body: string; offerTitle: string; offerText: string;
}

export interface EmailArtDirection {
  mode: "bags" | "scene";
  concepts: string[];
  choice: number;
  why: string;
  bags: string[];                                   // bags mode: product names, as listed
  references: Array<{ key: string; role: string }>; // library photos (scene: 1-2, bags: 0-1 for the setting)
  prompt: string;
  qa: string[];
}

export interface EmailHeroResult {
  url: string | null;
  design: number | null;         // design-review "yes" answers of the chosen image, out of DESIGN_QUESTIONS.length
  concept: string;               // stored as the draft's sceneBrief, so the next email does something else
  attempts: number;
  issues: string[];
  notes: string[];
  direction: EmailArtDirection | null;
}

export const EMAIL_AD_SYSTEM = `You are Minuto's art director for campaign emails. Minuto is a small specialty coffee roastery and espresso bar in Rehovot, Israel ("מינוטו קפה בית קלייה ספיישלטי"). For each email you design the hero image: the one photograph at the top that makes the reader feel the email before reading it. An image model (Nano Banana Pro) renders your prompt using Minuto's own photos as references.

Where the image lives: a 600px-wide email, under a deep olive (#2F3B25) header with a lime (#C9D77E) button. The image is a wide 16:9 photograph that sits directly below that olive band, on phones at 375px wide too.

The standard is a senior art director at a premium brand, working with a top still-life and editorial photographer. The owner judges every image against that bar, and he rejected the last Black Friday hero (four bags lined up in a row on a black stone tile, beans scattered, a cup in the corner) as amateur work.
What expert work looks like:
- An idea, not an inventory: the image carries one thought that belongs to this email (a moment, a gesture of the season, a feeling of abundance or of choosing), and a viewer gets it without reading.
- Composition with intent: one hero subject placed off-centre on a third, real depth (foreground, subject, background in distinct planes), generous negative space, a strong graphic shape or line, a camera height and lens chosen for the subject.
- Lighting as design: one motivated light source (window daylight, low morning sun, a soft side light), real shadows with direction, highlights that model the form.
- A colour story: a restrained palette chosen to sit beside the deep olive band (warm naturals, cream, linen, wood, stone, olive and lime echoes), one accent at most.
- Material and texture you can feel: paper, ceramic, linen, wood grain, the matte surface of roasted beans.
- Restraint: every object earns its place; three objects are usually better than eight.
Amateur work the owner rejects (never produce these): products lined up in a row facing the camera; a straight top-down flat-lay of bags with beans scattered around them; dark slate, black tile or black stone backgrounds; centred, symmetric product line-ups; props filling every corner; generic "coffee beans and cup" stock compositions; a catalogue packshot passed off as a hero.
It reads at phone size in one glance, serves the email's single message, and differs from the recent email images you are shown.

Two modes:
- "bags": Minuto's real sealed bags are the subject. Pick 1 or 2 of the email's products. Each bag is rendered from a photo of the real bag and then checked letter by letter, and the image model keeps a label readable only when the bag stands upright with its front label facing the camera (turned at most slightly), fully in frame and uncovered. So every bag stands upright, front to camera, sealed; lying, tilted, overlapping or turned-away bags come out with upside-down or cut-off labels and are rejected. The bags are white with their printed label; describe them only as "the white Minuto bag", never with paper or colour words (kraft, brown, paper bag), and never describe their labels or text. Special editions (marked JAR) are never in a bag shot. You may add one library photo as a reference for the setting.
- "scene": no bags or jars. A real moment or detail at Minuto (the bar, the roaster, the beans, the brewing) from 1-2 library photos. Library photos are references for what the real equipment and place look like, never the composition to copy.
Choose the mode that best carries THIS email. An offer on bags is often best told by the bags themselves; a story email by a scene. It is your call.

Real-world rules (hard rules):
- Coffee beans are always roasted, light-cinnamon to medium brown, never green, black or oily.
- No people's faces in focus; people appear only as hands or soft background figures, and a hand may only do what a chosen reference shows a hand doing.
- Every object rests on a surface or is held; nothing floats. Liquid and steam come only from where they really come from.
- No text, numbers, prices, percent signs, signs, banners or logos are added to the image. The offer is in the email's words, never painted in the picture.
- The espresso machine (when shown) is the 2-group La Marzocco Strada X with slate-grey body and clear pale-blue glass side panels; never ask for lettering on it.
- Minuto roasts weekly, on a Coffee-Tech Ghibli R15 drum roaster.

How you work:
1. Read the approved email: its one job, its offer and its mood.
2. Look at the recent email images and do something different in subject, setting and light.
3. Propose 3 genuinely different concepts in one line each. Judge each as the senior art director would: is it an idea or an inventory, would it run on a premium brand's homepage, does it avoid every amateur pattern above. Pick the strongest and say why in one sentence.
4. Choose the mode and the references (bag product names and/or library photo keys from the index). Each library reference gets one role sentence: what the image model copies from it and nothing else.
5. Write the prompt (120-220 words) as one flowing paragraph, the way a photographer describes the shot: the style, what each reference controls, the subject and its arrangement, surface and props, the setting, the light, the camera and lens, the texture and colour. Describe only what should be in the picture, all positively; do not use the words "no", "not", "never", "without" or "avoid" in the prompt. End it with "Wide 16:9 frame."
6. Write 2-3 yes/no questions a checker can answer by looking at the image, phrased so "yes" means correct, about the physical details most likely to go wrong in your scene.

Reply with JSON only, exactly this shape:
{"mode": "bags" | "scene", "concepts": ["...", "...", "..."], "choice": 0, "why": "...", "bags": ["<product name as listed>"], "references": [{"key": "<photo key>", "role": "..."}], "prompt": "...", "qa": ["...", "..."]}`;

export function emailAdUserMessage(copy: EmailCopy, products: AdProduct[], recentScenes: string[], artNote: string, photos = referenceCandidates()): string {
  return [
    "PHOTO INDEX (library references; key, what it shows, what hands do in it):",
    JSON.stringify(photos.map((p) => ({ key: p.key, desc: p.desc, shows: p.shows, actions: p.actions, flags: p.flags }))),
    "", "THE EMAIL'S PRODUCTS (bags mode may use these; JAR = special edition, never in a bag shot):",
    ...products.map((p) => `- ${p.short}${p.jar ? " (JAR)" : ""}: ${p.description.slice(0, 200) || "(no description)"}`),
    "", "RECENT EMAIL IMAGES (newest first; do something different):",
    recentScenes.length ? recentScenes.map((s) => `- ${s}`).join("\n") : "- (none yet)",
    ...(artNote ? ["", `THE OWNER'S NOTE FOR THIS IMAGE: ${artNote}`] : []),
    "", "THE APPROVED EMAIL:",
    `subject: ${copy.subject}`,
    copy.preheader ? `preheader: ${copy.preheader}` : "",
    copy.kicker ? `kicker: ${copy.kicker}` : "",
    copy.headline ? `headline: ${copy.headline}` : "",
    copy.offerTitle ? `offer: ${copy.offerTitle}${copy.offerText ? ` (${copy.offerText})` : ""}` : "",
    `body: ${copy.body.slice(0, 1500)}`,
  ].filter((l) => l !== "").join("\n");
}

const NEGATION = /\b(no|not|never|without|avoid)\b/i;

/** Parse and check the art director's JSON against what this email allows. */
export function parseEmailArtDirection(
  text: string, productNames: string[], jarNames: ReadonlySet<string>, allowedKeys: ReadonlySet<string>,
): { ok: true; value: EmailArtDirection; warnings: string[] } | { ok: false; errors: string[] } {
  let d: Record<string, unknown>;
  try {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    d = JSON.parse(text.slice(s, e + 1));
  } catch {
    return { ok: false, errors: ["the reply was not valid JSON"] };
  }
  const errors: string[] = [], warnings: string[] = [];
  const mode = d.mode === "bags" || d.mode === "scene" ? d.mode : null;
  if (!mode) errors.push('mode must be "bags" or "scene"');
  const concepts = Array.isArray(d.concepts) ? d.concepts.map(String) : [];
  if (concepts.length !== 3) errors.push("concepts must hold exactly 3 one-line ideas");
  const choice = Number(d.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice > 2) errors.push("choice must be 0, 1 or 2");
  const bags = Array.isArray(d.bags) ? [...new Set(d.bags.map((b) => String(b).trim()).filter(Boolean))] : [];
  const references = (Array.isArray(d.references) ? d.references as Array<Record<string, unknown>> : [])
    .map((r) => ({ key: String(r?.key ?? ""), role: String(r?.role ?? "").trim() }));
  for (const r of references) {
    if (!allowedKeys.has(r.key)) errors.push(`reference "${r.key}" is not a key in the photo index`);
    if (!r.role) errors.push(`reference "${r.key}" needs a role sentence`);
  }
  if (new Set(references.map((r) => r.key)).size !== references.length) errors.push("references must be different photos");
  if (mode === "bags") {
    if (bags.length < 1 || bags.length > 2) errors.push("bags mode needs 1 or 2 bags");
    for (const b of bags) {
      if (!productNames.includes(b)) errors.push(`bag "${b}" is not one of the email's products (${productNames.join(", ")})`);
      if (jarNames.has(b)) errors.push(`"${b}" is a special edition in a jar and cannot be in a bag shot`);
    }
    if (references.length > 1) errors.push("bags mode takes at most 1 library reference (the setting)");
  }
  if (mode === "scene") {
    if (bags.length) errors.push("scene mode has no bags; leave bags empty");
    if (references.length < 1 || references.length > 2) errors.push("scene mode needs 1-2 library references");
  }
  const prompt = typeof d.prompt === "string" ? d.prompt.trim() : "";
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words < 60) errors.push(`the prompt has ${words} words; write 120-220`);
  if (words > 320) errors.push(`the prompt has ${words} words; keep it under 220`);
  if (NEGATION.test(prompt)) warnings.push(`prompt uses a negation word ("${prompt.match(NEGATION)![0]}")`);
  const qa = Array.isArray(d.qa) ? d.qa.map(String).filter((q) => q.trim()).slice(0, 3) : [];
  if (errors.length) return { ok: false, errors };
  return { ok: true, warnings, value: { mode: mode!, concepts, choice, why: String(d.why ?? ""), bags: mode === "bags" ? bags : [], references, prompt, qa } };
}

// Objective checks for a scene (the Instagram art director's blocking list,
// minus the bar/roastery-only ones), plus the email's own.
export const SCENE_BLOCKING = [
  "Is the image free of added text, numbers, prices, signs, banners and logos (lettering printed on real equipment is fine)?",
  "Are all coffee beans roasted brown, none green? (yes if no beans)",
  "Is the image free of coffee bags and jars?",
  "Is the image free of a sharp, recognisable face that is the main subject or in the foreground? (soft or background faces are fine)",
  "Is every object resting on a surface or held, with nothing visibly floating in the air?",
];
export const SCENE_NOTES = [
  "Does the scene look like a real photograph, with nothing physically absurd that jumps out at first glance?",
];

// Design quality, asked of every candidate in both modes and used to rank
// them: the owner's bar is a senior art director, not a correct packshot.
export const DESIGN_QUESTIONS = [
  "Would a senior art director at a premium brand approve this as a homepage hero photograph?",
  "Is it free of the amateur patterns: products lined up in a row, a top-down flat-lay with scattered beans, a black tile or slate background, a centred symmetric line-up, a cluttered frame?",
  "Does it have one clear off-centre subject, real depth and directional light, readable at phone size?",
];
const DESIGN_SYSTEM = `You are a senior art director reviewing a hero photograph for a premium specialty coffee brand's email, as it will be seen on a phone. Be demanding: answer "yes" only when a top agency would ship it. Reply with JSON only: {"answers": [{"n": 1, "answer": "yes" | "no", "why": "short"}]}`;

// deno-lint-ignore no-explicit-any
type Part = Record<string, any>;

async function gemini(model: string, key: string, parts: Part[], generationConfig: Record<string, unknown>, timeoutMs: number): Promise<Part[]> {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j?.candidates?.[0]?.content?.parts ?? [];
}

const libraryUrl = (supabaseUrl: string, key: string) =>
  `${supabaseUrl}/storage/v1/object/public/marketing/upload_images/${key.split("/").map(encodeURIComponent).join("/")}`;
const mimeOf = (key: string) => /\.png$/i.test(key) ? "image/png" : /\.webp$/i.test(key) ? "image/webp" : "image/jpeg";

export async function artDirectEmailHero(opts: {
  copy: EmailCopy;
  products: AdProduct[];
  recentScenes: string[];
  artNote: string;
  geminiKey: string;
  supabaseUrl: string;
  // deno-lint-ignore no-explicit-any
  supabase: any;
  log?: (m: string) => void;
}): Promise<EmailHeroResult> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const left = () => EMAIL_AD_BUDGET_MS - (Date.now() - started);
  const fail = (issues: string[], direction: EmailArtDirection | null = null, attempts = 0): EmailHeroResult =>
    ({ url: null, design: null, concept: direction ? direction.concepts[direction.choice] ?? "" : "", attempts, issues, notes: [], direction });
  if (!opts.geminiKey) return fail(["GEMINI_API_KEY not set"]);
  for (const p of opts.products) {
    if (!isTrustedImageUrl(p.image_url, opts.supabaseUrl)) return fail([`untrusted image for ${p.short}`]);
  }

  // 1. The art director designs the image (one fix round on invalid JSON).
  const photos = referenceCandidates();
  const allowed = new Set(photos.map((p) => p.key));
  const names = opts.products.map((p) => p.short);
  const jars = new Set(opts.products.filter((p) => p.jar).map((p) => p.short));
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: emailAdUserMessage(opts.copy, opts.products, opts.recentScenes, opts.artNote, photos) },
  ];
  let ad: EmailArtDirection | null = null;
  for (let round = 0; round < 2 && !ad; round++) {
    let res;
    try {
      res = await callClaude({
        sourceFn: "generate-campaign", model: AD_MODEL, system: EMAIL_AD_SYSTEM, messages,
        maxTokens: 16000, effort: "medium", timeoutMs: Math.min(75_000, left()),
      });
    } catch (e) {
      return fail([`art director: ${e instanceof Error ? e.message : String(e)}`]);
    }
    const parsed = parseEmailArtDirection(res.text, names, jars, allowed);
    if (parsed.ok) {
      ad = parsed.value;
      if (parsed.warnings.length) log(`email art director warnings: ${parsed.warnings.join("; ")}`);
    } else {
      messages.push({ role: "assistant", content: res.text }, { role: "user", content: `Fix these problems and reply with the full JSON again:\n- ${parsed.errors.join("\n- ")}` });
      if (round === 1) return fail([`art director: ${parsed.errors.join("; ")}`]);
    }
  }
  if (!ad) return fail(["art director returned nothing"]);
  log(`email art director (${Date.now() - started}ms): ${ad.mode}: ${ad.concepts[ad.choice]}`);

  // 2. References: real bag photos (or the shop packshot when a bag has no
  // photo yet) and library photos by URL.
  const refParts: Part[] = [];
  const bagProducts = ad.bags.map((b) => opts.products.find((p) => p.short === b)!);
  const labelRefs: Part[] = [];
  try {
    for (const [i, p] of bagProducts.entries()) {
      const real = bagReferenceFor(Number(p.woo_id));
      const ref = await fetchRef(real ? storagePublicUrl(opts.supabaseUrl, real.front) : p.image_url);
      const part = { inline_data: { mime_type: ref.mime, data: ref.data } };
      const label = { text: `Reference bag ${i + 1}: the real Minuto "${p.short}" coffee bag. Reproduce THIS EXACT bag, sealed.` };
      refParts.push(label, part);
      labelRefs.push(label, part);
    }
  } catch (e) {
    return fail([e instanceof Error ? e.message : String(e)], ad);
  }
  for (const [i, r] of ad.references.entries()) {
    refParts.push({ text: `Library reference ${i + 1}: use it only for ${r.role.slice(0, 300)}` });
    refParts.push({ fileData: { mimeType: mimeOf(r.key), fileUri: libraryUrl(opts.supabaseUrl, r.key) } });
  }
  const bagRule = ad.mode === "bags"
    ? `\n\nShow each of the ${bagProducts.length} reference bag${bagProducts.length > 1 ? "s" : ""} exactly once, standing upright with its front label facing the camera, sealed, white, with its exact shape, stag logo, "MINUTO Café Roastery" wordmark and label artwork from its reference, the whole label in frame and readable. Add no text anywhere else.`
    : "";

  // 3. Render candidates in parallel, check each, keep the best. One more
  // round only if nothing usable came back and the budget allows it.
  const issues: string[] = [];
  let attempts = 0;
  let best: { url: string; notes: string[]; passes: boolean; design: number } | null = null;
  const rank = (c: { passes: boolean; design: number }) => (c.passes ? 100 : 0) + c.design;
  // A second round runs when nothing usable came back, or the best one falls
  // short of the design bar, and the budget allows it.
  for (let round = 0; round < 2 && !(best?.passes && best.design === DESIGN_QUESTIONS.length); round++) {
    if (round > 0 && left() < 80_000) break;
    const cands = await Promise.all(Array.from({ length: EMAIL_AD_CANDIDATES }, async () => {
      const n = ++attempts;
      try {
        const out = await gemini(IMAGE_MODEL, opts.geminiKey, [...refParts, { text: ad!.prompt + bagRule }],
          { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "16:9" } }, Math.min(100_000, Math.max(left(), 20_000)));
        const img = out.map((p) => p.inlineData || p.inline_data).find((d) => d?.data && String(d.mimeType || d.mime_type).startsWith("image/"));
        if (!img) return { n, error: "no image returned" };
        const mime = String(img.mimeType || img.mime_type);
        const imagePart = { inline_data: { mime_type: mime, data: img.data } };
        // Correctness (labels for bags, objective checks for a scene) and the
        // design review run side by side.
        const correctness = async (): Promise<{ passes: boolean; notes: string[] }> => {
          if (ad!.mode === "bags") {
            const v = parseCheck((await gemini(CHECK_MODEL, opts.geminiKey,
              [...labelRefs, { text: "Generated image to check:" }, imagePart, { text: checkPrompt(bagProducts.map((p) => p.short)) }],
              { responseMimeType: "application/json", temperature: 0 }, 45_000)).map((p) => p.text || "").join(""));
            return { passes: v.pass, notes: v.issues };
          }
          const questions = [...SCENE_BLOCKING, ...SCENE_NOTES, ...ad!.qa];
          const v = parseCritic((await gemini(AD_CRITIC_MODEL, opts.geminiKey,
            [{ text: AD_CRITIC_SYSTEM }, imagePart, { text: criticUserMessage(questions) }],
            { responseMimeType: "application/json", temperature: 0 }, 60_000)).map((p) => p.text || "").join(""), questions, SCENE_BLOCKING.length);
          return { passes: v.passes, notes: [...v.failed, ...v.notes].map((f) => `${f.q} → no: ${f.why}`) };
        };
        const design = async (): Promise<{ score: number; notes: string[] }> => {
          try {
            const v = parseCritic((await gemini(AD_CRITIC_MODEL, opts.geminiKey,
              [{ text: DESIGN_SYSTEM }, imagePart, { text: criticUserMessage(DESIGN_QUESTIONS) }],
              { responseMimeType: "application/json", temperature: 0 }, 60_000)).map((p) => p.text || "").join(""), DESIGN_QUESTIONS, 0);
            return { score: DESIGN_QUESTIONS.length - v.notes.length, notes: v.notes.map((f) => `design: ${f.q} → no: ${f.why}`) };
          } catch (e) {
            return { score: 0, notes: [`design review failed: ${e instanceof Error ? e.message : String(e)}`] };
          }
        };
        const [c, d] = await Promise.all([correctness(), design()]);
        return { n, mime, data: img.data, passes: c.passes, notes: c.notes, design: d.score, designNotes: d.notes };
      } catch (e) {
        return { n, error: e instanceof Error ? e.message : String(e) };
      }
    }));
    for (const c of cands) if ("error" in c) issues.push(`attempt ${c.n}: ${c.error}`);
    type Cand = { n: number; mime: string; data: string; passes: boolean; notes: string[]; design: number; designNotes: string[] };
    const usable = cands.filter((c): c is Cand => !("error" in c))
      // A bag shot with a failed label check is never used.
      .filter((c) => ad!.mode === "scene" || c.passes)
      // Correct first, then the design review's score, then fewest notes.
      .sort((a, b) => Number(b.passes) - Number(a.passes) || b.design - a.design || a.notes.length - b.notes.length);
    for (const c of cands) if (!("error" in c) && ad.mode === "bags" && !c.passes) issues.push(`attempt ${c.n}: ${c.notes.join("; ") || "failed the label check"}`);
    const top = usable[0];
    // A second round replaces the first only with a better candidate.
    if (!top || (best && rank(best) >= rank(top))) continue;
    const ext = top.mime.includes("png") ? "png" : "jpg";
    const path = `scenes/${new Date().toISOString().slice(0, 10)}-ad-${crypto.randomUUID()}.${ext}`;
    const bytes = Uint8Array.from(atob(top.data), (ch) => ch.charCodeAt(0));
    const { error } = await opts.supabase.storage.from("marketing").upload(path, bytes, { contentType: top.mime, upsert: false });
    if (error) { issues.push(`upload failed: ${error.message}`); break; }
    const { data } = opts.supabase.storage.from("marketing").getPublicUrl(path);
    if (data?.publicUrl) best = { url: data.publicUrl, notes: [...top.notes, ...top.designNotes], passes: top.passes, design: top.design };
    log(`email art director round ${round + 1}: ${usable.length}/${cands.length} usable in ${Date.now() - started}ms`);
  }
  return {
    url: best?.url ?? null, design: best?.design ?? null, concept: ad.concepts[ad.choice] ?? "", attempts, issues,
    notes: best?.notes ?? [], direction: ad,
  };
}
