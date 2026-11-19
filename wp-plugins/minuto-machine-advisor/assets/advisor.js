/** Advisor screens. The rules themselves are in engine.js. */
(function () {
  'use strict';

  var root = document.getElementById('minuto-machine-advisor');
  if (!root || !window.MinutoAdvisorEngine) return;
  var Engine = window.MinutoAdvisorEngine;

  var GA4_ID = 'G-Q531JEYSMC';

  function shekels(n) { return '₪' + Number(n).toLocaleString('en-US'); }

  function budgetOptions(kind) {
    var r = Engine.RANGES[kind];
    return [
      [0, 'עד ' + shekels(r[0][1])],
      [1, shekels(r[1][0]) + ' עד ' + shekels(r[1][1])],
      [2, shekels(r[2][0]) + ' עד ' + shekels(r[2][1])],
      [3, 'מעל ' + shekels(r[3][0])],
    ];
  }

  var STEPS = [
    { id: 'use', title: 'איך מכינים קפה אצלך?', options: [
      ['auto', 'מכונה אוטומטית', 'לחיצה על כפתור והקפה מוכן'],
      ['manual', 'מכונת אספרסו ידנית', 'עם ידית, כמו בבית קפה'],
      ['lever', 'מכונת מנוף', 'הלחץ נוצר ביד, במשיכת המנוף'],
      ['go', 'בדרכים', 'מכונה ניידת לטיולים ולרכב'],
      ['filter', 'קפה פילטר'],
      ['business', 'לבית קפה או למשרד', 'נמליץ בשיחה בוואטסאפ'],
    ] },
    { id: 'milk', title: 'ומה עם חלב?', when: function (a) { return a.use === 'auto'; }, options: [
      ['none', 'בלי חלב'],
      ['hand', 'לפעמים, מקציפים לבד', 'עם צינור קיטור'],
      ['button', 'הרבה, בלחיצת כפתור', 'קפוצ׳ינו ולאטה מוכנים מהמכונה'],
    ] },
    { id: 'milk', title: 'כמה משקאות חלב ביום?', when: function (a) { return a.use === 'manual'; }, options: [
      ['rarely', 'מעט או בכלל לא', 'דוד אחד מספיק'],
      ['daily', 'משקה או שניים ביום', 'מקציפים ומפיקים אספרסו בו בזמן'],
      ['many', 'כמה משקאות ברצף', 'שני דודים, בלי המתנה בין משקה למשקה'],
    ] },
    { id: 'takes', title: 'מה שמים במכונה?', when: function (a) { return a.use === 'go'; }, options: [
      ['ground', 'קפה טחון'],
      ['capsule', 'קפסולות'],
    ] },
    { id: 'budget', title: 'מה התקציב?', when: function (a) { return a.use === 'auto'; }, options: budgetOptions('auto') },
    { id: 'budget', title: 'מה התקציב?', when: function (a) { return a.use === 'manual' || a.use === 'lever'; }, options: budgetOptions('manual') },
    { id: 'grinder', title: 'יש מטחנת קפה בבית?', when: function (a) { return a.use === 'manual'; }, options: [
      ['yes', 'כן'],
      ['no', 'עדיין לא'],
    ] },
    { id: 'water', title: 'לחבר את המכונה לקו המים?', when: Engine.asksWater, options: [
      ['no', 'לא, מיכל מים מספיק'],
      ['yes', 'כן, חיבור קבוע לקו המים', 'בלי למלא מיכל'],
    ] },
  ];

  var catalog = [];
  var coffee = { ready: false, items: [] };
  var answers = {};
  var stepIndex = 0;
  var interacted = false;
  var started = false;

  // Analytics must never get in the way. The site's gtag already honors
  // consent, and these events carry advisor choices only, nothing personal.
  function track(name, params) {
    try {
      if (typeof window.gtag !== 'function') return;
      var data = { send_to: GA4_ID };
      Object.keys(params || {}).forEach(function (k) { data[k] = params[k]; });
      window.gtag('event', name, data);
    } catch (e) { /* ignored on purpose */ }
  }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  }

  // Each screen replaces the last, which would drop keyboard and screen-reader
  // focus. Not on first load: that would scroll the page down to the advisor.
  function heading(text) {
    var h = el('h2', 'ma-title', text);
    h.tabIndex = -1;
    return h;
  }

  function focusHeading(h) { if (interacted) h.focus(); }

  function activeSteps() {
    return STEPS.filter(function (s) { return !s.when || s.when(answers); });
  }

  function answer(step, value) {
    interacted = true;
    if (!started) { started = true; track('advisor_start'); }
    answers[step.id] = value;
    // Later answers depend on earlier ones: drop what no longer applies.
    var ids = activeSteps().map(function (s) { return s.id; });
    Object.keys(answers).forEach(function (k) { if (ids.indexOf(k) === -1) delete answers[k]; });
    stepIndex += 1;
    render();
  }

  function renderStep() {
    var steps = activeSteps();
    var step = steps[stepIndex];
    var wrap = el('div', 'ma-step');
    // No "of N": how many questions follow depends on the answers.
    wrap.appendChild(el('p', 'ma-progress', 'שאלה ' + (stepIndex + 1)));
    var title = heading(step.title);
    wrap.appendChild(title);
    var list = el('div', 'ma-options');
    step.options.forEach(function (o) {
      var b = el('button', 'ma-option');
      b.type = 'button';
      b.appendChild(el('span', 'ma-option-label', o[1]));
      if (o[2]) b.appendChild(el('span', 'ma-option-hint', o[2]));
      b.addEventListener('click', function () { answer(step, o[0]); });
      list.appendChild(b);
    });
    wrap.appendChild(list);
    if (stepIndex > 0) {
      var back = el('button', 'ma-link', 'חזרה');
      back.type = 'button';
      back.addEventListener('click', function () { interacted = true; stepIndex -= 1; render(); });
      wrap.appendChild(back);
    }
    root.appendChild(wrap);
    focusHeading(title);
  }

  // The coffee for a machine, from the coffee quiz's rules and its live stock.
  function coffeeFor(m) {
    if (!coffee.ready || !window.MinutoQuizEngine) return null;
    var qa = Engine.coffeeAnswers(m, answers);
    if (!qa) return null;
    var named = coffee.items.filter(function (c) { return !c.extra; });
    var keys = window.MinutoQuizEngine.recommend(qa, {
      all: named.map(function (c) { return c.key; }),
      light: named.filter(function (c) { return c.light; }).map(function (c) { return c.key; }),
      extras: coffee.items.filter(function (c) { return c.extra || c.limited; }),
    });
    return coffee.items.filter(function (c) { return c.key === keys[0]; })[0] || null;
  }

  function renderCard(m) {
    var card = el('div', 'ma-card');
    if (m.image) {
      var img = el('img', 'ma-photo');
      img.src = m.image; img.alt = m.name; img.loading = 'lazy';
      card.appendChild(img);
    }
    var body = el('div', 'ma-card-body');
    body.appendChild(el('h3', 'ma-name', m.name));
    if (m.price_text) body.appendChild(el('p', 'ma-price', m.price_text));
    var a = el('a', 'ma-button', 'לפרטים על המכונה');
    a.href = m.url;
    a.addEventListener('click', function () {
      track('advisor_click', { machine: m.name, transport_type: 'beacon' });
    });
    body.appendChild(a);
    var c = coffeeFor(m);
    if (c) {
      var line = el('p', 'ma-coffee');
      line.appendChild(document.createTextNode('הקפה שמתאים למכונה: '));
      var link = el('a', 'ma-coffee-link', c.name);
      link.href = c.url;
      link.addEventListener('click', function () {
        track('advisor_coffee_click', { machine: m.name, coffee: c.name, transport_type: 'beacon' });
      });
      line.appendChild(link);
      body.appendChild(line);
    }
    card.appendChild(body);
    return card;
  }

  function restart(wrap) {
    var again = el('button', 'ma-link', 'להתחיל מחדש');
    again.type = 'button';
    again.addEventListener('click', function () { interacted = true; answers = {}; stepIndex = 0; started = false; render(); });
    wrap.appendChild(again);
  }

  function renderWhatsApp() {
    track('advisor_result', { use: 'business' });
    var wrap = el('div', 'ma-result');
    var title = heading('נמליץ בשיחה');
    wrap.appendChild(title);
    wrap.appendChild(el('p', 'ma-note', 'מכונה לבית קפה או למשרד בוחרים לפי כמות המשקאות ביום, המקום והחיבורים. כתבו לנו בוואטסאפ ונמליץ על המכונה המתאימה.'));
    var a = el('a', 'ma-button ma-button-wide', 'לשיחה בוואטסאפ');
    a.href = 'https://wa.me/' + root.getAttribute('data-whatsapp')
      + '?text=' + encodeURIComponent('היי, אשמח להמלצה על מכונת קפה לבית קפה או למשרד');
    a.target = '_blank'; a.rel = 'noopener';
    a.addEventListener('click', function () { track('advisor_whatsapp', { transport_type: 'beacon' }); });
    wrap.appendChild(a);
    restart(wrap);
    root.appendChild(wrap);
    focusHeading(title);
  }

  function renderResult() {
    var result = Engine.recommend(answers, catalog);
    if (result.route === 'whatsapp') return renderWhatsApp();
    track('advisor_result', { use: answers.use, milk: answers.milk, budget: answers.budget, count: result.keys.length });
    var wrap = el('div', 'ma-result');
    var title = heading(result.keys.length ? 'המכונות שמתאימות לך' : 'לא מצאנו מכונה מתאימה במלאי');
    wrap.appendChild(title);
    if (result.near) wrap.appendChild(el('p', 'ma-note', 'אין כרגע מכונה שמתאימה בדיוק לתקציב הזה. אלה הקרובות ביותר.'));
    if (result.needGrinder) wrap.appendChild(el('p', 'ma-note', 'למכונות האלה צריך גם מטחנת קפה.'));
    var cards = el('div', 'ma-cards');
    result.keys.forEach(function (k) {
      var m = catalog.filter(function (x) { return x.key === k; })[0];
      if (m) cards.appendChild(renderCard(m));
    });
    wrap.appendChild(cards);
    if (!result.keys.length) {
      var all = el('a', 'ma-button ma-button-wide', 'לכל מכונות הקפה');
      all.href = root.getAttribute('data-machines') || '/shop/';
      wrap.appendChild(all);
    } else if (root.getAttribute('data-quiz')) {
      var quiz = el('a', 'ma-link', 'לבחירת הקפה המדויק בשאלון הקפה');
      quiz.href = root.getAttribute('data-quiz');
      wrap.appendChild(el('br'));
      wrap.appendChild(quiz);
    }
    wrap.appendChild(el('br'));
    restart(wrap);
    root.appendChild(wrap);
    focusHeading(title);
  }

  function render() {
    root.textContent = '';
    if (stepIndex >= activeSteps().length) renderResult(); else renderStep();
  }

  // The coffee line is a bonus: the advisor never waits on it or fails with it.
  var coffeeUrl = root.getAttribute('data-coffee');
  if (coffeeUrl) {
    fetch(coffeeUrl)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (items) { coffee.items = Array.isArray(items) ? items : []; coffee.ready = true; })
      .catch(function () { /* machines still show, without the coffee line */ });
  }

  fetch(root.getAttribute('data-catalog'))
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (items) {
      catalog = Array.isArray(items) ? items : [];
      if (!catalog.length) throw new Error('empty catalog');
      render();
    })
    .catch(function () {
      root.textContent = '';
      var p = el('p', 'ma-error', 'משהו השתבש בטעינה. אפשר לראות את כל המכונות בחנות.');
      var a = el('a', 'ma-link', 'למכונות הקפה');
      a.href = root.getAttribute('data-machines') || '/shop/';
      root.appendChild(p); root.appendChild(a);
    });
})();
