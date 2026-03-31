const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let browser;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // Login to MFlow
    await page.goto('https://my.mflow.co.il/login', { waitUntil: 'networkidle0' });
    await page.type('input[name="email"]', process.env.MFLOW_EMAIL || '');
    await page.type('input[name="password"]', process.env.MFLOW_PASSWORD || '');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    // Navigate to sales report
    await page.goto('https://my.mflow.co.il/reports/product-sell-report', { waitUntil: 'networkidle0' });

    // Set date range to last 7 days
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Scrape sales data
    const sales = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        return {
          product: cells[0]?.innerText?.trim() || '',
          quantity: parseFloat(cells[1]?.innerText?.trim()) || 0,
          date: cells[2]?.innerText?.trim() || ''
        };
      }).filter(s => s.product && s.quantity > 0);
    });

    await browser.close();

    // Return sales data
    return res.status(200).json({
      success: true,
      salesCount: sales.length,
      sales: sales,
      dateRange: {
        from: weekAgo.toISOString().split('T')[0],
        to: today.toISOString().split('T')[0]
      }
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('MFlow sync error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
