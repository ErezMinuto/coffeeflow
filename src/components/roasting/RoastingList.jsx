import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { blendedWeightLoss } from '../../lib/utils';

const DEFAULT_ROAST_KG = 15;
const ROAST_LEVEL_LABELS = { none: '', light: 'לייט', medium: 'מדיום' };
const ROAST_LEVEL_COLORS = { none: '#6B7280', light: '#F59E0B', medium: '#6F4E37' };

export default function RoastingList({
  data, originsDb, roastsDb, showToast,
  roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb
}) {
  const [checkedOrigins,  setCheckedOrigins]  = useState({});
  const [checkedProfiles, setCheckedProfiles] = useState({});
  const [amounts,         setAmounts]         = useState({}); // key: "o_id" or "p_id"
  const [saving,          setSaving]          = useState(false);

  const userId = data.origins[0]?.user_id;

  // ── WHAT NEEDS ROASTING ───────────────────────────────────────────────────────

  const originsNeeded = data.origins
    .map(origin => {
      const daily    = origin.daily_average || 0;
      const critical = daily * 7;
      const current  = origin.roasted_stock || 0;
      const needed   = critical - current;
      return { ...origin, critical_stock: critical, needed };
    })
    .filter(o => o.needed > 0)
    .sort((a, b) => b.needed - a.needed);

  const profilesNeeded = (data.roastProfiles || [])
    .map(profile => {
      const daily    = profile.daily_average || 0;
      const critical = Math.max(daily * 7, profile.min_stock || 0);
      const current  = profile.roasted_stock || 0;
      const needed   = critical - current;
      return { ...profile, critical_stock: critical, needed };
    })
    .filter(p => p.needed > 0)
    .sort((a, b) => b.needed - a.needed);

  const totalNeeded    = originsNeeded.length + profilesNeeded.length;
  const anyChecked     = Object.values(checkedOrigins).some(Boolean) || Object.values(checkedProfiles).some(Boolean);
  const checkedCount   = Object.values(checkedOrigins).filter(Boolean).length + Object.values(checkedProfiles).filter(Boolean).length;

  // ── CONFIRM ───────────────────────────────────────────────────────────────────

  const confirmRoasting = async () => {
    setSaving(true);
    const syncTime = new Date().toISOString();
    let success = 0;

    // ── Origin roasts (simple) ─────────────────────────────────────────────────
    const toRoastOrigins = originsNeeded.filter(o => checkedOrigins[o.id]);
    for (const origin of toRoastOrigins) {
      const greenKg     = parseFloat(amounts[`o_${origin.id}`] || DEFAULT_ROAST_KG);
      const yieldPct    = 1 - (origin.weight_loss / 100);
      const roastedKg   = parseFloat((greenKg * yieldPct).toFixed(2));
      const newGreen    = (origin.stock || 0) - greenKg;

      if (newGreen < 0) { showToast(`אין מספיק מלאי ירוק ל${origin.name}`, 'error'); continue; }

      try {
        await originsDb.update(origin.id, {
          roasted_stock: (origin.roasted_stock || 0) + roastedKg,
          stock: newGreen
        });
        await supabase.from('roasts').insert({
          origin_id: origin.id, roast_profile_id: null,
          green_weight: greenKg, roasted_weight: roastedKg,
          operator: 'מנהל קלייה', date: syncTime, user_id: userId
        });
        success++;
      } catch (err) {
        showToast(`שגיאה ב${origin.name}: ${err.message}`, 'error');
      }
    }

    // ── Profile roasts (blend / multi-level) ──────────────────────────────────
    const toRoastProfiles = profilesNeeded.filter(p => checkedProfiles[p.id]);
    for (const profile of toRoastProfiles) {
      const greenKg  = parseFloat(amounts[`p_${profile.id}`] || DEFAULT_ROAST_KG);
      const ings     = (data.roastProfileIngredients || []).filter(i => i.profile_id === profile.id);

      if (ings.length === 0) { showToast(`⚠️ לפרופיל "${profile.name}" אין רכיבים מוגדרים`, 'warning'); continue; }

      // Validate stock per ingredient
      let stockOk = true;
      for (const ing of ings) {
        const origin    = data.origins.find(o => o.id === ing.origin_id);
        const greenUsed = greenKg * ing.percentage / 100;
        if (!origin || origin.stock < greenUsed) {
          showToast(`⚠️ אין מספיק מלאי ירוק ל${origin?.name || '?'} (${profile.name})`, 'error');
          stockOk = false; break;
        }
      }
      if (!stockOk) continue;

      const weightLoss  = blendedWeightLoss(ings, data.origins);
      const roastedKg   = parseFloat((greenKg * (1 - weightLoss / 100)).toFixed(2));

      try {
        const { data: roastRow, error: roastErr } = await supabase
          .from('roasts')
          .insert({
            roast_profile_id: profile.id, origin_id: null,
            green_weight: greenKg, roasted_weight: roastedKg,
            operator: 'מנהל קלייה', date: syncTime, user_id: userId
          })
          .select().single();
        if (roastErr) throw roastErr;

        for (const ing of ings) {
          const origin    = data.origins.find(o => o.id === ing.origin_id);
          const greenUsed = parseFloat((greenKg * ing.percentage / 100).toFixed(4));
          await supabase.from('roast_components').insert({ roast_id: roastRow.id, origin_id: ing.origin_id, green_weight_used: greenUsed });
          await originsDb.update(origin.id, { stock: parseFloat((origin.stock - greenUsed).toFixed(4)) });
        }

        await roastProfilesDb.update(profile.id, {
          roasted_stock: parseFloat(((profile.roasted_stock || 0) + roastedKg).toFixed(4)),
          updated_at: new Date().toISOString()
        });

        success++;
      } catch (err) {
        showToast(`שגיאה ב${profile.name}: ${err.message}`, 'error');
      }
    }

    await originsDb.refresh();
    await roastsDb.refresh();
    if (roastProfilesDb)          await roastProfilesDb.refresh();
    if (roastProfileIngredientsDb) await roastProfileIngredientsDb.refresh();
    if (roastComponentsDb)        await roastComponentsDb.refresh();

    setSaving(false);
    setCheckedOrigins({}); setCheckedProfiles({}); setAmounts({});
    if (success > 0) showToast(`✅ ${success} קליות נרשמו בהצלחה!`);
  };

  // ── ROW RENDERERS ─────────────────────────────────────────────────────────────

  const OriginRow = ({ origin }) => {
    const isChecked = !!checkedOrigins[origin.id];
    const key       = `o_${origin.id}`;
    const greenKg   = parseFloat(amounts[key] || DEFAULT_ROAST_KG);
    const yieldPct  = 1 - (origin.weight_loss / 100);
    const roastedKg = (greenKg * yieldPct).toFixed(1);

    const toggle = () => {
      setCheckedOrigins(prev => ({ ...prev, [origin.id]: !prev[origin.id] }));
      if (!amounts[key]) setAmounts(prev => ({ ...prev, [key]: DEFAULT_ROAST_KG }));
    };

    return (
      <div
        style={{ background: isChecked ? '#F0FDF4' : 'white', border: isChecked ? '2px solid #10B981' : '1px solid #E5E7EB', borderRadius: '12px', padding: '1.25rem', cursor: 'pointer', transition: 'all 0.2s' }}
        onClick={toggle}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <input type="checkbox" checked={isChecked} onChange={toggle} onClick={e => e.stopPropagation()} style={{ width: '20px', height: '20px', cursor: 'pointer' }} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '1.1rem' }}>{origin.name}</strong>
              <span style={{ background: '#FEE2E2', color: '#DC2626', padding: '0.2rem 0.6rem', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 'bold' }}>
                חסר {origin.needed.toFixed(1)} ק"ג
              </span>
            </div>
            <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.875rem', color: '#666', flexWrap: 'wrap' }}>
              <span>מלאי קלוי: <strong>{(origin.roasted_stock || 0).toFixed(1)} ק"ג</strong></span>
              <span>מלאי קריטי: <strong>{origin.critical_stock.toFixed(1)} ק"ג</strong></span>
              <span>מלאי ירוק: <strong>{(origin.stock || 0).toFixed(1)} ק"ג</strong></span>
            </div>
          </div>
        </div>
        {isChecked && (
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #D1FAE5' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>משקל ירוק לקלייה (ק"ג)</label>
                <input type="number" step="0.5" value={amounts[key] || DEFAULT_ROAST_KG} onChange={e => setAmounts(prev => ({ ...prev, [key]: e.target.value }))} style={{ width: '120px' }} />
              </div>
              <div style={{ fontSize: '0.875rem', color: '#059669', paddingBottom: '0.5rem' }}>
                → {roastedKg} ק"ג קלוי ({origin.weight_loss}% איבוד)
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const ProfileRow = ({ profile }) => {
    const isChecked = !!checkedProfiles[profile.id];
    const key       = `p_${profile.id}`;
    const greenKg   = parseFloat(amounts[key] || DEFAULT_ROAST_KG);
    const ings      = (data.roastProfileIngredients || []).filter(i => i.profile_id === profile.id);
    const weightLoss = blendedWeightLoss(ings, data.origins);
    const roastedKg = (greenKg * (1 - weightLoss / 100)).toFixed(1);

    const toggle = () => {
      setCheckedProfiles(prev => ({ ...prev, [profile.id]: !prev[profile.id] }));
      if (!amounts[key]) setAmounts(prev => ({ ...prev, [key]: DEFAULT_ROAST_KG }));
    };

    return (
      <div
        style={{ background: isChecked ? '#FFF7ED' : 'white', border: isChecked ? '2px solid #F59E0B' : '1px solid #E5E7EB', borderRadius: '12px', padding: '1.25rem', cursor: 'pointer', transition: 'all 0.2s' }}
        onClick={toggle}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <input type="checkbox" checked={isChecked} onChange={toggle} onClick={e => e.stopPropagation()} style={{ width: '20px', height: '20px', cursor: 'pointer' }} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <strong style={{ fontSize: '1.1rem' }}>{profile.name}</strong>
                {profile.roast_level && profile.roast_level !== 'none' && (
                  <span style={{ background: ROAST_LEVEL_COLORS[profile.roast_level], color: 'white', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 'bold' }}>
                    {ROAST_LEVEL_LABELS[profile.roast_level]}
                  </span>
                )}
              </div>
              <span style={{ background: '#FEE2E2', color: '#DC2626', padding: '0.2rem 0.6rem', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 'bold' }}>
                חסר {profile.needed.toFixed(1)} ק"ג
              </span>
            </div>
            <div style={{ fontSize: '0.875rem', color: '#888', marginTop: '0.3rem' }}>
              {ings.map((ing, i) => {
                const origin = data.origins.find(o => o.id === ing.origin_id);
                return <span key={i}>{i > 0 ? ' · ' : ''}{ing.percentage}% {origin?.name || '?'}</span>;
              })}
            </div>
            <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.875rem', color: '#666', flexWrap: 'wrap' }}>
              <span>מלאי קלוי: <strong>{(profile.roasted_stock || 0).toFixed(1)} ק"ג</strong></span>
              <span>מלאי קריטי: <strong>{profile.critical_stock.toFixed(1)} ק"ג</strong></span>
            </div>
          </div>
        </div>
        {isChecked && (
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #FDE68A' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>משקל ירוק לקלייה (ק"ג)</label>
                <input type="number" step="0.5" value={amounts[key] || DEFAULT_ROAST_KG} onChange={e => setAmounts(prev => ({ ...prev, [key]: e.target.value }))} style={{ width: '120px' }} />
              </div>
              <div style={{ fontSize: '0.875rem', color: '#059669', paddingBottom: '0.5rem' }}>
                → {roastedKg} ק"ג קלוי
              </div>
              {ings.length > 1 && (
                <div style={{ fontSize: '0.8rem', color: '#888', paddingBottom: '0.5rem' }}>
                  {ings.map((ing, i) => {
                    const origin    = data.origins.find(o => o.id === ing.origin_id);
                    const greenUsed = (parseFloat(amounts[key] || DEFAULT_ROAST_KG) * ing.percentage / 100).toFixed(2);
                    return <span key={i} style={{ marginLeft: '0.75rem' }}>• {origin?.name}: {greenUsed} ק"ג</span>;
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── RENDER ────────────────────────────────────────────────────────────────────

  return (
    <div>
      {anyChecked && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
          <button onClick={confirmRoasting} disabled={saving} className="btn-primary" style={{ background: '#6F4E37' }}>
            {saving ? '⏳ שומר...' : `✅ אשר קלייה (${checkedCount})`}
          </button>
        </div>
      )}

      {totalNeeded === 0 ? (
        <div className="empty-state">
          <h3>✅ אין צורך בקלייה כרגע</h3>
          <p>כל הזנים והפרופילים מעל המלאי הקריטי</p>
          <p style={{ fontSize: '0.85rem', color: '#999', marginTop: '0.5rem' }}>
            הגדר <strong>ממוצע מכירות יומי</strong> לכל זן ופרופיל כדי שהמערכת תדע מתי לקלות
          </p>
        </div>
      ) : (
        <>
          <p style={{ color: '#666', marginBottom: '1.5rem' }}>
            {totalNeeded} פריטים צריכים קלייה. סמן את מה שתקלה היום.
          </p>

          {/* Profile rows */}
          {profilesNeeded.length > 0 && (
            <>
              <p style={{ fontWeight: '600', color: '#6F4E37', marginBottom: '0.75rem', fontSize: '0.9rem' }}>🔥 פרופילי קלייה</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
                {profilesNeeded.map(profile => <ProfileRow key={profile.id} profile={profile} />)}
              </div>
            </>
          )}

          {/* Origin rows */}
          {originsNeeded.length > 0 && (
            <>
              {profilesNeeded.length > 0 && (
                <p style={{ fontWeight: '600', color: '#374151', marginBottom: '0.75rem', fontSize: '0.9rem' }}>🌱 זנים</p>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {originsNeeded.map(origin => <OriginRow key={origin.id} origin={origin} />)}
              </div>
            </>
          )}
        </>
      )}

      <div style={{ marginTop: '2rem', padding: '1rem', background: '#FFF9F0', borderRadius: '8px', border: '1px solid #F4E8D8' }}>
        <p style={{ fontSize: '0.875rem', color: '#666', margin: 0 }}>
          💡 הגדר <strong>ממוצע מכירות יומי</strong> בדף הזנים (לחיצה על ✏️) ובהגדרות → פרופילי קלייה.
        </p>
      </div>
    </div>
  );
}
