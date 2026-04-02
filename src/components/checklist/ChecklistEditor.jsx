import React, { useState } from 'react';
import { useApp } from '../../lib/context';

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
    if (!editing.name.trim()) { showToast('⚠️ נא להזין שם לתבנית', 'warning'); return; }
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
      showToast('✅ תבנית נשמרה!');
      setEditing(null);
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בשמירה', 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async (id) => {
    if (!window.confirm('למחוק תבנית זו?')) return;
    await roastChecklistTemplatesDb.remove(id);
    await roastChecklistTemplatesDb.refresh();
    showToast('✅ תבנית נמחקה');
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
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <button onClick={() => setEditing(null)} className="btn-small">← חזור</button>
          <h1>📋 {editing.id ? 'עריכת תבנית' : 'תבנית חדשה'}</h1>
        </div>

        {/* Name */}
        <div className="form-card" style={{ marginBottom: '16px' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>שם התבנית</label>
            <input
              value={editing.name}
              onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
              placeholder="רשימת קלייה"
            />
          </div>
        </div>

        {/* Variables */}
        <div className="form-card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h3 style={{ margin: 0 }}>🔧 משתנים</h3>
            <button onClick={addVar} className="btn-small">+ הוסף</button>
          </div>
          <p style={{ fontSize: '12px', color: '#6B7280', margin: '0 0 12px' }}>
            השתמש ב-<code style={{ background: '#F3F4F6', padding: '1px 4px', borderRadius: '3px' }}>{'{{שם}}'}</code> בתוך שלבים. לדוגמה: <code style={{ background: '#F3F4F6', padding: '1px 4px', borderRadius: '3px' }}>{'{{weight}}'}</code>, <code style={{ background: '#F3F4F6', padding: '1px 4px', borderRadius: '3px' }}>{'{{profile}}'}</code>
          </p>
          {editing.variables.length === 0 && (
            <div style={{ color: '#9CA3AF', fontSize: '13px' }}>אין משתנים</div>
          )}
          {editing.variables.map((v, i) => (
            <div key={v.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
              <input
                value={v.name}
                onChange={e => updateVar(i, 'name', e.target.value)}
                placeholder="שם (באנגלית, ללא רווח)"
                style={{ direction: 'ltr', fontFamily: 'monospace' }}
              />
              <input value={v.label} onChange={e => updateVar(i, 'label', e.target.value)} placeholder="תווית בעברית" />
              <input value={v.default_value} onChange={e => updateVar(i, 'default_value', e.target.value)} placeholder="ברירת מחדל" />
              <button onClick={() => removeVar(i)} className="btn-icon">🗑️</button>
            </div>
          ))}
        </div>

        {/* Steps */}
        <div className="form-card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h3 style={{ margin: 0 }}>📝 שלבים ({editing.steps.length})</h3>
            <button onClick={addStep} className="btn-small">+ הוסף שלב</button>
          </div>
          {editing.steps.length === 0 && (
            <div style={{ color: '#9CA3AF', fontSize: '13px' }}>אין שלבים עדיין</div>
          )}
          {editing.steps.map((step, i) => (
            <div key={step.id} style={{
              background: '#F9FAFB', borderRadius: '8px', padding: '10px',
              marginBottom: '8px', border: '1px solid #E5E7EB'
            }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                {/* Reorder */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: '4px' }}>
                  <button
                    onClick={() => moveStep(i, -1)} disabled={i === 0}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: '1px', opacity: i === 0 ? 0.3 : 1 }}
                  >▲</button>
                  <button
                    onClick={() => moveStep(i, 1)} disabled={i === editing.steps.length - 1}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: '1px', opacity: i === editing.steps.length - 1 ? 0.3 : 1 }}
                  >▼</button>
                </div>
                <span style={{ color: '#9CA3AF', fontSize: '13px', minWidth: '20px', paddingTop: '6px' }}>{i + 1}.</span>
                <div style={{ flex: 1 }}>
                  <input
                    value={step.text}
                    onChange={e => updateStep(i, 'text', e.target.value)}
                    placeholder={`טקסט שלב — למשל: שקול {{weight}} ק"ג`}
                    style={{ width: '100%', marginBottom: '4px' }}
                  />
                  <input
                    value={step.note}
                    onChange={e => updateStep(i, 'note', e.target.value)}
                    placeholder="הערה אופציונלית (קצר)"
                    style={{ width: '100%', fontSize: '12px' }}
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', whiteSpace: 'nowrap', paddingTop: '6px', cursor: 'pointer' }}>
                  <input
                    type="checkbox" checked={step.required}
                    onChange={e => updateStep(i, 'required', e.target.checked)}
                  />
                  חובה
                </label>
                <button onClick={() => removeStep(i)} className="btn-icon" style={{ paddingTop: '4px' }}>🗑️</button>
              </div>
            </div>
          ))}
        </div>

        <button onClick={save} disabled={saving} className="btn-primary" style={{ width: '100%' }}>
          {saving ? '⏳ שומר...' : '✅ שמור תבנית'}
        </button>
      </div>
    );
  }

  // ── List view ─────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>📋 עורך צ'קליסט קלייה</h1>
        <button onClick={startNew} className="btn-primary">+ תבנית חדשה</button>
      </div>

      {templates.length === 0 ? (
        <div className="empty-state">אין תבניות עדיין. צור תבנית ראשונה!</div>
      ) : (
        templates.map(t => (
          <div key={t.id} className="form-card" style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{t.name}</div>
              <div style={{ fontSize: '12px', color: '#6B7280' }}>
                {(t.steps || []).length} שלבים · {(t.variables || []).length} משתנים
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => startEdit(t)} className="btn-small">✏️ ערוך</button>
              <button onClick={() => deleteTemplate(t.id)} className="btn-icon">🗑️</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
