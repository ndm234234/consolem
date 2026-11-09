/* Движок «Автоматизации» — сторона сервера. Считает то, что в продукте считает бэкенд: действует ли
   расписание, какой сейчас режим объекта, что сделает правило при запуске. Подключается во встроенном
   сервере (api/server.js) и в сборке эталонного набора (tools/fixture_fires.js):
   демо-запуски набора посчитаны им же.

   Работает на объектах склада (Unit) и описаниях видов (UnitKind), без кода под вид: события объектов — из
   UnitKind.events (триггер {source: "unit", kinds?, implements?, event, match}), действия на объектах — из UnitKind.actions
   с ruleAction (шаг {type: "unitAction", action, target, params}), право назвать объект в правиле — right события или
   действия (уровень класса доступа вида, Role.kindAccess, folderAccess, objectAccess). Цель — {uid} или область
   {area: folder | server | domain, uid}. В коде остаются действия и условия не про объекты: уведомления, раскладка,
   запрос, запуск правила, время, режим, ход выполнения.
   Время — в часовом поясе системы: «стенные» даты — объекты Date, у которых UTC-поля равны местному времени системы.
   Трасса запуска — кодами: { code, params }. Подписи по кодам собирает интерфейс.

   create(world): world — доступ к данным сервера: store() — склад объектов (api/units.js: get, byKind, byFolder,
   byParent), kinds() — описания видов, rules(), schedules(), dayGroups(), modes() → { items, otherwise },
   manualMode() → { modeId, until } | null, windows(), roles(), users(), tz — часовой пояс системы (строка или функция). */
