// Compositing helper — paste a real product photo (e.g. a Minuto bag,
// shot on a white background) onto a Gemini-generated scene. Solves the
// structural-fidelity problem we hit with text+reference-image generation:
// Gemini reliably reproduces atmosphere, light, and lifestyle context, but
// hallucinates bag shape/colour/label artwork no matter how strong the
// prompt is. Compositing fixes that — the bag in the output IS the bag
// in the source photo, pixel-for-pixel.
//
// White-background → alpha is done via simple color-keying with edge
// feathering. Works for product photos on clean white backgrounds (the
// existing minuto.co.il bag library qualifies). For more complex source
// material we'd need a real background-removal model; not needed here.
//
// Position and scale are fixed for v1 (lower-right third, ~34% of frame
// width). Variable positioning would require Gemini to also output bag
// region coordinates, which is unreliable — fixed-position keeps the
// compositor and the prompt in agreement by construction.

import { Image } from 'https://deno.land/x/imagescript@1.2.17/mod.ts'

// Pixels with all RGB channels >= this are made fully transparent.
// Tuned for product-shot white backgrounds — pure white pixels read as 254-255
// even after JPEG-style compression artifacts; threshold of 245 catches them
// without bleeding into the bag's actual lighter regions.
const WHITE_FULL_THRESHOLD = 245
// Pixels with all RGB in [SOFT, FULL) get a partial alpha — gives a 1-2 px
// soft edge so the composited bag doesn't have a hard pixelated outline.
const WHITE_SOFT_THRESHOLD = 220

// Region geometry for each composited object type. Each region is defined by:
//   - widthPct:     object's width as fraction of frame width
//   - centerXPct:   horizontal CENTER position (0=left edge, 1=right edge)
//   - centerYPct:   vertical CENTER position (0=top, 1=bottom)
// Geometry must match the prompt language that tells Gemini to leave this
// region empty. If you change either, change both, otherwise the object
// will land on top of a Gemini-hallucinated object.
export interface CompositeRegion {
  widthPct:    number
  centerXPct:  number
  centerYPct:  number
}

export const BAG_REGION: CompositeRegion = {
  widthPct:   0.46,   // bag occupies 46% of frame width — sized to dominate as the hero element (a coffee bag is much larger than a bean pile or cup in real life; previous 34% read as undersized next to Gemini's beans)
  centerXPct: 0.74,   // lower-right (74% from left, slightly inset to leave breathing room from edge)
  centerYPct: 0.70,   // anchored toward bottom
}

export const CUP_REGION: CompositeRegion = {
  widthPct:   0.28,   // cup is smaller than bag but larger than before — needs to read as substantial vs. surrounding beans
  centerXPct: 0.35,   // left-of-center
  centerYPct: 0.60,   // center-vertical, slightly lower
}

// Human-readable region descriptions for use in the Gemini prompt. Each
// describes the position language Gemini should respect when leaving the
// region empty for compositing. Geometry numbers MUST stay in sync with
// the CompositeRegion constants above.
export const BAG_REGION_PROMPT = `the LOWER-RIGHT area of the frame, occupying roughly 46% of the frame's width, centered around 74% from the left and 70% from the top`
export const CUP_REGION_PROMPT = `the CENTER-LEFT area of the frame, occupying roughly 28% of the frame's width, centered around 35% from the left and 60% from the top`

/**
 * Bilinear-interpolation resize. ImageScript 1.2.17's only working resize
 * mode is nearest-neighbor, which destroys text legibility at 3-4x
 * downscale. Pure-JS implementation here — slower than a native call but
 * acceptable (~200-400ms for a 384x384 output) and gives much sharper
 * text than nearest. Center-aligned sampling avoids the half-pixel shift
 * that simple `x * ratio` produces.
 */
function bilinearResize(src: Image, newWidth: number, newHeight: number): Image {
  const out = new Image(newWidth, newHeight)
  const xRatio = src.width  / newWidth
  const yRatio = src.height / newHeight
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcX = (x + 0.5) * xRatio - 0.5
      const srcY = (y + 0.5) * yRatio - 0.5
      const x0c = Math.floor(srcX)
      const y0c = Math.floor(srcY)
      const x0 = Math.max(0, Math.min(src.width  - 1, x0c))
      const x1 = Math.max(0, Math.min(src.width  - 1, x0c + 1))
      const y0 = Math.max(0, Math.min(src.height - 1, y0c))
      const y1 = Math.max(0, Math.min(src.height - 1, y0c + 1))
      const fx = srcX - x0c
      const fy = srcY - y0c
      // ImageScript getPixelAt is 1-indexed.
      const p00 = src.getPixelAt(x0 + 1, y0 + 1)
      const p10 = src.getPixelAt(x1 + 1, y0 + 1)
      const p01 = src.getPixelAt(x0 + 1, y1 + 1)
      const p11 = src.getPixelAt(x1 + 1, y1 + 1)
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx       * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx       * fy
      const r = Math.round(((p00 >>> 24) & 0xff) * w00 + ((p10 >>> 24) & 0xff) * w10 + ((p01 >>> 24) & 0xff) * w01 + ((p11 >>> 24) & 0xff) * w11)
      const g = Math.round(((p00 >>> 16) & 0xff) * w00 + ((p10 >>> 16) & 0xff) * w10 + ((p01 >>> 16) & 0xff) * w01 + ((p11 >>> 16) & 0xff) * w11)
      const b = Math.round(((p00 >>>  8) & 0xff) * w00 + ((p10 >>>  8) & 0xff) * w10 + ((p01 >>>  8) & 0xff) * w01 + ((p11 >>>  8) & 0xff) * w11)
      const a = Math.round(( p00         & 0xff) * w00 + ( p10         & 0xff) * w10 + ( p01         & 0xff) * w01 + ( p11         & 0xff) * w11)
      const color = ((r & 0xff) * 0x1000000 + (g & 0xff) * 0x10000 + (b & 0xff) * 0x100 + (a & 0xff)) >>> 0
      out.setPixelAt(x + 1, y + 1, color)
    }
  }
  return out
}

