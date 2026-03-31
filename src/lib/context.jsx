import React, { createContext, useContext, useState, useEffect } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useSupabaseData, useCostSettings } from './hooks';
import { supabase } from './supabase';
import {
  calculateProductCost as _calculateProductCost,
  calculateRoastedWeight,
  getOriginById as _getOriginById,
  blendedWeightLoss
} from './utils';

const AppContext = createContext(null);

export const AppProvider = ({ children }) => {
  const { user } = useUser();
  const [toasts, setToasts] = useState([]);
  const [userRole, setUserRole] = useState(null);
  const [roleLoading, setRoleLoading] = useState(true);

  // Fetch user role from Supabase
  useEffect(() => {
    if (!user) { setRoleLoading(false); return; }
    const fetchRole = async () => {
      const { data: roleData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .single();
      // If no role found, default to employee (least privilege)
      setUserRole(roleData?.role || 'employee');
      setRoleLoading(false);
    };
    fetchRole();
  }, [user]);

  const isAdmin = userRole === 'admin';

  const originsDb                = useSupabaseData('origins');
  const productsDb               = useSupabaseData('products');
  const roastsDb                 = useSupabaseData('roasts');
  const operatorsDb              = useSupabaseData('operators');
  const roastProfilesDb           = useSupabaseData('roast_profiles');
  const roastProfileIngredientsDb = useSupabaseData('roast_profile_ingredients');
  const roastComponentsDb         = useSupabaseData('roast_components');
  const waitingCustomersDb        = useSupabaseData('waiting_customers');
  const employeesDb               = useSupabaseData('employees');
  const availabilityDb            = useSupabaseData('availability_submissions');
  const schedulesDb               = useSupabaseData('schedules');
  const assignmentsDb             = useSupabaseData('schedule_assignments');
  const marketingContactsDb       = useSupabaseData('marketing_contacts');
  const campaignsDb               = useSupabaseData('campaigns');
  const packingLogsDb             = useSupabaseData('packing_logs');
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
    packingLogs:             packingLogsDb.data             || [],
    costSettings:            costSettings                  || {}
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

  return (
    <AppContext.Provider value={{
      user,
      data,
      isAdmin, userRole, roleLoading,
      originsDb, productsDb, roastsDb, operatorsDb,
      roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb, waitingCustomersDb,
      employeesDb, availabilityDb, schedulesDb, assignmentsDb, marketingContactsDb, campaignsDb, packingLogsDb,
      costSettings, updateCostSettings,
      showToast, toasts,
      calculateProductCost, calculateRoastedWeight, getOriginById, blendedWeightLoss
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
