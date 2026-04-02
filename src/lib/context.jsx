import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useUser, useAuth, useClerk } from '@clerk/clerk-react';
import { useSupabaseData, useCostSettings } from './hooks';
import { supabase, setClerkTokenGetter } from './supabase';
import {
  calculateProductCost as _calculateProductCost,
  calculateRoastedWeight,
  getOriginById as _getOriginById,
  blendedWeightLoss
} from './utils';

const AppContext = createContext(null);

const INACTIVITY_TIMEOUT_MS = 45 * 60 * 1000; // 45 min — staff on shared computers only
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];

export const AppProvider = ({ children }) => {
  const { user } = useUser();
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const [toasts, setToasts] = useState([]);
  const [userRole, setUserRole] = useState(null);
  const [roleLoading, setRoleLoading] = useState(true);
  const inactivityTimer = useRef(null);

  // Wire Clerk JWT getter into the Supabase fetch interceptor so every
  // request carries a valid JWT and RLS can enforce per-user security.
  useEffect(() => {
    setClerkTokenGetter(getToken);
  }, [getToken]);

  // ── Inactivity timeout ────────────────────────────────────────────────────
  // Sign the user out after 2 hours of no interaction.
  const resetTimer = useCallback(() => {
    clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      signOut();
    }, INACTIVITY_TIMEOUT_MS);
  }, [signOut]);

  useEffect(() => {
    if (!user || !userRole) return;
    // Admins work on personal computers — no inactivity timeout needed.
    // Staff work on shared computers — sign out after 45 min of inactivity.
    if (userRole === 'admin') return;

    resetTimer();
    ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, resetTimer, { passive: true }));

    return () => {
      clearTimeout(inactivityTimer.current);
      ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, resetTimer));
    };
  }, [user, userRole, resetTimer]);

  // Fetch user role from Supabase
  useEffect(() => {
    if (!user) { setRoleLoading(false); return; }
    const fetchRole = async () => {
      const email    = user.primaryEmailAddress?.emailAddress || '';
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');

      // get_role_for_user is SECURITY DEFINER — safe to call with anon key.
      // It looks up the role by user_id without relying on JWT verification.
      const { data: role } = await supabase.rpc('get_role_for_user', {
        p_user_id: user.id,
      });
      setUserRole(role || 'employee');
      setRoleLoading(false);
    };
    fetchRole();
  }, [user]);

  const isAdmin = userRole === 'admin';

  // Shared org-wide tables — all team members see the same data
  const originsDb                = useSupabaseData('origins',                   { filterByUser: false });
  const productsDb               = useSupabaseData('products',                  { filterByUser: false });
  const roastsDb                 = useSupabaseData('roasts',                    { filterByUser: false });
  const operatorsDb              = useSupabaseData('operators',                  { filterByUser: false });
  const roastProfilesDb          = useSupabaseData('roast_profiles',            { filterByUser: false });
  const roastProfileIngredientsDb = useSupabaseData('roast_profile_ingredients', { filterByUser: false });
  const roastComponentsDb         = useSupabaseData('roast_components',          { filterByUser: false });
  const waitingCustomersDb        = useSupabaseData('waiting_customers',         { filterByUser: false });
  const employeesDb               = useSupabaseData('employees',                 { filterByUser: false });
  const availabilityDb            = useSupabaseData('availability_submissions',  { filterByUser: false });
  const schedulesDb               = useSupabaseData('schedules',                 { filterByUser: false });
  const assignmentsDb             = useSupabaseData('schedule_assignments',      { filterByUser: false });
  const marketingContactsDb       = useSupabaseData('marketing_contacts',        { filterByUser: false });
  const campaignsDb               = useSupabaseData('campaigns',                 { filterByUser: false });
  const packingLogsDb             = useSupabaseData('packing_logs',              { filterByUser: false });
  const roastChecklistTemplatesDb = useSupabaseData('roast_checklist_templates');
  const { settings: costSettings, updateSettings: updateCostSettings } = useCostSettings();

  const data = {
    origins:                 originsDb.data                || [],
    products:                productsDb.data               || [],
    roasts:                  roastsDb.data                 || [],
    operators:               operatorsDb.data              || [],
    roastProfiles:           roastProfilesDb.data           || [],
    roastProfileIngredients: roastProfileIngredientsDb.data || [],
    roastComponents:         roastComponentsDb.data         || [],
    waitingCustomers:        waitingCustomersDb.data        || [],
    employees:               employeesDb.data               || [],
    availability:            availabilityDb.data            || [],
    schedules:               schedulesDb.data               || [],
    assignments:             assignmentsDb.data             || [],
    marketingContacts:       marketingContactsDb.data       || [],
    campaigns:               campaignsDb.data               || [],
    packingLogs:                  packingLogsDb.data                 || [],
    roastChecklistTemplates:      roastChecklistTemplatesDb.data     || [],
    costSettings:                 costSettings                       || {}
  };

  const showToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };

  const getOriginById = (id) => _getOriginById(data.origins, id);

  const calculateProductCost = (product, breakdown = false) =>
    _calculateProductCost(
      product, data.origins, costSettings, breakdown,
      data.roastProfiles, data.roastProfileIngredients
    );

  const refreshAll = useCallback(() => {
    originsDb.refresh();
    productsDb.refresh();
    roastsDb.refresh();
    operatorsDb.refresh();
    roastProfilesDb.refresh();
    roastProfileIngredientsDb.refresh();
    roastComponentsDb.refresh();
    waitingCustomersDb.refresh();
    employeesDb.refresh();
    availabilityDb.refresh();
    schedulesDb.refresh();
    assignmentsDb.refresh();
    marketingContactsDb.refresh();
    campaignsDb.refresh();
    packingLogsDb.refresh();
    roastChecklistTemplatesDb.refresh();
  }, [
    originsDb, productsDb, roastsDb, operatorsDb,
    roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb, waitingCustomersDb,
    employeesDb, availabilityDb, schedulesDb, assignmentsDb, marketingContactsDb, campaignsDb, packingLogsDb,
    roastChecklistTemplatesDb,
  ]);

  return (
    <AppContext.Provider value={{
      user,
      data,
      isAdmin, userRole, roleLoading,
      originsDb, productsDb, roastsDb, operatorsDb,
      roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb, waitingCustomersDb,
      employeesDb, availabilityDb, schedulesDb, assignmentsDb, marketingContactsDb, campaignsDb, packingLogsDb, roastChecklistTemplatesDb,
      costSettings, updateCostSettings,
      showToast, toasts,
      calculateProductCost, calculateRoastedWeight, getOriginById, blendedWeightLoss,
      refreshAll,
    }}>
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
};
