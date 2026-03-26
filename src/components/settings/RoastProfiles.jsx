import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

const ROAST_LEVEL_LABELS = { none: 'ללא', light: 'לייט', medium: 'מדיום' };
const ROAST_LEVEL_COLORS = { none: '#6B7280', light: '#F59E0B', medium: '#6F4E37' };

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
    <div className="form-group">
      <label>רכיבים (סה"כ חייב להיות 100%) *</label>
      {ingredients.map((ing, index) => (
        <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '10px', marginBottom: '10px' }}>
          <select value={ing.origin_id || ''} onChange={e => update(index, 'origin_id', e.target.value)}>
            <option value="">בחר זן...</option>
            {origins.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <input
            type="number" placeholder="%" min="0" max="100" step="0.1"
            value={ing.percentage}
            onChange={e => update(index, 'percentage', e.target.value)}
          />
          {ingredients.length > 1 && (
            <button onClick={() => remove(index)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }}>🗑️</button>
          )}
        </div>
      ))}
      <button onClick={add} className="btn-small" style={{ marginTop: '5px' }}>➕ הוסף זן</button>
      <div style={{ marginTop: '10px', fontSize: '14px', color: total === 100 ? '#059669' : '#DC2626' }}>
        סה"כ: {total}%
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
    if (!profile.name.trim()) { showToast('⚠️ נא למלא שם פרופיל', 'warning'); return false; }
    if (!profile.ingredients || profile.ingredients.length === 0) { showToast('⚠️ נא להוסיף לפחות רכיב אחד', 'warning'); return false; }
    for (const ing of profile.ingredients) {
      if (!ing.origin_id) { showToast('⚠️ נא לבחור זן לכל רכיב', 'warning'); return false; }
    }
    const total = profile.ingredients.reduce((s, i) => s + (parseFloat(i.percentage) || 0), 0);
    if (Math.abs(total - 100) > 0.1) {
      showToast(`⚠️ סכום האחוזים חייב להיות 100% (כרגע: ${total}%)`, 'warning');
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
      showToast('✅ פרופיל קלייה נוסף!');
    } catch (err) {
      console.error('Error saving profile:', err);
      showToast('❌ שגיאה בשמירת פרופיל', 'error');
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
      showToast('✅ פרופיל עודכן!');
    } catch (err) {
      console.error('Error updating profile:', err);
      showToast('❌ שגיאה בעדכון פרופיל', 'error');
    }
  };

  const deleteProfile = async (profile) => {
    const hasHistory = data.roasts.some(r => r.roast_profile_id === profile.id);
    if (hasHistory) { showToast('⚠️ לא ניתן למחוק פרופיל עם היסטוריית קליות', 'warning'); return; }
    if (!window.confirm(`האם למחוק את הפרופיל "${profile.name}"?`)) return;
    try {
      await roastProfilesDb.remove(profile.id);
      await roastProfileIngredientsDb.refresh();
      showToast('✅ פרופיל נמחק!');
    } catch (err) {
      console.error('Error deleting profile:', err);
      showToast('❌ שגיאה במחיקת פרופיל', 'error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="section" style={{ marginTop: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2>🔥 פרופילי קלייה ({data.roastProfiles.length})</h2>
        {!adding && !editing && (
          <button onClick={() => setAdding(true)} className="btn-primary">➕ הוסף פרופיל</button>
        )}
      </div>
      <p style={{ color: '#666', marginBottom: '1rem' }}>
        פרופיל קלייה מגדיר מה קולים (זנים ואחוזים) ואת רמת הקלייה. כל פרופיל מנהל מלאי קלוי נפרד.
      </p>

      {/* Add form */}
      {adding && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#F0F9FF', border: '2px solid #3B82F6' }}>
          <h3>➕ פרופיל חדש</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label>שם הפרופיל *</label>
              <input type="text" placeholder="למשל: Kenya Light" value={newProfile.name} onChange={e => setNewProfile({ ...newProfile, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>רמת קלייה</label>
              <select value={newProfile.roast_level} onChange={e => setNewProfile({ ...newProfile, roast_level: e.target.value })}>
                <option value="none">ללא</option>
                <option value="light">לייט</option>
                <option value="medium">מדיום</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label>ממוצע מכירות יומי (ק"ג)</label>
              <input type="number" step="0.1" placeholder="למשל: 1.5" value={newProfile.daily_average} onChange={e => setNewProfile({ ...newProfile, daily_average: e.target.value })} />
            </div>
            <div className="form-group">
              <label>מלאי מינימום (ק"ג)</label>
              <input type="number" step="0.1" placeholder="למשל: 5" value={newProfile.min_stock} onChange={e => setNewProfile({ ...newProfile, min_stock: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>הערות (אופציונלי)</label>
            <input type="text" placeholder="מידע נוסף..." value={newProfile.notes} onChange={e => setNewProfile({ ...newProfile, notes: e.target.value })} />
          </div>
          <IngredientForm
            ingredients={newProfile.ingredients}
            onChange={ingredients => setNewProfile({ ...newProfile, ingredients })}
            origins={data.origins}
          />
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={saveNew} className="btn-primary" style={{ flex: 1 }}>💾 שמור פרופיל</button>
            <button onClick={() => { setAdding(false); setNewProfile(emptyProfile()); }} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
          <h3>✏️ עריכת פרופיל: {editing.name}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label>שם הפרופיל *</label>
              <input type="text" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>רמת קלייה</label>
              <select value={editing.roast_level} onChange={e => setEditing({ ...editing, roast_level: e.target.value })}>
                <option value="none">ללא</option>
                <option value="light">לייט</option>
                <option value="medium">מדיום</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label>מלאי קלוי נוכחי (ק"ג)</label>
              <input type="number" step="0.1" value={editing.roasted_stock ?? ''} onChange={e => setEditing({ ...editing, roasted_stock: e.target.value })} />
            </div>
            <div className="form-group">
              <label>ממוצע מכירות יומי (ק"ג)</label>
              <input type="number" step="0.1" value={editing.daily_average ?? ''} onChange={e => setEditing({ ...editing, daily_average: e.target.value })} />
            </div>
            <div className="form-group">
              <label>מלאי מינימום (ק"ג)</label>
              <input type="number" step="0.1" value={editing.min_stock ?? ''} onChange={e => setEditing({ ...editing, min_stock: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>הערות</label>
            <input type="text" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
          </div>
          <IngredientForm
            ingredients={editing.ingredients}
            onChange={ingredients => setEditing({ ...editing, ingredients })}
            origins={data.origins}
          />
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={saveEdit} className="btn-primary" style={{ flex: 1 }}>💾 שמור שינויים</button>
            <button onClick={() => setEditing(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* Profile cards */}
      {!adding && !editing && (
        <>
          {data.roastProfiles.length === 0 ? (
            <div className="empty-state">אין פרופילי קלייה. הוסף פרופיל ראשון!</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {data.roastProfiles.map(profile => {
                const ingredients = data.roastProfileIngredients.filter(i => i.profile_id === profile.id);
                const roastCount  = data.roasts.filter(r => r.roast_profile_id === profile.id).length;
                return (
                  <div key={profile.id} style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '1.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                          <strong style={{ fontSize: '1.1rem' }}>{profile.name}</strong>
                          {profile.roast_level !== 'none' && (
                            <span style={{ background: ROAST_LEVEL_COLORS[profile.roast_level], color: 'white', padding: '0.15rem 0.5rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 'bold' }}>
                              {ROAST_LEVEL_LABELS[profile.roast_level]}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: '0.5rem' }}>
                          {ingredients.map((ing, i) => {
                            const origin = data.origins.find(o => o.id === ing.origin_id);
                            return <span key={i}>{i > 0 ? ' · ' : ''}{ing.percentage}% {origin?.name || '?'}</span>;
                          })}
                        </div>
                        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.875rem', flexWrap: 'wrap' }}>
                          <span>📦 מלאי קלוי: <strong>{(profile.roasted_stock || 0).toFixed(1)} ק"ג</strong></span>
                          {profile.daily_average > 0 && <span>📈 יומי: <strong>{profile.daily_average} ק"ג</strong></span>}
                          {profile.min_stock > 0 && <span>⚠️ מינימום: <strong>{profile.min_stock} ק"ג</strong></span>}
                          <span>🔥 קליות: <strong>{roastCount}</strong></span>
                          {profile.notes && <span style={{ color: '#999' }}>📝 {profile.notes}</span>}
                        </div>
                      </div>
                      <div className="action-buttons">
                        <button onClick={() => startEdit(profile)} className="btn-icon">✏️</button>
                        <button onClick={() => deleteProfile(profile)} className="btn-icon">🗑️</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
