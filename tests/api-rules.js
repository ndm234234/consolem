/* Тесты API: правила автоматизации (история версий, запуски, пробный запуск, повтор), расписания, особые дни,
   режимы объекта, окна обслуживания; опции. */
(() => {
  const { test, makeEnv, assert, key } = ApiTest;
  const FX = ApiTest.FX;
  const rule = (name) => FX.rules.find((r) => r.name === name);
  const r1 = rule("Охрана входа ночью");
  // Правила, которые есть и в эталонном наборе, и в профиле one-domain (камеры и детекторы)
  const r2 = rule("Тревога на периметре");
  const sched = (name) => FX.schedules.find((s) => s.name === name);
  const CONTENT = ["name", "enabled", "logOnly", "logOnlySince", "start", "runMode", "operatorMenu", "ratePerMinute", "windowSec", "runAt", "repeat",
    "triggers", "conditions", "steps", "owner", "purpose", "serverId", "runAsRoleId", "allowChain"];
  const body = (r, over) => Object.assign(Object.fromEntries(CONTENT.map((k) => [k, JSON.parse(JSON.stringify(r[k]))])), over || {});
  const etag = (r) => ({ "If-Match": `"${r.version}"` });
  // Цель — объект по uid
  const dev = (uid) => ({ include: [{ uid }], exclude: [], gone: [], fromEvent: false });
  const cam = FX.devices.find((d) => d.type === "camera" && d.online && d.enabled);
  const blank = (over) => Object.assign({
    name: "Тест", enabled: false, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
    runAt: null, repeat: "skip", triggers: [], conditions: [], steps: [{ type: "unitAction", action: "record", target: dev(cam.id), params: { duration: "min", minutes: 5 } }],
    owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true,
  }, over || {});

  test("Правило: сохранить целиком — версия новая, автор и время с сервера, в истории — новая версия", async () => {
    const env = await makeEnv();
    const steps = [{ control: "wait", sec: 5 }].concat(r1.steps);
    const res = await env.call("PUT", `/rules/${r1.id}`, body(r1, { name: "Ночь — вход", steps }), etag(r1));
    assert.status(res, 200);
    assert.eq([res.body.name, res.body.steps.length, res.body.changedBy], ["Ночь — вход", steps.length, (await env.ok("GET", "/me")).login], "сохранено");
    assert.ok(res.body.version !== r1.version && res.headers.etag === `"${res.body.version}"`, "версия изменилась, в ETag");
    const h = await env.list(`/rules/${r1.id}/versions`), was = FX.ruleVersions.filter((v) => v.ruleId === r1.id);
    assert.eq([h.length, h[h.length - 1].number, h[h.length - 1].rule.name], [was.length + 1, was[was.length - 1].number + 1, "Ночь — вход"], "версия истории");
  });

  test("Правило: выключенное сохраняется незаконченным; включённое с ошибкой — 422 RULE_INVALID; 428, 412, 404, 422", async () => {
    const env = await makeEnv();
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(r1, { enabled: false, steps: [] }), etag(r1)), 200, null, "выключенное без действий");
    const cur = await env.ok("GET", `/rules/${r1.id}`);
    const bad = await env.call("PUT", `/rules/${r1.id}`, body(cur, { enabled: true, steps: [] }), etag(cur));
    assert.status(bad, 422, "RULE_INVALID");
    assert.eq(bad.body.params.issue.code, "rule.noAction", "что не так — кодом");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(cur)), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(cur), { "If-Match": '"stale"' }), 412, "VERSION_MISMATCH");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(cur, { name: " " }), etag(cur)), 422, "NAME_REQUIRED");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(cur, { ratePerMinute: 0 }), etag(cur)), 422, "VALIDATION_FAILED", "потолок — от 1");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(cur, { steps: [{ type: "unitAction", action: "output", target: null, params: { port: "2" } }] }), etag(cur)), 422, "VALIDATION_FAILED", "номер реле — числом: тип — по схеме действия вида");
    assert.status(await env.call("PUT", "/rules/70009999-0000-4000-8000-000000000000", body(cur), { "If-Match": '"1"' }), 404, "NOT_FOUND");
  }, { needs: ["kind:relay"] });

  test("Правило: создать — id, порядок и первая версия истории от сервера; удалить — с историей, журнал запусков остаётся", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/rules", blank());
    assert.status(res, 201);
    const r = res.body;
    assert.ok(/^7/.test(r.id) && r.order === Math.max(...FX.rules.map((x) => x.order)) + 1 && r.mute === null, "id и порядок — сервер: " + r.order);
    assert.eq((await env.list(`/rules/${r.id}/versions`)).map((v) => [v.number, v.note && v.note.code]), [[1, "created"]], "версия «создано»");
    const del = await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: [{ id: r.id, version: r.version }, { id: r1.id, version: "stale" }] });
    assert.eq([del.done, del.failed.map((x) => x.code)], [[r.id], ["VERSION_MISMATCH"]], "частичный успех");
    assert.status(await env.call("GET", `/rules/${r.id}`), 404, "NOT_FOUND");
    assert.status(await env.call("GET", `/rules/${r.id}/versions`), 404, "NOT_FOUND", "история — вместе с правилом");
  });

  test("Правила группой: состояние и приглушение — частичный успех, «Только журнал» с даты, версия истории за смену состояния", async () => {
    const env = await makeEnv();
    const until = new Date(env.now + 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
    const res = await env.ok("POST", "/rules/update", { idempotencyKey: key(), items: [
      { ruleId: r1.id, version: r1.version, set: { enabled: true, logOnly: true } },
      { ruleId: r2.id, version: r2.version, set: { mute: { until, reason: "работы" } } },
      { ruleId: r1.id, version: "stale", set: { enabled: false } },
    ] });
    assert.eq([res.done.map((r) => r.id), res.failed.map((x) => x.code)], [[r1.id, r2.id], ["VERSION_MISMATCH"]], "частичный успех");
    const [a, b] = res.done;
    assert.ok(a.logOnly && a.logOnlySince && a.version !== r1.version, "«Только журнал» с " + a.logOnlySince);
    assert.eq([b.mute.until, b.mute.reason, b.mute.by], [until, "работы", (await env.ok("GET", "/me")).login], "приглушено");
    const h = await env.list(`/rules/${r1.id}/versions`);
    assert.eq(h[h.length - 1].note, { code: "state", params: { mode: "watch" } }, "версия — за смену состояния");
    assert.eq((await env.list(`/rules/${r2.id}/versions`)).length, FX.ruleVersions.filter((v) => v.ruleId === r2.id).length, "приглушение версии не пишет");
    const off = await env.ok("POST", "/rules/update", { idempotencyKey: key(), items: [{ ruleId: r1.id, version: a.version, set: { enabled: false } }] });
    assert.eq([off.done[0].enabled, off.done[0].logOnly], [false, true], "выключено, «Только журнал» остался отмеченным");
  });

  test("Версия правила не возвращается: «Отменить» и «Вернуть версию» — новая метка; истечение приглушения версию не меняет", async () => {
    const env = await makeEnv();
    const seen = new Set([r1.version]);
    const a = await env.ok("PUT", `/rules/${r1.id}`, body(r1, { name: "Ночь" }), etag(r1));
    seen.add(a.version);
    const h = await env.list(`/rules/${r1.id}/versions`), last = h[h.length - 1];
    const b = await env.ok("PUT", `/rules/${r1.id}`, body(r1, { historyNote: { code: "undo", params: { number: last.number } } }), etag(a));
    assert.ok(!seen.has(b.version), "после «Отменить» — новая версия: " + b.version);
    seen.add(b.version);
    assert.eq((await env.list(`/rules/${r1.id}/versions`)).length, h.length - 1, "отменённая версия истории убрана");
    const v1 = (await env.list(`/rules/${r1.id}/versions`))[0];
    const c = await env.ok("PUT", `/rules/${r1.id}`, Object.assign({}, v1.rule, { historyNote: { code: "restore", params: { number: v1.number } } }), etag(b));
    assert.ok(!seen.has(c.version) && c.name === v1.rule.name, "«Вернуть версию 1» — содержимое версии, новая метка");
    const hh = await env.list(`/rules/${r1.id}/versions`);
    assert.eq(hh[hh.length - 1].note, { code: "restore", params: { number: 1 } }, "пометка версии");
    if (!env.frozen) return;
    const until = new Date(env.now + 60e3).toISOString().replace(/\.\d{3}Z$/, "Z");
    const m = (await env.ok("POST", "/rules/update", { idempotencyKey: key(), items: [{ ruleId: r1.id, version: c.version, set: { mute: { until, reason: "" } } }] })).done[0];
    await env.advance(120);
    assert.eq((await env.ok("GET", `/rules/${r1.id}`)).version, m.version, "приглушение истекло — версия та же");
  });

  test("«Отменить» — как не было: «Изменено» и «в наблюдении с» прежние, версия записи — новая", async () => {
    const env = await makeEnv();
    const r0 = await env.ok("GET", `/rules/${r1.id}`);
    const a = await env.ok("PUT", `/rules/${r1.id}`, body(r0, { name: "Ночь" }), etag(r0));
    const h = await env.list(`/rules/${r1.id}/versions`);
    const b = await env.ok("PUT", `/rules/${r1.id}`, body(r0, { historyNote: { code: "undo", params: { number: h[h.length - 1].number } } }), etag(a));
    assert.eq([b.changedAt, b.changedBy], [r0.changedAt, r0.changedBy], "правка отменена — «Изменено» прежнее");
    assert.ok(b.version !== r0.version && b.version !== a.version, "версия записи — новая");
    assert.ok((await env.list(`/rules/${r1.id}/versions`)).every((v) => !("was" in v)), "служебное поле истории наружу не выходит");
    const wf = FX.rules.find((x) => x.enabled && x.logOnly && x.logOnlySince);
    if (!wf) return;
    const w = await env.ok("GET", `/rules/${wf.id}`);
    const on = (await env.ok("POST", "/rules/update", { idempotencyKey: key(), items: [{ ruleId: w.id, version: w.version, set: { logOnly: false } }] })).done[0];
    assert.eq(on.logOnlySince, null, "включено — даты «в наблюдении» нет");
    const hw = await env.list(`/rules/${w.id}/versions`);
    const back = (await env.ok("POST", "/rules/update", { idempotencyKey: key(), items: [{ ruleId: w.id, version: on.version, set: { enabled: true, logOnly: true },
      historyNote: { code: "undo", params: { number: hw[hw.length - 1].number, state: true } } }] })).done[0];
    assert.eq([back.logOnlySince, back.changedAt, back.changedBy], [w.logOnlySince, w.changedAt, w.changedBy], "«Отменить» — «в наблюдении» с прежней даты");
  });

  test("Расписание «только здесь» у правила: владелец — правило, удаляется вместе с ним; владельца нет — 422", async () => {
    const env = await makeEnv();
    const sc = (owner) => ({ name: "Только здесь", kind: "week", week: [[["09:00", "18:00"]], [], [], [], [], [], []], overrides: [], valid: { from: "", to: "" },
      cycle: { length: 4, start: "2026-10-01", days: [] }, dates: [], astro: { window: "night", offsetStartMin: 0, offsetEndMin: 0, lat: 55.75, lon: 37.62, utcOffsetHours: 3 }, owner });
    assert.status(await env.call("POST", "/schedules", sc({ kind: "rule", id: "70009999-0000-4000-8000-000000000000" })), 422, "VALIDATION_FAILED", "правила нет");
    const r = (await env.call("POST", "/rules", blank())).body;
    const s = await env.call("POST", "/schedules", sc({ kind: "rule", id: r.id }));
    assert.status(s, 201);
    assert.eq(s.body.owner, { kind: "rule", id: r.id }, "владелец — правило");
    const cur = await env.ok("PUT", `/rules/${r.id}`, body(r, { conditions: [{ kind: "time", scheduleId: s.body.id }] }), etag(r));
    await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: [{ id: r.id, version: cur.version }] });
    assert.status(await env.call("GET", `/schedules/${s.body.id}`), 404, "NOT_FOUND", "своё расписание — вместе с правилом");
  });

  test("Порядок правил: всё или ничего — 412, если хоть одна версия не та", async () => {
    const env = await makeEnv();
    const items = [{ ruleId: r1.id, version: r1.version, order: 5 }, { ruleId: r2.id, version: r2.version, order: 1 }];
    assert.status(await env.call("POST", "/rules/reorder", { items: [items[0], Object.assign({}, items[1], { version: "stale" })] }), 412, "VERSION_MISMATCH");
    assert.eq((await env.ok("GET", `/rules/${r1.id}`)).order, r1.order, "ничего не поменялось");
    const res = await env.ok("POST", "/rules/reorder", { items });
    assert.eq(res.items.map((r) => r.order), [5, 1], "новый порядок");
    assert.ok(res.items[0].version !== r1.version, "версия изменилась");
  });

  test("Запустить сейчас: трасса кодами — события, проверки, шаги по устройствам; запуск — в журнале; выключенное — 409", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", `/rules/${r1.id}/run`, { idempotencyKey: key() });
    assert.status(res, 201);
    const f = res.body;
    assert.eq([f.ruleId, f.by, f.events.length], [r1.id, "manual", 0], "запуск вручную, без событий");
    assert.ok(f.steps.length && f.steps.every((s) => (s.action || s.label) && ["ok", "fail", "skip", "would"].includes(s.state)), "шаги: действие или подпись кодом, исход");
    if (r1.steps.some((s) => s.control)) assert.ok(f.steps.some((s) => s.control && s.label.code === "ctl.waitEvent"), "шаг хода выполнения — кодом");
    assert.ok((await env.list(`/rules/${r1.id}/fires`)).some((x) => x.id === f.id), "в журнале запусков");
    const off = rule("Обрыв потока — писать соседнюю");
    const no = await env.call("POST", `/rules/${off.id}/run`, { idempotencyKey: key() });
    assert.status(no, 409, "NOT_RUNNABLE");
    assert.eq(no.body.params.reason.code, "off", "почему — кодом");
  });

  test("Пробный запуск: черновик на выбранных событиях — проверки событий и условий, ничего не выполняет; log — в журнал", async () => {
    const env = await makeEnv();
    const ev = r1.triggers.map((t) => ({ source: t.source, event: t.event, match: t.match, deviceId: t.target.include[0].uid }));
    const at = new Date(env.now).toISOString().replace(/\.\d{3}Z$/, "Z");
    const f = await env.ok("POST", "/rules/test", { ruleId: r1.id, rule: body(r1, { name: "Черновик" }), events: ev, at, branches: { 2: "no" }, log: false });
    assert.eq(f.by, "test", "пробный");
    assert.eq(f.checks.filter((c) => c.code === "event.came").length, r1.triggers.length, "все события пришли");
    assert.ok(f.steps.filter((s) => !s.control).every((s) => s.state !== "ok"), "ничего не выполнено — только «выполнилось бы» или отказ");
    if (r1.steps.some((s) => s.control)) assert.ok(f.steps.some((s) => s.label && s.label.code === "branch" && s.label.params.branch === "yes"), "исход ветки — как выбран");
    assert.eq((await env.list(`/rules/${r1.id}/fires`)).length, FX.ruleFires.filter((x) => x.ruleId === r1.id).length, "без log — не в журнале");
    const other = { source: "unit", event: "silent", match: {}, deviceId: cam.id };
    const unsaved = await env.ok("POST", "/rules/test", { ruleId: null, rule: blank({ start: "event", triggers: r1.triggers.slice(0, 1) }), events: [other], at: null, branches: {}, log: false });
    assert.ok(unsaved.checks.some((c) => c.code === "event.other" && !c.ok), "событие не то — проверка не прошла");
    await env.ok("POST", "/rules/test", { ruleId: r1.id, rule: body(r1), events: ev, at: null, branches: {}, log: true });
    assert.eq((await env.list(`/rules/${r1.id}/fires`)).length, FX.ruleFires.filter((x) => x.ruleId === r1.id).length + 1, "log — в журнале");
    assert.status(await env.call("POST", "/rules/test", { ruleId: null, rule: blank(), events: [], at: null, branches: {}, log: true }), 422, "VALIDATION_FAILED", "черновик нового — не в журнал");
  });

  test("Повторить невыполненное: только отказавшие шаги, на нынешних устройствах; нечего повторять — 409", async () => {
    const env = await makeEnv();
    const fires = await env.list(`/rules/${r1.id}/fires`);
    const f = fires.find((x) => x.steps.some((s) => s.state === "fail" && s.action && s.action.action !== "runrule"));
    if (f) {
      const res = await env.call("POST", `/rules/${r1.id}/fires/${f.id}/retry`, { idempotencyKey: key() });
      assert.status(res, 201);
      assert.eq(res.body.steps.length, f.steps.filter((s) => s.state === "fail" && !s.control && s.action && s.action.action !== "runrule").length, "столько шагов, сколько отказов");
    }
    const failed = (x) => x.steps.some((s) => s.state === "fail" && !s.control && s.action && s.action.action !== "runrule");
    const ok = fires.find((x) => !failed(x));
    if (ok) assert.status(await env.call("POST", `/rules/${r1.id}/fires/${ok.id}/retry`, { idempotencyKey: key() }), 409, "NOT_RUNNABLE", "нечего повторять");
    assert.status(await env.call("POST", `/rules/${r1.id}/fires/d0009999-0000-4000-8000-000000000000/retry`, { idempotencyKey: key() }), 404, "NOT_FOUND");
  });

  test("Удалили устройство — в правилах оно остаётся удалённым по имени: новая версия правила, история поправлена", async () => {
    const env = await makeEnv();
    const gone = r1.steps[0].target.include.slice(-1)[0].uid, name = FX.devices.find((d) => d.id === gone).name;
    const d = await env.ok("GET", `/units/${gone}`);
    await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: [{ id: gone, version: d.version }] });
    const r = await env.ok("GET", `/rules/${r1.id}`);
    assert.eq([r.steps[0].target.include.map((x) => x.uid).includes(gone), r.steps[0].target.gone], [false, [name]], "в цели — удалённое по имени");
    assert.ok(r.version !== r1.version, "версия правила новая");
    const h = await env.list(`/rules/${r1.id}/versions`);
    assert.ok(!JSON.stringify(h).includes(gone), "в версиях истории — тоже по имени");
  });

  test("Расписания: создать, сохранить, удалить — где использовалось, переходит на «Никогда»; встроенные — 409 BUILTIN", async () => {
    const env = await makeEnv();
    const s = (await env.call("POST", "/schedules", { name: "Смена", kind: "week", week: [[["09:00", "18:00"]], [], [], [], [], [], []], overrides: [], valid: { from: "", to: "" },
      cycle: { length: 4, start: "2026-10-01", days: [] }, dates: [], astro: { window: "night", offsetStartMin: 0, offsetEndMin: 0, lat: 55.75, lon: 37.62, utcOffsetHours: 3 }, owner: null }));
    assert.status(s, 201);
    assert.ok(/^f/.test(s.body.id) && !s.body.builtin, "id от сервера");
    const put = await env.call("PUT", `/schedules/${s.body.id}`, Object.assign({}, s.body, { name: "Смена 2", id: undefined, version: undefined, builtin: undefined }), etag(s.body));
    assert.status(put, 200);
    assert.eq((await env.list("/schedules")).length, FX.schedules.length + 1, "в списке");
    const used = sched("Внерабочее время в будни"), never = sched("Никогда");
    assert.status(await env.call("DELETE", `/schedules/${never.id}`, undefined, etag(never)), 409, "BUILTIN");
    assert.status(await env.call("DELETE", `/schedules/${used.id}`), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("DELETE", `/schedules/${used.id}`, undefined, etag(used)), 204);
    const timed = FX.rules.find((x) => x.conditions.some((c) => c.kind === "time" && c.scheduleId === used.id));
    if (timed) assert.eq((await env.ok("GET", `/rules/${timed.id}`)).conditions.find((c) => c.kind === "time").scheduleId, never.id, "условие «Время» — на «Никогда»");
    const night = sched("Ночь");
    await env.ok("DELETE", `/schedules/${night.id}`, undefined, await env.etag(`/schedules/${night.id}`).then((e) => ({ "If-Match": e })));
    assert.ok((await env.ok("GET", "/modes")).items.every((m) => m.scheduleId !== night.id), "режим — только вручную");
  });

  test("Особые дни: создать, сохранить, удалить — из расписаний пропадают исключения этой группы", async () => {
    const env = await makeEnv();
    const g = await env.call("POST", "/day-groups", { name: "Ремонт", rules: [{ type: "range", from: "2026-11-10", to: "2026-11-12", yearly: false }] });
    assert.status(g, 201);
    assert.status(await env.call("PUT", `/day-groups/${g.body.id}`, { name: " ", rules: [] }, etag(g.body)), 422, "NAME_REQUIRED");
    assert.eq([(await env.list("/day-groups")).length, (await env.ok("GET", `/day-groups/${g.body.id}`)).name], [FX.dayGroups.length + 1, "Ремонт"], "в списке и по id");
    const hol = FX.dayGroups.find((x) => x.name === "Праздники РФ");
    assert.status(await env.call("DELETE", `/day-groups/${hol.id}`, undefined, etag(hol)), 204);
    const all = await env.list("/schedules");
    assert.ok(all.every((s) => s.overrides.every((o) => o.dayGroupId !== hol.id)), "исключения праздников убраны");
    assert.ok(all.find((s) => s.name === "Рабочие дни").version !== sched("Рабочие дни").version, "версия расписания новая");
  });

  test("Режимы объекта: список целиком с версией; системный не удалить; удалённый уходит из условий; текущий — без версии", async () => {
    const env = await makeEnv();
    const M = await env.ok("GET", "/modes"), sys = M.items.find((m) => m.system === "service");
    const mine = { id: "f0009999-0003-4000-8000-000000000000", name: "Праздник", scheduleId: null, system: "", color: null };
    const add = await env.call("PUT", "/modes", { items: M.items.concat(mine), otherwise: M.otherwise }, { "If-Match": `"${M.version}"` });
    assert.status(add, 200);
    assert.ok(add.body.version !== M.version, "версия новая");
    assert.status(await env.call("PUT", "/modes", { items: add.body.items.filter((m) => m !== sys && m.id !== sys.id), otherwise: M.otherwise }, { "If-Match": `"${add.body.version}"` }), 409, "BUILTIN");
    const cur = await env.ok("POST", "/modes/current", { modeId: mine.id, until: null });
    assert.eq([cur.modeId, typeof cur.manual.until], [mine.id, "string"], "включён вручную; срока нет в запросе — сервер ставит 8 часов");
    const r = await env.ok("GET", `/rules/${r1.id}`);
    // Условие «Режим объекта» устарело (0.4.0), но работает: в эталонном наборе его нет, добавляем
    await env.ok("PUT", `/rules/${r1.id}`, body(r, { conditions: r.conditions.concat({ kind: "mode", modeIds: [mine.id] }) }), etag(r));
    const del = await env.ok("PUT", "/modes", { items: M.items, otherwise: M.otherwise }, { "If-Match": `"${add.body.version}"` });
    assert.ok(del.items.length === M.items.length, "удалён");
    assert.ok(!JSON.stringify((await env.ok("GET", `/rules/${r1.id}`)).conditions).includes(mine.id), "ушёл из условия «Режим объекта»");
    assert.eq((await env.ok("GET", "/modes/current")).manual, null, "включённый вручную — снят");
    const back = await env.ok("POST", "/modes/current", { modeId: null, until: null });
    assert.eq(back.manual, null, "по расписаниям");
    assert.status(await env.call("POST", "/modes/current", { modeId: "f0008888-0003-4000-8000-000000000000", until: null }), 404, "NOT_FOUND");
  });

  test("Окна обслуживания: создать вместе со своим расписанием, сохранить, удалить — своё расписание уходит с окном", async () => {
    const env = await makeEnv();
    const sc = Object.assign({}, sched("По средам 02:00–03:00"));
    ["id", "version", "builtin"].forEach((k) => delete sc[k]);
    sc.owner = null;
    const res = await env.call("POST", "/maintenance-windows", { name: "Проверка", enabled: true, ruleIds: [r1.id], schedule: sc });
    assert.status(res, 201);
    const { window: w, schedule } = res.body;
    assert.eq([w.scheduleId, schedule.owner], [schedule.id, { kind: "maintenanceWindow", id: w.id }], "расписание окна");
    assert.eq((await env.ok("GET", `/maintenance-windows/${w.id}`)).name, "Проверка", "по id");
    const put = await env.ok("PUT", `/maintenance-windows/${w.id}`, { name: "Проверка", scheduleId: w.scheduleId, ruleIds: null, enabled: false }, etag(w));
    assert.eq([put.ruleIds, put.enabled], [null, false], "все правила, выключено");
    assert.status(await env.call("DELETE", `/maintenance-windows/${w.id}`, undefined, { "If-Match": `"${put.version}"` }), 204);
    assert.status(await env.call("GET", `/schedules/${schedule.id}`), 404, "NOT_FOUND", "расписание окна — тоже");
    assert.eq((await env.list("/maintenance-windows")).length, FX.maintenanceWindows.length, "остальные на месте");
  });

  test("Опции: изменить часть — остальное на месте, версия +1; чужой ключ и значение не из списка — 422", async () => {
    const env = await makeEnv();
    const s = FX.settings;
    const res = await env.call("PATCH", "/settings", { values: { "ntp.server": "time.local", "sec.pwdage": 30 } }, { "If-Match": `"${s.version}"` });
    assert.status(res, 200);
    assert.eq([res.body.values["ntp.server"], res.body.values["sec.pwdage"], res.body.values["mail.smtp"]], ["time.local", 30, s.values["mail.smtp"]], "сохранено");
    assert.ok(res.body.version !== s.version, "версия изменилась");
    assert.status(await env.call("PATCH", "/settings", { values: { "sec.2fa": "always" } }, { "If-Match": `"${res.body.version}"` }), 422, "VALIDATION_FAILED");
    assert.status(await env.call("PATCH", "/settings", { values: { "ui.theme": "dark" } }, { "If-Match": `"${res.body.version}"` }), 422, "VALIDATION_FAILED");
    assert.status(await env.call("PATCH", "/settings", { values: {} }), 428, "PRECONDITION_REQUIRED");
  });

  test("Правило: номер входа и выхода — из записи, расхождение с полем правила — 422 RULE_INVALID", async () => {
    const env = await makeEnv();
    const rule = FX.rules[0];
    const cur = await env.ok("GET", `/rules/${rule.id}`);
    const unit = (await env.list("/units?kind=relay")).find((u) => u.properties.channel);
    const relay = { id: unit.uid, channel: unit.properties.channel };
    const step = (port) => ({ type: "unitAction", action: "output", target: dev(relay.id), params: { state: true, pulseMs: 500, port } });
    const res = await env.call("PUT", `/rules/${rule.id}`, body(cur, { steps: [step(relay.channel + 1)] }), etag(cur));
    assert.status(res, 422, "RULE_INVALID", "номер не совпал");
    assert.eq(res.body.params.issue.code, "action.portMismatch", "что не так");
    await env.ok("PUT", `/rules/${rule.id}`, body(cur, { steps: [step(relay.channel)] }), etag(cur));
  }, { needs: ["type:relay"] });

  test("Правило: варианты уточнения входа — начало и конец тревоги, номера нет; у события есть конец", async () => {
    const env = await makeEnv();
    const e = (await env.ok("GET", "/kinds/sensor")).events.find((x) => x.id === "io.input");
    assert.eq([Object.keys(e.params.properties), e.params.properties.value.enum, e.ends], [["value"], ["active", "normal"], true], "варианты — параметры события вида");
    assert.ok(!("ruleTriggers" in (await env.ok("GET", "/reference"))), "событий объектов в справочнике нет — они в описаниях видов");
  }, { needs: ["kind:sensor"] });

  /* ----- Правила по событиям и действиям незнакомых видов ----- */

  const ctrl = FX.units.find((u) => u.kind === "security_controller/CONTROLLER" && u.status.link === "online");
  const sensor = ctrl && FX.units.find((u) => u.kind === "security_controller/SENSOR" && u.parentId === ctrl.uid);
  const alarmRule = (over) => blank(Object.assign({ name: "Тревога датчика — на охрану", enabled: true, start: "event", runMode: "always",
    triggers: [{ source: "unit", kinds: [sensor.kind], event: "ALARM", target: dev(sensor.uid), match: {} }],
    steps: [{ type: "unitAction", action: "ARM", target: dev(ctrl.uid), params: {} }] }, over));

  test("Правило на ALARM датчика security_controller → unitAction ARM контроллера срабатывает", async () => {
    const env = await makeEnv();
    const kinds = new Map((await env.ok("GET", "/kinds")).items.map((k) => [k.kind, k]));
    assert.ok(kinds.get(sensor.kind).events.some((e) => e.id === "ALARM") && kinds.get(ctrl.kind).actions.some((a) => a.id === "ARM" && a.ruleAction), "событие и действие — из описаний видов");
    const made = await env.ok("POST", "/rules", alarmRule());
    assert.eq(made.status, { state: "watching", reason: "" }, "правило вне кода вида — следит");
    assert.eq((await env.ok("GET", `/units/${ctrl.uid}`)).status.observed.armed, false, "контроллер снят с охраны");
    assert.status(await env.call("POST", "/test/events", { type: "unit.event", deviceId: sensor.uid, eventId: "RESTORE" }), 200);
    assert.eq((await env.list(`/rules/${made.id}/fires`)).length, 0, "другое событие правило не слышит");
    assert.status(await env.call("POST", "/test/events", { type: "unit.event", deviceId: sensor.uid, eventId: "ALARM", match: { zone: "Периметр" } }), 200);
    const fires = await env.list(`/rules/${made.id}/fires`);
    assert.eq(fires.length, 1, "запуск по событию");
    const f = fires[0];
    assert.eq([f.by, f.events.map((e) => [e.source, e.event, e.deviceId]), f.sourceDeviceIds, f.result], ["event", [["unit", "ALARM", sensor.uid]], [sensor.uid], "ok"], "что пришло");
    assert.eq(f.steps.map((x) => [x.action.type, x.action.action, x.deviceId, x.state]), [["unitAction", "ARM", ctrl.uid, "ok"]], "шаг — команда вида на контроллере");
    assert.eq((await env.ok("GET", `/units/${ctrl.uid}`)).status.observed.armed, true, "контроллер на охране: команда выполнена");
    const t = await env.ok("POST", "/rules/test", { ruleId: made.id, rule: body(made), events: [{ source: "unit", event: "ALARM", match: {}, deviceId: sensor.uid }], at: null, branches: {}, log: false });
    assert.eq([t.checks.filter((c) => c.code === "event.came").length, t.steps[0].state], [1, "would"], "пробный запуск — на событии вида");
  }, { needs: ["kind:security_controller/SENSOR", "kind:security_controller/CONTROLLER"] });

  test("Правило с ARM: автору с kindAccess security_controller=view — 403, что именно — uid; действие и событие вне описания вида — 422", async () => {
    const base = FX.access.roles.find((r) => !r.global.unr && !Object.keys(r.folderAccess).length);
    const role = Object.assign(JSON.parse(JSON.stringify(base)), { id: "8fff0003-0000-4000-8000-000000000003", name: "Только смотреть", kindAccess: { security_controller: "view" } });
    const user = Object.assign(JSON.parse(JSON.stringify(FX.access.users.find((u) => u.id !== FX.me.userId))), { id: "9fff0004-0000-4000-8000-000000000004", login: "sc-view", roleIds: [role.id], roleUntil: {} });
    const env = await makeEnv({ actAs: user.login, fixturePatch: { access: { roles: FX.access.roles.concat([role]), users: FX.access.users.concat([user]) } } });
    const bad = await env.call("POST", "/rules", alarmRule());
    assert.status(bad, 403, "PERMISSION_DENIED");
    assert.eq(bad.body.params.target, { uid: ctrl.uid }, "что именно");
    const adm = await makeEnv();
    const no = await adm.call("POST", "/rules", alarmRule({ steps: [{ type: "unitAction", action: "FLY", target: dev(ctrl.uid), params: {} }] }));
    assert.status(no, 422, "NOT_SUPPORTED");
    assert.eq([no.body.field, no.body.params.issue.code], ["steps", "action.notDeclared"], "действия у вида нет");
    const ev = await adm.call("POST", "/rules", alarmRule({ triggers: [{ source: "unit", kinds: [ctrl.kind], event: "ALARM", target: dev(ctrl.uid), match: {} }] }));
    assert.status(ev, 422, "NOT_SUPPORTED");
    assert.eq([ev.body.field, ev.body.params.issue.code], ["triggers", "trigger.notDeclared"], "события у вида нет");
  }, { needs: ["kind:security_controller/SENSOR", "kind:security_controller/CONTROLLER"] });

  /* ----- Права правил — как в базе (api/rule-engine.js COMMAND, roleAllowsArea): уровни не беднеют ----- */

  test("Права правил как в базе: «Пусконаладчик» (cam FULL, tel NO, pos FORBID) заводит правило по источнику событий и с пресетом", async () => {
    const role = FX.access.roles.find((r) => r.name === "Пусконаладчик");
    assert.eq([role.kindAccess.cam, role.kindAccess.tel, role.kindAccess.pos], ["FULL", "NO", "FORBID"], "уровни роли");
    const src = FX.units.find((u) => u.kind === "eventsrc");
    const ptz = FX.units.find((u) => u.kind === "camera" && u.properties.ptz);
    const text = FX.kinds.find((k) => k.kind === "eventsrc").events.find((e) => e.id === "text");
    const preset = FX.kinds.find((k) => k.kind === "camera").actions.find((a) => a.id === "preset");
    assert.eq([text.right, preset.right], [{ class: "cam", level: "FULL" }, { level: "FULL" }], "право — уровень камер, как COMMAND базы");
    const rule = blank({ name: "Чек — на пресет", triggers: [{ source: "unit", kinds: ["eventsrc"], event: "text", target: dev(src.uid), match: {} }],
      steps: [{ type: "unitAction", action: "preset", target: dev(ptz.uid), params: { preset: 1 } }] });
    const env = await makeEnv({ actAs: "commissioning" });
    assert.status(await env.call("POST", "/rules", rule), 201, null, "cam FULL — можно, телеметрия и pos не нужны");
    const view = await makeEnv({ actAs: "elena" });
    const no = await view.call("POST", "/rules", rule);
    assert.status(no, 403, "PERMISSION_DENIED", "cam MON — нельзя");
    assert.eq(no.body.params.target, { uid: src.uid }, "первое, на что нет права, — источник событий");
  }, { needs: ["kind:eventsrc"] });

  test("Права правил как в базе: область (домен, папка) судится уровнем камер на ней или по умолчанию — reference.ruleTargets.areaRight", async () => {
    const ref = await makeEnv().then((e) => e.ok("GET", "/reference"));
    assert.eq(ref.ruleTargets.areaRight, { class: "cam", level: "FULL" }, "право на область");
    const relay = FX.units.find((u) => u.kind === "relay");
    const area = relay.domainId;
    const rule = blank({ steps: [{ type: "unitAction", action: "output", target: { include: [{ area: "domain", uid: area }], exclude: [], gone: [], fromEvent: false }, params: { state: true } }] });
    const as = async (kindAccess, folderAccess) => {
      const base = FX.access.roles.find((r) => r.name === "Аудитор");
      const r = Object.assign(JSON.parse(JSON.stringify(base)), { id: "8fff0006-0000-4000-8000-000000000006", name: "Реле без камер", kindAccess, folderAccess: folderAccess || {} });
      const u = Object.assign(JSON.parse(JSON.stringify(FX.access.users.find((x) => x.login === "auditor"))), { id: "9fff0007-0000-4000-8000-000000000007", login: "relay-only", roleIds: [r.id], roleUntil: {} });
      const env = await makeEnv({ actAs: u.login, fixturePatch: { access: { roles: FX.access.roles.concat([r]), users: FX.access.users.concat([u]) } } });
      return env.call("POST", "/rules", rule);
    };
    const no = await as({ relay: "MANAGE", cam: "MON" });
    assert.status(no, 403, "PERMISSION_DENIED", "реле — да, камер FULL нет: область не назвать");
    assert.eq(no.body.params.target, { area: "domain", uid: area }, "что именно");
    assert.status(await as({ relay: "MANAGE", cam: "MON" }, { [area]: { cam: "FULL" } }), 201, null, "FULL на самом домене");
    assert.status(await as({ relay: "MANAGE", cam: "FULL" }), 201, null, "FULL по умолчанию роли");
  }, { needs: ["kind:relay"] });

  test("Событие с rule:false (abandoned камеры) триггером правила не берут; с rule по умолчанию (motion) — берут", async () => {
    const env = await makeEnv();
    const ev = (await env.ok("GET", "/kinds/camera")).events;
    assert.ok(ev.find((e) => e.id === "abandoned").rule === false && ev.find((e) => e.id === "motion").rule !== false, "флаги в описании вида");
    const trig = (event) => [{ source: "unit", kinds: ["camera"], event, target: dev(cam.id), match: {} }];
    const steps = [{ type: "unitAction", action: "alarm", target: dev(cam.id), params: {} }];
    const no = await env.call("POST", "/rules", blank({ name: "Брошенный предмет", enabled: true, start: "event", triggers: trig("abandoned"), steps }));
    assert.status(no, 422, null, "rule:false — отказ");
    assert.eq(no.body.field, "triggers", "поле");
    const yes = await env.call("POST", "/rules", blank({ name: "Движение", enabled: true, start: "event", triggers: trig("motion"), steps }));
    assert.ok(!(yes.body.field === "triggers"), "motion триггер принят: " + JSON.stringify(yes.body).slice(0, 160));
  }, { needs: ["kind:camera"] });

  ApiTest.loaded("api-rules.js");
})();