(() => {
  const RULE_CHAIN_MAX = 5;
  const RULE_DEPTH = 2;
  const RULE_ESC_MAX = 5;
  const TPL_VARS = ["камера", "устройство", "событие", "время", "правило"];
  // Справочники кодами: события и действия не про объекты (событий таких пока нет), условия, шаги хода выполнения.
  // События и действия объектов — в описаниях видов
  const TRIGGERS = [];
  // target — условию нужна цель; implements — у каких объектов (нет — у любого объекта правил)
  const CONDITIONS = [
    { kind: "time" },
    { kind: "mode" },
    { kind: "armed", implements: ["vms.camera/1"], target: true },
    { kind: "recording", implements: ["vms.camera/1"], target: true },
    { kind: "online", target: true },
  ];
  // Действия без объекта. fields — обязательные поля, tpl — поля-шаблоны, via — вид объекта-исполнителя (уведомитель)
  const ACTIONS = [
    { source: "client", action: "layout", fields: ["layoutId", "roleId"] },
    { source: "ntf", action: "email", fields: ["to", "subject"], tpl: ["subject", "body"], via: "email" },
    { source: "ntf", action: "tg", fields: ["chat", "text"], tpl: ["text"] },
    { source: "ntf", action: "push", fields: ["to", "subject"], tpl: ["subject", "body"] },
    { source: "client", action: "sound", fields: ["file", "roleId"] },
    { source: "client", action: "voice", fields: ["roleId"] },
    { source: "client", action: "view", fields: ["view", "roleId"] },
    { source: "client", action: "program", fields: ["path", "roleId"] },
    { source: "net", action: "http", fields: ["url"], tpl: ["url"] },
    { source: "rule", action: "runrule", fields: ["ruleId"] },
  ];
  const CONTROLS = [
    { control: "wait", branches: [] },
    { control: "waitEvent", branches: ["yes", "no"] },
    { control: "ask", branches: ["yes", "no"] },
    { control: "escalate", branches: [] },
    { control: "check", branches: ["yes", "no"] },
    { control: "after", branches: [] },
    { control: "abort", branches: [] },
  ];
  // Что проверяет шаг check
  const CHECKS = ["record", "safe", "armed", "online"];
  const UNIT_ACTION = "unitAction";
  const isUnitAction = (a) => !!a && a.type === UNIT_ACTION;
  const condKind = (c) => CONDITIONS.find((k) => k.kind === c.kind) || CONDITIONS[0];
  const sysAction = (a) => ACTIONS.find((k) => k.source === a.source && k.action === a.action) || null;
  const branchesOf = (c) => (CONTROLS.find((k) => k.control === c.control) || CONTROLS[0]).branches;
  const msg = (code, params) => ({ code, params: params || {} });
  // Вид без класса доступа — класс = код вида, уровни view < edit < admin
  const LEVELS_DEFAULT = ["view", "edit", "admin"];

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


    /* ===== Объекты, виды и цели ===== */

    const store = () => world.store();
    // Описания видов — по коду; кэш живёт, пока реестр отдаёт тот же список (put описания — новый список)
    let kindList = null, kindMap = new Map();
    function kindsNow() {
      const list = world.kinds();
      if (list !== kindList || list.length !== kindMap.size) {
        kindList = list;
        kindMap = new Map(list.map((k) => [k.kind, k]));
      }
      return kindMap;
    }
    const kindOf = (code) => kindsNow().get(code) || null;
    const evDesc = (code, ev) => ((kindOf(code) || {}).events || []).find((e) => e.id === ev) || null;
    const actDesc = (code, id) => ((kindOf(code) || {}).actions || []).find((a) => a.id === id && a.ruleAction) || null;
    const implementers = (list) => [...kindsNow().values()].filter((k) => (k.implements || []).some((p) => list.includes(p))).map((k) => k.kind);
    // Виды объектов правил: у вида есть события или действия правил
    const ruleKinds = () => [...kindsNow().values()].filter((k) => (k.events || []).length || (k.actions || []).some((a) => a.ruleAction)).map((k) => k.kind);
    // Виды события триггера: названные (kinds или implements), у которых это событие есть; не названы — все виды с этим событием
    function trigKinds(t) {
      const named = t.kinds ? t.kinds : t.implements ? implementers(t.implements) : [...kindsNow().keys()];
      return named.filter((k) => { const e = evDesc(k, t.event); return !!e && e.rule !== false; }); // rule:false — не триггер правила
    }
    const ends = (t) => trigKinds(t).some((k) => evDesc(k, t.event).ends);
    // Виды действия на объекте: у кого действие правила с этим кодом
    const actKinds = (a) => (isUnitAction(a) ? [...kindsNow().keys()].filter((k) => !!actDesc(k, a.action)) : []);
    const condKinds = (c) => (condKind(c).implements ? implementers(condKind(c).implements) : ruleKinds());
    // Виды шага check: запись, защита и охрана — у камер, связь — у любого объекта правил
    const checkKinds = (c) => (c.what === "online" ? ruleKinds() : implementers(["vms.camera/1"]));

    // Запись объекта для движка: свойства и наблюдаемое состояние — полями, как в записи устройства
    function recOf(u) {
      if (!u) return null;
      const st = u.status || {};
      return Object.assign({}, u.properties || {}, st.observed || {}, { id: u.uid, type: u.kind, parentId: u.parentId || null, domainId: u.domainId || null, name: u.name },
        st.link ? { online: st.link !== "offline" } : {});
    }
    const devById = (id) => (id ? recOf(store().get(id)) : null);
    const unitIs = (id, kind) => { const u = id ? store().get(id) : null; return !!u && u.kind === kind; };
    // Цепочка «объект → родители»; у исполнителя уведомлений (svc) — ещё и сервер, на котором он живёт: связь теряется, если
    // без связи кто-то из них
    function ancestors(n, svc) {
      const out = [n];
      let x = n;
      while (x.parentId) {
        const p = devById(x.parentId);
        if (!p) break;
        out.push(p);
        x = p;
      }
      if (svc && x.serverId && unitIs(x.serverId, "server")) out.push(Object.assign({ kind: "server" }, devById(x.serverId)));
      return out;
    }
    // Сервер объекта: сервер-родитель, сервер в свойстве serverId, сервер хранилища, куда объект пишет
    function devServer(n) {
      for (const x of ancestors(n)) {
        if (x.type === "server") return x.id;
        if (x.serverId && unitIs(x.serverId, "server")) return x.serverId;
        if (x.archiveId && x.recordMode && x.recordMode !== "none") {
          const a = store().get(x.archiveId);
          if (a && a.parentId && unitIs(a.parentId, "server")) return a.parentId;
        }
      }
      return "";
    }
    // Папка — с подпапками; в ней — объекты папок и их дочерние
    function folderDevs(fid) {
      const out = new Map();
      if (!unitIs(fid, "folder")) return out;
      const kids = (id) => store().byParent(id).forEach((u) => { out.set(u.uid, recOf(u)); kids(u.uid); });
      const sub = (id) => {
        store().byFolder(id).forEach((u) => {
          out.set(u.uid, recOf(u));
          kids(u.uid);
        });
        store().byParent(id).filter((u) => u.kind === "folder").forEach((f) => sub(f.uid));
      };
      sub(fid);
      return out;
    }
    // Цель → строки-элементы, как их сортирует интерфейс: объект — uid, область — вид:uid, удалённое — gone:имя
    const toks = (t) => (t ? [...t.include.map((x) => (x.area ? `${x.area}:${x.uid}` : x.uid)), ...t.gone.map((g) => "gone:" + g)].sort() : []);
    const isArea = (tok) => /^(folder|server|domain):/.test(tok || "");
    const isGroup = (t) => !!t && (t.include.length + t.gone.length > 1 || t.exclude.length > 0 || t.include.some((x) => !!x.area));
    function tokNodes(tok, kinds) {
      const i = tok.indexOf(":"), k = i < 0 ? "" : tok.slice(0, i), v = tok.slice(i + 1);
      const all = () => kinds.flatMap((kind) => store().byKind(kind)).map(recOf);
      if (k === "folder") return [...folderDevs(v).values()].filter((n) => kinds.includes(n.type));
      if (k === "server") return all().filter((n) => devServer(n) === v);
      if (k === "domain") return all().filter((n) => n.domainId === v);
      if (k === "gone" || !tok) return [];
      const n = devById(tok);
      return n ? [n] : [];
    }
    function nodes(t, kinds) {
      if (!t) return [];
      kinds = kinds || ruleKinds();
      const no = new Set(t.exclude), out = new Map();
      toks(t).forEach((x) => tokNodes(x, kinds).forEach((n) => { if (!no.has(n.id)) out.set(n.id, n); }));
      return [...out.values()];
    }
    function tokBroken(tok) {
      if (tok.startsWith("gone:")) return true;
      const i = tok.indexOf(":");
      if (i > 0) return !unitIs(tok.slice(i + 1), tok.slice(0, i));
      return !store().get(tok);
    }
    const brokenToks = (t) => toks(t).filter(tokBroken);
    const broken = (t) => brokenToks(t).length > 0;
    const single = (t) => (t && !t.fromEvent && !isGroup(t) && t.include.length === 1 ? devById(t.include[0].uid) : null);
    const covers = (t, id, kinds) => !!t && !!id && (single(t) ? single(t).id === id : isGroup(t) && nodes(t, kinds).some((n) => n.id === id));
    // Объект, от которого пришло событие tk: из области — по номеру запуска
    function eventDevices(tk, i) {
      if (isGroup(tk.target)) {
        const ns = nodes(tk.target, trigKinds(tk));
        return ns.length ? [ns[(i || 0) % ns.length]] : [];
      }
      return [single(tk.target)].filter(Boolean);
    }
    // Почему объект не выполнит действие: без связи (он или родитель), выключен, выключен правилом
    function devDown(n, keepOff, at, past, svc) {
      for (const x of ancestors(n, svc)) if (x.online === false && !(x.kind === "server" && x.allocated === false)) return msg("device.offline", { deviceId: x.id });
      if (keepOff) return null;
      const off = !!n.disabledByRuleId;
      // История набора: объект выключен правилом с disabledByRuleAt — раньше этого времени суток он работал
      if (off && past && n.disabledByRuleAt && clock(wall(at)) < clock(wall(Date.parse(n.disabledByRuleAt)))) return null;
      if (off) return msg("device.ruleOff", { deviceId: n.id, ruleId: n.disabledByRuleId });
      return n.enabled === false ? msg("device.disabled", { deviceId: n.id }) : null;
    }
    const recording = (n) => !!n.archiveId && !!n.recordMode && n.recordMode !== "none";
    // Защищённая запись на встроенном сервере: архив камеры зашифрован (другой метки защиты у склада нет)
    // Камера пишет сейчас: по настройкам и по наблюдаемому состоянию (recordState: running; нет поля — не опровергнуто)
    const recordsNow = (n) => n.recordState === undefined || n.recordState === "running";
    const archiveSafe = (n) => {
      const a = n.archiveId ? store().get(n.archiveId) : null;
      return !!a && !!(a.properties || {}).encrypted;
    };
    // Есть ли что проверять: у камеры есть запись, если названо хранилище — в нём
    const hasRecord = (n, archive) => (archive ? [n.archiveId, ...(n.extraArchives || []).map((x) => x.archiveId)].includes(archive) : !!n.archiveId || !!(n.extraArchives || []).length);
    const paramsOf = (a) => (isUnitAction(a) ? a.params || {} : a);

    /* ===== Права ===== */

    // Уровни класса cls: у вида — основной класс (access) и дополнительные (access.also); класс без описания у вида —
    // по любому виду, который его объявил; вид без класса — свой код, view < edit < admin
    function classLevels(code, cls) {
      const k = kindOf(code) || {};
      const own = [k.access, ...((k.access || {}).also || [])].filter(Boolean).find((x) => x.class === cls);
      if (own) return own.levels;
      if (!k.access && cls === code) return LEVELS_DEFAULT;
      for (const x of kindsNow().values()) {
        const hit = [x.access, ...((x.access || {}).also || [])].filter(Boolean).find((y) => y.class === cls);
        if (hit) return hit.levels;
      }
      return null;
    }
    const primaryClass = (code) => (((kindOf(code) || {}).access || {}).class) || code;
    // Право на объект вида code для события или действия: {cls, level} или null — не судится
    function rightOf(desc, code) {
      if (!desc || !desc.right || !desc.right.level) return null;
      return { cls: desc.right.class || primaryClass(code), level: desc.right.level, kind: code };
    }
    const roleById = (id) => world.roles().find((x) => x.id === id) || null;
    const enough = (levels, need) => (v) => !!v && !!levels && levels.indexOf(v) >= levels.indexOf(need) && levels.indexOf(need) >= 0;
    // Права роли на объект: запись самого объекта, папки над ним, домен, умолчание роли (kindAccess). Встроенная «Администратор» — всё
    function roleAllows(id, n, right) {
      const role = roleById(id);
      if (!role) return false;
      if (role.global.unr || !right) return true;
      const ok = enough(classLevels(n.type, right.cls), right.level), cls = right.cls;
      const own = (role.objectAccess[n.id] || {})[cls];
      if (own) return ok(own);
      const u = store().get(n.id);
      const inFolders = ((u && u.folders) || []).map((fid) => store().get(fid)).filter(Boolean).flatMap(folderChain).map((f) => (role.folderAccess[f.uid] || {})[cls]).filter(Boolean);
      if (inFolders.length) return inFolders.some(ok);
      return ok((role.folderAccess[n.domainId] || {})[cls] || (role.kindAccess || {})[cls]);
    }
    function folderChain(f) {
      const out = [];
      for (let x = f; x && x.kind === "folder"; x = x.parentId ? store().get(x.parentId) : null) out.push(x);
      return out;
    }
    // Права роли на область: папка и домен — своя запись или умолчание роли, сервер — только умолчание
    function roleAllowsArea(id, x, right) {
      const role = roleById(id);
      if (!role) return false;
      if (role.global.unr || !right) return true;
      const own = x.area === "server" ? null : (role.folderAccess[x.uid] || {})[right.cls];
      return enough(classLevels(right.kind, right.cls), right.level)(own || (role.kindAccess || {})[right.cls]);
    }
    // Права, которые нужны на элемент цели: по видам события или действия (у объекта — его вид, у области — все виды)
    const eventRights = (t) => trigKinds(t).map((k) => rightOf(evDesc(k, t.event), k));
    // Право действия в правиле: ruleRight описания, если у шага правила оно своё (команда реле: в правиле — уровень реле), иначе right
    const ruleDesc = (d) => (d && d.ruleRight ? Object.assign({}, d, { right: d.ruleRight }) : d);
    const actionRights = (a) => actKinds(a).map((k) => rightOf(ruleDesc(actDesc(k, a.action)), k));
    // Что правило называет: элементы include событий, шагов и ожидаемых событий — с правами по их видам. Условия и exclude — нет
    function named(r) {
      const out = [], add = (t, rights) => t && t.include.forEach((x) => out.push({ x, rights }));
      r.triggers.forEach((t) => add(t.target, eventRights(t)));
      items(r).forEach(({ it }) => {
        if (isUnitAction(it)) add(it.target, actionRights(it));
        if (it.event) add(it.event.target, eventRights(it.event));
      });
      return out;
    }
    // Первое, на что ни у одной из ролей нет права, или null: элемент цели {uid} или {area, uid}. Область судится одним правом
    // справочника (ref.ruleTargets.areaRight), какими бы ни были события и действия; нет его — не судится
    function forbidden(r, roleIds, ref) {
      const ar = ((ref || {}).ruleTargets || {}).areaRight, area = ar && ar.class ? { cls: ar.class, level: ar.level, kind: null } : null;
      const bad = named(r).find(({ x, rights }) => {
        if (x.area) return !!area && !roleIds.some((id) => roleAllowsArea(id, x, area));
        const n = devById(x.uid);
        if (!n) return false;
        const rt = rights.find((y) => y && y.kind === n.type) || null;
        return !roleIds.some((id) => roleAllows(id, n, rt));
      });
      return bad ? bad.x : null;
    }
    // Право шага на объекте n: по описанию действия его вида
    const stepRight = (a, n) => rightOf(ruleDesc(actDesc(n.type, a.action)), n.type);

    /* ===== Домены правила ===== */

    // Домены целей: события, условия, шаги. Домен контракта — кластер правила (ADR-0111 пп. 8, 10)
    function domainsOf(r) {
      const out = new Set(), one = (x) => {
        if (x.area === "domain") return out.add(x.uid);
        const u = store().get(x.uid);
        if (u && u.domainId) out.add(u.domainId);
      };
      const add = (t) => t && t.include.forEach(one);
      r.triggers.forEach((t) => add(t.target));
      r.conditions.forEach((c) => add(c.target));
      items(r).forEach(({ it }) => {
        add(it.target);
        if (it.event) add(it.event.target);
      });
      return [...out];
    }
    // Шаг, которого правило с целями из нескольких доменов не исполняет, или null
    function crossDomain(r, ref) {
      if (!ref.ruleCrossDomainActions || domainsOf(r).length < 2) return null;
      const bad = items(r).find(({ it }) => !ref.ruleCrossDomainActions.includes(it.action));
      return bad ? msg("rule.crossDomain", { step: bad.it.action || bad.it.control }) : null;
    }

    /* ===== Проверка правила ===== */

    const ruleById = (id) => world.rules().find((r) => r.id === id) || null;
    const hasEnds = (r) => r.triggers.some(ends);
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
    // Действие на объекте сверяется с описанием его вида: у объекта цели — его вид, иначе — первый вид, где действие есть
    function descOf(a) {
      const one = single(a.target);
      if (one && actDesc(one.type, a.action)) return actDesc(one.type, a.action);
      const k = actKinds(a)[0];
      return k ? actDesc(k, a.action) : null;
    }
    // Схема параметров действия: обязательные (required), числа в пределах (minimum, maximum), шаблоны (x-template)
    const propsOf = (d) => ((d && d.params) || {}).properties || {};
    function paramIssue(a, d) {
      const p = paramsOf(a), props = propsOf(d);
      const miss = (((d && d.params) || {}).required || []).find((f) => !String(p[f] ?? "").trim());
      if (miss) return msg("action.field", { action: a.action, field: miss });
      const out = Object.keys(props).find((f) => typeof p[f] === "number" && ((props[f].minimum != null && p[f] < props[f].minimum) || (props[f].maximum != null && p[f] > props[f].maximum)));
      return out ? msg("action.field", { action: a.action, field: out }) : null;
    }
    const tplOf = (a, d) => (isUnitAction(a) ? Object.keys(propsOf(d)).filter((f) => propsOf(d)[f]["x-template"]) : (sysAction(a) || {}).tpl || []);
    // Действие с целью «объект из события»: среди событий правила есть событие объекта, на котором действие есть
    const srcOk = (r, kinds) => r.triggers.some((t) => trigKinds(t).some((x) => kinds.includes(x)));
    const roleOk = (id) => world.roles().some((x) => x.id === id);
    // Первая ошибка правила кодом (те же проверки, что подсказка в интерфейсе) или null
    function issue(r) {
      if (r.start === "event") {
        if (!r.triggers.length) return msg("rule.noTrigger");
        const any = r.whenLogic === "any";
        if (r.triggers.length > 1 && !any && !r.windowSec) return msg("rule.noWindow");
        if ((r.triggers.length === 1 || any) && r.windowSec) return msg("rule.extraWindow");
        for (const t of r.triggers) {
          if (!t.target) return msg("trigger.noTarget", { event: t.event });
          if (isGroup(t.target) && !broken(t.target) && !nodes(t.target, trigKinds(t)).length) return msg("trigger.areaEmpty", { event: t.event });
        }
      } else if (r.start === "schedule") {
        if (!r.runAt || !r.runAt.days.length || !/^\d\d:\d\d$/.test(r.runAt.time || "")) return msg("rule.noRunAt");
        if (r.runAt.randomShift && !r.runAt.everyMin) return msg("rule.noEvery");
      }
      for (const c of r.conditions) {
        const k = condKind(c);
        if (c.kind === "mode" && !(c.modeIds || []).length) return msg("cond.noMode");
        if (c.kind === "time") {
          const s = schById(c.scheduleId);
          if (!s) return msg("cond.scheduleGone");
          if (schEmpty(s)) return msg("cond.scheduleEmpty", { scheduleId: s.id });
        }
        if (k.target) {
          if (!c.target) return msg("cond.noTarget", { kind: c.kind });
          if (isGroup(c.target) && !broken(c.target) && !nodes(c.target, condKinds(c)).length) return msg("cond.areaEmpty", { kind: c.kind });
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
        const unit = isUnitAction(a), kinds = actKinds(a), d = unit ? descOf(a) : null, p = paramsOf(a);
        if (unit && !a.target) return msg("action.noTarget", { action: a.action });
        if (a.action === "record" && p.duration !== "event" && !(p.minutes > 0)) return msg("action.field", { action: a.action, field: "minutes" });
        if (a.action === "scan" && (p.beforeSec ?? 60) === 0 && (p.afterSec ?? 60) === 0) return msg("action.scanWindow");
        if (unit) {
          const why = paramIssue(a, d);
          if (why) return why;
        } else {
          const miss = ((sysAction(a) || {}).fields || []).find((f) => !String(a[f] ?? "").trim());
          if (miss) return msg("action.field", { action: a.action, field: miss });
        }
        if (unit && isGroup(a.target) && !broken(a.target) && !nodes(a.target, kinds).length) return msg("action.areaEmpty", { action: a.action });
        if (unit && a.target.fromEvent && !srcOk(r, kinds)) return msg("action.noEventDevice", { action: a.action });
        if (!unit && (sysAction(a) || {}).via && !notifier(sysAction(a).via)) return msg("action.noNotifier", { action: a.action });
        if (a.action === "record" && p.duration === "event" && !hasEnds(r)) return msg("action.recordNoEnd");
        if (a.action === "runrule") {
          if (a.ruleId === r.id) return msg("chain.self");
          const t = ruleById(a.ruleId);
          if (!t) return msg("chain.ruleGone");
          if (t.allowChain === false) return msg("chain.forbidden", { ruleId: t.id });
        }
        for (const f of tplOf(a, d)) {
          const u = tplUnknown(p[f])[0];
          if (u) return msg("action.unknownVar", { action: a.action, name: u });
        }
      }
      if (r.ratePerMinute < 1 || r.ratePerMinute > 600) return msg("rule.rate");
      const gone = [r.triggers, r.conditions, all.map((x) => x.it), all.map((x) => x.it.event).filter(Boolean)].flat().some((x) => x && x.target && broken(x.target));
      return gone ? msg("rule.targetGone") : null;
    }
    function controlIssue(c, r) {
      const sec = (x) => x.sec >= 1 && x.sec <= 3600;
      if (c.control === "wait" || c.control === "after") return sec(c) ? null : msg("control.sec", { control: c.control });
      if (c.control === "abort") return null;
      if (c.control === "check") {
        if (!CHECKS.includes(c.what)) return msg("control.noWhat", { control: c.control });
        if (!c.target) return msg("control.noTarget", { control: c.control });
        const kinds = checkKinds(c);
        if (c.target.fromEvent && !srcOk(r, kinds)) return msg("control.noEventDevice", { control: c.control });
        if (isGroup(c.target) && !broken(c.target) && !nodes(c.target, kinds).length) return msg("control.areaEmpty", { control: c.control });
        if ((c.what === "record" || c.what === "safe") && !(c.depthSec >= 1 && c.depthSec <= 86400)) return msg("control.depth", { control: c.control });
        return null;
      }
      if (c.control === "waitEvent") {
        if (!c.event.target) return msg("control.noTarget", { control: c.control });
        if (isGroup(c.event.target) && !broken(c.event.target) && !nodes(c.event.target, trigKinds(c.event)).length) return msg("control.areaEmpty", { control: c.control });
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
      if (l.slice(0, -1).some((x) => !(x.waitMin >= 1 && x.waitMin <= 120)) || !(l[l.length - 1].waitMin >= 0 && l[l.length - 1].waitMin <= 120)) return msg("escalate.wait");
      if (c.stop === "reset" && !hasEnds(r)) return msg("escalate.resetNoEnd");
      return null;
    }
    // Исполнитель уведомлений: первый объект вида via
    const notifier = (via) => recOf(store().byKind(via || "email")[0]);

    /* ===== Каталог: что объявила система ===== */

    // Необязательные поля действия без объекта: нет в справочнике — у действия их нет (reference.ruleActions)
    const FIELDS_OPTIONAL = ["method", "body", "attach", "auth", "headers"];
    // Правило вне каталога: { field — раздел, issue } или null. ref — справочник системы; события и действия объектов —
    // описания видов
    function undeclared(r, ref) {
      const bad = (field, code, params) => ({ field, issue: msg(code, params) });
      const targetBad = (t, field) => {
        const on = ref.ruleTargets;
        if (!t || !on) return null;
        const x = t.include.find((i) => i.area && !on.areas.includes(i.area));
        if (x) return bad(field, "target.notDeclared", { area: x.area });
        return t.fromEvent && !on.fromEvent ? bad(field, "target.notDeclared", { fromEvent: true }) : null;
      };
      const eventBad = (t, field) => {
        if (t.source !== "unit") return (ref.ruleTriggers || TRIGGERS).some((k) => k.source === t.source && k.kind === t.kind) ? targetBad(t.target, field) : bad(field, "trigger.notDeclared", { source: t.source });
        const named = t.kinds || [];
        const stray = named.find((k) => !evDesc(k, t.event));
        if (stray || !trigKinds(t).length) return bad(field, "trigger.notDeclared", Object.assign({ event: t.event }, stray ? { kind: stray } : {}));
        return targetBad(t.target, field);
      };
      const stepBad = (a) => {
        if (a.control) {
          if (!ref.ruleControls.some((k) => k.control === a.control)) return bad("steps", "control.notDeclared", { control: a.control });
          return a.event ? eventBad(a.event, "steps") : a.control === "check" ? targetBad(a.target, "steps") : null;
        }
        if (isUnitAction(a)) {
          const kinds = actKinds(a);
          if (!kinds.length) return bad("steps", "action.notDeclared", { action: a.action });
          const one = single(a.target);
          if (one && !actDesc(one.type, a.action)) return bad("steps", "action.notDeclared", { action: a.action, kind: one.type });
          const ds = one ? [actDesc(one.type, a.action)] : kinds.map((k) => actDesc(k, a.action));
          const p = a.params || {};
          const field = Object.keys(p).find((f) => p[f] != null && p[f] !== "" && !ds.some((d) => {
            const s = propsOf(d)[f];
            return !!s && (!s.enum || s.enum.includes(p[f]));
          }));
          if (field) return bad("steps", "action.fieldNotDeclared", { action: a.action, field });
          return targetBad(a.target, "steps");
        }
        const k = ref.ruleActions.find((x) => x.source === a.source && x.action === a.action);
        if (!k) return bad("steps", "action.notDeclared", { action: a.action });
        const value = k.fields.find((f) => (f.options || []).length && a[f.id] != null && a[f.id] !== "" && !f.options.includes(a[f.id]));
        if (value) return bad("steps", "action.fieldNotDeclared", { action: a.action, field: value.id });
        const extra = FIELDS_OPTIONAL.find((f) => a[f] && !k.fields.some((x) => x.id === f));
        if (extra) return bad("steps", "action.fieldNotDeclared", { action: a.action, field: extra });
        return null;
      };
      if (ref.ruleStarts && !ref.ruleStarts.includes(r.start)) return bad("start", "rule.startNotDeclared", { start: r.start });
      // Логика и интервал правила: что система не объявила в reference.ruleFeatures, она не исполняет
      const feat = (name) => (ref.ruleFeatures || []).includes(name);
      if (r.whenLogic === "any" && !feat("whenAny")) return bad("triggers", "rule.featureNotDeclared", { feature: "whenAny" });
      if (r.condLogic === "any" && !feat("condAny")) return bad("conditions", "rule.featureNotDeclared", { feature: "condAny" });
      if (r.runAt && (r.runAt.everyMin || r.runAt.randomShift) && !feat("every")) return bad("start", "rule.featureNotDeclared", { feature: "every" });
      for (const t of r.triggers) {
        const p = eventBad(t, "triggers");
        if (p) return p;
      }
      for (const c of r.conditions) {
        if (!ref.ruleConditions.some((k) => k.kind === c.kind)) return bad("conditions", "cond.notDeclared", { kind: c.kind });
        const p = targetBad(c.target, "conditions");
        if (p) return p;
      }
      for (const { it } of items(r)) {
        const p = stepBad(it);
        if (p) return p;
      }
      return null;
    }

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
      const ns = c.target && !broken(c.target) ? nodes(c.target, condKinds(c)) : [];
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
      // any: достаточно одного выполненного условия — в проверки идут выполненные, а если их нет, то все невыполненные
      const cc = r.conditions.map((cd) => condCheck(cd, o));
      c.push(...(r.condLogic === "any" && cc.some((x) => x.ok) ? cc.filter((x) => x.ok) : cc));
      if (o.via === "event" && r.triggers.length > 1 && r.whenLogic !== "any" && (o.pre || []).every((x) => x.ok)) c.push({ code: "window", params: { sec: r.windowSec }, ok: true, reason: null });
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
        const rp = o.busyAs || r.repeat || "skip";
        c.push(rp === "skip" ? { code: "busy", params: {}, ok: false, reason: msg("busy.skip") } : { code: "busy", params: {}, ok: true, reason: msg("busy." + rp) });
      }
      return c;
    }
    // Проверки пробного запуска по событиям, которые выбрал администратор
    function eventChecks(r, evs) {
      const used = new Set(), out = [];
      const any = r.whenLogic === "any" && r.triggers.length > 1;
      const fits = (tk, e) => e.source === tk.source && e.event === tk.event && covers(tk.target, e.deviceId, trigKinds(tk)) &&
        Object.entries(tk.match || {}).every(([m, v]) => v === "" || v == null || (e.match || {})[m] === undefined || (e.match || {})[m] === v);
      // any: каждое событие примеряется ко всем событиям правила; подошло любое — проверка пройдена, прочие события не лишние
      if (any) {
        const done = [];
        r.triggers.forEach((tk) => {
          const e = evs.find((x) => fits(tk, x));
          if (e) done.push({ code: "event.came", params: { trigger: tk, deviceId: e.deviceId }, ok: true, reason: null });
        });
        if (done.length) return done;
      }
      r.triggers.forEach((tk, j) => {
        const hit = evs.findIndex((e, x) => !used.has(x) && fits(tk, e));
        if (hit >= 0) {
          used.add(hit);
          out.push({ code: "event.came", params: { trigger: tk, deviceId: evs[hit].deviceId }, ok: true, reason: null });
          return;
        }
        const other = evs.findIndex((e, x) => !used.has(x));
        if (other >= 0) {
          used.add(other);
          const e = evs[other];
          out.push({ code: "event.other", params: { event: { source: e.source, event: e.event, match: e.match || {} }, deviceId: e.deviceId }, ok: false, reason: msg("event.expected", { trigger: tk }) });
          return;
        }
        out.push({ code: "event.missing", params: { trigger: tk }, ok: false, reason: j > 0 && !any ? msg("event.notInWindow", { sec: r.windowSec }) : msg("event.none") });
      });
      // any: запускает любое одно событие. Пришедшее — проверка пройдена; ни одно не пришло — остаются отказы
      if (any && out.some((x) => x.ok)) return out.filter((x) => x.ok);
      return out;
    }
    function controlRun(c, o) {
      const i = o.i || 0;
      if (c.control === "wait") return { label: msg("ctl.wait", { sec: c.sec }) };
      if (c.control === "after") return { label: msg("ctl.after", { sec: c.sec }), note: msg("after.ended") };
      if (c.control === "abort") return { label: msg("ctl.abort"), abort: true, note: msg("abort.stop") };
      if (c.control === "check") {
        const kinds = checkKinds(c);
        const ns = c.target && c.target.fromEvent ? (o.src || []).map(devById).filter((n) => n && kinds.includes(n.type)) : c.target && !broken(c.target) ? nodes(c.target, kinds) : [];
        const good = (n) => (c.what === "record" ? recording(n) && recordsNow(n) : c.what === "safe" ? recording(n) && recordsNow(n) && archiveSafe(n) : c.what === "armed" ? !!n.armed : !devDown(n, true));
        const bad = ns.filter((n) => !good(n));
        const pick = (o.br && o.br[o.key]) || (ns.length && !bad.length ? "yes" : "no");
        // Запуск, который встанет на вопросе, при возобновлении не пересудит проверку: исход запоминается в br
        if (o.live && o.br && !o.br[o.key]) o.br[o.key] = pick;
        return { label: msg("ctl.check", { what: c.what, depthSec: c.depthSec == null ? null : c.depthSec, target: c.target }), deviceId: (bad[0] || ns[0] || {}).id || null, pick,
          note: msg(pick === "yes" ? "check.yes" : ns.length ? "check.no" : "check.none", { what: c.what, items: bad.slice(0, 2).map((n) => n.id), more: Math.max(0, bad.length - 2) }) };
      }
      if (c.control === "waitEvent") {
        const pick = (o.br && o.br[o.key]) || (!o.test && i % 3 === 2 ? "no" : "yes");
        const n = eventDevices(c.event, i)[0], s = Math.max(1, Math.min((c.sec || 1) - 1, 5 + ((i * 7) % 20)));
        return { label: msg("ctl.waitEvent", { event: { source: c.event.source, event: c.event.event, match: c.event.match || {} }, target: c.event.target }), deviceId: n ? n.id : null, pick,
          note: pick === "yes" ? msg("waitEvent.came", { sec: s }) : msg("waitEvent.timeout", { sec: c.sec }) };
      }
      const who = o.who && o.who[o.key];
      if (c.control === "ask") {
        if (o.live && !(o.br && o.br[o.key])) return { label: msg("ctl.ask", { text: c.text, roleId: c.roleId }), pause: true, note: msg("ask.waiting") };
        const silent = o.noHuman || (o.watch && !o.test);
        const out = (o.br && o.br[o.key]) || (silent ? "none" : !o.test && i % 5 === 4 ? "none" : !o.test && i % 3 === 1 ? "no" : "yes");
        const pick = out === "none" ? (c.default === "yes" ? "yes" : "no") : out;
        const s = Math.max(1, Math.min((c.sec || 1) - 1, 4 + ((i * 11) % 40)));
        return { label: msg("ctl.ask", { text: c.text, roleId: c.roleId }), pick,
          note: out === "none" ? msg("ask.noAnswer", { sec: c.sec, counted: pick }) : msg("ask.answer", { answer: out, login: who ? who.login : roleUser(c.roleId), at: who ? who.at : instant(addSec(o.at, s)) }) };
      }
      const L = c.levels || [];
      if (o.live && !(o.br && o.br[o.key])) return { label: msg("ctl.escalate", { roleIds: L.map((l) => l.roleId) }), pause: true, note: msg("escalate.until", { stop: c.stop === "reset" ? "reset" : "ack" }) };
      const out = (o.br && o.br[o.key]) || (o.noHuman || (o.watch && !o.test) ? "none" : !o.test ? (i % 3 === 0 ? "ack:1" : i % 3 === 1 ? "ack:2" : c.stop === "reset" ? "reset" : "none") : "ack:1");
      // Запуск с настоящим ответом: на каком уровне остановились — докуда дошло, а не кто квитировал
      const stopAt = who && who.level ? Math.min(who.level, L.length) : out === "none" ? L.length : out === "reset" ? 1 : Math.min(+out.split(":")[1], L.length), subs = [];
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
          const when = who ? who.at : instant(addSec(o.at, t + w));
          subs.push({ label: out === "reset" ? msg("esc.reset", { at: when }) : msg("esc.ack", { login: who ? who.login : roleUser(l.roleId), at: when }) });
        } else if (last) subs.push({ label: msg("esc.none") });
        else subs.push({ label: msg("esc.wait", { min: l.waitMin }) });
        t += wait;
      });
      return { label: msg("ctl.escalate", { roleIds: L.map((l) => l.roleId) }), note: msg("escalate.until", { stop: c.stop === "reset" ? "reset" : "ack" }), subs };
    }
    function stepDevices(a, src) {
      if (!isUnitAction(a)) return (sysAction(a) || {}).via ? [notifier(sysAction(a).via)].filter(Boolean) : [];
      const ok = actKinds(a);
      if (a.target && a.target.fromEvent) return (src || []).map(devById).filter((n) => n && ok.includes(n.type));
      if (isGroup(a.target)) return nodes(a.target, ok);
      return [single(a.target)].filter(Boolean);
    }
    function stepsFor(r, o) {
      const out = [], stop = { abort: false };
      const walk = (list, pre, depth) => list.forEach((a, i) => {
        if ((o.halt && o.halt.at) || stop.abort) return;
        const path = [...pre, i], key = path.join(".");
        if (a.control) {
          const res = controlRun(a, Object.assign({}, o, { key })), st = res.pause ? "waiting" : o.watch ? "would" : "ok";
          out.push({ path: key, deviceId: res.deviceId || null, action: null, label: res.label, control: true, skip: false, state: st, reason: null, note: res.note || null, depth });
          // abort: запуск идёт к концу, шаги после него не выполняются
          if (res.abort) {
            stop.abort = true;
            return;
          }
          // Запуск встал на вопросе: дальше — когда ответят или выйдет срок
          if (res.pause) {
            o.halt.at = { key, control: a };
            return;
          }
          (res.subs || []).forEach((x) => out.push({ path: key, deviceId: null, action: null, label: x.label, control: true, skip: !!x.skip, state: x.skip ? "skip" : st, reason: null, note: x.note || null, depth: depth + 1 }));
          branchesOf(a).forEach((b) => {
            if (b === res.pick) walk(a[b] || [], [...path, b], depth + 1);
            else out.push({ path: key + "." + b, deviceId: null, action: null, label: msg("branch", { branch: b, control: a.control, test: !!o.test }), control: true, skip: true, state: "skip", reason: null, note: null, depth: depth + 1 });
          });
          return;
        }
        if (o.only && !o.only.has(key)) return;
        const unit = isUnitAction(a), via = unit ? null : (sysAction(a) || {}).via, devs = stepDevices(a, o.src), keep = a.action === "disable", p = paramsOf(a);
        let note = null;
        if (a.action === "record" && p.duration === "event" && o.via === "event") {
          const ev = r.triggers.find(ends);
          note = msg("record.untilEnd", { trigger: ev ? { source: ev.source, event: ev.event } : null, at: instant(o.endAt), afterSec: p.afterSec || 0 });
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
            stepsFor(t, { src: o.src, watch: o.watch || t.logOnly, date: o.date, at: o.at, now: o.now, i: o.i, test: o.test, via: "chain", chain: lvl, noHuman: o.live })
              .forEach((x) => out.push(Object.assign({}, x, { control: true, path: "", depth: x.depth + depth + 1 })));
          return;
        }
        // Удалённые части цели — отдельные отказавшие шаги: остальные объекты выполняются
        (unit ? brokenToks(a.target) : []).forEach((t) => mk(null, t.startsWith("gone:") ? msg("target.gone", { name: t.slice(5), area: false }) : msg(isArea(t) ? "target.areaGone" : "target.deviceGone", { token: t })));
        if (!devs.length && !(unit && broken(a.target))) {
          if (via) return mk(null, msg("notifier.gone"));
          if (!unit) return mk(null, null);
          return mk(single(a.target) ? single(a.target).id : null, msg(!a.target ? "target.none" : a.target.fromEvent ? "target.noEventDevice" : isGroup(a.target) ? "target.areaEmpty" : "target.deviceGone"));
        }
        devs.forEach((n) => mk(n.id, devDown(n, keep, fromWall(o.at), !o.now, !!via) || (a.action === "scan" && !hasRecord(n, p.archive) ? msg("target.noRecord", { deviceId: n.id }) : null) || (unit && r.runAsRoleId && !roleAllows(r.runAsRoleId, n, stepRight(a, n)) ? msg("role.denied", { roleId: r.runAsRoleId, deviceId: n.id }) : null) || (o.flaky && o.flaky(key) ? msg("relay.timeout") : null)));
      });
      walk(r.steps, [], 0);
      return out;
    }
    /* Запуск правила r: что пришло, что проверено, что выполнено на каких устройствах. o: via — event | sched |
       manual | test; at — момент (мс); now — запуск сейчас (иначе — запись истории); i — номер запуска (исходы
       демо: какое событие из области, ответ оператора); events, pre — события и их проверки пробного запуска;
       src, only — устройства из событий и пути шагов повтора; br — исходы ветвлений; rateN, rateHit, busy,
       flaky — демо-история набора (tools/fixture_fires.js).
       Ход с людьми: live — шаг ask, escalate без исхода в br останавливает запуск: result waiting, в невидимом
       поле pause — { key, control }; who — кто и когда решил шаг по ключу пути; checks — проверки уже идущего
       запуска; queued — запуск встал в очередь; busyAs — как судить занятость вместо r.repeat */
    function fire(r, o) {
      const at = o.at, d = wall(at), via = o.via || (r.start === "schedule" ? "sched" : r.start), i = o.i || 0, watch = o.watch !== undefined ? o.watch : !!r.logOnly;
      let ev = o.events;
      if (!ev) {
        ev = [];
        if (via === "event" && r.whenLogic === "any" && r.triggers.length > 1) {
          // any: правило запустило одно событие — по номеру запуска
          const tk = r.triggers[i % r.triggers.length], n = eventDevices(tk, i)[0];
          ev.push({ source: tk.source, event: tk.event, match: tk.match || {}, deviceId: n ? n.id : null, at: instant(d) });
        } else if (via === "event")
          r.triggers.forEach((tk, j) => {
            const n = eventDevices(tk, i)[0];
            ev.push({ source: tk.source, event: tk.event, match: tk.match || {}, deviceId: n ? n.id : null,
              at: instant(new Date(d.getTime() - (r.triggers.length - 1 - j) * (6 + (i % 5)) * 1000)) });
          });
      }
      const src = o.src || ev.map((e) => e.deviceId).filter(Boolean);
      const checks = o.checks || checksFor(r, Object.assign({}, o, { via, date: d }));
      const skip = checks.some((c) => !c.ok);
      const endAt = addSec(d, 25 + ((i * 13) % 40));
      const halt = {}, live = !!o.live && !skip;
      let steps = o.queued ? [] : stepsFor(r, { src, watch, only: o.only, flaky: o.flaky, at: d, date: d, now: o.now, i, br: o.br, test: o.by === "test", via, endAt, live, halt, who: o.who });
      if (skip) steps = steps.map((s) => Object.assign({}, s, { state: "skip", reason: msg("skipped") }));
      const result = skip ? "skip" : halt.at || o.queued ? "waiting" : outcome(steps, watch);
      const out = { ruleId: r.id, at: instant(d), by: o.by || via, logOnly: watch, sourceDeviceIds: src, events: ev, checks, steps, result };
      if (halt.at) Object.defineProperty(out, "pause", { value: halt.at });
      return out;
    }
    function outcome(steps, watch) {
      const acts = steps.filter((s) => !s.control), n = acts.length, good = acts.filter((s) => s.state === "ok" || s.state === "would").length;
      return watch ? (good || !n ? "watch" : "fail") : good === n ? "ok" : good ? "part" : "fail";
    }
    // Значения подстановок запуска — в тексте вопроса оператору
    function fillText(text, r, f) {
      const n = (f.sourceDeviceIds[0] && devById(f.sourceDeviceIds[0])) || null, ev = f.events[f.events.length - 1];
      const v = { камера: n ? n.name : "", устройство: n ? n.id : "", событие: ev ? ev.event : "", время: stamp(wall(Date.parse(f.at))), правило: r.name };
      return String(text || "").replace(/\{([^{}]+)\}/g, (m, k) => (k in v ? v[k] : m));
    }
    // Событие подходит правилу: код события и объект
    const hears = (t, event, id) => t.source === "unit" && t.event === event && covers(t.target, id, trigKinds(t));

    // Повтор невыполненного: те же шаги (действия, как они были в том запуске) — на нынешних устройствах
    const retryable = (s) => s.state === "fail" && !s.control && s.action && s.action.action !== "runrule";
    function retry(r, f, at) {
      const steps = f.steps.filter(retryable).map((s) => {
        const n = s.deviceId ? devById(s.deviceId) : null, keep = s.action.action === "disable", via = isUnitAction(s.action) ? null : (sysAction(s.action) || {}).via;
        const why = n ? devDown(n, keep, undefined, undefined, !!via) : !isUnitAction(s.action) && !s.deviceId && !(s.reason && /^target\./.test(s.reason.code)) ? null
          : s.reason && /^target\.(gone|areaGone)$/.test(s.reason.code) ? s.reason : msg("target.deviceGone");
        return Object.assign({}, s, { state: why ? "fail" : "ok", reason: why, depth: 0 });
      });
      const g = steps.filter((s) => s.state === "ok").length;
      return { ruleId: r.id, at: instant(wall(at)), by: "manual", logOnly: false, sourceDeviceIds: [], events: [], checks: [], steps,
        result: g === steps.length ? "ok" : g ? "part" : "fail" };
    }

    // Что сервер знает о включённом правиле сейчас (Rule.status). Встроенный сервер сверяет только то, что есть в его записях
    function status(r, ref) {
      const out = undeclared(r, ref), why = out ? out.issue : crossDomain(r, ref) || issue(r);
      if (why) return { state: "refused", reason: why.code };
      const unfit = [], unchecked = [];
      const name = (n) => `«${n.name}»`;
      const down = (n) => n.online === false && unchecked.push(`${name(n)}: нет связи, что умеет устройство, не проверено`);
      r.triggers.forEach((t) => (t.target && !broken(t.target) ? nodes(t.target, trigKinds(t)) : []).forEach(down));
      items(r).forEach(({ it: a }) => {
        if (!isUnitAction(a) || !a.target || a.target.fromEvent) return;
        const p = paramsOf(a);
        (broken(a.target) ? [] : nodes(a.target, actKinds(a))).forEach((n) => {
          down(n);
          if (a.action === "preset" && n.presetMax && p.preset > n.presetMax) unfit.push(`${name(n)}: нет пресета ${p.preset}, предел ${n.presetMax}`);
          if (a.action === "scan" && !hasRecord(n, p.archive)) unfit.push(`${name(n)}: нечего проверять, запись не ведётся`);
        });
      });
      if (unfit.length) return { state: "unfit", reason: [...new Set(unfit)].join("; ") };
      return unchecked.length ? { state: "unchecked", reason: [...new Set(unchecked)].join("; ") } : { state: "watching", reason: "" };
    }

    return { fire, retry, retryable, outcome, fillText, hears, issue, undeclared, status, forbidden, domainsOf, crossDomain, eventChecks, rightOf, roleAllows: (id, uid, right) => { const n = devById(uid); return !!n && roleAllows(id, n, right); }, schActive: (id, ms) => schActive(id, wall(ms)), modeNow, modeNext, stamp: (ms) => stamp(wall(ms)), clock: (ms) => clock(wall(ms)), wall, fromWall };
  }

  // world поверх данных в виде набора (api/fixtures/demo.json): db() отдаёт их текущее состояние. Склад объектов
  // собирается из db().units и живёт, пока набор отдаёт тот же список
  function forDb(db) {
    let units = null, st = null;
    const store = () => {
      if (db().units !== units) {
        const Units = typeof window !== "undefined" && window.ConsolemUnits ? window.ConsolemUnits : require("./units.js");
        units = db().units;
        st = Units.create();
        st.load(units);
      }
      return st;
    };
    return create({
      tz: () => db().timezone, store, kinds: () => db().kinds,
      rules: () => db().rules, schedules: () => db().schedules, dayGroups: () => db().dayGroups, modes: () => db().modes, manualMode: () => db().modeManual,
      windows: () => db().maintenanceWindows, roles: () => db().access.roles, users: () => db().access.users,
    });
  }
  const api = { create, forDb, TRIGGERS, CONDITIONS, ACTIONS, CONTROLS };
  if (typeof window !== "undefined") window.ConsolemRuleEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})();
