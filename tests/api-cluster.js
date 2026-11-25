/* Тесты API: домен шире кластера, запрос 2026-11-01-182545Z пп. 7–11, 13, 16, 17 и дополнение пп. 4, 5. */
(() => {
  ApiTest.fileLayer("profile:vms.camera/1");
  const { makeEnv, assert, FX, FOLDER } = ApiTest;
  // Слой теста по началу имени; остальные тесты файла идут в слое файла
  const test = ApiTest.prefixLayers([
    ["Приём в домен", "profile:vms.server/1"],
    ["Приём шагом move", "profile:vms.server/1"],
    // Папка — профиль механизма core.folder/1 (с 0.28.0): её тесты — механизм
    ["Папки без связи", "mechanism"],
    ["Папки — не запись", "mechanism"],
    ["Правка при молчащем сервере", "mechanism"],
  ]);
  const d1 = FX.domains[0];
  const cam = FX.devices.find((d) => d.type === "camera" && !d.parentId && d.serverId && d.online && d.domainId === d1.id);
  const w2c = (over) => Object.assign({ id: "39999999-0000-4000-8000-000000000000", type: "camera", parentId: null, domainId: d1.id, name: "Камера w2c", online: true, enabled: true, direct: false, writableFields: ["name", "enabled"], ptz: true, version: "1" }, over);
  const withCam = (over) => ({ devices: FX.devices.concat(w2c(over)) });
  const server = FX.servers.find((s) => s.allocated && s.online && s.domainId === d1.id);
  // Пути ядра: объект по uid; что система говорит о записи камеры (recordingTarget, direct) — status.observed
  const U = (uid) => `/units/${uid}`;
  const obs = (u) => (u.status || {}).observed || {};
  // Назначение записи w2c — у api-archive.js («Запись камеры w2c: приёмник — PUT /units/{uid}/recording-target»)

  test("Камера-кластер: правка принята — 409 SERVER_OFFLINE с kept, применится с периодом; повтор тот же, другая — 412; шаг операции", async () => {
    const env = await makeEnv({ fixturePatch: withCam() });
    const id = w2c().id, ver = async () => (await env.ok("GET", U(id))).version;
    const v0 = await ver(), patch = (body) => env.call("PATCH", U(id), body, { "If-Match": `"${v0}"` });
    const first = await patch({ name: "Новое имя" });
    assert.status(first, 409, "SERVER_OFFLINE", "принята, срок вышел");
    assert.eq(first.body.params.targetId, id, "цель");
    const kept = first.body.params.kept;
    assert.ok(typeof kept === "string" && kept, "имя правки");
    assert.eq((await env.ok("GET", U(id))).name, w2c().name, "ещё не применена");
    assert.eq((await patch({ name: "Новое имя" })).body.params.kept, kept, "повтор новую не заводит");
    assert.status(await patch({ name: "Другое имя" }), 412, "VERSION_MISMATCH", "другая правка до применения первой");
    await env.call("POST", "/test/clock", { advanceSec: 61 });
    const done = await env.ok("GET", U(id));
    assert.ok(done.name === "Новое имя" && done.version !== v0, "применена с периодом камеры");
    const again = await env.call("PATCH", U(id), { name: "Третье" }, { "If-Match": `"${done.version}"` });
    assert.ok(again.body.params.kept && again.body.params.kept !== kept, "новая правка — новое имя");
    const op = await env.runOperation({ idempotencyKey: "k-kept-0002", items: [{ uid: id, patch: { name: "Третье" } }], expectedVersions: { [id]: done.version } });
    assert.eq([op.items[0].state, op.items[0].code, op.items[0].params.kept], ["fail", "SERVER_OFFLINE", again.body.params.kept], "шаг операции: код и kept, та же правка");
  }, { needs: ["patchUnit", "createOperation"] });

  test("Копии записи: список серверов, порядок значим; копия — кластер: повтор, чужой, кластер основного и два сервера кластера — 422", async () => {
    // Свои серверы: кластер — начало имени, наборы называют серверы по-разному
    const names = ["К1/Сервер а", "К1/Сервер б", "К2/Сервер а", "К2/Сервер б", "К3/Сервер а", "Сервер один"];
    const made = names.map((name, i) => Object.assign({}, server, { id: `2000aaa${i}-0000-4000-8000-000000000000`, name, fingerprint: undefined }));
    const env = await makeEnv({ fixturePatch: Object.assign(withCam(), { servers: FX.servers.concat(JSON.parse(JSON.stringify(made))) }) });
    const put = (b) => env.call("PUT", `${U(w2c().id)}/recording-target`, b);
    const target = (r) => obs(r.body).recordingTarget;
    const [main, twin, a, a2, b, solo] = made.map((s) => s.id);
    const res = await put({ serverId: main, copies: [b, a, solo] });
    assert.eq(target(res), { serverId: main, copies: [b, a, solo] }, "порядок как прислан");
    assert.eq(obs(await env.ok("GET", U(w2c().id))).recordingTarget.copies, [b, a, solo], "и на чтении");
    assert.eq(target(await put({ serverId: main, copies: [a, b] })).copies, [a, b], "порядок сменился");
    const bad = async (copies, what) => {
      const r = await put({ serverId: main, copies });
      assert.status(r, 422, "VALIDATION_FAILED", what);
      assert.eq(r.body.field, "/copies", what);
    };
    await bad([a, a], "повтор");
    await bad(["20009999-0000-4000-8000-000000000000"], "несуществующий");
    await bad([main], "сам основной");
    await bad([twin], "сервер кластера основного");
    await bad([a, a2], "два сервера одного кластера");
    assert.eq(obs(await env.ok("GET", U(w2c().id))).recordingTarget.copies, [a, b], "отказ ничего не менял");
    assert.eq(target(await put({ serverId: main, copies: [] })).copies, [], "пусто — копий нет");
    const off = await put({ serverId: null, copies: [a] });
    assert.status(off, 422, "VALIDATION_FAILED", "снятие с копиями");
    assert.status(await put({ serverId: main, copies: 2 }), 422, "VALIDATION_FAILED", "число — прежний контракт, больше не принимается");
  }, { needs: ["putUnitRecordingTarget"] });

  test("Камера w2c: адресные поля не пишутся, молчание — DEVICE_OFFLINE, движение арендой недоступно, пресет можно", async () => {
    const env = await makeEnv({ fixturePatch: withCam() });
    const id = w2c().id;
    const r = await env.ok("GET", U(id));
    assert.eq([obs(r).direct, "ip" in r.properties, r.writable], [false, false, ["name", "enabled"]], "адреса нет, правится только имя и включение");
    const addr = await env.call("PATCH", U(id), { properties: { ip: "10.0.0.1" } }, { "If-Match": `"${r.version}"` });
    assert.status(addr, 422, "NOT_SUPPORTED", "адрес не пишется");
    assert.eq(addr.body.field, "/properties/ip", "поле");
    assert.status(await env.call("PUT", `${U(id)}/ptz`, { pan: 0.1, tilt: 0, zoom: 0, focus: 0, ttlSec: 2 }), 422, "NOT_SUPPORTED", "аренда");
    assert.status(await env.call("PUT", `${U(id)}/presets/1`, { name: "Ворота" }), 200, null, "подпись пресета правкой");
    const pos = await env.call("PUT", `${U(id)}/presets/1`, {});
    assert.status(pos, 409, "OTHER_CLUSTER", "положение на камере за NAT");
    assert.ok(!pos.body.params || !pos.body.params.url, "ссылки на вход нет");
    const off = await makeEnv({ fixturePatch: withCam({ online: false }) });
    const o = await off.ok("GET", U(id));
    assert.status(await off.call("PATCH", U(id), { name: "x" }, { "If-Match": `"${o.version}"` }), 409, "DEVICE_OFFLINE");
  }, { needs: ["patchUnit", "putUnitPtz", "putUnitPreset"] });

  test("Правка при молчащем сервере — 409 SERVER_OFFLINE; другой кластер — OTHER_CLUSTER со ссылкой", async () => {
    const quiet = FX.servers.find((s) => s.allocated && !s.online);
    const onIt = FX.devices.find((x) => x.serverId === quiet.id);
    const env = await makeEnv();
    if (onIt) assert.status(await env.call("PATCH", U(onIt.id), { name: "x" }, { "If-Match": `"${onIt.version}"` }), 409, "SERVER_OFFLINE");
    const url = "https://cluster-b/backend/";
    const other = await makeEnv({ fixturePatch: { stand: { otherCluster: { [cam.id]: url } } } });
    const res = await other.call("POST", `${U(cam.id)}/live`, { width: 640, height: 360 });
    assert.status(res, 409, "OTHER_CLUSTER");
    assert.eq(res.body.params.url, url, "ссылка на вход");
    // Камера w2c за NAT, вошли не через кластер приёмника: та же дверь, та же кнопка
    const id = w2c().id;
    const nat = await makeEnv({ fixturePatch: Object.assign(withCam({}), { stand: { otherCluster: { [id]: url } } }) });
    const far = await nat.call("POST", `${U(id)}/live`, { width: 640, height: 360 });
    assert.status(far, 409, "OTHER_CLUSTER");
    assert.eq(far.body.params.url, url, "камера за NAT: ссылка на вход");
    // Вошли через него: обычный адрес
    assert.ok((await (await makeEnv({ fixturePatch: withCam({}) })).ok("POST", `${U(id)}/live`, { width: 640, height: 360 })).whepUrl, "через свой кластер — адрес");
  }, { needs: ["patchUnit", "startUnitLive"] });

  test("Определение модели: логин и пароль необязательны, без них система вправе не назвать", async () => {
    const env = await makeEnv({ fixturePatch: { stand: { probeNeedsLogin: true } } });
    // Производитель, у которого модели есть: у первого в наборе список пуст, и «с входом» модель не назвать
    const part = ((await env.ok("GET", "/kinds/camera")).schema.allOf || []).find((x) => x.if && x.if.properties && x.if.properties.vendor
      && x.then && x.then.properties && x.then.properties.model && (x.then.properties.model.examples || []).length);
    const vendor = part.if.properties.vendor.const;
    // Камеры ещё нет: команда вида (scope kind) — POST /kinds/camera/actions/probe
    const probe = async (params) => (await env.ok("POST", "/kinds/camera/actions/probe", { params })).result;
    assert.eq((await probe({ ip: "10.1.1.1", port: 80, vendor })).model, null, "без входа");
    assert.ok((await probe({ ip: "10.1.1.1", port: 80, vendor, login: "a", password: "b" })).model, "с входом");
  }, { needs: ["runKindAction", "kind:camera"] });

  test("Приём в домен (перенос move): отпечаток сверяется, только администратор домена, камера становится объектом camera", async () => {
    const knock = FX.servers.find((s) => !s.allocated && s.domainId === d1.id && s.fingerprint && s.class !== "camera");
    const env = await makeEnv();
    const accept = (e, s, params, version) => e.call("POST", `/units/${s.id}/move`, Object.assign({ parentId: s.domainId }, params ? { params } : {}), { "If-Match": `"${version || s.version}"` });
    assert.status(await accept(env, knock, { fingerprint: "чужой" }), 409, "FINGERPRINT_MISMATCH", "чужая коробка");
    assert.status(await accept(env, knock), 409, "FINGERPRINT_MISMATCH", "без сверки");
    const ok = await accept(env, knock, { fingerprint: knock.fingerprint });
    assert.status(ok, 200, null, "принят");
    assert.eq([ok.body.uid, ok.body.properties.allocated], [knock.id, true], "принят");
    const back = await env.call("POST", `/units/${knock.id}/move`, { parentId: null }, { "If-Match": ok.headers.etag });
    assert.eq(back.body.properties.allocated, false, "исключён");
    const adm = FX.access.roles.find((r) => r.global.unr);
    const man = FX.access.users.find((u) => u.enabled && !u.roleIds.includes(adm.id) && !FX.access.groups.some((g) => g.memberIds.includes(u.id) && g.roleIds.includes(adm.id)));
    const plain = await makeEnv({ actAs: man.login });
    assert.status(await accept(plain, knock, { fingerprint: knock.fingerprint }), 403, "PERMISSION_DENIED");
    const cam2 = FX.servers.find((s) => !s.allocated && s.class === "camera" && s.domainId === d1.id);
    const seen = [];
    const env2 = await makeEnv();
    const stop = ApiTest.subscribeForTest((m) => seen.push(m), [d1.id]);
    await ApiTest.settle();
    const camera = await accept(env2, cam2, { fingerprint: cam2.fingerprint });
    await ApiTest.settle();
    stop();
    assert.eq(camera.body.kind, "camera", "ответ — объект camera");
    assert.ok(seen.some((m) => m.type === "entity.deleted" && m.kind === "server" && m.entityId === cam2.id), "запись сервера снята");
    assert.ok(seen.some((m) => m.type === "entity.created" && m.kind === "device" && m.entityId === camera.body.uid), "появилась камера");
    assert.status(await env2.call("GET", `/units/${cam2.id}`), 404, "NOT_FOUND", "сервера нет");
  }, { needs: ["moveUnit", "implements:vms.server/1"] });

  test("Приём шагом move операции: итог шага называет затронутый объект; сервер-камера — createdId камеры, которой он стал", async () => {
    const box = FX.servers.find((s) => !s.allocated && s.class === "camera" && s.domainId === d1.id && s.fingerprint);
    const plain = FX.servers.find((s) => !s.allocated && s.class !== "camera" && s.domainId === d1.id && s.fingerprint);
    const env = await makeEnv();
    const step = (s) => ({ uid: s.id, move: s.domainId, params: { fingerprint: s.fingerprint } });
    const res = await env.call("POST", "/operations", { idempotencyKey: ApiTest.key(), items: [step(plain), step(box)], expectedVersions: { [plain.id]: plain.version, [box.id]: box.version }, wait: true });
    assert.status(res, 200, null, "перенос — мгновенный шаг: итог в запросе");
    const [a, b] = res.body.items;
    assert.eq([a.state, a.targetId, a.createdId], ["ok", plain.id, undefined], "обычный сервер: объект шага — он сам");
    assert.eq([b.state, b.targetId], ["ok", box.id], "камера-коробка принята");
    assert.ok(b.createdId && b.createdId !== box.id, "createdId — новый объект");
    const made = await env.ok("GET", `/units/${b.createdId}`);
    assert.eq([made.kind, made.name, made.domainId, made.version], ["camera", box.name, d1.id, b.version], "это камера, версия — из итога шага");
    assert.status(await env.call("GET", `/units/${box.id}`), 404, "NOT_FOUND", "записи сервера нет");
  }, { needs: ["createOperation", "implements:vms.server/1"] });

  test("Папки без связи с доменом: 409 SERVER_OFFLINE, шаг fail, создание с папкой — строка fail SERVER_OFFLINE /folders", async () => {
    const f = FX.folders.find((x) => x.domainId === d1.id);
    const env = await makeEnv();
    const dev = await env.ok("GET", `/units/${f.deviceIds[0] || cam.id}`);
    await env.ok("POST", "/test/events", { type: "domain.link", domainId: d1.id, online: false });
    const made = await env.ok("POST", "/units", { idempotencyKey: ApiTest.key(), items: [{ kind: "folder", name: "x", domainId: d1.id, properties: {} }] });
    assert.eq(made.failed.map((x) => x.code), ["SERVER_OFFLINE"], "создать папку");
    assert.status(await env.call("PATCH", `/units/${f.id}`, { name: "x" }, { "If-Match": `"${f.version}"` }), 409, "SERVER_OFFLINE", "переименовать");
    assert.status(await env.call("DELETE", `/units/${f.id}`, undefined, { "If-Match": `"${f.version}"` }), 409, "SERVER_OFFLINE", "удалить");
    const without = (dev.folders || []).filter((x) => x !== f.id);
    const inside = without.length === (dev.folders || []).length ? without.concat(f.id) : without;
    assert.status(await env.call("PATCH", `/units/${dev.uid}`, { folders: inside }, { "If-Match": `"${dev.version}"` }), 409, "SERVER_OFFLINE", "состав папки");
    const op = await env.runOperation({ idempotencyKey: ApiTest.key(), items: [{ uid: dev.uid, folders: inside }], expectedVersions: { [dev.uid]: dev.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["fail", "SERVER_OFFLINE"]], "шаг folders");
    const res = await env.ok("POST", "/units", { idempotencyKey: ApiTest.key(), items: [{ kind: "camera", name: "Новая", domainId: d1.id, parentId: null, folders: [f.id], properties: { rtspUrl: "rtsp://10.0.0.9/1" } }] });
    assert.eq(res.failed.map((x) => [x.code, x.field]), [["SERVER_OFFLINE", "/folders"]], "создание с папкой");
  }, { needs: ["patchUnit", "deleteUnit", "createOperation", "createUnits", `implements:${FOLDER}`, "kind:camera", "testEvent"] });

  test("Папки без связи с доменом, перенос: 409 SERVER_OFFLINE, шаг move — fail, папка на месте", async () => {
    const f = FX.folders.find((x) => x.domainId === d1.id && x.parentId);
    const env = await makeEnv();
    await env.ok("POST", "/test/events", { type: "domain.link", domainId: d1.id, online: false });
    assert.status(await env.call("POST", `/units/${f.id}/move`, { parentId: null }, { "If-Match": `"${f.version}"` }), 409, "SERVER_OFFLINE", "перенести");
    const op = await env.runOperation({ idempotencyKey: ApiTest.key(), items: [{ uid: f.id, move: null }], expectedVersions: { [f.id]: f.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["fail", "SERVER_OFFLINE"]], "шаг move");
    assert.eq((await env.ok("GET", `/units/${f.id}`)).parentId, f.parentId, "родитель прежний");
  }, { needs: ["moveUnit", "createOperation", `implements:${FOLDER}`, "cap:folder:move", "testEvent"] });

  test("Папки — не запись на сервер устройства: шаги folders и patch {folders}, PATCH {folders} при молчащем сервере проходят, как состав папки в базе", async () => {
    const env = await makeEnv();
    const quiet = FX.servers.filter((s) => s.allocated && s.online === false);
    const dev = FX.devices.find((d) => d.type === "camera" && !d.parentId && quiet.some((s) => s.id === d.serverId));
    assert.ok(dev, "в наборе есть камера молчащего сервера");
    const f = FX.folders.find((x) => x.domainId === dev.domainId);
    const toggle = (list) => ((list || []).includes(f.id) ? list.filter((x) => x !== f.id) : (list || []).concat(f.id));
    const sorted = (list) => (list || []).slice().sort();
    let u = await env.ok("GET", `/units/${dev.id}`);
    const next = toggle(u.folders);
    const op = await env.runOperation({ idempotencyKey: ApiTest.key(), items: [{ uid: u.uid, folders: next }], expectedVersions: { [u.uid]: u.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null]], "шаг folders");
    u = await env.ok("GET", `/units/${dev.id}`);
    assert.eq(sorted(u.folders), sorted(next), "папки после шага");
    // Шаг patch, который меняет только folders, — тоже не запись на сервер устройства
    const back = toggle(u.folders);
    const op2 = await env.runOperation({ idempotencyKey: ApiTest.key(), items: [{ uid: u.uid, patch: { folders: back } }], expectedVersions: { [u.uid]: u.version } });
    assert.eq(op2.items.map((x) => [x.state, x.code]), [["ok", null]], "шаг patch {folders}");
    u = await env.ok("GET", `/units/${dev.id}`);
    assert.eq(sorted(u.folders), sorted(back), "папки после шага patch");
    const named = await env.runOperation({ idempotencyKey: ApiTest.key(), items: [{ uid: u.uid, patch: { name: "Другое имя", folders: u.folders || [] } }], expectedVersions: { [u.uid]: u.version } });
    assert.eq(named.items.map((x) => [x.state, x.code]), [["fail", "SERVER_OFFLINE"]], "шаг patch с именем — запись на сервер");
    const p = await env.call("PATCH", `/units/${u.uid}`, { folders: toggle(u.folders) }, { "If-Match": `"${u.version}"` });
    assert.status(p, 200, null, "PATCH {folders}");
    assert.status(await env.call("PATCH", `/units/${u.uid}`, { name: "Другое имя" }, { "If-Match": p.headers.etag }), 409, "SERVER_OFFLINE", "имя — запись на сервер");
  }, { needs: ["createOperation", "patchUnit", `implements:${FOLDER}`, "kind:camera"] });

  ApiTest.loaded("api-cluster.js");
})();
