/* Встроенный сервер прототипа. Отвечает на запросы ровно по контракту api/openapi.json и хранит всё,
   что в продукте хранит бэкенд: оборудование, хранилища, правила, права, опции, журнал. Интерфейс
   разговаривает с ним только через api/client.js — теми же запросами, что с настоящим бэкендом.
   Работает в той же вкладке: страница открывается и с диска (file://), и с сайта.

   Данные — эталонный набор api/fixtures/demo.json (api/fixture.js): его же загружает бэкенд на тестовом
   стенде. Записи хранятся в том виде, в каком уходят в ответах.

   Параметры create(): fixture — набор, с которым сервер стартует; fixtures — наборы по имени для
   POST /test/reset (по умолчанию { demo: fixture }); openapi — контракт (api/openapi.js): по нему
   проверяются тела запросов и находится operationId запроса; now — часы; autoTick: false — шаги операций
   не выполняются сами, только по /test/clock; testSupport: true — служебные операции тестового стенда /test/….

   Что система умеет — reference.capabilities набора: операции не из списка отвечают 404 NO_ROUTE,
   виды устройств и необязательные настройки не из списка — 422 NOT_SUPPORTED. Так один сервер
   изображает и систему со всем контрактом (demo), и систему с его частью (one-domain). */
(() => {
  // Изменения на один прогон стенда — JSON Merge Patch (RFC 7396): объекты сливаются, null удаляет поле,
  // массивы и значения заменяются целиком. Исходник не меняется
  function mergePatch(target, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
    const out = target && typeof target === "object" && !Array.isArray(target) ? clone(target) : {};
    Object.entries(patch).forEach(([key, value]) => {
      if (value === null) delete out[key];
      else out[key] = mergePatch(out[key], value);
    });
    return out;
  }
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const DAY = 86400000;
  const GB = 1024 ** 3;
  const TB = 1024 ** 4;
  const DATE = /^\d{4}-\d\d-\d\d$/;
  const MOMENT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

  // Набор снят в capturedAt: каждая дата и каждый момент сдвигаются на «сейчас − capturedAt», даты — на
  // целые сутки. Так «вошёл вчера» и «истекает через неделю» остаются правдой в любой день
  function shiftTimes(node, ms) {
    const days = Math.round(ms / DAY);
    const walk = (v) => {
      if (typeof v === "string") {
        if (MOMENT.test(v)) return new Date(Date.parse(v) + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
        if (DATE.test(v)) return new Date(Date.parse(v + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
        return v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k), walk(x)]));
      return v;
    };
    return walk(node);
  }

  // Вид записи — первая цифра UUID (api/README.md, «Идентификаторы»): сервер продолжает номера набора
  const KIND = { operation: "0", domain: "1", server: "2", device: "3", folder: "4", archive: "5", volume: "6", rule: "7", fire: "d", history: "e",
    // «Автоматизация»: первая цифра «f», вид — во второй группе UUID
    schedule: "f-0001", dayGroup: "f-0002", mode: "f-0003", window: "f-0004", ruleVersion: "f-0005", archiveWatch: "f-0006", archiveScan: "f-0007", prompt: "f-0008", journal: "c", bookmark: "f-0009", export: "f-000a" };
  const TABLES = { domains: "domain", servers: "server", devices: "device", folders: "folder", archives: "archive", volumes: "volume", rules: "rule" };
  // Ответ на запрос с ключом повтора помнится 10 минут: повтор получает его же и ничего не выполняет снова
  const IDEMPOTENCY_MS = 10 * 60 * 1000;
  // Движок «Автоматизации» (api/rule-engine.js): расписания, режим объекта, запуски правил
  const Engine = typeof window !== "undefined" && window.ConsolemRuleEngine ? window.ConsolemRuleEngine : require("./rule-engine.js");
  // Реестр описаний видов (api/kinds.js) и склад объектов (api/units.js)
  const Kinds = typeof window !== "undefined" && window.ConsolemKinds ? window.ConsolemKinds : require("./kinds.js");
  const Units = typeof window !== "undefined" && window.ConsolemUnits ? window.ConsolemUnits : require("./units.js");
  // Хуки профилей vms.* (api/profiles.js): смысл известных видов — общий код старых путей и путей ядра
  const Profiles = typeof window !== "undefined" && window.ConsolemProfiles ? window.ConsolemProfiles : require("./profiles.js");
  // Содержимое правила: то, что правит администратор и что хранят версии истории
  const RULE_CONTENT = ["name", "enabled", "logOnly", "logOnlySince", "start", "runMode", "operatorMenu", "ratePerMinute", "windowSec", "runAt", "repeat",
    "triggers", "conditions", "steps", "owner", "purpose", "serverId", "runAsRoleId", "allowChain", "labels", "validForSec"];
  const STREAM_DEPTH = 500;
  // Запусков одного правила на строке хода: идущий и очередь (repeat: queue), сверх — как skip
  const RUNS_MAX = 16;
  // Стопка отката: сколько операций и как долго сервер помнит, что вернуть
  const UNDO_KEEP = 50;
  const UNDO_MS = 7 * 86400000;

  /* ===== Старые таблицы — представления склада =====
     Сервер живёт на складе объектов (units.js): набор хранит только units. Старые маршруты (/domains, /servers, /devices,
     /folders, /archives, /volumes) сняты; их код, перенесённый в хуки профилей, работает с db.domains … db.volumes, как раньше,
     но это представления: запись — Proxy над объектом склада, её поля читаются и пишутся в поля объекта (не копия). Тот же
     перевод для инструментов и тестов (fixturePatch старыми разделами) — tools/generic_legacy.py.
     Запись ↔ объект: id ↔ uid, type ↔ kind (у хранилища kind ↔ archive.<kind>), online ↔ status.link, состояние, которое
     система назначает сама (OBSERVED), ↔ status.observed, hasPassword/hasSecret ↔ secrets, остальное ↔ properties.
     Хранилище: serverId ↔ parentId (domainId записи — только у хранилища домена); том: archiveId ↔ parentId; папка: deviceIds ↔
     Unit.folders устройств; потоки камеры (streams) ↔ дочерние объекты вида stream. Порядок полей записи — свой. */
  const OLD_TABLES = ["domains", "servers", "devices", "folders", "archives", "volumes"];
  const DEVICE_TYPES = new Set(["camera", "ipsrv", "channel", "mic", "spk", "sensor", "relay", "storage", "det", "eventsrc", "acfa", "acfa_sensor", "acfa_lock",
    "acfa_fence", "export", "email", "sms"]);
  const tableOf = (kind) =>
    DEVICE_TYPES.has(kind) ? "devices" : String(kind).startsWith("archive.") ? "archives" : { domain: "domains", server: "servers", folder: "folders", volume: "volumes" }[kind] || null;
  const OBSERVED = {
    devices: ["fault", "faultText", "licenseExceeded", "recordState", "recordReason", "replicaLagSec", "armed", "disabledByRuleId", "disabledByRuleAt", "archiveJobs",
      "direct", "recordingTarget", "detectorKinds", "derived"],
    servers: ["telemetry", "gpu", "disks", "class", "fingerprint"],
    domains: ["stateSummary"],
    volumes: ["usedPercent", "shrinkPendingBytes", "heldBy", "incidentsLost", "incidentsAtRisk"],
    archives: [],
    folders: [],
    streams: [],
  };
  const SECRET_FLAGS = { devices: { hasPassword: "password" }, volumes: { hasPassword: "password", hasSecret: "secret" } };
  // uid потока: uid камеры с номером потока во второй группе (30000013-0001-…)
  const streamUid = (cam, n) => `${cam.slice(0, 9)}${String(n).padStart(4, "0")}${cam.slice(13)}`;
  const streamNo = (uid) => parseInt(uid.slice(9, 13), 10) || 0;

  // hooks: version() — новая версия объекта потока; refKey(kind, key) — поле со ссылкой (переиндексировать); touched(unit)
  function Legacy(store, hooks) {
    hooks = hooks || {};
    const viewOf = new WeakMap();
    const unitOf = new WeakMap();
    const tables = {};
    const touched = (u) => (hooks.touched ? hooks.touched(u) : store.get(u.uid) === u && store.reindex(u.uid));
    const status = (u) => u.status || (u.status = {});
    const observed = (u) => (u.status && u.status.observed) || {};
    const setObserved = (u, key, value) => {
      const s = status(u);
      (s.observed || (s.observed = {}))[key] = value;
    };
    const delObserved = (u, key) => {
      const o = u.status && u.status.observed;
      if (!o) return;
      delete o[key];
      if (!Object.keys(o).length) delete u.status.observed;
    };
    const secretSet = (u, name, on) => {
      if (on) (u.secrets || (u.secrets = {}))[name] = true;
      else if (u.secrets) {
        delete u.secrets[name];
        if (!Object.keys(u.secrets).length) delete u.secrets;
      }
    };
    const field = (get, set, has) => ({ get, set, has: has || (() => true) });
    const link = field((u) => u.status.link === "online", (u, v) => (v === undefined ? u.status && delete u.status.link : (status(u).link = v ? "online" : "offline")), (u) => !!u.status && "link" in u.status);
    const plain = (key, then) => field((u) => u[key], (u, v) => {
      u[key] = v === undefined ? null : v;
      if (then) then(u, v);
    });
    const reindexed = (u) => touched(u);
    // Версия меняется после каждой правки записи (bump): тогда же склад переиндексирует объект — и вложенные ссылки тоже
    const version = plain("version", reindexed);
    const children = (u) => store.byParent(u.uid).filter((s) => s.kind === "stream").sort((a, b) => (a.uid < b.uid ? -1 : 1));
    // Домен объекта переходит на всех его потомков по parentId: потоки и дочерние устройства, хранилища сервера и их тома,
    // объекты незнакомых видов. Иначе /units?domainId= и права по домену разошлись бы со старым путём
    const cascadeDomain = (u) => {
      store.byParent(u.uid).forEach((c) => {
        if (c.domainId !== u.domainId) {
          c.domainId = u.domainId;
          touched(c);
        }
        cascadeDomain(c);
      });
    };
    const domainOf = plain("domainId", (u) => {
      reindexed(u);
      cascadeDomain(u);
    });
    const secretFlag = (name) => field(() => true, (u, v) => secretSet(u, name, !!v), (u) => !!(u.secrets && u.secrets[name]));
    // Поля записи, у которых своё место в объекте; порядок — порядок полей записи. "*props" — свойства, "*observed" — состояние
    const SPECIAL = {
      domains: { id: plain("uid"), name: plain("name"), "*props": 0, online: link, "*observed": 0, version },
      servers: { id: plain("uid"), name: plain("name"), domainId: domainOf, "*props": 0, online: link, "*observed": 0, version },
      folders: {
        id: plain("uid"), name: plain("name"), domainId: domainOf, parentId: plain("parentId", reindexed),
        deviceIds: field((u) => store.byFolder(u.uid).filter((d) => DEVICE_TYPES.has(d.kind)).map((d) => d.uid), (u, v) => setMembers(u, v || [])),
        version,
      },
      archives: {
        id: plain("uid"), name: plain("name"),
        kind: field((u) => u.kind.slice("archive.".length), (u, v) => {
          u.kind = `archive.${v}`;
          reindexed(u);
        }),
        "*props": 0,
        serverId: field((u) => u.parentId, (u, v) => {
          u.parentId = v || null;
          const s = v && store.get(v);
          if (s) u.domainId = s.domainId;
          reindexed(u);
          cascadeDomain(u);
        }),
        domainId: field((u) => (u.parentId ? null : u.domainId), (u, v) => {
          if (!u.parentId && v != null) u.domainId = v;
          reindexed(u);
          cascadeDomain(u);
        }),
        version,
      },
      volumes: {
        id: plain("uid"),
        archiveId: field((u) => u.parentId, (u, v) => {
          u.parentId = v || null;
          const a = v && store.get(v);
          if (a) u.domainId = a.domainId;
          reindexed(u);
          cascadeDomain(u);
        }),
        name: plain("name"), "*props": 0, online: link, "*observed": 0, hasPassword: secretFlag("password"), hasSecret: secretFlag("secret"), version,
      },
      devices: {
        id: plain("uid"), type: plain("kind", reindexed), parentId: plain("parentId", reindexed), domainId: domainOf, name: plain("name"), online: link,
        "*props": 0, "*observed": 0, hasPassword: secretFlag("password"), version,
        // Что правится у записи сейчас — Unit.writable
        writableFields: field((u) => u.writable, (u, v) => (v == null ? delete u.writable : (u.writable = v.slice())), (u) => Array.isArray(u.writable)),
        streams: field((u) => children(u).map(view), (u, v) => setStreams(u, v || []), (u) => children(u).length > 0),
      },
      streams: {
        id: field((u) => u.properties.streamId, (u, v) => (u.properties.streamId = v)), name: plain("name"), "*props": 0, online: link,
      },
    };
    const HIDDEN = { streams: new Set(["streamId"]) };
    const tableOfUnit = (u) => (u.kind === "stream" ? "streams" : tableOf(u.kind));

    function handler(t) {
      const special = SPECIAL[t], obs = new Set(OBSERVED[t]), hidden = HIDDEN[t] || new Set();
      const own = (u, key) => {
        if (typeof key !== "string") return false;
        const s = special[key];
        if (s) return s.has(u);
        if (key.startsWith("*") || hidden.has(key)) return false;
        return (u.properties && key in u.properties) || key in observed(u);
      };
      const get = (u, key) => {
        if (typeof key !== "string") return undefined;
        const s = special[key];
        if (s) return s.has(u) ? s.get(u) : undefined;
        if (key.startsWith("*") || hidden.has(key)) return undefined;
        if (obs.has(key)) return observed(u)[key];
        if (u.properties && key in u.properties) return u.properties[key];
        return observed(u)[key];
      };
      const set = (u, key, value) => {
        const s = special[key];
        if (s) return s.set(u, value), true;
        if (obs.has(key) || (!(key in (u.properties || {})) && key in observed(u))) setObserved(u, key, value);
        else (u.properties || (u.properties = {}))[key] = value;
        if (hooks.refKey && hooks.refKey(u.kind, key)) touched(u);
        return true;
      };
      return {
        get,
        set: (u, key, value) => (typeof key === "string" ? set(u, key, value) : true),
        has: own,
        deleteProperty(u, key) {
          if (typeof key !== "string") return true;
          const s = special[key];
          if (s) s.set(u, undefined);
          else if (u.properties && key in u.properties) delete u.properties[key];
          else delObserved(u, key);
          if (hooks.refKey && hooks.refKey(u.kind, key)) touched(u);
          return true;
        },
        ownKeys(u) {
          const out = [];
          Object.keys(special).forEach((key) => {
            if (key === "*props") Object.keys(u.properties || {}).forEach((k) => !hidden.has(k) && !special[k] && out.push(k));
            else if (key === "*observed") Object.keys(observed(u)).forEach((k) => !special[k] && !out.includes(k) && out.push(k));
            else if (special[key].has(u)) out.push(key);
          });
          return out;
        },
        getOwnPropertyDescriptor: (u, key) => (own(u, key) ? { value: get(u, key), writable: true, enumerable: true, configurable: true } : undefined),
        defineProperty: (u, key, desc) => ("value" in desc ? set(u, key, desc.value) : true),
      };
    }
    const HANDLERS = {};
    Object.keys(SPECIAL).forEach((t) => (HANDLERS[t] = handler(t)));
    // Запись объекта: всегда одна и та же — код старых путей сравнивает записи по ссылке
    function view(u) {
      if (!u) return null;
      let v = viewOf.get(u);
      if (!v) {
        v = new Proxy(u, HANDLERS[tableOfUnit(u)]);
        viewOf.set(u, v);
        unitOf.set(v, u);
      }
      return v;
    }

    // Запись → объект склада (новая запись старого кода, набор со старыми разделами)
    const split = (rec, t, skip) => {
      const props = {}, obs = {}, st = {};
      const special = SPECIAL[t], o = new Set(OBSERVED[t]);
      Object.keys(rec).forEach((k) => {
        if (special[k] || skip.includes(k) || k === "folderIds") return;
        if (o.has(k)) obs[k] = rec[k];
        else props[k] = rec[k];
      });
      if ("online" in rec && special.online) st.link = rec.online === false ? "offline" : "online";
      if (Object.keys(obs).length) st.observed = obs;
      return { props, st };
    };
    function toUnit(t, rec) {
      const { props, st } = split(rec, t, []);
      const u = { uid: rec.id, kind: null, parentId: null, domainId: null, name: rec.name };
      if (t === "domains") u.kind = "domain";
      else if (t === "servers") Object.assign(u, { kind: "server", domainId: rec.domainId });
      else if (t === "folders") Object.assign(u, { kind: "folder", parentId: rec.parentId || null, domainId: rec.domainId });
      else if (t === "archives") {
        const s = rec.serverId && store.get(rec.serverId);
        Object.assign(u, { kind: `archive.${rec.kind}`, parentId: rec.serverId || null, domainId: rec.domainId || (s ? s.domainId : null) });
      } else if (t === "volumes") {
        const a = store.get(rec.archiveId);
        Object.assign(u, { kind: "volume", parentId: rec.archiveId, domainId: a ? a.domainId : null });
      } else Object.assign(u, { kind: rec.type, parentId: rec.parentId || null, domainId: rec.domainId });
      u.version = rec.version;
      u.properties = props;
      const flags = SECRET_FLAGS[t] || {};
      Object.keys(flags).forEach((f) => rec[f] && secretSet(u, flags[f], true));
      if (t === "devices" && Array.isArray(rec.writableFields)) u.writable = rec.writableFields.slice();
      if (Object.keys(st).length) u.status = st;
      return u;
    }
    function streamUnit(cam, rec, n) {
      const { props, st } = split(rec, "streams", []);
      return Object.assign({ uid: streamUid(cam.uid, n), kind: "stream", parentId: cam.uid, domainId: cam.domainId, name: rec.name, version: hooks.version ? hooks.version() : cam.version,
        properties: Object.assign({ streamId: rec.id }, props) }, Object.keys(st).length ? { status: st } : {});
    }
    // Новый состав потоков камеры: объекты потоков по коду потока правятся на месте, новых — новые номера, лишние уходят
    function setStreams(cam, next) {
      const was = children(cam);
      const byCode = new Map(was.map((s) => [s.properties.streamId, s]));
      const kept = new Set();
      let n = was.reduce((m, s) => Math.max(m, streamNo(s.uid)), 0);
      next.forEach((x) => {
        const own = unitOf.get(x);
        const s = own && own.parentId === cam.uid ? own : byCode.get(x.id);
        if (s && !kept.has(s)) {
          kept.add(s);
          if (own === s) return;
          const fresh = streamUnit(cam, x, streamNo(s.uid));
          Object.keys(s).forEach((k) => delete s[k]);
          Object.assign(s, fresh);
          touched(s);
          return;
        }
        const made = streamUnit(cam, unitOf.has(x) ? JSON.parse(JSON.stringify(x)) : x, ++n);
        kept.add(made);
        store.put(made);
      });
      was.filter((s) => !kept.has(s)).forEach((s) => store.remove(s.uid));
    }
    // Состав папки: только устройства, объекты незнакомых видов в папке остаются как были
    function setMembers(folder, ids) {
      const want = new Set(ids);
      store.byFolder(folder.uid).forEach((d) => {
        if (!DEVICE_TYPES.has(d.kind) || want.has(d.uid)) return;
        d.folders = d.folders.filter((f) => f !== folder.uid);
        if (!d.folders.length) delete d.folders;
        touched(d);
      });
      ids.forEach((id) => {
        const d = store.get(id);
        if (!d || (d.folders || []).includes(folder.uid)) return;
        d.folders = (d.folders || []).concat(folder.uid);
        touched(d);
      });
    }
    // Запись в склад: объект, его потоки, состав папки. Возвращает запись-представление
    function put(t, rec) {
      if (unitOf.has(rec)) {
        const u = unitOf.get(rec);
        if (!store.has(u.uid)) store.put(u);
        return rec;
      }
      const u = store.put(toUnit(t, rec));
      if (t === "devices" && rec.streams) setStreams(u, rec.streams);
      if (t === "folders" && rec.deviceIds) setMembers(u, rec.deviceIds);
      return view(u);
    }
    function drop(u) {
      if (tableOf(u.kind) === "devices") children(u).forEach((s) => store.remove(s.uid));
      store.remove(u.uid);
    }
    function rebuild() {
      OLD_TABLES.forEach((t) => (tables[t] = []));
      for (const u of store.all()) {
        const t = tableOf(u.kind);
        if (t) tables[t].push(view(u));
      }
    }
    // Старые разделы набора (fixturePatch тестов старых путей) заменяют объекты своих таблиц. Состав папок — из
    // folders[].deviceIds, без раздела folders — прежний. Объекты незнакомых видов без родителя или домена уходят
    function importTables(given) {
      const order = ["domains", "servers", "folders", "archives", "volumes", "devices"].filter((t) => Array.isArray(given[t]));
      if (!order.length) return;
      const memberOf = new Map();
      for (const u of store.all()) if (u.folders && !(given.folders && DEVICE_TYPES.has(u.kind))) memberOf.set(u.uid, u.folders.slice());
      order.forEach((t) => {
        [...store.all()].filter((u) => tableOf(u.kind) === t).forEach(drop);
        given[t].forEach((rec) => put(t, rec));
      });
      memberOf.forEach((folders, uid) => {
        const u = store.get(uid);
        const live = folders.filter((f) => store.has(f));
        if (!u || !live.length) return;
        u.folders = [...new Set((u.folders || []).concat(live))];
        touched(u);
      });
      for (let gone = true; gone; ) {
        gone = false;
        [...store.all()].forEach((u) => {
          if (tableOf(u.kind) || ((!u.parentId || store.has(u.parentId)) && (!u.domainId || store.has(u.domainId)))) return;
          drop(u);
          gone = true;
        });
      }
    }
    // Присваивание таблицы целиком (db.devices = db.devices.filter(…)): чего нет — уходит со склада, новое — приходит
    function setTable(t, list) {
      const next = list.map((x) => put(t, x));
      const keep = new Set(next.map((v) => unitOf.get(v)));
      (tables[t] || []).forEach((v) => {
        const u = unitOf.get(v);
        if (!keep.has(u) && store.get(u.uid) === u) drop(u);
      });
      tables[t] = next;
    }
    // Объект пришёл на склад или ушёл с него не через таблицу (пути ядра): таблица догоняет
    function attach(u) {
      const t = tableOf(u.kind);
      if (t && tables[t] && !tables[t].includes(view(u))) tables[t].push(view(u));
    }
    function detach(u) {
      const t = tableOf(u.kind);
      if (t && tables[t]) tables[t] = tables[t].filter((v) => unitOf.get(v) !== u);
    }
    return {
      view,
      unitOf: (rec) => unitOf.get(rec) || null,
      table: (t) => tables[t],
      setTable,
      add(t, rec) {
        const v = put(t, rec);
        if (!tables[t].includes(v)) tables[t].push(v);
        return v;
      },
      importTables,
      rebuild,
      attach,
      detach,
    };
  }

  // Набор со старыми разделами для тестов и инструментов старых путей: выведены из units, исходный набор не меняется
  function legacyFixture(fixture) {
    if (!fixture || !fixture.units || OLD_TABLES.every((t) => t in fixture)) return fixture;
    const Units = typeof window !== "undefined" && window.ConsolemUnits ? window.ConsolemUnits : require("./units.js");
    const store = Units.create();
    store.load(JSON.parse(JSON.stringify(fixture.units)));
    const legacy = Legacy(store, {});
    legacy.rebuild();
    const out = Object.assign({}, fixture);
    OLD_TABLES.forEach((t) => {
      if (!(t in out)) out[t] = JSON.parse(JSON.stringify(legacy.table(t)));
    });
    return out;
  }

  function create(opts) {
    const SPEC = opts.openapi || null;
    const FIXTURES = opts.fixtures || { demo: opts.fixture };
    const FIXTURE = opts.fixture || FIXTURES.demo;
    // operationId по методу и шаблону пути контракта: {deviceId} и {id} — одно и то же
    const shape = (template) => template.replace(/\{\w+\}/g, "{}");
    const OPERATION = {};
    if (SPEC)
      Object.entries(SPEC.paths).forEach(([path, item]) =>
        Object.entries(item).forEach(([m, o]) => o && o.operationId && (OPERATION[`${m.toUpperCase()} ${shape(path)}`] = o.operationId))
      );
    const testSupport = !!opts.testSupport;

    // Часы. Тестовый стенд их останавливает и сдвигает (/test/clock), иначе идут вместе с настоящими
    const realNow = opts.now || (() => Date.now());
    const clock = { frozenAt: null, offset: 0 };
    const now = () => (clock.frozenAt != null ? clock.frozenAt : realNow() + clock.offset);
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

    let db = null;
    let me = null;
    // Склад объектов, описания видов и старые таблицы над складом — собираются в load()
    let kinds = null, store = null, legacy = null, kindList = null;
    // Состояние хуков профилей (итоги круга домена…): сбрасывается в load()
    let profileState = {};
    /* Хуки профилей (profiles.js) и то, что они видят у сервера: склад, описания видов, старые таблицы и общие помощники старых
       путей. Помощники — обёртки: сами функции объявлены ниже, хук зовёт их, когда сервер уже собран */
    const HOOKS = Profiles.HOOKS;
    const hFolder = HOOKS["vms.folder/1"];
    const hDevice = Profiles.DEVICE, hCamera = HOOKS["vms.camera/1"], hStream = HOOKS["vms.stream/1"], hDetector = HOOKS["vms.detector/1"], hAcs = HOOKS["vms.acs/1"];
    const hLive = HOOKS["vms.live/1"], hPtz = HOOKS["vms.ptz/1"], hTalk = HOOKS["vms.talk/1"], hTimeline = HOOKS["vms.timeline/1"];
    const pctx = {
      get units() { return store; },
      get kinds() { return kinds; },
      get db() { return db; },
      get state() { return profileState; },
      get formatting() { return formatting; },
      get VIEW_ROUND_MS() { return VIEW_ROUND_MS; },
      get FORMAT_MS() { return FORMAT_MS; },
      legacy: {
        view: (u) => legacy.view(u),
        unitOf: (rec) => legacy.unitOf(rec),
        add: (t, rec) => legacy.add(t, rec),
        isDevice: (u) => tableOf(u.kind) === "devices",
      },
      problem: (status, code, message, extra) => problem(status, code, message, extra),
      send: (type, fields) => send(type, fields),
      now: () => now(),
      iso: (ms) => iso(ms),
      byId: (table, id) => byId(table, id),
      uuid: (kind) => uuid(kind),
      newVersion: () => newVersion(),
      bump: (rec) => bump(rec),
      changed: (kind, rec) => changed(kind, rec),
      lockedProblem: (ids, test) => lockedProblem(ids, test),
      // Занятость «кроме своей операции»: внутри шага операции — кроме неё самой (heldNow), иначе — любая
      held: (id) => (heldNow || held)(id),
      isAdmin: () => holdsAdmin(db.access, me),
      domainDown: (id) => domainDown(id),
      featureProblem: (kind, patch) => featureProblem(kind, patch),
      folderable: (d) => folderable(d),
      specOf: (a) => specOf(a),
      kindSpec: (kind) => kindSpec(kind),
      serverWideChanged: (a) => serverWideChanged(a),
      dropStreamGrants: (fn) => dropStreamGrants(fn),
      // Устройства (DEVICE, vms.camera/1…): то, что старые пути делают с записью устройства
      applyPatch: (rec, patch) => applyPatch(rec, patch),
      withChildren: (id) => withChildren(id),
      removeDevice: (id) => removeDevice(id),
      copiesProblem: (s, copies) => copiesProblem(s, copies),
      myLogin: () => myLogin(),
      pageList: (q, name, rows, key, show, extra) => pageList(q, name, rows, key, show, extra),
      // Вид объекта в событии: на путях ядра — вид объекта (camera, archive.local), на старых — вид таблицы (evKind)
      evKind: (kind, x) => evKind(kind, x),
      // Шаг операции: всё, что план меняет у этого объекта (правки этого и следующих шагов, слитые), — камера сверяет запись целиком
      get plan() { return planNow; },
      // Идёт запрос пути ядра или шаг по uid: событие — с видом объекта (решение 5)
      get core() { return coreMode; },
    };
    // Хуки вида — по его профилям (implements), только те, что сервер знает. У устройств (таблица devices) первыми — общие
    // хуки устройства (DEVICE: система, папки, ссылки, сервер-исполнитель, удаление), затем — профилей
    const hooksOf = (kind) => {
      const own = ((kinds.get(kind) || {}).implements || []).map((p) => HOOKS[p]).filter(Boolean);
      return tableOf(kind) === "devices" && kinds.get(kind) ? [hDevice].concat(own) : own;
    };
    // Что уходит и что меняется с объектом — по всем его хукам (dependents): у камеры — дочерние, строки незнакомых видов
    // под ней, камеры, что пишут по её детекторам
    function dependentsOf(u) {
      const remove = new Set(), detach = new Set();
      hooksOf(u.kind).forEach((h) => {
        if (!h.dependents) return;
        const d = h.dependents(u, pctx);
        (d.remove || []).forEach((x) => remove.add(x));
        (d.detach || []).forEach((x) => detach.add(x));
      });
      return { remove: [...remove], detach: [...detach].filter((x) => !remove.has(x)) };
    }
    let planNow = null;
    const hookOf = (kind, name) => hooksOf(kind).find((h) => h[name]) || null;
    let heldNow = null;
    // Пароли — отдельно от записей: в ответах их нет, только hasPassword
    let secrets = new Map();
    const seq = {};
    let ops = new Map();
    // Стопка повтора: отменённые операции, последняя отменённая — в конце
    let redoStack = [];
    const answered = new Map();

    function load(fixture) {
      db = shiftTimes(clone(fixture), now() - Date.parse(fixture.capturedAt));
      // Расписания и особые дни — календарь (праздники, даты ярмарки): их даты не сдвигаются
      db.schedules = clone(fixture.schedules || []);
      db.dayGroups = clone(fixture.dayGroups || []);
      lastMode = null;
      me = db.me.userId;
      ruleRuns = [];
      prompts = [];
      secrets = new Map();
      ops = new Map();
      redoStack = [];
      expWork = new Map();
      formatting = new Map();
      applying = new Map();
      profileState = {};
      scanning = new Map();
      db.archiveWatches = db.archiveWatches || [];
      db.archiveScans = db.archiveScans || [];
      db.stand = db.stand || {};
      // Склад — из units набора; старые разделы, если набор их принёс (fixturePatch тестов старых путей), заменяют объекты
      // своих таблиц. db.domains … db.volumes дальше — представления склада
      // Новое описание вида (PUT /test/kinds/{kind}) меняет набор ссылок x-ref: объекты вида переиндексируются
      kindList = null;
      kinds = Kinds.create(db.kinds || [], db.profiles || [], { onPut: (kind) => { kindList = null; if (store) store.byKind(kind).forEach((u) => store.reindex(u.uid)); } });
      store = Units.create({ refs: unitRefs, onMembers: (uid, added) => partsMember(uid, added) });
      store.load(db.units || []);
      legacy = Legacy(store, { version: () => newVersion(), refKey: (kind, key) => kinds.refNames(kind).has(key) });
      const given = {};
      OLD_TABLES.forEach((t) => {
        if (Array.isArray(db[t])) given[t] = db[t];
        delete db[t];
      });
      ["units", "kinds", "profiles"].forEach((k) => delete db[k]);
      legacy.importTables(given);
      legacy.rebuild();
      OLD_TABLES.forEach((t) => Object.defineProperty(db, t, { get: () => legacy.table(t), set: (list) => legacy.setTable(t, list), enumerable: true, configurable: true }));
      if (db.stand.large) expandLarge(db.stand.large);
      unitPartsWarm();
      treePending = {};
      viewStamp++;
      searches = new Map();
      syncing = new Map();
      answered.clear();
      // Номера новых id — после самых больших в наборе
      Object.keys(seq).forEach((k) => delete seq[k]);
      // Объекты склада без старой таблицы (незнакомые виды) — по uid: их номера тоже заняты
      const idsOf = (node) => JSON.stringify(node).replace(/"u?id":"([0-9a-f])(\d{7})-(\d{4})-4000-8000-0{12}"/g, (m, kind, n, sub) => {
        const k = sub === "0000" ? kind : `${kind}-${sub}`;
        seq[k] = Math.max(seq[k] || 0, Number(n));
        return "";
      });
      // Большой набор строкой целиком не разбирается: устройства — номером последнего
      if (db.stand.large) {
        idsOf(Object.assign({}, db, { devices: [] }));
        seq[KIND.device] = db.devices.length + 1000;
      } else idsOf(Object.assign({}, db, { units: [...store.all()].filter((u) => !tableOf(u.kind)) }));
    }
    const uuid = (kind) => {
      const k = KIND[kind];
      const [first, sub] = k.split("-");
      seq[k] = (seq[k] || 0) + 1;
      return `${first}${String(seq[k]).padStart(7, "0")}-${sub || "0000"}-4000-8000-000000000000`;
    };
    // Движок правил — на складе объектов и описаниях видов. Список видов — тот же, пока его не сменило новое описание (onPut)
    const engine = Engine.create({
      tz: () => db.timezone, store: () => store, kinds: () => kindList || (kindList = kinds.list()),
      rules: () => db.rules, schedules: () => db.schedules, dayGroups: () => db.dayGroups, modes: () => db.modes, manualMode: () => db.modeManual,
      windows: () => db.maintenanceWindows, roles: () => db.access.roles, users: () => db.access.users,
    });
    let lastMode = null;
    // Записи старых таблиц — по складу: объект по uid и его запись-представление, если он из этой таблицы
    const byId = (table, id) => {
      if (!OLD_TABLES.includes(table)) return db[table].find((r) => r.id === id) || null;
      const u = id == null ? null : store.get(id);
      return u && tableOf(u.kind) === table ? legacy.view(u) : null;
    };
    // Ссылки объекта для индекса склада: свойства с x-ref и сервер размещения из status.observed
    function unitRefs(u) {
      const out = kinds.refsOf(u).map((r) => r.uid);
      const s = u.status && u.status.observed && u.status.observed.serverId;
      if (typeof s === "string") out.push(s);
      return out;
    }
    // Возможности системы — из набора: так же их объявляет бэкенд в GET /reference
    const caps = () => db.reference.capabilities;
    // Журнал камеры — она и единицы про неё: дети и источник событий, привязанный к ней
    const journalAbout = (e, id) => {
      if (e.deviceId === id) return true;
      const rec = e.deviceId && byId("devices", e.deviceId);
      return !!rec && (rec.parentId === id || rec.cameraId === id);
    };
    const can = (feature) => caps().features.includes(feature);

    /* ===== Поток событий ===== */

    let seqEvent = 0;
    const history = [];
    let clientSeq = 0;
    const clients = new Map();
    // Кто рядом с устройством: оно, родитель, сервер, папки; домен — только у лежащих прямо под ним
    function nearOf(rec) {
      const out = [rec.id];
      if (rec.parentId) out.push(rec.parentId);
      if (rec.serverId) out.push(rec.serverId);
      if (!rec.parentId && !rec.serverId) out.push(rec.domainId);
      foldersOf(rec.id).forEach((f) => out.push(f));
      return out;
    }
    const goneNear = new Map();
    // События устройств — только наблюдающим его или родителя. Операции, правила, права и домен — всем
    const wants = (c, m) => !m.near || m.near.some((id) => c.watch.has(id));
    function send(type, fields) {
      const message = Object.assign({ id: String(++seqEvent), type, at: iso(now()) }, fields || {});
      if (message.kind === "device" || DEVICE_TYPES.has(message.kind)) {
        viewStamp++;
        const rec = byId("devices", message.entityId);
        const near = rec ? nearOf(rec) : goneNear.get(message.entityId) || [message.entityId];
        Object.defineProperty(message, "near", { value: near, enumerable: false });
        treeTouch(rec, near);
      }
      if (message.type === "journal.event") {
        const rec = byId("devices", message.entityId);
        Object.defineProperty(message, "near", { value: [message.entityId, rec && rec.parentId, rec && rec.cameraId].filter(Boolean), enumerable: false });
      }
      history.push(message);
      if (history.length > STREAM_DEPTH) history.shift();
      clients.forEach((c) => setTimeout(() => wants(c, message) && c.fn(clone(message)), 0));
    }
    // Ветка изменилась: tree.changed копится и уходит одним сообщением на раскладку, частота от размера домена не зависит
    let treePending = {};
    let treeSentAt = 0;
    const TREE_EVERY_MS = 1000;
    function treeTouch(rec, near) {
      const add = (layout, id) => id && (treePending[layout] = treePending[layout] || new Set()).add(id);
      if (!rec) near.slice(1).forEach((id) => { add("servers", id); add("folders", id); });
      else {
        add("servers", rec.parentId || rec.serverId || rec.domainId);
        foldersOf(rec.id).forEach((f) => add("folders", f));
        if (!rec.parentId && !foldersOf(rec.id).length) add("folders", rec.domainId);
      }
    }
    function treeFlush() {
      const layouts = Object.keys(treePending);
      if (!layouts.length || (clock.frozenAt == null && now() - treeSentAt < TREE_EVERY_MS)) return;
      treeSentAt = now();
      const pending = treePending;
      treePending = {};
      layouts.forEach((layout) => send("tree.changed", { layout, parentIds: [...pending[layout]] }));
    }
    const changed = (kind, rec) => send("entity.changed", { kind: evKind(kind, rec), entityId: rec.id, version: rec.version });
    // Запрос пути ядра (/units…) и шаг операции по uid: событие об объекте несёт вид объекта (camera, archive.local), в том числе
    // о том, что сделали хуки и помощники моста (changed("device", …)). Вне запроса (события стенда /test/events, часы) — вид
    // таблицы (device, archive)
    let coreMode = false;
    const evKind = (kind, x) => {
      if (!coreMode || !x) return kind;
      if (x.uid && x.kind) return x.kind;
      const u = x.id ? store.get(x.id) : null;
      return u ? u.kind : kind;
    };
    // Переподключение с Last-Event-ID: пропущенное досылается; если его уже нет — stream.reset,
    // и клиент перечитывает всё
    // watch — список наблюдаемых из запроса открытия, GET /stream?watch=…
    function subscribe(fn, lastEventId, watch) {
      const clientId = `c${(++clientSeq).toString(36)}`;
      const client = { fn, watch: new Set(watch || []) };
      setTimeout(() => fn({ id: String(seqEvent), type: "stream.hello", at: iso(now()), clientId }), 0);
      if (lastEventId != null && lastEventId !== "") {
        const i = history.findIndex((m) => m.id === String(lastEventId));
        const missed = i >= 0 ? history.slice(i + 1) : [{ id: String(seqEvent), type: "stream.reset", at: iso(now()), payload: {} }];
        // Досылка — всё подряд: наблюдение у нового потока ещё не задано, лишнее клиент пропускает
        missed.forEach((m) => setTimeout(() => fn(clone(m)), 0));
      }
      clients.set(clientId, client);
      return () => clients.delete(clientId);
    }

    // Пароль учётки потока: сервер его не хранит в открытую, отдаёт один раз
    let secretSeq = 0;
    const newSecret = () => `s-${(++secretSeq).toString(36)}-${(now() % 1679616).toString(36)}`;

    /* ===== Ответы ===== */

    function problem(status, code, message, extra) {
      return { status, body: Object.assign({ code, message }, extra || {}) };
    }
    // Версия записи — непрозрачная строка (контракт): клиенты сравнивают её только на равенство. Встроенный
    // сервер берёт её из общего счётчика: у одной записи она растёт скачками и никогда не повторяется — так
    // никто не опирается на «+1», а старая версия не совпадёт с новой
    let versionSeq = 0;
    const newVersion = () => `v${(++versionSeq).toString(36)}`;
    const bump = (rec) => (rec.version = newVersion());
    const etag = (rec) => `"${rec.version}"`;
    const one = (rec, status) => ({ status: status || 200, body: rec, headers: { ETag: etag(rec) } });
    const items = (list) => ({ status: 200, body: { items: list } });
    const parseMatch = (h) => (h == null ? null : String(h).replace(/^W\//, "").replace(/"/g, "").trim());
    // Версия из If-Match: нет заголовка — 428, не совпала — 412 с актуальной записью; над записью идёт
    // групповая операция — 409 BUSY
    function precondition(rec, headers) {
      const v = parseMatch(headers["if-match"]);
      if (v == null || v === "") return problem(428, "PRECONDITION_REQUIRED", "Нужен заголовок If-Match с версией записи");
      if (v !== rec.version) return problem(412, "VERSION_MISMATCH", "Запись изменилась с момента чтения", { current: clone(rec) });
      return lockedProblem([rec.id]);
    }
    // Объекты групповой операции, пока она не завершена, другим запросам не меняются: первый занятый из ids — 409
    // test — busy для правок; held для удалений: там занято и то, на что ссылается ждущий шаг
    function lockedProblem(ids, test = busy) {
      const at = ids.findIndex(test);
      return at >= 0 ? problem(409, "BUSY", "Над объектом выполняется групповая операция", { params: { targetId: ids[at] } }) : null;
    }

    /* ===== Устройства ===== */

    // Выводное поле камеры «детекторы»: виды встроенных и серверных (cameraId) детекторов, без повторов
    function detKindsOf(camId, all) {
      const kinds = new Set();
      (all || db.devices).forEach((d) => d.type === "det" && (d.parentId === camId || d.cameraId === camId) && d.detectorKind && kinds.add(d.detectorKind));
      return kinds;
    }
    /* ----- Смысл устройств — в хуках profiles.js (DEVICE, vms.camera/1, vms.stream/1, vms.detector/1, vms.acs/1): старые
       пути зовут тот же код, что пути ядра ----- */
    const replicaView = (out) => hCamera.replicaView(out);
    const SOURCE_GONE = hCamera.SOURCE_GONE;
    const serverWideRows = (rec) => hCamera.serverWideRows(rec, pctx);
    const serverWideChanged = (a) => hCamera.serverWideChanged(a, pctx);
    const cardProblem = (rec, patch) => hCamera.cardProblem(rec, patch, pctx);
    const hasBuiltIn = (rec) => hCamera.hasBuiltIn(rec, pctx);
    const rowOf = (rec, archiveId) => hCamera.archiveRowOf(rec, archiveId);
    const offline = (s) => hDevice.offline(s);
    const keptTick = () => hDevice.keptTick(pctx);
    const unitType = (type) => hDevice.unitKind(type, pctx);
    const isUnit = (d) => hDevice.isUnit(d, pctx);
    const folderable = (d) => hDevice.folderable(d, pctx);
    const numberOf = (d) => hDevice.numberOf(d);
    const goneWith = (rec) => hDevice.goneWith(rec, pctx);
    const detOption = (d, cam) => hDetector.detOption(d, cam, pctx);
    const zoneProblem = (z) => hDetector.zoneProblem(z, pctx);
    const sensProblem = (d, value, cam) => hDetector.sensProblem(d, value, cam, pctx);
    const sizeOf = (res) => hStream.sizeOf(res);
    const resProblem = (options, res) => hStream.resProblem(options, res, pctx);
    /* ----- Виды хранилищ: что отдал сервер ----- */

    // Вид хранилища (local, network…) — из описания вида archive.<вид>: x-archive (адрес, режимы, шифрование); вида нет — null
    const kindSpec = (kind) => {
      const k = kinds.get(`archive.${kind}`);
      return k && k["x-archive"] ? Object.assign({ kind }, k["x-archive"]) : null;
    };
    const NO_KIND = { address: "disk", recordModes: [], archiveModes: [], serverWide: false, encryption: false, admits: true };
    const specOf = (a) => kindSpec(a.kind) || NO_KIND;
    const archiveWrites = (d, id) => d.archiveId === id || (d.extraArchives || []).some((x) => x.archiveId === id);
    // Команда на реле двери идёт операцией единицы (unitAction unit), а не выходом
    function doorRelayIssue(c) {
      const hit = (t) => (t ? t.include : []).some((x) => {
        const d = !x.area ? byId("devices", x.uid) : null;
        return !!d && d.type === "relay" && isUnit(d);
      });
      const walk = (l) => l.some((a) => (a.type === "unitAction" && a.action === "output" && hit(a.target)) || walk(a.yes || []) || walk(a.no || []));
      return walk(c.steps) ? problem(422, "NOT_SUPPORTED", "Реле двери управляется операцией единицы", { field: "steps" }) : null;
    }

    // Папки ведёт центр домена
    const domainDown = (id) => (byId("domains", id) || {}).online === false;
    // Новый состав пресетов — одиночная правка в стопке, шаг по uid: откат — правкой properties.presets
    function setPresets(rec, next) {
      const presets = next.sort((a, b) => a.n - b.n);
      const before = applyPatch(rec, { presets });
      changed("device", rec);
      const u = store.get(rec.id), patch = { properties: { presets: clone(presets) } };
      recordSingle([{ targetId: u.uid, version: u.version, before: { unitPatch: { properties: { presets: before.presets } } }, after: unitFieldsOf(u, patch), secret: false, req: { uid: u.uid, patch } }]);
    }

    /* ----- Детекторы ----- */

    const parentOf = (d) => (d.parentId ? byId("devices", d.parentId) : null);

    /* ===== Тома ===== */

    // Форматирование идёт по часам сервера: том → когда закончится
    const FORMAT_MS = 1500;
    let formatting = new Map();
    // Скан кончается по часам сервера: задача → когда закончится
    const SCAN_MS = 1500;
    let scanning = new Map();
    // Необязательные настройки, которых в системе нет (capabilities.features), менять нельзя
    const FEATURE_FIELDS = { server: { role: "serverRoles", netmask: "serverNetwork", gateway: "serverNetwork", dns: "serverNetwork" } };
    function featureProblem(kind, patch) {
      const field = Object.keys(patch).find((k) => FEATURE_FIELDS[kind] && FEATURE_FIELDS[kind][k] && !can(FEATURE_FIELDS[kind][k]));
      if (field) return problem(422, "NOT_SUPPORTED", `Система не поддерживает: ${field}`, { field });
      if (kind === "archive" && patch.encrypted === true && !can("archiveEncryption")) return problem(422, "NOT_SUPPORTED", "Система не поддерживает шифрование хранилищ", { field: "encrypted" });
      return null;
    }
    // Значения до изменения — для отката: поля, которых не было, — null
    // Что говорит о строке записи сервер, правка строки не стирает; в запись это не попадает
    const keepRows = (rec, patch) => hCamera.keepRows(rec, patch);
    function applyPatch(rec, patch) {
      const before = {};
      Object.entries(keepRows(rec, patch)).forEach(([k, v]) => {
        if (k === "password" || k === "secret") {
          const sk = k === "password" ? rec.id : rec.id + ":secret";
          before[k] = secrets.has(sk) ? secrets.get(sk) : null;
          if (v === null || v === "") secrets.delete(sk);
          else secrets.set(sk, v);
          return;
        }
        before[k] = k in rec ? clone(rec[k]) : null;
        if (v === null) delete rec[k];
        else rec[k] = clone(v);
      });
      bump(rec);
      return before;
    }

    /* ===== Устройства: создание и удаление ===== */

    // Вместе с дочерними; ссылки на него убираются из папок и из записи по детекторам
    // Удалённое уходит из доступа учёток потоков, снимок прав меняется
    function dropStreamGrants(fn) {
      const list = db.access.streamGrants;
      if (!list) return;
      const was = JSON.stringify(list);
      list.forEach(fn);
      db.access.streamGrants = list.filter((g) => g.account);
      if (JSON.stringify(db.access.streamGrants) === was) return;
      bump(db.access);
      send("entity.changed", { kind: "access", version: db.access.version });
    }
    function removeDevice(id) {
      const gone = goneWith(byId("devices", id));
      // Строки незнакомых видов под камерой (w2c.example/rows и потомки) уходят с ней — dependents профиля vms.camera/1
      const rows = dependentsOf(store.get(id)).remove.filter((x) => !gone.has(x) && store.has(x) && tableOf(store.get(x).kind) !== "devices");
      // Вид удалённого — до удаления: на путях ядра событие несёт его (camera, det)
      const kindOf = new Map([...gone].map((x) => [x, (store.get(x) || {}).kind]));
      gone.forEach((x) => { const d = byId("devices", x); if (d) goneNear.set(x, nearOf(d)); });
      db.devices.filter((d) => d.parentId === id && !gone.has(d.id)).forEach((c) => {
        c.parentId = null;
        bump(c);
        changed("device", c);
      });
      const names = new Map(db.devices.filter((d) => gone.has(d.id)).map((d) => [d.id, d.name]));
      db.devices = db.devices.filter((d) => !gone.has(d.id));
      dropStreamGrants((g) => { g.deviceIds = g.deviceIds.filter((x) => !gone.has(x)); });
      db.archiveWatches.filter((w) => gone.has(w.deviceId)).forEach(dropWatch);
      db.archiveScans.filter((x) => gone.has(x.deviceId)).forEach(dropScan);
      rulesGone(names);
      db.folders.forEach((f) => {
        if (!f.deviceIds.some((x) => gone.has(x))) return;
        f.deviceIds = f.deviceIds.filter((x) => !gone.has(x));
        bump(f);
        changed("folder", f);
      });
      db.devices.forEach((d) => {
        if (!(d.recordDetectorIds || []).some((x) => gone.has(x))) return;
        d.recordDetectorIds = d.recordDetectorIds.filter((x) => !gone.has(x));
        bump(d);
        changed("device", d);
      });
      rows.slice().reverse().forEach((x) => {
        const u = store.get(x);
        store.remove(x);
        legacy.detach(u);
        applying.delete(x);
        [...secrets.keys()].filter((key) => secretOfUnit(x, key)).forEach((key) => secrets.delete(key));
        send("entity.deleted", { kind: u.kind, entityId: x });
      });
      // Прочие ссылки x-ref на удалённое — как у удаления путями ядра (refsCleanup)
      refsCleanup(new Set([...gone, ...rows]));
      gone.forEach((x) => {
        // Пароль (ключ — id) и прочие секреты объекта (логин путей ядра: id#login)
        [...secrets.keys()].filter((key) => secretOfUnit(x, key)).forEach((key) => secrets.delete(key));
        wasRemoved.add(x);
        send("entity.deleted", { kind: evKind("device", { uid: x, kind: kindOf.get(x) }), entityId: x });
        goneNear.delete(x);
      });
    }

    // Правило — с историей версий и своими расписаниями, если они больше нигде не используются;
    // журнал его запусков остаётся
    function removeRule(r) {
      db.rules = db.rules.filter((x) => x !== r);
      db.ruleVersions = db.ruleVersions.filter((v) => v.ruleId !== r.id);
      runsStop(r.id);
      send("entity.deleted", { kind: "rule", entityId: r.id });
      db.schedules.filter((sc) => sc.owner && sc.owner.kind === "rule" && sc.owner.id === r.id && !scheduleUsed(sc.id)).forEach(removeSchedule);
    }
    function dropWatch(w) {
      db.archiveWatches = db.archiveWatches.filter((x) => x !== w);
      send("entity.deleted", { kind: "archiveWatch", entityId: w.id });
    }
    function dropScan(x) {
      scanning.delete(x.id);
      db.archiveScans = db.archiveScans.filter((y) => y !== x);
      send("entity.deleted", { kind: "archiveScan", entityId: x.id });
    }
    /* ----- Обход и скан архива ----- */

    const fieldBad = (field, text) => problem(422, "VALIDATION_FAILED", text, { field });
    // Коды событий из описаний видов (UnitKind.events): что бывает тревогой
    // alarm:false — событие в тревоги не берут (other, segment.lost)
    const eventCodes = () => new Set(kinds.list().flatMap((k) => (k.events || []).filter((e) => e.alarm !== false).map((e) => e.id)));
    // Вид детектора — из перечня detectorKind схемы вида det
    const kindKnown = (k) => ((((kinds.get("det") || {}).schema || {}).properties || {}).detectorKind || {}).enum?.includes(k) || false;
    const cameraArchive = (cam, id) => !!rowOf(cam, id) || serverWideRows(cam).some((x) => x.archiveId === id);
    function jobProblem(x) {
      if (x.mask && zoneProblem(x.mask)) return fieldBad("mask", "Маска задана неверно");
      const known = eventCodes();
      if ((x.alarms || []).some((a) => !known.has(a))) return fieldBad("alarms", "Нет такого вида события");
      return null;
    }
    function watchProblem(w, was) {
      const cam = byId("devices", w.deviceId);
      if (!cam || cam.type !== "camera") return fieldBad("deviceId", "Обход — у камеры");
      if (cam.archiveJobs === false) return problem(422, "NOT_SUPPORTED", "Запись камеры хранится в другом кластере", { field: "deviceId" });
      if (!hasBuiltIn(cam)) return problem(422, "NOT_SUPPORTED", "У камеры нет архива устройства", { field: "deviceId" });
      if (!kindKnown(w.detectorKind)) return fieldBad("detectorKind", "Нет такого вида детектора");
      if (db.archiveWatches.some((x) => x !== was && x.deviceId === w.deviceId && x.detectorKind === w.detectorKind)) return fieldBad("detectorKind", "Такой обход у камеры уже есть");
      if (w.keep === "hits" && (!w.archiveId || !cameraArchive(cam, w.archiveId))) return fieldBad("archiveId", "Найденное сохраняется в архив этой камеры");
      return jobProblem(w);
    }
    function scanProblem(b) {
      const cam = byId("devices", b.deviceId);
      if (!cam || cam.type !== "camera") return fieldBad("deviceId", "Скан — по записи камеры");
      if (cam.archiveJobs === false) return problem(422, "NOT_SUPPORTED", "Запись камеры хранится в другом кластере", { field: "deviceId" });
      if (!cameraArchive(cam, b.archiveId)) return fieldBad("archiveId", "Архив не этой камеры");
      if (!kindKnown(b.detectorKind)) return fieldBad("detectorKind", "Нет такого вида детектора");
      if (!(Date.parse(b.from) < Date.parse(b.to))) return fieldBad("to", "Конец отрезка раньше начала");
      return jobProblem(b);
    }
    // Встроенный сервер записей не смотрит: итог считается от длины отрезка, камера без связи — неудача
    function finishScan(x) {
      const asked = (Date.parse(x.to) - Date.parse(x.from)) / 1000;
      const cam = byId("devices", x.deviceId);
      const off = !cam || cam.online === false;
      x.state = off ? "failed" : "done";
      x.result = off ? { end: "failed", covered: 0, asked, events: 0, partial: [], why: "Камера без связи" } : { end: "done", covered: asked, asked, events: Math.floor(asked / 600), partial: [] };
      bump(x);
      send("entity.changed", { kind: "archiveScan", entityId: x.id, version: x.version });
    }
    // Запись с потомками по parentId: устройство — с дочерними, папка — с подпапками
    function subtree(table, id) {
      const all = new Set([id]);
      for (let grew = true; grew; ) {
        grew = false;
        db[table].forEach((x) => {
          if (x.parentId && all.has(x.parentId) && !all.has(x.id)) {
            all.add(x.id);
            grew = true;
          }
        });
      }
      return all;
    }
    const withChildren = (id) => subtree("devices", id);
    // Что меняет удаление записи (для проверки на групповую операцию): устройство — с дочерними и камеры, что
    // записывают по его детекторам; папка — состав, то есть папки лежащих в ней устройств; хранилище — с томами
    // и камерами, что в него пишут
    function touchedBy(table, rec) {
      if (table === "devices") {
        const d = dependentsOf(legacy.unitOf(rec));
        return d.remove.concat(d.detach);
      }
      if (table === "folders" || table === "archives") {
        const d = hookOf(legacy.unitOf(rec).kind, "dependents").dependents(legacy.unitOf(rec), pctx);
        return d.remove.concat(d.detach);
      }
      return [rec.id];
    }

    /* ===== Автоматизация ===== */

    // Правило в ответе: умолчание годности, состояние — только у включённого, в версию не входит
    const ruleView = (r) => Object.assign(clone(r), { validForSec: r.validForSec ?? 30 }, r.enabled ? { status: engine.status(r, db.reference) } : {});
    const content = (r) => Object.fromEntries(RULE_CONTENT.map((k) => [k, clone(r[k])]));
    const myLogin = () => (db.access.users.find((u) => u.id === me) || {}).login || "";
    // Цели правила (и вложенные — в шагах, ожидаемом событии): fn(target) → новая цель
    function eachTarget(c, fn) {
      c.triggers.forEach((t) => (t.target = fn(t.target)));
      c.conditions.forEach((x) => "target" in x && (x.target = fn(x.target)));
      const walk = (l) => l.forEach((a) => {
        if ("target" in a) a.target = fn(a.target);
        if (a.event) a.event.target = fn(a.event.target);
        walk(a.yes || []);
        walk(a.no || []);
      });
      walk(c.steps);
    }
    // Удалённый объект остаётся в цели битым элементом — по имени; исключение удалённого просто снимается.
    // В версиях истории — так же, иначе «Сравнить» покажет удаление как правку
    function rulesGone(names) {
      if (!names.size) return;
      const fix = (t) => {
        if (!t) return t;
        const hit = t.include.filter((x) => !x.area && names.has(x.uid));
        if (!hit.length && !t.exclude.some((x) => names.has(x))) return t;
        return Object.assign({}, t, { include: t.include.filter((x) => !hit.includes(x)), exclude: t.exclude.filter((x) => !names.has(x)),
          gone: [...t.gone, ...hit.map((x) => names.get(x.uid))] });
      };
      db.rules.forEach((r) => {
        const was = JSON.stringify(r);
        eachTarget(r, fix);
        if (JSON.stringify(r) === was) return;
        bump(r);
        runsStop(r.id);
        changed("rule", r);
      });
      db.ruleVersions.forEach((v) => eachTarget(v.rule, fix));
    }
    // Версия истории: что стало после изменения. undo убирает версию, которую отменяет, если она последняя
    // was — кто и когда менял правило и с какого дня оно «в наблюдении» до этой правки. «Отменить»
    // правки возвращает их: отменённое изменение не считается изменением (версия записи — всё равно новая)
    const ruleMeta = (r) => ({ changedAt: r.changedAt, changedBy: r.changedBy, logOnlySince: r.logOnlySince });
    function pushVersion(r, note, was) {
      const h = db.ruleVersions.filter((v) => v.ruleId === r.id);
      if (note && note.code === "undo") {
        const last = h[h.length - 1];
        if (last && last.number === note.params.number) {
          db.ruleVersions = db.ruleVersions.filter((v) => v !== last);
          if (last.was) Object.assign(r, last.was);
          return;
        }
      }
      db.ruleVersions.push({ id: uuid("ruleVersion"), ruleId: r.id, number: h.length ? h[h.length - 1].number + 1 : 1, at: iso(now()), by: myLogin(), note: note || null, rule: content(r), was: was || null });
    }
    const versionView = (v) => { const out = clone(v); delete out.was; return out; };
    // Номер входа и выхода — в записи. Поле правила, если оно есть, значит то же самое
    function portIssue(c) {
      const off = (target, port) => (target ? target.include : []).some((x) => {
        const d = !x.area ? byId("devices", x.uid) : null;
        return !!d && d.channel != null && d.channel !== Number(port);
      });
      if (c.triggers.some((t) => t.event === "io.input" && t.match.port != null && off(t.target, t.match.port))) return "trigger.portMismatch";
      const port = (a) => (a.type === "unitAction" && a.action === "output" && a.params && a.params.port != null ? a.params.port : null);
      const walk = (l) => l.some((a) => (port(a) != null && off(a.target, port(a))) || walk(a.yes || []) || walk(a.no || []));
      return walk(c.steps) ? "action.portMismatch" : null;
    }
    // Живые роли человека: личные и через группы
    function myRoleIds() {
      const a = db.access, t = today(), live = (until) => !until || until >= t, u = a.users.find((x) => x.id === me);
      if (!u) return [];
      return [...new Set([...u.roleIds.filter((r) => live(u.roleUntil[r])), ...a.groups.filter((g) => g.memberIds.includes(me) && live(g.rolesUntil)).flatMap((g) => g.roleIds)])];
    }
    // Автор отвечает за всё, что правило называет: иначе правило стало бы способом командовать чужой камерой
    function ruleRightProblem(c) {
      const bad = engine.forbidden(c, myRoleIds(), db.reference);
      return bad ? problem(403, "PERMISSION_DENIED", "Нет права на то, что называет правило", { params: { target: clone(bad) } }) : null;
    }
    // Тип поля шага unitAction — по схеме params команды вида (ActionDescriptor.params) у видов, где команда — действие правила.
    // Не тот тип — 422 VALIDATION_FAILED и у выключенного правила: такое значение не исполнит никто. Поле вне схемы, значение
    // вне enum — забота каталога (action.fieldNotDeclared, только у включённого)
    function stepTypeProblem(c) {
      const is = (x, v) => (x === "integer" ? Number.isInteger(v) : x === "number" ? typeof v === "number" : x === "null" ? v === null : x === "array" ? Array.isArray(v) :
        x === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : typeof v === x);
      const typeOk = (sch, v) => { const t = [].concat(sch.type || []); return !t.length || t.some((x) => is(x, v)); };
      const props = (a, n) => kinds.list().map((k) => (k.actions || []).find((x) => x.id === a.action && x.ruleAction)).filter(Boolean)
        .map((d) => ((d.params || {}).properties || {})[n]).filter(Boolean);
      const bad = (a) => a.type === "unitAction" && Object.entries(a.params || {}).find(([n, v]) => { const l = props(a, n); return l.length && !l.some((x) => typeOk(x, v)); });
      let hit = null;
      const walk = (l) => l.some((a) => (hit = bad(a)) || walk(a.yes || []) || walk(a.no || []));
      return walk(c.steps) ? problem(422, "VALIDATION_FAILED", `Поле ${hit[0]} — не того типа, что в описании команды`, { field: "steps", params: { keyword: "type", param: hit[0] } }) : null;
    }
    function ruleProblem(c) {
      if (!String(c.name || "").trim()) return problem(422, "NAME_REQUIRED", "Укажите название правила", { field: "name" });
      if (c.runAsRoleId && !db.access.roles.some((x) => x.id === c.runAsRoleId)) return problem(422, "VALIDATION_FAILED", `Роли ${c.runAsRoleId} нет`, { field: "runAsRoleId" });
      const typed = stepTypeProblem(c);
      if (typed) return typed;
      const door = doorRelayIssue(c);
      if (door) return door;
      const port = portIssue(c);
      if (port) return problem(422, "RULE_INVALID", "Номер входа или выхода не совпал с записью", { params: { issue: { code: port, params: {} } } });
      if (c.enabled) {
        const out = engine.undeclared(c, db.reference);
        if (out) return problem(422, "NOT_SUPPORTED", "Система этого не исполняет: правило вне каталога", { field: out.field, params: { issue: out.issue } });
        const cross = engine.crossDomain(c, db.reference);
        if (cross) return problem(422, "NOT_SUPPORTED", "Правило с целями из нескольких доменов этого не исполняет", { field: "steps", params: { issue: cross } });
        const home = c.serverId ? byId("servers", c.serverId) : null, doms = engine.domainsOf(c);
        if (home && doms.length === 1 && doms[0] !== home.domainId) return problem(422, "VALIDATION_FAILED", "Цели правила — в другом домене, чем его сервер", { field: "serverId" });
        const why = engine.issue(Object.assign({ id: null }, c));
        if (why) return problem(422, "RULE_INVALID", "Правило с ошибкой нельзя включить: исправьте ошибку или выключите правило", { params: { issue: why } });
      }
      return null;
    }
    const stateNote = (r) => ({ code: "state", params: { mode: !r.enabled ? "off" : r.logOnly ? "watch" : "on" } });
    const sysToday = () => engine.stamp(now()).slice(0, 10);
    /* ----- Ход правил: запуски, которые ждут человека, и вопросы им (ask, escalate) -----
       Запуск встал — запись RuleFire с result: waiting и строка в ruleRuns. Ответ или срок решают шаг: запуск
       считается заново тем же движком с записанными исходами, запись обновляется. Настоящий бэкенд держит
       это в строке запуска и переживает перезапуск; здесь — в памяти до /test/reset */
    let ruleRuns = [], prompts = [];
    const runRec = (run) => db.ruleFires.find((x) => x.id === run.fireId);
    // Память о закрытом вопросе: имя запуска живёт в done, потом — 404 вместо 409. Срок стенда условный: в нормах это
    // вытеснение из done, а не часы
    const PROMPT_KEEP_MS = 86400000;
    // Роль без строк грантов не видна двери ответа: предел, ADR-0112 доп. (9) п. 4. Встроенный сервер судит это по строкам роли
    const roleSeen = (id) => {
      const r = db.access.roles.find((x) => x.id === id);
      return !!r && (r.global.unr || Object.keys(r.folderAccess || {}).length + Object.keys(r.objectAccess || {}).length > 0);
    };
    const mayAnswer = (p) => myRoleIds().includes(p.roleId) && roleSeen(p.roleId);
    const promptView = (p) => ({ id: p.id, ruleId: p.ruleId, fireId: p.fireId, step: p.step, kind: p.kind, text: p.text, roleId: p.roleId, level: p.level,
      openedAt: p.openedAt, until: p.until, canAnswer: mayAnswer(p) });
    function promptOpen(run, f) {
      const p = Object.assign({ id: uuid("prompt"), ruleId: run.ruleId, fireId: run.fireId, step: run.pause.key, openedAt: iso(now()), until: iso(run.pause.until), closed: null }, f);
      prompts.push(p);
      send("prompt.opened", { kind: "rulePrompt", entityId: p.id, payload: { ruleId: p.ruleId, fireId: p.fireId, step: p.step, roleId: p.roleId, level: p.level } });
    }
    function promptsClose(run, reason, extra) {
      prompts.filter((p) => p.fireId === run.fireId && !p.closed).forEach((p) => {
        p.closed = reason;
        p.closedAt = now();
        send("prompt.closed", { kind: "rulePrompt", entityId: p.id, payload: Object.assign({ ruleId: p.ruleId, fireId: p.fireId, step: p.step, reason }, extra || {}) });
      });
    }
    function runPause(run, pause) {
      const c = pause.control, t = now();
      run.pause = { key: pause.key, control: c };
      // «Только журнал» никого не трогает: срок идёт, вопроса нет, ask кончается веткой default, escalate — последним уровнем
      const silent = runRec(run).logOnly;
      if (c.control === "ask") {
        run.pause.until = t + c.sec * 1000;
        if (silent) return null;
        return promptOpen(run, { kind: "ask", text: engine.fillText(c.text, run.rule, runRec(run)), roleId: c.roleId, level: null });
      }
      let at = t;
      run.pause.levels = c.levels.map((l) => {
        const x = { at, roleId: l.roleId };
        at += l.waitMin * 60000;
        return x;
      });
      run.pause.until = at;
      run.pause.reached = silent ? run.pause.levels.length : 0;
      runLevels(run);
    }
    // Уровни, до которых дошло время: вопрос прежнего остаётся открытым до конца эскалации
    function runLevels(run) {
      const p = run.pause;
      while (p.reached < p.levels.length && now() >= p.levels[p.reached].at) {
        p.reached += 1;
        promptOpen(run, { kind: "escalate", text: "", roleId: p.levels[p.reached - 1].roleId, level: p.reached });
      }
    }
    // Шаг решён: запуск идёт дальше до следующего ожидания или до конца
    function runDecide(run, outcome, who) {
      run.br[run.pause.key] = outcome;
      if (who) run.who[run.pause.key] = who;
      run.pause = null;
      runGo(run);
    }
    function runGo(run) {
      const rec = runRec(run);
      const f = engine.fire(run.rule, { via: run.via, by: rec.by, at: run.at, now: true, i: 0, live: true, br: run.br, who: run.who, events: run.events, src: run.src, checks: rec.checks, watch: rec.logOnly });
      Object.assign(rec, { at: f.at, steps: f.steps, result: f.result });
      send("entity.changed", { kind: "ruleFire", entityId: rec.id, payload: { ruleId: rec.ruleId } });
      if (f.pause) return runPause(run, f.pause);
      ruleRuns = ruleRuns.filter((x) => x !== run);
      const next = ruleRuns.find((x) => x.ruleId === run.ruleId && x.queued);
      if (next && !ruleRuns.some((x) => x.ruleId === run.ruleId && !x.queued)) {
        next.queued = false;
        next.at = now();
        runGo(next);
      }
    }
    // Запуск снят правкой правила или repeat: restart: итог — по тому, что успело выполниться
    function runStop(run) {
      promptsClose(run, "stopped");
      ruleRuns = ruleRuns.filter((x) => x !== run);
      const rec = runRec(run);
      rec.steps = rec.steps.map((s) => (s.state === "waiting" ? Object.assign({}, s, { state: "skip", reason: { code: "run.stopped", params: {} } }) : s));
      rec.result = run.queued ? "skip" : engine.outcome(rec.steps, rec.logOnly);
      send("entity.changed", { kind: "ruleFire", entityId: rec.id, payload: { ruleId: rec.ruleId } });
    }
    const runsStop = (ruleId) => ruleRuns.filter((x) => x.ruleId === ruleId).forEach(runStop);
    function runDue() {
      return ruleRuns.filter((x) => x.pause).flatMap((x) => [x.pause.until, ...(x.pause.levels || []).slice(x.pause.reached).map((l) => l.at)]);
    }
    function runTick() {
      ruleRuns.slice().forEach((run) => {
        const p = run.pause;
        if (!p) return;
        if (p.levels) runLevels(run);
        if (now() < p.until) return;
        promptsClose(run, "expired");
        runDecide(run, "none", p.levels ? { level: p.levels.length, at: iso(now()) } : null);
      });
    }
    // Новый запуск: repeat судит идущий, запуск встаёт на первом ожидании (V/07.4)
    function ruleStart(r, o) {
      const busy = ruleRuns.filter((x) => x.ruleId === r.id), rp = r.repeat || "skip";
      const over = rp === "queue" && busy.length >= RUNS_MAX, queued = !!busy.length && rp === "queue" && !over;
      if (busy.length && rp === "restart") busy.forEach(runStop);
      const rule = clone(r), at = now();
      const f = engine.fire(rule, Object.assign({ at, now: true, i: 0, live: true, busy: !!busy.length, busyAs: over ? "skip" : undefined, queued }, o));
      const rec = storeFire(f);
      if (!queued && !f.pause) return rec;
      const run = { ruleId: r.id, fireId: rec.id, rule, via: o.via, at, events: rec.events, src: rec.sourceDeviceIds, br: {}, who: {}, pause: null, queued };
      ruleRuns.push(run);
      if (f.pause) runPause(run, f.pause);
      return rec;
    }
    // Выполнить шаги запуска, которые движок счёл выполненными: команды объектов (unitAction) — как POST /units/{uid}/actions/…
    // Только мгновенные команды вида и не «Только журнал»; итог — в status.observed объекта
    function fireDo(f) {
      if (!f || f.logOnly) return;
      f.steps.forEach((x) => {
        if (x.state !== "ok" || !x.action || x.action.type !== "unitAction" || !x.deviceId) return;
        const u = store.get(x.deviceId), desc = u && unitCommand(u.kind, x.action.action);
        if (!desc || desc.execution === "longRunning") return;
        const params = clone(x.action.params || {}), run = actionRun(u.kind, desc.id);
        if (run) run(u, params, pctx, desc.id);
        else runAction(u, desc, params);
      });
    }
    function storeFire(f) {
      const rec = Object.assign({ id: uuid("fire") }, f);
      db.ruleFires.push(rec);
      send("entity.created", { kind: "ruleFire", entityId: rec.id, payload: { ruleId: rec.ruleId } });
      return rec;
    }
    // Владелец расписания — существующее окно обслуживания или правило
    const ownerProblem = (o) =>
      o && !byId(o.kind === "rule" ? "rules" : "maintenanceWindows", o.id) ? problem(422, "VALIDATION_FAILED", `Владельца расписания ${o.id} нет`, { field: "owner" }) : null;
    // Где используется расписание: режимы, условия «Время», окна обслуживания
    const scheduleUsed = (id) =>
      db.modes.items.some((m) => m.scheduleId === id) || db.maintenanceWindows.some((w) => w.scheduleId === id) ||
      db.rules.some((r) => r.conditions.some((c) => c.kind === "time" && c.scheduleId === id)) ||
      db.devices.some((d) => d.recordScheduleId === id);
    const never = () => (db.schedules.find((s) => s.builtin && s.kind === "never") || {}).id || null;
    function removeSchedule(sc) {
      db.schedules = db.schedules.filter((x) => x !== sc);
      send("entity.deleted", { kind: "schedule", entityId: sc.id });
      if (db.modes.items.some((m) => m.scheduleId === sc.id)) {
        db.modes.items.forEach((m) => m.scheduleId === sc.id && (m.scheduleId = null));
        bump(db.modes);
        send("entity.changed", { kind: "modes", version: db.modes.version });
      }
      db.rules.forEach((r) => {
        const hit = r.conditions.filter((c) => c.kind === "time" && c.scheduleId === sc.id);
        if (!hit.length) return;
        hit.forEach((c) => (c.scheduleId = never()));
        bump(r);
        runsStop(r.id);
        changed("rule", r);
      });
      db.maintenanceWindows.forEach((w) => {
        if (w.scheduleId !== sc.id) return;
        w.scheduleId = never();
        bump(w);
        changed("maintenanceWindow", w);
      });
    }
    const modeCurrent = () => {
      const m = db.modeManual, live = m && db.modes.items.some((x) => x.id === m.modeId) && (!m.until || Date.parse(m.until) > now());
      return { modeId: engine.modeNow(now()), manual: live ? { until: m.until || null } : null };
    };
    // Смена текущего режима (по расписанию или вручную) — событием objectMode
    function modeTick() {
      const m = engine.modeNow(now());
      if (lastMode !== null && m !== lastMode) send("entity.changed", { kind: "objectMode", entityId: m });
      lastMode = m;
    }

    /* ===== Права ===== */

    const SYNC_MS = 1500;
    let syncing = new Map();
    const lower = (s) => String(s || "").trim().toLowerCase();
    // Сегодня по часам и часовому поясу системы — для сроков назначений
    function today() {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: db.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now()));
      return p;
    }
    // Кто сейчас администратор: включён, встроенная роль (unr) — личная или группы, срок не истёк
    function admins(a) {
      const unr = new Set(a.roles.filter((r) => r.global.unr).map((r) => r.id));
      const t = today();
      const live = (until) => !until || until >= t;
      return a.users.filter((u) => {
        if (!u.enabled || (u.expiresDate && u.expiresDate < t)) return false;
        if (u.roleIds.some((r) => unr.has(r) && live(u.roleUntil[r]))) return true;
        return a.groups.some((g) => g.memberIds.includes(u.id) && live(g.rolesUntil) && g.roleIds.some((r) => unr.has(r)));
      });
    }
    // Что система не объявила, в черновик не проходит: уровни, функции, запреты и плагины — из
    // reference.access, части прав — из capabilities.features. Встроенная роль судится отдельно
    // Классы доступа и их уровни: из описаний видов (access и access.also; вид без класса — свой код, view < edit < admin),
    // прочие — из reference.access.levels (map, alert, bm, ur, vw, macro, plug)
    function accessClasses() {
      const out = new Map(Object.entries(db.reference.access.levels));
      kinds.list().forEach((k) => (k.access ? [k.access, ...(k.access.also || [])] : [{ class: k.kind, levels: ["view", "edit", "admin"] }]).forEach((c) => out.set(c.class, c.levels)));
      return out;
    }
    function accessPartProblem(a) {
      const ref = db.reference.access;
      const on = (f) => db.reference.capabilities.features.includes(f);
      const no = (field, id, what) => problem(422, "NOT_SUPPORTED", `Система этого не поддерживает: ${what}`, { field, params: { id } });
      const classes = accessClasses();
      const lv = (cls, v) => (classes.get(cls) || []).includes(v);
      const lowest = (v) => v === "FORBID" || v === "NO";
      const fields = (map, r, name) => {
        for (const [key, row] of Object.entries(map)) {
          if (key.startsWith("plug:") && !ref.plugins.includes(key.slice(5))) return no(name, r.id, `плагин ${key.slice(5)}`);
          for (const [f, v] of Object.entries(row)) if (!lv(f, v)) return no(`${name}.${f}`, r.id, `уровень ${v}`);
        }
        return null;
      };
      for (const r of a.roles) {
        const g = r.global;
        if (g.unr) continue;
        const bad = g.feat.find((x) => !ref.features.includes(x));
        if (bad) return no("global.feat", r.id, `функция ${bad}`);
        const globals = Object.fromEntries(ref.globals.map((x) => [x.key, x.levels]));
        for (const k of Object.keys(g)) {
          if (!/^(map|alert|bm)$/.test(k)) continue;
          if (globals[k] ? !lv(globals[k], g[k]) : !lowest(g[k])) return no(`global.${k}`, r.id, `уровень ${g[k]}`);
        }
        for (const [cls, v] of Object.entries(r.kindAccess || {})) if (!lv(cls, v)) return no(`kindAccess.${cls}`, r.id, classes.has(cls) ? `уровень ${v}` : `класс ${cls}`);
        const f = fields(r.folderAccess, r, "folderAccess") || fields(r.objectAccess, r, "objectAccess");
        if (f) return f;
        const restr = Object.keys(g.restr).filter((k) => g.restr[k]);
        if (restr.length && !on("accessRestrictions")) return no("global.restr", r.id, "запреты роли");
        if (restr.some((k) => !ref.restrictions.includes(k))) return no("global.restr", r.id, "запрет");
        if (g.depth && !on("accessDepth")) return no("global.depth", r.id, "глубина архива");
        const urFree = on("accessUserRights");
        if (urFree ? !lv("ur", g.ur) : g.ur !== (g.feat.includes("USERS_RIGHTS_SETUP") ? "ALL" : "NO")) return no("global.ur", r.id, "права на права пользователей");
        if (!ref.loginSchedules.includes(r.loginSchedule) || (r.loginSchedule && !on("accessLoginSchedule"))) return no("loginSchedule", r.id, "расписание входа");
        if ((r.supervision.roleId || r.supervision.login || r.supervision.export) && !on("accessSupervision")) return no("supervision", r.id, "подтверждение входа и экспорта");
      }
      if (!on("accessSessions")) {
        const u = a.users.find((x) => x.webSessions || x.mobileSessions);
        if (u) return no(u.webSessions ? "webSessions" : "mobileSessions", u.id, "лимиты сессий");
      }
      if (!on("accessCatalogs")) {
        if (a.catalogs.length) return no("catalogs", a.catalogs[0].id, "каталоги");
        const g = a.groups.find((x) => x.source);
        if (g) return no("source", g.id, "группа из каталога");
        const u = a.users.find((x) => x.catalogId);
        if (u) return no("catalogId", u.id, "пользователь из каталога");
      }
      return null;
    }
    // Сравнение без учёта порядка ключей
    const sorted = (x) => (Array.isArray(x) ? x.map(sorted) : x && typeof x === "object" ? Object.keys(x).sort().reduce((o, k) => ((o[k] = sorted(x[k])), o), {}) : x);
    const sameJson = (x, y) => JSON.stringify(sorted(x)) === JSON.stringify(sorted(y));
    // Администратор, на которого можно положиться: включён, без срока учётной записи и без срока
    // назначения, личного или через группу. Со сроком последним не считается: система запиралась бы сама
    function provenAdmins(a) {
      const unr = new Set(a.roles.filter((r) => r.global.unr).map((r) => r.id));
      return a.users.filter((u) => {
        if (!u.enabled || u.expiresDate) return false;
        if (u.roleIds.some((r) => unr.has(r) && !u.roleUntil[r])) return true;
        return a.groups.some((g) => g.memberIds.includes(u.id) && !g.rolesUntil && g.roleIds.some((r) => unr.has(r)));
      });
    }
    // Встроенная роль: меняются только назначения. unr у другой роли не бывает
    function builtinProblem(a) {
      const was = db.access.roles.find((r) => r.global.unr);
      const other = a.roles.find((r) => r.global.unr && (!was || r.id !== was.id));
      if (other) return problem(422, "NOT_SUPPORTED", "Администратор — только встроенная роль", { field: "global.unr", params: { id: other.id } });
      if (!was) return null;
      const r = a.roles.find((x) => x.id === was.id);
      if (!r) return problem(409, "BUILTIN", "Встроенную роль удалить нельзя");
      if (!r.global.unr) return problem(422, "NOT_SUPPORTED", "Снять у встроенной роли «Администратор» нельзя", { field: "global.unr", params: { id: r.id } });
      for (const k of ["name", "comment", "loginSchedule", "supervision", "global", "folderAccess", "objectAccess"]) {
        if (!sameJson(r[k], was[k])) return problem(409, "BUILTIN", "У встроенной роли меняются только назначения", { field: k });
      }
      return null;
    }
    // Назначение встроенной роли: личное или через группу, срок не истёк
    function holdsAdmin(a, id) {
      const unr = new Set(a.roles.filter((r) => r.global.unr).map((r) => r.id));
      const t = today();
      const live = (until) => !until || until >= t;
      const u = a.users.find((x) => x.id === id);
      if (!u) return false;
      return u.roleIds.some((r) => unr.has(r) && live(u.roleUntil[r])) || a.groups.some((g) => g.memberIds.includes(id) && live(g.rolesUntil) && g.roleIds.some((r) => unr.has(r)));
    }
    // Функция роли у человека: через действующую роль, личную или группы
    const managesUsers = (a, id) => hasFeat(a, id, "USERS_RIGHTS_SETUP");
    // Встроенный сервер права на камеру не считает: admin на камеру — администратор или DEVICES_SETUP
    const cameraAdmin = () => holdsAdmin(db.access, me) || hasFeat(db.access, me, "DEVICES_SETUP");
    function hasFeat(a, id, feat) {
      const t = today();
      const live = (until) => !until || until >= t;
      const has = (rid) => (a.roles.find((r) => r.id === rid) || { global: { feat: [] } }).global.feat.includes(feat);
      const u = a.users.find((x) => x.id === id);
      if (!u) return false;
      return u.roleIds.some((r) => has(r) && live(u.roleUntil[r])) || a.groups.some((g) => g.memberIds.includes(id) && live(g.rolesUntil) && g.roleIds.some(has));
    }
    const SERVER_USER = ["hasPassword", "passwordByAdmin"];
    const bare = (u) => { const c = clone(u); SERVER_USER.forEach((k) => delete c[k]); return c; };
    // Кто применяет: администратор — всё; управляющий — всё, кроме администратора, отказ на весь пакет.
    // Судится разница: строки, которых пакет не меняет, не проверяются
    function applierProblem(was, next, passwords) {
      if (holdsAdmin(was, me)) return null;
      const byId = (list) => new Map(list.map((x) => [x.id, x]));
      const wu = byId(was.users), nu = byId(next.users), wg = byId(was.groups), ng = byId(next.groups), wr = byId(was.roles), nr = byId(next.roles);
      const userChanged = (id) => passwords.has(id) || !wu.has(id) || !nu.has(id) || !sameJson(bare(wu.get(id)), bare(nu.get(id)));
      const groupChanged = (id) => !wg.has(id) || !ng.has(id) || !sameJson(wg.get(id), ng.get(id));
      const roleChanged = (id) => !wr.has(id) || !nr.has(id) || !sameJson(wr.get(id), nr.get(id));
      const users = [...new Set([...wu.keys(), ...nu.keys()])].filter(userChanged);
      const groups = [...new Set([...wg.keys(), ...ng.keys()])].filter(groupChanged);
      const roles = [...new Set([...wr.keys(), ...nr.keys()])].filter(roleChanged);
      if (!sameJson(was.streamGrants || [], next.streamGrants || []) && !managesUsers(was, me)) return problem(403, "PERMISSION_DENIED", "Нет права менять права");
      if (!users.length && !groups.length && !roles.length && !sameJson(was.catalogs, next.catalogs)) return problem(403, "PERMISSION_DENIED", "Нет права менять права");
      if (!users.length && !groups.length && !roles.length) return null;
      if (!managesUsers(was, me)) return problem(403, "PERMISSION_DENIED", "Нет права менять права");
      const deny = () => problem(403, "PERMISSION_DENIED", "Менять администратора может только администратор");
      if (users.some((id) => holdsAdmin(was, id) || holdsAdmin(next, id))) return deny();
      const unr = new Set(next.roles.filter((r) => r.global.unr).map((r) => r.id));
      const hits = (g) => !!g && g.roleIds.some((r) => unr.has(r));
      if (groups.some((id) => hits(wg.get(id)) || hits(ng.get(id)))) return deny();
      const mgr = (r) => !!r && r.global.feat.includes("USERS_RIGHTS_SETUP");
      if (roles.some((id) => mgr(wr.get(id)) !== mgr(nr.get(id)))) return deny();
      return null;
    }
    // «Администратора» не назначить тому, чей последний пароль задал не он сам и не администратор
    function passwordProblem(was, next, passwords) {
      const u = next.users.find((x) => x.passwordByAdmin === false && !passwords.has(x.id) && holdsAdmin(next, x.id) && !holdsAdmin(was, x.id));
      return u ? problem(409, "PASSWORD_NOT_ADMIN", "Пароль пользователя задал не администратор: сначала смените его", { field: "roleIds", params: { id: u.id } }) : null;
    }
    function policyProblem(u, pwd) {
      const P = db.reference.access.passwordPolicy;
      const bad = pwd.length < P.minLength || (P.letter && !/\p{L}/u.test(pwd)) || (P.digit && !/\d/.test(pwd)) || (P.notLogin && pwd.toLowerCase().includes(u.login.toLowerCase()));
      return bad ? problem(422, "PASSWORD_POLICY", "Пароль не подходит по политике", { field: "password", params: { id: u.id } }) : null;
    }
    // Почту видят администратор и управляющий, остальные — только свою
    function accessView() {
      const a = clone(db.access);
      if (!holdsAdmin(a, me) && !managesUsers(a, me)) a.users.forEach((u) => { if (u.id !== me) u.email = ""; });
      return a;
    }
    // Снимок: версия, роли без списка объектов, каталоги. Люди, группы, история и объекты роли — своими перечнями
    function accessSnapshot() {
      const a = clone(db.access);
      ["users", "groups", "history", "cellHistory"].forEach((k) => delete a[k]);
      a.roles = a.roles.map(({ objectAccess, ...r }) => Object.assign(r, { objectAccessCount: Object.keys(objectAccess || {}).length }, (a.spread || {})[r.id] ? { spread: a.spread[r.id] } : {}));
      delete a.spread;
      return a;
    }
    // Кластер — начало имени сервера. Записи кластера в контракте нет
    const clusterOf = (s) => (s.name.includes("/") ? s.name.slice(0, s.name.indexOf("/")) : null);
    const clusterNames = () => [...new Set(db.servers.filter((s) => s.allocated).map(clusterOf).filter(Boolean))];
    // Копия записи — это кластер: на кластер один приёмник, склеивать молча нельзя. Сервер без кластера — сам себе кластер
    function copiesProblem(main, ids) {
      const seen = new Set([clusterOf(main) || main.id]);
      if (new Set(ids).size !== ids.length) return "Сервер в копиях повторяется";
      for (const id of ids) {
        const s = byId("servers", id);
        if (!s || !s.allocated) return "Нет такого сервера";
        const key = clusterOf(s) || s.id;
        if (seen.has(key)) return "В копиях уже есть этот кластер";
        seen.add(key);
      }
      return null;
    }
    // Роль, у которой поменялись права: они расходятся по кластерам, имя и назначения пишутся одной записью
    function rolesTouched(a, next) {
      const part = (r) => JSON.stringify([r.global, r.folderAccess, r.objectAccess]);
      return next.roles.filter((r) => { const was = a.roles.find((x) => x.id === r.id); return !was || part(was) !== part(r); }).map((r) => r.id);
    }
    // Групповая операция по кластерам: отказ одного не откатывает прочие, расхождение остаётся видно у роли.
    // Отказ задаёт стенд: stand.refuseClusters
    function roleSpread(roleIds, again) {
      const refuse = db.stand.refuseClusters || [];
      db.access.spread = db.access.spread || {};
      const out = [];
      const stamp = iso(now());
      const mark = (roleId, cluster) => {
        const list = (db.access.spread[roleId] = (db.access.spread[roleId] || []).filter((x) => x.cluster !== cluster));
        if (!refuse.includes(cluster)) return;
        list.push({ cluster, state: "refused", at: stamp });
        const srv = db.servers.find((s) => clusterOf(s) === cluster);
        out.push(Object.assign({ cluster, roleId, code: "SERVER_OFFLINE" }, srv ? { serverId: srv.id } : {}));
        const role = db.access.roles.find((r) => r.id === roleId);
        db.access.history.unshift({ id: uuid("history"), at: stamp, actor: "система", text: `права роли «${role.name}» на кластере ${cluster} не применены`, roleId });
      };
      roleIds.forEach((id) => clusterNames().forEach((c) => mark(id, c)));
      Object.keys(db.access.spread).forEach((id) => (db.access.spread[id] || []).map((x) => x.cluster).filter((c) => again.includes(c)).forEach((c) => mark(id, c)));
      Object.keys(db.access.spread).forEach((id) => { if (!db.access.spread[id].length) delete db.access.spread[id]; });
      return out;
    }
    // Изменения поверх нынешнего: всё, чего нет в changes, остаётся как есть
    function accessNext(a, changes) {
      const next = { roles: clone(a.roles), users: clone(a.users), groups: clone(a.groups), catalogs: clone(a.catalogs) };
      if (a.streamGrants) next.streamGrants = clone(a.streamGrants);
      for (const c of changes) {
        if (c.kind === "streamGrants") {
          next.streamGrants = clone(c.value.grants);
          continue;
        }
        if (c.kind === "roleObject") {
          const role = next.roles.find((r) => r.id === c.id);
          if (!role) return problem(422, "VALIDATION_FAILED", "Роли нет", { field: "changes" });
          role.objectAccess = role.objectAccess || {};
          if (c.op === "delete" || c.value.levels === null) delete role.objectAccess[c.value.objectId];
          else role.objectAccess[c.value.objectId] = clone(c.value.levels);
          continue;
        }
        const table = { role: "roles", user: "users", group: "groups", catalog: "catalogs" }[c.kind];
        const i = next[table].findIndex((r) => r.id === c.id);
        if (c.op === "delete") {
          if (i >= 0) next[table].splice(i, 1);
          continue;
        }
        const value = clone(c.value);
        if (c.kind === "role") {
          delete value.objectAccessCount;
          value.objectAccess = i >= 0 ? next.roles[i].objectAccess : {};
        }
        if (i >= 0) next[table][i] = value;
        else next[table].push(value);
      }
      return next;
    }
    function streamGrantProblem(a) {
      const list = a.streamGrants || [];
      if (!list.length) return null;
      if (!db.reference.capabilities.features.includes("streamGrants")) return problem(422, "NOT_SUPPORTED", "Система этого не поддерживает: доступ учёток потоков", { field: "streamGrants" });
      const bad = (what) => problem(422, "VALIDATION_FAILED", `Доступ учёток потоков: ${what}`, { field: "streamGrants" });
      const seen = new Set();
      for (const g of list) {
        if (seen.has(g.account)) return bad(`учётка ${g.account} повторяется`);
        seen.add(g.account);
        if (!db.streamAccounts.some((x) => x.name === g.account)) return bad(`учётки ${g.account} нет`);
        if (!g.folderIds.every((id) => db.folders.some((f) => f.id === id))) return bad("папки нет");
        if (!g.deviceIds.every((id) => db.devices.some((d) => d.id === id && d.type === "camera"))) return bad("это не камера");
      }
      return null;
    }
    function accessProblem(a) {
      const dup = (list, key, code, what) => {
        const seen = new Set();
        for (const x of list) {
          const k = lower(x[key]);
          if (!k) return problem(422, "NAME_REQUIRED", `Пустое имя: ${what}`, { field: key });
          if (seen.has(k)) return problem(409, code, `${what} «${x[key]}» повторяется`, { field: key, params: { value: x[key] } });
          seen.add(k);
        }
        return null;
      };
      const bad =
        dup(a.roles, "name", "NAME_TAKEN", "Роль") || dup(a.users, "login", "LOGIN_TAKEN", "Логин") || dup(a.groups, "name", "NAME_TAKEN", "Группа") || dup(a.catalogs, "name", "NAME_TAKEN", "Каталог");
      if (bad) return bad;
      const ids = (list) => new Set(list.map((x) => x.id));
      const roles = ids(a.roles), users = ids(a.users), groups = ids(a.groups), cats = ids(a.catalogs);
      const all = [...roles, ...users, ...groups, ...cats];
      if (new Set(all).size !== all.length) return problem(422, "VALIDATION_FAILED", "id повторяются", { field: "id" });
      const miss = (cond, what) => (cond ? null : problem(422, "VALIDATION_FAILED", `Ссылка никуда не ведёт: ${what}`, { field: what }));
      for (const r of a.roles) {
        const e = miss(!r.supervision.roleId || roles.has(r.supervision.roleId), "supervision.roleId");
        if (e) return e;
      }
      for (const u of a.users) {
        const e =
          miss(u.roleIds.every((x) => roles.has(x)) && Object.keys(u.roleUntil).every((x) => roles.has(x)), "roleIds") ||
          miss(!u.catalogId || cats.has(u.catalogId), "catalogId") ||
          miss(!u.syncedGroupId || groups.has(u.syncedGroupId), "syncedGroupId");
        if (e) return e;
      }
      for (const g of a.groups) {
        const e = miss(g.roleIds.every((x) => roles.has(x)), "groups.roleIds") || miss(g.memberIds.every((x) => users.has(x)), "memberIds") || miss(!g.source || cats.has(g.source.catalogId), "source.catalogId");
        if (e) return e;
      }
      const part = builtinProblem(a) || accessPartProblem(a) || streamGrantProblem(a);
      if (part) return part;
      // Защита от самоблокировки: бессрочный администратор остаётся, текущий свой доступ и вход не теряет
      if (!provenAdmins(a).length) return problem(409, "SELF_LOCKOUT", "Не останется ни одного включённого бессрочного администратора");
      const self = a.users.find((u) => u.id === me);
      if (!self || !self.enabled) return problem(409, "SELF_LOCKOUT", "Вы потеряете вход");
      if (admins(db.access).some((u) => u.id === me) && !admins(a).some((u) => u.id === me)) return problem(409, "SELF_LOCKOUT", "Вы перестанете быть администратором");
      return null;
    }

    /* ===== Поиск устройств в сети ===== */

    // Находка — раз в 140 мс по часам сервера: столько, сколько в макете
    const DISCOVERY_STEP_MS = 140;
    let searches = new Map();
    const wasRemoved = new Set();
    function discoveryOf(domainId) {
      let d = db.discovery.find((x) => x.domainId === domainId);
      if (!d) db.discovery.push((d = { domainId, state: "idle", progress: 0, startedAt: null, finishedAt: null, candidateIds: [] }));
      return d;
    }
    function candidate(id) {
      const c = clone(db.network.find((x) => x.id === id));
      delete c.domainIds;
      return c;
    }
    function discoveryView(domainId) {
      const d = db.discovery.find((x) => x.domainId === domainId);
      if (!d) return { domainId, state: "idle", progress: 0, startedAt: null, finishedAt: null, candidates: [] };
      return { domainId, state: d.state, progress: d.progress, startedAt: d.startedAt || null, finishedAt: d.finishedAt || null, candidates: d.candidateIds.map(candidate) };
    }
    function finishDiscovery(domainId, state) {
      searches.delete(domainId);
      const d = discoveryOf(domainId);
      Object.assign(d, { state, finishedAt: iso(now()) });
      if (state === "done") d.progress = 100;
      send("discovery.finished", { kind: "discovery", entityId: domainId, payload: { state, progress: d.progress } });
    }
    function tickDiscovery(fired) {
      searches.forEach((s, domainId) => {
        while (searches.has(domainId) && s.nextAt <= now()) {
          const id = s.queue.shift();
          const d = discoveryOf(domainId);
          d.candidateIds.push(id);
          d.progress = Math.round(((s.total - s.queue.length) / s.total) * 100);
          send("discovery.progress", { kind: "discovery", entityId: domainId, payload: { progress: d.progress, candidate: candidate(id) } });
          s.nextAt += DISCOVERY_STEP_MS;
          if (!s.queue.length) {
            finishDiscovery(domainId, "done");
            fired.push({ kind: "discovery", id: domainId });
          }
        }
      });
    }

    /* ===== Папки устройства ===== */

    // Папки устройства — Unit.folders объекта склада, в порядке таблицы папок
    const foldersOf = (deviceId) => {
      const u = store.get(deviceId);
      if (!u || !u.folders) return [];
      const at = (id) => db.folders.indexOf(byId("folders", id));
      return u.folders.filter((f) => at(f) >= 0).sort((a, b) => at(a) - at(b));
    };

    /* ===== Групповые операции ===== */

    // Шаг выполняется за 90–230 мс: столько, сколько в макете шла очередь. Разброс — от номера шага,
    // чтобы ход был живым и при этом повторялся от прогона к прогону
    const stepMs = (i) => 90 + ((i * 53) % 141);
    // Почему операцию нельзя откатить: null — можно
    const undoing = (x) => (x.revertOf || x.redoOf) && x.state !== "done";
    // Стопка отката — законченные операции с удачными шагами, не откачанные и не сами откаты. Откатить можно только
    // верхнюю: самую новую по концу, при равенстве — созданную позже. Пока идёт откат, верхней нет
    function undoTop() {
      const all = [...ops.values()];
      if (all.some(undoing)) return null;
      return all.filter((x) => x.state === "done" && !x.revertOf && !x.reverted && !x.noUndo && x.items.some((i) => i.state === "ok"))
        .reduce((top, x) => (!top || Date.parse(x.finishedAt) >= Date.parse(top.finishedAt) ? x : top), null);
    }
    const revertReason = (op) =>
      op.revertOf ? "isRevert" : op.state !== "done" ? "running" : op.reverted ? "reverted" : op.noUndo || !op.items.some((x) => x.state === "ok") ? "empty" : now() - Date.parse(op.finishedAt) > UNDO_MS ? "expired" : undoTop() !== op ? "notLast" : null;
    // Почему отменённую операцию нельзя повторить: null — можно. Очищенное и просроченное — stale
    function redoReason(op) {
      if (!redoStack.includes(op.id) || now() - Date.parse(op.finishedAt) > UNDO_MS) return "stale";
      return redoStack[redoStack.length - 1] !== op.id || [...ops.values()].some(undoing) ? "notLast" : null;
    }
    // Одиночная правка — законченная операция из одного шага. Так откат идёт цепочкой назад и через правки
    // по одной. Ответ правки не меняется, id — из GET /operations
    function recordSingle(steps) {
      if (!steps.length) return;
      const at = iso(now());
      redoStack = [];
      const op = { id: uuid("operation"), state: "done", createdAt: at, finishedAt: at, revertOf: null, redoOf: null, retryOf: null, single: true, nextAt: 0,
        items: steps.map((x, index) => Object.assign({ index, state: "ok", code: null, req: {} }, x)) };
      ops.set(op.id, op);
      trimOps();
      send("operation.finished", { kind: "operation", entityId: op.id, payload: { state: "done", ok: op.items.length, failed: 0, cancelled: 0 } });
    }
    function trimOps() {
      const done = [...ops.values()].filter((op) => op.state === "done");
      done.slice(0, Math.max(0, done.length - UNDO_KEEP)).forEach((op) => ops.delete(op.id));
    }
    const opView = (op) => ({
      id: op.id,
      state: op.state,
      createdAt: op.createdAt,
      finishedAt: op.finishedAt,
      revertOf: op.revertOf,
      redoOf: op.redoOf || null,
      retryOf: op.retryOf,
      single: !!op.single,
      revertible: !revertReason(op),
      redoable: !redoReason(op),
      total: op.items.length,
      done: op.items.filter((x) => x.state !== "wait" && x.state !== "run").length,
      ok: op.items.filter((x) => x.state === "ok").length,
      failed: op.items.filter((x) => x.state === "fail").length,
      cancelled: op.items.filter((x) => x.state === "cancel").length,
      items: op.items.map((x) => {
        const out = { index: x.index, targetId: x.targetId, state: x.state, code: x.code };
        if (x.version !== undefined) out.version = x.version;
        if (x.createdId) out.createdId = x.createdId;
        if (x.params) out.params = x.params;
        return out;
      }),
    });
    // Шаг долгой команды, которая объект не держит (req.free: format тома — как в базе, где том на время форматирования
    // правится и удаляется), занятым его не делает
    const pending = (fn) => [...ops.values()].some((op) => op.state !== "done" && op.items.some((x) => (x.state === "wait" || x.state === "run") && !x.req.free && fn(x)));
    const busy = (targetId) => pending((x) => x.targetId === targetId);
    // Папка из folders или хранилище из properties.archiveId ещё не выполненного шага: удалить их — шаг молча
    // выполнится не так, как просили. Менять можно, удалять нельзя
    const stepProps = (x) => ((x.req.patch || {}).properties) || {};
    const holds = (x, id) => x.targetId === id || (x.req.folders || []).includes(id) || ((x.req.patch || {}).folders || []).includes(id) || stepProps(x).archiveId === id || (stepProps(x).extraArchives || []).some((e) => e.archiveId === id);
    const held = (id) => pending((x) => holds(x, id));
    // То же для шага, который выполняется сейчас: сам он ждёт в своей операции, но объект не держит
    const heldBy = (self) => (id) => pending((x) => x !== self && holds(x, id));

    function startOperation(requests, extra) {
      // Новая правка очищает повтор; откат и повтор сами стопку не трогают
      if (!extra || !(extra.revertOf || extra.redoOf)) redoStack = [];
      const op = Object.assign(
        {
          id: uuid("operation"),
          state: "running",
          createdAt: iso(now()),
          finishedAt: null,
          revertOf: null,
          retryOf: null,
          // Шаг — по uid: цель шага (targetId в ответе) — uid объекта
          items: requests.map((r, index) => ({ index, targetId: r.uid, state: "wait", code: null, req: r })),
          nextAt: now() + stepMs(0),
        },
        extra || {}
      );
      ops.set(op.id, op);
      return op;
    }

    // Шаг, который назад не вернуть (откат удаления, команды, секрета), — отказ NOT_SUPPORTED с причиной; остальное — шаг по uid
    function runItem(op, item) {
      if (item.req.undoable === false) return Object.assign(item, { state: "fail", code: "NOT_SUPPORTED" }, item.req.why ? { params: { reason: item.req.why } } : {});
      return runUnitItem(op, item);
    }

    function finish(op, fired) {
      op.state = "done";
      op.finishedAt = iso(now());
      // Отмена, которая что-то вернула, открывает повтор
      if (op.revertOf && op.items.some((x) => x.state === "ok")) redoStack.push(op.revertOf);
      trimOps();
      const v = opView(op);
      send("operation.finished", { kind: "operation", entityId: op.id, payload: { state: v.state, ok: v.ok, failed: v.failed, cancelled: v.cancelled } });
      if (fired) fired.push({ kind: "operation", id: op.id });
    }

    // Всё, что к этому моменту должно было выполниться
    function tick() {
      treeFlush();
      keptTick();
      const fired = [];
      syncing.forEach((s, cid) => {
        if (s.at > now()) return;
        syncing.delete(cid);
        const c = db.access.catalogs.find((x) => x.id === cid);
        if (!c) return;
        const at = iso(now());
        if (!s.groupId) Object.assign(c, { status: "ok", lastSyncAt: at, durationSec: 7, message: "" });
        db.access.groups.filter((g) => g.source && g.source.catalogId === cid && (!s.groupId || g.id === s.groupId)).forEach((g) => Object.assign(g.source, { status: "ok", at, message: "" }));
        bump(db.access);
        send("entity.changed", { kind: "access", version: db.access.version });
        fired.push({ kind: "catalog", id: cid });
      });
      tickDiscovery(fired);
      applyTick(fired);
      runTick();
      modeTick();
      exportTick();
      formatting.forEach((at, id) => {
        if (at > now()) return;
        formatting.delete(id);
        const v = byId("volumes", id);
        if (!v) return;
        Object.assign(v, { state: "ready", usedPercent: 0 });
        bump(v);
        changed("volume", v);
        fired.push({ kind: "volume", id });
      });
      scanning.forEach((at, id) => {
        if (at > now()) return;
        scanning.delete(id);
        const x = byId("archiveScans", id);
        if (!x) return;
        finishScan(x);
        fired.push({ kind: "archiveScan", id });
      });
      ops.forEach((op) => {
        while (op.state === "running" && op.nextAt <= now()) {
          const item = op.items.find((x) => x.state === "wait");
          if (!item) {
            finish(op, fired);
            break;
          }
          runItem(op, item);
          const v = opView(op);
          send("operation.progress", { kind: "operation", entityId: op.id, payload: { item: v.items[item.index], done: v.done, total: v.total } });
          op.nextAt += stepMs(item.index + 1);
          if (!op.items.some((x) => x.state === "wait")) finish(op, fired);
        }
      });
      return fired;
    }

    function opById(id) {
      const op = ops.get(id);
      return op ? op : null;
    }

    /* ===== Документ сценариев V/07.5 ===== */

    // Один документ на домен, целиком: хранится, не исполняется. Состояние задаёт стенд, /test/events scenario.outcome
    function scenarioDoc(id) {
      db.scenarioDocs = db.scenarioDocs || {};
      return db.scenarioDocs[id] || (db.scenarioDocs[id] = { version: newVersion(), items: [] });
    }
    function scenarioProblem(list) {
      const max = db.reference.limits.scenariosMax;
      if (list.length > max) return problem(422, "VALIDATION_FAILED", `Сценариев не больше ${max}`, { field: "items" });
      const names = new Set();
      for (let i = 0; i < list.length; i++) {
        const x = list[i], at = `items[${i}]`;
        const key = String(x.name).trim().toLowerCase();
        if (!key) return problem(422, "NAME_REQUIRED", "Укажите имя сценария", { field: `${at}.name` });
        if (names.has(key)) return problem(409, "NAME_TAKEN", "Такое имя уже есть", { field: `${at}.name` });
        names.add(key);
        const cam = (id) => { const d = byId("devices", id); return d && d.type === "camera"; };
        if (!cam(x.when.deviceId)) return problem(422, "VALIDATION_FAILED", "Триггер — камера", { field: `${at}.when.deviceId` });
        if (!cam(x.then.deviceId)) return problem(422, "VALIDATION_FAILED", "Цель — камера", { field: `${at}.then.deviceId` });
        if ((db.reference.scenarioKinds || []).length && !db.reference.scenarioKinds.includes(x.when.kind)) return problem(422, "VALIDATION_FAILED", "Такого вида события нет", { field: `${at}.when.kind` });
        const preset = x.then.action === "preset";
        if ("n" in x.then && "port" in x.then) return problem(422, "VALIDATION_FAILED", "Или пресет, или выход", { field: `${at}.then` });
        if (preset ? !("n" in x.then) : !("port" in x.then)) return problem(422, "VALIDATION_FAILED", preset ? "Нужен номер пресета" : "Нужен номер выхода", { field: `${at}.then` });
      }
      return null;
    }

    /* ===== Страницы ===== */

    // Круг вида: столько живёт курсор и столько отстаёт итог домена
    const VIEW_ROUND_MS = 20 * 60000;
    // Бюджет времени одного запроса ограниченного прохода (отбор по /units без члена): проход дописывает страницу, пока она
    // не набрала limit, не вышло это время или не кончились разделы, и только тогда отдаёт nextCursor. Встроенный сервер
    // работает в той же вкладке, что и страница: бюджет — время, когда страница не отвечает, поэтому он меньше
    // рекомендации бэкенду (~100–200 мс, api/README.md, «Страницы ограниченного прохода»). Часы — настоящие, не часы стенда
    const SCAN_BUDGET_MS = 40;
    const workNow = typeof performance !== "undefined" && performance.now ? () => performance.now() : () => Date.now();
    const hashOf = (text) => {
      let h = 2166136261;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      return h >>> 0;
    };
    // Раздел вида: порядок внутри — байты id, поэтому порядок перечня не алфавитный и не сдвигается вставкой
    const partsCount = () => (db.stand.large ? 4096 : 16);
    // Раздел — по id и размеру стенда: запомнен (partOf и partKey), иначе каждая страница дерева и пересборка разделов
    // склада заново хешируют все id
    let partMemo = new Map(), partKeys = new Map(), partMemoLarge = null;
    const partReset = () => { if (partMemoLarge !== !!db.stand.large) { partMemo = new Map(); partKeys = new Map(); partMemoLarge = !!db.stand.large; } };
    const partOf = (id) => {
      partReset();
      let p = partMemo.get(id);
      if (p === undefined) partMemo.set(id, (p = hashOf(id) % partsCount()));
      return p;
    };
    const partKey = (id) => {
      partReset();
      let k = partKeys.get(id);
      if (k === undefined) partKeys.set(id, (k = `${String(partOf(id)).padStart(4, "0")}:${id}`));
      return k;
    };
    // Новые первыми, место не зависит от того, что появится потом: номер записи с конца списка
    const backRank = (list, rec) => String(9999999 - (list.length - 1 - list.indexOf(rec))).padStart(8, "0");
    const backTime = (at) => String(9e15 - Date.parse(at)).padStart(17, "0");
    // Поиск по складу проверяет сотни тысяч полей подряд: «ё» заменяется, только если она есть, а запрос нормализуется один раз
    const normText = (v) => { const t = String(v).toLowerCase(); return t.includes("ё") ? t.replace(/ё/g, "е") : t; };
    let needleOf = { q: null, n: "" };
    const needleFor = (q) => (needleOf.q === q ? needleOf.n : (needleOf = { q, n: normText(String(q).trim()) }).n);
    const textHit = (q, ...fields) => {
      const needle = needleFor(q);
      return fields.some((f) => f != null && normText(f).includes(needle));
    };
    const scopeOf = (name, q) => hashOf(name + JSON.stringify(Object.keys(q).filter((k) => k !== "limit" && k !== "cursor").sort().map((k) => [k, q[k]]))).toString(36);
    const cursorMake = (scope, at, exp) => btoa(encodeURIComponent(JSON.stringify({ s: scope, a: at, e: exp || now() + VIEW_ROUND_MS })));
    function cursorRead(q, scope) {
      if (q.cursor === undefined) return { at: null };
      let c = null;
      try { c = JSON.parse(decodeURIComponent(atob(q.cursor))); } catch (e) { c = null; }
      if (!c || c.s !== scope || !(now() <= c.e)) return { bad: problem(422, "INVALID_CURSOR", "Курсор просрочен или чужой: читайте с начала", { field: "cursor" }) };
      return { at: c.a, exp: c.e };
    }
    function limitOf(q) {
      if (q.limit === undefined) return 200;
      const n = Number(q.limit);
      return Number.isInteger(n) && n >= 1 && n <= db.reference.limits.pageMax ? n : null;
    }
    const limitBad = () => problem(422, "VALIDATION_FAILED", `limit — от 1 до ${db.reference.limits.pageMax}`, { field: "limit" });
    // Страница по ключу: курсор хранит ключ последней строки, вставка и снятие других строк страницы не сдвигают
    function pageList(q, name, rows, key, show, extra) {
      const limit = limitOf(q);
      if (limit === null) return limitBad();
      const scope = scopeOf(name, q), cur = cursorRead(q, scope);
      if (cur.bad) return cur.bad;
      // Нужны только limit первых ключей после курсора: отбор за один проход, без сортировки всех строк (на large у узла
      // тысячи детей, а страница — 200). top — отсортированные лучшие, не длиннее limit; rest — сколько строк после них
      const top = [];
      let after = 0;
      for (const r of rows) {
        const k = key(r);
        if (cur.at !== null && !(k > cur.at)) continue;
        if (top.length === limit && !(k < top[limit - 1][0])) { after++; continue; }
        let lo = 0, hi = top.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (!(k < top[mid][0])) lo = mid + 1; else hi = mid; }
        top.splice(lo, 0, [k, r]);
        if (top.length > limit) { top.pop(); after++; }
      }
      const chunk = top;
      const body = Object.assign({ items: chunk.map((x) => show(x[1])) }, extra || {});
      if (after > 0) body.nextCursor = cursorMake(scope, chunk[chunk.length - 1][0], cur.exp);
      return { status: 200, body };
    }
    /* ----- Камера-кластер, дочерние устройства ----- */

    // Камера-кластер: сама себе член домена, в виде нет ни сервера, ни родителя
    const isClusterCam = (d) => d.type === "camera" && !d.parentId && !d.serverId;
    // Дочерние записи устройств — индекс, который строится заново, когда меняется состав (viewStamp)
    let viewStamp = 0, viewMade = -1, viewKids = new Map();
    function viewIndex() {
      if (viewMade === viewStamp) return;
      viewMade = viewStamp;
      viewKids = new Map();
      db.devices.forEach((d) => {
        if (d.parentId) (viewKids.get(d.parentId) || viewKids.set(d.parentId, []).get(d.parentId)).push(d);
      });
    }
    const kidsOf = (id) => (viewIndex(), viewKids.get(id) || []);
    const recording = (d) => (!!d.archiveId && !!d.recordMode && d.recordMode !== "none") || (d.extraArchives || []).some((x) => x.recordMode && x.recordMode !== "none");
    /* ----- Дерево ----- */

    // Дерево — по складу: дети узла — из индексов (родитель, папка, ссылка на сервер), без прохода всех объектов.
    // Узел — объект склада: вид, значок и профили из описания вида, краткий объект (UnitBrief). Потоки камеры и документы
    // домена (shape: document) — не узлы
    const LAYOUTS = ["folders", "servers", "archives", "detectors"];
    const unallocOf = (id) => (String(id).startsWith("unalloc:") ? id.slice(8) : null);
    const SERVICE = new Set(["export", "email", "sms"]);
    const isArchive = (u) => tableOf(u.kind) === "archives";
    const inTree = (u) => u.kind !== "stream" && (kinds.get(u.kind) || {}).shape !== "document";
    const props = (u) => u.properties || {};
    const ofKind = (kind, domainId) => store.byKind(kind).filter((u) => u.domainId === domainId);
    const archivesOf = (pred) => kinds.list().filter((k) => tableOf(k.kind) === "archives").flatMap((k) => store.byKind(k.kind)).filter(pred);
    const isDetector = (u) => kinds.profileOf(u.kind, "vms.detector/1");
    // Сервер размещения объекта: status.observed.serverId или свойство вида с x-ref на сервер (имена — раз на описание)
    const toServer = (ref) => (ref.kinds || []).includes("server") || (ref.implements || []).includes("vms.server/1");
    const serverProps = new WeakMap();
    function serverNames(kind) {
      const k = kinds.get(kind);
      if (!k) return [];
      if (!serverProps.has(k)) {
        const p = (k.schema || {}).properties || {};
        serverProps.set(k, Object.keys(p).filter((n) => p[n] && p[n]["x-ref"] && toServer(p[n]["x-ref"])));
      }
      return serverProps.get(k);
    }
    function serverOfUnit(u) {
      const o = u.status && u.status.observed && u.status.observed.serverId;
      if (typeof o === "string") return o;
      const n = serverNames(u.kind).find((x) => typeof props(u)[x] === "string");
      return n ? props(u)[n] : null;
    }
    function unitBrief(u) {
      const out = { uid: u.uid, kind: u.kind, name: u.name, parentId: u.parentId == null ? null : u.parentId, domainId: u.domainId == null ? null : u.domainId, version: u.version };
      if (u.status && u.status.link) out.status = { link: u.status.link };
      if (typeof props(u).subtype === "string" && props(u).subtype) out.subtype = props(u).subtype; // как DeviceRow.subtype
      const brief = {};
      (kinds.get(u.kind) ? kinds.briefNames(u.kind) : []).forEach((n) => n in props(u) && (brief[n] = clone(props(u)[n])));
      // Строке дерева без строки устройства: выключенность и сервер — свойства вида (если они в схеме), сбой и лицензия — наблюдаемое
      const own = (((kinds.get(u.kind) || {}).schema || {}).properties) || {};
      if ("enabled" in own) brief.enabled = props(u).enabled !== false;
      if ("serverId" in own && typeof props(u).serverId === "string") brief.serverId = props(u).serverId;
      if (Object.keys(brief).length) out.brief = brief;
      const obs = (u.status && u.status.observed) || {}, seen = {};
      if (typeof obs.fault === "string" && obs.fault) seen.fault = obs.fault;
      if (obs.licenseExceeded) seen.licenseExceeded = true;
      if (Object.keys(seen).length) out.status = Object.assign(out.status || {}, { observed: seen });
      return out;
    }
    const treeChildrenOf = (u) => store.byParent(u.uid).filter(inTree);
    function unitHasChildren(u) {
      if (u.kind === "domain") return true;
      if (u.kind === "folder") return store.byFolder(u.uid).length > 0 || store.byParent(u.uid).some((x) => x.kind === "folder");
      if (isArchive(u)) return store.byParent(u.uid).some((x) => x.kind === "volume");
      // Устройство: дочерние записи устройства; камера-кластер — «может быть» (дети приходят от её серверов)
      if (tableOf(u.kind) === "devices" && (isClusterCam(legacy.view(u)) || kidsOf(u.uid).length > 0)) return true;
      return treeChildrenOf(u).length > 0;
    }
    function unitNode(u, parentId, hasChildren) {
      const k = kinds.get(u.kind);
      const node = { id: u.uid, kind: u.kind, name: u.name, parentId, hasChildren: hasChildren === undefined ? unitHasChildren(u) : hasChildren };
      if (k && k.icon) node.icon = k.icon;
      node.implements = k ? (k.implements || []).slice() : [];
      node.unit = unitBrief(u);
      return node;
    }
    // Узел позже: строка устройства считается только для страницы, которую отдают
    const lazy = (u, parentId, hasChildren) => () => unitNode(u, parentId, hasChildren);
    const camHasDets = (u) => store.byParent(u.uid).some(isDetector);
    // Дети узла: [ключ порядка, узел]. Ключ решает порядок: на верхнем уровне и в папках — разделы, в члене — имя
    function treeKids(layout, parentId) {
      const k = (group, id) => `${group}:${partKey(id)}`;
      const name = (group, u) => `${group}:${u.name} ${u.uid}`;
      if (!parentId) return store.byKind("domain").map((d) => [k(1, d.uid), unitNode(d, null, true)]);
      const un = unallocOf(parentId);
      if (un) return ofKind("server", un).filter((s) => !props(s).allocated).map((s) => [k(1, s.uid), unitNode(s, parentId, false)]);
      const u = store.get(parentId);
      if (!u) return null;
      if (u.kind === "domain") {
        if (layout === "folders") return ofKind("folder", u.uid).filter((f) => !f.parentId).map((f) => [k(1, f.uid), unitNode(f, parentId)]);
        const servers = ofKind("server", u.uid);
        const out = servers.filter((s) => props(s).allocated).map((s) => [k(1, s.uid), unitNode(s, parentId, true)]);
        if (layout === "servers" && servers.some((s) => !props(s).allocated)) out.push(["2", { id: `unalloc:${u.uid}`, kind: "unalloc", name: "Нераспределённые серверы", parentId, hasChildren: true }]);
        if (layout === "archives") archivesOf((a) => !a.parentId && a.domainId === u.uid).forEach((a) => out.push([k(3, a.uid), unitNode(a, parentId)]));
        // Корни домена без сервера размещения: камеры-кластеры, регистраторы, СКУД, объекты незнакомых видов. Детекторы
        // камеры-кластера видны только при её раскрытии: сводного списка в detectors у них нет
        if (layout === "servers")
          store.byParent(null, u.uid).forEach((x) => {
            if (!inTree(x) || ["server", "folder", "domain", "volume"].includes(x.kind) || isArchive(x) || SERVICE.has(x.kind) || serverOfUnit(x)) return;
            out.push([k(4, x.uid), lazy(x, parentId)]);
          });
        return out;
      }
      if (u.kind === "server") {
        if (layout === "archives") return store.byParent(u.uid).filter(isArchive).map((a) => [name(1, a), unitNode(a, parentId)]);
        const placed = store.byRef(u.uid).filter((x) => !x.parentId && inTree(x) && serverOfUnit(x) === u.uid);
        return (layout === "detectors" ? placed.filter(camHasDets) : placed).map((x) => [name(1, x), lazy(x, parentId)]);
      }
      if (u.kind === "folder") {
        const subs = store.byParent(u.uid).filter((f) => f.kind === "folder").map((f) => [k(1, f.uid), unitNode(f, parentId)]);
        const members = store.byFolder(u.uid).filter(inTree);
        return subs.concat((layout === "detectors" ? members.filter((x) => kinds.profileOf(x.kind, "vms.camera/1")) : members).map((x) => [k(2, x.uid), lazy(x, parentId)]));
      }
      if (isArchive(u)) return store.byParent(u.uid).filter((v) => v.kind === "volume").map((v) => [name(1, v), unitNode(v, parentId, false)]);
      if (u.kind === "volume") return [];
      const kids = treeChildrenOf(u);
      return (layout === "detectors" ? kids.filter(isDetector) : kids).map((x) => [name(1, x), lazy(x, parentId)]);
    }
    function treeChildren(q) {
      if (!LAYOUTS.includes(q.layout)) return problem(422, "VALIDATION_FAILED", "Нет такой раскладки", { field: "layout" });
      const rows = treeKids(q.layout, q.parentId);
      if (!rows) return notFound("Узел");
      return pageList(q, "tree", rows, (x) => x[0], (x) => (typeof x[1] === "function" ? x[1]() : x[1]), q.parentId ? { parentCount: rows.length } : {});
    }
    // Хранилища, в которые пишет объект: кандидаты — его ссылки (индекс), запись — как у старых путей (archiveWrites)
    const writesInto = (u, archiveId) =>
      tableOf(u.kind) === "devices" ? archiveWrites(legacy.view(u), archiveId) : kinds.refsOf(u).some((r) => r.uid === archiveId);
    // Цепочки от корня: шаг — {id, kind, name}, kind — вид объекта (TreePathStep.kind — код вида, как TreeNode.kind). Путь —
    // по parentId до корня, у корня без родителя — его домен; таблицы старых видов не участвуют, так что путь есть у любого
    // вида склада. Объект вне ветки домена (камера, контроллер — корень домена) кладётся по раскладке: в папках — под каждой
    // своей папкой (Unit.folders), в хранилищах — под хранилищами, куда пишет, в серверах — под сервером записи
    function treeChains(layout, id) {
      const step = (x) => ({ id: x.uid, kind: x.kind, name: x.name });
      const domainStep = (domainId) => {
        const d = domainId && store.get(domainId);
        return d && kinds.profileOf(d.kind, "vms.domain/1") ? [step(d)] : [];
      };
      // Цепочка объекта по parentId: от корня (домен — сам; корень без родителя — с доменом впереди) до объекта
      const upChain = (x) => {
        const line = [];
        const seen = new Set();
        let top = x;
        for (;;) {
          line.unshift(step(top));
          seen.add(top.uid);
          const par = top.parentId ? store.get(top.parentId) : null;
          if (!par || seen.has(par.uid)) break;
          top = par;
        }
        const rooted = !!kinds.profileOf(top.kind, "vms.domain/1");
        return { line, top, rooted };
      };
      const chainOf = (x) => {
        const c = upChain(x);
        return c.rooted ? c.line : domainStep(c.top.domainId).concat(c.line);
      };
      const u = store.get(id);
      if (!u) return [];
      const { line, top, rooted } = upChain(u);
      // Ветка домена (серверы, хранилища, тома) и сами папки — путь по parentId при любой раскладке
      if (rooted || kinds.profileOf(top.kind, "vms.folder/1") || tableOf(top.kind) === "servers" || isArchive(top)) return [rooted ? line : domainStep(top.domainId).concat(line)];
      const plain = [domainStep(top.domainId).concat(line)];
      if (layout === "folders") {
        const homes = foldersOf(top.uid).map((x) => store.get(x)).filter(Boolean);
        return homes.length ? homes.map((h) => chainOf(h).concat(line)) : plain;
      }
      if (layout === "archives") {
        const order = (a) => db.archives.indexOf(legacy.view(a));
        const rows = [...new Set(kinds.refsOf(top).map((r) => r.uid))].map((x) => store.get(x)).filter((a) => a && isArchive(a) && writesInto(top, a.uid)).sort((a, b) => order(a) - order(b));
        return rows.length ? rows.map((a) => chainOf(a).concat(line)) : plain;
      }
      const srv = serverOfUnit(top) && store.get(serverOfUnit(top));
      return srv ? [chainOf(srv).concat(line)] : plain;
    }
    function treePaths(q) {
      if (!LAYOUTS.includes(q.layout)) return problem(422, "VALIDATION_FAILED", "Нет такой раскладки", { field: "layout" });
      const ids = String(q.ids || "").split(",").filter(Boolean);
      if (ids.length > db.reference.limits.idsMax) return problem(422, "VALIDATION_FAILED", "Больше, чем idsMax", { field: "ids" });
      return { status: 200, body: { items: ids.map((id) => ({ id, chains: treeChains(q.layout, id) })).filter((x) => x.chains.length) } };
    }

    /* ----- Ядро: виды и объекты склада ----- */

    // Описания видов: ETag — хэш описаний; тот же ETag в If-None-Match — 304 без тела
    function kindsList(headers) {
      const tag = kinds.etag();
      if (parseMatch(headers["if-none-match"]) === parseMatch(tag)) return { status: 304, body: null, headers: { ETag: tag } };
      return { status: 200, body: { items: clone(kinds.list()), profiles: clone(kinds.profiles()) }, headers: { ETag: tag } };
    }
    // Секреты старых путей сервер держит отдельно (secrets): пароль устройства и тома, секрет облачного тома
    const keptSecrets = (u) => {
      const t = tableOf(u.kind);
      if (t !== "devices" && t !== "volumes") return [];
      return [secrets.has(u.uid) && "password", t === "volumes" && secrets.has(u.uid + ":secret") && "secret"].filter(Boolean);
    };
    // Наследуемое свойство (x-inherit): своё значение объекта, иначе — из документа домена (вид с shape: document, в нём раздел
    // с кодом вида объекта), иначе — умолчание схемы. Документ домена ищется по виду документа: их мало, домен целиком не проходится
    function inheritedOf(u, shown) {
      const names = kinds.inheritNames(u.kind);
      if (!names.length) return null;
      const docs = kinds.documentKinds().flatMap((k) => store.byKind(k)).filter((d) => d.domainId === u.domainId);
      const p = (kinds.get(u.kind).schema || {}).properties || {};
      const out = {};
      names.forEach((name) => {
        if (name in props(u)) return (out[name] = { from: "unit" });
        const doc = docs.find((d) => props(d)[u.kind] && typeof props(d)[u.kind] === "object" && name in props(d)[u.kind]);
        if (doc) {
          shown[name] = clone(props(doc)[u.kind][name]);
          out[name] = { from: "domain", uid: doc.uid, version: doc.version };
        } else if ("default" in p[name]) {
          shown[name] = clone(p[name].default);
          out[name] = { from: "default" };
        }
      });
      return out;
    }
    // Объект в ответе: значений секретов (writeOnly) нет — только secrets[имя] = true. Вид без описания — свойства как есть.
    // Наследуемые свойства (x-inherit) — со значением, откуда оно, — в inherited
    function unitView(u, extra) {
      const hide = new Set(kinds.get(u.kind) ? kinds.secretNames(u.kind) : []);
      const out = { uid: u.uid, kind: u.kind, parentId: u.parentId == null ? null : u.parentId, name: u.name, domainId: u.domainId == null ? null : u.domainId };
      if (u.folders && u.folders.length) out.folders = u.folders.slice();
      out.version = u.version;
      const shown = {}, set = Object.assign({}, u.secrets || {});
      Object.keys(props(u)).forEach((key) => {
        const v = props(u)[key];
        if (!hide.has(key)) shown[key] = clone(v);
        else if (v != null && v !== "") set[key] = true;
      });
      keptSecrets(u).forEach((n) => (set[n] = true));
      const inherited = kinds.get(u.kind) ? inheritedOf(u, shown) : null;
      out.properties = shown;
      if (Object.keys(set).length) out.secrets = set;
      if (inherited && Object.keys(inherited).length) out.inherited = inherited;
      // Что правится у объекта сейчас (уже, чем схема вида): карта камеры w2c, обычное встроенное хранилище, камера w2c
      if (Array.isArray(u.writable)) out.writable = u.writable.slice();
      if (u.status && Object.keys(u.status).length) out.status = clone(u.status);
      out.hasChildren = unitHasChildren(u); // как в дереве: потоки и документы дочерними не считаются
      // Вычисляемое профилем (status.observed): итог круга домена, держатель тома
      hooksOf(u.kind).forEach((h) => h.view && h.view(out, pctx));
      return Object.assign(out, extra || {});
    }
    // Поиск q: имя, short (если оно есть у вида), uid, свойства с x-search; fields — где искать. Ответ — где нашлось
    // Где нашлось q: имя, short, свойства x-search, uid. uid — только целиком: часть uid (цифра «1») есть почти у каждого
    // объекта, а /devices?q= базы по id не искал. Так q без fields находит то же, что база (имя, номер, адрес, производитель, модель)
    // Поля поиска вида: запомнены по описанию вида (новое описание — новый объект, kinds.put), иначе собираются на каждый объект
    const searchNamesMemo = new WeakMap();
    function searchNamesOf(k) {
      let n = searchNamesMemo.get(k);
      if (!n) searchNamesMemo.set(k, (n = ["name"].concat("short" in ((k.schema || {}).properties || {}) ? ["short"] : [], kinds.searchNames(k.kind).filter((x) => x !== "short"), ["uid"])));
      return n;
    }
    function matchOf(u, text, fields) {
      const k = kinds.get(u.kind);
      const names = k ? searchNamesOf(k) : ["name"].concat((k ? "short" in ((k.schema || {}).properties || {}) : "short" in props(u)) ? ["short"] : [], k ? kinds.searchNames(u.kind).filter((n) => n !== "short") : [], ["uid"]);
      const value = (f) => (f === "name" ? u.name : f === "uid" ? u.uid : props(u)[f]);
      const hit = (f) => (f === "uid" ? String(text).trim().toLowerCase() === u.uid.toLowerCase() : textHit(text, Array.isArray(value(f)) ? value(f).join(" ") : value(f)));
      return names.find((f) => (!fields || fields.includes(f)) && hit(f)) || null;
    }
    // noDetector — флаг или код вида детектора: перечень свойства detectorKind видов профиля vms.detector/1
    const detectorCodes = () => new Set(kinds.list().filter((k) => kinds.profileOf(k.kind, "vms.detector/1")).flatMap((k) => ((((k.schema || {}).properties || {}).detectorKind || {}).enum || [])));
    const flagBad = (q) => ["noFolder", "noRecord", "noDetector"].find((n) => q[n] !== undefined && q[n] !== "true" && q[n] !== "false" && !(n === "noDetector" && detectorCodes().has(q[n])));
    const isCamera = (u) => kinds.profileOf(u.kind, "vms.camera/1");
    // Детекторы камеры — дочерние и серверные (ссылка x-ref на камеру); code — только этого вида
    const hasDetector = (u, code) => store.byParent(u.uid).concat(store.byRef(u.uid)).some((d) => isDetector(d) && (!code || props(d).detectorKind === code));
    function unitStatusHit(u, words) {
      const link = (u.status && u.status.link) || "unknown", obs = (u.status && u.status.observed) || {};
      const on = props(u).enabled !== false, lic = !!obs.licenseExceeded, sig = link !== "offline";
      return words.some((w) => (w === link ? true : w === "off" ? !on : w === "license" ? on && lic : w === "nosignal" ? on && !lic && !sig : w === "run" ? on && !lic && sig : false));
    }
    // Отбор строки: false — мимо, true — подходит, {field} — подходит по q
    function unitFilter(q) {
      const list = (v) => String(v).split(",").filter(Boolean);
      const kindSet = q.kind ? new Set(list(q.kind)) : null;
      const implSet = q.implements ? new Set(list(q.implements).flatMap((p) => kinds.implementers(p))) : null;
      const words = q.status ? list(q.status) : null;
      const fields = q.fields ? list(q.fields) : null;
      const noFolder = q.noFolder === "true", noRecord = q.noRecord === "true";
      const noDet = q.noDetector === "true" || (q.noDetector !== undefined && q.noDetector !== "false"), detCode = noDet && q.noDetector !== "true" ? q.noDetector : null;
      const hidden = hiddenServers();
      // Объекты без права view отсеяны дверью (стенд: stand.hiddenIds): страница короче limit и бывает пустой при живом nextCursor
      const noView = new Set(db.stand.hiddenIds || []);
      const folderFree = (u) => !u.parentId && !(u.folders || []).length &&
        (tableOf(u.kind) === "devices" ? folderable(legacy.view(u)) : ((kinds.get(u.kind) || {}).capabilities || []).includes("folders"));
      const filtered = !!(q.q || kindSet || implSet || words || q.domainId || noFolder || noRecord || noDet);
      const hit = (u) => {
        if ((kindSet && !kindSet.has(u.kind)) || (implSet && !implSet.has(u.kind)) || (q.domainId && u.domainId !== q.domainId)) return false;
        if ((words && !unitStatusHit(u, words)) || (noFolder && !folderFree(u)) || (noRecord && !(isCamera(u) && !recording(props(u)))) || (noDet && !(isCamera(u) && !hasDetector(u, detCode)))) return false;
        // Без связи с доменом сервер входа видит только свой кластер: чужие серверы и то, что на них, не показываются
        if (hidden.size && (hidden.has(u.uid) || hidden.has(serverOfUnit(u)))) return false;
        if (noView.has(u.uid)) return false;
        if (!q.q) return true;
        const field = matchOf(u, q.q, fields);
        return field ? { field } : false;
      };
      return { hit, filtered };
    }
    // Разделы склада для прохода без члена: порядок — байты uid, не сдвигается вставкой. Разделы держат uid, а не объекты:
    // замена объекта (смена статуса, правка) их не трогает. Собираются один раз на склад, дальше ведутся по месту — склад
    // сообщает, что uid пришёл или ушёл (onMembers). На xl это миллион uid: пересборка на каждую запись — 0,2–0,4 с
    let unitParts = null, unitPartsOf = null, partsWarm = null;
    function partsPlace(parts, uid, added) {
      const list = parts[partOf(uid)];
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < uid) lo = mid + 1; else hi = mid; }
      const has = list[lo] === uid;
      if (added && !has) list.splice(lo, 0, uid);
      else if (!added && has) list.splice(lo, 1);
    }
    function partsMember(uid, added) {
      if (uid === null) { unitParts = null; partsWarm = null; return; }
      if (partsWarm) partsWarm.pending.push([uid, added]);
      else if (unitParts) partsPlace(unitParts, uid, added);
    }
    // Сборка по шагам: раскладка uid по разделам, затем сортировка разделов, затем то, что пришло и ушло за время сборки.
    // step(deadline) — до срока, true — готово. Раздел — через partOf: хеши запоминаются в простое и нужны и дереву (partKey
    // у детей домена на xl — сотни тысяч строк)
    function partsBuild() {
      const n = partsCount(), parts = Array.from({ length: n }, () => []), it = store.all();
      let sorted = 0, filled = false;
      const w = {
        store, parts, pending: [],
        step(deadline) {
          let i = 0;
          while (!filled) {
            const x = it.next();
            if (x.done) { filled = true; break; }
            parts[partOf(x.value.uid)].push(x.value.uid);
            if (++i % 4096 === 0 && workNow() > deadline) return false;
          }
          while (sorted < n) {
            parts[sorted++].sort();
            if (sorted % 64 === 0 && workNow() > deadline) return false;
          }
          w.pending.forEach(([uid, added]) => partsPlace(parts, uid, added));
          w.pending = [];
          return true;
        },
      };
      return w;
    }
    function partsDone(w) {
      unitParts = w.parts;
      unitPartsOf = w.store;
      if (partsWarm === w) partsWarm = null;
    }
    // Большой стенд: разделы собираются заранее, в простое страницы кусками по 30 мс, а не первым запросом прохода. Запрос
    // до конца сборки доделывает её сам
    function unitPartsWarm() {
      if (!db.stand.large || typeof setTimeout !== "function") return;
      const w = (partsWarm = partsBuild());
      const tick = () => {
        if (partsWarm !== w || w.store !== store) return;
        if (w.step(workNow() + 30)) partsDone(w);
        else setTimeout(tick, 0);
      };
      setTimeout(tick, 0);
    }
    function unitPartsList() {
      if (unitParts && unitPartsOf === store && unitParts.length === partsCount()) return unitParts;
      const w = partsWarm && partsWarm.store === store ? partsWarm : (partsWarm = partsBuild());
      w.step(Infinity);
      partsDone(w);
      return unitParts;
    }
    // Порядок перечня по профилю: домены и серверы — как /domains и /servers базы (порядок таблицы: заведённый и принятый
    // в домен сервер — последним), сначала домены, потом серверы; остальное — по разделам (partKey), как /folders, /archives,
    // /volumes базы. Номер в таблице — с запасом под курсор, ключ — строка
    const rankOf = new Map();
    function tableRank(u) {
      const t = tableOf(u.kind);
      if (t !== "domains" && t !== "servers") return `2:${partKey(u.uid)}`;
      // Номера таблицы — заново, когда таблица сменилась (приём сервера пересобирает db.servers) или выросла
      let r = rankOf.get(t);
      if (!r || r.list !== db[t] || r.n !== db[t].length) rankOf.set(t, (r = { list: db[t], n: db[t].length, at: new Map(db[t].map((x, i) => [x.id, i])) }));
      const at = r.at.has(u.uid) ? r.at.get(u.uid) : -1;
      return `${t === "domains" ? 0 : 1}:${String(at < 0 ? 99999999 : at).padStart(8, "0")}:${u.uid}`;
    }
    // GET /units: ids — по записи; parentId, folderId, ref, serverId, archiveId — один член из индекса склада, порядок по
    // имени; остальное — разделы склада, с отбором — ограниченный проход: не меньше scanPartsMax разделов, дальше страница
    // дописывается до limit или до бюджета времени SCAN_BUDGET_MS
    function unitsPage(q) {
      const limit = limitOf(q);
      if (limit === null) return limitBad();
      const flag = flagBad(q);
      if (flag) return problem(422, "VALIDATION_FAILED", flag === "noDetector" ? "noDetector — true, false или код вида детектора" : `${flag} — true или false`, { field: flag });
      if (q.ids !== undefined) {
        const ids = String(q.ids).split(",").filter(Boolean);
        if (ids.length > db.reference.limits.idsMax) return problem(422, "VALIDATION_FAILED", "Больше, чем idsMax", { field: "ids" });
        return { status: 200, body: { items: ids.map((id) => store.get(id)).filter(Boolean).map((u) => unitView(u)) } };
      }
      const { hit, filtered } = unitFilter(q);
      const show = ([u, m]) => unitView(u, m === true ? null : { match: m });
      const MEMBER = {
        parentId: [(v) => store.byParent(v), (u, v) => u.parentId === v],
        folderId: [(v) => store.byFolder(v), (u, v) => (u.folders || []).includes(v)],
        ref: [(v) => store.byRef(v), (u, v) => kinds.refsOf(u).some((r) => r.uid === v)],
        serverId: [(v) => store.byRef(v).filter((u) => serverOfUnit(u) === v), (u, v) => serverOfUnit(u) === v],
        archiveId: [(v) => store.byRef(v).filter((u) => writesInto(u, v)), (u, v) => writesInto(u, v)],
      };
      const members = Object.keys(MEMBER).filter((n) => q[n] !== undefined);
      if (members.length) {
        const [first, ...rest] = members;
        const rows = MEMBER[first][0](q[first]).filter((u) => rest.every((n) => MEMBER[n][1](u, q[n]))).map((u) => [u, hit(u)]).filter((x) => x[1]);
        return pageList(q, "units", rows, ([u]) => `${u.name} ${u.uid}`, show);
      }
      // Только implements (можно с domainId): строки из индекса вида, порядок тот же (раздел, uid), страницы полные. Это чтение
      // по профилю вместо таблиц базы (/domains, /servers, /folders, /archives, /volumes), у которых первая страница полная.
      // kind= — отбор, как /devices?type= базы: ограниченный проход ниже. Иначе первая страница kind= несёт больше строк, чем
      // в базе, и кэш формы (выбор цели правила читает одну страницу по виду) расходится с базой — с ним и дерево
      if (q.implements && !q.kind && !(q.q || q.status || q.noFolder === "true" || q.noRecord === "true" || (q.noDetector !== undefined && q.noDetector !== "false"))) {
        const ks = String(q.implements).split(",").filter(Boolean).flatMap((pr) => kinds.implementers(pr));
        const rows = [...new Set(ks)].flatMap((k) => store.byKind(k)).map((u) => [u, hit(u)]).filter((x) => x[1]);
        return pageList(q, "units-kind", rows, ([u]) => tableRank(u), show);
      }
      // kind= вместе с domainId (и без других отборов): объекты названных видов одного домена — из индекса вида, в порядке
      // разделов (partKey), страницы полные. Нужно узким чтениям по виду в домене (держатель удержаний читает два-три вида
      // хранилищ вместо всех хранилищ домена). kind= без domainId — по-прежнему ограниченный проход, как type у /devices
      if (q.kind && q.domainId && !q.implements && !(q.q || q.status || q.noFolder === "true" || q.noRecord === "true" || (q.noDetector !== undefined && q.noDetector !== "false"))) {
        const ks = [...new Set(String(q.kind).split(",").filter(Boolean))];
        const rows = ks.flatMap((k) => store.byKind(k)).map((u) => [u, hit(u)]).filter((x) => x[1]);
        return pageList(q, "units-kind", rows, ([u]) => tableRank(u), show);
      }
      const scope = scopeOf("units", q), cur = cursorRead(q, scope);
      if (cur.bad) return cur.bad;
      const parts = unitPartsList();
      const at = cur.at || { p: 0, a: null };
      // С отбором: не меньше scanPartsMax разделов (и хотя бы один — проход всегда движется), дальше — до limit или до
      // бюджета времени. stand.sparsePages — бэкенд, который страницу не дописывает: ровно scanPartsMax разделов, пустая
      // страница с nextCursor (её клиент обязан выдерживать — tests/api-pages.js)
      const minParts = filtered ? Math.max(1, db.reference.limits.scanPartsMax) : Infinity;
      const until = filtered && !db.stand.sparsePages ? workNow() + SCAN_BUDGET_MS : null;
      const more = () => seen < minParts || (until !== null && workNow() < until);
      const out = [];
      let p = at.p, after = at.a, seen = 0, stopped = null;
      for (; p < parts.length && !stopped && more(); ) {
        const list = parts[p];
        for (let i = 0; i < list.length; i++) {
          if (after !== null && list[i] <= after) continue;
          const u = store.get(list[i]);
          if (!u) continue;
          const m = hit(u);
          if (!m) continue;
          out.push([u, m]);
          if (out.length === limit) {
            stopped = { p, a: u.uid };
            break;
          }
        }
        if (!stopped) {
          p++;
          seen++;
          after = null;
        }
      }
      const body = { items: out.map(show) };
      if (stopped) {
        // Есть ли что дальше — смотрим остаток, пока не вышел бюджет. Не успели — курсор: пустая следующая страница законна
        let left = false;
        for (let i = stopped.p; i < parts.length && !left; i++) {
          if (until !== null && i > stopped.p && workNow() >= until) {
            left = true;
            break;
          }
          left = parts[i].some((uid) => { if (!(i > stopped.p || uid > stopped.a)) return false; const u = store.get(uid); return !!u && !!hit(u); });
        }
        if (left) body.nextCursor = cursorMake(scope, stopped, cur.exp);
      } else if (p < parts.length) body.nextCursor = cursorMake(scope, { p, a: null }, cur.exp);
      if (!filtered) body.total = store.size();
      return { status: 200, body };
    }
    // Что можно создать под объектом: виды, у которых его вид — в createParents. Вид устройства, которого система не
    // объявила, — нет; единица СКУД под родителем с dynamicCreate — если её называют шаблоны единиц родителя (unitOptions)
    function creatableOf(u) {
      const parent = tableOf(u.kind) === "devices" ? legacy.view(u) : null;
      const options = parent && (kinds.get(u.kind) || {}).dynamicCreate ? hAcs.unitOptionsFor(parent, pctx) : null;
      return kinds.creatable(u.kind).map((kind) => {
        const no = (reason) => ({ kind, allowed: false, reason });
        if (options && unitType(kind) && !options.some((o) => o.type === kind)) return no("NOT_SUPPORTED");
        return { kind, allowed: true };
      });
    }
    /* ----- Ядро: запись объектов ----- */

    /* Пути ядра пишут объект по описанию его вида: схема (readOnly, writeOnly, x-immutable, x-bound-to, x-unique), родители
       (parents, createParents), capabilities, actions, events. Смысл сверх описания — у хуков профилей (profiles.js): домен,
       сервер, папка, хранилище, том (vms.domain/1, vms.server/1, vms.folder/1, vms.archive/1, vms.volume/1), устройства — общие
       хуки DEVICE и профили vms.camera/1, vms.stream/1, vms.detector/1, vms.acs/1. Пишутся виды с описанием, у которых каждый
       профиль vms.* сервер знает (хук есть). Остальным — 422 NOT_SUPPORTED, field /kind. Объект вида без описания читается, но не пишется. Ошибки — {code, field, params}: field — JSON Pointer в теле
       запроса (у строки POST /units — в строке); ошибку хука (field старого пути) переводит pointerOf.
       Секреты (writeOnly) хранятся отдельно от объекта, как пароли старых путей (secrets): в объекте — только secrets[имя]. */
    const coreKind = (kind) => {
      const k = kinds.get(kind);
      if (!k) return false;
      return (k.implements || []).filter((p) => String(p).startsWith("vms.")).every((p) => !!HOOKS[p]);
    };
    // Правка только папок (Unit.folders): у устройства её пишет ядро уже сейчас — членство ведёт профиль папки
    const foldersOnly = (patch) => !!patch && patch.folders !== undefined && Object.keys(patch).every((k) => k === "folders");
    const membersOnly = (u, patch) => tableOf(u.kind) === "devices" && !!kinds.get(u.kind) && foldersOnly(patch);
    const capOf = (kind, cap) => ((kinds.get(kind) || {}).capabilities || []).includes(cap);
    const esc = (name) => String(name).replace(/~/g, "~0").replace(/\//g, "~1");
    const err = (code, field, params) => Object.assign({ code }, field !== undefined ? { field } : {}, params ? { params } : {});
    const errOut = (e) => Object.assign({ code: e.code }, e.field !== undefined ? { field: e.field } : {}, e.params ? { params: clone(e.params) } : {});
    // Первая ошибка — в code/field/params, все — в errors. Статус — заданный, у ошибки хука — её (409 NAME_TAKEN…), иначе 422
    function errsProblem(errs, message, status) {
      const [first] = errs;
      return problem(status || first.status || 422, first.code, message, Object.assign(first.field !== undefined ? { field: first.field } : {}, first.params ? { params: clone(first.params) } : {}, { errors: errs.map(errOut) }));
    }
    const kindErrs = (kind, at) => (coreKind(kind) ? [] : [err("NOT_SUPPORTED", `${at || ""}/kind`, { kind })]);
    // Поле ошибки хука (имя поля старого пути) → указатель в теле запроса ядра: свойства — /properties/…, параметры команды
    // и переноса — base /params/
    const POINTER = { name: "/name", parentId: "/parentId", serverId: "/parentId", archiveId: "/parentId", domainId: "/domainId", kind: "/kind", folders: "/folders", moveTo: "/moveTo" };
    // У устройства serverId, archiveId — свойства (сервер записи, хранилище), а не родитель; папка старого пути — folderId
    const DEVICE_POINTER = { name: "/name", parentId: "/parentId", domainId: "/domainId", kind: "/kind", type: "/kind", folders: "/folders", folderId: "/folders", children: "/children" };
    const pointerOf = (field, base, kind) => (field == null ? undefined : String(field).startsWith("/") ? field : (kind && tableOf(kind) === "devices" ? DEVICE_POINTER : POINTER)[field] || `${base || "/properties/"}${esc(field)}`);
    // Отказ хука (Problem) → ошибка строки {code, field, params}; at — указатель строки, kind — вид объекта
    const hookErr = (res, at, base, kind) => Object.assign(err(res.body.code, `${at || ""}${pointerOf(res.body.field, base, kind) || ""}` || undefined, res.body.params), { status: res.status });
    // Отказ хука → ответ ядра: тот же статус и код, field — указателем
    function hookProblem(res, base, kind) {
      const field = pointerOf(res.body.field, base, kind);
      return { status: res.status, body: Object.assign({}, res.body, field !== undefined ? { field } : {}) };
    }
    // Хуки вида по очереди: первый отказ
    function hooksProblem(kind, name, args) {
      for (const h of hooksOf(kind)) {
        const bad = h[name] ? h[name](...args, pctx) : null;
        if (bad) return bad;
      }
      return null;
    }
    // Объект на склад: у видов старых таблиц — и в таблицу (запись-представление), как legacy.add
    function unitPut(u) {
      store.put(u);
      legacy.attach(u);
      return tableOf(u.kind) ? legacy.view(u) : u;
    }
    // Сервер-исполнитель изменения объекта (хук профиля executor): запись сервера или null
    function executorOf(u) {
      const h = u ? hookOf(u.kind, "executor") : null;
      const id = h ? h.executor(u, pctx) : null;
      return id ? byId("servers", id) : null;
    }
    const kindProblem = (kind) => {
      const e = kindErrs(kind);
      return e.length ? errsProblem(e, kinds.get(kind) ? `Вид ${kind} путями ядра пока не пишется: его смысл — у своих путей` : `Описания вида ${kind} нет: объект только читается`) : null;
    };
    const isDocument = (kind) => (kinds.get(kind) || {}).shape === "document";
    // Ключ секрета — как у старых путей: пароль — uid, секрет облачного тома — uid:secret, прочие — uid#имя
    const secretKey = (uid, name) => (name === "password" ? uid : name === "secret" ? `${uid}:secret` : `${uid}#${name}`);
    const secretOfUnit = (uid, key) => key === uid || key.startsWith(`${uid}:`) || key.startsWith(`${uid}#`);
    // Объект с потомками по parentId: сначала он, потом дети
    function unitSubtree(u) {
      const out = [u];
      for (let i = 0; i < out.length; i++) store.byParent(out[i].uid).forEach((c) => out.push(c));
      return out;
    }
    // Ветка изменилась: tree.changed — как у устройств (treeTouch)
    function unitTreeTouch(u) {
      const add = (layout, id) => id && (treePending[layout] = treePending[layout] || new Set()).add(id);
      add("servers", u.parentId || u.domainId);
      (u.folders || []).forEach((f) => add("folders", f));
    }
    // Версия из If-Match: нет — 428, не та — 412 с объектом, над объектом идёт операция — 409 BUSY
    function unitPrecondition(u, headers) {
      const v = parseMatch(headers["if-match"]);
      if (v == null || v === "") return problem(428, "PRECONDITION_REQUIRED", "Нужен заголовок If-Match с версией объекта");
      if (v !== u.version) return problem(412, "VERSION_MISMATCH", "Объект изменился с момента чтения", { current: unitView(u) });
      return lockedProblem([u.uid]);
    }
    // x-unique: у строк с хозяином (вид без корня в parents) — среди строк того же хозяина, у остальных — среди объектов вида
    // rows — уже проверенные соседние строки того же нового родителя (UnitCreate.children): их ещё нет на складе
    function uniqueErrs(kind, parentId, values, selfUid, at, rows) {
      const names = kinds.uniqueNames(kind).filter((n) => values[n] !== undefined && values[n] !== null);
      if (!names.length) return [];
      const owned = !((kinds.get(kind) || {}).parents || []).includes(null);
      const peers = (owned ? (parentId ? store.byParent(parentId) : []) : store.byKind(kind)).filter((x) => x.kind === kind && x.uid !== selfUid).concat((rows || []).filter((x) => x.kind === kind));
      return names.filter((n) => peers.some((x) => JSON.stringify(props(x)[n]) === JSON.stringify(values[n]))).map((n) => err("VALIDATION_FAILED", `${at || ""}/properties/${esc(n)}`, { keyword: "x-unique" }));
    }
    // Папки объекта: вид с возможностью folders, папки — того же домена
    function foldersErrs(kind, domainId, folders, at) {
      if (!folders || !folders.length) return [];
      if (!capOf(kind, "folders")) return [err("NOT_SUPPORTED", `${at}/folders`, { capability: "folders" })];
      const bad = folders.findIndex((f) => {
        const x = store.get(f);
        return !x || x.kind !== "folder" || x.domainId !== domainId;
      });
      return bad >= 0 ? [err("VALIDATION_FAILED", `${at}/folders/${bad}`, { keyword: "x-ref" })] : [];
    }
    // Новые папки объекта: по описанию вида (foldersErrs) и по смыслу профиля папки — центр домена на связи, запись в папки
    // входит (хук vms.folder/1). Сверяются папки, которые меняются: добавленные и убранные
    function folderChangeErrs(u, folders) {
      // Вид без папок: и пустой набор — не про него
      if (!capOf(u.kind, "folders")) return [err("NOT_SUPPORTED", "/folders", { capability: "folders" })];
      const errs = foldersErrs(u.kind, u.domainId, folders, "");
      if (errs.length) return errs;
      const was = u.folders || [];
      const bad = hFolder.memberProblem(u, folders.filter((f) => !was.includes(f)).concat(was.filter((f) => !folders.includes(f))), pctx);
      return bad ? [hookErr(bad, "", undefined, u.kind)] : [];
    }

    // Правка (UnitPatch: name, folders, properties — JSON Merge Patch) против описания вида. У документа (shape: document)
    // properties — запись целиком: проверяется как новое целое, а не как правка
    function unitPatchErrs(u, patch) {
      const out = membersOnly(u, patch) ? [] : kindErrs(u.kind);
      if (out.length) return out;
      if (patch.name !== undefined && patch.name !== u.name) {
        if (!String(patch.name).trim()) return [err("NAME_REQUIRED", "/name")];
        if (!capOf(u.kind, "rename")) return [err("NOT_SUPPORTED", "/name", { capability: "rename" })];
      }
      if (patch.folders) out.push(...folderChangeErrs(u, patch.folders));
      if (out.length) return out;
      let whole = null;
      if (patch.properties) {
        // Секреты лежат не в объекте: заданные (secrets[имя]) для обязательности целого — есть
        const errs = isDocument(u.kind) ? kinds.validate(u.kind, patch.properties, {}) : kinds.validate(u.kind, patch.properties, { partial: true, old: props(u), secrets: Object.keys(u.secrets || {}) });
        if (errs.length) return errs;
        whole = isDocument(u.kind) ? patch.properties : Kinds.mergePatch(props(u), patch.properties);
        const uniq = uniqueErrs(u.kind, u.parentId, whole, u.uid, "");
        if (uniq.length) return uniq;
      }
      // Смысл профиля: хук может привести правку к виду записи (обрезать имя) — patch у зовущего копия
      const bad = membersOnly(u, patch) ? null : hooksProblem(u.kind, "beforeSet", [u, patch, whole]);
      return bad ? [hookErr(bad, "", undefined, u.kind)] : [];
    }
    // Свойства с x-transient (подтверждение уменьшения тома) — только проверка правки, в объекте не хранятся
    const transientNames = (kind) => Object.entries(((kinds.get(kind) || {}).schema || {}).properties || {}).filter(([, s]) => s && s["x-transient"]).map(([n]) => n);
    // Обратная правка: по ней откат вернёт прежнее. Вложенные объекты — тоже правкой: добавленное снимается null
    function inverseOf(old, patch) {
      const out = {};
      Object.keys(patch).forEach((k) => {
        const a = old ? old[k] : undefined, b = patch[k];
        const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
        out[k] = plain(a) && plain(b) ? inverseOf(a, b) : a === undefined ? null : clone(a);
      });
      return out;
    }
    // Значения полей, которые трогает правка: откат и повтор сверяют их, а не версию
    function unitFieldsOf(u, patch) {
      const out = {};
      if (patch.name !== undefined) out.name = u.name;
      if (patch.folders !== undefined) out.folders = (u.folders || []).slice();
      if (patch.properties) {
        const hide = new Set(kinds.secretNames(u.kind).concat(transientNames(u.kind)));
        out.properties = isDocument(u.kind) ? clone(props(u)) : Object.fromEntries(Object.keys(patch.properties).filter((n) => !hide.has(n)).map((n) => [n, n in props(u) ? clone(props(u)[n]) : null]));
      }
      return out;
    }
    const sameUnitFields = (u, want) => JSON.stringify(unitFieldsOf(u, want)) === JSON.stringify(want);
    // Секреты правки и создания: значение — в secrets, в объекте — только флаг; null снимает секрет
    function setSecret(u, name, value) {
      const key = secretKey(u.uid, name);
      if (value === null || value === "") {
        secrets.delete(key);
        if (u.secrets) delete u.secrets[name];
        if (u.secrets && !Object.keys(u.secrets).length) delete u.secrets;
      } else {
        secrets.set(key, value);
        (u.secrets || (u.secrets = {}))[name] = true;
      }
    }
    const touchesSecret = (u, patch) => !!patch.properties && kinds.secretNames(u.kind).some((n) => n in patch.properties);
    // Правка: возвращает обратную правку. Версия, «ещё не применилось» и событие — unitChanged
    function applyUnitPatch(u, patch) {
      const before = {};
      if (patch.name !== undefined) {
        before.name = u.name;
        u.name = patch.name;
      }
      if (patch.folders !== undefined) {
        before.folders = (u.folders || []).slice();
        if (patch.folders.length) u.folders = [...new Set(patch.folders)];
        else delete u.folders;
        store.reindex(u.uid);
      }
      if (patch.properties) {
        const hide = new Set(kinds.secretNames(u.kind).concat(transientNames(u.kind)));
        const open = Object.fromEntries(Object.entries(patch.properties).filter(([n]) => !hide.has(n)));
        Object.entries(patch.properties).filter(([n]) => hide.has(n) && kinds.secretNames(u.kind).includes(n)).forEach(([n, v]) => setSecret(u, n, v));
        if (isDocument(u.kind)) {
          before.properties = clone(props(u));
          u.properties = clone(open);
        } else {
          before.properties = inverseOf(props(u), open);
          u.properties = Kinds.mergePatch(props(u), open);
        }
        if ([...kinds.refNames(u.kind)].some((n) => n in open)) store.reindex(u.uid);
      }
      hooksOf(u.kind).forEach((h) => h.afterSet && h.afterSet(u, before, pctx));
      return before;
    }
    // Правку система применяет не сразу: status.observedVersion отстаёт от version, условие Applied: false — до такта часов
    const APPLY_MS = 600;
    let applying = new Map();
    function setApplied(u, ok) {
      const s = u.status || (u.status = {});
      s.conditions = (s.conditions || []).filter((c) => c.type !== "Applied").concat({ type: "Applied", status: ok ? "true" : "false", reason: ok ? "Applied" : "Pending", since: iso(now()) });
      if (ok) s.observedVersion = u.version;
    }
    function unitChanged(u, pending) {
      const was = u.version;
      bump(u);
      if (pending) {
        const s = u.status || (u.status = {});
        if (s.observedVersion === undefined) s.observedVersion = was;
        setApplied(u, false);
        applying.set(u.uid, now() + APPLY_MS);
      }
      send("entity.changed", { kind: u.kind, entityId: u.uid, version: u.version });
      unitTreeTouch(u);
    }
    function applyTick(fired) {
      applying.forEach((at, uid) => {
        if (at > now()) return;
        applying.delete(uid);
        const u = store.get(uid);
        if (!u) return;
        setApplied(u, true);
        send("entity.changed", { kind: u.kind, entityId: u.uid, version: u.version, payload: { status: true } });
        fired.push({ kind: u.kind, id: uid });
      });
    }

    // Новый объект (UnitCreate) — проверка строки целиком, с дочерними: at — указатель строки (/children/0…).
    // parent — объект склада, null — корень домена, { fresh } — родитель из той же строки (ещё не создан)
    function unitCreateErrs(spec, parent, at) {
      at = at || "";
      const k = kinds.get(spec.kind);
      const out = kindErrs(spec.kind, at);
      if (out.length) return out;
      let par = parent;
      // Родитель задан местом (дочерний строки, шаг createUnit): parentId в теле, если есть, — он же
      if (par) {
        if (spec.parentId != null && (par.fresh || spec.parentId !== par.uid)) return [err("PARENT_MISMATCH", `${at}/parentId`, { kind: spec.kind })];
      } else if (spec.parentId != null) {
        par = store.get(spec.parentId);
        if (!par) return [err("VALIDATION_FAILED", `${at}/parentId`, { keyword: "x-ref" })];
      }
      // Под этим родителем вид бывает (parents), но заводит его не оператор (находит сервер) — NOT_SUPPORTED; не бывает — PARENT_MISMATCH.
      // Дочерняя строка нового родителя (UnitCreate.children) судится по children родителя и create вида: вид с пустым
      // createParents заводится только так, вместе с родителем (том — с новым хранилищем); непустой createParents должен
      // называть вид родителя, как у существующего
      const pk = par ? par.kind : null;
      const withParent = par && par.fresh && ((kinds.get(pk) || {}).children || []).includes(spec.kind) && !(k.createParents || []).length;
      // create снят с вида — отдельно его не заводят, но первый том (vms.volume/1 в children нового хранилища, createParents пуст) идёт его дочерней строкой
      if (!capOf(spec.kind, "create") && !(withParent && kinds.profileOf(spec.kind, "vms.volume/1"))) return [err("NOT_SUPPORTED", `${at}/kind`, { kind: spec.kind, capability: "create" })];
      if (!withParent && !(k.createParents || []).includes(pk)) return [(k.parents || []).includes(pk) ? err("NOT_SUPPORTED", `${at}/kind`, { kind: spec.kind, parentKind: pk }) : err("PARENT_MISMATCH", `${at}/parentId`, { kind: spec.kind, parentKind: pk })];
      // Домен — сам себе корень: domainId у него нет
      const selfRoot = kinds.profileOf(spec.kind, "vms.domain/1");
      const domainId = selfRoot ? null : par ? par.domainId : spec.domainId;
      if (selfRoot) {
        if (spec.domainId) return [err("VALIDATION_FAILED", `${at}/domainId`, { keyword: "const", value: null })];
      } else if (!par) {
        if (!domainId) return [err("VALIDATION_FAILED", `${at}/domainId`, { keyword: "required" })];
        const d = store.get(domainId);
        if (!d || d.kind !== "domain") return [err("VALIDATION_FAILED", `${at}/domainId`, { keyword: "x-ref" })];
      } else if (spec.domainId && spec.domainId !== domainId) return [err("VALIDATION_FAILED", `${at}/domainId`, { keyword: "const", value: domainId })];
      if (spec.name !== undefined && !String(spec.name).trim()) return [err("NAME_REQUIRED", `${at}/name`)];
      out.push(...foldersErrs(spec.kind, domainId, spec.folders, at));
      // Папки ведёт центр домена: без связи с ним новый объект в папку не войдёт — как правка folders (memberProblem)
      if (!out.length && (spec.folders || []).length && domainDown(domainId)) out.push(Object.assign(err("SERVER_OFFLINE", `${at}/folders`), { status: 409 }));
      out.push(...kinds.validate(spec.kind, spec.properties || {}).map((e) => Object.assign({}, e, { field: at + e.field })));
      // Дочерние строки одного нового родителя сверяются и между собой (par.rows — уже проверенные соседи): x-unique здесь,
      // смысл профиля (второй том того же хранилища на том же диске — DISK_TAKEN) — у хука, родитель строки несёт rows
      if (!out.length) out.push(...uniqueErrs(spec.kind, par && !par.fresh ? par.uid : null, spec.properties || {}, null, at, par && par.fresh ? par.rows : null));
      if (out.length) return out;
      // Смысл профиля: хук смотрит будущий объект (имя, адрес сервера, диск тома…)
      const draft = unitDraft(spec, par, domainId);
      const bad = hooksProblem(spec.kind, "beforeCreate", [draft, par]);
      if (bad) return [hookErr(bad, at, undefined, spec.kind)];
      if (par && par.fresh && par.rows) par.rows.push(draft);
      const fresh = { fresh: true, kind: spec.kind, domainId, parentId: par && !par.fresh ? par.uid : null, rows: [] };
      for (const [i, c] of (spec.children || []).entries()) {
        const e = unitCreateErrs(c, fresh, `${at}/children/${i}`);
        if (e.length) return e;
      }
      return [];
    }
    // Будущий объект строки (ещё без uid и версии): хуки профиля проверяют его и дополняют умолчаниями. Секретов в нём нет
    function unitDraft(spec, parent, domainId) {
      const u = { uid: null, kind: spec.kind, parentId: parent && !parent.fresh ? parent.uid : null, domainId: domainId == null ? null : domainId, name: spec.name, properties: {} };
      if (spec.folders && spec.folders.length) u.folders = [...new Set(spec.folders)];
      const hide = new Set(kinds.secretNames(spec.kind).concat(transientNames(spec.kind)));
      Object.entries(spec.properties || {}).forEach(([n, v]) => {
        if (!hide.has(n) && v !== null) u.properties[n] = clone(v);
      });
      // Строка целиком (x-transient-свойства: профиль камеры при добавлении; candidateId) — хукам, в объекте не хранится
      Object.defineProperty(u, "spec", { value: spec, enumerable: false, configurable: true });
      return u;
    }
    // Имя по шаблону вида: подпись и номер
    const unitName = (kind) => `${((kinds.get(kind) || {}).label || {}).text || kind} ${store.byKind(kind).length + 1}`;
    // Создать проверенную строку: объект и дочерние. Первый в ответе — сам объект
    // Умолчания и поля нового объекта — хуки профиля (beforeCreate), после создания — afterSet(unit, null). uid — с цифрой
    // своей таблицы (домен 1…, сервер 2…), у видов без таблицы — как у устройств
    function unitMake(spec, parent) {
      const domainId = kinds.profileOf(spec.kind, "vms.domain/1") ? null : parent ? parent.domainId : spec.domainId;
      const u = unitDraft(spec, parent, domainId);
      hooksOf(spec.kind).forEach((h) => h.beforeCreate && h.beforeCreate(u, parent, pctx));
      // uid — с цифрой своей таблицы; у потока — по камере (хук newUid)
      const nu = parent && !parent.fresh ? hookOf(spec.kind, "newUid") : null;
      u.uid = nu ? nu.newUid(u, parent, pctx) : uuid(TABLES[tableOf(spec.kind)] || "device");
      if (u.name === undefined) u.name = unitName(spec.kind);
      u.version = newVersion();
      kinds.secretNames(spec.kind).forEach((n) => spec.properties && n in spec.properties && setSecret(u, n, spec.properties[n]));
      u.status = Object.assign({ link: "unknown" }, u.status);
      setApplied(u, true);
      unitPut(u);
      send("entity.created", { kind: u.kind, entityId: u.uid, version: u.version });
      unitTreeTouch(u);
      hooksOf(u.kind).forEach((h) => h.afterSet && h.afterSet(u, null, pctx));
      delete u.spec;
      return [u].concat(...(spec.children || []).map((c) => unitMake(c, u)));
    }
    // Удалить объект с потомками: снимок для отката (с секретами), события — от детей к родителю
    function unitRemoveTree(u) {
      const all = unitSubtree(u);
      const snap = all.map((x) => ({ unit: clone(x), secrets: [...secrets.entries()].filter(([key]) => secretOfUnit(x.uid, key)) }));
      all.slice().reverse().forEach((x) => {
        store.remove(x.uid);
        legacy.detach(x);
        applying.delete(x.uid);
        snap.find((s) => s.unit.uid === x.uid).secrets.forEach(([key]) => secrets.delete(key));
        send("entity.deleted", { kind: x.kind, entityId: x.uid });
        unitTreeTouch(x);
      });
      // Ссылки на удалённое у остальных — снять; откат вернёт (snap[0].refs)
      snap[0].refs = refsCleanup(new Set(all.map((x) => x.uid)));
      return snap;
    }
    const nullable = (s) => [].concat((s || {}).type || []).includes("null");
    // Элемент массива ссылается на удалённое — сам или полем строки (extraArchives[].archiveId)
    // Элемент массива держится на удалённом: сам — ссылка на него, или у строки обязательное поле ссылается на него
    // (extraArchives[].archiveId). Необязательное поле строки (extraArchives[].replicaFrom) снимается, строка остаётся
    // Ссылка снимается, если цель удалили и у x-ref нет onDelete: "keep" (висящая ссылка — норма профиля: источник replica)
    const refGone = (s, v, gone) => !!s["x-ref"] && s["x-ref"].onDelete !== "keep" && gone.has(v);
    const refHit = (s, x, gone) => !!s && x != null && (typeof x === "string" ? refGone(s, x, gone) : typeof x === "object" && !Array.isArray(x) && (s.required || []).some((k) => refHit((s.properties || {})[k], x[k], gone)));
    // Значение без ссылок на удалённое: одиночная ссылка — null (схема null не допускает — undefined: свойство снимается),
    // из массива уходит элемент, который на удалённом держится, у остальных элементов и вложенных объектов — то же по полям
    function refStrip(s, v, gone) {
      if (v == null || !s) return v;
      if (typeof v === "string") return refGone(s, v, gone) ? (nullable(s) ? null : undefined) : v;
      if (Array.isArray(v)) return v.filter((x) => !refHit(s.items, x, gone)).map((x) => refStrip(s.items, x, gone));
      if (typeof v !== "object") return v;
      const out = {};
      Object.entries(v).forEach(([k, x]) => {
        const y = refStrip((s.properties || {})[k], x, gone);
        if (y !== undefined) out[k] = y;
      });
      return out;
    }
    /* Удалили объекты (gone — uid): у остальных объектов склада ссылки x-ref на них снимаются, как это делают хуки удаления
       (removeDevice — детекторы записи; хранилища камер хук хранилища снимает по-своему). Версия объекта
       растёт, в поток — entity.changed. Ответ — что вернуть откатом: [{uid, properties: прежние значения, version: после}] */
    function refsCleanup(gone) {
      const out = [];
      const seen = new Set();
      gone.forEach((id) => store.byRef(id).forEach((u) => {
        if (gone.has(u.uid) || seen.has(u.uid) || !kinds.get(u.kind)) return;
        seen.add(u.uid);
        const names = [...new Set(kinds.refsOf(u).filter((r) => gone.has(r.uid)).map((r) => r.name))];
        const schema = (kinds.get(u.kind).schema || {}).properties || {};
        const before = {};
        names.forEach((n) => {
          const v = refStrip(schema[n], props(u)[n], gone);
          // onDelete: "keep" — значение то же: свойство не трогается
          if (JSON.stringify(v) === JSON.stringify(props(u)[n])) return;
          before[n] = clone(props(u)[n]);
          if (v === undefined) delete u.properties[n];
          else u.properties[n] = v;
        });
        if (!Object.keys(before).length) return;
        store.reindex(u.uid);
        bump(u);
        send("entity.changed", { kind: u.kind, entityId: u.uid, version: u.version });
        out.push({ uid: u.uid, properties: before, version: u.version });
      }));
      return out;
    }
    /* Своё удаление профиля (хук remove) на путях ядра, затем — общая очистка ссылок x-ref на всё, что ушло со склада:
       хранилище с томами, папка с подпапками, домен. Хук делает своё (хранилище переназначает камерам основное), остальные
       ссылки снимает refsCleanup — кроме x-ref с onDelete: "keep" (replicaFrom: запись ждёт источник, SOURCE_GONE). Ответ
       хука и refs — что сняли */
    function hookRemove(rem, u, params) {
      const was = new Set(unitSubtree(u).map((x) => x.uid).concat(dependentsOf(u).remove));
      const res = Object.assign({}, rem.remove(u, params, pctx));
      res.refs = refsCleanup(new Set([...was].filter((id) => !store.has(id))));
      return res;
    }
    // Откат: ссылки возвращаются объектам, которые после очистки не меняли
    function refsRestore(list) {
      (list || []).forEach((r) => {
        const u = store.get(r.uid);
        if (!u || u.version !== r.version) return;
        Object.entries(r.properties).forEach(([n, v]) => (u.properties[n] = clone(v)));
        store.reindex(u.uid);
        bump(u);
        send("entity.changed", { kind: u.kind, entityId: u.uid, version: u.version });
      });
    }
    // Откат удаления: объекты возвращаются с теми же uid, если uid свободны и родитель с доменом на месте; версия — новая
    function unitRestore(snap) {
      const root = snap[0].unit;
      if (snap.some((s) => store.has(s.unit.uid))) return "NOT_SUPPORTED";
      if ((root.parentId && !store.has(root.parentId)) || (root.domainId && !store.has(root.domainId))) return "NOT_FOUND";
      snap.forEach((s) => {
        const u = clone(s.unit);
        if (u.folders) u.folders = u.folders.filter((f) => store.has(f));
        if (u.folders && !u.folders.length) delete u.folders;
        u.version = newVersion();
        setApplied(u, true);
        s.secrets.forEach(([key, value]) => secrets.set(key, value));
        unitPut(u);
        send("entity.created", { kind: u.kind, entityId: u.uid, version: u.version });
        unitTreeTouch(u);
      });
      refsRestore(snap[0].refs);
      return null;
    }
    // Удаление: возможность delete; объект и его потомки не заняты операцией (общее правило всех видов: том под format,
    // камера под шагом — 409 BUSY на любом пути удаления: DELETE, /objects/delete, шаг delete); у вида со своим удалением
    // (хук remove) — проверки хука (beforeDelete: последний домен, непустой без moveTo, занятость затронутого), без них —
    // каскад ядра по parentId. Занятость — «кроме своей операции» внутри шага (heldNow), иначе — любая (held)
    function unitDeleteErrs(u, params) {
      const out = kindErrs(u.kind);
      if (out.length) return out;
      if (!capOf(u.kind, "delete")) return [err("NOT_SUPPORTED", "/kind", { kind: u.kind, capability: "delete" })];
      const locked = lockedProblem(unitSubtree(u).map((x) => x.uid), heldNow || held);
      if (locked) return [Object.assign(err("BUSY", undefined, locked.body.params), { status: 409 })];
      const bad = hooksProblem(u.kind, "beforeDelete", [u, params || {}]);
      if (bad) return [hookErr(bad, "", undefined, u.kind)];
      if (hookOf(u.kind, "remove")) return [];
      // Потомок вида с профилем (смысл удаления — у его пути) не уходит каскадом ядра
      const foreign = unitSubtree(u).find((x) => !coreKind(x.kind));
      return foreign ? [err("NOT_SUPPORTED", "/kind", { kind: foreign.kind, uid: foreign.uid })] : [];
    }
    // Перенос к другому родителю: возможность move, родитель — из UnitKind.parents, не свой потомок, в том же домене
    // У вида со своим переносом (хук move: сервер — приём в домен и исключение) родителя и параметры судит хук (beforeMove),
    // у остальных параметров переноса нет
    function unitMoveErrs(u, parentId, params) {
      const out = kindErrs(u.kind);
      if (out.length) return out;
      if (!capOf(u.kind, "move")) return [err("NOT_SUPPORTED", "/parentId", { capability: "move" })];
      if (hookOf(u.kind, "move")) {
        const bad = hooksProblem(u.kind, "beforeMove", [u, parentId == null ? null : parentId, params || {}]);
        return bad ? [hookErr(bad, "", "/params/", u.kind)] : [];
      }
      const extra = Object.keys(params || {});
      if (extra.length) return [err("VALIDATION_FAILED", `/params/${esc(extra[0])}`, { keyword: "additionalProperties" })];
      const par = parentId == null ? null : store.get(parentId);
      if (parentId != null && !par) return [err("VALIDATION_FAILED", "/parentId", { keyword: "x-ref" })];
      if (!kinds.parentsOk(u.kind, par ? par.kind : null)) return [err("PARENT_MISMATCH", "/parentId", { kind: u.kind, parentKind: par ? par.kind : null })];
      if (par && unitSubtree(u).some((x) => x.uid === par.uid)) return [err("PARENT_MISMATCH", "/parentId", { reason: "cycle" })];
      if (par && par.domainId !== u.domainId) return [err("VALIDATION_FAILED", "/parentId", { keyword: "domain" })];
      return [];
    }
    // Перенос со смыслом (хук move профиля). moveBack хука — как вернуть объект туда, где он сейчас: снимок до переноса — шаг
    // отката, снимок после — то, что откат сверяет (here). Объект сменился (камера w2c вместо сервера) или стоит, где стоял, —
    // возвращать нечего
    function hookMove(mv, u, parentId, params) {
      const back = mv.moveBack ? mv.moveBack(u, pctx) : null;
      const unit = mv.move(u, parentId, params || {}, pctx);
      const here = back && unit === u ? mv.moveBack(u, pctx) : null;
      return { unit, before: here && JSON.stringify(here) !== JSON.stringify(back) ? { hookMove: true, back, here } : { hookMove: true } };
    }
    const sameHere = (u, want) => {
      const h = hookOf(u.kind, "moveBack");
      return !!h && JSON.stringify(h.moveBack(u, pctx)) === JSON.stringify(want);
    };
    function applyUnitMove(u, parentId) {
      const was = u.parentId;
      unitTreeTouch(u);
      u.parentId = parentId == null ? null : parentId;
      store.reindex(u.uid);
      unitChanged(u, true);
      return was;
    }

    /* Команды объекта (ActionDescriptor) у видов без профиля исполняются одинаково:
       - право: ActionDescriptor.right {class?, level} — уровень класса доступа вида (нет class — основной класс вида) хотя бы у одной
         живой роли: исключение объекта (objectAccess по uid), иначе папки объекта, иначе домен, иначе Role.kindAccess; ниже —
         403 PERMISSION_DENIED, params.right — нужное право. Встроенная «Администратор» может всё;
       - команда ruleOnly — только шагом правила: здесь её нет (404);
       - параметры — по ActionDescriptor.params: ошибка — 422 с field /params/<имя>; без params в описании параметров быть не должно;
       - объект без связи (status.link offline) — 409 DEVICE_OFFLINE, над объектом идёт операция — 409 BUSY;
       - instant — ответ сразу: {result, unit}; longRunning — 202, операция из одного шага, шаг идёт по часам сервера;
       - итог пишется в status.observed (версия настроек не меняется, в поток — entity.changed с payload.status):
         парная команда — флаг: X и UN<X> или DIS<X> (ARM/DISARM, BYPASS/UNBYPASS) → observed[<x>ed] = true / false
         (armed, bypassed); у команды без пары — observed[<код строчными>] = {at, result?} — когда выполнена;
       - событие вида: если у вида есть событие с кодом команды или её причастием (ARM → ARM или ARMED, DISARM → DISARMED) —
         запись журнала и journal.event (kind события, source — вид объекта). Других событий вида команда не порождает. */
    const past = (w) => (w.endsWith("e") ? `${w}d` : `${w}ed`);
    function actionFlag(kind, id) {
      const low = id.toLowerCase(), names = new Set(((kinds.get(kind) || {}).actions || []).map((a) => a.id.toLowerCase()));
      for (const pre of ["un", "dis"]) if (low.startsWith(pre) && names.has(low.slice(pre.length))) return { key: past(low.slice(pre.length)), value: false };
      if (names.has(`un${low}`) || names.has(`dis${low}`)) return { key: past(low), value: true };
      return null;
    }
    // Право {class?, level} на объект u — у одной из живых ролей человека; нет — 403 с нужным правом
    function rightProblem(u, right, text) {
      const need = engine.rightOf(right ? { right } : null, u.kind);
      if (!need || myRoleIds().some((id) => engine.roleAllows(id, u.uid, need))) return null;
      return problem(403, "PERMISSION_DENIED", text, { params: { right: { class: need.cls, level: need.level } } });
    }
    const actionRightProblem = (u, desc) => rightProblem(u, desc.right, `Команде ${desc.id} нужен уровень ${(desc.right || {}).level}`);
    // Команда, которую можно отдать объекту: есть в описании вида, не только шагом правила, scope — объекту (нет поля — объекту)
    const actionScope = (desc) => desc.scope || ["unit"];
    const unitCommand = (kind, id) => {
      const desc = kinds.action(kind, id);
      return desc && !desc.ruleOnly && actionScope(desc).includes("unit") ? desc : null;
    };
    // Команда, которую объект называет своей (properties.operations: реле под замком СКУД — on, off), а описание вида не знает:
    // устройство её не выполнит — 409 DEVICE_REFUSED reason noOperation, как /devices/{id}/operations/{op} базы (без связи —
    // DEVICE_OFFLINE). Команды нет ни там, ни там — null: 404
    function strayCommandProblem(u, id) {
      if (!((props(u).operations || []).includes(id))) return null;
      if ((u.status || {}).link === "offline") return problem(409, "DEVICE_OFFLINE", "Устройство без связи");
      return problem(409, "DEVICE_REFUSED", "Такой команды у устройства нет", { params: { reason: "noOperation", operation: id } });
    }
    // Команда вида без объекта (scope ∋ kind)
    const kindCommand = (kind, id) => {
      const desc = kinds.action(kind, id);
      return desc && !desc.ruleOnly && actionScope(desc).includes("kind") ? desc : null;
    };
    // Право команды вида: объекта нет — судит умолчание роли по классу (Role.kindAccess); встроенная «Администратор» — всё
    function kindRightProblem(kind, desc) {
      const need = engine.rightOf(desc.right ? { right: desc.right } : null, kind);
      if (!need) return null;
      const acc = (kinds.get(kind) || {}).access;
      // Класс — свой у вида или другого вида набора (Right.class): уровни — у того, кто его объявил
      const classesOf = (a) => (a ? [a].concat(a.also || []) : []);
      const cls = classesOf(acc).find((c) => c.class === need.cls) || kinds.list().flatMap((k) => classesOf(k.access)).find((c) => c.class === need.cls);
      const levels = cls ? cls.levels : ["view", "edit", "admin"];
      const ok = (v) => !!v && levels.indexOf(v) >= levels.indexOf(need.level) && levels.indexOf(need.level) >= 0;
      if (db.access.roles.some((r) => myRoleIds().includes(r.id) && (r.global.unr || ok((r.kindAccess || {})[need.cls])))) return null;
      return problem(403, "PERMISSION_DENIED", `Команде ${desc.id} нужен уровень ${need.level}`, { params: { right: { class: need.cls, level: need.level } } });
    }
    function actionParamErrs(desc, params) {
      const C = typeof window !== "undefined" ? window.ConsolemContract : null;
      if (desc.params) return C ? C.validate(desc.params, params, "/params", { dir: "write" }).map((e) => err(e.code, e.field, e.params)) : [];
      return Object.keys(params).map((n) => err("VALIDATION_FAILED", `/params/${esc(n)}`, { keyword: "additionalProperties" }));
    }
    // Итог по ActionDescriptor.result: у встроенного сервера — постоянные значения по типу
    function actionResult(desc) {
      const out = {};
      Object.entries(((desc.result || {}).properties) || {}).forEach(([n, s]) => {
        const t = [].concat(s.type || [])[0];
        if (t === "number" || t === "integer") out[n] = 1;
        else if (t === "boolean") out[n] = true;
        else if (t === "string") out[n] = "";
      });
      return out;
    }
    // Всё, что мешает выполнить команду сейчас: {status, body} или null
    function actionProblem(u, desc, params) {
      const right = actionRightProblem(u, desc);
      if (right) return right;
      const errs = actionParamErrs(desc, params);
      if (errs.length) return errsProblem(errs, "Параметры команды не подходят под ActionDescriptor.params");
      if (u.status && u.status.link === "offline") return problem(409, "DEVICE_OFFLINE", "Объект без связи: команда не дойдёт");
      return null;
    }
    // Поведение команды — у хука профиля: своё по коду или общее ("*": команды единицы СКУД из её operations)
    function actionRun(kind, id) {
      const h = hooksOf(kind).find((x) => x.actions && (x.actions[id] || x.actions["*"]));
      return h ? h.actions[id] || h.actions["*"] : null;
    }
    function runAction(u, desc, params) {
      const at = iso(now());
      const result = actionResult(desc);
      const st = u.status || (u.status = {});
      const obs = st.observed || (st.observed = {});
      const flag = actionFlag(u.kind, desc.id);
      if (flag) obs[flag.key] = flag.value;
      else obs[desc.id.toLowerCase()] = Object.assign({ at }, Object.keys(result).length ? { result: clone(result) } : {});
      send("entity.changed", { kind: u.kind, entityId: u.uid, version: u.version, payload: { status: true } });
      const low = desc.id.toLowerCase();
      const ev = ((kinds.get(u.kind) || {}).events || []).find((e) => [low, past(low)].includes(String(e.id).toLowerCase()));
      if (ev) {
        const e = { id: uuid("journal"), at, occurredAt: at, category: ["alarm", "critical", "error"].includes(ev.severity) ? "alarm" : "info",
          text: `${(ev.label || {}).text || ev.id}: ${u.name}`, deviceId: u.uid, source: u.kind, kind: ev.id, fields: Object.assign({ action: desc.id }, Object.keys(params || {}).length ? { params: clone(params) } : {}) };
        db.journal.unshift(e);
        send("journal.event", { entityId: u.uid, payload: clone(e) });
      }
      return result;
    }

    // Шаг операции по uid: patch, action (+params), delete, folders, createUnit, move (+params). Служебные шаги отката и повтора:
    // restore (вернуть удалённое), unitRemove (снять созданное), move (вернуть родителя); expectUnit, expectParent — значения,
    // которые шаг сверяет перед тем, как выполниться (чужая правка после — VERSION_MISMATCH). Смысл профиля — хуки (удаление,
    // перенос, команды, сервер-исполнитель). Отказ — по строке, params.field — указатель. Внутри шага занятость «кроме этой
    // операции» видят и хуки (heldNow)
    function runUnitItem(op, item) {
      heldNow = heldBy(item);
      coreMode = true;
      // План объекта: правки этого и следующих шагов по тому же uid, слитые (камера сверяет запись целиком)
      const later = item.req.patch ? op.items.slice(op.items.indexOf(item)).filter((x) => x.req.uid === item.req.uid && x.req.patch && x.req.patch.properties) : [];
      planNow = later.length > 1 ? { properties: Object.assign({}, ...later.map((x) => x.req.patch.properties)) } : null;
      try {
        return runUnitStep(op, item);
      } finally {
        heldNow = null;
        coreMode = false;
        planNow = null;
      }
    }
    function runUnitStep(op, item) {
      const r = item.req;
      const fail = (code, params) => Object.assign(item, { state: "fail", code }, params ? { params } : {});
      // Указатель (OperationItem.params.field — JSON Pointer в теле шага) старше одноимённого params ошибки (x-bound-to: имя поля)
      const failErr = (e) => fail(e.code, Object.assign({}, e.params || {}, e.field !== undefined ? { field: e.field } : {}));
      const ok = (version) => Object.assign(item, { state: "ok", code: null }, version !== undefined ? { version } : {});
      if (r.restore) {
        const bad = unitRestore(r.restore);
        if (bad) return fail(bad);
        item.before = {};
        return ok(store.get(r.restore[0].unit.uid).version);
      }
      if (r.unitRemove) {
        const made = store.get(r.unitRemove);
        if (!made) return fail("NOT_FOUND");
        const sub = unitSubtree(made).map((x) => x.uid);
        if (made.version !== r.expect || lockedProblem(sub, heldBy(item))) return fail("NOT_SUPPORTED");
        // На созданное уже ссылаются (камера пишет в созданное хранилище): снять его — снять и чужую настройку
        if (sub.some((id) => store.byRef(id).some((x) => !sub.includes(x.uid)))) return fail("NOT_SUPPORTED");
        const rem = hookOf(made.kind, "remove");
        if (rem) hookRemove(rem, made, {});
        else unitRemoveTree(made);
        item.before = {};
        return ok();
      }
      const u = store.get(r.uid);
      if (!u) return fail("NOT_FOUND");
      // Шаг createUnit меняет не цель, а создаёт под ней: судит вид создаваемого (хозяин строки может быть камерой)
      const kindBad = r.createUnit || (r.folders && membersOnly(u, { folders: r.folders })) ? [] : kindErrs(u.kind);
      if (kindBad.length) return failErr(kindBad[0]);
      if ((r.expectUnit && !sameUnitFields(u, r.expectUnit)) || (r.expectParent !== undefined && (u.parentId || null) !== r.expectParent) || (r.expectHere && !sameHere(u, r.expectHere))) return fail("VERSION_MISMATCH");
      // Изменение применяет сервер-исполнитель (хук executor): без связи — отказ. Папки — не запись на сервер устройства: их судит
      // профиль папки (центр домена на связи), как PATCH {folders}
      // Правка только папок (Unit.folders) — дело центра домена, не сервера устройства: как PATCH /units {folders}
      const via = (r.patch && !foldersOnly(r.patch)) || r.delete ? executorOf(u) : null;
      if (via && via.online === false) return fail("SERVER_OFFLINE");
      if (r.patch) {
        // Копия: хук может привести правку к виду записи (имя без пробелов по краям), исходная нужна повтору
        const patch = clone(r.patch);
        const errs = unitPatchErrs(u, patch);
        if (errs.length) return failErr(errs[0]);
        const held = hooksProblem(u.kind, "beforeApply", [u, patch, true]);
        if (held) return failErr(hookErr(held, "", undefined, u.kind));
        item.before = { unitPatch: applyUnitPatch(u, patch) };
        item.after = unitFieldsOf(u, patch);
        item.secret = touchesSecret(u, patch);
        unitChanged(u, true);
      } else if (r.move !== undefined) {
        const errs = unitMoveErrs(u, r.move, r.params);
        if (errs.length) return failErr(errs[0]);
        const mv = hookOf(u.kind, "move");
        if (mv) {
          const res = hookMove(mv, u, r.move, r.params);
          item.before = res.before;
          // Перенос заменил объект (сервер вида camera принят камерой, запись сервера снята): итог называет новый объект
          if (res.unit.uid !== u.uid) item.createdId = res.unit.uid;
          return ok(res.unit.version);
        }
        item.before = { parentId: applyUnitMove(u, r.move) };
        item.after = { parentId: u.parentId };
      } else if (r.action) {
        const desc = unitCommand(u.kind, r.action);
        if (!desc) {
          const stray = strayCommandProblem(u, r.action);
          return stray ? fail(stray.body.code, Object.assign({ field: "/action" }, stray.body.params || {})) : fail("NOT_FOUND", { field: "/action" });
        }
        // Долгая команда с поведением уже запущена (POST /units/{uid}/actions/…): шаг — её срок по часам сервера
        if (r.until !== undefined) {
          item.before = {};
          return ok(u.version);
        }
        const bad = actionProblem(u, desc, r.params || {});
        if (bad) return fail(bad.body.code, Object.assign({}, bad.body.params || {}, bad.body.field ? { field: bad.body.field } : {}));
        const run = actionRun(u.kind, desc.id);
        if (run) {
          const res = run(u, clone(r.params || {}), pctx, desc.id);
          if (Profiles.isProblem(res)) return failErr(hookErr(res, "", "/params/", u.kind));
        } else runAction(u, desc, r.params || {});
        item.before = {};
      } else if (r.delete) {
        const errs = unitDeleteErrs(u, {});
        if (errs.length) return failErr(errs[0]);
        const version = u.version;
        const rem = hookOf(u.kind, "remove");
        if (rem) {
          // Своё удаление (каскад профиля): откат его не возвращает, как удаление старых путей
          hookRemove(rem, u, {});
          item.before = { deleted: true };
          return ok(version);
        }
        // Потомок, над которым идёт другая операция (или другой шаг этой), — как у DELETE /units/{uid}: отказ BUSY
        const locked = lockedProblem(unitSubtree(u).map((x) => x.uid), heldBy(item));
        if (locked) return fail("BUSY", locked.body.params);
        item.before = { restore: unitRemoveTree(u) };
        return ok(version);
      } else if (r.folders) {
        const errs = folderChangeErrs(u, r.folders);
        if (errs.length) return failErr(errs[0]);
        item.before = { folders: applyUnitPatch(u, { folders: r.folders }).folders };
        unitChanged(u, false);
      } else if (r.createUnit) {
        const errs = unitCreateErrs(r.createUnit, u, "");
        if (errs.length) return failErr(errs[0]);
        const made = unitMake(r.createUnit, u)[0];
        Object.assign(item, { createdId: made.uid, createdVersion: made.version, before: { unitRemove: made.uid } });
      } else return fail("NOT_SUPPORTED");
      return ok(u.version);
    }
    // Шаг отката по выполненному шагу x: что вернуть. Команду и папки назад не вернуть (как папки старых путей), секрет — тоже
    function unitUndo(x) {
      const r = x.req, uid = r.uid;
      if (r.patch) {
        if (x.secret) return { uid, undoable: false, why: "secret" };
        // Свойства, которые откат не возвращает (хук fixed: адрес и объём тома)
        const fixed = hooksOf(unitKindOf(x)).flatMap((h) => h.fixed || []);
        if (Object.keys(r.patch.properties || {}).some((n) => fixed.includes(n))) return { uid, undoable: false };
        return { uid, patch: x.before.unitPatch, expectUnit: x.after, forward: r.patch };
      }
      if (r.delete) return x.before.deleted ? { uid, undoable: false } : { uid, restore: x.before.restore };
      if (r.createUnit) return { uid, unitRemove: x.createdId, expect: x.createdVersion };
      if (r.move !== undefined && x.before.hookMove) {
        // Перенос со смыслом: назад — в прежнее место (у сервера — домен и распределён ли), если там, куда перенесли, он и стоит
        const b = x.before;
        return b.back ? { uid, move: b.back.parentId, params: clone(b.back.params), expectHere: b.here, forward: { move: r.move, params: clone(r.params || {}) } } : { uid, undoable: false };
      }
      if (r.move !== undefined) return { uid, move: x.before.parentId, expectParent: x.after.parentId };
      return { uid, undoable: false, why: r.folders ? "folders" : "action" };
    }
    // Вид объекта шага: объект на складе, а если его уже нет — вид из снимка удаления
    const unitKindOf = (x) => (store.get(x.req.uid) || (x.before.restore ? x.before.restore[0].unit : {})).kind;
    // Шаг повтора по удачному шагу отката: то же, что делал исходный шаг. Снятое откатом созданное заново не создаётся
    function unitRedo(x) {
      const r = x.req, uid = r.uid;
      if (r.patch) return { uid, patch: r.forward, expectUnit: x.after };
      if (r.restore) return { uid, delete: true };
      if (r.move !== undefined && r.forward) return x.before.here ? { uid, move: r.forward.move, params: clone(r.forward.params), expectHere: x.before.here } : { uid, undoable: false };
      if (r.move !== undefined) return { uid, move: r.expectParent, expectParent: r.move };
      return { uid, undoable: false };
    }
    // Шаг по uid в POST /operations: ровно одно действие; params — только у action и move. Цель — объект склада
    const UNIT_STEP = ["patch", "action", "delete", "folders", "createUnit", "move"];
    function unitStepProblem(r, i) {
      const at = `/items/${i}`;
      if (UNIT_STEP.filter((k) => r[k] !== undefined).length !== 1) return problem(422, "VALIDATION_FAILED", `У шага ровно одно из ${UNIT_STEP.join(", ")}`, { field: at });
      if (r.params !== undefined && r.action === undefined && r.move === undefined) return problem(422, "VALIDATION_FAILED", "params — только у action и move", { field: `${at}/params` });
      // Объекта шага нет — как состав папки базы (/folders/{id}/devices): 422 на всю операцию, указатель — uid шага
      if (!store.get(r.uid)) return problem(422, "VALIDATION_FAILED", `Объекта ${r.uid} нет: операция не запущена, ничего не изменено`, { field: `${at}/uid`, params: { keyword: "x-ref", targetId: r.uid } });
      return null;
    }
    // Версия цели нужна шагам, которые меняют сам объект: patch, delete, folders, move. Команде и созданию дочернего — нет
    const unitStepNeedsVersion = (r) => r.patch !== undefined || r.delete !== undefined || r.folders !== undefined || r.move !== undefined;
    // Состав папок в шагах проверяется до запуска, как состав папки в базе (/folders/{id}/devices, шаг folderIds у /operations):
    // папки нет или она в другом домене, запись в папки не входит — отклоняется вся операция, ничего не применено. Ответ —
    // отказ шага: field — указатель в теле запроса (/items/{i}/folders/0, /items/{i}/patch/folders/0), params.targetId — объект
    // шага. Права и связь с центром домена — при выполнении (как у шага базы): у шагов одной папки отказ одинаков у всех.
    // Прочее (описание вида, смысл профиля, связь сервера, перенос, удаление, команда) судится при выполнении, по строке
    function unitStepsPreflight(items) {
      for (const [i, r] of items.entries()) {
        const folders = r.folders !== undefined ? r.folders : r.patch && r.patch.folders;
        if (!folders) continue;
        const u = store.get(r.uid), at = r.folders !== undefined ? `/items/${i}` : `/items/${i}/patch`;
        let errs = !capOf(u.kind, "folders") ? [err("NOT_SUPPORTED", "/folders", { capability: "folders" })] : foldersErrs(u.kind, u.domainId, folders, "");
        if (!errs.length && tableOf(u.kind) === "devices" && folders.some((f) => !(u.folders || []).includes(f)) && !folderable(legacy.view(u))) errs = [err("NOT_SUPPORTED", "/folders")];
        if (!errs.length) continue;
        const e = errs[0];
        return problem(422, e.code, e.code === "NOT_SUPPORTED" ? "Эта запись в папки не входит: операция не запущена, ничего не изменено" : "Папки нет в домене объекта: операция не запущена, ничего не изменено",
          { field: at + e.field, params: Object.assign({}, e.params || {}, { targetId: r.uid }) });
      }
      return null;
    }
    // Мгновенный шаг (patch, folders, move: без команды устройству, удаления и создания) — у операции с wait выполняется
    // в самом запросе, как быстрые записи базы (/devices/update, /folders/{id}/devices, /servers/assign)
    const unitStepInstant = (r) => r.patch !== undefined || r.folders !== undefined || r.move !== undefined;
    /* ----- Домен: итог круга — хук vms.domain/1 (в ядре — status.observed.stateSummary) ----- */

    /* ----- Большой набор ----- */

    // stand.large: устройства, серверы, папки, хранилища считаются при загрузке из номера: в файле набора только числа.
    // Числа — на весь набор. stand.large.domains (по умолчанию 1) — доменов, всё делится между ними поровну блоками по
    // порядку: серверы с хранилищами и томами, кластеры, папки, камеры (под серверами, ветка первого сервера, без сервера).
    // Домены сверх первого — копии первого объекта набора с именами из domainNames (иначе «Домен N»), ретранслятор — у первого.
    // Номера (uid, имена серверов, папок, камер) — сквозные по набору: при domains 1 раскладка та же, что без этих чисел
    function expandLarge(L) {
      const D = Math.max(1, L.domains || 1), names = L.domainNames || [];
      const uuidOf = (kind, n) => `${kind}${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
      // Доля домена d из n и её начало: остаток — первым доменам
      const share = (n, d) => Math.floor(n / D) + (d < n % D ? 1 : 0);
      const from = (n, d) => d * Math.floor(n / D) + Math.min(d, n % D);
      const first = store.get(db.domains[0].id);
      if (names[0]) first.name = names[0];
      for (let d = 1; d < D; d++) {
        const u = clone(first);
        Object.assign(u, { uid: uuidOf("1", Number(first.uid.slice(1, 8)) + d), name: names[d] || `Домен ${d + 1}` });
        store.put(u);
      }
      legacy.rebuild();
      const doms = db.domains.slice(0, D).map((x) => x.id), dom = doms[0];
      const base = { port: 20111, role: "node", domainId: dom, allocated: true, class: "server", online: true, telemetry: { cpu: 20, ram: 40, net: 5, disk: 30 }, gpu: null, disks: [{ disk: "C:", sizeBytes: 274877906944, system: true }], version: "v0" };
      const srv = [], fold = [];
      doms.forEach((domainId, d) => {
        // Кластеров меньше, чем доменов: у домена без своей доли — один кластер (иначе в имени сервера был бы NaN)
        const s0 = from(L.servers, d), c0 = from(L.clusters, d), nc = Math.max(1, share(L.clusters, d)), f0 = from(L.folders, d);
        for (let j = 0; j < share(L.servers, d); j++) {
          const i = s0 + j;
          srv.push(Object.assign({}, base, { domainId, id: uuidOf("2", 1000 + i), name: `Кластер ${c0 + (j % nc) + 1}/Сервер ${String(i + 1).padStart(3, "0")}`, ip: `10.${(i >> 8) & 255}.${i & 255}.10` }));
        }
        for (let j = 0; j < share(L.folders, d); j++) fold.push({ id: uuidOf("4", 1000 + f0 + j), name: `Папка ${f0 + j + 1}`, domainId, parentId: null, deviceIds: [], version: "v0" });
      });
      db.servers = srv;
      // Ретранслятор первого домена: его доля кластеров (последние кластеры домена) и камеры за ним. Камеры в составе не
      // совпадут с именами кластеров
      const relayed = Math.min(share(L.relayed, 0), share(L.clusters, 0)), last = share(L.clusters, 0);
      db.relays = { [dom]: { "Кластер 1": Array.from({ length: relayed }, (x, i) => `Кластер ${last - i}`).concat(Array.from({ length: 3000 }, (x, i) => `cam-${i}`)) } };
      db.archives = db.servers.map((s, i) => ({ id: uuidOf("5", 1000 + i), name: `Хранилище ${i + 1}`, kind: "local", storage: "object", encrypted: false, retentionDays: 30, provider: null, serverId: s.id, domainId: null, version: "v0", admits: true }));
      db.volumes = db.archives.map((a, i) => ({ id: uuidOf("6", 1000 + i), archiveId: a.id, name: "D:", disk: "D:", sizeBytes: 4398046511104, usedPercent: 40, state: "ready", online: true, mode: "dir", dir: "D:\\Archive", version: "v0" }));
      db.folders = fold;
      // Камеры — сразу объектами склада: 250 000 записей через перевод старой таблицы шли бы дольше.
      // В каждом домене первый сервер — с большой веткой: его страница не кончается за одно чтение. Остальные поровну
      const firstBranch = L.firstBranch, folders = db.folders.map((f) => f.id);
      const servers = db.servers.map((s) => s.id), archives = db.archives.map((a) => a.id);
      doms.forEach((domainId, d) => {
        const n0 = from(L.cameras, d), s0 = from(L.servers, d), ns = share(L.servers, d), f0 = from(L.folders, d), nf = share(L.folders, d);
        const onServer = share(L.serverCameras, d);
        for (let k = 0; k < share(L.cameras, d); k++) {
          const i = n0 + k;
          const id = uuidOf("3", 100000 + i);
          const sid = k < firstBranch ? 0 : k < onServer ? (ns > 1 ? 1 + ((k - firstBranch) % (ns - 1)) : 0) : -1;
          const u = { uid: id, kind: "camera", parentId: null, domainId, name: `Камера ${String((i * 7919) % L.cameras).padStart(6, "0")}`, version: "v0",
            properties: { enabled: i % 200 !== 11 }, status: { link: i % 50 !== 7 ? "online" : "offline" } };
          if (sid >= 0 && ns) Object.assign(u.properties, { serverId: servers[s0 + sid], archiveId: archives[s0 + sid], recordMode: "always" });
          if (k % 40 === 0 && nf) u.folders = [folders[f0 + ((k / 40) % nf)]];
          store.put(u);
        }
      });
      legacy.rebuild();
    }

    /* ===== Выгрузка (ADR-0117): задание — части по камерам, ход по часам стенда, файлы со сроком =====
       Как api/server.js базы, но камера — объект по uid, вид которого реализует vms.camera/1; записи камеры — шкала хука
       vms.timeline/1 (profiles.js). Не камера — 422 NOT_SUPPORTED, нет объекта — 404, field — /cameras/i */
    const expAll = () => db.exports || (db.exports = []);
    const expRef = () => db.reference.export;
    // Права человека: стенд правит их через stand.exportGrant (тесты), по умолчанию можно всё и без пароля
    const expGrant = () => Object.assign({ allowed: true, passwordRequired: false, privacyForced: false, supervisorRequired: false, watermark: false, depthHours: 0 }, db.stand.exportGrant || {});
    const expSupervisor = () => Object.assign({ login: "supervisor", password: "supervisor" }, db.stand.exportSupervisor || {});
    const expBad = (status, code, message, field, params) => ({ status, body: Object.assign({ code, message }, field ? { field } : {}, params ? { params } : {}) });
    // Камера заказа — запись-представление объекта склада; не камера или нет объекта — null
    const expCam = (uid) => {
      const u = uid == null ? null : store.get(uid);
      return u && tableOf(u.kind) === "devices" && isCamera(u) ? legacy.view(u) : null;
    };
    const expOverlap = (rec, a, b) => hTimeline.camSpans(rec, pctx).some((s) => s.startMs < b && s.endMs > a);
    const expSec = (body) => (body.periods || []).reduce((n, p) => n + Math.max(0, (Date.parse(p.to) - Date.parse(p.from)) / 1000), 0);
    const expTranscode = (b) => {
      const q = b.quality || {}, t = b.titles || {};
      return b.mode === "video" && ((q.codec && q.codec !== "source") || (q.resolution && q.resolution !== "source") || (q.compression && q.compression !== "default") || q.fpsDivisor > 1 || !!q.maxFps || q.speed > 1
        || ((t.fields || []).length > 0 && t.overlay !== "soft") || b.cameras.some((c) => c.area));
    };
    const expClean = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "");
    function expNames(b) {
      const f = expRef().formats.find((x) => x.id === b.format), zip = !!b.password && f && f.password === "zip";
      const ext = zip ? "zip" : b.format;
      const at = b.mode === "frame" ? (b.source === "live" ? now() : Date.parse(b.at)) : Math.min(...(b.periods || []).map((p) => Date.parse(p.from)));
      // Время в имени — по часам системы (Me.timezone), как его видит оператор
      const stamp = new Date(Number.isFinite(at) && at > 0 ? at : now()).toLocaleString("sv-SE", { timeZone: db.timezone || "UTC" }).replace(/[-:]/g, "").replace(" ", "-");
      const cam = (c) => { const rec = expCam(c.uid), srv = rec && rec.serverId && byId("servers", rec.serverId); return expClean(`${srv ? srv.name : "VMS"}_${rec ? rec.name : c.uid}`); };
      if (b.singleFile && b.cameras.length > 1) return [{ name: `${expClean(b.name || `${b.cameras.length}_камер`)}[${stamp}].${ext}` }];
      return b.cameras.map((c, i) => ({ uid: c.uid, name: `${b.name ? expClean(b.name) + (b.cameras.length > 1 ? `_${i + 1}` : "") : cam(c)}[${stamp}].${ext}` }));
    }
    // Все отказы заказа по порядку полей. Первый — ответ POST /exports, все — POST /exports/check
    function expProblems(b) {
      const out = [], R = expRef(), L = R.limits, g = expGrant(), add = (status, code, message, field, params) => out.push(expBad(status, code, message, field, params));
      if (!g.allowed) add(403, "PERMISSION_DENIED", "Нет права на выгрузку");
      if (g.refusal) add(403, "PERMISSION_DENIED", g.refusal, undefined, g.privacyForced ? { reason: "privacy" } : undefined);
      const f = R.formats.find((x) => x.id === b.format), live = b.source === "live";
      if (!f) add(422, "NOT_SUPPORTED", "Такого формата нет", "/format");
      else if (f.kind !== b.mode || (live ? !f.entries.includes("live") : !f.entries.includes("archive"))) add(422, "NOT_SUPPORTED", "Формат не подходит к выгрузке", "/format");
      if (b.mode === "video" && !can("exportVideo")) add(422, "NOT_SUPPORTED", "Видео система не выгружает", "/mode");
      if (b.mode === "frame" && !live && !can("exportFrame")) add(422, "NOT_SUPPORTED", "Кадр архива система не выгружает", "/mode");
      if (live && (b.mode !== "frame" || !can("exportLiveFrame"))) add(422, "NOT_SUPPORTED", "Живым бывает только кадр", "/source");
      if (b.cameras.length > L.maxCameras) add(422, "LIMIT_EXCEEDED", "Слишком много камер", "/cameras", { limit: "maxCameras", max: L.maxCameras });
      if (b.cameras.length > 1 && !can("exportMultiCamera")) add(422, "NOT_SUPPORTED", "Одна камера в задании", "/cameras");
      if (b.cameras.length > 1 && b.mode === "frame") add(422, "NOT_SUPPORTED", "Кадр — одной камеры", "/cameras");
      b.cameras.forEach((c, i) => {
        const u = store.get(c.uid), rec = expCam(c.uid), w = `/cameras/${i}`;
        if (!u) return add(404, "NOT_FOUND", "Камеры нет", w);
        if (!rec) return add(422, "NOT_SUPPORTED", `Вид ${u.kind} не реализует vms.camera/1: выгрузка — только у камеры`, w, { kind: u.kind, profile: "vms.camera/1" });
        if ((db.stand.otherCluster || {})[rec.id]) add(409, "OTHER_CLUSTER", "Камера другого кластера: выгрузка через него", w, { url: db.stand.otherCluster[rec.id] });
        if ((db.stand.exportDenied || []).includes(rec.id)) add(403, "PERMISSION_DENIED", "Нет права на эту камеру", w);
        if (live && rec.online === false) add(409, "DEVICE_OFFLINE", "Камера без связи", w);
        const a = c.area;
        if (a) {
          if (!can("exportArea")) add(422, "NOT_SUPPORTED", "Область кадра система не обрезает", `${w}/area`);
          else if (!(a.w > 0 && a.h > 0 && a.x + a.w <= 1 + 1e-9 && a.y + a.h <= 1 + 1e-9)) add(422, "VALIDATION_FAILED", "Область выходит за кадр или пуста", `${w}/area`);
        }
      });
      if (b.mode === "video") {
        const ps = b.periods || [];
        if (!ps.length) add(422, "VALIDATION_FAILED", "Укажите отрезок", "/periods");
        if (ps.length > L.maxPeriods) add(422, "LIMIT_EXCEEDED", "Слишком много отрезков", "/periods", { limit: "maxPeriods", max: L.maxPeriods });
        if (ps.length > 1 && !can("exportMultiPeriod")) add(422, "NOT_SUPPORTED", "Один отрезок в задании", "/periods");
        ps.forEach((p, i) => { if (!(Date.parse(p.to) > Date.parse(p.from))) add(422, "VALIDATION_FAILED", "Конец позже начала", `/periods/${i}/to`); else if (Date.parse(p.from) > now()) add(422, "VALIDATION_FAILED", "Отрезок в будущем", `/periods/${i}/from`); });
        if (expSec(b) * b.cameras.length > L.maxTotalSec) add(422, "LIMIT_EXCEEDED", "Видео в задании слишком много", "/periods", { limit: "maxTotalSec", max: L.maxTotalSec });
        const recs = b.cameras.map((c) => expCam(c.uid)).filter(Boolean);
        ps.forEach((p, i) => { if (Date.parse(p.to) > Date.parse(p.from) && recs.length && !recs.some((r) => expOverlap(r, Date.parse(p.from), Date.parse(p.to)))) add(422, "NO_RECORDING", "В отрезке нет записи", `/periods/${i}`); });
      }
      if (b.mode === "frame" && !live) {
        const at = Date.parse(b.at), rec = expCam((b.cameras[0] || {}).uid);
        if (!(at > 0)) add(422, "VALIDATION_FAILED", "Укажите момент кадра", "/at");
        else if (rec && !expOverlap(rec, at - 10000, at + 1)) add(422, "NO_RECORDING", "В этот момент записи нет", "/at");
      }
      if (b.singleFile && b.cameras.length > 1 && !(can("exportSingleFile") && f && f.singleFile === "tracks")) add(422, "NOT_SUPPORTED", "«В один файл» — только MKV", "/singleFile");
      if (b.password && !can("exportPassword")) add(422, "NOT_SUPPORTED", "Пароль система не ставит", "/password");
      if (g.passwordRequired && !b.password && !g.refusal) add(422, "PASSWORD_REQUIRED", "Политика требует пароль", "/password");
      const q = b.quality || {};
      if (q.codec && f && !f.codecs.includes(q.codec)) add(422, "NOT_SUPPORTED", "Кодек не подходит к формату", "/quality/codec");
      if (expTranscode(Object.assign({}, b, { cameras: [] })) && !can("exportTranscode")) add(422, "NOT_SUPPORTED", "Перекодирование система не делает", "/quality");
      if ((b.titles || {}).fields && b.titles.fields.length && !can("exportTitles")) add(422, "NOT_SUPPORTED", "Титры система не накладывает", "/titles");
      if (((b.titles || {}).eventSource || {}).on && !can("exportEventTitles")) add(422, "NOT_SUPPORTED", "Титров источника событий система не накладывает", "/titles/eventSource");
      if ((b.titles || {}).overlay === "soft" && f && !f.softTitles) add(422, "NOT_SUPPORTED", "Программные титры — не в этом формате", "/titles/overlay");
      const sp = b.special || {};
      if (sp.audio && !can("exportAudio")) add(422, "NOT_SUPPORTED", "Звук система не выгружает", "/special/audio");
      if (sp.player && !(can("exportPlayer") && f && f.player)) add(422, "NOT_SUPPORTED", "Плеера нет", "/special/player");
      if (sp.maxFileMb > L.maxFileMbMax) add(422, "LIMIT_EXCEEDED", "Часть файла больше предела", "/special/maxFileMb", { limit: "maxFileMbMax", max: L.maxFileMbMax });
      if (b.highlight && !can("exportTracks")) add(422, "NOT_SUPPORTED", "Треков система не рисует", "/highlight");
      if (b.privacy && b.privacy.mode !== "none" && !can("exportPrivacy")) add(422, "NOT_SUPPORTED", "Маскирования нет", "/privacy");
      // Надзор над выгрузкой — по выдаче прав, от accessSupervision не зависит. Кто подходит — задаёт стенд (stand.exportSupervisor)
      if (g.supervisorRequired) {
        const s = b.supervisor, right = expSupervisor();
        if (!s) add(403, "SUPERVISOR_REQUIRED", "Нужно подтверждение супервизора", "/supervisor");
        else if (s.login === myLogin() || s.login !== right.login || s.password !== right.password) add(403, "SUPERVISOR_REJECTED", "Супервизор не подтвердил", "/supervisor");
      }
      if (b.destination === "cloud" && !can("exportCloud")) add(422, "NOT_SUPPORTED", "Выгрузки в облако нет", "/destination");
      return out;
    }
    const expPublic = (b) => { const r = clone(b); delete r.password; if (r.supervisor) delete r.supervisor.password; delete r.idempotencyKey; return r; };
    // Ход части: длительность по объёму, кадр — за секунду с небольшим. Состояние считается в tick, не по таймеру браузера
    let expWork = new Map();
    function expMake(b, retryOf) {
      const g = expGrant(), live = b.source === "live", t = now(), names = expNames(b);
      const span = b.mode === "video" ? { from: iso(Math.min(...b.periods.map((p) => Date.parse(p.from)))), to: iso(Math.max(...b.periods.map((p) => Date.parse(p.to)))) } : { at: iso(live ? t : Date.parse(b.at)) };
      const x = { id: uuid("export"), state: "queued", createdAt: iso(t), by: myLogin(), progress: { percent: 0, done: 0, total: b.cameras.length },
        parts: b.cameras.map((c) => Object.assign({ uid: c.uid, state: "wait", percent: 0 }, span)), files: [], request: expPublic(b),
        enforced: { privacy: g.privacyForced, watermark: g.watermark, password: g.passwordRequired }, transcode: expTranscode(b) };
      if (b.supervisor && g.supervisorRequired) x.supervisedBy = b.supervisor.login;
      if (retryOf) x.retryOf = retryOf;
      const sec = expSec(b), dur = b.mode === "frame" ? 1200 : Math.min(2500 + (sec / 3600) * (x.transcode ? 9000 : 4000), 15000);
      expWork.set(x.id, { start: t + 300, dur, names, sentAt: 0, sizes: b.cameras.map(() => (b.mode === "frame" ? 180000 + Math.floor(Math.random() * 90000) : Math.max(1, Math.round(sec * (x.transcode ? 220000 : 500000))))) });
      expAll().push(x);
      return x;
    }
    function expPartFate(x, i) {
      const b = x.request, rec = expCam(x.parts[i].uid), fail = (db.stand.exportFail || {})[x.parts[i].uid];
      if (fail) return { state: "fail", code: fail };
      if (!rec) return { state: "fail", code: "unreachable" };
      if (b.source === "live") return rec.online === false ? { state: "fail", code: "offline" } : { state: "ok" };
      if (b.mode === "frame") return expOverlap(rec, Date.parse(b.at) - 10000, Date.parse(b.at) + 1) ? { state: "ok" } : { state: "fail", code: "no_recording" };
      const has = b.periods.map((p) => expOverlap(rec, Date.parse(p.from), Date.parse(p.to)));
      if (!has.some(Boolean)) return { state: "fail", code: "no_recording" };
      const spans = hTimeline.camSpans(rec, pctx);
      const full = b.periods.every((p) => spans.some((s) => s.startMs <= Date.parse(p.from) && s.endMs >= Date.parse(p.to)));
      return full ? { state: "ok" } : { state: "ok", partial: true };
    }
    const expMedia = { mkv: "video/x-matroska", mp4: "video/mp4", avi: "video/x-msvideo", jpg: "image/jpeg", pdf: "application/pdf", zip: "application/zip" };
    function expFinish(x, w) {
      const done = x.parts.filter((p) => p.state === "ok");
      x.state = x.state === "cancelled" ? "cancelled" : done.length ? "done" : "failed";
      x.finishedAt = iso(now());
      if (x.state === "done") {
        const keep = now() + expRef().limits.keepSec * 1000, single = w.names.length === 1 && x.parts.length > 1;
        x.files = (single ? [w.names[0]] : x.parts.map((p, i) => (p.state === "ok" ? w.names[i] : null))).map((n, i) => n && {
          id: `f${i + 1}`, uid: single ? undefined : x.parts[i].uid, name: n.name, sizeBytes: single ? w.sizes.reduce((a, b2) => a + b2, 0) : w.sizes[i],
          sha256: (x.id.replace(/-/g, "") + "0".repeat(64)).slice(0, 56) + String(i + 1).padStart(8, "0"), mediaType: expMedia[n.name.split(".").pop()] || "application/octet-stream", expiresAt: iso(keep) }).filter(Boolean);
        x.files.forEach((f) => f.uid === undefined && delete f.uid);
        x.expiresAt = iso(keep);
      }
      x.progress = { percent: 100, done: x.parts.filter((p) => p.state !== "wait" && p.state !== "run").length, total: x.parts.length };
      send("export.finished", { kind: "exportJob", entityId: x.id, payload: { state: x.state, files: clone(x.files) } });
    }
    function exportTick() {
      const t = now();
      expAll().forEach((x) => {
        if (x.state === "done" && x.expiresAt && Date.parse(x.expiresAt) <= t) {
          x.state = "expired"; x.files = [];
          send("entity.changed", { kind: "exportJob", entityId: x.id });
          return;
        }
        if (x.state !== "queued" && x.state !== "running") return;
        const w = expWork.get(x.id);
        if (!w || t < w.start) return;
        x.state = "running";
        let moved = false;
        x.parts.forEach((p, i) => {
          if (p.state !== "wait" && p.state !== "run") return;
          // Части идут рядом со своими записями, поэтому параллельно; у каждой свой темп
          const pct = Math.min(100, Math.floor(((t - w.start) / (w.dur * (1 + i * 0.15))) * 100));
          if (pct < 100) { if (p.state !== "run" || pct - p.percent >= 5) { p.state = "run"; p.percent = pct; moved = true; } return; }
          const fate = expPartFate(x, i);
          Object.assign(p, { state: fate.state, percent: fate.state === "ok" ? 100 : p.percent });
          if (fate.code) p.code = fate.code;
          if (fate.partial) p.partial = true;
          moved = true;
        });
        const finished = x.parts.filter((p) => p.state !== "wait" && p.state !== "run").length;
        x.progress = { percent: Math.floor(x.parts.reduce((n, p) => n + (p.state === "run" || p.state === "ok" ? p.percent : p.state === "wait" ? 0 : 100), 0) / x.parts.length), done: finished, total: x.parts.length };
        if (finished === x.parts.length) return expFinish(x, w);
        if (moved && t - w.sentAt >= 400) { w.sentAt = t; send("export.progress", { kind: "exportJob", entityId: x.id, payload: { progress: clone(x.progress), parts: clone(x.parts) } }); }
      });
    }
    const expFind = (id) => expAll().find((e) => e.id === id);

    /* ===== Маршруты ===== */

    const notFound = (what) => problem(404, "NOT_FOUND", `${what} не найден(а)`);
    // Путь ядра /units/{uid}/…: вид объекта реализует профиль. field отказа — указатель: свойство объекта — /properties/…,
    // поле тела — /<имя> (тело — та же схема, что у старого пути), тип записи — /kind
    const SUBJECT_POINTER = { type: "/kind", ptz: "/properties/ptz", direct: "/properties/direct" };
    function subject(uid, profile, fn) {
      const u = store.get(uid);
      if (!u) return notFound("Объект");
      if (tableOf(u.kind) !== "devices" || !kinds.profileOf(u.kind, profile)) return problem(422, "NOT_SUPPORTED", `Вид ${u.kind} не реализует ${profile}`, { field: "/kind", params: { kind: u.kind, profile } });
      // Право на профиль — UnitKind.apiRights (PTZ камеры — класс tel); нет записи — не судится
      const denied = rightProblem(u, ((kinds.get(u.kind) || {}).apiRights || {})[profile], `Пути ${profile} нужно право ${profile}`);
      if (denied) return denied;
      const res = fn(legacy.view(u));
      const f = res && res.status >= 400 && res.body ? res.body.field : undefined;
      if (f == null || String(f).startsWith("/")) return res;
      return { status: res.status, body: Object.assign({}, res.body, { field: SUBJECT_POINTER[f] || `/${f}` }) };
    }
    // Пресеты по хуку vms.ptz/1: отказ, «менять нечего» или новый состав; ответ — объект
    function presetsDone(rec, r) {
      if (Profiles.isProblem(r)) return r;
      if (!r.same) setPresets(rec, r.presets);
      return one(unitView(store.get(rec.id)));
    }
    function getter(table, label) {
      const show = (r) => (table === "rules" ? ruleView(r) : clone(r));
      return [
        ["GET", `/${table}`, () => items(db[table].map(show))],
        [
          "GET",
          `/${table}/{id}`,
          (p) => {
            const rec = byId(table, p.id);
            return rec ? one(show(rec)) : notFound(label);
          },
        ],
      ];
    }

    // Без связи с доменом сервер входа видит только свой кластер: первый сервер домена, если стенд не сказал иначе
    function hiddenServers() {
      const out = new Set();
      db.domains.filter((d) => d.online === false && d.stand !== "own").forEach((d) => {
        const mine = db.servers.filter((s) => s.domainId === d.id && s.allocated);
        if (!mine.length || !mine[0].name.includes("/")) return;
        const own = mine[0].name.slice(0, mine[0].name.indexOf("/"));
        mine.forEach((s) => { if (!s.name.startsWith(own + "/")) out.add(s.id); });
      });
      return out;
    }
    const ROUTES = [
      [
        "GET",
        "/me",
        () => {
          const u = db.access.users.find((x) => x.id === me);
          return { status: 200, body: { userId: u.id, login: u.login, name: u.name, serverTime: iso(now()), timezone: db.timezone } };
        },
      ],
      ["GET", "/reference", () => {
        const ref = clone(db.reference);
        ref.serverLabels = [...new Set((ref.serverLabels || []).concat(db.servers.flatMap((s) => s.labels || [])))];
        return { status: 200, body: ref };
      }],
      ["GET", "/domains/{id}/relays", (p) => (byId("domains", p.id) ? items(Object.keys((db.relays || {})[p.id] || {}).sort().map((name) => ({ name }))) : notFound("Домен"))],
      ["GET", "/domains/{id}/relays/{name}", (p) => {
        const r = byId("domains", p.id) && ((db.relays || {})[p.id] || {})[p.name];
        return r ? { status: 200, body: { name: p.name, members: r.slice().sort() } } : notFound("Ретранслятор");
      }],
      ["GET", "/domains/{id}/scenarios", (p) => (byId("domains", p.id) ? one(clone(scenarioDoc(p.id))) : notFound("Домен"))],
      ["PUT", "/domains/{id}/scenarios", (p, q, body, headers) => {
        const dom = byId("domains", p.id);
        if (!dom) return notFound("Домен");
        if (!holdsAdmin(db.access, me)) return problem(403, "PERMISSION_DENIED", "Документ ведёт администратор домена");
        const doc = scenarioDoc(p.id);
        const bad = precondition(doc, headers) || (dom.online === false ? problem(409, "SERVER_OFFLINE", "Нет связи с доменом") : null) || scenarioProblem(body.items);
        if (bad) return bad;
        doc.items = clone(body.items);
        bump(doc);
        send("entity.changed", { kind: "scenarios", entityId: p.id, version: doc.version });
        return one(clone(doc));
      }],
      ["GET", "/domains/{id}/scenarios/status", (p) => {
        if (!byId("domains", p.id)) return notFound("Домен");
        const doc = scenarioDoc(p.id), st = (db.scenarioStatus || {})[p.id] || {};
        return items(doc.items.filter((x) => st[x.name]).map((x) => clone(st[x.name])));
      }],
      ["GET", "/tree/children", (p, q) => treeChildren(q)],
      ["GET", "/tree/paths", (p, q) => treePaths(q)],
      /* ----- Ядро: виды и объекты ----- */
      ["GET", "/kinds", (p, q, body, headers) => kindsList(headers)],
      ["GET", "/kinds/{kind}", (p) => {
        const k = kinds.get(p.kind);
        return k ? { status: 200, body: clone(k), headers: { ETag: kinds.etag() } } : notFound(`Вид ${p.kind}`);
      }],
      ["GET", "/units", (p, q) => unitsPage(q)],
      ["GET", "/units/{uid}", (p) => {
        const u = store.get(p.uid);
        return u ? one(unitView(u)) : notFound("Объект");
      }],
      ["GET", "/units/{uid}/schema", (p) => {
        const u = store.get(p.uid);
        if (!u) return notFound("Объект");
        const k = kinds.get(u.kind);
        if (!k || !k.schemaPerUnit) return problem(422, "NOT_SUPPORTED", "Схема своя только у объектов вида со schemaPerUnit: у остальных — схема вида, GET /kinds/{kind}");
        return { status: 200, body: kinds.unitSchema(u.kind, u.properties), headers: { ETag: `"${u.version}"` } };
      }],
      ["GET", "/units/{uid}/creatable", (p) => {
        const u = store.get(p.uid);
        return u ? { status: 200, body: { items: creatableOf(u) } } : notFound("Объект");
      }],
      /* ----- Ядро: запись объектов видов без профиля ----- */
      ["POST", "/units", (p, q, body) => {
        const done = [], failed = [];
        body.items.forEach((spec, index) => {
          const errs = unitCreateErrs(spec, null, "");
          if (errs.length) return failed.push(Object.assign({ index }, errOut(errs[0]), { errors: errs.map(errOut) }));
          const made = unitMake(spec, spec.parentId ? store.get(spec.parentId) : null);
          done.push({ index, units: made.map((u) => unitView(u)) });
          recordSingle([{ targetId: made[0].uid, version: made[0].version, createdId: made[0].uid, createdVersion: made[0].version, before: { unitRemove: made[0].uid }, req: { uid: made[0].uid, createUnit: clone(spec) } }]);
        });
        return { status: 200, body: { done, failed } };
      }],
      ["POST", "/units/validate", (p, q, body) => {
        // Строка — либо правка объекта (uid + patch), либо создание (create): обе сразу — неясно, что проверять
        const both = body.items.findIndex((x) => x.create && (x.uid !== undefined || x.patch !== undefined));
        if (both >= 0) return problem(422, "VALIDATION_FAILED", "В строке либо uid с patch, либо create", { field: `/items/${both}` });
        return {
        status: 200,
        body: {
          items: body.items.map((x, index) => {
            const u = x.create ? null : store.get(x.uid);
            const errs = x.create ? unitCreateErrs(x.create, null, "") : !u ? [err("NOT_FOUND", "/uid")] : unitPatchErrs(u, x.patch);
            return errs.length ? { index, ok: false, errors: errs.map(errOut) } : { index, ok: true };
          }),
        },
        };
      }],
      ["PATCH", "/units/{uid}", (p, q, body, headers) => {
        const u = store.get(p.uid);
        if (!u) return notFound("Объект");
        const bad = unitPrecondition(u, headers) || (membersOnly(u, body) ? null : kindProblem(u.kind));
        if (bad) return bad;
        // Копия: хук может привести правку к виду записи (имя без пробелов по краям)
        const patch = clone(body);
        const errs = unitPatchErrs(u, patch);
        if (errs.length) return errsProblem(errs, "Правка не подходит под описание вида");
        const held = hooksProblem(u.kind, "beforeApply", [u, patch, false]);
        if (held) return hookProblem(held, undefined, u.kind);
        const before = applyUnitPatch(u, patch);
        unitChanged(u, true);
        recordSingle([{ targetId: u.uid, version: u.version, before: { unitPatch: before }, after: unitFieldsOf(u, patch), secret: touchesSecret(u, patch), req: { uid: u.uid, patch: clone(body) } }]);
        return one(unitView(u));
      }],
      ["DELETE", "/units/{uid}", (p, q, body, headers) => {
        const u = store.get(p.uid);
        if (!u) return notFound("Объект");
        const bad = unitPrecondition(u, headers) || kindProblem(u.kind);
        if (bad) return bad;
        // Параметры удаления — в запросе: moveTo у домена (куда перенести содержимое)
        const params = q.moveTo !== undefined ? { moveTo: q.moveTo } : {};
        const errs = unitDeleteErrs(u, params);
        if (errs.length) return errsProblem(errs, "Удалить нельзя");
        const version = u.version;
        const rem = hookOf(u.kind, "remove");
        if (rem) {
          // Своё удаление профиля: в стопке — шаг, который назад не вернуть (record), как у DELETE старых путей
          if (hookRemove(rem, u, params).record) recordSingle([{ targetId: u.uid, version, before: { deleted: true }, req: { uid: u.uid, delete: true } }]);
          return { status: 204, body: null };
        }
        const locked = lockedProblem(unitSubtree(u).map((x) => x.uid), held);
        if (locked) return locked;
        recordSingle([{ targetId: u.uid, version, before: { restore: unitRemoveTree(u) }, req: { uid: u.uid, delete: true } }]);
        return { status: 204, body: null };
      }],
      ["POST", "/units/{uid}/move", (p, q, body, headers) => {
        const u = store.get(p.uid);
        if (!u) return notFound("Объект");
        const bad = unitPrecondition(u, headers) || kindProblem(u.kind);
        if (bad) return bad;
        const errs = unitMoveErrs(u, body.parentId, body.params);
        if (errs.length) return errsProblem(errs, "Под этим родителем объекту этого вида не место");
        const mv = hookOf(u.kind, "move");
        // Перенос со смыслом (сервер: приём в домен, исключение) — в стопке отката, если его можно вернуть. Ответ — объект после
        // переноса: у камеры w2c, принятой в домен, это новая запись
        if (mv) {
          const res = hookMove(mv, u, body.parentId == null ? null : body.parentId, body.params);
          if (res.before.back) recordSingle([{ targetId: u.uid, version: u.version, before: res.before, req: { uid: u.uid, move: body.parentId == null ? null : body.parentId, params: clone(body.params || {}) } }]);
          return one(unitView(res.unit));
        }
        const was = applyUnitMove(u, body.parentId);
        recordSingle([{ targetId: u.uid, version: u.version, before: { parentId: was }, after: { parentId: u.parentId }, req: { uid: u.uid, move: u.parentId } }]);
        return one(unitView(u));
      }],
      // Команда вида без объекта (ActionDescriptor.scope ∋ kind): определить модель, опросить адреса, проверить подключение до
      // создания. Поведение — тот же хук профиля, что у команды объекта; объекта у хука нет — черновик с кодом вида
      ["POST", "/kinds/{kind}/actions/{action}", (p, q, body) => {
        if (!kinds.get(p.kind)) return notFound(`Вид ${p.kind}`);
        const desc = kindCommand(p.kind, p.action);
        if (!desc) return problem(404, "NOT_FOUND", `Команды ${p.action} без объекта у вида ${p.kind} нет`);
        const params = body.params || {};
        const refused = kindRightProblem(p.kind, desc);
        if (refused) return refused;
        const errs = actionParamErrs(desc, params);
        if (errs.length) return errsProblem(errs, "Параметры команды не подходят под ActionDescriptor.params");
        const run = actionRun(p.kind, desc.id);
        if (!run) return { status: 200, body: { result: actionResult(desc) } };
        const res = run({ uid: null, kind: p.kind, parentId: null, domainId: null, name: "", properties: {}, status: {} }, clone(params), pctx, desc.id);
        if (Profiles.isProblem(res)) return hookProblem(res, "/params/", p.kind);
        return { status: 200, body: { result: res.result } };
      }],
      ["POST", "/units/{uid}/actions/{action}", (p, q, body) => {
        const u = store.get(p.uid);
        if (!u) return notFound("Объект");
        const bad = kindProblem(u.kind);
        if (bad) return bad;
        const desc = unitCommand(u.kind, p.action);
        if (!desc) return strayCommandProblem(u, p.action) || problem(404, "NOT_FOUND", `Команды ${p.action} у вида ${u.kind} нет`);
        const params = body.params || {};
        const refused = actionProblem(u, desc, params) || lockedProblem([u.uid]);
        if (refused) return refused;
        // Команда с поведением (хук профиля): итог сразу или долгая — операция, которая идёт до срока хука
        const run = actionRun(u.kind, desc.id);
        if (run) {
          const res = run(u, clone(params), pctx, desc.id);
          if (Profiles.isProblem(res)) return hookProblem(res, "/params/", u.kind);
          if (res.operation) {
            const op = startOperation([Object.assign({ uid: u.uid, action: desc.id, params: clone(params), until: res.operation.until }, res.operation.free ? { free: true } : {})], { noUndo: true });
            op.nextAt = res.operation.until;
            return { status: 202, body: opView(op) };
          }
          return { status: 200, body: { result: res.result, unit: unitView(store.get(u.uid) || u) } };
        }
        // Долгая команда — операция из одного шага: в стопку отката не попадает, назад её не вернуть
        if (desc.execution === "longRunning") return { status: 202, body: opView(startOperation([{ uid: u.uid, action: desc.id, params: clone(params) }], { noUndo: true })) };
        const result = runAction(u, desc, params);
        return { status: 200, body: { result, unit: unitView(u) } };
      }],
      ...getter("rules", "Правило"),
      /* ----- Просмотр: разговор, шкала, куски, удержания, отметки ----- */
      [
        "DELETE",
        "/holds/{id}",
        (p) => {
          const i = hTimeline.holdsAll(pctx).findIndex((h) => h.id === p.id);
          if (i < 0) return notFound("Удержание");
          if (db.stand.keepDenied) return problem(403, "PERMISSION_DENIED", "Нет права снимать удержание");
          const [h] = hTimeline.holdsAll(pctx).splice(i, 1);
          send("entity.deleted", { kind: "hold", entityId: h.id, payload: { deviceId: h.deviceId } });
          return { status: 204, body: null };
        },
      ],
      [
        "POST",
        "/holds/{id}/verify",
        (p) => {
          const h = hTimeline.holdsAll(pctx).find((x) => x.id === p.id);
          if (!h) return notFound("Удержание");
          return { status: 200, body: { results: h.recordingIds.map((recordingId) => ({ recordingId, result: db.stand.holdVerify || "ok" })) } };
        },
      ],
      /* ----- Предметные API объекта (/units/{uid}/…): вид объекта реализует профиль (vms.live/1, vms.talk/1, vms.timeline/1,
         vms.ptz/1, vms.camera/1). Тела и ответы — те же схемы, что у старых путей (у пресетов и назначения записи — объект Unit);
         смысл — те же хуки. Нет объекта — 404, вид без профиля — 422 NOT_SUPPORTED, field /kind ----- */
      ["POST", "/units/{uid}/live", (p, q, body) => subject(p.uid, "vms.live/1", (rec) => hLive.start(rec, body, pctx))],
      ["PUT", "/units/{uid}/live", (p, q, body) => subject(p.uid, "vms.live/1", (rec) => hLive.move(rec, body, pctx))],
      ["POST", "/units/{uid}/talk", (p) => subject(p.uid, "vms.talk/1", (rec) => hTalk.start(rec, pctx))],
      ["GET", "/units/{uid}/timeline", (p, q) => subject(p.uid, "vms.timeline/1", (rec) => hTimeline.spans(rec, q, pctx))],
      ["GET", "/units/{uid}/playback", (p, q) => subject(p.uid, "vms.timeline/1", (rec) => hTimeline.playback(rec, q, pctx))],
      ["GET", "/units/{uid}/holds", (p, q) => subject(p.uid, "vms.timeline/1", (rec) => hTimeline.holds(rec, q, pctx))],
      ["POST", "/units/{uid}/holds", (p, q, body) => subject(p.uid, "vms.timeline/1", (rec) => hTimeline.hold(rec, body, pctx))],
      ["GET", "/units/{uid}/bookmarks", (p, q) => subject(p.uid, "vms.timeline/1", (rec) => hTimeline.bookmarks(rec, q, pctx))],
      ["POST", "/units/{uid}/bookmarks", (p, q, body) => subject(p.uid, "vms.timeline/1", (rec) => hTimeline.bookmark(rec, body, pctx))],
      ["POST", "/units/{uid}/archive-fetch", (p, q, body) => subject(p.uid, "vms.timeline/1", (rec) => hTimeline.fetch(rec, body, pctx))],
      ["PUT", "/units/{uid}/ptz", (p, q, body) => subject(p.uid, "vms.ptz/1", (rec) => hPtz.lease(rec, body, me, pctx))],
      ["DELETE", "/units/{uid}/ptz", (p) => subject(p.uid, "vms.ptz/1", (rec) => hPtz.release(rec, me, pctx))],
      ["PUT", "/units/{uid}/presets/{n}", (p, q, body) => subject(p.uid, "vms.ptz/1", (rec) => presetsDone(rec, hPtz.put(rec, Number(p.n), body, pctx)))],
      ["DELETE", "/units/{uid}/presets/{n}", (p) => subject(p.uid, "vms.ptz/1", (rec) => presetsDone(rec, hPtz.drop(rec, Number(p.n), pctx)))],
      ["PUT", "/units/{uid}/recording-target", (p, q, body) => subject(p.uid, "vms.camera/1", (rec) => hCamera.setTarget(rec, body, pctx) || one(unitView(store.get(rec.id))))],
      // Сутки с записью для календаря окна выгрузки: камера — профилем vms.camera/1, сутки — по шкале хука vms.timeline/1
      ["GET", "/units/{uid}/recording-days", (p, q) => subject(p.uid, "vms.camera/1", (rec) => hTimeline.days(rec, q, pctx))],
      /* ----- Выгрузка: камеры заказа — по uid ----- */
      [
        "GET",
        "/me/export",
        (p, q) => {
          const g = expGrant(), ids = q.ids ? String(q.ids).split(",").filter(Boolean) : [];
          const lim = db.reference.limits.idsMax || 200;
          if (ids.length > lim) return problem(422, "VALIDATION_FAILED", `Не больше ${lim} id`, { field: "ids" });
          const body = { allowed: g.allowed, passwordRequired: g.passwordRequired, privacyForced: g.privacyForced, supervisorRequired: g.supervisorRequired, watermark: g.watermark, depthHours: g.depthHours,
            devices: ids.map((uid) => { const rec = expCam(uid), no = !rec || (db.stand.exportDenied || []).includes(uid) || !g.allowed;
              return { uid, archive: !no, live: !no && rec.online !== false }; }) };
          if (g.refusal) body.refusal = g.refusal;
          return { status: 200, body };
        },
      ],
      [
        "POST",
        "/exports/check",
        (p, q, body) => {
          const errs = expProblems(body), sec = expSec(body), tr = expTranscode(body);
          const noRec = [];
          if (body.mode === "video") body.cameras.map((c) => expCam(c.uid)).forEach((r, ci) => r && (body.periods || []).forEach((pp, pi) => { if (Date.parse(pp.to) > Date.parse(pp.from) && !expOverlap(r, Date.parse(pp.from), Date.parse(pp.to))) noRec.push({ camera: ci, period: pi }); }));
          const bytes = body.mode === "frame" ? 220000 : Math.round(sec * body.cameras.length * (tr ? 220000 : 500000));
          return { status: 200, body: { ok: !errs.length, errors: errs.map((e) => e.body), transcode: tr, estimate: { bytes, sec: body.mode === "frame" ? 2 : Math.max(3, Math.round(sec / (tr ? 8 : 120))) }, files: expNames(body), noRecording: noRec } };
        },
      ],
      [
        "GET",
        "/exports",
        (p, q) => {
          const states = q.state ? String(q.state).split(",") : null, mine = q.mine === "true", login = myLogin();
          const rows = expAll().filter((x) => (!mine || x.by === login) && (!states || states.includes(x.state)));
          return pageList(q, `exports:${mine}:${q.state || ""}`, rows, (x) => `${backTime(x.createdAt)}|${x.id}`, clone);
        },
      ],
      [
        "POST",
        "/exports",
        (p, q, body) => {
          const errs = expProblems(body);
          if (errs.length) return errs[0];
          const login = myLogin(), active = expAll().filter((x) => x.by === login && (x.state === "queued" || x.state === "running")).length, max = expRef().limits.maxActivePerUser;
          if (active >= max) return problem(409, "BUSY", "Активных выгрузок слишком много: дождитесь или отмените", { params: { limit: "maxActivePerUser", max } });
          const x = expMake(body);
          send("entity.created", { kind: "exportJob", entityId: x.id });
          return { status: 202, body: clone(x), headers: { Location: `/exports/${x.id}` } };
        },
      ],
      ["GET", "/exports/{id}", (p) => { const x = expFind(p.id); return x ? { status: 200, body: clone(x) } : notFound("Выгрузка"); }],
      [
        "DELETE",
        "/exports/{id}",
        (p) => {
          const i = expAll().findIndex((e) => e.id === p.id);
          if (i < 0) return notFound("Выгрузка");
          if (expAll()[i].by !== myLogin()) return problem(403, "PERMISSION_DENIED", "Чужую выгрузку удаляет администратор выгрузки камеры");
          expAll().splice(i, 1);
          expWork.delete(p.id);
          send("entity.deleted", { kind: "exportJob", entityId: p.id });
          return { status: 204, body: null };
        },
      ],
      [
        "POST",
        "/exports/{id}/cancel",
        (p) => {
          const x = expFind(p.id);
          if (!x) return notFound("Выгрузка");
          if (x.by !== myLogin()) return problem(403, "PERMISSION_DENIED", "Отменяет автор");
          if (x.state !== "queued" && x.state !== "running") return problem(409, "NOT_RUNNABLE", "Выгрузка уже закончилась");
          // Готовые части тоже отменяются: их файлы удаляются вместе с заданием
          x.parts.forEach((pp) => { if (pp.state === "wait" || pp.state === "run" || pp.state === "ok") pp.state = "cancel"; });
          x.state = "cancelled";
          x.files = [];
          expFinish(x, expWork.get(x.id) || { names: [] });
          return { status: 200, body: clone(x) };
        },
      ],
      [
        "POST",
        "/exports/{id}/retry-failed",
        (p, q, body) => {
          const x = expFind(p.id);
          if (!x) return notFound("Выгрузка");
          if (x.by !== myLogin()) return problem(403, "PERMISSION_DENIED", "Повторяет автор");
          const failed = new Set(x.parts.filter((pp) => pp.state === "fail" || pp.state === "cancel").map((pp) => pp.uid));
          if (!failed.size || x.state === "queued" || x.state === "running") return problem(409, "NOT_RUNNABLE", "Неудачных частей нет");
          const b = Object.assign(clone(x.request), { cameras: x.request.cameras.filter((c) => failed.has(c.uid)) });
          if (body && body.password) b.password = body.password;
          // Супервизор подтверждает каждый заказ: логин прежнего заказа не действует
          delete b.supervisor;
          if (body && body.supervisor) b.supervisor = body.supervisor;
          const errs = expProblems(b);
          if (errs.length) return errs[0];
          const n = expMake(b, x.id);
          send("entity.created", { kind: "exportJob", entityId: n.id });
          return { status: 202, body: clone(n), headers: { Location: `/exports/${n.id}` } };
        },
      ],
      [
        "POST",
        "/exports/{id}/files/{fileId}/link",
        (p) => {
          const x = expFind(p.id);
          if (!x) return notFound("Выгрузка");
          if (x.by !== myLogin()) return problem(403, "PERMISSION_DENIED", "Файл получает только автор");
          if (x.state === "expired") return problem(410, "EXPORT_EXPIRED", "Файл удалён по сроку");
          const f = x.files.find((ff) => ff.id === p.fileId);
          if (!f) return notFound("Файл");
          return { status: 200, body: { url: `stub://export/${x.id}/${f.id}/${encodeURIComponent(f.name)}?t=stub-${newVersion()}`, expiresAt: iso(now() + expRef().limits.linkTtlSec * 1000) } };
        },
      ],
      /* ----- Домен: поиск устройств (discovery); объекты домена — пути ядра /units ----- */
      [
        "POST",
        "/domains/{id}/discovery",
        (p) => {
          if (!byId("domains", p.id)) return notFound("Домен");
          const job = discoveryOf(p.id);
          if (job.state === "searching") return problem(409, "BUSY", "Поиск в сети домена уже идёт");
          // Новый поиск заменяет итог прежнего: найденное появляется по одному, как при настоящем опросе
          Object.assign(job, { state: "searching", progress: 0, startedAt: iso(now()), finishedAt: null, candidateIds: [] });
          // Первая находка — сразу, следующие — раз в 140 мс
          searches.set(p.id, { queue: db.network.filter((c) => c.domainIds.includes(p.id)).map((c) => c.id), total: 0, nextAt: now() });
          searches.get(p.id).total = searches.get(p.id).queue.length;
          if (!searches.get(p.id).total) finishDiscovery(p.id, "done");
          else tickDiscovery([]);
          return { status: 202, body: discoveryView(p.id) };
        },
      ],
      [
        "DELETE",
        "/domains/{id}/discovery",
        (p) => {
          if (!byId("domains", p.id)) return notFound("Домен");
          if (searches.has(p.id)) finishDiscovery(p.id, "stopped");
          return { status: 200, body: discoveryView(p.id) };
        },
      ],
      [
        "POST",
        "/objects/delete",
        (p, q, body) => {
          if (body.items.length > db.reference.limits.selectMax) return problem(422, "VALIDATION_FAILED", "Больше, чем selectMax: несколькими операциями, у каждой свой откат", { field: "items" });
          const done = [];
          const failed = [];
          const steps = [];
          body.items.forEach((x) => {
            // Объект склада — по uid, как DELETE /units/{uid}: вид со своим удалением (хук remove) — по хуку, в стопке шаг, который
            // назад не вернуть; остальные — каскадом ядра, откат возвращает их. Серверы и домены так не удаляют — NOT_FOUND
            const u = store.get(x.id);
            if (u && (kinds.profileOf(u.kind, "vms.server/1") || kinds.profileOf(u.kind, "vms.domain/1"))) return failed.push({ id: x.id, code: "NOT_FOUND" });
            if (u) {
              if (u.version !== x.version) return failed.push({ id: x.id, code: "VERSION_MISMATCH" });
              const errs = unitDeleteErrs(u);
              if (errs.length) return failed.push({ id: x.id, code: errs[0].code === "BUSY" ? "BUSY" : "NOT_SUPPORTED" });
              const rem = hookOf(u.kind, "remove");
              if (rem) {
                if (hookRemove(rem, u, {}).record) steps.push({ targetId: u.uid, version: u.version, before: { deleted: true }, req: { uid: u.uid, delete: true } });
                return done.push(x.id);
              }
              if (lockedProblem(unitSubtree(u).map((y) => y.uid), held)) return failed.push({ id: x.id, code: "BUSY" });
              const snap = unitRemoveTree(u);
              snap.forEach((y) => wasRemoved.add(y.unit.uid));
              done.push(x.id);
              return steps.push({ targetId: u.uid, version: u.version, before: { restore: snap }, req: { uid: u.uid, delete: true } });
            }
            // Правило — по id. Уже удалён вместе с родителем из этого же запроса — тоже удалён
            const rule = byId("rules", x.id);
            if (!rule) return done.includes(x.id) || wasRemoved.has(x.id) ? done.push(x.id) : failed.push({ id: x.id, code: "NOT_FOUND" });
            if (rule.version !== x.version) return failed.push({ id: x.id, code: "VERSION_MISMATCH" });
            if (lockedProblem(touchedBy("rules", rule), held)) return failed.push({ id: x.id, code: "BUSY" });
            removeRule(rule);
            done.push(x.id);
          });
          wasRemoved.clear();
          recordSingle(steps);
          return { status: 200, body: { done, failed } };
        },
      ],
      [
        "PUT",
        "/rules/{id}",
        (p, q, body, headers) => {
          const r = byId("rules", p.id);
          if (!r) return notFound("Правило");
          const bad = precondition(r, headers) || ruleRightProblem(body) || ruleProblem(body);
          if (bad) return bad;
          const was = ruleMeta(r);
          runsStop(r.id);
          RULE_CONTENT.forEach((k) => (r[k] = clone(body[k])));
          Object.assign(r, { changedAt: iso(now()), changedBy: myLogin() });
          bump(r);
          pushVersion(r, body.historyNote, was);
          changed("rule", r);
          return one(ruleView(r));
        },
      ],
      [
        "PATCH",
        "/settings",
        (p, q, body, headers) => {
          const s = db.settings;
          const bad = precondition(s, headers);
          if (bad) return bad;
          const alarms = body.values["alarms.domain"], known = eventCodes();
          if (alarms && alarms.some((k) => !known.has(k))) return problem(422, "VALIDATION_FAILED", "Такого вида события нет", { field: "alarms.domain" });
          Object.assign(s.values, clone(body.values));
          bump(s);
          send("entity.changed", { kind: "settings", version: s.version });
          return one(clone(s));
        },
      ],
      [
        "POST",
        "/access/apply",
        (p, q, body, headers) => {
          const a = db.access;
          if (body.version !== a.version) return problem(412, "VERSION_MISMATCH", "Запись изменилась с момента чтения", { current: accessSnapshot() });
          const next = accessNext(a, body.changes);
          if (next.status) return next;
          const touched = rolesTouched(a, next);
          // Состояние синхронизации ведёт сервер: у существующих каталогов и групп — его значения
          if (!next.streamGrants && a.streamGrants) next.streamGrants = clone(a.streamGrants);
          next.catalogs.forEach((c) => {
            const was = a.catalogs.find((x) => x.id === c.id);
            if (was) ["status", "lastSyncAt", "nextSyncAt", "durationSec", "message", "entries"].forEach((k) => (c[k] = clone(was[k])));
          });
          next.groups.forEach((g) => {
            const was = a.groups.find((x) => x.id === g.id);
            if (was && was.source && g.source) ["status", "at", "message"].forEach((k) => (g.source[k] = was.source[k]));
          });
          // Пароль — только на запись; hasPassword и passwordByAdmin ведёт сервер
          const passwords = new Map();
          next.users.forEach((u) => {
            if (u.password != null) passwords.set(u.id, u.password);
            delete u.password;
            const was = a.users.find((x) => x.id === u.id);
            SERVER_USER.forEach((k) => delete u[k]);
            if (was) SERVER_USER.forEach((k) => { if (k in was) u[k] = was[k]; });
            else u.hasPassword = false;
          });
          // Кто чужой почты не видел, её не правит: пустая строка из снимка — не правка
          if (!holdsAdmin(a, me) && !managesUsers(a, me)) next.users.forEach((u) => {
            const was = a.users.find((x) => x.id === u.id);
            if (was && u.id !== me && !u.email) u.email = was.email;
          });
          const why = accessProblem(next);
          if (why) return why;
          for (const [id, pwd] of passwords) {
            const u = next.users.find((x) => x.id === id);
            if (!u) continue;
            if (u.catalogId) return problem(422, "VALIDATION_FAILED", "Пароль хранится в каталоге", { field: "password", params: { id } });
            const weak = policyProblem(u, pwd);
            if (weak) return weak;
          }
          if (body.dryRun) return { status: 200, body: { applied: false, access: null }, headers: { ETag: etag(a) } };
          // Повтор на кластеры без изменений записей: версия снимка не меняется, меняется расхождение
          const again = body.retryClusters || [];
          const refused = applierProblem(a, next, passwords) || passwordProblem(a, next, passwords);
          if (refused) return refused;
          const admin = holdsAdmin(a, me);
          next.users.forEach((u) => {
            if (!passwords.has(u.id)) return;
            u.hasPassword = true;
            u.passwordByAdmin = admin || u.id === me;
          });
          const actor = (a.users.find((u) => u.id === me) || {}).login || "";
          const at = iso(now());
          const stamp = (kind, x) => Object.assign({ id: uuid(kind), at, actor }, clone(x));
          Object.assign(a, next, {
            history: body.history.map((h) => stamp("history", h)).concat(a.history),
            cellHistory: body.cellHistory.map((h) => stamp("history", h)).concat(a.cellHistory || []),
          });
          const spread = roleSpread(touched, again);
          bump(a);
          send("entity.changed", { kind: "access", version: a.version });
          return { status: 200, body: Object.assign({ applied: true, access: accessSnapshot(), clusters: clusterNames().length }, spread.length ? { notApplied: spread } : {}), headers: { ETag: etag(a) } };
        },
      ],
      [
        "POST",
        "/access/catalogs/{id}/sync",
        (p, q, body) => {
          const c = db.access.catalogs.find((x) => x.id === p.id);
          if (!c) return notFound("Каталог");
          if (body.groupId && !db.access.groups.some((g) => g.id === body.groupId && g.source && g.source.catalogId === c.id)) return notFound("Группа каталога");
          if (syncing.has(c.id)) return problem(409, "BUSY", "Синхронизация уже идёт");
          const mine = (g) => g.source && g.source.catalogId === c.id && (!body.groupId || g.id === body.groupId);
          if (!body.groupId) c.status = "run";
          db.access.groups.filter(mine).forEach((g) => (g.source.status = "run"));
          syncing.set(c.id, { at: now() + SYNC_MS, groupId: body.groupId });
          bump(db.access);
          send("entity.changed", { kind: "access", version: db.access.version });
          return { status: 202, body: clone(c) };
        },
      ],
      [
        "GET",
        "/domains/{id}/discovery",
        (p, q) => {
          if (!byId("domains", p.id)) return notFound("Домен");
          const whole = discoveryView(p.id);
          // Поиск отдаёт находки в своём порядке: номер находки
          const res = pageList(q, `discovery:${p.id}`, whole.candidates, (c) => String(whole.candidates.indexOf(c)).padStart(8, "0"), (c) => c, { total: whole.candidates.length });
          if (res.status !== 200) return res;
          return { status: 200, body: Object.assign(whole, res.body, { candidates: res.body.items, items: undefined }) };
        },
      ],
      [
        "GET",
        "/rules/{id}/fires",
        (p, q) => (byId("rules", p.id) ? pageList(q, `fires:${p.id}`, db.ruleFires.filter((f) => f.ruleId === p.id), (f) => backTime(f.at) + f.id, clone) : notFound("Правило")),
      ],
      [
        "POST",
        "/rules",
        (p, q, body) => {
          const bad = ruleRightProblem(body) || ruleProblem(body);
          if (bad) return bad;
          const at = iso(now());
          const r = Object.assign({ id: uuid("rule") }, content(body), { createdAt: at, createdBy: myLogin(), changedAt: at, changedBy: myLogin(), mute: null,
            order: Math.max(0, ...db.rules.map((x) => x.order)) + 1, version: newVersion() });
          db.rules.push(r);
          pushVersion(r, { code: "created", params: {} });
          send("entity.created", { kind: "rule", entityId: r.id, version: r.version });
          return one(ruleView(r), 201);
        },
      ],
      [
        "POST",
        "/rules/update",
        (p, q, body) => {
          const done = [], failed = [];
          body.items.forEach((x) => {
            const r = byId("rules", x.ruleId);
            if (!r) return failed.push({ ruleId: x.ruleId, code: "NOT_FOUND" });
            if (r.version !== x.version) return failed.push({ ruleId: x.ruleId, code: "VERSION_MISMATCH" });
            const set = x.set, was = stateNote(r).params.mode, meta = ruleMeta(r);
            const next = Object.assign({}, r, "enabled" in set ? { enabled: set.enabled } : {}, "logOnly" in set ? { logOnly: set.logOnly } : {});
            if (next.enabled && !r.enabled && (engine.undeclared(next, db.reference) || engine.crossDomain(next, db.reference))) return failed.push({ ruleId: x.ruleId, code: "NOT_SUPPORTED" });
            if (next.enabled && !r.enabled && engine.issue(next)) return failed.push({ ruleId: x.ruleId, code: "RULE_INVALID" });
            if ("enabled" in set || "logOnly" in set) {
              if (next.enabled && next.logOnly && !(r.enabled && r.logOnly)) next.logOnlySince = sysToday();
              if (next.enabled && !next.logOnly) next.logOnlySince = null;
              if (next.enabled !== r.enabled || next.logOnly !== r.logOnly) runsStop(r.id);
              ["enabled", "logOnly", "logOnlySince"].forEach((k) => (r[k] = next[k]));
              Object.assign(r, { changedAt: iso(now()), changedBy: myLogin() });
            }
            if ("mute" in set) r.mute = set.mute ? { since: iso(now()), until: set.mute.until, by: myLogin(), reason: set.mute.reason || "" } : null;
            bump(r);
            if (stateNote(r).params.mode !== was || x.historyNote) pushVersion(r, x.historyNote || stateNote(r), meta);
            changed("rule", r);
            done.push(ruleView(r));
          });
          return { status: 200, body: { done, failed } };
        },
      ],
      [
        "POST",
        "/rules/reorder",
        (p, q, body) => {
          for (const x of body.items) {
            const r = byId("rules", x.ruleId);
            if (!r) return notFound("Правило");
            if (r.version !== x.version) return problem(412, "VERSION_MISMATCH", "Правило изменилось с момента чтения", { current: ruleView(r), params: { ruleId: r.id } });
          }
          const out = body.items.map((x) => {
            const r = byId("rules", x.ruleId);
            if (r.order === x.order) return r;
            r.order = x.order;
            bump(r);
            changed("rule", r);
            return r;
          });
          return { status: 200, body: { items: out.map(ruleView) } };
        },
      ],
      [
        "POST",
        "/rules/test",
        (p, q, body) => {
          const saved = body.ruleId ? byId("rules", body.ruleId) : null;
          if (body.ruleId && !saved) return notFound("Правило");
          if (body.log && !saved) return problem(422, "VALIDATION_FAILED", "Записать в журнал можно проверку сохранённого правила", { field: "log" });
          const r = Object.assign({ id: body.ruleId || null, mute: saved ? saved.mute : null, order: saved ? saved.order : 0 }, clone(body.rule));
          const at = body.at ? Date.parse(body.at) : now();
          const pre = r.enabled ? [] : [{ code: "testOff", params: {}, ok: true, reason: null }];
          let events;
          if (r.start === "event") {
            events = (body.events || []).map((e) => ({ source: e.source, event: e.event, match: e.match || {}, deviceId: e.deviceId, at: iso(at) }));
            pre.push(...engine.eventChecks(r, events));
          }
          const f = engine.fire(r, { by: "test", at, now: !body.at, watch: true, events, pre, br: body.branches || {} });
          if (body.log) return { status: 200, body: storeFire(f) };
          return { status: 200, body: Object.assign({ id: uuid("fire") }, f) };
        },
      ],
      [
        "POST",
        "/rules/{id}/run",
        (p) => {
          const r = byId("rules", p.id);
          if (!r) return notFound("Правило");
          const out = engine.undeclared(r, db.reference);
          const why = !r.enabled ? { code: "off" } : out ? out.issue : engine.issue(r);
          if (why) return problem(409, "NOT_RUNNABLE", "Правило сейчас не запустить", { params: { reason: why } });
          return { status: 201, body: clone(ruleStart(r, { via: "manual" })) };
        },
      ],
      ["GET", "/rule-prompts", () => items(prompts.filter((x) => !x.closed).map(promptView))],
      [
        "POST",
        "/rule-prompts/{id}/answer",
        (p, q, body) => {
          const pr = prompts.find((x) => x.id === p.id);
          // Запуск снят новой правкой, выключением или удалением — вопроса больше нет: ADR-0112 доп. (9) п. 4
          if (!pr || pr.closed === "stopped" || (pr.closed && now() - pr.closedAt >= PROMPT_KEEP_MS)) return notFound("Вопрос");
          if (!mayAnswer(pr)) return problem(403, "PERMISSION_DENIED", "Отвечает человек с ролью шага", { params: { roleId: pr.roleId } });
          if (pr.closed === "answered") return problem(409, "BUSY", "На вопрос уже ответили", { params: { reason: "answered" } });
          if (pr.closed) return problem(409, "NOT_RUNNABLE", "Запуск больше не ждёт ответа", { params: { reason: { code: "over" } } });
          if (!(pr.kind === "ask" ? ["yes", "no"] : ["ack"]).includes(body.answer)) return problem(422, "VALIDATION_FAILED", "Ответ не этого вида", { field: "answer" });
          const run = ruleRuns.find((x) => x.fireId === pr.fireId), who = { login: myLogin(), at: iso(now()) };
          if (pr.kind === "escalate") who.level = run.pause.reached;
          promptsClose(run, "answered", { answer: body.answer, by: who.login });
          runDecide(run, pr.kind === "ask" ? body.answer : `ack:${pr.level}`, who);
          return { status: 202 };
        },
      ],
      ["GET", "/rules/{id}/versions", (p) => (byId("rules", p.id) ? items(db.ruleVersions.filter((v) => v.ruleId === p.id).map(versionView)) : notFound("Правило"))],
      [
        "POST",
        "/rules/{id}/fires/{fireId}/retry",
        (p) => {
          const r = byId("rules", p.id);
          const f = db.ruleFires.find((x) => x.id === p.fireId && x.ruleId === p.id);
          if (!r || !f) return notFound(r ? "Запуск" : "Правило");
          const why = !r.enabled ? { code: "off" } : r.logOnly ? { code: "logOnly" } : engine.issue(r);
          if (why) return problem(409, "NOT_RUNNABLE", "Правило сейчас не запустить", { params: { reason: why } });
          if (!f.steps.some(engine.retryable)) return problem(409, "NOT_RUNNABLE", "В запуске нет невыполненных шагов", { params: { reason: { code: "nothing" } } });
          return { status: 201, body: storeFire(engine.retry(r, f, now())) };
        },
      ],
      /* ----- Расписания, особые дни, режимы объекта, окна обслуживания ----- */
      ...getter("schedules", "Расписание"),
      [
        "POST",
        "/schedules",
        (p, q, body) => {
          if (!String(body.name || "").trim()) return problem(422, "NAME_REQUIRED", "Укажите название расписания", { field: "name" });
          if (ownerProblem(body.owner)) return ownerProblem(body.owner);
          const sc = Object.assign({ id: uuid("schedule") }, clone(body), { builtin: false, version: newVersion() });
          db.schedules.push(sc);
          send("entity.created", { kind: "schedule", entityId: sc.id, version: sc.version });
          return one(clone(sc), 201);
        },
      ],
      [
        "PUT",
        "/schedules/{id}",
        (p, q, body, headers) => {
          const sc = byId("schedules", p.id);
          if (!sc) return notFound("Расписание");
          const bad = precondition(sc, headers);
          if (bad) return bad;
          if (sc.builtin) return problem(409, "BUILTIN", "Встроенное расписание не правится");
          if (!String(body.name || "").trim()) return problem(422, "NAME_REQUIRED", "Укажите название расписания", { field: "name" });
          if (ownerProblem(body.owner)) return ownerProblem(body.owner);
          Object.assign(sc, clone(body));
          bump(sc);
          changed("schedule", sc);
          return one(clone(sc));
        },
      ],
      [
        "DELETE",
        "/schedules/{id}",
        (p, q, body, headers) => {
          const sc = byId("schedules", p.id);
          if (!sc) return notFound("Расписание");
          const bad = precondition(sc, headers);
          if (bad) return bad;
          if (sc.builtin) return problem(409, "BUILTIN", "Встроенное расписание не удаляется");
          removeSchedule(sc);
          return { status: 204 };
        },
      ],
      ...getter("dayGroups", "Группа дат").map(([m, path, fn]) => [m, path.replace("/dayGroups", "/day-groups"), fn]),
      [
        "POST",
        "/day-groups",
        (p, q, body) => {
          if (!String(body.name || "").trim()) return problem(422, "NAME_REQUIRED", "Укажите название группы", { field: "name" });
          const g = Object.assign({ id: uuid("dayGroup") }, clone(body), { version: newVersion() });
          db.dayGroups.push(g);
          send("entity.created", { kind: "dayGroup", entityId: g.id, version: g.version });
          return one(clone(g), 201);
        },
      ],
      [
        "PUT",
        "/day-groups/{id}",
        (p, q, body, headers) => {
          const g = byId("dayGroups", p.id);
          if (!g) return notFound("Группа дат");
          const bad = precondition(g, headers);
          if (bad) return bad;
          if (!String(body.name || "").trim()) return problem(422, "NAME_REQUIRED", "Укажите название группы", { field: "name" });
          Object.assign(g, clone(body));
          bump(g);
          changed("dayGroup", g);
          return one(clone(g));
        },
      ],
      [
        "DELETE",
        "/day-groups/{id}",
        (p, q, body, headers) => {
          const g = byId("dayGroups", p.id);
          if (!g) return notFound("Группа дат");
          const bad = precondition(g, headers);
          if (bad) return bad;
          db.dayGroups = db.dayGroups.filter((x) => x !== g);
          send("entity.deleted", { kind: "dayGroup", entityId: g.id });
          // Из расписаний пропадают особые дни этой группы: в эти даты действуют их обычные интервалы
          db.schedules.forEach((sc) => {
            if (!sc.overrides.some((o) => o.dayGroupId === g.id)) return;
            sc.overrides = sc.overrides.filter((o) => o.dayGroupId !== g.id);
            bump(sc);
            changed("schedule", sc);
          });
          return { status: 204 };
        },
      ],
      ["GET", "/modes", () => one(clone(db.modes))],
      [
        "PUT",
        "/modes",
        (p, q, body, headers) => {
          const M = db.modes;
          const bad = precondition(M, headers);
          if (bad) return bad;
          const ids = new Set(body.items.map((m) => m.id));
          const sys = M.items.find((m) => m.system && !ids.has(m.id));
          if (sys) return problem(409, "BUILTIN", "Системный режим не удаляется", { params: { modeId: sys.id } });
          if (!ids.has(body.otherwise)) return problem(422, "VALIDATION_FAILED", "Режим «иначе» — один из режимов", { field: "otherwise" });
          const blank = body.items.find((m) => !String(m.name || "").trim());
          if (blank) return problem(422, "NAME_REQUIRED", "Укажите название режима", { field: "items" });
          const gone = M.items.filter((m) => !ids.has(m.id)).map((m) => m.id);
          Object.assign(M, { items: clone(body.items), otherwise: body.otherwise });
          bump(M);
          send("entity.changed", { kind: "modes", version: M.version });
          // Удалённый режим уходит из условий «Режим объекта»; включённый вручную — снимается
          db.rules.forEach((r) => {
            const hit = r.conditions.filter((c) => c.kind === "mode" && (c.modeIds || []).some((x) => gone.includes(x)));
            if (!hit.length) return;
            hit.forEach((c) => (c.modeIds = c.modeIds.filter((x) => !gone.includes(x))));
            bump(r);
            runsStop(r.id);
            changed("rule", r);
          });
          if (db.modeManual && gone.includes(db.modeManual.modeId)) db.modeManual = null;
          modeTick();
          return one(clone(M));
        },
      ],
      ["GET", "/modes/current", () => ({ status: 200, body: modeCurrent() })],
      [
        "POST",
        "/modes/current",
        (p, q, body) => {
          if (body.modeId && !db.modes.items.some((m) => m.id === body.modeId)) return notFound("Режим");
          db.modeManual = body.modeId ? { modeId: body.modeId, until: body.until || null } : null;
          send("entity.changed", { kind: "objectMode", entityId: engine.modeNow(now()) });
          lastMode = engine.modeNow(now());
          return { status: 200, body: modeCurrent() };
        },
      ],
      ...getter("maintenanceWindows", "Окно обслуживания").map(([m, path, fn]) => [m, path.replace("/maintenanceWindows", "/maintenance-windows"), fn]),
      [
        "POST",
        "/maintenance-windows",
        (p, q, body) => {
          if (!String(body.name || "").trim()) return problem(422, "NAME_REQUIRED", "Укажите название окна", { field: "name" });
          const w = { id: uuid("window"), name: body.name, scheduleId: null, ruleIds: clone(body.ruleIds), enabled: body.enabled, version: newVersion() };
          const sc = Object.assign({ id: uuid("schedule") }, clone(body.schedule), { builtin: false, owner: { kind: "maintenanceWindow", id: w.id }, version: newVersion() });
          w.scheduleId = sc.id;
          db.schedules.push(sc);
          db.maintenanceWindows.push(w);
          send("entity.created", { kind: "schedule", entityId: sc.id, version: sc.version });
          send("entity.created", { kind: "maintenanceWindow", entityId: w.id, version: w.version });
          return { status: 201, body: { window: clone(w), schedule: clone(sc) } };
        },
      ],
      [
        "PUT",
        "/maintenance-windows/{id}",
        (p, q, body, headers) => {
          const w = byId("maintenanceWindows", p.id);
          if (!w) return notFound("Окно обслуживания");
          const bad = precondition(w, headers);
          if (bad) return bad;
          if (!String(body.name || "").trim()) return problem(422, "NAME_REQUIRED", "Укажите название окна", { field: "name" });
          if (!byId("schedules", body.scheduleId)) return problem(422, "VALIDATION_FAILED", "Расписания нет", { field: "scheduleId" });
          Object.assign(w, clone(body));
          bump(w);
          changed("maintenanceWindow", w);
          return one(clone(w));
        },
      ],
      [
        "DELETE",
        "/maintenance-windows/{id}",
        (p, q, body, headers) => {
          const w = byId("maintenanceWindows", p.id);
          if (!w) return notFound("Окно обслуживания");
          const bad = precondition(w, headers);
          if (bad) return bad;
          db.maintenanceWindows = db.maintenanceWindows.filter((x) => x !== w);
          send("entity.deleted", { kind: "maintenanceWindow", entityId: w.id });
          // Своё расписание окна — вместе с ним, если больше нигде не используется
          db.schedules.filter((sc) => sc.owner && sc.owner.id === w.id && !scheduleUsed(sc.id)).forEach(removeSchedule);
          return { status: 204 };
        },
      ],
      ["GET", "/access", () => one(accessSnapshot())],
      ["GET", "/access/users", (p, q) => {
        const hit = (u) => !q.q || textHit(q.q, u.login, u.name, u.email);
        return pageList(q, "access/users", accessView().users.filter(hit), (u) => u.id, (u) => u);
      }],
      ["GET", "/access/groups", (p, q) => pageList(q, "access/groups", db.access.groups.filter((g) => !q.q || textHit(q.q, g.name)), (g) => g.id, clone)],
      ["GET", "/access/history", (p, q) => pageList(q, "access/history", db.access.history.filter((h) => !q.q || textHit(q.q, JSON.stringify(h))), (h) => backRank(db.access.history, h), clone)],
      ["GET", "/access/cell-history", (p, q) => pageList(q, "access/cell-history", (db.access.cellHistory || []).filter((h) => !q.q || textHit(q.q, JSON.stringify(h))), (h) => backRank(db.access.cellHistory, h), clone)],
      ["GET", "/access/roles/{id}/objects", (p, q) => {
        const role = db.access.roles.find((r) => r.id === p.id);
        if (!role) return notFound("Роль");
        const rows = Object.entries(role.objectAccess || {}).map(([objectId, levels]) => ({ objectId, levels })).filter((x) => !q.q || textHit(q.q, x.objectId, (byId("devices", x.objectId) || {}).name));
        return pageList(q, `access/roles/${p.id}/objects`, rows, (x) => x.objectId, clone);
      }],
      ["GET", "/settings", () => one(clone(db.settings))],
      ["GET", "/licenses", () => items(clone(db.licenses))],
      [
        "GET",
        "/journal",
        (p, q) => {
          const when = (e) => Date.parse(e.occurredAt || e.at);
          const hit = db.journal.filter((e) => (!q.category || e.category === q.category) && (!q.deviceId || journalAbout(e, q.deviceId)) && (!q.source || e.source === q.source) &&
            (!q.from || when(e) >= Date.parse(q.from)) && (!q.to || when(e) <= Date.parse(q.to)));
          // Встроенный сервер права на журнал не проверяет: скрытых записей у него нет
          const res = pageList(q, "journal", hit, (e) => backRank(db.journal, e), clone);
          if (res.status !== 200) return res;
          return { status: 200, body: Object.assign(res.body, { truncated: !!res.body.nextCursor, withheldCount: 0 }) };
        },
      ],
      /* ----- Учётки потоков ----- */
      ["GET", "/archive-watches", (p, q) => pageList(q, "archive-watches", db.archiveWatches.filter((w) => !q.deviceId || w.deviceId === q.deviceId), (w) => partKey(w.id), clone)],
      [
        "POST",
        "/archive-watches",
        (p, q, body) => {
          const w = Object.assign({ start: "now", keep: "none", archiveId: null, preSec: 5, postSec: 5, joinSec: 30, enabled: true, alarms: [], labels: [] }, clone(body), { through: null, overrunSec: 0 });
          const bad = watchProblem(w, null);
          if (bad) return bad;
          w.id = uuid("archiveWatch");
          w.version = newVersion();
          db.archiveWatches.push(w);
          send("entity.created", { kind: "archiveWatch", entityId: w.id, version: w.version });
          return one(clone(w), 201);
        },
      ],
      [
        "PATCH",
        "/archive-watches/{id}",
        (p, q, body, headers) => {
          const w = byId("archiveWatches", p.id);
          if (!w) return notFound("Обход");
          if (!cameraAdmin()) return problem(403, "PERMISSION_DENIED", "Менять может администратор камеры");
          const bad = precondition(w, headers) || watchProblem(Object.assign({}, w, body), w);
          if (bad) return bad;
          Object.assign(w, clone(body));
          bump(w);
          send("entity.changed", { kind: "archiveWatch", entityId: w.id, version: w.version });
          return one(clone(w));
        },
      ],
      [
        "DELETE",
        "/archive-watches/{id}",
        (p, q, body, headers) => {
          const w = byId("archiveWatches", p.id);
          if (!w) return notFound("Обход");
          if (!cameraAdmin()) return problem(403, "PERMISSION_DENIED", "Снимать может администратор камеры");
          const bad = precondition(w, headers);
          if (bad) return bad;
          dropWatch(w);
          return { status: 204, body: null };
        },
      ],
      ["GET", "/archive-scans", (p, q) => pageList(q, "archive-scans", db.archiveScans.filter((x) => !q.deviceId || x.deviceId === q.deviceId), (x) => partKey(x.id), clone)],
      [
        "POST",
        "/archive-scans",
        (p, q, body) => {
          const bad = scanProblem(body);
          if (bad) return bad;
          const x = Object.assign({ alarms: [], labels: [] }, clone(body), { id: uuid("archiveScan"), state: "running", result: null, version: newVersion() });
          db.archiveScans.push(x);
          scanning.set(x.id, now() + SCAN_MS);
          send("entity.created", { kind: "archiveScan", entityId: x.id, version: x.version });
          return one(clone(x), 201);
        },
      ],
      [
        "DELETE",
        "/archive-scans/{id}",
        (p) => {
          const x = byId("archiveScans", p.id);
          if (!x) return notFound("Скан");
          if (!cameraAdmin()) return problem(403, "PERMISSION_DENIED", "Снимать может администратор камеры");
          dropScan(x);
          return { status: 204, body: null };
        },
      ],
      ["GET", "/stream-accounts", () => items(db.streamAccounts.map(clone))],
      [
        "POST",
        "/stream-accounts",
        (p, q, body) => {
          const name = String(body.name).trim();
          if (!name) return problem(422, "NAME_REQUIRED", "Укажите имя учётки", { field: "name" });
          if (db.streamAccounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) return problem(409, "NAME_TAKEN", "Учётка с таким именем уже есть", { field: "name" });
          db.streamAccounts.push({ name, disabled: false, at: iso(now()), by: myLogin() });
          send("entity.changed", { kind: "streamAccounts" });
          return { status: 201, body: { name, password: newSecret() } };
        },
      ],
      [
        "PATCH",
        "/stream-accounts/{name}",
        (p, q, body) => {
          const a = db.streamAccounts.find((x) => x.name === p.name);
          if (!a) return notFound("Учётка");
          Object.assign(a, { disabled: body.disabled, at: iso(now()), by: myLogin() });
          send("entity.changed", { kind: "streamAccounts" });
          return { status: 200, body: clone(a) };
        },
      ],
      [
        "DELETE",
        "/stream-accounts/{name}",
        (p) => {
          if (!db.streamAccounts.some((x) => x.name === p.name)) return notFound("Учётка");
          db.streamAccounts = db.streamAccounts.filter((x) => x.name !== p.name);
          dropStreamGrants((g) => { if (g.account === p.name) g.account = ""; });
          send("entity.changed", { kind: "streamAccounts" });
          return { status: 204, body: null };
        },
      ],
      [
        "POST",
        "/stream-accounts/{name}/password",
        (p) => {
          const a = db.streamAccounts.find((x) => x.name === p.name);
          if (!a) return notFound("Учётка");
          Object.assign(a, { at: iso(now()), by: myLogin() });
          return { status: 200, body: { name: a.name, password: newSecret() } };
        },
      ],
      // Ассистент — заглушка с записанными ходами: модели у встроенного сервера нет. Поток — массивом сообщений,
      // клиент отдаёт их по одному, петля пишет строками data:
      ["POST", "/assist/turns", (p, q, body) => ({ status: 200, body: assistStub(body), headers: { "Content-Type": "text/event-stream" } })],
      // Поток встроенного сервера — subscribe(); по HTTP его отдаёт петля (tests/loopback-sw.js) или бэкенд
      ["PUT", "/stream/{clientId}/watch", (p, q, body) => {
        const c = clients.get(p.clientId);
        if (!c || c.elsewhere) return notFound("Поток");
        if (body.ids.length > db.reference.limits.watchMax) return problem(422, "VALIDATION_FAILED", "Больше, чем watchMax", { field: "ids" });
        c.watch = new Set(body.ids);
        return { status: 204, body: null };
      }],
      // Предел watch судится здесь, поток по HTTP перед открытием спрашивает этот маршрут
      ["GET", "/stream", (p, q) => {
        if (String(q.watch || "").split(",").filter(Boolean).length > db.reference.limits.watchMax) return problem(422, "VALIDATION_FAILED", "Больше, чем watchMax", { field: "watch" });
        return problem(404, "NO_ROUTE", "Поток событий встроенного сервера — subscribe()");
      }],

      [
        "POST",
        "/operations",
        (p, q, body) => {
          // Шаг по uid: patch, action, delete, folders, createUnit, move. patch, folders, createUnit проверяются до запуска
          // (unitStepsPreflight): не пройдёт один — отклонена вся операция. Остальное (связь сервера, перенос, удаление,
          // команда) — при выполнении шага: отказ одного объекта не останавливает остальные. Шагов по папкам (folders, patch только с folders) — до
          // selectMax (reference.limits): состав папок за раз, как у групповой правки папок; прочие шаги предела не имеют
          const folderSteps = body.items.filter((r) => r.folders !== undefined || (r.patch && Object.keys(r.patch).length && Object.keys(r.patch).every((k) => k === "folders"))).length;
          if (folderSteps > db.reference.limits.selectMax) return problem(422, "VALIDATION_FAILED", "Шагов по папкам больше, чем selectMax: несколькими операциями", { field: "items" });
          for (const [i, r] of body.items.entries()) {
            const bad = unitStepProblem(r, i);
            if (bad) return bad;
          }
          const targets = [...new Set(body.items.map((r) => r.uid))];
          // Версия нужна шагу, который меняет сам объект (patch, delete, folders, move)
          const needs = new Set(body.items.filter(unitStepNeedsVersion).map((r) => r.uid));
          const missing = targets.find((t) => needs.has(t) && !(t in body.expectedVersions));
          if (missing) return problem(428, "PRECONDITION_REQUIRED", "Для каждого объекта нужна версия, по которой построен план", { params: { targetId: missing } });
          for (const id of targets) {
            if (!(id in body.expectedVersions)) continue;
            const u = store.get(id);
            if (u.version !== body.expectedVersions[id]) return problem(412, "VERSION_MISMATCH", "Объект изменился с момента построения плана", { current: unitView(u), params: { targetId: id } });
          }
          const taken = targets.find(busy);
          if (taken) return problem(409, "BUSY", "Над объектом выполняется другая операция", { params: { targetId: taken } });
          const early = unitStepsPreflight(body.items);
          if (early) return early;
          // Только команды — назад не вернуть: такая операция в стопку отката не попадает
          const commands = body.items.every((r) => r.action !== undefined);
          const op = startOperation(body.items.map(clone), commands ? { noUndo: true } : undefined);
          // wait и все шаги мгновенные: шаги — сразу, ответ — законченная операция (200), опрашивать нечего
          if (body.wait && body.items.every(unitStepInstant)) {
            op.items.forEach((item) => {
              runItem(op, item);
              const v = opView(op);
              send("operation.progress", { kind: "operation", entityId: op.id, payload: { item: v.items[item.index], done: v.done, total: v.total } });
            });
            finish(op);
            return { status: 200, body: opView(op) };
          }
          return { status: 202, body: opView(op) };
        },
      ],
      ["GET", "/operations", (p, q) => {
        const all = [...ops.values()];
        // Новые сверху: номер с начала списка, новая операция страницы не сдвигает
        return pageList(q, "operations", all, (x) => String(9999999 - all.indexOf(x)).padStart(8, "0"), opView);
      }],
      ["GET", "/operations/{id}", (p) => (opById(p.id) ? { status: 200, body: opView(opById(p.id)) } : notFound("Операция"))],
      [
        "POST",
        "/operations/{id}/pause",
        (p) => {
          const op = opById(p.id);
          if (!op) return notFound("Операция");
          if (op.state !== "running") return problem(409, "BUSY", "Операция не выполняется");
          op.state = "paused";
          return { status: 200, body: opView(op) };
        },
      ],
      [
        "POST",
        "/operations/{id}/resume",
        (p) => {
          const op = opById(p.id);
          if (!op) return notFound("Операция");
          if (op.state !== "paused") return problem(409, "BUSY", "Операция не на паузе");
          op.state = "running";
          op.nextAt = now() + stepMs(op.items.filter((x) => x.state !== "wait").length);
          return { status: 200, body: opView(op) };
        },
      ],
      [
        "POST",
        "/operations/{id}/cancel",
        (p) => {
          const op = opById(p.id);
          if (!op) return notFound("Операция");
          if (op.state === "done") return problem(409, "BUSY", "Операция уже завершена");
          op.items.forEach((x) => {
            if (x.state === "wait") Object.assign(x, { state: "cancel", code: null });
          });
          finish(op);
          return { status: 200, body: opView(op) };
        },
      ],
      [
        "POST",
        "/operations/{id}/retry-failed",
        (p) => {
          const op = opById(p.id);
          if (!op) return notFound("Операция");
          const failed = op.items.filter((x) => x.state === "fail");
          if (op.state !== "done" || !failed.length) return problem(409, "BUSY", "Повторять нечего: операция не завершена или неудачных шагов нет");
          // Повтор и откат — новые операции: занятый другой операцией объект они тоже не трогают
          const lockedRetry = lockedProblem(failed.map((x) => x.targetId));
          if (lockedRetry) return lockedRetry;
          // Шаг повторяется теми же полями запроса; служебные шаги отката (restore, unitRemove…) — отказом
          const again = (r) => ({ uid: r.uid, patch: r.patch, action: r.action, params: r.params, delete: r.delete, folders: r.folders, createUnit: r.createUnit });
          return { status: 202, body: opView(startOperation(failed.map((x) => stripUndefined(again(x.req))), { retryOf: op.id, noUndo: op.noUndo })) };
        },
      ],
      [
        "POST",
        "/operations/{id}/revert",
        (p) => {
          const op = opById(p.id);
          if (!op) return notFound("Операция");
          const reason = revertReason(op);
          if (reason) return problem(409, "NOT_REVERTIBLE", "Откатить нельзя", { params: { reason } });
          const done = op.items.filter((x) => x.state === "ok");
          // Кроме самих объектов — созданное шагом createUnit: откат его снимет
          const lockedRevert = lockedProblem(done.flatMap((x) => [x.targetId].concat(x.before.unitRemove ? [x.before.unitRemove] : [])).filter((id) => store.has(id)), held);
          if (lockedRevert) return lockedRevert;
          op.reverted = true;
          // Шаги — в обратном порядке. Шаг сверяет значения своих полей с записанными: другое значение — объект
          // меняли после, шаг не выполняется. Удаление со своим смыслом, папки, секреты, адрес и объём тома назад не возвращаются
          const requests = done.slice().reverse().map((x) => stripUndefined(unitUndo(x)));
          return { status: 202, body: opView(startOperation(requests, { revertOf: op.id })) };
        },
      ],
      [
        "POST",
        "/operations/{id}/redo",
        (p) => {
          const op = opById(p.id);
          if (!op) return notFound("Операция");
          const reason = redoReason(op);
          if (reason) return problem(409, "NOT_REVERTIBLE", "Повторить нельзя", { params: { reason } });
          const undo = [...ops.values()].filter((x) => x.revertOf === op.id).pop();
          // Только то, что отмена вернула: её удачные шаги в исходном порядке. Откат снял созданное — заново не создаётся
          const done = undo.items.filter((x) => x.state === "ok").reverse();
          const locked = lockedProblem(done.map((x) => x.targetId).filter((id) => store.has(id)), held);
          if (locked) return locked;
          redoStack.pop();
          const requests = done.map((x) => stripUndefined(unitRedo(x)));
          return { status: 202, body: opView(startOperation(requests, { redoOf: op.id })) };
        },
      ],
    ];
    function stripUndefined(o) {
      Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]);
      return o;
    }

    /* ===== Тестовый стенд: только с testSupport, в боевой системе этих операций нет ===== */

    const TEST_ROUTES = [
      [
        "POST",
        "/test/reset",
        (p, q, body) => {
          const base = FIXTURES[body.fixture];
          if (!base) return problem(404, "NOT_FOUND", `Набора ${body.fixture} нет`);
          // Часы останавливаются: время в тестах идёт только по /test/clock
          clock.frozenAt = body.freezeClock === false ? null : realNow() + clock.offset;
          load(body.fixturePatch ? mergePatch(base, body.fixturePatch) : base);
          if (body.actAs) {
            const u = db.access.users.find((x) => x.login === body.actAs);
            if (!u) return problem(404, "NOT_FOUND", `Пользователя ${body.actAs} нет`);
            me = u.id;
          }
          send("test.reset", { payload: {} });
          return { status: 200, body: { fixture: body.fixture, now: iso(now()), frozen: clock.frozenAt != null } };
        },
      ],
      // Описание вида на ходу — как установка или обновление плагина: новый ETag /kinds, kinds.changed в поток. Склад
      // переиндексирует объекты вида (ссылки x-ref могли измениться) — хук onPut реестра
      ["PUT", "/test/kinds/{kind}", (p, q, body) => {
        if (body.kind !== p.kind) return errsProblem([err("VALIDATION_FAILED", "/kind", { keyword: "const", value: p.kind })], "Код вида в теле — не тот, что в пути");
        kinds.put(clone(body));
        send("kinds.changed", { payload: { kinds: [p.kind] } });
        return { status: 200, body: clone(kinds.get(p.kind)) };
      }],
      // Второй экземпляр консоли: поток идёт, а PUT наблюдения попадает туда, где его нет
      ["POST", "/test/stream-elsewhere", () => {
        clients.forEach((c) => (c.elsewhere = true));
        return { status: 204, body: null };
      }],
      [
        "POST",
        "/test/clock",
        (p, q, body) => {
          const ms = body.advanceSec * 1000;
          // Время идёт шагами: всё, что наступило по пути, выполняется в свой момент, а не разом в конце
          const fired = [];
          const target = now() + ms;
          for (let t = now(); ; ) {
            const due = Math.min(target, ...[...ops.values()].filter((o) => o.state === "running").map((o) => o.nextAt), ...formatting.values(), ...[...searches.values()].map((s) => s.nextAt), ...[...syncing.values()].map((s) => s.at), ...applying.values(), ...runDue());
            if (clock.frozenAt != null) clock.frozenAt = Math.max(t, due);
            else clock.offset += Math.max(t, due) - now();
            fired.push(...tick());
            t = now();
            if (t >= target) break;
          }
          return { status: 200, body: { now: iso(now()), fired } };
        },
      ],
      [
        "POST",
        "/test/events",
        (p, q, body) => {
          // Связь с доменом: видно только свой кластер, чужое пропадает из ответов без entity.deleted
          if (body.type === "domain.link") {
            const dm = byId("domains", body.domainId);
            if (!dm) return notFound("Домен");
            dm.online = body.online;
            bump(dm);
            changed("domain", dm);
            send("stream.reset", { payload: {} });
            return { status: 200, body: { applied: true } };
          }
          if (body.type === "journal.event") {
            if (!byId("devices", body.deviceId)) return notFound("Устройство");
            const dev = byId("devices", body.deviceId), at = iso(now()), cameraId = dev.type === "camera" ? dev.id : dev.cameraId || dev.parentId;
            const e = Object.assign({ id: uuid("journal"), at, occurredAt: at, category: "info", text: "", deviceId: body.deviceId }, cameraId ? { cameraId } : {}, clone(body.event || {}), { deviceId: body.deviceId });
            db.journal.unshift(e);
            send("journal.event", { entityId: e.deviceId, payload: clone(e) });
            return { status: 200, body: { applied: true } };
          }
          if (body.type === "scenario.outcome") {
            if (!byId("domains", body.domainId)) return notFound("Домен");
            db.scenarioStatus = db.scenarioStatus || {};
            (db.scenarioStatus[body.domainId] = db.scenarioStatus[body.domainId] || {})[body.name] = clone(body.status);
            return { status: 200, body: { applied: true } };
          }
          // Событие объекта из описания его вида (UnitKind.events): запускает включённые правила с этим одним событием,
          // уточнение правила (match) — подмножество полей события, сравнение строгое. Шаги-команды объектов выполняются
          if (body.type === "unit.event") {
            const u = store.get(body.deviceId);
            if (!u) return notFound("Объект");
            if (!((kinds.get(u.kind) || {}).events || []).some((e) => e.id === body.eventId)) return problem(422, "VALIDATION_FAILED", `У вида ${u.kind} нет события ${body.eventId}`, { field: "eventId" });
            const match = clone(body.match || {}), ev = { source: "unit", event: body.eventId, match, deviceId: u.uid, at: iso(now()) };
            const fits = (t) => Object.entries(t.match || {}).every(([k, v]) => k in match && JSON.stringify(match[k]) === JSON.stringify(v));
            db.rules.filter((r) => r.enabled && r.start === "event" && r.runMode !== "manual" && r.triggers.length === 1 && engine.hears(r.triggers[0], body.eventId, u.uid) && fits(r.triggers[0]))
              .forEach((r) => fireDo(ruleStart(r, { via: "event", events: [ev], src: [u.uid] })));
            return { status: 200, body: { applied: true } };
          }
          const dev = byId("devices", body.deviceId);
          if (!dev) return notFound("Устройство");
          // Сервер сам находит и теряет записи, когда устройство ответило иначе
          if (body.type === "device.found") {
            if (!body.found) return problem(422, "VALIDATION_FAILED", "Нужно found", { field: "found" });
            const d = legacy.add("devices", Object.assign({ id: uuid("device"), type: body.found.type, parentId: dev.id, domainId: dev.domainId, name: body.found.name, online: true, enabled: true, version: newVersion() }, body.found.channel != null ? { channel: body.found.channel } : {}));
            send("entity.created", { kind: "device", entityId: d.id, version: d.version });
            return { status: 200, body: { applied: true, deviceId: d.id } };
          }
          if (body.type === "device.lost") {
            removeDevice(dev.id);
            return { status: 200, body: { applied: true } };
          }
          // Сигнал входа: начало запускает правила с одним событием io.input, конец останавливает эскалацию с stop: reset
          if (body.type === "io.input") {
            if (!body.value) return problem(422, "VALIDATION_FAILED", "Нужно value", { field: "value" });
            const at = iso(now());
            if (body.value === "active") {
              const ev = { source: "unit", event: "io.input", match: { value: "active" }, deviceId: dev.id, at };
              db.rules.filter((r) => r.enabled && r.start === "event" && r.runMode !== "manual" && r.triggers.length === 1 && (r.triggers[0].match.value || "active") === "active" && engine.hears(r.triggers[0], "io.input", dev.id))
                .forEach((r) => ruleStart(r, { via: "event", events: [ev], src: [dev.id] }));
            } else
              ruleRuns.filter((x) => x.pause && x.pause.control.stop === "reset" && x.events.some((e) => e.event === "io.input" && e.deviceId === dev.id)).forEach((x) => {
                const level = x.pause.reached;
                promptsClose(x, "reset");
                runDecide(x, "reset", { level, at });
              });
            return { status: 200, body: { applied: true } };
          }
          if (body.type === "device.parent") {
            dev.parentId = body.parentId || null;
            bump(dev);
            changed("device", dev);
            return { status: 200, body: { applied: true } };
          }
          if (body.type === "device.signal") {
            if (typeof body.online !== "boolean") return problem(422, "VALIDATION_FAILED", "Нужно online", { field: "online" });
            dev.online = body.online;
            if (dev.online) delete dev.fault;
            else dev.fault = body.fault || dev.fault || "conn";
          } else {
            if (body.fault) dev.fault = body.fault;
            else delete dev.fault;
          }
          // Связь — состояние, а не настройка: версия не растёт, иначе правка администратора упала бы с 412
          send("entity.changed", { kind: "device", entityId: dev.id, version: dev.version, payload: { status: true } });
          return { status: 200, body: { applied: true } };
        },
      ],
    ];

    /* ----- Заглушка ассистента: разбор — по словам просьбы, чтобы сценарии были предсказуемы. Это не модель, план здесь
       никто не проверяет: у бэкенда проверяет код. Мир — объекты и описания видов: слова просьбы сверяются с подписями вида
       (label, x-label, x-enum-labels), значениями свойств с x-search и подписями команд. Кода под вид нет — незнакомый вид
       понимается по своему описанию. Слова профилей, которых в подписях нет («запись» камеры), — ASSIST_PHRASES.
       «сбой» — error, поля нет в описаниях — refused, значение вне схемы — refused с указателем, не понял — question ----- */
    const ASSIST_STOP = ["камер", "запис", "включ", "выклу", "парол", "секре", "смени", "помен", "измен", "поста", "устан", "задай", "перев", "сдела", "всех", "этаж"];
    // «включи/выключи запись» — режим записи профиля камеры: в подписях схемы этого слова нет («Когда писать»)
    const ASSIST_PHRASES = [
      { re: /выключи\S*\s.*запис|запис\S*.*выключи/, profile: "vms.camera/1", name: "recordMode", value: "none" },
      { re: /(^|[^ы])включи\S*\s.*запис/, profile: "vms.camera/1", name: "recordMode", value: "always" },
    ];
    const assistNorm = (t) => { const s = String(t == null ? "" : t).toLowerCase(); return s.includes("ё") ? s.replace(/ё/g, "е") : s; };
    const assistWords = (t) => assistNorm(t).split(/[^a-zа-я0-9]+/).filter(Boolean);
    const assistText = (t) => (t && typeof t === "object" ? t.text || t.key || "" : String(t || ""));
    // Основа слова без окончания: «камера» → «камер», «ручной» → «ручн»
    const assistStem = (w) => w.replace(/[аеиоуыэюяйь]+$/, "");
    const assistWordHit = (req, lab) => req === lab || (assistStem(lab).length >= 4 && req.startsWith(assistStem(lab)));
    // Подпись в словах просьбы: каждое значимое слово подписи (от min букв) — в каком-то слове просьбы. Ответ — слова
    // просьбы, которые её назвали, или null. Подпись из одного короткого слова («Реле», «Том») — только целым словом
    function assistLabelHit(words, label, min) {
      const all = assistWords(assistText(label));
      const sig = all.filter((w) => w.length >= (min || 3));
      const need = sig.length ? sig : all.length === 1 && !min ? all : [];
      if (!need.length) return null;
      const got = need.map((w) => words.find((r) => assistWordHit(r, w)));
      return got.every(Boolean) ? got : null;
    }
    const assistEat = (rest, words) => words.reduce((s, w) => s.replace(new RegExp(`(^|[^a-zа-я0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^a-zа-я0-9]|$)`, "g"), "$1 "), rest);
    // Виды по подписи (UnitKind.label): подпись из большего числа слов главнее — «датчик acfa», а не «датчик»
    function assistKindsIn(rest) {
      const words = assistWords(rest);
      const hits = kinds.list().map((k) => ({ k, m: assistLabelHit(words, k.label) })).filter((h) => h.m);
      return hits.filter((h) => !hits.some((o) => o !== h && o.m.length > h.m.length && h.m.every((w) => o.m.includes(w))));
    }
    const assistKindLabel = (kind) => assistText((kinds.get(kind) || {}).label) || kind;
    const assistProps = (kind) => ((kinds.get(kind) || {}).schema || {}).properties || {};
    // Словарь значений x-search видов отбора. Один на набор видов, пока не изменились склад (stamp, а правку
    // на месте выдаёт событие — seqEvent) и описания видов:
    // на xl это миллион значений, и собирать его на каждую реплику — секунды
    let assistValuesMemo = null;
    function assistValuesOf(scope) {
      const key = scope.join(",") + "|" + kinds.etag();
      const m = assistValuesMemo;
      if (m && m.key === key && m.store === store && m.stamp === store.stamp() && m.seq === seqEvent) return m;
      const values = new Map();
      const labelOf = (kind, prop) => assistText((assistProps(kind)[prop] || {})["x-label"]).toLowerCase() || prop;
      // Объекты вида — одним списком на вид, а не на каждое свойство поиска: на xl это миллион записей
      scope.forEach((kind) => { const units = store.byKind(kind); kinds.searchNames(kind).forEach((prop) => units.forEach((u) => {
        [].concat(props(u)[prop]).forEach((v) => {
          if (typeof v !== "string" || v.length < 3) return;
          const n = assistNorm(v);
          if (!values.has(n)) values.set(n, { v, prop, label: labelOf(kind, prop) });
        });
      })); });
      assistValuesMemo = { key, store, stamp: store.stamp(), seq: seqEvent, values };
      return assistValuesMemo;
    }
    const assistByName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.uid < b.uid ? -1 : 1);
    // Команда над объектами: подпись команды вида (UnitKind.actions, кроме ruleOnly) — все её слова в просьбе (по пяти буквам:
    // «поставь» — «Поставить»). Виды, названные в просьбе, сужают выбор
    function assistActionOf(said) {
      const words = assistWords(said);
      const hit = (label) => {
        const sig = assistWords(assistText(label)).filter((w) => w.length >= 4);
        return sig.length && sig.every((w) => words.some((r) => r.slice(0, 5) === w.slice(0, 5)));
      };
      let found = [];
      kinds.list().forEach((k) => (k.actions || []).forEach((a) => !a.ruleOnly && hit(a.label) && found.push({ kind: k.kind, a })));
      const named = new Set(assistKindsIn(said).map((h) => h.k.kind));
      if (named.size) found = found.filter((x) => named.has(x.kind));
      if (!found.length) return null;
      const id = found[0].a.id;
      return { id, label: assistText(found[0].a.label), kinds: found.filter((x) => x.a.id === id).map((x) => x.kind) };
    }
    // AssistFoundFilter → запрос GET /units: kinds → kind, списки — через запятую, флаги — "true"
    function assistUnitsQuery(f) {
      const q = {};
      Object.entries(f).forEach(([k, v]) => (q[k === "kinds" ? "kind" : k] = Array.isArray(v) ? v.join(",") : String(v)));
      return q;
    }

    // Заглушка плана правил: просьбы тестов, а не разбор языка. Настоящий ход — V/10.7: модель, проверка, сверка со словами
    function assistRulesStub(said, context, at) {
      const low = said.toLowerCase();
      const out = [{ type: "progress", at, text: "читаю правила" }];
      const last = (e) => out.concat(Object.assign({ at }, e));
      if (/детектор на время|провер\S* архив/.test(low)) return last({ type: "refused", text: "Такое правило заводится на странице консоли.", context });
      // Вопрос и эскалация составляются как любое новое правило: наблюдающим или выключенным, в наблюдении никого не трогают
      const asks = /спроси/.test(low), escalates = /эскалац/.test(low);
      const rule = db.rules.find((r) => low.includes(r.name.toLowerCase()));
      if (/убери|лимит/.test(low)) {
        if (!rule) return last({ type: "question", text: "Какое правило изменить?", context });
        const limit = (low.match(/лимит\D*(\d+)/) || [])[1];
        const edit = limit ? { ratePerMinute: Number(limit) } : /услови/.test(low) ? { conditions: [] } : /шаг/.test(low) ? { steps: rule.steps.slice(0, -1) } : null;
        if (!edit) return last({ type: "question", text: "Что изменить в правиле?", context });
        return last({ type: "plan", summary: `Правило «${rule.name}»`, context, rules: [{ table: "scenarios", op: "update", id: rule.id, body: edit }] });
      }
      // Расписание просьбы: новое — запись плана с ref, готовое у окна — копия строки в теле
      const copy = (x) => {
        const { id, version, builtin, ...sc } = clone(x);
        return Object.assign(sc, { owner: null });
      };
      const fresh = /новое расписание|новому расписанию/.test(low), windowed = /окно обслуживания/.test(low);
      const shift = () => ({ table: "schedules", op: "create", ref: "shift", body: Object.assign(copy(db.schedules.find((x) => !x.builtin)), { name: "Смена из просьбы" }) });
      const win = (schedule) => ({ table: "windows", op: "create", body: { name: "Окно из просьбы", ruleIds: null, enabled: false, schedule } });
      if (windowed && !/движени/.test(low)) {
        if (fresh) return last({ type: "plan", summary: "Create a window", context, rules: [shift(), win("@shift")] });
        const ready = db.schedules.find((x) => !x.builtin && low.includes(x.name.toLowerCase()));
        if (!ready) return last({ type: "question", text: "По какому расписанию?", context });
        return last({ type: "plan", summary: "Create a window", context, rules: [win(copy(ready))] });
      }
      // Камера — объект профиля vms.camera/1 по имени в просьбе, самое длинное имя
      const cam = [...store.all()].filter((u) => isCamera(u) && low.includes(String(u.name).toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
      if (!/движени/.test(low) && !asks && !escalates) return last({ type: "refused", text: "Не понял, какое правило нужно.", context });
      if (!cam) return last({ type: "question", text: "На какой камере?", context });
      const minutes = (low.match(/(\d+)\s*мин/) || [])[1];
      if (!minutes && !asks && !escalates) return last({ type: "question", text: "Сколько минут писать?", context });
      const target = { include: [{ uid: cam.uid }], exclude: [], gone: [], fromEvent: false };
      const record = { type: "unitAction", action: "record", target, params: { duration: "min", minutes: Number(minutes || 5) } };
      // Кому: роль по имени в просьбе, иначе охрана
      const roles = db.access.roles, guard = roles.find((x) => /^охрана$/i.test(x.name)) || roles[0];
      const role = roles.find((x) => low.includes(x.name.toLowerCase())) || guard, chief = roles.find((x) => /^старший охраны$/i.test(x.name) && x !== role);
      const control = asks
        ? [{ control: "ask", text: `Подтвердить движение: ${cam.name}?`, roleId: role.id, sec: 60, default: "no", yes: [record], no: [] }]
        : escalates
          ? [record, { control: "escalate", levels: [{ roleId: role.id, via: "client", waitMin: 5 }].concat(chief ? [{ roleId: chief.id, via: "client", waitMin: 10 }] : []), stop: "ack" }]
          : [record];
      const r = { name: `${asks ? "Вопрос" : escalates ? "Эскалация" : "Запись"} при движении: ${cam.name}`, start: "event", triggers: [{ source: "unit", kinds: [cam.kind], event: "motion", target, match: {} }], conditions: [], steps: control };
      Object.assign(r, /выключенн/.test(low) ? { enabled: false } : { enabled: true, logOnly: true });
      const rows = [{ table: "scenarios", op: "create", body: r }];
      if (fresh) {
        rows.unshift(shift());
        r.conditions.push({ kind: "time", scheduleId: "@shift" });
        if (windowed) rows.push(win("@shift"));
      }
      return last({ type: "plan", summary: "Create a rule", context, rules: rows });
    }
    // Что за реплика, заглушка решает сама по словам просьбы вместе с прежним context: поля типа в запросе нет.
    // Порядок разбора: просьба научить («покажи, как создать…», assistLearnStub) → слова отбора («покажи») → вопрос о системе → правило → команда → правка. Команда над объектами
    // («поставь контроллеры на охрану») — отбор: выполняет её человек. Подпись команды сравнивается по первым пяти буквам
    // слов, поэтому она перехватывает просьбу, только если разбор правки не узнал в ней свойства: «включи запись» — правка,
    // даже когда у вида есть команда «Включить». Выбранное держит в себе, в событиях его нет
    function assistKindOf(said) {
      const low = said.toLowerCase();
      // «покажи, как создать правило», «как настроить детекторы»: «как» и глагол в неопределённой форме — просьба научить
      if (/(^|[^а-яё])как\s+[а-яё]+(ть|ться|ти|чь)(?![а-яё])/.test(low)) return "learn";
      if (/выгруз|экспорт|кадр с камер/.test(low) && caps().operations.includes("createExport")) return "export";
      if (/дай список|покажи|выведи/.test(low)) return "found";
      if (/сколько|почему|какой|какая|какие/.test(low)) return "explain";
      if (/правил|при движени|эскалац|спроси|окно обслуживания|расписани|услови|детектор на время|провер\S* архив|лимит/.test(low)) return "rules";
      if (assistActionOf(said) && !assistEditOf(said).field.size) return "found";
      return "config";
    }
    // Отбор: условия по словам просьбы — фильтры GET /units (AssistFoundFilter) и то, что фильтром не выражается (папка,
    // значение перечня); отбирает код по объектам — тем же unitFilter, что GET /units, — не модель. Только читает. ids по имени,
    // без повторов, до selectMax. Filter — когда всё выражается фильтром и отобрано больше selectMax или просили команду;
    // есть условие, которое проверяется по объекту (папка, значение перечня), — ids (больше selectMax — первые и truncated),
    // и с командой тоже: тогда action стоит рядом с ids
    function assistFoundStub(said, context, at) {
      let rest = assistNorm(said);
      const eatRe = (re) => {
        const m = rest.match(re);
        if (m) rest = rest.replace(m[0], " ");
        return m;
      };
      // Условие: rank — порядок слов в ответе, f — часть фильтра, test — проверка объекта, если фильтром не выразить
      const conds = [];
      const add = (rank, word, f, test) => conds.push({ rank, word, f, test });
      const action = assistActionOf(said);
      if (action) rest = assistEat(rest, assistWords(action.label).filter((w) => w.length >= 4).flatMap((w) => assistWords(rest).filter((r) => r.slice(0, 5) === w.slice(0, 5))));
      const recOff = eatRe(/без записи|запис\S* выключ\S*|выключенн\S* запис\S*|не пиш\S*/);
      if (recOff) add(1, "запись: нет", { noRecord: true });
      const det = eatRe(/(?:без|нет) детектор\S*(?:\s+([a-zа-я]+))?/);
      if (det) {
        // Вид детектора — по подписи перечня detectorKind видов профиля vms.detector/1
        const codes = det[1] ? kinds.list().filter((k) => kinds.profileOf(k.kind, "vms.detector/1")).flatMap((k) => Object.entries((assistProps(k.kind).detectorKind || {})["x-enum-labels"] || {})).filter(([, l]) => assistLabelHit([det[1]], l)).map(([c]) => c) : [];
        if (codes.length) add(10, `детектор ${det[1]}: нет`, { noDetector: codes[0] });
        else {
          add(10, "детектор: нет", { noDetector: true });
          if (det[1]) rest += ` ${det[1]}`;
        }
      }
      if (eatRe(/без папк\S*|вне папок/)) add(8, "папка: нет", { noFolder: true });
      // Папка и домен — объекты профилей vms.folder/1, vms.domain/1 по имени в просьбе, самое длинное
      const named = (profile) => [...store.all()].filter((u) => kinds.profileOf(u.kind, profile) && u.name && rest.includes(assistNorm(u.name))).sort((a, b) => b.name.length - a.name.length)[0];
      if (/папк/.test(rest)) {
        const folder = named("vms.folder/1");
        if (folder) {
          add(6, `папка: ${folder.name}`, null, (u) => (u.folders || []).includes(folder.uid));
          rest = rest.replace(assistNorm(folder.name), " ").replace(/\S*папк\S*/g, " ");
        }
      }
      if (/домен/.test(rest)) {
        const domain = named("vms.domain/1");
        if (domain) {
          add(7, `домен: ${domain.name}`, { domainId: domain.uid });
          rest = rest.replace(assistNorm(domain.name), " ").replace(/\S*домен\S*/g, " ");
        }
      }
      if (eatRe(/не на связи|без связи|офлайн|оффлайн/)) add(3, "на связи: нет", { status: ["offline"] });
      else if (eatRe(/на связи|онлайн/)) add(3, "на связи: да", { status: ["online"] });
      if (!recOff && eatRe(/выключенн\S*/)) add(2, "включена: нет", { status: ["off"] });
      else if (!recOff && eatRe(/(^|[^ы])включенн\S*/)) add(2, "включена: да", { status: ["run", "nosignal", "license"] });
      const name = eatRe(/(?:имя содержит|с именем|в имени)\s*«?([^»,.]+)»?/);
      if (name && name[1].trim()) add(9, `имя содержит: ${name[1].trim()}`, { q: name[1].trim(), fields: ["name"] });
      // Виды — по подписи вида; команда сама называет свои виды
      const hits = assistKindsIn(rest);
      rest = assistEat(rest, hits.flatMap((h) => h.m));
      const scope = action ? action.kinds : hits.length ? [...new Set(hits.map((h) => h.k.kind))] : kinds.list().map((k) => k.kind);
      if (action || hits.length) add(0, `тип: ${[...new Set(scope.map((k) => assistKindLabel(k).toLowerCase()))].join(", ")}`, { kinds: scope });
      // Значение перечня по подписи (x-enum-labels) у видов отбора: «режим: ручной», «когда писать: всегда»
      const enums = new Map();
      scope.forEach((kind) => Object.entries(assistProps(kind)).forEach(([prop, s]) => {
        const labels = (s && s["x-enum-labels"]) || {};
        Object.entries(labels).forEach(([v, l]) => {
          const m = assistLabelHit(assistWords(rest), l, 4);
          if (!m) return;
          const word = `${assistText(s["x-label"]).toLowerCase() || prop}: ${assistText(l).toLowerCase()}`;
          const e = enums.get(word) || enums.set(word, { tests: [], m }).get(word);
          e.tests.push((u) => u.kind === kind && (Array.isArray(props(u)[prop]) ? props(u)[prop].includes(v) : props(u)[prop] === v));
        });
      }));
      enums.forEach((e, word) => add(4, word, null, (u) => e.tests.some((t) => t(u))));
      enums.forEach((e) => (rest = assistEat(rest, e.m)));
      // Значение свойства с x-search у объектов видов отбора, целым словом: «производитель: Axis», «серийный номер: TU-0001»
      // Кандидаты — куски фразы между границами слов (их десятки), а не весь словарь (на xl значений — миллион); длинные первыми
      const { values } = assistValuesOf(scope);
      const edge = (c) => c === undefined || !/[a-zа-я0-9-]/.test(c);
      const keys = [];
      for (let i = 0; i < rest.length; i++) {
        if (!edge(rest[i - 1])) continue;
        for (let j = i + 3; j <= rest.length; j++) if (edge(rest[j]) && values.has(rest.slice(i, j))) keys.push(rest.slice(i, j));
      }
      [...new Set(keys)].sort((a, b) => b.length - a.length).forEach((key) => {
        const at = new RegExp(`(^|[^a-zа-я0-9-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^a-zа-я0-9-]|$)`);
        if (!at.test(rest)) return;
        const x = values.get(key);
        rest = rest.replace(at, "$1 ");
        add(5, `${x.label}: ${x.v}`, { q: x.v, fields: [x.prop] }, null);
      });
      const out = [{ type: "progress", at, text: "отбираю" }];
      if (!conds.length) return out.concat({ type: "question", at, text: "По какому условию отобрать?", context });
      // Фильтр — из частей условий; ключ занят (второе q, второй status) — то условие проверкой объекта
      const filter = {}, tests = [];
      conds.sort((a, b) => a.rank - b.rank);
      conds.forEach((c) => {
        if (c.f && Object.keys(c.f).every((k) => !(k in filter))) Object.assign(filter, c.f);
        else if (c.f) tests.push(c.f.q !== undefined ? (u) => !!matchOf(u, c.f.q, c.f.fields) : (u) => unitStatusHit(u, c.f.status));
        else tests.push(c.test);
      });
      const { hit } = unitFilter(assistUnitsQuery(filter));
      // На xl под отбор попадает до миллиона объектов: сортировка по имени — только когда в ответ идут ids, и только первые
      // selectMax (отбор за один проход), а для ответа фильтром нужно одно число. uid в складе уникальны
      const all = [];
      for (const u of store.all()) if (hit(u) && tests.every((t) => t(u))) all.push(u);
      const max = db.reference.limits.selectMax, total = all.length;
      const conditions = conds.map((c) => c.word);
      const e = { type: "found", at, context, conditions };
      if (!tests.length && (action || total > max)) {
        Object.assign(e, { filter, total });
        e.text = `Отобрано: ${total}.${action ? ` Команда «${action.label}» — над отобранным, из групповой карточки.` : " Листается фильтром."}`;
      } else {
        const first = [];
        for (const u of all) {
          if (first.length === max && assistByName(u, first[max - 1]) >= 0) continue;
          let lo = 0, hi = first.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (assistByName(first[mid], u) < 0) lo = mid + 1; else hi = mid; }
          first.splice(lo, 0, u);
          if (first.length > max) first.pop();
        }
        Object.assign(e, { ids: first.map((u) => u.uid), total });
        if (total > max) e.truncated = true;
        e.text = !total ? "Ничего не отобрано." : `Отобрано: ${total}.${total > max ? ` Показаны первые ${max}.` : ""}`;
      }
      if (action) e.action = action.id;
      return out.concat(e);
    }
    /* Просьба научить: ответ answer, и если в каталоге обучения консоли есть подходящие главы — learn, ссылки на них
       (AssistLearnLink: версия каталога, ID темы и главы). Каталог даёт страница (opts.learn — функция, Tour.catalog), у сервера
       своего нет: без каталога или с недоступным материалом — обычный answer. Глава — по словам просьбы в названии темы и главы
       и в цели главы, название главы весит вдвое; лучшие, не больше трёх. Не нашлось — answer без learn. Это не модель:
       настоящий выбор главы — у бэкенда VMS по его каталогу */
    const LEARN_STOP = ["покаж", "научи", "объяс", "пожал", "можно", "нужно", "хочу", "консо", "систе", "через", "чтобы"];
    function assistLearnStub(said, context, at) {
      const out = [{ type: "progress", at, text: "ищу учебную главу" }];
      const last = (e) => out.concat(Object.assign({ at, context }, e));
      let cat = null;
      try {
        cat = typeof opts.learn === "function" ? opts.learn() : null;
      } catch (e) {}
      if (!cat || !cat.available || !/^sha256:[0-9a-f]{64}$/.test(cat.version || "") || !(cat.topics || []).length) return last({ type: "answer", text: "В этой консоли нет учебных глав. Спросите администратора." });
      const stem = (t) => assistWords(t).filter((w) => w.length >= 4).map((w) => w.slice(0, 5));
      const want = [...new Set(stem(said).filter((w) => !LEARN_STOP.includes(w)))];
      const hits = (t) => { const have = new Set(stem(t)); return want.filter((w) => have.has(w)).length; };
      const scored = [];
      cat.topics.forEach((tp) => (tp.chapters || []).forEach((ch) => scored.push({ tp, ch, n: hits(tp.title) + 2 * hits(ch.title) + hits(ch.goal) })));
      const best = Math.max(0, ...scored.map((x) => x.n));
      if (!best) return last({ type: "answer", text: "Готовой учебной главы на эту тему нет. Задайте вопрос иначе или откройте раздел «Обучение»." });
      const top = scored.filter((x) => x.n === best).slice(0, 3);
      return last({ type: "answer", text: `Есть готовый учебный пример: «${top[0].ch.title}». Показ идёт на учебных данных и не меняет систему.`, learn: top.map((x) => ({ catalog: cat.version, topic: x.tp.id, chapter: x.ch.id })) });
    }
    // Вопрос о системе: только чтение, конечное событие answer, плана нет. Виды, названные в просьбе, — по подписи
    function assistExplainStub(said, context, at) {
      const low = said.toLowerCase();
      const count = (kind) => store.byKind(kind).length;
      const named = assistKindsIn(said).map((h) => `, ${assistKindLabel(h.k.kind)}: ${count(h.k.kind)}`);
      const text = /правил/.test(low) ? `Правил: ${db.rules.length}.` : `Объектов: ${store.size()}${[...new Set(named)].join("")}.`;
      return [{ type: "progress", at, text: "читаю систему" }, { type: "answer", at, text, context }];
    }
    // Заказ выгрузки: камеры — объекты профиля vms.camera/1 по словам имени, «кадр» — кадр архива минуту назад, «живой» —
    // кадр сейчас, иначе видео за последние N минут (10 по умолчанию). Камеры заказа — по uid (ExportCamera.uid). Ход ничего
    // не пишет: пароль и супервизора вводит человек в окне
    function assistExportStub(said, context, at) {
      const low = said.toLowerCase(), out = [{ type: "progress", at, text: "читаю камеры" }];
      const last = (e) => out.concat(Object.assign({ at }, e));
      if (/маск|облак/.test(low)) return last({ type: "refused", text: "Маскирования и выгрузки в облако в этой системе нет.", context });
      const words = low.split(/[^а-яёa-z0-9]+/).map((w) => w.slice(0, 5)).filter((w) => w.length >= 4 && !ASSIST_STOP.includes(w) && !["выгру", "экспо", "кадр", "кадра", "минут", "после", "живой", "сейча", "видео", "архив"].includes(w));
      // Имя камеры целиком в просьбе — только такие камеры, иначе — по словам имени
      const all = [...store.all()].filter(isCamera), nameOf = (u) => String(u.name).toLowerCase();
      const named = all.filter((u) => low.includes(nameOf(u)));
      const cams = named.length ? named : all.filter((u) => words.some((w) => nameOf(u).includes(w)));
      if (!cams.length) return last({ type: "question", text: "С каких камер выгрузить?", context });
      const ref = expRef(), fmt = (kind) => (ref.formats.find((f) => f.kind === kind) || {}).id;
      const frame = /кадр/.test(low), live = frame && /живо|сейчас/.test(low);
      const body = { mode: frame ? "frame" : "video", cameras: (frame ? cams.slice(0, 1) : cams.slice(0, ref.limits.maxCameras)).map((u) => ({ uid: u.uid })), format: fmt(frame ? "frame" : "video") };
      if (live) body.source = "live";
      else if (frame) body.at = iso(now() - 60000);
      else {
        const min = Math.max(1, Math.min(Number((low.match(/(\d+)\s*мин/) || [])[1]) || 10, ref.limits.maxTotalSec / 60));
        body.periods = [{ from: iso(now() - min * 60000), to: iso(now()) }];
      }
      out.push({ type: "progress", at, text: "собираю заказ" });
      const names = body.cameras.map((c) => store.get(c.uid).name).join(", ");
      return last({ type: "plan", summary: frame ? `Кадр: ${names}` : `Выгрузка: ${names}`, context, export: body });
    }
    // Разбор правки: что меняется (вид → свойство) и кого. Слова профиля (ASSIST_PHRASES), «включи/выключи» — булево свойство
    // с подписью «Включено…», «смени|поменяй|… <поле> … на <значение>» — свойство по x-label. field пуст — правку не узнали
    function assistEditOf(said) {
      const low = assistNorm(said);
      // «смени … на <значение>»: значение — после последнего «на», в словах кого и что его нет
      const setVerb = /(^|\s)(смени|поменяй|измени|поставь|установи|задай|переведи|сделай)(\s|$)/.test(low);
      // «поменяй маску сети на камерах»: после «на» — вид, а не значение
      const at4 = setVerb ? low.lastIndexOf(" на ") : -1;
      const cut = at4 >= 0 && !assistKindsIn(low.slice(at4 + 4)).length ? at4 : -1;
      const valueText = cut >= 0 ? said.slice(cut + 4).trim() : null;
      let rest = cut >= 0 ? low.slice(0, cut) : low;
      const hits = assistKindsIn(rest);
      rest = assistEat(rest, hits.flatMap((h) => h.m));
      const named = hits.length ? new Set(hits.map((h) => h.k.kind)) : null;
      const inScope = (k) => !named || named.has(k.kind);
      // Поле: вид → имя свойства; value — готовое значение (слова профиля, включи/выключи)
      const field = new Map();
      let value;
      const phrase = ASSIST_PHRASES.find((p) => p.re.test(low));
      if (phrase) {
        kinds.list().filter((k) => inScope(k) && kinds.profileOf(k.kind, phrase.profile) && assistProps(k.kind)[phrase.name]).forEach((k) => field.set(k.kind, phrase.name));
        value = phrase.value;
        rest = rest.replace(/\S*запис\S*/g, " ");
      } else if (setVerb) {
        const words = assistWords(rest);
        const found = [];
        kinds.list().filter(inScope).forEach((k) => Object.entries(assistProps(k.kind)).forEach(([prop, s]) => {
          const m = s && !s.readOnly && s["x-label"] && assistLabelHit(words, s["x-label"]);
          if (m) found.push({ kind: k.kind, prop, m });
        }));
        const most = Math.max(0, ...found.map((x) => x.m.length));
        found.filter((x) => x.m.length === most).forEach((x) => (field.has(x.kind) ? null : field.set(x.kind, x.prop)));
        rest = assistEat(rest, found.flatMap((x) => x.m));
      } else if (/(^|[^ы])включи|выключи/.test(low)) {
        // «включи/выключи» без поля — булево свойство с подписью «Включено…»
        kinds.list().filter(inScope).forEach((k) => {
          const prop = Object.keys(assistProps(k.kind)).find((n) => [].concat(assistProps(k.kind)[n].type || []).includes("boolean") && (assistWords(assistText(assistProps(k.kind)[n]["x-label"]))[0] || "").startsWith("включ"));
          if (prop) field.set(k.kind, prop);
        });
        value = !/выключи/.test(low);
      }
      return { setVerb, valueText, named, field, value, rest };
    }
    // Шаг плана против описания вида — как PATCH /units/{uid}: вид пишется, свойства — схемой в два прохода (contract.js),
    // x-immutable, x-bound-to, x-unique. Смысл профиля (сервер без связи, хранилище записи) — не здесь: его скажет шаг при «Применить»
    function assistPlanErrs(u, patch) {
      const out = kindErrs(u.kind);
      if (out.length || isDocument(u.kind)) return out;
      const errs = kinds.validate(u.kind, patch.properties, { partial: true, old: props(u), secrets: Object.keys(u.secrets || {}) });
      return errs.length ? errs : uniqueErrs(u.kind, u.parentId, Kinds.mergePatch(props(u), patch.properties), u.uid, "");
    }
    // Значение просьбы по схеме свойства: перечень — значение или его подпись (x-enum-labels), да/нет, число, иначе текст.
    // Вне схемы — как есть: план проверяет схема вида
    function assistValueOf(s, text) {
      const t = String(text).trim(), low = assistNorm(t);
      if (s.enum) {
        const raw = s.enum.find((v) => assistNorm(v) === low);
        if (raw !== undefined) return raw;
        const byLabel = Object.entries(s["x-enum-labels"] || {}).find(([, l]) => assistLabelHit(assistWords(t), l));
        return byLabel ? s.enum.find((v) => String(v) === byLabel[0]) : t;
      }
      const types = [].concat(s.type || []);
      if (types.includes("boolean") && /^(да|вкл\S*|true)$/.test(low)) return true;
      if (types.includes("boolean") && /^(нет|выкл\S*|false)$/.test(low)) return false;
      if ((types.includes("integer") || types.includes("number")) && /^-?\d+([.,]\d+)?$/.test(t)) return Number(t.replace(",", "."));
      return t;
    }
    // План настройки: шаги {uid, version, patch} — JSON Merge Patch объекта, как PATCH /units/{uid}; поле — JSON Pointer.
    // Что меняется: слова профиля (ASSIST_PHRASES), «включи/выключи» — свойство с подписью «Включено», «смени <поле> на
    // <значение>» — свойство по x-label. Кого: виды по подписи и имена объектов. Каждый шаг сверен со схемой вида, как PATCH:
    // не подходит — отказ с указателем. Частичных планов нет
    function assistStub(body) {
      const said = `${(body.context || "").replace(/^stub:/, "")} ${body.text}`.trim();
      const kind = assistKindOf(said);
      if (kind === "learn") return assistLearnStub(said, `stub:${said}`, iso(now()));
      if (kind === "rules") return assistRulesStub(said, `stub:${said}`, iso(now()));
      if (kind === "explain") return assistExplainStub(said, `stub:${said}`, iso(now()));
      if (kind === "found") return assistFoundStub(said, `stub:${said}`, iso(now()));
      if (kind === "export") return assistExportStub(said, `stub:${said}`, iso(now()));
      const low = assistNorm(said);
      const context = `stub:${said}`;
      const at = iso(now());
      const out = [{ type: "progress", at, text: "читаю объекты" }];
      const last = (e) => out.concat(Object.assign({ at }, e));
      if (/сбой/.test(low)) return last({ type: "error", code: "UPSTREAM_UNAVAILABLE", message: "модель не отвечает" });
      const { setVerb, valueText, named, field, value, rest } = assistEditOf(said);
      if (setVerb && !field.size) return last({ type: "refused", text: "Такого поля нет в описании видов.", context });
      if (setVerb && !valueText) return last({ type: "question", text: "Какое значение поставить?", context });
      if (!field.size) return last({ type: "question", text: "Что изменить?", context });
      // Кого: объекты видов поля по словам имени; слов нет, но виды названы — все объекты этих видов
      const words = assistWords(rest).map((w) => w.slice(0, 5)).filter((w) => w.length >= 4 && !ASSIST_STOP.includes(w));
      if (!words.length && !named) return last({ type: "question", text: "На каких объектах?", context });
      const units = [...field.keys()].flatMap((k) => store.byKind(k)).filter((u) => !words.length || words.some((w) => assistNorm(u.name).includes(w))).sort(assistByName);
      // Значение — по схеме свойства вида; секрет — номер из полей ассистента, значение в пояснение не идёт
      const secretNo = valueText ? (assistNorm(valueText).match(/^секрет\D*(\d+)/) || [])[1] : null;
      const items = [];
      for (const u of units) {
        const prop = field.get(u.kind), s = assistProps(u.kind)[prop] || {};
        let v = value;
        if (s.writeOnly) {
          v = secretNo ? (body.secrets || [])[Number(secretNo) - 1] : undefined;
          if (v === undefined) return last({ type: "question", text: "Какой секрет поставить?", context });
        } else if (v === undefined) v = assistValueOf(s, valueText);
        // Частичных правок и пустых строк в плане нет: объект, где значение уже такое, в план не идёт
        if (!s.writeOnly && JSON.stringify(props(u)[prop]) === JSON.stringify(v)) continue;
        const patch = { properties: { [prop]: v } };
        const errs = assistPlanErrs(u, patch);
        if (errs.length) {
          const shown = s.writeOnly ? `секрет № ${secretNo}` : JSON.stringify(v);
          return last({ type: "refused", text: `${shown} не подходит под описание вида «${assistKindLabel(u.kind)}» (${errs[0].field}).`, context, field: errs[0].field });
        }
        const change = { field: `/properties/${esc(prop)}`, after: s.writeOnly ? `новый (секрет № ${secretNo})` : v, why: "просьба" };
        if (!s.writeOnly) change.before = props(u)[prop] === undefined ? null : clone(props(u)[prop]);
        items.push({ uid: u.uid, version: u.version, patch, name: u.name, changes: [Object.assign({ field: change.field }, "before" in change ? { before: change.before } : {}, { after: change.after, why: change.why })] });
      }
      if (!items.length) return last({ type: "question", text: "На каких объектах?", context });
      out.push({ type: "progress", at, text: "проверяю план" });
      const per = new Map();
      items.forEach((x) => {
        const k = store.get(x.uid).kind;
        const l = kinds.profileOf(k, "vms.camera/1") ? "Камеры" : assistKindLabel(k);
        per.set(l, (per.get(l) || 0) + 1);
      });
      // Итог плана — как у базы: у камер «Камеры: N» (во множественном числе); у видов, которых в базе нет, — подпись вида
      return last({ type: "plan", summary: [...per].map(([l, n]) => `${l}: ${n}`).join(", "), context, items });
    }

    const compile = (list, test) =>
      list.map(([method, template, fn]) => {
        const names = [];
        const re = new RegExp(`^${template.replace(/\{(\w+)\}/g, (m, name) => (names.push(name), "([^/]+)"))}$`);
        return { method, template, re, names, fn, test };
      });
    const compiled = compile(ROUTES, false).concat(compile(TEST_ROUTES, true));

    function handle(method, url, body, headers) {
      const [path, query = ""] = String(url).split("?");
      const q = {};
      new URLSearchParams(query).forEach((v, k) => (q[k] = v));
      const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const fits = compiled.filter((r) => r.method === method && r.re.test(path)).sort((a, b) => a.names.length - b.names.length);
      const route = fits[0];
      if (!route) return problem(404, "NO_ROUTE", `${method} ${path}: такой операции нет`);
      if (route.test && !testSupport) return problem(404, "TEST_SUPPORT_OFF", "Служебные операции тестового стенда выключены");
      const operationId = OPERATION[`${method} ${shape(route.template)}`];
      if (!route.test && operationId && !caps().operations.includes(operationId)) return problem(404, "NO_ROUTE", `${method} ${path}: система этого не поддерживает (${operationId} нет в capabilities)`);
      const m = path.match(route.re);
      const params = {};
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      // Тело — по контракту: что не подходит под схему, сервер не выполняет
      if (SPEC && method !== "GET" && window.ConsolemContract) {
        const errs = window.ConsolemContract.requestProblems(SPEC, method, path, body);
        if (errs.length) {
          let field = (errs[0].match(/^body\.?([^:\s[]*)/) || [])[1] || undefined;
          // На путях ядра field — JSON Pointer в теле запроса
          if (/^\/(units|kinds|test\/kinds|exports)(\/|$)/.test(path)) field = "/" + ((errs[0].match(/^body\.?([^:\s]*)/) || [])[1] || "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).join("/");
          return problem(422, "VALIDATION_FAILED", errs.slice(0, 3).join("; "), field ? { field } : {});
        }
      }
      // Перед запросом — всё, что уже наступило по времени: шаги операций не ждут следующего такта
      if (!route.test) tick();
      const key = method === "POST" && body && body.idempotencyKey ? `${method} ${path} ${body.idempotencyKey}` : null;
      answered.forEach((a, k) => now() - a.at >= IDEMPOTENCY_MS && answered.delete(k));
      if (key && answered.has(key)) return clone(answered.get(key).res);
      coreMode = /^\/units(\/|$)/.test(path);
      let res;
      try {
        res = route.fn(params, q, body || {}, h);
      } finally {
        coreMode = false;
      }
      const out = { status: res.status, body: res.body === undefined ? null : res.body, headers: res.headers || {} };
      if (key && res.status < 300) answered.set(key, { at: now(), res: clone(out) });
      return out;
    }

    load(FIXTURE);
    if (opts.autoTick !== false) setInterval(tick, 40);

    return {
      handle,
      subscribe,
      routes: compiled.map((r) => `${r.method} ${r.template}`),
    };
  }

  window.ConsolemServer = { create, legacyFixture };
})();
