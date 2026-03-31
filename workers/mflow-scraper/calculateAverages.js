const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

const USER_ID = process.env.USER_ID || '';

function getPreviousMonthRange() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
  const format = (d) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return { iso: year + '-' + month + '-' + day, display: day + '/' + month + '/' + year };
  };
  return { start: format(firstDay), end: format(lastDay), days: lastDay.getDate() };
}

async function scrapeMonthSales(page) {
  const { start, end, days } = getPreviousMonthRange();
  console.log('Fetching previous month: ' + start.display + ' - ' + end.display + ' (' + days + ' days)');

  const reportUrl = 'https://my.mflow.co.il/reports/product-sell-report?start_date=' + start.iso + '&end_date=' + end.iso;

  await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  await page.evaluate(function(startStr, endStr) {
    var input = document.getElementById('product_sr_date_filter');
    if (input && $(input).data('daterangepicker')) {
      var picker = $(input).data('daterangepicker');
      picker.setStartDate(moment(startStr, 'DD/MM/YYYY'));
      picker.setEndDate(moment(endStr, 'DD/MM/YYYY'));
      $(input).trigger('apply.daterangepicker', [picker]);
    }
  }, start.display, end.display);

  await new Promise(r => setTimeout(r, 1000));

  await page.evaluate(function() {
    var btn = document.getElementById('filter_btn');
    if (btn) btn.click();
  });

  await new Promise(r => setTimeout(r, 3000));

  await page.evaluate(function() {
    try {
      var table = $('#product_sell_report_table').DataTable();
      if (table) table.page.len(-1).draw();
    } catch(e) {}
  });

  await new Promise(r => setTimeout(r, 3000));

  await new Promise(r => setTimeout(r, 1000));

  await page.evaluate(function() {
    var btn = document.getElementById('filter_btn');
    if (btn) btn.click();
  });

  await new Promise(r => setTimeout(r, 3000));

  await page.evaluate(function() {
    try {
      var table = $('#product_sell_report_table').DataTable();
      if (table) table.page.len(-1).draw();
    } catch(e) {}
  });

  await new Promise(r => setTimeout(r, 2000));
  await page.waitForSelector('table', { timeout: 20000 });

  const sales = await page.evaluate(function() {
    var rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(function(row) {
      var cells = row.querySelectorAll('td');
      return {
        sku: cells[0] && cells[0].innerText ? cells[0].innerText.trim() : '',
        product: cells[1] && cells[1].innerText ? cells[1].innerText.trim() : ''
      };
    }).filter(function(s) { return s.sku; });
  });

  console.log('Found ' + sales.length + ' records for previous month');
  return { sales, days };
}

async function calculateDailyAverages(page) {
  console.log('=== CALCULATING DAILY AVERAGES ===');

  try {
    const { sales, days } = await scrapeMonthSales(page);

    if (sales.length === 0) {
      console.log('No sales data for previous month, skipping');
      return;
    }

    const salesByProduct = new Map();
    for (const sale of sales) {
      const normalizedSku = sale.sku.split('-')[0].replace(/^0+/, '');
      salesByProduct.set(normalizedSku, (salesByProduct.get(normalizedSku) || 0) + 1);
    }

    const originConsumption = new Map();

    for (const [normalizedSku, quantity] of salesByProduct) {
      const { data: products } = await supabase
        .from('products')
        .select('name, size, recipe')
        .eq('sku', normalizedSku)
        .eq('user_id', USER_ID);

      if (!products || products.length === 0) continue;

      const product = products[0];
      const recipe = product.recipe;
      if (!recipe || recipe.length === 0) continue;

      for (const ingredient of recipe) {
        if (!ingredient.originId || !ingredient.percentage) continue;
        const amountKg = (product.size * quantity * ingredient.percentage) / 100 / 1000;
        originConsumption.set(
          ingredient.originId,
          (originConsumption.get(ingredient.originId) || 0) + amountKg
        );
      }
    }

    let updated = 0;
    for (const [originId, totalKg] of originConsumption) {
      const dailyAvg = totalKg / days;
      const { error } = await supabase
        .from('origins')
        .update({ daily_average: parseFloat(dailyAvg.toFixed(3)) })
        .eq('id', originId)
        .eq('user_id', USER_ID);

      if (error) {
        console.error('Error updating origin ' + originId + ': ' + error.message);
      } else {
        console.log('Origin ' + originId + ': ' + dailyAvg.toFixed(3) + ' kg/day');
        updated++;
      }
    }

    console.log('Updated ' + updated + ' origins');
    console.log('==================================');

  } catch (err) {
    console.error('Error in calculateDailyAverages: ' + err.message);
  }
}

module.exports = { calculateDailyAverages };
