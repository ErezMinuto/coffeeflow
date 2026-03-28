import React, { createContext, useContext, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useSupabaseData, useCostSettings } from './hooks';
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
      originsDb, productsDb, roastsDb, operatorsDb,
      roastProfilesDb, roastProfileIngredientsDb, roastComponentsDb, waitingCustomersDb,
      employeesDb, availabilityDb, schedulesDb, assignmentsDb,
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
