import React, { useState } from 'react';
import { UserProfile, useUser, useClerk } from '@clerk/clerk-react';

/**
 * Two-step verification gate.
 *
 * Applies only to people who sign in to CoffeeFlow itself. Telegram-only staff
 * have no Clerk account and never reach this screen.
 *
 * Gated behind REACT_APP_REQUIRE_MFA so this can ship before the Clerk
 * Dashboard has a second factor enabled. Enforcing while Clerk offers no MFA
 * method would lock everyone out with no way to enrol and no fix short of a
 * redeploy. Flip the flag on only after an admin has enrolled and confirmed it.
 */
const MFA_REQUIRED = process.env.REACT_APP_REQUIRE_MFA === 'true';

const btn = {
  border: 'none',
  borderRadius: '10px',
  padding: '0.6rem 1.4rem',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
};

export default function MfaGate({ children }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [checking, setChecking] = useState(false);

  if (!MFA_REQUIRED || user?.twoFactorEnabled) return children;

  const recheck = async () => {
    setChecking(true);
    try {
      await user.reload();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', padding: '2rem 1rem',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      background: 'linear-gradient(160deg, #3D4A2E 0%, #556B3A 50%, #6A7D45 100%)',
    }}>
      <div style={{
        background: 'white', padding: '2rem', borderRadius: '20px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.35)', textAlign: 'center',
        direction: 'rtl', maxWidth: '900px', width: '100%',
      }}>
        <img
          src="/New_logo.pdf.png"
          alt="Minuto Café Roastery"
          style={{ height: '90px', width: 'auto', objectFit: 'contain', marginBottom: '0.5rem' }}
        />

        <h2 style={{ margin: '0.5rem 0 0.75rem', color: '#3D4A2E', fontSize: '1.3rem' }}>
          נדרש אימות דו-שלבי
        </h2>
        <p style={{ margin: '0 auto 1.5rem', color: '#5B6B45', fontSize: '0.95rem', maxWidth: '520px', lineHeight: 1.6 }}>
          כדי להיכנס למערכת צריך להפעיל אימות דו-שלבי בחשבון.
          בחרו בלשונית Security ואז ב-Two-step verification, וסרקו את הקוד באפליקציית אימות.
          מומלץ לשמור גם קודי גיבוי.
        </p>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.5rem' }}>
          <UserProfile appearance={{ elements: { rootBox: { direction: 'ltr' } } }} />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={recheck}
            disabled={checking}
            style={{ ...btn, background: '#556B3A', color: 'white', opacity: checking ? 0.6 : 1 }}
          >
            {checking ? 'בודק...' : 'סיימתי, המשך למערכת'}
          </button>
          <button
            onClick={() => signOut()}
            style={{ ...btn, background: '#F3F4F6', color: '#4B5563' }}
          >
            התנתקות
          </button>
        </div>
      </div>
    </div>
  );
}
