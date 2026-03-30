import React, { useState, useRef } from 'react';
import { useApp } from '../../lib/context';
import { callBrevoFunction, callCampaignFunction } from '../../lib/brevo';
import { buildEmailHtml, buildCampaignHtml } from '../../lib/emailTemplate';
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

      {activeTab === 'compose'     && <AutoComposeTab data={data} user={user} showToast={showToast} />}
      {activeTab === 'automations' && <AutomationsTab data={data} user={user} showToast={showToast} />}
      {activeTab === 'contacts'    && <ContactsTab data={data} user={user} showToast={showToast} marketingContactsDb={marketingContactsDb} />}
      {activeTab === 'history'     && <HistoryTab data={data} />}
    </div>
  );
}

// ── Auto Compose Tab (AI-powered one-click) ─────────────────────────────────

function AutoComposeTab({ data, user, showToast }) {
  const [step, setStep]                 = useState('idle'); // idle | generating | draft | sending | sent
  const [hint, setHint]                 = useState('');
  const [draft, setDraft]               = useState(null);
  const [editSubject, setEditSubject]   = useState('');
  const [editBody, setEditBody]         = useState('');
  const [testEmail, setTestEmail]       = useState('');
  const [syncing, setSyncing]           = useState(false);

  const optedInCount = (data.marketingContacts || []).filter(c => c.opted_in).length;

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
      setStep('draft');
    } catch (err) {
      showToast(`❌ שגיאה ביצירת קמפיין: ${err.message}`, 'error');
      setStep('idle');
    }
  };

  const regenerate = () => {
    setDraft(null);
    setStep('idle');
  };

  const rebuildHtml = () => {
    if (!draft) return draft?.htmlContent || '';
    return buildCampaignHtml({
      subject: editSubject,
      preheader: draft.preheader || '',
      greeting: draft.greeting || '',
      body: editBody,
      ctaText: draft.ctaText || 'לחנות',
      ctaUrl: draft.ctaUrl || 'https://minuto.co.il/shop',
      products: draft.products || [],
      unsubscribeUrl: '{{UNSUBSCRIBE_URL}}',
    });
  };

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
    if (optedInCount === 0) {
      showToast('⚠️ אין אנשי קשר שאישרו קבלת מיילים', 'warning');
      return;
    }
    if (!window.confirm(`לשלוח את הקמפיין ל-${optedInCount} נמענים?`)) return;

    setStep('sending');
    try {
      const result = await callCampaignFunction(supabase, 'send-campaign', {
        userId: user.id,
        campaignId: draft.id,
      });
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
          <p style={{ color: '#666', marginBottom: '24px', maxWidth: '400px', margin: '0 auto 24px' }}>
            ה-AI ייצור מייל מושלם בעברית עם מוצרים מהחנות שלך.
            <br />רק תאשר ותשלח.
          </p>

          <div style={{ maxWidth: '400px', margin: '0 auto 16px' }}>
            <input
              type="text"
              placeholder="הנחיה אופציונלית: למשל 'מכונות Jura במבצע' או השאר ריק..."
              value={hint}
              onChange={e => setHint(e.target.value)}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: '8px',
                border: '1px solid #ddd', fontSize: '0.95rem', textAlign: 'right',
                direction: 'rtl',
              }}
            />
          </div>

          <button
            onClick={generateCampaign}
            className="btn-primary"
            style={{ fontSize: '1.1rem', padding: '14px 32px' }}
          >
            🚀 צור קמפיין
          </button>

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

  const previewHtml = rebuildHtml();

  return (
    <div className="section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>📝 סקירת הקמפיין</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          {draft?.theme && (
            <span style={{
              background: '#DCFCE7', padding: '4px 12px', borderRadius: '12px',
              fontSize: '0.8rem', fontWeight: 600,
            }}>
              {THEME_LABELS[draft.theme] || draft.theme}
            </span>
          )}
          <button onClick={regenerate} className="btn-small">🔄 צור מחדש</button>
        </div>
      </div>

      {/* Editable Subject */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontWeight: 600 }}>נושא המייל</label>
          <input
            type="text"
            value={editSubject}
            onChange={e => setEditSubject(e.target.value)}
            style={{ fontSize: '1rem', fontWeight: 600 }}
          />
        </div>
      </div>

      {/* Editable Body */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontWeight: 600 }}>תוכן ההודעה</label>
          <textarea
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            rows={6}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', direction: 'rtl' }}
          />
        </div>
      </div>

      {/* Products */}
      {draft?.products && draft.products.length > 0 && (
        <div className="form-card" style={{ marginBottom: '12px' }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>
            מוצרים ({draft.products.length})
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            {draft.products.map(p => (
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
          </div>
        </div>
      )}

      {/* Email Preview */}
      <div className="form-card" style={{ marginBottom: '12px' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>👁️ תצוגה מקדימה</label>
        <iframe
          srcDoc={previewHtml}
          style={{ width: '100%', height: '500px', border: '1px solid #ddd', borderRadius: '8px' }}
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

        {/* Approve & Send */}
        <button
          onClick={sendCampaign}
          disabled={step === 'sending' || optedInCount === 0}
          className="btn-primary"
          style={{ width: '100%', fontSize: '1.1rem', padding: '14px' }}
        >
          {step === 'sending'
            ? '⏳ שולח...'
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

function ContactsTab({ data, user, showToast, marketingContactsDb }) {
  const [importing, setImporting]     = useState(false);
  const [showWooForm, setShowWooForm] = useState(false);
  const [wooUrl, setWooUrl]           = useState('');
  const [wooKey, setWooKey]           = useState('');
  const [wooSecret, setWooSecret]     = useState('');
  const fileInputRef = useRef(null);

  const contacts = data.marketingContacts || [];
  const optedIn  = contacts.filter(c => c.opted_in).length;

  const toggleOptIn = async (contact) => {
    try {
      await marketingContactsDb.update(contact.id, { opted_in: !contact.opted_in });
      showToast(contact.opted_in ? '🔕 הוסר מרשימת התפוצה' : '✅ נוסף לרשימת התפוצה');
    } catch (err) {
      showToast(`❌ שגיאה: ${err.message}`, 'error');
    }
  };

  const importCsv = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim());
      const header = lines[0].toLowerCase();

      const cols = header.split(',').map(c => c.trim());
      const emailIdx = cols.findIndex(c => c.includes('email') || c.includes('מייל'));
      const nameIdx  = cols.findIndex(c => c.includes('name') || c.includes('שם') || c.includes('first_name'));
      const phoneIdx = cols.findIndex(c => c.includes('phone') || c.includes('טלפון'));

      if (emailIdx === -1) {
        showToast('⚠️ לא נמצאה עמודת email בקובץ', 'warning');
        return;
      }

      const contacts = lines.slice(1).map(line => {
        const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        return {
          email:    parts[emailIdx] || '',
          name:     nameIdx >= 0 ? parts[nameIdx] : '',
          phone:    phoneIdx >= 0 ? parts[phoneIdx] : '',
          opted_in: false,
        };
      }).filter(c => c.email && c.email.includes('@'));

      const result = await callBrevoFunction(supabase, 'sync-contacts', {
        userId: user.id,
        contacts,
        source: 'csv',
      });

      showToast(`✅ יובאו ${result.synced} אנשי קשר מקובץ CSV`);
    } catch (err) {
      showToast(`❌ שגיאה בייבוא: ${err.message}`, 'error');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const importWoo = async () => {
    if (!wooUrl || !wooKey || !wooSecret) {
      showToast('⚠️ נא למלא את כל שדות WooCommerce', 'warning');
      return;
    }

    setImporting(true);
    try {
      const result = await callBrevoFunction(supabase, 'import-woo', {
        userId: user.id,
        wooUrl: wooUrl.trim(),
        consumerKey: wooKey.trim(),
        consumerSecret: wooSecret.trim(),
      });

      showToast(`✅ יובאו ${result.synced} לקוחות מ-WooCommerce`);
      setShowWooForm(false);
    } catch (err) {
      showToast(`❌ שגיאה בייבוא: ${err.message}`, 'error');
    } finally {
      setImporting(false);
    }
  };

  const bulkOptIn = async (value) => {
    try {
      for (const c of contacts) {
        if (c.opted_in !== value) {
          await marketingContactsDb.update(c.id, { opted_in: value });
        }
      }
      showToast(value ? '✅ כל אנשי הקשר אושרו' : '🔕 כל אנשי הקשר הוסרו');
    } catch (err) {
      showToast(`❌ שגיאה: ${err.message}`, 'error');
    }
  };

  return (
    <div className="section">
      <h2>👥 אנשי קשר ({contacts.length})</h2>
      <p style={{ color: '#666', marginBottom: '1rem' }}>
        {optedIn} מתוך {contacts.length} אישרו קבלת הודעות
      </p>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label className="btn-primary" style={{ cursor: 'pointer' }}>
          📄 ייבוא CSV
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt"
            onChange={importCsv}
            style={{ display: 'none' }}
          />
        </label>
        <button onClick={() => setShowWooForm(!showWooForm)} className="btn-small">
          🛒 ייבוא מ-WooCommerce
        </button>
        <button onClick={() => bulkOptIn(true)} className="btn-small">✅ אשר הכל</button>
        <button onClick={() => bulkOptIn(false)} className="btn-small">🔕 הסר הכל</button>
      </div>

      {importing && <p style={{ color: '#556B3A' }}>⏳ מייבא אנשי קשר...</p>}

      {showWooForm && (
        <div className="form-card" style={{ marginBottom: '1rem', background: '#FFF9F0', border: '1px solid #FDE68A' }}>
          <h3>🛒 ייבוא מ-WooCommerce</h3>
          <div className="form-group">
            <label>כתובת החנות</label>
            <input type="text" placeholder="https://your-store.com" value={wooUrl} onChange={e => setWooUrl(e.target.value)} style={{ fontFamily: 'monospace' }} />
          </div>
          <div className="form-group">
            <label>Consumer Key</label>
            <input type="text" placeholder="ck_..." value={wooKey} onChange={e => setWooKey(e.target.value)} style={{ fontFamily: 'monospace' }} />
          </div>
          <div className="form-group">
            <label>Consumer Secret</label>
            <input type="password" placeholder="cs_..." value={wooSecret} onChange={e => setWooSecret(e.target.value)} style={{ fontFamily: 'monospace' }} />
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
            <button onClick={importWoo} disabled={importing} className="btn-primary" style={{ flex: 1 }}>
              {importing ? '⏳ מייבא...' : '📥 ייבוא'}
            </button>
            <button onClick={() => setShowWooForm(false)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {contacts.length > 0 ? (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>שם</th>
                <th>אימייל</th>
                <th>טלפון</th>
                <th>מקור</th>
                <th>מאושר</th>
              </tr>
            </thead>
            <tbody>
              {contacts.slice(0, 100).map(c => (
                <tr key={c.id}>
                  <td><strong>{c.name || '—'}</strong></td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{c.email}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{c.phone || '—'}</td>
                  <td>
                    <span style={{
                      background: c.source === 'woocommerce' ? '#EDE9FE' : c.source === 'csv' ? '#FEF3C7' : '#DCFCE7',
                      padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem',
                    }}>
                      {c.source === 'woocommerce' ? '🛒 WooCommerce' : c.source === 'csv' ? '📄 CSV' : '✏️ ידני'}
                    </span>
                  </td>
                  <td>
                    <button
                      onClick={() => toggleOptIn(c)}
                      style={{
                        background: c.opted_in ? '#10B981' : '#DC2626',
                        color: 'white', border: 'none', borderRadius: '6px',
                        padding: '4px 12px', cursor: 'pointer', fontSize: '0.8rem',
                      }}
                    >
                      {c.opted_in ? '✅ מאושר' : '❌ לא מאושר'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {contacts.length > 100 && (
            <p style={{ textAlign: 'center', color: '#888', fontSize: '0.85rem', marginTop: '8px' }}>
              מציג 100 מתוך {contacts.length} אנשי קשר
            </p>
          )}
        </div>
      ) : (
        <div className="empty-state">אין אנשי קשר. ייבא מ-CSV או WooCommerce!</div>
      )}
    </div>
  );
}

// ── History Tab ─────────────────────────────────────────────────────────────

function HistoryTab({ data }) {
  const campaigns = (data.campaigns || []).sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  return (
    <div className="section">
      <h2>📊 היסטוריית קמפיינים</h2>

      {campaigns.length > 0 ? (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>תאריך</th>
                <th>ערוץ</th>
                <th>נושא</th>
                <th>סוג</th>
                <th>נמענים</th>
                <th>סטטוס</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => (
                <tr key={c.id}>
                  <td>{new Date(c.created_at).toLocaleDateString('he-IL')}</td>
                  <td>{c.channel === 'email' ? '✉️ מייל' : '💬 WhatsApp'}</td>
                  <td>{c.subject || '—'}</td>
                  <td>
                    <span style={{
                      background: c.campaign_type === 'auto' ? '#DBEAFE' : '#F3F4F6',
                      padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem',
                    }}>
                      {c.campaign_type === 'auto' ? '🤖 אוטומטי' : '✏️ ידני'}
                    </span>
                  </td>
                  <td>{c.recipient_count || 0}</td>
                  <td>
                    <span style={{
                      background: c.status === 'sent' ? '#DCFCE7' : c.status === 'failed' ? '#FEE2E2' : '#FEF3C7',
                      color: c.status === 'sent' ? '#065F46' : c.status === 'failed' ? '#991B1B' : '#92400E',
                      padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600,
                    }}>
                      {c.status === 'sent' ? '✅ נשלח' : c.status === 'failed' ? '❌ נכשל' : '📝 טיוטה'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">אין קמפיינים עדיין. צור את הקמפיין הראשון!</div>
      )}
    </div>
  );
}
