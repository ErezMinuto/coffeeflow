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
    await page.type('input[name="email"]', 'erez@gurimi.com');
    await page.type('input[name="password"]', 'Mowfoz-sibdur-3bihbi');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    // Navigate to products page
    await page.goto('https://my.mflow.co.il/products', { waitUntil: 'networkidle0' });

    // Scrape products
    const products = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        return {
          name: cells[0]?.innerText?.trim() || '',
          sku: cells[1]?.innerText?.trim() || '',
          price: cells[2]?.innerText?.trim() || ''
        };
      }).filter(p => p.name);
    });

    await browser.close();

    // Return products for manual processing
    return res.status(200).json({
      success: true,
      count: products.length,
      products: products
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('MFlow import error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
