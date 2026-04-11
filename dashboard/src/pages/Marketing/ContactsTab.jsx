import { useState } from 'react';
import { callCampaignFunction } from '../../lib/brevo';
import { ProgressBar, useAnimatedProgress } from '../../components/shared/ProgressBar';
import { supabase } from '../../lib/supabase';

export function ContactsTab({ data, user, showToast, marketingContactsDb }) {
  const [contactFilter, setContactFilter] = useState('all');
  const [syncingResend, setSyncingResend] = useState(false);
  const [pushingResend, setPushingResend] = useState(false);
  const syncResendProgress = useAnimatedProgress(syncingResend, 20);
  const pushResendProgress = useAnimatedProgress(pushingResend, 30);
  const [importingFlashy, setImportingFlashy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newContactEmail, setNewContactEmail] = useState('');
  const [newContactName, setNewContactName] = useState('');
  const [addingContact, setAddingContact] = useState(false);

  const addManualContact = async () => {
    const email = newContactEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      showToast('⚠️ כתובת מייל לא תקינה', 'warning');
      return;
    }
    setAddingContact(true);
    try {
      // 1. Push to Resend (source of truth) — uses the existing subscribe action
      await callCampaignFunction(supabase, 'subscribe', {
        email,
        name: newContactName.trim() || undefined,
        userId: user.id,
      });
      // 2. Mirror immediately into Supabase so the UI shows it without waiting
      //    for the next full sync.
      try {
        await marketingContactsDb.insert({
          email,
          name: newContactName.trim() || null,
          opted_in: true,
          source: 'manual',
        });
      } catch (mirrorErr) {
        // Likely a unique constraint hit — already in marketing_contacts.
        // Not fatal; Resend has it now and the next sync will reconcile.
        console.warn('mirror insert skipped:', mirrorErr?.message);
      }
      showToast(`✅ נוסף ${email}`);
      setNewContactEmail('');
      setNewContactName('');
      setShowAddForm(false);
    } catch (err) {
      showToast(`❌ שגיאה: ${err?.message || 'unknown'}`, 'error');
    } finally {
      setAddingContact(false);
    }
  };
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
      const removedMsg = result.removed > 0 ? ` (הוסרו ${result.removed} שאינם ב-Resend)` : '';
      syncResendProgress.complete();
      showToast(`✅ סונכרנו ${result.synced} אנשי קשר מ-Resend${removedMsg}`);
    } catch (err) {
      showToast(`❌ שגיאה בסנכרון: ${err.message}`, 'error');
    } finally {
      setSyncingResend(false);
    }
  };

  // Push all opted-in contacts from Supabase → Resend in pages of 500
  const pushAllToResend = async () => {
    setPushingResend(true);
    let totalPushed = 0, totalFailed = 0, offset = 0;
    try {
      while (true) {
        const result = await callCampaignFunction(supabase, 'push-to-resend', {
          userId: user.id, offset, limit: 500,
        });
        totalPushed += result.pushed || 0;
        totalFailed += result.failed || 0;
        offset = result.offset || offset + 500;
        if (result.done || !result.total) break;
      }
      const failMsg = totalFailed > 0 ? ` (${totalFailed} נכשלו)` : '';
      pushResendProgress.complete();
      showToast(`✅ נדחפו ${totalPushed} אנשי קשר ל-Resend${failMsg}`);
    } catch (err) {
      showToast(`❌ שגיאה בדחיפה ל-Resend: ${err.message}`, 'error');
    } finally {
      setPushingResend(false);
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

        // Fix triple-encoded Hebrew: Flashy exports UTF-8 Hebrew that was
        // misread as CP1252 and re-encoded as UTF-8.
        // Also handles NBSP (0xA0) normalized to SPACE (0x20) for letter נ.
        const fixHebrew = (str) => {
          if (!str || !/[\xC0-\xFF]/.test(str)) return str;
          try {
            // Step 1: encode each char back to a raw byte (CP1252-like)
            const buf = [];
            for (const ch of str) {
              const cp = ch.charCodeAt(0);
              if (cp < 0x80) { buf.push(cp); }
              else if (cp <= 0x9F) { buf.push(cp); }           // undefined CP1252 → direct byte
              else if (cp <= 0xFF) { buf.push(cp); }           // Latin-1 range
              else {
                // For multi-byte Unicode (e.g. U+2018 ' → 0x91, U+2122 ™ → 0x99)
                // Use a minimal reverse-CP1252 table for chars Flashy produces
                const map = { 0x2018:0x91,0x2019:0x92,0x201A:0x82,0x201C:0x93,0x201D:0x94,
                              0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,
                              0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F,
                              0x20AC:0x80,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,
                              0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,
                              0x017D:0x8E };
                buf.push(map[cp] ?? 0x3F); // '?' fallback
              }
            }
            // Step 2: fix D7 + non-continuation (NBSP normalized to SPACE → restore נ)
            const fixed = [];
            for (let i = 0; i < buf.length; i++) {
              if (buf[i] === 0xD7 && i + 1 < buf.length && (buf[i+1] < 0x80 || buf[i+1] > 0xBF)) {
                fixed.push(0xD7, 0xA0); // restore נ (NUN)
                i++;
              } else {
                fixed.push(buf[i]);
              }
            }
            return new TextDecoder('utf-8').decode(new Uint8Array(fixed)).replace(/\uFFFD/g, '');
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
            .upsert(batch, { onConflict: 'user_id,email', ignoreDuplicates: false });
          if (error) throw new Error(error.message);
          imported += batch.length;
        }
        const skippedMsg = skipped > 0 ? ` (${skipped} לא מאושרים דולגו)` : '';
        showToast(`✅ יובאו ${imported} אנשי קשר מ-Flashy${skippedMsg} — דוחף ל-Resend...`);
        marketingContactsDb.refresh();
        // Auto-push all opted-in contacts to Resend (server fetches from Supabase)
        await pushAllToResend();
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
      <div style={{ display: 'flex', gap: '10px', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <button onClick={() => setShowAddForm(v => !v)} className="btn-primary" style={{ fontSize: '0.85rem' }}>
          {showAddForm ? '✕ סגור' : '➕ הוסף איש קשר'}
        </button>
        <button onClick={syncFromResend} disabled={syncingResend || pushingResend} className="btn-small" style={{ fontSize: '0.85rem' }}>
          {syncingResend ? '⏳ מסנכרן...' : '🔄 סנכרן מ-Resend'}
        </button>
        <button onClick={pushAllToResend} disabled={pushingResend || syncingResend} className="btn-small" style={{ fontSize: '0.85rem' }}>
          {pushingResend ? '⏳ דוחף...' : '📤 דחוף ל-Resend'}
        </button>
        <label style={{ cursor: importingFlashy ? 'not-allowed' : 'pointer' }}>
          <input type="file" accept=".csv" style={{ display: 'none' }} onChange={importFlashyCSV} disabled={importingFlashy} />
          <span className="btn-small" style={{ fontSize: '0.85rem', pointerEvents: importingFlashy ? 'none' : 'auto', opacity: importingFlashy ? 0.6 : 1 }}>
            {importingFlashy ? '⏳ מייבא...' : '📥 ייבא מ-Flashy CSV'}
          </span>
        </label>
        <a
          href="https://resend.com/audience?limit=120"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-small"
          style={{ textDecoration: 'none', fontSize: '0.85rem' }}
        >
          📋 ניהול אנשי קשר ב-Resend
        </a>
      </div>

      {/* Manual add contact form */}
      {showAddForm && (
        <div className="form-card" style={{ marginTop: '12px', marginBottom: '12px', background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>➕ הוסף איש קשר ידנית</label>
          <p style={{ fontSize: '0.78rem', color: '#666', margin: '0 0 10px' }}>
            יתווסף ל-Resend ולרשימה המקומית מיד. אין צורך בסנכרון.
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="email"
              value={newContactEmail}
              onChange={e => setNewContactEmail(e.target.value)}
              placeholder="example@gmail.com"
              style={{ flex: '2 1 220px', fontFamily: 'monospace', fontSize: '0.9rem', direction: 'ltr' }}
              onKeyDown={e => { if (e.key === 'Enter') addManualContact(); }}
              autoFocus
            />
            <input
              type="text"
              value={newContactName}
              onChange={e => setNewContactName(e.target.value)}
              placeholder="שם (אופציונלי)"
              style={{ flex: '1 1 140px', fontSize: '0.9rem' }}
              onKeyDown={e => { if (e.key === 'Enter') addManualContact(); }}
            />
            <button
              onClick={addManualContact}
              disabled={addingContact || !newContactEmail.trim()}
              className="btn-primary"
              style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}
            >
              {addingContact ? '⏳ מוסיף...' : '✅ הוסף'}
            </button>
          </div>
        </div>
      )}

      {/* Progress bars for long-running contact ops */}
      {syncingResend && (
        <div style={{ marginBottom: '1rem' }}>
          <ProgressBar progress={syncResendProgress.progress} label="מסנכרן אנשי קשר מ-Resend..." color="#0369A1" />
        </div>
      )}
      {pushingResend && (
        <div style={{ marginBottom: '1rem' }}>
          <ProgressBar progress={pushResendProgress.progress} label="דוחף אנשי קשר ל-Resend..." color="#065F46" />
        </div>
      )}

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
