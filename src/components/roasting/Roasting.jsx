import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { blendedWeightLoss } from '../../lib/utils';
import { notifyTeamIfWaiting } from '../../lib/telegram';
import RoastingList from './RoastingList';

const ROAST_LEVEL_LABELS = { none: '', light: 'לייט', medium: 'מדיום' };
const ROAST_LEVEL_COLORS = { none: '#6B7280', light: '#F59E0B', medium: '#6F4E37' };

export default function Roasting() {
  const {
    data, originsDb, roastsDb, roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb,
    getOriginById, calculateRoastedWeight, showToast, waitingCustomersDb
  } = useApp();

  // Form mode: 'origin' (simple) | 'profile' (blend / multi-level)
  const [formMode,         setFormMode]         = useState('origin');
  const [selectedOrigin,   setSelectedOrigin]   = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [greenWeight,      setGreenWeight]       = useState('15');
  const [selectedOperator, setSelectedOperator]  = useState('');
  const [colorReading,     setColorReading]      = useState('');
  const [editingRoast,     setEditingRoast]      = useState(null);
  const [view,             setView]              = useState('log'); // 'log' | 'list'

  // Filters
  const [searchTerm,    setSearchTerm]    = useState('');
  const [dateFilter,    setDateFilter]    = useState('all');
  const [startDate,     setStartDate]     = useState('');
  const [endDate,       setEndDate]       = useState('');
  const [displayLimit,  setDisplayLimit]  = useState(20);
  const [selectedRoasts, setSelectedRoasts] = useState([]);

  const navigate = useNavigate();

  const startChecklist = () => {
    const profileName = formMode === 'profile'
      ? data.roastProfiles.find(p => p.id === parseInt(selectedProfileId))?.name || ''
      : '';
    const originName = formMode === 'origin'
      ? data.origins.find(o => o.id === parseInt(selectedOrigin))?.name || ''
      : '';
    navigate('/checklist', {
      state: {
        prefillVars: {
          weight:   greenWeight,
          profile:  profileName || originName,
          origin:   originName,
          operator: selectedOperator,
        }
      }
    });
  };

  // ── HELPERS ───────────────────────────────────────────────────────────────────

  const getProfileById = (id) => data.roastProfiles.find(p => p.id === parseInt(id));

  const getProfileIngredients = (profileId) =>
    data.roastProfileIngredients.filter(i => i.profile_id === parseInt(profileId));

  const previewIngredients = (profileId, totalGreenKg) => {
    const ings = getProfileIngredients(profileId);
    return ings.map(ing => {
      const origin    = getOriginById(ing.origin_id);
      const greenUsed = totalGreenKg * ing.percentage / 100;
      return { origin, percentage: ing.percentage, greenUsed };
    });
  };

  const calcProfileRoastedWeight = (profileId, totalGreenKg) => {
    const ings       = getProfileIngredients(profileId);
    const weightLoss = blendedWeightLoss(ings, data.origins);
    return parseFloat((totalGreenKg * (1 - weightLoss / 100)).toFixed(2));
  };

  const makeBatchNum = () => {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const todayRoasts = data.roasts.filter(r => r.date && r.date.startsWith(new Date().toISOString().split('T')[0]));
    return `BATCH-${today}-${String(todayRoasts.length + 1).padStart(3, '0')}`;
  };

  // ── RECORD — SIMPLE ORIGIN ────────────────────────────────────────────────────

  const recordOriginRoast = async () => {
    if (!selectedOrigin || !greenWeight || !selectedOperator) {
      showToast('⚠️ נא למלא את כל השדות', 'warning'); return;
    }
    const origin = getOriginById(parseInt(selectedOrigin));
    if (!origin) { showToast('⚠️ זן לא נמצא', 'warning'); return; }

    const weight = parseFloat(greenWeight);
    if (weight <= 0 || weight > 20) { showToast('⚠️ משקל לא תקין (1-20 ק"ג)', 'warning'); return; }
    if (origin.stock < weight) {
      showToast(`⚠️ אין מספיק מלאי! נדרש: ${weight} ק"ג, קיים: ${origin.stock} ק"ג`, 'warning'); return;
    }

    const roastedWeight = parseFloat(calculateRoastedWeight(weight, origin.weight_loss));
    const batchNum = makeBatchNum();

    try {
      await roastsDb.insert({
        origin_id: origin.id, roast_profile_id: null,
        green_weight: weight, roasted_weight: roastedWeight,
        operator: selectedOperator, date: new Date().toISOString(), batch_number: batchNum,
        color_reading: colorReading ? parseFloat(colorReading) : null,
      });
      await originsDb.update(origin.id, {
        stock: origin.stock - weight,
        roasted_stock: (origin.roasted_stock || 0) + roastedWeight
      });
      await roastsDb.refresh();
      await originsDb.refresh();
      setGreenWeight('15'); setSelectedOrigin(''); setSelectedOperator('');
      showToast(`✅ קלייה נרשמה! ${batchNum} | ${weight} ק"ג → ${roastedWeight} ק"ג קלוי`);
      await notifyTeamIfWaiting({ waitingCustomers: data.waitingCustomers, roastLabel: `${origin.name} (${roastedWeight} ק"ג)`, showToast });
    } catch (err) {
      console.error('Error recording roast:', err);
      showToast('❌ שגיאה ברישום קלייה', 'error');
    }
  };

  // ── RECORD — PROFILE ──────────────────────────────────────────────────────────

  const recordProfileRoast = async () => {
    if (!selectedProfileId || !greenWeight || !selectedOperator) {
      showToast('⚠️ נא למלא את כל השדות', 'warning'); return;
    }
    const profile = getProfileById(selectedProfileId);
    if (!profile) { showToast('⚠️ פרופיל לא נמצא', 'warning'); return; }

    const weight = parseFloat(greenWeight);
    if (weight <= 0 || weight > 20) { showToast('⚠️ משקל לא תקין (1-20 ק"ג)', 'warning'); return; }

    const ings = getProfileIngredients(selectedProfileId);
    if (ings.length === 0) { showToast('⚠️ לפרופיל זה אין רכיבים מוגדרים', 'warning'); return; }

    for (const ing of ings) {
      const origin    = getOriginById(ing.origin_id);
      const greenUsed = weight * ing.percentage / 100;
      if (!origin) { showToast(`⚠️ זן לא נמצא (ID ${ing.origin_id})`, 'warning'); return; }
      if (origin.stock < greenUsed) {
        showToast(`⚠️ אין מספיק מלאי ירוק ל${origin.name}! נדרש: ${greenUsed.toFixed(2)} ק"ג, קיים: ${origin.stock} ק"ג`, 'warning'); return;
      }
    }

    const roastedWeight = calcProfileRoastedWeight(selectedProfileId, weight);
    const batchNum = makeBatchNum();

    try {
      const { data: roastRow, error: roastErr } = await supabase
        .from('roasts')
        .insert({
          roast_profile_id: profile.id, origin_id: null,
          green_weight: weight, roasted_weight: roastedWeight,
          operator: selectedOperator, date: new Date().toISOString(),
          batch_number: batchNum, user_id: data.origins[0]?.user_id,
          color_reading: colorReading ? parseFloat(colorReading) : null,
        })
        .select().single();
      if (roastErr) throw roastErr;

      for (const ing of ings) {
        const origin    = getOriginById(ing.origin_id);
        const greenUsed = parseFloat((weight * ing.percentage / 100).toFixed(4));
        await supabase.from('roast_components').insert({ roast_id: roastRow.id, origin_id: ing.origin_id, green_weight_used: greenUsed });
        await originsDb.update(origin.id, { stock: parseFloat((origin.stock - greenUsed).toFixed(4)) });
      }

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
      await notifyTeamIfWaiting({ waitingCustomers: data.waitingCustomers, roastLabel: `${profile.name} (${roastedWeight} ק"ג)`, showToast });
    } catch (err) {
      console.error('Error recording profile roast:', err);
      showToast('❌ שגיאה ברישום קלייה', 'error');
    }
  };

  const recordRoast = () => formMode === 'origin' ? recordOriginRoast() : recordProfileRoast();

  // ── EDIT ──────────────────────────────────────────────────────────────────────

  const startEditRoast = (roast) => {
    setEditingRoast({
      id:               roast.id,
      profileId:        roast.roast_profile_id,
      originId:         roast.origin_id,
      greenWeight:      roast.green_weight,
      operator:         roast.operator,
      oldGreenWeight:   roast.green_weight,
      oldRoastedWeight: roast.roasted_weight,
      isProfile:        !!roast.roast_profile_id
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
        const profile  = getProfileById(editingRoast.profileId);
        const ings     = getProfileIngredients(editingRoast.profileId);
        const oldComps = data.roastComponents.filter(c => c.roast_id === editingRoast.id);

        // Phase A: reverse
        for (const comp of oldComps) {
          const origin = getOriginById(comp.origin_id);
          if (origin) await originsDb.update(origin.id, { stock: parseFloat((origin.stock + comp.green_weight_used).toFixed(4)) });
        }
        await roastProfilesDb.update(profile.id, {
          roasted_stock: parseFloat(((profile.roasted_stock || 0) - editingRoast.oldRoastedWeight).toFixed(4)),
          updated_at: new Date().toISOString()
        });
        await supabase.from('roast_components').delete().eq('roast_id', editingRoast.id);

        // Validate
        for (const ing of ings) {
          const origin    = getOriginById(ing.origin_id);
          const greenUsed = newWeight * ing.percentage / 100;
          if (!origin || origin.stock < greenUsed) {
            showToast(`⚠️ אין מספיק מלאי ירוק ל${origin?.name || '?'}`, 'warning');
            // Rollback
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

        // Phase B: apply
        const newRoastedWeight = calcProfileRoastedWeight(editingRoast.profileId, newWeight);
        await roastsDb.update(editingRoast.id, { green_weight: newWeight, roasted_weight: newRoastedWeight, operator: editingRoast.operator, updated_at: new Date().toISOString() });
        for (const ing of ings) {
          const origin    = getOriginById(ing.origin_id);
          const greenUsed = parseFloat((newWeight * ing.percentage / 100).toFixed(4));
          await supabase.from('roast_components').insert({ roast_id: editingRoast.id, origin_id: ing.origin_id, green_weight_used: greenUsed });
          await originsDb.update(origin.id, { stock: parseFloat((origin.stock - greenUsed).toFixed(4)) });
        }
        await roastProfilesDb.update(profile.id, {
          roasted_stock: parseFloat(((profile.roasted_stock || 0) + newRoastedWeight).toFixed(4)),
          updated_at: new Date().toISOString()
        });

      } else {
        // Legacy simple origin edit
        const origin = getOriginById(editingRoast.originId);
        if (!origin) { showToast('⚠️ זן לא נמצא', 'warning'); return; }
        const newRoastedWeight = parseFloat(calculateRoastedWeight(newWeight, origin.weight_loss));
        const oldWeight        = parseFloat(editingRoast.oldGreenWeight);
        const oldRoastedWeight = parseFloat(editingRoast.oldRoastedWeight);

        await roastsDb.update(editingRoast.id, { green_weight: newWeight, roasted_weight: newRoastedWeight, operator: editingRoast.operator, updated_at: new Date().toISOString() });
        await originsDb.update(origin.id, {
          stock: origin.stock - (newWeight - oldWeight),
          roasted_stock: (origin.roasted_stock || 0) + (newRoastedWeight - oldRoastedWeight)
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
        if (profile) await roastProfilesDb.update(profile.id, { roasted_stock: parseFloat(((profile.roasted_stock || 0) - roast.roasted_weight).toFixed(4)), updated_at: new Date().toISOString() });
      } else {
        const origin = getOriginById(roast.origin_id);
        if (origin) await originsDb.update(origin.id, { stock: origin.stock + roast.green_weight, roasted_stock: (origin.roasted_stock || 0) - roast.roasted_weight });
      }

      await roastsDb.remove(roast.id);
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
          if (profile) await roastProfilesDb.update(profile.id, { roasted_stock: parseFloat(((profile.roasted_stock || 0) - roast.roasted_weight).toFixed(4)), updated_at: new Date().toISOString() });
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

  // Preview for profile mode
  const selectedProfile  = getProfileById(selectedProfileId);
  const preview          = selectedProfile && greenWeight ? previewIngredients(selectedProfileId, parseFloat(greenWeight)) : [];
  const previewRoastedKg = selectedProfile && greenWeight ? calcProfileRoastedWeight(selectedProfileId, parseFloat(greenWeight)) : null;

  // Preview for origin mode
  const selectedOriginObj = getOriginById(parseInt(selectedOrigin));

  // ── LIST VIEW ─────────────────────────────────────────────────────────────────

  if (view === 'list') {
    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>📋 רשימת קלייה</h1>
          <button onClick={() => setView('log')} className="btn-small">← חזור לרישום</button>
        </div>
        <RoastingList
          data={data} originsDb={originsDb} roastsDb={roastsDb} showToast={showToast}
          roastProfilesDb={roastProfilesDb}
          roastProfileIngredientsDb={roastProfileIngredientsDb}
          roastComponentsDb={roastComponentsDb}
        />
      </div>
    );
  }

  // ── MAIN VIEW ─────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>🔥 רישום קלייה</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          {data.roastChecklistTemplates?.length > 0 && (
            <button onClick={startChecklist} className="btn-small" style={{ background: '#3D4A2E', color: 'white' }}>
              ✅ צ'קליסט קלייה
            </button>
          )}
          <button onClick={() => setView('list')} className="btn-small" style={{ background: '#6F4E37', color: 'white' }}>
            📋 רשימת קלייה
          </button>
        </div>
      </div>

      {/* Edit form */}
      {editingRoast && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
          <h3>✏️ עריכת קלייה</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>{editingRoast.isProfile ? 'פרופיל' : 'זן'}</label>
              <input
                type="text" disabled
                value={editingRoast.isProfile ? (getProfileById(editingRoast.profileId)?.name || '') : (getOriginById(editingRoast.originId)?.name || '')}
                style={{ background: '#F3F4F6', color: '#6B7280' }}
              />
            </div>
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
              משקל קלוי משוער: <strong>{calcProfileRoastedWeight(editingRoast.profileId, parseFloat(editingRoast.greenWeight))} ק"ג</strong>
            </div>
          )}
          {!editingRoast.isProfile && editingRoast.greenWeight && editingRoast.originId && (
            <div className="calculation-display">
              משקל קלוי משוער: <strong>{calculateRoastedWeight(parseFloat(editingRoast.greenWeight), getOriginById(editingRoast.originId)?.weight_loss || 20)} ק"ג</strong>
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
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '1.25rem' }}>
          <button
            onClick={() => setFormMode('origin')}
            style={{
              padding: '0.4rem 1rem', borderRadius: '6px', border: '2px solid',
              borderColor: formMode === 'origin' ? '#6F4E37' : '#E5E7EB',
              background: formMode === 'origin' ? '#6F4E37' : 'white',
              color: formMode === 'origin' ? 'white' : '#374151',
              fontWeight: '600', cursor: 'pointer', fontSize: '0.9rem'
            }}
          >
            🌱 זן בודד
          </button>
          <button
            onClick={() => setFormMode('profile')}
            style={{
              padding: '0.4rem 1rem', borderRadius: '6px', border: '2px solid',
              borderColor: formMode === 'profile' ? '#6F4E37' : '#E5E7EB',
              background: formMode === 'profile' ? '#6F4E37' : 'white',
              color: formMode === 'profile' ? 'white' : '#374151',
              fontWeight: '600', cursor: 'pointer', fontSize: '0.9rem'
            }}
          >
            🔥 פרופיל קלייה
          </button>
        </div>

        {/* Single origin mode */}
        {formMode === 'origin' && (
          <>
            <div className="form-grid">
              <div className="form-group">
                <label>בחר זן לקלייה</label>
                <select value={selectedOrigin} onChange={e => setSelectedOrigin(e.target.value)}>
                  <option value="">בחר זן...</option>
                  {data.origins.filter(o => o.stock > 0).map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {o.stock} ק"ג)</option>)}
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
            {selectedOriginObj && greenWeight && (
              <div className="calculation-display">
                <div>איבוד משקל: <strong>{selectedOriginObj.weight_loss}%</strong></div>
                <div>משקל קלוי צפוי: <strong>{calculateRoastedWeight(greenWeight, selectedOriginObj.weight_loss || 20)} ק"ג</strong></div>
              </div>
            )}
          </>
        )}

        {/* Profile mode */}
        {formMode === 'profile' && (
          <>
            {data.roastProfiles.length === 0 ? (
              <div style={{ color: '#666', padding: '0.5rem 0 1rem', textAlign: 'center' }}>
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
                        🌱 {p.origin?.name || '?'} — {p.percentage}% → <strong>{p.greenUsed.toFixed(2)} ק"ג</strong>
                        {p.origin && p.origin.stock < p.greenUsed && (
                          <span style={{ color: '#DC2626', marginRight: '0.5rem' }}> ⚠️ מלאי לא מספיק ({p.origin.stock} ק"ג)</span>
                        )}
                      </div>
                    ))}
                    <div style={{ marginTop: '0.5rem', fontWeight: 'bold' }}>
                      🔥 צפי קלוי: <strong>{previewRoastedKg} ק"ג</strong>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        <div style={{ marginTop: '0.75rem' }}>
          <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 'bold', fontSize: '0.9rem' }}>🎨 קריאת צבע (Color Meter)</label>
          <input
            type="number"
            step="0.1"
            placeholder="למשל: 65.4"
            value={colorReading}
            onChange={e => setColorReading(e.target.value)}
            style={{ width: '100%', padding: '0.5rem', borderRadius: '8px', border: '1px solid #ddd', fontSize: '1rem' }}
          />
        </div>

        <button onClick={recordRoast} className="btn-primary" style={{ marginTop: '0.75rem' }}>🔥 רשום קלייה</button>
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
                        <h3>{isProfile ? (profile?.name || 'פרופיל לא ידוע') : (origin?.name || 'זן לא ידוע')}</h3>
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
                      {roast.color_reading != null && <div>🎨 צבע: <strong>{roast.color_reading}</strong></div>}
                      {roast.updated_at && <div style={{ fontSize: '0.85em', color: '#FF6B35' }}>✏️ עודכן: {new Date(roast.updated_at).toLocaleString('he-IL')}</div>}
                    </div>

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
