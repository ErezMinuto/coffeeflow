import { useState } from 'react';
import { supabase } from '../../lib/supabase';

export function HistoryTab({ data, user, showToast, onDuplicate, onEdit }) {
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
                        onClick={(e) => { e.stopPropagation(); onEdit(c); }}
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
