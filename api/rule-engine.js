/* Движок «Автоматизации» — сторона сервера. Считает то, что в продукте считает бэкенд: действует ли
   расписание, какой сейчас режим объекта, что сделает правило при запуске. Подключается во встроенном
   сервере (api/server.js) и в сборке эталонного набора (tools/fixture_fires.js): демо-запуски набора
   посчитаны им же.

   Работает на записях API (правила, расписания, устройства — как в ответах сервера). Время — в часовом
   поясе системы: «стенные» даты — объекты Date, у которых UTC-поля равны местному времени системы.
   Трасса запуска — кодами: { code, params }. Подписи по кодам собирает интерфейс.

   create(world): world — доступ к данным сервера: devices(), servers(), domains(), folders(), archives(),
   rules(), schedules(), dayGroups(), modes() → { items, otherwise }, manualMode() → { modeId, until } | null,
   windows(), roles(), users(), tz — часовой пояс системы (строка или функция). */
(() => {
  const RULE_CHAIN_MAX = 5;
  const RULE_DEPTH = 2;
  const RULE_ESC_MAX = 5;
  const TPL_VARS = ["камера", "устройство", "событие", "время", "правило"];
  const RULE_DEVTYPES = ["camera", "sensor", "acfa_sensor", "relay"];
  // Справочники кодами: виды событий, условий, действий и шагов хода выполнения
  const TRIGGERS = [
    { source: "vms", kind: "io.input", deviceTypes: ["sensor", "acfa_sensor"], ends: true },
    { source: "det", kind: "motion", deviceTypes: ["camera"], ends: true },
    { source: "det", kind: "linecross", deviceTypes: ["camera"] },
    { source: "det", kind: "lpr", deviceTypes: ["camera"] },
    { source: "vms", kind: "silent", deviceTypes: ["camera"] },
    { source: "rec", kind: "segment.lost", deviceTypes: ["camera"] },
  ];
  const CONDITIONS = [
    { kind: "time", deviceTypes: [] },
    { kind: "mode", deviceTypes: [] },
    { kind: "armed", deviceTypes: ["camera"] },
    { kind: "recording", deviceTypes: ["camera"] },
    { kind: "online", deviceTypes: ["camera", "sensor", "acfa_sensor", "relay"] },
  ];
  // fields — обязательные поля действия (кроме цели), tpl — поля-шаблоны
  const ACTIONS = [
    { source: "vms", action: "arm", deviceTypes: ["camera"], fields: [] },
    { source: "vms", action: "disarm", deviceTypes: ["camera"], fields: [] },
    { source: "vms", action: "preset", deviceTypes: ["camera"], fields: ["preset"] },
    { source: "rec", action: "record", deviceTypes: ["camera"], fields: [] },
    { source: "vms", action: "disable", deviceTypes: ["camera"], fields: ["minutes"] },
    { source: "alarm", action: "alarm", deviceTypes: ["camera"], fields: [], tpl: ["text"] },
    { source: "alarm", action: "alarmclose", deviceTypes: ["camera"], fields: [] },
    { source: "client", action: "layout", deviceTypes: [], fields: ["layoutId", "roleId"] },
    { source: "client", action: "wall", deviceTypes: ["camera"], fields: [] },
    { source: "ntf", action: "email", deviceTypes: [], fields: ["to", "subject"], tpl: ["subject", "body"], via: "email" },
    { source: "ntf", action: "tg", deviceTypes: [], fields: ["chat", "text"], tpl: ["text"] },
    { source: "vms", action: "output", deviceTypes: ["relay"], fields: ["port", "pulseMs"] },
    { source: "net", action: "http", deviceTypes: [], fields: ["url"], tpl: ["url"] },
    { source: "rule", action: "runrule", deviceTypes: [], fields: ["ruleId"] },
  ];
  const CONTROLS = [
    { control: "wait", branches: [] },
    { control: "waitEvent", branches: ["yes", "no"] },
    { control: "ask", branches: ["yes", "no"] },
    { control: "escalate", branches: [] },
  ];
  const triggerKind = (t) => TRIGGERS.find((k) => k.source === t.source && k.kind === t.kind) || TRIGGERS[0];
  const condKind = (c) => CONDITIONS.find((k) => k.kind === c.kind) || CONDITIONS[0];
  const actionKind = (a) => ACTIONS.find((k) => k.source === a.source && k.action === a.action) || ACTIONS[ACTIONS.length - 3];
  const branchesOf = (c) => (CONTROLS.find((k) => k.control === c.control) || CONTROLS[0]).branches;
  const msg = (code, params) => ({ code, params: params || {} });

  /* ===== Стенное время ===== */

  const DAY = 864e5;
  function offsetMs(tz, ms) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
    const g = (k) => Number(p.find((x) => x.type === k).value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const dow = (d) => d.getUTCDay() || 7;
  const dayAdd = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
  const dayOf = (iso) => {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  };
  const minOf = (t) => {
    const [h, m] = String(t || "0:0").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const raw = (iv) => {
    const f = minOf(iv[0]), t = minOf(iv[1]);
    return [f, t <= f ? t + 1440 : t];
  };
  function union(l) {
    const a = l.filter(([x, y]) => y > x).map((x) => [...x]).sort((p, q) => p[0] - q[0]), o = [];
    a.forEach((x) => {
      const t = o[o.length - 1];
      if (t && x[0] <= t[1]) t[1] = Math.max(t[1], x[1]);
      else o.push(x);
    });
    return o;
  }

  function create(world) {
    const tz = () => (typeof world.tz === "function" ? world.tz() : world.tz) || "Europe/Moscow";
    const wall = (ms) => new Date(ms + offsetMs(tz(), ms));
    const fromWall = (d) => {
      const guess = d.getTime() - offsetMs(tz(), d.getTime());
      return d.getTime() - offsetMs(tz(), guess);
    };
    const clock = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const stamp = (d) => `${isoDay(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    const instant = (d) => new Date(fromWall(d)).toISOString().replace(/\.\d{3}Z$/, "Z");

    /* ===== Расписания (как в интерфейсе: библиотека «Расписания») ===== */

    const schById = (id) => world.schedules().find((s) => s.id === id) || null;
    const grpById = (id) => world.dayGroups().find((g) => g.id === id) || null;
    function grpRuleHit(r, d) {
      if (r.type === "ord") {
        if (r.month && d.getUTCMonth() + 1 !== +r.month) return false;
        if (dow(d) !== +r.dow) return false;
        const day = d.getUTCDate();
        if (r.nth === "last") return day + 7 > new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        return Math.ceil(day / 7) === +r.nth;
      }
      if (!r.from) return false;
      const to = r.to && r.to >= r.from ? r.to : r.from, x = isoDay(d);
      if (!r.yearly) return x >= r.from && x <= to;
      const md = x.slice(5), a = r.from.slice(5), b = to.slice(5);
      return a <= b ? md >= a && md <= b : md >= a || md <= b;
    }
    const grpHit = (g, d) => !!g && g.rules.some((r) => grpRuleHit(r, d));
    function ovrIv(s, o) {
      if (o.mode === "none") return [];
      if (o.mode === "full") return [[0, 1440]];
      if (o.mode === "same") return (s.week[(+o.dow || 1) - 1] || []).map(raw);
      return (o.intervals || []).map(raw);
    }
    function cycleDay(s, d) {
      const c = s.cycle;
      if (!c || !c.start || !c.length) return -1;
      const n = Math.round((dayAdd(d, 0) - dayOf(c.start)) / DAY);
      return ((n % c.length) + c.length) % c.length;
    }
    function sun(d, lat, lon, off, rise) {
      const R = Math.PI / 180, N = Math.round((dayAdd(d, 0) - Date.UTC(d.getUTCFullYear(), 0, 0)) / DAY), lh = lon / 15;
      const t = N + ((rise ? 6 : 18) - lh) / 24, M = 0.9856 * t - 3.289;
      const L = (M + 1.916 * Math.sin(M * R) + 0.02 * Math.sin(2 * M * R) + 282.634 + 720) % 360;
      let RA = (Math.atan(0.91764 * Math.tan(L * R)) / R + 720) % 360;
      RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
      const sd = 0.39782 * Math.sin(L * R), cd = Math.cos(Math.asin(sd));
      const ch = (Math.cos(90.833 * R) - sd * Math.sin(lat * R)) / (cd * Math.cos(lat * R));
      if (ch > 1) return { m: null, polar: "night" };
      if (ch < -1) return { m: null, polar: "day" };
      const H = (rise ? 360 - Math.acos(ch) / R : Math.acos(ch) / R) / 15, T = H + RA - 0.06571 * t - 6.622;
      return { m: Math.round(((((T - lh + (+off || 0)) % 24) + 48) % 24) * 60) };
    }
    const sunDay = (s, d) => {
      const a = s.astro;
      return { rise: sun(d, +a.lat, +a.lon, a.utcOffsetHours, true), set: sun(d, +a.lat, +a.lon, a.utcOffsetHours, false) };
    };
    function astroIv(s, d) {
      const a = s.astro, o1 = +a.offsetStartMin || 0, o2 = +a.offsetEndMin || 0, t = sunDay(s, d);
      if (a.window === "day") {
        if (t.rise.m == null || t.set.m == null) return (t.rise.polar || t.set.polar) === "day" ? [[0, 1440]] : [];
        return [[t.rise.m + o1, t.set.m + o2]];
      }
      const n = sunDay(s, dayAdd(d, 1));
      if (t.set.m == null) return t.set.polar === "night" ? [[0, 1440]] : [];
      return [[t.set.m + o1, 1440 + (n.rise.m == null ? 0 : n.rise.m) + o2]];
    }
    function base(s, d) {
      if (s.kind === "always") return [[0, 1440]];
      if (s.kind === "week") return (s.week[dow(d) - 1] || []).map(raw);
      if (s.kind === "cycle") {
        const k = cycleDay(s, d);
        return k < 0 ? [] : (s.cycle.days[k] || []).map(raw);
      }
      if (s.kind === "dates") {
        const e = s.dates.find((x) => x.date === isoDay(d));
        return e ? e.intervals.map(raw) : [];
      }
      if (s.kind === "astro") return astroIv(s, d);
      return [];
    }
    function own(s, d) {
      if (!s) return [];
      const x = isoDay(d), v = s.valid || {};
      if ((v.from && x < v.from) || (v.to && x > v.to)) return [];
      const hit = (s.overrides || []).find((o) => grpHit(grpById(o.dayGroupId), d));
      return hit ? ovrIv(s, hit) : base(s, d);
    }
    function schDay(s, d) {
      const carry = own(s, dayAdd(d, -1)).filter(([, b]) => b > 1440).map(([, b]) => [0, Math.min(b - 1440, 1440)]);
      return union([...own(s, d).map(([a, b]) => [a, Math.min(b, 1440)]), ...carry]);
    }
    // Действует ли расписание в стенный момент d
    function schActive(id, d) {
      const s = schById(id);
      if (!s) return false;
      const m = d.getUTCHours() * 60 + d.getUTCMinutes();
      return schDay(s, d).some(([a, b]) => m >= a && m < b);
    }
    const schEmpty = (s) => s.kind === "never" || (s.kind === "week" && s.week.every((x) => !x.length) && !(s.overrides || []).some((o) => o.mode !== "none")) ||
      (s.kind === "dates" && !s.dates.length) || (s.kind === "cycle" && !(s.cycle.days || []).some((x) => x.length));

    /* ===== Режим объекта ===== */

    function modeSegs(d) {
      const M = world.modes();
      const per = M.items.filter((m) => m.scheduleId && schById(m.scheduleId)).map((m) => ({ m, iv: schDay(schById(m.scheduleId), d) }));
      const cut = new Set([0, 1440]);
      per.forEach((x) => x.iv.forEach(([a, b]) => { cut.add(a); cut.add(b); }));
      const c = [...cut].sort((a, b) => a - b), out = [];
      for (let i = 0; i < c.length - 1; i++) {
        const a = c[i], b = c[i + 1];
        if (b <= a) continue;
        const hit = per.find((x) => x.iv.some(([p, q]) => a >= p && a < q)), id = hit ? hit.m.id : M.otherwise, last = out[out.length - 1];
        if (last && last.mode === id) last.to = b;
        else out.push({ from: a, to: b, mode: id });
      }
      return out;
    }
    // Режим по расписаниям в стенный момент d
    function modeSched(d) {
      const m = d.getUTCHours() * 60 + d.getUTCMinutes();
      return (modeSegs(d).find((s) => m >= s.from && m < s.to) || { mode: world.modes().otherwise }).mode;
    }
    // Следующая смена режима по расписаниям после момента ms — момент или null
    function modeNext(ms) {
      const now = wall(ms), cur = modeSched(now), t0 = dayAdd(now, 0);
      for (let k = 0; k < 9; k++) {
        const d = dayAdd(t0, k);
        for (const s of modeSegs(d)) {
          const t = new Date(d.getTime() + s.from * 60000);
          if (t > now && s.mode !== cur) return fromWall(t);
        }
      }
      return null;
    }
    // Текущий режим: включённый вручную (пока не истёк) или по расписаниям
    function modeNow(ms) {
      const man = world.manualMode();
      if (man && world.modes().items.some((m) => m.id === man.modeId) && (!man.until || Date.parse(man.until) > ms)) return man.modeId;
      return modeSched(wall(ms));
    }

    /* ===== Устройства и цели ===== */

    const devById = (id) => world.devices().find((d) => d.id === id) || null;
    const srvById = (id) => world.servers().find((s) => s.id === id) || null;
    // Цепочка «устройство → родители → сервер службы»: связь теряется, если без связи кто-то из них
    function ancestors(n) {
      const out = [n];
      let x = n;
      while (x.parentId) {
        const p = devById(x.parentId);
        if (!p) break;
        out.push(p);
        x = p;
      }
      if (x.onServer || SERVICES.has(x.type)) {
        const s = srvById(x.serverId);
        if (s) out.push(Object.assign({ kind: "server" }, s));
      }
      return out;
    }
    const SERVICES = new Set(["export", "email", "sms"]);
    function devServer(n) {
      for (const x of ancestors(n)) {
        if (x.kind === "server") return x.id;
        if (x.serverId && (x.type === "camera" || x.type === "ipsrv") && srvById(x.serverId)) return x.serverId;
        if (x.archiveId && x.recordMode && x.recordMode !== "none") {
          const a = world.archives().find((y) => y.id === x.archiveId);
          if (a && a.serverId && srvById(a.serverId)) return a.serverId;
        }
      }
      return "";
    }
    const devDomain = (n) => {
      const top = ancestors(n).filter((x) => x.kind !== "server").pop();
      return top.domainId;
    };
    function folderDevs(fid) {
      const f = world.folders().find((x) => x.id === fid), out = new Map();
      if (!f) return out;
      const ids = new Set();
      const sub = (x) => {
        x.deviceIds.forEach((id) => ids.add(id));
        world.folders().filter((y) => y.parentId === x.id).forEach(sub);
      };
      sub(f);
      const kids = (id) => world.devices().filter((d) => d.parentId === id).forEach((d) => { out.set(d.id, d); kids(d.id); });
      ids.forEach((id) => {
        const n = devById(id);
        if (!n) return;
        out.set(n.id, n);
        kids(n.id);
      });
      return out;
    }
    // Цель → строки-элементы, как их сортирует интерфейс: устройство — id, область — вид:id, удалённое — gone:имя
    const toks = (t) => (t ? [...t.include.map((x) => (x.kind === "device" ? x.id : `${x.kind}:${x.id}`)), ...t.gone.map((g) => "gone:" + g)].sort() : []);
    const isArea = (tok) => /^(folder|server|domain):/.test(tok || "");
    const isGroup = (t) => !!t && (t.include.length + t.gone.length > 1 || t.exclude.length > 0 || t.include.some((x) => x.kind !== "device"));
    function tokNodes(tok, dt) {
      const i = tok.indexOf(":"), k = i < 0 ? "" : tok.slice(0, i), v = tok.slice(i + 1);
      const all = () => world.devices().filter((n) => dt.includes(n.type));
      if (k === "folder") return [...folderDevs(v).values()].filter((n) => dt.includes(n.type));
      if (k === "server") return all().filter((n) => devServer(n) === v);
      if (k === "domain") return all().filter((n) => devDomain(n) === v);
      if (k === "gone" || !tok) return [];
      const n = devById(tok);
      return n ? [n] : [];
    }
    function nodes(t, dt) {
      if (!t) return [];
      dt = dt || RULE_DEVTYPES;
      const no = new Set(t.exclude), out = new Map();
      toks(t).forEach((x) => tokNodes(x, dt).forEach((n) => { if (!no.has(n.id)) out.set(n.id, n); }));
      return [...out.values()];
    }
    function tokBroken(tok) {
      if (tok.startsWith("gone:")) return true;
      if (tok.startsWith("folder:")) return !world.folders().some((f) => f.id === tok.slice(7));
      if (tok.startsWith("server:")) return !srvById(tok.slice(7));
      if (tok.startsWith("domain:")) return !world.domains().some((d) => d.id === tok.slice(7));
      return !devById(tok);
    }
    const brokenToks = (t) => toks(t).filter(tokBroken);
    const broken = (t) => brokenToks(t).length > 0;
    const single = (t) => (t && !t.fromEvent && !isGroup(t) && t.include.length === 1 ? devById(t.include[0].id) : null);
    const covers = (t, id, dt) => !!t && !!id && (single(t) ? single(t).id === id : isGroup(t) && nodes(t, dt).some((n) => n.id === id));
    // Устройство, от которого пришло событие tk: из области — по номеру запуска
    function eventDevices(tk, i) {
      if (isGroup(tk.target)) {
        const ns = nodes(tk.target, triggerKind(tk).deviceTypes);
        return ns.length ? [ns[(i || 0) % ns.length]] : [];
      }
      return [single(tk.target)].filter(Boolean);
    }
    // Почему устройство не выполнит действие: без связи (оно или родитель), выключено, выключено правилом
    function devDown(n, keepOff, at, past) {
      for (const x of ancestors(n)) if (x.online === false && !(x.kind === "server" && x.allocated === false)) return msg("device.offline", { deviceId: x.id });
      if (keepOff) return null;
      const off = n.type === "camera" && !!n.disabledByRuleId;
      // История набора: камера выключена правилом с disabledByRuleAt — раньше этого времени суток она работала
      if (off && past && n.disabledByRuleAt && clock(wall(at)) < clock(wall(Date.parse(n.disabledByRuleAt)))) return null;
      if (off) return msg("device.ruleOff", { deviceId: n.id, ruleId: n.disabledByRuleId });
      return n.enabled === false ? msg("device.disabled", { deviceId: n.id }) : null;
    }
    const recording = (n) => n.type === "camera" && !!n.archiveId && !!n.recordMode && n.recordMode !== "none";

    /* ===== Проверка правила ===== */

    const ruleById = (id) => world.rules().find((r) => r.id === id) || null;
    const hasEnds = (r) => r.triggers.some((t) => triggerKind(t).ends);
    function items(r) {
      const out = [];
      const walk = (list, pre) => list.forEach((a, i) => {
        const path = [...pre, i];
        out.push({ it: a, path });
        branchesOf(a).forEach((b) => walk(a[b] || [], [...path, b]));
      });
      walk(r.steps, []);
      return out;
    }
    const tplUnknown = (s) => [...String(s || "").matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).filter((k) => !TPL_VARS.includes(k));
    const srcOk = (r, dt) => r.triggers.some((t) => triggerKind(t).deviceTypes.some((x) => dt.includes(x)));
    const roleOk = (id) => world.roles().some((x) => x.id === id);
    // Первая ошибка правила кодом (те же проверки, что подсказка в интерфейсе) или null
    function issue(r) {
      if (r.start === "event") {
        if (!r.triggers.length) return msg("rule.noTrigger");
        if (r.triggers.length > 1 && !r.windowSec) return msg("rule.noWindow");
        if (r.triggers.length === 1 && r.windowSec) return msg("rule.extraWindow");
        for (const t of r.triggers) {
          if (!t.target) return msg("trigger.noTarget", { kind: t.kind });
          if (isGroup(t.target) && !broken(t.target) && !nodes(t.target, triggerKind(t).deviceTypes).length) return msg("trigger.areaEmpty", { kind: t.kind });
        }
      } else if (r.start === "schedule" && (!r.runAt || !r.runAt.days.length || !/^\d\d:\d\d$/.test(r.runAt.time || ""))) return msg("rule.noRunAt");
      for (const c of r.conditions) {
        const k = condKind(c);
        if (c.kind === "mode" && !(c.modeIds || []).length) return msg("cond.noMode");
        if (c.kind === "time") {
          const s = schById(c.scheduleId);
          if (!s) return msg("cond.scheduleGone");
          if (schEmpty(s)) return msg("cond.scheduleEmpty", { scheduleId: s.id });
        }
        if (k.deviceTypes.length) {
          if (!c.target) return msg("cond.noTarget", { kind: c.kind });
          if (isGroup(c.target) && !broken(c.target) && !nodes(c.target, k.deviceTypes).length) return msg("cond.areaEmpty", { kind: c.kind });
        }
      }
      const all = items(r);
      if (!all.some((x) => x.it.action)) return msg("rule.noAction");
      for (const { it: a, path } of all) {
        if ((path.length - 1) / 2 > RULE_DEPTH) return msg("rule.tooDeep");
        if (a.control) {
          const p = controlIssue(a, r);
          if (p) return p;
          continue;
        }
        const k = actionKind(a);
        if (k.deviceTypes.length && !a.target) return msg("action.noTarget", { action: a.action });
        if (a.action === "record" && a.duration !== "event" && !(a.minutes > 0)) return msg("action.field", { action: a.action, field: "minutes" });
        const miss = k.fields.find((f) => !String(a[f] ?? "").trim());
        if (miss) return msg("action.field", { action: a.action, field: miss });
        if (isGroup(a.target) && !broken(a.target) && !nodes(a.target, k.deviceTypes).length) return msg("action.areaEmpty", { action: a.action });
        if (a.target && a.target.fromEvent && !srcOk(r, k.deviceTypes)) return msg("action.noEventDevice", { action: a.action });
        if (k.via && !notifier()) return msg("action.noNotifier", { action: a.action });
        if (a.action === "record" && a.duration === "event" && !hasEnds(r)) return msg("action.recordNoEnd");
        if (a.action === "runrule") {
          if (a.ruleId === r.id) return msg("chain.self");
          const t = ruleById(a.ruleId);
          if (!t) return msg("chain.ruleGone");
          if (t.allowChain === false) return msg("chain.forbidden", { ruleId: t.id });
        }
        for (const f of k.tpl || []) {
          const u = tplUnknown(a[f])[0];
          if (u) return msg("action.unknownVar", { action: a.action, name: u });
        }
      }
      if (r.ratePerMinute < 1 || r.ratePerMinute > 600) return msg("rule.rate");
      const gone = [r.triggers, r.conditions, all.map((x) => x.it), all.map((x) => x.it.event).filter(Boolean)].flat().some((x) => x && x.target && broken(x.target));
      return gone ? msg("rule.targetGone") : null;
    }
    function controlIssue(c, r) {
      const sec = (x) => x.sec >= 1 && x.sec <= 3600;
      if (c.control === "wait") return sec(c) ? null : msg("control.sec", { control: c.control });
      if (c.control === "waitEvent") {
        if (!c.event.target) return msg("control.noTarget", { control: c.control });
        if (isGroup(c.event.target) && !broken(c.event.target) && !nodes(c.event.target, triggerKind(c.event).deviceTypes).length) return msg("control.areaEmpty", { control: c.control });
        return sec(c) ? null : msg("control.sec", { control: c.control });
      }
      if (c.control === "ask") {
        if (!String(c.text || "").trim()) return msg("control.noText");
        const u = tplUnknown(c.text)[0];
        if (u) return msg("control.unknownVar", { name: u });
        if (!roleOk(c.roleId)) return msg("control.noRole", { control: c.control });
        return sec(c) ? null : msg("control.sec", { control: c.control });
      }
      const l = c.levels || [];
      if (!l.length) return msg("escalate.noLevels");
      if (l.length > RULE_ESC_MAX) return msg("escalate.tooMany", { max: RULE_ESC_MAX });
      if (l.some((x) => !roleOk(x.roleId))) return msg("control.noRole", { control: c.control });
      if (l.slice(0, -1).some((x) => !(x.waitMin >= 1 && x.waitMin <= 120))) return msg("escalate.wait");
      if (c.stop === "reset" && !hasEnds(r)) return msg("escalate.resetNoEnd");
      return null;
    }
    const notifier = () => world.devices().find((d) => d.type === "email") || null;

    /* ===== Запуск ===== */

    const muteAt = (r, ms) => {
      const m = r.mute;
      return m && ms < Date.parse(m.until) && (!m.since || ms >= Date.parse(m.since)) ? m : null;
    };
    const maintHit = (w, r, d) => !!w.enabled && (w.ruleIds == null || w.ruleIds.includes(r.id)) && schActive(w.scheduleId, d);
    // Кто из роли отвечает оператору и квитирует: первый пользователь с этой ролью
    const roleUser = (id) => ((world.users().find((u) => (u.roleIds || []).includes(id)) || {}).login || "");
    const addSec = (d, s) => new Date(d.getTime() + Math.round(s || 0) * 1000);

    function condCheck(c, o) {
      const d = o.date, fail = (w) => ({ code: "cond", params: { condition: c }, ok: false, reason: w });
      if (c.kind === "time") return schActive(c.scheduleId, d) ? { code: "cond", params: { condition: c }, ok: true, reason: null } : fail(msg("cond.time", { at: instant(d) }));
      if (c.kind === "mode") {
        const m = o.now ? modeNow(fromWall(d)) : modeSched(d);
        return (c.modeIds || []).includes(m) ? { code: "cond", params: { condition: c }, ok: true, reason: null } : fail(msg("cond.mode", { modeId: m }));
      }
      const k = condKind(c), ns = c.target && !broken(c.target) ? nodes(c.target, k.deviceTypes) : [];
      if (!ns.length) return fail(msg(!c.target ? "target.none" : broken(c.target) ? "target.deviceGone" : "target.areaEmpty"));
      const val = c.value !== false;
      const why = (n) => {
        if (c.kind === "armed") return !!n.armed === val ? null : { deviceId: n.id, code: val ? "disarmed" : "armed" };
        if (c.kind === "recording") return recording(n) ? null : { deviceId: n.id, code: "notRecording" };
        const w = devDown(n, true);
        return w ? { deviceId: n.id, code: "offline", viaId: w.params.deviceId } : null;
      };
      const bad = ns.map(why).filter(Boolean);
      if (!bad.length) return { code: "cond", params: { condition: c }, ok: true, reason: null };
      return fail(msg("cond.devices", { items: bad.slice(0, 2), more: Math.max(0, bad.length - 2) }));
    }
    function checksFor(r, o) {
      const c = [...(o.pre || [])];
      r.conditions.forEach((cd) => c.push(condCheck(cd, o)));
      if (o.via === "event" && r.triggers.length > 1 && (o.pre || []).every((x) => x.ok)) c.push({ code: "window", params: { sec: r.windowSec }, ok: true, reason: null });
      // Тишина: приглушение и окна обслуживания гасят запуск по событию и расписанию; запуск вручную — нет
      if (o.via !== "manual") {
        const ms = fromWall(o.date), m = muteAt(r, ms);
        if (m) c.push({ code: "muted", params: { until: m.until, by: m.by, reason: m.reason }, ok: false, reason: msg("skipped") });
        world.windows().filter((w) => maintHit(w, r, o.date)).forEach((w) => c.push({ code: "maintenance", params: { windowId: w.id, name: w.name }, ok: false, reason: msg("skipped") }));
      }
      if (o.via === "event" || o.via === "sched") {
        if (o.rateHit) c.push({ code: "rateHit", params: { max: r.ratePerMinute }, ok: false, reason: msg("skipped") });
        else c.push({ code: "rate", params: { n: o.rateN || 1, max: r.ratePerMinute }, ok: true, reason: null });
      }
      if (o.busy) {
        const rp = r.repeat || "skip";
        c.push(rp === "skip" ? { code: "busy", params: {}, ok: false, reason: msg("busy.skip") } : { code: "busy", params: {}, ok: true, reason: msg("busy." + rp) });
      }
      return c;
    }
    // Проверки пробного запуска по событиям, которые выбрал администратор
    function eventChecks(r, evs) {
      const used = new Set(), out = [];
      r.triggers.forEach((tk, j) => {
        const hit = evs.findIndex((e, x) => !used.has(x) && e.source === tk.source && e.kind === tk.kind && covers(tk.target, e.deviceId, triggerKind(tk).deviceTypes) &&
          Object.entries(tk.match || {}).every(([m, v]) => !v || (e.match || {})[m] === undefined || (e.match || {})[m] === v));
        if (hit >= 0) {
          used.add(hit);
          out.push({ code: "event.came", params: { trigger: tk, deviceId: evs[hit].deviceId }, ok: true, reason: null });
          return;
        }
        const other = evs.findIndex((e, x) => !used.has(x));
        if (other >= 0) {
          used.add(other);
          const e = evs[other];
          out.push({ code: "event.other", params: { event: { source: e.source, kind: e.kind, match: e.match || {} }, deviceId: e.deviceId }, ok: false, reason: msg("event.expected", { trigger: tk }) });
          return;
        }
        out.push({ code: "event.missing", params: { trigger: tk }, ok: false, reason: j > 0 ? msg("event.notInWindow", { sec: r.windowSec }) : msg("event.none") });
      });
      return out;
    }
    function controlRun(c, o) {
      const i = o.i || 0;
      if (c.control === "wait") return { label: msg("ctl.wait", { sec: c.sec }) };
      if (c.control === "waitEvent") {
        const pick = (o.br && o.br[o.key]) || (!o.test && i % 3 === 2 ? "no" : "yes");
        const n = eventDevices(c.event, i)[0], s = Math.max(1, Math.min((c.sec || 1) - 1, 5 + ((i * 7) % 20)));
        return { label: msg("ctl.waitEvent", { event: { source: c.event.source, kind: c.event.kind, match: c.event.match || {} }, target: c.event.target }), deviceId: n ? n.id : null, pick,
          note: pick === "yes" ? msg("waitEvent.came", { sec: s }) : msg("waitEvent.timeout", { sec: c.sec }) };
      }
      if (c.control === "ask") {
        const out = (o.br && o.br[o.key]) || (!o.test && i % 5 === 4 ? "none" : !o.test && i % 3 === 1 ? "no" : "yes");
        const pick = out === "none" ? (c.default === "yes" ? "yes" : "no") : out;
        const s = Math.max(1, Math.min((c.sec || 1) - 1, 4 + ((i * 11) % 40)));
        return { label: msg("ctl.ask", { text: c.text, roleId: c.roleId }), pick,
          note: out === "none" ? msg("ask.noAnswer", { sec: c.sec, counted: pick }) : msg("ask.answer", { answer: out, login: roleUser(c.roleId), at: instant(addSec(o.at, s)) }) };
      }
      const L = c.levels || [], out = (o.br && o.br[o.key]) || (!o.test ? (i % 3 === 0 ? "ack:1" : i % 3 === 1 ? "ack:2" : c.stop === "reset" ? "reset" : "none") : "ack:1");
      const stopAt = out === "none" ? L.length : out === "reset" ? 1 : Math.min(+out.split(":")[1], L.length), subs = [];
      let t = 0;
      L.forEach((l, j) => {
        if (j >= stopAt) {
          subs.push({ label: msg("esc.level", { n: j + 1, roleId: l.roleId, via: l.via, needed: false }), skip: true });
          return;
        }
        subs.push({ label: msg("esc.level", { n: j + 1, roleId: l.roleId, via: l.via, needed: true }), note: msg("clock", { at: instant(addSec(o.at, t)) }) });
        const last = j === stopAt - 1, wait = (l.waitMin || 0) * 60;
        if (last && out !== "none") {
          const w = Math.max(1, Math.min(wait ? wait - 1 : 600, 50 + ((i * 37) % 240)));
          subs.push({ label: out === "reset" ? msg("esc.reset", { at: instant(addSec(o.at, t + w)) }) : msg("esc.ack", { login: roleUser(l.roleId), at: instant(addSec(o.at, t + w)) }) });
        } else if (last) subs.push({ label: msg("esc.none") });
        else subs.push({ label: msg("esc.wait", { min: l.waitMin }) });
        t += wait;
      });
      return { label: msg("ctl.escalate", { roleIds: L.map((l) => l.roleId) }), note: msg("escalate.until", { stop: c.stop === "reset" ? "reset" : "ack" }), subs };
    }
    function stepDevices(a, src) {
      const k = actionKind(a), ok = k.deviceTypes;
      if (!ok.length) return k.via ? [notifier()].filter(Boolean) : [];
      if (a.target && a.target.fromEvent) return (src || []).map(devById).filter((n) => n && ok.includes(n.type));
      if (isGroup(a.target)) return nodes(a.target, ok);
      return [single(a.target)].filter(Boolean);
    }
    function stepsFor(r, o) {
      const out = [];
      const walk = (list, pre, depth) => list.forEach((a, i) => {
        const path = [...pre, i], key = path.join(".");
        if (a.control) {
          const res = controlRun(a, Object.assign({}, o, { key })), st = o.watch ? "would" : "ok";
          out.push({ path: key, deviceId: res.deviceId || null, action: null, label: res.label, control: true, skip: false, state: st, reason: null, note: res.note || null, depth });
          (res.subs || []).forEach((x) => out.push({ path: key, deviceId: null, action: null, label: x.label, control: true, skip: !!x.skip, state: x.skip ? "skip" : st, reason: null, note: x.note || null, depth: depth + 1 }));
          branchesOf(a).forEach((b) => {
            if (b === res.pick) walk(a[b] || [], [...path, b], depth + 1);
            else out.push({ path: key + "." + b, deviceId: null, action: null, label: msg("branch", { branch: b, control: a.control, test: !!o.test }), control: true, skip: true, state: "skip", reason: null, note: null, depth: depth + 1 });
          });
          return;
        }
        if (o.only && !o.only.has(key)) return;
        const k = actionKind(a), devs = stepDevices(a, o.src), keep = a.action === "disable";
        let note = null;
        if (a.action === "record" && a.duration === "event" && o.via === "event") {
          const ev = r.triggers.find((t) => triggerKind(t).ends);
          note = msg("record.untilEnd", { trigger: ev ? { source: ev.source, kind: ev.kind } : null, at: instant(o.endAt), afterSec: a.afterSec || 0 });
        }
        const mk = (id, why) => out.push({ path: key, deviceId: id, action: JSON.parse(JSON.stringify(a)), label: null, control: false, skip: false,
          state: why ? "fail" : o.watch ? "would" : "ok", reason: why || null, note, depth });
        // «Запустить правило»: шаги запущенного правила идут следом вложенными строками и в итог этого запуска не входят
        if (a.action === "runrule") {
          const t = ruleById(a.ruleId), lvl = (o.chain || 1) + 1;
          let why = !t ? msg("chain.ruleGone") : t.allowChain === false ? msg("chain.forbidden", { ruleId: t.id }) : lvl > RULE_CHAIN_MAX ? msg("chain.max", { max: RULE_CHAIN_MAX }) : !t.enabled ? msg("chain.ruleOff") : null;
          if (t && !why) {
            if (issue(t)) why = msg("chain.invalid", { ruleId: t.id });
            else {
              const bad = checksFor(t, { via: "chain", date: o.date, now: o.now }).find((c) => !c.ok);
              if (bad) why = msg("chain.check", { ruleId: t.id, check: bad });
            }
          }
          if (t && !why) note = msg("chain.level", { level: lvl, max: RULE_CHAIN_MAX });
          mk(null, why);
          if (t && !why)
            stepsFor(t, { src: o.src, watch: o.watch || t.logOnly, date: o.date, at: o.at, now: o.now, i: o.i, test: o.test, via: "chain", chain: lvl })
              .forEach((x) => out.push(Object.assign({}, x, { control: true, path: "", depth: x.depth + depth + 1 })));
          return;
        }
        // Удалённые части цели — отдельные отказавшие шаги: остальные устройства выполняются
        brokenToks(a.target).forEach((t) => mk(null, t.startsWith("gone:") ? msg("target.gone", { name: t.slice(5), area: false }) : msg(isArea(t) ? "target.areaGone" : "target.deviceGone", { token: t })));
        if (!devs.length && !broken(a.target)) {
          if (k.via) return mk(null, msg("notifier.gone"));
          if (!k.deviceTypes.length) return mk(null, null);
          return mk(single(a.target) ? single(a.target).id : null, msg(!a.target ? "target.none" : a.target.fromEvent ? "target.noEventDevice" : isGroup(a.target) ? "target.areaEmpty" : "target.deviceGone"));
        }
        devs.forEach((n) => mk(n.id, devDown(n, keep, fromWall(o.at), !o.now) || (o.flaky && o.flaky(key) ? msg("relay.timeout") : null)));
      });
      walk(r.steps, [], 0);
      return out;
    }
    /* Запуск правила r: что пришло, что проверено, что выполнено на каких устройствах. o: via — event | sched |
       manual | test; at — момент (мс); now — запуск сейчас (иначе — запись истории); i — номер запуска (исходы
       демо: какое событие из области, ответ оператора); events, pre — события и их проверки пробного запуска;
       src, only — устройства из событий и пути шагов повтора; br — исходы ветвлений; rateN, rateHit, busy,
       flaky — демо-история набора (tools/fixture_fires.js) */
    function fire(r, o) {
      const at = o.at, d = wall(at), via = o.via || (r.start === "schedule" ? "sched" : r.start), i = o.i || 0, watch = o.watch !== undefined ? o.watch : !!r.logOnly;
      let ev = o.events;
      if (!ev) {
        ev = [];
        if (via === "event")
          r.triggers.forEach((tk, j) => {
            const n = eventDevices(tk, i)[0];
            ev.push({ source: tk.source, kind: tk.kind, match: tk.match || {}, deviceId: n ? n.id : null,
              at: instant(new Date(d.getTime() - (r.triggers.length - 1 - j) * (6 + (i % 5)) * 1000)) });
          });
      }
      const src = o.src || ev.map((e) => e.deviceId).filter(Boolean);
      const checks = checksFor(r, Object.assign({}, o, { via, date: d }));
      const skip = checks.some((c) => !c.ok);
      const endAt = addSec(d, 25 + ((i * 13) % 40));
      let steps = stepsFor(r, { src, watch, only: o.only, flaky: o.flaky, at: d, date: d, now: o.now, i, br: o.br, test: o.by === "test", via, endAt });
      if (skip) steps = steps.map((s) => Object.assign({}, s, { state: "skip", reason: msg("skipped") }));
      const acts = steps.filter((s) => !s.control), n = acts.length, good = acts.filter((s) => s.state === "ok" || s.state === "would").length;
      const result = skip ? "skip" : watch ? (good || !n ? "watch" : "fail") : good === n ? "ok" : good ? "part" : "fail";
      return { ruleId: r.id, at: instant(d), by: o.by || via, logOnly: watch, sourceDeviceIds: src, events: ev, checks, steps, result };
    }

    // Повтор невыполненного: те же шаги (действия, как они были в том запуске) — на нынешних устройствах
    const retryable = (s) => s.state === "fail" && !s.control && s.action && s.action.action !== "runrule";
    function retry(r, f, at) {
      const steps = f.steps.filter(retryable).map((s) => {
        const n = s.deviceId ? devById(s.deviceId) : null, keep = s.action.action === "disable";
        const k = actionKind(s.action);
        const why = n ? devDown(n, keep) : !k.deviceTypes.length && !s.deviceId && !(s.reason && /^target\./.test(s.reason.code)) ? null
          : s.reason && /^target\.(gone|areaGone)$/.test(s.reason.code) ? s.reason : msg("target.deviceGone");
        return Object.assign({}, s, { state: why ? "fail" : "ok", reason: why, depth: 0 });
      });
      const g = steps.filter((s) => s.state === "ok").length;
      return { ruleId: r.id, at: instant(wall(at)), by: "manual", logOnly: false, sourceDeviceIds: [], events: [], checks: [], steps,
        result: g === steps.length ? "ok" : g ? "part" : "fail" };
    }

    return { fire, retry, retryable, issue, eventChecks, schActive: (id, ms) => schActive(id, wall(ms)), modeNow, modeNext, stamp: (ms) => stamp(wall(ms)), clock: (ms) => clock(wall(ms)), wall, fromWall };
  }

  // world поверх данных в виде набора (api/fixtures/demo.json): db() отдаёт их текущее состояние
  const forDb = (db) => create({
    tz: () => db().timezone,
    devices: () => db().devices, servers: () => db().servers, domains: () => db().domains, folders: () => db().folders, archives: () => db().archives,
    rules: () => db().rules, schedules: () => db().schedules, dayGroups: () => db().dayGroups, modes: () => db().modes, manualMode: () => db().modeManual,
    windows: () => db().maintenanceWindows, roles: () => db().access.roles, users: () => db().access.users,
  });
  const api = { create, forDb, TRIGGERS, CONDITIONS, ACTIONS, CONTROLS };
  if (typeof window !== "undefined") window.ConsolemRuleEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})();
