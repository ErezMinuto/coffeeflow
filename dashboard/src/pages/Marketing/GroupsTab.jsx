import { useState } from 'react';

export function GroupsTab({ data, showToast, contactGroupsDb, contactGroupMembersDb }) {
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [isTestDraft, setIsTestDraft] = useState(false);
  const [saving, setSaving] = useState(false);

  const groups = data.contactGroups || [];
  const members = data.contactGroupMembers || [];
  const contacts = data.marketingContacts || [];

  // Member counts per group
  const countByGroup = new Map();
  for (const m of members) {
    countByGroup.set(m.group_id, (countByGroup.get(m.group_id) || 0) + 1);
  }

  const resetForm = () => {
    setShowCreate(false);
    setEditingId(null);
    setNameDraft('');
    setDescDraft('');
    setIsTestDraft(false);
  };

  const saveGroup = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      showToast('⚠️ שם הקבוצה חובה', 'warning');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await contactGroupsDb.update(editingId, {
          name: trimmed,
          description: descDraft.trim() || null,
          is_test_group: isTestDraft,
          updated_at: new Date().toISOString(),
        });
        showToast('✅ הקבוצה עודכנה');
      } else {
        await contactGroupsDb.insert({
          name: trimmed,
          description: descDraft.trim() || null,
          is_test_group: isTestDraft,
        });
        showToast('✅ הקבוצה נוצרה');
      }
      resetForm();
    } catch (err) {
      showToast(`❌ שגיאה: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async (group) => {
    const memberCount = countByGroup.get(group.id) || 0;
    const confirmMsg = memberCount > 0
      ? `למחוק את הקבוצה "${group.name}" ו-${memberCount} חברים?`
      : `למחוק את הקבוצה "${group.name}"?`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await contactGroupsDb.remove(group.id);
      await contactGroupMembersDb.refresh();
      showToast('🗑️ הקבוצה נמחקה');
    } catch (err) {
      showToast(`❌ שגיאה: ${err.message}`, 'error');
    }
  };

  const startEdit = (group) => {
    setEditingId(group.id);
    setNameDraft(group.name || '');
    setDescDraft(group.description || '');
    setIsTestDraft(!!group.is_test_group);
    setShowCreate(true);
  };

  return (
    <div className="section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>🗂️ קבוצות אנשי קשר</h2>
        {!showCreate && (
          <button onClick={() => setShowCreate(true)} className="btn-primary" style={{ fontSize: '0.9rem', padding: '8px 18px' }}>
            ➕ צור קבוצה
          </button>
        )}
      </div>
      <p style={{ color: '#888', fontSize: '0.85rem', marginBottom: '16px' }}>
        קבוצות מאפשרות לשלוח קמפיינים לתת-קבוצה של אנשי קשר. סמן קבוצה כ"קבוצת בדיקה" כדי לשלוח אליה בלחיצה אחת מתוך מחולל הקמפיינים.
      </p>

      {/* Create / edit form */}
      {showCreate && (
        <div className="form-card" style={{ marginBottom: '16px', background: '#F9F8F5', border: '1px solid #D4E8C2' }}>
          <label style={{ fontWeight: 600, display: 'block', marginBottom: '8px' }}>
            {editingId ? '✏️ עריכת קבוצה' : '➕ קבוצה חדשה'}
          </label>
          <div className="form-group" style={{ marginBottom: '8px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888' }}>שם הקבוצה</label>
            <input
              type="text"
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              placeholder="למשל: לקוחות VIP, צוות בדיקה, בעלי Jura"
              autoFocus
            />
          </div>
          <div className="form-group" style={{ marginBottom: '8px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888' }}>תיאור (אופציונלי)</label>
            <input
              type="text"
              value={descDraft}
              onChange={e => setDescDraft(e.target.value)}
              placeholder="למה משמשת הקבוצה"
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', cursor: 'pointer', direction: 'rtl' }}>
            <input
              type="checkbox"
              checked={isTestDraft}
              onChange={e => setIsTestDraft(e.target.checked)}
              style={{ accentColor: '#3D4A2E' }}
            />
            <span style={{ fontSize: '0.9rem' }}>🧪 סמן כקבוצת בדיקה (תופיע כפתור מהיר במחולל הקמפיינים)</span>
          </label>
          <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
            <button onClick={saveGroup} disabled={saving} className="btn-primary" style={{ fontSize: '0.85rem', padding: '8px 20px' }}>
              {saving ? '⏳ שומר...' : '💾 שמור'}
            </button>
            <button onClick={resetForm} className="btn-small" style={{ fontSize: '0.85rem' }}>ביטול</button>
          </div>
        </div>
      )}

      {/* Groups list */}
      {groups.length === 0 ? (
        <div className="empty-state">אין קבוצות עדיין. לחץ "צור קבוצה" כדי להתחיל.</div>
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {groups.map(g => (
            <GroupRow
              key={g.id}
              group={g}
              memberCount={countByGroup.get(g.id) || 0}
              members={members.filter(m => m.group_id === g.id)}
              contacts={contacts}
              contactGroupMembersDb={contactGroupMembersDb}
              onEdit={() => startEdit(g)}
              onDelete={() => deleteGroup(g)}
              showToast={showToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupRow({ group, memberCount, members, contacts, contactGroupMembersDb, onEdit, onDelete, showToast }) {
  const [expanded, setExpanded] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [manualEmail, setManualEmail] = useState('');

  const memberEmails = new Set(members.map(m => (m.email || '').toLowerCase()));

  const addContact = async (c) => {
    const email = (c.email || '').toLowerCase().trim();
    if (!email || memberEmails.has(email)) return;
    try {
      await contactGroupMembersDb.insert({ group_id: group.id, email, name: c.name || null });
      setMemberSearch('');
    } catch (err) {
      showToast(`❌ שגיאה: ${err.message}`, 'error');
    }
  };

  const addManualEmail = async () => {
    const email = manualEmail.toLowerCase().trim();
    if (!email || !email.includes('@')) {
      showToast('⚠️ כתובת מייל לא תקינה', 'warning');
      return;
    }
    if (memberEmails.has(email)) {
      showToast('⚠️ המייל כבר בקבוצה', 'warning');
      return;
    }
    try {
      await contactGroupMembersDb.insert({ group_id: group.id, email, name: null });
      setManualEmail('');
    } catch (err) {
      showToast(`❌ שגיאה: ${err.message}`, 'error');
    }
  };

  const removeMember = async (memberId) => {
    try {
      await contactGroupMembersDb.remove(memberId);
    } catch (err) {
      showToast(`❌ שגיאה: ${err.message}`, 'error');
    }
  };

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #E8E8E0',
      borderRadius: '12px',
      padding: '14px 16px',
      direction: 'rtl',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontWeight: 600, color: '#2C3522', fontSize: '0.95rem' }}>{group.name}</span>
            {group.is_test_group && (
              <span style={{
                background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A',
                borderRadius: '12px', padding: '2px 10px', fontSize: '0.7rem', fontWeight: 600,
              }}>🧪 קבוצת בדיקה</span>
            )}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#888' }}>
            {memberCount} חברים {group.description ? `• ${group.description}` : ''}
          </div>
        </div>
        <button onClick={() => setExpanded(v => !v)} className="btn-small" style={{ fontSize: '0.8rem' }}>
          {expanded ? '✕ סגור' : '👥 חברים'}
        </button>
        <button onClick={onEdit} className="btn-small" style={{ fontSize: '0.8rem' }}>✏️ ערוך</button>
        <button onClick={onDelete} className="btn-small" style={{ fontSize: '0.8rem', color: '#991B1B' }}>🗑️</button>
      </div>

      {expanded && (
        <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px dashed #E8E8E0' }}>
          {/* Current members */}
          {members.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
              {members.map(m => (
                <span key={m.id} style={{
                  background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '16px',
                  padding: '3px 10px', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '6px',
                  direction: 'ltr',
                }}>
                  <span>{m.email}</span>
                  <button
                    onClick={() => removeMember(m.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', padding: 0, fontSize: '0.85rem' }}
                  >✕</button>
                </span>
              ))}
            </div>
          ) : (
            <div style={{ color: '#999', fontStyle: 'italic', fontSize: '0.85rem', marginBottom: '12px' }}>
              אין חברים עדיין. הוסף למטה.
            </div>
          )}

          {/* Add manual email */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
            <input
              type="email"
              value={manualEmail}
              onChange={e => setManualEmail(e.target.value)}
              placeholder="הוסף מייל ידני (למשל tester@gmail.com)"
              style={{ flex: 1, fontSize: '0.85rem', direction: 'ltr', fontFamily: 'monospace' }}
              onKeyDown={e => { if (e.key === 'Enter') addManualEmail(); }}
            />
            <button onClick={addManualEmail} className="btn-small" style={{ fontSize: '0.8rem' }}>➕</button>
          </div>

          {/* Pick from existing contacts */}
          <input
            type="text"
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            placeholder="🔍 חפש בין אנשי הקשר הקיימים..."
            style={{ width: '100%', fontSize: '0.85rem', marginBottom: '6px', boxSizing: 'border-box' }}
          />
          {memberSearch.trim() && (
            <div style={{
              maxHeight: '160px', overflowY: 'auto', background: '#FAFAF7',
              border: '1px solid #E8E8E0', borderRadius: '8px',
            }}>
              {contacts
                .filter(c => c.opted_in)
                .filter(c => {
                  const q = memberSearch.toLowerCase();
                  return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q);
                })
                .slice(0, 20)
                .map(c => {
                  const already = memberEmails.has((c.email || '').toLowerCase());
                  return (
                    <div
                      key={c.id}
                      onClick={() => !already && addContact(c)}
                      style={{
                        padding: '6px 10px', cursor: already ? 'default' : 'pointer',
                        opacity: already ? 0.5 : 1, fontSize: '0.82rem',
                        display: 'flex', justifyContent: 'space-between', gap: '8px',
                        borderBottom: '1px solid #F0F0E8',
                      }}
                      onMouseEnter={e => { if (!already) e.currentTarget.style.background = '#F0FDF4'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span>{c.name || '—'} <span style={{ color: '#888', fontFamily: 'monospace', fontSize: '0.78rem' }}>{c.email}</span></span>
                      {already ? <span style={{ color: '#10B981' }}>✓</span> : <span>➕</span>}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
