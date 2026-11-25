/* Тесты API: «Оборудование» — домены, серверы, папки. Пути ядра (/units): смысл — хуки профилей механизма core.domain/1
   (область системы), core.folder/1 (папка) и профиля vms.server/1. */
(() => {
  ApiTest.fileLayer("profile:vms.server/1");
  const { makeEnv, assert, key, FX, AREA, FOLDER } = ApiTest;
  // Слой теста по началу имени; остальные тесты файла идут в слое файла
  const test = ApiTest.prefixLayers([
    // Область и папка — профили механизма core.domain/1, core.folder/1 (с 0.28.0): их тесты — механизм
    ["Домен:", "mechanism"],
    ["Папка:", "mechanism"],
    ["Лицензии", "mechanism"],
  ]);
  const UNKNOWN_DOMAIN = "10009999-0000-4000-8000-000000000000";
  const [d1, d2] = FX.domains;
  const unalloc = FX.servers.find((s) => !s.allocated && s.domainId === d1.id && s.class !== "camera");
  const unalloc2 = FX.servers.find((s) => !s.allocated && s.domainId === d1.id && s.class !== "camera" && s.id !== unalloc.id);
  const inDomain = FX.servers.find((s) => s.allocated && s.domainId === d1.id && s.online);
  const offlineServer = FX.servers.find((s) => s.allocated && !s.online);
  const rootFolder = FX.folders.find((f) => f.domainId === d1.id && !f.parentId && FX.folders.some((x) => x.parentId === f.id));
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const U = (uid) => `/units/${uid}`;
  // Создание путём ядра: строка — UnitCreate; ответ — объекты строки или отказы строки [code, field]
  const create = (env, ...items) => env.ok("POST", "/units", { idempotencyKey: key(), items });
  async function made(env, spec) {
    const res = await create(env, spec);
    assert.eq(res.failed.map((x) => [x.code, x.field]), [], `создан ${spec.kind}`);
    return res.done[0].units[0];
  }
  const refused = async (env, spec) => (await create(env, spec)).failed.map((x) => [x.code, x.field]);
  const units = (env, query) => env.list(`/units?${query}`);
  // Устройства — объекты видов устройств набора
  const DEVICE_KINDS = [...new Set(FX.devices.map((d) => d.type))].sort().join(",");
  const deviceCount = async (env) => (await units(env, `kind=${DEVICE_KINDS}`)).length;
  const move = (env, rec, parentId, params) => env.call("POST", `${U(rec.id)}/move`, Object.assign({ parentId }, params ? { params } : {}), v(rec));

  /* ===== Домены ===== */

  // Область системы (домен) — часть системы, у которой свои объекты, права и лицензии. У VMS это домен, у оркестратора агентов —
  // рабочее пространство. Бэкенд узнаёт область по профилю core.domain/1, а не по коду вида
  test("Область системы: вид области объявляет core.domain/1; области — верх дерева в каждой раскладке", async () => {
    const env = await makeEnv();
    const { items, layouts } = await env.ok("GET", "/kinds");
    const areaKinds = items.filter((k) => (k.implements || []).includes(AREA)).map((k) => k.kind);
    assert.ok(areaKinds.length > 0, `вид с ${AREA} есть`);
    const areas = (await env.pages(`/units?implements=${AREA}&limit=1000`)).map((u) => u.uid).sort();
    assert.ok(areas.length > 0, "объекты области есть");
    for (const l of layouts || []) {
      const top = await env.pages(`/tree/children?layout=${encodeURIComponent(l.id)}&limit=1000`);
      assert.eq(top.map((n) => n.id).sort(), areas, `${l.id}: верх дерева — ровно области`);
      assert.ok(top.every((n) => areaKinds.includes(n.kind)), `${l.id}: вид узла верха — вид области`);
    }
    if (ApiTest.fixtureName === "agents") {
      const old = items.filter((k) => (k.implements || []).some((p) => p === "vms.domain/1" || p === "vms.folder/1")).map((k) => k.kind);
      assert.eq(old, [], "agents: vms.domain/1 и vms.folder/1 не объявляет ни один вид");
    }
    return `видов области ${areaKinds.length}, раскладок ${(layouts || []).length}`;
  }, { needs: ["listKinds", "listUnits", "getTreeChildren"], layer: "mechanism" });

  test("Домен: создать — 200, имя занято (без учёта регистра) — NAME_TAKEN, пустое — NAME_REQUIRED", async () => {
    const env = await makeEnv();
    const d = await made(env, { kind: "domain", name: "  Домен Тест ", properties: {} });
    assert.eq([d.name, d.parentId, d.domainId], ["Домен Тест", null, null], "домен — корень без domainId, имя без пробелов по краям");
    assert.eq((await env.call("GET", U(d.uid))).headers.etag, `"${d.version}"`, "версия в ETag");
    assert.ok((await units(env, "kind=domain")).some((x) => x.uid === d.uid), "в списке");
    assert.eq(await refused(env, { kind: "domain", name: d1.name.toUpperCase(), properties: {} }), [["NAME_TAKEN", "/name"]], "имя занято");
    assert.eq(await refused(env, { kind: "domain", name: "  ", properties: {} }), [["NAME_REQUIRED", "/name"]], "имя пустое");
  }, { needs: ["createUnits", "cap:domain:create"] });

  // Свойство license жило в vms.domain/1 и снято с ним в 0.32.0: лицензии домена — License.* (/licenses, /licenses/keys)
  test("Домен: свойства license нет (снято в 0.32.0) — ни в схеме вида, ни у нового домена; PATCH license — 422", async () => {
    const env = await makeEnv();
    const kind = (await env.list("/kinds")).find((k) => k.kind === "domain");
    assert.eq(Object.keys((kind.schema && kind.schema.properties) || {}).includes("license"), false, "в схеме вида нет license");
    const d = await made(env, { kind: "domain", name: "Домен без лицензии", properties: {} });
    assert.eq("license" in ((await env.ok("GET", U(d.uid))).properties || {}), false, "у нового домена нет license");
    const res = await env.call("PATCH", U(d.uid), { properties: { license: "LIC-1" } }, { "If-Match": `"${d.version}"` });
    assert.status(res, 422, "VALIDATION_FAILED");
  }, { needs: ["listKinds", "createUnits", "patchUnit", "cap:domain:create"] });

  test("Домен: переименовать — PATCH с версией; чужое имя — 409, без версии — 428, старая версия — 412", async () => {
    const env = await makeEnv();
    const res = await env.call("PATCH", U(d1.id), { name: "Центральный" }, v(d1));
    assert.status(res, 200);
    assert.eq(res.body.name, "Центральный", "имя изменено");
    assert.ok(res.body.version !== d1.version, "версия изменилась");
    if (d2) {
      const taken = await env.call("PATCH", U(d1.id), { name: d2.name }, { "If-Match": res.headers.etag });
      assert.status(taken, 409, "NAME_TAKEN");
      assert.eq(taken.body.field, "/name", "field — указатель");
    }
    assert.status(await env.call("PATCH", U(d1.id), { name: "x" }), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("PATCH", U(d1.id), { name: "x" }, v(d1)), 412, "VERSION_MISMATCH");
  }, { needs: ["patchUnit", `implements:${AREA}`, "cap:domain:rename"] });

  // Область и папку сервер узнаёт только по профилям механизма core.domain/1, core.folder/1 (с 0.32.0): профили vms.domain/1,
  // vms.folder/1 сняты. Вид, который объявил только их, для сервера не область и не папка: верх дерева без его объектов
  test("Область системы: вид только со снятыми vms.domain/1 и vms.folder/1 — не область и не папка", async () => {
    const old = { domain: ["vms.domain/1"], folder: ["vms.folder/1"] };
    const kinds = FX.kinds.map((k) => (old[k.kind] ? Object.assign({}, k, { implements: old[k.kind] }) : k));
    const env = await makeEnv({ fixturePatch: { kinds } });
    const top = await env.pages("/tree/children?layout=folders&limit=1000");
    const ids = new Set(FX.domains.map((d) => d.id));
    assert.eq(top.filter((n) => ids.has(n.id)).map((n) => n.id), [], "верх дерева — без объектов вида со снятым vms.domain/1");
    assert.eq((await env.pages(`/units?implements=${AREA}&limit=1000`)).length, 0, `объектов с ${AREA} нет`);
    // Вид папки объявил только снятый vms.folder/1 — его объекты для сервера не папки
    assert.eq((await env.pages(`/units?implements=${FOLDER}&limit=1000`)).length, 0, `объектов с ${FOLDER} нет`);
  }, { needs: ["listKinds", "getTreeChildren", "listUnits"], layer: "mechanism" });

  test("Домен: удалить с переносом — серверы нераспределённые в целевом, папки, устройства, хранилища и найденное — там же", async () => {
    const env = await makeEnv();
    const before = { servers: FX.servers.filter((s) => s.domainId === d1.id).length, folders: FX.folders.filter((f) => f.domainId === d1.id).length,
      devices: FX.devices.filter((d) => d.domainId === d1.id).length, archives: FX.archives.filter((a) => a.domainId === d1.id).length };
    const empty = await env.call("DELETE", U(d1.id), undefined, v(d1));
    assert.status(empty, 422, "DOMAIN_NOT_EMPTY", "без moveTo");
    assert.eq(empty.body.field, "/moveTo", "field — указатель на moveTo");
    assert.status(await env.call("DELETE", `${U(d1.id)}?moveTo=${d1.id}`, undefined, v(d1)), 422, "DOMAIN_NOT_EMPTY", "в себя же");
    assert.status(await env.call("DELETE", `${U(d1.id)}?moveTo=${d2.id}`, undefined, v(d1)), 204);
    assert.status(await env.call("GET", U(d1.id)), 404, "NOT_FOUND", "домена нет");
    const servers = await units(env, `kind=server&domainId=${d2.id}`);
    const moved = servers.filter((s) => FX.servers.find((x) => x.id === s.uid).domainId === d1.id);
    assert.eq([moved.length, moved.every((s) => !s.properties.allocated)], [before.servers, true], "серверы — нераспределённые в целевом");
    assert.eq((await units(env, `kind=folder&domainId=${d1.id}`)).length, 0, "папок старого домена нет");
    assert.eq((await units(env, `domainId=${d1.id}`)).length, 0, "устройств, хранилищ и прочего старого домена нет");
    if (ApiTest.can("getDiscovery") && ApiTest.can("implements:vms.discovery/1")) {
      const disc = await env.ok("GET", `${U(d2.id)}/discovery`);
      const old = FX.discovery.find((x) => x.domainId === d1.id).candidateIds;
      assert.ok(old.every((c) => disc.candidates.some((x) => x.id === c)), "найденное поиском перенесено");
    }
    return `перенесено: серверов ${before.servers}, папок ${before.folders}, устройств ${before.devices}, хранилищ ${before.archives}`;
  }, { needs: ["deleteUnit", "cap:domain:delete"] });

  test("Домен: пустой удаляется без moveTo; последний — 409 LAST_DOMAIN", async () => {
    const env = await makeEnv();
    const fresh = await made(env, { kind: "domain", name: "Пустой", properties: {} });
    assert.status(await env.call("DELETE", U(fresh.uid), undefined, { "If-Match": `"${fresh.version}"` }), 204, null, "пустой");
    const only = await makeEnv({ fixturePatch: { domains: [d1], servers: [], devices: [], folders: [], archives: [], volumes: [], discovery: [] } });
    assert.status(await only.call("DELETE", U(d1.id), undefined, v(d1)), 409, "LAST_DOMAIN");
  }, { needs: ["createUnits", "deleteUnit", "cap:domain:create", "cap:domain:delete"] });

  /* ===== Серверы ===== */

  test("Серверы: принять в домен и исключить — перенос (move): версия +1", async () => {
    const env = await makeEnv();
    const res = await move(env, unalloc, d1.id, { fingerprint: unalloc.fingerprint });
    assert.status(res, 200);
    assert.eq([res.body.properties.allocated, res.body.domainId, res.body.parentId], [true, d1.id, null], "принят: распределён в домене, остаётся корнем");
    assert.ok(res.body.version !== unalloc.version, "версия изменилась");
    assert.ok((await units(env, `implements=vms.server/1&domainId=${d1.id}`)).some((u) => u.uid === unalloc.id && u.properties.allocated), "в списке серверов домена — распределённым");
    const back = await move(env, inDomain, null);
    assert.status(back, 200);
    assert.eq([back.body.properties.allocated, back.body.domainId], [false, d1.id], "исключён — нераспределённый в том же домене");
    if (unalloc2 && unalloc2.fingerprint) assert.status(await move(env, unalloc2, d1.id, { fingerprint: "не тот" }), 409, "FINGERPRINT_MISMATCH");
    const folder = FX.folders.find((f) => f.domainId === d1.id);
    assert.status(await move(env, unalloc2 || unalloc, folder.id), 422, "PARENT_MISMATCH", "сервер принимают только в домен");
  }, { needs: ["moveUnit", "implements:vms.server/1"] });

  test("Серверы: групповой перенос — частичный успех; чужая версия и неизвестный сервер — отказ до выполнения", async () => {
    const env = await makeEnv();
    const op = await env.runOperation({ idempotencyKey: key(), items: [
      { uid: unalloc.id, move: d1.id, params: { fingerprint: unalloc.fingerprint } },
      { uid: offlineServer.id, move: UNKNOWN_DOMAIN },
    ], expectedVersions: { [unalloc.id]: unalloc.version, [offlineServer.id]: offlineServer.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null], ["fail", "NOT_FOUND"]], "по шагам: неизвестный домен — отказ шага");
    assert.eq((await env.ok("GET", U(unalloc.id))).properties.allocated, true, "выполнено");
    // Устаревшая версия — вся операция 412: ничего не выполняется
    const stale = await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ uid: inDomain.id, move: null }], expectedVersions: { [inDomain.id]: "stale" } });
    assert.status(stale, 412, "VERSION_MISMATCH");
    assert.eq((await env.ok("GET", U(inDomain.id))).properties.allocated, true, "устаревшая версия — не тронут");
    const nobody = "20009999-0000-4000-8000-000000000000";
    assert.status(await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ uid: nobody, move: d1.id }], expectedVersions: { [nobody]: "1" } }), 422, "VALIDATION_FAILED", "неизвестный сервер: объекта шага нет");
  }, { needs: ["createOperation", "implements:vms.server/1"] });

  test("Серверы: повтор операции с тем же idempotencyKey — тот же ответ, второй раз не выполняется", async () => {
    const env = await makeEnv();
    const body = { idempotencyKey: key(), items: [{ uid: unalloc.id, move: d1.id, params: { fingerprint: unalloc.fingerprint } }], expectedVersions: { [unalloc.id]: unalloc.version } };
    const a = await env.ok("POST", "/operations", body);
    const b = await env.ok("POST", "/operations", body);
    assert.eq(b, a, "тот же ответ");
    const done = await env.finished(a.id);
    assert.eq((await env.ok("GET", U(unalloc.id))).version, done.items[0].version, "изменение одно: версия — из шага операции");
  }, { needs: ["createOperation", "implements:vms.server/1"] });

  test("Серверы: опрос адресов (команда probe) — в домене, найден, не отвечает; лишние адреса — 422", async () => {
    const env = await makeEnv();
    const probe = (targets) => env.call("POST", `${U(inDomain.id)}/actions/probe`, { params: { targets } });
    const targets = [{ ip: inDomain.ip, port: inDomain.port }, { ip: unalloc.ip, port: unalloc.port }];
    for (let i = 1; i < 40; i++) targets.push({ ip: `10.77.0.${i}`, port: 20111 });
    const res = await probe(targets);
    assert.status(res, 200);
    const items = res.body.result.items;
    assert.eq([items[0].status, items[0].serverId, items[0].domainId], ["in-domain", inDomain.id, inDomain.domainId], "в домене");
    assert.eq([items[1].status, items[1].serverId], ["found", unalloc.id], "заведён, но нераспределённый");
    const fresh = items.slice(2);
    assert.ok(fresh.some((x) => x.status === "dead") && fresh.some((x) => x.status === "found" && !x.serverId), "новые: часть отвечает, часть нет");
    assert.eq((await probe(targets)).body.result.items, items, "ответ повторяется");
    // Предел адресов — Discovery.ipScanMax области (с 0.30.0); система без поиска в сети — предел стенда
    const max = ApiTest.can("getDiscovery") ? (await env.ok("GET", `${U(inDomain.domainId)}/discovery`)).ipScanMax : FX.stand.ipScanMax;
    const many = Array.from({ length: max + 1 }, (_, i) => ({ ip: `10.78.${i >> 8}.${i & 255}`, port: 20111 }));
    assert.status(await probe(many), 422, "IP_RANGE_TOO_LARGE");
  }, { needs: ["runUnitAction", "implements:vms.server/1"] });

  test("Серверы: завести по адресу — нераспределённый в домене; тот же адрес — ADDRESS_TAKEN; неверный — INVALID_IP", async () => {
    const env = await makeEnv();
    const s = await made(env, { kind: "server", domainId: d1.id, properties: { ip: "10.77.0.2", port: 20111 } });
    assert.eq([s.properties.allocated, s.domainId, s.properties.role, s.properties.port, s.name], [false, d1.id, "node", 20111, "Сервер — 10.77.0.2"], "объект");
    assert.eq(await refused(env, { kind: "server", domainId: d1.id, properties: { ip: "10.77.0.2", port: 20111 } }), [["ADDRESS_TAKEN", "/properties/ip"]], "тот же адрес");
    assert.eq(await refused(env, { kind: "server", domainId: d1.id, properties: { ip: "10.77 0.3", port: 20111 } }), [["INVALID_IP", "/properties/ip"]], "неверный адрес");
    assert.eq(await refused(env, { kind: "server", domainId: UNKNOWN_DOMAIN, properties: { ip: "10.77.0.4", port: 20111 } }), [["VALIDATION_FAILED", "/domainId"]], "домена нет");
    const probe = (await env.ok("POST", `${U(inDomain.id)}/actions/probe`, { params: { targets: [{ ip: "10.77.0.2", port: 20111 }] } })).result.items[0];
    assert.eq([probe.status, probe.serverId], ["found", s.uid], "опрос его видит");
  }, { needs: ["createUnits", "runUnitAction", "implements:vms.server/1"] });

  test("Сервер: PATCH — имя, роль и сеть (если система их умеет); неизвестная роль — 422", async () => {
    const env = await makeEnv();
    // Роль и сеть — необязательные возможности (capabilities.features)
    const props = Object.assign({}, ApiTest.can("feature:serverRoles") ? { role: "standby" } : {}, ApiTest.can("feature:serverNetwork") ? { netmask: "255.255.0.0" } : {});
    const res = await env.call("PATCH", U(inDomain.id), { name: "Сервер — Главный", properties: props }, v(inDomain));
    assert.status(res, 200);
    assert.eq([res.body.name].concat(Object.keys(props).map((k) => res.body.properties[k])), ["Сервер — Главный"].concat(Object.values(props)), "изменено: name " + Object.keys(props).join(" "));
    const role = await env.call("PATCH", U(inDomain.id), { properties: { role: "boss" } }, { "If-Match": res.headers.etag });
    assert.status(role, 422, "VALIDATION_FAILED");
    assert.eq(role.body.field, "/properties/role", "field — указатель");
    assert.status(await env.call("PATCH", U(inDomain.id), { properties: { allocated: false } }, { "If-Match": res.headers.etag }), 422, "VALIDATION_FAILED", "домен — через move");
  }, { needs: ["patchUnit", "implements:vms.server/1"] });

  test("Операция: план карточки сервера и домена; сервер без связи — fail SERVER_OFFLINE", async () => {
    const env = await makeEnv();
    const op = await env.runOperation({ idempotencyKey: key(), items: [
      { uid: inDomain.id, patch: { name: "Сервер — план" } },
      { uid: d1.id, patch: { name: "Домен — план" } },
      { uid: offlineServer.id, patch: { name: "не примется" } },
    ], expectedVersions: { [inDomain.id]: inDomain.version, [d1.id]: d1.version, [offlineServer.id]: offlineServer.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null], ["ok", null], ["fail", "SERVER_OFFLINE"]], "по шагам");
    assert.eq((await env.ok("GET", U(d1.id))).name, "Домен — план", "домен");
    // Смысл профиля судит шаг при выполнении: занятое имя домена — отказ шага. Папки сервера — как шаг folderIds базы: в
    // папках только устройства, отказ до запуска всей операции
    const sv = (await env.ok("GET", U(inDomain.id))).version;
    if (d2) {
      const bad = await env.runOperation({ idempotencyKey: key(), items: [{ uid: d1.id, patch: { name: d2.name } }], expectedVersions: { [d1.id]: (await env.ok("GET", U(d1.id))).version } });
      assert.eq(bad.items.map((x) => [x.state, x.code]), [["fail", "NAME_TAKEN"]], "занятое имя домена");
    }
    const res = await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ uid: inDomain.id, patch: { name: "x" } }, { uid: inDomain.id, folders: [] }], expectedVersions: { [inDomain.id]: sv } });
    assert.status(res, 422, "NOT_SUPPORTED", "в папках только устройства");
    assert.eq([res.body.field, res.body.params.targetId], ["/items/1/folders", inDomain.id], "указатель и объект шага");
    assert.eq((await env.ok("GET", U(inDomain.id))).version, sv, "ничего не применено");
  }, { needs: ["createOperation", "implements:vms.server/1", `implements:${AREA}`] });

  test("Порядок доменов и серверов по профилю — как /domains и /servers базы: порядок таблицы, принятый и исключённый сервер — последним", async () => {
    const env = await makeEnv();
    const list = async () => (await env.pages(`/units?implements=${AREA},vms.server/1&limit=1000`)).map((u) => u.uid);
    const hidden = new Set(FX.stand && FX.stand.hiddenIds || []);
    assert.eq(await list(), FX.domains.map((d) => d.id).concat(FX.servers.map((s) => s.id)).filter((id) => !hidden.has(id)), "сначала домены, потом серверы — в порядке набора");
    const s = await env.ok("GET", U(unalloc.id));
    const got = await env.runOperation({ idempotencyKey: key(), items: [Object.assign({ uid: s.uid, move: d1.id }, unalloc.fingerprint ? { params: { fingerprint: unalloc.fingerprint } } : {})], expectedVersions: { [s.uid]: s.version } });
    assert.eq(got.items[0].state, "ok", "принят");
    let now = await list();
    assert.eq(now[now.length - 1], unalloc.id, "принятый — последним");
    const page = await env.ok("GET", "/units?implements=vms.server/1&limit=2");
    assert.ok(!page.items.some((u) => u.uid === unalloc.id), "на первой странице его нет");
    const out = await env.runOperation({ idempotencyKey: key(), items: [{ uid: inDomain.id, move: null }], expectedVersions: { [inDomain.id]: inDomain.version } });
    assert.eq(out.items[0].state, "ok", "исключён");
    now = await list();
    assert.eq(now.slice(-2), [unalloc.id, inDomain.id], "исключённый — тоже последним, как в базе");
  }, { needs: ["createOperation", "implements:vms.server/1", `implements:${AREA}`] });

  /* ===== Папки ===== */

  test("Папка: создать корневую и вложенную; родитель в другом домене — 422", async () => {
    const env = await makeEnv();
    const root = await made(env, { kind: "folder", name: "Новая папка", domainId: d1.id, properties: {} });
    const sub = await made(env, { kind: "folder", name: "Вложенная", parentId: root.uid, properties: {} });
    assert.eq([sub.parentId, sub.domainId, "deviceIds" in sub.properties, (await units(env, `folderId=${sub.uid}`)).length], [root.uid, d1.id, false, 0], "вложенная, состава в объекте нет");
    if (d2) assert.eq(await refused(env, { kind: "folder", name: "x", domainId: d2.id, parentId: root.uid, properties: {} }), [["VALIDATION_FAILED", "/domainId"]], "родитель в другом домене");
    assert.eq(await refused(env, { kind: "folder", name: " ", domainId: d1.id, properties: {} }), [["NAME_REQUIRED", "/name"]], "без имени");
    assert.eq(await refused(env, { kind: "folder", name: "x", domainId: UNKNOWN_DOMAIN, properties: {} }), [["VALIDATION_FAILED", "/domainId"]], "домена нет");
  }, { needs: ["createUnits", `implements:${FOLDER}`] });

  test("Папка: переименовать, очистить, задать состав (Unit.folders); устройство чужого домена — отказ", async () => {
    const env = await makeEnv();
    const f = FX.folders.find((x) => x.deviceIds.length > 2);
    const res = await env.ok("PATCH", U(f.id), { name: "Переименованная" }, v(f));
    assert.eq(res.name, "Переименованная", "переименована");
    assert.ok(res.version !== f.version, "версия изменилась");
    // Состав — у объектов: папки объекта целиком (шаг folders)
    const step = async (ids, fn) => {
      const all = await Promise.all(ids.map((id) => env.ok("GET", U(id))));
      return env.runOperation({ idempotencyKey: key(), items: all.map((u) => ({ uid: u.uid, folders: fn(u.folders || []) })), expectedVersions: Object.fromEntries(all.map((u) => [u.uid, u.version])) });
    };
    const clear = await step(f.deviceIds, (fs) => fs.filter((x) => x !== f.id));
    assert.eq([clear.ok, (await units(env, `folderId=${f.id}`)).length], [f.deviceIds.length, 0], "очищена");
    await step(f.deviceIds.slice(0, 2), (fs) => fs.concat(f.id));
    assert.eq((await units(env, `folderId=${f.id}`)).map((u) => u.uid).sort(), f.deviceIds.slice(0, 2).sort(), "состав задан");
    assert.status(await env.call("PATCH", U(f.id), { properties: { deviceIds: [] } }, { "If-Match": `"${res.version}"` }), 422, "VALIDATION_FAILED", "состав — не свойство папки");
    // Устройство чужого домена — как POST /folders/{id}/devices базы: вся операция отклонена, ничего не применено
    const alien = FX.devices.find((d) => d.domainId !== f.domainId && d.type === "camera");
    if (alien) {
      const mine = await env.ok("GET", U(f.deviceIds[2]));
      const a = await env.ok("GET", U(alien.id));
      const res = await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ uid: mine.uid, folders: (mine.folders || []).concat(f.id) }, { uid: a.uid, folders: (a.folders || []).concat(f.id) }],
        expectedVersions: { [mine.uid]: mine.version, [a.uid]: a.version } });
      assert.status(res, 422, "VALIDATION_FAILED", "чужой домен");
      assert.eq(res.body.params.targetId, alien.id, "чей шаг");
      assert.ok(!(await units(env, `folderId=${f.id}`)).some((u) => u.uid === mine.uid), "шаг своего устройства не применён");
    }
    assert.eq(await deviceCount(env), FX.devices.length, "устройства на месте");
  }, { needs: ["patchUnit", "createOperation", `implements:${FOLDER}`, "kind:camera"] });

  test("Папка: удалить вместе с подпапками, устройства остаются; без версии — 428", async () => {
    const env = await makeEnv();
    const kids = FX.folders.filter((x) => x.parentId === rootFolder.id).map((x) => x.id);
    assert.status(await env.call("DELETE", U(rootFolder.id)), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("DELETE", U(rootFolder.id), undefined, v(rootFolder)), 204);
    const left = (await units(env, "kind=folder")).map((x) => x.uid);
    assert.ok(!left.includes(rootFolder.id) && kids.every((k) => !left.includes(k)), "папка и подпапки удалены");
    assert.eq(await deviceCount(env), FX.devices.length, "устройства на месте");
    assert.status(await env.call("DELETE", U(rootFolder.id), undefined, v(rootFolder)), 404, "NOT_FOUND", "второй раз");
  }, { needs: ["deleteUnit", `implements:${FOLDER}`, "kind:camera"] });

  // Перенос папки с подпапками (пробел F72 против Axxon One): возможность move вида папки. Родителя, цикл и домен судит ядро
  test("Папка: перенести с подпапками в другую папку и в корень домена; под свою подпапку и в чужой домен — 422", async () => {
    const env = await makeEnv();
    const kids = FX.folders.filter((x) => x.parentId === rootFolder.id).map((x) => x.id);
    const to = await made(env, { kind: "folder", name: "Куда", domainId: d1.id, properties: {} });
    assert.status(await env.call("POST", `${U(rootFolder.id)}/move`, { parentId: to.uid }), 428, "PRECONDITION_REQUIRED", "без If-Match");
    const res = await move(env, rootFolder, to.uid);
    assert.status(res, 200, null, "в другую папку");
    assert.eq([res.body.parentId, res.body.domainId], [to.uid, d1.id], "под новой папкой, в своём домене");
    assert.ok(res.body.version !== rootFolder.version && res.headers.etag === `"${res.body.version}"`, "новая версия — в ETag");
    const under = (await units(env, `parentId=${rootFolder.id}&kind=folder`)).map((x) => x.uid).sort();
    assert.eq(under, kids.slice().sort(), "подпапки — с ней");
    const tree = await env.pages(`/tree/children?layout=folders&parentId=${to.uid}`);
    assert.ok(tree.some((n) => n.id === rootFolder.id), "в раскладке folders — под новой папкой");
    const rec = { id: rootFolder.id, version: res.body.version };
    if (kids.length) {
      const cyc = await move(env, rec, kids[0]);
      assert.status(cyc, 422, "PARENT_MISMATCH", "под свою подпапку");
      assert.eq(cyc.body.field, "/parentId", "указатель — на родителя");
    }
    const alien = d2 && FX.folders.find((x) => x.domainId === d2.id);
    if (alien) assert.status(await move(env, rec, alien.id), 422, "VALIDATION_FAILED", "папка другого домена");
    const back = await move(env, rec, null);
    assert.status(back, 200, null, "в корень");
    assert.eq([back.body.parentId, back.body.domainId], [null, d1.id], "в корне своего домена");
  }, { needs: ["moveUnit", "createUnits", "layout:folders", `implements:${FOLDER}`, "cap:folder:move"] });

  test("Метки сервера: PATCH; детектор просит метку, сервера нет — faultText", async () => {
    const env = await makeEnv();
    const s = FX.servers.find((x) => x.allocated && x.online);
    const res = await env.ok("PATCH", U(s.id), { properties: { labels: ["hall"] } }, v(s));
    assert.eq(res.properties.labels, ["hall"], "метка на сервере");
    const c = FX.devices.find((d) => d.type === "camera" && d.domainId === s.domainId);
    const det = await made(env, { kind: "det", name: "Метка", domainId: c.domainId, parentId: c.id, properties: { detectorKind: "motion", labels: ["нет-такой"] } });
    assert.ok(/нет-такой/.test(((det.status || {}).observed || {}).faultText || ""), "причина словами");
    const auto = await made(env, { kind: "det", name: "Без меток", domainId: c.domainId, parentId: c.id, properties: { detectorKind: "motion" } });
    assert.eq(auto.properties.labels, ["gpu"], "по умолчанию просит gpu");
  }, { needs: ["patchUnit", "createUnits", "implements:vms.server/1", "kind:det"] });

  // Ретрансляторы — путь профиля vms.relays/1 у объекта области (с 0.29.0; прежний путь /domains/{id}/relays снят в 0.32.0)
  test("Ретрансляторы: список домена и кто за ретранслятором — GET /units/{uid}/relays", async () => {
    const d = FX.domains.find((x) => FX.relays && FX.relays[x.id]);
    if (!d) return "ретрансляторов в наборе нет";
    const env = await makeEnv();
    const relays = (await env.ok("GET", `${U(d.id)}/relays`)).items;
    assert.ok(relays.length > 0, "ретранслятор есть");
    const one = await env.ok("GET", `${U(d.id)}/relays/${encodeURIComponent(relays[0].name)}`);
    assert.eq(one.members, one.members.slice().sort(), "имена по возрастанию");
    assert.status(await env.call("GET", `${U(d.id)}/relays/нет`), 404, "NOT_FOUND");
  }, { needs: ["listRelays", "getRelay"], layer: "profile:vms.relays/1" });

  test("Домен: потеря связи — только свой кластер, чужое не удалено, stream.reset", async () => {
    const d = FX.domains.find((x) => FX.relays && FX.relays[x.id]);
    if (!d) return "ретрансляторов в наборе нет";
    const env = await makeEnv();
    // Без связи с доменом сервер входа видит только свой кластер
    const servers = () => units(env, "implements=vms.server/1");
    const all = await servers();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => seen.push(m));
    await ApiTest.settle();
    await env.ok("POST", "/test/events", { type: "domain.link", domainId: d.id, online: false });
    await ApiTest.settle();
    assert.ok(seen.some((m) => m.type === "stream.reset"), "stream.reset");
    assert.ok(!seen.some((m) => m.type === "entity.deleted"), "это не удаление");
    assert.eq((await env.ok("GET", U(d.id))).status.link, "offline", "status.link домена");
    const part = await servers();
    assert.ok(part.length < all.length && part.length > 0, "только свой кластер");
    await env.ok("POST", "/test/events", { type: "domain.link", domainId: d.id, online: true });
    assert.eq((await servers()).length, all.length, "связь вернулась");
    stop();
  }, { needs: ["listUnits", "implements:vms.server/1"] });

  /* ===== Пути профилей области: поиск в сети, сценарии, ретрансляторы (с 0.29.0) ===== */

  // uid — объект области, вид которого объявил профиль; объект другого вида — 422 NOT_SUPPORTED, объекта нет — 404
  test("Пути профилей: объект без профиля — 422 NOT_SUPPORTED, объекта нет — 404", async () => {
    const env = await makeEnv();
    const cam = FX.devices.find((x) => x.type === "camera");
    const notArea = await env.call("GET", `${U(cam.id)}/scenarios`);
    assert.status(notArea, 422, "NOT_SUPPORTED", "камера — не объект с vms.scenarios/1");
    assert.eq(notArea.body.field, "/kind", "field — вид объекта");
    assert.status(await env.call("GET", `${U(UNKNOWN_DOMAIN)}/scenarios`), 404, "NOT_FOUND", "объекта нет");
    if (ApiTest.can("getDiscovery") && ApiTest.can("implements:vms.discovery/1")) {
      assert.status(await env.call("GET", `${U(cam.id)}/discovery`), 422, "NOT_SUPPORTED", "поиск у камеры");
      assert.status(await env.call("GET", `${U(UNKNOWN_DOMAIN)}/discovery`), 404, "NOT_FOUND", "поиск: объекта нет");
    }
    if (ApiTest.can("listRelays") && ApiTest.can("implements:vms.relays/1")) {
      assert.status(await env.call("GET", `${U(cam.id)}/relays`), 422, "NOT_SUPPORTED", "ретрансляторы у камеры");
      assert.status(await env.call("GET", `${U(UNKNOWN_DOMAIN)}/relays`), 404, "NOT_FOUND", "ретрансляторы: объекта нет");
    }
  }, { needs: ["getScenarios", "implements:vms.scenarios/1", "kind:camera"], layer: "profile:vms.scenarios/1" });

  test("Сервер между доменами: откат переноса возвращает в исходный домен и состояние; исключить в другой домен — params.domainId", async () => {
    const env = await makeEnv();
    const last = async () => (await env.ok("GET", "/operations")).items[0];
    const revert = async () => env.finished((await env.ok("POST", `/operations/${(await last()).id}/revert`, {})).id);
    const place = async (s) => {
      const u = await env.ok("GET", U(s.id));
      return [u.domainId, u.properties.allocated];
    };
    // Нераспределённый в первом домене — принят во второй — откат: снова нераспределённый в первом
    const acc = await move(env, unalloc, d2.id, { fingerprint: unalloc.fingerprint });
    assert.status(acc, 200);
    assert.eq([acc.body.domainId, acc.body.properties.allocated], [d2.id, true], "принят в другой домен");
    assert.eq((await revert()).failed, 0, "откат приёма");
    assert.eq(await place(unalloc), [d1.id, false], "снова нераспределённый в исходном домене");
    // Распределённый в первом — во второй — откат: снова распределён в первом
    const m = await move(env, inDomain, d2.id);
    assert.eq([m.body.domainId, m.body.properties.allocated], [d2.id, true], "перенесён в другой домен");
    assert.eq((await revert()).failed, 0, "откат переноса");
    assert.eq(await place(inDomain), [d1.id, true], "снова распределён в исходном домене");
    // Исключить сразу в другой домен: parentId null, params.domainId
    const etag = await env.etag(U(inDomain.id));
    const ex = await env.call("POST", `${U(inDomain.id)}/move`, { parentId: null, params: { domainId: d2.id } }, { "If-Match": etag });
    assert.status(ex, 200);
    assert.eq([ex.body.domainId, ex.body.properties.allocated], [d2.id, false], "нераспределённый в другом домене");
    assert.eq((await revert()).failed, 0, "откат исключения");
    assert.eq(await place(inDomain), [d1.id, true], "снова распределён в исходном домене");
    const now = await env.etag(U(inDomain.id));
    assert.status(await env.call("POST", `${U(inDomain.id)}/move`, { parentId: null, params: { domainId: UNKNOWN_DOMAIN } }, { "If-Match": now }), 404, "NOT_FOUND", "домена нет");
    assert.status(await env.call("POST", `${U(inDomain.id)}/move`, { parentId: d2.id, params: { domainId: d2.id } }, { "If-Match": now }), 422, "VALIDATION_FAILED", "domainId — только при исключении");
  }, { needs: ["moveUnit", "revertOperation", "implements:vms.server/1", "cap:domain:create"] });

  /* ----- Лицензии 0.20.0: ключи /licenses/keys, счётчики домена, событие license.changed ----- */
  const KEYS = "/licenses/keys", K = (id) => `${KEYS}/${encodeURIComponent(id)}`;
  const domainUids = async (env) => (await units(env, "kind=domain")).map((u) => u.uid);

  test("Лицензии 0.20.0: ключи — пул, домены, лимиты, observedAt; /licenses — сумма ключей, с domainId — счётчики домена с owners", async () => {
    const env = await makeEnv();
    const keys = await env.list(KEYS);
    assert.ok(keys.length > 0, "ключи есть");
    const doms = await domainUids(env);
    for (const k of keys) {
      assert.ok(["active", "expiring", "expired", "mismatch"].includes(k.state), `состояние ключа ${k.serial}`);
      const one = await env.call("GET", K(k.id));
      assert.eq([one.status, one.headers.etag, one.body], [200, `"${k.version}"`, k], "ключ по id — как в списке, ETag — версия");
      for (const f of k.features) {
        assert.eq(f.used, f.domains.reduce((s, d) => s + d.used, 0), `${k.serial} ${f.code}: занято в пуле — сумма доменов`);
        assert.eq(f.domains.map((d) => d.domainId), k.domainIds, `${k.serial} ${f.code}: разбивка по доменам ключа`);
        assert.ok(f.domains.every((d) => !Number.isNaN(Date.parse(d.observedAt))), "observedAt у каждого домена");
      }
    }
    const named = keys.flatMap((k) => k.domainIds);
    assert.eq(named.length, new Set(named).size, "домен — не больше чем на одном ключе");
    // Вся система — сумма ключей по коду функции
    const sys = await env.list("/licenses");
    for (const l of sys) {
      const fs = keys.flatMap((k) => k.features.filter((f) => f.code === l.kind));
      assert.eq([l.used, l.total], [fs.reduce((s, f) => s + f.used, 0), fs.some((f) => f.total == null) ? null : fs.reduce((s, f) => s + f.total, 0)], `система: ${l.kind}`);
      assert.ok(!("owners" in l), "без domainId владельцев нет");
    }
    // Домен ключа: занято в домене, всего — лимит или пул, владельцы
    const k = keys.find((x) => x.features.some((f) => f.domains.some((d) => d.limit != null)));
    const f = k.features.find((x) => x.domains.some((d) => d.limit != null)), d = f.domains.find((x) => x.limit != null);
    const mine = (await env.list(`/licenses?domainId=${d.domainId}`)).find((x) => x.kind === f.code);
    assert.eq([mine.used, mine.total], [d.used, d.limit], "домен с лимитом: total — лимит");
    assert.ok(mine.owners.length <= mine.ownersTotal && mine.owners.every((uid) => typeof uid === "string"), "owners — uid, не больше ownersTotal");
    for (const uid of mine.owners.slice(0, 3)) assert.eq((await env.ok("GET", U(uid))).domainId, d.domainId, "владелец — объект этого домена");
    const free = doms.find((x) => !named.includes(x));
    if (free) assert.eq(await env.list(`/licenses?domainId=${free}`), [], "домен без ключа — пустой список");
    assert.status(await env.call("GET", `/licenses?domainId=${UNKNOWN_DOMAIN}`), 404, "NOT_FOUND", "нет домена");
    assert.status(await env.call("GET", K("нет-ключа")), 404, "NOT_FOUND", "нет ключа");
  }, { needs: ["listLicenseKeys", "getLicenseKey", "listLicenses", "getUnit"] });

  test("Лицензии 0.20.0: добавить ключ номером и файлом, назначить домены и лимиты одним PATCH (домен уходит с прежнего ключа), снять ключ; license.changed", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => seen.push(m));
    await ApiTest.settle();
    const before = await env.list(KEYS);
    const res = await env.call("POST", KEYS, { serial: "AX-PRO-TEST-0100" });
    assert.status(res, 201, null, "ключ по номеру");
    const k = res.body;
    assert.eq([k.serial, k.domainIds, res.headers.etag], ["AX-PRO-TEST-0100", [], `"${k.version}"`], "номер, доменов нет, ETag");
    assert.ok(k.product && k.features.length && k.features.every((f) => f.used === 0 && f.domains.length === 0), "что сервер прочёл из ключа");
    assert.status(await env.call("POST", KEYS, { serial: "AX-PRO-TEST-0100" }), 409, "IDENTIFIER_TAKEN", "тот же номер");
    assert.status(await env.call("POST", KEYS, {}), 422, "VALIDATION_FAILED", "ни номера, ни файла");
    assert.status(await env.call("POST", KEYS, { serial: "X", fileId: "y" }), 422, "VALIDATION_FAILED", "и номер, и файл");
    assert.status(await env.call("POST", KEYS, { fileId: "нет-файла" }), 422, "VALIDATION_FAILED", "файла нет");
    // Домен с другого ключа и новый лимит — одним вызовом
    const old = before.find((x) => x.domainIds.length > 1);
    const moved = old.domainIds[old.domainIds.length - 1], f0 = k.features[0].code;
    assert.status(await env.call("PATCH", K(k.id), { domainIds: [moved] }), 428, "PRECONDITION_REQUIRED", "без If-Match");
    assert.status(await env.call("PATCH", K(k.id), { domainIds: [moved] }, { "If-Match": '"old"' }), 412, "VERSION_MISMATCH", "чужая версия");
    const bad = await env.call("PATCH", K(k.id), { domainIds: [moved], limits: [{ domainId: UNKNOWN_DOMAIN, feature: f0, limit: 1 }] }, v(k));
    assert.eq([bad.status, bad.body.field], [422, "limits.0"], "лимит не своему домену");
    assert.eq((await env.call("PATCH", K(k.id), { domainIds: [UNKNOWN_DOMAIN] }, v(k))).body.field, "domainIds.0", "нет домена");
    const k2 = await env.ok("PATCH", K(k.id), { domainIds: [moved], limits: [{ domainId: moved, feature: f0, limit: 5 }] }, v(k));
    assert.eq([k2.domainIds, k2.features[0].domains.map((d) => [d.domainId, d.limit])], [[moved], [[moved, 5]]], "домен и лимит");
    const was = await env.ok("GET", K(old.id));
    assert.ok(!was.domainIds.includes(moved) && was.version !== old.version, "прежний ключ отдал домен, версия новая");
    assert.ok(was.features.every((f) => f.domains.every((d) => d.domainId !== moved)), "в разбивке прежнего ключа домена нет");
    // Файл ключа: сервер забирает файл себе; ключ снят — файл снова временный, ключ можно вернуть тем же fileId
    if (ApiTest.can("uploadFile")) {
      const file = (await env.ok("POST", "/files?name=ключ.lic", new Blob(["KEY"], { type: "text/plain" }), { "Content-Type": "text/plain" }));
      const fk = (await env.call("POST", KEYS, { fileId: file.id }));
      assert.status(fk, 201, null, "ключ из файла");
      assert.eq(fk.body.fileId, file.id, "ключ называет файл");
      assert.status(await env.call("POST", KEYS, { fileId: file.id }), 409, "IDENTIFIER_TAKEN", "тот же файл второй раз");
      if (env.frozen) {
        await env.advance(Math.ceil((Date.parse(file.expiresAt) - env.now) / 1000) + 60);
        assert.status(await env.call("GET", K(fk.body.id)), 200, null, "срок файла прошёл, ключ на месте");
      }
      assert.status(await env.call("DELETE", K(fk.body.id), undefined, v(fk.body)), 204, null, "ключ из файла снят");
      assert.status(await env.call("POST", KEYS, { fileId: file.id }), 201, null, "вернуть ключ тем же файлом");
    }
    assert.status(await env.call("DELETE", K(k.id)), 428, "PRECONDITION_REQUIRED", "снять без If-Match");
    assert.status(await env.call("DELETE", K(k.id), undefined, v(k2)), 204, null, "ключ снят");
    assert.status(await env.call("GET", K(k.id)), 404, "NOT_FOUND", "ключа нет");
    assert.eq(await env.list(`/licenses?domainId=${moved}`), [], "домен остался без ключа");
    await ApiTest.settle();
    stop();
    const ev = seen.filter((m) => m.type === "license.changed");
    assert.ok(ev.some((m) => m.entityId === k.id && m.payload.reason === "added"), "событие: добавлен");
    assert.ok(ev.some((m) => m.entityId === old.id && m.payload.reason === "changed" && m.version), "событие: прежний ключ отдал домен");
    assert.ok(ev.some((m) => m.entityId === k.id && m.payload.reason === "removed" && !m.version), "событие: снят, без версии");
    if ((ApiTest.caps().features || []).includes("journalAudit")) {
      const audit = await env.list("/journal?limit=1000&category=audit");
      assert.ok(["createLicenseKey", "patchLicenseKey", "deleteLicenseKey"].every((op) => audit.some((j) => j.kind === `api.${op}`)), "журнал аудита: добавить, назначить, снять");
    }
  }, { needs: ["listLicenseKeys", "createLicenseKey", "getLicenseKey", "patchLicenseKey", "deleteLicenseKey", "listLicenses", "listUnits"] });

  ApiTest.loaded("api-domains.js");
})();
