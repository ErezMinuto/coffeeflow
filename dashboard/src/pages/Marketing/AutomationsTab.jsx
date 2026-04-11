// Automations tab — static list of future automation ideas. No state, no hooks.

export function AutomationsTab({ data, user, showToast }) {
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
