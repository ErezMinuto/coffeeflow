import React, { useState } from 'react';
import { ArrowRight, Plus, Pencil, Trash2, ChevronUp, ChevronDown, Check } from 'lucide-react';
import { useApp } from '../../lib/context';
import { PageHeader } from '../shared/ui';
import './checklist.css';

export default function ChecklistEditor() {
  const { roastChecklistTemplatesDb, showToast } = useApp();
  const templates = roastChecklistTemplatesDb?.data || [];

  const [editing, setEditing] = useState(null);
  const [saving,  setSaving]  = useState(false);

  const startNew = () => setEditing({
    id: null, name: 'רשימת קלייה', variables: [], steps: []
  });

  const startEdit = (t) => setEditing({
    id: t.id, name: t.name,
    variables: JSON.parse(JSON.stringify(t.variables || [])),
    steps:     JSON.parse(JSON.stringify(t.steps     || [])),
  });

  const save = async () => {
    if (!editing.name.trim()) { showToast('נא להזין שם לתבנית', 'warning'); return; }
    setSaving(true);
    try {
      const payload = {
        name:      editing.name.trim(),
        variables: editing.variables,
        steps:     editing.steps,
        updated_at: new Date().toISOString(),
      };
      if (editing.id) await roastChecklistTemplatesDb.update(editing.id, payload);
      else             await roastChecklistTemplatesDb.insert(payload);
      await roastChecklistTemplatesDb.refresh();
      showToast('התבנית נשמרה');
      setEditing(null);
    } catch (err) {
      console.error(err);
      showToast('שגיאה בשמירה', 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async (id) => {
    if (!window.confirm('למחוק תבנית זו?')) return;
    await roastChecklistTemplatesDb.remove(id);
    await roastChecklistTemplatesDb.refresh();
    showToast('התבנית נמחקה');
  };

  // ── Variables helpers ─────────────────────────────────────────────────────

  const addVar = () => setEditing(p => ({
    ...p, variables: [...p.variables, { id: Date.now().toString(), name: '', label: '', default_value: '' }]
  }));

  const updateVar = (i, field, val) => setEditing(p => {
    const vars = [...p.variables];
    vars[i] = { ...vars[i], [field]: val };
    return { ...p, variables: vars };
  });

  const removeVar = (i) => setEditing(p => ({
    ...p, variables: p.variables.filter((_, idx) => idx !== i)
  }));

  // ── Steps helpers ─────────────────────────────────────────────────────────

  const addStep = () => setEditing(p => ({
    ...p, steps: [...p.steps, { id: Date.now().toString(), text: '', note: '', required: true }]
  }));

  const updateStep = (i, field, val) => setEditing(p => {
    const steps = [...p.steps];
    steps[i] = { ...steps[i], [field]: val };
    return { ...p, steps };
  });

  const removeStep = (i) => setEditing(p => ({
    ...p, steps: p.steps.filter((_, idx) => idx !== i)
  }));

  const moveStep = (i, dir) => setEditing(p => {
    const steps = [...p.steps];
    const j = i + dir;
    if (j < 0 || j >= steps.length) return p;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    return { ...p, steps };
  });

  // ── Edit view ─────────────────────────────────────────────────────────────

  if (editing) {
    return (
      <div className="page checklist-page checklist-editor">
        <button type="button" onClick={() => setEditing(null)} className="btn ghost sm checklist-back">
          <ArrowRight aria-hidden="true" />חזרה לתבניות
        </button>
        <PageHeader title={editing.id ? 'עריכת תבנית' : 'תבנית חדשה'} />

        {/* Name */}
        <section className="card">
          <div className="form-group checklist-name">
            <label htmlFor="cl-tpl-name">שם התבנית</label>
            <input
              id="cl-tpl-name"
              value={editing.name}
              onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
              placeholder="רשימת קלייה"
            />
          </div>
        </section>

        {/* Variables */}
        <section className="card flush">
          <div className="card-head">
            <h2>משתנים</h2>
            <button type="button" onClick={addVar} className="btn sm">
              <Plus aria-hidden="true" />הוספה
            </button>
          </div>
          <div className="card-body">
            <p className="field-help checklist-help">
              אפשר להשתמש ב-<code>{'{{שם}}'}</code> בתוך שלבים. לדוגמה: <code>{'{{weight}}'}</code>, <code>{'{{profile}}'}</code>
            </p>
            {editing.variables.length === 0 && (
              <p className="text-muted checklist-none">אין משתנים</p>
            )}
            {editing.variables.map((v, i) => (
              <div key={v.id} className="checklist-var-row">
                <input
                  value={v.name}
                  onChange={e => updateVar(i, 'name', e.target.value)}
                  placeholder="שם (באנגלית, ללא רווח)"
                  aria-label="שם המשתנה"
                  className="checklist-code-input"
                />
                <input value={v.label} onChange={e => updateVar(i, 'label', e.target.value)} placeholder="תווית בעברית" aria-label="תווית בעברית" />
                <input value={v.default_value} onChange={e => updateVar(i, 'default_value', e.target.value)} placeholder="ברירת מחדל" aria-label="ברירת מחדל" />
                <button type="button" onClick={() => removeVar(i)} className="btn-icon danger" title="מחיקת משתנה" aria-label="מחיקת משתנה">
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Steps */}
        <section className="card flush">
          <div className="card-head">
            <h2>שלבים <span className="checklist-count num">{editing.steps.length}</span></h2>
            <button type="button" onClick={addStep} className="btn sm">
              <Plus aria-hidden="true" />הוספת שלב
            </button>
          </div>
          {editing.steps.length === 0 && (
            <p className="text-muted checklist-none checklist-none-pad">אין שלבים עדיין</p>
          )}
          {editing.steps.length > 0 && (
            <ol className="checklist-edit-steps">
              {editing.steps.map((step, i) => (
                <li key={step.id} className="checklist-edit-step">
                  {/* Reorder */}
                  <div className="checklist-reorder">
                    <button
                      type="button" className="btn-icon" title="הזזה למעלה" aria-label="הזזה למעלה"
                      onClick={() => moveStep(i, -1)} disabled={i === 0}
                    ><ChevronUp aria-hidden="true" /></button>
                    <button
                      type="button" className="btn-icon" title="הזזה למטה" aria-label="הזזה למטה"
                      onClick={() => moveStep(i, 1)} disabled={i === editing.steps.length - 1}
                    ><ChevronDown aria-hidden="true" /></button>
                  </div>
                  <span className="checklist-num num">{i + 1}</span>
                  <div className="checklist-edit-fields">
                    <input
                      value={step.text}
                      onChange={e => updateStep(i, 'text', e.target.value)}
                      placeholder={`טקסט השלב, למשל: שקילת {{weight}} ק"ג`}
                      aria-label={`טקסט שלב ${i + 1}`}
                    />
                    <input
                      value={step.note}
                      onChange={e => updateStep(i, 'note', e.target.value)}
                      placeholder="הערה קצרה (לא חובה)"
                      aria-label={`הערה לשלב ${i + 1}`}
                      className="checklist-note-input"
                    />
                  </div>
                  <div className="checklist-edit-end">
                    <label className="checklist-required">
                      <input
                        type="checkbox" checked={step.required}
                        onChange={e => updateStep(i, 'required', e.target.checked)}
                      />
                      חובה
                    </label>
                    <button type="button" onClick={() => removeStep(i)} className="btn-icon danger" title="מחיקת שלב" aria-label={`מחיקת שלב ${i + 1}`}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="checklist-save">
          <button type="button" onClick={save} disabled={saving} className="btn primary">
            {saving ? 'בשמירה…' : <><Check aria-hidden="true" />שמירת התבנית</>}
          </button>
        </div>
      </div>
    );
  }

  // ── List view ─────────────────────────────────────────────────────────────

  return (
    <div className="page checklist-page checklist-editor">
      <PageHeader
        title="עורך צ'קליסט קלייה"
        subtitle="השלבים שמופיעים בצ'קליסט שנפתח מדף הקלייה"
        actions={
          <button type="button" onClick={startNew} className="btn primary">
            <Plus aria-hidden="true" />תבנית חדשה
          </button>
        }
      />

      {templates.length === 0 ? (
        <div className="card empty-state">אין תבניות עדיין. אפשר ליצור את הראשונה בכפתור ״תבנית חדשה״.</div>
      ) : (
        <section className="card flush">
          <ul className="checklist-templates">
            {templates.map(t => (
              <li key={t.id} className="checklist-template">
                <div className="checklist-template-text">
                  <div className="checklist-template-name">{t.name}</div>
                  <div className="text-muted num">
                    {(t.steps || []).length} שלבים · {(t.variables || []).length} משתנים
                  </div>
                </div>
                <div className="checklist-template-actions">
                  <button type="button" onClick={() => startEdit(t)} className="btn sm">
                    <Pencil aria-hidden="true" />עריכה
                  </button>
                  <button type="button" onClick={() => deleteTemplate(t.id)} className="btn-icon danger" title="מחיקת תבנית" aria-label={`מחיקת התבנית ${t.name}`}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
