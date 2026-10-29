/* Встроенный сервер прототипа. Отвечает на запросы ровно по контракту api/openapi.json и хранит всё,
   что в продукте хранит бэкенд: оборудование, хранилища, правила, права, опции, журнал. Интерфейс
   разговаривает с ним только через api/client.js — теми же запросами, что с настоящим бэкендом.
   Работает в той же вкладке: страница открывается и с диска (file://), и с сайта.

   Данные — эталонный набор api/fixtures/demo.json (api/fixture.js): его же загружает бэкенд на тестовом
   стенде. Записи хранятся в том виде, в каком уходят в ответах.

   Параметры create(): fixture — эталонный набор; openapi — контракт (api/openapi.js): по нему
   проверяются тела запросов; now — часы; autoTick: false — шаги операций не выполняются сами, только
   по /test/clock; testSupport: true — служебные операции тестового стенда /test/… */
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
  const KIND = { operation: "0", domain: "1", server: "2", device: "3", folder: "4", archive: "5", volume: "6", rule: "7" };
  const TABLES = { domains: "domain", servers: "server", devices: "device", folders: "folder", archives: "archive", volumes: "volume", rules: "rule" };
  // Ответ на запрос с ключом повтора помнится 10 минут: повтор получает его же и ничего не выполняет снова
  const IDEMPOTENCY_MS = 10 * 60 * 1000;
  const STREAM_DEPTH = 500;

  function create(opts) {
    const SPEC = opts.openapi || null;
    const FIXTURE = opts.fixture;
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
    const etag = (rec) => `"${rec.version}"`;
    const one = (rec, status) => ({ status: status || 200, body: rec, headers: { ETag: etag(rec) } });
    const items = (list) => ({ status: 200, body: { items: list } });
    const parseMatch = (h) => (h == null ? null : Number(String(h).replace(/^W\//, "").replace(/"/g, "")));
    // Версия из If-Match: нет заголовка — 428, не совпала — 412 с актуальной записью
    function precondition(rec, headers) {
      const v = parseMatch(headers["if-match"]);
      if (v == null || Number.isNaN(v)) return problem(428, "PRECONDITION_REQUIRED", "Нужен заголовок If-Match с версией записи");
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
    // Значения до изменения — для отката: поля, которых не было, — null
    function applyPatch(rec, patch) {
      const before = {};
      Object.entries(patch).forEach(([k, v]) => {
        if (k === "password") {
          before.password = secrets.has(rec.id) ? secrets.get(rec.id) : null;
          if (v === null || v === "") secrets.delete(rec.id);
          else secrets.set(rec.id, v);
          return;
        }
        before[k] = k in rec ? clone(rec[k]) : null;
        if (v === null) delete rec[k];
        else rec[k] = clone(v);
      });
      rec.version += 1;
      return before;
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
        f.version += 1;
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
      const dev = byId("devices", item.targetId);
      if (!dev) return Object.assign(item, { state: "fail", code: "NOT_FOUND" });
      if (item.req.expect !== undefined && dev.version !== item.req.expect) return Object.assign(item, { state: "fail", code: "VERSION_MISMATCH" });
      if (offline(serverOf(dev))) return Object.assign(item, { state: "fail", code: "SERVER_OFFLINE" });
      if (item.req.set) {
        if (item.req.set.enabled === true && dev.licenseExceeded) return Object.assign(item, { state: "fail", code: "LICENSE_EXCEEDED" });
        item.before = { set: applyPatch(dev, item.req.set) };
        changed("device", dev);
      } else {
        item.before = { folderIds: setFolders(dev.id, item.req.folderIds) };
      }
      return Object.assign(item, { state: "ok", code: null, version: dev.version });
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
      return [
        ["GET", `/${table}`, () => items(db[table].map((r) => (table === "devices" ? device(r) : clone(r))))],
        [
          "GET",
          `/${table}/{id}`,
          (p) => {
            const rec = byId(table, p.id);
            return rec ? one(table === "devices" ? device(rec) : clone(rec)) : notFound(label);
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
      [
        "GET",
        "/domains/{id}/discovery",
        (p) => {
          if (!byId("domains", p.id)) return notFound("Домен");
          const d = db.discovery.find((x) => x.domainId === p.id);
          const candidates = ((d && d.candidateIds) || []).map((cid) => {
            const c = clone(db.network.find((x) => x.id === cid));
            delete c.domainIds;
            return c;
          });
          return {
            status: 200,
            body: d
              ? { domainId: p.id, state: d.state, progress: d.progress, startedAt: d.startedAt || null, finishedAt: d.finishedAt || null, candidates }
              : { domainId: p.id, state: "idle", progress: 0, startedAt: null, finishedAt: null, candidates: [] },
          };
        },
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
            if (!!r.set === !!r.folderIds) return problem(422, "VALIDATION_FAILED", "У шага ровно одно из set и folderIds", { field: `items[${i}]` });
            if (!byId("devices", r.targetId)) return problem(404, "NOT_FOUND", `Устройство ${r.targetId} не найдено`, { params: { targetId: r.targetId } });
            if (r.set) {
              const bad = patchProblem(r.set);
              if (bad) return bad;
            }
            if (r.folderIds) {
              const dev = byId("devices", r.targetId);
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
          for (const t of targets) {
            const rec = byId("devices", t);
            if (rec.version !== body.expectedVersions[t]) return problem(412, "VERSION_MISMATCH", "Объект изменился с момента построения плана", { current: device(rec), params: { targetId: t } });
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
          return { status: 202, body: opView(startOperation(failed.map((x) => ({ targetId: x.req.targetId, set: x.req.set, folderIds: x.req.folderIds })).map(stripUndefined), { retryOf: op.id })) };
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
          if (body.fixture !== "demo") return problem(404, "NOT_FOUND", `Набора ${body.fixture} нет`);
          // Часы останавливаются: время в тестах идёт только по /test/clock
          clock.frozenAt = body.freezeClock === false ? null : realNow() + clock.offset;
          load(body.fixturePatch ? mergePatch(FIXTURE, body.fixturePatch) : FIXTURE);
          if (body.actAs) {
            const u = db.access.users.find((x) => x.login === body.actAs);
            if (!u) return problem(404, "NOT_FOUND", `Пользователя ${body.actAs} нет`);
            me = u.id;
          }
          send("test.reset", { payload: {} });
          return { status: 200, body: { fixture: "demo", now: iso(now()), frozen: clock.frozenAt != null } };
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
            const due = Math.min(target, ...[...ops.values()].filter((o) => o.state === "running").map((o) => o.nextAt));
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
