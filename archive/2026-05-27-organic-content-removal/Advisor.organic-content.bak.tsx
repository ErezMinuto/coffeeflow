/*
 * ARCHIVED — DO NOT EDIT. Reference only.
 *
 * Removed from: dashboard/src/pages/Advisor.tsx
 * Date:         2026-05-27
 * Reason:       organic-content agent retired (replaced by organic-orchestrator
 *               + workers + /admin/seo-agent dashboard). See PRs #95-98 for
 *               the retirement sequence.
 *
 * Contents extracted verbatim from Advisor.tsx (line ranges as of pre-removal):
 *   - PostToPublish interface             (was lines 114-125)
 *   - GoogleOrganicRec interface          (was lines 150-159)
 *   - AdditionalSlide interface           (was lines 172-176)
 *   - EnrichedPost interface              (was lines 178-203)
 *   - OrganicReport interface             (was lines 205-214)
 *   - CarouselControls component          (was lines 1145-1404)
 *   - PostPublishingControls component    (was lines 1413-1753)
 *   - OrganicPanel component              (was lines 1757-2188)
 *   - writeBlogPost / generateBanner helpers + their state hooks
 *     (was inside main component, ~2322-2800)
 *
 * Imports + helper function references inside the extracted code will NOT
 * resolve here — this file is reference material, not compilable. The
 * surrounding main component's React state hooks (blogState, allProducts,
 * etc.) lived in Advisor.tsx; restoring would require re-adding those.
 *
 * If you need this restored: cherry-pick the relevant pieces back into
 * Advisor.tsx, re-import the lucide-react icons that were used, restore
 * the `organic_content` agent_type in the type unions, and restore the
 * organic-content agent handling in marketing-advisor (also archived in
 * marketing-advisor.organic-blocks.bak.ts next to this file).
 */

// ──────────────────────────────────────────────────────────────────────
// PART 1 — Type interfaces
// ──────────────────────────────────────────────────────────────────────

interface PostToPublish {
  type: string
  intent?: 'save' | 'share' | 'behind_the_scenes' | string
  topic: string
  best_day: string
  best_time: string
  caption: string
  hashtags: string[]
  hook: string
  visual_direction: string
  why_this_intent?: string
}

interface GoogleOrganicRec {
  keyword: string
  current_position: number
  search_volume_signal: string
  content_type: 'blog_post' | 'landing_page' | 'product_page' | 'faq_page'
  suggested_title: string
  key_points: string[]
  why_now: string
  estimated_difficulty: 'קל' | 'בינוני' | 'קשה'
}

// Enrichment output from marketing-advisor/enrichment.ts. Each post in
// posts_to_publish gets a matching entry by post_index. The IG-publishing
// pipeline (visual-test → meta-publish) reads from this shape.
interface AdditionalSlide {
  scene_brief:  string
  overlay_text: string | null
  image_url:    string | null
}

interface EnrichedPost {
  post_index:           number
  intent:               string
  post_type:            string
  aspect:               'feed_square' | 'reel_cover'
  upstream_type:        string
  calendar_hook:        string
  scene_brief:          string
  overlay_text:         string | null
  scheduled_for:        string
  caption:              string
  hashtags:             string[]
  image_url:            string | null
  // Carousel-only: slides 2..N. Slide 1 (the cover) is the scene_brief
  // above. Total slides in the carousel = 1 + additional_slides.length.
  additional_slides?:   AdditionalSlide[]
  product_reference?:   string | null   // product name Haiku detected, e.g. "Dark Chocolate"
  reference_image_url?: string | null   // matched woo_products bag image, drives visual-test
  // Render strategy chosen by the enrichment agent. 'no_bag' → bag-free
  // editorial scene; routed to visual-test (Gemini Image) with
  // use_reference:false — Gemini natively accepts the equipment
  // reference photos (roaster, Strada) so rendered hardware matches
  // Minuto's actual gear. Missing/'bag_hero' → existing behavior
  // (gemini/vertex toggle, bag composited byte-perfect via Vertex).
  render_mode?:         'bag_hero' | 'no_bag'
}

interface OrganicReport {
  summary: string
  account_health: { avg_reach_30d: number; follower_count: number; best_post_type: string; engagement_rate_pct: number }
  google_organic_recommendations: GoogleOrganicRec[]
  content_recommendations: { priority: number; content_type: string; topic: string; reason: string; best_day: string; best_time: string }[]
  products_to_feature: { product: string; reason: string; content_angle: string }[]
  posts_to_publish: PostToPublish[]
  enriched_posts?: EnrichedPost[]
  key_insights: string[]
}

// ──────────────────────────────────────────────────────────────────────
// PART 2 — CarouselControls (was lines 1145-1404)
// ──────────────────────────────────────────────────────────────────────

