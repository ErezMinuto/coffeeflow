// Daily "waiting for your approval" email to the owner.
//
// Sent by health-watchdog once a day, ONLY when something is waiting. Counts
// the same queues the dashboard's NeedsYou card shows, plus the strategist
// closed-loop states, and lists the strategist items by title so the email is
// useful without opening the dashboard.
//
// Read-only: it never approves, sends or changes anything.

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

export const RECENT_DAYS = 14
const DASHBOARD_URL = Deno.env.get('DASHBOARD_URL') ?? 'https://coffeeflow-neon.vercel.app'

export interface DigestSection {
  key:    string
  label:  string   // Hebrew, gender-inclusive, no em-dashes
  count:  number
  link:   string
  titles: string[] // up to 5 examples, empty when the queue has no titles
}

async function countOf(q: Promise<{ count: number | null; error: unknown }>): Promise<number> {
  try { const { count, error } = await q; return error ? 0 : (count ?? 0) } catch { return 0 }
}

async function titlesOf(supabase: Db, statuses: string[]): Promise<{ count: number; titles: string[] }> {
  try {
    const { data, error, count } = await supabase
      .from('strategic_recommendations')
      .select('title', { count: 'exact' })
      .in('status', statuses)
      .order('created_at', { ascending: false })
      .limit(5)
    if (error) return { count: 0, titles: [] }
    return { count: count ?? (data ?? []).length, titles: ((data ?? []) as Array<{ title: string }>).map(r => r.title) }
  } catch { return { count: 0, titles: [] } }
}

export async function buildApprovalDigest(supabase: Db): Promise<DigestSection[]> {
  const head = { count: 'exact', head: true } as const
  const recentIso = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString()
  const [proposed, reviewed, stuck, drafts, content, signals] = await Promise.all([
    titlesOf(supabase, ['proposed']),
    titlesOf(supabase, ['ready_for_review']),
    titlesOf(supabase, ['needs_human']),
    countOf(supabase.from('campaigns').select('*', head).eq('status', 'draft')),
    // Content and signals have a long historic backlog (hundreds of rows); the
    // email lists only what arrived in the last RECENT_DAYS so it stays a
    // to-do list, not a wall. The dashboard still shows everything.
    countOf(supabase.from('seo_tasks').select('*', head).eq('result_data->>review_required', 'true').gte('created_at', recentIso)),
    countOf(supabase.from('strategist_signals').select('*', head).eq('status', 'open').gte('created_at', recentIso)),
  ])
  const brief = `${DASHBOARD_URL}/admin/seo-agent?view=inbox`
  return [
    { key: 'proposed', label: 'המלצות מהאסטרטג שממתינות לאישור', count: proposed.count, link: brief, titles: proposed.titles },
    { key: 'ready',    label: 'טיוטות שעברו בדיקה ומוכנות להחלטה שלך', count: reviewed.count, link: brief, titles: reviewed.titles },
    { key: 'stuck',    label: 'טיוטות שלא עברו בדיקה אחרי 2 תיקונים', count: stuck.count, link: brief, titles: stuck.titles },
    { key: 'drafts',   label: 'טיוטות מייל מוכנות לבדיקה ושליחה', count: drafts, link: `${DASHBOARD_URL}/marketing?tab=history`, titles: [] },
    { key: 'content',  label: `תוכן שממתין לבדיקה (${RECENT_DAYS} הימים האחרונים)`, count: content, link: brief, titles: [] },
    { key: 'signals',  label: `בקשות ורעיונות חדשים מהאסטרטג (${RECENT_DAYS} הימים האחרונים)`, count: signals, link: brief, titles: [] },
  ].filter(s => s.count > 0)
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function renderApprovalDigest(sections: DigestSection[]): { subject: string; html: string } {
  const total = sections.reduce((n, s) => n + s.count, 0)
  const rows = sections.map(s => `
      <tr><td style="padding:12px 0;border-bottom:1px solid #eee">
        <a href="${s.link}" style="color:#3f4a28;font-weight:600;text-decoration:none">${esc(s.label)}: ${s.count}</a>
        ${s.titles.length ? `<ul style="margin:6px 0 0;padding-inline-start:18px;color:#555;font-size:13px">${s.titles.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      </td></tr>`).join('')
  return {
    subject: `☕ ${total} פריטים ממתינים לאישור שלך`,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <h2 style="margin:0 0 6px;font-size:18px">ממתין לאישור שלך</h2>
      <p style="margin:0 0 12px;color:#666;font-size:13px">סיכום יומי. שום דבר לא נשלח, לא פורסם ולא הופעל בלי האישור שלך.</p>
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <p style="margin-top:18px"><a href="${DASHBOARD_URL}/admin/seo-agent?view=inbox" style="display:inline-block;background:#6A7D45;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">לדשבורד</a></p>
    </div>`,
  }
}
