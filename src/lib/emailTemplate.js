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

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
