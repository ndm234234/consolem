/* Тесты API: «Оборудование» — правка устройства и групповые операции (план карточки и выборки). */
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

  /* ===== PATCH /devices/{id} — сразу, без очереди (переименование в дереве) ===== */

  test("Устройство: переименовать — 200, версия +1, ETag, изменение в потоке", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.entityId === cam.id && seen.push(m.type));
    await ApiTest.settle();
    const res = await env.call("PATCH", `/devices/${cam.id}`, { name: "Главный вход — новый" }, { "If-Match": await env.etag(`/devices/${cam.id}`) });
    assert.status(res, 200);
    assert.eq(res.body.name, "Главный вход — новый", "имя");
    assert.ok(res.body.version !== cam.version, "версия изменилась");
    assert.eq(res.headers.etag, `"${res.body.version}"`, "ETag — новая версия");
    assert.eq((await env.ok("GET", `/devices/${cam.id}`)).name, "Главный вход — новый", "сохранено");
    await ApiTest.settle();
    stop();
    assert.ok(seen.includes("entity.changed"), "в потоке");
  });

  test("Устройство: без If-Match — 428, старая версия — 412 с актуальной записью", async () => {
    const env = await makeEnv();
    assert.status(await env.call("PATCH", `/devices/${cam.id}`, { name: "x" }), 428, "PRECONDITION_REQUIRED");
    const stale = await env.etag(`/devices/${cam.id}`);
    await env.ok("PATCH", `/devices/${cam.id}`, { short: "1a" }, { "If-Match": stale });
    const res = await env.call("PATCH", `/devices/${cam.id}`, { name: "x" }, { "If-Match": stale });
    assert.status(res, 412, "VERSION_MISMATCH");
    assert.eq(res.body.current.short, "1a", "актуальная запись в теле");
    assert.ok(res.body.current.version !== cam.version, "у неё новая версия");
    assert.eq((await env.ok("GET", `/devices/${cam.id}`)).name, cam.name, "ничего не изменилось");
  });

  test("Устройство: пустое имя — 422 NAME_REQUIRED; чужое поле или тип — 422 VALIDATION_FAILED; нет устройства — 404", async () => {
    const env = await makeEnv();
    const h = { "If-Match": `"${cam.version}"` };
    assert.status(await env.call("PATCH", `/devices/${cam.id}`, { name: "  " }, h), 422, "NAME_REQUIRED");
    assert.status(await env.call("PATCH", `/devices/${cam.id}`, { colour: "red" }, h), 422, "VALIDATION_FAILED", "поля нет в контракте");
    assert.status(await env.call("PATCH", `/devices/${cam.id}`, { port: "80" }, h), 422, "VALIDATION_FAILED", "строка вместо числа");
    assert.status(await env.call("PATCH", `/devices/${cam.id}`, { recordMode: "forever" }, h), 422, "VALIDATION_FAILED", "не из перечисления");
    assert.status(await env.call("PATCH", `/devices/${cam.id}`, { archiveId: "50009999-0000-4000-8000-000000000000" }, h), 422, "VALIDATION_FAILED", "нет хранилища");
    assert.status(await env.call("PATCH", `/devices/${UNKNOWN}`, { name: "x" }, h), 404, "NOT_FOUND");
    assert.eq((await env.ok("GET", `/devices/${cam.id}`)).version, cam.version, "версия не изменилась");
  });

  test("Устройство: null убирает поле; пароль не возвращается, только hasPassword", async () => {
    const env = await makeEnv();
    let d = await env.ok("PATCH", `/devices/${cam.id}`, { identifier: null, login: "admin", password: "s3cret" }, { "If-Match": `"${cam.version}"` });
    assert.ok(!("identifier" in d), "поле убрано");
    assert.eq([d.login, d.hasPassword, "password" in d], ["admin", true, false], "пароль скрыт");
    d = await env.ok("PATCH", `/devices/${cam.id}`, { password: null }, { "If-Match": `"${d.version}"` });
    assert.ok(!d.hasPassword, "пароль снят");
  });

  /* ===== POST /operations — план карточки и выборки ===== */

  test("Операция: план карточки — шаги по одному, итог ok, объект и папки изменены, ход в потоке", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "operation" && seen.push(m.type));
    await ApiTest.settle();
    const folders = folderOf(cam.id).concat(otherFolder.id);
    const res = await env.call("POST", "/operations", plan([
      { targetId: cam.id, set: { name: "Вход — главный" } },
      { targetId: cam.id, set: { recordMode: "motion", preRecordSec: 7 } },
      { targetId: cam.id, folderIds: folders },
    ], { [cam.id]: cam.version }));
    assert.status(res, 202);
    assert.eq([res.body.state, res.body.total, res.body.done], ["running", 3, 0], "принята, ещё не выполнялась");
    if (env.frozen) {
      await env.advance(0);
      assert.eq((await env.ok("GET", `/operations/${res.body.id}`)).done, 0, "часы стоят — шаги ждут");
    }
    const done = await env.finished(res.body.id);
    assert.eq([done.state, done.ok, done.failed, done.items.map((x) => x.state)], ["done", 3, 0, ["ok", "ok", "ok"]], "итог");
    const d = await env.ok("GET", `/devices/${cam.id}`);
    assert.eq([d.name, d.recordMode, d.preRecordSec], ["Вход — главный", "motion", 7], "устройство");
    assert.eq(d.version, done.items[2].version, "версия — та, что дал последний шаг");
    assert.eq((await env.ok("GET", `/folders/${otherFolder.id}`)).deviceIds.slice(-1), [cam.id], "добавлено в папку");
    await ApiTest.settle();
    stop();
    assert.eq([seen.filter((t) => t === "operation.progress").length, seen.filter((t) => t === "operation.finished").length], [3, 1], "ход в потоке");
  });

  test("Операция: версия объекта не та, что в плане — 412, ничего не выполняется; версии нет — 428", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/operations", plan([{ targetId: cam.id, set: { name: "x" } }], { [cam.id]: "stale" }));
    assert.status(res, 412, "VERSION_MISMATCH");
    assert.eq(res.body.current.id, cam.id, "актуальная запись в теле");
    assert.status(await env.call("POST", "/operations", plan([{ targetId: cam.id, set: { name: "x" } }], {})), 428, "PRECONDITION_REQUIRED");
    assert.eq((await env.ok("GET", `/devices/${cam.id}`)).name, cam.name, "не изменилось");
  });

  test("Операция: шаг с set и folderIds сразу, папка чужого домена, нет устройства — отказ до выполнения", async () => {
    const env = await makeEnv();
    const v = { [cam.id]: cam.version };
    assert.status(await env.call("POST", "/operations", plan([{ targetId: cam.id, set: { name: "x" }, folderIds: [] }], v)), 422, "VALIDATION_FAILED", "оба");
    assert.status(await env.call("POST", "/operations", plan([{ targetId: cam.id }], v)), 422, "VALIDATION_FAILED", "ни одного");
    const alien = FX.folders.find((f) => f.domainId !== cam.domainId);
    if (alien) assert.status(await env.call("POST", "/operations", plan([{ targetId: cam.id, folderIds: [alien.id] }], v)), 422, "VALIDATION_FAILED", "чужой домен");
    assert.status(await env.call("POST", "/operations", plan([{ targetId: UNKNOWN, set: { name: "x" } }], { [UNKNOWN]: "1" })), 404, "NOT_FOUND");
    assert.status(await env.call("POST", "/operations", { idempotencyKey: key(), items: [], expectedVersions: {} }), 422, "VALIDATION_FAILED", "пустой план");
  });

  test("Операция: повтор с тем же idempotencyKey — та же операция, второй раз не выполняется", async () => {
    const env = await makeEnv();
    const body = plan([{ targetId: cam.id, set: { short: "1b" } }], { [cam.id]: cam.version });
    const a = await env.call("POST", "/operations", body);
    const b = await env.call("POST", "/operations", body);
    assert.status(b, 202);
    assert.eq(b.body.id, a.body.id, "та же операция");
    const op = await env.finished(a.body.id);
    assert.eq((await env.ok("GET", `/devices/${cam.id}`)).version, op.items[0].version, "изменение одно: версия — та, что дал единственный шаг");
  });

  // Длинная операция: 20 камер на серверах со связью, cam — последним шагом. Пока она идёт, с ней можно
  // делать что угодно и при часах, которые не остановить
  function longPlan() {
    const online = new Set(FX.servers.filter((s) => s.online).map((s) => s.id));
    const cams = FX.devices.filter((d) => d.type === "camera" && d.id !== cam.id && online.has(d.serverId)).slice(0, 19).concat(cam);
    return plan(cams.map((c) => ({ targetId: c.id, set: { short: c.short || "x" } })), Object.fromEntries(cams.map((c) => [c.id, c.version])));
  }

  test("Операция: над объектом уже идёт другая — 409 BUSY", async () => {
    const env = await makeEnv();
    await env.ok("POST", "/operations", longPlan());
    assert.status(await env.call("POST", "/operations", plan([{ targetId: cam.id, set: { short: "1d" } }], { [cam.id]: cam.version })), 409, "BUSY");
  });

  test("Операция: пока идёт, её объекты не меняются и другими запросами — 409 BUSY, в пакетной правке — failed BUSY; после отмены — можно", async () => {
    const env = await makeEnv();
    const res = await env.ok("POST", "/operations", longPlan());
    const free = FX.devices.find((d) => !res.items.some((x) => x.targetId === d.id));
    const h = { "If-Match": `"${cam.version}"` };
    const patch = await env.call("PATCH", `/devices/${cam.id}`, { short: "1h" }, h);
    assert.status(patch, 409, "BUSY", "одиночная правка");
    assert.eq(patch.body.params, { targetId: cam.id }, "какой объект занят");
    assert.status(await env.call("DELETE", `/devices/${cam.id}`, undefined, h), 409, "BUSY", "удаление");
    const batch = await env.ok("POST", "/devices/update", { idempotencyKey: key(), items: [
      { deviceId: cam.id, version: cam.version, set: { short: "1h" } },
      { deviceId: free.id, version: free.version, set: { short: "1i" } },
    ] });
    assert.eq([batch.failed, batch.done.map((d) => [d.id, d.short])], [[{ deviceId: cam.id, code: "BUSY" }], [[free.id, "1i"]]], "занятое — failed, остальное выполнено");
    assert.eq((await env.ok("GET", `/devices/${cam.id}`)).short, cam.short, "занятое не изменилось");
    // cam — последний шаг: при любых часах к отмене он ещё ждёт
    const cancelled = await env.ok("POST", `/operations/${res.id}/cancel`);
    assert.eq(cancelled.items[cancelled.items.length - 1].state, "cancel", "шаг cam отменён");
    const d = await env.ok("PATCH", `/devices/${cam.id}`, { short: "1h" }, h);
    assert.eq(d.short, "1h", "после отмены правка проходит");
  });

  test("Операция: папку, в которую ещё не выполненный шаг кладёт объект, удалить нельзя — 409 BUSY; переименовать можно", async () => {
    const env = await makeEnv();
    const dev = await env.ok("GET", `/devices/${cam.id}`);
    const folder = FX.folders.find((f) => f.domainId === dev.domainId && !f.deviceIds.includes(cam.id));
    if (!folder) return;
    const p = longPlan();
    p.items[p.items.length - 1] = { targetId: cam.id, folderIds: [folder.id] };
    const res = await env.ok("POST", "/operations", p);
    const h = { "If-Match": `"${folder.version}"` };
    const del = await env.call("DELETE", `/folders/${folder.id}`, undefined, h);
    assert.status(del, 409, "BUSY", "удаление папки из шага");
    assert.eq(del.body.params, { targetId: folder.id }, "занята сама папка");
    const renamed = await env.ok("PATCH", `/folders/${folder.id}`, { name: folder.name + " 2" }, h);
    assert.eq(renamed.name, folder.name + " 2", "переименование проходит");
    await env.ok("POST", `/operations/${res.id}/cancel`);
    assert.status(await env.call("DELETE", `/folders/${folder.id}`, undefined, { "If-Match": `"${renamed.version}"` }), 204, null, "после отмены — удаляется");
  });

  test("Операция: частичный успех — сервер без связи и превышенная лицензия дают fail с кодом, остальное выполняется", async () => {
    const env = await makeEnv();
    const items = [{ targetId: cam.id, set: { short: "1e" } }, { targetId: camOffline.id, set: { short: "9z" } }];
    const versions = { [cam.id]: cam.version, [camOffline.id]: camOffline.version };
    if (camLicense) {
      const lic = await env.ok("PATCH", `/devices/${camLicense.id}`, { enabled: false }, { "If-Match": `"${camLicense.version}"` });
      items.push({ targetId: camLicense.id, set: { enabled: true } });
      versions[camLicense.id] = lic.version;
    }
    const op = await env.runOperation(plan(items, versions));
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null], ["fail", "SERVER_OFFLINE"]].concat(camLicense ? [["fail", "LICENSE_EXCEEDED"]] : []), "по шагам");
    assert.eq([op.ok, op.failed], [1, items.length - 1], "счётчики");
    assert.eq((await env.ok("GET", `/devices/${camOffline.id}`)).short, camOffline.short, "без связи — не изменилось");
    if (camLicense) assert.eq((await env.ok("GET", `/devices/${camLicense.id}`)).enabled, false, "лицензия — осталось выключенным");
    return camLicense ? "" : "камер с превышенной лицензией в наборе нет";
  });

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
  });

  test("Операция: «Повторить неудачные» — новая операция только с неудачными шагами", async () => {
    const env = await makeEnv();
    const op = await env.runOperation(plan([
      { targetId: cam.id, set: { short: "1f" } },
      { targetId: camOffline.id, set: { short: "9y" } },
    ], { [cam.id]: cam.version, [camOffline.id]: camOffline.version }));
    const res = await env.call("POST", `/operations/${op.id}/retry-failed`);
    assert.status(res, 202);
    assert.eq([res.body.retryOf, res.body.items.map((x) => x.targetId)], [op.id, [camOffline.id]], "что повторяется");
    assert.eq((await env.finished(res.body.id)).items[0].code, "SERVER_OFFLINE", "сервер всё ещё без связи");
    const clean = await env.runOperation(plan([{ targetId: cam.id, set: { short: "1g" } }], { [cam.id]: (await env.ok("GET", `/devices/${cam.id}`)).version }));
    assert.status(await env.call("POST", `/operations/${clean.id}/retry-failed`), 409, "BUSY", "неудачных нет");
  });

  test("Операция: «Отменить» — объекты возвращаются к «до» обратной операцией, второй раз нельзя", async () => {
    const env = await makeEnv();
    const before = folderOf(cam.id);
    const op = await env.runOperation(plan([
      { targetId: cam.id, set: { name: "Временное имя", recordMode: "motion" } },
      { targetId: cam.id, folderIds: before.concat(otherFolder.id) },
    ], { [cam.id]: cam.version }));
    const res = await env.call("POST", `/operations/${op.id}/revert`);
    assert.status(res, 202);
    assert.eq(res.body.revertOf, op.id, "чья отмена");
    const back = await env.finished(res.body.id);
    assert.eq([back.ok, back.failed], [2, 0], "откат выполнен");
    const d = await env.ok("GET", `/devices/${cam.id}`);
    assert.eq([d.name, d.recordMode], [cam.name, cam.recordMode], "поля вернулись");
    assert.eq((await env.ok("GET", `/folders/${otherFolder.id}`)).deviceIds.includes(cam.id), false, "из папки убрано");
    assert.status(await env.call("POST", `/operations/${op.id}/revert`), 409, "BUSY", "второй раз");
    assert.status(await env.call("GET", `/operations/${UNKNOWN}`), 404, "NOT_FOUND");
  });

  test("Операция: «Отменить» после чужой правки — шаг отката fail VERSION_MISMATCH, чужое не затирается", async () => {
    const env = await makeEnv();
    const op = await env.runOperation(plan([{ targetId: cam.id, set: { name: "Моё имя" } }], { [cam.id]: cam.version }));
    await env.ok("PATCH", `/devices/${cam.id}`, { short: "чужое" }, { "If-Match": `"${op.items[0].version}"` });
    const res = await env.ok("POST", `/operations/${op.id}/revert`);
    const done = await env.finished(res.id);
    assert.eq(done.items.map((x) => [x.state, x.code]), [["fail", "VERSION_MISMATCH"]], "откат не выполнен");
    const d = await env.ok("GET", `/devices/${cam.id}`);
    assert.eq([d.name, d.short], ["Моё имя", "чужое"], "чужая правка цела");
  });

  ApiTest.loaded("api-hardware.js");
})();
