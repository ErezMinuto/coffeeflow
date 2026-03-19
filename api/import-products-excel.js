import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get file from form data
    const contentType = req.headers['content-type'] || '';
    
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Must upload file as multipart/form-data' 
      });
    }

    // For now, return mock data to test the flow
    // We'll add actual Excel parsing in the next step
    return res.status(200).json({
      success: true,
      total: 14,
      imported: 14,
      skipped: 0,
      errors: [],
      message: 'Test successful - Excel parsing will be added next'
    });

  } catch (error) {
    console.error('Import error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
