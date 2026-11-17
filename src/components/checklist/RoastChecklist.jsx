import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, Check, Info, Play, Flag } from 'lucide-react';
import { useApp } from '../../lib/context';
import { PageHeader } from '../shared/ui';
import './checklist.css';

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
      <div className="page checklist-page">
        <button type="button" onClick={() => navigate('/roasting')} className="btn ghost sm checklist-back">
          <ArrowRight aria-hidden="true" />חזרה לקלייה
        </button>
        <PageHeader title="צ'קליסט קלייה" />
        <div className="card empty-state">
          <p className="checklist-empty-title">אין תבנית צ'קליסט מוגדרת.</p>
          <p className="text-muted">אפשר לבקש מסאגי ליצור תבנית ב<Link to="/checklist-editor" className="text-link">עורך הצ'קליסט</Link>.</p>
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
      <div className="page checklist-page">
        <button type="button" onClick={() => navigate('/roasting')} className="btn ghost sm checklist-back">
          <ArrowRight aria-hidden="true" />חזרה לקלייה
        </button>
        <PageHeader
          title={template.name}
          subtitle={`${steps.length} שלבים, ${requiredSteps.length} מהם חובה`}
        />

        {(template.variables || []).length > 0 && (
          <section className="card flush">
            <div className="card-head">
              <h2>פרטי הקלייה</h2>
              <span className="meta">הערכים ימולאו בתוך השלבים אוטומטית</span>
            </div>
            <div className="card-body checklist-vars">
              {template.variables.map(v => (
                <div key={v.id || v.name} className="form-group">
                  <label htmlFor={`cl-var-${v.id || v.name}`}>{v.label || v.name}</label>
                  <input
                    id={`cl-var-${v.id || v.name}`}
                    value={varValues[v.name] || ''}
                    onChange={e => setVarValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                    placeholder={v.default_value || v.label || v.name}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Preview */}
        <section className="card flush">
          <div className="card-head">
            <h2>השלבים</h2>
          </div>
          <ol className="checklist-preview">
            {steps.slice(0, 4).map((s, i) => (
              <li key={s.id}>
                <span className="checklist-num num">{i + 1}</span>
                <span className="checklist-preview-text">{substitute(s.text, varValues)}</span>
                {s.required && <span className="tag">חובה</span>}
              </li>
            ))}
          </ol>
          {steps.length > 4 && (
            <div className="checklist-more">ועוד {steps.length - 4} שלבים</div>
          )}
        </section>

        <div className="checklist-actionbar">
          <button
            type="button"
            onClick={() => { setChecked({}); setPhase('checklist'); }}
            className="btn primary checklist-big"
          >
            <Play aria-hidden="true" />התחלת הצ'קליסט
          </button>
        </div>
      </div>
    );
  }

  // ── Checklist phase ───────────────────────────────────────────────────────

  return (
    <div className="page checklist-page">
      <button type="button" onClick={() => setPhase('setup')} className="btn ghost sm checklist-back">
        <ArrowRight aria-hidden="true" />חזרה לפרטי הקלייה
      </button>
      <PageHeader title={template.name} />

      {/* Progress */}
      <div className="checklist-progress">
        <div className="checklist-progress-row">
          <span><strong className="num">{completedAll}</strong> מתוך <span className="num">{steps.length}</span> שלבים הושלמו</span>
          <span className="checklist-pct num">{progress}%</span>
        </div>
        <div
          className="meter checklist-meter"
          role="progressbar"
          aria-label="התקדמות הצ'קליסט"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <i style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* Steps: each row is one big tap target */}
      <ol className="checklist-steps">
        {steps.map((step, i) => {
          const isDone = !!checked[step.id];
          return (
            <li key={step.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={isDone}
                onClick={() => toggleStep(step.id)}
                className={`checklist-step${isDone ? ' done' : ''}`}
              >
                <span className="checklist-check" aria-hidden="true">
                  {isDone && <Check />}
                </span>
                <span className="checklist-step-body">
                  <span className="checklist-step-text">
                    <span className="checklist-num num">{i + 1}</span>
                    {substitute(step.text, varValues)}
                  </span>
                  {step.note && (
                    <span className="checklist-step-note">
                      <Info aria-hidden="true" />{substitute(step.note, varValues)}
                    </span>
                  )}
                </span>
                {step.required && !isDone && <span className="tag warn">חובה</span>}
              </button>
            </li>
          );
        })}
      </ol>

      {/* Finish button */}
      <div className="checklist-actionbar">
        <button
          type="button"
          onClick={() => navigate('/roasting')}
          disabled={!allReqDone}
          className="btn primary checklist-big"
        >
          {allReqDone
            ? <><Flag aria-hidden="true" />סיום וחזרה לרישום הקלייה</>
            : `נותרו ${requiredSteps.length - completedReq} שלבי חובה`}
        </button>
      </div>
    </div>
  );
}
