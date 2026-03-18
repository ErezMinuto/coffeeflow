// MFlow Sales Scraper for CoffeeFlow
// Runs hourly via Vercel Cron to sync sales data

import { createClient } from '@supabase/supabase-js';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY
);

// Product mapping: MFlow product name → CoffeeFlow origin name
const PRODUCT_MAPPING = {
  'פולי קפה טרי ספשלטי קפה מינוטו אריסטו': 'אריסטו',
  'פולי קפה ספשלטי קפה מינוטו נטול קפאין': 'נטול קפאין',
  '1 ק״ג פולי קפה Veneto Premium': 'Veneto Premium',
  '1 ק״ג פולי קפה Veneto Delux': 'Veneto Delux',
  'פולי קפה ספשלטי טרי 100% ערביקה קולומביה': 'קולומביה',
  'ספשלטי קפה פולי קפה קניה AA+': 'קניה AA+',
  'פולי קפה ספשלטי קפה  גוג\'י חד זני': 'גוג\'י',
  'פולי קפה ספשלטי קפה אנטיגואה חד זני': 'אנטיגואה',
  'פולי קפה טרי ספשלטי קפה מינוטו טריאסט': 'טריאסט',
  'פולי קפה טרי ספשלטי קפה מינוטו פרסטיז\'': 'פרסטיז\'',
  'פולי קפה טרי ספשלטי קפה מינוטו אינטנסו': 'אינטנסו',
  'ספשלטי קפה פולי קפה Jungle Java': 'Jungle Java',
  'פולי קפה טרי 100% ערביקה  - Minuto Dark Chocolate': 'Dark Chocolate',
  'פולי קפה אתיופיה דיי בנסה': 'דיי בנסה',
  'פולי קפה אתיופיה יירגשף': 'יירגשף',
  'פולי קפה אתיופיה Benesa Desita': 'Benesa Desita'
};

// Extract weight from product name
function extractWeight(productName) {
  // Look for patterns like "330 גר" or "1 ק״ג"
  const gramMatch = productName.match(/(\d+)\s*גר/);
  if (gramMatch) return parseFloat(gramMatch[1]) / 1000; // Convert to kg
  
  const kgMatch = productName.match(/(\d+(?:\.\d+)?)\s*ק״ג/);
  if (kgMatch) return parseFloat(kgMatch[1]);
  
  // Default to 0.33kg (330g) if not specified
  return 0.33;
}

// Map MFlow product to CoffeeFlow origin
function mapProductToOrigin(mflowProductName) {
  // Try exact match first
  for (const [mflowName, originName] of Object.entries(PRODUCT_MAPPING)) {
    if (mflowProductName.includes(mflowName)) {
      return originName;
    }
  }
  
  // If no match, return null
  return null;
}

export default async function handler(req, res) {
  // Only allow POST or GET
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let browser = null;

  try {
    console.log('🚀 Starting MFlow sync...');

    // Launch Puppeteer
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // 1. Login to MFlow
    console.log('🔐 Logging in to MFlow...');
    await page.goto('https://my.mflow.co.il/login', { waitUntil: 'networkidle0' });
    
    await page.type('input[type="email"], input[name="email"]', process.env.MFLOW_EMAIL);
    await page.type('input[type="password"], input[name="password"]', process.env.MFLOW_PASSWORD);
    
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle0' })
    ]);
    
    console.log('✅ Logged in successfully');

    // 2. Navigate to sales report
    console.log('📊 Navigating to sales report...');
    
    // Wait a bit for page to load
    await page.waitForTimeout(2000);
    
    // Try to find and click on reports/sales menu
    // This might need adjustment based on actual MFlow structure
    await page.goto('https://my.mflow.co.il/reports/sales', { waitUntil: 'networkidle0' });
    
    console.log('✅ On sales report page');

    // 3. Set date filter to today
    console.log('📅 Setting date filter...');
    
    const today = new Date().toISOString().split('T')[0];
    
    // Try to find date inputs and set them
    // This is a guess - might need to inspect actual page
    const dateInputs = await page.$$('input[type="date"]');
    if (dateInputs.length >= 2) {
      await dateInputs[0].evaluate((el, date) => el.value = date, today);
      await dateInputs[1].evaluate((el, date) => el.value = date, today);
    }
    
    await page.waitForTimeout(2000);
    
    console.log('✅ Date filter set');

    // 4. Extract sales data from table
    console.log('🔍 Extracting sales data...');
    
    const sales = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        return {
          sku: cells[0]?.innerText?.trim() || '',
          product: cells[1]?.innerText?.trim() || '',
          date: cells[5]?.innerText?.trim() || '',
        };
      }).filter(sale => sale.product && sale.product !== 'סה"כ:');
    });
    
    console.log(`✅ Found ${sales.length} sales`);

    // 5. Process sales and update CoffeeFlow
    console.log('💾 Updating CoffeeFlow inventory...');
    
    const updates = [];
    
    for (const sale of sales) {
      const originName = mapProductToOrigin(sale.product);
      
      if (!originName) {
        console.log(`⚠️ No mapping for product: ${sale.product}`);
        continue;
      }
      
      const weight = extractWeight(sale.product);
      
      console.log(`📦 ${originName}: -${weight}kg`);
      
      // Find origin in Supabase
      const { data: origins, error: fetchError } = await supabase
        .from('origins')
        .select('*')
        .ilike('name', `%${originName}%`)
        .limit(1);
      
      if (fetchError || !origins || origins.length === 0) {
        console.log(`❌ Origin not found: ${originName}`);
        continue;
      }
      
      const origin = origins[0];
      const currentStock = origin.roasted_stock || 0;
      const newStock = Math.max(0, currentStock - weight);
      
      // Update stock
      const { error: updateError } = await supabase
        .from('origins')
        .update({ roasted_stock: newStock })
        .eq('id', origin.id);
      
      if (updateError) {
        console.log(`❌ Failed to update ${originName}: ${updateError.message}`);
      } else {
        console.log(`✅ Updated ${originName}: ${currentStock}kg → ${newStock}kg`);
        updates.push({
          origin: originName,
          oldStock: currentStock,
          newStock: newStock,
          weight: weight
        });
      }
    }

    await browser.close();

    console.log('🎉 Sync completed successfully!');

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      salesFound: sales.length,
      updates: updates
    });

  } catch (error) {
    console.error('❌ Error syncing MFlow:', error);
    
    if (browser) {
      await browser.close();
    }
    
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
}
