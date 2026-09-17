# Minuto product reels (Remotion)

Renders a vertical 1080×1920 Instagram Reel for one WooCommerce coffee product.
Production renders run in `.github/workflows/render-reel.yml`; this folder is the
Remotion project it uses.

## How facts are built (`scripts/build-facts.mjs`)
- **Price, weight, roast, image**: read directly from the public WooCommerce Store API.
- **Titles, tasting notes, farm/producer/process**: extracted by Claude, then
  verified. Any value that does not appear word for word in the product text is
  dropped and logged. Scenes with no data are skipped, so the reel gets shorter
  instead of showing invented facts.
- Only products in a `פולי קפה` category are accepted (roasted specialty beans).
- `BRIEF_FACTS` (human-confirmed values from the dashboard) override extraction.

## Local use
```bash
cd video
npm ci
node scripts/build-facts.mjs --woo-id 82540 --badge "מהדורה מוגבלת" --out facts.json
npx remotion render src/index.jsx ProductReel reel.mp4 --props=facts.json
npm run studio   # live preview with the sample props
```
Set `ANTHROPIC_API_KEY` for extraction; without it the reel shows only the
deterministic facts.

## License
Remotion is free for for-profit companies with up to 3 employees (see
`node_modules/remotion/LICENSE.md`). Re-check before growing the team or
upgrading to Remotion 5.0.
