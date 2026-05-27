// Minuto Organic Marketing — industry intelligence ingester.
//
// Cron-polled daily (separately scheduled). For each active row in
// industry_sources, fetches the RSS feed, finds NEW article URLs (not
// already in industry_articles), fetches each article's HTML, extracts
// the readable body via a cheap text-extraction pass, and asks Claude
// Haiku to write a 2-4-sentence INSIGHT framing the article's
// applicability to Minuto's organic stack — plus a 0..1 relevance score
// and topic tags.
//
// Decoupled from market_research (Meta Ad Library competitor ads only).
// This is broader content/news from the field — what marketers and the
// coffee industry are writing about right now.
//
// Strategist consumer: orchestrator's user-message build pulls the top
// recent insights (filter: summarized_at NOT NULL AND relevance >= 0.5)
// and surfaces them in a dedicated 'INDUSTRY INTELLIGENCE' block.
//
// Cost envelope: ~9 sources × ~3 new articles/day × Haiku summary
// (~$0.001 each) = ~$0.03/day. Negligible.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callClaude, parseClaudeJson } from '../seo-agent/claude.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Per-article body extract cap. We trust Claude to pull insights from
// the first ~5KB; pulling more = bigger summary cost without more signal
// (most articles bury thesis in the first 3-4 paragraphs anyway).
const MAX_BODY_CHARS = 5000
// How many seconds we'll spend on one feed before giving up. Some
// industry blogs are slow; don't let one block the others.
const FETCH_TIMEOUT_MS = 15_000
// Don't re-summarize articles older than this even if they're new to us
// (e.g. backfill on first run). Recency cap prevents the first run from
// summarizing a year of Sprudge backlog.
const MAX_AGE_DAYS_TO_SUMMARIZE = 14

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
  const startedAt = new Date().toISOString()

  // 1. Load active sources.
  const { data: sources, error: srcErr } = await supabase
    .from('industry_sources')
    .select('*')
    .eq('active', true)
  if (srcErr) return jsonResponse({ error: `sources query failed: ${srcErr.message}` }, 500)
  if (!sources || sources.length === 0) return jsonResponse({ ok: true, note: 'no active sources' })

  const stats = {
    sources_polled:   0,
    articles_found:   0,
    articles_fetched: 0,
    articles_stored:  0,
    articles_summarized: 0,
    errors:           [] as Array<{ source: string; error: string }>,
  }

  for (const src of sources as Array<{ id: string; name: string; rss_url: string; category: string; max_per_run: number }>) {
    stats.sources_polled++
    try {
      // Fetch + parse RSS.
      const rssText = await fetchWithTimeout(src.rss_url, FETCH_TIMEOUT_MS)
      const items   = parseRssMinimal(rssText).slice(0, src.max_per_run)
      stats.articles_found += items.length

      for (const item of items) {
        // Dedup check — skip if URL already known.
        const { data: existing } = await supabase
          .from('industry_articles')
          .select('id, summarized_at')
          .eq('url', item.link)
          .maybeSingle()
        if (existing) continue   // either already summarized, or pending re-try by separate path

        // Age check — don't blow $$ summarizing old backlog.
        if (item.published_at) {
          const ageDays = (Date.now() - new Date(item.published_at).getTime()) / (24 * 3600 * 1000)
          if (ageDays > MAX_AGE_DAYS_TO_SUMMARIZE) continue
        }

        // Fetch article HTML body.
        let body = ''
        try {
          body = await fetchWithTimeout(item.link, FETCH_TIMEOUT_MS)
          body = extractReadableText(body).slice(0, MAX_BODY_CHARS)
          stats.articles_fetched++
        } catch (e: any) {
          console.warn(`[industry-intel] fetch ${item.link} failed: ${e?.message ?? e}`)
          // Still insert the row with raw_content empty so we don't keep retrying
          // the same dead link.
          body = ''
        }

        // Insert pending row.
        const insertRow = {
          source_id:       src.id,
          source_name:     src.name,
          source_category: src.category,
          url:             item.link,
          title:           item.title.slice(0, 500),
          published_at:    item.published_at,
          raw_content:     body,
        }
        const { data: stored, error: insErr } = await supabase
          .from('industry_articles')
          .insert(insertRow)
          .select('id')
          .single()
        if (insErr) {
          stats.errors.push({ source: src.name, error: `insert ${item.link}: ${insErr.message}` })
          continue
        }
        stats.articles_stored++

        // Synthesize insight if we have body.
        if (body.length > 200) {
          try {
            const synth = await synthesizeInsight({
              source_name:     src.name,
              source_category: src.category,
              title:           item.title,
              body,
            })
            await supabase
              .from('industry_articles')
              .update({
                insight:       synth.insight,
                relevance:     synth.relevance,
                tags:          synth.tags,
                summarized_at: new Date().toISOString(),
              })
              .eq('id', stored.id)
            stats.articles_summarized++
          } catch (e: any) {
            console.warn(`[industry-intel] synth ${item.link} failed: ${e?.message ?? e}`)
          }
        }
      }
    } catch (e: any) {
      stats.errors.push({ source: src.name, error: e?.message ?? String(e) })
    }
  }

  return jsonResponse({ ok: true, started_at: startedAt, finished_at: new Date().toISOString(), stats })
})

