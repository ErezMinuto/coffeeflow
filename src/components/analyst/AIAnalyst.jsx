import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { ProgressBar, useAnimatedProgress } from '../shared/ProgressBar';

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

// ── Styles ───────────────────────────────────────────────────────────────────
const S = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 70px)',
    overflow: 'hidden',
    background: '#f7f2ea',
    direction: 'rtl',
  },
  header: {
    background: '#2c1a0e',
    padding: '14px 24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '2px solid #c8923a',
    flexShrink: 0,
  },
  headerTitle: {
    fontFamily: 'serif',
    color: '#f7f2ea',
    fontSize: '1.25rem',
    fontWeight: 700,
  },
  headerGold: { color: '#c8923a' },
  statusDot: {
    width: 8, height: 8,
    borderRadius: '50%',
    background: '#4ade80',
    display: 'inline-block',
    marginLeft: 8,
    animation: 'pulse 2s infinite',
  },
  statusLabel: { color: '#9b8778', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 6 },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: {
    width: 260,
    background: '#2c1a0e',
    padding: '20px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    overflowY: 'auto',
    borderLeft: '1px solid rgba(255,255,255,0.08)',
    flexShrink: 0,
  },
  sidebarTitle: {
    color: '#c8923a',
    fontSize: '0.72rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    marginBottom: 4,
    fontWeight: 600,
  },
  quickBtn: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: '#f7f2ea',
    padding: '9px 12px',
    borderRadius: 10,
    fontSize: '0.8rem',
    cursor: 'pointer',
    textAlign: 'right',
    transition: 'all 0.2s',
    lineHeight: 1.4,
    width: '100%',
  },
  dataPreview: {
    marginTop: 8,
    padding: 12,
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.08)',
  },
  dataTitle: { color: '#9b8778', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 },
  statRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' },
  statLabel: { color: '#9b8778', fontSize: '0.74rem' },
  statVal: { color: '#f7f2ea', fontSize: '0.82rem', fontWeight: 500 },
  chatArea: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  messages: { flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 },
  welcome: { textAlign: 'center', padding: '40px 20px', color: '#9b8778' },
  welcomeIcon: { fontSize: '2.5rem', marginBottom: 12 },
  welcomeTitle: { fontFamily: 'serif', color: '#2c1a0e', fontSize: '1.5rem', marginBottom: 8 },
  msgUser: { alignSelf: 'flex-start', maxWidth: '78%' },
  msgAssistant: { alignSelf: 'flex-end', maxWidth: '78%' },
  senderLabel: { fontSize: '0.68rem', color: '#9b8778', marginBottom: 4, padding: '0 4px' },
  bubbleUser: {
    background: '#2c1a0e',
    color: '#f7f2ea',
    padding: '12px 16px',
    borderRadius: 16,
    borderBottomRightRadius: 4,
    fontSize: '0.9rem',
    lineHeight: 1.6,
  },
  bubbleAssistant: {
    background: '#ffffff',
    color: '#1a1208',
    padding: '14px 18px',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    border: '1px solid #e4d8c8',
    boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
  },
  typing: {
    display: 'flex', gap: 4, padding: '14px 18px',
    background: '#fff', border: '1px solid #e4d8c8',
    borderRadius: 16, borderBottomLeftRadius: 4,
    width: 'fit-content', alignSelf: 'flex-end',
  },
  typingDot: { width: 7, height: 7, background: '#c8923a', borderRadius: '50%' },
  inputArea: {
    padding: '14px 20px 18px',
    background: '#ffffff',
    borderTop: '1px solid #e4d8c8',
    display: 'flex',
    gap: 10,
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    border: '1.5px solid #e4d8c8',
    borderRadius: 14,
    padding: '11px 15px',
    fontFamily: 'inherit',
    fontSize: '0.9rem',
    color: '#1a1208',
    background: '#f7f2ea',
    resize: 'none',
    outline: 'none',
    minHeight: 44,
    maxHeight: 120,
    lineHeight: 1.5,
    direction: 'rtl',
  },
  sendBtn: {
    background: '#2c1a0e',
    color: '#f7f2ea',
    border: 'none',
    borderRadius: 12,
    width: 46,
    height: 46,
    cursor: 'pointer',
    fontSize: '1.1rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s',
    flexShrink: 0,
  },
};

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
      const [postsRes, metaRes, googleRes] = await Promise.all([
        supabase.from('meta_organic_posts').select('*').order('created_at', { ascending: false }).limit(100),
        supabase.from('meta_ad_campaigns').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('google_campaigns').select('*').order('created_at', { ascending: false }).limit(50),
      ]);

      const posts = postsRes.data || [];
      const meta  = metaRes.data  || [];
      const google = googleRes.data || [];

      setPostsData(posts);
      setMetaAds(meta);
      setGoogleAds(google);

      // Compute stats
      const reels = posts.filter(p => p.post_type === 'reel');
      const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
      const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
      const totalEng = posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0) + (p.shares || 0) + (p.saves || 0), 0);
      const avgEng = posts.length > 0 ? (totalEng / posts.length).toFixed(1) : 0;
      setStats({ posts: posts.length, reels: reels.length, totalLikes, totalComments, avgEng, metaCampaigns: meta.length, googleCampaigns: google.length });
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
${googleSummary.length > 0 ? JSON.stringify(googleSummary) : 'אין נתונים'}`;
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

  return (
    <>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .analyst-msg { animation: fadeUp 0.25s ease; }
        .quick-btn-analyst:hover { background: rgba(200,146,58,0.15) !important; border-color: #c8923a !important; color: #c8923a !important; }
        .analyst-send:hover:not(:disabled) { background: #6b3a1f !important; transform: scale(1.05); }
        .analyst-send:disabled { opacity: 0.4; cursor: not-allowed; }
        .analyst-textarea:focus { border-color: #c8923a !important; }
        .typing-dot-1 { animation: bounce 1.2s infinite; }
        .typing-dot-2 { animation: bounce 1.2s 0.2s infinite; }
        .typing-dot-3 { animation: bounce 1.2s 0.4s infinite; }
      `}</style>

      <div style={S.page}>
        {/* Header */}
        <div style={S.header}>
          <div style={S.headerTitle}>
            Minuto <span style={S.headerGold}>✦</span> AI Analyst
          </div>
          <div style={S.statusLabel}>
            <span style={S.statusDot} />
            {dataLoading ? 'טוען נתונים...' : 'מחובר לנתונים בזמן אמת'}
          </div>
        </div>

        <div style={S.body}>
          {/* Sidebar */}
          <div style={S.sidebar}>
            <div style={S.sidebarTitle}>שאלות מהירות</div>
            {QUICK_ASKS.map(qa => (
              <button
                key={qa.q}
                className="quick-btn-analyst"
                style={S.quickBtn}
                onClick={() => sendMessage(qa.q)}
                disabled={loading}
              >
                {qa.icon} {qa.label}
              </button>
            ))}

            {/* Data stats */}
            <div style={S.dataPreview}>
              <div style={S.dataTitle}>נתונים טעונים</div>
              {[
                ['פוסטים אורגניים', dataLoading ? 'טוען...' : (stats?.posts ?? '—')],
                ['ריילס', dataLoading ? '...' : (stats?.reels ?? '—')],
                ['סה״כ לייקים', dataLoading ? '...' : (stats?.totalLikes?.toLocaleString() ?? '—')],
                ['סה״כ תגובות', dataLoading ? '...' : (stats?.totalComments?.toLocaleString() ?? '—')],
                ['מעורבות ממוצעת', dataLoading ? '...' : (stats?.avgEng ?? '—')],
                ['קמפיינים Meta', dataLoading ? '...' : (stats?.metaCampaigns ?? '—')],
                ['קמפיינים Google', dataLoading ? '...' : (stats?.googleCampaigns ?? '—')],
              ].map(([label, val]) => (
                <div key={label} style={{ ...S.statRow, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={S.statLabel}>{label}</span>
                  <span style={S.statVal}>{val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Chat area */}
          <div style={S.chatArea}>
            <div style={S.messages}>
              {isEmpty && (
                <div style={S.welcome}>
                  <div style={S.welcomeIcon}>☕</div>
                  <h2 style={S.welcomeTitle}>שלום!</h2>
                  <p style={{ fontSize: '0.9rem', lineHeight: 1.6 }}>
                    אני מנתח את נתוני הביצועים של Minuto בזמן אמת.<br />
                    שאל אותי כל שאלה על אינסטגרם, קמפיינים ממומנים ואסטרטגיה.
                  </p>
                </div>
              )}

              {messages.map((m, i) => (
                <div key={i} className="analyst-msg" style={m.type === 'user' ? S.msgUser : S.msgAssistant}>
                  <div style={{ ...S.senderLabel, textAlign: m.type === 'user' ? 'right' : 'left' }}>
                    {m.type === 'user' ? 'אתה' : 'AI Analyst'}
                  </div>
                  {m.type === 'user' ? (
                    <div style={S.bubbleUser}>{m.text}</div>
                  ) : (
                    <div style={S.bubbleAssistant}>
                      <MarkdownBubble text={m.text} />
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div style={{ padding: '8px 0 4px' }}>
                  <ProgressBar progress={aiProgress.progress} label="מנתח נתונים..." color="#4A7C59" />
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div style={S.inputArea}>
              <textarea
                ref={textareaRef}
                className="analyst-textarea"
                style={S.textarea}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onInput={autoResize}
                placeholder="שאל אותי על הביצועים שלך..."
                rows={1}
                disabled={loading}
              />
              <button
                className="analyst-send"
                style={S.sendBtn}
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
              >
                ➤
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
