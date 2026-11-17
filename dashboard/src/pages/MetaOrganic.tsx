import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { CardHead, CHART, Kpi, Kpis, SectionHead, Segmented, Swatch } from '../components/shared/cockpit'
import { DateRange } from '../lib/types'
import { getDefaultDateRange, formatNumber } from '../lib/utils'
import { Heart, MessageCircle, Share2, Bookmark, Film, Image } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { subMonths, startOfMonth, endOfMonth } from 'date-fns'

function getPrevMonthRange() {
  const prev = subMonths(new Date(), 1)
  return { from: startOfMonth(prev), to: endOfMonth(prev) }
}

export default function MetaOrganicPage() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange())
  const [posts, setPosts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'reel' | 'post'>('all')
  const [sortBy, setSortBy] = useState<'date' | 'likes' | 'comments' | 'engagement'>('date')

  // MoM comparison
  const [prevLikes, setPrevLikes] = useState<number | null>(null)
  const [prevComments, setPrevComments] = useState<number | null>(null)
  const [prevPosts, setPrevPosts] = useState<number | null>(null)

  useEffect(() => { loadPosts() }, [dateRange])
  useEffect(() => { loadPrevMonth() }, [])

  async function loadPosts() {
    setLoading(true)
    const { data } = await supabase
      .from('meta_organic_posts')
      .select('*')
      .gte('created_at', dateRange.from.toISOString())
      .lte('created_at', dateRange.to.toISOString())
      .order('created_at', { ascending: false })
    setPosts(data || [])
    setLoading(false)
  }

  async function loadPrevMonth() {
    const prev = getPrevMonthRange()
    const { data } = await supabase
      .from('meta_organic_posts')
      .select('likes, comments')
      .gte('created_at', prev.from.toISOString())
      .lte('created_at', prev.to.toISOString())
    if (data) {
      setPrevLikes(data.reduce((s, p) => s + p.likes, 0))
      setPrevComments(data.reduce((s, p) => s + p.comments, 0))
      setPrevPosts(data.length)
    }
  }

  const filtered = posts.filter(p => filter === 'all' || p.post_type === filter)
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'date') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (sortBy === 'likes') return b.likes - a.likes
    if (sortBy === 'comments') return b.comments - a.comments
    if (sortBy === 'engagement') return (b.likes + b.comments + b.shares + b.saves) - (a.likes + a.comments + a.shares + a.saves)
    return 0
  })

  const totalLikes = filtered.reduce((s, p) => s + p.likes, 0)
  const totalComments = filtered.reduce((s, p) => s + p.comments, 0)
  const totalShares = filtered.reduce((s, p) => s + p.shares, 0)
  const totalSaves = filtered.reduce((s, p) => s + p.saves, 0)
  const totalEngagement = totalLikes + totalComments + totalShares + totalSaves
  const reels = filtered.filter(p => p.post_type === 'reel').length
  const regularPosts = filtered.filter(p => p.post_type === 'post').length

  const likesChange = prevLikes && prevLikes > 0 ? ((totalLikes - prevLikes) / prevLikes) * 100 : undefined
  const commentsChange = prevComments && prevComments > 0 ? ((totalComments - prevComments) / prevComments) * 100 : undefined
  const postsChange = prevPosts && prevPosts > 0 ? ((filtered.length - prevPosts) / prevPosts) * 100 : undefined

  // Chart: engagement by post (top 10)
  const chartData = [...filtered]
    .sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments))
    .slice(0, 10)
    .map(p => ({
      name: p.message ? p.message.slice(0, 20) + '…' : p.post_id.slice(-6),
      likes: p.likes,
      comments: p.comments,
      type: p.post_type,
    }))

  return (
    <div className="space-y-5 fade-up">
      <SectionHead
        title="אינסטגרם אורגני"
        sub={`${filtered.length} פוסטים · ${reels} ריילס · ${regularPosts} פוסטים רגילים`}
        actions={<div className="w-full lg:w-auto"><DateRangePicker value={dateRange} onChange={setDateRange} /></div>}
      />

      {/* KPIs */}
      <div className="space-y-3">
        <Kpis label="מדדי אינסטגרם עיקריים">
          <Kpi label="לייקים" value={formatNumber(totalLikes)} change={likesChange} loading={loading} />
          <Kpi label="תגובות" value={formatNumber(totalComments)} change={commentsChange} loading={loading} />
          <Kpi label="שמירות" value={formatNumber(totalSaves)} loading={loading} />
          <Kpi label="פוסטים" value={filtered.length} change={postsChange} loading={loading} />
        </Kpis>
        <Kpis label="מדדי אינסטגרם משניים" cols={3}>
          <Kpi size="sm" label="שיתופים" value={formatNumber(totalShares)} loading={loading} />
          <Kpi size="sm" label="מעורבות כוללת" value={formatNumber(totalEngagement)} loading={loading} />
          <Kpi size="sm" label="מעורבות ממוצעת לפוסט" value={filtered.length > 0 ? (totalEngagement / filtered.length).toFixed(1) : '0'} loading={loading} />
        </Kpis>
      </div>

      {/* Engagement chart */}
      {chartData.length > 0 && (
        <section className="card-flush overflow-hidden">
          <CardHead title="הפוסטים המובילים">
            <div className="flex items-center gap-3">
              <Swatch color={CHART.olive} label="לייקים" />
              <Swatch color={CHART.oliveSoft} label="תגובות" />
            </div>
          </CardHead>
          <div className="p-4 pt-5" dir="ltr">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid horizontal={false} stroke={CHART.grid} />
                <XAxis type="number" tick={CHART.tick} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" tick={CHART.tick} tickLine={false} axisLine={false} width={130} />
                <Tooltip {...CHART.tooltip} />
                <Bar dataKey="likes" fill={CHART.olive} name="לייקים" stackId="a" />
                <Bar dataKey="comments" fill={CHART.oliveSoft} name="תגובות" radius={[0, 2, 2, 0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {/* Posts grid */}
      <section className="card-flush overflow-hidden">
        <CardHead title="פוסטים">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="סוג פוסט"
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'all', label: 'הכול' },
                { id: 'reel', label: <><Film size={14} aria-hidden="true" />ריילס</> },
                { id: 'post', label: <><Image size={14} aria-hidden="true" />פוסטים</> },
              ]}
            />
            <Segmented
              label="מיון הפוסטים"
              value={sortBy}
              onChange={setSortBy}
              options={[
                { id: 'date', label: 'תאריך' },
                { id: 'likes', label: 'לייקים' },
                { id: 'comments', label: 'תגובות' },
                { id: 'engagement', label: 'מעורבות' },
              ]}
            />
          </div>
        </CardHead>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i}>
                <div className="aspect-square bg-surface-100 rounded-lg" />
                <div className="h-3 w-2/3 bg-surface-100 rounded mt-2.5" />
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-14 px-6">
            <p className="text-sm font-medium text-surface-900">אין פוסטים בטווח הזה</p>
            <p className="text-[13px] text-surface-500 mt-1">אפשר לשנות את טווח התאריכים או לסנכרן מחדש בהגדרות.</p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-5 p-4">
            {sorted.map(post => (
              <li key={post.post_id} className="min-w-0">
                <div className="relative aspect-square rounded-lg overflow-hidden bg-surface-100 outline outline-1 -outline-offset-1 outline-black/10">
                  {post.thumbnail_url ? (
                    <img src={post.thumbnail_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {post.post_type === 'reel' ? <Film size={24} aria-hidden="true" className="text-surface-400" /> : <Image size={24} aria-hidden="true" className="text-surface-400" />}
                    </div>
                  )}

                  {/* Type tag */}
                  {post.post_type === 'reel' && (
                    <span className="absolute top-2 right-2 inline-flex items-center gap-1 px-1.5 h-5 rounded-[5px] bg-white/90 text-[11px] font-medium text-surface-900">
                      <Film size={11} aria-hidden="true" /> ריל
                    </span>
                  )}
                </div>

                {/* Stats are always visible (they used to sit in a hover-only overlay, out of reach on phones). */}
                <div className="mt-2 flex items-center gap-3 text-[13px] text-surface-900 num">
                  <span className="inline-flex items-center gap-1"><Heart size={14} aria-hidden="true" className="text-surface-400" /><span className="sr-only">לייקים</span>{formatNumber(post.likes)}</span>
                  <span className="inline-flex items-center gap-1"><MessageCircle size={14} aria-hidden="true" className="text-surface-400" /><span className="sr-only">תגובות</span>{formatNumber(post.comments)}</span>
                  {(post.shares > 0 || post.saves > 0) && (
                    <>
                      <span className="hidden sm:inline-flex items-center gap-1 text-surface-600"><Share2 size={13} aria-hidden="true" className="text-surface-400" /><span className="sr-only">שיתופים</span>{formatNumber(post.shares)}</span>
                      <span className="hidden sm:inline-flex items-center gap-1 text-surface-600"><Bookmark size={13} aria-hidden="true" className="text-surface-400" /><span className="sr-only">שמירות</span>{formatNumber(post.saves)}</span>
                    </>
                  )}
                </div>
                {post.message && (
                  <p className="text-[12.5px] text-surface-600 mt-1 line-clamp-2" dir="auto">{post.message}</p>
                )}
                <p className="text-[12px] text-surface-400 mt-0.5 num">{new Date(post.created_at).toLocaleDateString('he-IL')}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
