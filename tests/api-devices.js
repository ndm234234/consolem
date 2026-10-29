/* Тесты API: добавление устройств, групповое изменение, удаление, детекторы, поиск в сети. */
(() => {
  const { test, makeEnv, assert, key, FX } = ApiTest;
  const d1 = FX.domains[0];
  const folder = FX.folders.find((f) => f.domainId === d1.id && !f.parentId);
  const cam = FX.devices.find((d) => d.type === "camera" && d.name === "Главный вход");
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const create = (items) => ({ idempotencyKey: key(), items });
  const newCam = (over) => ({ type: "camera", name: "Камера — тест", ip: "10.9.9.9", port: 80, vendor: "Hikvision", model: "DS-2CD2143G2", login: "admin", password: "x", ...over });

  test("Добавить: камера с папкой — номер выдал сервер, пароль скрыт, в папке, дочерний детектор создан", async () => {
    const env = await makeEnv();
    const res = await env.ok("POST", "/devices", create([{ device: newCam({ recordMode: "motion", children: [{ type: "det", name: "Детектор движения", builtin: true }] }), domainId: d1.id, parentId: null, folderId: folder.id }]));
    assert.eq([res.done.length, res.failed.length], [1, 0], "создано");
    const [c, det] = res.done[0].devices;
    const max = Math.max(...FX.devices.filter((d) => ["camera", "ipsrv", "eventsrc", "acfa"].includes(d.type)).map((d) => Number(d.identifier || (/^\d+$/.test(d.short || "") ? d.short : 0)) || 0));
    assert.eq([c.identifier, c.hasPassword, "password" in c, c.enabled, c.online], [String(max + 1), true, false, true, true], "камера");
    assert.eq([det.type, det.parentId, det.domainId], ["det", c.id, d1.id], "детектор под камерой");
    assert.eq(res.done[0].folders[0].deviceIds.slice(-1), [c.id], "в папке");
    assert.eq((await env.list("/devices")).length, FX.devices.length + 2, "в списке");
  });

  test("Добавить: частичный успех — занятый номер, чужой родитель, папка другого домена", async () => {
    const env = await makeEnv();
    const alien = FX.folders.find((f) => f.domainId !== d1.id);
    const res = await env.ok("POST", "/devices", create([
      { device: newCam({ name: "ок" }), domainId: d1.id, parentId: null, folderId: null },
      { device: newCam({ identifier: cam.identifier }), domainId: d1.id, parentId: null, folderId: null },
      { device: { type: "sensor", name: "Датчик" }, domainId: FX.domains[1].id, parentId: cam.id, folderId: null },
      { device: newCam(), domainId: d1.id, parentId: null, folderId: alien.id },
    ]));
    assert.eq(res.done.map((x) => x.index), [0], "выполнено");
    assert.eq(res.failed.map((x) => [x.index, x.code]), [[1, "IDENTIFIER_TAKEN"], [2, "PARENT_MISMATCH"], [3, "VALIDATION_FAILED"]], "отказы");
  });

  test("Добавить: дочерний объект под камерой и служба сервера; повтор с тем же ключом — второй раз не создаёт", async () => {
    const env = await makeEnv();
    const s = FX.servers.find((x) => x.allocated && x.online);
    const body = create([
      { device: { type: "sensor", name: "Датчик двери", channel: 3 }, domainId: cam.domainId, parentId: cam.id, folderId: null },
      { device: { type: "email", name: "Email — тест", serverId: s.id, smtp: "smtp.local" }, domainId: s.domainId, parentId: null, folderId: null },
    ]);
    const a = await env.ok("POST", "/devices", body);
    const b = await env.ok("POST", "/devices", body);
    assert.eq(b, a, "тот же ответ");
    assert.eq([a.done[0].devices[0].parentId, a.done[1].devices[0].serverId], [cam.id, s.id], "куда легли");
    assert.eq((await env.list("/devices")).length, FX.devices.length + 2, "создано один раз");
  });

  test("Добавить из найденного: строка уходит из итога поиска", async () => {
    const env = await makeEnv();
    const disc = FX.discovery[0];
    const c = FX.network.find((x) => x.id === disc.candidateIds[0]);
    await env.ok("POST", "/devices", create([{ device: newCam({ ip: c.ip, mac: c.mac }), domainId: disc.domainId, parentId: null, folderId: null, candidateId: c.id }]));
    const now = await env.ok("GET", `/domains/${disc.domainId}/discovery`);
    assert.ok(!now.candidates.some((x) => x.id === c.id), "добавленное — не в найденных");
  });

  test("Изменить сразу: несколько устройств одним запросом, устаревшая версия — в failed", async () => {
    const env = await makeEnv();
    const cams = FX.devices.filter((d) => d.type === "camera" && d.archiveId).slice(0, 3);
    const a = FX.archives.find((x) => x.id !== cams[0].archiveId);
    const res = await env.ok("POST", "/devices/update", { idempotencyKey: key(), items: [
      { deviceId: cams[0].id, version: cams[0].version, set: { extraArchives: [{ archiveId: a.id, recordMode: "always", stream: "main" }] } },
      { deviceId: cams[1].id, version: cams[1].version, set: { recordMode: "motion" } },
      { deviceId: cams[2].id, version: cams[2].version + 9, set: { recordMode: "none" } },
    ] });
    assert.eq([res.done.length, res.failed.map((f) => f.code)], [2, ["VERSION_MISMATCH"]], "частичный успех");
    assert.eq((await env.ok("GET", `/devices/${cams[1].id}`)).recordMode, "motion", "изменено");
    assert.eq((await env.ok("GET", `/devices/${cams[2].id}`)).recordMode, cams[2].recordMode, "не тронуто");
  });

  test("Определить модель: по адресу; неизвестный производитель — null", async () => {
    const env = await makeEnv();
    const m = await env.ok("POST", "/devices/probe", { ip: "10.1.2.3", port: 80, vendor: "Axis" });
    assert.ok(FX.reference.deviceModels.find((x) => x.vendor === "Axis").models.includes(m.model), `модель Axis: ${m.model}`);
    assert.eq(await env.ok("POST", "/devices/probe", { ip: "10.1.2.3", port: 80, vendor: "Axis" }), m, "повторяется");
    assert.eq((await env.ok("POST", "/devices/probe", { ip: "10.1.2.3", port: 80, vendor: "Noname" })).model, null, "неизвестный");
  });

  test("Удалить устройство: вместе с дочерними, из папок и из записи по детекторам", async () => {
    const env = await makeEnv();
    const kids = FX.devices.filter((d) => d.parentId === cam.id);
    const det = kids.find((d) => d.type === "det");
    const other = FX.devices.find((d) => d.type === "camera" && d.id !== cam.id);
    await env.ok("PATCH", `/devices/${other.id}`, { recordDetectorIds: [det.id] }, v(other));
    assert.status(await env.call("DELETE", `/devices/${det.id}`), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("DELETE", `/devices/${cam.id}`, undefined, v(cam)), 204);
    const ids = new Set((await env.list("/devices")).map((d) => d.id));
    assert.ok(!ids.has(cam.id) && kids.every((k) => !ids.has(k.id)), `удалено с дочерними: ${kids.length}`);
    assert.ok((await env.list("/folders")).every((f) => !f.deviceIds.includes(cam.id)), "в папках нет");
    assert.eq((await env.ok("GET", `/devices/${other.id}`)).recordDetectorIds, [], "запись по детектору — без него");
    assert.status(await env.call("DELETE", `/devices/${cam.id}`, undefined, v(cam)), 404, "NOT_FOUND");
  });

  test("Детектор из карточки камеры: шаг create, «Отменить» удаляет созданное", async () => {
    const env = await makeEnv();
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ targetId: cam.id, create: { type: "det", name: "Новый детектор", detectorKind: "motion", sensitivity: 12 } }], expectedVersions: { [cam.id]: cam.version } });
    const id = op.items[0].createdId;
    assert.eq([op.ok, (await env.ok("GET", `/devices/${id}`)).parentId], [1, cam.id], "создан под камерой");
    const back = await env.ok("POST", `/operations/${op.id}/revert`);
    await env.advance(1);
    assert.eq((await env.ok("GET", `/operations/${back.id}`)).ok, 1, "откат выполнен");
    assert.status(await env.call("GET", `/devices/${id}`), 404, "NOT_FOUND", "созданного нет");
    assert.status(await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ targetId: cam.id, create: { type: "det", name: "x" }, set: { name: "y" } }], expectedVersions: { [cam.id]: cam.version } }), 422, "VALIDATION_FAILED", "create вместе с set");
  });

  test("Поиск в сети: найденное по одному в своём порядке, итог заменяет прежний; во время — 409; остановка", async () => {
    const env = await makeEnv();
    const did = d1.id;
    const expect = FX.network.filter((c) => c.domainIds.includes(did)).map((c) => c.id);
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "discovery" && m.entityId === did && seen.push(m.type));
    await ApiTest.settle();
    const res = await env.call("POST", `/domains/${did}/discovery`);
    assert.status(res, 202);
    assert.eq([res.body.state, res.body.candidates.map((c) => c.id)], ["searching", expect.slice(0, 1)], "начат, прежний итог сброшен, первая находка — сразу");
    assert.status(await env.call("POST", `/domains/${did}/discovery`), 409, "BUSY");
    await env.advance(5);
    const done = await env.ok("GET", `/domains/${did}/discovery`);
    assert.eq([done.state, done.progress, done.candidates.map((c) => c.id)], ["done", 100, expect], "найдено всё, по порядку");
    await ApiTest.settle();
    stop();
    assert.eq([seen.filter((t) => t === "discovery.progress").length, seen.filter((t) => t === "discovery.finished").length], [expect.length, 1], "в потоке");
    await env.ok("POST", `/domains/${did}/discovery`);
    const stopped = await env.ok("DELETE", `/domains/${did}/discovery`);
    assert.eq(stopped.state, "stopped", "остановлен");
    assert.status(await env.call("DELETE", "/domains/10009999-0000-4000-8000-000000000000/discovery"), 404, "NOT_FOUND");
  });

  ApiTest.loaded("api-devices.js");
})();
