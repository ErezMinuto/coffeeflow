// Scene images for campaign emails, built around the REAL Minuto bags.
//
// The bags' shop photos go to Nano Banana Pro as references, so the stag,
// wordmark and label art come from the real packaging instead of being drawn
// from a text prompt. Every render is then checked against the same photos by
// a vision model; a render that misspells "Café Roastery", drops or invents a
// bag, opens one or adds text is thrown away. Tested 2026-11-05: 3 of 4 first
// renders passed, the 4th had "Café Soastery". If no render passes within the
// budget, the caller falls back to the real product photos.

const IMAGE_MODEL = "gemini-3-pro-image";
const CHECK_MODEL = "gemini-3.5-flash";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

export const MAX_SCENE_ATTEMPTS = 3;
// render-draft runs inside a chat turn; stop starting new attempts after this.
const BUDGET_MS = 100_000;

export interface SceneBag { name: string; image_url: string }

export interface SceneResult {
  url: string | null;
  attempts: number;
  issues: string[];          // why rejected renders failed, newest last
}

// Only our own shop images and our own Storage are fetched as references.
export function isTrustedImageUrl(raw: string, supabaseUrl: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    if (u.hostname === "minuto.co.il" || u.hostname === "www.minuto.co.il") return true;
    return !!supabaseUrl && u.origin === new URL(supabaseUrl).origin;
  } catch { return false; }
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function fetchRef(url: string): Promise<{ mime: string; data: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`reference image ${res.status}: ${url}`);
  const mime = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
  if (!mime.startsWith("image/")) throw new Error(`reference is not an image (${mime}): ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 8_000_000) throw new Error(`reference image too large: ${url}`);
  return { mime, data: b64(bytes) };
}

export function sceneRules(count: number): string {
  return `Hard rules: show all ${count} bag${count > 1 ? "s" : ""} from the references, each exactly once, every bag SEALED and upright or lying flat (never open, torn or spilling). Each bag keeps its exact proportions, stag logo, "MINUTO Café Roastery" wordmark and label artwork; do not redraw, simplify or invent label text. Any loose coffee beans are medium-roasted, light-cinnamon brown, not black or oily. No people, no hands, no added text, numbers, prices, signs or logos anywhere except what is printed on the real bags. Everything in sharp focus, no heavy background blur. Premium, warm, natural photography for a specialty coffee roastery's email. Wide 16:9 frame.`;
}

export function checkPrompt(names: string[]): string {
  return `You are a strict brand-compliance checker for a coffee roastery's marketing image. Compare the generated image with the reference bags.
Expected: exactly the ${names.length} reference bag${names.length > 1 ? "s" : ""} (${names.join(", ")}), each once.
FAIL the image if ANY of these is true:
- an expected bag is missing, appears more than once, or an unexpected/invented bag appears
- the large wordmark on any bag is not exactly "MINUTO" or the line under it is not exactly "Café Roastery" (check every letter)
- the product name printed on a bag is misspelled, hidden or cut off, or differs from the name printed on its reference bag
- a bag's label artwork or colours clearly differ from its reference (ignore the tiny fine-print lines; they are always unreadable and do not count)
- a bag is open, torn or spilling
- there are people or hands, or any added text, numbers, prices or logos outside the bags
Reply with JSON only: {"pass": true|false, "issues": ["short reason", ...]}`;
}

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

/** Parse the checker's reply; anything but an explicit pass is a fail. */
export function parseCheck(text: string): { pass: boolean; issues: string[] } {
  try {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    const j = JSON.parse(text.slice(s, e + 1));
    const issues = Array.isArray(j?.issues) ? j.issues.map((x: unknown) => String(x).slice(0, 200)).slice(0, 6) : [];
    return { pass: j?.pass === true && issues.length === 0, issues };
  } catch {
    return { pass: false, issues: ["label check returned no verdict"] };
  }
}

export async function generateSceneImage(opts: {
  bags: SceneBag[];
  sceneBrief: string;
  geminiKey: string;
  supabaseUrl: string;
  // deno-lint-ignore no-explicit-any
  supabase: any;
}): Promise<SceneResult> {
  const { bags, geminiKey } = opts;
  const brief = opts.sceneBrief.trim().slice(0, 600);
  if (!geminiKey) return { url: null, attempts: 0, issues: ["GEMINI_API_KEY not set"] };
  if (!bags.length || bags.length > 4 || !brief) return { url: null, attempts: 0, issues: ["need 1-4 bags and a scene brief"] };
  for (const b of bags) {
    if (!isTrustedImageUrl(b.image_url, opts.supabaseUrl)) return { url: null, attempts: 0, issues: [`untrusted image for ${b.name}`] };
  }

  let refs: { mime: string; data: string }[];
  try { refs = await Promise.all(bags.map((b) => fetchRef(b.image_url))); }
  catch (e) { return { url: null, attempts: 0, issues: [e instanceof Error ? e.message : String(e)] }; }

  const refParts: Part[] = [];
  bags.forEach((b, i) => {
    refParts.push({ text: `Reference image ${i + 1}: the real Minuto "${b.name}" coffee bag. Reproduce THIS EXACT bag.` });
    refParts.push({ inline_data: { mime_type: refs[i].mime, data: refs[i].data } });
  });
  const names = bags.map((b) => b.name);
  const started = Date.now();
  const issues: string[] = [];
  let attempts = 0;

  while (attempts < MAX_SCENE_ATTEMPTS && Date.now() - started < BUDGET_MS) {
    attempts++;
    try {
      const out = await gemini(IMAGE_MODEL, geminiKey,
        [...refParts, { text: `Scene: ${brief}\n\n${sceneRules(bags.length)}` }],
        { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "16:9" } }, 90_000);
      const img = out.map((p) => p.inlineData || p.inline_data).find((d) => d?.data && String(d.mimeType || d.mime_type).startsWith("image/"));
      if (!img) { issues.push(`attempt ${attempts}: no image returned`); continue; }
      const mime = String(img.mimeType || img.mime_type);

      const verdictParts = await gemini(CHECK_MODEL, geminiKey,
        [...refParts, { text: "Generated image to check:" }, { inline_data: { mime_type: mime, data: img.data } }, { text: checkPrompt(names) }],
        { responseMimeType: "application/json", temperature: 0 }, 45_000);
      const verdict = parseCheck(verdictParts.map((p) => p.text || "").join(""));
      if (!verdict.pass) { issues.push(`attempt ${attempts}: ${verdict.issues.join("; ") || "failed the label check"}`); continue; }

      const ext = mime.includes("png") ? "png" : "jpg";
      const path = `scenes/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.${ext}`;
      const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
      const { error } = await opts.supabase.storage.from("marketing").upload(path, bytes, { contentType: mime, upsert: false });
      if (error) { issues.push(`attempt ${attempts}: upload failed: ${error.message}`); break; }
      const { data } = opts.supabase.storage.from("marketing").getPublicUrl(path);
      return { url: data?.publicUrl ?? null, attempts, issues };
    } catch (e) {
      issues.push(`attempt ${attempts}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { url: null, attempts, issues };
}
