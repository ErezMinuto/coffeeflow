/**
 * Brevo Marketing helpers
 * WooCommerce import credentials stored in localStorage.
 * Brevo API key stays server-side only (edge function secret).
 */

const STORAGE_KEY = 'coffeeflow_brevo';

export const getBrevoSettings = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
};

export const saveBrevoSettings = (settings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

/**
 * Call the brevo-marketing edge function with an action + payload.
 * Returns the parsed response body.
 */
export const callBrevoFunction = async (supabase, action, payload) => {
  const { data, error } = await supabase.functions.invoke('brevo-marketing', {
    body: { action, ...payload }
  });
  if (error) throw new Error(error.message || 'Brevo function error');
  return data;
};
