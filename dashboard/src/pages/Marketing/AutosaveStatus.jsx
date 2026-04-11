// Small status pill shown next to the compose tab while a draft is being
// autosaved. Extracted from the old monolithic Marketing.jsx so the compose
// tab can import it on its own.

export function AutosaveStatus({ saving, dirty, lastSavedAt, onSaveNow, hasDraftId }) {
  if (!hasDraftId) return null;
  let label, color, bg, border;
  if (saving) {
    label = '⏳ שומר...';
    color = '#92400E'; bg = '#FEF3C7'; border = '#FDE68A';
  } else if (dirty) {
    label = '✏️ שינויים לא שמורים';
    color = '#92400E'; bg = '#FEF3C7'; border = '#FDE68A';
  } else if (lastSavedAt) {
    label = '✅ נשמר אוטומטית';
    color = '#065F46'; bg = '#DCFCE7'; border = '#BBF7D0';
  } else {
    label = '💾 שמירה אוטומטית פעילה';
    color = '#3D4A2E'; bg = '#F0FDF4'; border = '#BBF7D0';
  }
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      <span style={{
        background: bg, border: `1px solid ${border}`, color,
        padding: '4px 12px', borderRadius: '12px',
        fontSize: '0.78rem', fontWeight: 600, direction: 'rtl',
      }}>
        {label}
      </span>
      {dirty && !saving && (
        <button
          onClick={onSaveNow}
          className="btn-small"
          style={{ fontSize: '0.75rem', padding: '3px 10px' }}
          title="שמור עכשיו בלי להמתין"
        >
          שמור עכשיו
        </button>
      )}
    </div>
  );
}
