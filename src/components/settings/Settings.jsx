import React, { useState, useEffect } from 'react';
import {
  Users, Coins, Flame, ShieldCheck, Send, Plus, Pencil, Trash2, Check, X, Copy, Save, Mail,
} from 'lucide-react';
import { useApp } from '../../lib/context';
import RoastProfiles from './RoastProfiles';
import { getTelegramSettings, saveTelegramSettings, sendTelegramMessage } from '../../lib/telegram';
import { supabase } from '../../lib/supabase';
import { PageHeader } from '../shared/ui';
import './settings.css';

// ── Sections of the settings page ─────────────────────────────────────────────
const CATEGORIES = [
  { id: 'operators',  Icon: Users,       label: 'מפעילים' },
  { id: 'costs',      Icon: Coins,       label: 'עלויות' },
  { id: 'roast',      Icon: Flame,       label: 'פרופילי קלייה' },
  { id: 'roles',      Icon: ShieldCheck, label: 'תפקידים' },
  { id: 'telegram',   Icon: Send,        label: 'טלגרם' },
];

// ── Shared section wrapper ────────────────────────────────────────────────────
function Section({ title, description, children }) {
  return (
    <section className="set-section">
      <div className="set-section-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

// Your own Clerk user ID with a copy button (used by Roles and Telegram).
function UserIdRow({ user, showToast }) {
  return (
    <div className="set-userid">
      <span className="set-userid-label">ה-User ID שלך</span>
      <code className="set-code">{user.id}</code>
      <button
        onClick={() => { navigator.clipboard.writeText(user.id); showToast('הועתק!'); }}
        className="btn-icon" title="העתקה" aria-label="העתקת ה-User ID"
      >
        <Copy aria-hidden="true" />
      </button>
    </div>
  );
}

// ── Operators ─────────────────────────────────────────────────────────────────
function OperatorsSection({ data, operatorsDb, roastsDb, showToast }) {
  const [newOperator,     setNewOperator]     = useState('');
  const [editingOperator, setEditingOperator] = useState(null);

  const addOperator = async () => {
    if (!newOperator.trim()) return;
    try {
      await operatorsDb.insert({ name: newOperator.trim() });
      setNewOperator('');
      showToast('מפעיל נוסף!');
    } catch (error) {
      showToast('שגיאה בהוספת מפעיל', 'error');
    }
  };

  const saveEditOperator = async () => {
    if (!editingOperator.name.trim()) { showToast('נא למלא שם מפעיל', 'warning'); return; }
    try {
      await operatorsDb.update(editingOperator.id, { name: editingOperator.name.trim() });
      const oldOperator = data.operators.find(op => op.id === editingOperator.id);
      if (oldOperator && oldOperator.name !== editingOperator.name.trim()) {
        for (const roast of data.roasts.filter(r => r.operator === oldOperator.name)) {
          await roastsDb.update(roast.id, { operator: editingOperator.name.trim() });
        }
      }
      setEditingOperator(null);
      showToast('מפעיל עודכן!');
    } catch (error) {
      showToast('שגיאה בעדכון מפעיל', 'error');
    }
  };

  const deleteOperator = async (operator) => {
    const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
    const msg = roastCount > 0
      ? `למפעיל "${operator.name}" יש ${roastCount} קליות.\n\nהאם למחוק?`
      : `האם למחוק את המפעיל "${operator.name}"?`;
    if (!window.confirm(msg)) return;
    try {
      await operatorsDb.remove(operator.id);
      showToast('מפעיל נמחק!');
    } catch (error) {
      showToast('שגיאה במחיקת מפעיל', 'error');
    }
  };

  return (
    <Section title="מפעילים" description="העובדים שאפשר לשייך לרשומת קלייה.">
      <div className="card flush">
        <div className="card-head">
          <h2>רשימת מפעילים</h2>
          <span className="meta num">{data.operators.length}</span>
        </div>

        <div className="card-body set-add-row">
          <input
            type="text" placeholder="שם מפעיל חדש" aria-label="שם מפעיל חדש"
            value={newOperator} onChange={e => setNewOperator(e.target.value)}
            onKeyPress={e => e.key === 'Enter' && addOperator()}
          />
          <button onClick={addOperator} className="btn primary">
            <Plus aria-hidden="true" />הוספה
          </button>
        </div>

        {data.operators.length > 0 ? (
          <div className="set-table-wrap">
            <table>
              <thead><tr><th>שם</th><th>קליות</th><th className="end"><span className="sr-only">פעולות</span></th></tr></thead>
              <tbody>
                {data.operators.map(op => (
                  editingOperator && editingOperator.id === op.id ? (
                    <tr key={op.id} className="set-editing">
                      <td colSpan={3}>
                        <div className="set-inline-edit">
                          <input
                            type="text" value={editingOperator.name} aria-label="שם המפעיל"
                            onChange={e => setEditingOperator({ ...editingOperator, name: e.target.value })}
                            autoFocus
                          />
                          <button onClick={saveEditOperator} className="btn primary sm">
                            <Check aria-hidden="true" />שמירה
                          </button>
                          <button onClick={() => setEditingOperator(null)} className="btn sm">ביטול</button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={op.id}>
                      <td className="set-strong">{op.name}</td>
                      <td>{data.roasts.filter(r => r.operator === op.name).length}</td>
                      <td className="end">
                        <div className="action-buttons">
                          <button onClick={() => setEditingOperator({ ...op })} className="btn-icon" title="עריכה" aria-label={`עריכת ${op.name}`}>
                            <Pencil aria-hidden="true" />
                          </button>
                          <button onClick={() => deleteOperator(op)} className="btn-icon danger" title="מחיקה" aria-label={`מחיקת ${op.name}`}>
                            <Trash2 aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">אין מפעילים.</div>
        )}
      </div>
    </Section>
  );
}

// ── Costs ─────────────────────────────────────────────────────────────────────
// [label, unit, key, fallback, step]
const COST_GROUPS = [
  { title: 'חומרי אריזה', rows: [
    ['שקית 250 גרם',  '₪',    'bag_250g',              0.60, 0.01],
    ['שקית 330 גרם',  '₪',    'bag_330g',              0,    0.01],
    ['שקית 1 ק"ג',    '₪',    'bag_1000g',             2.00, 0.01],
    ['מדבקה',         '₪',    'label',                 0,    0.01],
  ] },
  { title: 'קלייה', rows: [
    ['גז לקלייה',     '₪',    'gas_per_roast',         0,    0.01],
    ['זמן קלייה',     'דק׳',  'roasting_time_minutes', 0,    1   ],
  ] },
  { title: 'עבודה', rows: [
    ['שכר לשעה',      '₪',    'labor_per_hour',        0,    1   ],
    ['זמן אריזה',     'דק׳',  'packaging_time_minutes',0,    0.1 ],
  ] },
];

function CostsSection({ costSettings, updateCostSettings }) {
  return (
    <Section title="עלויות" description="עלויות קבועות שנכנסות לחישוב מחיר המוצרים.">
      {costSettings ? (
        <div className="card flush">
          <div className="card-head">
            <h2>עלויות קבועות</h2>
            <span className="meta"><span className="dot ok" aria-hidden="true" />השינויים נשמרים אוטומטית</span>
          </div>
          {COST_GROUPS.map(group => (
            <div className="set-group" key={group.title}>
              <div className="set-group-title">{group.title}</div>
              {group.rows.map(([label, unit, key, fallback, step]) => (
                <div className="set-row" key={key}>
                  <label className="set-row-label" htmlFor={`cost-${key}`}>{label}</label>
                  <div className="set-unit-field">
                    <input
                      id={`cost-${key}`}
                      type="number" step={step}
                      value={costSettings[key] ?? fallback}
                      onChange={async e => updateCostSettings({ [key]: parseFloat(e.target.value) })}
                    />
                    <span className="set-unit">{unit}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="card empty-state">טוען הגדרות...</div>
      )}
    </Section>
  );
}

// ── Roles ─────────────────────────────────────────────────────────────────────
const ROLE_HELP = [
  ['מנהל/ת',          'גישה מלאה'],
  ['אחראי/ת סידור',   'סידור עבודה בלבד'],
  ['עובד/ת',          'סקירה וייצור בלבד'],
  ['הנהלת חשבונות',  'חשבוניות ספקים בלבד, צפייה והורדה'],
];

function RoleOptions() {
  return (
    <>
      <option value="employee">עובד/ת</option>
      <option value="schedule_manager">אחראי/ת סידור</option>
      <option value="admin">מנהל/ת</option>
      <option value="bookkeeper">הנהלת חשבונות (חשבוניות ספקים בלבד)</option>
    </>
  );
}

function RolesSection({ user, showToast }) {
  const [roles,       setRoles]       = useState([]);
  const [newEmail,    setNewEmail]    = useState('');
  const [newRoleRole, setNewRoleRole] = useState('employee');
  const [looking,     setLooking]     = useState(false);
  const [invites,     setInvites]     = useState([]);   // pending Clerk invitations carrying a role

  const fetchRoles = async () => {
    const { data: rows } = await supabase.from('user_roles').select('*').order('created_at', { ascending: true });
    const roles = rows || [];
    setRoles(roles);

    // Auto-populate email/name for rows missing them
    const missing = roles.filter(r => !r.email).map(r => r.user_id);
    if (missing.length === 0) return;

    try {
      const { data: users } = await supabase.functions.invoke('clerk-user-lookup', {
        body: { user_ids: missing },
      });
      if (!users || !Array.isArray(users)) return;

      await Promise.all(users.map(u =>
        supabase.from('user_roles').update({ email: u.email, full_name: u.full_name })
          .eq('user_id', u.user_id)
      ));

      // Refresh to show updated values
      const { data: updated } = await supabase.from('user_roles').select('*').order('created_at', { ascending: true });
      setRoles(updated || []);
    } catch (_) {}
  };

  const fetchInvites = async () => {
    const { data } = await supabase.functions.invoke('clerk-user-lookup', { body: { action: 'list-invites' } });
    setInvites(Array.isArray(data?.invites) ? data.invites : []);
  };

  useEffect(() => { fetchRoles(); fetchInvites(); }, []);

  const roleLabelOf = (role) => role === 'admin' ? 'מנהל/ת' : role === 'schedule_manager' ? 'אחראי/ת סידור' : role === 'bookkeeper' ? 'הנהלת חשבונות' : 'עובד/ת';

  // No Clerk account yet: Clerk emails them a sign-up link; the role is
  // applied automatically on their first sign-in (claim-invite).
  const invite = async (email, role) => {
    const { data, error } = await supabase.functions.invoke('clerk-user-lookup', {
      body: { action: 'invite', email, role },
    });
    if (error || data?.error) {
      let msg = data?.error;
      try { msg = msg || (await error?.context?.json())?.error; } catch (_) {}
      throw new Error(msg || error?.message || 'ההזמנה נכשלה');
    }
    setNewEmail('');
    fetchInvites();
    showToast(`נשלחה הזמנה ל-${email} בתפקיד ${roleLabelOf(role)}. התפקיד ייקבע אוטומטית בכניסה הראשונה.`);
  };

  // A manual role change always wins over an old invitation.
  const clearInvitedRole = (userId) =>
    supabase.functions.invoke('clerk-user-lookup', { body: { action: 'clear-invited-role', user_id: userId } })
      .then(() => fetchInvites()).catch(() => {});

  const revokeInvite = async (inv) => {
    if (!window.confirm(`לבטל את ההזמנה של ${inv.email}?`)) return;
    const { data, error } = await supabase.functions.invoke('clerk-user-lookup', {
      body: { action: 'revoke-invite', id: inv.id, user_id: inv.status === 'accepted' ? inv.user_id : undefined },
    });
    if (error || data?.error) { showToast(`${data?.error || error?.message}`, 'error'); return; }
    fetchInvites();
    showToast('ההזמנה בוטלה');
  };

  const addRole = async () => {
    if (!newEmail.trim()) { showToast('נא להזין אימייל', 'warning'); return; }
    setLooking(true);
    try {
      const email = newEmail.trim();
      const { data, error } = await supabase.functions.invoke('clerk-user-lookup', {
        body: { email },
      });
      if (error?.context?.status === 404 || data?.error === 'User not found') {
        if (window.confirm(`ל-${email} עדיין אין חשבון ב-CoffeeFlow.\nלשלוח לו/ה הזמנה במייל? התפקיד "${roleLabelOf(newRoleRole)}" ייקבע אוטומטית בכניסה הראשונה.`)) {
          await invite(email, newRoleRole);
        }
        return;
      }
      if (error || data?.error) throw new Error(data?.error || error?.message || 'משתמש לא נמצא');

      const { error: upsertError } = await supabase.from('user_roles').upsert(
        { user_id: data.user_id, email: data.email, full_name: data.full_name, role: newRoleRole },
        { onConflict: 'user_id', ignoreDuplicates: false }
      );
      if (upsertError) throw new Error(upsertError.message);
      clearInvitedRole(data.user_id);
      setNewEmail('');
      fetchRoles();
      showToast(`${data.full_name || data.email} נוסף/ה בתפקיד ${roleLabelOf(newRoleRole)}!`);
    } catch (err) {
      showToast(`${err.message}`, 'error');
    } finally {
      setLooking(false);
    }
  };

  const updateRole = async (userId, role) => {
    await supabase.from('user_roles').update({ role }).eq('user_id', userId);
    clearInvitedRole(userId);
    fetchRoles();
    showToast(`תפקיד עודכן`);
  };

  const deleteRole = async (userId) => {
    if (!window.confirm('להסיר את התפקיד? המשתמש/ת יקבל/תקבל גישת עובד/ת.')) return;
    await supabase.from('user_roles').delete().eq('user_id', userId);
    clearInvitedRole(userId);
    fetchRoles();
    showToast('תפקיד הוסר');
  };

  return (
    <Section title="תפקידים" description="מי נכנס ל-CoffeeFlow ולאילו עמודים. בלי תפקיד מוגדר, הגישה היא גישת עובד/ת.">
      {/* Add */}
      <div className="card flush">
        <div className="card-head"><h2>הוספת משתמש/ת</h2></div>
        <div className="card-body">
          <div className="set-add-role">
            <div className="form-group set-grow">
              <label htmlFor="role-email">אימייל</label>
              <input
                id="role-email"
                type="email" placeholder="user@example.com"
                value={newEmail} onChange={e => setNewEmail(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && addRole()}
              />
            </div>
            <div className="form-group">
              <label htmlFor="role-role">תפקיד</label>
              <select id="role-role" value={newRoleRole} onChange={e => setNewRoleRole(e.target.value)}>
                <RoleOptions />
              </select>
            </div>
            <button onClick={addRole} disabled={looking} className="btn primary">
              {looking ? 'בבדיקה...' : <><Plus aria-hidden="true" />הוספה</>}
            </button>
          </div>
          <dl className="set-role-help">
            {ROLE_HELP.map(([name, what]) => (
              <div key={name}><dt>{name}</dt><dd>{what}</dd></div>
            ))}
          </dl>
        </div>
      </div>

      {/* Pending invitations */}
      {invites.length > 0 && (
        <div className="card flush">
          <div className="card-head">
            <h2>הזמנות שממתינות להרשמה</h2>
            <span className="tag warn num">{invites.length}</span>
          </div>
          {invites.map(inv => (
            <div key={inv.id} className="attn-item">
              <span className="dot warn" aria-hidden="true" />
              <div className="set-grow set-min0">
                <div className="attn-what set-ellipsis">{inv.email}</div>
                <div className="attn-why">
                  {roleLabelOf(inv.role)} · {inv.status === 'accepted' ? 'נרשם/ה, עוד לא נכנס/ה' : 'ממתינה להרשמה'}
                </div>
              </div>
              <button onClick={() => revokeInvite(inv)} className="btn-icon danger" title="ביטול ההזמנה" aria-label={`ביטול ההזמנה של ${inv.email}`}>
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
          <div className="set-card-foot">
            <Mail aria-hidden="true" />
            התפקיד ייקבע אוטומטית בכניסה הראשונה, אחרי ההרשמה דרך הקישור במייל. הזמנה תקפה ל-30 יום.
          </div>
        </div>
      )}

      {/* Users */}
      <div className="card flush">
        <div className="card-head">
          <h2>משתמשים עם תפקיד</h2>
          <span className="meta num">{roles.length}</span>
        </div>
        {roles.length > 0 ? (
          <ul className="set-list">
            {roles.map(r => (
              <li key={r.id} className="set-user">
                <div className="set-user-id">
                  <div className="set-user-name">
                    <span className="set-ellipsis">{r.full_name || r.email || r.user_id}</span>
                    {r.user_id === user?.id && <span className="tag brand">אני</span>}
                  </div>
                  {r.full_name && r.email && (
                    <div className="set-user-email set-ellipsis">{r.email}</div>
                  )}
                  <div className="set-user-uid">{r.user_id}</div>
                </div>
                <div className="set-user-actions">
                  <select value={r.role} onChange={e => updateRole(r.user_id, e.target.value)} aria-label="תפקיד">
                    <RoleOptions />
                  </select>
                  <button onClick={() => deleteRole(r.user_id)} className="btn-icon danger"
                    disabled={r.user_id === user?.id} title={r.user_id === user?.id ? 'לא ניתן להסיר את עצמך' : 'הסרת התפקיד'}
                    aria-label="הסרת התפקיד">
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">אין תפקידים. כל המשתמשים מקבלים גישת עובד/ת.</div>
        )}
        {user && (
          <div className="set-card-foot set-card-foot-plain">
            <UserIdRow user={user} showToast={showToast} />
          </div>
        )}
      </div>
    </Section>
  );
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function TelegramSection({ user, showToast }) {
  const [telegram,      setTelegram]      = useState({ botToken: '', chatId: '' });
  const [telegramSaved, setTelegramSaved] = useState(false);
  const [testing,       setTesting]       = useState(false);

  useEffect(() => {
    const saved = getTelegramSettings();
    if (saved.botToken || saved.chatId) setTelegram(saved);
  }, []);

  const save = () => {
    saveTelegramSettings(telegram);
    setTelegramSaved(true);
    setTimeout(() => setTelegramSaved(false), 2000);
    showToast('הגדרות טלגרם נשמרו!');
  };

  const test = async () => {
    if (!telegram.botToken || !telegram.chatId) { showToast('נא למלא טוקן וצ\'אט ID', 'warning'); return; }
    setTesting(true);
    try {
      await sendTelegramMessage(telegram.botToken, telegram.chatId, '✅ CoffeeFlow מחובר לטלגרם! 🎉');
      showToast('הודעת בדיקה נשלחה!');
    } catch (err) {
      showToast(`שגיאת טלגרם: ${err.message}`, 'error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title="טלגרם" description="בוט לקבלת התראות ולניהול לקוחות ממתינים מהקבוצה.">
      <div className="card flush">
        <div className="card-head"><h2>פרטי הבוט</h2></div>
        <div className="card-body">
          <div className="form-group">
            <label htmlFor="tg-token">Bot Token</label>
            <input id="tg-token" type="text" placeholder="1234567890:AAF..." className="set-mono" dir="ltr"
              value={telegram.botToken} onChange={e => setTelegram({ ...telegram, botToken: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="tg-chat">Chat ID</label>
            <input id="tg-chat" type="text" placeholder="-1001234567890" className="set-mono" dir="ltr"
              value={telegram.chatId} onChange={e => setTelegram({ ...telegram, chatId: e.target.value })} />
          </div>
          <div className="set-actions">
            <button onClick={save} className="btn primary">
              {telegramSaved ? <><Check aria-hidden="true" />נשמר</> : <><Save aria-hidden="true" />שמירה</>}
            </button>
            <button onClick={test} disabled={testing} className="btn">
              {testing ? 'בשליחה...' : <><Send aria-hidden="true" />שליחת הודעת בדיקה</>}
            </button>
          </div>
        </div>
        {user && (
          <div className="set-card-foot set-card-foot-plain">
            <UserIdRow user={user} showToast={showToast} />
          </div>
        )}
      </div>

      <div className="card flush">
        <div className="card-head"><h2>הגדרת הבוט</h2></div>
        <div className="card-body">
          <ol className="set-steps">
            <li>שמירת Bot Token ו-Chat ID בטופס למעלה.</li>
            <li>ב-<strong>Supabase ← Edge Functions ← Secrets</strong> יש להוסיף:
              <ul>
                <li><code className="set-code">TELEGRAM_BOT_TOKEN</code></li>
                <li><code className="set-code">TELEGRAM_CHAT_ID</code></li>
                <li><code className="set-code">COFFEEFLOW_USER_ID</code> = ה-User ID שלמעלה</li>
              </ul>
            </li>
            <li>הרצה חד-פעמית:
              <code className="set-code set-code-block" dir="ltr">
                curl "https://api.telegram.org/bot{'<TOKEN>'}/setWebhook?url=https://{'<PROJECT>'}.supabase.co/functions/v1/telegram-bot"
              </code>
            </li>
          </ol>
        </div>
        <div className="set-group">
          <div className="set-group-title">פקודות בקבוצה</div>
          <div className="set-row">
            <code className="set-code" dir="ltr">/task</code>
            <span className="set-row-help">משימה חדשה: שם, מוצר, טלפון. למשל: ירון, מקינטה מוקה 387874, 054-7373737</span>
          </div>
          <div className="set-row">
            <code className="set-code" dir="ltr">/tasks</code>
            <span className="set-row-help">רשימת הממתינים</span>
          </div>
          <div className="set-row">
            <code className="set-code" dir="ltr">/done 2</code>
            <span className="set-row-help">סימון #2 כטופל</span>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── Main Settings ─────────────────────────────────────────────────────────────
export default function Settings() {
  const { data, operatorsDb, roastsDb, costSettings, updateCostSettings, showToast, user } = useApp();
  const [activeCategory, setActiveCategory] = useState('operators');

  return (
    <div className="page settings-page">
      <PageHeader title="הגדרות" subtitle="מפעילים, עלויות, פרופילי קלייה, תפקידים וטלגרם" />

      <div className="set-layout">
        <nav className="set-nav" aria-label="קטגוריות הגדרות">
          {CATEGORIES.map(({ id, Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveCategory(id)}
              className={`set-nav-item${activeCategory === id ? ' active' : ''}`}
              aria-current={activeCategory === id ? 'page' : undefined}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="set-content">
          {activeCategory === 'operators' && (
            <OperatorsSection data={data} operatorsDb={operatorsDb} roastsDb={roastsDb} showToast={showToast} />
          )}
          {activeCategory === 'costs' && (
            <CostsSection costSettings={costSettings} updateCostSettings={updateCostSettings} />
          )}
          {activeCategory === 'roast' && <RoastProfiles />}
          {activeCategory === 'roles' && <RolesSection user={user} showToast={showToast} />}
          {activeCategory === 'telegram' && <TelegramSection user={user} showToast={showToast} />}
        </div>
      </div>
    </div>
  );
}
