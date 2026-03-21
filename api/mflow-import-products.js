import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'Missing userId' });
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.goto('https://my.mflow.co.il/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await new Promise(r => setTimeout(r, 3000));
    await page.waitForSelector('#login_username', { timeout: 20000 });
    await page.type('#login_username', process.env.MFLOW_EMAIL);
    await page.type('#login_password', process.env.MFLOW_PASSWORD);

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
    ]);

    await new Promise(r => setTimeout(r, 2000));

    if (!page.url().includes('/home')) {
      throw new Error('Login failed - unexpected URL: ' + page.url());
    }

    await page.goto('https://my.mflow.co.il/products', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await new Promise(r => setTimeout(r, 3000));

    // Show all rows
    await page.evaluate(function() {
      try {
        var select = document.querySelector('select[name*="length"]');
        if (select) {
          select.value = '-1';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch(e) {}
    });

    await new Promise(r => setTimeout(r, 2000));

    const products = await page.evaluate(function() {
      var rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(function(row) {
        var cells = row.querySelectorAll('td');
        return {
          sku: cells[0] && cells[0].innerText ? cells[0].innerText.trim() : '',
          name: cells[1] && cells[1].innerText ? cells[1].innerText.trim() : ''
        };
      }).filter(function(p) { return p.sku && p.name; });
    });

    await browser.close();

    let imported = 0;
    let skipped = 0;
    let errors = [];

    for (const product of products) {
      const sku = product.sku.split('-')[0].replace(/^0+/, '');

      const { data: existing } = await supabase
        .from('products')
        .select('id')
        .eq('sku', sku)
        .eq('user_id', userId)
        .limit(1);

      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }

      const { error } = await supabase
        .from('products')
        .insert({
          name: product.name,
          sku,
          size: 330,
          type: 'single',
          user_id: userId,
          recipe: []
        });

      if (error) {
        errors.push(product.name + ': ' + error.message);
      } else {
        imported++;
      }
    }

    return res.status(200).json({
      success: true,
      total: products.length,
      imported,
      skipped,
      errors
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('MFlow import error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
