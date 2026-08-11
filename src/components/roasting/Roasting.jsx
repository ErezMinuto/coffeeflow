import React, { useState, useMemo, useRef } from 'react';
import { useApp } from '../../lib/context';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { blendedWeightLoss } from '../../lib/utils';
import { notifyTeamIfWaiting } from '../../lib/telegram';
import RoastingList from './RoastingList';

const ROAST_LEVEL_LABELS = { none: '', light: 'לייט', medium: 'מדיום' };

// ── Inline SVG icons (Lucide-style) ───────────────────────────────────────────
const Icon = ({ d, size = 16, sw = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const RI = {
  fire:  <><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5Z" /></>,
  leaf:  <><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" /><path d="M2 21c0-3 1.85-5.36 5.08-6" /></>,
  list:  <><line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" /><line x1="8" x2="21" y1="18" y2="18" /><line x1="3" x2="3.01" y1="6" y2="6" /><line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" /></>,
  check: <><path d="M11 12H3" /><path d="m15 6-3 6 3 6" /><rect width="8" height="18" x="13" y="3" rx="1" /></>,
  search:<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  edit:  <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /></>,
  arrow: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  alert: <><path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  chart: <><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></>,
  x:     <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
};

export default function Roasting() {
  const {
    data, originsDb, roastsDb, roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb,
    getOriginById, calculateRoastedWeight, showToast
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
  const [isSaving,      setIsSaving]      = useState(false);
  const savingRef = useRef(false); // synchronous in-flight lock — blocks double-submit before React re-renders

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
    if (savingRef.current) return; // ignore repeat taps while an insert is in flight
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

    savingRef.current = true; setIsSaving(true);
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
    } finally {
      savingRef.current = false; setIsSaving(false);
    }
  };

  // ── RECORD — PROFILE ──────────────────────────────────────────────────────────

  const recordProfileRoast = async () => {
    if (savingRef.current) return; // ignore repeat taps while an insert is in flight
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

    savingRef.current = true; setIsSaving(true);
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
    } finally {
      savingRef.current = false; setIsSaving(false);
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
    if (savingRef.current) return; // ignore repeat taps while an update is in flight
    if (!editingRoast.greenWeight || !editingRoast.operator) {
      showToast('⚠️ נא למלא את כל השדות', 'warning'); return;
    }
    const newWeight = parseFloat(editingRoast.greenWeight);
    if (newWeight <= 0 || newWeight > 20) { showToast('⚠️ משקל לא תקין', 'warning'); return; }

    savingRef.current = true; setIsSaving(true);
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
    } finally {
      savingRef.current = false; setIsSaving(false);
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
        if (profile) await roastProfilesDb.update(profile.id, { roasted_stock: parseFloat((Math.max(0, (profile.roasted_stock || 0) - roast.roasted_weight)).toFixed(4)), updated_at: new Date().toISOString() });
      } else {
        const origin = getOriginById(roast.origin_id);
        if (origin) await originsDb.update(origin.id, { stock: origin.stock + roast.green_weight, roasted_stock: Math.max(0, (origin.roasted_stock || 0) - roast.roasted_weight) });
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
          if (profile) await roastProfilesDb.update(profile.id, { roasted_stock: parseFloat((Math.max(0, (profile.roasted_stock || 0) - roast.roasted_weight)).toFixed(4)), updated_at: new Date().toISOString() });
        } else {
          const origin = getOriginById(roast.origin_id);
          if (origin) await originsDb.update(origin.id, { stock: origin.stock + roast.green_weight, roasted_stock: Math.max(0, (origin.roasted_stock || 0) - roast.roasted_weight) });
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

  // ── KPI SUMMARY ─────────────────────────────────────────────────────────────
  const roastStats = useMemo(() => {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(startToday.getTime() - 6 * 24 * 60 * 60 * 1000);
    let todayCount = 0, greenToday = 0, roastedToday = 0, roastedWeek = 0;
    for (const r of data.roasts) {
      const d = new Date(r.date);
      if (d >= startToday) { todayCount++; greenToday += r.green_weight || 0; roastedToday += r.roasted_weight || 0; }
      if (d >= weekAgo) { roastedWeek += r.roasted_weight || 0; }
    }
    return { todayCount, greenToday, roastedToday, roastedWeek };
  }, [data.roasts]);

  // ── WHAT NEEDS ROASTING (mirrors RoastingList: roasted_stock + packed bags vs daily×10) ──
  const needsRoasting = useMemo(() => {
    const packedByOrigin = {}, packedByProfile = {};
    for (const product of (data.products || [])) {
      const bags = product.packed_stock || 0;
      const sizeKg = (product.size || 0) / 1000;
      const recipe = Array.isArray(product.recipe) ? product.recipe : [];
      if (bags <= 0 || sizeKg <= 0 || recipe.length === 0) continue;
      for (const ing of recipe) {
        const kg = bags * sizeKg * ((ing.percentage || 0) / 100);
        const id = ing.sourceId ?? ing.originId;
        if (!id) continue;
        if (ing.sourceType === 'profile') packedByProfile[id] = (packedByProfile[id] || 0) + kg;
        else packedByOrigin[id] = (packedByOrigin[id] || 0) + kg;
      }
    }
    const originsNeeded = data.origins.map(o => {
      const critical = (o.daily_average || 0) * 10;
      const available = (o.roasted_stock || 0) + (packedByOrigin[o.id] || 0);
      return { kind: 'origin', id: o.id, name: o.name, level: null, needed: critical - available, roasted: o.roasted_stock || 0, critical };
    }).filter(x => x.needed > 0);
    const profilesNeeded = (data.roastProfiles || []).map(p => {
      const critical = Math.max((p.daily_average || 0) * 10, p.min_stock || 0);
      const available = (p.roasted_stock || 0) + (packedByProfile[p.id] || 0);
      return { kind: 'profile', id: p.id, name: p.name, level: p.roast_level, needed: critical - available, roasted: p.roasted_stock || 0, critical };
    }).filter(x => x.needed > 0);
    return [...originsNeeded, ...profilesNeeded].sort((a, b) => b.needed - a.needed);
  }, [data.origins, data.roastProfiles, data.products]);

  const roastNow = (item) => {
    if (item.kind === 'profile') { setFormMode('profile'); setSelectedProfileId(String(item.id)); }
    else { setFormMode('origin'); setSelectedOrigin(String(item.id)); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const num = (n, digits = 1) => (parseFloat(n) || 0).toFixed(digits);

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

  const levelPill = (lvl) => (lvl && lvl !== 'none')
    ? <span className={`rlvl ${lvl}`}>{ROAST_LEVEL_LABELS[lvl]}</span> : null;
  const DATE_CHIPS = [['all', 'הכל'], ['today', 'היום'], ['week', 'שבוע'], ['month', 'חודש']];

  return (
    <div className="page roasting-page">
      {/* Header */}
      <div className="roasting-head">
        <div>
          <h1><span className="rh-fire"><Icon d={RI.fire} size={26} /></span>רישום קלייה</h1>
          <p>רישום קליות, מעקב מלאי קלוי ותכנון מה צריך לקלות — במקום אחד.</p>
        </div>
        <div className="roasting-head-actions">
          {data.roastChecklistTemplates?.length > 0 && (
            <button onClick={startChecklist} className="rbtn forest"><Icon d={RI.check} /> צ'קליסט קלייה</button>
          )}
          <button onClick={() => setView('list')} className="rbtn ghost"><Icon d={RI.list} /> רשימת קלייה</button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="roasting-kpis">
        <div className="rkpi"><div className="lbl"><Icon d={RI.fire} size={14} /> קליות היום</div><div className="val">{roastStats.todayCount}</div><i className="spark" /></div>
        <div className="rkpi"><div className="lbl">ק"ג ירוק היום</div><div className="val">{num(roastStats.greenToday, 0)} <small>ק"ג</small></div><i className="spark" /></div>
        <div className="rkpi"><div className="lbl">ק"ג קלוי היום</div><div className="val">{num(roastStats.roastedToday, 0)} <small>ק"ג</small></div><i className="spark" /></div>
        <div className="rkpi"><div className="lbl">קלוי השבוע</div><div className="val">{num(roastStats.roastedWeek, 0)} <small>ק"ג</small></div><i className="spark" /></div>
      </div>

      {/* Two columns: record form | needs roasting */}
      <div className="roasting-cols">
        {/* Record roast */}
        <div className="rcard">
          <div className="rcard-h"><h2><Icon d={RI.fire} size={18} /> קלייה חדשה</h2></div>
          <div className="rcard-b">
            <div className="rseg">
              <button className={formMode === 'origin' ? 'active' : ''} onClick={() => setFormMode('origin')}><Icon d={RI.leaf} /> זן בודד</button>
              <button className={formMode === 'profile' ? 'active' : ''} onClick={() => setFormMode('profile')}><Icon d={RI.fire} /> פרופיל בלנד</button>
            </div>

            {formMode === 'origin' && (
              <>
                <div className="rfield">
                  <label>בחר זן לקלייה</label>
                  <select value={selectedOrigin} onChange={e => setSelectedOrigin(e.target.value)}>
                    <option value="">בחר זן...</option>
                    {data.origins.filter(o => o.stock > 0).map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {num(o.stock)} ק"ג)</option>)}
                  </select>
                </div>
                <div className="rrow2">
                  <div className="rfield">
                    <label>משקל ירוק (ק"ג)</label>
                    <div className="rstepper">
                      <button type="button" onClick={() => setGreenWeight(String(Math.max(0, (parseFloat(greenWeight) || 0) - 1)))}>−</button>
                      <input type="number" step="0.5" placeholder="15" value={greenWeight} onChange={e => setGreenWeight(e.target.value)} />
                      <button type="button" onClick={() => setGreenWeight(String((parseFloat(greenWeight) || 0) + 1))}>+</button>
                    </div>
                  </div>
                  <div className="rfield">
                    <label>מפעיל</label>
                    <select value={selectedOperator} onChange={e => setSelectedOperator(e.target.value)}>
                      <option value="">בחר מפעיל...</option>
                      {data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}
                    </select>
                  </div>
                </div>
                {selectedOriginObj && greenWeight && (
                  <div className="rpreview">
                    <div className="pv-top">
                      <div className="pv-name"><Icon d={RI.leaf} size={15} /> {selectedOriginObj.name}</div>
                      <div className="pv-arrow"><span className="g">{num(greenWeight)} ק"ג</span><Icon d={RI.arrow} size={16} /><span className="r">{calculateRoastedWeight(greenWeight, selectedOriginObj.weight_loss || 20)} ק"ג</span></div>
                    </div>
                    <div className="pv-loss">איבוד משקל {selectedOriginObj.weight_loss}% · מלאי ירוק זמין {num(selectedOriginObj.stock)} ק"ג</div>
                  </div>
                )}
              </>
            )}

            {formMode === 'profile' && (
              <>
                {data.roastProfiles.length === 0 ? (
                  <div className="rempty">
                    ⚠️ עדיין אין פרופילי קלייה.{' '}
                    <a href="/settings">הגדר פרופילים בהגדרות ←</a>
                  </div>
                ) : (
                  <>
                    <div className="rfield">
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
                    <div className="rrow2">
                      <div className="rfield">
                        <label>משקל ירוק (ק"ג)</label>
                        <div className="rstepper">
                          <button type="button" onClick={() => setGreenWeight(String(Math.max(0, (parseFloat(greenWeight) || 0) - 1)))}>−</button>
                          <input type="number" step="0.5" placeholder="15" value={greenWeight} onChange={e => setGreenWeight(e.target.value)} />
                          <button type="button" onClick={() => setGreenWeight(String((parseFloat(greenWeight) || 0) + 1))}>+</button>
                        </div>
                      </div>
                      <div className="rfield">
                        <label>מפעיל</label>
                        <select value={selectedOperator} onChange={e => setSelectedOperator(e.target.value)}>
                          <option value="">בחר מפעיל...</option>
                          {data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}
                        </select>
                      </div>
                    </div>
                    {selectedProfile && greenWeight && preview.length > 0 && (
                      <div className="rpreview">
                        <div className="pv-top">
                          <div className="pv-name"><Icon d={RI.fire} size={15} /> {selectedProfile.name} {levelPill(selectedProfile.roast_level)}</div>
                          <div className="pv-arrow"><span className="g">{num(greenWeight)} ק"ג</span><Icon d={RI.arrow} size={16} /><span className="r">{previewRoastedKg} ק"ג</span></div>
                        </div>
                        <div className="pv-comps">
                          {preview.map((p, i) => (
                            <div key={i} className="pv-comp">
                              <span><Icon d={RI.leaf} size={13} /> {p.origin?.name || '?'} · {p.percentage}%</span>
                              <span>{p.greenUsed.toFixed(2)} ק"ג
                                {p.origin && p.origin.stock < p.greenUsed && <span className="pv-warn"> ⚠ חסר ({num(p.origin.stock)} ק"ג)</span>}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            <div className="rfield" style={{ marginTop: '4px' }}>
              <label>קריאת צבע (Color Meter) — אופציונלי</label>
              <input type="number" step="0.1" placeholder="למשל: 65.4" value={colorReading} onChange={e => setColorReading(e.target.value)} />
            </div>

            <button onClick={recordRoast} disabled={isSaving} className="rbtn roast rbtn-block"><Icon d={RI.fire} /> {isSaving ? 'רושם…' : 'רשום קלייה'}</button>
          </div>
        </div>

        {/* Needs roasting */}
        <div className="rcard">
          <div className="rcard-h"><h2><Icon d={RI.alert} size={18} /> מה צריך לקלות</h2><span className="rcount">{needsRoasting.length}</span></div>
          <div className="rcard-b">
            {needsRoasting.length === 0 ? (
              <div className="needs-empty">הכול מעל המלאי הקריטי 🎉</div>
            ) : (
              <div className="needs">
                {needsRoasting.map(n => (
                  <div key={`${n.kind}-${n.id}`} className={`need ${n.needed >= n.critical * 0.5 ? 'urgent' : ''}`}>
                    <div className="n-top">
                      <div className="n-name"><Icon d={n.kind === 'profile' ? RI.fire : RI.leaf} size={15} /> {n.name} {levelPill(n.level)}</div>
                      <span className="missing">חסר {num(n.needed)} ק"ג</span>
                    </div>
                    <div className="n-sub"><span>מלאי קלוי <b>{num(n.roasted)}</b></span><span>קריטי <b>{num(n.critical)}</b></span></div>
                    <button className="rbtn roast roast-now" onClick={() => roastNow(n)}><Icon d={RI.fire} size={14} /> רשום קלייה</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* History */}
      <div className="rcard">
        <div className="rcard-h rcard-h-wrap">
          <h2><Icon d={RI.chart} size={18} /> היסטוריית קליות <span className="rcount">{filteredRoasts.length}</span></h2>
          <div className="rtoolbar">
            <div className="rsearch"><Icon d={RI.search} size={16} /><input type="text" aria-label="חיפוש קלייה" placeholder="חיפוש…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} /></div>
            <div className="rchips">
              {DATE_CHIPS.map(([val, lbl]) => (
                <button key={val} className={`rchip ${dateFilter === val ? 'active' : ''}`} onClick={() => setDateFilter(val)}>{lbl}</button>
              ))}
              <button className={`rchip ${dateFilter === 'custom' ? 'active' : ''}`} onClick={() => setDateFilter('custom')}>מותאם</button>
            </div>
          </div>
        </div>

        {dateFilter === 'custom' && (
          <div className="rcustom">
            <input type="date" aria-label="מתאריך" value={startDate} onChange={e => setStartDate(e.target.value)} />
            <span>עד</span>
            <input type="date" aria-label="עד תאריך" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
        )}

        {selectedRoasts.length > 0 && (
          <div className="rbulk">
            <span>{selectedRoasts.length} נבחרו</span>
            <button className="rbtn ghost sm" onClick={() => setSelectedRoasts([])}>בטל בחירה</button>
            <button className="rbtn danger sm" onClick={deleteSelectedRoasts}><Icon d={RI.trash} size={14} /> מחק נבחרים</button>
          </div>
        )}

        {filteredRoasts.length === 0 ? (
          <div className="empty-state">אין קליות עדיין. רשום קלייה ראשונה!</div>
        ) : (
          <>
            <div className="rscroll">
              <table className="rtable">
                <thead>
                  <tr>
                    <th className="c" style={{ width: '36px' }}>
                      <input type="checkbox" className="rchk" aria-label="בחר הכל"
                        checked={selectedRoasts.length === displayedRoasts.length && displayedRoasts.length > 0}
                        onChange={toggleSelectAll} />
                    </th>
                    <th>פריט</th><th className="c">ירוק → קלוי</th><th className="c">מפעיל</th>
                    <th className="c">צבע</th><th className="c">תאריך</th><th className="c">פעולות</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedRoasts.map(roast => {
                    const isProfile  = !!roast.roast_profile_id;
                    const profile    = isProfile ? getProfileById(roast.roast_profile_id) : null;
                    const origin     = !isProfile ? getOriginById(roast.origin_id) : null;
                    const comps      = isProfile ? data.roastComponents.filter(c => c.roast_id === roast.id) : [];
                    const isSelected = selectedRoasts.includes(roast.id);
                    const name       = isProfile ? (profile?.name || 'פרופיל לא ידוע') : (origin?.name || 'זן לא ידוע');
                    return (
                      <tr key={roast.id} className={isSelected ? 'sel' : ''}>
                        <td className="c"><input type="checkbox" className="rchk" aria-label={`בחר ${name}`} checked={isSelected} onChange={() => toggleRoastSelection(roast.id)} /></td>
                        <td>
                          <div className="ritem">
                            <div className={`ri-ico ${isProfile ? 'blend' : 'single'}`}><Icon d={isProfile ? RI.fire : RI.leaf} size={15} /></div>
                            <div>
                              <div className="ri-nm">{name} {isProfile && levelPill(profile?.roast_level)}</div>
                              <div className="ri-sub">
                                {roast.batch_number || '—'}
                                {isProfile && comps.length > 0 && <span className="ri-comps"> · {comps.map(c => getOriginById(c.origin_id)?.name || '?').join(' + ')}</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="c rwt"><span className="g">{roast.green_weight}</span><Icon d={RI.arrow} size={14} /><span className="r">{roast.roasted_weight} ק"ג</span></td>
                        <td className="c">{roast.operator}</td>
                        <td className="c rnum">{roast.color_reading != null ? roast.color_reading : '—'}</td>
                        <td className="c rnum rdate">{new Date(roast.date).toLocaleDateString('he-IL')}</td>
                        <td className="c">
                          <div className="racts">
                            <button className="rico" title="עריכה" aria-label={`עריכת ${name}`} onClick={() => startEditRoast(roast)}><Icon d={RI.edit} /></button>
                            <button className="rico danger" title="מחיקה" aria-label={`מחיקת ${name}`} onClick={() => deleteRoast(roast)}><Icon d={RI.trash} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div className="rmore">
                <button onClick={() => setDisplayLimit(displayLimit + 20)} className="rbtn ghost">טען עוד 20 קליות</button>
                <div className="rmore-sub">מציג {displayedRoasts.length} מתוך {filteredRoasts.length}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Edit drawer */}
      {editingRoast && (
        <>
          <div className="rdrawer-overlay" onClick={() => setEditingRoast(null)} />
          <aside className="rdrawer" role="dialog" aria-modal="true">
            <div className="rdh">
              <div className="rdh-ico"><Icon d={RI.edit} size={20} /></div>
              <div><h2>עריכת קלייה</h2><p>{editingRoast.isProfile ? (getProfileById(editingRoast.profileId)?.name || '') : (getOriginById(editingRoast.originId)?.name || '')}</p></div>
              <button className="rico rdx" onClick={() => setEditingRoast(null)} aria-label="סגור"><Icon d={RI.x} /></button>
            </div>
            <div className="rdb">
              <div className="rfield">
                <label>{editingRoast.isProfile ? 'פרופיל' : 'זן'}</label>
                <input type="text" disabled value={editingRoast.isProfile ? (getProfileById(editingRoast.profileId)?.name || '') : (getOriginById(editingRoast.originId)?.name || '')} />
              </div>
              <div className="rfield">
                <label>משקל ירוק (ק"ג)</label>
                <input type="number" step="0.1" value={editingRoast.greenWeight} onChange={e => setEditingRoast({ ...editingRoast, greenWeight: e.target.value })} />
              </div>
              <div className="rfield">
                <label>מפעיל</label>
                <select value={editingRoast.operator} onChange={e => setEditingRoast({ ...editingRoast, operator: e.target.value })}>
                  <option value="">בחר מפעיל...</option>
                  {data.operators.map(op => <option key={op.id} value={op.name}>{op.name}</option>)}
                </select>
              </div>
              {editingRoast.isProfile && editingRoast.greenWeight && (
                <div className="rpreview compact">משקל קלוי משוער: <b>{calcProfileRoastedWeight(editingRoast.profileId, parseFloat(editingRoast.greenWeight))} ק"ג</b></div>
              )}
              {!editingRoast.isProfile && editingRoast.greenWeight && editingRoast.originId && (
                <div className="rpreview compact">משקל קלוי משוער: <b>{calculateRoastedWeight(parseFloat(editingRoast.greenWeight), getOriginById(editingRoast.originId)?.weight_loss || 20)} ק"ג</b></div>
              )}
            </div>
            <div className="rdf">
              <button className="rbtn ghost" onClick={() => setEditingRoast(null)}>ביטול</button>
              <button className="rbtn roast" onClick={saveEditRoast} disabled={isSaving}>{isSaving ? 'שומר…' : 'שמור שינויים'}</button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
