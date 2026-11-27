/* Тесты API: добавление устройств, групповое изменение, удаление, детекторы, поиск в сети.
   Пути ядра: устройство — объект своего вида (camera, det, sensor, acfa_lock…), поток камеры — дочерний объект вида stream;
   создание — POST /units (дочерние — children, папки — folders), правка — PATCH /units/{uid}, удаление — DELETE /units/{uid},
   команды — /units/{uid}/actions/… (probe, output, команды единиц СКУД), живое видео и PTZ — /units/{uid}/live, ptz, presets.
   Поле отказа — JSON Pointer. */
(() => {
  ApiTest.fileLayer("profile:vms.camera/1");
  const { makeEnv, assert, key, FX } = ApiTest;
  // Слой теста по началу имени; остальные тесты файла идут в слое файла
  const test = ApiTest.prefixLayers([
    ["Добавить:", "mechanism"],
    ["Добавить из найденного", "mechanism"],
    ["Удалить камеру: строки незнакомых видов", "mechanism"],
    ["Детектор из карточки камеры", "mechanism"],
    ["Профиль при добавлении", "mechanism"],
    ["Поиск в сети", "profile:vms.discovery/1"],
    ["Схемы видов:", "mechanism"],
    ["Потоки:", "profile:vms.stream/1"],
    ["Разрешение:", "profile:vms.stream/1"],
    ["Адрес RTSP у потока", "profile:vms.stream/1"],
    ["Живое видео", "video"],
    ["Переразместить", "video"],
    ["Пресеты", "video"],
    ["Аренда PTZ", "video"],
    ["Поддетектор", "profile:vms.subdetector/1"],
    ["Удаление детектора удаляет поддетекторы", "profile:vms.subdetector/1"],
    ["План одной операцией", "profile:vms.subdetector/1"],
    ["/tree/children: у трекера", "profile:vms.subdetector/1"],
    ["Правило по subdet.triggered", "profile:vms.subdetector/1"],
    ["Встроенный детектор", "profile:vms.detector/1"],
    ["Несовместимые", "profile:vms.detector/1"],
    ["Зона:", "profile:vms.detector/1"],
    ["Детектор без полей", "profile:vms.detector/1"],
    ["objectSize", "profile:vms.detector/1"],
    ["extraZones", "profile:vms.detector/1"],
    ["direction", "profile:vms.detector/1"],
    ["recordMask", "profile:vms.detector/1"],
    ["analyticsKind", "profile:vms.detector/1"],
    ["Свойства детектора и поддетектора", "profile:vms.detector/1"],
    ["Списки лиц и номеров у детектора", "profile:vms.detector/1"],
    ["Записи списков лиц и номеров", "mechanism"],
    ["Источник:", "profile:vms.pos/1"],
    ["Правило: событие text", "profile:vms.pos/1"],
    ["Единица СКУД", "profile:vms.acs/1"],
    ["Реле: в СКУД", "profile:vms.acs/1"],
    ["Команда единицы", "profile:vms.acs/1"],
    ["Правило: действие unit", "profile:vms.acs/1"],
  ]);
  const d1 = FX.domains[0];
  const folder = FX.folders.find((f) => f.domainId === d1.id && !f.parentId);
  const cam = FX.devices.find((d) => d.type === "camera" && d.name === "Главный вход");
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const U = (uid) => `/units/${uid}`;
  const P = (name) => `/properties/${name}`;
  const create = (env, ...items) => env.ok("POST", "/units", { idempotencyKey: key(), items });
  const made = async (env, item) => {
    const res = await create(env, item);
    assert.eq(res.failed.map((x) => [x.code, x.field]), [], `создан ${item.kind}`);
    return res.done[0].units;
  };
  const failedOf = async (env, item) => (await create(env, item)).failed.map((x) => [x.code, x.field]);
  const newCam = (props, over) => Object.assign({ kind: "camera", name: "Камера — тест", domainId: d1.id,
    properties: Object.assign({ ip: "10.9.9.9", port: 80, vendor: "Hikvision", model: "DS-2CD2143G2", login: "admin", password: "x" }, props) }, over);
  const obs = (u) => (u.status || {}).observed || {};
  const get = (env, uid) => env.ok("GET", U(uid));
  const patch = (env, u, body) => env.call("PATCH", U(u.uid), body, v(u));
  const props = (env, u, properties) => patch(env, u, { properties });
  const field = (res, code, name, msg, status = 422) => { assert.status(res, status, code, msg); assert.eq(res.body.field, name, `${msg}: поле`); };
  const ofKind = async (env, kind, more) => (await env.list(`/units?kind=${kind}`)).find((u) => !more || more(u));
  const inFolder = async (env, folderId) => (await env.pages(`/units?folderId=${folderId}&limit=1000`)).map((u) => u.uid);
  const devCount = async (env, kinds) => (await env.pages(`/units?kind=${kinds}&limit=1000`)).length;
  // Потоки камеры — дочерние объекты вида stream (основной — первый по uid)
  const streamsOf = async (env, uid) => (await env.list(`/units?parentId=${uid}&kind=stream`)).sort((a, b) => (a.uid < b.uid ? -1 : 1));

  test("Добавить: камера с папкой — номер выдал сервер, пароль скрыт, в папке, дочерний детектор создан", async () => {
    const env = await makeEnv();
    const before = await devCount(env, "camera,det");
    const [c, det] = await made(env, newCam({ recordMode: "motion" }, { folders: [folder.id], children: [{ kind: "det", name: "Детектор движения", properties: { builtin: true } }] }));
    const max = Math.max(...FX.devices.filter((d) => ["camera", "ipsrv", "eventsrc", "acfa"].includes(d.type)).map((d) => Number(d.identifier || (/^\d+$/.test(d.short || "") ? d.short : 0)) || 0));
    assert.eq([c.properties.identifier, c.secrets && c.secrets.password, "password" in c.properties, c.properties.login, c.properties.enabled, c.status.link], [String(max + 1), true, false, "admin", true, "online"], "камера: пароль скрыт, логин читается");
    assert.eq([det.kind, det.parentId, det.domainId], ["det", c.uid, d1.id], "детектор под камерой");
    assert.ok((await inFolder(env, folder.id)).includes(c.uid), "в папке");
    assert.eq(await devCount(env, "camera,det"), before + 2, "в списке");
    assert.eq((await streamsOf(env, c.uid)).map((s) => s.properties.streamId), ["main"], "основной поток — дочерний объект stream");
  }, { needs: ["createUnits", "kind:camera", "kind:det"] });

  test("Добавить: частичный успех — занятый номер, родитель другого домена, папка другого домена", async () => {
    const env = await makeEnv();
    // Родитель другого домена и папка другого домена — только если в наборе есть второй домен
    const d2 = FX.domains[1];
    const alien = FX.folders.find((f) => f.domainId !== d1.id);
    const rows = [
      [newCam({}, { name: "ок" }), null],
      [newCam({ identifier: cam.identifier }), ["IDENTIFIER_TAKEN", P("identifier")]],
    ];
    // Домен дочернего — домен родителя: другой в строке — VALIDATION_FAILED /domainId (у старого пути — PARENT_MISMATCH)
    if (d2) rows.push([{ kind: "det", name: "Детектор", domainId: d2.id, parentId: cam.id, properties: {} }, ["VALIDATION_FAILED", "/domainId"]]);
    if (alien) rows.push([newCam({}, { folders: [alien.id] }), ["VALIDATION_FAILED", "/folders/0"]]);
    const res = await create(env, ...rows.map((r) => r[0]));
    assert.eq(res.done.map((x) => x.index), [0], "выполнено");
    assert.eq(res.failed.map((x) => [x.index, x.code, x.field]), rows.map((r, i) => [i].concat(r[1] || [])).slice(1), "отказы");
  }, { needs: ["createUnits", "kind:camera"] });

  test("Добавить: дочерний объект под камерой и служба сервера; повтор с тем же ключом — второй раз не создаёт", async () => {
    const env = await makeEnv();
    const s = FX.servers.find((x) => x.allocated && x.online);
    // Дочерний — детектор: датчики находит сервер; служба — если есть email-оповещатели
    const rows = [{ kind: "det", name: "Детектор — тест", parentId: cam.id, properties: { detectorKind: "motion" } }];
    const mail = ApiTest.can("type:email") && ApiTest.can("kind:email");
    if (mail) rows.push({ kind: "email", name: "Email — тест", domainId: s.domainId, properties: { serverId: s.id, smtp: "smtp.local" } });
    const before = await devCount(env, "det,email");
    const body = { idempotencyKey: key(), items: rows };
    const a = await env.ok("POST", "/units", body);
    const b = await env.ok("POST", "/units", body);
    assert.eq(b, a, "тот же ответ");
    assert.eq(a.done[0].units[0].parentId, cam.id, "дочерний — под камерой");
    if (mail) assert.eq(a.done[1].units[0].properties.serverId, s.id, "служба — на сервере");
    assert.eq(await devCount(env, "det,email"), before + rows.length, "создано один раз");
  }, { needs: ["createUnits", "kind:det"] });

  test("Добавить из найденного: строка уходит из итога поиска, MAC — из находки", async () => {
    const env = await makeEnv();
    const disc = FX.discovery[0];
    const c = FX.network.find((x) => x.id === disc.candidateIds[0]);
    const [u] = await made(env, newCam({ ip: c.ip, mac: c.mac }, { domainId: disc.domainId, candidateId: c.id }));
    const now = await env.ok("GET", `/units/${disc.domainId}/discovery`);
    assert.ok(!now.candidates.some((x) => x.id === c.id), "добавленное — не в найденных");
    assert.eq(u.properties.mac, c.mac, "MAC из поиска сохранён");
  }, { needs: ["getDiscovery", "createUnits", "implements:vms.discovery/1"] });

  test("Определить модель: команда probe камеры и регистратора; повторяется; неизвестный производитель — null", async () => {
    const env = await makeEnv();
    const probe = async (uid, params) => (await env.ok("POST", `${U(uid)}/actions/probe`, { params })).result;
    const m = await probe(cam.id, { ip: "10.1.2.3", port: 80, vendor: "Axis" });
    // Модели производителя — allOf вида камеры: if vendor = Axis → then model.examples (с 0.30.0)
    const axis = ((await env.ok("GET", "/kinds/camera")).schema.allOf || []).find((x) => x.if && x.if.properties && x.if.properties.vendor && x.if.properties.vendor.const === "Axis");
    assert.ok(axis && axis.then.properties.model.examples.includes(m.model), `модель Axis: ${m.model}`);
    assert.eq(await probe(cam.id, { ip: "10.1.2.3", port: 80, vendor: "Axis" }), m, "повторяется");
    assert.eq((await probe(cam.id, { ip: "10.1.2.3", port: 80, vendor: "Noname" })).model, null, "неизвестный");
    const nvr = FX.devices.find((d) => d.type === "ipsrv" && d.online !== false);
    if (nvr) assert.eq(await probe(nvr.id, { ip: "10.1.2.3", port: 80, vendor: "Axis" }), m, "у регистратора — та же команда");
    const bad = await env.call("POST", `${U(cam.id)}/actions/probe`, { params: { port: 80 } });
    assert.status(bad, 422, "VALIDATION_FAILED", "адрес обязателен");
  }, { needs: ["runUnitAction", "kind:camera"] });

  test("Удалить устройство: вместе с дочерними, из папок и из записи по детекторам; события — с видом объекта", async () => {
    const env = await makeEnv();
    const kids = FX.devices.filter((d) => d.parentId === cam.id);
    const det = kids.find((d) => d.type === "det");
    const other = await get(env, FX.devices.find((d) => d.type === "camera" && d.id !== cam.id).id);
    await env.ok("PATCH", U(other.uid), { properties: { recordDetectorIds: [det.id] } }, v(other));
    assert.status(await env.call("DELETE", U(det.id)), 428, "PRECONDITION_REQUIRED");
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.type === "entity.deleted" && seen.push([m.entityId, m.kind]), [cam.id]);
    await ApiTest.settle();
    assert.status(await env.call("DELETE", U(cam.id), undefined, v(await get(env, cam.id))), 204);
    await ApiTest.settle();
    stop();
    const ids = new Set((await env.pages("/units?limit=1000")).map((u) => u.uid));
    assert.ok(!ids.has(cam.id) && kids.every((k) => !ids.has(k.id)), `удалено с дочерними: ${kids.length}`);
    for (const f of FX.folders.filter((x) => x.deviceIds.includes(cam.id))) assert.ok(!(await inFolder(env, f.id)).includes(cam.id), "в папках нет");
    assert.eq((await get(env, other.uid)).properties.recordDetectorIds, [], "запись по детектору — без него");
    assert.ok(seen.some(([id, k]) => id === cam.id && k === "camera"), "entity.deleted камеры — вид camera");
    if (det) assert.ok(seen.some(([id, k]) => id === det.id && k === "det"), "каскад — со своим видом");
    assert.status(await env.call("DELETE", U(cam.id), undefined, v(cam)), 404, "NOT_FOUND");
  }, { needs: ["deleteUnit", "patchUnit", "kind:camera"] });

  test("Удалить камеру: строки незнакомых видов под ней уходят с ней — и DELETE, и групповым удалением", async () => {
    const env = await makeEnv();
    const all = await env.pages("/units?limit=1000");
    const kindsOf = new Map((await env.ok("GET", "/kinds")).items.map((k) => [k.kind, k]));
    const byUid = new Map(all.map((u) => [u.uid, u]));
    const isCam = (u) => !!u && (kindsOf.get(u.kind) || {}).implements?.includes("vms.camera/1");
    const rows = all.filter((u) => isCam(byUid.get(u.parentId)) && !FX.devices.some((d) => d.id === u.uid) && u.kind !== "stream");
    if (rows.length < 1) return "строк незнакомых видов под камерами в наборе нет";
    const under = (c) => all.filter((u) => u.parentId === c && rows.includes(u)).map((u) => u.uid);
    const [one, two] = [...new Set(rows.map((u) => u.parentId))];
    const gone = under(one);
    assert.status(await env.call("DELETE", U(one), undefined, v(byUid.get(one))), 204, null, "камера путём ядра");
    for (const uid of gone) assert.status(await env.call("GET", U(uid)), 404, "NOT_FOUND", "строка ушла с камерой");
    if (two) {
      const left = under(two);
      const res = await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: [{ id: two, version: (await get(env, two)).version }] });
      assert.eq(res.done, [two], "камера групповым удалением");
      for (const uid of left) assert.status(await env.call("GET", U(uid)), 404, "NOT_FOUND", "и групповым удалением");
    }
  }, { needs: ["deleteUnit", "listKinds", "implements:vms.camera/1"] });

  test("Детектор из карточки камеры: шаг createUnit, «Отменить» удаляет созданное", async () => {
    const env = await makeEnv();
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: cam.id, createUnit: { kind: "det", name: "Новый детектор", properties: { detectorKind: "motion", sensitivity: 12 } } }], expectedVersions: {} });
    const id = op.items[0].createdId;
    assert.eq([op.ok, (await get(env, id)).parentId], [1, cam.id], "создан под камерой");
    const back = await env.ok("POST", `/operations/${op.id}/revert`);
    assert.eq((await env.finished(back.id)).ok, 1, "откат выполнен");
    assert.status(await env.call("GET", U(id)), 404, "NOT_FOUND", "созданного нет");
    assert.status(await env.call("POST", "/operations", { idempotencyKey: key(), items: [{ uid: cam.id, createUnit: { kind: "det", name: "x" }, patch: { name: "y" } }], expectedVersions: { [cam.id]: cam.version } }), 422, "VALIDATION_FAILED", "createUnit вместе с patch");
  }, { needs: ["kind:det"] });

  test("Поиск в сети: найденное по одному в своём порядке, итог заменяет прежний; во время — 409; остановка", async () => {
    const env = await makeEnv();
    const did = d1.id;
    // Без тела — все серверы области, IP-устройства (category нет — ip; с 0.36.0)
    const expect = FX.network.filter((c) => c.domainIds.includes(did) && (c.category || "ip") === "ip").map((c) => c.id);
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "discovery" && m.entityId === did && seen.push(m.type));
    await ApiTest.settle();
    const res = await env.call("POST", `/units/${did}/discovery`);
    assert.status(res, 202);
    assert.eq([res.body.state, res.body.candidates.map((c) => c.id)], ["searching", expect.slice(0, 1)], "начат, прежний итог сброшен, первая находка — сразу");
    assert.status(await env.call("POST", `/units/${did}/discovery`), 409, "BUSY");
    const done = await env.until(async () => {
      const x = await env.ok("GET", `/units/${did}/discovery`);
      return x.state === "done" && x;
    }, "поиск закончился");
    assert.eq([done.state, done.progress, done.candidates.map((c) => c.id)], ["done", 100, expect], "найдено всё, по порядку");
    await ApiTest.settle();
    stop();
    assert.eq([seen.filter((t) => t === "discovery.progress").length, seen.filter((t) => t === "discovery.finished").length], [expect.length, 1], "в потоке");
    await env.ok("POST", `/units/${did}/discovery`);
    const stopped = await env.ok("DELETE", `/units/${did}/discovery`);
    assert.eq(stopped.state, "stopped", "остановлен");
    assert.status(await env.call("DELETE", "/units/10009999-0000-4000-8000-000000000000/discovery"), 404, "NOT_FOUND");
  }, { needs: ["startDiscovery", "getDiscovery", "stopDiscovery"] });

  test("Поиск в сети: сервер и категория в теле (с 0.36.0) — только сеть сервера и своя категория; чужой сервер — 422", async () => {
    const env = await makeEnv();
    const did = d1.id;
    const own = FX.servers.filter((x) => x.domainId === did).map((x) => x.id);
    const other = FX.servers.find((x) => x.domainId !== did);
    const sees = (c, sid, cat) => c.domainIds.includes(did) && (c.category || "ip") === cat && (!sid || !c.serverIds || c.serverIds.includes(sid));
    // Сервер, который видит не всё: фильтр заметен
    const sid = own.find((s) => { const n = FX.network.filter((c) => sees(c, s, "ip")).length; return n > 0 && n < FX.network.filter((c) => sees(c, null, "ip")).length; });
    const run = async (body) => {
      const res = await env.call("POST", `/units/${did}/discovery`, body);
      assert.status(res, 202);
      return env.until(async () => { const x = await env.ok("GET", `/units/${did}/discovery`); return x.state === "done" && x; }, "поиск закончился");
    };
    if (sid) {
      const byServer = await run({ serverId: sid });
      assert.eq([byServer.serverId, byServer.candidates.map((c) => c.id)], [sid, FX.network.filter((c) => sees(c, sid, "ip")).map((c) => c.id)], "только сеть сервера");
      assert.ok(byServer.candidates.every((c) => c.serverId === sid), "находку видит сервер поиска");
    }
    const cats = [...new Set(FX.network.filter((c) => c.domainIds.includes(did)).map((c) => c.category || "ip"))].filter((c) => c !== "ip");
    for (const cat of cats) {
      const x = await run({ category: cat });
      assert.eq([x.category, x.candidates.map((c) => c.id)], [cat, FX.network.filter((c) => sees(c, null, cat)).map((c) => c.id)], `категория ${cat}`);
      assert.ok(x.candidates.every((c) => c.category === cat), `у находок категория ${cat}`);
    }
    if (other) {
      const foreign = await env.call("POST", `/units/${did}/discovery`, { serverId: other.id });
      assert.status(foreign, 422, "VALIDATION_FAILED", "сервер другой области");
      assert.eq(foreign.body.field, "/serverId", "поле отказа — сервер");
    }
    const badCat = await env.call("POST", `/units/${did}/discovery`, { category: "camera" });
    assert.status(badCat, 422, "VALIDATION_FAILED", "неизвестная категория");
    assert.eq(badCat.body.field, "/category", "поле отказа — категория");
    const extra = await env.call("POST", `/units/${did}/discovery`, { domainId: did });
    assert.status(extra, 422, "VALIDATION_FAILED", "чужое поле");
    const plain = await run(undefined);
    assert.eq([plain.serverId ?? null, plain.category ?? "ip", plain.candidates.map((c) => c.id)], [null, "ip", FX.network.filter((c) => sees(c, null, "ip")).map((c) => c.id)], "без тела — как раньше: все серверы, ip");
  }, { needs: ["startDiscovery", "getDiscovery"] });

  /* ===== Виды, которые находит сервер ===== */

  const kindTest = (kind, name, fn) => test(name, fn, { needs: [`kind:${kind}`, "createUnits", "patchUnit"] });

  kindTest("sensor", "Находки сервера: не создаются и не удаляются, 422 NOT_SUPPORTED, field: /kind", async () => {
    const env = await makeEnv();
    const parent = await ofKind(env, "camera");
    const one = await failedOf(env, { kind: "sensor", name: "Датчик", parentId: parent.uid, properties: { channel: 3 } });
    assert.eq(one, [["NOT_SUPPORTED", "/kind"]], "строкой в failed");
    const nested = await failedOf(env, newCam({}, { children: [{ kind: "mic", name: "Микрофон", properties: {} }] }));
    assert.eq(nested, [["NOT_SUPPORTED", "/children/0/kind"]], "и в children");
    // Шаг createUnit судит выполнение: отказ шага
    const step = await env.runOperation({ idempotencyKey: key(), items: [{ uid: parent.uid, createUnit: { kind: "relay", name: "Реле", properties: {} } }], expectedVersions: {} });
    assert.eq(step.items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "шаг createUnit");
    const s = await ofKind(env, "sensor");
    field(await env.call("DELETE", U(s.uid), undefined, v(s)), "NOT_SUPPORTED", "/kind", "DELETE");
    const bulk = await env.runOperation({ idempotencyKey: key(), items: [{ uid: s.uid, delete: true }], expectedVersions: { [s.uid]: s.version } });
    assert.eq(bulk.items[0].code, "NOT_SUPPORTED", "шагом операции");
  });

  kindTest("sensor", "Находки сервера: правится только то, что не readOnly в схеме и есть в Unit.writable; у вида без полей — отказ", async () => {
    const env = await makeEnv();
    const s = await ofKind(env, "sensor");
    // Поле, которое ведёт сервер, — readOnly схемы вида: VALIDATION_FAILED с keyword
    const bad = await props(env, s, { channel: 9 });
    field(bad, "VALIDATION_FAILED", P("channel"), "номер не правится");
    assert.eq(bad.body.params.keyword, "readOnly", "слово схемы");
    const ok = await env.ok("PATCH", U(s.uid), { name: "Ворота", properties: { enabled: false, norm: "closed" } }, v(s));
    assert.eq([ok.name, ok.properties.enabled, ok.properties.norm], ["Ворота", false, "closed"], "имя, включение, norm");
    const ch = await ofKind(env, "channel");
    field(await patch(env, ch, { name: "x" }), "NOT_SUPPORTED", "/name", "имя канала не правится");
    const st = await ofKind(env, "storage", (u) => u.writable && u.writable.join() === "replication");
    assert.status(await props(env, st, { enabled: false }), 422, null, "у хранилища ничего");
  });

  kindTest("channel", "Канал ввода-вывода: включение правится (enable), номер и имя — нет", async () => {
    const env = await makeEnv();
    const ch = await ofKind(env, "channel");
    assert.ok(!ch.writable || ch.writable.includes("enabled"), "Unit.writable не закрывает enabled");
    const off = await env.ok("PATCH", U(ch.uid), { properties: { enabled: false } }, v(ch));
    assert.eq(off.properties.enabled, false, "канал выключен");
    const on = await env.ok("PATCH", U(ch.uid), { properties: { enabled: true } }, v(off));
    assert.eq(on.properties.enabled, true, "канал включён");
    field(await props(env, on, { channel: 9 }), "VALIDATION_FAILED", P("channel"), "номер не правится");
    field(await patch(env, on, { name: "x" }), "NOT_SUPPORTED", "/name", "имя не правится");
  });

  test("Схемы видов: параметров pulse, debounce, gain, vol, acodec нет; у входа и выхода — norm", async () => {
    const env = await makeEnv();
    const schema = async (kind) => ((await env.ok("GET", `/kinds/${encodeURIComponent(kind)}`)).schema || {}).properties || {};
    const odd = ["pulse", "debounce", "gain", "vol", "acodec"];
    for (const kind of ["sensor", "relay", "mic", "spk"].filter((k) => ApiTest.can(`kind:${k}`))) {
      const p = await schema(kind);
      assert.eq(odd.filter((n) => n in p), [], `${kind}: лишних параметров нет`);
      if (kind === "sensor" || kind === "relay") assert.eq(p.norm.enum, ["open", "closed"], `${kind}: norm`);
    }
    assert.ok(!("deviceParams" in (await env.ok("GET", "/reference"))), "справочника deviceParams нет — параметры в схемах видов");
  }, { needs: ["getKind", "kind:sensor"] });

  kindTest("ipsrv", "ipsrv: с записью устройства создаётся, правится своими полями, DELETE оставляет камеры без родителя", async () => {
    const env = await makeEnv();
    const nvr = await ofKind(env, "ipsrv", (u) => !obs(u).derived && u.properties.subtype === "nvr");
    const cams = (await env.list(`/units?parentId=${nvr.uid}&kind=camera`));
    assert.ok(cams.length > 0, "у регистратора есть камеры");
    const bad = await props(env, nvr, { ip: "10.0.0.1" });
    assert.status(bad, 422, "VALIDATION_FAILED", "адрес не правится");
    assert.eq(bad.body.field, P("ip"), "поле");
    const same = await env.ok("PATCH", U(nvr.uid), { properties: { lat: 55.1, mac: "00:11:22:33:44:66" } }, v(nvr));
    assert.eq([same.properties.lat, same.properties.mac], [55.1, "00:11:22:33:44:66"], "координаты и mac");
    assert.status(await env.call("DELETE", U(nvr.uid), undefined, v(same)), 204);
    assert.eq((await get(env, cams[0].uid)).parentId, null, "камера осталась без родителя");
    assert.status(await env.call("GET", U(nvr.uid)), 404, "NOT_FOUND", "записи нет");
    const [io] = await made(env, { kind: "ipsrv", name: "Блок входов", domainId: nvr.domainId, properties: { subtype: "io", ip: "10.0.0.2", port: 80 } });
    assert.eq(io.kind, "ipsrv", "создаётся");
  });

  kindTest("ipsrv", "ipsrv без записи: PATCH, DELETE, папки — 422 NOT_SUPPORTED", async () => {
    const env = await makeEnv();
    const nvr = await ofKind(env, "ipsrv", (u) => obs(u).derived);
    assert.status(await patch(env, nvr, { name: "x" }), 422, "NOT_SUPPORTED", "PATCH");
    assert.status(await env.call("DELETE", U(nvr.uid), undefined, v(nvr)), 422, "NOT_SUPPORTED", "DELETE");
    const step = await env.runOperation({ idempotencyKey: key(), items: [{ uid: nvr.uid, folders: [] }], expectedVersions: { [nvr.uid]: nvr.version } });
    assert.eq(step.items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "папки");
  });

  kindTest("ipsrv", "Записи появляются и пропадают сами, у камеры меняется родитель", async () => {
    const env = await makeEnv();
    const c = await ofKind(env, "camera", (u) => !u.parentId);
    const res = await env.ok("POST", "/test/events", { type: "device.found", deviceId: c.uid, found: { type: "sensor", name: "Вход 7", channel: 7 } });
    assert.eq((await get(env, res.deviceId)).properties.channel, 7, "запись появилась, номер с пропуском");
    await env.ok("POST", "/test/events", { type: "device.lost", deviceId: res.deviceId });
    assert.status(await env.call("GET", U(res.deviceId)), 404, "NOT_FOUND", "пропала");
    const nvr = await ofKind(env, "ipsrv");
    await env.ok("POST", "/test/events", { type: "device.parent", deviceId: c.uid, parentId: nvr.uid });
    assert.eq((await get(env, c.uid)).parentId, nvr.uid, "родитель сменился");
  });

  test("Адрес камеры: без rtspUrl и без vendor, model — 422, rtspUrl читается и пишется, снять последний адрес нельзя", async () => {
    const env = await makeEnv();
    const row = (name, properties) => ({ kind: "camera", name, domainId: d1.id, properties });
    assert.eq(await failedOf(env, row("Без адреса", { ip: "10.1.1.1", port: 80 })), [["VALIDATION_FAILED", P("rtspUrl")]], "нужен адрес");
    const [c] = await made(env, row("По адресу", { rtspUrl: "rtsp://10.1.1.1/main" }));
    assert.eq(c.properties.rtspUrl, "rtsp://10.1.1.1/main", "адрес в записи");
    field(await props(env, c, { rtspUrl: null }), "VALIDATION_FAILED", P("rtspUrl"), "адрес один, снять нельзя");
    const next = await env.ok("PATCH", U(c.uid), { properties: { rtspUrl: "rtsp://10.1.1.2/main" } }, v(c));
    assert.eq(next.properties.rtspUrl, "rtsp://10.1.1.2/main", "правится");
  }, { needs: ["createUnits", "patchUnit", "kind:camera"] });

  test("MAC камеры — только из поиска: без candidateId не хранится, PATCH — 422", async () => {
    const env = await makeEnv();
    const [c] = await made(env, newCam({ mac: "00:11:22:33:44:77" }));
    assert.eq(c.properties.mac, undefined, "принят и не сохранён");
    // Только при создании — x-immutable схемы вида (у старого пути — NOT_SUPPORTED)
    const bad = await props(env, c, { mac: "00:11:22:33:44:88" });
    field(bad, "VALIDATION_FAILED", P("mac"), "правки нет");
    assert.eq(bad.body.params.keyword, "x-immutable", "слово схемы");
  }, { needs: ["createUnits", "patchUnit", "kind:camera"] });

  /* ===== Потоки, разрешение, живое видео ===== */

  const camWith = async (env, more) => {
    const all = await env.pages("/units?kind=camera&limit=1000");
    for (const c of all) {
      const st = await streamsOf(env, c.uid);
      if (more(c, st)) return [c, st];
    }
    return [null, []];
  };

  test("Потоки: добавить, изменить, удалить; основной — это res и fps камеры; запись ссылается на код потока", async () => {
    const env = await makeEnv();
    const [c, streams] = await camWith(env, (u, st) => st.length >= 2 && u.status.link !== "offline");
    const [st] = await made(env, { kind: "stream", parentId: c.uid, name: "Для облака", properties: { res: "1280x720", fps: 10 } });
    assert.eq([st.name, st.properties.width, st.properties.height, st.properties.fps, st.parentId], ["Для облака", 1280, 720, 10, c.uid], "поток с размером");
    const code = st.properties.streamId;
    const named = await env.ok("PATCH", U(st.uid), { name: "Облако" }, v(st));
    assert.eq(named.name, "Облако", "имя");
    const main = streams[0];
    await env.ok("PATCH", U(main.uid), { properties: { fps: 15 } }, v(main));
    const cam15 = await get(env, c.uid);
    assert.eq(cam15.properties.fps, 15, "основной поток — это fps камеры");
    const again = await env.ok("PATCH", U(c.uid), { properties: { fps: 20 } }, v(cam15));
    assert.eq((await get(env, main.uid)).properties.fps, 20, "и наоборот");
    field(await props(env, again, { stream: "нет-такого" }), "VALIDATION_FAILED", P("stream"), "неизвестный поток");
    const used = await env.ok("PATCH", U(c.uid), { properties: { stream: code } }, v(again));
    field(await env.call("DELETE", U(st.uid), undefined, v(named)), "VALIDATION_FAILED", P("stream"), "по потоку идёт запись");
    await env.ok("PATCH", U(c.uid), { properties: { stream: main.properties.streamId } }, v(used));
    assert.status(await env.call("DELETE", U(st.uid), undefined, v(named)), 204, null, "удалён");
    assert.eq((await streamsOf(env, c.uid)).length, streams.length, "потоков снова столько же");
    const fresh = await get(env, main.uid);
    field(await env.call("DELETE", U(main.uid), undefined, v(fresh)), "NOT_SUPPORTED", P("streamId"), "основной остаётся");
    assert.status(await env.call("DELETE", U("30009999-0000-4000-8000-000000000000"), undefined, v(fresh)), 404, "NOT_FOUND");
    const det = await ofKind(env, "det");
    assert.eq(await failedOf(env, { kind: "stream", parentId: det.uid, name: "x", properties: {} }), [["PARENT_MISMATCH", "/parentId"]], "только у камеры");
    assert.eq(await failedOf(env, { kind: "stream", parentId: c.uid, properties: {} }), [["NAME_REQUIRED", "/name"]], "имя обязательно");
  }, { needs: ["createUnits", "patchUnit", "deleteUnit", "kind:stream"] });

  test("Адрес RTSP у потока (vms.stream/1 1.3): необязательный, хранится и правится; у камеры остаётся свой", async () => {
    const env = await makeEnv();
    const [c, streams] = await camWith(env, (u, st) => u.properties.rtspUrl && st.some((s) => s.properties.rtspUrl));
    const own = streams.find((s) => s.properties.rtspUrl);
    assert.eq(/^rtsp:\/\//.test(own.properties.rtspUrl) && own.properties.rtspUrl !== c.properties.rtspUrl, true, "в наборе у второго потока свой адрес");
    assert.eq(streams[0].properties.rtspUrl, undefined, "у основного поля нет: он идёт по адресу камеры");
    const url = c.properties.rtspUrl.replace(/\d+$/, "103");
    const [st] = await made(env, { kind: "stream", parentId: c.uid, name: "Третий", properties: { rtspUrl: url } });
    assert.eq(st.properties.rtspUrl, url, "адрес при создании");
    const next = await env.ok("PATCH", U(st.uid), { properties: { rtspUrl: url + "?tcp" } }, v(st));
    assert.eq((await get(env, next.uid)).properties.rtspUrl, url + "?tcp", "адрес правится");
    assert.eq((await get(env, c.uid)).properties.rtspUrl, c.properties.rtspUrl, "адрес камеры не меняется");
    assert.status(await env.call("PATCH", U(st.uid), { properties: { rtspUrl: 5 } }, v(next)), 422, "VALIDATION_FAILED", "строка");
  }, { needs: ["createUnits", "patchUnit", "kind:stream"] });

  test("Разрешение: латинская x, из resOptions; нет списка — ввод руками; codec только чтение, у потока откат", async () => {
    const env = await makeEnv();
    const list = await env.pages("/units?kind=camera&limit=1000");
    const c = list.find((u) => u.properties.resOptions);
    assert.status(await props(env, c, { res: "1920×1080" }), 422, "VALIDATION_FAILED", "кириллический знак умножения не проходит");
    assert.status(await props(env, c, { res: "7680x4320" }), 422, "VALIDATION_FAILED", "вне вариантов");
    const bad = await props(env, c, { codec: "H.265" });
    field(bad, "VALIDATION_FAILED", P("codec"), "кодек только чтение");
    const free = list.find((u) => !u.properties.resOptions && u.status.link !== "offline");
    assert.eq((await env.ok("PATCH", U(free.uid), { properties: { res: "1024x768" } }, v(free))).properties.res, "1024x768", "руками");
    const before = (await streamsOf(env, free.uid)).length;
    await made(env, { kind: "stream", parentId: free.uid, name: "Новый", properties: {} });
    const op = (await env.ok("GET", "/operations")).items[0];
    await env.finished((await env.ok("POST", `/operations/${op.id}/revert`)).id);
    assert.eq((await streamsOf(env, free.uid)).length, before, "создание потока откатывается");
  }, { needs: ["createUnits", "patchUnit", "kind:stream"] });

  const kindNo = (res, msg) => field(res, "NOT_SUPPORTED", "/kind", msg);
  const size = { width: 640, height: 360 };

  test("Живое видео: адрес, токен, срок; без связи — 409 DEVICE_OFFLINE; вид без vms.live/1 — 422, field /kind", async () => {
    const env = await makeEnv();
    const list = await env.pages("/units?kind=camera&limit=1000");
    const c = list.find((u) => u.status.link === "online");
    const live = await env.ok("POST", `${U(c.uid)}/live`, size);
    assert.ok(live.whepUrl && live.token && Date.parse(live.expiresAt) > 0, "ответ");
    const off = list.find((u) => u.status.link === "offline");
    assert.status(await env.call("POST", `${U(off.uid)}/live`, size), 409, "DEVICE_OFFLINE");
    const det = await ofKind(env, "det");
    kindNo(await env.call("POST", `${U(det.uid)}/live`, size), "не камера");
    assert.status(await env.call("POST", `${U("30009999-0000-4000-8000-000000000000")}/live`, size), 404, "NOT_FOUND");
  }, { needs: ["startUnitLive", "implements:vms.live/1"] });

  test("Живое видео: сеть, поток, шлюз; раздача для другой сети — 409 с params.labels, переразмещение, срок раздачи", async () => {
    const env = await makeEnv();
    const [c, streams] = await camWith(env, (u, st) => u.status.link === "online" && st.length > 1);
    const local = await env.ok("POST", `${U(c.uid)}/live`, size);
    assert.ok(local.gateway, "шлюз назван");
    assert.ok(!local.whepUrl.includes("stream="), "поток выбирает сервер");
    const second = streams[1].properties.streamId;
    const one = await env.ok("POST", `${U(c.uid)}/live`, Object.assign({ streamId: second, network: "local" }, size));
    assert.ok(one.whepUrl.includes(`stream=${second}`), "выбранный поток");
    field(await env.call("POST", `${U(c.uid)}/live`, Object.assign({ streamId: "нет" }, size)), "VALIDATION_FAILED", "/streamId", "нет такого потока");
    assert.status(await env.call("POST", `${U(c.uid)}/live`, Object.assign({ network: "везде" }, size)), 422, "VALIDATION_FAILED");
    const other = await env.call("POST", `${U(c.uid)}/live`, Object.assign({ network: "outside" }, size));
    assert.status(other, 409, "OTHER_NETWORK");
    assert.eq(other.body.params.labels, [], "метки раздачи");
    assert.status(await env.call("PUT", `${U(c.uid)}/live`, { network: "outside" }), 204);
    assert.ok((await env.ok("POST", `${U(c.uid)}/live`, Object.assign({ network: "outside" }, size))).gateway, "после переразмещения извне");
    const back = await env.call("POST", `${U(c.uid)}/live`, size);
    assert.status(back, 409, "OTHER_NETWORK");
    assert.eq(back.body.params.labels, ["public-address"], "метки раздачи извне");
    if (env.frozen) {
      await env.advance(61);
      await env.ok("POST", `${U(c.uid)}/live`, size);
    }
  }, { needs: ["startUnitLive", "moveUnitLive", "kind:stream"] });

  test("Переразместить: право, без связи, вид без vms.live/1, другой кластер", async () => {
    const list = await (await makeEnv()).pages("/units?kind=camera&limit=1000");
    const c = list.find((u) => u.status.link === "online"), off = list.find((u) => u.status.link === "offline");
    const det = FX.devices.find((d) => d.type === "det");
    const env = await makeEnv({ fixturePatch: { stand: { liveMoveDenied: true } } });
    assert.status(await env.call("PUT", `${U(c.uid)}/live`, { network: "outside" }), 403, "PERMISSION_DENIED");
    const free = await makeEnv({ fixturePatch: { stand: { otherCluster: { [c.uid]: "https://b/backend/" } } } });
    assert.status(await free.call("PUT", `${U(c.uid)}/live`, { network: "outside" }), 409, "OTHER_CLUSTER");
    assert.status(await free.call("PUT", `${U(off.uid)}/live`, { network: "outside" }), 409, "DEVICE_OFFLINE");
    kindNo(await free.call("PUT", `${U(det.id)}/live`, { network: "outside" }), "не камера");
  }, { needs: ["moveUnitLive"] });

  /* ===== Детекторы ===== */

  const optsCam = async (env) => (await env.pages("/units?kind=camera&limit=1000")).find((u) => u.properties.detectorOptions);
  const det = (c, name, properties) => ({ kind: "det", name, parentId: c.uid, properties });
  const addDet = async (env, c, name, properties) => (await made(env, det(c, name, properties)))[0];

  test("Встроенный детектор: шаблон из detectorOptions, без них — 422; чувствительность по диапазону, нет настройки — 422", async () => {
    const env = await makeEnv();
    const c = await optsCam(env);
    assert.eq(await failedOf(env, det(c, "Нет такого", { builtin: true, template: "нет" })), [["VALIDATION_FAILED", P("template")]], "шаблона нет");
    const noOpts = (await env.pages("/units?kind=camera&limit=1000")).find((u) => !u.properties.detectorOptions);
    assert.eq(await failedOf(env, det(noOpts, "Нельзя", { builtin: true })), [["NOT_SUPPORTED", P("builtin")]], "камера не умеет");
    const d = await addDet(env, c, "Лица", { builtin: true, template: "tmpl.face", detectorKind: "other", sensitivity: 50, enabled: false });
    field(await props(env, d, { sensitivity: 95 }), "VALIDATION_FAILED", P("sensitivity"), "вне диапазона");
    const t = (await env.list("/units?kind=det")).find((x) => x.properties.template === "tmpl.tamper");
    field(await props(env, t, { sensitivity: 5 }), "NOT_SUPPORTED", P("sensitivity"), "настройки нет");
  }, { needs: ["createUnits", "patchUnit", "kind:det"] });

  test("Несовместимые детекторы: включение — 409 BUSY с params.reason, шаг операции — fail BUSY", async () => {
    const env = await makeEnv();
    const c = await optsCam(env);
    const t = (await env.list(`/units?parentId=${c.uid}&kind=det`)).find((x) => x.properties.template === "tmpl.tamper") || (await addDet(env, c, "Корпус", { builtin: true, template: "tmpl.tamper", detectorKind: "other" }));
    const face = await addDet(env, c, "Лица", { builtin: true, template: "tmpl.face", detectorKind: "other", enabled: false });
    const res = await props(env, face, { enabled: true });
    field(res, "BUSY", P("enabled"), "вместе нельзя", 409);
    assert.eq([res.body.params.reason, res.body.params.with], ["incompatible", [t.uid]], "причина и с кем (с 0.22.0 — массив)");
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: face.uid, patch: { properties: { enabled: true } } }], expectedVersions: { [face.uid]: face.version } });
    assert.eq([op.items[0].code, op.items[0].params.reason], ["BUSY", "incompatible"], "по шагу");
    const off = await env.ok("PATCH", U(t.uid), { properties: { enabled: false } }, v(t));
    assert.eq(off.properties.enabled, false, "выключили первый");
    assert.eq((await env.ok("PATCH", U(face.uid), { properties: { enabled: true } }, v(face))).properties.enabled, true, "теперь можно");
  }, { needs: ["createUnits", "patchUnit", "kind:det"] });

  // С 0.30.0 несовместимые виды — x-conflicts {значение: [значения]} у свойства analyticsKind вида (расширение vms.detector/1);
  // reference.analyticsConflicts снят в 0.32.0. Связь двусторонняя: у всех видов детектора — те же пары без порядка
  test("Несовместимые детекторы: x-conflicts у analyticsKind — значения analyticsKind, у видов детектора те же пары", async () => {
    const env = await makeEnv();
    const pairs = (list) => [...new Set(list.flatMap(([a, cs]) => cs.map((b) => [a, b].sort().join("|"))))].sort();
    const dets = (await env.ok("GET", "/kinds")).items.filter((k) => (k.implements || []).includes("vms.detector/1"));
    let want = null;
    for (const k of dets) {
      const ak = k.schema.properties.analyticsKind;
      if (!ak || !ak["x-conflicts"]) continue;
      const xc = ak["x-conflicts"];
      if (want === null) want = pairs(Object.entries(xc));
      assert.eq(pairs(Object.entries(xc)), want, `${k.kind}: x-conflicts — те же пары`);
      Object.entries(xc).forEach(([a, cs]) => [a, ...cs].forEach((x) => assert.ok(ak.enum.includes(x), `${k.kind}: ${x} — значение analyticsKind`)));
    }
    // x-conflicts необязательно: система без несовместимых видов (набор one-domain) его не объявляет. Тест тогда ничего
    // не проверяет и говорит об этом в строке PASS
    if (want === null) return `x-conflicts нет ни у одного из ${dets.length} видов детектора — проверять нечего`;
    assert.ok(want.length > 0, "x-conflicts объявлено — в нём есть пары");
    return `пар ${want.length}`;
  }, { needs: ["listKinds", "implements:vms.detector/1"] });

  test("Несовместимые виды серверных детекторов (с 0.21.0): x-conflicts у analyticsKind; на одном сервере — 409 BUSY, params.with — массив; на другом сервере — можно", async () => {
    const env = await makeEnv();
    const xc = (((await env.ok("GET", "/kinds/det")).schema.properties.analyticsKind || {})["x-conflicts"]) || {};
    assert.ok((xc.faceTV || []).includes("faceVA") || (xc.faceVA || []).includes("faceTV"), "лица TV и VA — в x-conflicts");
    const FACE = ["faceTV", "faceVA", "faceVL"];
    // Чистый стенд: включённые детекторы лиц из набора выключены
    for (const d of (await env.pages("/units?kind=det&limit=1000")).filter((u) => FACE.includes(u.properties.analyticsKind) && u.properties.enabled !== false)) {
      await env.ok("PATCH", U(d.uid), { properties: { enabled: false } }, v(d));
    }
    const up = new Set(FX.servers.filter((x) => x.allocated && x.online).map((x) => x.id));
    const cams = (await env.pages("/units?kind=camera&limit=1000")).filter((u) => up.has(u.properties.serverId) && u.status.link === "online");
    const a = cams[0], same = cams.find((u) => u !== a && u.properties.serverId === a.properties.serverId), other = cams.find((u) => u.properties.serverId !== a.properties.serverId);
    assert.ok(same && other, "две камеры одного сервера и камера другого");
    const face = (ak, extra) => Object.assign({ detectorKind: "other", analyticsKind: ak }, extra);
    const va = await addDet(env, a, "Лица VA", face("faceVA"));
    // Создание включённого рядом с включённым несовместимым
    const res = await create(env, det(same, "Лица TV", face("faceTV")));
    assert.eq(res.failed.map((x) => [x.code, x.field]), [["BUSY", P("analyticsKind")]], "создать нельзя");
    assert.eq([res.failed[0].params.reason, res.failed[0].params.with], ["incompatible", [va.uid]], "причина и кто мешает");
    // Выключенный создаётся, включить нельзя: запрос и шаг операции
    const tvOff = await addDet(env, same, "Лица TV", face("faceTV", { enabled: false }));
    const on = await props(env, tvOff, { enabled: true });
    field(on, "BUSY", P("enabled"), "включить нельзя", 409);
    assert.eq([on.body.params.reason, on.body.params.with], ["incompatible", [va.uid]], "включение: причина и кто мешает");
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: tvOff.uid, patch: { properties: { enabled: true } } }], expectedVersions: { [tvOff.uid]: tvOff.version } });
    assert.eq([op.items[0].code, op.items[0].params.reason, op.items[0].params.with], ["BUSY", "incompatible", [va.uid]], "по шагу");
    // Смена вида включённого детектора на несовместимый
    const meta = await addDet(env, same, "Мета", face("meta"));
    field(await props(env, meta, { analyticsKind: "faceVL" }), "BUSY", P("analyticsKind"), "сменить вид нельзя", 409);
    // Новая камера с детектором в той же строке: сервер — serverId камеры
    const kid = (ak) => ({ kind: "det", name: "Лица", properties: face(ak) });
    const fresh = await create(env, newCam({ ip: "10.9.9.31", serverId: a.properties.serverId }, { children: [kid("faceTV")] }));
    assert.eq([fresh.failed.map((x) => x.code), (fresh.failed[0] || {}).params], [["BUSY"], { reason: "incompatible", with: [va.uid] }], "новая камера того же сервера: детектор лиц TV не заводится");
    // Два несовместимых детектора в одной строке новой камеры: второй не заводится, with пуст — у соседа ещё нет uid
    const pair = await create(env, newCam({ ip: "10.9.9.32", serverId: other.properties.serverId }, { children: [kid("faceVL"), kid("faceTV")] }));
    assert.eq([pair.failed.map((x) => x.code), ((pair.failed[0] || {}).params || {}).with], [["BUSY"], []], "два пакета в одной строке");
    // На другом сервере пакет свой
    const far = await addDet(env, other, "Лица TV", face("faceTV"));
    assert.eq(far.properties.enabled !== false, true, "на другом сервере — можно");
    // Перенос камеры на сервер, где работает другой пакет
    const moved = await props(env, other, { serverId: a.properties.serverId });
    field(moved, "BUSY", P("serverId"), "камеру с детектором лиц TV не перенести к детектору лиц VA", 409);
    assert.eq(moved.body.params.with, [va.uid], "перенос: кто мешает");
    // Выключили мешающий — теперь можно
    await env.ok("PATCH", U(va.uid), { properties: { enabled: false } }, v(va));
    assert.eq((await env.ok("PATCH", U(tvOff.uid), { properties: { enabled: true } }, v(tvOff))).properties.enabled, true, "мешающий выключен — включили");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "prop:det.analyticsKind"] });

  test("Зона: rect, polygon, line в долях кадра, неверная — 422 field: /properties/zone; два детектора одного вида; stream и params серверного", async () => {
    const env = await makeEnv();
    const c = await optsCam(env);
    const [main] = await streamsOf(env, c.uid);
    const a = await addDet(env, c, "Линия 1", { detectorKind: "linecross", zone: { shape: "line", points: [[0.1, 0.1], [0.9, 0.9]] } });
    const b = await addDet(env, c, "Линия 2", Object.assign({ detectorKind: "linecross", params: "a=1" }, main ? { stream: main.properties.streamId } : {}));
    assert.eq([a.properties.zone.shape, b.properties.params], ["line", "a=1"], "две записи одного вида, у каждой своё");
    field(await props(env, a, { zone: { shape: "polygon", points: [[0, 0], [1, 1]] } }), "VALIDATION_FAILED", P("zone"), "мало точек");
    // Точка за кадром — отказ схемы вида: указатель ведёт внутрь зоны
    const out = await props(env, a, { zone: { shape: "line", points: [[0, 0], [1.2, 1]] } });
    assert.status(out, 422, "VALIDATION_FAILED", "за кадром");
    assert.ok(String(out.body.field).startsWith(P("zone")), `за кадром: поле ${out.body.field}`);
    const z = await env.ok("PATCH", U(a.uid), { properties: { zone: { shape: "rect", points: [[0.2, 0.2], [0.4, 0.4]] } } }, v(a));
    assert.eq(z.properties.zone.shape, "rect", "сохранена");
    assert.eq((await env.ok("PATCH", U(a.uid), { properties: { zone: null } }, v(z))).properties.zone, undefined, "сброшена");
  }, { needs: ["createUnits", "patchUnit", "kind:det"] });

  /* ===== Настройки детектора и поддетекторы (контракт 0.12.0) ===== */

  const camU = { uid: cam && cam.id };
  const NEW_DET = ["analyticsKind", "extraZones", "direction", "objectSize", "classes", "confidence", "minDurationSec", "plateWidth", "crowdMin", "crowdHoldSec", "stillSec"];
  const TRI = [[0.2, 0.2], [0.5, 0.2], [0.5, 0.5]];
  const tracker = (c, name, over) => det(c, name || "Трекер", Object.assign({ detectorKind: "other", analyticsKind: "tracker", sensitivity: 60 }, over));
  const sub = (parent, kind, over, name) => ({ kind: "subdet", name: name || `Поддетектор ${kind}`, parentId: parent.uid,
    properties: Object.assign({ subdetectorKind: kind, zone: { shape: kind === "line" ? "line" : "polygon", points: kind === "line" ? [[0.1, 0.1], [0.9, 0.9]] : TRI } }, over) });
  const addSub = async (env, parent, kind, over, name) => (await made(env, sub(parent, kind, over, name)))[0];
  const kidsOf = (env, uid) => env.list(`/units?parentId=${uid}&kind=subdet`);

  test("Детектор без полей 0.12.0 — как раньше: новых ключей нет, чувствительность и зона правятся", async () => {
    const env = await makeEnv();
    const d = await addDet(env, camU, "Старый клиент", { detectorKind: "motion", sensitivity: 10 });
    assert.eq(NEW_DET.filter((n) => n in d.properties), [], "новых свойств в ответе нет");
    const s = await env.ok("PATCH", U(d.uid), { properties: { sensitivity: 20 } }, v(d));
    const z = await env.ok("PATCH", U(d.uid), { properties: { zone: { shape: "rect", points: [[0.1, 0.1], [0.6, 0.6]] } } }, v(s));
    assert.eq([z.properties.sensitivity, z.properties.zone.shape, NEW_DET.filter((n) => n in z.properties)], [20, "rect", []], "правка как раньше");
    const again = await get(env, d.uid);
    assert.eq(NEW_DET.filter((n) => n in again.properties), [], "и после правки");
  }, { needs: ["createUnits", "patchUnit", "kind:det"] });

  // kind:subdet в needs — знак, что сервер знает 0.12.0: без него этих свойств det нет, и тест пропускается
  test("objectSize, plateWidth: min выше max — 422 /properties/<имя>/min, reason minAboveMax; верные сохраняются; null снимает", async () => {
    const env = await makeEnv();
    const d = await addDet(env, camU, "Размеры", { detectorKind: "lpr", sensitivity: 10 });
    const bad = await props(env, d, { objectSize: { min: [0.5, 0.1], max: [0.2, 0.9] } });
    field(bad, "VALIDATION_FAILED", P("objectSize/min"), "ширина min выше max");
    assert.eq(bad.body.params.reason, "minAboveMax", "причина");
    field(await props(env, d, { objectSize: { min: [0.1, 0.5], max: [0.9, 0.2] } }), "VALIDATION_FAILED", P("objectSize/min"), "высота min выше max");
    const pw = await props(env, d, { plateWidth: { min: 0.3, max: 0.1 } });
    field(pw, "VALIDATION_FAILED", P("plateWidth/min"), "номер: min выше max");
    assert.eq(pw.body.params.reason, "minAboveMax", "причина у номера");
    const ok = await env.ok("PATCH", U(d.uid), { properties: { objectSize: { min: [0.05, 0.1], max: [0.5, 0.6] }, plateWidth: { min: 0.1, max: 0.3 } } }, v(d));
    assert.eq([ok.properties.objectSize, ok.properties.plateWidth], [{ min: [0.05, 0.1], max: [0.5, 0.6] }, { min: 0.1, max: 0.3 }], "верные сохранены");
    // Merge Patch: судится запись целиком, а не кусок
    field(await props(env, ok, { objectSize: { max: [0.01, 0.6] } }), "VALIDATION_FAILED", P("objectSize/min"), "max ниже сохранённого min");
    const half = await env.ok("PATCH", U(d.uid), { properties: { objectSize: { min: null } } }, v(ok));
    assert.eq(half.properties.objectSize, { max: [0.5, 0.6] }, "часть снята: без ограничения снизу");
    const gone = await env.ok("PATCH", U(d.uid), { properties: { objectSize: null, plateWidth: null } }, v(half));
    assert.eq(["objectSize" in gone.properties, "plateWidth" in gone.properties], [false, false], "null снимает");
    assert.eq(await failedOf(env, det(camU, "Новый", { detectorKind: "motion", objectSize: { min: [0.9, 0.9], max: [0.1, 0.1] } })), [["VALIDATION_FAILED", P("objectSize/min")]], "и при создании");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "kind:subdet"] });

  // kind:subdet в needs — знак, что сервер знает 0.12.0: без него этих свойств det нет, и тест пропускается
  test("extraZones: in и ex сохраняются, zone не меняется; две точки — 422 /properties/extraZones/0/points; null снимает", async () => {
    const env = await makeEnv();
    const zone = { shape: "polygon", points: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] };
    const d = await addDet(env, camU, "Зоны", { detectorKind: "motion", sensitivity: 10, zone });
    const extra = [{ type: "in", points: TRI }, { type: "ex", points: [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]] }];
    const ok = await env.ok("PATCH", U(d.uid), { properties: { extraZones: extra } }, v(d));
    assert.eq([ok.properties.extraZones, ok.properties.zone], [extra, zone], "добавочные сохранены, zone прежняя");
    const short = await props(env, ok, { extraZones: [{ type: "ex", points: [[0.1, 0.1], [0.2, 0.2]] }] });
    field(short, "VALIDATION_FAILED", P("extraZones/0/points"), "две точки");
    assert.eq(short.body.params.keyword, "minItems", "слово схемы");
    field(await props(env, ok, { extraZones: [{ type: "in", points: TRI }, { type: "x", points: TRI }] }), "VALIDATION_FAILED", P("extraZones/1/type"), "тип зоны");
    field(await props(env, ok, { extraZones: [{ type: "in", points: [[0, 0], [1.5, 0], [1, 1]] }] }), "VALIDATION_FAILED", P("extraZones/0/points/1/0"), "точка за кадром");
    const same = await get(env, d.uid);
    assert.eq(same.properties.extraZones, extra, "отказ ничего не менял");
    const gone = await env.ok("PATCH", U(d.uid), { properties: { extraZones: null, zone: null } }, v(same));
    assert.eq(["extraZones" in gone.properties, "zone" in gone.properties], [false, false], "обе сняты: вся картинка");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "kind:subdet"] });

  // kind:subdet в needs — знак, что сервер знает 0.12.0: без него этих свойств det нет, и тест пропускается
  test("direction, classes, confidence, minDurationSec, crowdMin, crowdHoldSec, stillSec: вне допустимого — 422 со словом схемы; верные сохраняются", async () => {
    const env = await makeEnv();
    const d = await addDet(env, camU, "Настройки", { detectorKind: "motion", sensitivity: 10 });
    const bad = [
      [{ direction: "up" }, "direction", "enum"], [{ classes: ["tank"] }, "classes/0", "enum"],
      [{ confidence: 9 }, "confidence", "minimum"], [{ confidence: 100 }, "confidence", "maximum"],
      [{ minDurationSec: 31 }, "minDurationSec", "maximum"], [{ minDurationSec: -1 }, "minDurationSec", "minimum"],
      [{ crowdMin: 1 }, "crowdMin", "minimum"], [{ crowdMin: 51 }, "crowdMin", "maximum"],
      [{ crowdHoldSec: 0 }, "crowdHoldSec", "minimum"], [{ crowdHoldSec: 601 }, "crowdHoldSec", "maximum"],
      [{ stillSec: 4 }, "stillSec", "minimum"], [{ stillSec: 1801 }, "stillSec", "maximum"],
    ];
    for (const [p, name, keyword] of bad) {
      const res = await props(env, d, p);
      field(res, "VALIDATION_FAILED", P(name), JSON.stringify(p));
      assert.eq(res.body.params.keyword, keyword, `${JSON.stringify(p)}: слово схемы`);
    }
    const good = { direction: "ba", classes: ["person", "car", "bike"], confidence: 99, minDurationSec: 30, crowdMin: 50, crowdHoldSec: 600, stillSec: 5 };
    const ok = await env.ok("PATCH", U(d.uid), { properties: good }, v(d));
    assert.eq(Object.keys(good).map((n) => ok.properties[n]), Object.values(good), "верные сохранены");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "kind:subdet"] });

  // prop:det.recordTracks в needs — знак, что сервер знает 0.13.0: без него этих свойств det нет, и тест пропускается
  test("recordMask, recordTracks, showMask, showTracks, showTrackLifespan (0.13.0): нет поля — нет ключа; true и false сохраняются; не boolean — 422 type; null снимает", async () => {
    const env = await makeEnv();
    const REC = ["recordMask", "recordTracks", "showMask", "showTracks", "showTrackLifespan"];
    const d = await addDet(env, camU, "Запись и показ", { detectorKind: "motion", sensitivity: 10 });
    assert.eq(REC.filter((n) => n in d.properties), [], "без полей — ключей нет: действуют умолчания");
    for (const n of REC) {
      const res = await props(env, d, { [n]: "yes" });
      field(res, "VALIDATION_FAILED", P(n), `${n}: строка`);
      assert.eq(res.body.params.keyword, "type", `${n}: слово схемы`);
    }
    const good = { recordMask: false, recordTracks: false, showMask: false, showTracks: true, showTrackLifespan: true };
    const ok = await env.ok("PATCH", U(d.uid), { properties: good }, v(d));
    assert.eq(REC.map((n) => ok.properties[n]), REC.map((n) => good[n]), "сохранены");
    const again = await get(env, d.uid);
    assert.eq(REC.map((n) => again.properties[n]), REC.map((n) => good[n]), "и при чтении");
    const gone = await env.ok("PATCH", U(d.uid), { properties: Object.fromEntries(REC.map((n) => [n, null])) }, v(again));
    assert.eq(REC.filter((n) => n in gone.properties), [], "null снимает: снова умолчания");
    const tr = await addDet(env, camU, "Трекер с записью", { detectorKind: "other", analyticsKind: "tracker", sensitivity: 60, recordTracks: false, showTracks: true });
    assert.eq([tr.properties.recordTracks, tr.properties.showTracks], [false, true], "и при создании");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "prop:det.recordTracks"] });

  // kind:subdet в needs — знак, что сервер знает 0.12.0: без него этих свойств det нет, и тест пропускается
  test("analyticsKind: только при detectorKind other — иначе 422; detectorKind: motion у трекера проходит, поле остаётся без действия", async () => {
    const env = await makeEnv();
    assert.eq(await failedOf(env, tracker(camU, "Не other", { detectorKind: "linecross" })), [["VALIDATION_FAILED", P("analyticsKind")]], "при создании: field");
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker", sensitivity: 60 });
    assert.eq([t.properties.detectorKind, t.properties.analyticsKind], ["other", "tracker"], "трекер создан");
    const m = await env.ok("PATCH", U(t.uid), { properties: { detectorKind: "motion" } }, v(t));
    assert.eq([m.properties.detectorKind, m.properties.analyticsKind], ["motion", "tracker"], "старый клиент сменил вид: поле не тронуто");
    field(await props(env, m, { analyticsKind: "neural" }), "VALIDATION_FAILED", P("analyticsKind"), "задать при motion — отказ");
    const back = await env.ok("PATCH", U(t.uid), { properties: { detectorKind: "other", analyticsKind: "neural" } }, v(m));
    assert.eq(back.properties.analyticsKind, "neural", "вид и поле вместе");
    const off = await env.ok("PATCH", U(t.uid), { properties: { detectorKind: "motion", analyticsKind: null } }, v(back));
    assert.eq(["analyticsKind" in off.properties, off.properties.detectorKind], [false, "motion"], "новый клиент снимает поле вместе с видом");
    field(await props(env, off, { analyticsKind: "robot" }), "VALIDATION_FAILED", P("analyticsKind"), "незнакомый код — отказ схемы");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "kind:subdet"] });

  // С 0.40.0 (vms.detector/1 1.3): серверные семейства Axxon One — значения analyticsKind; x-events {значение: [коды событий камеры]}
  // у свойства analyticsKind говорит, какие события камеры поднимает детектор этого вида сверх other (пункты C5, F209, F210, F223)
  const FAMILIES = ["neuralCounter", "pose", "ppe", "fight", "fireSmoke", "audio", "queue", "waterLevel", "barcode", "heatmap", "sceneChange", "unattendedMoney", "floatingObjects", "operatorControl"];
  test("analyticsKind: семейства серверных детекторов (с 0.40.0) — значение с подписью, x-events называет события камеры; детектор каждого семейства создаётся", async () => {
    const env = await makeEnv();
    const ak = (await env.ok("GET", "/kinds/det")).schema.properties.analyticsKind;
    const camEv = new Set((await env.ok("GET", "/kinds/camera")).events.map((e) => e.id));
    const xe = ak["x-events"] || {};
    for (const f of FAMILIES) {
      assert.ok(ak.enum.includes(f), `${f} — значение analyticsKind`);
      assert.ok(ak["x-enum-labels"] && ak["x-enum-labels"][f] && ak["x-enum-labels"][f].text, `${f} — подпись`);
    }
    Object.entries(xe).forEach(([a, evs]) => {
      assert.ok(ak.enum.includes(a), `x-events: ${a} — значение analyticsKind`);
      evs.forEach((e) => assert.ok(camEv.has(e), `x-events ${a}: ${e} — событие вида camera`));
    });
    assert.eq(xe.fireSmoke, ["fire", "smoke"], "дым и огонь — два события");
    assert.eq(xe.sceneChange, ["tamper"], "изменение сцены — tamper");
    for (const f of FAMILIES) {
      const d = await addDet(env, camU, `Семейство ${f}`, { detectorKind: "other", analyticsKind: f });
      assert.eq([d.properties.detectorKind, d.properties.analyticsKind], ["other", f], `${f}: детектор создан`);
    }
    return `семейств ${FAMILIES.length}, с событиями ${Object.values(xe).filter((e) => e.length).length}`;
  }, { needs: ["createUnits", "kind:det", "kind:camera", "prop:det.analyticsKind"], layer: "profile:vms.detector/1", since: "1.3" });

  test("analyticsKind: событие детектора семейства (с 0.40.0) — коды из x-events и other проходят, чужой код — 422 field eventId; match.detector пишет сервер", async () => {
    const env = await makeEnv();
    const ev = (deviceId, eventId) => env.call("POST", "/test/events", Object.assign({ type: "unit.event", deviceId, match: {} }, eventId ? { eventId } : {}));
    const fs = await addDet(env, camU, "Дым и огонь", { detectorKind: "other", analyticsKind: "fireSmoke" });
    for (const id of ["fire", "smoke", "other", null]) assert.status(await ev(fs.uid, id), 200, null, `fireSmoke: ${id || "без eventId"}`);
    const bad = await ev(fs.uid, "pose");
    assert.status(bad, 422, "VALIDATION_FAILED", "fireSmoke не поднимает pose");
    assert.eq(bad.body.field, "eventId", "field — eventId");
    const tr = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    assert.status(await ev(tr.uid, "fire"), 422, "VALIDATION_FAILED", "у трекера x-events нет — fire не проходит, как раньше");
    const mo = await addDet(env, camU, "Движение", { detectorKind: "motion", analyticsKind: undefined });
    assert.status(await ev(mo.uid, "fire"), 422, "VALIDATION_FAILED", "детектор не other — x-events не действует");
    const hm = await addDet(env, camU, "Тепловая карта", { detectorKind: "other", analyticsKind: "heatmap" });
    assert.status(await ev(hm.uid, null), 200, null, "heatmap: без eventId — other");
    assert.status(await ev(hm.uid, "fire"), 422, "VALIDATION_FAILED", "heatmap: пустая строка x-events — только other");
  }, { needs: ["createUnits", "kind:det", "kind:camera", "prop:det.analyticsKind", "testEvent"], layer: "profile:vms.detector/1", since: "1.3" });

  test("Поддетектор: под трекером и движением — создан, entity.created kind subdet; под другим видом — 422 NOT_SUPPORTED /parentId; abandoned только под трекером", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const n = await addDet(env, camU, "Нейро", { detectorKind: "other", analyticsKind: "neural" });
    const mo = await addDet(env, camU, "Движение", { detectorKind: "motion" });
    const lc = await addDet(env, camU, "Линия", { detectorKind: "linecross" });
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.type === "entity.created" && seen.push([m.kind, m.entityId]), [cam.id, t.uid]);
    await ApiTest.settle();
    const s = await addSub(env, t, "dwell", { timeSec: 20 }, "Долго");
    await ApiTest.settle();
    stop();
    assert.eq([s.kind, s.parentId, s.domainId, s.name, s.properties.subdetectorKind], ["subdet", t.uid, d1.id, "Долго", "dwell"], "поддетектор под трекером");
    assert.ok(seen.some(([k, id]) => k === "subdet" && id === s.uid), "entity.created с видом subdet");
    assert.eq((await kidsOf(env, t.uid)).map((x) => x.uid), [s.uid], "виден по parentId");
    await addSub(env, n, "enter");
    await addSub(env, mo, "exit");
    for (const host of [lc, await addDet(env, camU, "Обычный", { detectorKind: "other" })]) {
      const res = await create(env, sub(host, "enter"));
      assert.eq(res.failed.map((x) => [x.code, x.field, x.params.reason]), [["NOT_SUPPORTED", "/parentId", "noSubdetectors"]], `под ${host.properties.detectorKind}`);
    }
    assert.eq(await failedOf(env, sub(n, "abandoned", { timeSec: 30 })), [["NOT_SUPPORTED", P("subdetectorKind")]], "abandoned под нейросетевым");
    assert.eq(await failedOf(env, sub(mo, "abandoned", { timeSec: 30 })), [["NOT_SUPPORTED", P("subdetectorKind")]], "abandoned под движением");
    await addSub(env, t, "abandoned", { timeSec: 30 });
    // Родитель из той же строки POST /units судится по его свойствам
    const rows = await create(env, Object.assign(det(camU, "Новый трекер", { detectorKind: "other", analyticsKind: "tracker" }), { children: [{ kind: "subdet", name: "Сразу", properties: sub(t, "stop", { timeSec: 5 }).properties }] }));
    assert.eq(rows.failed.map((x) => [x.code, x.field]), [], "дочерняя строка под новым трекером");
    const bad = await create(env, Object.assign(det(camU, "Новая линия", { detectorKind: "linecross" }), { children: [{ kind: "subdet", properties: sub(t, "enter").properties }] }));
    assert.eq(bad.failed.map((x) => [x.code, x.field]), [["NOT_SUPPORTED", "/children/0/parentId"]], "и под новой линией — отказ");
  }, { needs: ["createUnits", "kind:det", "kind:subdet"] });

  // С 0.40.0 (vms.subdetector/1 1.1, пункт F223): контроль оператора принимает только dwell, enter, line; GET /units/{uid}/creatable
  // у детектора отдаёт схему вида subdet с subdetectorKind, суженным под этот детектор
  test("Поддетектор: контроль оператора (с 0.40.0) — dwell, enter, line созданы, другой вид — 422 NOT_SUPPORTED /properties/subdetectorKind; creatable сужает subdetectorKind", async () => {
    const env = await makeEnv();
    const oc = await addDet(env, camU, "Контроль оператора", { detectorKind: "other", analyticsKind: "operatorControl" });
    for (const k of ["dwell", "enter", "line"]) {
      const s = await addSub(env, oc, k, k === "dwell" ? { timeSec: 20 } : {});
      assert.eq([s.parentId, s.properties.subdetectorKind], [oc.uid, k], `${k} под контролем оператора`);
    }
    const res = await create(env, sub(oc, "stop", { timeSec: 5 }));
    assert.eq(res.failed.map((x) => [x.code, x.field]), [["NOT_SUPPORTED", P("subdetectorKind")]], "stop — отказ");
    const kindsUnder = async (u) => {
      const row = (await env.ok("GET", `/units/${u.uid}/creatable`)).items.find((x) => x.kind === "subdet") || {};
      return row.schema?.properties?.subdetectorKind?.enum;
    };
    assert.eq(await kindsUnder(oc), ["line", "enter", "dwell"], "creatable: только допустимые, в порядке схемы вида");
    const tr = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const mo = await addDet(env, camU, "Движение", { detectorKind: "motion" });
    const all = (await env.ok("GET", "/kinds/subdet")).schema.properties.subdetectorKind.enum;
    assert.eq(await kindsUnder(tr), all, "трекер — все виды");
    assert.eq(await kindsUnder(mo), all.filter((k) => k !== "abandoned"), "движение — все, кроме abandoned");
    const ne = await addDet(env, camU, "Нейро", { detectorKind: "other", analyticsKind: "neural" });
    assert.eq(await kindsUnder(ne), all.filter((k) => k !== "abandoned"), "нейросетевой трекер — все, кроме abandoned");
    const under = (await env.ok("GET", `/units/${cam.id}/creatable`)).items;
    assert.ok(under.every((x) => !("schema" in x)), "под камерой схему не сужают");
  }, { needs: ["createUnits", "getCreatable", "kind:det", "kind:subdet", "prop:det.analyticsKind"], layer: "profile:vms.subdetector/1", since: "1.1" });

  // С профиля vms.subdetector/1 1.2 (пункт F122): поддетекторы принимают номера, позы, СИЗ и штрихкод — все виды, кроме abandoned;
  // детекторы лиц — только line, enter, dwell. creatable сужает subdetectorKind под каждым
  test("Поддетектор: номера, позы, СИЗ, штрихкод и лица (с профиля 1.2) — созданы; у лиц только line, enter, dwell, другой вид — 422 NOT_SUPPORTED /properties/subdetectorKind; creatable сужает subdetectorKind", async () => {
    const env = await makeEnv();
    const kindsUnder = async (u) => {
      const row = (await env.ok("GET", `/units/${u.uid}/creatable`)).items.find((x) => x.kind === "subdet") || {};
      return row.schema?.properties?.subdetectorKind?.enum;
    };
    const all = (await env.ok("GET", "/kinds/subdet")).schema.properties.subdetectorKind.enum;
    const full = [["Номера", { detectorKind: "lpr" }], ["Позы", { detectorKind: "other", analyticsKind: "pose" }],
      ["СИЗ", { detectorKind: "other", analyticsKind: "ppe" }], ["Штрихкод", { detectorKind: "other", analyticsKind: "barcode" }]];
    for (const [name, p] of full) {
      const d = await addDet(env, camU, name, p);
      const s = await addSub(env, d, "stop", { timeSec: 5 });
      assert.eq([s.parentId, s.properties.subdetectorKind], [d.uid, "stop"], `stop под «${name}»`);
      assert.eq(await kindsUnder(d), all.filter((k) => k !== "abandoned"), `«${name}»: все виды, кроме abandoned`);
      assert.eq(await failedOf(env, sub(d, "abandoned", { timeSec: 30 })), [["NOT_SUPPORTED", P("subdetectorKind")]], `abandoned под «${name}»`);
    }
    for (const ak of ["faceTV", "faceVA", "faceVL"]) {
      const env2 = await makeEnv();
      // Выключен: на сервере набора уже есть детектор лиц, а виды лиц несовместимы (x-conflicts)
      const f = await addDet(env2, camU, "Лица", { detectorKind: "other", analyticsKind: ak, enabled: false });
      for (const k of ["line", "enter", "dwell"]) {
        const s = await addSub(env2, f, k, k === "dwell" ? { timeSec: 20 } : {});
        assert.eq([s.parentId, s.properties.subdetectorKind], [f.uid, k], `${k} под ${ak}`);
      }
      const res = await create(env2, sub(f, "exit"));
      assert.eq(res.failed.map((x) => [x.code, x.field]), [["NOT_SUPPORTED", P("subdetectorKind")]], `exit под ${ak} — отказ`);
      assert.eq(await kindsUnder(f), ["line", "enter", "dwell"], `creatable под ${ak}: только допустимые, в порядке схемы вида`);
    }
    const fight = await addDet(env, camU, "Драка", { detectorKind: "other", analyticsKind: "fight" });
    const res = await create(env, sub(fight, "enter"));
    assert.eq(res.failed.map((x) => [x.code, x.field, x.params.reason]), [["NOT_SUPPORTED", "/parentId", "noSubdetectors"]], "драка поддетекторов не принимает, как раньше");
    const row = (await env.ok("GET", `/units/${fight.uid}/creatable`)).items.find((x) => x.kind === "subdet");
    assert.eq(row && [row.allowed, row.reason], [false, "NOT_SUPPORTED"], "creatable под дракой: subdet — allowed false, NOT_SUPPORTED");
  }, { needs: ["createUnits", "getCreatable", "kind:det", "kind:subdet", "prop:det.analyticsKind"], layer: "profile:vms.subdetector/1", since: "1.2" });

  // С профиля vms.subdetector/1 1.3 (vms.detector/1 1.7, пункт F122): трекер людей (humanTracker, Human tracker VL в Axxon One) —
  // значение analyticsKind с подписью, событий сверх other нет; принимает все виды поддетектора, кроме abandoned
  test("Поддетектор: трекер людей (с 1.3) — значение analyticsKind humanTracker с подписью, x-events пуст; stop создан, abandoned — 422, creatable — все виды, кроме abandoned", async () => {
    const env = await makeEnv();
    const ak = (await env.ok("GET", "/kinds/det")).schema.properties.analyticsKind;
    assert.ok(ak.enum.includes("humanTracker") && ak["x-enum-labels"]?.humanTracker?.text, "humanTracker — значение с подписью");
    assert.eq((ak["x-events"] || {}).humanTracker || [], [], "событий сверх other нет");
    const h = await addDet(env, camU, "Трекер людей", { detectorKind: "other", analyticsKind: "humanTracker" });
    const s = await addSub(env, h, "stop", { timeSec: 5 });
    assert.eq([s.parentId, s.properties.subdetectorKind], [h.uid, "stop"], "stop под трекером людей");
    assert.eq(await failedOf(env, sub(h, "abandoned", { timeSec: 30 })), [["NOT_SUPPORTED", P("subdetectorKind")]], "abandoned под трекером людей");
    const all = (await env.ok("GET", "/kinds/subdet")).schema.properties.subdetectorKind.enum;
    const row = (await env.ok("GET", `/units/${h.uid}/creatable`)).items.find((x) => x.kind === "subdet") || {};
    assert.eq(row.schema?.properties?.subdetectorKind?.enum, all.filter((k) => k !== "abandoned"), "creatable: все виды, кроме abandoned");
  }, { needs: ["createUnits", "getCreatable", "kind:det", "kind:subdet", "prop:det.analyticsKind"], layer: "profile:vms.subdetector/1", since: "1.3" });

  test("Поддетектор: вид родителя сменили после создания — поддетектор правится; правило родителя — только при создании и при subdetectorKind в правке", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const ab = await addSub(env, t, "abandoned", { timeSec: 30 }, "Сумка");
    const en = await addSub(env, t, "enter", {}, "Вход");
    // Старый клиент сменил вид: трекер стал движением, потом линией
    const m = await env.ok("PATCH", U(t.uid), { properties: { detectorKind: "motion" } }, v(t));
    const ab2 = await env.ok("PATCH", U(ab.uid), { properties: { timeSec: 45 } }, v(ab));
    assert.eq(ab2.properties.timeSec, 45, "abandoned под движением: правка прошла");
    await env.ok("PATCH", U(t.uid), { properties: { detectorKind: "linecross" } }, v(m));
    const en2 = await env.ok("PATCH", U(en.uid), { name: "Вход 2", properties: { enabled: false } }, v(en));
    assert.eq([en2.name, en2.properties.enabled], ["Вход 2", false], "под линией: имя и enabled правятся");
    field(await props(env, ab2, { subdetectorKind: "abandoned" }), "NOT_SUPPORTED", P("subdetectorKind"), "subdetectorKind в правке — правило родителя");
    field(await props(env, en2, { zone: { shape: "line", points: [[0.1, 0.1], [0.9, 0.9]] } }), "VALIDATION_FAILED", P("zone"), "правила формы — как раньше");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "kind:subdet"] });

  test("Поддетектор: геометрия по виду (line — line, a2a — rect/polygon и zoneTo, остальные — rect/polygon); speed min выше max — 422; subdetectorKind не меняется", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const line = { shape: "line", points: [[0.1, 0.1], [0.9, 0.9]] };
    assert.eq(await failedOf(env, sub(t, "line", { zone: { shape: "polygon", points: TRI } })), [["VALIDATION_FAILED", P("zone")]], "линия: нужна line");
    assert.eq(await failedOf(env, sub(t, "enter", { zone: line })), [["VALIDATION_FAILED", P("zone")]], "область: line нельзя");
    const shape = await create(env, sub(t, "enter", { zone: line }));
    assert.eq(shape.failed[0].params.reason, "shape", "reason shape");
    assert.eq(await failedOf(env, sub(t, "enter", { zone: { shape: "rect", points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]] } })), [["VALIDATION_FAILED", P("zone")]], "rect — две точки");
    assert.eq(await failedOf(env, sub(t, "a2a")), [["VALIDATION_FAILED", P("zoneTo")]], "a2a без zoneTo");
    assert.eq(await failedOf(env, sub(t, "enter", { zoneTo: { points: TRI } })), [["VALIDATION_FAILED", P("zoneTo")]], "zoneTo не у a2a");
    assert.eq(await failedOf(env, sub(t, "stop")), [["VALIDATION_FAILED", P("timeSec")]], "stop без времени");
    assert.eq(await failedOf(env, sub(t, "abandoned", { timeSec: 0 })), [["VALIDATION_FAILED", P("timeSec")]], "abandoned: 0 с");
    assert.eq(await failedOf(env, sub(t, "move", { speed: { min: 300, max: 100 } })), [["VALIDATION_FAILED", P("speed/min")]], "speed min выше max");
    const a2a = await addSub(env, t, "a2a", { zoneTo: { points: [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9]] } });
    const ln = await addSub(env, t, "line", { direction: "ab" });
    const mv = await addSub(env, t, "move", { speed: { min: 10, max: 100 }, offset: { x: 5, y: 5 }, group: { count: 3, waitSec: 5 }, classes: ["car"], minObjects: 2 });
    assert.eq([a2a.properties.zoneTo.points.length, ln.properties.direction, mv.properties.speed], [3, "ab", { min: 10, max: 100 }], "верные сохранены");
    field(await props(env, mv, { speed: { min: 200 } }), "VALIDATION_FAILED", P("speed/min"), "правка: min выше сохранённого max");
    field(await props(env, ln, { zone: { shape: "polygon", points: TRI } }), "VALIDATION_FAILED", P("zone"), "правка: линия стала областью");
    field(await props(env, a2a, { zoneTo: null }), "VALIDATION_FAILED", P("zoneTo"), "правка: a2a без zoneTo");
    const kind = await props(env, mv, { subdetectorKind: "stop" });
    assert.status(kind, 422, "VALIDATION_FAILED", "subdetectorKind не меняется");
    const ren = await env.ok("PATCH", U(mv.uid), { name: "Новое имя", properties: { enabled: false, timeMode: "lt", timeSec: 7 } }, v(mv));
    assert.eq([ren.name, ren.properties.enabled, ren.properties.timeMode, ren.properties.timeSec], ["Новое имя", false, "lt", 7], "имя, enabled и время правятся");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "kind:subdet"] });

  /* ===== Свойства детектора и поддетектора (контракт 0.15.0) ===== */

  // prop:det.scanWindow и prop:subdet.lostObjectType в needs — знак, что сервер знает 0.15.0: без них тест пропускается
  test("Свойства детектора и поддетектора 0.15.0: без полей — как раньше; новые сохраняются; null снимает; frontEdge и шаг окна проверяются", async () => {
    const env = await makeEnv();
    const NEW = ["detectUnattendedObjects", "humanSize", "speedCalibArea", "cameraPosition", "similarSearch", "similarTrackSec", "minTriggers", "scanWindow"];
    const t = await addDet(env, camU, "Трекер 0.15", { detectorKind: "other", analyticsKind: "tracker", sensitivity: 60 });
    assert.eq(NEW.filter((n) => n in t.properties), [], "без полей — ключей нет");
    const good = { detectUnattendedObjects: false, humanSize: [0.05, 0.2], speedCalibArea: [[0.1, 0.6], [0.9, 0.6], [0.8, 0.9], [0.2, 0.9]], cameraPosition: "ceiling",
      similarSearch: true, similarTrackSec: 4, minTriggers: 4, scanWindow: { width: 640, height: 480, stepWidth: 320 } };
    const ok = await env.ok("PATCH", U(t.uid), { properties: good }, v(t));
    assert.eq(NEW.map((n) => ok.properties[n]), NEW.map((n) => good[n]), "сохранены");
    field(await props(env, ok, { cameraPosition: "floor" }), "VALIDATION_FAILED", P("cameraPosition"), "незнакомое положение");
    field(await props(env, ok, { speedCalibArea: good.speedCalibArea.slice(0, 3) }), "VALIDATION_FAILED", P("speedCalibArea"), "три точки");
    field(await props(env, ok, { minTriggers: 1 }), "VALIDATION_FAILED", P("minTriggers"), "меньше двух");
    const step = await props(env, ok, { scanWindow: { width: 100, height: 100, stepWidth: null, stepHeight: 200 } });
    field(step, "VALIDATION_FAILED", P("scanWindow/stepHeight"), "шаг выше окна");
    assert.eq(step.body.params.reason, "stepAboveWindow", "reason шага");
    // Зоны: ломаная, название, передняя сторона, пересечение границы
    const poly = { shape: "polyline", points: [[0.1, 0.5], [0.4, 0.4], [0.7, 0.6], [0.9, 0.5]], name: "Забор" };
    const zoned = await env.ok("PATCH", U(ok.uid), { properties: { zone: poly, direction: "ab", extraZones: [{ type: "in", points: TRI, name: "Касса", description: "У входа", frontEdge: 2, crossing: "in" }] } }, v(ok));
    assert.eq([zoned.properties.zone, zoned.properties.extraZones[0].frontEdge, zoned.properties.extraZones[0].crossing], [poly, 2, "in"], "ломаная и свойства зоны сохранены");
    const fe = await props(env, zoned, { extraZones: [{ type: "in", points: TRI, frontEdge: 3 }] });
    field(fe, "VALIDATION_FAILED", P("extraZones/0/frontEdge"), "сторона за числом точек");
    assert.eq(fe.body.params.reason, "frontEdge", "reason frontEdge");
    field(await props(env, zoned, { zone: { shape: "polygon", points: TRI, frontEdge: 5 } }), "VALIDATION_FAILED", P("zone/frontEdge"), "и у zone");
    const long = { shape: "polyline", points: Array.from({ length: 65 }, (_, i) => [i / 100, 0.5]) };
    field(await props(env, zoned, { zone: long }), "VALIDATION_FAILED", P("zone"), "ломаная из 65 точек");
    const gone = await env.ok("PATCH", U(zoned.uid), { properties: Object.fromEntries(NEW.map((n) => [n, null])) }, v(zoned));
    assert.eq(NEW.filter((n) => n in gone.properties), [], "null снимает");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "prop:det.scanWindow"] });

  // Профиль vms.detector/1 1.4, пункт C1: параметры детектора по семействам. prop:det.objectSpeed в needs — знак, что сервер знает 1.4
  test("Параметры детектора по семействам (1.4): без полей — как раньше; новые сохраняются; пределы и min выше max — 422; null снимает", async () => {
    const env = await makeEnv();
    const NEW = ["alarmEndSec", "analysisFps", "frameWidth", "abandonedSensitivity", "objectSpeed"];
    const t = await addDet(env, camU, "Трекер 1.4", { detectorKind: "other", analyticsKind: "tracker", sensitivity: 60 });
    assert.eq(NEW.filter((n) => n in t.properties), [], "без полей — ключей нет");
    const good = { alarmEndSec: 30, analysisFps: 6.5, frameWidth: 640, abandonedSensitivity: 20, objectSpeed: { min: 10, max: 200 } };
    const ok = await env.ok("PATCH", U(t.uid), { properties: good }, v(t));
    assert.eq(NEW.map((n) => ok.properties[n]), NEW.map((n) => good[n]), "сохранены");
    field(await props(env, ok, { alarmEndSec: 601 }), "VALIDATION_FAILED", P("alarmEndSec"), "задержка больше 600");
    field(await props(env, ok, { analysisFps: 0 }), "VALIDATION_FAILED", P("analysisFps"), "0 кадров");
    field(await props(env, ok, { frameWidth: 800 }), "VALIDATION_FAILED", P("frameWidth"), "ширина вне перечня");
    field(await props(env, ok, { abandonedSensitivity: 0 }), "VALIDATION_FAILED", P("abandonedSensitivity"), "чувствительность 0");
    field(await props(env, ok, { objectSpeed: { max: 501 } }), "VALIDATION_FAILED", P("objectSpeed/max"), "скорость выше 500");
    const sp = await props(env, ok, { objectSpeed: { min: 300, max: 100 } });
    field(sp, "VALIDATION_FAILED", P("objectSpeed/min"), "min выше max");
    assert.eq(sp.body.params.reason, "minAboveMax", "reason скорости");
    const gone = await env.ok("PATCH", U(ok.uid), { properties: Object.fromEntries(NEW.map((n) => [n, null])) }, v(ok));
    assert.eq(NEW.filter((n) => n in gone.properties), [], "null снимает");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "prop:det.objectSpeed"], layer: "profile:vms.detector/1", since: "1.4" });

  // Профиль vms.detector/1 1.5, пункт C17: checkLists и lists. kind:facelist в needs — знак, что система объявила списки
  test("Списки лиц и номеров у детектора (1.5): детектор лиц — списки лиц, номеров — списки номеров; другой вид, чужой uid, другое семейство — 422; список удалён — uid уходит", async () => {
    const env = await makeEnv();
    const [f1, f2] = await env.pages("/units?kind=facelist&limit=100");
    const [p1] = await env.pages("/units?kind=platelist&limit=100");
    const L = (n) => `/properties/lists/${n}`;
    // Выключенные: включённый детектор лиц того же сервера ответил бы 409 BUSY
    const face = await addDet(env, camU, "Лица со списками", { detectorKind: "other", analyticsKind: "faceVA", enabled: false });
    assert.eq(["lists", "checkLists"].filter((n) => n in face.properties), [], "без полей — ключей нет");
    const ok = await env.ok("PATCH", U(face.uid), { properties: { checkLists: true, lists: [f1.uid, f2.uid] } }, v(face));
    assert.eq([ok.properties.checkLists, ok.properties.lists], [true, [f1.uid, f2.uid]], "сохранены");
    const wrong = await props(env, ok, { lists: [f1.uid, p1.uid] });
    field(wrong, "VALIDATION_FAILED", L(1), "список номеров у детектора лиц");
    assert.eq([wrong.body.params.reason, wrong.body.params.kind], ["wrongKind", "facelist"], "reason и ожидаемый вид");
    const ghost = await props(env, ok, { lists: ["00000000-0000-4000-8000-000000000000"] });
    field(ghost, "VALIDATION_FAILED", L(0), "нет такого uid");
    assert.eq(ghost.body.params.reason, "unknownList", "reason неизвестного списка");
    field(await props(env, ok, { lists: [cam.id] }), "VALIDATION_FAILED", L(0), "uid камеры вместо списка");
    assert.eq(await failedOf(env, det(camU, "Новый с чужим списком", { detectorKind: "other", analyticsKind: "faceVL", enabled: false, lists: [p1.uid] })), [["VALIDATION_FAILED", L(0)]], "и при создании");
    // Номера
    const lpr = await addDet(env, camU, "Номера со списками", { detectorKind: "lpr", sensitivity: 10, checkLists: true, lists: [p1.uid] });
    assert.eq(lpr.properties.lists, [p1.uid], "детектор номеров: список номеров");
    field(await props(env, lpr, { lists: [f1.uid] }), "VALIDATION_FAILED", L(0), "список лиц у детектора номеров");
    // Другие семейства списков не имеют
    const mo = await addDet(env, camU, "Движение без списков", { detectorKind: "motion", sensitivity: 10 });
    field(await props(env, mo, { lists: [f1.uid] }), "VALIDATION_FAILED", P("lists"), "детектор движения со списком");
    const fam = await props(env, mo, { checkLists: true });
    field(fam, "VALIDATION_FAILED", P("checkLists"), "детектор движения проверяет по спискам");
    assert.eq(fam.body.params.reason, "notFamily", "reason семейства");
    const off = await env.ok("PATCH", U(mo.uid), { properties: { checkLists: false } }, v(mo));
    assert.eq(off.properties.checkLists, false, "checkLists: false — у любого семейства");
    // checkLists без lists — все списки своего вида: не ошибка
    const all = await addDet(env, camU, "Все списки", { detectorKind: "lpr", sensitivity: 10, checkLists: true });
    assert.eq([all.properties.checkLists, "lists" in all.properties], [true, false], "checkLists: true без lists — сохранено");
    const empty = await env.ok("PATCH", U(all.uid), { properties: { lists: [] } }, v(all));
    assert.eq([empty.properties.checkLists, empty.properties.lists], [true, []], "пустой lists — не ошибка");
    // Смена семейства (старый клиент шлёт detectorKind и analyticsKind: null) не отказывает; хранимые списки остаются как есть
    const moved = await env.ok("PATCH", U(ok.uid), { properties: { detectorKind: "motion", analyticsKind: null } }, v(ok));
    assert.eq([moved.properties.detectorKind, moved.properties.lists], ["motion", [f1.uid, f2.uid]], "семейство сменено, lists на месте");
    await env.ok("PATCH", U(ok.uid), { properties: { detectorKind: "other", analyticsKind: "faceVA" } }, v(moved));
    // Список удалён: uid уходит из lists, как любая ссылка x-ref. Консоль списки не удаляет: стенд на время даёт виду delete
    const dropList = async (name, list) => {
      const kind = await env.ok("GET", `/kinds/${name}`);
      assert.status(await env.call("PUT", `/test/kinds/${name}`, Object.assign({}, kind, { capabilities: ["delete"] })), 200, null, "стенд дал виду delete");
      const del = await env.call("DELETE", U(list.uid), undefined, v(list));
      assert.ok([200, 202, 204].includes(del.status), "список удалён: " + del.status);
      assert.status(await env.call("PUT", `/test/kinds/${name}`, kind), 200, null, "стенд вернул описание вида");
      await ApiTest.settle();
    };
    await dropList("facelist", f1);
    assert.eq((await get(env, face.uid)).properties.lists, [f2.uid], "uid удалённого списка снят из lists");
    // Сужение до одного списка, и его удалили: пустой lists значил бы «все списки» — checkLists снимается, детектор не переходит на все
    const narrow = await env.ok("PATCH", U(lpr.uid), { properties: { checkLists: true, lists: [p1.uid] } }, v(await get(env, lpr.uid)));
    assert.eq([narrow.properties.checkLists, narrow.properties.lists], [true, [p1.uid]], "сужено до одного списка");
    await dropList("platelist", p1);
    const after = (await get(env, lpr.uid)).properties;
    assert.eq([after.checkLists, after.lists], [false, []], "выбранный список удалён: lists пуст, checkLists снят");
    // Без сужения (checkLists без lists) удаление списка детектор не меняет
    assert.eq([(await get(env, all.uid)).properties.checkLists], [true], "детектор без lists: checkLists остался");
    const cleared = await env.ok("PATCH", U(face.uid), { properties: { checkLists: null, lists: null } }, v(await get(env, face.uid)));
    assert.eq(["lists", "checkLists"].filter((n) => n in cleared.properties), [], "null снимает");
  }, { needs: ["createUnits", "patchUnit", "deleteUnit", "kind:det", "kind:facelist", "kind:platelist", "prop:det.lists"], layer: "profile:vms.detector/1", since: "1.5" });
  // Профиль vms.detector/1 1.6, замечания det-760 и det-761: трекер для поддетектора «Оставленный предмет». prop:det.longTimeIdleSec в needs — знак, что сервер знает 1.6
  test("Трекер для оставленных предметов (1.6): без полей — как раньше; новые сохраняются; время покоя вне 15–1800 — 422; null снимает", async () => {
    const env = await makeEnv();
    const NEW = ["autoSensitivity", "longTimeUnattended", "longTimeIdleSec"];
    const t = await addDet(env, camU, "Трекер 1.6", { detectorKind: "other", analyticsKind: "tracker" });
    assert.eq(NEW.filter((n) => n in t.properties), [], "без полей — ключей нет");
    const good = { autoSensitivity: true, longTimeUnattended: true, longTimeIdleSec: 120 };
    const ok = await env.ok("PATCH", U(t.uid), { properties: good }, v(t));
    assert.eq(NEW.map((n) => ok.properties[n]), NEW.map((n) => good[n]), "сохранены");
    field(await props(env, ok, { longTimeIdleSec: 14 }), "VALIDATION_FAILED", P("longTimeIdleSec"), "время покоя меньше 15");
    field(await props(env, ok, { longTimeIdleSec: 1801 }), "VALIDATION_FAILED", P("longTimeIdleSec"), "время покоя больше 1800");
    field(await props(env, ok, { autoSensitivity: "да" }), "VALIDATION_FAILED", P("autoSensitivity"), "не логическое");
    const gone = await env.ok("PATCH", U(ok.uid), { properties: Object.fromEntries(NEW.map((n) => [n, null])) }, v(ok));
    assert.eq(NEW.filter((n) => n in gone.properties), [], "null снимает");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "prop:det.longTimeIdleSec"], layer: "profile:vms.detector/1", since: "1.6" });

  // Контракт 0.42.0: GET /units/{uid}/entries. Необязательный путь: система без listUnitEntries читает properties.entries, как в 0.41.0
  test("Записи списков лиц и номеров (0.42.0): страницы по offset и по cursor, total, q, ids, entryCount; отказы", async () => {
    const env = await makeEnv();
    const lists = await env.pages("/units?kind=facelist,platelist&limit=100");
    const faces = lists.find((l) => l.name === "Сотрудники"), plates = lists.find((l) => l.name === "Автопарк");
    const E = (l, qs) => `/units/${l.uid}/entries${qs ? "?" + qs : ""}`;
    // Страницы по offset: total — всех записей списка, offset — индекс первой записи страницы
    const all = (await get(env, faces.uid)).properties.entries;
    const p0 = await env.ok("GET", E(faces, "limit=100"));
    assert.eq([p0.items.length, p0.total, p0.offset, typeof p0.nextCursor], [100, 240, 0, "string"], "первая страница");
    const p2 = await env.ok("GET", E(faces, "limit=100&offset=200"));
    assert.eq([p2.items.length, p2.total, p2.offset, "nextCursor" in p2], [40, 240, 200, false], "последняя страница: 40 записей, курсора нет");
    assert.eq(p2.items, all.slice(200), "записи страницы — те же, что в properties.entries");
    const dflt = await env.ok("GET", E(faces));
    assert.eq([dflt.items.length, dflt.offset], [200, 0], "limit по умолчанию 200");
    const past = await env.ok("GET", E(faces, "offset=5000"));
    assert.eq([past.items, past.total, past.offset], [[], 240, 5000], "смещение за концом — пустые items, не ошибка");
    // Обход по cursor даёт те же записи, что обход по offset
    const byCursor = [];
    let page = await env.ok("GET", E(faces, "limit=70"));
    for (let n = 0; n < 10; n++) {
      byCursor.push(...page.items);
      if (!page.nextCursor) break;
      page = await env.ok("GET", E(faces, `limit=70&cursor=${encodeURIComponent(page.nextCursor)}`));
    }
    const byOffset = [];
    for (let o = 0; o < 240; o += 70) byOffset.push(...(await env.ok("GET", E(faces, `limit=70&offset=${o}`))).items);
    assert.eq([byCursor.length, byCursor], [240, byOffset], "обход по cursor равен обходу по offset");
    assert.eq(new Set(byCursor.map((x) => x.id)).size, 240, "id записей не повторяются");
    // Поиск лиц: имя без учёта регистра, id целиком
    const first = all[0];
    const up = await env.ok("GET", E(faces, `q=${encodeURIComponent(first.name.toUpperCase())}&limit=1000`));
    const lo = await env.ok("GET", E(faces, `q=${encodeURIComponent(first.name.toLowerCase())}&limit=1000`));
    const want = all.filter((x) => x.name.toLowerCase().includes(first.name.toLowerCase()));
    assert.eq([up.items.map((x) => x.id), lo.total], [want.map((x) => x.id), want.length], "q: регистр не важен");
    assert.eq((await env.ok("GET", E(faces, "q=f-0102"))).items.map((x) => x.id), ["f-0102"], "q равен id");
    assert.eq((await env.ok("GET", E(faces, "q=f-010"))).total, 0, "часть id — не совпадение");
    const sp = await env.ok("GET", E(faces, "q=%20%20"));
    assert.eq(sp.total, 240, "q из пробелов — без отбора");
    const miss = await env.ok("GET", E(faces, "q=%D0%AF%D0%AF%D0%AF%D0%AF"));
    assert.eq([miss.items, miss.total, miss.offset], [[], 0, 0], "ничего не нашлось");
    const sub = await env.ok("GET", E(faces, `q=${encodeURIComponent(first.name.toLowerCase())}&limit=1&offset=${want.length - 1}`));
    assert.eq([sub.total, sub.offset, sub.items.map((x) => x.id)], [want.length, want.length - 1, [want[want.length - 1].id]], "offset считают в отобранном наборе");
    // Номера: кириллица и латиница, пробелы и дефисы
    const pl = (await get(env, plates.uid)).properties.entries;
    assert.eq((await env.ok("GET", E(plates))).total, 120, "в списке номеров 120 записей");
    const norm = (v) => String(v).replace(/[\s-]+/g, "").toUpperCase().replace(/[АВЕКМНОРСТУХ]/g, (c) => "ABEKMHOPCTYX"["АВЕКМНОРСТУХ".indexOf(c)]);
    const wantP = pl.filter((x) => norm(x.plate).includes("A123BC")).map((x) => x.id);
    assert.ok(wantP.includes("p-0101"), "ожидание: А123ВС77 подходит");
    for (const qq of ["A123BC", "а123вс", "a 123-bc", "А123ВС 77", "a123bc77"]) {
      const r = await env.ok("GET", E(plates, `q=${encodeURIComponent(qq)}&limit=1000`));
      const wantQ = pl.filter((x) => norm(x.plate).includes(norm(qq))).map((x) => x.id);
      assert.eq([r.items.map((x) => x.id), r.total], [wantQ, wantQ.length], `номер по q «${qq}»`);
      assert.ok(r.items.some((x) => x.id === "p-0101"), `«${qq}» находит p-0101`);
      assert.eq(r.items.find((x) => x.id === "p-0101").plate, "А123ВС77", "plate записи без изменений");
    }
    assert.eq("plate" in (await env.ok("GET", E(faces, "limit=1"))).items[0], false, "у списка лиц plate нет");
    assert.eq((await env.ok("GET", E(faces, "q=A123BC"))).total, 0, "у списка лиц номер не ищут");
    // ids: в порядке списка, неизвестные пропущены
    const ids = await env.ok("GET", E(faces, "ids=f-0103,f-0101,нет-такой"));
    assert.eq([ids.items.map((x) => x.id), ids.total], [["f-0101", "f-0103"], 2], "ids: только названные, в порядке списка");
    const tooMany = await env.call("GET", E(faces, "ids=" + Array.from({ length: 201 }, (_, i) => "x" + i).join(",")));
    assert.status(tooMany, 422, "VALIDATION_FAILED");
    assert.eq(tooMany.body.field, "ids", "field ids");
    assert.eq((await env.ok("GET", E(faces, "ids=" + all.slice(0, 200).map((x) => x.id).join(",") + "&limit=1000"))).total, 200, "200 id — можно");
    // Отказы
    const both = await env.call("GET", E(faces, `limit=10&offset=10&cursor=${encodeURIComponent(p0.nextCursor)}`));
    assert.status(both, 422, "VALIDATION_FAILED");
    assert.eq([both.body.field, both.body.params.reason], ["offset", "withCursor"], "offset вместе с cursor");
    assert.status(await env.call("GET", E(faces, "cursor=чужой")), 422, "INVALID_CURSOR");
    assert.status(await env.call("GET", E(faces, `limit=100&q=zzz&cursor=${encodeURIComponent(p0.nextCursor)}`)), 422, "INVALID_CURSOR");
    assert.status(await env.call("GET", E(faces, "limit=0")), 422, "VALIDATION_FAILED");
    assert.status(await env.call("GET", E(faces, "offset=-1")), 422, "VALIDATION_FAILED");
    const other = await env.call("GET", `/units/${cam.id}/entries`);
    assert.status(other, 422, "NOT_SUPPORTED");
    assert.eq(other.body.field, "/kind", "field /kind у камеры");
    assert.status(await env.call("GET", "/units/00000000-0000-4000-8000-000000000000/entries"), 404, "NOT_FOUND");
    // entryCount равен total без q
    for (const l of lists) {
      const u = await get(env, l.uid), n = (await env.ok("GET", E(l))).total;
      assert.eq([u.properties.entryCount, u.properties.entryCount === (u.properties.entries || []).length], [n, true], `entryCount «${l.name}» равен total`);
    }
    assert.eq(lists.map((l) => l.properties.entryCount), lists.map((l) => (l.properties.entries || []).length), "entryCount и в перечне /units");
  }, { needs: ["listUnitEntries", "kind:facelist", "kind:platelist"] });

  test("Поддетектор 0.15.0: stripe — линия или ломаная; свой objectSize; диапазон multi; lostObjectType; свои extraZones; direction у a2a", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер 0.15", { detectorKind: "other", analyticsKind: "tracker" });
    const poly = { shape: "polyline", points: [[0.1, 0.5], [0.5, 0.4], [0.9, 0.5]] };
    const st = await addSub(env, t, "stripe", { zone: poly, width: 7.5, showLine: false, direction: "ba" });
    assert.eq([st.properties.subdetectorKind, st.properties.width, st.properties.showLine, st.properties.zone.shape], ["stripe", 7.5, false, "polyline"], "полоса на ломаной");
    const ln = await addSub(env, t, "line", { zone: poly });
    assert.eq(ln.properties.zone.shape, "polyline", "линия — тоже ломаной");
    assert.eq(await failedOf(env, sub(t, "stripe", { zone: { shape: "polygon", points: TRI } })), [["VALIDATION_FAILED", P("zone")]], "полоса: нужна линия");
    assert.eq(await failedOf(env, sub(t, "enter", { zone: poly })), [["VALIDATION_FAILED", P("zone")]], "область: ломаную нельзя");
    const ab = await addSub(env, t, "abandoned", { timeSec: 10, lostObjectType: "taken", objectSize: { min: [0.01, 0.01], max: [0.2, 0.2] },
      extraZones: [{ type: "ex", points: TRI }] });
    assert.eq([ab.properties.lostObjectType, ab.properties.objectSize.max, ab.properties.extraZones.length], ["taken", [0.2, 0.2], 1], "свой размер и исключения");
    field(await props(env, ab, { objectSize: { min: [0.5, 0.5], max: [0.1, 0.1] } }), "VALIDATION_FAILED", P("objectSize/min"), "размер: min выше max");
    field(await props(env, ab, { lostObjectType: "lost" }), "VALIDATION_FAILED", P("lostObjectType"), "незнакомый тип");
    const mu = await addSub(env, t, "multi", { minObjects: 2, maxObjects: 10, rangeMode: "out", cooldownSec: 5, confirmFrames: 3, extraZones: [{ type: "in", points: TRI }] });
    assert.eq([mu.properties.maxObjects, mu.properties.rangeMode, mu.properties.cooldownSec, mu.properties.confirmFrames], [10, "out", 5, 3], "диапазон multi");
    const rng = await props(env, mu, { maxObjects: 1 });
    field(rng, "VALIDATION_FAILED", P("minObjects"), "конец ниже начала");
    assert.eq(rng.body.params.reason, "minAboveMax", "reason диапазона");
    const a2a = await addSub(env, t, "a2a", { zoneTo: { points: [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9]] }, direction: "both" });
    assert.eq(a2a.properties.direction, "both", "направление между зонами");
  }, { needs: ["createUnits", "patchUnit", "kind:det", "kind:subdet", "prop:subdet.lostObjectType"] });

  test("Поддетектор: правка без If-Match — 428, чужая версия — 412 с current", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const s = await addSub(env, t, "enter");
    assert.status(await env.call("PATCH", U(s.uid), { properties: { enabled: false } }), 428, "PRECONDITION_REQUIRED");
    const old = await env.ok("PATCH", U(s.uid), { properties: { enabled: false } }, v(s));
    const res = await env.call("PATCH", U(s.uid), { properties: { enabled: true } }, v(s));
    assert.status(res, 412, "VERSION_MISMATCH", "версия устарела");
    assert.eq([res.body.current.uid, res.body.current.version], [s.uid, old.version], "current — свежий поддетектор");
    assert.status(await env.call("DELETE", U(s.uid)), 428, "PRECONDITION_REQUIRED", "и удаление");
    assert.status(await env.call("DELETE", U(s.uid), undefined, v(old)), 204, null, "удалён");
  }, { needs: ["createUnits", "patchUnit", "deleteUnit", "kind:det", "kind:subdet"] });

  test("Удаление детектора удаляет поддетекторы: entity.deleted от детей, и DELETE, и шагом операции; поддетектор шагом — «Отменить» возвращает его", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const a = await addSub(env, t, "enter"), b = await addSub(env, t, "line");
    // Один поддетектор: шаг delete и откат
    const one = await env.runOperation({ idempotencyKey: key(), items: [{ uid: a.uid, delete: true }], expectedVersions: { [a.uid]: a.version } });
    assert.eq([one.ok, (await kidsOf(env, t.uid)).map((x) => x.uid)], [1, [b.uid]], "шаг delete снял поддетектор");
    const back = await env.ok("POST", `/operations/${one.id}/revert`);
    assert.eq((await env.finished(back.id)).ok, 1, "откат выполнен");
    assert.eq((await kidsOf(env, t.uid)).map((x) => x.name).sort(), [a.name, b.name].sort(), "поддетектор вернулся");
    // Детектор целиком: дети уходят с ним
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.type === "entity.deleted" && seen.push([m.kind, m.entityId]), [cam.id, t.uid]);
    await ApiTest.settle();
    const fresh = await get(env, t.uid);
    assert.status(await env.call("DELETE", U(t.uid), undefined, v(fresh)), 204);
    await ApiTest.settle();
    stop();
    for (const x of [t, a, b]) assert.status(await env.call("GET", U(x.uid)), 404, "NOT_FOUND", `${x.name} удалён`);
    assert.ok([a, b].every((x) => seen.some(([k, id]) => k === "subdet" && id === x.uid)), "entity.deleted от каждого поддетектора, вид subdet");
    // То же шагом операции
    const t2 = await addDet(env, camU, "Трекер 2", { detectorKind: "other", analyticsKind: "tracker" });
    const c = await addSub(env, t2, "exit");
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: t2.uid, delete: true }], expectedVersions: { [t2.uid]: t2.version } });
    assert.eq(op.ok, 1, "шаг delete детектора выполнен");
    assert.status(await env.call("GET", U(c.uid)), 404, "NOT_FOUND", "поддетектор ушёл с детектором");
  }, { needs: ["createUnits", "deleteUnit", "createOperation", "revertOperation", "kind:det", "kind:subdet"] });

  test("План одной операцией: patch детектора, createUnit, patch и delete поддетектора — все шаги ok, в любом порядке; откат возвращает всё", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker", sensitivity: 60 });
    const keep = await addSub(env, t, "enter", {}, "Остаётся");
    const drop = await addSub(env, t, "exit", {}, "Уйдёт");
    const steps = [
      { uid: t.uid, patch: { properties: { sensitivity: 70, objectSize: { min: [0.02, 0.04], max: [0.5, 0.6] } } } },
      { uid: t.uid, createUnit: { kind: "subdet", name: "Новый", properties: sub(t, "dwell", { timeSec: 15 }).properties } },
      { uid: keep.uid, patch: { name: "Переименован", properties: { enabled: false } } },
      { uid: drop.uid, delete: true },
    ];
    // Порядок шагов не должен мешать: шаг по детектору ждёт операцию, а шаги потомков проверяются «кроме своей операции»
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]]) {
      const env2 = await makeEnv();
      const t2 = await addDet(env2, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker", sensitivity: 60 });
      const k2 = await addSub(env2, t2, "enter", {}, "Остаётся");
      const d2 = await addSub(env2, t2, "exit", {}, "Уйдёт");
      const map = { [t.uid]: t2.uid, [keep.uid]: k2.uid, [drop.uid]: d2.uid };
      const items = order.map((i) => {
        const s = JSON.parse(JSON.stringify(steps[i]));
        s.uid = map[s.uid];
        if (s.createUnit) s.createUnit.parentId = undefined;
        return s;
      });
      const run = await env2.runOperation({ idempotencyKey: key(), items, expectedVersions: { [t2.uid]: t2.version, [k2.uid]: k2.version, [d2.uid]: d2.version } });
      assert.eq(run.items.map((x) => x.state || x.status || (x.ok ? "ok" : "fail")), items.map(() => "ok"), `порядок ${order}: шаги`);
      const kids = await kidsOf(env2, t2.uid);
      assert.eq(kids.map((x) => x.name).sort(), ["Новый", "Переименован"], `порядок ${order}: состав поддетекторов`);
      assert.eq((await get(env2, t2.uid)).properties.objectSize.max, [0.5, 0.6], `порядок ${order}: правка детектора`);
      const back = await env2.ok("POST", `/operations/${run.id}/revert`);
      assert.eq((await env2.finished(back.id)).ok, items.length, `порядок ${order}: откат всех шагов`);
      assert.eq((await kidsOf(env2, t2.uid)).map((x) => x.name).sort(), ["Остаётся", "Уйдёт"], `порядок ${order}: после отката как было`);
      const det2 = (await get(env2, t2.uid)).properties, kept = await get(env2, k2.uid);
      assert.eq([det2.sensitivity, "objectSize" in det2], [60, false], `порядок ${order}: откат вернул детектор`);
      assert.eq([kept.name, kept.properties.enabled !== false], ["Остаётся", true], `порядок ${order}: откат вернул поддетектор`);
    }
  }, { needs: ["createUnits", "patchUnit", "deleteUnit", "createOperation", "revertOperation", "kind:det", "kind:subdet"] });

  test("/tree/children: у трекера hasChildren, дети в раскладках detectors и servers — вид subdet", async () => {
    const env = await makeEnv();
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const a = await addSub(env, t, "enter", {}, "Вход"), b = await addSub(env, t, "line", {}, "Линия");
    const plain = await addDet(env, camU, "Без детей", { detectorKind: "motion" });
    for (const layout of ["detectors", "servers"]) {
      const under = (await env.pages(`/tree/children?layout=${layout}&parentId=${cam.id}&limit=1000`)).find((x) => x.id === t.uid);
      assert.eq(under && under.hasChildren, true, `${layout}: у трекера есть дети`);
      const kids = await env.pages(`/tree/children?layout=${layout}&parentId=${t.uid}&limit=1000`);
      assert.eq(kids.map((x) => [x.kind, x.id]).sort(), [["subdet", a.uid], ["subdet", b.uid]].sort(), `${layout}: дети — поддетекторы`);
      assert.eq(kids.every((x) => x.implements.includes("vms.subdetector/1") && x.hasChildren === false), true, `${layout}: профиль, листья`);
      const flat = (await env.pages(`/tree/children?layout=${layout}&parentId=${cam.id}&limit=1000`)).find((x) => x.id === plain.uid);
      assert.eq(flat && flat.hasChildren, false, `${layout}: у детектора без детей их нет`);
    }
  }, { needs: ["createUnits", "kind:det", "kind:subdet", "getTreeChildren", "layout:detectors", "layout:servers"] });

  test("Правило по subdet.triggered (kinds: [subdet]) проходит проверку; событие не тревога и не в «Что считать тревогой»", async () => {
    const env = await makeEnv();
    const k = await env.ok("GET", "/kinds/subdet");
    const ev = k.events.find((e) => e.id === "subdet.triggered");
    assert.eq([ev && ev.alarm, k.implements], [false, ["vms.subdetector/1"]], "событие объявлено, не тревога");
    const t = await addDet(env, camU, "Трекер", { detectorKind: "other", analyticsKind: "tracker" });
    const s = await addSub(env, t, "dwell", { timeSec: 20 });
    const rule = { name: "Долго у входа — запись", enabled: false, logOnly: false, logOnlySince: null, start: "event", runMode: "always", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
      runAt: null, repeat: "skip", triggers: [{ source: "unit", kinds: ["subdet"], event: "subdet.triggered", target: { include: [{ uid: s.uid }], exclude: [], gone: [], fromEvent: false }, match: {} }], conditions: [],
      steps: [{ type: "unitAction", action: "record", target: { include: [{ uid: cam.id }], exclude: [], gone: [], fromEvent: false }, params: { duration: "min", minutes: 5 } }],
      owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true };
    const res = await env.call("POST", "/rules", rule);
    assert.status(res, 201, null, "правило сохранено");
    assert.eq(res.body.triggers[0].kinds, ["subdet"], "триггер по виду subdet");
    const settings = await env.ok("GET", "/settings");
    const bad = await env.call("PATCH", "/settings", { values: { "alarms.domain": ["subdet.triggered"] } }, { "If-Match": `"${settings.version}"` });
    assert.status(bad, 422, "VALIDATION_FAILED", "subdet.triggered — не тревога");
  }, { needs: ["createUnits", "kind:det", "kind:subdet", "patchSettings"] });

  /* ===== PTZ ===== */

  const ptzCam = async (env) => (await env.pages("/units?kind=camera&limit=1000")).find((u) => u.properties.ptz && u.status.link === "online" && (u.properties.presetMax == null || u.properties.presetMax >= 9));
  const presets = (u) => u.properties.presets || [];
  // Номер и имя пресета: поля профиля 1.2 (savedOnDevice, pan, tilt, zoom) судит свой тест
  const nn = (p) => p && { n: p.n, name: p.name };

  test("Пресеты: задать, переименовать, удалить, откат; камера без PTZ — 422 field /properties/ptz", async () => {
    const env = await makeEnv();
    const c = await ptzCam(env);
    const was = presets(c).length;
    const at = (r, n) => presets(r).find((x) => x.n === n);
    const put = (uid, n, body) => env.ok("PUT", `${U(uid)}/presets/${n}`, body);
    // PUT {} сохраняет положение и создаёт запись без подписи; ответ — объект камеры
    const pos = await put(c.uid, 9, {});
    assert.eq([pos.uid, nn(at(pos, 9))], [c.uid, { n: 9, name: "" }], "сохранённый без имени виден");
    assert.ok(c.properties.presetMax >= 9, "предел в записи");
    const set = await put(c.uid, 9, { name: "Ворота" });
    assert.eq(nn(presets(set).at(-1)), { n: 9, name: "Ворота" }, "имя задано, номера по порядку");
    assert.ok(set.version !== c.version, "версия объекта изменилась");
    const same = await put(c.uid, 9, {});
    assert.eq(at(same, 9).name, "Ворота", "без имени — положение, имя прежнее");
    const blank = await put(c.uid, 9, { name: "" });
    assert.eq(nn(at(blank, 9)), { n: 9, name: "" }, "пустое снимает подпись, запись остаётся");
    const made8 = await put(c.uid, 8, { name: "" });
    assert.eq(nn(at(made8, 8)), { n: 8, name: "" }, "PUT {name} создаёт запись, пустое имя тоже");
    assert.status(await env.call("PUT", `${U(c.uid)}/presets/${c.properties.presetMax + 1}`, {}), 404, "NOT_FOUND", "выше предела");
    assert.status(await env.call("DELETE", `${U(c.uid)}/presets/${c.properties.presetMax + 1}`), 404, "NOT_FOUND", "и удаление");
    await env.ok("DELETE", `${U(c.uid)}/presets/8`);
    const gone = await env.ok("DELETE", `${U(c.uid)}/presets/9`);
    assert.eq(presets(gone).length, was, "снимает запись только DELETE");
    assert.eq(presets(await env.ok("DELETE", `${U(c.uid)}/presets/9`)).length, was, "записи нет — отказа нет");
    const op = (await env.ok("GET", "/operations")).items[0];
    assert.eq(op.single && op.items[0].targetId, c.uid, "правка пресетов — в стопке отката");
    const flat = (await env.pages("/units?kind=camera&limit=1000")).find((u) => !u.properties.ptz);
    field(await env.call("PUT", `${U(flat.uid)}/presets/1`, {}), "NOT_SUPPORTED", P("ptz"), "без PTZ");
    assert.eq(presets(await put(flat.uid, 1, { name: "Без PTZ" }))[0].name, "Без PTZ", "имя ptz не судит");
    assert.status(await env.call("PUT", `${U(flat.uid)}/presets/1`, { name: "" }), 200);
    assert.eq(presets(await env.ok("DELETE", `${U(flat.uid)}/presets/1`)).length, 0, "DELETE снимает запись и без ptz");
    kindNo(await env.call("PUT", `${U(FX.devices.find((d) => d.type === "det").id)}/presets/1`, {}), "вид без vms.ptz/1");
    const offline = await env.ok("POST", "/test/events", { type: "device.signal", deviceId: c.uid, online: false });
    assert.eq(offline.applied, true, "камера без связи");
    assert.status(await env.call("PUT", `${U(c.uid)}/presets/7`, {}), 409, "DEVICE_OFFLINE", "положение судит связь");
    assert.status(await env.call("PUT", `${U(c.uid)}/presets/7`, { name: "Ночь" }), 200);
    assert.status(await env.call("DELETE", `${U(c.uid)}/presets/7`), 200);
  }, { needs: ["putUnitPreset", "deleteUnitPreset", "implements:vms.ptz/1"] });

  test("Аренда PTZ: срок от ttlSec, продление, стоп, скорости от -1 до 1", async () => {
    const env = await makeEnv();
    const c = await ptzCam(env);
    const a = await env.ok("PUT", `${U(c.uid)}/ptz`, { pan: 0.5, tilt: -0.5, ttlSec: 3 });
    assert.ok(Date.parse(a.expiresAt) > 0, "срок");
    assert.status(await env.call("PUT", `${U(c.uid)}/ptz`, { pan: 2, ttlSec: 3 }), 422, "VALIDATION_FAILED", "скорость вне диапазона");
    assert.status(await env.call("PUT", `${U(c.uid)}/ptz`, { zoom: 1 }), 422, "VALIDATION_FAILED", "срок обязателен");
    assert.status(await env.call("DELETE", `${U(c.uid)}/ptz`), 204);
    assert.status(await env.call("DELETE", `${U(c.uid)}/ptz`), 204, null, "аренды нет — тоже стоп");
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: c.uid, online: false, fault: "conn" });
    assert.status(await env.call("PUT", `${U(c.uid)}/ptz`, { pan: 1, ttlSec: 1 }), 409, "DEVICE_OFFLINE", "без связи");
  }, { needs: ["putUnitPtz", "deleteUnitPtz", "implements:vms.ptz/1"] });

  test("PTZ выключен (ptzEnabled: false) — аренда и положение пресета 422 field /properties/ptzEnabled; телеметрия через порт хранится", async () => {
    const env = await makeEnv();
    const c = await ptzCam(env);
    const srv = (await env.pages("/units?kind=server&limit=10"))[0];
    const r = await patch(env, c, { properties: { ptzEnabled: false, ptzSource: "port", ptzPort: { unitId: srv.uid, port: "COM1" }, ptzProtocol: "Pelco-D", ptzAddress: 3 } });
    assert.status(r, 200);
    const off = r.body;
    assert.eq([off.properties.ptzEnabled, off.properties.ptzSource, off.properties.ptzPort, off.properties.ptzAddress], [false, "port", { unitId: srv.uid, port: "COM1" }, 3], "поля телеметрии хранятся");
    field(await env.call("PUT", `${U(c.uid)}/ptz`, { pan: 0.5, ttlSec: 3 }), "NOT_SUPPORTED", P("ptzEnabled"), "аренда при выключенном");
    field(await env.call("PUT", `${U(c.uid)}/presets/1`, {}), "NOT_SUPPORTED", P("ptzEnabled"), "положение при выключенном");
    assert.status(await env.call("PUT", `${U(c.uid)}/presets/1`, { name: "Вход" }), 200, null, "подпись пресета — правка, ptzEnabled её не судит");
    assert.status(await patch(env, await get(env, c.uid), { properties: { ptzAddress: 256 } }), 422, "VALIDATION_FAILED", "адрес до 255");
    const on = await patch(env, await get(env, c.uid), { properties: { ptzEnabled: true } });
    assert.status(on, 200);
    assert.ok(Date.parse((await env.ok("PUT", `${U(c.uid)}/ptz`, { pan: 0.5, ttlSec: 3 })).expiresAt) > 0, "включён — аренда снова есть");
  }, { needs: ["patchUnit", "putUnitPtz", "putUnitPreset", "implements:vms.ptz/1", "kind:server"], layer: "profile:vms.ptz/1", since: "1.1" });

  test("Пресет: savedOnDevice и записанное положение (pan, tilt, zoom); диафрагма в аренде движения", async () => {
    const env = await makeEnv();
    const c = await ptzCam(env);
    const at = (r, n) => presets(r).find((x) => x.n === n);
    const inRange = (p) => ["pan", "tilt"].every((k) => p[k] == null || (p[k] >= -1 && p[k] <= 1)) && (p.zoom == null || (p.zoom >= 0 && p.zoom <= 1));
    // Только имя: положение не записано — savedOnDevice не true, положения нет
    const named = at(await env.ok("PUT", `${U(c.uid)}/presets/9`, { name: "Только имя" }), 9);
    assert.ok(named.savedOnDevice !== true && named.pan == null, "запись только с именем — без положения");
    // Движение с диафрагмой: поле iris принимается, вне диапазона — отказ
    assert.ok(Date.parse((await env.ok("PUT", `${U(c.uid)}/ptz`, { pan: 0.5, iris: 0.5, ttlSec: 3 })).expiresAt) > 0, "iris в аренде");
    assert.status(await env.call("PUT", `${U(c.uid)}/ptz`, { iris: 2, ttlSec: 3 }), 422, "VALIDATION_FAILED", "iris вне диапазона");
    await env.advance(2);
    assert.status(await env.call("DELETE", `${U(c.uid)}/ptz`), 204);
    // Запомнить положение: savedOnDevice true, имя прежнее, положение в диапазоне
    const saved = at(await env.ok("PUT", `${U(c.uid)}/presets/9`, {}), 9);
    assert.eq([saved.name, saved.savedOnDevice], ["Только имя", true], "положение записано, имя прежнее");
    assert.ok(inRange(saved), "pan, tilt от -1 до 1, zoom от 0 до 1");
    // Подпись не трогает положение
    const renamed = at(await env.ok("PUT", `${U(c.uid)}/presets/9`, { name: "Вход 2" }), 9);
    assert.eq([renamed.savedOnDevice, renamed.pan, renamed.tilt, renamed.zoom], [saved.savedOnDevice, saved.pan, saved.tilt, saved.zoom], "имя не меняет положение");
    await env.ok("DELETE", `${U(c.uid)}/presets/9`);
  }, { needs: ["putUnitPreset", "deleteUnitPreset", "putUnitPtz", "deleteUnitPtz", "clock", "implements:vms.ptz/1"], layer: "profile:vms.ptz/1", since: "1.2" });

  test("Туры PTZ (tours): сохранить, изменить, удалить; повтор id, второй тур с idleStartSec и пределы камеры — 422 field /properties/tours", async () => {
    const env = await makeEnv();
    const c = await ptzCam(env);
    const st = (preset, dwellSec, speed) => Object.assign({ preset, dwellSec }, speed ? { speed } : {});
    const a = { id: "a", name: "Вход и двор", steps: [st(1, 10, 50), st(2, 15)], order: "seq", pauseSec: 5, onManual: "pause", resumeSec: 20, resumeFrom: "first", idleStartSec: 120 };
    const r = await patch(env, c, { properties: { tours: [a] } });
    assert.status(r, 200);
    assert.eq(r.body.properties.tours, [a], "тур хранится как есть");
    const b = { id: "b", name: "Ночь", steps: [st(2, 30, 100)], onManual: "stop" };
    const two = await patch(env, r.body, { properties: { tours: [a, b] } });
    assert.status(two, 200);
    assert.eq(two.body.properties.tours.map((t) => t.id), ["a", "b"], "второй тур добавлен, порядок как в запросе");
    // Смысл туров (reason) — поле /properties/tours; ошибка схемы — путь до самого поля внутри tours
    const bad = async (tours, reason, msg, at) => {
      const res = await patch(env, await get(env, c.uid), { properties: { tours } });
      if (reason) { field(res, "VALIDATION_FAILED", P("tours"), msg); assert.eq(res.body.params && res.body.params.reason, reason, `${msg}: причина`); return; }
      field(res, "VALIDATION_FAILED", P(`tours/${at}`), msg);
    };
    await bad([a, Object.assign({}, b, { id: "a" })], "duplicateId", "повтор id");
    await bad([a, Object.assign({}, b, { idleStartSec: 60 })], "idleTwice", "второй тур с запуском без оператора");
    const cur = (await get(env, c.uid)).properties;
    if (cur.tourStepsMax != null) await bad([Object.assign({}, b, { steps: Array.from({ length: cur.tourStepsMax + 1 }, (_, i) => st(1 + (i % 2), 5)) })], "tourStepsMax", "точек больше предела");
    if (cur.tourMax != null) await bad(Array.from({ length: cur.tourMax + 1 }, (_, i) => Object.assign({}, b, { id: `t${i}` })), "tourMax", "туров больше предела");
    await bad([Object.assign({}, b, { steps: [{ preset: 1 }] })], null, "точка без dwellSec", "0/steps/0/dwellSec");
    await bad([Object.assign({}, b, { onManual: "resume" })], null, "onManual вне перечня", "0/onManual");
    const one = await patch(env, await get(env, c.uid), { properties: { tours: [Object.assign({}, b, { name: "Ночь, долго" })] } });
    assert.status(one, 200);
    assert.eq(one.body.properties.tours, [Object.assign({}, b, { name: "Ночь, долго" })], "тур изменён, тур a удалён");
    const none = await patch(env, one.body, { properties: { tours: [] } });
    assert.eq(none.body.properties.tours, [], "пустой список — туров нет");
  }, { needs: ["patchUnit", "implements:vms.ptz/1"], layer: "profile:vms.ptz/1", since: "1.3" });

  /* ===== Источник событий ===== */

  const pos = (over) => ({ kind: "eventsrc", name: "Касса", domainId: d1.id, properties: Object.assign({ vendor: "PosXml", model: "PosXml Device", ip: "10.3.3.3", port: 2600 }, over) });

  test("Источник: 0.0.0.0 и :: — 422 field: /properties/ip; без сервера выбирает система и предупреждает; второй на порт не запустится", async () => {
    const env = await makeEnv();
    assert.eq(await failedOf(env, pos({ ip: "0.0.0.0" })), [["VALIDATION_FAILED", P("ip")]], "все адреса");
    assert.eq(await failedOf(env, pos({ ip: "::" })), [["VALIDATION_FAILED", P("ip")]], "и в IPv6");
    const [a] = await made(env, pos());
    assert.ok(a.properties.serverId && obs(a).faultText, "сервер выбран, предупреждение есть");
    field(await props(env, a, { ip: "::" }), "VALIDATION_FAILED", P("ip"), "и при правке");
    const s = FX.servers.find((x) => x.allocated && x.online && x.id !== a.properties.serverId) || FX.servers.find((x) => x.id === a.properties.serverId);
    const [b] = await made(env, pos({ serverId: a.properties.serverId }));
    assert.eq([b.status.link, /занят/.test(obs(b).faultText)], ["offline", true], "второй на порт — причина в состоянии");
    const moved = await env.ok("PATCH", U(a.uid), { properties: { serverId: s.id } }, v(a));
    assert.eq(moved.properties.serverId, s.id, "сервер источника — свойство");
  }, { needs: ["createUnits", "patchUnit", "kind:eventsrc"] });

  test("Правило: событие text у источника, уточнение по слову; номера нет", async () => {
    const env = await makeEnv();
    const kinds = (await env.ok("GET", "/kinds")).items;
    const has = kinds.filter((k) => (k.events || []).some((e) => e.id === "text")).map((k) => k.kind);
    const e = kinds.find((k) => k.kind === "eventsrc").events.find((x) => x.id === "text");
    assert.eq([has, Object.keys(e.params.properties)], [["eventsrc"], ["word"]], "событие — у вида источника");
  }, { needs: ["kind:eventsrc"] });

  /* ===== Единицы СКУД ===== */

  const opsOf = (u) => u.properties.operations || obs(u).operations || [];
  const acs = async (env) => {
    const list = await env.pages("/units?limit=1000");
    return { list, root: list.find((u) => u.kind === "acfa" && !u.parentId), lock: list.find((u) => u.kind === "acfa_lock" && opsOf(u).length) };
  };
  const unitRow = (kind, name, properties, parent, over) => Object.assign({ kind, name, parentId: parent.uid, properties }, over);
  const inAcs = { needs: ["createUnits", "patchUnit", "implements:vms.acs/1"] };

  test("Единица СКУД: шаблон из unitOptions, адрес path, правка model — 422; в папку нельзя; родитель — acfa, камера, ipsrv", async () => {
    const env = await makeEnv();
    const { root, list } = await acs(env);
    const [d] = await made(env, unitRow("acfa_lock", "Дверь", { model: "tmpl.door", path: "door/9" }, root));
    assert.eq([d.properties.model, d.properties.path], ["tmpl.door", "door/9"], "создана");
    field(await props(env, d, { model: "tmpl.zone" }), "VALIDATION_FAILED", P("model"), "шаблон не правится");
    assert.eq((await env.ok("PATCH", U(d.uid), { properties: { path: "door/10", properties: { mode: "locked" } } }, v(d))).properties.path, "door/10", "адрес правится");
    assert.eq(await failedOf(env, unitRow("acfa_lock", "Нет шаблона", { model: "нет" }, root)), [["VALIDATION_FAILED", P("model")]], "шаблона нет");
    const f = FX.folders.find((x) => x.domainId === root.domainId);
    assert.eq((await failedOf(env, unitRow("acfa_sensor", "В папку", {}, root, { folders: [f.id] })))[0], ["NOT_SUPPORTED", "/folders"], "папки нет");
    const cam1 = list.find((x) => x.kind === "camera");
    await made(env, unitRow("acfa_sensor", "Считыватель", {}, cam1));
    const ip = list.find((x) => x.kind === "ipsrv" && !obs(x).derived);
    await made(env, unitRow("acfa_lock", "Замок", {}, ip));
    const sensor = list.find((x) => x.kind === "sensor");
    assert.eq(await failedOf(env, unitRow("acfa_lock", "Нельзя", {}, sensor)), [["PARENT_MISMATCH", "/parentId"]], "под датчиком — нет");
  }, inAcs);

  test("Реле: в СКУД заводит оператор, вне СКУД — 422; контроллер: acfa с родителем, без своего подключения, снимается с вложенным", async () => {
    const env = await makeEnv();
    const { root, lock, list } = await acs(env);
    await made(env, unitRow("relay", "Реле двери", { path: "r/1" }, lock));
    const cam1 = list.find((x) => x.kind === "camera");
    assert.eq(await failedOf(env, unitRow("relay", "Реле", {}, cam1)), [["NOT_SUPPORTED", "/kind"]], "под камерой — находка сервера");
    assert.eq(await failedOf(env, unitRow("acfa", "Контроллер", { ip: "10.0.0.5" }, root)), [["NOT_SUPPORTED", P("ip")]], "адреса нет");
    const [c] = await made(env, unitRow("acfa", "Контроллер", { path: "c/1" }, root));
    field(await props(env, c, { vendor: "x" }), "NOT_SUPPORTED", P("vendor"), "подключения нет");
    const [kid] = await made(env, unitRow("acfa_lock", "Дверь", {}, c));
    assert.status(await env.call("DELETE", U(c.uid), undefined, v(c)), 204);
    assert.status(await env.call("GET", U(kid.uid)), 404, "NOT_FOUND", "вложенное снято");
  }, inAcs);

  test("Команда единицы: выполняется; нет у единицы — 409 DEVICE_REFUSED; нет у вида — 404, у реле замка on — 409 DEVICE_REFUSED; без связи — 409 DEVICE_OFFLINE", async () => {
    // Замок, у которого из команд вида осталась одна: остальные объявлены видом, но у единицы их нет (шаблон)
    const lock0 = FX.devices.find((d) => d.type === "acfa_lock" && (d.operations || []).length > 1);
    const env = await makeEnv({ fixturePatch: { devices: FX.devices.map((d) => (d.id === lock0.id ? Object.assign({}, d, { operations: d.operations.slice(0, 1) }) : d)) } });
    const lock = await get(env, lock0.id);
    const run = (uid, id) => env.call("POST", `${U(uid)}/actions/${id}`, {});
    assert.eq(opsOf(lock), lock0.operations.slice(0, 1), "у единицы одна команда");
    const ok = await run(lock.uid, opsOf(lock)[0]);
    assert.status(ok, 200);
    assert.eq(ok.body.result.done, true, "выполнено");
    // Команды вида — из описания (ActionDescriptor); у этой единицы — свои из шаблона (operations)
    const declared = ((await env.ok("GET", "/kinds/acfa_lock")).actions || []).map((a) => a.id);
    const missing = declared.find((id) => !opsOf(lock).includes(id));
    assert.ok(missing, `у вида есть команда, которой нет у единицы: ${declared}`);
    const no = await run(lock.uid, missing);
    assert.status(no, 409, "DEVICE_REFUSED", "у единицы такой команды нет");
    assert.eq([no.body.params.reason, no.body.params.operation], ["noOperation", missing], "причина");
    assert.status(await run(lock.uid, "fly"), 404, "NOT_FOUND", "у вида такой команды нет");
    // Реле: у вида одна команда output, другая — 404 до хука, если и реле её своей не называет
    const relay = await ofKind(env, "relay");
    assert.status(await run(relay.uid, "open"), 404, "NOT_FOUND", "у реле команд СКУД нет");
    // Реле под замком называет своими on/off (operations шаблона), а вид их не описывает: устройство отказывает — как база
    // /devices/{id}/operations/on: 409 DEVICE_REFUSED noOperation, не 404
    const lockRelay = FX.devices.find((d) => d.type === "relay" && (d.operations || []).some((x) => x !== "output"));
    if (lockRelay) {
      const op = lockRelay.operations.find((x) => x !== "output");
      const res = await run(lockRelay.id, op);
      assert.status(res, 409, "DEVICE_REFUSED", "реле замка: «Включить»");
      assert.eq([res.body.params.reason, res.body.params.operation], ["noOperation", op], "причина");
    }
    const cam1 = await ofKind(env, "camera");
    assert.status(await run(cam1.uid, "open"), 404, "NOT_FOUND", "у камеры команд СКУД нет");
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: lock.uid, online: false, fault: "conn" });
    assert.status(await run(lock.uid, opsOf(lock)[0]), 409, "DEVICE_OFFLINE");
  }, { needs: ["runUnitAction", "getKind", "kind:acfa_lock"] });

  test("Камера за NAT: правка путём ядра отложена — 409 SERVER_OFFLINE с kept; применяется по часам, событие — с видом camera", async () => {
    const id = "39999999-0000-4000-8000-000000000000";
    const w2c = { id, type: "camera", parentId: null, domainId: d1.id, name: "Камера w2c", online: true, enabled: true, direct: false, writableFields: ["name", "enabled"], version: "1" };
    const env = await makeEnv({ fixturePatch: { devices: FX.devices.concat(w2c) } });
    if (!env.frozen) return "часы системы не остановить: срок отложенной правки не промотать";
    const before = await get(env, id);
    const first = await env.call("PATCH", U(id), { name: "Новое имя" }, v(before));
    assert.status(first, 409, "SERVER_OFFLINE", "принята, срок вышел");
    assert.ok(first.body.params.kept, "имя отложенной правки");
    assert.eq((await get(env, id)).name, before.name, "ещё не применена");
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.type === "entity.changed" && m.entityId === id && seen.push(m.kind), [id]);
    await ApiTest.settle();
    await env.advance(61);
    const done = await get(env, id);
    await ApiTest.settle();
    stop();
    assert.eq(done.name, "Новое имя", "применена с периодом камеры");
    assert.ok(seen.length > 0 && seen.every((k) => k === "camera"), `entity.changed — вид camera, не device: ${seen}`);
  }, { needs: ["patchUnit"] });

  test("Правило: действие unit с operation, событие unit с word; output на реле двери — 422 NOT_SUPPORTED", async () => {
    const env = await makeEnv();
    const lockKind = await env.ok("GET", "/kinds/acfa_lock");
    assert.ok(lockKind.events.some((x) => x.id === "unit") && lockKind.actions.some((x) => x.id === "unit" && x.ruleAction && x.ruleOnly), "объявлены у вида единицы");
    const { list } = await acs(env);
    const by = new Map(list.map((u) => [u.uid, u]));
    const relay = list.find((u) => u.kind === "relay" && by.get(u.parentId)?.kind === "acfa_lock");
    const cur = (await env.list("/rules"))[0];
    const CONTENT = ["name", "enabled", "logOnly", "logOnlySince", "start", "runMode", "operatorMenu", "ratePerMinute", "windowSec", "runAt", "repeat", "triggers", "conditions", "steps", "owner", "purpose", "serverId", "runAsRoleId", "allowChain"];
    const body = (steps) => Object.assign(Object.fromEntries(CONTENT.map((k) => [k, cur[k]])), { steps });
    const target = { include: [{ uid: relay.uid }], exclude: [], gone: [], fromEvent: false };
    const res = await env.call("PUT", `/rules/${cur.id}`, body([{ type: "unitAction", action: "output", target, params: { state: true, pulseMs: 500 } }]), { "If-Match": `"${cur.version}"` });
    assert.status(res, 422, "NOT_SUPPORTED", "команда идёт операцией");
    await env.ok("PUT", `/rules/${cur.id}`, body([{ type: "unitAction", action: "unit", target, params: { operation: "on" } }]), { "If-Match": `"${cur.version}"` });
  }, { needs: ["implements:vms.acs/1"] });

  /* ===== Профиль при добавлении ===== */

  test("Профиль при добавлении: разовый выбор (x-transient), в объекте его нет; default — умолчания; template — копия с камеры той же модели", async () => {
    const env = await makeEnv();
    const [cur] = await made(env, newCam({ configMode: "current" }));
    assert.eq([cur.properties.configMode, cur.properties.res], [undefined, undefined], "current: ничего не меняет, в ответе поля нет");
    const bad = await props(env, cur, { configMode: "default" });
    field(bad, "VALIDATION_FAILED", P("configMode"), "PATCH");
    assert.eq(bad.body.params.keyword, "x-immutable", "только при создании");
    const [def] = await made(env, newCam({ configMode: "default" }));
    assert.ok(def.properties.res && def.properties.fps, "default: умолчания модели");
    assert.eq(await failedOf(env, { kind: "camera", name: "Только адрес", domainId: d1.id, properties: { rtspUrl: "rtsp://1", configMode: "default" } }), [["VALIDATION_FAILED", P("configMode")]], "без модели — нельзя");
    const [src, srcStreams] = await camWith(env, (u, st) => st.length > 1 && u.properties.vendor && u.properties.model && !u.parentId);
    const [good] = await made(env, newCam({ vendor: src.properties.vendor, model: src.properties.model, configMode: "template", templateId: src.uid }));
    const gp = good.properties;
    assert.eq([gp.res, gp.fps, (await streamsOf(env, good.uid)).length, gp.templateId], [src.properties.res, src.properties.fps, srcStreams.length, undefined], "копия потоков, связи нет");
    assert.ok(gp.ip !== src.properties.ip && good.name !== src.name && !gp.recordDetectorIds, "адрес, имя, записи не копируются");
    assert.eq(await failedOf(env, newCam({ model: "Другая", configMode: "template", templateId: src.uid })), [["VALIDATION_FAILED", P("templateId")]], "другая модель");
    assert.eq(await failedOf(env, newCam({ configMode: "template" })), [["VALIDATION_FAILED", P("templateId")]], "нет источника");
  }, { needs: ["createUnits", "patchUnit", "kind:camera"] });

  /* ----- Источник событий (vms.pos/1, контракт 0.5.0): камеры титров, вид титров, разбор чека, приём данных, строки от кассы ----- */

  const posTest = (name, fn, more) => test(name, fn, { needs: ["kind:eventsrc", "implements:vms.pos/1", "patchUnit", "createUnits"].concat(more || []) });
  const area = (x, y, w, h) => ({ x, y, w, h });
  const posCams = async (env) => (await env.list("/units?kind=camera&limit=1000")).filter((u) => !u.parentId).slice(0, 3);
  const posSrc = (env) => ofKind(env, "eventsrc");

  posTest("Источник событий: несколько камер титров, cameraId (устарело) — первая камера списка", async () => {
    const env = await makeEnv();
    const [a, b, c] = await posCams(env);
    const kind = await env.ok("GET", "/kinds/eventsrc");
    assert.ok(kind.schema.properties.cameraId.deprecated === true && /overlays/.test(kind.schema.properties.cameraId.description), "cameraId помечен устаревшим, описание называет overlays");
    let src = await posSrc(env);
    const list = [{ cameraId: a.uid, area: area(0.1, 0.2, 0.5, 0.4) }, { cameraId: b.uid, area: area(0, 0, 1, 0.3) }];
    src = await env.ok("PATCH", U(src.uid), { properties: { overlays: list } }, v(src));
    assert.eq([src.properties.overlays, src.properties.cameraId], [list, a.uid], "список принят, cameraId — первая камера");
    src = await env.ok("PATCH", U(src.uid), { properties: { cameraId: c.uid } }, v(src));
    assert.eq(src.properties.overlays.map((o) => o.cameraId), [c.uid, b.uid], "cameraId заменил первую камеру, вторая осталась");
    assert.eq(src.properties.overlays[0].area, list[0].area, "камера берёт зону прежней первой");
    src = await env.ok("PATCH", U(src.uid), { properties: { cameraId: b.uid } }, v(src));
    assert.eq(src.properties.overlays.map((o) => o.cameraId), [b.uid], "камера, что уже была в списке, встала первой без повтора");
    assert.eq(src.properties.overlays[0].area, list[0].area, "и взяла зону прежней первой, а не свою");
    field(await props(env, src, { cameraId: src.uid }), "VALIDATION_FAILED", P("cameraId"), "cameraId не камеры");
    src = await env.ok("PATCH", U(src.uid), { properties: { cameraId: a.uid, overlays: [{ cameraId: c.uid, area: area(0, 0, 0.5, 0.5) }] } }, v(src));
    assert.eq([src.properties.overlays.map((o) => o.cameraId), src.properties.cameraId], [[c.uid], c.uid], "оба поля в правке — действует overlays");
    src = await env.ok("PATCH", U(src.uid), { properties: { cameraId: null } }, v(src));
    assert.eq([src.properties.overlays, src.properties.cameraId], [[], null], "cameraId: null очищает список");
    const bad = (properties, msg) => patch(env, src, { properties }).then((res) => field(res, "VALIDATION_FAILED", P("overlays"), msg));
    await bad({ overlays: [list[0], list[0]] }, "камера дважды");
    await bad({ overlays: [{ cameraId: a.uid, area: area(0.6, 0, 0.5, 0.5) }] }, "зона за кадром по x");
    await bad({ overlays: [{ cameraId: a.uid, area: area(0, 0.9, 0.5, 0.2) }] }, "зона за кадром по y");
    await bad({ overlays: [{ cameraId: src.uid, area: area(0, 0, 0.5, 0.5) }] }, "не камера");
    assert.status(await props(env, src, { overlays: [{ cameraId: a.uid, area: area(0, 0, 0, 0.5) }] }), 422, "VALIDATION_FAILED", "ширина 0");
    assert.status(await props(env, src, { overlays: [{ cameraId: a.uid }] }), 422, "VALIDATION_FAILED", "нет зоны");
    const [fresh] = await made(env, newCam({}));
    src = await env.ok("PATCH", U(src.uid), { properties: { overlays: [{ cameraId: fresh.uid, area: area(0, 0, 0.5, 0.5) }, list[0]] } }, v(src));
    const about = async (cam) => (await env.ok("GET", `/journal?deviceId=${cam}&limit=100`)).items.filter((e) => e.deviceId === src.uid).map((e) => e.text);
    await env.ok("POST", "/test/events", { type: "journal.event", deviceId: src.uid, event: { text: "Чек 1", kind: "text", source: "pos" } });
    assert.eq([(await about(fresh.uid)).includes("Чек 1"), (await about(a.uid)).includes("Чек 1")], [true, true], "событие источника видно по каждой камере списка");
    await env.ok("DELETE", U(fresh.uid), undefined, v(fresh));
    await env.ok("POST", "/test/events", { type: "journal.event", deviceId: src.uid, event: { text: "Чек 2", kind: "text", source: "pos" } });
    assert.eq(((await env.ok("GET", "/journal?limit=200")).items.find((e) => e.text === "Чек 2") || {}).cameraId, a.uid, "после удаления первой камеры событие несёт следующую");
    src = await get(env, src.uid);
    assert.eq([src.properties.overlays.map((o) => o.cameraId), src.properties.cameraId], [[a.uid], a.uid], "удалённая камера снята из списка, cameraId — следующая");
    const [created] = await made(env, { kind: "eventsrc", name: "POS — тест", domainId: d1.id, properties: { ip: "10.9.9.10", port: 2600, cameraId: a.uid } });
    assert.eq(created.properties.overlays.map((o) => o.cameraId), [a.uid], "создан со старым cameraId — список из одной камеры");
  });

  posTest("Источник событий: вид титров, разбор чека, флажки слов — хранятся, границы значений", async () => {
    const env = await makeEnv();
    let src = await posSrc(env);
    const set = { overlayFont: "Consolas", overlayFontSize: 14, overlayColor: "#ffee00", overlayBg: "#001122", overlayBgTransparency: 60,
      receiptStartWords: ["ЧЕК"], receiptEndWords: ["ИТОГО", "СПАСИБО"], receiptSplit: "none", ignoreCase: false, billsOnly: true, eraseOnEnd: true,
      overlayDurationSec: 0, words: [{ msg: "ОТМЕНА", color: "#ff4444", bg: "#000000", caseSensitive: true, wholeLine: true, bgEnabled: false }] };
    src = await env.ok("PATCH", U(src.uid), { properties: set }, v(src));
    assert.eq(Object.keys(set).map((k) => src.properties[k]), Object.values(set), "всё сохранено и читается как записано");
    const cases = [["overlayFontSize", 5], ["overlayFontSize", 73], ["overlayColor", "red"], ["overlayBg", "#12345"], ["overlayBgTransparency", 101], ["overlayBgTransparency", -1],
      ["receiptSplit", "both"], ["receiptStartWords", [""]], ["receiptStartWords", [1]], ["ignoreCase", "yes"], ["overlayDurationSec", -1],
      ["words", [{ msg: "A", wholeLine: "да" }]], ["words", [{ msg: "A", other: 1 }]]];
    for (const [name, value] of cases) field(await props(env, src, { [name]: value }), "VALIDATION_FAILED", name === "words" ? P("words/0/" + Object.keys(value[0]).find((k) => k !== "msg")) : name === "receiptStartWords" ? P("receiptStartWords/0") : P(name), `${name} = ${JSON.stringify(value)}`);
    assert.status(await props(env, src, { receiptStartWords: Array.from({ length: 33 }, (_, i) => `w${i}`) }), 422, "VALIDATION_FAILED", "больше 32 слов");
    src = await env.ok("PATCH", U(src.uid), { properties: { overlayDurationSec: null, receiptEndWords: null } }, v(src));
    assert.eq([src.properties.overlayDurationSec, src.properties.receiptEndWords], [undefined, undefined], "null снимает значение");
  });

  posTest("Источник событий: приём данных — RS-232 требует порт и скорость, чужие поля в той же правке — 422, при смене протокола прежние поля снимаются", async () => {
    const env = await makeEnv();
    let src = await posSrc(env);
    assert.status(await props(env, src, { protocol: "rs232" }), 422, "VALIDATION_FAILED", "rs232 без comPort и baudRate");
    assert.status(await props(env, src, { protocol: "rs232", comPort: "COM3" }), 422, "VALIDATION_FAILED", "rs232 без baudRate");
    src = await env.ok("PATCH", U(src.uid), { properties: { protocol: "rs232", comPort: "COM3", baudRate: 19200, parity: "even", encoding: "dos2win" } }, v(src));
    assert.eq([src.properties.comPort, src.properties.baudRate, src.properties.parity, src.properties.encoding], ["COM3", 19200, "even", "dos2win"], "RS-232 сохранён");
    src = await env.ok("PATCH", U(src.uid), { properties: { protocol: "tcp" } }, v(src));
    assert.eq(["comPort", "baudRate", "parity"].map((k) => src.properties[k]), [undefined, undefined, undefined], "при смене протокола поля RS-232 сняты");
    field(await props(env, src, { comPort: "COM1" }), "VALIDATION_FAILED", P("comPort"), "comPort у tcp");
    field(await props(env, src, { protocol: "udp", parity: "odd" }), "VALIDATION_FAILED", P("parity"), "parity у udp");
    field(await props(env, src, { udpMaxPacket: 1024 }), "VALIDATION_FAILED", P("udpMaxPacket"), "udpMaxPacket у tcp");
    src = await env.ok("PATCH", U(src.uid), { properties: { protocol: "udp", udpMaxPacket: 1024 } }, v(src));
    assert.eq(src.properties.udpMaxPacket, 1024, "udpMaxPacket у udp");
    src = await env.ok("PATCH", U(src.uid), { properties: { protocol: "tcp" } }, v(src));
    assert.eq(src.properties.udpMaxPacket, undefined, "udpMaxPacket снят вместе с udp");
    for (const [name, value] of [["protocol", "serial"], ["baudRate", 1234], ["encoding", "koi8"], ["udpMaxPacket", 0], ["parserFile", "шаблон.xml"], ["processing", "xml"], ["timeoutMs", 5], ["timeoutMs", 3001], ["timeOffsetMs", 5001], ["retalix", 1]])
      field(await props(env, src, { [name]: value }), "VALIDATION_FAILED", P(name), `${name} = ${JSON.stringify(value)}`);
    const ok = { terminalType: "XML PROTOCOL", parserFile: "pos_kassa3.prl", processing: "event", timeoutMs: 250, timeOffsetMs: -300, retalix: true };
    src = await env.ok("PATCH", U(src.uid), { properties: ok }, v(src));
    assert.eq(Object.keys(ok).map((k) => src.properties[k]), Object.values(ok), "разбор данных хранится как записан");
    const [made1] = await made(env, { kind: "eventsrc", name: "POS — RS-232", domainId: d1.id, properties: { vendor: "POSLegacy", protocol: "rs232", comPort: "COM1", baudRate: 9600 } });
    assert.eq(made1.properties.protocol, "rs232", "создан с RS-232");
    assert.eq(await failedOf(env, { kind: "eventsrc", name: "POS — без порта", domainId: d1.id, properties: { vendor: "POSLegacy", protocol: "rs232" } }).then((x) => x[0][0]), "VALIDATION_FAILED", "создание rs232 без comPort");
  });

  posTest("Источник событий: последние сырые строки кассы — порядок, limit, кладёт POST /test/events", async () => {
    const env = await makeEnv();
    const src = await posSrc(env);
    const raw = (q) => env.ok("GET", `${U(src.uid)}/pos/raw${q || ""}`);
    const first = (await raw()).items;
    assert.ok(first.length > 0 && first.every((x) => typeof x.text === "string" && !Number.isNaN(Date.parse(x.at))), "у каждой строки at и text");
    assert.ok(first.every((x, i) => !i || Date.parse(x.at) >= Date.parse(first[i - 1].at)), "от старых к новым");
    assert.eq((await raw("?limit=3")).items, first.slice(-3), "limit — последние строки");
    await env.ok("POST", "/test/events", { type: "pos.raw", deviceId: src.uid, text: "ЧЕК 777  ИТОГО 10,00" });
    const last = (await raw("?limit=1")).items[0];
    assert.eq(last.text, "ЧЕК 777  ИТОГО 10,00", "подложенная строка — последняя");
    await env.ok("POST", "/test/events", { type: "pos.raw", deviceId: src.uid, text: "Старая", at: "2020-01-01T00:00:00Z" });
    const ord = (await raw("?limit=200")).items;
    assert.eq([ord[0].text, ord.at(-1).text, ord.length], ["Старая", "ЧЕК 777  ИТОГО 10,00", 2], "первая подложенная строка начала список с пустого (пример чека не хранится); строка со старым at — в начало");
    await env.ok("POST", "/test/events", { type: "pos.raw", deviceId: src.uid, clear: true });
    assert.eq((await raw()).items, [], "clear: true — строк нет, примера чека нет");
    for (let i = 0; i < 210; i++) await env.ok("POST", "/test/events", { type: "pos.raw", deviceId: src.uid, text: `строка ${i}` });
    const kept = (await raw("?limit=200")).items;
    assert.eq([kept.length, kept[0].text, kept[199].text], [200, "строка 10", "строка 209"], "сервер хранит последние 200 строк");
    for (const q of ["?limit=0", "?limit=201", "?limit=abc"]) field(await env.call("GET", `${U(src.uid)}/pos/raw${q}`), "VALIDATION_FAILED", "/limit", `limit${q}`);
    field(await env.call("POST", "/test/events", { type: "pos.raw", deviceId: src.uid, text: "" }), "VALIDATION_FAILED", "text", "пустая строка");
    const [camera] = await posCams(env);
    field(await env.call("GET", `${U(camera.uid)}/pos/raw`), "NOT_SUPPORTED", "/kind", "камера не источник событий");
    field(await env.call("POST", "/test/events", { type: "pos.raw", deviceId: camera.uid, text: "x" }), "NOT_SUPPORTED", "/kind", "строку камере не подложить");
    assert.status(await env.call("GET", `${U("30009999-0000-4000-8000-000000000000")}/pos/raw`), 404, "NOT_FOUND", "нет объекта");
  }, ["listUnitPosRaw"]);

  test("Метки, тревожные виды, строка записи: хранятся; состояние только чтение", async () => {
    const env = await makeEnv();
    const c = (await env.pages("/units?kind=camera&limit=1000")).find((u) => u.properties.archiveId);
    const res = await env.ok("PATCH", U(c.uid), { properties: { labels: ["gpu"], alarmKinds: ["motion"] } }, v(c));
    assert.eq([res.properties.labels, res.properties.alarmKinds], [["gpu"], ["motion"]], "камера");
    const srv = (await env.ok("GET", "/kinds")).items.find((k) => (k.implements || []).includes("vms.server/1"));
    const labels = srv ? (((srv.schema.properties.labels || {}).items || {}).examples || []) : [];
    assert.ok((await env.ok("GET", "/kinds/camera")).events.some((e) => e.id === "motion") && labels.length > 0, "варианты: события вида, метки — examples у labels сервера");
    const a = FX.archives.find((x) => x.id !== c.properties.archiveId);
    const x = await env.ok("PATCH", U(c.uid), { properties: { extraArchives: [{ archiveId: a.id, recordMode: "always", labels: ["archive"] }] } }, v(res));
    assert.eq(x.properties.extraArchives[0].labels, ["archive"], "метка строки записи");
    field(await props(env, x, { recordState: "ok" }), "VALIDATION_FAILED", P("recordState"), "состояние — status.observed, не свойство");
  }, { needs: ["patchUnit", "kind:camera", "testEvent"] });

  ApiTest.loaded("api-devices.js");
})();
