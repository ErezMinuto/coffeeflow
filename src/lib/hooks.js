import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import { useUser } from '@clerk/clerk-react';

// Hook לטעינת נתונים מטבלה
export const useSupabaseData = (table, { filterByUser = true } = {}) => {
  const { user } = useUser();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) {
      setData([]);
      setLoading(false);
      return;
    }

    fetchData();
    
    // Subscribe to realtime changes
    const subscription = supabase
      .channel(`${table}_changes`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: table, ...(filterByUser ? { filter: `user_id=eq.${user.id}` } : {}) },
        (payload) => {
          console.log('Change received!', payload);
          fetchData();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [user, table]);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Paginate to fetch all rows (Supabase default max is 1000 per request)
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        let query = supabase.from(table).select('*');
        if (filterByUser) query = query.eq('user_id', user.id);
        const { data: result, error } = await query
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);

        if (error) throw error;
        if (!result || result.length === 0) break;
        allRows = allRows.concat(result);
        if (result.length < PAGE) break; // last page
        from += PAGE;
      }
      setData(allRows);
    } catch (err) {
      console.error(`Error fetching ${table}:`, err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const insert = async (item) => {
    try {
      const { data: result, error } = await supabase
        .from(table)
        .insert({ ...item, user_id: user.id })
        .select()
        .single();

      if (error) throw error;
      return result;
    } catch (err) {
      console.error(`Error inserting ${table}:`, err);
      throw err;
    }
  };

  const update = async (id, updates) => {
    try {
      let query = supabase.from(table).update(updates).eq('id', id);
      // Only filter by user_id for per-user tables (e.g. cost_settings).
      // Shared org-wide tables (filterByUser: false) must be updatable by any team member.
      if (filterByUser) query = query.eq('user_id', user.id);
      // Use select() without .single() — .single() adds an Accept header that
      // causes Safari to fail with "Load failed" in Supabase JS v2.
      const { data: rows, error } = await query.select();

      if (error) throw error;
      await fetchData(); // Refresh local state immediately after update
      return rows?.[0] ?? null;
    } catch (err) {
      console.error(`Error updating ${table}:`, err);
      throw err;
    }
  };

  const remove = async (id) => {
    try {
      let query = supabase.from(table).delete().eq('id', id);
      // Only filter by user_id for per-user tables (e.g. cost_settings).
      // Shared org-wide tables (filterByUser: false) must be deletable by any team member.
      if (filterByUser) query = query.eq('user_id', user.id);
      const { error } = await query;

      if (error) throw error;
      await fetchData(); // Refresh local state immediately after delete
    } catch (err) {
      console.error(`Error deleting ${table}:`, err);
      throw err;
    }
  };

  return { data, loading, error, insert, update, remove, refresh: fetchData };
};

// Hook ספציפי להגדרות עלויות
export const useCostSettings = () => {
  const { user } = useUser();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setSettings(null);
      setLoading(false);
      return;
    }

    fetchSettings();
  }, [user]);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('cost_settings')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (error && error.code === 'PGRST116') {
        // No settings found, create default
        const defaultSettings = {
          user_id: user.id,
          bag_330g: 0.70,
          bag_250g: 0.60,
          bag_1000g: 2.00,
          label: 0.08,
          gas_per_roast: 10.00,
          labor_per_hour: 60,
          roasting_time_minutes: 17,
          packaging_time_minutes: 0.5,
          batch_size_kg: 15
        };

        const { data: newData, error: insertError } = await supabase
          .from('cost_settings')
          .insert(defaultSettings)
          .select()
          .single();

        if (insertError) throw insertError;
        setSettings(newData);
      } else if (error) {
        throw error;
      } else {
        setSettings(data);
      }
    } catch (err) {
      console.error('Error fetching cost settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateSettings = async (updates) => {
    try {
      const { data, error } = await supabase
        .from('cost_settings')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      setSettings(data);
      return data;
    } catch (err) {
      console.error('Error updating cost settings:', err);
      throw err;
    }
  };

  return { settings, loading, updateSettings, refresh: fetchSettings };
};
