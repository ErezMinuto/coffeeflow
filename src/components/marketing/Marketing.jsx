import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useApp } from '../../lib/context';
import { callCampaignFunction } from '../../lib/brevo';
// Email HTML is built server-side (edge function) with banner images
import { supabase } from '../../lib/supabase';

const TABS = [
  { id: 'compose',     label: '🚀 קמפיין אוטומטי' },
  { id: 'automations', label: '⚡ אוטומציות' },
  { id: 'contacts',    label: '👥 אנשי קשר' },
  { id: 'history',     label: '📊 היסטוריה' },
];

const THEME_LABELS = {
  tips:      '💡 טיפים',
  story:     '📖 סיפור',
  promo:     '🏷️ מבצע',
  seasonal:  '🌿 עונתי',
  education: '📚 חינוך',
};

export default function Marketing() {
  const { data, user, showToast, marketingContactsDb, campaignsDb } = useApp();
  const [activeTab, setActiveTab] = useState('compose');
  const [duplicateData, setDuplicateData] = useState(null);

  const handleDuplicate = (campaign) => {
    setDuplicateData(campaign);
    setActiveTab('compose');
  };

  return (
    <div className="page">
      <h1>📧 Marketing</h1>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={activeTab === tab.id ? 'btn-primary' : 'btn-small'}
            style={{ fontSize: '0.9rem' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'compose'     && <AutoComposeTab data={data} user={user} showToast={showToast} duplicateData={duplicateData} clearDuplicate={() => setDuplicateData(null)} />}
      {activeTab === 'automations' && <AutomationsTab data={data} user={user} showToast={showToast} />}
      {activeTab === 'contacts'    && <ContactsTab data={data} user={user} showToast={showToast} />}
      {activeTab === 'history'     && <HistoryTab data={data} user={user} showToast={showToast} onDuplicate={handleDuplicate} />}
    </div>
  );
}

// ── Auto Compose Tab (AI-powered one-click) ─────────────────────────────────

function AutoComposeTab({ data, user, showToast, duplicateData, clearDuplicate }) {
  const [step, setStep]                 = useState('idle'); // idle | ideas | generating | draft | sending | sent
  const [hint, setHint]                 = useState('');
  const [ideas, setIdeas]               = useState([]);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [draft, setDraft]               = useState(null);
  const [editSubject, setEditSubject]   = useState('');
  const [editBody, setEditBody]         = useState('');
  const [testEmail, setTestEmail]       = useState('');
  const [syncing, setSyncing]           = useState(false);
  const [showContext, setShowContext]    = useState(false);
  const [editPreheader, setEditPreheader] = useState('');
  const [editGreeting, setEditGreeting]   = useState('');
  const [promoDeadline, setPromoDeadline] = useState('');
  const [saving, setSaving]             = useState(false);
  const [dirty, setDirty]               = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [allProducts, setAllProducts]    = useState([]);
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContacts, setSelectedContacts] = useState([]);  // [{email, name}]
  const [sendMode, setSendMode]          = useState('all'); // 'all' | 'selected'

  const optedInCount = (data.marketingContacts || []).filter(c => c.opted_in).length;

  // Handle duplicate campaign data arriving from history tab
  useEffect(() => {
    if (!duplicateData) return;
    const loadDuplicate = async () => {
      setStep('generating');
      try {
        // Create a new draft based on the old campaign
        const result = await callCampaignFunction(supabase, 'generate', {
          userId: user.id,
          customInstructions: `שכפול קמפיין קודם. נושא: ${duplicateData.subject}. תוכן: ${duplicateData.message || ''}`,
          duplicateFrom: duplicateData.id,
        });
        if (!result.ok) throw new Error(result.error || 'Duplication failed');
        setDraft(result.campaign);
        setEditSubject(result.campaign.subject);
        setEditBody(result.campaign.body);
        setEditPreheader(result.campaign.preheader || '');
        setEditGreeting(result.campaign.greeting || '');
        setDirty(false);
        setStep('draft');
      } catch (err) {
        // Fallback: just load the old data into editor fields
        setEditSubject(duplicateData.subject || '');
        setEditBody(duplicateData.message || '');
        setEditPreheader(duplicateData.preheader || '');
        setEditGreeting('');
        setDraft({
          id: null,
          subject: duplicateData.subject,
          body: duplicateData.message,
          htmlContent: duplicateData.html_content || '',
          products: [],
        });
        setDirty(true);
        setStep('draft');
        showToast('⚠️ שוכפל ללא יצירה מחדש — ערוך ושמור', 'warning');
      }
      clearDuplicate();
    };
    loadDuplicate();
  }, [duplicateData]);

  const getIdeas = async () => {
    setIdeasLoading(true);
    try {
      const result = await callCampaignFunction(supabase, 'generate-ideas', {
        userId: user.id,
        context: hint.trim() || undefined,
      });
      if (!result.ok) throw new Error(result.error || 'Failed to get ideas');
      setIdeas(result.ideas || []);
      setStep('ideas');
    } catch (err) {
      showToast(`❌ שגיאה בקבלת רעיונות: ${err.message}`, 'error');
    } finally {
      setIdeasLoading(false);
    }
  };

  const generateFromIdea = async (idea) => {
    const instructions = `${idea.title}: ${idea.description}`;
    setStep('generating');
    try {
      const result = await callCampaignFunction(supabase, 'generate', {
        userId: user.id,
        customInstructions: instructions,
      });
      if (!result.ok) throw new Error(result.error || 'Generation failed');
      setDraft(result.campaign);
      setEditSubject(result.campaign.subject);
      setEditBody(result.campaign.body);
      setEditPreheader(result.campaign.preheader || '');
      setEditGreeting(result.campaign.greeting || '');
      setDirty(false);
      setStep('draft');
    } catch (err) {
      showToast(`❌ שגיאה ביצירת קמפיין: ${err.message}`, 'error');
      setStep('ideas');
    }
  };

  const generateCampaign = async () => {
    setStep('generating');
    try {
      const result = await callCampaignFunction(supabase, 'generate', {
        userId: user.id,
        customInstructions: hint.trim() || undefined,
      });

      if (!result.ok) throw new Error(result.error || 'Generation failed');

      setDraft(result.campaign);
      setEditSubject(result.campaign.subject);
      setEditBody(result.campaign.body);
      setEditPreheader(result.campaign.preheader || '');
      setEditGreeting(result.campaign.greeting || '');
      setDirty(false);
      setStep('draft');
    } catch (err) {
      showToast(`❌ שגיאה ביצירת קמפיין: ${err.message}`, 'error');
      setStep('idle');
    }
  };

  const regenerate = () => {
    setDraft(null);
    setDirty(false);
    setStep('idle');
  };

  // Save edits — calls update-draft to rebuild HTML with current edits
  const saveEdits = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await callCampaignFunction(supabase, 'update-draft', {
        userId: user.id,
        campaignId: draft.id,
        subject: editSubject,
        body: editBody,
        preheader: editPreheader,
        greeting: editGreeting,
        bannerUrl: draft.bannerUrl || null,
        ctaText: draft.ctaText,
        ctaUrl: draft.ctaUrl,
        products: draft.products || [],
        promoDeadline: promoDeadline || null,
      });
      if (result.htmlContent) {
        setDraft(prev => ({ ...prev, htmlContent: result.htmlContent, subject: editSubject, body: editBody, preheader: editPreheader, greeting: editGreeting }));
        setDirty(false);
        showToast('✅ השינויים נשמרו');
      }
    } catch (err) {
      showToast(`❌ שגיאה בשמירה: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Mark dirty when any field changes
  const onFieldChange = (setter) => (e) => {
    setter(e.target.value);
    setDirty(true);
  };

  // Fetch all products for the product picker
  const loadAllProducts = async () => {
    try {
      const { data: products } = await supabase
        .from('woo_products')
        .select('woo_id, name, price, image_url, permalink, regular_price, sale_price, short_description')
        .eq('user_id', user.id)
        .eq('stock_status', 'instock')
        .order('name');
      setAllProducts(products || []);
    } catch (err) {
      console.error('Failed to load products:', err);
    }
  };

  const addProduct = (product) => {
    if (!draft) return;
    // Don't add duplicates
    if (draft.products.some(p => p.woo_id === product.woo_id)) return;
    setDraft(prev => ({
      ...prev,
      products: [...(prev.products || []), product],
    }));
    setDirty(true);
  };



  // Use a blob URL for the preview so the iframe shares the parent origin,
  // which avoids CORS issues loading Supabase storage images via srcDoc's opaque origin
  const previewBlobUrl = useMemo(() => {
    const html = draft?.htmlContent || '';
    if (!html) return '';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    return URL.createObjectURL(blob);
  }, [draft?.htmlContent]);

  // Clean up blob URL on unmount or when it changes
  useEffect(() => {
    return () => { if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl); };
  }, [previewBlobUrl]);

  const sendTest = async () => {
    if (!testEmail.trim()) {
      showToast('⚠️ נא להזין כתובת מייל לטסט', 'warning');
      return;
    }
    setStep('sending');
    try {
      const result = await callCampaignFunction(supabase, 'send-test', {
        userId: user.id,
        campaignId: draft.id,
        testEmail: testEmail.trim(),
      });
      showToast(`✅ טסט נשלח ל-${testEmail}!`);
      setStep('draft');
    } catch (err) {
      showToast(`❌ שגיאה בשליחת טסט: ${err.message}`, 'error');
      setStep('draft');
    }
  };

  const sendCampaign = async () => {
    const recipientCount = sendMode === 'selected' ? selectedContacts.length : optedInCount;
    if (recipientCount === 0) {
      showToast(sendMode === 'selected' ? '⚠️ לא נבחרו נמענים' : '⚠️ אין אנשי קשר שאישרו קבלת מיילים', 'warning');
      return;
    }
    if (!window.confirm(`לשלוח את הקמפיין ל-${recipientCount} נמענים?`)) return;

    setStep('sending');
    try {
      const payload = {
        userId: user.id,
        campaignId: draft.id,
      };
      if (sendMode === 'selected' && selectedContacts.length > 0) {
        payload.selectedRecipients = selectedContacts;
      }
      const result = await callCampaignFunction(supabase, 'send-campaign', payload);
      showToast(`✅ הקמפיין נשלח ל-${result.sent} נמענים!`);
      setStep('sent');
    } catch (err) {
      showToast(`❌ שגיאה בשליחה: ${err.message}`, 'error');
      setStep('draft');
    }
  };

  const syncProducts = async () => {
    setSyncing(true);
    try {
      const result = await callCampaignFunction(supabase, 'sync-woo-products', {
        userId: user.id,
      });
      showToast(`✅ סונכרנו ${result.synced} מוצרים מ-WooCommerce`);
    } catch (err) {
      showToast(`❌ שגיאה בסנכרון: ${err.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const removeProduct = (wooId) => {
    if (!draft) return;
    setDraft({
      ...draft,
      products: draft.products.filter(p => p.woo_id !== wooId),
    });
    setDirty(true);
  };

  // ── IDLE: Generate button ─────────────────────────────────────────────

  if (step === 'idle') {
    return (
      <div className="section">
        <div style={{
          textAlign: 'center', padding: '40px 20px',
          background: 'linear-gradient(135deg, #F0FDF4, #ECFDF5)',
          borderRadius: '16px', border: '2px solid #BBF7D0',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🤖</div>
          <h2 style={{ color: '#3D4A2E', marginBottom: '8px', fontSize: '1.5rem' }}>
            יצירת קמפיין אוטומטי
          </h2>
          <p style={{ color: '#666', maxWidth: '420px', margin: '0 auto 20px' }}>
            ה-AI ייצור מייל מושלם בעברית עם מוצרים מהחנות שלך.
            <br />רק תאשר ותשלח.
          </p>

          {/* Context / prompt area */}
          <div style={{ maxWidth: '480px', margin: '0 auto 20px', textAlign: 'right' }}>
            <button
              onClick={() => setShowContext(prev => !prev)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#556B3A', fontSize: '0.9rem', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '6px',
                margin: '0 auto 8px', direction: 'rtl',
              }}
            >
              <span style={{ transform: showContext ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'inline-block' }}>◀</span>
              💡 רוצה לכוון את ה-AI? (אופציונלי)
            </button>

            {showContext && (
              <div style={{
                background: 'white', borderRadius: '12px', padding: '16px',
                border: '1px solid #D4E8C2', textAlign: 'right', direction: 'rtl',
              }}>
                <textarea
                  placeholder="ספר ל-AI על מה הקמפיין... למשל הגיע קפה חדש, יש מבצע, תקופת חגים..."
                  value={hint}
                  onChange={e => setHint(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: '8px',
                    border: '1px solid #ddd', fontSize: '0.9rem',
                    fontFamily: 'inherit', resize: 'vertical', direction: 'rtl',
                  }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
                  {[
                    { label: '☀️ קיץ', text: 'תקופת קיץ, קפה קר ומרענן' },
                    { label: '🎄 חגים', text: 'תקופת חגים, מתנות ומבצעים' },
                    { label: '🏷️ מבצע', text: 'מבצע מיוחד באתר, הנחות' },
                    { label: '☕ מוצר חדש', text: 'מוצר חדש שהגיע לחנות' },
                    { label: '🫘 קלייה חדשה', text: 'קלייה חדשה שהגיעה, מקור יחיד' },
                    { label: '🎁 כוסות/אביזרים', text: 'קידום כוסות ואביזרי קפה' },
                  ].map(chip => (
                    <button
                      key={chip.label}
                      onClick={() => setHint(prev => prev ? `${prev}, ${chip.text}` : chip.text)}
                      style={{
                        background: hint.includes(chip.text) ? '#DCFCE7' : '#F5F5F0',
                        border: hint.includes(chip.text) ? '1px solid #86EFAC' : '1px solid #E5E5DB',
                        borderRadius: '20px', padding: '4px 12px', cursor: 'pointer',
                        fontSize: '0.8rem', color: '#3D4A2E', fontWeight: 500,
                        transition: 'all 0.15s',
                      }}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={getIdeas}
              disabled={ideasLoading}
              className="btn-primary"
              style={{ fontSize: '1.1rem', padding: '14px 32px' }}
            >
              {ideasLoading ? '⏳ חושב...' : '💡 תן לי רעיונות'}
            </button>
            <button
              onClick={generateCampaign}
              className="btn-small"
              style={{ fontSize: '0.95rem', padding: '14px 24px' }}
            >
              🚀 צור ישירות
            </button>
          </div>

          <div style={{ marginTop: '16px' }}>
            <button onClick={syncProducts} disabled={syncing} className="btn-small" style={{ fontSize: '0.8rem' }}>
              {syncing ? '⏳ מסנכרן...' : '🔄 סנכרן מוצרים מ-WooCommerce'}
            </button>
          </div>

          <p style={{ color: '#888', fontSize: '0.8rem', marginTop: '16px' }}>
            {optedInCount} נמענים מאושרים
          </p>
        </div>
      </div>
    );
  }

  // ── IDEAS: Pick a concept ──────────────────────────────────────────────

  if (step === 'ideas') {
    const themeIcons = { tips: '💡', story: '📖', promo: '🏷️', seasonal: '🌿', education: '📚' };
    return (
      <div className="section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0 }}>💡 בחר רעיון לקמפיין</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setIdeas([]); setStep('idle'); }} className="btn-small">← חזור</button>
            <button onClick={getIdeas} disabled={ideasLoading} className="btn-small">
              {ideasLoading ? '⏳' : '🔄'} רעיונות חדשים
            </button>
          </div>
        </div>

        {hint.trim() && (
          <div style={{
            background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '8px',
            padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem',
            color: '#0369A1', direction: 'rtl',
          }}>
            <strong>ההקשר שלך:</strong> {hint}
          </div>
        )}

        <div style={{ display: 'grid', gap: '12px' }}>
          {ideas.map((idea, i) => (
            <div
              key={i}
              onClick={() => generateFromIdea(idea)}
              style={{
                background: '#FFFFFF', borderRadius: '12px', padding: '20px',
                border: '1px solid #E8E8E0', cursor: 'pointer',
                transition: 'all 0.15s',
                display: 'flex', gap: '16px', alignItems: 'flex-start',
                direction: 'rtl',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#86EFAC'; e.currentTarget.style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#E8E8E0'; e.currentTarget.style.boxShadow = 'none'; }}
            >
              <div style={{ fontSize: '2rem', lineHeight: 1 }}>
                {themeIcons[idea.theme] || '📧'}
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: '0 0 6px', color: '#2C3522', fontSize: '1.05rem' }}>{idea.title}</h3>
                <p style={{ margin: '0 0 8px', color: '#666', fontSize: '0.9rem', lineHeight: 1.5 }}>{idea.description}</p>
                {idea.suggestedProducts && idea.suggestedProducts.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {idea.suggestedProducts.map((prod, j) => (
                      <span key={j} style={{
                        background: '#F0FDF4', border: '1px solid #BBF7D0',
                        borderRadius: '12px', padding: '2px 10px',
                        fontSize: '0.75rem', color: '#3D4A2E',
                      }}>
                        {prod}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ color: '#556B3A', fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', alignSelf: 'center' }}>
                בחר →
              </div>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: '20px' }}>
          <button onClick={generateCampaign} className="btn-small" style={{ fontSize: '0.9rem' }}>
            🚀 או צור קמפיין ישירות בלי לבחור רעיון
          </button>
        </div>
      </div>
    );
  }

  // ── GENERATING: Loading ────────────────────────────────────────────────

  if (step === 'generating') {
    return (
      <div className="section">
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px', animation: 'spin 2s linear infinite' }}>🤖</div>
          <h2 style={{ color: '#3D4A2E' }}>יוצר את הקמפיין שלך...</h2>
          <p style={{ color: '#666' }}>מסנכרן מוצרים, יוצר תוכן בעברית, בונה עיצוב</p>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  // ── SENT: Success ─────────────────────────────────────────────────────

  if (step === 'sent') {
    return (
      <div className="section">
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontSize: '64px', marginBottom: '16px' }}>🎉</div>
          <h2 style={{ color: '#065F46' }}>הקמפיין נשלח בהצלחה!</h2>
          <p style={{ color: '#666', marginBottom: '24px' }}>
            המייל נשלח ל-{optedInCount} נמענים
          </p>
          <button onClick={() => { setDraft(null); setStep('idle'); setHint(''); }} className="btn-primary">
            צור קמפיין חדש
          </button>
        </div>
      </div>
    );
  }

  // ── DRAFT / SENDING: Review & Approve ─────────────────────────────────

  return (
    <div className="section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>📝 עריכת הקמפיין</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {draft?.theme && (
            <span style={{
              background: '#DCFCE7', padding: '4px 12px', borderRadius: '12px',
              fontSize: '0.8rem', fontWeight: 600,
            }}>
              {THEME_LABELS[draft.theme] || draft.theme}
            </span>
          )}
          {dirty && (
            <button
              onClick={saveEdits}
              disabled={saving}
              className="btn-primary"
              style={{ fontSize: '0.85rem', padding: '6px 16px', animation: 'pulse 2s infinite' }}
            >
              {saving ? '⏳ שומר...' : '💾 שמור שינויים'}
            </button>
          )}
          <button onClick={regenerate} className="btn-small">🔄 צור מחדש</button>
        </div>
      </div>

      <style>{`@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.7; } }`}</style>

      {/* Banner text — subject + preheader overlay */}
      <div className="form-card" style={{ marginBottom: '12px', background: '#F9F8F5' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>🖼️ טקסט על הבאנר</label>
        <div className="form-group" style={{ marginBottom: '8px' }}>
          <label style={{ fontSize: '0.8rem', color: '#888' }}>כותרת (מופיע על התמונה)</label>
          <input
            type="text"
            value={editSubject}
            onChange={onFieldChange(setEditSubject)}
            style={{ fontSize: '1rem', fontWeight: 600 }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontSize: '0.8rem', color: '#888' }}>תת-כותרת (מופיע מתחת)</label>
          <input
            type="text"
            value={editPreheader}
            onChange={onFieldChange(setEditPreheader)}
            placeholder="משפט קצר שמופיע מתחת לכותרת על הבאנר..."
            style={{ fontSize: '0.9rem' }}
          />
        </div>
      </div>

      {/* Greeting + Body */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <div className="form-group" style={{ marginBottom: '8px' }}>
          <label style={{ fontWeight: 600 }}>פתיחה</label>
          <input
            type="text"
            value={editGreeting}
            onChange={onFieldChange(setEditGreeting)}
            placeholder="היי / שלום / מה קורה"
            style={{ fontSize: '1rem', fontWeight: 600 }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontWeight: 600 }}>תוכן ההודעה</label>
          <textarea
            value={editBody}
            onChange={onFieldChange(setEditBody)}
            rows={6}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', direction: 'rtl' }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0, marginTop: '12px' }}>
          <label style={{ fontSize: '0.85rem', color: '#888' }}>📅 תאריך סיום מבצע (אופציונלי — מופיע בתחתית המייל)</label>
          <input
            type="date"
            value={promoDeadline}
            onChange={onFieldChange(setPromoDeadline)}
            style={{ fontSize: '0.9rem', direction: 'ltr', maxWidth: '200px' }}
          />
          {promoDeadline && (
            <p style={{ fontSize: '0.8rem', color: '#556B3A', margin: '4px 0 0', direction: 'rtl' }}>
              יוצג: המבצע עד ה־{new Date(promoDeadline).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })} או עד גמר המלאי, הראשון מבינהם | ט.ל.ח
            </p>
          )}
        </div>
      </div>

      {/* Products — with add/remove */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <label style={{ fontWeight: 600 }}>
            מוצרים ({(draft?.products || []).length})
          </label>
          <button
            onClick={() => { setShowProductPicker(!showProductPicker); if (!allProducts.length) loadAllProducts(); }}
            className="btn-small"
            style={{ fontSize: '0.8rem', padding: '4px 12px' }}
          >
            {showProductPicker ? '✕ סגור' : '➕ הוסף מוצר'}
          </button>
        </div>

        {/* Product picker dropdown */}
        {showProductPicker && (
          <div style={{
            background: '#FAFAF7', border: '1px solid #E8E8E0', borderRadius: '10px',
            padding: '12px', marginBottom: '12px',
          }}>
            <input
              type="text"
              value={productSearch}
              onChange={e => setProductSearch(e.target.value)}
              placeholder="חפש מוצר..."
              style={{
                width: '100%', padding: '8px 12px', borderRadius: '8px',
                border: '1px solid #ddd', fontSize: '0.9rem', direction: 'rtl', marginBottom: '8px',
              }}
            />
            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {allProducts
                .filter(p => {
                  const q = productSearch.toLowerCase();
                  if (!q) return true;
                  return (p.name || '').toLowerCase().includes(q);
                })
                .slice(0, 20)
                .map(p => {
                  const alreadyAdded = (draft?.products || []).some(dp => dp.woo_id === p.woo_id);
                  return (
                    <div
                      key={p.woo_id}
                      onClick={() => !alreadyAdded && addProduct(p)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '8px', borderRadius: '8px', cursor: alreadyAdded ? 'default' : 'pointer',
                        opacity: alreadyAdded ? 0.5 : 1,
                        direction: 'rtl',
                      }}
                      onMouseEnter={e => { if (!alreadyAdded) e.currentTarget.style.background = '#F0FDF4'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {p.image_url && (
                        <img src={p.image_url} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover' }} />
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#3D4A2E' }}>{p.name}</div>
                        {p.price && <div style={{ fontSize: '0.75rem', color: '#888' }}>₪{p.price}</div>}
                      </div>
                      {alreadyAdded
                        ? <span style={{ fontSize: '0.75rem', color: '#10B981' }}>✓ נוסף</span>
                        : <span style={{ fontSize: '0.8rem', color: '#556B3A' }}>➕</span>
                      }
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* Current products */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {(draft?.products || []).map(p => (
            <div key={p.woo_id} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              background: '#F0FDF4', border: '1px solid #BBF7D0',
              borderRadius: '8px', padding: '6px 10px',
            }}>
              {p.image_url && (
                <img src={p.image_url} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }} />
              )}
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#3D4A2E' }}>{p.name}</div>
                {p.price && <div style={{ fontSize: '0.75rem', color: '#556B3A' }}>₪{p.price}</div>}
              </div>
              <button
                onClick={() => removeProduct(p.woo_id)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: '1rem', color: '#999', padding: '0 4px',
                }}
              >
                ✕
              </button>
            </div>
          ))}
          {(draft?.products || []).length === 0 && (
            <div style={{ color: '#999', fontSize: '0.85rem', fontStyle: 'italic' }}>אין מוצרים. לחץ "הוסף מוצר" למעלה.</div>
          )}
        </div>
      </div>

      {/* Save reminder + Preview */}
      {dirty && (
        <div style={{
          background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: '8px',
          padding: '10px 14px', marginBottom: '12px', fontSize: '0.85rem',
          color: '#92400E', direction: 'rtl', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>⚠️ יש שינויים שלא נשמרו. שמור כדי לעדכן את התצוגה המקדימה.</span>
          <button onClick={saveEdits} disabled={saving} className="btn-primary" style={{ fontSize: '0.8rem', padding: '4px 14px' }}>
            {saving ? '⏳' : '💾'} שמור
          </button>
        </div>
      )}

      <div className="form-card" style={{ marginBottom: '12px' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>👁️ תצוגה מקדימה</label>
        <iframe
          src={previewBlobUrl || 'about:blank'}
          style={{ width: '100%', height: '600px', border: '1px solid #ddd', borderRadius: '8px' }}
          title="Email Preview"
        />
      </div>

      {/* Actions */}
      <div className="form-card">
        {/* Test send */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <input
            type="email"
            placeholder="מייל לטסט (שלך)"
            value={testEmail}
            onChange={e => setTestEmail(e.target.value)}
            style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.9rem' }}
          />
          <button
            onClick={sendTest}
            disabled={step === 'sending'}
            className="btn-small"
            style={{ whiteSpace: 'nowrap' }}
          >
            {step === 'sending' ? '⏳' : '📧'} שלח טסט
          </button>
        </div>

        {/* Send mode toggle */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px', fontSize: '0.9rem' }}>📬 שלח אל:</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => { setSendMode('all'); setShowContactPicker(false); }}
              className={sendMode === 'all' ? 'btn-primary' : 'btn-small'}
              style={{ fontSize: '0.85rem', padding: '6px 16px' }}
            >
              כל הנמענים ({optedInCount})
            </button>
            <button
              onClick={() => { setSendMode('selected'); setShowContactPicker(true); }}
              className={sendMode === 'selected' ? 'btn-primary' : 'btn-small'}
              style={{ fontSize: '0.85rem', padding: '6px 16px' }}
            >
              בחירה ידנית {selectedContacts.length > 0 ? `(${selectedContacts.length})` : ''}
            </button>
          </div>
        </div>

        {/* Contact picker */}
        {showContactPicker && (
          <div style={{
            border: '1px solid #D4E8C2', borderRadius: '10px', padding: '12px',
            marginBottom: '12px', background: '#FAFFF5', maxHeight: '300px', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <input
              type="text"
              placeholder="🔍 חפש לפי שם או אימייל..."
              value={contactSearch}
              onChange={e => setContactSearch(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: '8px',
                border: '1px solid #ddd', fontSize: '0.85rem', marginBottom: '8px',
                direction: 'rtl',
              }}
            />
            {selectedContacts.length > 0 && (
              <div style={{ marginBottom: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {selectedContacts.map(c => (
                  <span key={c.email} style={{
                    background: '#DCFCE7', border: '1px solid #86EFAC', borderRadius: '16px',
                    padding: '2px 10px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '4px',
                  }}>
                    {c.name || c.email}
                    <button
                      onClick={() => setSelectedContacts(prev => prev.filter(s => s.email !== c.email))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: '#666', padding: 0 }}
                    >✕</button>
                  </span>
                ))}
                <button
                  onClick={() => setSelectedContacts([])}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: '#999' }}
                >נקה הכל</button>
              </div>
            )}
            <div style={{ overflowY: 'auto', maxHeight: '200px' }}>
              {(data.marketingContacts || [])
                .filter(c => c.opted_in)
                .filter(c => {
                  if (!contactSearch.trim()) return true;
                  const q = contactSearch.toLowerCase();
                  return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q);
                })
                .slice(0, 50)
                .map(c => {
                  const isSelected = selectedContacts.some(s => s.email === c.email);
                  return (
                    <label key={c.id} style={{
                      display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
                      borderRadius: '6px', cursor: 'pointer', direction: 'rtl',
                      background: isSelected ? '#F0FDF4' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#F5F5F0'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          if (isSelected) {
                            setSelectedContacts(prev => prev.filter(s => s.email !== c.email));
                          } else {
                            setSelectedContacts(prev => [...prev, { email: c.email, name: c.name }]);
                          }
                        }}
                        style={{ accentColor: '#3D4A2E' }}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#2C3522' }}>{c.name || '—'}</span>
                        <span style={{ fontSize: '0.8rem', color: '#888', marginRight: '8px', fontFamily: 'monospace' }}>{c.email}</span>
                      </div>
                    </label>
                  );
                })}
            </div>
          </div>
        )}

        {/* Approve & Send */}
        <button
          onClick={sendCampaign}
          disabled={step === 'sending' || (sendMode === 'all' ? optedInCount === 0 : selectedContacts.length === 0)}
          className="btn-primary"
          style={{ width: '100%', fontSize: '1.1rem', padding: '14px' }}
        >
          {step === 'sending'
            ? '⏳ שולח...'
            : sendMode === 'selected'
              ? `✅ שלח ל-${selectedContacts.length} נמענים שנבחרו`
              : `✅ אשר ושלח ל-${optedInCount} נמענים`
          }
        </button>
      </div>
    </div>
  );
}

// ── Automations Tab ─────────────────────────────────────────────────────────

function AutomationsTab({ data, user, showToast }) {
  const AUTOMATIONS = [
    {
      type: 'welcome',
      icon: '👋',
      title: 'מייל ברוכים הבאים',
      description: 'נשלח אוטומטית ללקוח חדש שנרשם באתר',
      trigger: 'הרשמה חדשה באתר',
      delay: 'מיידי',
    },
    {
      type: 'cart_abandon',
      icon: '🛒',
      title: 'עגלה נטושה',
      description: 'נשלח כשלקוח מוסיף לעגלה אבל לא משלים רכישה',
      trigger: 'עגלה נטושה',
      delay: 'שעה אחרי',
    },
    {
      type: 'post_purchase_tips',
      icon: '☕',
      title: 'טיפים אחרי רכישה',
      description: 'טיפים להכנת הקפה שנרכש',
      trigger: 'הזמנה הושלמה',
      delay: '3 ימים אחרי',
    },
    {
      type: 'post_purchase_reorder',
      icon: '🔄',
      title: 'תזכורת להזמנה חוזרת',
      description: '"נגמר הקפה? הגיע הזמן להזמין שוב"',
      trigger: 'הזמנה הושלמה',
      delay: '25 ימים אחרי',
    },
  ];

  return (
    <div className="section">
      <h2>⚡ אוטומציות מייל</h2>
      <p style={{ color: '#666', marginBottom: '1.5rem' }}>
        מיילים אוטומטיים שנכתבים פעם אחת ורצים לבד. מופעלים ע"י אירועים מה-WooCommerce שלך.
      </p>

      <div style={{ display: 'grid', gap: '12px' }}>
        {AUTOMATIONS.map(auto => (
          <div key={auto.type} className="form-card" style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
            <div style={{ fontSize: '2rem', lineHeight: 1 }}>{auto.icon}</div>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: '0 0 4px', color: '#3D4A2E' }}>{auto.title}</h3>
              <p style={{ margin: '0 0 8px', color: '#666', fontSize: '0.9rem' }}>{auto.description}</p>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <span style={{ background: '#EDE9FE', padding: '2px 8px', borderRadius: '6px', fontSize: '0.75rem', color: '#5B21B6' }}>
                  טריגר: {auto.trigger}
                </span>
                <span style={{ background: '#FEF3C7', padding: '2px 8px', borderRadius: '6px', fontSize: '0.75rem', color: '#92400E' }}>
                  עיכוב: {auto.delay}
                </span>
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <span style={{
                display: 'inline-block', padding: '4px 12px', borderRadius: '12px',
                fontSize: '0.8rem', fontWeight: 600,
                background: '#FEF3C7', color: '#92400E',
              }}>
                🔧 בקרוב
              </span>
            </div>
          </div>
        ))}
      </div>

      <div style={{
        marginTop: '1.5rem', padding: '16px',
        background: '#F0F9FF', border: '1px solid #BAE6FD',
        borderRadius: '8px', fontSize: '0.85rem', color: '#0369A1',
      }}>
        <strong>💡 איך זה עובד?</strong>
        <br />
        1. ה-AI כותב את התוכן בעברית (פעם אחת)
        <br />
        2. ה-WooCommerce Plugin שלך שולח אירועים (הזמנה חדשה, עגלה נטושה, לקוח חדש)
        <br />
        3. המערכת שולחת את המייל המתאים אוטומטית דרך Resend
        <br />
        4. אתה לא עושה כלום — זה פשוט עובד 🎉
      </div>
    </div>
  );
}

// ── Contacts Tab ────────────────────────────────────────────────────────────

function ContactsTab({ data, user, showToast }) {
  const [contactFilter, setContactFilter] = useState('all');
  const [syncingResend, setSyncingResend] = useState(false);
  const [importingFlashy, setImportingFlashy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const [searchQuery, setSearchQuery] = useState('');
  // Contacts synced from Resend (read-only cache in Supabase)
  const contacts = data.marketingContacts || [];
  const optedIn  = contacts.filter(c => c.opted_in).length;
  const optedOut = contacts.length - optedIn;
  const filteredContacts = contacts.filter(c => {
    if (contactFilter === 'opted_in' && !c.opted_in) return false;
    if (contactFilter === 'opted_out' && c.opted_in) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!(c.name || '').toLowerCase().includes(q) && !(c.email || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const syncFromResend = async () => {
    setSyncingResend(true);
    try {
      const result = await callCampaignFunction(supabase, 'sync-resend-contacts', { userId: user.id });
      showToast(`✅ סונכרנו ${result.synced} אנשי קשר מ-Resend`);
    } catch (err) {
      showToast(`❌ שגיאה בסנכרון: ${err.message}`, 'error');
    } finally {
      setSyncingResend(false);
    }
  };

  const importFlashyCSV = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // reset so same file can be re-selected
    setImportingFlashy(true);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const text = ev.target.result;
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) { showToast('⚠️ קובץ ריק', 'warning'); return; }

        // Parse header — detect column indices case-insensitively
        const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
        const idx = (keys) => { for (const k of keys) { const i = header.findIndex(h => h.includes(k)); if (i >= 0) return i; } return -1; };
        const emailIdx  = idx(['email']);
        if (emailIdx < 0) { showToast('❌ לא נמצאה עמודת email בקובץ', 'error'); return; }
        const firstIdx  = idx(['first_name', 'firstname', 'first name', 'שם פרטי']);
        const lastIdx   = idx(['last_name', 'lastname', 'last name', 'שם משפחה']);
        const nameIdx   = idx(['name', 'full_name', 'שם']);
        const phoneIdx  = idx(['phone', 'mobile', 'טלפון']);
        const statusIdx = idx(['status', 'subscription_status', 'subscribed', 'opted_in', 'opt_in']);
        const tagsIdx   = idx(['tags']);

        const APPROVED = new Set(['subscribed', 'active', 'approved', 'yes', '1', 'true', 'opted_in', 'optin']);

        // Fix double-encoded Hebrew: Flashy exports UTF-8 bytes that were
        // misread as Latin-1, then re-encoded as UTF-8.  Re-encode as Latin-1
        // bytes and decode as UTF-8 to recover the original Hebrew text.
        const fixHebrew = (str) => {
          if (!str || !/[\xC0-\xFF]/.test(str)) return str;
          try {
            const bytes = Uint8Array.from(str, c => c.charCodeAt(0) & 0xFF);
            return new TextDecoder('utf-8').decode(bytes);
          } catch { return str; }
        };

        const parseRow = (line) => {
          // Handle quoted CSV values
          const cols = [];
          let cur = '', inQ = false;
          for (const ch of line) {
            if (ch === '"') { inQ = !inQ; }
            else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
            else { cur += ch; }
          }
          cols.push(cur.trim());
          return cols;
        };

        const rows = lines.slice(1).map(parseRow);
        const contacts = rows
          .map(cols => {
            const email = cols[emailIdx]?.replace(/"/g, '').trim().toLowerCase();
            if (!email || !email.includes('@')) return null;

            // Skip if tags contain "unsubscribed" (Flashy format)
            if (tagsIdx >= 0) {
              const tagsRaw = (cols[tagsIdx] || '').replace(/^"|"$/g, '').trim();
              try {
                const tags = tagsRaw ? JSON.parse(tagsRaw) : [];
                if (tags.includes('unsubscribed')) return null;
              } catch {}
            }

            // Skip if explicit status column exists and is not approved
            if (statusIdx >= 0) {
              const status = (cols[statusIdx] || '').replace(/"/g, '').trim().toLowerCase();
              if (status && !APPROVED.has(status)) return null;
            }

            const firstName = fixHebrew(firstIdx >= 0 ? (cols[firstIdx] || '').replace(/"/g, '').trim() : '');
            const lastName  = fixHebrew(lastIdx  >= 0 ? (cols[lastIdx]  || '').replace(/"/g, '').trim() : '');
            const fullName  = nameIdx  >= 0
              ? fixHebrew((cols[nameIdx] || '').replace(/"/g, '').trim())
              : [firstName, lastName].filter(Boolean).join(' ');
            const phone = phoneIdx >= 0 ? (cols[phoneIdx] || '').replace(/"/g, '').trim() : '';
            return { user_id: user.id, email, name: fullName || null, phone: phone || null, source: 'flashy', opted_in: true };
          })
          .filter(Boolean);

        const skipped = rows.length - contacts.length;
        if (contacts.length === 0) {
          showToast(statusIdx >= 0 ? `⚠️ לא נמצאו אנשי קשר מאושרים (${skipped} לא מאושרים דולגו)` : '⚠️ לא נמצאו אנשי קשר תקינים', 'warning');
          return;
        }

        // Upsert in batches of 100
        let imported = 0;
        for (let i = 0; i < contacts.length; i += 100) {
          const batch = contacts.slice(i, i + 100);
          const { error } = await supabase.from('marketing_contacts')
            .upsert(batch, { onConflict: 'email', ignoreDuplicates: false });
          if (error) throw new Error(error.message);
          imported += batch.length;
        }
        const skippedMsg = skipped > 0 ? ` (${skipped} לא מאושרים דולגו)` : '';
        showToast(`✅ יובאו ${imported} אנשי קשר מ-Flashy${skippedMsg}`);
        marketingContactsDb.refresh();
      } catch (err) {
        showToast(`❌ שגיאה בייבוא: ${err.message}`, 'error');
      } finally {
        setImportingFlashy(false);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  return (
    <div className="section">
      <h2>👥 אנשי קשר ({contacts.length})</h2>

      {/* Info banner */}
      <div style={{
        background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '10px',
        padding: '12px 16px', marginBottom: '1rem', fontSize: '0.85rem', color: '#0369A1', direction: 'rtl',
      }}>
        <strong>📧 Resend = מקור האמת.</strong> אנשי הקשר מנוהלים ב-Resend.
        הרשמות מהאתר נכנסות ישירות ל-Resend. לחץ "סנכרן" לעדכון התצוגה.
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div style={{ background: '#DCFCE7', borderRadius: '10px', padding: '8px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#065F46' }}>{optedIn}</div>
          <div style={{ fontSize: '0.7rem', color: '#065F46' }}>מאושרים</div>
        </div>
        <div style={{ background: '#FEE2E2', borderRadius: '10px', padding: '8px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#991B1B' }}>{optedOut}</div>
          <div style={{ fontSize: '0.7rem', color: '#991B1B' }}>הוסרו</div>
        </div>
        <div style={{ background: '#F3F4F6', borderRadius: '10px', padding: '8px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#374151' }}>{contacts.length}</div>
          <div style={{ fontSize: '0.7rem', color: '#6B7280' }}>סה״כ</div>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '1rem' }}>
        {[
          { id: 'all', label: `הכל (${contacts.length})` },
          { id: 'opted_in', label: `✅ מאושרים (${optedIn})` },
          { id: 'opted_out', label: `🔕 הוסרו (${optedOut})` },
        ].map(f => (
          <button
            key={f.id}
            onClick={() => setContactFilter(f.id)}
            className={contactFilter === f.id ? 'btn-primary' : 'btn-small'}
            style={{ fontSize: '0.8rem', padding: '5px 12px' }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button onClick={syncFromResend} disabled={syncingResend} className="btn-primary" style={{ fontSize: '0.85rem' }}>
          {syncingResend ? '⏳ מסנכרן...' : '🔄 סנכרן מ-Resend'}
        </button>
        <label style={{ cursor: importingFlashy ? 'not-allowed' : 'pointer' }}>
          <input type="file" accept=".csv" style={{ display: 'none' }} onChange={importFlashyCSV} disabled={importingFlashy} />
          <span className="btn-small" style={{ fontSize: '0.85rem', pointerEvents: importingFlashy ? 'none' : 'auto', opacity: importingFlashy ? 0.6 : 1 }}>
            {importingFlashy ? '⏳ מייבא...' : '📥 ייבא מ-Flashy CSV'}
          </span>
        </label>
        <a
          href="https://resend.com/contacts"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-small"
          style={{ textDecoration: 'none', fontSize: '0.85rem' }}
        >
          📋 ניהול אנשי קשר ב-Resend
        </a>
      </div>

      {/* Search */}
      <div style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="🔍 חפש לפי שם או אימייל..."
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setVisibleCount(50); }}
          style={{
            width: '100%', padding: '10px 14px', borderRadius: '8px',
            border: '1px solid #ddd', fontSize: '0.9rem', direction: 'rtl',
          }}
        />
        {searchQuery && (
          <p style={{ color: '#888', fontSize: '0.8rem', marginTop: '4px' }}>
            נמצאו {filteredContacts.length} תוצאות
          </p>
        )}
      </div>

      {/* Contacts table */}
      {filteredContacts.length > 0 ? (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>שם</th>
                <th>אימייל</th>
                <th>סטטוס</th>
              </tr>
            </thead>
            <tbody>
              {filteredContacts.slice(0, visibleCount).map(c => (
                <tr key={c.id}>
                  <td><strong>{c.name || '—'}</strong></td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{c.email}</td>
                  <td>
                    <span style={{
                      background: c.opted_in ? '#DCFCE7' : '#FEE2E2',
                      color: c.opted_in ? '#065F46' : '#991B1B',
                      padding: '3px 10px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600,
                    }}>
                      {c.opted_in ? '✅ מאושר' : '🔕 הוסר'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredContacts.length > visibleCount && (
            <div style={{ textAlign: 'center', marginTop: '12px' }}>
              <button
                onClick={() => setVisibleCount(prev => prev + 50)}
                className="btn-small"
                style={{ fontSize: '0.85rem' }}
              >
                טען עוד ({filteredContacts.length - visibleCount} נותרו)
              </button>
            </div>
          )}
          <p style={{ textAlign: 'center', color: '#888', fontSize: '0.8rem', marginTop: '8px' }}>
            מציג {Math.min(visibleCount, filteredContacts.length)} מתוך {filteredContacts.length}
          </p>
        </div>
      ) : (
        <div className="empty-state">
          {contacts.length === 0
            ? 'אין אנשי קשר. לחץ "סנכרן מ-Resend" לטעינת הרשימה.'
            : 'אין תוצאות לפילטר הנוכחי.'
          }
        </div>
      )}
    </div>
  );
}

// ── History Tab ─────────────────────────────────────────────────────────────

function HistoryTab({ data, user, showToast, onDuplicate }) {
  const [expandedId, setExpandedId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);

  const campaigns = (data.campaigns || []).sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  const toggleExpand = (campaign) => {
    if (expandedId === campaign.id) {
      setExpandedId(null);
      if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(''); }
    } else {
      setExpandedId(campaign.id);
      if (campaign.html_content) {
        const blob = new Blob([campaign.html_content], { type: 'text/html;charset=utf-8' });
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(blob));
      } else {
        setPreviewUrl('');
      }
    }
  };

  const statusLabel = (s) =>
    s === 'sent' ? '✅ נשלח' : s === 'failed' ? '❌ נכשל' : '📝 טיוטה';
  const statusStyle = (s) => ({
    background: s === 'sent' ? '#DCFCE7' : s === 'failed' ? '#FEE2E2' : '#FEF3C7',
    color: s === 'sent' ? '#065F46' : s === 'failed' ? '#991B1B' : '#92400E',
    padding: '3px 10px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600,
  });

  return (
    <div className="section">
      <h2>📊 היסטוריית קמפיינים</h2>
      <p style={{ color: '#888', fontSize: '0.85rem', marginBottom: '1rem' }}>
        {campaigns.length} קמפיינים. לחץ על שורה לפרטים.
      </p>

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 16px',
          background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px',
          marginBottom: '10px', direction: 'rtl',
        }}>
          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#991B1B' }}>
            {selectedIds.size} נבחרו
          </span>
          <button
            onClick={async () => {
              if (!window.confirm(`למחוק ${selectedIds.size} קמפיינים?`)) return;
              setDeleting(true);
              try {
                const { error: delErr } = await supabase.from('campaigns').delete().in('id', [...selectedIds]);
                if (delErr) throw delErr;
                showToast(`🗑️ ${selectedIds.size} קמפיינים נמחקו`);
                setSelectedIds(new Set());
                setExpandedId(null);
              } catch (err) {
                showToast(`❌ שגיאה: ${err.message}`, 'error');
              } finally {
                setDeleting(false);
              }
            }}
            disabled={deleting}
            style={{
              background: '#DC2626', color: 'white', border: 'none', borderRadius: '8px',
              padding: '6px 16px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
            }}
          >
            {deleting ? '⏳ מוחק...' : `🗑️ מחק ${selectedIds.size}`}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.85rem', color: '#991B1B' }}
          >
            ✕ בטל בחירה
          </button>
        </div>
      )}

      {campaigns.length > 0 ? (
        <div style={{ display: 'grid', gap: '10px' }}>
          {/* Select all */}
          <label style={{
            display: 'flex', alignItems: 'center', gap: '8px', direction: 'rtl',
            fontSize: '0.8rem', color: '#888', padding: '0 4px', cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={selectedIds.size === campaigns.length && campaigns.length > 0}
              onChange={(e) => {
                if (e.target.checked) {
                  setSelectedIds(new Set(campaigns.map(c => c.id)));
                } else {
                  setSelectedIds(new Set());
                }
              }}
              style={{ accentColor: '#3D4A2E' }}
            />
            בחר הכל
          </label>

          {campaigns.map(c => (
            <div key={c.id}>
              {/* Campaign row */}
              <div
                style={{
                  background: selectedIds.has(c.id) ? '#FEF2F2' : expandedId === c.id ? '#F9F8F5' : '#FFFFFF',
                  border: selectedIds.has(c.id) ? '1px solid #FECACA' : expandedId === c.id ? '1px solid #BBF7D0' : '1px solid #E8E8E0',
                  borderRadius: expandedId === c.id ? '12px 12px 0 0' : '12px',
                  padding: '14px 16px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '12px',
                  direction: 'rtl', transition: 'all 0.15s',
                }}
                onMouseEnter={e => { if (expandedId !== c.id && !selectedIds.has(c.id)) e.currentTarget.style.borderColor = '#D1D5DB'; }}
                onMouseLeave={e => { if (expandedId !== c.id && !selectedIds.has(c.id)) e.currentTarget.style.borderColor = '#E8E8E0'; }}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    setSelectedIds(prev => {
                      const next = new Set(prev);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      return next;
                    });
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ accentColor: '#3D4A2E', flexShrink: 0 }}
                />
                <div style={{ flex: 1 }} onClick={() => toggleExpand(c)}>
                  <div style={{ fontWeight: 600, color: '#2C3522', marginBottom: '4px', fontSize: '0.95rem' }}>
                    {c.subject || 'ללא נושא'}
                  </div>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem', color: '#888' }}>
                    <span>{new Date(c.created_at).toLocaleDateString('he-IL')}</span>
                    <span>•</span>
                    <span>{c.channel === 'email' ? '✉️ מייל' : '💬 WhatsApp'}</span>
                    <span>•</span>
                    <span>{c.recipient_count || 0} נמענים</span>
                  </div>
                </div>
                <span style={statusStyle(c.status)}>{statusLabel(c.status)}</span>
                <span onClick={() => toggleExpand(c)} style={{ fontSize: '0.8rem', color: '#AAA', transform: expandedId === c.id ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▶</span>
              </div>

              {/* Expanded detail */}
              {expandedId === c.id && (
                <div style={{
                  background: '#FFFFFF', border: '1px solid #BBF7D0', borderTop: 'none',
                  borderRadius: '0 0 12px 12px', padding: '16px',
                }}>
                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
                    <div style={{ background: '#F0FDF4', borderRadius: '10px', padding: '12px 20px', textAlign: 'center', flex: 1, minWidth: '80px' }}>
                      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#065F46' }}>{c.recipient_count || 0}</div>
                      <div style={{ fontSize: '0.75rem', color: '#888' }}>נשלחו</div>
                    </div>
                    <div style={{ background: '#F0F9FF', borderRadius: '10px', padding: '12px 20px', textAlign: 'center', flex: 1, minWidth: '80px' }}>
                      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#0369A1' }}>{c.open_count || '—'}</div>
                      <div style={{ fontSize: '0.75rem', color: '#888' }}>פתחו</div>
                    </div>
                    <div style={{ background: '#FDF4FF', borderRadius: '10px', padding: '12px 20px', textAlign: 'center', flex: 1, minWidth: '80px' }}>
                      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#7E22CE' }}>{c.click_count || '—'}</div>
                      <div style={{ fontSize: '0.75rem', color: '#888' }}>לחצו</div>
                    </div>
                    {c.sent_at && (
                      <div style={{ background: '#F5F5F0', borderRadius: '10px', padding: '12px 20px', textAlign: 'center', flex: 1, minWidth: '80px' }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#3D4A2E' }}>
                          {new Date(c.sent_at).toLocaleString('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#888' }}>נשלח בתאריך</div>
                      </div>
                    )}
                  </div>

                  {/* Error info */}
                  {c.error && (
                    <div style={{
                      background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px',
                      padding: '8px 12px', marginBottom: '12px', fontSize: '0.8rem', color: '#991B1B', direction: 'ltr',
                    }}>
                      {c.error}
                    </div>
                  )}

                  {/* HTML preview */}
                  {previewUrl && (
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ fontWeight: 600, fontSize: '0.85rem', display: 'block', marginBottom: '6px' }}>👁️ תצוגת המייל</label>
                      <iframe
                        src={previewUrl}
                        style={{ width: '100%', height: '400px', border: '1px solid #E8E8E0', borderRadius: '8px' }}
                        title="Campaign Preview"
                      />
                    </div>
                  )}

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDuplicate(c); }}
                      className="btn-primary"
                      style={{ fontSize: '0.85rem', padding: '8px 18px' }}
                    >
                      📋 שכפל קמפיין
                    </button>
                    {c.status === 'draft' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onDuplicate(c); }}
                        className="btn-small"
                        style={{ fontSize: '0.85rem' }}
                      >
                        ✏️ המשך עריכה
                      </button>
                    )}
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm(`למחוק את הקמפיין "${c.subject}"?`)) return;
                        try {
                          const { error: delErr } = await supabase.from('campaigns').delete().eq('id', c.id);
                          if (delErr) throw delErr;
                          showToast('🗑️ הקמפיין נמחק');
                          setExpandedId(null);
                        } catch (err) {
                          showToast(`❌ שגיאה: ${err.message}`, 'error');
                        }
                      }}
                      className="btn-small"
                      style={{ fontSize: '0.85rem', color: '#991B1B' }}
                    >
                      🗑️ מחק
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">אין קמפיינים עדיין. צור את הקמפיין הראשון!</div>
      )}
    </div>
  );
}
