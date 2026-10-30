/** Quiz screens. The rules themselves are in engine.js. */
(function () {
  'use strict';

  var root = document.getElementById('minuto-coffee-quiz');
  if (!root) return;

  var SIMPLE = 'simple', PREMIUM = 'premium';
  var STEPS = [
    { id: 'brew', title: 'איך מכינים קפה אצלך?', options: [
      ['auto', 'מכונה אוטומטית', 'לחיצה על כפתור והקפה מוכן'],
      ['combo', 'מכונת אספרסו עם מטחנה מובנית'],
      ['manual', 'מכונת אספרסו ידנית', 'עם ידית ומטחנה נפרדת'],
      ['moka', 'מקינטה'],
      ['filter', 'פילטר או V60'],
      ['press', 'פרנץ׳ פרס או חליטה קרה'],
    ] },
    { id: 'brand', title: 'איזו מכונה יש לך?', when: function (a) { return a.brew === 'auto'; }, options: [
      [SIMPLE, 'DeLonghi'], [SIMPLE, 'Siemens'], [SIMPLE, 'Philips'], [SIMPLE, 'Krups'], [SIMPLE, 'Saeco'], [SIMPLE, 'Gaggia'],
      [PREMIUM, 'Jura'], [PREMIUM, 'Melitta'], [PREMIUM, 'Nivona'], [SIMPLE, 'מכונה אחרת'],
    ] },
    { id: 'milk', title: 'עם חלב או בלי?', options: [
      ['none', 'בלי חלב'], ['cow', 'עם חלב רגיל'], ['alt', 'עם חלב צמחי', 'שיבולת שועל, סויה ודומיהם'],
    ] },
    { id: 'taste', title: 'אילו טעמים אהובים עליך?', options: [
      ['chocolate', 'שוקולד ואגוזים'], ['fruity', 'פירותי ורענן'], ['floral', 'פרחוני ועדין'], ['unknown', 'עוד לא בטוח/ה'],
    ] },
    { id: 'strength', title: 'כמה חזק?', options: [
      ['gentle', 'עדין'], ['balanced', 'מאוזן'], ['strong', 'חזק'], ['very_strong', 'חזק מאוד'],
    ] },
    { id: 'extra', title: 'יש בקשה מיוחדת?', options: [
      ['none', 'בלי העדפה'], ['light', 'קלייה בהירה'], ['natural', 'עיבוד נטורל'],
      ['noSour', 'בלי חמיצות בכלל'], ['decaf', 'נטול קפאין'],
    ] },
  ];

  var catalog = [];
  var answers = {};
  var stepIndex = 0;

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  }

  function activeSteps() {
    return STEPS.filter(function (s) { return !s.when || s.when(answers); });
  }

  function answer(step, value) {
    if (step.id === 'extra') {
      answers.light = value === 'light';
      answers.natural = value === 'natural';
      answers.noSour = value === 'noSour';
      answers.decaf = value === 'decaf';
    } else {
      answers[step.id] = value;
    }
    stepIndex += 1;
    render();
  }

  function renderStep() {
    var steps = activeSteps();
    var step = steps[stepIndex];
    var wrap = el('div', 'mq-step');
    wrap.appendChild(el('p', 'mq-progress', 'שאלה ' + (stepIndex + 1) + ' מתוך ' + steps.length));
    wrap.appendChild(el('h2', 'mq-title', step.title));
    var list = el('div', 'mq-options');
    step.options.forEach(function (o) {
      var b = el('button', 'mq-option');
      b.type = 'button';
      b.appendChild(el('span', 'mq-option-label', o[1]));
      if (o[2]) b.appendChild(el('span', 'mq-option-hint', o[2]));
      b.addEventListener('click', function () { answer(step, o[0]); });
      list.appendChild(b);
    });
    wrap.appendChild(list);
    if (stepIndex > 0) {
      var back = el('button', 'mq-link', 'חזרה');
      back.type = 'button';
      back.addEventListener('click', function () { stepIndex -= 1; render(); });
      wrap.appendChild(back);
    }
    root.appendChild(wrap);
  }

  function renderCard(c) {
    var card = el('div', 'mq-card');
    if (c.image) {
      var img = el('img', 'mq-photo');
      img.src = c.image; img.alt = c.name; img.loading = 'lazy';
      card.appendChild(img);
    }
    var body = el('div', 'mq-card-body');
    body.appendChild(el('h3', 'mq-name', c.name));
    if (c.why) body.appendChild(el('p', 'mq-why', c.why));
    if (c.price) body.appendChild(el('p', 'mq-price', c.price));
    var a = el('a', 'mq-button', c.cart ? 'הוספה לסל' : 'לבחירת גודל וטחינה');
    a.href = c.cart || c.url;
    body.appendChild(a);
    card.appendChild(body);
    return card;
  }

  function renderResult() {
    var available = {
      all: catalog.map(function (c) { return c.key; }),
      light: catalog.filter(function (c) { return c.light; }).map(function (c) { return c.key; }),
    };
    var keys = window.MinutoQuizEngine.recommend(answers, available);
    var wrap = el('div', 'mq-result');
    wrap.appendChild(el('h2', 'mq-title', 'הקפה שמתאים לך'));
    var cards = el('div', 'mq-cards');
    keys.forEach(function (k) {
      var c = catalog.filter(function (x) { return x.key === k; })[0];
      if (c) cards.appendChild(renderCard(c));
    });
    wrap.appendChild(cards);
    var again = el('button', 'mq-link', 'להתחיל מחדש');
    again.type = 'button';
    again.addEventListener('click', function () { answers = {}; stepIndex = 0; render(); });
    wrap.appendChild(again);
    root.appendChild(wrap);
  }

  function render() {
    root.textContent = '';
    if (stepIndex >= activeSteps().length) renderResult(); else renderStep();
  }

  fetch(root.getAttribute('data-catalog'))
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (items) {
      catalog = items;
      if (window.MinutoQuizDemo) { answers = window.MinutoQuizDemo; stepIndex = 99; }
      render();
    })
    .catch(function () {
      var p = el('p', 'mq-error', 'משהו השתבש בטעינה. אפשר לראות את כל הקפה בחנות.');
      var a = el('a', 'mq-link', 'לחנות');
      a.href = '/shop/';
      root.appendChild(p); root.appendChild(a);
    });
})();
