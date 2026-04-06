/**
 * Call the generate-campaign edge function with an action + payload.
 */
export const callCampaignFunction = async (supabase, action, payload) => {
  const { data, error } = await supabase.functions.invoke('generate-campaign', {
    body: { action, ...payload }
  });
  if (error) throw new Error(error.message || 'Campaign function error');
  return data;
};
