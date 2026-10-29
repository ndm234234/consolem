/* Тесты API: «Оборудование» — домены, серверы, папки. */
(() => {
  const { test, makeEnv, assert, key, FX } = ApiTest;
  const UNKNOWN_DOMAIN = "10009999-0000-4000-8000-000000000000";
  const [d1, d2] = FX.domains;
  const unalloc = FX.servers.find((s) => !s.allocated && s.domainId === d1.id);
  const inDomain = FX.servers.find((s) => s.allocated && s.domainId === d1.id && s.online);
  const offlineServer = FX.servers.find((s) => s.allocated && !s.online);
  const rootFolder = FX.folders.find((f) => f.domainId === d1.id && !f.parentId && FX.folders.some((x) => x.parentId === f.id));
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const assign = (items) => ({ idempotencyKey: key(), items });

  /* ===== Домены ===== */

  test("Домен: создать — 201, имя занято (без учёта регистра) — 409, пустое — 422", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/domains", { name: "  Домен Тест " });
    assert.status(res, 201);
    assert.eq([res.body.name, res.headers.etag], ["Домен Тест", `"${res.body.version}"`], "запись, версия в ETag");
    assert.ok((await env.list("/domains")).some((d) => d.id === res.body.id), "в списке");
    assert.status(await env.call("POST", "/domains", { name: d1.name.toUpperCase() }), 409, "NAME_TAKEN");
    assert.status(await env.call("POST", "/domains", { name: "  " }), 422, "NAME_REQUIRED");
  });

  test("Домен: переименовать и задать лицензию — PATCH с версией; чужое имя — 409", async () => {
    const env = await makeEnv();
    const res = await env.call("PATCH", `/domains/${d1.id}`, { name: "Центральный", license: "LIC-1" }, v(d1));
    assert.status(res, 200);
    assert.eq([res.body.name, res.body.license], ["Центральный", "LIC-1"], "изменено");
    assert.ok(res.body.version !== d1.version, "версия изменилась");
    assert.status(await env.call("PATCH", `/domains/${d1.id}`, { name: d2.name }, { "If-Match": `"${res.body.version}"` }), 409, "NAME_TAKEN");
    assert.status(await env.call("PATCH", `/domains/${d1.id}`, { name: "x" }), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("PATCH", `/domains/${d1.id}`, { name: "x" }, v(d1)), 412, "VERSION_MISMATCH");
  });

  test("Домен: удалить с переносом — серверы нераспределённые в целевом, папки, устройства, хранилища и найденное — там же", async () => {
    const env = await makeEnv();
    const before = { servers: FX.servers.filter((s) => s.domainId === d1.id).length, folders: FX.folders.filter((f) => f.domainId === d1.id).length,
      devices: FX.devices.filter((d) => d.domainId === d1.id).length, archives: FX.archives.filter((a) => a.domainId === d1.id).length };
    assert.status(await env.call("DELETE", `/domains/${d1.id}`, undefined, v(d1)), 422, "DOMAIN_NOT_EMPTY", "без moveTo");
    assert.status(await env.call("DELETE", `/domains/${d1.id}?moveTo=${d1.id}`, undefined, v(d1)), 422, "DOMAIN_NOT_EMPTY", "в себя же");
    const res = await env.call("DELETE", `/domains/${d1.id}?moveTo=${d2.id}`, undefined, v(d1));
    assert.status(res, 204);
    assert.status(await env.call("GET", `/domains/${d1.id}`), 404, "NOT_FOUND", "домена нет");
    const servers = (await env.list("/servers")).filter((s) => s.domainId === d2.id);
    const moved = servers.filter((s) => FX.servers.find((x) => x.id === s.id).domainId === d1.id);
    assert.eq([moved.length, moved.every((s) => !s.allocated)], [before.servers, true], "серверы — нераспределённые в целевом");
    assert.eq((await env.list("/folders")).filter((f) => f.domainId === d1.id).length, 0, "папок старого домена нет");
    assert.eq((await env.list("/devices")).filter((d) => d.domainId === d1.id).length, 0, "устройств старого домена нет");
    assert.eq((await env.list("/archives")).filter((a) => a.domainId === d1.id).length, 0, "хранилищ старого домена нет");
    const disc = await env.ok("GET", `/domains/${d2.id}/discovery`);
    const old = FX.discovery.find((x) => x.domainId === d1.id).candidateIds;
    assert.ok(old.every((c) => disc.candidates.some((x) => x.id === c)), "найденное поиском перенесено");
    return `перенесено: серверов ${before.servers}, папок ${before.folders}, устройств ${before.devices}, хранилищ ${before.archives}`;
  });

  test("Домен: пустой удаляется без moveTo; последний — 409 LAST_DOMAIN", async () => {
    const env = await makeEnv();
    const fresh = await env.ok("POST", "/domains", { name: "Пустой" });
    assert.status(await env.call("DELETE", `/domains/${fresh.id}`, undefined, v(fresh)), 204, null, "пустой");
    const only = await makeEnv({ fixturePatch: { domains: [d1], servers: [], devices: [], folders: [], archives: [], volumes: [], discovery: [] } });
    assert.status(await only.call("DELETE", `/domains/${d1.id}`, undefined, v(d1)), 409, "LAST_DOMAIN");
  });

  /* ===== Серверы ===== */

  test("Серверы: добавить в домен и исключить одним запросом — версия +1, добавленный в конце списка", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/servers/assign", assign([{ serverId: unalloc.id, version: unalloc.version, domainId: d1.id, allocated: true }]));
    assert.status(res, 200);
    assert.eq([res.body.done.length, res.body.failed.length, res.body.done[0].allocated], [1, 0, true], "добавлен");
    assert.ok(res.body.done[0].version !== unalloc.version, "версия изменилась");
    const list = await env.list("/servers");
    assert.eq(list[list.length - 1].id, unalloc.id, "в конце списка");
    const back = await env.ok("POST", "/servers/assign", assign([{ serverId: inDomain.id, version: inDomain.version, domainId: d1.id, allocated: false }]));
    assert.eq(back.done[0].allocated, false, "исключён — нераспределённый в том же домене");
  });

  test("Серверы: частичный успех — устаревшая версия и неизвестный сервер в failed, остальное выполнено", async () => {
    const env = await makeEnv();
    const res = await env.ok("POST", "/servers/assign", assign([
      { serverId: unalloc.id, version: unalloc.version, domainId: d1.id, allocated: true },
      { serverId: inDomain.id, version: "stale", domainId: d1.id, allocated: false },
      { serverId: "20009999-0000-4000-8000-000000000000", version: "1", domainId: d1.id, allocated: true },
      { serverId: offlineServer.id, version: offlineServer.version, domainId: UNKNOWN_DOMAIN, allocated: true },
    ]));
    assert.eq(res.done.map((s) => s.id), [unalloc.id], "выполнено");
    assert.eq(res.failed.map((f) => f.code), ["VERSION_MISMATCH", "NOT_FOUND", "NOT_FOUND"], "отказы с кодами");
    assert.eq((await env.ok("GET", `/servers/${inDomain.id}`)).allocated, true, "устаревшая версия — не тронут");
  });

  test("Серверы: повтор с тем же idempotencyKey — тот же ответ, второй раз не выполняется", async () => {
    const env = await makeEnv();
    const body = assign([{ serverId: unalloc.id, version: unalloc.version, domainId: d1.id, allocated: true }]);
    const a = await env.ok("POST", "/servers/assign", body);
    const b = await env.ok("POST", "/servers/assign", body);
    assert.eq(b, a, "тот же ответ");
    assert.eq((await env.ok("GET", `/servers/${unalloc.id}`)).version, a.done[0].version, "изменение одно: версия — из первого ответа");
  });

  test("Серверы: опрос адресов — в домене, найден, не отвечает; лишние адреса — 422", async () => {
    const env = await makeEnv();
    const targets = [{ ip: inDomain.ip, port: inDomain.port }, { ip: unalloc.ip, port: unalloc.port }];
    for (let i = 1; i < 40; i++) targets.push({ ip: `10.77.0.${i}`, port: 20111 });
    const items = (await env.ok("POST", "/servers/probe", { targets })).items;
    assert.eq([items[0].status, items[0].serverId, items[0].domainId], ["in-domain", inDomain.id, inDomain.domainId], "в домене");
    assert.eq([items[1].status, items[1].serverId], ["found", unalloc.id], "заведён, но нераспределённый");
    const fresh = items.slice(2);
    assert.ok(fresh.some((x) => x.status === "dead") && fresh.some((x) => x.status === "found" && !x.serverId), "новые: часть отвечает, часть нет");
    const again = (await env.ok("POST", "/servers/probe", { targets })).items;
    assert.eq(again, items, "ответ повторяется");
    const many = Array.from({ length: FX.reference.limits.ipScanMax + 1 }, (_, i) => ({ ip: `10.78.${i >> 8}.${i & 255}`, port: 20111 }));
    assert.status(await env.call("POST", "/servers/probe", { targets: many }), 422, "IP_RANGE_TOO_LARGE");
  });

  test("Серверы: завести по адресу — нераспределённый в домене; тот же адрес — 409; неверный — 422", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/servers", { ip: "10.77.0.2", port: 20111, domainId: d1.id });
    assert.status(res, 201);
    assert.eq([res.body.allocated, res.body.domainId, res.body.role, res.body.port], [false, d1.id, "node", 20111], "запись");
    assert.status(await env.call("POST", "/servers", { ip: "10.77.0.2", port: 20111, domainId: d1.id }), 409, "ADDRESS_TAKEN");
    assert.status(await env.call("POST", "/servers", { ip: "10.77 0.3", port: 20111, domainId: d1.id }), 422, "INVALID_IP");
    assert.status(await env.call("POST", "/servers", { ip: "10.77.0.4", port: 20111, domainId: UNKNOWN_DOMAIN }), 404, "NOT_FOUND");
    const probe = (await env.ok("POST", "/servers/probe", { targets: [{ ip: "10.77.0.2", port: 20111 }] })).items[0];
    assert.eq([probe.status, probe.serverId], ["found", res.body.id], "опрос его видит");
  });

  test("Сервер: PATCH — имя, роль, сеть; неизвестная роль — 422", async () => {
    const env = await makeEnv();
    const res = await env.call("PATCH", `/servers/${inDomain.id}`, { name: "Сервер — Главный", role: "standby", netmask: "255.255.0.0" }, v(inDomain));
    assert.status(res, 200);
    assert.eq([res.body.name, res.body.role, res.body.netmask], ["Сервер — Главный", "standby", "255.255.0.0"], "изменено");
    assert.status(await env.call("PATCH", `/servers/${inDomain.id}`, { role: "boss" }, { "If-Match": `"${res.body.version}"` }), 422, "VALIDATION_FAILED");
    assert.status(await env.call("PATCH", `/servers/${inDomain.id}`, { allocated: false }, { "If-Match": `"${res.body.version}"` }), 422, "VALIDATION_FAILED", "домен — через assign");
  });

  test("Операция: план карточки сервера и домена; сервер без связи — fail SERVER_OFFLINE", async () => {
    const env = await makeEnv();
    const op = await env.runOperation({ idempotencyKey: key(), items: [
      { targetId: inDomain.id, set: { name: "Сервер — план" } },
      { targetId: d1.id, set: { license: "LIC-2" } },
      { targetId: offlineServer.id, set: { name: "не примется" } },
    ], expectedVersions: { [inDomain.id]: inDomain.version, [d1.id]: d1.version, [offlineServer.id]: offlineServer.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null], ["ok", null], ["fail", "SERVER_OFFLINE"]], "по шагам");
    assert.eq((await env.ok("GET", `/domains/${d1.id}`)).license, "LIC-2", "домен");
    const bad = await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ targetId: d1.id, set: { name: d2.name } }], expectedVersions: { [d1.id]: (await env.ok("GET", `/domains/${d1.id}`)).version } });
    assert.status(bad, 409, "NAME_TAKEN", "занятое имя домена — до выполнения");
    const wrong = await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ targetId: inDomain.id, folderIds: [] }], expectedVersions: { [inDomain.id]: (await env.ok("GET", `/servers/${inDomain.id}`)).version } });
    assert.status(wrong, 422, "VALIDATION_FAILED", "в папках только устройства");
  });

  /* ===== Папки ===== */

  test("Папка: создать корневую и вложенную; родитель в другом домене — 422", async () => {
    const env = await makeEnv();
    const root = await env.call("POST", "/folders", { name: "Новая папка", domainId: d1.id, parentId: null });
    assert.status(root, 201);
    const sub = await env.ok("POST", "/folders", { name: "Вложенная", domainId: d1.id, parentId: root.body.id });
    assert.eq([sub.parentId, sub.deviceIds], [root.body.id, []], "вложенная");
    assert.status(await env.call("POST", "/folders", { name: "x", domainId: d2.id, parentId: root.body.id }), 422, "VALIDATION_FAILED");
    assert.status(await env.call("POST", "/folders", { name: " ", domainId: d1.id, parentId: null }), 422, "NAME_REQUIRED");
    assert.status(await env.call("POST", "/folders", { name: "x", domainId: UNKNOWN_DOMAIN, parentId: null }), 404, "NOT_FOUND");
  });

  test("Папка: переименовать, очистить, задать состав; устройство чужого домена — 422", async () => {
    const env = await makeEnv();
    const f = FX.folders.find((x) => x.deviceIds.length > 2);
    let res = await env.ok("PATCH", `/folders/${f.id}`, { name: "Переименованная" }, v(f));
    res = await env.ok("PATCH", `/folders/${f.id}`, { deviceIds: [] }, { "If-Match": `"${res.version}"` });
    assert.eq([res.name, res.deviceIds.length], ["Переименованная", 0], "очищена");
    assert.ok(res.version !== f.version, "версия изменилась");
    const alien = FX.devices.find((d) => d.domainId !== f.domainId);
    assert.status(await env.call("PATCH", `/folders/${f.id}`, { deviceIds: [alien.id] }, { "If-Match": `"${res.version}"` }), 422, "VALIDATION_FAILED");
    assert.eq((await env.list("/devices")).length, FX.devices.length, "устройства на месте");
  });

  test("Папка: удалить вместе с подпапками, устройства остаются; без версии — 428", async () => {
    const env = await makeEnv();
    const kids = FX.folders.filter((x) => x.parentId === rootFolder.id).map((x) => x.id);
    assert.status(await env.call("DELETE", `/folders/${rootFolder.id}`), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("DELETE", `/folders/${rootFolder.id}`, undefined, v(rootFolder)), 204);
    const left = (await env.list("/folders")).map((x) => x.id);
    assert.ok(!left.includes(rootFolder.id) && kids.every((k) => !left.includes(k)), "папка и подпапки удалены");
    assert.eq((await env.list("/devices")).length, FX.devices.length, "устройства на месте");
    assert.status(await env.call("DELETE", `/folders/${rootFolder.id}`, undefined, v(rootFolder)), 404, "NOT_FOUND", "второй раз");
  });

  ApiTest.loaded("api-domains.js");
})();
