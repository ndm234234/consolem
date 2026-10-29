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
    assert.status(await env.call("GET", `/domains/${UNKNOWN}/discovery`), 404, "NOT_FOUND", "поиск в неизвестном домене");
    assert.status(await env.call("GET", `/rules/${UNKNOWN}/fires`), 404, "NOT_FOUND", "срабатывания неизвестного правила");
    assert.status(await env.call("GET", "/no-such-thing"), 404, "NO_ROUTE");
  });

  test("Текущий администратор и часы сервера: me набора, время — сейчас по стенду", async () => {
    const env = await makeEnv();
    const me = await env.ok("GET", "/me");
    const u = FX.access.users.find((x) => x.id === FX.me.userId);
    assert.eq([me.userId, me.login], [u.id, u.login], "кто");
    assert.eq(me.timezone, FX.timezone, "часовой пояс системы");
    assert.eq(Date.parse(me.serverTime), env.now, "часы сервера — часы стенда");
  });

  test("Времена набора сдвинуты на «сейчас − capturedAt»: моменты — точно, даты — на целые сутки", async () => {
    const env = await makeEnv();
    const shift = env.now - Date.parse(FX.capturedAt);
    const journal = await env.list("/journal");
    assert.eq(Date.parse(journal[0].at) - Date.parse(FX.journal[0].at), shift, "момент в журнале");
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

  test("Права, опции, лицензии: снимок с версией в ETag", async () => {
    const env = await makeEnv();
    const acc = await env.call("GET", "/access");
    assert.status(acc, 200);
    assert.eq(acc.headers.etag, `"${acc.body.version}"`, "ETag прав");
    assert.eq(acc.body.users.length, FX.access.users.length, "пользователи");
    const st = await env.call("GET", "/settings");
    assert.eq(st.headers.etag, `"${st.body.version}"`, "ETag опций");
    assert.eq(st.body.values["sec.2fa"], "off", "значения опций — кодами");
    assert.eq((await env.list("/licenses")).map((l) => l.kind), ["cameras", "acfa"], "лицензии");
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
  });

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
  });

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
