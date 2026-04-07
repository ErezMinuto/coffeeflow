import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { ProgressBar, useAnimatedProgress } from '../components/shared/ProgressBar';

// ── Simple markdown renderer (no external lib needed) ────────────────────────
function MarkdownBubble({ text }) {
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4 style="margin:10px 0 4px;color:#6b3a1f;font-size:0.95rem">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="margin:12px 0 6px;color:#6b3a1f;font-size:1rem">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 style="margin:12px 0 6px;color:#2c1a0e;font-size:1.1rem">$1</h2>')
    .replace(/^- (.+)$/gm, '<li style="margin:3px 0">$1</li>')
    .replace(/(<li[^>]*>.*<\/li>\n?)+/g, m => `<ul style="padding-right:18px;margin:6px 0">${m}</ul>`)
    .replace(/\n\n/g, '</p><p style="margin:6px 0">')
    .replace(/\n/g, '<br/>');
  return (
    <div
      style={{ lineHeight: 1.65, fontSize: '0.9rem' }}
      dangerouslySetInnerHTML={{ __html: `<p style="margin:0">${html}</p>` }}
    />
  );
}

// ── Quick-ask prompts ────────────────────────────────────────────────────────
const QUICK_ASKS = [
  { icon: '🏆', label: 'הפוסטים המובילים החודש', q: 'אילו פוסטים ביצעו הכי טוב החודש? ומה המשותף ביניהם?' },
  { icon: '🎬', label: 'ריילס vs. פוסטים', q: 'מה ההבדל בין הביצועים של ריילס לפוסטים רגילים אצלנו?' },
  { icon: '📈', label: 'מגמות מעורבות לאורך זמן', q: 'איך המעורבות שלנו השתנתה לאורך הזמן? יש מגמה?' },
  { icon: '💡', label: 'רעיונות תוכן', q: 'תן לי 5 רעיונות קונקרטיים לתוכן בהתבסס על מה שעבד אצלנו, עם הסבר קצר לכל אחד' },
  { icon: '📣', label: 'מה כדאי לקדם בתשלום?', q: 'איזה קמפיין ממומן הייתי ממליץ להריץ כרגע על בסיס הפוסטים האורגניים הטובים ביותר?' },
  { icon: '📊', label: 'סיכום קמפיינים ממומנים', q: 'תנתח את ביצועי הקמפיינים הממומנים שלנו — Meta ו-Google. מה עובד טוב ומה לשפר?' },
  { icon: '🕐', label: 'מתי כדאי לפרסם?', q: 'מה שעות ויום הפרסום האופטימליים עבורנו על בסיס הנתונים?' },
  { icon: '📋', label: 'דוח מנהלים מלא', q: 'תנתח את הביצועים שלנו ותן לי דוח מנהלים קצר עם 3 נקודות חוזק ו-3 תחומי שיפור' },
];


