import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let browser;
  
  try {
    // Launch browser with chrome-aws-lambda
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // Login to MFlow
    await page.goto('https://my.mflow.co.il/login', { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
    await page.type('input[type="email"], input[name="email"]', 'erez@gurimi.com');
    await page.type('input[type="password"], input[name="password"]', 'Mowfoz-sibdur-3bihbi');
    
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
    ]);

    // Navigate to products page
    await page.goto('https://my.mflow.co.il/products', { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

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
