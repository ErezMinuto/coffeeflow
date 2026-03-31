# הוראות החלפת Flashy ב-Resend — טופס הרשמה לניוזלטר באתר מינוטו

## רקע
במקום Flashy, אנחנו עוברים ל-Resend לניהול אנשי קשר ושליחת מיילים שיווקיים.
הטופס באתר צריך לשלוח את הנתונים ל-API שלנו ב-Supabase, שמסנכרן אוטומטית גם ל-Resend וגם למערכת CoffeeFlow.

---

## מה צריך לעשות

### שלב 1: הסרת קוד Flashy
- להסיר את כל ה-scripts של Flashy מהאתר (בדרך כלל בקובץ `header.php` או `footer.php` או דרך תוסף)
- להסיר כל טופס הרשמה קיים של Flashy
- לוודא שאין קריאות API ל-Flashy בשום מקום באתר

### שלב 2: הוספת טופס הרשמה חדש
להחליף את טופס Flashy הקיים בקוד הבא. אפשר להוסיף דרך:
- ווידג'ט HTML בוורדפרס
- Elementor HTML widget
- ישירות בתבנית PHP

```html
<!-- טופס הרשמה לניוזלטר — מינוטו -->
<div id="minuto-newsletter" style="direction:rtl;text-align:right;max-width:400px;margin:0 auto;font-family:inherit;">
  <form id="minuto-subscribe-form">
    <div style="margin-bottom:10px;">
      <input
        type="text"
        name="name"
        placeholder="שם מלא"
        style="width:100%;padding:12px 16px;border:1px solid #ddd;border-radius:8px;font-size:15px;direction:rtl;"
      />
    </div>
    <div style="margin-bottom:10px;">
      <input
        type="email"
        name="email"
        placeholder="כתובת אימייל *"
        required
        style="width:100%;padding:12px 16px;border:1px solid #ddd;border-radius:8px;font-size:15px;direction:ltr;"
      />
    </div>
    <div style="margin-bottom:10px;">
      <input
        type="tel"
        name="phone"
        placeholder="טלפון (אופציונלי)"
        style="width:100%;padding:12px 16px;border:1px solid #ddd;border-radius:8px;font-size:15px;direction:ltr;"
      />
    </div>
    <button
      type="submit"
      style="width:100%;padding:14px;background:#3D4A2E;color:white;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;"
    >
      הרשמה לניוזלטר ☕
    </button>
    <p style="font-size:11px;color:#999;margin-top:8px;text-align:center;">
      בלחיצה על "הרשמה" את/ה מאשר/ת קבלת מיילים שיווקיים מ-מינוטו קפה. ניתן להסיר בכל עת.
    </p>
  </form>
  <div id="minuto-subscribe-success" style="display:none;text-align:center;padding:24px;">
    <div style="font-size:32px;margin-bottom:8px;">☕</div>
    <p style="font-size:18px;font-weight:600;color:#3D4A2E;">תודה שנרשמת!</p>
    <p style="font-size:14px;color:#666;">נשלח לך עדכונים על קפה טרי, מבצעים וטיפים.</p>
  </div>
</div>

<script>
(function() {
  var ENDPOINT = 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/generate-campaign';
  // חשוב: להחליף את ה-USER_ID בערך האמיתי מ-CoffeeFlow
  var USER_ID = 'REPLACE_WITH_YOUR_USER_ID';

  var form = document.getElementById('minuto-subscribe-form');
  var success = document.getElementById('minuto-subscribe-success');

  form.addEventListener('submit', function(e) {
    e.preventDefault();

    var btn = form.querySelector('button[type="submit"]');
    var originalText = btn.textContent;
    btn.textContent = '⏳ שולח...';
    btn.disabled = true;

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'subscribe',
        email: form.email.value.trim(),
        name: form.name.value.trim(),
        phone: form.phone.value.trim(),
        userId: USER_ID
      })
    })
    .then(function(res) {
      if (res.ok) {
        form.style.display = 'none';
        success.style.display = 'block';
      } else {
        alert('שגיאה בהרשמה. נסו שוב.');
        btn.textContent = originalText;
        btn.disabled = false;
      }
    })
    .catch(function() {
      alert('שגיאה בהרשמה. בדקו חיבור לאינטרנט.');
      btn.textContent = originalText;
      btn.disabled = false;
    });
  });
})();
</script>
```

### שלב 3: הגדרת USER_ID
בקוד למעלה, להחליף את `REPLACE_WITH_YOUR_USER_ID` ב-User ID האמיתי מ-CoffeeFlow.
אפשר למצוא אותו ב:
- כניסה ל-CoffeeFlow → הגדרות → מזהה משתמש
- או ב-Supabase Dashboard → Authentication → Users

### שלב 4: בדיקה
1. לפתוח את הדף עם הטופס
2. להזין אימייל לבדיקה ולשלוח
3. לוודא שהופיעה הודעת "תודה שנרשמת"
4. לוודא שהאיש קשר הופיע ב-CoffeeFlow בלשונית "אנשי קשר"
5. לוודא שהאיש קשר הופיע ב-Resend Dashboard בלשונית Contacts

---

## מה קורה מאחורי הקלעים
כשמישהו נרשם בטופס:
1. הנתונים נשלחים ל-Supabase Edge Function
2. האיש קשר נשמר בבסיס הנתונים של CoffeeFlow (עם סטטוס "מאושר")
3. האיש קשר נוסף גם ל-Resend Contacts
4. ניתן לשלוח לו קמפיינים מ-CoffeeFlow

כשמישהו לוחץ "הסרה" במייל:
1. הסטטוס מתעדכן אוטומטית ל-"לא מאושר"
2. הוא לא יקבל יותר מיילים שיווקיים
3. זה עובד גם ב-Resend וגם ב-CoffeeFlow

---

## הערות חשובות
- **אין צורך בתוסף Resend** — הטופס עובד ישירות עם ה-API שלנו
- **אין צורך ב-Flashy יותר** — אפשר לבטל את המנוי
- **הטופס עובד מכל דף** — אפשר לשים אותו בפוטר, בפופאפ, בדף נחיתה, בכל מקום
- **העיצוב ניתן להתאמה** — אפשר לשנות צבעים, גדלים, מרווחים לפי העיצוב של האתר
- **CORS** — ה-API מוגדר לקבל קריאות מ-`coffeeflow-thaf.vercel.app`. אם זה לא עובד מהאתר, צריך להוסיף את הדומיין של מינוטו ל-CORS. להודיע לי ואני אוסיף.

---

## בעיות נפוצות

| בעיה | פתרון |
|------|-------|
| שגיאת CORS | צריך להוסיף את דומיין האתר ל-ALLOWED_ORIGIN ב-Supabase |
| "שגיאה בהרשמה" | לבדוק ש-USER_ID נכון ושה-Edge Function רץ |
| איש קשר לא מופיע | לחכות כמה שניות ולרענן את CoffeeFlow |
| הטופס לא מופיע | לוודא שה-HTML נוסף נכון ושאין קונפליקט JS |
