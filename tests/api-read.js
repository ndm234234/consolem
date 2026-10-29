/* Тесты API: чтение всех разделов, ошибки адресов, служебные операции стенда. */
(() => {
  const { test, makeEnv, assert, FX } = ApiTest;
  const UNKNOWN = "30009999-0000-4000-8000-000000000000";
  const DAY = 86400000;

  test("Чтение: каждая коллекция отдаёт столько записей, сколько в эталонном наборе", async () => {
    const env = await makeEnv();
    const sizes = [];
    for (const table of ["domains", "servers", "devices", "folders", "archives", "volumes", "rules"]) {
      const list = await env.list(`/${table}`);
      assert.eq(list.length, FX[table].length, table);
      assert.eq(list.map((r) => r.id), FX[table].map((r) => r.id), `${table}: порядок — как в наборе`);
      sizes.push(`${table} ${list.length}`);
    }
    return sizes.join(", ");
  });

  test("Чтение одной записи: тело как в списке, версия в ETag", async () => {
    const env = await makeEnv();
    for (const table of ["domains", "servers", "devices", "folders", "archives", "volumes", "rules"]) {
      const first = (await env.list(`/${table}`))[0];
      const res = await env.call("GET", `/${table}/${first.id}`);
      assert.status(res, 200, null, table);
      assert.eq(res.body, first, `${table}: запись`);
      assert.eq(res.headers.etag, `"${first.version}"`, `${table}: ETag`);
    }
  });

  test("Нет записи — 404 NOT_FOUND; нет операции — 404 NO_ROUTE", async () => {
    const env = await makeEnv();
    for (const table of ["domains", "servers", "devices", "folders", "archives", "volumes", "rules"]) {
      assert.status(await env.call("GET", `/${table}/${UNKNOWN}`), 404, "NOT_FOUND", table);
    }
    if (ApiTest.can("getDiscovery")) assert.status(await env.call("GET", `/domains/${UNKNOWN}/discovery`), 404, "NOT_FOUND", "поиск в неизвестном домене");
    assert.status(await env.call("GET", `/rules/${UNKNOWN}/fires`), 404, "NOT_FOUND", "срабатывания неизвестного правила");
    assert.status(await env.call("GET", "/no-such-thing"), 404, "NO_ROUTE");
  });

  test("Текущий администратор и часы сервера: me набора, время — сейчас по стенду", async () => {
    const env = await makeEnv();
    const me = await env.ok("GET", "/me");
    const u = FX.access.users.find((x) => x.id === FX.me.userId);
    assert.eq([me.userId, me.login], [u.id, u.login], "кто");
    assert.eq(me.timezone, FX.timezone, "часовой пояс системы");
    if (env.frozen) assert.eq(Date.parse(me.serverTime), env.now, "часы сервера — часы стенда");
    else assert.ok(Math.abs(Date.parse(me.serverTime) - Date.now()) < 120000, `часы сервера — сейчас: ${me.serverTime}`);
  });

  test("Времена набора сдвинуты на «сейчас − capturedAt»: моменты — точно, даты — на целые сутки", async () => {
    const env = await makeEnv();
    const shift = env.now - Date.parse(FX.capturedAt);
    const journal = await env.list("/journal");
    const moved = Date.parse(journal[0].at) - Date.parse(FX.journal[0].at);
    // Часы идут — между сдвигом набора и ответом сброса проходит доля секунды
    if (env.frozen) assert.eq(moved, shift, "момент в журнале");
    else assert.ok(Math.abs(moved - shift) < 5000, `момент в журнале: сдвиг ${moved} вместо ${shift}`);
    const access = await env.ok("GET", "/access");
    const u = FX.access.users.find((x) => x.lastLoginDate);
    const got = access.users.find((x) => x.id === u.id).lastLoginDate;
    assert.eq((Date.parse(got) - Date.parse(u.lastLoginDate)) / DAY, Math.round(shift / DAY), "дата последнего входа");
  });

  test("Справочники: коды, без подписей", async () => {
    const env = await makeEnv();
    const ref = await env.ok("GET", "/reference");
    assert.eq(ref.recordModes, ["none", "always", "motion", "sched", "replica"], "режимы записи");
    assert.ok(ref.deviceModels.some((v) => v.vendor === "Hikvision"), "модели по производителям");
    assert.ok(!JSON.stringify(ref.detectorKinds).match(/[а-яё]/i), "виды детекторов — кодами");
  });

  test("Возможности системы: объявлены в справочниках, как в наборе; обязательный минимум есть", async () => {
    const env = await makeEnv();
    const caps = (await env.ok("GET", "/reference")).capabilities;
    assert.eq(caps, FX.reference.capabilities, "как в наборе");
    const known = new Set(Object.values(ApiTest.spec.paths).flatMap((item) => Object.values(item).map((o) => o && o.operationId)));
    assert.eq(caps.operations.filter((id) => !known.has(id)), [], "операции — из контракта");
    assert.eq(["getMe", "getReference", "stream"].filter((id) => !caps.operations.includes(id)), [], "минимум");
    assert.eq(caps.operations.filter((id) => ["testReset", "testClock", "testEvent"].includes(id)), [], "служебных стенда — нет");
    return `операций ${caps.operations.length}, виды устройств: ${caps.deviceTypes.join(", ")}; необязательные: ${caps.features.join(", ") || "нет"}`;
  });

  test("Неподдержанные вид устройства и настройки — 422 NOT_SUPPORTED, ничего не меняется", async () => {
    const env = await makeEnv();
    const caps = ApiTest.caps();
    const notes = [];
    const type = ["mic", "sensor", "relay", "eventsrc", "acfa", "email"].find((t) => !caps.deviceTypes.includes(t));
    const dom = FX.domains[0];
    if (type && caps.operations.includes("createDevices")) {
      const res = await env.ok("POST", "/devices", { idempotencyKey: ApiTest.key(), items: [{ domainId: dom.id, parentId: null, folderId: null, device: { type, name: "Не тот вид" } }] });
      assert.eq([res.done.length, res.failed.map((x) => [x.code, x.field])], [0, [["NOT_SUPPORTED", "type"]]], `вид ${type}`);
      assert.ok(!(await env.list("/devices")).some((d) => d.name === "Не тот вид"), "не создано");
      notes.push(`вид ${type}`);
    }
    const srv = FX.servers.find((s) => s.allocated && s.online);
    for (const [feature, patch] of [["serverRoles", { role: "standby" }], ["serverNetwork", { dns: "10.0.0.53" }]]) {
      if (caps.features.includes(feature)) continue;
      const res = await env.call("PATCH", `/servers/${srv.id}`, patch, { "If-Match": `"${srv.version}"` });
      assert.status(res, 422, "NOT_SUPPORTED", feature);
      assert.eq(res.body.field, Object.keys(patch)[0], `${feature}: поле`);
      notes.push(feature);
    }
    if (!caps.features.includes("archiveEncryption")) {
      const a = FX.archives[0];
      assert.status(await env.call("PATCH", `/archives/${a.id}`, { encrypted: true }, { "If-Match": `"${a.version}"` }), 422, "NOT_SUPPORTED", "шифрование");
      assert.eq((await env.ok("GET", `/archives/${a.id}`)).version, a.version, "хранилище не изменилось");
      notes.push("archiveEncryption");
    }
    return notes.length ? `проверено: ${notes.join(", ")}` : "система поддерживает всё — проверять нечего";
  });

  test("Права, опции, лицензии: снимок с версией в ETag", async () => {
    const env = await makeEnv();
    const acc = await env.call("GET", "/access");
    assert.status(acc, 200);
    assert.eq(acc.headers.etag, `"${acc.body.version}"`, "ETag прав");
    assert.eq(acc.body.users.length, FX.access.users.length, "пользователи");
    const st = await env.call("GET", "/settings");
    assert.eq(st.headers.etag, `"${st.body.version}"`, "ETag опций");
    assert.eq(st.body.values["sec.2fa"], "off", "значения опций — кодами");
    if (ApiTest.can("listLicenses")) assert.eq((await env.list("/licenses")).map((l) => l.kind), FX.licenses.map((l) => l.kind), "лицензии");
  });

  test("Журнал: новые первыми, фильтр по категории", async () => {
    const env = await makeEnv();
    const all = await env.list("/journal");
    assert.eq(all.length, FX.journal.length, "все записи");
    assert.ok(all.every((e, i) => !i || all[i - 1].at >= e.at), "по убыванию времени");
    const alarms = await env.list("/journal?category=alarm");
    assert.ok(alarms.length && alarms.every((e) => e.category === "alarm"), "только тревоги");
    assert.eq(alarms.length, all.filter((e) => e.category === "alarm").length, "все тревоги");
  });

  test("Срабатывания правила: только этого правила, новые первыми", async () => {
    const env = await makeEnv();
    const rule = (await env.list("/rules"))[0];
    const fires = await env.list(`/rules/${rule.id}/fires`);
    assert.eq(fires.length, FX.ruleFires.filter((f) => f.ruleId === rule.id).length, "число");
    assert.ok(fires.every((f, i) => f.ruleId === rule.id && (!i || fires[i - 1].at >= f.at)), "своё и по убыванию");
  });

  test("Поиск в сети: последний итог домена — найденные устройства; домен без поиска — idle", async () => {
    const env = await makeEnv();
    const known = FX.discovery[0];
    const d = await env.ok("GET", `/domains/${known.domainId}/discovery`);
    assert.eq(d.state, "done", "состояние");
    assert.eq(d.candidates.map((c) => c.id), known.candidateIds, "найденные");
    const silent = FX.domains.find((x) => !FX.discovery.some((y) => y.domainId === x.id));
    const idle = await env.ok("GET", `/domains/${silent.id}/discovery`);
    assert.eq([idle.state, idle.candidates.length], ["idle", 0], "без поиска");
  }, { needs: ["getDiscovery"] });

  test("Стенд: fixturePatch меняет набор только на этот прогон", async () => {
    const env = await makeEnv({ fixturePatch: { timezone: "UTC" } });
    assert.eq((await env.ok("GET", "/me")).timezone, "UTC", "с изменением");
    const again = await makeEnv();
    assert.eq((await again.ok("GET", "/me")).timezone, FX.timezone, "следующий сброс — исходный набор");
  });

  test("Стенд: actAs — прогон от имени другого администратора", async () => {
    const other = FX.access.users.find((u) => u.id !== FX.me.userId && u.enabled);
    const env = await makeEnv({ actAs: other.login });
    assert.eq((await env.ok("GET", "/me")).login, other.login, "кто");
    assert.status(await env.call("POST", "/test/reset", { fixture: "demo", actAs: "no-such-login" }), 404, "NOT_FOUND", "нет такого логина");
    assert.status(await env.call("POST", "/test/reset", { fixture: "other" }), 422, "VALIDATION_FAILED", "нет такого набора — не по контракту");
  });

  test("Стенд: часы стоят и идут только по /test/clock; назад — нельзя", async () => {
    const env = await makeEnv();
    const t0 = Date.parse((await env.ok("GET", "/me")).serverTime);
    await new Promise((r) => setTimeout(r, 20));
    assert.eq(Date.parse((await env.ok("GET", "/me")).serverTime), t0, "стоят");
    await env.advance(90);
    assert.eq(Date.parse((await env.ok("GET", "/me")).serverTime), t0 + 90000, "сдвинулись на 90 с");
    assert.status(await env.call("POST", "/test/clock", { advanceSec: -5 }), 422, "VALIDATION_FAILED", "назад");
    assert.status(await env.call("POST", "/test/clock", {}), 422, "VALIDATION_FAILED", "без advanceSec");
  }, { needs: ["clock"] });

  test("Стенд: устройство потеряло и вернуло связь — запись и поток, версия не растёт", async () => {
    const env = await makeEnv();
    const cam = (await env.list("/devices")).find((d) => d.type === "camera" && d.online);
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.entityId === cam.id && seen.push(m));
    await ApiTest.settle();
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: cam.id, online: false, fault: "auth" }), 200);
    let now = await env.ok("GET", `/devices/${cam.id}`);
    assert.eq([now.online, now.fault, now.version], [false, "auth", cam.version], "без связи");
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: cam.id, online: true }), 200);
    now = await env.ok("GET", `/devices/${cam.id}`);
    assert.eq([now.online, "fault" in now], [true, false], "связь вернулась");
    assert.status(await env.call("POST", "/test/events", { type: "device.fault", deviceId: cam.id, fault: "drv" }), 200, null, "причина");
    assert.eq((await env.ok("GET", `/devices/${cam.id}`)).fault, "drv", "причина записана");
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: "30009999-0000-4000-8000-000000000000", online: true }), 404, "NOT_FOUND");
    await ApiTest.settle();
    stop();
    assert.ok(seen.filter((m) => m.type === "entity.changed").length >= 2, `в потоке — изменения записи: ${seen.length}`);
  });

  ApiTest.loaded("api-read.js");
})();