// ─────────────────────────────────────────────────────────────────────────
// RSS parser — minimal regex-based. Most feeds are RSS 2.0 or Atom.
// Returns title, link, published_at per item. We don't validate XML
// strictly; "good enough" parsing beats pulling a 100KB XML library.
// ─────────────────────────────────────────────────────────────────────────
interface RssItem {
  title: string
  link: string
  published_at: string | null
}

function parseRssMinimal(xml: string): RssItem[] {
  const out: RssItem[] = []
  // RSS 2.0: <item> blocks
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml))) {
    const block = m[1]
    const title = extractTag(block, 'title')
    const link  = extractTag(block, 'link')
    const pub   = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'published')
    if (title && link) {
      out.push({ title: decodeEntities(title), link: link.trim(), published_at: parseDateOrNull(pub) })
    }
  }
  if (out.length > 0) return out
  // Atom: <entry> blocks with <link href="..." />
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
  while ((m = entryRe.exec(xml))) {
    const block = m[1]
    const title = extractTag(block, 'title')
    const linkM = /<link[^>]+href=["']([^"']+)["']/i.exec(block)
    const pub   = extractTag(block, 'updated') || extractTag(block, 'published')
    if (title && linkM) {
      out.push({ title: decodeEntities(title), link: linkM[1].trim(), published_at: parseDateOrNull(pub) })
    }
  }
  return out
}

function extractTag(block: string, tag: string): string {
  // Handle CDATA + plain text.
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i')
  const m  = re.exec(block)
  return m ? m[1].trim() : ''
}

function parseDateOrNull(s: string): string | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ─────────────────────────────────────────────────────────────────────────
// Readability — cheap text extraction. Strip script/style, then HTML tags.
// Industry blogs are mostly clean HTML; full-featured extractors (Mozilla
// Readability port etc.) would be overkill at our scale.
// ─────────────────────────────────────────────────────────────────────────
function extractReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Some sources block default Deno user-agent.
        'User-Agent': 'Mozilla/5.0 (compatible; MinutoOrganicAgent/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, text/html, */*',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Insight synthesizer — Haiku is cheap + fast enough for this. The output
// guides the strategist's planning, not the public-facing copy, so we
// don't need Sonnet here.
// ─────────────────────────────────────────────────────────────────────────
const SYNTH_SYSTEM_PROMPT = `You are the research analyst for Minuto's organic marketing agent. Given an industry article (marketing/SEO/social/coffee), distill an ACTIONABLE insight for Minuto's organic strategy.

CONTEXT — Minuto is a small specialty coffee roastery in Israel. The agent runs:
  • Hebrew SEO blog (drafts published on minuto.co.il)
  • Instagram organic (~few posts per week)
  • Google Search Console targets in Hebrew + some English

OUTPUT (strict JSON, no markdown fences):
{
  "insight":   "2-4 sentences explaining what this article argues + WHY/HOW it applies to Minuto's organic stack. NOT a generic abstract. Cite the specific technique or principle.",
  "relevance": 0.0–1.0,  // how directly applicable to Minuto's organic blog/IG. 0.8+ = act on it. 0.5-0.7 = worth knowing. <0.5 = noise.
  "tags":      ["hook_design", "seo_technical", "instagram_growth", "trend_alert", "case_study", "tool_recommendation"]  // pick 1-4 from the list, or invent if needed
}

CALIBRATION:
  • Generic 'content marketing 101' post → relevance 0.2-0.4
  • Specific tactic Minuto could test next cycle (e.g. 'use FAQ schema on category pages') → relevance 0.7-0.9
  • Industry news about coffee trends → relevance 0.5-0.7 (informs topics, not techniques)
  • Marketing tool launches Minuto wouldn't realistically adopt → relevance 0.1-0.3`

async function synthesizeInsight(args: {
  source_name:     string
  source_category: string
  title:           string
  body:            string
}): Promise<{ insight: string; relevance: number; tags: string[] }> {
  const userMessage = `SOURCE: ${args.source_name} (${args.source_category})
TITLE: ${args.title}

ARTICLE BODY (first 5KB):
${args.body}

Output strict JSON per the system prompt.`

  const res = await callClaude({
    model:       'claude-haiku-4-5',
    system:      SYNTH_SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userMessage }],
    maxTokens:   500,
    temperature: 0.3,
    timeoutMs:   30_000,
  })

  const parsed = parseClaudeJson<{ insight?: unknown; relevance?: unknown; tags?: unknown }>(res.text)
  return {
    insight:   typeof parsed.insight === 'string' ? parsed.insight : `(synth failed for "${args.title}")`,
    relevance: typeof parsed.relevance === 'number' ? Math.max(0, Math.min(1, parsed.relevance)) : 0.3,
    tags:      Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 6) : [],
  }
}
