// MFlow Webhook Handler
// קובץ זה מקבל webhooks מ-MFlow ומעדכן את CoffeeFlow

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  // Allow only POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Log the incoming webhook for debugging
    console.log('MFlow Webhook received:', JSON.stringify(req.body, null, 2));
    console.log('Headers:', JSON.stringify(req.headers, null, 2));

    // TODO: Parse MFlow data structure
    // We need to see what MFlow actually sends to complete this
    const mflowData = req.body;

    // For now, just log and return success
    // We'll update this once we see the actual payload
    
    // Return success to MFlow
    return res.status(200).json({ 
      success: true,
      message: 'Webhook received and logged',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

/*
EXPECTED MFLOW PAYLOAD (to be updated once we see it):
{
  "sale_id": "12345",
  "date": "2026-03-18T15:30:00Z",
  "items": [
    {
      "product_id": "...",
      "product_name": "ברזיל 500 גרם",
      "quantity": 5,
      "price": 42
    }
  ],
  "total": 210
}
*/
