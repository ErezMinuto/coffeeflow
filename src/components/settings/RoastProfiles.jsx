import React, { useState } from 'react';
import { Plus, Pencil, Trash2, Save } from 'lucide-react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

const ROAST_LEVEL_LABELS = { none: 'ללא', light: 'לייט', medium: 'מדיום' };

const emptyProfile = () => ({
  name: '', roast_level: 'none', notes: '', daily_average: '', min_stock: '',
  ingredients: [{ origin_id: '', percentage: 100 }]
});

// ── IngredientForm — defined OUTSIDE RoastProfiles to prevent remounting ──────

function IngredientForm({ ingredients, onChange, origins }) {
  const total = ingredients.reduce((s, i) => s + (parseFloat(i.percentage) || 0), 0);

  const update = (index, field, value) => {
    const arr = ingredients.map((ing, i) =>
      i === index ? { ...ing, [field]: field === 'origin_id' ? parseInt(value) : parseFloat(value) } : ing
    );
    onChange(arr);
  };

  const add    = () => onChange([...ingredients, { origin_id: '', percentage: 0 }]);
  const remove = (index) => onChange(ingredients.filter((_, i) => i !== index));

  return (
    <div className="form-group rp-ingredients">
      <span className="field-label">רכיבים (הסכום חייב להיות 100%) *</span>
      {ingredients.map((ing, index) => (
        <div key={index} className="rp-ing-row">
          <select value={ing.origin_id || ''} onChange={e => update(index, 'origin_id', e.target.value)} aria-label={`זן ${index + 1}`}>
            <option value="">בחירת זן</option>
            {origins.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <div className="set-unit-field">
            <input
              type="number" placeholder="0" min="0" max="100" step="0.1"
              value={ing.percentage} aria-label={`אחוז זן ${index + 1}`}
              onChange={e => update(index, 'percentage', e.target.value)}
            />
            <span className="set-unit">%</span>
          </div>
          {ingredients.length > 1 ? (
            <button onClick={() => remove(index)} className="btn-icon danger" title="הסרת הזן" aria-label={`הסרת זן ${index + 1}`}>
              <Trash2 aria-hidden="true" />
            </button>
          ) : <span className="rp-ing-spacer" />}
        </div>
      ))}
      <div className="rp-ing-foot">
        <button onClick={add} className="btn sm"><Plus aria-hidden="true" />הוספת זן</button>
        <span className={`rp-total ${total === 100 ? 'ok' : 'danger'}`}>
          <span className={`dot ${total === 100 ? 'ok' : 'danger'}`} aria-hidden="true" />
          סה"כ: <span className="num">{total}%</span>
        </span>
      </div>
    </div>
  );
}

// ── RoastProfiles ─────────────────────────────────────────────────────────────

export default function RoastProfiles() {
  const { data, roastProfilesDb, roastProfileIngredientsDb, showToast } = useApp();

  const [adding,     setAdding]     = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [newProfile, setNewProfile] = useState(emptyProfile());

  // ── Validation ──────────────────────────────────────────────────────────────

  const validate = (profile) => {
    if (!profile.name.trim()) { showToast('נא למלא שם פרופיל', 'warning'); return false; }
    if (!profile.ingredients || profile.ingredients.length === 0) { showToast('נא להוסיף לפחות רכיב אחד', 'warning'); return false; }
    for (const ing of profile.ingredients) {
      if (!ing.origin_id) { showToast('נא לבחור זן לכל רכיב', 'warning'); return false; }
    }
    const total = profile.ingredients.reduce((s, i) => s + (parseFloat(i.percentage) || 0), 0);
    if (Math.abs(total - 100) > 0.1) {
      showToast(`סכום האחוזים חייב להיות 100% (כרגע: ${total}%)`, 'warning');
      return false;
    }
    return true;
  };

  // ── CRUD ────────────────────────────────────────────────────────────────────

  const saveNew = async () => {
    if (!validate(newProfile)) return;
    try {
      const inserted = await roastProfilesDb.insert({
        name: newProfile.name.trim(), roast_level: newProfile.roast_level, notes: newProfile.notes,
        daily_average: parseFloat(newProfile.daily_average) || 0,
        min_stock: parseFloat(newProfile.min_stock) || 0
      });
      const ingredientRows = newProfile.ingredients.map(ing => ({
        profile_id: inserted.id, origin_id: ing.origin_id, percentage: ing.percentage
      }));
      const { error: ingError } = await supabase.from('roast_profile_ingredients').insert(ingredientRows);
      if (ingError) throw ingError;
      await roastProfileIngredientsDb.refresh();
      setAdding(false);
      setNewProfile(emptyProfile());
      showToast('פרופיל קלייה נוסף!');
    } catch (err) {
      console.error('Error saving profile:', err);
      showToast('שגיאה בשמירת פרופיל', 'error');
    }
  };

  const startEdit = (profile) => {
    const ingredients = data.roastProfileIngredients
      .filter(i => i.profile_id === profile.id)
      .map(i => ({ origin_id: i.origin_id, percentage: i.percentage }));
    setEditing({ ...profile, ingredients: ingredients.length ? ingredients : [{ origin_id: '', percentage: 100 }] });
  };

  const saveEdit = async () => {
    if (!validate(editing)) return;
    try {
      await roastProfilesDb.update(editing.id, {
        name: editing.name.trim(), roast_level: editing.roast_level, notes: editing.notes,
        daily_average: parseFloat(editing.daily_average) || 0,
        min_stock: parseFloat(editing.min_stock) || 0,
        roasted_stock: parseFloat(editing.roasted_stock) || 0,
        updated_at: new Date().toISOString()
      });
      await supabase.from('roast_profile_ingredients').delete().eq('profile_id', editing.id);
      const ingredientRows = editing.ingredients.map(ing => ({
        profile_id: editing.id, origin_id: ing.origin_id, percentage: ing.percentage
      }));
      const { error: ingError } = await supabase.from('roast_profile_ingredients').insert(ingredientRows);
      if (ingError) throw ingError;
      await roastProfilesDb.refresh();
      await roastProfileIngredientsDb.refresh();
      setEditing(null);
      showToast('פרופיל עודכן!');
    } catch (err) {
      console.error('Error updating profile:', err);
      showToast('שגיאה בעדכון פרופיל', 'error');
    }
  };

  const deleteProfile = async (profile) => {
    const hasHistory = data.roasts.some(r => r.roast_profile_id === profile.id);
    if (hasHistory) { showToast('לא ניתן למחוק פרופיל עם היסטוריית קליות', 'warning'); return; }
    if (!window.confirm(`האם למחוק את הפרופיל "${profile.name}"?`)) return;
    try {
      await roastProfilesDb.remove(profile.id);
      await roastProfileIngredientsDb.refresh();
      showToast('פרופיל נמחק!');
    } catch (err) {
      console.error('Error deleting profile:', err);
      showToast('שגיאה במחיקת פרופיל', 'error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <section className="set-section">
      <div className="set-section-head set-section-head-row">
        <div>
          <h2>פרופילי קלייה</h2>
          <p>מה קולים (זנים ואחוזים) ובאיזו רמת קלייה. לכל פרופיל מלאי קלוי נפרד.</p>
        </div>
        {!adding && !editing && (
          <button onClick={() => setAdding(true)} className="btn primary"><Plus aria-hidden="true" />פרופיל חדש</button>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div className="card flush">
          <div className="card-head"><h2>פרופיל חדש</h2></div>
          <div className="card-body">
            <div className="rp-grid">
              <div className="form-group">
                <label htmlFor="rp-new-name">שם הפרופיל *</label>
                <input id="rp-new-name" type="text" placeholder="למשל: Kenya Light" value={newProfile.name} onChange={e => setNewProfile({ ...newProfile, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="rp-new-level">רמת קלייה</label>
                <select id="rp-new-level" value={newProfile.roast_level} onChange={e => setNewProfile({ ...newProfile, roast_level: e.target.value })}>
                  <option value="none">ללא</option>
                  <option value="light">לייט</option>
                  <option value="medium">מדיום</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="rp-new-daily">ממוצע מכירות יומי (ק"ג)</label>
                <input id="rp-new-daily" type="number" step="0.1" placeholder="למשל: 1.5" value={newProfile.daily_average} onChange={e => setNewProfile({ ...newProfile, daily_average: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="rp-new-min">מלאי מינימום (ק"ג)</label>
                <input id="rp-new-min" type="number" step="0.1" placeholder="למשל: 5" value={newProfile.min_stock} onChange={e => setNewProfile({ ...newProfile, min_stock: e.target.value })} />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="rp-new-notes">הערות (לא חובה)</label>
              <input id="rp-new-notes" type="text" placeholder="מידע נוסף" value={newProfile.notes} onChange={e => setNewProfile({ ...newProfile, notes: e.target.value })} />
            </div>
            <IngredientForm
              ingredients={newProfile.ingredients}
              onChange={ingredients => setNewProfile({ ...newProfile, ingredients })}
              origins={data.origins}
            />
          </div>
          <div className="set-form-foot">
            <button onClick={saveNew} className="btn primary"><Save aria-hidden="true" />שמירת הפרופיל</button>
            <button onClick={() => { setAdding(false); setNewProfile(emptyProfile()); }} className="btn">ביטול</button>
          </div>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="card flush">
          <div className="card-head"><h2>עריכת פרופיל: {editing.name}</h2></div>
          <div className="card-body">
            <div className="rp-grid">
              <div className="form-group">
                <label htmlFor="rp-edit-name">שם הפרופיל *</label>
                <input id="rp-edit-name" type="text" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="rp-edit-level">רמת קלייה</label>
                <select id="rp-edit-level" value={editing.roast_level} onChange={e => setEditing({ ...editing, roast_level: e.target.value })}>
                  <option value="none">ללא</option>
                  <option value="light">לייט</option>
                  <option value="medium">מדיום</option>
                </select>
              </div>
            </div>
            <div className="rp-grid rp-grid-3">
              <div className="form-group">
                <label htmlFor="rp-edit-stock">מלאי קלוי נוכחי (ק"ג)</label>
                <input id="rp-edit-stock" type="number" step="0.1" value={editing.roasted_stock ?? ''} onChange={e => setEditing({ ...editing, roasted_stock: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="rp-edit-daily">ממוצע מכירות יומי (ק"ג)</label>
                <input id="rp-edit-daily" type="number" step="0.1" value={editing.daily_average ?? ''} onChange={e => setEditing({ ...editing, daily_average: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="rp-edit-min">מלאי מינימום (ק"ג)</label>
                <input id="rp-edit-min" type="number" step="0.1" value={editing.min_stock ?? ''} onChange={e => setEditing({ ...editing, min_stock: e.target.value })} />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="rp-edit-notes">הערות</label>
              <input id="rp-edit-notes" type="text" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
            </div>
            <IngredientForm
              ingredients={editing.ingredients}
              onChange={ingredients => setEditing({ ...editing, ingredients })}
              origins={data.origins}
            />
          </div>
          <div className="set-form-foot">
            <button onClick={saveEdit} className="btn primary"><Save aria-hidden="true" />שמירת השינויים</button>
            <button onClick={() => setEditing(null)} className="btn">ביטול</button>
          </div>
        </div>
      )}

      {/* Profile list */}
      {!adding && !editing && (
        <div className="card flush">
          <div className="card-head">
            <h2>כל הפרופילים</h2>
            <span className="meta num">{data.roastProfiles.length}</span>
          </div>
          {data.roastProfiles.length === 0 ? (
            <div className="empty-state">אין עדיין פרופילי קלייה.</div>
          ) : (
            <ul className="set-list">
              {data.roastProfiles.map(profile => {
                const ingredients = data.roastProfileIngredients.filter(i => i.profile_id === profile.id);
                const roastCount  = data.roasts.filter(r => r.roast_profile_id === profile.id).length;
                return (
                  <li key={profile.id} className="rp-item">
                    <div className="rp-main">
                      <div className="rp-title">
                        <span className="rp-name">{profile.name}</span>
                        {profile.roast_level !== 'none' && (
                          <span className="tag">{ROAST_LEVEL_LABELS[profile.roast_level]}</span>
                        )}
                      </div>
                      <div className="rp-blend">
                        {ingredients.map((ing, i) => {
                          const origin = data.origins.find(o => o.id === ing.origin_id);
                          return <span key={i}>{i > 0 ? ' · ' : ''}{ing.percentage}% {origin?.name || '?'}</span>;
                        })}
                      </div>
                      <dl className="rp-stats">
                        <div><dt>מלאי קלוי</dt><dd className="num">{(profile.roasted_stock || 0).toFixed(1)} ק"ג</dd></div>
                        {profile.daily_average > 0 && <div><dt>יומי</dt><dd className="num">{profile.daily_average} ק"ג</dd></div>}
                        {profile.min_stock > 0 && <div><dt>מינימום</dt><dd className="num">{profile.min_stock} ק"ג</dd></div>}
                        <div><dt>קליות</dt><dd className="num">{roastCount}</dd></div>
                      </dl>
                      {profile.notes && <div className="rp-notes">{profile.notes}</div>}
                    </div>
                    <div className="action-buttons">
                      <button onClick={() => startEdit(profile)} className="btn-icon" title="עריכה" aria-label={`עריכת ${profile.name}`}>
                        <Pencil aria-hidden="true" />
                      </button>
                      <button onClick={() => deleteProfile(profile)} className="btn-icon danger" title="מחיקה" aria-label={`מחיקת ${profile.name}`}>
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