// ── Main Component ───────────────────────────────────────────────────────────
export default function AIAnalyst() {
  const [messages, setMessages]         = useState([]);
  const [input, setInput]               = useState('');
  const [loading, setLoading]           = useState(false);
  const aiProgress = useAnimatedProgress(loading, 12);
  const [dataLoading, setDataLoading]   = useState(true);
  const [postsData, setPostsData]       = useState([]);
  const [metaAds, setMetaAds]           = useState([]);
  const [googleAds, setGoogleAds]       = useState([]);
  const [products, setProducts]         = useState([]);
  const [packingLogs, setPackingLogs]   = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [stats, setStats]               = useState(null);
  const [convHistory, setConvHistory]   = useState([]);
  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setDataLoading(true);
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const [postsRes, metaRes, googleRes, productsRes, packingRes, ordersRes] = await Promise.all([
        supabase.from('meta_organic_posts').select('*').order('created_at', { ascending: false }).limit(100),
        supabase.from('meta_ad_campaigns').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('google_campaigns').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('products').select('name, packed_stock, min_packed_stock').order('name'),
        supabase.from('packing_logs').select('product_name, bags_packed, created_at').gte('created_at', weekAgo).order('created_at', { ascending: false }),
        supabase.from('pending_orders').select('customer_name, product_name, quantity_bags, expected_date, status').eq('status', 'pending').limit(50),
      ]);

      const posts = postsRes.data || [];
      const meta  = metaRes.data  || [];
      const google = googleRes.data || [];

      setPostsData(posts);
      setMetaAds(meta);
      setGoogleAds(google);
      setProducts(productsRes.data || []);
      setPackingLogs(packingRes.data || []);
      setPendingOrders(ordersRes.data || []);

      // Compute stats
      const reels = posts.filter(p => p.post_type === 'reel');
      const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
      const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
      const totalEng = posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0) + (p.shares || 0) + (p.saves || 0), 0);
      const avgEng = posts.length > 0 ? (totalEng / posts.length).toFixed(1) : 0;
      const bagsThisWeek = (packingRes.data || []).reduce((s, l) => s + (l.bags_packed || 0), 0);
      setStats({ posts: posts.length, reels: reels.length, totalLikes, totalComments, avgEng, metaCampaigns: meta.length, googleCampaigns: google.length, bagsThisWeek, pendingOrders: (ordersRes.data || []).length });
    } catch (err) {
      console.error('Failed to load analyst data:', err);
    } finally {
      setDataLoading(false);
    }
  }

  function buildDataContext() {
    if (!postsData.length && !metaAds.length && !googleAds.length) return 'אין נתונים זמינים.';

    const sorted = [...postsData].sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)));
    const top10  = sorted.slice(0, 10);
    const reels  = postsData.filter(p => p.post_type === 'reel');
    const posts  = postsData.filter(p => p.post_type !== 'reel');

    const avgEngReels = reels.length > 0
      ? (reels.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / reels.length).toFixed(1) : 0;
    const avgEngPosts = posts.length > 0
      ? (posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0) / posts.length).toFixed(1) : 0;

    const postsSummary = postsData.map(p => ({
      type: p.post_type,
      date: p.created_at?.slice(0, 10),
      likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves,
      caption: p.message ? p.message.slice(0, 120) : null,
      dayOfWeek: p.created_at ? new Date(p.created_at).toLocaleDateString('he-IL', { weekday: 'long' }) : null,
      hour: p.created_at ? new Date(p.created_at).getHours() : null,
    }));

    const metaSummary = metaAds.slice(0, 20).map(c => ({
      name: c.name, status: c.status, objective: c.objective,
      spend: c.spend, impressions: c.impressions, clicks: c.clicks,
      ctr: c.ctr, cpc: c.cpc, purchases: c.purchases, roas: c.roas,
      date: c.created_at?.slice(0, 10),
    }));

    const googleSummary = googleAds.slice(0, 20).map(c => ({
      name: c.name || c.campaign_name, status: c.status,
      spend: c.cost || c.spend, impressions: c.impressions, clicks: c.clicks,
      ctr: c.ctr, cpc: c.cpc, conversions: c.conversions,
      date: c.created_at?.slice(0, 10),
    }));

    // Sales & stock context
    const lowStock = products.filter(p => (p.packed_stock || 0) < (p.min_packed_stock || 0));
    const bagsThisWeek = packingLogs.reduce((s, l) => s + (l.bags_packed || 0), 0);
    const bagsByProduct = packingLogs.reduce((acc, l) => {
      acc[l.product_name] = (acc[l.product_name] || 0) + (l.bags_packed || 0);
      return acc;
    }, {});
    const topSelling = Object.entries(bagsByProduct).sort((a, b) => b[1] - a[1]).slice(0, 5);

    return `נתוני ביצועים של Minuto Coffee (בית קפה ספשיאלטי ברחובות, ישראל):

=== Instagram אורגני ===
סיכום: ${postsData.length} פוסטים (${reels.length} ריילס, ${posts.length} פוסטים רגילים)
מעורבות ממוצעת ריילס: ${avgEngReels} | פוסטים: ${avgEngPosts}
סה"כ לייקים: ${postsData.reduce((s, p) => s + (p.likes || 0), 0)} | תגובות: ${postsData.reduce((s, p) => s + (p.comments || 0), 0)}

10 הפוסטים המובילים:
${top10.map((p, i) => `${i + 1}. [${p.post_type}] ${p.created_at?.slice(0, 10)} | לייקים: ${p.likes} | תגובות: ${p.comments} | "${p.message?.slice(0, 80) || 'ללא כיתוב'}"`).join('\n')}

כל הפוסטים:
${JSON.stringify(postsSummary)}

=== קמפיינים ממומנים Meta ===
${metaSummary.length > 0 ? JSON.stringify(metaSummary) : 'אין נתונים'}

=== קמפיינים Google ===
${googleSummary.length > 0 ? JSON.stringify(googleSummary) : 'אין נתונים'}

=== מכירות ומלאי (שבוע אחרון) ===
שקיות שנמכרו השבוע: ${bagsThisWeek}
המוצרים הנמכרים ביותר: ${topSelling.map(([name, bags]) => `${name} (${bags} שקיות)`).join(', ') || 'אין נתונים'}
מוצרים במלאי נמוך: ${lowStock.length > 0 ? lowStock.map(p => `${p.name} (${p.packed_stock}/${p.min_packed_stock})`).join(', ') : 'אין'}
הזמנות ממתינות: ${pendingOrders.length > 0 ? pendingOrders.map(o => `${o.customer_name} - ${o.product_name} x${o.quantity_bags}`).join(', ') : 'אין'}
כל המוצרים ומלאי: ${JSON.stringify(products.map(p => ({ name: p.name, stock: p.packed_stock, min: p.min_packed_stock })))}
`;
  }

  const sendMessage = useCallback(async (customMsg) => {
    const msg = customMsg || input.trim();
    if (!msg || loading) return;
    if (!customMsg) setInput('');

    const userMsg = { role: 'user', content: msg };
    setMessages(prev => [...prev, { type: 'user', text: msg }]);

    const newHistory = [...convHistory, userMsg];
    setConvHistory(newHistory);
    setLoading(true);

    try {
      const dataContext = buildDataContext();
      const systemPrompt = `אתה אנליסט שיווק דיגיטלי מומחה לעסקי קפה ומסעדנות, עם גישה לנתוני האינסטגרם והקמפיינים הממומנים האמיתיים של Minuto Coffee.

${dataContext}

הנחיות:
- ענה בעברית תמיד
- היה ספציפי — הזכר מספרים ותאריכים מהנתונים
- תן המלצות קונקרטיות ומעשיות
- הבן את הקהל הישראלי ותרבות הקפה המקומית
- כשמדבר על תוכן — חשוב במונחים של specialty coffee, בית קפה שכונתי, חוויה
- השווה ביצועי Meta ו-Google כשרלוונטי
- היה תמציתי אך מעמיק`;

      // Keep last 8 turns for context window
      const trimmedHistory = newHistory.slice(-8);

      const { data, error } = await supabase.functions.invoke('ai-analyst', {
        body: { messages: trimmedHistory, systemPrompt },
      });

      if (error) throw error;

      const reply = data?.content?.[0]?.text || data?.reply || 'שגיאה בקבלת תשובה';
      aiProgress.complete();
      setMessages(prev => [...prev, { type: 'assistant', text: reply }]);
      setConvHistory(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      console.error('AI analyst error:', err);
      setMessages(prev => [...prev, { type: 'assistant', text: 'שגיאה בתקשורת עם הAI. נסה שוב.' }]);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, loading, convHistory, postsData, metaAds, googleAds]);

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function autoResize(e) {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }

  const isEmpty = messages.length === 0;

  const STAT_ROWS = [
    ['פוסטים אורגניים', dataLoading ? '...' : (stats?.posts ?? '—')],
    ['ריילס',           dataLoading ? '...' : (stats?.reels ?? '—')],
    ['לייקים סה״כ',    dataLoading ? '...' : (stats?.totalLikes?.toLocaleString() ?? '—')],
    ['תגובות סה״כ',    dataLoading ? '...' : (stats?.totalComments?.toLocaleString() ?? '—')],
    ['מעורבות ממוצעת', dataLoading ? '...' : (stats?.avgEng ?? '—')],
    ['קמפיינים Meta',  dataLoading ? '...' : (stats?.metaCampaigns ?? '—')],
    ['קמפיינים Google',dataLoading ? '...' : (stats?.googleCampaigns ?? '—')],
    ['שקיות (שבוע)',   dataLoading ? '...' : (stats?.bagsThisWeek ?? '—')],
    ['הזמנות ממתינות', dataLoading ? '...' : (stats?.pendingOrders ?? '—')],
  ];

  return (
    <div className="flex flex-col fade-up" style={{ height: 'calc(100vh - 7rem)' }}>

      {/* Page header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">AI Analyst</h2>
          <p className="text-sm text-surface-400 mt-1">שאל שאלות על הנתונים שלך בזמן אמת</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-surface-400">
          <span className={`w-2 h-2 rounded-full ${dataLoading ? 'bg-amber-400 animate-pulse' : 'bg-green-400'}`} />
          {dataLoading ? 'טוען נתונים...' : 'מחובר לנתונים'}
        </div>
      </div>

      {/* Two-column body */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* Quick-asks sidebar */}
        <div className="w-56 shrink-0 flex flex-col gap-2 overflow-y-auto">
          <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider px-1 shrink-0">שאלות מהירות</p>
          {QUICK_ASKS.map(qa => (
            <button
              key={qa.q}
              onClick={() => sendMessage(qa.q)}
              disabled={loading}
              className="text-right text-sm text-surface-700 bg-white border border-surface-200 hover:bg-brand-50 hover:border-brand-300 hover:text-brand-700 rounded-xl px-3 py-2.5 transition-all disabled:opacity-40 leading-snug w-full"
            >
              {qa.icon} {qa.label}
            </button>
          ))}

          {/* Data stats */}
          <div className="card p-3 mt-1 shrink-0">
            <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">נתונים טעונים</p>
            <div className="space-y-1.5">
              {STAT_ROWS.map(([label, val]) => (
                <div key={label} className="flex justify-between items-center text-xs border-b border-surface-50 pb-1 last:border-0 last:pb-0">
                  <span className="text-surface-400">{label}</span>
                  <span className="text-surface-700 font-medium font-mono">{val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 card flex flex-col min-h-0 p-0 overflow-hidden">

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
            {isEmpty && (
              <div className="flex flex-col items-center justify-center flex-1 text-center text-surface-400 py-10">
                <div className="text-4xl mb-3">☕</div>
                <h3 className="font-display text-xl text-surface-700 mb-2">שלום!</h3>
                <p className="text-sm leading-relaxed max-w-xs">
                  אני מנתח את נתוני הביצועים של Minuto בזמן אמת.<br />
                  שאל אותי כל שאלה על אינסטגרם, קמפיינים ממומנים ואסטרטגיה.
                </p>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex flex-col gap-1 ${m.type === 'user' ? 'items-start' : 'items-end'}`}>
                <span className="text-xs text-surface-400 px-1">
                  {m.type === 'user' ? 'אתה' : 'AI Analyst'}
                </span>
                {m.type === 'user' ? (
                  <div className="max-w-[78%] bg-surface-900 text-white px-4 py-3 rounded-2xl rounded-br-sm text-sm leading-relaxed">
                    {m.text}
                  </div>
                ) : (
                  <div className="max-w-[78%] bg-white border border-surface-200 shadow-sm px-4 py-3 rounded-2xl rounded-bl-sm text-sm">
                    <MarkdownBubble text={m.text} />
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs text-surface-400 px-1">AI Analyst</span>
                <div className="px-4 py-3">
                  <ProgressBar progress={aiProgress.progress} label="מנתח נתונים..." color="#4A7C59" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-surface-100 p-4 flex gap-3 items-end bg-white">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={autoResize}
              placeholder="שאל אותי על הביצועים שלך..."
              rows={1}
              disabled={loading}
              dir="rtl"
              className="flex-1 border border-surface-200 rounded-xl px-4 py-2.5 text-sm text-surface-800 bg-surface-50 resize-none outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400 transition placeholder:text-surface-300 disabled:opacity-50"
              style={{ minHeight: 44, maxHeight: 120, lineHeight: 1.5 }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="btn-primary w-11 h-11 flex items-center justify-center shrink-0 disabled:opacity-40 disabled:cursor-not-allowed text-base"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