function CarouselControls({ ep }: { ep: EnrichedPost }) {
  // Build the unified slides array. Slide 0 is the cover (= ep.scene_brief).
  const slides = [
    { scene_brief: ep.scene_brief, overlay_text: ep.overlay_text },
    ...(ep.additional_slides ?? []).map(s => ({ scene_brief: s.scene_brief, overlay_text: s.overlay_text })),
  ]
  const N = slides.length

  const [imageUrls,   setImageUrls]   = useState<(string | null)[]>(new Array(N).fill(null))
  const [generating,  setGenerating]  = useState<boolean[]>(new Array(N).fill(false))
  const [genErrors,   setGenErrors]   = useState<(string | null)[]>(new Array(N).fill(null))
  const [publishing,  setPublishing]  = useState(false)
  const [publishedTo, setPublishedTo] = useState<string | null>(null)
  const [pubError,    setPubError]    = useState<string | null>(null)
  const [renderPipeline, setRenderPipeline] = useRenderPipeline()
  // Editable caption — seeded from the agent's caption; user can refine
  // before publishing. Local-only (refresh discards). Hashtags stay
  // read-only and are appended automatically at publish time.
  const [caption, setCaption] = useState<string>(ep.caption)

  // Set a single index in an array-state in an immutable way.
  const setAt = <T,>(setter: React.Dispatch<React.SetStateAction<T[]>>) => (i: number, v: T) =>
    setter(prev => { const next = [...prev]; next[i] = v; return next })

  const setUrl  = setAt(setImageUrls)
  const setGen  = setAt(setGenerating)
  const setErr  = setAt(setGenErrors)

  async function generateSlide(i: number) {
    setGen(i, true); setErr(i, null); setUrl(i, null)
    try {
      // 1. Generate the photographic background.
      //    bag_hero slides → vertex-imagen-edit (byte-perfect bag composite;
      //      Gemini hallucinates bag text — was the source of the
      //      "Yirgachoffe / Doye Benos / Fasenda BertSo" incident,
      //      2026-05-23).
      //    no_bag slides   → visual-test with use_reference:false. Same
      //      logic as the single-image generateVisual: Gemini Image
      //      natively accepts the roaster / Strada reference photos, so
      //      the rendered equipment matches Minuto's actual gear instead
      //      of Imagen 4's text-only guesses. Carousels are currently
      //      disabled upstream but keeping the routing consistent for
      //      when they're re-enabled.
      const noBag    = ep.render_mode === 'no_bag'
      const renderFn = noBag ? 'visual-test' : 'vertex-imagen-edit'
      const gen = await supabase.functions.invoke(renderFn, {
        body: noBag
          ? {
              scene_brief:   slides[i].scene_brief,
              aspect:        ep.aspect,
              use_reference: false,
            }
          : {
              scene_brief:         slides[i].scene_brief,
              aspect:              ep.aspect,
              // Same product reference for every slide so the bag (when shown)
              // is always the matched product across the whole carousel.
              reference_image_url: ep.reference_image_url || undefined,
            },
      })
      if (gen.error) throw gen.error
      if (!gen.data?.url) throw new Error(`${renderFn} returned no url`)
      let finalUrl: string = gen.data.url

      // 2. If this slide has an overlay_text, composite it via visual-overlay.
      //    Falls back to the bare image if the overlay step fails — better
      //    to publish a no-text version than nothing.
      const overlayText = slides[i].overlay_text
      if (overlayText && overlayText.trim()) {
        try {
          const ov = await supabase.functions.invoke('visual-overlay', {
            body: {
              image_url:    finalUrl,
              overlay_text: overlayText,
              position:     'bottom',
              direction:    'rtl',
              aspect:       ep.aspect,
            },
          })
          if (ov.error) throw ov.error
          if (ov.data?.url) finalUrl = ov.data.url
        } catch (oe: any) {
          console.warn(`[carousel] overlay failed for slide ${i}, using bare image:`, oe?.message)
        }
      }

      setUrl(i, finalUrl)
    } catch (e: any) {
      setErr(i, e?.message ?? String(e))
    } finally {
      setGen(i, false)
    }
  }

  async function generateAll() {
    // Trigger all in parallel; useState batching keeps this clean.
    await Promise.all(slides.map((_, i) => generateSlide(i)))
  }

  const allReady = imageUrls.every(u => !!u)

  async function publishCarousel() {
    if (!allReady) return
    setPublishing(true); setPubError(null); setPublishedTo(null)
    try {
      // The bare body comes from local state (`caption`) so any edits the
      // user made in the textarea above are honored. Hashtags are still
      // appended from the agent's read-only list.
      const fullCaption = `${caption}\n\n${(ep.hashtags ?? []).join(' ')}`.trim()
      // meta-publish carousel branch builds child + parent containers per the
      // IG Graph API two-step flow. Single-shot via publish_now so the page
      // token from /me/accounts is reused end-to-end (see publishToInstagram
      // comment for the Meta 100/33 trap if you split prepare/publish).
      const pub = await supabase.functions.invoke('meta-publish', {
        body: {
          action:   'publish_now',
          type:     'carousel',
          children: imageUrls.map(u => ({ image_url: u! })),
          caption: fullCaption,
        },
      })
      if (pub.error) throw pub.error
      const link = pub.data?.permalink
      if (!link) throw new Error(`publish returned no permalink: ${JSON.stringify(pub.data).slice(0, 200)}`)
      setPublishedTo(link)
    } catch (e: any) {
      setPubError(e?.message ?? String(e))
    } finally {
      setPublishing(false)
    }
  }

  const anyGenerating = generating.some(g => g)

  return (
    <div className="mt-2 border-t border-surface-200 pt-2 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[10px] uppercase tracking-wide text-surface-500 font-semibold">
          🎨 קרוסל — {N} שקפים
        </div>
        <div className="text-[11px] text-surface-600">
          <span className="font-semibold">סוג סצנה:</span> {ep.post_type}
          {ep.render_mode === 'no_bag' && (
            <span className="mr-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">ללא שקית</span>
          )}
          {' '}· <span className="font-semibold">רגע:</span> {ep.calendar_hook} · <span className="font-semibold">מתוזמן:</span> {ep.scheduled_for}
        </div>
      </div>
      {ep.product_reference && (
        <div className={`text-[11px] ${ep.reference_image_url ? 'text-emerald-700' : 'text-surface-500'}`}>
          <span className="font-semibold">מוצר רפרנס:</span> {ep.product_reference}{' '}
          {ep.reference_image_url ? '✓ נמצאה תמונה' : '⚠ לא נמצאה במלאי, ייווצר מהשקית הדיפולטית'}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {slides.map((s, i) => (
          <div key={i} className="bg-surface-50 border border-surface-200 rounded-lg p-2 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-surface-700">
                {i === 0 ? 'שקף 1 — כריכה' : `שקף ${i + 1}`}
              </div>
              <button
                onClick={() => generateSlide(i)}
                disabled={generating[i] || publishing}
                className="text-[10px] px-2 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-surface-300 disabled:cursor-not-allowed"
              >
                {generating[i] ? '...' : (imageUrls[i] ? '🔄' : '🎨')}
              </button>
            </div>
            <details className="text-[11px]">
              <summary className="cursor-pointer text-surface-500 hover:text-surface-700">📷 תקציר</summary>
              <p className="mt-1 p-1.5 bg-white rounded text-surface-700 leading-relaxed">{s.scene_brief}</p>
            </details>
            {s.overlay_text && (
              <div className="text-[10px] text-amber-700"><span className="font-semibold">טקסט-על:</span> {s.overlay_text}</div>
            )}
            {imageUrls[i] && (
              <a href={imageUrls[i]!} target="_blank" rel="noopener noreferrer">
                <img
                  src={imageUrls[i]!}
                  alt={`Slide ${i + 1}`}
                  className="w-full rounded border border-surface-200"
                  style={{ aspectRatio: ep.aspect === 'reel_cover' ? '9/16' : '1/1', objectFit: 'cover' }}
                />
              </a>
            )}
            {genErrors[i] && (
              <div className="text-[10px] text-red-700 bg-red-50 border border-red-200 rounded p-1">
                {genErrors[i]}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-1" dir="rtl">
        <label className="text-[11px] text-surface-600 font-semibold flex items-center justify-between">
          <span>גוף הפוסט (ניתן לעריכה לפני פרסום)</span>
          {caption !== ep.caption && (
            <button
              type="button"
              onClick={() => setCaption(ep.caption)}
              className="text-[10px] text-indigo-600 hover:text-indigo-800 font-normal"
            >
              ↺ החזר למקור
            </button>
          )}
        </label>
        <textarea
          value={caption}
          onChange={e => setCaption(e.target.value)}
          dir="rtl"
          rows={8}
          className="w-full text-[12px] leading-relaxed border border-surface-300 rounded p-2 font-sans focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        />
        <div className="text-[10px] text-surface-500 flex justify-between">
          <span>{caption.length} תווים</span>
          <span>האשטגים נוספים אוטומטית: {(ep.hashtags ?? []).length}</span>
        </div>
      </div>

      {pubError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          שגיאה בפרסום: {pubError}
        </div>
      )}
      {publishedTo && (
        <div className="text-xs text-green-800 bg-green-50 border border-green-200 rounded p-2">
          ✅ פורסם בהצלחה!{' '}
          <a href={publishedTo} target="_blank" rel="noopener noreferrer" className="underline">
            פתח באינסטגרם
          </a>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <RenderPipelineToggle pipeline={renderPipeline} onChange={setRenderPipeline} />
        <button
          onClick={generateAll}
          disabled={anyGenerating || publishing}
          className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-surface-300 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {anyGenerating
            ? (<><Loader2 className="w-3 h-3 animate-spin" /> מייצר את כל השקפים...</>)
            : '🎨 צור את כל השקפים'}
        </button>
        <button
          onClick={publishCarousel}
          disabled={!allReady || publishing || anyGenerating || !!publishedTo}
          className="text-xs px-3 py-1.5 rounded bg-rose-600 text-white hover:bg-rose-700 disabled:bg-surface-300 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {publishing
            ? (<><Loader2 className="w-3 h-3 animate-spin" /> מפרסם קרוסל...</>)
            : '📤 פרסם כקרוסל'}
        </button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// PART 3 — PostPublishingControls (was lines 1413-1753)
// ──────────────────────────────────────────────────────────────────────

function PostPublishingControls({ ep }: { ep: EnrichedPost }) {
  // Multi-slide carousels have their own component (separate state + UI).
  // Detect early before any hooks so we don't violate rules-of-hooks if we
  // ever conditionally bail out.
  const isCarousel = (ep.additional_slides ?? []).length > 0
  if (isCarousel) {
    return <CarouselControls ep={ep} />
  }

  const [imageUrl,    setImageUrl]    = useState<string | null>(ep.image_url)
  const [generating,  setGenerating]  = useState(false)
  const [genError,    setGenError]    = useState<string | null>(null)
  const [publishing,  setPublishing]  = useState(false)
  const [publishedTo, setPublishedTo] = useState<string | null>(null)
  const [pubError,    setPubError]    = useState<string | null>(null)
  const [renderPipeline, setRenderPipeline] = useRenderPipeline()
  // Reel state — Veo image-to-video, polled async (1–3 min typical)
  const [videoUrl,        setVideoUrl]        = useState<string | null>(null)
  const [reelOperation,   setReelOperation]   = useState<string | null>(null)
  const [reelGenerating,  setReelGenerating]  = useState(false)
  const [reelError,       setReelError]       = useState<string | null>(null)
  // Editable caption — seeded from the agent's caption; user can refine
  // before publishing. Local-only (refresh discards). Hashtags stay
  // read-only and are appended automatically at publish time.
  const [caption,         setCaption]         = useState<string>(ep.caption)
  // The post is Reel-shaped if its aspect is 9:16. Only those get the
  // Generate Reel button — feed posts (1:1) skip the video pipeline.
  const isReelType = ep.aspect === 'reel_cover'

  // Poll Veo every 5s while a job is running. Stops when the status function
  // returns done/error or the component unmounts. Cancels via a ref so a new
  // job started before the old finishes doesn't keep two pollers running.
  useEffect(() => {
    if (!reelOperation) return
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('meta-reel-status', {
          body: { operation: reelOperation },
        })
        if (cancelled) return
        if (error) throw error
        if (data?.status === 'done' && data.video_url) {
          setVideoUrl(data.video_url)
          setReelOperation(null)
          setReelGenerating(false)
          return
        }
        if (data?.status === 'error') {
          setReelError(data.error ?? 'unknown error')
          setReelOperation(null)
          setReelGenerating(false)
          return
        }
        // pending → poll again
        timer = setTimeout(poll, 5000) as unknown as number
      } catch (e: any) {
        if (cancelled) return
        setReelError(e?.message ?? String(e))
        setReelOperation(null)
        setReelGenerating(false)
      }
    }
    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [reelOperation])

  async function generateVisual() {
    setGenerating(true); setGenError(null); setImageUrl(null)
    setVideoUrl(null); setReelOperation(null); setReelError(null)
    try {
      // 1. Generate the photographic background.
      //    bag_hero → goes through RenderPipelineToggle (Gemini visual-test
      //      default / Vertex composite for byte-perfect bag text).
      //    no_bag  → routed to visual-test with use_reference:false. Gemini
      //      Image natively accepts the equipment reference photos
      //      (MINUTO_ROASTER_REFERENCE_URL, MINUTO_ESPRESSO_MACHINE_REFERENCE_URL),
      //      so the rendered roaster / Strada match Minuto's actual gear.
      //      Previously this routed to vertex-imagen-edit (Imagen 4
      //      text-to-image), which was structurally blind to those
      //      references — Imagen rendered generic Probat-style copper
      //      roasters from text alone. Switched 2026-05-26 after the
      //      empirical comparison showed Gemini-image is the only path
      //      that can lock the equipment shape.
      const noBag    = ep.render_mode === 'no_bag'
      const renderFn = noBag ? 'visual-test' : RENDER_FN[renderPipeline]
      const gen = await supabase.functions.invoke(renderFn, {
        body: noBag
          ? {
              scene_brief:   ep.scene_brief,
              aspect:        ep.aspect,
              // Skip the bag entirely — visual-test gets the equipment refs
              // it needs from MINUTO_ROASTER_REFERENCE_URL /
              // MINUTO_ESPRESSO_MACHINE_REFERENCE_URL inside the function
              // (attached based on regex match against the scene_brief).
              use_reference: false,
            }
          : {
              scene_brief: ep.scene_brief,
              aspect: ep.aspect,
              // Per-post bag reference — when the post is about a specific product
              // (e.g. Dark Chocolate), the agent matched it to a woo_products row
              // and we feed THAT bag image to Gemini instead of the default. Falls
              // back to the locked Yirgacheffe bag if not set.
              reference_image_url: ep.reference_image_url || undefined,
            },
      })
      if (gen.error) throw gen.error
      if (!gen.data?.url) throw new Error(`${renderFn} returned no url`)
      let finalUrl: string = gen.data.url

      // 2. If the post has overlay_text, composite it via visual-overlay.
      //    Falls back to bare image on failure — better to ship something.
      if (ep.overlay_text && ep.overlay_text.trim()) {
        try {
          const ov = await supabase.functions.invoke('visual-overlay', {
            body: {
              image_url:    finalUrl,
              overlay_text: ep.overlay_text,
              position:     'bottom',
              direction:    'rtl',
              aspect:       ep.aspect,
            },
          })
          if (ov.error) throw ov.error
          if (ov.data?.url) finalUrl = ov.data.url
        } catch (oe: any) {
          console.warn('[single-image] overlay failed, using bare image:', oe?.message)
        }
      }

      setImageUrl(finalUrl)
    } catch (e: any) {
      setGenError(e?.message ?? String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function generateReel() {
    if (!imageUrl) return
    setReelGenerating(true); setReelError(null); setVideoUrl(null)
    try {
      // Pull a Veo-friendly motion description from the scene_brief — it's
      // already photographic/cinematic prose, ideal as the motion prompt.
      // Veo 2 silently outputs ~5s of subtle motion driven by this text.
      const motionPrompt =
        `Slow gentle cinematic motion: ${ep.scene_brief.slice(0, 600)}. ` +
        `Subtle, premium, no people, no text, no animation of the bag itself. ` +
        `Faint atmosphere — steam wisps, soft light shift, light breeze. 5 seconds.`
      const { data, error } = await supabase.functions.invoke('meta-reel-generate', {
        body: {
          image_url:     imageUrl,
          motion_prompt: motionPrompt,
          aspect:        'reel_9_16',
          duration_sec:  5,
        },
      })
      if (error) throw error
      const op = data?.operation
      if (!op) throw new Error(`no operation id returned: ${JSON.stringify(data).slice(0, 200)}`)
      setReelOperation(op)   // useEffect kicks in and starts polling every 5s
    } catch (e: any) {
      setReelError(e?.message ?? String(e))
      setReelGenerating(false)
    }
  }

  async function publishToInstagram() {
    if (!imageUrl && !videoUrl) return
    setPublishing(true); setPubError(null); setPublishedTo(null)
    try {
      // Mode is decided by what we have: if a Veo video was generated, ship as
      // a Reel (the cover frame becomes the in-grid thumbnail Meta picks from
      // the video). Otherwise ship as a feed post with the still.
      const mode = videoUrl ? 'reel' : 'feed'
      // The bare body comes from local state (`caption`) so any edits the
      // user made in the textarea above are honored. Hashtags are still
      // appended from the agent's read-only list.
      const fullCaption = `${caption}\n\n${(ep.hashtags ?? []).join(' ')}`.trim()
      // Single-shot publish: prepare+publish in one edge-function invocation so
      // the page token from /me/accounts is reused end-to-end. Splitting them
      // across two invocations triggered Meta error 100/33 because /me/accounts
      // mints a fresh page token per call and containers are bound to the token
      // that created them.
      const pub = await supabase.functions.invoke('meta-publish', {
        body: mode === 'reel'
          ? { action: 'publish_now', type: 'reel', video_url: videoUrl, caption: fullCaption }
          : { action: 'publish_now', type: 'feed', image_url: imageUrl, caption: fullCaption },
      })
      if (pub.error) throw pub.error
      const link = pub.data?.permalink
      if (!link) throw new Error(`publish returned no permalink: ${JSON.stringify(pub.data).slice(0, 200)}`)
      setPublishedTo(link)
    } catch (e: any) {
      setPubError(e?.message ?? String(e))
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="mt-2 border-t border-surface-200 pt-2 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-surface-500 font-semibold">
        🎨 פוסט מועשר ({ep.aspect === 'reel_cover' ? 'תמונת כריכה לריל' : 'פוסט פיד'})
      </div>
      <div className="text-[11px] text-surface-600 space-y-1">
        <div>
          <span className="font-semibold">סוג סצנה:</span> {ep.post_type}
          {ep.render_mode === 'no_bag' && (
            <span className="mr-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">ללא שקית</span>
          )}
          {' '}· <span className="font-semibold">רגע:</span> {ep.calendar_hook}
        </div>
        <div><span className="font-semibold">מתוזמן:</span> {ep.scheduled_for}</div>
        {ep.overlay_text && (
          <div className="text-amber-700"><span className="font-semibold">טקסט על התמונה:</span> {ep.overlay_text}</div>
        )}
        {ep.product_reference && (
          <div className={ep.reference_image_url ? 'text-emerald-700' : 'text-surface-500'}>
            <span className="font-semibold">מוצר רפרנס:</span> {ep.product_reference}{' '}
            {ep.reference_image_url ? '✓ נמצאה תמונה' : '⚠ לא נמצאה במלאי, ייווצר מהשקית הדיפולטית'}
          </div>
        )}
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-surface-500 hover:text-surface-700">📷 תקציר הצלם (English)</summary>
        <p className="mt-1 p-2 bg-surface-50 rounded text-surface-700 leading-relaxed">{ep.scene_brief}</p>
      </details>

      {videoUrl ? (
        <video
          src={videoUrl}
          controls
          className="w-full rounded-lg border border-surface-200 mt-1"
          style={{ aspectRatio: '9/16', objectFit: 'cover', maxHeight: 480 }}
        />
      ) : imageUrl ? (
        <a href={imageUrl} target="_blank" rel="noopener noreferrer">
          <img
            src={imageUrl}
            alt="Generated IG visual"
            className="w-full rounded-lg border border-surface-200 mt-1"
            style={{ aspectRatio: ep.aspect === 'reel_cover' ? '9/16' : '1/1', objectFit: 'cover' }}
          />
        </a>
      ) : null}

      {genError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          שגיאה ביצירת תמונה: {genError}
        </div>
      )}
      {reelError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          שגיאה ביצירת ריל: {reelError}
        </div>
      )}
      {pubError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          שגיאה בפרסום: {pubError}
        </div>
      )}
      {reelOperation && reelGenerating && (
        <div className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded p-2 flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          Veo מייצר ריל (1-3 דקות)... מעדכן אוטומטית כשמסתיים.
        </div>
      )}
      {publishedTo && (
        <div className="text-xs text-green-800 bg-green-50 border border-green-200 rounded p-2">
          ✅ פורסם בהצלחה!{' '}
          <a href={publishedTo} target="_blank" rel="noopener noreferrer" className="underline">
            פתח באינסטגרם
          </a>
        </div>
      )}

      <div className="space-y-1" dir="rtl">
        <label className="text-[11px] text-surface-600 font-semibold flex items-center justify-between">
          <span>גוף הפוסט (ניתן לעריכה לפני פרסום)</span>
          {caption !== ep.caption && (
            <button
              type="button"
              onClick={() => setCaption(ep.caption)}
              className="text-[10px] text-indigo-600 hover:text-indigo-800 font-normal"
            >
              ↺ החזר למקור
            </button>
          )}
        </label>
        <textarea
          value={caption}
          onChange={e => setCaption(e.target.value)}
          dir="rtl"
          rows={8}
          className="w-full text-[12px] leading-relaxed border border-surface-300 rounded p-2 font-sans focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        />
        <div className="text-[10px] text-surface-500 flex justify-between">
          <span>{caption.length} תווים</span>
          <span>האשטגים נוספים אוטומטית: {(ep.hashtags ?? []).length}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <RenderPipelineToggle pipeline={renderPipeline} onChange={setRenderPipeline} />
        <button
          onClick={generateVisual}
          disabled={generating || publishing || reelGenerating}
          className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-surface-300 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {generating
            ? (<><Loader2 className="w-3 h-3 animate-spin" /> מייצר תמונה...</>)
            : (imageUrl ? '🔄 צור תמונה מחדש' : '🎨 צור תמונה')}
        </button>
        {isReelType && (
          <button
            onClick={generateReel}
            disabled={!imageUrl || reelGenerating || generating || publishing}
            title={!imageUrl ? 'צור קודם תמונת כריכה' : 'הפוך את התמונה לריל של 5 שניות (Veo, 1-3 דקות)'}
            className="text-xs px-3 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:bg-surface-300 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {reelGenerating
              ? (<><Loader2 className="w-3 h-3 animate-spin" /> Veo רץ...</>)
              : (videoUrl ? '🔄 צור ריל מחדש' : '🎬 הפוך לריל')}
          </button>
        )}
        <button
          onClick={publishToInstagram}
          disabled={(!imageUrl && !videoUrl) || publishing || generating || reelGenerating || !!publishedTo}
          className="text-xs px-3 py-1.5 rounded bg-rose-600 text-white hover:bg-rose-700 disabled:bg-surface-300 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {publishing
            ? (<><Loader2 className="w-3 h-3 animate-spin" /> מפרסם...</>)
            : (videoUrl ? '📤 פרסם כריל' : '📤 פרסם פוסט פיד')}
        </button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// PART 4 — OrganicPanel (was lines 1757-2188)
// ──────────────────────────────────────────────────────────────────────

function OrganicPanel({ row, blogState, setBlogState, writeBlogPost, generateBanner, allProducts, onRun, running }: {
  row: AdvisorReport | null
  blogState: Record<string, { loading: boolean; post: BlogPost | null; error?: string; selectedProducts?: string[]; bannerReferenceProduct?: string; bannerLoading?: boolean }>
  setBlogState: React.Dispatch<React.SetStateAction<Record<string, { loading: boolean; post: BlogPost | null; error?: string; selectedProducts?: string[]; customProductText?: string; bannerReferenceProduct?: string; bannerLoading?: boolean }>>>
  writeBlogPost: (rec: GoogleOrganicRec, selectedProducts: string[]) => void
  generateBanner: (keyword: string, title: string) => void
  allProducts: string[]
  onRun?: () => void
  running?: boolean
}) {
  if (!row)                        return <PanelEmpty label="סוכן תוכן אורגני" onRun={onRun} running={running} />
  if (row.status === 'running')    return <PanelRunning />
  if (row.status === 'cancelled')  return <PanelEmpty label="סוכן תוכן אורגני" onRun={onRun} running={running} />
  if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)                 return <PanelEmpty label="סוכן תוכן אורגני" onRun={onRun} running={running} />
  const r = row.report as OrganicReport

  // OrganicReport has no next_week_focus field — the hero card falls back
  // to rendering just the summary as the focus. Still gets the dark TL;DR
  // treatment at the top so the three panels feel visually parallel.
  return (
    <div className="space-y-4">
      <HeroCard focus={r.summary} />

      {/* Account health */}
      {r.account_health && (
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: 'reach ממוצע', value: r.account_health.avg_reach_30d.toLocaleString() },
            { label: 'עוקבים', value: r.account_health.follower_count.toLocaleString() },
            { label: 'engagement', value: `${r.account_health.engagement_rate_pct}%` },
            { label: 'תוכן מוביל', value: r.account_health.best_post_type === 'reel' ? '🎬 ריילס' : r.account_health.best_post_type === 'post' ? '🖼️ פוסט' : '⏱ סטורי' },
          ].map(k => (
            <div key={k.label} className="bg-surface-50 rounded-xl p-2.5 text-center">
              <p className="text-base font-bold font-mono text-surface-900">{k.value}</p>
              <p className="text-xs text-surface-400 mt-0.5">{k.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Google Organic / SEO ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-indigo-200 bg-indigo-50 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-indigo-100 border-b border-indigo-200">
          <span className="text-base">🔍</span>
          <span className="text-sm font-bold text-indigo-900">Google אורגני — SEO ותוכן לדרג</span>
        </div>
        {r.google_organic_recommendations?.length > 0 ? (
          <div className="p-3 space-y-3">
            {r.google_organic_recommendations.map((rec, i) => (
              <div key={i} className="bg-white rounded-xl p-3 border border-indigo-200 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-indigo-900">"{rec.keyword}"</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {rec.current_position > 0 && (
                        <span className="text-xs text-indigo-600 font-mono bg-indigo-50 px-1.5 py-0.5 rounded">מיקום {rec.current_position}</span>
                      )}
                      {rec.search_volume_signal && (
                        <span className="text-xs text-surface-500">{rec.search_volume_signal}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                      rec.estimated_difficulty === 'קל' ? 'bg-green-100 text-green-700' :
                      rec.estimated_difficulty === 'בינוני' ? 'bg-amber-100 text-amber-700' :
                      'bg-red-100 text-red-700'
                    }`}>{rec.estimated_difficulty || 'בינוני'}</span>
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full">
                      {rec.content_type === 'blog_post' ? '📝 בלוג' :
                       rec.content_type === 'landing_page' ? '🎯 דף נחיתה' :
                       rec.content_type === 'product_page' ? '🛍️ דף מוצר' :
                       '❓ FAQ'}
                    </span>
                  </div>
                </div>
                <div className="bg-indigo-50 rounded-lg p-2.5 space-y-1">
                  <p className="text-xs font-semibold text-surface-500">כותרת מוצעת (H1):</p>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-indigo-900">{rec.suggested_title}</p>
                    <CopyButton text={rec.suggested_title} />
                  </div>
                </div>
                {rec.key_points?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-surface-500 mb-1">מה לכלול בתוכן:</p>
                    <ul className="space-y-1">
                      {rec.key_points.map((pt, j) => (
                        <li key={j} className="text-xs text-indigo-800 flex gap-1.5">
                          <span className="text-indigo-400 shrink-0">•</span>{pt}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {rec.why_now && (
                  <p className="text-xs text-indigo-700 bg-indigo-100 rounded px-2 py-1">⏰ {rec.why_now}</p>
                )}
                {/* Blog post writer — available on every organic rec, not
                    just ones the AI tagged as content_type='blog_post'. The
                    agent classifies targets into blog_post / landing_page /
                    product_page / faq_page but in practice the user may
                    want a written draft for any of them, and the server-
                    side writer is content-type-agnostic. The previous gate
                    hid the button entirely when the agent picked
                    landing_page, which made the Organic panel look broken
                    on weeks with no explicit blog_post recs. */}
                {(() => {
                  const bs = blogState[rec.keyword]
                  const picked = bs?.selectedProducts ?? []
                  const searchText = bs?.customProductText ?? ''

                  const updateState = (patch: Partial<{ selectedProducts: string[]; customProductText: string }>) =>
                    setBlogState(s => ({ ...s, [rec.keyword]: { ...(s[rec.keyword] ?? { loading: false, post: null }), ...patch } }))

                  const addProduct = (name: string) => {
                    if (!picked.includes(name)) updateState({ selectedProducts: [...picked, name], customProductText: '' })
                    else updateState({ customProductText: '' })
                  }

                  const removeProduct = (name: string) =>
                    updateState({ selectedProducts: picked.filter(n => n !== name) })

                  const suggestions = searchText.trim()
                    ? allProducts.filter(n => n.toLowerCase().includes(searchText.toLowerCase()) && !picked.includes(n))
                    : []

                  return (
                    <div className="pt-1 space-y-2">
                      {/* Product picker — only show when not loading and no post yet */}
                      {!bs?.loading && !bs?.post && (
                        <div className="space-y-2">
                          <p className="text-xs text-surface-500 font-semibold">🛍️ מוצרים לציין בפוסט (אופציונלי):</p>

                          {/* Search input with autocomplete */}
                          <div className="relative">
                            <input
                              type="text"
                              value={searchText}
                              onChange={e => updateState({ customProductText: e.target.value })}
                              placeholder="חפש מוצר..."
                              className="w-full text-xs border border-surface-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-400 placeholder-surface-400"
                              dir="rtl"
                            />
                            {suggestions.length > 0 && (
                              <div className="absolute z-10 top-full mt-1 w-full bg-white border border-surface-200 rounded-lg shadow-lg overflow-hidden">
                                {suggestions.slice(0, 8).map(name => (
                                  <button
                                    key={name}
                                    onMouseDown={e => { e.preventDefault(); addProduct(name) }}
                                    className="w-full text-right text-xs px-3 py-2 hover:bg-indigo-50 hover:text-indigo-700 transition-colors block"
                                  >
                                    {name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Selected products as removable pills */}
                          {picked.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {picked.map(name => (
                                <span key={name} className="inline-flex items-center gap-1 text-xs bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full">
                                  {name}
                                  <button onClick={() => removeProduct(name)} className="text-indigo-400 hover:text-indigo-700 leading-none">×</button>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {!bs?.loading && !bs?.post && (
                        <>
                          {bs?.error && (
                            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                              ⚠️ שגיאה: {bs.error}
                            </div>
                          )}
                          <button
                            onClick={() => writeBlogPost(rec, picked)}
                            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors"
                          >
                            ✍️ {bs?.error ? 'נסה שוב' : 'כתוב פוסט בלוג מלא'}
                            {picked.length > 0 && <span className="bg-indigo-500 rounded-full px-1.5 py-0.5">{picked.length} מוצרים</span>}
                          </button>
                        </>
                      )}
                      {bs?.loading && (
                        <div className="flex items-center gap-2 py-2 px-3 bg-indigo-50 rounded-lg">
                          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                          <span className="text-xs text-indigo-600">כותב פוסט... (~30 שניות)</span>
                        </div>
                      )}
                      {bs?.post && (
                        <div className="space-y-2 border border-indigo-200 rounded-xl overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-2 bg-indigo-600">
                            <span className="text-xs font-bold text-white">📝 פוסט מוכן לפרסום</span>
                            <div className="flex items-center gap-2">
                              <CopyButton text={bs.post.body} />
                              <button
                                onClick={() => setBlogState(s => ({ ...s, [rec.keyword]: { loading: false, post: null } }))}
                                className="text-indigo-200 hover:text-white text-xs"
                              >✕</button>
                            </div>
                          </div>
                          {/* Banner image — shows the generated banner or a
                              button to trigger generation on demand. */}
                          <div className="px-3 pt-2 space-y-1.5">
                            {bs.post.banner_url ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <p className="text-xs text-surface-500 font-semibold">🖼️ באנר:</p>
                                  <CopyButton text={bs.post.banner_url} />
                                  <a
                                    href={bs.post.banner_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[10px] text-indigo-600 hover:underline"
                                  >
                                    פתח בטאב חדש
                                  </a>
                                  <button
                                    onClick={() => generateBanner(rec.keyword, bs.post!.title)}
                                    disabled={bs?.bannerLoading}
                                    className="text-[10px] text-amber-600 hover:underline disabled:opacity-50"
                                  >
                                    🔄 באנר חדש
                                  </button>
                                </div>
                                {bs?.selectedProducts && bs.selectedProducts.length > 0 && (
                                  <div className="flex items-center gap-2">
                                    <label className="text-[10px] text-surface-500 font-semibold whitespace-nowrap">
                                      רפרנס לבאנר:
                                    </label>
                                    <select
                                      value={bs.bannerReferenceProduct ?? bs.selectedProducts[0]}
                                      onChange={(e) =>
                                        setBlogState(s => ({
                                          ...s,
                                          [rec.keyword]: { ...s[rec.keyword], bannerReferenceProduct: e.target.value || undefined },
                                        }))
                                      }
                                      className="text-[10px] flex-1 px-2 py-1 rounded border border-surface-300 bg-white"
                                    >
                                      {bs.selectedProducts.map(p => (
                                        <option key={p} value={p}>{p}</option>
                                      ))}
                                      <option value="">ללא רפרנס</option>
                                    </select>
                                  </div>
                                )}
                                <a href={bs.post.banner_url} target="_blank" rel="noopener noreferrer">
                                  <img
                                    src={bs.post.banner_url}
                                    alt={`Banner for ${bs.post.title}`}
                                    className="w-full rounded-lg border border-surface-200"
                                    style={{ aspectRatio: '16/9', objectFit: 'cover' }}
                                  />
                                </a>
                              </>
                            ) : bs?.bannerLoading ? (
                              <div className="flex items-center gap-2 py-2 px-3 bg-indigo-50 rounded-lg">
                                <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                                <span className="text-xs text-indigo-600">מייצר באנר... (~10-15 שניות)</span>
                              </div>
                            ) : (
                              <>
                                {bs?.selectedProducts && bs.selectedProducts.length > 0 && (
                                  <div className="flex items-center gap-2">
                                    <label className="text-[10px] text-surface-500 font-semibold whitespace-nowrap">
                                      רפרנס לבאנר:
                                    </label>
                                    <select
                                      value={bs.bannerReferenceProduct ?? bs.selectedProducts[0]}
                                      onChange={(e) =>
                                        setBlogState(s => ({
                                          ...s,
                                          [rec.keyword]: { ...s[rec.keyword], bannerReferenceProduct: e.target.value || undefined },
                                        }))
                                      }
                                      className="text-[10px] flex-1 px-2 py-1 rounded border border-surface-300 bg-white"
                                    >
                                      {bs.selectedProducts.map(p => (
                                        <option key={p} value={p}>{p}</option>
                                      ))}
                                      <option value="">ללא רפרנס</option>
                                    </select>
                                  </div>
                                )}
                                <button
                                  onClick={() => generateBanner(rec.keyword, bs.post!.title)}
                                  className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition-colors"
                                >
                                  🖼️ צור באנר לפוסט
                                </button>
                              </>
                            )}
                          </div>
                          <div className="px-3 pb-1 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <p className="text-xs text-surface-500 font-semibold">Meta description:</p>
                              <CopyButton text={bs.post.meta_description} />
                            </div>
                            <p className="text-xs text-indigo-800">{bs.post.meta_description}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <p className="text-xs text-surface-500 font-semibold">Slug:</p>
                              <span className="font-normal text-xs text-indigo-700">/{bs.post.slug}</span>
                              <CopyButton text={bs.post.slug} />
                            </div>
                          </div>
                          <div className="px-3 pb-3">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-xs text-surface-500 font-semibold">תוכן המאמר (Markdown):</p>
                              <CopyButton text={bs.post.body} />
                            </div>
                            <pre className="text-xs text-surface-700 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 max-h-96 overflow-y-auto leading-relaxed" dir="rtl">{bs.post.body}</pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-indigo-600 px-4 py-3">אין המלצות Google אורגני לשבוע זה</p>
        )}
      </div>

      {/* ── Instagram Content ─────────────────────────────────────────── */}
      {r.content_recommendations?.length > 0 && (
        <div className="rounded-2xl border border-green-200 bg-green-50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-green-100 border-b border-green-200">
            <span className="text-base">📸</span>
            <span className="text-sm font-bold text-green-900">אינסטגרם — תוכן השבוע</span>
          </div>
          <div className="p-3 space-y-2">
            {r.content_recommendations.slice(0, 2).map((rec, i) => (
              <div key={i} className="bg-white rounded-xl p-3 border border-green-200">
                <div className="flex items-center gap-2 mb-1">
                  <span>{contentTypeIcon(rec.content_type)}</span>
                  <span className="text-xs font-medium text-green-800">{rec.topic}</span>
                  <span className="text-xs text-surface-400 mr-auto">{rec.best_day} · {rec.best_time}</span>
                </div>
                <p className="text-xs text-surface-500">{rec.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products to feature */}
      {r.products_to_feature?.length > 0 && (
        <div>
          <SectionHeader>מוצרים לקדם</SectionHeader>
          <div className="space-y-1.5">
            {r.products_to_feature.map((p, i) => (
              <div key={i} className="card p-2.5">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-surface-800">{p.product}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${p.reason === 'low_stock_urgency' ? 'bg-red-100 text-red-600' : p.reason === 'new_batch' ? 'bg-blue-100 text-blue-600' : 'bg-amber-100 text-amber-600'}`}>
                    {p.reason === 'low_stock_urgency' ? '⚠️ מלאי נמוך' : p.reason === 'new_batch' ? '✨ חדש' : '🏆 מוביל'}
                  </span>
                </div>
                <p className="text-xs text-surface-500">{p.content_angle}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Posts to publish — grouped by intent (save / share / BTS) */}
      {r.posts_to_publish?.length > 0 && (
        <div>
          <SectionHeader>📲 פוסטים מוכנים לפרסום</SectionHeader>
          <div className="space-y-3">
            {r.posts_to_publish.map((p, i) => {
              const intentMap: Record<string, { label: string; emoji: string; color: string; bg: string; border: string }> = {
                save: { label: 'לשמירה', emoji: '🔖', color: 'text-blue-900', bg: 'bg-blue-50', border: 'border-blue-300' },
                share: { label: 'לשיתוף', emoji: '📣', color: 'text-rose-900', bg: 'bg-rose-50', border: 'border-rose-300' },
                behind_the_scenes: { label: 'מאחורי הקלעים', emoji: '🎬', color: 'text-amber-900', bg: 'bg-amber-50', border: 'border-amber-300' },
              }
              const intent = intentMap[p.intent ?? ''] ?? { label: 'כללי', emoji: '📱', color: 'text-green-900', bg: 'bg-green-50', border: 'border-green-300' }
              return (
                <div key={i} className={`card p-3 border ${intent.border} ${intent.bg} space-y-2`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border ${intent.border} ${intent.color}`}>
                        {intent.emoji} {intent.label}
                      </span>
                      <span>{contentTypeIcon(p.type)}</span>
                      <span className={`text-sm font-semibold ${intent.color}`}>{p.topic}</span>
                    </div>
                    <span className="text-xs text-surface-500">{p.best_day} {p.best_time}</span>
                  </div>
                  {p.why_this_intent && (
                    <p className="text-[11px] text-surface-600 italic">💡 {p.why_this_intent}</p>
                  )}
                  {p.hook && (
                    <p className={`text-xs font-medium text-surface-600 italic border-r-2 ${intent.border} pr-2`}>"{p.hook}"</p>
                  )}
                  <div className="bg-white rounded-lg p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-surface-800 leading-relaxed whitespace-pre-line flex-1">{p.caption}</p>
                      <CopyButton text={`${p.caption}\n\n${(p.hashtags ?? []).join(' ')}`} />
                    </div>
                    {p.hashtags?.length > 0 && (
                      <p className="text-xs text-blue-600">{p.hashtags.join(' ')}</p>
                    )}
                  </div>
                  {p.visual_direction && (
                    <p className="text-xs text-surface-500">📷 {p.visual_direction}</p>
                  )}
                  {(() => {
                    const ep = r.enriched_posts?.find(e => e.post_index === i)
                    return ep ? <PostPublishingControls ep={ep} /> : null
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />
    </div>
  )
}
