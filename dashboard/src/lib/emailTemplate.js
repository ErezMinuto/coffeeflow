/**
 * Build an HTML email with Minuto branding.
 * Inline styles only — email clients strip <style> tags.
 */
export function buildEmailHtml(customMessage, products = []) {
  const productCards = products.map(p => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #EBEFE2;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="font-size: 16px; font-weight: 600; color: #3D4A2E; padding-bottom: 4px;">
              ${escapeHtml(p.name)}
            </td>
          </tr>
          ${p.price ? `<tr><td style="font-size: 14px; color: #556B3A;">₪${p.price}</td></tr>` : ''}
          ${p.description ? `<tr><td style="font-size: 13px; color: #888; padding-top: 4px;">${escapeHtml(p.description)}</td></tr>` : ''}
        </table>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #F5F5F0; font-family: Arial, Helvetica, sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #F5F5F0;">
    <tr><td align="center" style="padding: 24px 16px;">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background: linear-gradient(135deg, #3D4A2E, #556B3A); padding: 24px; text-align: center;">
            <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 700;">Minuto</h1>
            <p style="margin: 4px 0 0; color: #B5C69A; font-size: 13px;">קפה ובית קלייה</p>
          </td>
        </tr>

        <!-- Custom message -->
        <tr>
          <td style="padding: 24px 32px; font-size: 15px; line-height: 1.7; color: #333; direction: rtl; text-align: right;">
            ${customMessage.replace(/\n/g, '<br>')}
          </td>
        </tr>

        ${products.length > 0 ? `
        <!-- Products -->
        <tr>
          <td style="padding: 0 32px 24px;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td style="padding-bottom: 12px; font-size: 18px; font-weight: 700; color: #3D4A2E; border-bottom: 2px solid #B5C69A;">
                  מוצרים מומלצים
                </td>
              </tr>
              ${productCards}
            </table>
          </td>
        </tr>
        ` : ''}

        <!-- Footer -->
        <tr>
          <td style="background: #EBEFE2; padding: 16px 32px; text-align: center; font-size: 12px; color: #666;">
            <p style="margin: 0;">Minuto Café Roastery</p>
            <p style="margin: 8px 0 0;">
              <a href="{{unsubscribe}}" style="color: #556B3A; text-decoration: underline;">להסרה מרשימת התפוצה</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build a campaign HTML email with product images from WooCommerce.
 * Used by the AI auto-generator. Products must have image_url, permalink, price.
 */
export function buildCampaignHtml({
  subject = '',
  preheader = '',
  greeting = '',
  body = '',
  ctaText = 'לחנות',
  ctaUrl = 'https://minuto.co.il/shop',
  products = [],
  unsubscribeUrl = '',
}) {
  const productCards = products.map(p => `
    <tr>
      <td style="padding: 16px 0; border-bottom: 1px solid #EBEFE2;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" dir="rtl">
          <tr>
            ${p.image_url ? `
            <td width="120" style="vertical-align: top; padding-left: 16px;">
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="text-decoration: none;">
                <img src="${escapeHtml(p.image_url)}" width="120" height="120"
                     style="border-radius: 8px; display: block; object-fit: cover; border: 1px solid #eee;"
                     alt="${escapeHtml(p.name)}" />
              </a>
            </td>
            ` : ''}
            <td style="vertical-align: top; direction: rtl; text-align: right;">
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="font-size: 16px; font-weight: 600; color: #3D4A2E; text-decoration: none;">
                ${escapeHtml(p.name)}
              </a>
              ${p.price ? `<div style="font-size: 18px; color: #556B3A; font-weight: 700; margin: 4px 0;">₪${escapeHtml(p.price)}</div>` : ''}
              ${p.sale_price && p.regular_price && p.sale_price !== p.regular_price ? `
                <div style="margin: 2px 0;">
                  <span style="font-size: 14px; color: #999; text-decoration: line-through;">₪${escapeHtml(p.regular_price)}</span>
                  <span style="font-size: 18px; color: #DC2626; font-weight: 700; margin-right: 8px;">₪${escapeHtml(p.sale_price)}</span>
                </div>
              ` : ''}
              ${p.short_description ? `<div style="font-size: 13px; color: #666; line-height: 1.4; margin-top: 4px;">${p.short_description}</div>` : ''}
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="display: inline-block; margin-top: 8px; padding: 6px 16px; background: #556B3A; color: white; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">
                לרכישה
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  const unsubLink = unsubscribeUrl || '{{unsubscribe}}';

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background: #F5F5F0; font-family: Arial, Helvetica, sans-serif;">
  ${preheader ? `<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${escapeHtml(preheader)}</div>` : ''}
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #F5F5F0;">
    <tr><td align="center" style="padding: 24px 16px;">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background: linear-gradient(135deg, #3D4A2E, #556B3A); padding: 28px 24px; text-align: center;">
            <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: 1px;">Minuto</h1>
            <p style="margin: 6px 0 0; color: #B5C69A; font-size: 14px;">קפה ובית קלייה</p>
          </td>
        </tr>

        <!-- Greeting -->
        ${greeting ? `
        <tr>
          <td style="padding: 24px 32px 0; font-size: 18px; font-weight: 600; color: #3D4A2E; direction: rtl; text-align: right;">
            ${escapeHtml(greeting)}
          </td>
        </tr>
        ` : ''}

        <!-- Body -->
        <tr>
          <td style="padding: 16px 32px 24px; font-size: 15px; line-height: 1.8; color: #333; direction: rtl; text-align: right;">
            ${body.replace(/\n/g, '<br>')}
          </td>
        </tr>

        <!-- CTA Button -->
        ${ctaText ? `
        <tr>
          <td style="padding: 0 32px 24px; text-align: center;">
            <a href="${escapeHtml(ctaUrl)}" style="display: inline-block; padding: 14px 32px; background: #3D4A2E; color: white; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 700;">
              ${escapeHtml(ctaText)}
            </a>
          </td>
        </tr>
        ` : ''}

        ${products.length > 0 ? `
        <!-- Products Section -->
        <tr>
          <td style="padding: 0 32px 8px;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td style="padding-bottom: 12px; font-size: 18px; font-weight: 700; color: #3D4A2E; border-bottom: 2px solid #B5C69A; direction: rtl; text-align: right;">
                  ☕ מוצרים מומלצים
                </td>
              </tr>
              ${productCards}
            </table>
          </td>
        </tr>
        ` : ''}

        <!-- Spacer -->
        <tr><td style="height: 16px;"></td></tr>

        <!-- Footer -->
        <tr>
          <td style="background: #EBEFE2; padding: 20px 32px; text-align: center; font-size: 12px; color: #666;">
            <p style="margin: 0; font-weight: 600;">Minuto Café & Roastery</p>
            <p style="margin: 6px 0 0; color: #888;">קפה טרי מהקלייה — ישירות אליך</p>
            <p style="margin: 12px 0 0;">
              <a href="${escapeHtml(unsubLink)}" style="color: #556B3A; text-decoration: underline; font-size: 11px;">להסרה מרשימת התפוצה</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
