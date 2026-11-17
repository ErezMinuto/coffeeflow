import React, { useState } from 'react';
import { ArrowLeft, Check, CircleCheck, Flame, Lightbulb, Sprout } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { blendedWeightLoss } from '../../lib/utils';
import { notifyTeamIfWaiting } from '../../lib/telegram';
import { reservedBagsByProduct, storeStock } from '../../lib/reservedStock';

const DEFAULT_ROAST_KG = 15;
const ROAST_LEVEL_LABELS = { none: '', light: 'לייט', medium: 'מדיום' };

// ── Row components — defined OUTSIDE to prevent input focus loss ──────────────
// Styling lives in the .roasting-page section of App.css (rl-* classes).

function OriginRow({ origin, isChecked, onToggle, amount, onAmountChange, colorReading, onColorChange }) {
  const yieldPct  = 1 - (origin.weight_loss / 100);
  const roastedKg = (parseFloat(amount) * yieldPct).toFixed(1);

  return (
    <div className={`rl-row${isChecked ? ' on' : ''}`} onClick={onToggle}>
      <div className="rl-main">
        <input type="checkbox" checked={isChecked} onChange={onToggle} onClick={e => e.stopPropagation()} aria-label={`קלייה של ${origin.name}`} />
        <div className="rl-body">
          <div className="rl-top">
            <span className="rl-name">{origin.name}</span>
            <span className="rl-missing">חסר {origin.needed.toFixed(1)} ק"ג</span>
          </div>
          <div className="rl-stats">
            <span>מלאי קלוי <strong>{(origin.roasted_stock || 0).toFixed(1)} ק"ג</strong></span>
            {origin.packed_kg > 0 && (
              <span>בשקיות ארוזות <strong>{origin.packed_kg.toFixed(1)} ק"ג</strong></span>
            )}
            <span>מלאי קריטי <strong>{origin.critical_stock.toFixed(1)} ק"ג</strong></span>
            <span>מלאי ירוק <strong>{(origin.stock || 0).toFixed(1)} ק"ג</strong></span>
          </div>
        </div>
      </div>
      {isChecked && (
        <div className="rl-detail" onClick={e => e.stopPropagation()}>
          <div className="rl-fields">
            <div className="form-group">
              <label>משקל ירוק לקלייה (ק"ג)</label>
              <input
                type="number" step="0.5"
                value={amount}
                onChange={e => onAmountChange(e.target.value)}
              />
            </div>
            <div className="rl-yield">
              <ArrowLeft aria-hidden="true" /> {roastedKg} ק"ג קלוי ({origin.weight_loss}% איבוד)
            </div>
            <div className="form-group">
              <label>קריאת צבע</label>
              <input
                type="number" step="0.1" placeholder="למשל: 65.4"
                value={colorReading}
                onChange={e => onColorChange(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileRow({ profile, isChecked, onToggle, amount, onAmountChange, origins, profileIngredients, colorReading, onColorChange }) {
  const ings       = (profileIngredients || []).filter(i => i.profile_id === profile.id);
  const weightLoss = blendedWeightLoss(ings, origins);
  const roastedKg  = (parseFloat(amount) * (1 - weightLoss / 100)).toFixed(1);

  return (
    <div className={`rl-row${isChecked ? ' on' : ''}`} onClick={onToggle}>
      <div className="rl-main">
        <input type="checkbox" checked={isChecked} onChange={onToggle} onClick={e => e.stopPropagation()} aria-label={`קלייה של ${profile.name}`} />
        <div className="rl-body">
          <div className="rl-top">
            <span className="rl-name">
              {profile.name}
              {profile.roast_level && profile.roast_level !== 'none' && (
                <span className={`rlvl ${profile.roast_level}`}>{ROAST_LEVEL_LABELS[profile.roast_level]}</span>
              )}
            </span>
            <span className="rl-missing">חסר {profile.needed.toFixed(1)} ק"ג</span>
          </div>
          <div className="rl-recipe">
            {ings.map((ing, i) => {
              const origin = origins.find(o => o.id === ing.origin_id);
              return <span key={i}>{i > 0 ? ' · ' : ''}{ing.percentage}% {origin?.name || '?'}</span>;
            })}
          </div>
          <div className="rl-stats">
            <span>מלאי קלוי <strong>{(profile.roasted_stock || 0).toFixed(1)} ק"ג</strong></span>
            {profile.packed_kg > 0 && (
              <span>בשקיות ארוזות <strong>{profile.packed_kg.toFixed(1)} ק"ג</strong></span>
            )}
            <span>מלאי קריטי <strong>{profile.critical_stock.toFixed(1)} ק"ג</strong></span>
          </div>
        </div>
      </div>
      {isChecked && (
        <div className="rl-detail" onClick={e => e.stopPropagation()}>
          <div className="rl-fields">
            <div className="form-group">
              <label>משקל ירוק לקלייה (ק"ג)</label>
              <input
                type="number" step="0.5"
                value={amount}
                onChange={e => onAmountChange(e.target.value)}
              />
            </div>
            <div className="rl-yield">
              <ArrowLeft aria-hidden="true" /> {roastedKg} ק"ג קלוי
            </div>
            {ings.length > 1 && (
              <div className="rl-split">
                {ings.map((ing, i) => {
                  const origin    = origins.find(o => o.id === ing.origin_id);
                  const greenUsed = (parseFloat(amount) * ing.percentage / 100).toFixed(2);
                  return <span key={i}>{origin?.name}: {greenUsed} ק"ג</span>;
                })}
              </div>
            )}
            <div className="form-group">
              <label>קריאת צבע</label>
              <input
                type="number" step="0.1" placeholder="למשל: 65.4"
                value={colorReading}
                onChange={e => onColorChange(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RoastingList ──────────────────────────────────────────────────────────────

export default function RoastingList({
  data, originsDb, roastsDb, showToast,
  roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb
}) {
  const [checkedOrigins,  setCheckedOrigins]  = useState({});
  const [checkedProfiles, setCheckedProfiles] = useState({});
  const [amounts,         setAmounts]         = useState({});
  const [colorReadings,   setColorReadings]   = useState({});
  const [saving,          setSaving]          = useState(false);

  const userId = data.origins[0]?.user_id;

  // ── What needs roasting ─────────────────────────────────────────────────────
  // Roasted inventory is split between two buckets:
  //   1. roasted_stock — bulk roasted coffee waiting to be packed
  //   2. packed bags sitting in shelves (products.packed_stock × bag size)
  // Both are "already roasted" — so the recommender must add them together
  // before comparing against the daily-consumption critical threshold.
  // Otherwise the system keeps recommending roasting an origin even when
  // that origin is already living inside dozens of packed bags.
  // Bags allocated to a B2B customer are NOT available — they already belong to
  // someone (see reservedStock.js) — so only store stock counts here.

  const reserved          = reservedBagsByProduct(data.bagAllocations);
  const packedKgByOrigin  = {};
  const packedKgByProfile = {};
  for (const product of (data.products || [])) {
    const bags    = storeStock(product, reserved);
    const sizeKg  = (product.size || 0) / 1000;
    const recipe  = Array.isArray(product.recipe) ? product.recipe : [];
    if (bags <= 0 || sizeKg <= 0 || recipe.length === 0) continue;

    for (const ing of recipe) {
      const kg = bags * sizeKg * ((ing.percentage || 0) / 100);
      const id = ing.sourceId ?? ing.originId;
      if (!id) continue;
      if (ing.sourceType === 'profile') {
        packedKgByProfile[id] = (packedKgByProfile[id] || 0) + kg;
      } else {
        packedKgByOrigin[id]  = (packedKgByOrigin[id]  || 0) + kg;
      }
    }
  }

  const originsNeeded = data.origins
    .map(origin => {
      const daily        = origin.daily_average || 0;
      const critical     = daily * 10;
      const roastedKg    = origin.roasted_stock || 0;
      const packedKg     = packedKgByOrigin[origin.id] || 0;
      const availableKg  = roastedKg + packedKg;
      const needed       = critical - availableKg;
      return { ...origin, critical_stock: critical, packed_kg: packedKg, available_kg: availableKg, needed };
    })
    .filter(o => o.needed > 0)
    .sort((a, b) => b.needed - a.needed);

  const profilesNeeded = (data.roastProfiles || [])
    .map(profile => {
      const daily        = profile.daily_average || 0;
      const critical     = Math.max(daily * 10, profile.min_stock || 0);
      const roastedKg    = profile.roasted_stock || 0;
      const packedKg     = packedKgByProfile[profile.id] || 0;
      const availableKg  = roastedKg + packedKg;
      const needed       = critical - availableKg;
      return { ...profile, critical_stock: critical, packed_kg: packedKg, available_kg: availableKg, needed };
    })
    .filter(p => p.needed > 0)
    .sort((a, b) => b.needed - a.needed);

  const totalNeeded  = originsNeeded.length + profilesNeeded.length;
  const checkedCount = Object.values(checkedOrigins).filter(Boolean).length + Object.values(checkedProfiles).filter(Boolean).length;
  const anyChecked   = checkedCount > 0;

  // ── Toggle helpers ──────────────────────────────────────────────────────────

  const toggleOrigin = (id) => {
    setCheckedOrigins(prev => ({ ...prev, [id]: !prev[id] }));
    setAmounts(prev => prev[`o_${id}`] ? prev : { ...prev, [`o_${id}`]: DEFAULT_ROAST_KG });
  };

  const toggleProfile = (id) => {
    setCheckedProfiles(prev => ({ ...prev, [id]: !prev[id] }));
    setAmounts(prev => prev[`p_${id}`] ? prev : { ...prev, [`p_${id}`]: DEFAULT_ROAST_KG });
  };

  // ── Confirm ─────────────────────────────────────────────────────────────────

  const confirmRoasting = async () => {
    setSaving(true);
    const syncTime = new Date().toISOString();
    let success = 0;

    // Origin roasts
    for (const origin of originsNeeded.filter(o => checkedOrigins[o.id])) {
      const greenKg   = parseFloat(amounts[`o_${origin.id}`] || DEFAULT_ROAST_KG);
      const yieldPct  = 1 - (origin.weight_loss / 100);
      const roastedKg = parseFloat((greenKg * yieldPct).toFixed(2));
      const newGreen  = (origin.stock || 0) - greenKg;
      if (newGreen < 0) { showToast(`אין מספיק מלאי ירוק ל${origin.name}`, 'error'); continue; }
      try {
        await originsDb.update(origin.id, { roasted_stock: (origin.roasted_stock || 0) + roastedKg, stock: newGreen });
        await supabase.from('roasts').insert({ origin_id: origin.id, roast_profile_id: null, green_weight: greenKg, roasted_weight: roastedKg, operator: 'מנהל קלייה', date: syncTime, user_id: userId, color_reading: colorReadings[`origin_${origin.id}`] ? parseFloat(colorReadings[`origin_${origin.id}`]) : null });
        success++;
      } catch (err) { showToast(`שגיאה ב${origin.name}: ${err.message}`, 'error'); }
    }

    // Profile roasts
    for (const profile of profilesNeeded.filter(p => checkedProfiles[p.id])) {
      const greenKg = parseFloat(amounts[`p_${profile.id}`] || DEFAULT_ROAST_KG);
      const ings    = (data.roastProfileIngredients || []).filter(i => i.profile_id === profile.id);
      if (ings.length === 0) { showToast(`לפרופיל "${profile.name}" אין רכיבים`, 'warning'); continue; }

      let stockOk = true;
      for (const ing of ings) {
        const origin    = data.origins.find(o => o.id === ing.origin_id);
        const greenUsed = greenKg * ing.percentage / 100;
        if (!origin || origin.stock < greenUsed) {
          showToast(`אין מספיק מלאי ירוק ל${origin?.name || '?'} (${profile.name})`, 'error');
          stockOk = false; break;
        }
      }
      if (!stockOk) continue;

      const weightLoss = blendedWeightLoss(ings, data.origins);
      const roastedKg  = parseFloat((greenKg * (1 - weightLoss / 100)).toFixed(2));

      try {
        const { data: roastRow, error: roastErr } = await supabase
          .from('roasts')
          .insert({ roast_profile_id: profile.id, origin_id: null, green_weight: greenKg, roasted_weight: roastedKg, operator: 'מנהל קלייה', date: syncTime, user_id: userId, color_reading: colorReadings[`profile_${profile.id}`] ? parseFloat(colorReadings[`profile_${profile.id}`]) : null })
          .select().single();
        if (roastErr) throw roastErr;

        for (const ing of ings) {
          const origin    = data.origins.find(o => o.id === ing.origin_id);
          const greenUsed = parseFloat((greenKg * ing.percentage / 100).toFixed(4));
          await supabase.from('roast_components').insert({ roast_id: roastRow.id, origin_id: ing.origin_id, green_weight_used: greenUsed });
          await originsDb.update(origin.id, { stock: parseFloat((origin.stock - greenUsed).toFixed(4)) });
        }
        await roastProfilesDb.update(profile.id, { roasted_stock: parseFloat(((profile.roasted_stock || 0) + roastedKg).toFixed(4)), updated_at: syncTime });
        success++;
      } catch (err) { showToast(`שגיאה ב${profile.name}: ${err.message}`, 'error'); }
    }

    await originsDb.refresh();
    await roastsDb.refresh();
    if (roastProfilesDb)           await roastProfilesDb.refresh();
    if (roastProfileIngredientsDb) await roastProfileIngredientsDb.refresh();
    if (roastComponentsDb)         await roastComponentsDb.refresh();

    setSaving(false);
    setCheckedOrigins({}); setCheckedProfiles({}); setAmounts({});
    if (success > 0) {
      showToast(`${success} קליות נרשמו בהצלחה!`);
      await notifyTeamIfWaiting({ waitingCustomers: data.waitingCustomers, roastLabel: `${success} קליות`, showToast });
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div>
      {anyChecked && (
        <div className="rl-bar">
          <button onClick={confirmRoasting} disabled={saving} className="btn primary">
            <Check aria-hidden="true" /> {saving ? 'שומר…' : `אישור קלייה (${checkedCount})`}
          </button>
        </div>
      )}

      {totalNeeded === 0 ? (
        <div className="card empty-state rl-empty">
          <CircleCheck aria-hidden="true" />
          <h3>אין צורך בקלייה כרגע</h3>
          <p>כל הזנים והפרופילים מעל המלאי הקריטי</p>
          <p className="rl-hint">
            כדי שהמערכת תדע מתי לקלות, צריך להגדיר <strong>ממוצע מכירות יומי</strong> לכל זן ופרופיל
          </p>
        </div>
      ) : (
        <>
          <p className="rl-intro">
            {totalNeeded} פריטים צריכים קלייה. אפשר לסמן כאן את מה שנקלה היום.
          </p>

          {profilesNeeded.length > 0 && (
            <>
              <p className="rl-group-label"><Flame aria-hidden="true" /> פרופילי קלייה</p>
              <div className="rl-list">
                {profilesNeeded.map(profile => (
                  <ProfileRow
                    key={profile.id}
                    profile={profile}
                    isChecked={!!checkedProfiles[profile.id]}
                    onToggle={() => toggleProfile(profile.id)}
                    amount={amounts[`p_${profile.id}`] || DEFAULT_ROAST_KG}
                    onAmountChange={val => setAmounts(prev => ({ ...prev, [`p_${profile.id}`]: val }))}
                    origins={data.origins}
                    profileIngredients={data.roastProfileIngredients}
                    colorReading={colorReadings[`profile_${profile.id}`] || ''}
                    onColorChange={val => setColorReadings(prev => ({ ...prev, [`profile_${profile.id}`]: val }))}
                  />
                ))}
              </div>
            </>
          )}

          {originsNeeded.length > 0 && (
            <>
              {profilesNeeded.length > 0 && (
                <p className="rl-group-label"><Sprout aria-hidden="true" /> זנים</p>
              )}
              <div className="rl-list">
                {originsNeeded.map(origin => (
                  <OriginRow
                    key={origin.id}
                    origin={origin}
                    isChecked={!!checkedOrigins[origin.id]}
                    onToggle={() => toggleOrigin(origin.id)}
                    amount={amounts[`o_${origin.id}`] || DEFAULT_ROAST_KG}
                    onAmountChange={val => setAmounts(prev => ({ ...prev, [`o_${origin.id}`]: val }))}
                    colorReading={colorReadings[`origin_${origin.id}`] || ''}
                    onColorChange={val => setColorReadings(prev => ({ ...prev, [`origin_${origin.id}`]: val }))}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div className="notice rl-tip">
        <Lightbulb aria-hidden="true" />
        <span>
          את <strong>ממוצע המכירות היומי</strong> מגדירים בדף הזנים (בעריכת הזן) ובהגדרות, תחת פרופילי קלייה.
        </span>
      </div>
    </div>
  );
}
