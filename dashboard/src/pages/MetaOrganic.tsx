import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { KPICard } from '../components/shared/KPICard'
import { DateRangePicker } from '../components/shared/DateRangePicker'
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
    <div className="space-y-8 fade-up">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">Instagram אורגני</h2>
          <p className="text-sm text-surface-400 mt-1">{filtered.length} פוסטים · {reels} ריילס · {regularPosts} פוסטים</p>
        </div>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="סה״כ לייקים" value={formatNumber(totalLikes)} change={likesChange} loading={loading} />
        <KPICard label="תגובות" value={formatNumber(totalComments)} change={commentsChange} loading={loading} />
        <KPICard label="שמירות" value={formatNumber(totalSaves)} loading={loading} />
        <KPICard label="פוסטים" value={filtered.length} change={postsChange} loading={loading} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <KPICard label="שיתופים" value={formatNumber(totalShares)} loading={loading} />
        <KPICard label="מעורבות כוללת" value={formatNumber(totalEngagement)} loading={loading} />
        <KPICard label="מעורבות ממוצעת לפוסט" value={filtered.length > 0 ? (totalEngagement / filtered.length).toFixed(1) : '0'} loading={loading} />
      </div>

      {/* Engagement chart */}
      {chartData.length > 0 && (
        <div className="card">
          <h3 className="font-display font-semibold text-surface-900 mb-4">הפוסטים המובילים (לייקים + תגובות)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 20, left: 80, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0ebe3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: '#927561' }} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#927561' }} tickLine={false} axisLine={false} width={80} />
              <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e3d9cc', borderRadius: 12, fontSize: 12 }} />
              <Bar dataKey="likes" fill="#e1306c" name="לייקים" radius={[0, 3, 3, 0]} stackId="a" />
              <Bar dataKey="comments" fill="#833ab4" name="תגובות" radius={[0, 3, 3, 0]} stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Posts grid */}
      <div className="card overflow-hidden p-0">
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            {(['all', 'reel', 'post'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filter === f ? 'bg-brand-600 text-white' : 'bg-surface-100 text-surface-600 hover:bg-surface-200'}`}>
                {f === 'all' ? 'הכל' : f === 'reel' ? '🎬 ריילס' : '🖼 פוסטים'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-surface-400">
            <span>מיין:</span>
            {(['date', 'likes', 'comments', 'engagement'] as const).map(s => (
              <button key={s} onClick={() => setSortBy(s)}
                className={`px-2 py-1 rounded ${sortBy === s ? 'bg-brand-100 text-brand-700 font-medium' : 'hover:bg-surface-100'}`}>
                {s === 'date' ? 'תאריך' : s === 'likes' ? 'לייקים' : s === 'comments' ? 'תגובות' : 'מעורבות'}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="aspect-square bg-surface-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-16 text-surface-400">
            <p>אין פוסטים בטווח הזה</p>
            <p className="text-sm mt-1">נסה לשנות את טווח התאריכים או לסנכרן מחדש</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-0 divide-x divide-y divide-surface-100" dir="ltr">
            {sorted.map(post => {
              const engagement = post.likes + post.comments + post.shares + post.saves
              return (
                <div key={post.post_id} className="relative group aspect-square bg-surface-50 overflow-hidden">
                  {post.thumbnail_url ? (
                    <img src={post.thumbnail_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-100 to-surface-200">
                      {post.post_type === 'reel' ? <Film size={32} className="text-surface-300" /> : <Image size={32} className="text-surface-300" />}
                    </div>
                  )}

                  {/* Type badge */}
                  <div className="absolute top-2 right-2">
                    {post.post_type === 'reel' && (
                      <span className="bg-black/60 text-white text-xs px-1.5 py-0.5 rounded-md flex items-center gap-1">
                        <Film size={10} /> ריל
                      </span>
                    )}
                  </div>

                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-3">
                    <div className="flex items-center gap-3 text-white text-sm font-medium">
                      <span className="flex items-center gap-1"><Heart size={14} className="text-red-400" />{formatNumber(post.likes)}</span>
                      <span className="flex items-center gap-1"><MessageCircle size={14} className="text-blue-300" />{formatNumber(post.comments)}</span>
                    </div>
                    {(post.shares > 0 || post.saves > 0) && (
                      <div className="flex items-center gap-3 text-white text-xs opacity-80">
                        <span className="flex items-center gap-1"><Share2 size={12} />{formatNumber(post.shares)}</span>
                        <span className="flex items-center gap-1"><Bookmark size={12} />{formatNumber(post.saves)}</span>
                      </div>
                    )}
                    {post.message && (
                      <p className="text-white text-xs opacity-70 text-center line-clamp-2 mt-1" dir="rtl">{post.message}</p>
                    )}
                    <p className="text-white/50 text-xs">{new Date(post.created_at).toLocaleDateString('he-IL')}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
