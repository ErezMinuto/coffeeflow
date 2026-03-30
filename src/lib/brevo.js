/**
 * Marketing helpers
 * WooCommerce import credentials stored in localStorage.
 * API keys stay server-side only (edge function secrets).
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

/**
 * Call the generate-campaign edge function with an action + payload.
 * Used for AI campaign generation, sending via Resend, and product sync.
 */
export const callCampaignFunction = async (supabase, action, payload) => {
  const { data, error } = await supabase.functions.invoke('generate-campaign', {
    body: { action, ...payload }
  });
  if (error) throw new Error(error.message || 'Campaign function error');
  return data;
};
