import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import { blendedWeightLoss } from '../../lib/utils';
import RoastingList from './RoastingList';

const ROAST_LEVEL_LABELS = { none: '', light: 'לייט', medium: 'מדיום' };
const ROAST_LEVEL_COLORS = { none: '#6B7280', light: '#F59E0B', medium: '#6F4E37' };

export default function Roasting() {
  const {
    data, originsDb, roastsDb, roastProfilesDb, roastComponentsDb,
    getOriginById, showToast
  } = useApp();

  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [greenWeight,        setGreenWeight]        = useState('15');
  const [selectedOperator,   setSelectedOperator]   = useState('');
  const [editingRoast,       setEditingRoast]        = useState(null);
  const [view,               setView]               = useState('log'); // 'log' | 'list'

  // Filters
  const [searchTerm,    setSearchTerm]    = useState('');
  const [dateFilter,    setDateFilter]    = useState('all');
  const [startDate,     setStartDate]     = useState('');
  const [endDate,       setEndDate]       = useState('');
  const [displayLimit,  setDisplayLimit]  = useState(20);
  const [selectedRoasts, setSelectedRoasts] = useState([]);

  // ── HELPERS ───────────────────────────────────────────────────────────────────

  const getProfileById = (id) => data.roastProfiles.find(p => p.id === parseInt(id));

  const getProfileIngredients = (profileId) =>
    data.roastProfileIngredients.filter(i => i.profile_id === parseInt(profileId));

  const previewIngredients = (profileId, totalGreenKg) => {
    const ings = getProfileIngredients(profileId);
    return ings.map(ing => {
      const origin  = getOriginById(ing.origin_id);
      const greenUsed = (totalGreenKg * ing.percentage / 100);
      return { origin, percentage: ing.percentage, greenUsed };
    });
  };

  const calcRoastedWeight = (profileId, totalGreenKg) => {
    const ings        = getProfileIngredients(profileId);
    const weightLoss  = blendedWeightLoss(ings, data.origins);
    return parseFloat((totalGreenKg * (1 - weightLoss / 100)).toFixed(2));
  };

  // ── RECORD ────────────────────────────────────────────────────────────────────

  const recordRoast = async () => {
    if (!selectedProfileId || !greenWeight || !selectedOperator) {
      showToast('⚠️ נא למלא את כל השדות', 'warning'); return;
    }
    const profile = getProfileById(selectedProfileId);
    if (!profile) { showToast('⚠️ פרופיל לא נמצא', 'warning'); return; }

    const weight = parseFloat(greenWeight);
    if (weight <= 0 || weight > 20) { showToast('⚠️ משקל לא תקין (1-20 ק"ג)', 'warning'); return; }

    const ings = getProfileIngredients(selectedProfileId);
    if (ings.length === 0) { showToast('⚠️ לפרופיל זה אין רכיבים מוגדרים', 'warning'); return; }

    // Validate each origin has enough green stock
    for (const ing of ings) {
      const origin   = getOriginById(ing.origin_id);
      const greenUsed = weight * ing.percentage / 100;
      if (!origin) { showToast(`⚠️ זן לא נמצא (ID ${ing.origin_id})`, 'warning'); return; }
      if (origin.stock < greenUsed) {
        showToast(`⚠️ אין מספיק מלאי ירוק ל${origin.name}! נדרש: ${greenUsed.toFixed(2)} ק"ג, קיים: ${origin.stock} ק"ג`, 'warning'); return;
      }
    }

    const roastedWeight = calcRoastedWeight(selectedProfileId, weight);
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const todayRoasts = data.roasts.filter(r => r.date && r.date.startsWith(new Date().toISOString().split('T')[0]));
    const batchNum = `BATCH-${today}-${String(todayRoasts.length + 1).padStart(3, '0')}`;

    try {
      // Insert roast row
      const { data: roastRow, error: roastErr } = await supabase
        .from('roasts')
        .insert({
          roast_profile_id: profile.id,
          origin_id: null,
          green_weight: weight,
          roasted_weight: roastedWeight,
          operator: selectedOperator,
          date: new Date().toISOString(),
          batch_number: batchNum,
          user_id: data.origins[0]?.user_id
        })
        .select()
        .single();
      if (roastErr) throw roastErr;

      // Insert components + deduct stock
      for (const ing of ings) {
        const origin   = getOriginById(ing.origin_id);
        const greenUsed = parseFloat((weight * ing.percentage / 100).toFixed(4));

        await supabase.from('roast_components').insert({
          roast_id: roastRow.id, origin_id: ing.origin_id, green_weight_used: greenUsed
        });

        await originsDb.update(origin.id, { stock: parseFloat((origin.stock - greenUsed).toFixed(4)) });
      }

      // Update profile roasted_stock
      await roastProfilesDb.update(profile.id, {
        roasted_stock: parseFloat(((profile.roasted_stock || 0) + roastedWeight).toFixed(4)),
        updated_at: new Date().toISOString()
      });

      await roastsDb.refresh();
      await originsDb.refresh();
      await roastProfilesDb.refresh();
      await roastComponentsDb.refresh();

      setGreenWeight('15'); setSelectedProfileId(''); setSelectedOperator('');
      showToast(`✅ קלייה נרשמה! ${batchNum} | ${weight} ק"ג ירוק → ${roastedWeight} ק"ג קלוי`);
    } catch (err) {
      console.error('Error recording roast:', err);
      showToast('❌ שגיאה ברישום קלייה', 'error');
    }
  };

  // ── EDIT ──────────────────────────────────────────────────────────────────────

  const startEditRoast = (roast) => {
    setEditingRoast({
      id:             roast.id,
      profileId:      roast.roast_profile_id,
      originId:       roast.origin_id,         // legacy
      greenWeight:    roast.green_weight,
      operator:       roast.operator,
      oldGreenWeight: roast.green_weight,
      oldRoastedWeight: roast.roasted_weight,
      isProfile:      !!roast.roast_profile_id
    });
  };

  const saveEditRoast = async () => {
    if (!editingRoast.greenWeight || !editingRoast.operator) {
      showToast('⚠️ נא למלא את כל השדות', 'warning'); return;
    }

    const newWeight = parseFloat(editingRoast.greenWeight);
    if (newWeight <= 0 || newWeight > 20) { showToast('⚠️ משקל לא תקין', 'warning'); return; }

    try {
      if (editingRoast.isProfile) {
        // Profile-based edit
        const profile  = getProfileById(editingRoast.profileId);
        const ings     = getProfileIngredients(editingRoast.profileId);
        const oldComps = data.roastComponents.filter(c => c.roast_id === editingRoast.id);

        // Phase A: reverse old components
        for (const comp of oldComps) {
          const origin = getOriginById(comp.origin_id);
          if (origin) {
            await originsDb.update(origin.id, { stock: parseFloat((origin.stock + comp.green_weight_used).toFixed(4)) });
          }
        }
        // Subtract old roasted weight from profile
        await roastProfilesDb.update(profile.id, {
          roasted_stock: parseFloat(((profile.roasted_stock || 0) - editingRoast.oldRoastedWeight).toFixed(4)),
          updated_at: new Date().toISOString()
        });
        // Delete old components
        await supabase.from('roast_components').delete().eq('roast_id', editingRoast.id);

        // Phase B: validate and apply new
        for (const ing of ings) {
          const origin   = getOriginById(ing.origin_id);
          const greenUsed = newWeight * ing.percentage / 100;
          if (!origin || origin.stock < greenUsed) {
            showToast(`⚠️ אין מספיק מלאי ירוק ל${origin?.name || '?'}`, 'warning');
            // Rollback A — re-add components
            for (const comp of oldComps) {
              const o = getOriginById(comp.origin_id);
              if (o) await originsDb.update(o.id, { stock: parseFloat((o.stock - comp.green_weight_used).toFixed(4)) });
            }
            await roastProfilesDb.update(profile.id, {
              roasted_stock: parseFloat(((profile.roasted_stock || 0) + editingRoast.oldRoastedWeight).toFixed(4)),
              updated_at: new Date().toISOString()
            });
            await supabase.from('roast_components').insert(oldComps.map(c => ({ roast_id: c.roast_id, origin_id: c.origin_id, green_weight_used: c.green_weight_used })));
            return;
          }
        }

        const newRoastedWeight = calcRoastedWeight(editingRoast.profileId, newWeight);
        await roastsDb.update(editingRoast.id, {
          green_weight: newWeight, roasted_weight: newRoastedWeight,
          operator: editingRoast.operator, updated_at: new Date().toISOString()
        });

        for (const ing of ings) {
          const origin   = getOriginById(ing.origin_id);
          const greenUsed = parseFloat((newWeight * ing.percentage / 100).toFixed(4));
          await supabase.from('roast_components').insert({ roast_id: editingRoast.id, origin_id: ing.origin_id, green_weight_used: greenUsed });
          await originsDb.update(origin.id, { stock: parseFloat((origin.stock - greenUsed).toFixed(4)) });
        }

        await roastProfilesDb.update(profile.id, {
          roasted_stock: parseFloat(((profile.roasted_stock || 0) + newRoastedWeight).toFixed(4)),
          updated_at: new Date().toISOString()
        });

      } else {
        // Legacy origin-based edit
        const newOrigin    = getOriginById(editingRoast.originId);
        const oldOrigin    = getOriginById(editingRoast.originId); // same origin; old logic
        if (!newOrigin) { showToast('⚠️ זן לא נמצא', 'warning'); return; }

        const newRoastedWeight  = parseFloat((newWeight * (1 - (newOrigin.weight_loss || 20) / 100)).toFixed(2));
        const oldWeight         = parseFloat(editingRoast.oldGreenWeight);
        const oldRoastedWeight  = parseFloat(editingRoast.oldRoastedWeight);

        await roastsDb.update(editingRoast.id, {
          green_weight: newWeight, roasted_weight: newRoastedWeight,
          operator: editingRoast.operator, updated_at: new Date().toISOString()
        });

        const stockDiff  = newWeight - oldWeight;
        const roastedDiff = newRoastedWeight - oldRoastedWeight;
        await originsDb.update(newOrigin.id, {
          stock: newOrigin.stock - stockDiff,
          roasted_stock: (newOrigin.roasted_stock || 0) + roastedDiff
        });
      }

      await roastsDb.refresh();
      await originsDb.refresh();
      await roastProfilesDb.refresh();
      await roastComponentsDb.refresh();
      setEditingRoast(null);
      showToast('✅ קלייה עודכנה!');
    } catch (err) {
      console.error('Error updating roast:', err);
      showToast('❌ שגיאה בעדכון קלייה', 'error');
    }
  };

  // ── DELETE ────────────────────────────────────────────────────────────────────

  const deleteRoast = async (roast) => {
    const isProfile = !!roast.roast_profile_id;
    const label = isProfile
      ? getProfileById(roast.roast_profile_id)?.name || 'פרופיל לא ידוע'
      : getOriginById(roast.origin_id)?.name || 'זן לא ידוע';
    if (!window.confirm(`⚠️ האם למחוק קלייה זו?\n${roast.green_weight} ק"ג ${label}\nהמלאי יוחזר`)) return;

    try {
      if (isProfile) {
        const profile = getProfileById(roast.roast_profile_id);
        const comps   = data.roastComponents.filter(c => c.roast_id === roast.id);
        for (const comp of comps) {
          const origin = getOriginById(comp.origin_id);
          if (origin) await originsDb.update(origin.id, { stock: parseFloat((origin.stock + comp.green_weight_used).toFixed(4)) });
        }
        if (profile) {
          await roastProfilesDb.update(profile.id, {
            roasted_stock: parseFloat(((profile.roasted_stock || 0) - roast.roasted_weight).toFixed(4)),
            updated_at: new Date().toISOString()
          });
        }
      } else {
        const origin = getOriginById(roast.origin_id);
        if (origin) {
          await originsDb.update(origin.id, { stock: origin.stock + roast.green_weight, roasted_stock: (origin.roasted_stock || 0) - roast.roasted_weight });
        }
      }

      await roastsDb.remove(roast.id); // cascades roast_components
      await roastsDb.refresh();
      await originsDb.refresh();
      await roastProfilesDb.refresh();
      await roastComponentsDb.refresh();
      showToast('✅ קלייה נמחקה והמלאי הוחזר!');
    } catch (err) {
      console.error('Error deleting roast:', err);
      showToast('❌ שגיאה במחיקת קלייה', 'error');
    }
  };

  // ── BULK DELETE ───────────────────────────────────────────────────────────────

  const toggleRoastSelection  = (id) => setSelectedRoasts(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleSelectAll       = () => setSelectedRoasts(selectedRoasts.length === displayedRoasts.length ? [] : displayedRoasts.map(r => r.id));

  const deleteSelectedRoasts = async () => {
    if (selectedRoasts.length === 0) { showToast('⚠️ לא נבחרו קליות למחיקה', 'warning'); return; }
    if (!window.confirm(`⚠️ האם למחוק ${selectedRoasts.length} קליות?\n\nהמלאי יוחזר אוטומטית.`)) return;
    try {
      for (const roastId of selectedRoasts) {
        const roast = data.roasts.find(r => r.id === roastId);
        if (!roast) continue;
        if (roast.roast_profile_id) {
          const profile = getProfileById(roast.roast_profile_id);
          const comps   = data.roastComponents.filter(c => c.roast_id === roast.id);
          for (const comp of comps) {
            const origin = getOriginById(comp.origin_id);
            if (origin) await originsDb.update(origin.id, { stock: parseFloat((origin.stock + comp.green_weight_used).toFixed(4)) });
          }
          if (profile) {
            await roastProfilesDb.update(profile.id, {
              roasted_stock: parseFloat(((profile.roasted_stock || 0) - roast.roasted_weight).toFixed(4)),
              updated_at: new Date().toISOString()
            });
          }
        } else {
          const origin = getOriginById(roast.origin_id);
          if (origin) await originsDb.update(origin.id, { stock: origin.stock + roast.green_weight, roasted_stock: (origin.roasted_stock || 0) - roast.roasted_weight });
        }
        await roastsDb.remove(roast.id);
      }
      await roastsDb.refresh();
      await originsDb.refresh();
      await roastProfilesDb.refresh();
      await roastComponentsDb.refresh();
      const count = selectedRoasts.length;
      setSelectedRoasts([]);
      showToast(`✅ ${count} קליות נמחקו והמלאי הוחזר!`);
    } catch (err) {
      console.error('Error bulk deleting roasts:', err);
      showToast('❌ שגיאה במחיקת קליות', 'error');
    }
  };

  // ── FILTERING ─────────────────────────────────────────────────────────────────

  const getFilteredRoasts = () => {
    let filtered = [...data.roasts];
    const now      = new Date();
    const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo  = new Date(today.getTime() - 7  * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (dateFilter === 'today')  filtered = filtered.filter(r => new Date(r.date) >= today);
    if (dateFilter === 'week')   filtered = filtered.filter(r => new Date(r.date) >= weekAgo);
    if (dateFilter === 'month')  filtered = filtered.filter(r => new Date(r.date) >= monthAgo);
    if (dateFilter === 'custom') {
      if (startDate) { const s = new Date(startDate); s.setHours(0,0,0,0); filtered = filtered.filter(r => new Date(r.date) >= s); }
      if (endDate)   { const e = new Date(endDate);   e.setHours(23,59,59,999); filtered = filtered.filter(r => new Date(r.date) <= e); }
    }
    if (searchTerm) {
      filtered = filtered.filter(r => {
        if (r.roast_profile_id) {
          const profile = getProfileById(r.roast_profile_id);
          return profile?.name?.toLowerCase().includes(searchTerm.toLowerCase())
            || r.operator?.toLowerCase().includes(searchTerm.toLowerCase());
        }
        const origin = getOriginById(r.origin_id);
        return origin?.name?.toLowerCase().includes(searchTerm.toLowerCase())
          || r.operator?.toLowerCase().includes(searchTerm.toLowerCase());
      });
    }
    return filtered.slice().reverse();
  };

  const filteredRoasts  = getFilteredRoasts();
  const displayedRoasts = filteredRoasts.slice(0, displayLimit);
  const hasMore         = filteredRoasts.length > displayLimit;

  // ── PREVIEW (new roast form) ───────────────────────────────────────────────────

  const selectedProfile = getProfileById(selectedProfileId);
  const preview = selectedProfile && greenWeight
    ? previewIngredients(selectedProfileId, parseFloat(greenWeight))
    : [];
  const previewRoastedKg = selectedProfile && greenWeight
    ? calcRoastedWeight(selectedProfileId, parseFloat(greenWeight))
    : null;

  // ── LIST VIEW ─────────────────────────────────────────────────────────────────

  if (view === 'list') {
    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>📋 רשימת קלייה</h1>
          <button onClick={() => setView('log')} className="btn-small">← חזור לרישום</button>
        </div>
        <RoastingList data={data} originsDb={originsDb} roastsDb={roastsDb} showToast={showToast} />
      </div>
    );
  }

  // ── MAIN VIEW ─────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>🔥 רישום קלייה</h1>
        <button onClick={() => setView('list')} className="btn-small" style={{ background: '#6F4E37', color: 'white' }}>
          📋 רשימת קלייה
        </button>
      </div>

      {/* Edit form */}
      {editingRoast && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
          <h3>✏️ עריכת קלייה</h3>
          <div className="form-grid">
            {editingRoast.isProfile ? (
              <div className="form-group">
                <label>פרופיל</label>
                <input type="text" disabled value={getProfileById(editingRoast.profileId)?.name || ''} style={{ background: '#F3F4F6', color: '#6B7280' }} />
              </div>
            ) : (
              <div className="form-group">
                <label>זן</label>
                <input type="text" disabled value={getOriginById(editingRoast.originId)?.name || ''} style={{ background: '#F3F4F6', color: '#6B7280' }} />
              </div>
            )}
            <div className="form-group">
              <label>משקל ירוק (ק"ג)</label>
              <input type="number" step="0.1" value={editingRoast.greenWeight} onChange={e => setEditingRoast({ ...editingRoast, greenWeight: e.target.value })} />
            </div>
            <div className="form-group">
              <label>מפעיל</label>
              <select value={editingRoast.operator} onChange={e => setEditingRoast({ ...editingRoast, operator: e.target.value })}>
                <option value="">בחר מפעיל...</option>
                {data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}
              </select>
            </div>
          </div>
          {editingRoast.isProfile && editingRoast.greenWeight && (
            <div className="calculation-display">
              משקל קלוי משוער: <strong>{calcRoastedWeight(editingRoast.profileId, parseFloat(editingRoast.greenWeight))} ק"ג</strong>
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={saveEditRoast} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
            <button onClick={() => setEditingRoast(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* New roast form */}
      <div className="form-card">
        {data.roastProfiles.length === 0 ? (
          <div style={{ color: '#666', padding: '1rem', textAlign: 'center' }}>
            ⚠️ עדיין אין פרופילי קלייה.{' '}
            <a href="/settings" style={{ color: '#6F4E37', fontWeight: 'bold' }}>הגדר פרופילים בהגדרות ←</a>
          </div>
        ) : (
          <>
            <div className="form-grid">
              <div className="form-group">
                <label>בחר פרופיל קלייה</label>
                <select value={selectedProfileId} onChange={e => setSelectedProfileId(e.target.value)}>
                  <option value="">בחר פרופיל...</option>
                  {data.roastProfiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.roast_level !== 'none' ? ` (${ROAST_LEVEL_LABELS[p.roast_level]})` : ''} — מלאי: {(p.roasted_stock || 0).toFixed(1)} ק"ג
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>משקל ירוק (ק"ג)</label>
                <input type="number" step="0.1" placeholder="15" value={greenWeight} onChange={e => setGreenWeight(e.target.value)} />
              </div>
              <div className="form-group">
                <label>מפעיל</label>
                <select value={selectedOperator} onChange={e => setSelectedOperator(e.target.value)}>
                  <option value="">בחר מפעיל...</option>
                  {data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}
                </select>
              </div>
            </div>

            {/* Preview */}
            {selectedProfile && greenWeight && preview.length > 0 && (
              <div className="calculation-display">
                <div style={{ marginBottom: '0.5rem', fontWeight: 'bold', color: '#6F4E37' }}>
                  {selectedProfile.name}
                  {selectedProfile.roast_level !== 'none' && (
                    <span style={{ marginRight: '0.5rem', background: ROAST_LEVEL_COLORS[selectedProfile.roast_level], color: 'white', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.8rem' }}>
                      {ROAST_LEVEL_LABELS[selectedProfile.roast_level]}
                    </span>
                  )}
                </div>
                {preview.map((p, i) => (
                  <div key={i} style={{ fontSize: '0.9rem' }}>
                    🌱 {p.origin?.name || '?'} — {p.percentage}% → <strong>{p.greenUsed.toFixed(2)} ק"ג ירוק</strong>
                    {p.origin && p.origin.stock < p.greenUsed && (
                      <span style={{ color: '#DC2626', marginRight: '0.5rem' }}>⚠️ מלאי לא מספיק ({p.origin.stock} ק"ג)</span>
                    )}
                  </div>
                ))}
                <div style={{ marginTop: '0.5rem', fontWeight: 'bold' }}>
                  🔥 צפי קלוי: <strong>{previewRoastedKg} ק"ג</strong>
                </div>
              </div>
            )}

            <button onClick={recordRoast} className="btn-primary">🔥 רשום קלייה</button>
          </>
        )}
      </div>

      {/* History + filters */}
      <div className="section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2>📋 היסטוריית קליות ({filteredRoasts.length})</h2>
          {selectedRoasts.length > 0 && (
            <button onClick={deleteSelectedRoasts} className="btn-small" style={{ background: '#DC2626', color: 'white' }}>
              🗑️ מחק נבחרים ({selectedRoasts.length})
            </button>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <input type="text" placeholder="🔍 חיפוש..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="search-input" style={{ maxWidth: '200px' }} />
          <select value={dateFilter} onChange={e => setDateFilter(e.target.value)} className="sort-select">
            <option value="all">כל הזמן</option>
            <option value="today">היום</option>
            <option value="week">שבוע אחרון</option>
            <option value="month">חודש אחרון</option>
            <option value="custom">תאריכים מותאמים</option>
          </select>
          {dateFilter === 'custom' && (
            <>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="sort-select" />
              <input type="date" value={endDate}   onChange={e => setEndDate(e.target.value)}   className="sort-select" />
            </>
          )}
        </div>

        {filteredRoasts.length === 0 ? (
          <div className="empty-state">אין קליות עדיין. רשום קלייה ראשונה!</div>
        ) : (
          <>
            <div style={{ marginBottom: '0.5rem' }}>
              <label style={{ cursor: 'pointer', fontSize: '0.9rem', color: '#666' }}>
                <input type="checkbox" checked={selectedRoasts.length === displayedRoasts.length && displayedRoasts.length > 0} onChange={toggleSelectAll} style={{ marginLeft: '0.5rem' }} />
                בחר הכל
              </label>
            </div>

            <div className="roasts-list">
              {displayedRoasts.map(roast => {
                const isProfile  = !!roast.roast_profile_id;
                const profile    = isProfile ? getProfileById(roast.roast_profile_id) : null;
                const origin     = !isProfile ? getOriginById(roast.origin_id) : null;
                const comps      = isProfile ? data.roastComponents.filter(c => c.roast_id === roast.id) : [];
                const isSelected = selectedRoasts.includes(roast.id);

                return (
                  <div key={roast.id} className="roast-card" style={{ border: isSelected ? '2px solid #3B82F6' : undefined }}>
                    <div className="roast-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleRoastSelection(roast.id)} onClick={e => e.stopPropagation()} />
                        <h3>
                          {isProfile ? (profile?.name || 'פרופיל לא ידוע') : (origin?.name || 'זן לא ידוע')}
                        </h3>
                        {isProfile && profile?.roast_level && profile.roast_level !== 'none' && (
                          <span style={{ background: ROAST_LEVEL_COLORS[profile.roast_level], color: 'white', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                            {ROAST_LEVEL_LABELS[profile.roast_level]}
                          </span>
                        )}
                        {roast.batch_number && (
                          <span style={{ fontSize: '0.75rem', color: '#999', background: '#F3F4F6', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{roast.batch_number}</span>
                        )}
                      </div>
                      <div className="roast-actions">
                        <button onClick={() => startEditRoast(roast)} className="btn-icon">✏️</button>
                        <button onClick={() => deleteRoast(roast)} className="btn-icon">🗑️</button>
                      </div>
                    </div>

                    <div className="roast-details">
                      <div>🌱 ירוק: <strong>{roast.green_weight} ק"ג</strong></div>
                      <div>🔥 קלוי: <strong>{roast.roasted_weight} ק"ג</strong></div>
                      <div>👨‍🍳 מפעיל: <strong>{roast.operator}</strong></div>
                      <div>📅 תאריך: <strong>{new Date(roast.date).toLocaleDateString('he-IL')}</strong></div>
                      {roast.updated_at && (
                        <div style={{ fontSize: '0.85em', color: '#FF6B35' }}>✏️ עודכן: {new Date(roast.updated_at).toLocaleString('he-IL')}</div>
                      )}
                    </div>

                    {/* Profile roast: show ingredient breakdown */}
                    {isProfile && comps.length > 0 && (
                      <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: '#FFFBF5', borderRadius: '6px', fontSize: '0.8rem', borderTop: '1px solid #F4E8D8' }}>
                        {comps.map((comp, i) => {
                          const o = getOriginById(comp.origin_id);
                          return <span key={i} style={{ marginLeft: '0.75rem' }}>• {o?.name || '?'}: {comp.green_weight_used} ק"ג</span>;
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {hasMore && (
              <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
                <button onClick={() => setDisplayLimit(displayLimit + 20)} className="btn-small" style={{ background: '#6F4E37', color: 'white', padding: '0.75rem 2rem' }}>
                  ⬇️ טען עוד 20 קליות
                </button>
                <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#999' }}>מציג {displayedRoasts.length} מתוך {filteredRoasts.length}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
