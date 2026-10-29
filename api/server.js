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
  const KIND = { operation: "0", domain: "1", server: "2", device: "3", folder: "4", archive: "5", volume: "6", rule: "7", history: "e" };
  const TABLES = { domains: "domain", servers: "server", devices: "device", folders: "folder", archives: "archive", volumes: "volume", rules: "rule" };
  // Ответ на запрос с ключом повтора помнится 10 минут: повтор получает его же и ничего не выполняет снова
  const IDEMPOTENCY_MS = 10 * 60 * 1000;
  const STREAM_DEPTH = 500;

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
    // Пароли — отдельно от записей: в ответах их нет, только hasPassword
    let secrets = new Map();
    const seq = {};
    let ops = new Map();
    const answered = new Map();

    function load(fixture) {
      db = shiftTimes(clone(fixture), now() - Date.parse(fixture.capturedAt));
      me = db.me.userId;
      secrets = new Map();
      ops = new Map();
      formatting = new Map();
      searches = new Map();
      syncing = new Map();
      answered.clear();
      // Номера новых id — после самых больших в наборе
      Object.keys(seq).forEach((k) => delete seq[k]);
      JSON.stringify(db).replace(/"id":"([0-9a-f])(\d{7})-0000-4000-8000-0{12}"/g, (m, kind, n) => {
        seq[kind] = Math.max(seq[kind] || 0, Number(n));
        return m;
      });
    }
    const uuid = (kind) => {
      const k = KIND[kind];
      seq[k] = (seq[k] || 0) + 1;
      return `${k}${String(seq[k]).padStart(7, "0")}-0000-4000-8000-000000000000`;
    };
    const byId = (table, id) => db[table].find((r) => r.id === id) || null;
    // Возможности системы — из набора: так же их объявляет бэкенд в GET /reference
    const caps = () => db.reference.capabilities;
    const can = (feature) => caps().features.includes(feature);

    /* ===== Поток событий ===== */

    let seqEvent = 0;
    const history = [];
    const listeners = new Set();
    function send(type, fields) {
      const message = Object.assign({ id: String(++seqEvent), type, at: iso(now()) }, fields || {});
      history.push(message);
      if (history.length > STREAM_DEPTH) history.shift();
      listeners.forEach((fn) => setTimeout(() => fn(clone(message)), 0));
    }
    const changed = (kind, rec) => send("entity.changed", { kind, entityId: rec.id, version: rec.version });
    // Переподключение с Last-Event-ID: пропущенное досылается; если его уже нет — stream.reset,
    // и клиент перечитывает всё
    function subscribe(fn, lastEventId) {
      if (lastEventId != null && lastEventId !== "") {
        const i = history.findIndex((m) => m.id === String(lastEventId));
        const missed = i >= 0 ? history.slice(i + 1) : [{ id: String(seqEvent), type: "stream.reset", at: iso(now()), payload: {} }];
        missed.forEach((m) => setTimeout(() => fn(clone(m)), 0));
      }
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

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
    // Версия из If-Match: нет заголовка — 428, не совпала — 412 с актуальной записью
    function precondition(rec, headers) {
      const v = parseMatch(headers["if-match"]);
      if (v == null || v === "") return problem(428, "PRECONDITION_REQUIRED", "Нужен заголовок If-Match с версией записи");
      if (v !== rec.version) return problem(412, "VERSION_MISMATCH", "Запись изменилась с момента чтения", { current: clone(rec) });
      return null;
    }

    /* ===== Устройства ===== */

    function device(rec) {
      const out = clone(rec);
      if (secrets.has(rec.id)) out.hasPassword = true;
      return out;
    }
    // Сервер устройства: свой (камера, регистратор, детектор, служба) или ближайшего родителя
    function serverOf(dev) {
      for (let d = dev; d; d = d.parentId ? byId("devices", d.parentId) : null) if (d.serverId) return byId("servers", d.serverId);
      return null;
    }
    const offline = (s) => !!s && s.online === false && s.allocated;

    // Проверка изменения до выполнения: ссылки ведут в существующие записи, имя не пустое
    function patchProblem(patch) {
      if ("name" in patch && !String(patch.name || "").trim()) return problem(422, "NAME_REQUIRED", "Имя не может быть пустым", { field: "name" });
      const refs = { serverId: "servers", archiveId: "archives", cameraId: "devices" };
      for (const [field, table] of Object.entries(refs)) {
        if (patch[field] != null && !byId(table, patch[field])) return problem(422, "VALIDATION_FAILED", `Нет записи ${patch[field]}`, { field });
      }
      for (const x of patch.extraArchives || []) {
        if (!byId("archives", x.archiveId)) return problem(422, "VALIDATION_FAILED", `Нет хранилища ${x.archiveId}`, { field: "extraArchives" });
      }
      return null;
    }
    // Объект изменения по id: устройство, сервер или домен — у каждого своя схема изменения
    const KINDS = [
      ["devices", "device", "DevicePatch"],
      ["servers", "server", "ServerPatch"],
      ["domains", "domain", "DomainPatch"],
      ["archives", "archive", "ArchivePatch"],
      ["volumes", "volume", "VolumePatch"],
    ];
    function targetOf(id) {
      for (const [table, kind, schema] of KINDS) {
        const rec = byId(table, id);
        if (rec) return { table, kind, schema, rec };
      }
      return null;
    }
    const view = (t) => (t.kind === "device" ? device(t.rec) : t.kind === "volume" ? volume(t.rec) : clone(t.rec));

    /* ===== Тома ===== */

    // Форматирование идёт по часам сервера: том → когда закончится
    const FORMAT_MS = 1500;
    let formatting = new Map();
    function volume(rec) {
      const out = clone(rec);
      if (secrets.has(rec.id)) out.hasPassword = true;
      if (secrets.has(rec.id + ":secret")) out.hasSecret = true;
      return out;
    }
    // Том годится для хранилища: у локального — диск его сервера, не занятый разделом и не повторяющийся
    // в этом хранилище; у облачного — бакет
    function volumeProblem(a, v) {
      if (!String(v.disk || "").trim()) return problem(422, "VALIDATION_FAILED", "Укажите диск или путь", { field: "disk" });
      if (a.kind === "cloud" && !String(v.bucket || "").trim()) return problem(422, "VALIDATION_FAILED", "Укажите бакет", { field: "bucket" });
      if (a.kind !== "local") return null;
      const s = byId("servers", a.serverId);
      if (!s.disks.some((d) => d.disk === v.disk)) return problem(422, "VALIDATION_FAILED", `На сервере нет диска ${v.disk}`, { field: "disk" });
      const onDisk = db.volumes.filter((x) => x.disk === v.disk && db.archives.some((y) => y.id === x.archiveId && y.kind === "local" && y.serverId === a.serverId));
      if (onDisk.some((x) => x.archiveId === a.id || x.mode === "part") || (v.mode === "part" && onDisk.length))
        return problem(409, "DISK_TAKEN", `Диск ${v.disk} занят`, { field: "disk" });
      return null;
    }
    function newVolume(a, spec) {
      const v = { id: uuid("volume"), archiveId: a.id, name: spec.name, disk: spec.disk, sizeBytes: spec.sizeBytes, usedPercent: 0,
        // Раздел целиком подключают неотформатированным: форматируют отдельно, когда решат
        state: a.kind === "local" && spec.mode === "part" ? "unfmt" : "ready", online: true };
      Object.entries(spec).forEach(([k, x]) => {
        if (k === "password") secrets.set(v.id, x);
        else if (k === "secret") secrets.set(v.id + ":secret", x);
        else if (!(k in v)) v[k] = clone(x);
      });
      v.version = newVersion();
      db.volumes.push(v);
      return v;
    }
    function domainNameProblem(name, exceptId) {
      const v = String(name || "").trim();
      if (!v) return problem(422, "NAME_REQUIRED", "Укажите имя домена", { field: "name" });
      if (db.domains.some((d) => d.id !== exceptId && d.name.trim().toLowerCase() === v.toLowerCase())) return problem(409, "NAME_TAKEN", "Домен с таким именем уже есть", { field: "name" });
      return null;
    }
    // Изменение — по схеме своего вида и по смыслу: ссылки ведут в существующие записи, имя не пустое,
    // имя домена не занято
    function setProblem(t, patch) {
      if (SPEC && window.ConsolemContract) {
        const errs = window.ConsolemContract.check(SPEC, { $ref: `#/components/schemas/${t.schema}` }, patch, "set", []);
        if (errs.length) {
          const field = (errs[0].match(/^set\.?([^:\s[]*)/) || [])[1];
          return problem(422, "VALIDATION_FAILED", errs.slice(0, 3).join("; "), field ? { field } : {});
        }
      }
      if (t.kind === "domain" && "name" in patch) return domainNameProblem(patch.name, t.rec.id);
      return featureProblem(t.kind, patch) || patchProblem(patch);
    }
    // Необязательные настройки, которых в системе нет (capabilities.features), менять нельзя
    const FEATURE_FIELDS = { server: { role: "serverRoles", netmask: "serverNetwork", gateway: "serverNetwork", dns: "serverNetwork" } };
    function featureProblem(kind, patch) {
      const field = Object.keys(patch).find((k) => FEATURE_FIELDS[kind] && FEATURE_FIELDS[kind][k] && !can(FEATURE_FIELDS[kind][k]));
      if (field) return problem(422, "NOT_SUPPORTED", `Система не поддерживает: ${field}`, { field });
      if (kind === "archive" && patch.encrypted === true && !can("archiveEncryption")) return problem(422, "NOT_SUPPORTED", "Система не поддерживает шифрование хранилищ", { field: "encrypted" });
      return null;
    }
    // Значения до изменения — для отката: поля, которых не было, — null
    function applyPatch(rec, patch) {
      const before = {};
      Object.entries(patch).forEach(([k, v]) => {
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

    // Номер устройства (ID в системе) — у камер, регистраторов, источников событий и СКУД; без своего
    // номера считается короткое имя, если оно числом
    const NUMBERED = new Set(["camera", "ipsrv", "eventsrc", "acfa"]);
    const numberOf = (d) => (d.identifier != null && d.identifier !== "" ? String(d.identifier) : /^\d+$/.test(String(d.short || "")) ? String(d.short) : "");
    function nextIdentifier() {
      return String(Math.max(0, ...db.devices.filter((d) => NUMBERED.has(d.type)).map((d) => Number(numberOf(d)) || 0)) + 1);
    }
    function createProblem(spec, domainId, parentId, folderId) {
      const alien = (s) => !caps().deviceTypes.includes(s.type) || (s.children || []).some(alien);
      if (alien(spec)) return { code: "NOT_SUPPORTED", field: "type" };
      if (!byId("domains", domainId)) return { code: "NOT_FOUND", field: "domainId" };
      if (parentId) {
        const p = byId("devices", parentId);
        if (!p) return { code: "NOT_FOUND", field: "parentId" };
        if (p.domainId !== domainId) return { code: "PARENT_MISMATCH", field: "parentId" };
      }
      if (folderId) {
        const f = byId("folders", folderId);
        if (!f || f.domainId !== domainId) return { code: "VALIDATION_FAILED", field: "folderId" };
      }
      const bad = patchProblem(spec);
      if (bad) return { code: bad.body.code, field: bad.body.field };
      if (NUMBERED.has(spec.type) && spec.identifier != null && spec.identifier !== "") {
        if (db.devices.some((d) => NUMBERED.has(d.type) && numberOf(d) === String(spec.identifier))) return { code: "IDENTIFIER_TAKEN", field: "identifier" };
      }
      for (const c of spec.children || []) {
        const e = patchProblem(c);
        if (e) return { code: e.body.code, field: "children" };
      }
      return null;
    }
    // Устройство с дочерними — родитель первым, как в списке устройств
    function createDevice(spec, domainId, parentId, folderId) {
      const bad = createProblem(spec, domainId, parentId, folderId);
      if (bad) return bad;
      const devices = [];
      const make = (s, parent) => {
        const d = { id: uuid("device"), type: s.type, parentId: parent, domainId };
        Object.entries(s).forEach(([k, v]) => {
          if (k === "children" || k === "type") return;
          if (k === "password") {
            if (v) secrets.set(d.id, v);
            return;
          }
          d[k] = clone(v);
        });
        if (!parent && NUMBERED.has(s.type) && (d.identifier == null || d.identifier === "")) d.identifier = nextIdentifier();
        if (!("enabled" in d)) d.enabled = true;
        d.online = true;
        d.version = newVersion();
        db.devices.push(d);
        devices.push(d);
        send("entity.created", { kind: "device", entityId: d.id, version: d.version });
        (s.children || []).forEach((c) => make(c, d.id));
      };
      make(spec, parentId || null);
      const folders = [];
      if (folderId) {
        const f = byId("folders", folderId);
        f.deviceIds = f.deviceIds.concat(devices[0].id);
        bump(f);
        changed("folder", f);
        folders.push(f);
      }
      return { devices, folders };
    }
    // Вместе с дочерними; ссылки на него убираются из папок и из записи по детекторам
    function removeDevice(id) {
      const gone = new Set([id]);
      for (let grew = true; grew; ) {
        grew = false;
        db.devices.forEach((d) => {
          if (d.parentId && gone.has(d.parentId) && !gone.has(d.id)) {
            gone.add(d.id);
            grew = true;
          }
        });
      }
      db.devices = db.devices.filter((d) => !gone.has(d.id));
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
      gone.forEach((x) => {
        secrets.delete(x);
        wasRemoved.add(x);
        send("entity.deleted", { kind: "device", entityId: x });
      });
    }

    // Папка — вместе с подпапками; сами устройства остаются в системе
    function removeFolder(f) {
      const gone = new Set([f.id]);
      for (let grew = true; grew; ) {
        grew = false;
        db.folders.forEach((x) => {
          if (x.parentId && gone.has(x.parentId) && !gone.has(x.id)) {
            gone.add(x.id);
            grew = true;
          }
        });
      }
      db.folders = db.folders.filter((x) => !gone.has(x.id));
      gone.forEach((id) => send("entity.deleted", { kind: "folder", entityId: id }));
    }
    // Хранилище — с томами. Камеры остаются: основным становится первое дополнительное хранилище, без него
    // запись выключается
    function removeArchive(a) {
      db.devices.forEach((d) => {
        const extra = (d.extraArchives || []).filter((x) => x.archiveId !== a.id);
        const main = d.archiveId === a.id;
        if (!main && extra.length === (d.extraArchives || []).length) return;
        if (d.extraArchives) d.extraArchives = extra;
        if (main) {
          const next = extra.shift();
          if (next) Object.assign(d, { archiveId: next.archiveId, recordMode: next.recordMode, stream: next.stream });
          else Object.assign(d, { archiveId: null, recordMode: "none" });
        }
        bump(d);
        changed("device", d);
      });
      db.volumes.filter((v) => v.archiveId === a.id).forEach(removeVolume);
      db.archives = db.archives.filter((x) => x !== a);
      send("entity.deleted", { kind: "archive", entityId: a.id });
    }
    function removeVolume(v) {
      db.volumes = db.volumes.filter((x) => x !== v);
      formatting.delete(v.id);
      send("entity.deleted", { kind: "volume", entityId: v.id });
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
    // Кто сейчас администратор с неограниченным доступом: включён, роль с unr — личная или группы, срок не истёк
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
      // Защита от самоблокировки: администратор остаётся, и текущий — среди них
      const left = admins(a);
      if (!left.length) return problem(409, "SELF_LOCKOUT", "Не останется ни одного администратора с неограниченным доступом");
      if (!left.some((u) => u.id === me)) return problem(409, "SELF_LOCKOUT", "Вы потеряете неограниченный доступ или вход");
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

    const foldersOf = (deviceId) => db.folders.filter((f) => f.deviceIds.includes(deviceId)).map((f) => f.id);
    function setFolders(deviceId, folderIds) {
      const before = foldersOf(deviceId);
      db.folders.forEach((f) => {
        const has = f.deviceIds.includes(deviceId);
        const want = folderIds.includes(f.id);
        if (has === want) return;
        f.deviceIds = want ? f.deviceIds.concat(deviceId) : f.deviceIds.filter((x) => x !== deviceId);
        bump(f);
        changed("folder", f);
      });
      return before;
    }

    /* ===== Групповые операции ===== */

    // Шаг выполняется за 90–230 мс: столько, сколько в макете шла очередь. Разброс — от номера шага,
    // чтобы ход был живым и при этом повторялся от прогона к прогону
    const stepMs = (i) => 90 + ((i * 53) % 141);
    const opView = (op) => ({
      id: op.id,
      state: op.state,
      createdAt: op.createdAt,
      finishedAt: op.finishedAt,
      revertOf: op.revertOf,
      retryOf: op.retryOf,
      total: op.items.length,
      done: op.items.filter((x) => x.state !== "wait" && x.state !== "run").length,
      ok: op.items.filter((x) => x.state === "ok").length,
      failed: op.items.filter((x) => x.state === "fail").length,
      cancelled: op.items.filter((x) => x.state === "cancel").length,
      items: op.items.map((x) => {
        const out = { index: x.index, targetId: x.targetId, state: x.state, code: x.code };
        if (x.version !== undefined) out.version = x.version;
        if (x.createdId) out.createdId = x.createdId;
        return out;
      }),
    });
    const busy = (targetId) => [...ops.values()].some((op) => op.state !== "done" && op.items.some((x) => x.targetId === targetId && (x.state === "wait" || x.state === "run")));

    function startOperation(requests, extra) {
      const op = Object.assign(
        {
          id: uuid("operation"),
          state: "running",
          createdAt: iso(now()),
          finishedAt: null,
          revertOf: null,
          retryOf: null,
          items: requests.map((r, index) => ({ index, targetId: r.targetId, state: "wait", code: null, req: r })),
          nextAt: now() + stepMs(0),
        },
        extra || {}
      );
      ops.set(op.id, op);
      return op;
    }

    // Отказы — как в очереди макета: сервер устройства без связи не примет изменение; включить
    // камеру с превышенной лицензией нельзя; версия объекта для отката не совпала — его меняли после
    function runItem(op, item) {
      const t = targetOf(item.targetId);
      if (!t) return Object.assign(item, { state: "fail", code: "NOT_FOUND" });
      const rec = t.rec;
      if (item.req.expect !== undefined && rec.version !== item.req.expect) return Object.assign(item, { state: "fail", code: "VERSION_MISMATCH" });
      // Изменение устройства применяет его сервер, изменение сервера — сам сервер; домен — без сервера
      const archiveServer = (a) => (a && a.serverId ? byId("servers", a.serverId) : null);
      const via =
        t.kind === "device" ? serverOf(rec) : t.kind === "server" ? rec : t.kind === "archive" ? archiveServer(rec) : t.kind === "volume" ? archiveServer(byId("archives", rec.archiveId)) : null;
      if (offline(via)) return Object.assign(item, { state: "fail", code: "SERVER_OFFLINE" });
      if (item.req.set) {
        if (t.kind === "device" && item.req.set.enabled === true && rec.licenseExceeded) return Object.assign(item, { state: "fail", code: "LICENSE_EXCEEDED" });
        item.before = { set: applyPatch(rec, item.req.set) };
        changed(t.kind, rec);
      } else if (item.req.create) {
        const res = createDevice(item.req.create, rec.domainId, rec.id, null);
        if (res.code) return Object.assign(item, { state: "fail", code: res.code });
        item.createdId = res.devices[0].id;
        item.before = { remove: item.createdId };
      } else if (item.req.remove) {
        if (byId("devices", item.req.remove)) removeDevice(item.req.remove);
        item.before = {};
      } else {
        item.before = { folderIds: setFolders(rec.id, item.req.folderIds) };
      }
      return Object.assign(item, { state: "ok", code: null, version: rec.version });
    }

    function finish(op, fired) {
      op.state = "done";
      op.finishedAt = iso(now());
      const v = opView(op);
      send("operation.finished", { kind: "operation", entityId: op.id, payload: { state: v.state, ok: v.ok, failed: v.failed, cancelled: v.cancelled } });
      if (fired) fired.push({ kind: "operation", id: op.id });
    }

    // Всё, что к этому моменту должно было выполниться
    function tick() {
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

    /* ===== Маршруты ===== */

    const notFound = (what) => problem(404, "NOT_FOUND", `${what} не найден(а)`);
    function getter(table, label) {
      const show = (r) => (table === "devices" ? device(r) : table === "volumes" ? volume(r) : clone(r));
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

    const ROUTES = [
      [
        "GET",
        "/me",
        () => {
          const u = db.access.users.find((x) => x.id === me);
          return { status: 200, body: { userId: u.id, login: u.login, name: u.name, serverTime: iso(now()), timezone: db.timezone } };
        },
      ],
      ["GET", "/reference", () => ({ status: 200, body: clone(db.reference) })],
      ...getter("domains", "Домен"),
      ...getter("servers", "Сервер"),
      ...getter("devices", "Устройство"),
      ...getter("folders", "Папка"),
      ...getter("archives", "Хранилище"),
      ...getter("volumes", "Том"),
      ...getter("rules", "Правило"),
      [
        "PATCH",
        "/devices/{id}",
        (p, q, body, headers) => {
          const rec = byId("devices", p.id);
          if (!rec) return notFound("Устройство");
          const bad = precondition(rec, headers) || patchProblem(body);
          if (bad) return bad;
          applyPatch(rec, body);
          changed("device", rec);
          return one(device(rec));
        },
      ],
      /* ----- Домены ----- */
      [
        "POST",
        "/domains",
        (p, q, body) => {
          const bad = domainNameProblem(body.name);
          if (bad) return bad;
          const d = { id: uuid("domain"), name: body.name.trim(), license: "", online: true, version: newVersion() };
          db.domains.push(d);
          send("entity.created", { kind: "domain", entityId: d.id, version: d.version });
          return one(clone(d), 201);
        },
      ],
      [
        "PATCH",
        "/domains/{id}",
        (p, q, body, headers) => {
          const t = targetOf(p.id);
          if (!t || t.kind !== "domain") return notFound("Домен");
          const bad = precondition(t.rec, headers) || setProblem(t, body);
          if (bad) return bad;
          if ("name" in body) body.name = body.name.trim();
          applyPatch(t.rec, body);
          changed("domain", t.rec);
          return one(clone(t.rec));
        },
      ],
      [
        "DELETE",
        "/domains/{id}",
        (p, q, body, headers) => {
          const d = byId("domains", p.id);
          if (!d) return notFound("Домен");
          const bad = precondition(d, headers);
          if (bad) return bad;
          if (db.domains.length < 2) return problem(409, "LAST_DOMAIN", "Последний домен удалить нельзя");
          const inside = (r) => r.domainId === d.id;
          const busyWith = db.servers.some(inside) || db.folders.some(inside) || db.devices.some(inside) || db.archives.some(inside);
          const to = q.moveTo ? byId("domains", q.moveTo) : null;
          if (busyWith && (!to || to.id === d.id)) return problem(422, "DOMAIN_NOT_EMPTY", "Укажите домен, куда перенести содержимое", { field: "moveTo" });
          // Ничего не пропадает: серверы становятся нераспределёнными в домене moveTo, папки, устройства и
          // сетевые хранилища меняют домен, найденное поиском переходит туда же
          const move = (table, kind, extra) =>
            db[table].filter(inside).forEach((r) => {
              Object.assign(r, { domainId: to.id }, extra || {});
              bump(r);
              changed(kind, r);
            });
          if (to) {
            move("servers", "server", { allocated: false });
            move("folders", "folder");
            move("devices", "device");
            move("archives", "archive");
            const from = db.discovery.find((x) => x.domainId === d.id);
            if (from) {
              const into = db.discovery.find((x) => x.domainId === to.id);
              if (into) into.candidateIds = into.candidateIds.concat(from.candidateIds.filter((c) => !into.candidateIds.includes(c)));
              else from.domainId = to.id;
            }
            db.network.forEach((c) => (c.domainIds = [...new Set(c.domainIds.map((x) => (x === d.id ? to.id : x)))]));
          }
          db.discovery = db.discovery.filter((x) => x.domainId !== d.id);
          db.domains = db.domains.filter((x) => x !== d);
          send("entity.deleted", { kind: "domain", entityId: d.id });
          return { status: 204, body: null };
        },
      ],

      /* ----- Серверы ----- */
      [
        "POST",
        "/servers",
        (p, q, body) => {
          if (!byId("domains", body.domainId)) return notFound("Домен");
          const ip = String(body.ip).trim();
          if (!/^[\w.-]+$/.test(ip)) return problem(422, "INVALID_IP", "Неверный адрес", { field: "ip" });
          if (db.servers.some((s) => s.ip.toLowerCase() === ip.toLowerCase() && s.port === body.port)) return problem(409, "ADDRESS_TAKEN", "Сервер с таким адресом уже есть", { field: "ip" });
          // Найденный опросом сервер сообщает о себе имя, нагрузку и диски; встроенный сервер их придумывает
          const s = {
            id: uuid("server"),
            name: `Сервер — ${ip}`,
            ip,
            port: body.port,
            role: "node",
            domainId: body.domainId,
            allocated: false,
            online: true,
            telemetry: { cpu: 5, ram: 18, net: 2, disk: 0 },
            gpu: null,
            disks: [["C:", 256 * GB, true], ["D:", 4 * TB], ["E:", 6 * TB], ["F:", 8 * TB], ["G:", 12 * TB]].map(([disk, sizeBytes, system]) => ({ disk, sizeBytes, system: !!system })),
            version: newVersion(),
          };
          db.servers.push(s);
          send("entity.created", { kind: "server", entityId: s.id, version: s.version });
          return one(clone(s), 201);
        },
      ],
      [
        "PATCH",
        "/servers/{id}",
        (p, q, body, headers) => {
          const t = targetOf(p.id);
          if (!t || t.kind !== "server") return notFound("Сервер");
          const bad = precondition(t.rec, headers) || setProblem(t, body);
          if (bad) return bad;
          applyPatch(t.rec, body);
          changed("server", t.rec);
          return one(clone(t.rec));
        },
      ],
      [
        "POST",
        "/servers/probe",
        (p, q, body) => {
          const max = db.reference.limits.ipScanMax;
          if (body.targets.length > max) return problem(422, "IP_RANGE_TOO_LARGE", `За раз — не больше ${max} адресов`, { params: { max } });
          // Отвечает ли адрес — у встроенного сервера по хешу адреса: так же, как в макете на константах
          const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0);
          const items = body.targets.map(({ ip, port }) => {
            const s = db.servers.find((x) => x.ip.toLowerCase() === ip.toLowerCase() && x.port === port);
            if (s) return { ip, port, status: s.allocated ? "in-domain" : "found", serverId: s.id, domainId: s.allocated ? s.domainId : null };
            return { ip, port, status: hash(`${ip}:${port}`) % 3 === 0 ? "dead" : "found", serverId: null, domainId: null };
          });
          return { status: 200, body: { items } };
        },
      ],
      [
        "POST",
        "/servers/assign",
        (p, q, body) => {
          const done = [];
          const failed = [];
          body.items.forEach((x) => {
            const s = byId("servers", x.serverId);
            if (!s) return failed.push({ serverId: x.serverId, code: "NOT_FOUND" });
            if (!byId("domains", x.domainId)) return failed.push({ serverId: x.serverId, code: "NOT_FOUND" });
            if (s.version !== x.version) return failed.push({ serverId: x.serverId, code: "VERSION_MISMATCH" });
            if (s.domainId !== x.domainId || s.allocated !== x.allocated) {
              Object.assign(s, { domainId: x.domainId, allocated: x.allocated });
              bump(s);
              // Добавленный встаёт в конец списка — там, где его и ждут увидеть
              db.servers = db.servers.filter((r) => r !== s).concat(s);
              changed("server", s);
            }
            done.push(clone(s));
          });
          return { status: 200, body: { done, failed } };
        },
      ],

      /* ----- Папки ----- */
      [
        "POST",
        "/folders",
        (p, q, body) => {
          if (!byId("domains", body.domainId)) return notFound("Домен");
          if (!String(body.name).trim()) return problem(422, "NAME_REQUIRED", "Укажите имя папки", { field: "name" });
          if (body.parentId) {
            const parent = byId("folders", body.parentId);
            if (!parent) return notFound("Папка");
            if (parent.domainId !== body.domainId) return problem(422, "VALIDATION_FAILED", "Родительская папка — в другом домене", { field: "parentId" });
          }
          const f = { id: uuid("folder"), name: body.name.trim(), domainId: body.domainId, parentId: body.parentId, deviceIds: [], version: newVersion() };
          db.folders.push(f);
          send("entity.created", { kind: "folder", entityId: f.id, version: f.version });
          return one(clone(f), 201);
        },
      ],
      [
        "PATCH",
        "/folders/{id}",
        (p, q, body, headers) => {
          const f = byId("folders", p.id);
          if (!f) return notFound("Папка");
          const bad = precondition(f, headers);
          if (bad) return bad;
          if ("name" in body && !String(body.name).trim()) return problem(422, "NAME_REQUIRED", "Укажите имя папки", { field: "name" });
          const alien = (body.deviceIds || []).find((id) => {
            const d = byId("devices", id);
            return !d || d.domainId !== f.domainId;
          });
          if (alien) return problem(422, "VALIDATION_FAILED", `Устройства ${alien} нет в домене папки`, { field: "deviceIds" });
          if ("name" in body) body.name = body.name.trim();
          if (body.deviceIds) body.deviceIds = [...new Set(body.deviceIds)];
          applyPatch(f, body);
          changed("folder", f);
          return one(clone(f));
        },
      ],
      [
        "DELETE",
        "/folders/{id}",
        (p, q, body, headers) => {
          const f = byId("folders", p.id);
          if (!f) return notFound("Папка");
          const bad = precondition(f, headers);
          if (bad) return bad;
          removeFolder(f);
          return { status: 204, body: null };
        },
      ],
      /* ----- Хранилища и тома ----- */
      [
        "POST",
        "/archives",
        (p, q, body) => {
          if (!String(body.name).trim()) return problem(422, "NAME_REQUIRED", "Укажите имя хранилища", { field: "name" });
          if ((body.serverId == null) === (body.domainId == null)) return problem(422, "VALIDATION_FAILED", "Владелец — ровно один из serverId и domainId", { field: "serverId" });
          if (body.serverId && !byId("servers", body.serverId)) return notFound("Сервер");
          if (body.domainId && !byId("domains", body.domainId)) return notFound("Домен");
          if (body.kind === "local" && !body.serverId) return problem(422, "VALIDATION_FAILED", "Локальное хранилище — на сервере", { field: "serverId" });
          const unsupported = featureProblem("archive", body);
          if (unsupported) return unsupported;
          const a = {
            id: uuid("archive"),
            name: body.name.trim(),
            kind: body.kind,
            storage: body.kind === "cloud" ? "object" : body.storage,
            // Шифрование — только у объектного и облачного
            encrypted: !!body.encrypted && (body.kind === "cloud" || body.storage === "object"),
            retentionDays: body.retentionDays,
            provider: body.kind === "cloud" ? body.provider : null,
            serverId: body.serverId,
            domainId: body.domainId,
            version: newVersion(),
          };
          const bad = volumeProblem(a, body.firstVolume);
          if (bad) return bad;
          db.archives.push(a);
          const v = newVolume(a, body.firstVolume);
          send("entity.created", { kind: "archive", entityId: a.id, version: a.version });
          send("entity.created", { kind: "volume", entityId: v.id, version: v.version });
          return { status: 201, body: { archive: clone(a), volumes: [volume(v)] } };
        },
      ],
      [
        "POST",
        "/archives/check",
        (p, q, body) => {
          // Встроенный сервер не ходит в сеть: подключение «удаётся», если заполнено то, без чего не подключиться
          const v = body.volume;
          const missing = body.kind === "remote" ? !v.disk.trim() || !String(v.login || "").trim() : body.kind === "cloud" ? !String(v.bucket || "").trim() : false;
          return { status: 200, body: { ok: !missing, code: missing ? "CONNECTION_FAILED" : null } };
        },
      ],
      [
        "PATCH",
        "/archives/{id}",
        (p, q, body, headers) => {
          const t = targetOf(p.id);
          if (!t || t.kind !== "archive") return notFound("Хранилище");
          const bad = precondition(t.rec, headers) || setProblem(t, body);
          if (bad) return bad;
          applyPatch(t.rec, body);
          changed("archive", t.rec);
          return one(clone(t.rec));
        },
      ],
      [
        "DELETE",
        "/archives/{id}",
        (p, q, body, headers) => {
          const a = byId("archives", p.id);
          if (!a) return notFound("Хранилище");
          const bad = precondition(a, headers);
          if (bad) return bad;
          removeArchive(a);
          return { status: 204, body: null };
        },
      ],
      [
        "POST",
        "/archives/{id}/volumes",
        (p, q, body) => {
          const a = byId("archives", p.id);
          if (!a) return notFound("Хранилище");
          const bad = volumeProblem(a, body);
          if (bad) return bad;
          const v = newVolume(a, body);
          send("entity.created", { kind: "volume", entityId: v.id, version: v.version });
          return one(volume(v), 201);
        },
      ],
      [
        "PATCH",
        "/volumes/{id}",
        (p, q, body, headers) => {
          const t = targetOf(p.id);
          if (!t || t.kind !== "volume") return notFound("Том");
          const bad = precondition(t.rec, headers) || setProblem(t, body);
          if (bad) return bad;
          applyPatch(t.rec, body);
          changed("volume", t.rec);
          return one(volume(t.rec));
        },
      ],
      [
        "DELETE",
        "/volumes/{id}",
        (p, q, body, headers) => {
          const v = byId("volumes", p.id);
          if (!v) return notFound("Том");
          const bad = precondition(v, headers);
          if (bad) return bad;
          removeVolume(v);
          return { status: 204, body: null };
        },
      ],
      [
        "POST",
        "/volumes/{id}/format",
        (p) => {
          const v = byId("volumes", p.id);
          if (!v) return notFound("Том");
          if (v.state === "format") return problem(409, "BUSY", "Том уже форматируется");
          v.state = "format";
          bump(v);
          formatting.set(v.id, now() + FORMAT_MS);
          changed("volume", v);
          return one(volume(v), 202);
        },
      ],
      /* ----- Устройства: добавить, изменить сразу, удалить, определить модель ----- */
      [
        "POST",
        "/devices",
        (p, q, body) => {
          const done = [];
          const failed = [];
          body.items.forEach((x, index) => {
            const res = createDevice(x.device, x.domainId, x.parentId, x.folderId);
            if (res.code) return failed.push(Object.assign({ index, code: res.code }, res.field ? { field: res.field } : {}));
            if (x.candidateId) {
              const d = db.discovery.find((y) => y.domainId === x.domainId);
              if (d) d.candidateIds = d.candidateIds.filter((c) => c !== x.candidateId);
            }
            done.push({ index, devices: res.devices.map(device), folders: res.folders.map(clone) });
          });
          return { status: 200, body: { done, failed } };
        },
      ],
      [
        "POST",
        "/devices/update",
        (p, q, body) => {
          const done = [];
          const failed = [];
          body.items.forEach((x) => {
            const t = targetOf(x.deviceId);
            if (!t || t.kind !== "device") return failed.push({ deviceId: x.deviceId, code: "NOT_FOUND" });
            if (t.rec.version !== x.version) return failed.push({ deviceId: x.deviceId, code: "VERSION_MISMATCH" });
            const bad = setProblem(t, x.set);
            if (bad) return failed.push(Object.assign({ deviceId: x.deviceId, code: bad.body.code }, bad.body.field ? { field: bad.body.field } : {}));
            applyPatch(t.rec, x.set);
            changed("device", t.rec);
            done.push(device(t.rec));
          });
          return { status: 200, body: { done, failed } };
        },
      ],
      [
        "POST",
        "/devices/probe",
        (p, q, body) => {
          // Модель «сообщает» устройство; у встроенного сервера — по сумме чисел адреса, как в макете
          const models = (db.reference.deviceModels.find((m) => m.vendor === body.vendor) || {}).models || [];
          if (!models.length) return { status: 200, body: { model: null } };
          const sum = body.ip.split(".").reduce((s, x) => s + (Number(x) || 0), 0);
          return { status: 200, body: { model: models[Math.abs(sum) % models.length] } };
        },
      ],
      [
        "DELETE",
        "/devices/{id}",
        (p, q, body, headers) => {
          const d = byId("devices", p.id);
          if (!d) return notFound("Устройство");
          const bad = precondition(d, headers);
          if (bad) return bad;
          removeDevice(d.id);
          return { status: 204, body: null };
        },
      ],
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
          const done = [];
          const failed = [];
          const kinds = { devices: (r) => removeDevice(r.id), folders: removeFolder, archives: removeArchive, volumes: removeVolume };
          body.items.forEach((x) => {
            const table = Object.keys(kinds).find((k) => byId(k, x.id));
            // Уже удалён вместе с родителем из этого же запроса — тоже удалён
            if (!table) return done.includes(x.id) || wasRemoved.has(x.id) ? done.push(x.id) : failed.push({ id: x.id, code: "NOT_FOUND" });
            const rec = byId(table, x.id);
            if (rec.version !== x.version) return failed.push({ id: x.id, code: "VERSION_MISMATCH" });
            kinds[table](rec);
            done.push(x.id);
          });
          wasRemoved.clear();
          return { status: 200, body: { done, failed } };
        },
      ],
      [
        "PUT",
        "/rules/{id}",
        (p, q, body, headers) => {
          const r = byId("rules", p.id);
          if (!r) return notFound("Правило");
          const bad = precondition(r, headers);
          if (bad) return bad;
          if (!String(body.name).trim()) return problem(422, "NAME_REQUIRED", "Укажите название правила", { field: "name" });
          Object.assign(r, clone(body));
          bump(r);
          changed("rule", r);
          return one(clone(r));
        },
      ],
      [
        "PATCH",
        "/settings",
        (p, q, body, headers) => {
          const s = db.settings;
          const bad = precondition(s, headers);
          if (bad) return bad;
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
          const bad = precondition(a, headers);
          if (bad) return bad;
          const next = clone(body.access);
          // Состояние синхронизации ведёт сервер: у существующих каталогов и групп — его значения
          next.catalogs.forEach((c) => {
            const was = a.catalogs.find((x) => x.id === c.id);
            if (was) ["status", "lastSyncAt", "nextSyncAt", "durationSec", "message", "entries"].forEach((k) => (c[k] = clone(was[k])));
          });
          next.groups.forEach((g) => {
            const was = a.groups.find((x) => x.id === g.id);
            if (was && was.source && g.source) ["status", "at", "message"].forEach((k) => (g.source[k] = was.source[k]));
          });
          const why = accessProblem(next);
          if (why) return why;
          if (body.dryRun) return { status: 200, body: { applied: false, access: null }, headers: { ETag: etag(a) } };
          const actor = (a.users.find((u) => u.id === me) || {}).login || "";
          const at = iso(now());
          const stamp = (kind, x) => Object.assign({ id: uuid(kind), at, actor }, clone(x));
          Object.assign(a, next, {
            history: body.history.map((h) => stamp("history", h)).concat(a.history),
            cellHistory: body.cellHistory.map((h) => stamp("history", h)).concat(a.cellHistory || []),
          });
          bump(a);
          send("entity.changed", { kind: "access", version: a.version });
          return { status: 200, body: { applied: true, access: clone(a) }, headers: { ETag: etag(a) } };
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
        (p) => (byId("domains", p.id) ? { status: 200, body: discoveryView(p.id) } : notFound("Домен")),
      ],
      [
        "GET",
        "/rules/{id}/fires",
        (p) => (byId("rules", p.id) ? items(db.ruleFires.filter((f) => f.ruleId === p.id).sort((a, b) => b.at.localeCompare(a.at)).map(clone)) : notFound("Правило")),
      ],
      ["GET", "/access", () => one(clone(db.access))],
      ["GET", "/settings", () => one(clone(db.settings))],
      ["GET", "/licenses", () => items(clone(db.licenses))],
      ["GET", "/journal", (p, q) => items(db.journal.filter((e) => !q.category || e.category === q.category).map(clone))],
      // Поток встроенного сервера — subscribe(); по HTTP его отдаёт петля (tests/loopback-sw.js) или бэкенд
      ["GET", "/stream", () => problem(404, "NO_ROUTE", "Поток событий встроенного сервера — subscribe()")],

      [
        "POST",
        "/operations",
        (p, q, body) => {
          for (const [i, r] of body.items.entries()) {
            if ([r.set, r.folderIds, r.create].filter(Boolean).length !== 1) return problem(422, "VALIDATION_FAILED", "У шага ровно одно из set, folderIds и create", { field: `items[${i}]` });
            const t = targetOf(r.targetId);
            if (!t) return problem(404, "NOT_FOUND", `Объект ${r.targetId} не найден`, { params: { targetId: r.targetId } });
            if (r.set) {
              const bad = setProblem(t, r.set);
              if (bad) return bad;
            }
            if (r.create) {
              if (t.kind !== "device") return problem(422, "VALIDATION_FAILED", "Дочерние — только у устройства", { field: `items[${i}].create` });
              const e = createProblem(r.create, t.rec.domainId, t.rec.id, null);
              if (e) return problem(422, e.code === "IDENTIFIER_TAKEN" ? "VALIDATION_FAILED" : e.code, "Шаг create не пройдёт", { field: `items[${i}].create` });
            }
            if (r.folderIds) {
              if (t.kind !== "device") return problem(422, "VALIDATION_FAILED", "В папках лежат только устройства", { field: `items[${i}].folderIds` });
              const dev = t.rec;
              const wrong = r.folderIds.find((f) => {
                const folder = byId("folders", f);
                return !folder || folder.domainId !== dev.domainId;
              });
              if (wrong) return problem(422, "VALIDATION_FAILED", `Папки ${wrong} нет в домене устройства`, { field: `items[${i}].folderIds` });
            }
          }
          const targets = [...new Set(body.items.map((r) => r.targetId))];
          const missing = targets.find((t) => !(t in body.expectedVersions));
          if (missing) return problem(428, "PRECONDITION_REQUIRED", "Для каждого объекта нужна версия, по которой построен план", { params: { targetId: missing } });
          for (const id of targets) {
            const t = targetOf(id);
            if (t.rec.version !== body.expectedVersions[id]) return problem(412, "VERSION_MISMATCH", "Объект изменился с момента построения плана", { current: view(t), params: { targetId: id } });
          }
          const taken = targets.find(busy);
          if (taken) return problem(409, "BUSY", "Над объектом выполняется другая операция", { params: { targetId: taken } });
          return { status: 202, body: opView(startOperation(body.items.map(clone))) };
        },
      ],
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
          return { status: 202, body: opView(startOperation(failed.map((x) => ({ targetId: x.req.targetId, set: x.req.set, folderIds: x.req.folderIds, create: x.req.create })).map(stripUndefined), { retryOf: op.id })) };
        },
      ],
      [
        "POST",
        "/operations/{id}/revert",
        (p) => {
          const op = opById(p.id);
          if (!op) return notFound("Операция");
          const done = op.items.filter((x) => x.state === "ok");
          if (op.state !== "done" || !done.length || op.reverted) return problem(409, "BUSY", "Откатывать нечего: операция не завершена, ничего не выполнено или уже отменена");
          op.reverted = true;
          // Шаги — в обратном порядке: последнее изменение откатывается первым. Каждый ждёт версию,
          // которую объект получил после шага; если его меняли после, шаг отката не выполняется
          const later = done.slice().reverse();
          const expectAfter = (x) => {
            const after = done.filter((y) => y.targetId === x.targetId);
            return after[after.length - 1] === x ? x.version : undefined;
          };
          const requests = later.map((x, i) =>
            stripUndefined({
              targetId: x.targetId,
              set: x.before.set,
              folderIds: x.before.folderIds,
              remove: x.before.remove,
              expect: i === later.findIndex((y) => y.targetId === x.targetId) ? expectAfter(x) : undefined,
            })
          );
          return { status: 202, body: opView(startOperation(requests, { revertOf: op.id })) };
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
      [
        "POST",
        "/test/clock",
        (p, q, body) => {
          const ms = body.advanceSec * 1000;
          // Время идёт шагами: всё, что наступило по пути, выполняется в свой момент, а не разом в конце
          const fired = [];
          const target = now() + ms;
          for (let t = now(); ; ) {
            const due = Math.min(target, ...[...ops.values()].filter((o) => o.state === "running").map((o) => o.nextAt), ...formatting.values(), ...[...searches.values()].map((s) => s.nextAt), ...[...syncing.values()].map((s) => s.at));
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
          const dev = byId("devices", body.deviceId);
          if (!dev) return notFound("Устройство");
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
          const field = (errs[0].match(/^body\.?([^:\s[]*)/) || [])[1] || undefined;
          return problem(422, "VALIDATION_FAILED", errs.slice(0, 3).join("; "), field ? { field } : {});
        }
      }
      // Перед запросом — всё, что уже наступило по времени: шаги операций не ждут следующего такта
      if (!route.test) tick();
      const key = method === "POST" && body && body.idempotencyKey ? `${method} ${path} ${body.idempotencyKey}` : null;
      answered.forEach((a, k) => now() - a.at >= IDEMPOTENCY_MS && answered.delete(k));
      if (key && answered.has(key)) return clone(answered.get(key).res);
      const res = route.fn(params, q, body || {}, h);
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

  window.ConsolemServer = { create };
})();
