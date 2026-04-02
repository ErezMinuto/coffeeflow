import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../../lib/context';

const substitute = (text, vars) =>
  (text || '').replace(/\{\{(\w+)\}\}/g, (_, name) =>
    vars[name] !== undefined && vars[name] !== '' ? vars[name] : `{{${name}}}`
  );

export default function RoastChecklist() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { data }  = useApp();

  const prefillVars = location.state?.prefillVars || {};
  const templates   = data.roastChecklistTemplates || [];
  const template    = templates[0];

  const [phase,     setPhase]     = useState('setup');
  const [varValues, setVarValues] = useState({});
  const [checked,   setChecked]   = useState({});

  useEffect(() => {
    if (!template) return;
    const defaults = {};
    (template.variables || []).forEach(v => {
      defaults[v.name] = prefillVars[v.name] !== undefined ? String(prefillVars[v.name]) : (v.default_value || '');
    });
    setVarValues(defaults);
  }, [template?.id]);

  // ── No template ───────────────────────────────────────────────────────────

  if (!template) {
    return (
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <button onClick={() => navigate('/roasting')} className="btn-small">← חזור לקלייה</button>
          <h1>📋 צ'קליסט קלייה</h1>
        </div>
        <div className="empty-state">
          <div style={{ marginBottom: '12px' }}>אין תבנית צ'קליסט מוגדרת.</div>
          <div style={{ fontSize: '13px', color: '#9CA3AF' }}>בקש מסאגי ליצור תבנית ב-/checklist-editor</div>
        </div>
      </div>
    );
  }

  const steps         = template.steps || [];
  const requiredSteps = steps.filter(s => s.required);
  const completedReq  = requiredSteps.filter(s => checked[s.id]).length;
  const completedAll  = steps.filter(s => checked[s.id]).length;
  const allReqDone    = completedReq === requiredSteps.length;
  const progress      = steps.length > 0 ? Math.round((completedAll / steps.length) * 100) : 0;

  const toggleStep = (id) => setChecked(prev => ({ ...prev, [id]: !prev[id] }));

  // ── Setup phase ───────────────────────────────────────────────────────────

  if (phase === 'setup') {
    return (
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <button onClick={() => navigate('/roasting')} className="btn-small">← חזור</button>
          <h1>📋 {template.name}</h1>
        </div>

        {(template.variables || []).length > 0 && (
          <div className="form-card" style={{ marginBottom: '20px' }}>
            <h3 style={{ marginTop: 0 }}>🔧 משתנים</h3>
            <p style={{ fontSize: '13px', color: '#6B7280', margin: '0 0 14px' }}>
              הערכים ימולאו בתוך השלבים אוטומטית
            </p>
            {template.variables.map(v => (
              <div key={v.id || v.name} className="form-group" style={{ marginBottom: '10px' }}>
                <label>{v.label || v.name}</label>
                <input
                  value={varValues[v.name] || ''}
                  onChange={e => setVarValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                  placeholder={v.default_value || v.label || v.name}
                />
              </div>
            ))}
          </div>
        )}

        {/* Preview */}
        <div style={{ background: '#FFFBF5', border: '1px solid #F4E8D8', borderRadius: '8px', padding: '14px', marginBottom: '24px' }}>
          <div style={{ fontWeight: '600', color: '#6F4E37', marginBottom: '8px' }}>
            📝 {steps.length} שלבים ({requiredSteps.length} חובה)
          </div>
          {steps.slice(0, 4).map((s, i) => (
            <div key={s.id} style={{ fontSize: '13px', color: '#374151', marginBottom: '3px' }}>
              {i + 1}. {substitute(s.text, varValues)}
              {s.required && <span style={{ color: '#EF4444', marginRight: '4px', fontSize: '11px' }}>*</span>}
            </div>
          ))}
          {steps.length > 4 && (
            <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '4px' }}>...ועוד {steps.length - 4} שלבים</div>
          )}
        </div>

        <button
          onClick={() => { setChecked({}); setPhase('checklist'); }}
          className="btn-primary"
          style={{ width: '100%', padding: '1rem', fontSize: '1.05rem' }}
        >
          🚀 התחל צ'קליסט
        </button>
      </div>
    );
  }

  // ── Checklist phase ───────────────────────────────────────────────────────

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => setPhase('setup')} className="btn-small">← הגדרות</button>
        <h1>📋 {template.name}</h1>
      </div>

      {/* Progress */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#6B7280', marginBottom: '6px' }}>
          <span>{completedAll} / {steps.length} שלבים הושלמו</span>
          <span style={{ fontWeight: '600', color: progress === 100 ? '#059669' : '#374151' }}>{progress}%</span>
        </div>
        <div style={{ background: '#E5E7EB', borderRadius: '999px', height: '8px' }}>
          <div style={{
            background: progress === 100 ? '#059669' : '#6F4E37',
            borderRadius: '999px', height: '8px',
            width: `${progress}%`, transition: 'width 0.3s ease'
          }} />
        </div>
      </div>

      {/* Steps */}
      <div style={{ marginBottom: '24px' }}>
        {steps.map((step, i) => {
          const isDone = !!checked[step.id];
          return (
            <div
              key={step.id}
              onClick={() => toggleStep(step.id)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '12px',
                padding: '14px', marginBottom: '8px', borderRadius: '10px',
                background: isDone ? '#F0FFF4' : 'white',
                border: `1.5px solid ${isDone ? '#6EE7B7' : '#E5E7EB'}`,
                cursor: 'pointer', transition: 'all 0.2s',
              }}
            >
              {/* Checkbox circle */}
              <div style={{
                width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0,
                border: `2px solid ${isDone ? '#059669' : '#D1D5DB'}`,
                background: isDone ? '#059669' : 'white',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.2s', marginTop: '1px',
              }}>
                {isDone && <span style={{ color: 'white', fontSize: '13px', fontWeight: 'bold', lineHeight: 1 }}>✓</span>}
              </div>

              <div style={{ flex: 1 }}>
                <div style={{
                  fontWeight: '600', fontSize: '0.95rem', lineHeight: '1.4',
                  color: isDone ? '#065F46' : '#1F2937',
                  textDecoration: isDone ? 'line-through' : 'none',
                }}>
                  <span style={{ color: '#9CA3AF', fontSize: '0.78rem', marginLeft: '6px' }}>{i + 1}.</span>
                  {substitute(step.text, varValues)}
                  {step.required && !isDone && (
                    <span style={{ color: '#EF4444', fontSize: '0.7rem', marginRight: '6px' }}>חובה</span>
                  )}
                </div>
                {step.note && (
                  <div style={{ fontSize: '0.8rem', color: '#6B7280', marginTop: '4px' }}>
                    💡 {substitute(step.note, varValues)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Finish button */}
      <button
        onClick={() => navigate('/roasting')}
        disabled={!allReqDone}
        className="btn-primary"
        style={{
          width: '100%', padding: '1rem', fontSize: '1.05rem',
          opacity: allReqDone ? 1 : 0.5,
          background: allReqDone ? '#059669' : undefined,
        }}
      >
        {allReqDone
          ? '✅ סיים קלייה — חזור לרישום'
          : `⏳ נותרו ${requiredSteps.length - completedReq} שלבי חובה`}
      </button>
    </div>
  );
}
