/* Тесты API: добавление устройств, групповое изменение, удаление, детекторы, поиск в сети.
   Пути ядра: устройство — объект своего вида (camera, det, sensor, acfa_lock…), поток камеры — дочерний объект вида stream;
   создание — POST /units (дочерние — children, папки — folders), правка — PATCH /units/{uid}, удаление — DELETE /units/{uid},
   команды — /units/{uid}/actions/… (probe, output, команды единиц СКУД), живое видео и PTZ — /units/{uid}/live, ptz, presets.
   Поле отказа — JSON Pointer. */
(() => {
  const { test, makeEnv, assert, key, FX } = ApiTest;
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
    const now = await env.ok("GET", `/domains/${disc.domainId}/discovery`);
    assert.ok(!now.candidates.some((x) => x.id === c.id), "добавленное — не в найденных");
    assert.eq(u.properties.mac, c.mac, "MAC из поиска сохранён");
  }, { needs: ["getDiscovery", "createUnits"] });

  test("Определить модель: команда probe камеры и регистратора; повторяется; неизвестный производитель — null", async () => {
    const env = await makeEnv();
    const probe = async (uid, params) => (await env.ok("POST", `${U(uid)}/actions/probe`, { params })).result;
    const m = await probe(cam.id, { ip: "10.1.2.3", port: 80, vendor: "Axis" });
    assert.ok(FX.reference.deviceModels.find((x) => x.vendor === "Axis").models.includes(m.model), `модель Axis: ${m.model}`);
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
    const expect = FX.network.filter((c) => c.domainIds.includes(did)).map((c) => c.id);
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "discovery" && m.entityId === did && seen.push(m.type));
    await ApiTest.settle();
    const res = await env.call("POST", `/domains/${did}/discovery`);
    assert.status(res, 202);
    assert.eq([res.body.state, res.body.candidates.map((c) => c.id)], ["searching", expect.slice(0, 1)], "начат, прежний итог сброшен, первая находка — сразу");
    assert.status(await env.call("POST", `/domains/${did}/discovery`), 409, "BUSY");
    const done = await env.until(async () => {
      const x = await env.ok("GET", `/domains/${did}/discovery`);
      return x.state === "done" && x;
    }, "поиск закончился");
    assert.eq([done.state, done.progress, done.candidates.map((c) => c.id)], ["done", 100, expect], "найдено всё, по порядку");
    await ApiTest.settle();
    stop();
    assert.eq([seen.filter((t) => t === "discovery.progress").length, seen.filter((t) => t === "discovery.finished").length], [expect.length, 1], "в потоке");
    await env.ok("POST", `/domains/${did}/discovery`);
    const stopped = await env.ok("DELETE", `/domains/${did}/discovery`);
    assert.eq(stopped.state, "stopped", "остановлен");
    assert.status(await env.call("DELETE", "/domains/10009999-0000-4000-8000-000000000000/discovery"), 404, "NOT_FOUND");
  }, { needs: ["startDiscovery", "getDiscovery", "stopDiscovery"] });

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
    field(await patch(env, ch, { name: "x" }), "NOT_SUPPORTED", "/name", "у канала ничего");
    const st = await ofKind(env, "storage", (u) => u.writable && !u.writable.length);
    assert.status(await props(env, st, { enabled: false }), 422, null, "у хранилища ничего");
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
    assert.eq([res.body.params.reason, res.body.params.with], ["incompatible", t.uid], "причина и с кем");
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: face.uid, patch: { properties: { enabled: true } } }], expectedVersions: { [face.uid]: face.version } });
    assert.eq([op.items[0].code, op.items[0].params.reason], ["BUSY", "incompatible"], "по шагу");
    const off = await env.ok("PATCH", U(t.uid), { properties: { enabled: false } }, v(t));
    assert.eq(off.properties.enabled, false, "выключили первый");
    assert.eq((await env.ok("PATCH", U(face.uid), { properties: { enabled: true } }, v(face))).properties.enabled, true, "теперь можно");
  }, { needs: ["createUnits", "patchUnit", "kind:det"] });

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

  /* ===== PTZ ===== */

  const ptzCam = async (env) => (await env.pages("/units?kind=camera&limit=1000")).find((u) => u.properties.ptz && u.status.link === "online" && (u.properties.presetMax == null || u.properties.presetMax >= 9));
  const presets = (u) => u.properties.presets || [];

  test("Пресеты: задать, переименовать, удалить, откат; камера без PTZ — 422 field /properties/ptz", async () => {
    const env = await makeEnv();
    const c = await ptzCam(env);
    const was = presets(c).length;
    const at = (r, n) => presets(r).find((x) => x.n === n);
    const put = (uid, n, body) => env.ok("PUT", `${U(uid)}/presets/${n}`, body);
    // PUT {} сохраняет положение и создаёт запись без подписи; ответ — объект камеры
    const pos = await put(c.uid, 9, {});
    assert.eq([pos.uid, at(pos, 9)], [c.uid, { n: 9, name: "" }], "сохранённый без имени виден");
    assert.ok(c.properties.presetMax >= 9, "предел в записи");
    const set = await put(c.uid, 9, { name: "Ворота" });
    assert.eq(presets(set).at(-1), { n: 9, name: "Ворота" }, "имя задано, номера по порядку");
    assert.ok(set.version !== c.version, "версия объекта изменилась");
    const same = await put(c.uid, 9, {});
    assert.eq(at(same, 9).name, "Ворота", "без имени — положение, имя прежнее");
    const blank = await put(c.uid, 9, { name: "" });
    assert.eq(at(blank, 9), { n: 9, name: "" }, "пустое снимает подпись, запись остаётся");
    const made8 = await put(c.uid, 8, { name: "" });
    assert.eq(at(made8, 8), { n: 8, name: "" }, "PUT {name} создаёт запись, пустое имя тоже");
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
    const ref = await env.ok("GET", "/reference");
    assert.ok((await env.ok("GET", "/kinds/camera")).events.some((e) => e.id === "motion") && ref.serverLabels.length > 0, "варианты: события вида, метки — справочник");
    const a = FX.archives.find((x) => x.id !== c.properties.archiveId);
    const x = await env.ok("PATCH", U(c.uid), { properties: { extraArchives: [{ archiveId: a.id, recordMode: "always", labels: ["archive"] }] } }, v(res));
    assert.eq(x.properties.extraArchives[0].labels, ["archive"], "метка строки записи");
    field(await props(env, x, { recordState: "ok" }), "VALIDATION_FAILED", P("recordState"), "состояние — status.observed, не свойство");
  }, { needs: ["patchUnit", "kind:camera"] });

  ApiTest.loaded("api-devices.js");
})();