/**
 * Composite a product photo onto a generated scene at the configured region.
 *
 * @param sceneB64    base64-encoded scene image returned by Gemini
 * @param productUrl  URL to the product photo (white background, PNG or JPEG)
 * @param region      where to place it (geometry as fractions of frame size)
 * @returns           base64-encoded JPEG of the composited result
 */
export async function compositeProductIntoScene(
  sceneB64: string,
  productUrl: string,
  region: CompositeRegion = BAG_REGION,
): Promise<{ b64: string; mime: string }> {
  const sceneBuf = Uint8Array.from(atob(sceneB64), c => c.charCodeAt(0))
  const scene = await Image.decode(sceneBuf)

  const res = await fetch(productUrl)
  if (!res.ok) throw new Error(`compositor: product fetch ${res.status} for ${productUrl}`)
  const productBuf = new Uint8Array(await res.arrayBuffer())
  const product = await Image.decode(productBuf)

  // Pipeline order MATTERS:
  //   1. Resize the product FIRST at its native white background (bilinear).
  //   2. Color-key the resized result.
  // The reverse order — color-key first, resize second — creates a dark
  // halo around the silhouette because resize interpolates between opaque
  // white pixels and transparent-black pixels, producing semi-transparent
  // grey/black edges. Color-keying AFTER resize avoids that: edge pixels
  // are interpolated between white-and-white-ish (no dark contamination),
  // then the white→alpha pass cleanly removes them.
  const targetWidth = Math.round(scene.width * region.widthPct)
  const aspect = product.width / product.height
  const targetHeight = Math.round(targetWidth / aspect)
  const resized = bilinearResize(product, targetWidth, targetHeight)

  // Background removal via 4-corner flood-fill. The previous approach —
  // simple threshold-based color-keying — treated the bag's WHITE
  // INTERIOR (the pouch material, which is also near-white) the same as
  // the white background, making the bag partially see-through. Flood-
  // fill from the corners marks only pixels that are *connected* to the
  // edges via near-white chains. The bag's enclosed white interior is
  // not connected to the corners, so it stays fully opaque. Bag-shaped
  // alpha mask, exactly what we need.
  const w = resized.width
  const h = resized.height
  const isBg = new Uint8Array(w * h)
  // Threshold: pixel is "background-like" if its darkest channel ≥ this.
  // 200 captures the soft anti-aliased edge of the white backdrop without
  // eating into the bag's actual border.
  const BG_THRESHOLD = 200
  const stack: number[] = []
  const pushIfBg = (px: number, py: number) => {
    if (px < 0 || px >= w || py < 0 || py >= h) return
    const idx = py * w + px
    if (isBg[idx]) return
    const pixel = resized.getPixelAt(px + 1, py + 1)
    const r = (pixel >>> 24) & 0xff
    const g = (pixel >>> 16) & 0xff
    const b = (pixel >>> 8)  & 0xff
    if (Math.min(r, g, b) >= BG_THRESHOLD) {
      isBg[idx] = 1
      stack.push(idx)
    }
  }
  pushIfBg(0,     0)
  pushIfBg(w - 1, 0)
  pushIfBg(0,     h - 1)
  pushIfBg(w - 1, h - 1)
  // DFS expand (pointer-based; queue.shift is O(n) so we'd avoid it; stack pop is O(1)).
  while (stack.length > 0) {
    const idx = stack.pop()!
    const x = idx % w
    const y = (idx - x) / w
    pushIfBg(x - 1, y)
    pushIfBg(x + 1, y)
    pushIfBg(x, y - 1)
    pushIfBg(x, y + 1)
  }

  // Apply the mask: background → fully transparent. Bag interior → keep
  // as-is. Edge pixels (bag pixels adjacent to background) get partial
  // alpha based on their brightness for clean anti-aliasing — the lighter
  // the pixel, the more transparent (treats the resize-blurred edge as a
  // natural soft cutout).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (isBg[idx]) {
        resized.setPixelAt(x + 1, y + 1, 0x00000000)
        continue
      }
      // Detect whether this bag pixel is on the silhouette edge.
      const isEdge =
        (x > 0     && isBg[idx - 1])     ||
        (x < w - 1 && isBg[idx + 1])     ||
        (y > 0     && isBg[idx - w])     ||
        (y < h - 1 && isBg[idx + w])
      if (!isEdge) continue
      const pixel = resized.getPixelAt(x + 1, y + 1)
      const r = (pixel >>> 24) & 0xff
      const g = (pixel >>> 16) & 0xff
      const b = (pixel >>> 8)  & 0xff
      const a = pixel & 0xff
      const minRGB = Math.min(r, g, b)
      // Soft edge: minRGB=255 → alpha=0 (effectively background-coloured),
      // minRGB=200 → alpha=255 (fully opaque). Linear in between.
      const t = Math.max(0, Math.min(1, (255 - minRGB) / 55))
      const newAlpha = Math.round(a * t)
      resized.setPixelAt(x + 1, y + 1, (pixel & 0xffffff00) | newAlpha)
    }
  }

  // Directional light gradient — the bag was shot under flat studio light;
  // the Gemini scene has hard upper-right light. Apply a SUBTLE darkening
  // gradient where the lower-left of the bag gets multiplied down a bit,
  // while the upper-right stays at full brightness. Subtlety matters here:
  // 0.72 was too aggressive (read as a dirty/uneven bag); 0.88 is enough
  // directional cue without obvious "stripe of darker" on the bag body.
  const SHADOW_SIDE_FACTOR = 0.88   // multiplier at lower-left corner
  const rw = resized.width
  const rh = resized.height
  for (let gy = 1; gy <= rh; gy++) {
    for (let gx = 1; gx <= rw; gx++) {
      const pixel = resized.getPixelAt(gx, gy)
      const a = pixel & 0xff
      if (a === 0) continue
      // Position normalized 0-1 within the bag bounds.
      const px = (gx - 1) / rw
      const py = (gy - 1) / rh
      // "How upper-right is this pixel?" — diagonal mix of (x-from-left) and
      // (1 - y-from-top). Range [0, 1]: 0=lower-left, 1=upper-right.
      const upperRightness = (px + (1 - py)) / 2
      const factor = SHADOW_SIDE_FACTOR + (1 - SHADOW_SIDE_FACTOR) * upperRightness
      const r = Math.round(((pixel >>> 24) & 0xff) * factor)
      const g = Math.round(((pixel >>> 16) & 0xff) * factor)
      const b = Math.round(((pixel >>>  8) & 0xff) * factor)
      const color = ((r & 0xff) * 0x1000000 + (g & 0xff) * 0x10000 + (b & 0xff) * 0x100 + (a & 0xff)) >>> 0
      resized.setPixelAt(gx, gy, color)
    }
  }

  // Composite position from the configured region — centerX/Y are the CENTER
  // of the object as fractions of frame size; we convert to top-left for
  // ImageScript's 1-indexed composite() call.
  const x = Math.round(scene.width  * region.centerXPct - targetWidth  / 2) + 1
  const y = Math.round(scene.height * region.centerYPct - targetHeight / 2) + 1

  // Build a soft drop shadow from the resized product's alpha silhouette
  // and composite it BEFORE the product itself. Light direction matches
  // the Minuto identity (hard upper-right light), so the shadow falls
  // toward the lower-left.
  const shadow = resized.clone()
  for (let sy = 1; sy <= shadow.height; sy++) {
    for (let sx = 1; sx <= shadow.width; sx++) {
      const pixel = shadow.getPixelAt(sx, sy)
      const a = pixel & 0xff
      if (a > 0) {
        // Black RGB with alpha scaled to ~50% of the bag's local alpha
        // (split between original 45% and overshot 60%). Visible but not
        // dominating — shadow should ground the bag, not pull the eye.
        shadow.setPixelAt(sx, sy, Math.round(a * 0.50))
      }
    }
  }
  // Moderate blur via 4x downscale + upscale (between original 3x and
  // overshot 5x). Soft falloff without the shadow becoming a visible
  // feature in itself.
  const sw = Math.max(2, Math.floor(shadow.width  / 4))
  const sh = Math.max(2, Math.floor(shadow.height / 4))
  shadow.resize(sw, sh)
  shadow.resize(targetWidth, targetHeight)

  // Shadow offset: lower-left of bag position, matching upper-right light.
  // 0.018/0.022 — between original 0.012/0.018 and overshot 0.025/0.030.
  // Enough offset to be visible without making the shadow itself read as
  // an artifact.
  const shadowDx = -Math.round(scene.width  * 0.018)
  const shadowDy =  Math.round(scene.height * 0.022)
  scene.composite(shadow,  x + shadowDx, y + shadowDy)
  scene.composite(resized, x, y)

  // Re-encode as JPEG — smaller than PNG, IG-friendly, plenty of quality.
  const outBuf = await scene.encodeJPEG(92)
  let bin = ''
  for (let i = 0; i < outBuf.length; i += 0x8000) {
    bin += String.fromCharCode(...outBuf.subarray(i, i + 0x8000))
  }
  return { b64: btoa(bin), mime: 'image/jpeg' }
}
