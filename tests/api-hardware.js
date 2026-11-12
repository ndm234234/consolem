/* Тесты API: «Оборудование» — правка устройства и групповые операции (план карточки и выборки).
   Пути ядра: правка объекта — PATCH /units/{uid} (name, folders, properties), шаги плана — по uid (patch, folders, createUnit).
   Чужая правка мимо стопки отката — только от системы: событие стенда device.lost снимает пропавший детектор из записи камер. */
(() => {
  const { test, makeEnv, assert, key, FX } = ApiTest;
  const UNKNOWN = "30009999-0000-4000-8000-000000000000";
  const byName = (name, type) => FX.devices.find((d) => d.name === name && (!type || d.type === type));
  // Камера сервера без связи и камера с превышенной лицензией — из набора (в системе без лицензий её нет)
  const offlineServer = FX.servers.find((s) => !s.online && s.allocated);
  const camOffline = FX.devices.find((d) => d.type === "camera" && d.serverId === offlineServer.id);
  const camLicense = FX.devices.find((d) => d.type === "camera" && d.licenseExceeded);
  const cam = byName("Главный вход", "camera");
  const folderOf = (id) => FX.folders.filter((f) => f.deviceIds.includes(id)).map((f) => f.id);
  const otherFolder = FX.folders.find((f) => f.domainId === cam.domainId && !f.deviceIds.includes(cam.id));
  const plan = (items, versions) => ({ idempotencyKey: key(), items, expectedVersions: versions });
  const U = (uid) => `/units/${uid}`;
  const at = (version) => ({ "If-Match": `"${version}"` });
  // Шаг плана по uid: правка свойств, имени, папок
  const props = (uid, properties) => ({ uid, patch: { properties } });
  const named = (uid, name) => ({ uid, patch: { name } });
  const inFolder = async (env, folderId) => (await env.pages(`/units?folderId=${folderId}&limit=1000`)).map((u) => u.uid);

  /* ===== PATCH /units/{uid} — сразу, без очереди (переименование в дереве) ===== */

  test("Устройство: переименовать — 200, версия +1, ETag, изменение в потоке", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.entityId === cam.id && seen.push([m.type, m.kind]), [cam.id]);
    await ApiTest.settle();
    const res = await env.call("PATCH", U(cam.id), { name: "Главный вход — новый" }, { "If-Match": await env.etag(U(cam.id)) });
    assert.status(res, 200);
    assert.eq(res.body.name, "Главный вход — новый", "имя");
    assert.ok(res.body.version !== cam.version, "версия изменилась");
    assert.eq(res.headers.etag, `"${res.body.version}"`, "ETag — новая версия");
    assert.eq((await env.ok("GET", U(cam.id))).name, "Главный вход — новый", "сохранено");
    await ApiTest.settle();
    stop();
    assert.ok(seen.some(([t, k]) => t === "entity.changed" && k === "camera"), "в потоке — с видом объекта");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Устройство: без If-Match — 428, старая версия — 412 с актуальным объектом", async () => {
    const env = await makeEnv();
    assert.status(await env.call("PATCH", U(cam.id), { name: "x" }), 428, "PRECONDITION_REQUIRED");
    const stale = await env.etag(U(cam.id));
    await env.ok("PATCH", U(cam.id), { properties: { short: "1a" } }, { "If-Match": stale });
    const res = await env.call("PATCH", U(cam.id), { name: "x" }, { "If-Match": stale });
    assert.status(res, 412, "VERSION_MISMATCH");
    assert.eq(res.body.current.properties.short, "1a", "актуальный объект в теле");
    assert.ok(res.body.current.version !== cam.version, "у него новая версия");
    assert.eq((await env.ok("GET", U(cam.id))).name, cam.name, "ничего не изменилось");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Устройство: пустое имя — 422 NAME_REQUIRED; чужое поле или тип — 422 VALIDATION_FAILED; нет устройства — 404", async () => {
    const env = await makeEnv();
    const h = at(cam.version);
    const bad = async (body, code, field, msg) => {
      const r = await env.call("PATCH", U(cam.id), body, h);
      assert.status(r, 422, code, msg);
      assert.eq(r.body.field, field, `${msg}: field`);
    };
    await bad({ name: "  " }, "NAME_REQUIRED", "/name", "пустое имя");
    await bad({ properties: { colour: "red" } }, "VALIDATION_FAILED", "/properties/colour", "поля нет в описании вида");
    await bad({ properties: { port: "80" } }, "VALIDATION_FAILED", "/properties/port", "строка вместо числа");
    await bad({ properties: { recordMode: "forever" } }, "VALIDATION_FAILED", "/properties/recordMode", "не из перечисления");
    await bad({ properties: { archiveId: "50009999-0000-4000-8000-000000000000" } }, "VALIDATION_FAILED", "/properties/archiveId", "нет хранилища");
    // Поле другого вида (у камеры его нет): схема вида — только её поля
    await bad({ properties: { words: ["чек"] } }, "VALIDATION_FAILED", "/properties/words", "поле источника событий");
    assert.status(await env.call("PATCH", U(UNKNOWN), { name: "x" }, h), 404, "NOT_FOUND");
    assert.eq((await env.ok("GET", U(cam.id))).version, cam.version, "версия не изменилась");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Устройство: null убирает поле; пароль — секрет: не возвращается, только secrets; логин читается", async () => {
    const env = await makeEnv();
    let d = await env.ok("PATCH", U(cam.id), { properties: { identifier: null, login: "admin", password: "s3cret" } }, at(cam.version));
    assert.ok(!("identifier" in d.properties), "поле убрано");
    // Как Device.login в базовом контракте: логин — читаемое свойство, writeOnly только пароль
    assert.eq([d.properties.login, d.secrets && d.secrets.password, "password" in d.properties, d.secrets && d.secrets.login], ["admin", true, false, undefined], "пароль скрыт, логин виден");
    d = await env.ok("PATCH", U(cam.id), { properties: { password: null } }, at(d.version));
    assert.ok(!(d.secrets && d.secrets.password), "пароль снят");
  }, { needs: ["patchUnit", "kind:camera"] });

  /* ===== POST /operations — план карточки и выборки ===== */

  test("Операция: план карточки — шаги по одному, итог ok, объект и папки изменены, ход в потоке", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "operation" && seen.push(m.type));
    await ApiTest.settle();
    const folders = folderOf(cam.id).concat(otherFolder.id);
    const res = await env.call("POST", "/operations", plan([
      named(cam.id, "Вход — главный"),
      props(cam.id, { recordMode: "motion", preRecordSec: 7 }),
      { uid: cam.id, folders },
    ], { [cam.id]: cam.version }));
    assert.status(res, 202);
    assert.eq([res.body.state, res.body.total, res.body.done], ["running", 3, 0], "принята, ещё не выполнялась");
    if (env.frozen) {
      await env.advance(0);
      assert.eq((await env.ok("GET", `/operations/${res.body.id}`)).done, 0, "часы стоят — шаги ждут");
    }
    const done = await env.finished(res.body.id);
    assert.eq([done.state, done.ok, done.failed, done.items.map((x) => x.state)], ["done", 3, 0, ["ok", "ok", "ok"]], "итог");
    const d = await env.ok("GET", U(cam.id));
    assert.eq([d.name, d.properties.recordMode, d.properties.preRecordSec], ["Вход — главный", "motion", 7], "устройство");
    assert.eq(d.version, done.items[2].version, "версия — та, что дал последний шаг");
    assert.ok((await inFolder(env, otherFolder.id)).includes(cam.id), "добавлено в папку");
    await ApiTest.settle();
    stop();
    assert.eq([seen.filter((t) => t === "operation.progress").length, seen.filter((t) => t === "operation.finished").length], [3, 1], "ход в потоке");
  }, { needs: ["kind:camera"] });

  test("Операция: версия объекта не та, что в плане — 412, ничего не выполняется; версии нет — 428", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/operations", plan([named(cam.id, "x")], { [cam.id]: "stale" }));
    assert.status(res, 412, "VERSION_MISMATCH");
    assert.eq(res.body.current.uid, cam.id, "актуальный объект в теле");
    assert.status(await env.call("POST", "/operations", plan([named(cam.id, "x")], {})), 428, "PRECONDITION_REQUIRED");
    assert.eq((await env.ok("GET", U(cam.id))).name, cam.name, "не изменилось");
  }, { needs: ["kind:camera"] });

  test("Операция: шаг с patch и folders сразу, пустой шаг, нет устройства, папка чужого домена — отказ до выполнения", async () => {
    const env = await makeEnv();
    const v = { [cam.id]: cam.version };
    assert.status(await env.call("POST", "/operations", plan([{ uid: cam.id, patch: { name: "x" }, folders: [] }], v)), 422, "VALIDATION_FAILED", "оба");
    assert.status(await env.call("POST", "/operations", plan([{ uid: cam.id }], v)), 422, "VALIDATION_FAILED", "ни одного");
    // Объекта шага нет — как POST /folders/{id}/devices базы: 422 на всю операцию, указатель на uid шага, ничего не применено
    const none = await env.call("POST", "/operations", plan([{ uid: cam.id, folders: folderOf(cam.id).concat(otherFolder.id) }, { uid: UNKNOWN, folders: [otherFolder.id] }], { [cam.id]: cam.version, [UNKNOWN]: "1" }));
    assert.status(none, 422, "VALIDATION_FAILED", "нет устройства");
    assert.eq([none.body.field, none.body.params.targetId], ["/items/1/uid", UNKNOWN], "указатель — uid шага, объект — params.targetId");
    assert.ok(!(await inFolder(env, otherFolder.id)).includes(cam.id), "шаг существующего объекта не применён");
    assert.status(await env.call("POST", "/operations", { idempotencyKey: key(), items: [], expectedVersions: {} }), 422, "VALIDATION_FAILED", "пустой план");
    // Папка чужого домена — как состав папки в базе: отклонена вся операция, указатель — в теле запроса, объект — params.targetId
    const alien = FX.folders.find((f) => f.domainId !== cam.domainId);
    if (alien) {
      const res = await env.call("POST", "/operations", plan([{ uid: cam.id, folders: [alien.id] }], v));
      assert.status(res, 422, "VALIDATION_FAILED", "чужой домен");
      assert.eq([res.body.field, res.body.params.targetId], ["/items/0/folders/0", cam.id], "какая папка, чей шаг");
      const patched = await env.call("POST", "/operations", plan([{ uid: cam.id, patch: { folders: [alien.id] } }], v));
      assert.eq([patched.status, patched.body.field], [422, "/items/0/patch/folders/0"], "то же у patch {folders}");
    }
  }, { needs: ["kind:camera"] });

  test("Операция: шаги проверяются до запуска — чужая папка в одном шаге отклоняет всю операцию, прошедшие шаги не применены", async () => {
    const env = await makeEnv();
    const alien = FX.folders.find((f) => f.domainId !== cam.domainId);
    const other = FX.devices.find((d) => d.type === "camera" && d.domainId === cam.domainId && d.id !== cam.id && !folderOf(d.id).includes(otherFolder.id));
    if (!alien || !other) return;
    const before = await inFolder(env, otherFolder.id);
    const res = await env.call("POST", "/operations", plan([
      { uid: other.id, folders: folderOf(other.id).concat(otherFolder.id) },
      { uid: cam.id, folders: folderOf(cam.id).concat(alien.id) },
    ], { [other.id]: other.version, [cam.id]: cam.version }));
    assert.status(res, 422, "VALIDATION_FAILED");
    assert.eq([res.body.field, res.body.params.targetId], ["/items/1/folders/" + folderOf(cam.id).length, cam.id], "отказ — у второго шага");
    assert.eq(await inFolder(env, otherFolder.id), before, "первый шаг не применён: состав папки прежний");
    assert.eq((await env.ok("GET", U(other.id))).version, other.version, "версия объекта первого шага прежняя");
    assert.eq((await env.ok("GET", "/operations?limit=5")).items.filter((x) => !x.single).length, 0, "операции не было");
  }, { needs: ["kind:camera", "listOperations"] });

  test("Операция с wait: мгновенные шаги (patch, folders) выполнены в запросе — 200, state done, итог по строкам; без wait — 202", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "operation" && seen.push(m.type));
    await ApiTest.settle();
    const res = await env.call("POST", "/operations", Object.assign(plan([
      named(cam.id, "Вход — сразу"),
      { uid: cam.id, folders: folderOf(cam.id).concat(otherFolder.id) },
      { uid: camOffline.id, patch: { name: "не примется" } },
    ], { [cam.id]: cam.version, [camOffline.id]: camOffline.version }), { wait: true }));
    assert.status(res, 200, null, "выполнена в запросе");
    assert.eq([res.body.state, res.body.total, res.body.done, res.body.ok, res.body.failed], ["done", 3, 3, 2, 1], "итог сразу");
    assert.eq(res.body.items.map((x) => [x.state, x.code]), [["ok", null], ["ok", null], ["fail", "SERVER_OFFLINE"]], "по строкам: отказ одного шага — его строка");
    const d = await env.ok("GET", U(cam.id));
    assert.eq([d.name, d.version], ["Вход — сразу", res.body.items[1].version], "объект изменён, версия — последнего шага");
    assert.ok((await inFolder(env, otherFolder.id)).includes(cam.id), "в папке");
    assert.eq((await env.ok("GET", `/operations/${res.body.id}`)).state, "done", "в журнале операций — законченная");
    await ApiTest.settle();
    stop();
    assert.eq([seen.filter((t) => t === "operation.progress").length, seen.filter((t) => t === "operation.finished").length], [3, 1], "ход в потоке — тот же");
    // Без wait — как прежде: 202, шаги по часам
    const slow = await env.call("POST", "/operations", plan([named(cam.id, "Вход — по шагам")], { [cam.id]: d.version }));
    assert.eq([slow.status, slow.body.state], [202, "running"], "без wait");
    await env.finished(slow.body.id);
  }, { needs: ["kind:camera"] });

  test("Операция: повтор с тем же idempotencyKey — та же операция, второй раз не выполняется", async () => {
    const env = await makeEnv();
    const body = plan([props(cam.id, { short: "1b" })], { [cam.id]: cam.version });
    const a = await env.call("POST", "/operations", body);
    const b = await env.call("POST", "/operations", body);
    assert.status(b, 202);
    assert.eq(b.body.id, a.body.id, "та же операция");
    const op = await env.finished(a.body.id);
    assert.eq((await env.ok("GET", U(cam.id))).version, op.items[0].version, "изменение одно: версия — та, что дал единственный шаг");
  }, { needs: ["kind:camera"] });

  // Длинная операция: 20 камер на серверах со связью, cam — последним шагом. Пока она идёт, с ней можно
  // делать что угодно и при часах, которые не остановить
  function longPlan() {
    const online = new Set(FX.servers.filter((s) => s.online).map((s) => s.id));
    const cams = FX.devices.filter((d) => d.type === "camera" && d.id !== cam.id && online.has(d.serverId)).slice(0, 19).concat(cam);
    return plan(cams.map((c) => props(c.id, { short: c.short || "x" })), Object.fromEntries(cams.map((c) => [c.id, c.version])));
  }

  test("Операция: над объектом уже идёт другая — 409 BUSY", async () => {
    const env = await makeEnv();
    await env.ok("POST", "/operations", longPlan());
    assert.status(await env.call("POST", "/operations", plan([props(cam.id, { short: "1d" })], { [cam.id]: cam.version })), 409, "BUSY");
  }, { needs: ["kind:camera"] });

  test("Операция: пока идёт, её объекты не меняются и другими запросами — 409 BUSY, в групповом удалении — failed BUSY; после отмены — можно", async () => {
    const env = await makeEnv();
    const res = await env.ok("POST", "/operations", longPlan());
    const free = FX.devices.find((d) => d.type === "camera" && !res.items.some((x) => x.targetId === d.id));
    const h = at(cam.version);
    const patch = await env.call("PATCH", U(cam.id), { properties: { short: "1h" } }, h);
    assert.status(patch, 409, "BUSY", "одиночная правка");
    assert.eq(patch.body.params, { targetId: cam.id }, "какой объект занят");
    assert.status(await env.call("DELETE", U(cam.id), undefined, h), 409, "BUSY", "удаление");
    // Групповое удаление: занятое — failed BUSY, остальное выполнено
    const batch = await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: [{ id: cam.id, version: cam.version }, { id: free.id, version: (await env.ok("GET", U(free.id))).version }] });
    assert.eq([batch.failed, batch.done], [[{ id: cam.id, code: "BUSY" }], [free.id]], "занятое — failed, остальное выполнено");
    assert.eq((await env.ok("GET", U(cam.id))).properties.short, cam.short, "занятое не изменилось");
    // cam — последний шаг: при любых часах к отмене он ещё ждёт
    const cancelled = await env.ok("POST", `/operations/${res.id}/cancel`);
    assert.eq(cancelled.items[cancelled.items.length - 1].state, "cancel", "шаг cam отменён");
    const d = await env.ok("PATCH", U(cam.id), { properties: { short: "1h" } }, h);
    assert.eq(d.properties.short, "1h", "после отмены правка проходит");
  }, { needs: ["patchUnit", "deleteUnit", "deleteObjects", "kind:camera"] });

  test("Операция: папку, в которую ещё не выполненный шаг кладёт объект, удалить нельзя — 409 BUSY; переименовать можно", async () => {
    const env = await makeEnv();
    const dev = await env.ok("GET", U(cam.id));
    const folder = FX.folders.find((f) => f.domainId === dev.domainId && !f.deviceIds.includes(cam.id));
    if (!folder) return;
    const p = longPlan();
    p.items[p.items.length - 1] = { uid: cam.id, folders: [folder.id] };
    const res = await env.ok("POST", "/operations", p);
    const h = at(folder.version);
    const del = await env.call("DELETE", U(folder.id), undefined, h);
    assert.status(del, 409, "BUSY", "удаление папки из шага");
    assert.eq(del.body.params, { targetId: folder.id }, "занята сама папка");
    const renamed = await env.ok("PATCH", U(folder.id), { name: folder.name + " 2" }, h);
    assert.eq(renamed.name, folder.name + " 2", "переименование проходит");
    await env.ok("POST", `/operations/${res.id}/cancel`);
    assert.status(await env.call("DELETE", U(folder.id), undefined, at(renamed.version)), 204, null, "после отмены — удаляется");
  }, { needs: ["patchUnit", "deleteUnit", "kind:folder", "kind:camera"] });

  test("Операция: частичный успех — сервер без связи и превышенная лицензия дают fail с кодом, остальное выполняется", async () => {
    const env = await makeEnv();
    const items = [props(cam.id, { short: "1e" }), props(camOffline.id, { short: "9z" })];
    const versions = { [cam.id]: cam.version, [camOffline.id]: camOffline.version };
    if (camLicense) {
      const lic = await env.ok("PATCH", U(camLicense.id), { properties: { enabled: false } }, at(camLicense.version));
      items.push(props(camLicense.id, { enabled: true }));
      versions[camLicense.id] = lic.version;
    }
    const op = await env.runOperation(plan(items, versions));
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null], ["fail", "SERVER_OFFLINE"]].concat(camLicense ? [["fail", "LICENSE_EXCEEDED"]] : []), "по шагам");
    assert.eq([op.ok, op.failed], [1, items.length - 1], "счётчики");
    assert.eq((await env.ok("GET", U(camOffline.id))).properties.short, camOffline.short, "без связи — не изменилось");
    if (camLicense) assert.eq((await env.ok("GET", U(camLicense.id))).properties.enabled, false, "лицензия — осталось выключенным");
    return camLicense ? "" : "камер с превышенной лицензией в наборе нет";
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Операция: пауза — шаги стоят; продолжить — идут; отменить оставшееся — cancel", async () => {
    const env = await makeEnv();
    const res = await env.ok("POST", "/operations", longPlan());
    if (env.frozen) await env.advance(1);
    const paused = await env.ok("POST", `/operations/${res.id}/pause`);
    assert.eq(paused.state, "paused", "пауза");
    await env.wait(env.frozen ? 5 : 1);
    const still = await env.ok("GET", `/operations/${res.id}`);
    assert.eq(still.done, paused.done, "на паузе не выполняется");
    assert.status(await env.call("POST", `/operations/${res.id}/pause`), 409, "BUSY", "уже на паузе");
    assert.eq((await env.ok("POST", `/operations/${res.id}/resume`)).state, "running", "продолжить");
    assert.status(await env.call("POST", `/operations/${res.id}/resume`), 409, "BUSY", "уже идёт");
    // Часы стоят — дать пройти секунде и проверить, что шаги пошли; идут — отменить сразу, пока есть что отменять
    if (env.frozen) await env.advance(1);
    const cancelled = await env.ok("POST", `/operations/${res.id}/cancel`);
    assert.eq(cancelled.state, "done", "завершена");
    assert.ok(cancelled.cancelled > 0 && cancelled.ok >= paused.done && cancelled.ok + cancelled.failed + cancelled.cancelled === cancelled.total, `выполненное осталось, оставшееся отменено: ok ${cancelled.ok}, cancel ${cancelled.cancelled}`);
    if (env.frozen) assert.ok(cancelled.ok > paused.done, "после «продолжить» шаги шли");
    assert.status(await env.call("POST", `/operations/${res.id}/cancel`), 409, "BUSY", "уже завершена");
  }, { needs: ["kind:camera"] });

  test("Операция: «Повторить неудачные» — новая операция только с неудачными шагами", async () => {
    const env = await makeEnv();
    const op = await env.runOperation(plan([
      props(cam.id, { short: "1f" }),
      props(camOffline.id, { short: "9y" }),
    ], { [cam.id]: cam.version, [camOffline.id]: camOffline.version }));
    const res = await env.call("POST", `/operations/${op.id}/retry-failed`);
    assert.status(res, 202);
    assert.eq([res.body.retryOf, res.body.items.map((x) => x.targetId)], [op.id, [camOffline.id]], "что повторяется");
    assert.eq((await env.finished(res.body.id)).items[0].code, "SERVER_OFFLINE", "сервер всё ещё без связи");
    const clean = await env.runOperation(plan([props(cam.id, { short: "1g" })], { [cam.id]: (await env.ok("GET", U(cam.id))).version }));
    assert.status(await env.call("POST", `/operations/${clean.id}/retry-failed`), 409, "BUSY", "неудачных нет");
  }, { needs: ["kind:camera"] });

  test("Операция: «Отменить» — объекты возвращаются к «до» обратной операцией, второй раз нельзя", async () => {
    const env = await makeEnv();
    const before = folderOf(cam.id);
    const op = await env.runOperation(plan([
      { uid: cam.id, patch: { name: "Временное имя", properties: { recordMode: "motion" } } },
      { uid: cam.id, folders: before.concat(otherFolder.id) },
    ], { [cam.id]: cam.version }));
    const res = await env.call("POST", `/operations/${op.id}/revert`);
    assert.status(res, 202);
    assert.eq(res.body.revertOf, op.id, "чья отмена");
    const back = await env.finished(res.body.id);
    assert.eq([back.ok, back.failed], [1, 1], "поля вернулись, папки вне отката");
    assert.eq(back.items.map((x) => x.code), ["NOT_SUPPORTED", null], "шаг папок — fail");
    const d = await env.ok("GET", U(cam.id));
    assert.eq([d.name, d.properties.recordMode], [cam.name, cam.recordMode], "поля вернулись");
    const twice = await env.call("POST", `/operations/${op.id}/revert`);
    assert.status(twice, 409, "NOT_REVERTIBLE", "второй раз");
    assert.eq(twice.body.params.reason, "reverted", "причина");
    assert.status(await env.call("GET", `/operations/${UNKNOWN}`), 404, "NOT_FOUND");
  }, { needs: ["kind:camera"] });

  // Чужая правка — мимо стопки отката. Правка путём API всегда в стопке (и становится верхней), мимо неё меняет только
  // система: детектор пропал (событие стенда device.lost) — камеры, что писали по нему, теряют его из recordDetectorIds
  const dets = FX.devices.filter((d) => d.type === "det").slice(0, 2).map((d) => d.id);
  const lost = (env, id) => env.ok("POST", "/test/events", { type: "device.lost", deviceId: id });
  const recordBy = (env, ids) => env.ok("PATCH", U(cam.id), { properties: { recordDetectorIds: ids } }, at(cam.version));

  test("Операция: «Отменить» после чужой правки того же поля — шаг отката fail VERSION_MISMATCH, чужое не затирается", async () => {
    const env = await makeEnv();
    const c = await recordBy(env, []);
    const op = await env.runOperation(plan([props(cam.id, { recordDetectorIds: dets })], { [cam.id]: c.version }));
    await lost(env, dets[1]);
    const res = await env.ok("POST", `/operations/${op.id}/revert`);
    const done = await env.finished(res.id);
    assert.eq(done.items.map((x) => [x.state, x.code]), [["fail", "VERSION_MISMATCH"]], "откат не выполнен");
    assert.eq((await env.ok("GET", U(cam.id))).properties.recordDetectorIds, [dets[0]], "чужая правка цела");
  }, { needs: ["patchUnit", "kind:camera", "kind:det"] });

  test("Операция: правка другого поля откату не мешает", async () => {
    const env = await makeEnv();
    const c = await recordBy(env, [dets[0]]);
    const op = await env.runOperation(plan([named(cam.id, "Моё имя")], { [cam.id]: c.version }));
    await lost(env, dets[0]);
    const res = await env.ok("POST", `/operations/${op.id}/revert`);
    assert.eq((await env.finished(res.id)).ok, 1, "откат выполнен");
    const now = await env.ok("GET", U(cam.id));
    assert.eq([now.name, now.properties.recordDetectorIds], [cam.name, []], "своё вернулось, чужое цело");
  }, { needs: ["patchUnit", "kind:camera", "kind:det"] });

  test("Одиночная правка — операция из одного шага: откат строго по стопке, с верхней", async () => {
    const env = await makeEnv();
    const group = await env.runOperation(plan([named(cam.id, "Групповое")], { [cam.id]: cam.version }));
    const one = await env.ok("PATCH", U(cam.id), { name: "Одиночное" }, at(group.items[0].version));
    const list = await env.ok("GET", "/operations", undefined);
    assert.eq(list.items[0].single, true, "новая сверху, одиночная");
    assert.eq([list.items[0].total, list.items[0].state, list.items[0].items[0].targetId], [1, "done", cam.id], "форма операции");
    assert.eq(list.items.map((x) => x.revertible), [true, false], "кнопка только у последней");
    // Старшая раньше младшей — отказ целиком, ничего не меняется
    const early = await env.call("POST", `/operations/${group.id}/revert`);
    assert.status(early, 409, "NOT_REVERTIBLE", "младшая не откачена");
    assert.eq(early.body.params.reason, "notLast", "причина");
    assert.eq((await env.ok("GET", U(cam.id))).name, one.name, "не тронуто");
    const back = await env.ok("POST", `/operations/${list.items[0].id}/revert`);
    assert.eq((await env.call("POST", `/operations/${group.id}/revert`)).body.params.reason, "notLast", "пока идёт откат, предыдущая ждёт");
    await env.finished(back.id);
    assert.eq((await env.ok("GET", U(cam.id))).name, "Групповое", "назад на шаг");
    const after = await env.ok("GET", "/operations");
    assert.eq(after.items.find((x) => x.id === group.id).revertible, true, "после отмены младшей откатывается предыдущая");
    assert.eq(after.items[0].revertOf, list.items[0].id, "откат — строкой списка");
    assert.eq(after.items[0].revertible, false, "откат не откатывается");
    const undo = await env.call("POST", `/operations/${after.items[0].id}/revert`);
    assert.status(undo, 409, "NOT_REVERTIBLE", "откат отката");
    assert.eq(undo.body.params.reason, "isRevert", "причина");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Откат по стопке: новая правка после отмены становится верхней", async () => {
    const env = await makeEnv();
    const a = await env.ok("PATCH", U(cam.id), { name: "Первое" }, at(cam.version));
    const first = (await env.ok("GET", "/operations")).items[0];
    const b = await env.ok("PATCH", U(cam.id), { name: "Второе" }, at(a.version));
    const second = (await env.ok("GET", "/operations")).items[0];
    await env.finished((await env.ok("POST", `/operations/${second.id}/revert`)).id);
    const c = await env.ok("GET", U(cam.id));
    await env.ok("PATCH", U(cam.id), { name: "Третье" }, at(c.version));
    const list = (await env.ok("GET", "/operations")).items;
    assert.eq(list.filter((x) => x.revertible).length, 1, "верхняя одна");
    assert.eq(list[0].revertible, true, "верхняя — новая правка");
    assert.eq((await env.call("POST", `/operations/${first.id}/revert`)).body.params.reason, "notLast", "первая снова под ней");
    assert.eq((await env.call("POST", `/operations/${second.id}/revert`)).body.params.reason, "reverted", "откаченная вне стопки");
    assert.ok(b.version !== c.version, "версии разные");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Откат одиночных правок: создание снимается, удаление и пароль — NOT_SUPPORTED, операции без шагов нет", async () => {
    const env = await makeEnv();
    const c = (await env.list("/units?kind=camera")).find((u) => u.uid !== cam.id);
    await env.ok("PATCH", U(c.uid), { properties: { password: "новый" } }, at(c.version));
    const op = (await env.ok("GET", "/operations")).items[0];
    const back = await env.ok("POST", `/operations/${op.id}/revert`);
    assert.eq((await env.finished(back.id)).items[0].code, "NOT_SUPPORTED", "пароль не возвращается");
    const fresh = await env.ok("GET", U(c.uid));
    assert.status(await env.call("DELETE", U(c.uid), undefined, at(fresh.version)), 204);
    const del = (await env.ok("GET", "/operations")).items[0];
    const res = await env.ok("POST", `/operations/${del.id}/revert`);
    assert.eq((await env.finished(res.id)).items[0].code, "NOT_SUPPORTED", "удаление не возвращается");
  }, { needs: ["patchUnit", "deleteUnit", "kind:camera"] });

  // Повтор: как в редакторе. Отменённое — правки имени, новая правка очищает стопку
  const edits = async (env, ...names) => {
    let v = (await env.ok("GET", U(cam.id))).version;
    const out = [];
    for (const name of names) {
      v = (await env.ok("PATCH", U(cam.id), { name }, at(v))).version;
      out.push((await env.ok("GET", "/operations")).items[0]);
    }
    return out;
  };
  const undo = async (env, op) => env.finished((await env.ok("POST", `/operations/${op.id}/revert`)).id);
  const redo = async (env, op) => env.finished((await env.ok("POST", `/operations/${op.id}/redo`)).id);
  const nameNow = async (env) => (await env.ok("GET", U(cam.id))).name;

  test("Повтор: после отмены значения возвращаются новой операцией, она снова верхняя и отменяется", async () => {
    const env = await makeEnv();
    const [a] = await edits(env, "Первое");
    assert.eq((await env.call("POST", `/operations/${a.id}/redo`)).body.params.reason, "stale", "не отменялась — повторять нечего");
    await undo(env, a);
    assert.eq(await nameNow(env), cam.name, "отменено");
    const row = (await env.ok("GET", "/operations")).items.find((x) => x.id === a.id);
    assert.eq([row.redoable, row.revertible], [true, false], "у отменённой — только повтор");
    const res = await env.ok("POST", `/operations/${a.id}/redo`);
    assert.eq(res.redoOf, a.id, "чей повтор");
    const done = await env.finished(res.id);
    assert.eq([done.ok, await nameNow(env)], [1, "Первое"], "значение снова то");
    const list = (await env.ok("GET", "/operations")).items;
    assert.eq([list[0].id, list[0].revertible, list[0].redoable], [res.id, true, false], "повтор — верхний в стопке");
    assert.eq(list.find((x) => x.id === a.id).redoable, false, "повторено");
    await undo(env, done);
    assert.eq(await nameNow(env), cam.name, "повтор отменяется как обычная операция");
    await redo(env, done);
    assert.eq(await nameNow(env), "Первое", "и снова повторяется");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Повтор: цепочка — отменили B, затем A, повторяется сначала A, потом B", async () => {
    const env = await makeEnv();
    const [a, b] = await edits(env, "A", "B");
    await undo(env, b);
    await undo(env, a);
    const early = await env.call("POST", `/operations/${b.id}/redo`);
    assert.status(early, 409, "NOT_REVERTIBLE", "B раньше A");
    assert.eq(early.body.params.reason, "notLast", "причина");
    await redo(env, a);
    assert.eq(await nameNow(env), "A", "сначала A");
    await redo(env, b);
    assert.eq(await nameNow(env), "B", "потом B");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Повтор: новая правка очищает его целиком, откат отменённого не очищает", async () => {
    const env = await makeEnv();
    const [a, b] = await edits(env, "A", "B");
    await undo(env, b);
    await undo(env, a);
    await edits(env, "Новая");
    const list = (await env.ok("GET", "/operations")).items;
    assert.eq(list.some((x) => x.redoable), false, "повторять нечего");
    for (const op of [a, b]) assert.eq((await env.call("POST", `/operations/${op.id}/redo`)).body.params.reason, "stale", "очищено");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Повтор: чужая правка поля — шаг fail VERSION_MISMATCH, чужое цело; созданное не создаётся заново; не откатившееся не повторяется", async () => {
    const env = await makeEnv();
    const c0 = await recordBy(env, [dets[1]]);
    const op = await env.runOperation(plan([props(cam.id, { recordDetectorIds: dets })], { [cam.id]: c0.version }));
    await env.finished((await env.ok("POST", `/operations/${op.id}/revert`)).id);
    await lost(env, dets[1]);
    const done = await redo(env, op);
    assert.eq(done.items.map((x) => [x.state, x.code]), [["fail", "VERSION_MISMATCH"]], "шаг не выполнен");
    assert.eq((await env.ok("GET", U(cam.id))).properties.recordDetectorIds, [], "чужая правка цела");
    const det = (name) => ({ uid: cam.id, createUnit: { kind: "det", name, properties: { detectorKind: "motion", sensitivity: 5 } } });
    const c = await env.ok("GET", U(cam.id));
    // Создание с правкой той же камеры: откат создания сверяет созданный детектор, а не камеру — снимается и он
    const made = await env.runOperation(plan([det("Новый"), props(cam.id, { short: "1z" })], { [cam.id]: c.version }));
    const back = await undo(env, made);
    assert.eq(back.items.map((x) => [x.state, x.code]), [["ok", null], ["ok", null]], "откатились и поле, и создание");
    assert.status(await env.call("GET", U(made.items[0].createdId)), 404, "NOT_FOUND", "детектора нет");
    const again = await redo(env, made);
    assert.eq(again.items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"], ["ok", null]], "создание не повторяется, поле повторено");
    assert.eq((await env.ok("GET", U(cam.id))).properties.short, "1z", "поле повторено");
    // Созданное меняли после: откат его не снимает, этот шаг и не повторяется
    const c2 = await env.ok("GET", U(cam.id));
    const kept = await env.runOperation(plan([det("Живой"), props(cam.id, { short: "2z" })], { [cam.id]: c2.version }));
    const live = kept.items[0].createdId;
    const edited = await env.ok("PATCH", U(live), { name: "Живой-2" }, { "If-Match": await env.etag(U(live)) });
    const rename = (await env.ok("GET", "/operations")).items[0];
    assert.eq((await undo(env, rename)).ok, 1, "сначала — правка детектора");
    const part = await undo(env, kept);
    assert.eq(part.items.map((x) => [x.state, x.code]), [["ok", null], ["fail", "NOT_SUPPORTED"]], "поле вернулось, изменённое созданное осталось");
    assert.status(await env.call("GET", U(live)), 200, null, "детектор на месте");
    assert.ok(edited.version !== (await env.ok("GET", U(live))).version, "у него своя версия");
    const third = await redo(env, kept);
    assert.eq(third.items.map((x) => [x.state, x.code]), [["ok", null]], "повторён только откатившийся шаг");
    assert.eq((await env.ok("GET", U(cam.id))).properties.short, "2z", "поле повторено");
    // Создание, которое откат снял, заново не создаётся
    const v = (await env.ok("GET", U(cam.id))).version;
    const one = await env.runOperation(plan([det("Второй")], { [cam.id]: v }));
    assert.eq((await undo(env, one)).ok, 1, "снято откатом");
    const fresh = await redo(env, one);
    assert.eq(fresh.items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "создание не повторяется");
    assert.status(await env.call("GET", U(one.items[0].createdId)), 404, "NOT_FOUND", "снятое не вернулось");
  }, { needs: ["patchUnit", "kind:camera", "kind:det"] });

  /* ===== Команды камеры defaults и readConfig (0.10.0): сброс к умолчаниям и загрузка настроек с устройства ===== */

  test("Команды камеры defaults и readConfig: по строке на поток, только чтение; без модели — 422, без связи — 409", async () => {
    const mainUid = `${cam.id.slice(0, 9)}0001${cam.id.slice(13)}`;
    const env = await makeEnv({ fixturePatch: { stand: { deviceConfig: { [mainUid]: { fps: 15 } } } } });
    const kinds = (await env.call("GET", "/kinds")).body;
    const acts = ((kinds.items || kinds).find((k) => k.kind === "camera").actions || []).filter((a) => ["defaults", "readConfig"].includes(a.id));
    assert.eq(acts.length, 2, "у вида camera обе команды");
    acts.forEach((a) => assert.eq(a.execution, "instant", `${a.id}: instant`));
    const kids = (await env.pages(`/units?parentId=${cam.id}&kind=stream&limit=100`)).filter((u) => u.kind === "stream");
    assert.ok(kids.length >= 1, "у камеры есть потоки");
    const before = (await env.call("GET", U(cam.id))).body.version;
    const shape = (rows, what) => {
      assert.eq(rows.length, kids.length, `${what}: строка на каждый поток`);
      rows.forEach((r) => {
        assert.ok(kids.some((k) => k.uid === r.uid), `${what}: uid ${r.uid} — поток камеры`);
        assert.ok(/^[0-9]+x[0-9]+$/.test(r.res), `${what}: разрешение ${r.res}`);
        assert.ok(Number.isInteger(r.fps) && r.fps >= 1, `${what}: к/с ${r.fps}`);
      });
    };
    const def = await env.call("POST", `${U(cam.id)}/actions/defaults`, {});
    assert.status(def, 200, null, "defaults");
    shape(def.body.result.streams, "defaults");
    const main = def.body.result.streams.find((r) => r.uid === mainUid);
    assert.eq(`${main.res} ${main.fps}`, "1920x1080 25", "основной поток: умолчания модели, как configMode: default");
    const camOpts = (await env.call("GET", U(cam.id))).body.properties.resOptions;
    def.body.result.streams.forEach((r) => {
      const k = kids.find((x) => x.uid === r.uid), opts = (k.properties || {}).resOptions || (r.uid === mainUid ? camOpts : null);
      if (opts && opts.length) assert.ok(opts.includes(r.res), `defaults: разрешение ${r.res} — из вариантов потока`);
    });
    const told = await env.call("POST", `${U(cam.id)}/actions/readConfig`, {});
    assert.status(told, 200, null, "readConfig");
    shape(told.body.result.streams, "readConfig");
    told.body.result.streams.forEach((r) => {
      const k = kids.find((x) => x.uid === r.uid);
      const want = r.uid === mainUid ? 15 : k.properties.fps;
      assert.eq(r.fps, want, `readConfig: к/с потока ${k.name} — как сообщила камера (stand.deviceConfig)`);
      assert.eq(r.res, k.properties.res, `readConfig: разрешение потока ${k.name}`);
    });
    assert.eq((await env.call("GET", U(cam.id))).body.version, before, "команды ничего не меняют: версия камеры та же");
    // Правку потока сервер передаёт камере: дальше камера сообщает новое значение
    const mainKid = kids.find((k) => k.uid === mainUid);
    assert.status(await env.call("PATCH", U(mainUid), { properties: { fps: 20 } }, at(mainKid.version)), 200, null, "PATCH основного потока");
    const after = (await env.call("POST", `${U(cam.id)}/actions/readConfig`, {})).body.result.streams.find((r) => r.uid === mainUid);
    assert.eq(after.fps, 20, "readConfig после правки потока — новое значение");
    // Камера под регистратором без своей модели: умолчаний нет
    const noModel = FX.devices.find((d) => d.type === "camera" && !d.model);
    if (noModel) assert.status(await env.call("POST", `${U(noModel.id)}/actions/defaults`, {}), 422, "NOT_SUPPORTED", "defaults без модели");
    // Без связи камера настроек не сообщит
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: cam.id, online: false }), 200);
    assert.status(await env.call("POST", `${U(cam.id)}/actions/readConfig`, {}), 409, "DEVICE_OFFLINE", "readConfig без связи");
  }, { needs: ["runUnitAction", "kind:camera", "action:camera/defaults", "action:camera/readConfig"] });

  ApiTest.loaded("api-hardware.js");
})();
