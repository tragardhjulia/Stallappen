/* Loddby Gård Stallappen: all logik. Ingen byggprocess, inga beroenden. */
(function () {
  'use strict';
  var C = window.CONFIG || {};
  var TZ = 'Europe/Stockholm';

  // ---------------------------------------------------------------- hjälpare
  function $(s, el) { return (el || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var WD = ['sön', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör'];
  var WDL = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
  var MO = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
  function pd(s) { return new Date(s + 'T12:00:00Z'); }
  function addD(s, n) { var d = pd(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function dow(s) { return pd(s).getUTCDay(); }
  function fmtDay(s) { var d = pd(s); return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MO[d.getUTCMonth()]; }
  function fmtDayLong(s) { var d = pd(s); return WDL[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MO[d.getUTCMonth()]; }
  function mondayOf(s) { return addD(s, -((dow(s) + 6) % 7)); }
  function tm(s) { return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10); }
  function dur(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }
  function nowHM() {
    try {
      return new Date().toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':');
    } catch (e) { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  }
  function toast(msg) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  // ---------------------------------------------------------------- tillstånd
  var S = null;            // allt från app_bootstrap
  var token = store.get('lg_token');
  var tab = 'idag';        // idag | schema | parmen | inkorg | tid
  var sub = 'instr';       // Pärmen: instr | horses | docs
  var filter = null;       // 'mine' | 'all'
  var dayOff = 0;          // 0 idag, 1 imorgon
  var weekOff = 0;
  var timeWho = 'me';      // Tid-fliken (familj): 'me' | 'all' | personId
  var offline = false;
  var lastJson = '';
  var seenMsg = null;      // id:n vi redan känt till
  var autoRead = {};
  var liveSheet = null;
  var WX = null, wxAt = 0, WXkey = '';
  var app = $('#app');

  // ---------------------------------------------------------------- nätverk
  function rpc(fn, args) {
    if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) {
      return Promise.reject(new Error('Appen är inte kopplad till någon databas ännu. Fyll i config.js (se README).'));
    }
    return fetch(C.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: C.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {})
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.message) || ('Fel ' + r.status));
          err.code = data && data.code;
          if (err.code === '28000') { logout(true); }
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error('Ingen kontakt med servern. Kolla uppkopplingen.');
      err.offline = true; throw err;
    });
  }

  function act(action, args) {
    return rpc('app_act', { p_token: token, p_action: action, p_args: args || {} });
  }
  function doAct(action, args, opts) {
    opts = opts || {};
    return act(action, args).then(function (r) {
      return refresh().then(function () { if (opts.ok) toast(opts.ok); return r; });
    }).catch(function (e) { toast(e.message); throw e; });
  }

  function refresh(quiet) {
    if (!token) return Promise.resolve();
    return rpc('app_bootstrap', { p_token: token }).then(function (d) {
      var was = offline; offline = false;
      var j = JSON.stringify(d);
      var changed = j !== lastJson;
      lastJson = j; S = d;
      if (!filter) filter = S.me.role === 'familj' ? 'all' : 'mine';
      newMessageToast();
      setBadge();
      if (changed || was || !$('.top')) render();
      if (changed && liveSheet) { liveSheet(); }
    }).catch(function (e) {
      if (e.offline) { if (!offline) { offline = true; if (S) render(); } }
      else if (!quiet) toast(e.message);
      if (!S && !e.offline && e.code !== '28000') { showLogin(e.message); }
    });
  }

  function newMessageToast() {
    var ids = unreadMsgs().map(function (m) { return m.id; });
    if (seenMsg === null) { seenMsg = {}; ids.forEach(function (i) { seenMsg[i] = 1; }); return; }
    var fresh = unreadMsgs().filter(function (m) { return !seenMsg[m.id]; });
    fresh.forEach(function (m) { seenMsg[m.id] = 1; });
    if (fresh.length && !document.hidden) {
      var p = person(fresh[0].from);
      toast('Nytt meddelande från ' + (p ? p.name : 'någon'));
    }
  }

  function setBadge() {
    var n = unreadMsgs().length;
    try { if (navigator.setAppBadge) { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
  }

  // ---------------------------------------------------------------- data-hjälp
  function person(id) { return S && S.people.filter(function (p) { return p.id === id; })[0] || null; }
  function isFam() { return S && S.me.role === 'familj'; }
  function av(id, cls) {
    var p = person(id);
    if (!p) return '<span class="av ' + (cls || '') + '" style="background:#8a8f88">?</span>';
    return '<span class="av ' + (cls || '') + '" style="background:' + esc(p.color) + '" title="' + esc(p.name) + '">' + esc(p.initials) + '</span>';
  }
  function unreadMsgs() {
    if (!S) return [];
    return S.messages.filter(function (m) { return m.to.indexOf(S.me.id) >= 0 && !m.reads[S.me.id]; });
  }
  function openTaskCount() {
    if (!S) return 0;
    return S.tasks.filter(function (t) { return t.day === S.today && !t.done && t.tpl !== 'utfodra' && (t.who === S.me.id || (!t.who && true)); }).length;
  }
  function feedTimes() { return (S.settings.feed_times || []).slice().sort(); }
  function clockOf(id) { return S.clock.filter(function (c) { return c.who === id; })[0]; }
  function templ(id) { return S.templates.filter(function (t) { return t.id === id; })[0]; }
  function instr(id) { return S.instructions.filter(function (i) { return i.id === id; })[0]; }
  function opt(list, sel, fn) {
    return list.map(function (x) { var o = fn(x); return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(sel) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  function peopleOpts(sel, none) {
    return (none ? '<option value="">' + esc(none) + '</option>' : '') + opt(S.people, sel, function (p) { return [p.id, p.name]; });
  }

  // ---------------------------------------------------------------- väder
  function farmPos() {
    var la = S && S.settings.lat != null ? S.settings.lat : C.LAT, lo = S && S.settings.lon != null ? S.settings.lon : C.LON;
    return (la == null || lo == null) ? null : { lat: la, lon: lo };
  }
  function boxList() { var n = Number(S.settings.box_count || 5), r = []; for (var i = 1; i <= n; i++) r.push(i); return r; }
  function armed(el, label) {
    if (el.dataset.armed) return true;
    el.dataset.armed = '1'; el.dataset.orig = el.textContent; el.textContent = label || 'Tryck igen för att bekräfta';
    setTimeout(function () { if (el.isConnected) { delete el.dataset.armed; el.textContent = el.dataset.orig; } }, 4000);
    return false;
  }
  function loadWeather() {
    var pos = farmPos(); if (!pos) return;
    var key = pos.lat + ',' + pos.lon; if (key !== WXkey) { WXkey = key; WX = null; wxAt = 0; }
    if (WX && Date.now() - wxAt < 30 * 60e3) return;
    wxAt = Date.now();
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(pos.lat) + '&longitude=' + encodeURIComponent(pos.lon) +
      '&hourly=temperature_2m,precipitation,wind_gusts_10m&wind_speed_unit=ms&timezone=Europe%2FStockholm&forecast_days=2';
    fetch(u).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.hourly && j.hourly.time) { WX = j.hourly; if (S && tab === 'idag') render(); }
    }).catch(function () { wxAt = Date.now() - 25 * 60e3; /* försök igen om 5 min, visa inget fel */ });
  }
  function weatherInfo() {
    if (!WX || !S) return null;
    var now = parseInt(nowHM().slice(0, 2), 10), rain = 0, gust = 0, temp = null, any = false;
    for (var i = 0; i < WX.time.length; i++) {
      var t = WX.time[i];
      if (t.slice(0, 10) !== S.today) continue;
      var h = parseInt(t.slice(11, 13), 10);
      if (h === now) temp = WX.temperature_2m[i];
      if (h >= now && h <= 18) { any = true; rain += WX.precipitation[i] || 0; gust = Math.max(gust, WX.wind_gusts_10m[i] || 0); }
    }
    if (!any && temp == null) return null;
    var rl = Number(S.settings.rain_limit || 5), wl = Number(S.settings.wind_limit || 10);
    return { rain: rain, gust: gust, temp: temp, bad: rain >= rl || gust >= wl, rainBad: rain >= rl, windBad: gust >= wl };
  }
  function weatherCard() {
    var w = weatherInfo(); if (!w || dayOff) return '';
    var parts = [];
    if (w.rain >= 0.5) parts.push(Math.round(w.rain * 10) / 10 + ' mm regn fram till 18');
    if (w.gust >= 5) parts.push('byar upp till ' + Math.round(w.gust) + ' m/s');
    var line = parts.length ? parts.join(' · ') : 'Inget regn eller blåst väntas före 18';
    var temp = w.temp != null ? Math.round(w.temp) + '° nu' : '';
    if (!w.bad) return '<div class="card wx calm"><div class="row"><div class="sp"><div class="big">Väder ' + esc(temp) + '</div><div class="small mute">' + esc(line) + '</div></div></div></div>';
    return '<div class="card wx"><div class="big">' + (w.rainBad ? 'Regn väntas' : 'Blåsigt') + ' i eftermiddag</div>' +
      '<div class="small" style="margin:2px 0 10px">' + esc(line) + (temp ? ' · ' + esc(temp) : '') + '</div>' +
      (isFam() ? '<button class="btn" data-act="bringIn">Ta in 15:30?</button>' : '<div class="small mute">Familjen kan flytta fram insläppet.</div>') + '</div>';
  }

  // ---------------------------------------------------------------- vyer
  var ICON = {
    idag: '<svg viewBox="0 0 24 24"><path d="M4 12l8-7 8 7"/><path d="M6 10.5V20h12v-9.5"/></svg>',
    schema: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    parmen: '<svg viewBox="0 0 24 24"><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z"/><path d="M8 17h11"/></svg>',
    inkorg: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>',
    tid: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>'
  };

  function render() {
    if (!S) return;
    var y = window.scrollY;
    var titles = { idag: fmtDayLong(addD(S.today, dayOff)), schema: 'Schema', parmen: 'Pärmen', inkorg: 'Inkorg', tid: 'Tid', inst: 'Inställningar' };
    var unread = unreadMsgs().length, open = openTaskCount();
    var body = ({ idag: viewToday, schema: viewSchema, parmen: viewParmen, inkorg: viewInbox, tid: viewTime, inst: viewSettings })[tab]();
    var navs = [['idag', 'Idag', open], ['schema', 'Schema', pendingSwaps()], ['parmen', 'Pärmen', 0], ['inkorg', 'Inkorg', unread], ['tid', 'Tid', 0]];
    app.innerHTML =
      (offline ? '<div class="offline">Ingen uppkoppling. Du ser senast hämtade uppgifter.</div>' : '') +
      '<header class="top"><div class="t"><div class="farm">' + esc(C.FARM || 'Stallappen') + '</div><h1>' + esc(titles[tab]) + '</h1></div>' +
      (isFam() ? (tab === 'inst' ? '<button class="btn soft sm" data-act="settingsBack">Klar</button>' : '<button class="btn soft sm" data-act="settings" aria-label="Inställningar" style="font-size:18px;padding:4px 12px">⚙</button>') : '') +
      '<button class="av lg" style="background:' + esc(S.me.color) + '" data-act="menu" aria-label="Meny">' + esc(S.me.initials) + '</button></header>' +
      '<main class="view">' + body + '</main>' +
      ((isFam() && (tab === 'idag' || tab === 'schema')) ? '<button class="fab" data-act="' + (tab === 'schema' ? 'addShift' : 'addMenu') + '">+ Lägg till</button>' : '') +
      '<nav class="nav">' + navs.map(function (n) {
        return '<button class="' + (tab === n[0] ? 'on' : '') + '" data-act="tab" data-tab="' + n[0] + '">' + ICON[n[0]] + '<span>' + n[1] + '</span>' +
          (n[2] ? '<span class="badge">' + n[2] + '</span>' : '') + '</button>';
      }).join('') + '</nav>';
    window.scrollTo(0, y);
    if (tab === 'idag') loadWeather();
    if (tab === 'inkorg') autoMarkRead();
  }

  // ---- Idag
  function periodOf(due) {
    var m = tm(due);
    return m < 9 * 60 ? 0 : m < 12 * 60 ? 1 : m < 17 * 60 ? 2 : 3;
  }
  var PNAME = ['Morgon', 'Förmiddag', 'Eftermiddag', 'Kväll'];

  function feedPanel(day) {
    var times = feedTimes(), now = nowHM(), isToday = day === S.today;
    var byDue = {};
    S.tasks.forEach(function (t) { if (t.day === day && t.tpl === 'utfodra') byDue[t.due] = t; });
    var next = null;
    if (isToday) times.forEach(function (t) { if (!next && t > now && !(byDue[t] && byDue[t].done)) next = t; });
    var head;
    if (!isToday) {
      head = '<div class="clock">' + esc(times[0] || '--:--') + '</div><div class="cd">Första utfodringen i morgon</div>';
    } else if (next) {
      var diff = tm(next) - tm(now);
      head = '<div class="clock">' + next + '</div><div class="cd">Nästa utfodring om ' + dur(diff) + '</div>';
    } else {
      var late = times.filter(function (t) { return t <= now && byDue[t] && !byDue[t].done; });
      head = late.length
        ? '<div class="clock" style="color:var(--warn)">' + late[0] + '</div><div class="cd late-t">Inte markerad som gjord</div>'
        : '<div class="clock">Klart</div><div class="cd">Alla utfodringar gjorda för i dag</div>';
    }
    var chips = times.map(function (t) {
      var task = byDue[t], done = task && task.done;
      var cls = 'fchip' + (done ? ' done' : '') + (isToday && !done && t <= now ? ' late' : '') + (t === next ? ' next' : '');
      return '<button class="' + cls + '"' + (task ? ' data-act="toggle" data-id="' + task.id + '"' : ' disabled') + ' aria-label="Utfodring ' + t + '">' + t +
        '<small>' + (done ? '✓ ' + (person(task.doneBy) ? esc(person(task.doneBy).name) : '') : (task && task.who && person(task.who) ? esc(person(task.who).name) : '–')) + '</small></button>';
    }).join('');
    var slot = isToday ? next : times[0], si = slot ? times.indexOf(slot) : -1, amounts = '';
    if (si >= 0) {
      var lines = S.horses.filter(function (h) { return h.feed && h.feed[si]; }).map(function (h) { return '<div class="row"><b style="min-width:84px">' + esc(h.name) + '</b><span>' + esc(h.feed[si]) + '</span></div>'; });
      if (lines.length) amounts = '<div class="small" style="margin-top:12px;display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--line);padding-top:10px"><div class="mute" style="font-weight:600">Kl ' + slot + ' får de</div>' + lines.join('') + '</div>';
    }
    return '<div class="card feed"><div class="row"><h3 class="sp">Utfodring</h3>' + (isFam() ? '<button class="btn soft sm" data-act="feedTimes">Ändra tider</button>' : '') + '</div><div style="margin-top:8px">' + head + '</div>' + amounts + '<div class="feeds">' + chips + '</div>' +
      '<details class="ft"><summary>Fodertabell</summary>' + feedTable() + '</details></div>';
  }
  function feedTable() {
    var times = feedTimes();
    var rows = S.horses.map(function (h) {
      return '<tr><td><b>' + esc(h.name) + '</b></td>' + times.map(function (t, i) { return '<td>' + (esc(h.feed && h.feed[i]) || '–') + '</td>'; }).join('') + '<td>' + (esc(h.extra) || '–') + '</td></tr>';
    }).join('');
    var empty = S.horses.every(function (h) { return !h.feed || !Object.keys(h.feed).length; });
    return '<div class="tablewrap"><table class="ftab"><tr><th>Häst</th>' + times.map(function (t) { return '<th>' + t + '</th>'; }).join('') + '<th>Tillägg</th></tr>' + rows + '</table></div>' +
      (empty ? '<p class="small mute">' + (isFam() ? 'Inga fodermängder är ifyllda än. Lägg in dem under Pärmen > Hästar > Ändra.' : 'Inga fodermängder är ifyllda än.') + '</p>' : '');
  }

  function taskRow(t) {
    var who = t.who ? av(t.who, 'sm') : '<span class="chip hay">Öppen</span>';
    var late = t.day === S.today && !t.done && t.due < nowHM();
    var rchip = t.resp === 'vantar' ? ' <span class="chip hay">Väntar på svar</span>' : t.resp === 'nej' ? ' <span class="chip warn">Kan inte</span>' : '';
    return '<div class="task' + (t.done ? ' done' : '') + '"><button class="chk" data-act="toggle" data-id="' + t.id + '" aria-label="Klar">✓</button>' +
      '<button class="tb" data-act="task" data-id="' + t.id + '"><div class="tt">' + esc(t.title) + (t.target ? ' <span class="mute" style="font-weight:500">· ' + esc(t.target) + '</span>' : '') + '</div>' +
      '<div class="tm' + (late ? ' late-t' : '') + '">' + t.due + (t.done && t.doneAt ? ' · klart ' + esc(t.doneAt) : '') + (t.note ? ' · ' + esc(t.note) : '') + rchip + '</div></button>' + who + '</div>';
  }

  function requestCards() {
    var out = [], mine = S.tasks.filter(function (t) { return t.who === S.me.id && t.resp === 'vantar' && !t.done; });
    if (mine.length) {
      out.push('<div class="sec">Kan du ta de här?</div>');
      mine.slice(0, 8).forEach(function (t) {
        out.push('<div class="card" style="background:var(--hay-soft);border-color:var(--hay)"><b>' + esc(t.title) + (t.target ? ' · ' + esc(t.target) : '') + '</b><div class="small">' + esc(fmtDayLong(t.day)) + ' kl ' + t.due + (t.addedBy && person(t.addedBy) ? ' · från ' + esc(person(t.addedBy).name) : '') + (t.note ? ' · ' + esc(t.note) : '') + '</div>' +
          '<div class="two" style="margin-top:10px"><button class="btn" data-act="respondYes" data-id="' + t.id + '">Jag kan</button><button class="btn danger" data-act="respondNo" data-id="' + t.id + '">Kan inte</button></div></div>');
      });
    }
    if (isFam()) {
      var wait = S.tasks.filter(function (t) { return t.who && t.who !== S.me.id && (t.resp === 'vantar' || t.resp === 'nej') && !t.done; });
      if (wait.length) {
        out.push('<div class="sec">Uppgifter som väntar på svar</div>');
        wait.slice(0, 10).forEach(function (t) {
          var p = person(t.who), prop = t.propDay || t.propDue ? 'Föreslår ' + fmtDay(t.propDay || t.day) + ' kl ' + (t.propDue || t.due) : '';
          out.push('<div class="card"><div class="row">' + av(t.who, 'sm') + '<div class="sp"><b>' + esc(t.title) + (t.target ? ' · ' + esc(t.target) : '') + '</b><div class="small mute">' + esc(p ? p.name : '') + ' · ' + esc(fmtDay(t.day)) + ' kl ' + t.due + '</div>' +
            (t.respNote ? '<div class="small">“' + esc(t.respNote) + '”</div>' : '') + (prop ? '<div class="small"><b>' + esc(prop) + '</b></div>' : '') + '</div>' +
            (t.resp === 'nej' ? '<span class="chip warn">Kan inte</span>' : '<span class="chip hay">Väntar</span>') + '</div>' +
            '<div class="row" style="margin-top:10px;gap:8px">' + (prop ? '<button class="btn sm" data-act="acceptProp" data-id="' + t.id + '">Godkänn förslaget</button>' : '') + '<button class="btn soft sm" data-act="task" data-id="' + t.id + '">Ändra / tilldela om</button></div></div>');
        });
      }
    }
    return out.join('');
  }

  function viewToday() {
    var day = addD(S.today, dayOff);
    var all = S.tasks.filter(function (t) { return t.day === day && t.tpl !== 'utfodra'; });
    var mine = all.filter(function (t) { return filter === 'all' || t.who === S.me.id || !t.who; });
    var out = [];
    out.push('<div class="seg"><button class="' + (dayOff === 0 ? 'on' : '') + '" data-act="day" data-n="0">Idag</button><button class="' + (dayOff === 1 ? 'on' : '') + '" data-act="day" data-n="1">Imorgon</button></div>');
    out.push(weatherCard());
    out.push(requestCards());
    out.push(feedPanel(day));
    out.push('<div class="seg"><button class="' + (filter === 'mine' ? 'on' : '') + '" data-act="filter" data-v="mine">Mina</button><button class="' + (filter === 'all' ? 'on' : '') + '" data-act="filter" data-v="all">Alla</button></div>');
    var doneN = mine.filter(function (t) { return t.done; }).length;
    if (mine.length) out.push('<div class="row small mute"><div class="sp">' + doneN + ' av ' + mine.length + ' klara</div></div>');
    for (var p = 0; p < 4; p++) {
      var list = mine.filter(function (t) { return periodOf(t.due) === p; });
      if (!list.length) continue;
      out.push('<div class="sec">' + PNAME[p] + '</div>');
      list.forEach(function (t) { out.push(taskRow(t)); });
    }
    if (!mine.length) out.push('<div class="empty">Inga uppgifter ' + (filter === 'mine' ? 'på dig ' : '') + (dayOff ? 'i morgon' : 'idag') + '.' + (isFam() ? '<br>Tryck på “Lägg till” för att lägga in en rutin eller uppgift.' : '') + '</div>');
    return out.join('');
  }

  // ---- Schema
  function viewSchema() {
    var start = addD(mondayOf(S.today), weekOff * 7), out = [];
    var d1 = pd(start), d2 = pd(addD(start, 6));
    out.push('<div class="row"><button class="btn soft sm" data-act="week" data-n="-1" aria-label="Förra veckan">‹</button><div class="sp" style="text-align:center;font-weight:700">' +
      d1.getUTCDate() + ' ' + MO[d1.getUTCMonth()] + ' – ' + d2.getUTCDate() + ' ' + MO[d2.getUTCMonth()] + '</div><button class="btn soft sm" data-act="week" data-n="1" aria-label="Nästa vecka">›</button></div>');
    out.push('<div class="seg"><button class="' + (filter === 'mine' ? 'on' : '') + '" data-act="filter" data-v="mine">Mina pass</button><button class="' + (filter === 'all' ? 'on' : '') + '" data-act="filter" data-v="all">Alla</button></div>');
    out.push(swapSection());
    var total = 0, any = false;
    for (var i = 0; i < 7; i++) {
      var day = addD(start, i);
      var list = S.shifts.filter(function (s) { return s.day === day && (filter === 'all' || s.who === S.me.id); });
      list.forEach(function (s) { if (s.who === S.me.id) total += tm(s.end) - tm(s.start); });
      if (list.length) any = true;
      out.push('<div class="day' + (day === S.today ? ' today' : '') + '"><h3>' + esc(fmtDayLong(day)) + (day === S.today ? ' <span class="chip">idag</span>' : '') + '</h3>' +
        (list.length ? list.map(function (s) {
          return '<div class="shift">' + av(s.who, 'sm') + '<div class="sp"><b>' + s.start + '–' + s.end + '</b> <span class="mute">' + esc(person(s.who) ? person(s.who).name : '') + '</span></div>' +
            (!isFam() && s.who === S.me.id && s.day >= S.today ? '<button class="btn soft sm" data-act="swapAsk" data-id="' + s.id + '">Byt / ledig</button>' : '') +
            (isFam() ? '<button class="btn danger sm" data-act="delShift" data-id="' + s.id + '">Ta bort</button>' : '') + '</div>';
        }).join('') : '<div class="small mute">Inga pass</div>') + '</div>');
    }
    if (total) out.splice(2, 0, '<div class="small mute">Dina planerade timmar den här veckan: <b>' + dur(total) + '</b></div>');
    return out.join('');
  }

  // ---- Pärmen
  function viewParmen() {
    var out = ['<div class="seg"><button class="' + (sub === 'instr' ? 'on' : '') + '" data-act="sub" data-v="instr">Instruktioner</button><button class="' + (sub === 'horses' ? 'on' : '') + '" data-act="sub" data-v="horses">Hästar</button><button class="' + (sub === 'docs' ? 'on' : '') + '" data-act="sub" data-v="docs">Dokument</button></div>'];
    if (sub === 'instr') {
      var cats = {};
      S.instructions.forEach(function (i) { (cats[i.cat || 'Övrigt'] = cats[i.cat || 'Övrigt'] || []).push(i); });
      Object.keys(cats).sort().forEach(function (c) {
        out.push('<div class="sec">' + esc(c) + '</div>');
        cats[c].forEach(function (i) {
          var done = (S.checks[i.id] || []).filter(Boolean).length;
          out.push('<button class="card" style="text-align:left;width:100%" data-act="instr" data-id="' + esc(i.id) + '"><div class="row"><div class="sp"><b>' + esc(i.title) + '</b><div class="small mute">' + i.steps.length + ' steg' + (i.minutes ? ' · ca ' + i.minutes + ' min' : '') + '</div></div>' +
            (done ? '<span class="chip">' + done + '/' + i.steps.length + '</span>' : '') + '</div></button>');
        });
      });
      if (!S.instructions.length) out.push('<div class="empty">Inga instruktioner än.' + (isFam() ? '<br>Lägg till din första, till exempel hur man mockar en box eller tar in hästarna.' : '') + '</div>');
      if (isFam()) out.push('<button class="btn ghost block" data-act="editInstr" data-id="">+ Ny instruktion</button>');
    } else if (sub === 'horses') {
      S.horses.forEach(function (h) {
        var rows = [['Hage', h.paddock], ['Hö', h.hay], ['Kraftfoder', h.grain], ['Tillägg', h.extra], ['Täcke', h.blanket], ['Att tänka på', h.notes]].filter(function (r) { return r[1]; });
        out.push('<div class="card horse"><h3>' + esc(h.name) + (h.box ? ' <span class="chip hay">Box ' + h.box + '</span>' : '') + '</h3>' +
          (h.descr ? '<div class="small mute">' + esc(h.descr) + '</div>' : '') +
          (rows.length ? '<div class="kv">' + rows.map(function (r) { return '<b>' + r[0] + '</b><span>' + esc(r[1]) + '</span>'; }).join('') + '</div>' : '<div class="small mute" style="margin-top:6px">Inget ifyllt än.</div>') +
          (isFam() ? '<div style="margin-top:10px"><button class="btn soft sm" data-act="editHorse" data-id="' + esc(h.id) + '">Ändra</button></div>' : '') + '</div>');
      });
      var used = S.horses.map(function (h) { return h.box; });
      var free = boxList().filter(function (b) { return used.indexOf(b) < 0; });
      if (free.length) out.push('<div class="small mute">Lediga boxar: ' + free.join(', ') + '</div>');
    } else {
      S.docs.forEach(function (d) {
        out.push('<div class="card"><div class="row"><div class="sp"><b>' + esc(d.name) + '</b>' + (d.cat ? ' <span class="chip hay">' + esc(d.cat) + '</span>' : '') +
          (d.note ? '<div class="small" style="white-space:pre-wrap;margin-top:6px;overflow-wrap:anywhere">' + esc(d.note) + '</div>' : '') +
          (d.url ? '<div style="margin-top:8px"><a class="btn soft sm" style="display:inline-block;text-decoration:none;line-height:22px" href="' + esc(d.url) + '" target="_blank" rel="noopener">Öppna</a></div>' : '') + '</div>' +
          (isFam() ? '<button class="btn soft sm" data-act="editDoc" data-id="' + d.id + '">Ändra</button>' : '') + '</div></div>');
      });
      if (!S.docs.length) out.push('<div class="empty">Inga dokument än.' + (isFam() ? '<br>Lägg in en länk (till exempel ett Google Drive-dokument) eller skriv text direkt.' : '') + '</div>');
      if (isFam()) out.push('<button class="btn ghost block" data-act="editDoc" data-id="">+ Nytt dokument</button>');
    }
    return out.join('');
  }

  // ---- Inkorg
  function viewInbox() {
    var out = [];
    if (isFam() || true) out.push('<button class="btn block" data-act="compose">Nytt meddelande</button>');
    if (!S.messages.length) out.push('<div class="empty">Inga meddelanden.</div>');
    S.messages.forEach(function (m) {
      var mineSent = m.from === S.me.id, incoming = m.to.indexOf(S.me.id) >= 0;
      var read = m.reads[S.me.id], unread = incoming && !read;
      var when = new Date(m.at * 1000).toLocaleString('sv-SE', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      var body = '<div class="card msg' + (unread ? ' unread' : '') + '"><div class="row">' + av(m.from, 'sm') + '<div class="sp"><b>' + esc(person(m.from) ? person(m.from).name : '?') + '</b>' +
        (mineSent ? ' <span class="mute small">till ' + esc(m.to.map(function (id) { return person(id) ? person(id).name : '?'; }).join(', ')) + '</span>' : '') + '</div><span class="small mute">' + esc(when) + '</span></div>' +
        '<p>' + esc(m.body) + '</p>';
      if (m.linkType === 'task' && incoming) body += '<button class="btn soft sm" data-act="goToday">Visa i Idag</button> ';
      if (m.linkType === 'swap') body += '<button class="btn soft sm" data-act="goSwap">Visa i Schema</button> ';
      if (unread && m.ack) body += '<button class="btn sm" data-act="read" data-id="' + m.id + '">Jag har läst</button>';
      else if (incoming && read) body += '<span class="small mute">Läst ✓</span>';
      if (mineSent && m.ack) {
        body += '<div class="readers">' + m.to.map(function (id) {
          var r = m.reads[id], p = person(id);
          return '<span class="chip ' + (r ? '' : 'warn') + '">' + esc(p ? p.name : '?') + (r ? ' ✓ ' + new Date(r * 1000).toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : ' ej läst') + '</span>';
        }).join('') + '</div>';
      }
      out.push(body + '</div>');
    });
    return out.join('');
  }
  function autoMarkRead() {
    unreadMsgs().forEach(function (m) {
      if (!m.ack && !autoRead[m.id]) { autoRead[m.id] = 1; act('mark_read', { id: m.id }).then(function () { return refresh(true); }, function () { delete autoRead[m.id]; }); }
    });
  }

  // ---- Tid
  function entryMin(e) { return tm(e.end) - tm(e.start); }
  function viewTime() {
    var out = [], me = S.me, mine = clockOf(me.id);
    if (mine) {
      var el = Math.floor(Date.now() / 1000 - mine.epoch) / 60;
      out.push('<div class="card"><div class="small mute">Instämplad sedan ' + esc(mine.since) + '</div><div class="sum" style="margin:6px 0 12px">' + dur(el) + '</div><button class="btn block" data-act="clockOut">Stämpla ut</button></div>');
    } else {
      out.push('<div class="card"><h3>Inte instämplad</h3><button class="btn block" style="margin-top:10px" data-act="clockIn">Stämpla in</button></div>');
    }
    if (isFam()) {
      var on = S.clock.filter(function (c) { return c.who !== me.id; });
      if (on.length) out.push('<div class="small mute">Instämplade nu: ' + on.map(function (c) { return esc(person(c.who) ? person(c.who).name : '?') + ' sedan ' + esc(c.since); }).join(', ') + '</div>');
      out.push('<div class="pill-list"><button class="pill' + (timeWho === 'me' ? ' on' : '') + '" data-act="twho" data-v="me">Jag</button><button class="pill' + (timeWho === 'all' ? ' on' : '') + '" data-act="twho" data-v="all">Alla</button>' +
        S.people.filter(function (p) { return p.id !== me.id; }).map(function (p) { return '<button class="pill' + (timeWho === p.id ? ' on' : '') + '" data-act="twho" data-v="' + p.id + '">' + esc(p.name) + '</button>'; }).join('') + '</div>');
    }
    var who = isFam() ? timeWho : 'me';
    var list = S.time.filter(function (e) { return who === 'all' || e.who === (who === 'me' ? me.id : who); });
    var wk = mondayOf(S.today), wsum = 0, msum = 0, ym = S.today.slice(0, 7);
    list.forEach(function (e) { if (e.day >= wk && e.day <= addD(wk, 6)) wsum += entryMin(e); if (e.day.slice(0, 7) === ym) msum += entryMin(e); });
    out.push('<div class="two"><div class="card"><div class="small mute">Den här veckan</div><div class="sum" style="margin-top:6px;font-size:28px">' + dur(wsum) + '</div></div><div class="card"><div class="small mute">' + MO[pd(S.today).getUTCMonth()] + '</div><div class="sum" style="margin-top:6px;font-size:28px">' + dur(msum) + '</div></div></div>');
    out.push('<button class="btn ghost block" data-act="addTime">+ Lägg in tid i efterhand</button><button class="btn block" data-act="exportSheet">Ladda ner Excel</button>');
    out.push('<div class="sec">Historik</div>');
    if (!list.length) out.push('<div class="empty">Ingen tid registrerad än.</div>');
    list.slice(0, 60).forEach(function (e) {
      out.push('<div class="shift">' + (who === 'all' || (isFam() && who !== 'me') ? av(e.who, 'sm') : '') + '<div class="sp"><b>' + esc(fmtDay(e.day)) + '</b> ' + e.start + '–' + e.end + ' <span class="mute">· ' + dur(entryMin(e)) + (e.note ? ' · ' + esc(e.note) : '') + '</span></div>' +
        (isFam() ? '<button class="btn danger sm" data-act="delTime" data-id="' + e.id + '">Ta bort</button>' : '') + '</div>');
    });
    return out.join('');
  }

  // ---------------------------------------------------------------- ark (sheets)
  function openSheet(html, opts) {
    closeSheet();
    var el = document.createElement('div');
    el.id = 'sheet'; el.className = 'sheet-wrap';
    el.innerHTML = '<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet' + (opts && opts.full ? ' full' : '') + '" role="dialog" aria-modal="true"><div class="sheet-h"><button class="x" data-act="closeSheet" aria-label="Stäng">✕</button></div><div class="sheet-b">' + html + '</div></div>';
    document.body.appendChild(el);
  }
  function setSheet(html) { var b = $('#sheet .sheet-b'); if (b) b.innerHTML = html; }
  function closeSheet() { liveSheet = null; var el = $('#sheet'); if (el) el.remove(); }

  function F(name, html, submit) {
    return '<form data-form="' + name + '" class="stack" autocomplete="off">' + html + '<button class="btn block" type="submit" style="margin-top:8px">' + (submit || 'Spara') + '</button></form>';
  }
  function fd(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (e) {
      if (!e.name) return;
      if (e.type === 'checkbox') { if (e.dataset.multi) { (o[e.name] = o[e.name] || []); if (e.checked) o[e.name].push(e.value); } else o[e.name] = e.checked; }
      else o[e.name] = e.value;
    });
    return o;
  }

  // ---- menyn
  function menuSheet() {
    var h = '<div class="row" style="margin:6px 0 14px">' + av(S.me.id, 'lg') + '<div class="sp"><h2 style="margin:0">' + esc(S.me.name) + '</h2><div class="small mute">' + (S.me.role === 'familj' ? 'Familj' : 'Skötare') + (S.me.title ? ' · ' + esc(S.me.title) : '') + '</div></div></div><div class="stack">';
    h += '<button class="btn soft block" data-act="changePin">Byt PIN</button>';
    if (isFam()) h += '<button class="btn soft block" data-act="settings">Inställningar</button>';
    h += '<button class="btn danger block" data-act="logout">Logga ut</button>';
    h += '<p class="small mute">Lägg appen på hemskärmen: iPhone: Dela-knappen > “Lägg till på hemskärmen”. Android: menyn > “Installera app”.</p></div>';
    openSheet(h);
  }

  function addMenuSheet() {
    openSheet('<h2>Lägg till</h2><div class="seg" style="margin:8px 0 14px"><button class="on" data-act="addTab" data-v="task">Uppgift</button><button data-act="addTab" data-v="routine">Rutin</button></div><div id="addbody">' + addTaskForm() + '</div>');
  }
  function addTaskForm() {
    return F('addTask',
      '<label>Från mall (valfritt)</label><select name="tpl" data-change="tplPick"><option value="">Egen uppgift</option>' + opt(S.templates, '', function (t) { return [t.id, t.name]; }) + '</select>' +
      '<label>Vad ska göras?</label><input name="title" required maxlength="120" placeholder="t.ex. Mocka box 3">' +
      '<label>Vem/vad (hast, box, rum)</label><input name="target" maxlength="80" list="targets" placeholder="t.ex. Flow">' +
      '<datalist id="targets">' + S.horses.map(function (x) { return '<option value="' + esc(x.name) + '">'; }).join('') + boxList().map(function (b) { return '<option value="Box ' + b + '">'; }).join('') + (S.settings.suggestions || []).map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist>' +
      '<div class="two"><div><label>Tid</label><input type="time" name="due" value="12:00" required></div><div><label>Dag</label><input type="date" name="day" value="' + addD(S.today, dayOff) + '" required></div></div>' +
      '<label>Ansvarig</label><select name="who">' + peopleOpts('', 'Ingen, öppen för alla') + '</select>' + daysPicker() +
      '<label>Notering (valfritt)</label><input name="note" maxlength="300">', 'Lägg in');
  }
  function daysPicker() {
    var out = '';
    for (var i = 0; i < 14; i++) { var d = addD(S.today, i); out += '<label class="pill" style="margin:0;color:var(--ink);font-size:14px"><input type="checkbox" data-multi="1" name="days" value="' + d + '" style="width:auto"> ' + esc(fmtDay(d)) + '</label>'; }
    return '<details><summary style="cursor:pointer;font-weight:600;color:var(--green);padding:8px 0">Upprepa på flera dagar (valfritt)</summary><div class="small mute" style="margin:4px 0 8px">Bockar du dagar här läggs uppgiften in på varje dag. Dag ovan används då inte. Ansvarig får en förfrågan och svarar Jag kan eller Kan inte.</div><div class="pill-list">' + out + '</div></details>';
  }
  function addRoutineForm() {
    if (!S.routines.length) return '<div class="empty">Inga rutiner än. Skapa en under menyn > Rutiner.</div>';
    return '<div class="stack">' + S.routines.map(function (r) {
      return '<form data-form="addRoutine" class="card stack"><input type="hidden" name="id" value="' + esc(r.id) + '"><div><b>' + esc(r.name) + '</b><div class="small mute">' + esc(r.descr) + ' · ' + r.items.length + ' uppgifter</div></div>' +
        '<div class="two"><div><label>Ansvarig</label><select name="who">' + peopleOpts('', 'Öppen för alla') + '</select></div><div><label>Dag</label><input type="date" name="day" value="' + addD(S.today, dayOff) + '" required></div></div>' +
        '<button class="btn" type="submit">Lägg in rutinen</button></form>';
    }).join('') + '</div>';
  }

  // ---- uppgiftsark
  function taskSheet(id) {
    var t = S.tasks.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    var ins = t.instr ? instr(t.instr) : null;
    var h = '<h2>' + esc(t.title) + (t.target ? ' · ' + esc(t.target) : '') + '</h2><div class="small mute" style="margin-bottom:10px">' + esc(fmtDayLong(t.day)) + ' kl ' + t.due + (t.addedBy && person(t.addedBy) ? ' · inlagd av ' + esc(person(t.addedBy).name) : '') + '</div><div class="stack">';
    if (t.resp === 'vantar' && t.who === S.me.id) h += '<div class="card" style="background:var(--hay-soft)"><b>Kan du ta den här?</b><div class="two" style="margin-top:10px"><button class="btn" data-act="respondYes" data-id="' + t.id + '">Jag kan</button><button class="btn danger" data-act="respondNo" data-id="' + t.id + '">Kan inte</button></div></div>';
    if (t.resp === 'nej') h += '<div class="card" style="background:var(--warn-soft)"><b>Kan inte</b>' + (t.respNote ? '<div class="small">“' + esc(t.respNote) + '”</div>' : '') + (t.propDay || t.propDue ? '<div class="small">Förslag: ' + esc(fmtDay(t.propDay || t.day)) + ' kl ' + esc(t.propDue || t.due) + '</div>' : '') + (isFam() && (t.propDay || t.propDue) ? '<button class="btn sm" style="margin-top:8px" data-act="acceptProp" data-id="' + t.id + '">Godkänn förslaget</button>' : '') + '</div>';
    if (ins) h += '<button class="btn soft block" data-act="instr" data-id="' + esc(ins.id) + '">Öppna instruktion: ' + esc(ins.title) + '</button>';
    h += '<form data-form="taskEdit" class="stack"><input type="hidden" name="id" value="' + t.id + '">';
    if (isFam()) h += '<label>Ansvarig</label><select name="who">' + peopleOpts(t.who || '', 'Ingen, öppen för alla') + '</select>';
    h += '<label>Notering</label><input name="note" maxlength="300" value="' + esc(t.note) + '"><button class="btn block" type="submit">Spara</button></form>';
    h += '<button class="btn ' + (t.done ? 'ghost' : 'soft') + ' block" data-act="toggle" data-id="' + t.id + '" data-close="1">' + (t.done ? 'Ångra klar' : 'Markera klar') + '</button>';
    if (isFam() && t.tpl !== 'utfodra') h += '<button class="btn danger block" data-act="delTask" data-id="' + t.id + '">Ta bort uppgiften</button>';
    openSheet(h + '</div>');
  }

  // ---- instruktioner
  function instrSheet(id) {
    var i = instr(id); if (!i) { closeSheet(); return; }
    var done = S.checks[id] || [], n = i.steps.length, d = done.filter(Boolean).length;
    var h = '<h2>' + esc(i.title) + '</h2><div class="small mute" style="margin-bottom:10px">' + esc(i.cat || '') + (i.minutes ? ' · ca ' + i.minutes + ' min' : '') + (i.updated ? ' · uppdaterad ' + esc(i.updated) : '') + '</div>' +
      '<div class="bar"><i style="width:' + (n ? Math.round(d / n * 100) : 0) + '%"></i></div><div class="small mute" style="margin:6px 0 12px">' + d + ' av ' + n + ' klara</div><div class="stack">' +
      i.steps.map(function (s, k) {
        return '<button class="step' + (done[k] ? ' done' : '') + '" data-act="step" data-id="' + esc(id) + '" data-i="' + k + '"><span class="chk">✓</span><span class="s">' + esc(s) + '</span></button>';
      }).join('') + '</div><div class="stack" style="margin-top:14px">' +
      '<button class="btn ghost block" data-act="resetSteps" data-id="' + esc(id) + '">Börja om</button>';
    if (isFam()) {
      h += '<form data-form="addStep" class="row" style="gap:8px"><input type="hidden" name="id" value="' + esc(id) + '"><input name="text" maxlength="300" placeholder="Lägg till steg" required><button class="btn" type="submit">+</button></form>' +
        '<button class="btn soft block" data-act="editInstr" data-id="' + esc(id) + '">Redigera instruktionen</button>';
    }
    return h + '</div>';
  }
  function openInstr(id) {
    openSheet(instrSheet(id), { full: true });
    liveSheet = function () { if (!$('#sheet')) { liveSheet = null; return; } if ($('#sheet form[data-form="addStep"] input[name=text]') && $('#sheet form[data-form="addStep"] input[name=text]').value) return; setSheet(instrSheet(id)); };
  }
  function editInstrSheet(id) {
    var i = id ? instr(id) : { id: '', title: '', cat: '', minutes: '', steps: [] };
    openSheet('<h2>' + (id ? 'Redigera instruktion' : 'Ny instruktion') + '</h2>' + F('saveInstr',
      '<input type="hidden" name="id" value="' + esc(i.id) + '"><label>Titel</label><input name="title" required maxlength="100" value="' + esc(i.title) + '">' +
      '<div class="two"><div><label>Kategori</label><input name="cat" maxlength="40" value="' + esc(i.cat) + '" placeholder="t.ex. Städ"></div><div><label>Minuter</label><input name="minutes" type="number" min="1" max="600" value="' + esc(i.minutes || '') + '"></div></div>' +
      '<label>Steg (ett per rad)</label><textarea name="steps" rows="8">' + esc(i.steps.join('\n')) + '</textarea>') +
      (id ? '<button class="btn danger block" style="margin-top:10px" data-act="delInstr" data-id="' + esc(id) + '">Ta bort instruktionen</button><p class="small mute">Om du sparar ändrade steg nollställs allas bockar för den här instruktionen.</p>' : ''), { full: true });
  }

  // ---- hästar, dokument
  function editHorseSheet(id) {
    var h = S.horses.filter(function (x) { return x.id === id; })[0]; if (!h) return;
    openSheet('<h2>' + esc(h.name) + '</h2>' + F('saveHorse',
      '<input type="hidden" name="id" value="' + esc(h.id) + '"><div class="two"><div><label>Box</label><input name="box" type="number" min="1" max="20" value="' + esc(h.box || '') + '"></div><div><label>Hage</label><input name="paddock" maxlength="60" value="' + esc(h.paddock) + '"></div></div>' +
      '<label>Beskrivning</label><input name="descr" maxlength="200" value="' + esc(h.descr) + '">' +
      '<label style="margin-top:16px;color:var(--ink);font-size:15px">Fodermängd vid varje utfodring</label><div class="small mute" style="margin-top:-4px">t.ex. “2 kg hö, 1 dl kraftfoder”. Lämna tomt om hästen inte får något då.</div>' +
      feedTimes().map(function (t, i) { return '<label>Kl ' + t + '</label><input name="f' + i + '" maxlength="80" value="' + esc(h.feed && h.feed[i] || '') + '">'; }).join('') +
      '<div class="two"><div><label>Hö</label><input name="hay" maxlength="60" value="' + esc(h.hay) + '" placeholder="t.ex. 3 kg"></div><div><label>Kraftfoder</label><input name="grain" maxlength="60" value="' + esc(h.grain) + '"></div></div>' +
      '<label>Tillägg och medicin</label><input name="extra" maxlength="200" value="' + esc(h.extra) + '">' +
      '<label>Täcke</label><input name="blanket" maxlength="300" value="' + esc(h.blanket) + '">' +
      '<label>Att tänka på</label><textarea name="notes" maxlength="600">' + esc(h.notes) + '</textarea>') + '<button class="btn danger block" style="margin-top:10px" data-act="delHorse" data-id="' + esc(h.id) + '">Ta bort hästen</button>', { full: true });
  }
  function editDocSheet(id) {
    var d = id ? S.docs.filter(function (x) { return x.id === id; })[0] : { id: '', name: '', cat: '', url: '', note: '' };
    if (!d) return;
    openSheet('<h2>' + (id ? 'Ändra dokument' : 'Nytt dokument') + '</h2>' + F('saveDoc',
      '<input type="hidden" name="id" value="' + esc(d.id) + '"><label>Namn</label><input name="name" required maxlength="120" value="' + esc(d.name) + '">' +
      '<label>Kategori</label><input name="cat" maxlength="40" value="' + esc(d.cat) + '" placeholder="t.ex. Veterinär">' +
      '<label>Länk (valfritt)</label><input name="url" type="url" maxlength="500" value="' + esc(d.url) + '" placeholder="https://…">' +
      '<label>Text (valfritt)</label><textarea name="note" rows="6" maxlength="4000">' + esc(d.note) + '</textarea>') +
      (id ? '<button class="btn danger block" style="margin-top:10px" data-act="delDoc" data-id="' + d.id + '">Ta bort</button>' : ''));
  }

  // ---- övriga ark
  function shiftSheet() {
    openSheet('<h2>Nytt pass</h2>' + F('addShift',
      '<label>Vem</label><select name="who">' + peopleOpts('') + '</select><label>Dag</label><input type="date" name="day" value="' + S.today + '" required>' +
      '<div class="two"><div><label>Från</label><input type="time" name="start" value="08:00" required></div><div><label>Till</label><input type="time" name="end" value="13:00" required></div></div>', 'Lägg in passet'));
  }
  function timeSheet() {
    openSheet('<h2>Lägg in tid</h2>' + F('addTime',
      (isFam() ? '<label>Vem</label><select name="who">' + peopleOpts(S.me.id) + '</select>' : '') + '<label>Dag</label><input type="date" name="day" value="' + S.today + '" max="' + S.today + '" required>' +
      '<div class="two"><div><label>Från</label><input type="time" name="start" required></div><div><label>Till</label><input type="time" name="end" required></div></div><label>Notering</label><input name="note" maxlength="200">', 'Spara tid'));
  }
  function composeSheet() {
    var others = S.people.filter(function (p) { return p.id !== S.me.id; });
    openSheet('<h2>Nytt meddelande</h2>' + F('send',
      '<label>Till</label><div class="pill-list">' + others.map(function (p) {
        return '<label class="pill" style="margin:0;color:var(--ink);font-size:inherit"><input type="checkbox" data-multi="1" name="to" value="' + p.id + '" style="width:auto"> ' + esc(p.name) + '</label>';
      }).join('') + '</div><label>Meddelande</label><textarea name="body" rows="5" required maxlength="2000"></textarea>' +
      '<label class="row" style="color:var(--ink);font-size:15px;margin-top:12px"><input type="checkbox" name="ack" checked style="width:auto"> Mottagaren ska kvittera “Jag har läst”</label>', 'Skicka'));
  }
  function pinResetSheet() {
    openSheet('<h2>Återställ PIN</h2><p class="small mute">Personen får PIN 0000 och väljer ett nytt vid nästa inloggning.</p><div class="stack">' +
      S.people.filter(function (p) { return p.id !== S.me.id; }).map(function (p) { return '<button class="btn soft block" data-act="doPinReset" data-id="' + p.id + '">' + esc(p.name) + '</button>'; }).join('') + '</div>');
  }
  function routinesSheet() {
    openSheet('<h2>Rutiner</h2><div class="stack">' + S.routines.map(function (r) {
      return '<button class="card" style="text-align:left" data-act="editRoutine" data-id="' + esc(r.id) + '"><b>' + esc(r.name) + '</b><div class="small mute">' + r.items.length + ' uppgifter</div></button>';
    }).join('') + '<button class="btn ghost block" data-act="editRoutine" data-id="">+ Ny rutin</button></div>');
  }
  function editRoutineSheet(id) {
    var r = id ? S.routines.filter(function (x) { return x.id === id; })[0] : { id: '', name: '', descr: '', items: [] };
    if (!r) return;
    var lines = r.items.map(function (it) { var t = templ(it.tpl); return it.time + '; ' + (t ? t.name : it.tpl) + '; ' + (it.target || ''); }).join('\n');
    openSheet('<h2>' + (id ? esc(r.name) : 'Ny rutin') + '</h2>' + F('saveRoutine',
      '<input type="hidden" name="id" value="' + esc(r.id) + '"><label>Namn</label><input name="name" required maxlength="80" value="' + esc(r.name) + '"><label>Beskrivning</label><input name="descr" maxlength="200" value="' + esc(r.descr) + '">' +
      '<label>Uppgifter, en per rad: tid; mall; vem/vad</label><textarea name="items" rows="10" placeholder="08:30; Ta ut häst till hage; Flow">' + esc(lines) + '</textarea>' +
      '<p class="small mute">Mallar: ' + S.templates.map(function (t) { return esc(t.name); }).join(', ') + '</p>') +
      (id ? '<button class="btn danger block" style="margin-top:10px" data-act="delRoutine" data-id="' + esc(id) + '">Ta bort rutinen</button>' : ''), { full: true });
  }
  function parseRoutine(text) {
    var items = [];
    text.split('\n').forEach(function (ln, k) {
      ln = ln.trim(); if (!ln) return;
      var p = ln.split(';').map(function (x) { return x.trim(); });
      var m = /^(\d{1,2})[:.](\d{2})$/.exec(p[0] || '');
      if (!m) throw new Error('Rad ' + (k + 1) + ': börja med en tid, t.ex. 08:30');
      var name = (p[1] || '').toLowerCase();
      var t = S.templates.filter(function (x) { return x.name.toLowerCase() === name || x.id === name; })[0];
      if (!t) throw new Error('Rad ' + (k + 1) + ': okänd mall “' + p[1] + '”');
      items.push({ time: ('0' + m[1]).slice(-2) + ':' + m[2], tpl: t.id, target: p[2] || '' });
    });
    return items;
  }

  // ---------------------------------------------------------------- byten och ledigt
  function pendingSwaps() { return isFam() && S.swaps ? S.swaps.filter(function (r) { return r.status === 'vantar'; }).length : 0; }
  function swapDesc(r) {
    if (r.kind === 'byte') return 'Flytta passet ' + fmtDay(r.fromDay) + ' ' + r.fromStart + '–' + r.fromEnd + ' till ' + fmtDay(r.toDay) + ' ' + r.toStart + '–' + r.toEnd;
    if (r.kind === 'ledig') return 'Vara ledig ' + fmtDay(r.fromDay) + ' (' + r.fromStart + '–' + r.fromEnd + ')';
    return 'Jobba extra ' + fmtDay(r.toDay) + ' ' + r.toStart + '–' + r.toEnd;
  }
  function swapSection() {
    var sw = S.swaps || [];
    var pend = sw.filter(function (r) { return r.status === 'vantar'; });
    var done = sw.filter(function (r) { return r.status === 'godkand' || r.status === 'nekad'; }).slice(0, 3);
    var out = [];
    if (!isFam()) out.push('<div class="card"><b>Behöver du byta eller vara ledig?</b><div class="small mute" style="margin:4px 0 10px">Tryck “Byt / ledig” vid ett av dina pass, så får familjen en förfrågan. Du får svar i Inkorgen.</div><button class="btn soft block" data-act="swapExtra">Jag kan jobba extra</button></div>');
    if (pend.length || done.length) {
      out.push('<div class="sec">Förfrågningar</div>');
      pend.concat(done).forEach(function (r) {
        var p = person(r.who), chip = r.status === 'vantar' ? '<span class="chip hay">Väntar</span>' : r.status === 'godkand' ? '<span class="chip">Godkänd</span>' : '<span class="chip warn">Nekad</span>';
        out.push('<div class="card"><div class="row">' + av(r.who, 'sm') + '<div class="sp"><b>' + esc(p ? p.name : '?') + '</b><div>' + esc(swapDesc(r)) + '</div>' +
          (r.note ? '<div class="small mute">“' + esc(r.note) + '”</div>' : '') + (r.reply ? '<div class="small">Svar: ' + esc(r.reply) + '</div>' : '') + '</div>' + chip + '</div>' +
          (r.status === 'vantar' && isFam() ? '<div style="margin-top:10px"><button class="btn sm" data-act="swapDecide" data-id="' + r.id + '">Svara</button></div>' : '') +
          (r.status === 'vantar' && r.who === S.me.id ? '<div style="margin-top:10px"><button class="btn danger sm" data-act="swapCancel" data-id="' + r.id + '">Dra tillbaka</button></div>' : '') + '</div>');
      });
    }
    return out.join('');
  }
  function timeInputs(a, b) { return '<div class="two"><div><label>Från</label><input type="time" name="to_start" value="' + a + '" required></div><div><label>Till</label><input type="time" name="to_end" value="' + b + '" required></div></div>'; }
  function swapAskSheet(id) {
    var s = S.shifts.filter(function (x) { return x.id === id; })[0]; if (!s) return;
    openSheet('<h2>Fråga om byte eller ledigt</h2><div class="small mute">Ditt pass: <b>' + esc(fmtDayLong(s.day)) + ' ' + s.start + '–' + s.end + '</b></div>' + F('swapReq',
      '<input type="hidden" name="shift_id" value="' + s.id + '"><label>Vad vill du?</label><select name="kind" data-change="swapKind"><option value="byte">Byta till en annan dag</option><option value="ledig">Vara ledig, utan att jobba in det</option></select>' +
      '<div id="swapTo"><label>Jag kan jobba i stället</label><input type="date" name="to_day" min="' + S.today + '" required>' + timeInputs(s.start, s.end) + '</div>' +
      '<label>Meddelande (valfritt)</label><input name="note" maxlength="300" placeholder="t.ex. jag ska på bröllop">', 'Skicka förfrågan'));
  }
  function swapExtraSheet() {
    openSheet('<h2>Jag kan jobba extra</h2>' + F('swapReq',
      '<input type="hidden" name="kind" value="extra"><label>Dag</label><input type="date" name="to_day" min="' + S.today + '" required>' + timeInputs('08:00', '13:00') +
      '<label>Meddelande (valfritt)</label><input name="note" maxlength="300">', 'Skicka förfrågan'));
  }
  function swapDecideSheet(id) {
    var r = S.swaps.filter(function (x) { return x.id === id; })[0]; if (!r) return;
    var p = person(r.who);
    openSheet('<h2>' + esc(p ? p.name : '') + '</h2><p>' + esc(swapDesc(r)) + '</p>' + (r.note ? '<p class="mute">“' + esc(r.note) + '”</p>' : '') +
      '<label>Svar till ' + esc(p ? p.name : '') + ' (valfritt)</label><input name="reply" maxlength="300"><div class="two" style="margin-top:14px"><button class="btn" data-act="decide" data-id="' + r.id + '" data-d="godkand">Godkänn</button><button class="btn danger" data-act="decide" data-id="' + r.id + '" data-d="nekad">Nej</button></div>' +
      '<p class="small mute">Godkänner du ändras schemat direkt och ' + esc(p ? p.name : 'personen') + ' får besked i Inkorgen.</p>');
  }

  function feedTimesSheet() {
    var times = feedTimes(), n = Math.min(8, Math.max(times.length + 2, 5)), inputs = '';
    for (var i = 0; i < n; i++) inputs += '<div><label>' + (i + 1) + '. utfodringen</label><input type="time" name="t' + i + '" value="' + (times[i] || '') + '"></div>';
    openSheet('<h2>Utfodringstider</h2><p class="small mute">Lämna en ruta tom för att ta bort en tid. Ogjorda utfodringar idag och framåt uppdateras direkt.</p>' + F('feedTimes', '<div class="two">' + inputs + '</div>' +
      '<p class="small mute">Fodermängderna per häst följer ordningen (1:a, 2:a …). Kontrollera dem efteråt under Pärmen > Hästar.</p>'));
  }

  // ---------------------------------------------------------------- inställningar (familjen)
  function viewSettings() {
    if (!isFam()) return '<div class="empty">Bara familjen kan ändra inställningar.</div>';
    function row(act, title, sum) { return '<button class="card" style="text-align:left;width:100%" data-act="' + act + '"><div class="row"><div class="sp"><b>' + title + '</b><div class="small mute">' + sum + '</div></div><span class="mute" style="font-size:22px">›</span></div></button>'; }
    var pos = farmPos();
    return '<div class="small mute">Här ändrar du allt i appen. Ändringar syns direkt för alla.</div>' +
      row('feedTimes', 'Utfodringstider', esc(feedTimes().join(' · '))) +
      row('routines', 'Rutiner', S.routines.length + ' st: ' + esc(S.routines.map(function (r) { return r.name; }).join(', '))) +
      row('templates', 'Mallar för uppgifter', S.templates.length + ' st') +
      row('horsesAdmin', 'Hästar och boxar', S.horses.map(function (h) { return esc(h.name); }).join(', ')) +
      row('peopleAdmin', 'Personer och roller', S.people.map(function (p) { return esc(p.name); }).join(', ')) +
      row('settingsSheet', 'Väder, boxar och platser', 'Regn ' + (S.settings.rain_limit || 5) + ' mm · vind ' + (S.settings.wind_limit || 10) + ' m/s · ' + boxList().length + ' boxar · ' + (pos ? 'plats ifylld' : 'plats saknas')) +
      row('goInstr', 'Instruktioner', S.instructions.length + ' st (Pärmen)') +
      row('goDocs', 'Dokument', S.docs.length + ' st (Pärmen)');
  }
  var PALETTE = ['#2F6B4F', '#B0473A', '#3E5C8A', '#7A4E8C', '#C08A1E', '#8A5A2B', '#2A8C8C', '#C0577D'];
  var PER = { horse: 'En häst', box: 'En box', room: 'Ett rum', all: 'Alla hästar' };
  function templatesSheet() {
    openSheet('<h2>Mallar</h2><p class="small mute">Mallar är vanliga uppgifter (som “Mocka box”) du kan välja när du lägger till något eller bygger en rutin.</p><div class="stack">' +
      S.templates.map(function (t) { return '<button class="card" style="text-align:left" data-act="editTemplate" data-id="' + esc(t.id) + '"><b>' + esc(t.name) + '</b><div class="small mute">' + esc(t.cat || 'Utan kategori') + ' · ' + PER[t.per] + '</div></button>'; }).join('') +
      '<button class="btn ghost block" data-act="editTemplate" data-id="">+ Ny mall</button></div>');
  }
  function editTemplateSheet(id) {
    var t = id ? templ(id) : { id: '', name: '', cat: '', per: 'horse', instr_id: '' }; if (!t) return;
    openSheet('<h2>' + (id ? 'Ändra mall' : 'Ny mall') + '</h2>' + F('saveTemplate',
      '<input type="hidden" name="id" value="' + esc(t.id) + '"><label>Namn</label><input name="name" required maxlength="80" value="' + esc(t.name) + '">' +
      '<label>Kategori</label><input name="cat" maxlength="40" value="' + esc(t.cat) + '" placeholder="t.ex. Städ">' +
      '<label>Gäller</label><select name="per">' + Object.keys(PER).map(function (k) { return '<option value="' + k + '"' + (t.per === k ? ' selected' : '') + '>' + PER[k] + '</option>'; }).join('') + '</select>' +
      '<label>Instruktion som följer med (valfritt)</label><select name="instr_id"><option value="">Ingen</option>' + opt(S.instructions, t.instr_id || '', function (i) { return [i.id, i.title]; }) + '</select>') +
      (id ? '<button class="btn danger block" style="margin-top:10px" data-act="delTemplate" data-id="' + esc(id) + '">Ta bort mallen</button>' : ''));
  }
  function horsesAdminSheet() {
    openSheet('<h2>Hästar och boxar</h2><div class="stack">' + S.horses.map(function (h) {
      return '<button class="card" style="text-align:left" data-act="editHorse" data-id="' + esc(h.id) + '"><b>' + esc(h.name) + '</b><div class="small mute">' + (h.box ? 'Box ' + h.box : 'Ingen box') + '</div></button>';
    }).join('') + '<button class="btn ghost block" data-act="newHorse">+ Ny häst</button></div><p class="small mute">Foder, täcke och annat per häst ändrar du genom att trycka på hästen.</p>');
  }
  function newHorseSheet() {
    var used = S.horses.map(function (h) { return h.box; }), free = boxList().filter(function (b) { return used.indexOf(b) < 0; });
    openSheet('<h2>Ny häst</h2>' + F('newHorse', '<label>Namn</label><input name="name" required maxlength="40"><label>Box</label><select name="box"><option value="">Ingen box</option>' + free.map(function (b) { return '<option value="' + b + '">Box ' + b + '</option>'; }).join('') + '</select>', 'Lägg till'));
  }
  function peopleAdminSheet() {
    openSheet('<h2>Personer och roller</h2><p class="small mute">Familjen kan ändra allt. Skötare ser sina uppgifter och pass, och bockar av.</p><div class="stack">' +
      S.people.map(function (p) { return '<button class="card" style="text-align:left" data-act="editPerson" data-id="' + esc(p.id) + '"><div class="row">' + av(p.id, '') + '<div class="sp"><b>' + esc(p.name) + '</b><div class="small mute">' + (p.role === 'familj' ? 'Familj' : 'Skötare') + (p.title ? ' · ' + esc(p.title) : '') + '</div></div></div></button>'; }).join('') +
      '<button class="btn ghost block" data-act="editPerson" data-id="">+ Ny person</button>' +
      ((S.inactive || []).length ? '<div class="sec" style="margin-top:12px">Borttagna</div>' + S.inactive.map(function (p) { return '<div class="row card"><span class="sp">' + esc(p.name) + '</span><button class="btn soft sm" data-act="reactivate" data-id="' + esc(p.id) + '">Lägg tillbaka</button></div>'; }).join('') : '') + '</div>');
  }
  function editPersonSheet(id) {
    var p = id ? person(id) : { id: '', name: '', role: 'skotare', title: '', color: PALETTE[S.people.length % PALETTE.length] }; if (!p) return;
    var self = id === S.me.id;
    openSheet('<h2>' + (id ? esc(p.name) : 'Ny person') + '</h2>' + F('savePerson',
      '<input type="hidden" name="id" value="' + esc(p.id) + '"><label>Namn</label><input name="name" required maxlength="40" value="' + esc(p.name) + '">' +
      '<label>Roll</label><select name="role"' + (self ? ' disabled' : '') + '><option value="skotare"' + (p.role === 'skotare' ? ' selected' : '') + '>Skötare</option><option value="familj"' + (p.role === 'familj' ? ' selected' : '') + '>Familj (kan ändra allt)</option></select>' +
      '<label>Titel (valfritt)</label><input name="title" maxlength="40" value="' + esc(p.title) + '" placeholder="t.ex. Hästskötare">' +
      '<label>Färg</label><input type="color" name="color" value="' + esc(p.color) + '" style="height:46px;padding:4px">') +
      (id ? '<div class="stack" style="margin-top:12px"><button class="btn soft block" data-act="doPinReset" data-id="' + esc(id) + '">Återställ PIN till 0000</button>' + (self ? '' : '<button class="btn danger block" data-act="deactivate" data-id="' + esc(id) + '">Ta bort från appen</button><p class="small mute">Passen och tiden de har registrerat sparas. Du kan lägga tillbaka personen senare.</p>') + '</div>'
         : '<p class="small mute">Nya personer får PIN 0000 och väljer en egen första gången de loggar in.</p>'));
  }
  function settingsSheet() {
    var pos = farmPos(), st = S.settings;
    openSheet('<h2>Väder, boxar och platser</h2>' + F('saveSettings',
      '<div class="two"><div><label>Varna för regn (mm)</label><input name="rain_limit" inputmode="decimal" value="' + esc(st.rain_limit != null ? st.rain_limit : 5) + '"></div><div><label>Varna för vind (m/s)</label><input name="wind_limit" inputmode="decimal" value="' + esc(st.wind_limit != null ? st.wind_limit : 10) + '"></div></div>' +
      '<p class="small mute" style="margin:0">Väderkortet föreslår att ta in hästarna när regnet fram till 18 eller vindbyarna når de här värdena.</p>' +
      '<label>Antal boxar</label><input name="box_count" type="number" min="1" max="30" value="' + esc(st.box_count != null ? st.box_count : 5) + '">' +
      '<div class="two"><div><label>Gårdens latitud</label><input name="lat" inputmode="decimal" value="' + (pos ? esc(pos.lat) : '') + '" placeholder="58.41"></div><div><label>Longitud</label><input name="lon" inputmode="decimal" value="' + (pos ? esc(pos.lon) : '') + '" placeholder="15.62"></div></div>' +
      '<button type="button" class="btn soft block" data-act="useLocation">Fyll i från telefonens plats (stå på gården)</button>' +
      '<label>Rum och platser att välja bland (ett per rad)</label><textarea name="suggestions" rows="6">' + esc((st.suggestions || []).join('\n')) + '</textarea>'), { full: true });
  }

  // ---------------------------------------------------------------- export till Excel
  function exportSheet() {
    var ym = S.today.slice(0, 7);
    openSheet('<h2>Tidrapport till Excel</h2><p class="small mute">Laddar ner en Excel-fil med alla tidsposter för vald månad, med summor per person.</p>' + F('exportTime',
      '<label>Månad</label><input type="month" name="month" value="' + ym + '" max="' + ym + '" required>' +
      (isFam() ? '<label>Vem</label><select name="who"><option value="all">Alla</option>' + peopleOpts('') + '</select>' : '<input type="hidden" name="who" value="' + S.me.id + '">'), 'Ladda ner Excel'));
  }
  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function exportTime(v) {
    if (!window.XLSX_LITE) { toast('Exporten kunde inte laddas. Ladda om sidan.'); return Promise.reject(new Error('x')); }
    var ym = v.month, y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var from = ym + '-01', to = ym + '-' + ('0' + new Date(Date.UTC(y, m, 0)).getUTCDate()).slice(-2);
    return act('export_time', { from: from, to: to, who: v.who }).then(function (r) {
      var rows = r.rows || [];
      if (!rows.length) { toast('Ingen tid registrerad den månaden'); return; }
      var data = [[{ h: 'Datum' }, { h: 'Dag' }, { h: 'Namn' }, { h: 'Från' }, { h: 'Till' }, { h: 'Timmar' }, { h: 'Anteckning' }]], per = {}, order = [];
      rows.forEach(function (e) {
        data.push([e.day, WD[dow(e.day)], e.name, e.start, e.end, { hrs: Math.round(e.min / 60 * 100) / 100 }, e.note || '']);
        if (!per[e.name]) { per[e.name] = { min: 0, n: 0 }; order.push(e.name); }
        per[e.name].min += e.min; per[e.name].n++;
      });
      data.push([{ b: 'Summa' }, '', '', '', '', { sum: 'F2:F' + (rows.length + 1) }, '']);
      var sum = [[{ h: 'Namn' }, { h: 'Timmar' }, { h: 'Antal poster' }]], tot = 0;
      order.sort().forEach(function (n) { sum.push([n, { hrs: Math.round(per[n].min / 60 * 100) / 100 }, per[n].n]); tot += per[n].min; });
      sum.push([{ b: 'Totalt' }, { sum: 'B2:B' + (order.length + 1) }, '']);
      var parts = window.XLSX_LITE.build([
        { name: 'Tidrapport', cols: [12, 7, 16, 8, 8, 9, 40], rows: data },
        { name: 'Summa per person', cols: [18, 10, 14], rows: sum }
      ]);
      var blob = new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      downloadBlob(blob, 'Tidrapport_' + ym + (v.who && v.who !== 'all' && isFam() ? '_' + (person(v.who) ? person(v.who).name : '') : '') + '.xlsx');
      toast('Excel-filen laddas ner');
    }).catch(function (e) { toast(e.message); throw e; });
  }

  // ---------------------------------------------------------------- inloggning
  var L = { people: null, sel: null, pin: '' };

  function showLogin(msg) {
    S = null; closeSheet();
    if (!L.people) {
      app.innerHTML = '<div class="boot">Laddar …</div>';
      rpc('app_people').then(function (p) { L.people = p; showLogin(msg); }, function (e) {
        app.innerHTML = '<div class="login"><h1>' + esc(C.FARM || 'Stallappen') + '</h1><p class="err">' + esc(e.message) + '</p><button class="btn" onclick="location.reload()">Försök igen</button></div>';
      });
      return;
    }
    var last = store.get('lg_last');
    if (!L.sel) {
      app.innerHTML = '<div class="login"><div class="farm">' + esc(C.FARM || '') + '</div><h1>Vem är du?</h1><div class="who">' +
        L.people.map(function (p) { return '<button data-act="pick" data-id="' + esc(p.id) + '"' + (p.id === last ? ' class="last"' : '') + '><span class="av lg" style="background:' + esc(p.color) + '">' + esc(p.initials) + '</span>' + esc(p.name) + '</button>'; }).join('') + '</div>' +
        (msg ? '<p class="err">' + esc(msg) + '</p>' : '') + '</div>';
      return;
    }
    pinScreen({ person: L.sel, title: 'Hej ' + L.sel.name, sub: 'Skriv din PIN-kod', back: true, onDone: doLogin, msg: msg });
  }

  var PS = null;
  function pinScreen(cfg) {
    PS = { cfg: cfg, pin: '' };
    var pad = '';
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (d) { pad += '<button data-act="pin" data-d="' + d + '">' + d + '</button>'; });
    pad += '<button class="ghost" data-act="pinBack">' + (cfg.back ? 'Byt person' : (cfg.cancel ? 'Avbryt' : '')) + '</button><button data-act="pin" data-d="0">0</button><button class="ghost" data-act="pinDel" aria-label="Sudda">⌫</button>';
    closeSheet();
    app.innerHTML = '<div class="login">' + (cfg.person ? '<span class="av lg" style="background:' + esc(cfg.person.color) + '">' + esc(cfg.person.initials) + '</span>' : '') +
      '<h1>' + esc(cfg.title) + '</h1><div class="mute">' + esc(cfg.sub) + '</div><div class="dots" id="dots"><i></i><i></i><i></i><i></i></div><div class="err" id="perr">' + esc(cfg.msg || '') + '</div><div class="pad">' + pad + '</div></div>';
  }
  function pinKey(d) {
    if (!PS || PS.busy) return;
    if (d === 'del') PS.pin = PS.pin.slice(0, -1); else if (PS.pin.length < 4) PS.pin += d;
    var dots = document.querySelectorAll('#dots i');
    for (var i = 0; i < 4; i++) dots[i].className = i < PS.pin.length ? 'f' : '';
    if (PS.pin.length === 4) {
      PS.busy = true;
      var pin = PS.pin, done = PS.cfg.onDone;
      setTimeout(function () { done(pin); }, 120);
    }
  }
  function pinFail(msg) {
    var dots = $('#dots'), err = $('#perr');
    if (PS) { PS.pin = ''; PS.busy = false; }
    if (dots) { dots.className = 'dots shake'; Array.prototype.forEach.call(dots.children, function (i) { i.className = ''; }); }
    if (err) err.textContent = msg;
  }
  function doLogin(pin) {
    rpc('app_login', { p_person: L.sel.id, p_pin: pin }).then(function (r) {
      if (r.error) { pinFail(r.error); return; }
      token = r.token; store.set('lg_token', token); store.set('lg_last', L.sel.id);
      if (r.mustChange) { forceChange(); } else { boot(); }
    }, function (e) { pinFail(e.message); });
  }
  function forceChange(first) {
    var firstPin = null;
    function ask() {
      pinScreen({ title: firstPin ? 'Upprepa PIN' : 'Välj en egen PIN', sub: firstPin ? 'Skriv samma fyra siffror igen' : 'Fyra siffror du kommer ihåg. Inte 0000.', onDone: onPin });
    }
    function onPin(pin) {
      if (!firstPin) {
        if (pin === '0000') { ask(); pinFail('Välj en annan kod än 0000'); return; }
        firstPin = pin; ask(); return;
      }
      if (pin !== firstPin) { firstPin = null; ask(); pinFail('Koderna stämde inte. Börja om.'); return; }
      act('set_pin', { pin: pin }).then(function () { boot(); }, function (e) { firstPin = null; ask(); pinFail(e.message); });
    }
    ask();
  }
  function changePin() {
    var firstPin = null;
    function ask() {
      pinScreen({ title: firstPin ? 'Upprepa PIN' : 'Ny PIN', sub: 'Fyra siffror', cancel: true, onDone: onPin });
    }
    function onPin(pin) {
      if (!firstPin) { if (pin === '0000') { ask(); pinFail('Välj en annan kod än 0000'); return; } firstPin = pin; ask(); return; }
      if (pin !== firstPin) { firstPin = null; ask(); pinFail('Koderna stämde inte. Börja om.'); return; }
      act('set_pin', { pin: pin }).then(function () { toast('PIN ändrad'); boot(); }, function (e) { firstPin = null; ask(); pinFail(e.message); });
    }
    ask();
  }
  function logout(expired) {
    token = null; store.del('lg_token'); S = null; lastJson = ''; seenMsg = null; filter = null; L.sel = null;
    PS = null;
    showLogin(expired === true ? 'Du blev utloggad. Logga in igen.' : '');
  }
  function boot() {
    PS = null; S = null; lastJson = '';
    app.innerHTML = '<div class="boot">Laddar …</div>';
    refresh().then(function () { if (!S && token) { /* offline eller fel */ app.innerHTML = '<div class="boot">Ingen kontakt med servern.<br><br><button class="btn" onclick="location.reload()">Försök igen</button></div>'; } });
  }

  // ---------------------------------------------------------------- händelser
  function closeAnd(fn) { return function (p) { closeSheet(); return fn(p); }; }

  var A = {
    closeSheet: function () { closeSheet(); },
    tab: function (el) { tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
    day: function (el) { dayOff = +el.dataset.n; render(); },
    week: function (el) { weekOff += +el.dataset.n; render(); },
    filter: function (el) { filter = el.dataset.v; render(); },
    sub: function (el) { sub = el.dataset.v; render(); },
    twho: function (el) { timeWho = el.dataset.v; render(); },
    menu: menuSheet,
    pick: function (el) { L.sel = L.people.filter(function (p) { return p.id === el.dataset.id; })[0]; showLogin(); },
    pin: function (el) { pinKey(el.dataset.d); },
    pinDel: function () { pinKey('del'); },
    pinBack: function () { if (PS && PS.cfg.back) { L.sel = null; showLogin(); } else if (PS && PS.cfg.cancel) { boot(); } },
    logout: function () { act('logout').then(function () {}, function () {}); logout(); },
    changePin: changePin,
    toggle: function (el) {
      var id = el.dataset.id, t = S.tasks.filter(function (x) { return x.id === id; })[0];
      if (t) { t.done = !t.done; t.doneBy = t.done ? S.me.id : null; t.doneAt = t.done ? nowHM() : ''; render(); }
      if (el.dataset.close) closeSheet();
      act('toggle_task', { id: id }).then(function () { return refresh(true); }, function (e) { toast(e.message); refresh(true); });
    },
    task: function (el) { taskSheet(el.dataset.id); },
    delTask: function (el) { if (!armed(el)) return; doAct('delete_task', { id: el.dataset.id }, { ok: 'Borttagen' }).then(closeSheet, function () {}); },
    bringIn: function () { doAct('bring_in', { time: '15:30' }).then(function (r) { toast(r && r.moved ? 'Insläppet flyttat till 15:30 och teamet meddelat' : 'Det finns inget insläpp kvar att flytta'); }, function () {}); },
    addMenu: addMenuSheet,
    addTab: function (el) {
      var v = el.dataset.v;
      Array.prototype.forEach.call(el.parentNode.children, function (b) { b.classList.toggle('on', b === el); });
      $('#addbody').innerHTML = v === 'task' ? addTaskForm() : addRoutineForm();
    },
    addShift: shiftSheet,
    delShift: function (el) { doAct('delete_shift', { id: el.dataset.id }); },
    swapAsk: function (el) { swapAskSheet(el.dataset.id); },
    swapExtra: swapExtraSheet,
    swapDecide: function (el) { swapDecideSheet(el.dataset.id); },
    decide: function (el) {
      var r = $('#sheet input[name=reply]');
      doAct('decide_swap', { id: el.dataset.id, decision: el.dataset.d, reply: r ? r.value : '' }, { ok: el.dataset.d === 'godkand' ? 'Godkänt, schemat är ändrat' : 'Nekat' }).then(closeSheet, function () {});
    },
    swapCancel: function (el) { doAct('cancel_swap', { id: el.dataset.id }, { ok: 'Förfrågan dragen tillbaka' }); },
    goSwap: function () { tab = 'schema'; render(); window.scrollTo(0, 0); },
    exportSheet: exportSheet,
    feedTimes: feedTimesSheet,
    settings: function () { closeSheet(); tab = 'inst'; render(); window.scrollTo(0, 0); },
    settingsBack: function () { tab = 'idag'; render(); },
    templates: templatesSheet, editTemplate: function (el) { editTemplateSheet(el.dataset.id); },
    delTemplate: function (el) { if (!armed(el)) return; doAct('delete_template', { id: el.dataset.id }, { ok: 'Borttagen' }).then(closeSheet, function () {}); },
    horsesAdmin: horsesAdminSheet, newHorse: newHorseSheet,
    delHorse: function (el) { if (!armed(el, 'Tryck igen för att ta bort hästen')) return; doAct('delete_horse', { id: el.dataset.id }, { ok: 'Hästen är borttagen' }).then(closeSheet, function () {}); },
    peopleAdmin: peopleAdminSheet, editPerson: function (el) { editPersonSheet(el.dataset.id); },
    deactivate: function (el) { if (!armed(el)) return; doAct('set_person_active', { id: el.dataset.id, active: false }, { ok: 'Borttagen från appen' }).then(closeSheet, function () {}); },
    reactivate: function (el) { doAct('set_person_active', { id: el.dataset.id, active: true }, { ok: 'Tillbaka i appen' }).then(closeSheet, function () {}); },
    settingsSheet: settingsSheet,
    goInstr: function () { tab = 'parmen'; sub = 'instr'; render(); window.scrollTo(0, 0); },
    goDocs: function () { tab = 'parmen'; sub = 'docs'; render(); window.scrollTo(0, 0); },
    useLocation: function () {
      if (!navigator.geolocation) { toast('Telefonen kan inte ge sin plats här'); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        var f = $('#sheet form[data-form=saveSettings]'); if (!f) return;
        f.elements.lat.value = p.coords.latitude.toFixed(4); f.elements.lon.value = p.coords.longitude.toFixed(4); toast('Platsen är ifylld. Tryck Spara.');
      }, function () { toast('Kunde inte hämta platsen. Skriv koordinaterna för hand.'); }, { timeout: 10000 });
    },
    respondYes: function (el) { doAct('respond_task', { id: el.dataset.id, answer: 'ja' }, { ok: 'Tack, familjen får besked' }).then(closeSheet, function () {}); },
    respondNo: function (el) {
      var t = S.tasks.filter(function (x) { return x.id === el.dataset.id; })[0]; if (!t) return;
      openSheet('<h2>Kan inte</h2><p>' + esc(t.title) + (t.target ? ' · ' + esc(t.target) : '') + '<br><span class="mute">' + esc(fmtDayLong(t.day)) + ' kl ' + t.due + '</span></p>' + F('respondNo',
        '<input type="hidden" name="id" value="' + t.id + '"><label>Meddelande (valfritt)</label><input name="note" maxlength="300" placeholder="t.ex. jag är på jobbet på dagen">' +
        '<label>Jag kan i stället (valfritt)</label><div class="two"><input type="date" name="propose_day" min="' + S.today + '"><input type="time" name="propose_due"></div>', 'Skicka svar'));
    },
    acceptProp: function (el) { doAct('accept_proposal', { id: el.dataset.id }, { ok: 'Flyttat enligt förslaget' }).then(closeSheet, function () {}); },
    instr: function (el) { openInstr(el.dataset.id); },
    step: function (el) {
      var id = el.dataset.id, i = +el.dataset.i, ins = instr(id); if (!ins) return;
      var arr = (S.checks[id] || []).slice(); while (arr.length < ins.steps.length) arr.push(false);
      arr[i] = !arr[i]; S.checks[id] = arr; setSheet(instrSheet(id));
      act('toggle_step', { id: id, i: i }).then(function () { return refresh(true); }, function (e) { toast(e.message); refresh(true); });
    },
    resetSteps: function (el) { var id = el.dataset.id; delete S.checks[id]; setSheet(instrSheet(id)); act('reset_steps', { id: id }).then(function () { return refresh(true); }); },
    editInstr: function (el) { editInstrSheet(el.dataset.id); },
    delInstr: function (el) { if (!armed(el)) return; doAct('delete_instruction', { id: el.dataset.id }, { ok: 'Borttagen' }).then(closeSheet, function () {}); },
    editHorse: function (el) { editHorseSheet(el.dataset.id); },
    editDoc: function (el) { editDocSheet(el.dataset.id); },
    delDoc: function (el) { if (!armed(el)) return; doAct('delete_doc', { id: el.dataset.id }, { ok: 'Borttaget' }).then(closeSheet, function () {}); },
    compose: composeSheet,
    read: function (el) { doAct('mark_read', { id: el.dataset.id }); },
    goToday: function () { tab = 'idag'; dayOff = 0; render(); },
    clockIn: function () { doAct('clock_in', {}, { ok: 'Instämplad' }).catch(function () {}); },
    clockOut: function () { doAct('clock_out', {}, { ok: 'Utstämplad' }).catch(function () {}); },
    addTime: timeSheet,
    delTime: function (el) { doAct('delete_time', { id: el.dataset.id }); },
    pinReset: pinResetSheet,
    doPinReset: function (el) { doAct('reset_pin', { id: el.dataset.id }, { ok: 'PIN återställd till 0000' }).then(closeSheet, function () {}); },
    routines: routinesSheet,
    editRoutine: function (el) { editRoutineSheet(el.dataset.id); },
    delRoutine: function (el) { if (!armed(el)) return; doAct('delete_routine', { id: el.dataset.id }, { ok: 'Borttagen' }).then(closeSheet, function () {}); }
  };

  var FORMS = {
    addTask: function (v) {
      var t = templ(v.tpl);
      return doAct('add_task', { title: v.title, target: v.target, due: v.due, day: v.day, days: v.days && v.days.length ? v.days : undefined, who: v.who, note: v.note, tpl: v.tpl || 'egen', instr: t && t.instr_id || '' }, { ok: v.who && v.who !== S.me.id ? 'Inlagd, personen får en förfrågan' : 'Inlagd' });
    },
    addRoutine: function (v) { return doAct('add_routine', { id: v.id, who: v.who, day: v.day }, { ok: 'Rutinen inlagd' }); },
    taskEdit: function (v) {
      var t = S.tasks.filter(function (x) { return x.id === v.id; })[0], p = Promise.resolve();
      if (t && v.note !== t.note) p = act('set_task_note', { id: v.id, note: v.note });
      if (isFam() && t && (v.who || '') !== (t.who || '')) p = p.then(function () { return act('assign_task', { id: v.id, who: v.who }); });
      return p.then(function () { return refresh(); });
    },
    addShift: function (v) { return doAct('add_shift', v, { ok: 'Pass inlagt' }); },
    swapReq: function (v) { return doAct('request_swap', v, { ok: 'Förfrågan skickad till familjen' }); },
    exportTime: exportTime,
    respondNo: function (v) { return doAct('respond_task', { id: v.id, answer: 'nej', note: v.note, propose_day: v.propose_day, propose_due: v.propose_due }, { ok: 'Svar skickat' }); },
    saveTemplate: function (v) { return doAct('save_template', v, { ok: 'Sparad' }); },
    newHorse: function (v) { return doAct('add_horse', v, { ok: 'Häst tillagd' }); },
    savePerson: function (v) {
      var form = $('#sheet form[data-form=savePerson]');
      if (form && form.elements.role && form.elements.role.disabled) v.role = S.me.role;
      return doAct('save_person', v, { ok: 'Sparad' });
    },
    saveSettings: function (v) {
      return doAct('save_settings', { rain_limit: v.rain_limit, wind_limit: v.wind_limit, box_count: v.box_count, lat: v.lat.trim(), lon: v.lon.trim(), suggestions: v.suggestions.split('\n') }, { ok: 'Inställningar sparade' });
    },
    addTime: function (v) { return doAct('add_time', v, { ok: 'Tid sparad' }); },
    send: function (v) {
      if (!v.to || !v.to.length) { toast('Välj minst en mottagare'); return Promise.reject(new Error('x')); }
      return doAct('send_message', { to: v.to, body: v.body, ack: v.ack }, { ok: 'Skickat' });
    },
    addStep: function (v) { return doAct('add_step', { id: v.id, text: v.text }).then(function () { setSheet(instrSheet(v.id)); }); },
    saveInstr: function (v) {
      return doAct('save_instruction', { id: v.id, title: v.title, cat: v.cat, minutes: v.minutes, steps: v.steps.split('\n') }, { ok: 'Sparad' });
    },
    saveHorse: function (v) {
      var feed = {};
      Object.keys(v).forEach(function (k) { if (/^f\d+$/.test(k) && String(v[k]).trim()) feed[k.slice(1)] = String(v[k]).trim(); });
      var o = {}; Object.keys(v).forEach(function (k) { if (!/^f\d+$/.test(k)) o[k] = v[k]; });
      o.feed = feed;
      return doAct('save_horse', o, { ok: 'Sparad' });
    },
    feedTimes: function (v) {
      var times = Object.keys(v).filter(function (k) { return /^t\d+$/.test(k) && v[k]; }).map(function (k) { return v[k]; });
      if (!times.length) { toast('Skriv minst en tid'); return Promise.reject(new Error('x')); }
      return doAct('save_feed_times', { times: times }, { ok: 'Utfodringstider sparade' });
    },
    saveDoc: function (v) { return doAct('save_doc', v, { ok: 'Sparad' }); },
    saveRoutine: function (v) {
      var items; try { items = parseRoutine(v.items); } catch (e) { toast(e.message); return Promise.reject(e); }
      return doAct('save_routine', { id: v.id, name: v.name, descr: v.descr, items: items }, { ok: 'Rutin sparad' });
    }
  };
  var KEEP_OPEN = { taskEdit: 0 };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || el.disabled) return;
    var fn = A[el.dataset.act];
    if (fn) { e.preventDefault(); try { fn(el, e); } catch (err) { toast(err.message); } }
  });
  document.addEventListener('submit', function (e) {
    var form = e.target.closest ? e.target.closest('form[data-form]') : null;
    if (!form) return;
    e.preventDefault();
    var fn = FORMS[form.dataset.form]; if (!fn) return;
    var btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    var v = fd(form), name = form.dataset.form;
    Promise.resolve().then(function () { return fn(v); }).then(function () {
      if (name !== 'addStep') closeSheet();
    }, function () { if (btn) btn.disabled = false; });
  });
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.dataset && el.dataset.change === 'swapKind') {
      var box = $('#swapTo'), byte = el.value === 'byte';
      if (box) { box.hidden = !byte; el.form.elements.to_day.required = byte; }
    }
    if (el.dataset && el.dataset.change === 'tplPick') {
      var t = templ(el.value); var f = el.form;
      if (t) { f.elements.title.value = t.name; }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSheet();
    if (PS && /^[0-9]$/.test(e.key)) pinKey(e.key);
    if (PS && e.key === 'Backspace') pinKey('del');
  });

  // ---------------------------------------------------------------- start
  setInterval(function () { if (token && !document.hidden) refresh(true); }, 15000);
  setInterval(function () { if (S && !$('#sheet') && (tab === 'idag' || tab === 'tid')) render(); }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && token) refresh(true); });
  window.addEventListener('online', function () { if (token) refresh(true); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  if (token) boot(); else showLogin();

  // för test
  window.__LG = { A: A, state: function () { return S; } };
})();
