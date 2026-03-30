import React, { useState, useRef } from 'react';
import { useApp } from '../../lib/context';
import { callBrevoFunction } from '../../lib/brevo';
import { buildEmailHtml } from '../../lib/emailTemplate';
import { supabase } from '../../lib/supabase';

const TABS = [
  { id: 'compose',  label: '✉️ יצירת קמפיין' },
  { id: 'whatsapp', label: '💬 WhatsApp' },
  { id: 'contacts', label: '👥 אנשי קשר' },
  { id: 'history',  label: '📊 היסטוריה' },
];

const TYPE_LABELS = {
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

      {/* Tabs */}
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

      {activeTab === 'compose'  && <ComposeTab data={data} user={user} showToast={showToast} campaignsDb={campaignsDb} />}
      {activeTab === 'whatsapp' && <WhatsAppTab data={data} user={user} showToast={showToast} />}
      {activeTab === 'contacts' && <ContactsTab data={data} user={user} showToast={showToast} marketingContactsDb={marketingContactsDb} />}
      {activeTab === 'history'  && <HistoryTab data={data} />}
    </div>
  );
}

// ── Compose Tab ─────────────────────────────────────────────────────────────

function ComposeTab({ data, user, showToast, campaignsDb }) {
  const [subject, setSubject]       = useState('');
  const [message, setMessage]       = useState('');
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [ideas, setIdeas]           = useState(null);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [sending, setSending]       = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');

  const optedInCount = (data.marketingContacts || []).filter(c => c.opted_in).length;

  const toggleProduct = (id) => {
    setSelectedProducts(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const generateIdeas = async () => {
    setLoadingIdeas(true);
    try {
      const pastSubjects = (data.campaigns || [])
        .filter(c => c.channel === 'email' && c.subject)
        .map(c => c.subject);

      const products = (data.products || []).map(p => ({
        name: p.name,
        description: p.description || '',
      }));

      const result = await callBrevoFunction(supabase, 'suggest-content', {
        userId: user.id,
        products,
        pastSubjects,
      });

      setIdeas(result.ideas || []);
    } catch (err) {
      showToast(`❌ שגיאה ביצירת רעיונות: ${err.message}`, 'error');
    } finally {
      setLoadingIdeas(false);
    }
  };

  const applyIdea = (idea) => {
    setSubject(idea.subject);
    setMessage(idea.preview);
    setIdeas(null);
    showToast('✅ הרעיון הוחל — ערוך לפי הצורך');
  };

  const showPreview = () => {
    const products = (data.products || []).filter(p => selectedProducts.includes(p.id));
    const html = buildEmailHtml(message, products);
    setPreviewHtml(html);
  };

  const sendCampaign = async () => {
    if (!subject.trim() || !message.trim()) {
      showToast('⚠️ נא למלא נושא ותוכן', 'warning');
      return;
    }
    if (optedInCount === 0) {
      showToast('⚠️ אין אנשי קשר שאישרו קבלת מיילים', 'warning');
      return;
    }

    setSending(true);
    try {
      const products = (data.products || []).filter(p => selectedProducts.includes(p.id));
      const htmlContent = buildEmailHtml(message, products);

      const result = await callBrevoFunction(supabase, 'send-email', {
        userId: user.id,
        subject: subject.trim(),
        htmlContent,
      });

      showToast(`✅ הקמפיין נשלח ל-${result.recipientCount} נמענים!`);
      setSubject('');
      setMessage('');
      setSelectedProducts([]);
      setPreviewHtml('');
    } catch (err) {
      showToast(`❌ שגיאה בשליחה: ${err.message}`, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="section">
      <h2>✉️ יצירת קמפיין מייל</h2>

      {/* AI Ideas */}
      <div className="form-card" style={{ marginBottom: '1rem' }}>
        <button onClick={generateIdeas} disabled={loadingIdeas} className="btn-primary">
          {loadingIdeas ? '⏳ יוצר רעיונות...' : '🤖 קבל רעיונות תוכן מ-AI'}
        </button>

        {ideas && ideas.length > 0 && (
          <div style={{ marginTop: '1rem', display: 'grid', gap: '10px' }}>
            {ideas.map((idea, i) => (
              <div
                key={i}
                onClick={() => applyIdea(idea)}
                style={{
                  background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px',
                  padding: '12px', cursor: 'pointer', transition: 'transform 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.01)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{
                    background: '#DCFCE7', padding: '2px 8px', borderRadius: '12px',
                    fontSize: '0.75rem', fontWeight: 600,
                  }}>
                    {TYPE_LABELS[idea.type] || idea.type}
                  </span>
                  <strong style={{ color: '#3D4A2E' }}>{idea.title}</strong>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: '#555' }}>{idea.preview}</p>
                <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#888' }}>נושא: {idea.subject}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Compose form */}
      <div className="form-card">
        <div className="form-group">
          <label>נושא המייל</label>
          <input
            type="text"
            placeholder="שורת הנושא..."
            value={subject}
            onChange={e => setSubject(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>תוכן ההודעה</label>
          <textarea
            placeholder="כתוב את תוכן המייל כאן..."
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={6}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        {/* Product selector */}
        {data.products && data.products.length > 0 && (
          <div className="form-group">
            <label>צרף מוצרים מומלצים</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
              {data.products.map(p => (
                <label
                  key={p.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    background: selectedProducts.includes(p.id) ? '#DCFCE7' : '#f5f5f5',
                    border: `1px solid ${selectedProducts.includes(p.id) ? '#86EFAC' : '#ddd'}`,
                    borderRadius: '6px', padding: '4px 10px', fontSize: '0.85rem',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedProducts.includes(p.id)}
                    onChange={() => toggleProduct(p.id)}
                    style={{ margin: 0 }}
                  />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '1rem' }}>
          <button onClick={showPreview} className="btn-small" style={{ flex: 1 }}>
            👁️ תצוגה מקדימה
          </button>
          <button
            onClick={sendCampaign}
            disabled={sending || optedInCount === 0}
            className="btn-primary"
            style={{ flex: 1 }}
          >
            {sending ? '⏳ שולח...' : `📤 שלח ל-${optedInCount} נמענים`}
          </button>
        </div>
      </div>

      {/* Preview */}
      {previewHtml && (
        <div className="form-card" style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ margin: 0 }}>👁️ תצוגה מקדימה</h3>
            <button onClick={() => setPreviewHtml('')} className="btn-small">✕ סגור</button>
          </div>
          <iframe
            srcDoc={previewHtml}
            style={{ width: '100%', height: '500px', border: '1px solid #ddd', borderRadius: '8px' }}
            title="Email Preview"
          />
        </div>
      )}
    </div>
  );
}

// ── WhatsApp Tab ────────────────────────────────────────────────────────────

function WhatsAppTab({ data, user, showToast }) {
  const [templateId, setTemplateId]       = useState('');
  const [text, setText]                   = useState('');
  const [senderNumber, setSenderNumber]   = useState('');
  const [sending, setSending]             = useState(false);

  const optedInWithPhone = (data.marketingContacts || []).filter(c => c.opted_in && c.phone).length;

  const sendWhatsApp = async () => {
    if (!senderNumber.trim()) {
      showToast('⚠️ נא להזין מספר שולח', 'warning');
      return;
    }
    if (!templateId && !text.trim()) {
      showToast('⚠️ נא להזין Template ID או טקסט', 'warning');
      return;
    }

    setSending(true);
    try {
      const payload = {
        userId: user.id,
        senderNumber: senderNumber.trim(),
      };

      if (templateId) {
        payload.templateId = parseInt(templateId);
      } else {
        payload.text = text.trim();
      }

      const result = await callBrevoFunction(supabase, 'send-whatsapp', payload);
      showToast(`✅ WhatsApp נשלח ל-${result.recipientCount} נמענים!`);
      setText('');
      setTemplateId('');
    } catch (err) {
      showToast(`❌ שגיאה בשליחה: ${err.message}`, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="section">
      <h2>💬 שליחת WhatsApp</h2>

      <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '8px', padding: '1rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#0369A1' }}>
        <strong>שים לב:</strong> הודעה ראשונה חייבת להיות מבוססת Template שנוצר בפלטפורמת Brevo.
        לאחר שהלקוח מגיב, ניתן לשלוח טקסט חופשי.
      </div>

      <div className="form-card">
        <div className="form-group">
          <label>מספר שולח (עם קידומת מדינה)</label>
          <input
            type="text"
            placeholder="972501234567"
            value={senderNumber}
            onChange={e => setSenderNumber(e.target.value)}
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>Template ID (להודעה ראשונה)</label>
          <input
            type="text"
            placeholder="לדוגמה: 1"
            value={templateId}
            onChange={e => setTemplateId(e.target.value)}
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>או טקסט חופשי (לתגובות)</label>
          <textarea
            placeholder="תוכן ההודעה..."
            value={text}
            onChange={e => setText(e.target.value)}
            rows={3}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        <button
          onClick={sendWhatsApp}
          disabled={sending || optedInWithPhone === 0}
          className="btn-primary"
          style={{ width: '100%', marginTop: '10px' }}
        >
          {sending ? '⏳ שולח...' : `📤 שלח ל-${optedInWithPhone} נמענים עם טלפון`}
        </button>
      </div>
    </div>
  );
}

// ── Contacts Tab ────────────────────────────────────────────────────────────

function ContactsTab({ data, user, showToast, marketingContactsDb }) {
  const [importing, setImporting]   = useState(false);
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

      // Detect columns
      const cols = header.split(',').map(c => c.trim());
      const emailIdx = cols.findIndex(c => c.includes('email') || c.includes('מייל'));
      const nameIdx  = cols.findIndex(c => c.includes('name') || c.includes('שם'));
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

      {/* Import buttons */}
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
        <button onClick={() => bulkOptIn(true)} className="btn-small">
          ✅ אשר הכל
        </button>
        <button onClick={() => bulkOptIn(false)} className="btn-small">
          🔕 הסר הכל
        </button>
      </div>

      {importing && <p style={{ color: '#556B3A' }}>⏳ מייבא אנשי קשר...</p>}

      {/* WooCommerce form */}
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

          <div style={{ marginTop: '12px', padding: '8px', background: '#FEF3C7', borderRadius: '6px', fontSize: '0.8rem', color: '#92400E' }}>
            <strong>שים לב:</strong> כל הלקוחות המיובאים מתחילים עם "לא מאושר" — יש לאשר ידנית רק לקוחות שנתנו הסכמה.
          </div>
        </div>
      )}

      {/* Contacts table */}
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
              {contacts.map(c => (
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
                  <td>{c.recipient_count}</td>
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
