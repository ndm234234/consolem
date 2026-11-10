/* Тесты API: встроенное хранилище камеры и регистратора и репликация в архив сервера (профиль vms.edge/1, контракт 0.6.0).
   Настройка — свойство replication (mode off или all, archiveId, speedLimitMbps, excludedCameras); mode all и recordMode replica
   камеры — одно и то же, сервер держит их согласованными. Состояние — status.observed.replicationStatus, только чтение.
   Время идёт по часам стенда (POST /test/clock), пропуск, проверку носителя и отказ подкладывает POST /test/events
   (edge.gap, edge.check, edge.fail). Забор шагом правила — команда камеры replicate; руками — POST /units/{uid}/archive-fetch. */
(() => {
  const { test, makeEnv, assert, FX } = ApiTest;
  const id = (n) => `${n}-0000-4000-8000-000000000000`;
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const U = (uid) => `/units/${uid}`;
  const P = (name) => `/properties/${name}`;
  const field = (res, code, name, msg, status = 422) => { assert.status(res, status, code, msg); assert.eq(res.body.field, name, `${msg}: поле`); };
  const dev = (uid) => ({ include: [{ uid }], exclude: [], gone: [], fromEvent: false });
  // Хранилища набора: камера без репликации, камера с репликацией, камера без связи, регистратор
  const S = { off: id(30000029), all: id(30000042), wait: id(30000040), lost: id(30000045), nvr: id(30000047), card: id(30000124) };
  const CAM = { off: id(30000013), all: id(30000041), wait: id(30000038) };
  const NVR = { corr1: id(30000048), lift: id(30000051), cam9: id(30000069), cam10: id(30000070), cam5: id(30000065) };
  const A1 = id(50000001);
  const needs = ["patchUnit", "implements:vms.edge/1"];
  const get = (env, uid) => env.ok("GET", U(uid));
  const rep = (u) => u.properties.replication;
  const st = (u) => u.status.observed.replicationStatus;
  const setRep = (env, u, replication) => env.call("PATCH", U(u.uid), { properties: { replication } }, v(u));
  const okRep = async (env, u, replication) => {
    const res = await setRep(env, u, replication);
    assert.status(res, 200, null, `PATCH replication ${JSON.stringify(replication)}`);
    return res.body;
  };
  const gap = (env, body) => env.ok("POST", "/test/events", Object.assign({ type: "edge.gap" }, body));
  const iso = (ms) => new Date(ms).toISOString();
  // Правило для PUT: поля содержимого, без id, версии и записей сервера
  const RULE_FIELDS = ["name", "enabled", "logOnly", "logOnlySince", "start", "runMode", "operatorMenu", "ratePerMinute", "windowSec", "runAt", "repeat", "triggers", "conditions", "steps", "owner", "purpose", "serverId", "runAsRoleId", "allowChain"];
  const rbody = (rule, over) => Object.assign(Object.fromEntries(RULE_FIELDS.map((k) => [k, rule[k]])), over);
  const journalOf = async (env, uid) => (await env.list(`/journal?deviceId=${uid}&limit=200`)).filter((e) => e.kind);

  test("Встроенное хранилище: настройка и состояние репликации в ответе — камера, регистратор, нет связи, потеря", async () => {
    const env = await makeEnv();
    const all = await get(env, S.all);
    assert.eq(rep(all), { mode: "all", archiveId: A1, speedLimitMbps: 20, excludedCameras: [] }, "настройка");
    assert.eq([st(all).state, st(all).lagSec, st(all).gaps, st(all).bytesToday > 0, !!st(all).lastTransferAt, "cameras" in st(all)], ["ok", 240, [], true, true, false], "в норме: отставание из replicaLagSec камеры");
    assert.eq([all.status.observed.mediaOk, all.status.observed.profileG], [true, true], "носитель и Profile G");
    assert.eq(all.writable, ["replication"], "правится настройка");
    const off = await get(env, S.off);
    assert.eq([rep(off).mode, rep(off).archiveId, rep(off).speedLimitMbps, st(off).state], ["off", A1, 0, "planned"], "выключена: ждёт правила, пропуск в очереди");
    assert.eq(st(off).gaps.map((g) => g.result), ["queued", "done"], "пропуски: новые первыми");
    assert.eq([st(off).timeLeftSec, st(off).nextTransferAt], [null, null], "правила нет — времени запуска нет");
    const wait = await get(env, S.wait);
    assert.eq([rep(wait).mode, st(wait).state, st(wait).gaps.map((g) => g.result)], ["all", "waiting", ["queued"]], "камера без связи: ждёт связи");
    const lost = await get(env, S.lost);
    assert.eq([st(lost).state, st(lost).gaps.map((g) => g.result)], ["ok", ["lost"]], "устройство записало поверх: lost");
    const card = await get(env, S.card);
    assert.eq([rep(card).mode, st(card).state, card.status.observed.mediaOk], ["off", "off", false], "репликации нет, носитель с ошибкой");
    const nvr = await get(env, S.nvr);
    assert.eq(rep(nvr).excludedCameras, [NVR.cam9], "регистратор: исключённая камера");
    const cams = st(nvr).cameras, by = (cid) => cams.find((c) => c.cameraId === cid);
    assert.eq(cams.length, 10, "состояние на каждую камеру регистратора");
    assert.eq([by(NVR.corr1).state, by(NVR.lift).state, by(NVR.cam10).state, by(NVR.cam9).state, by(NVR.cam9).excluded, by(NVR.cam5).excluded], ["ok", "running", "waiting", "off", true, false], "состояния камер");
    assert.eq(by(NVR.corr1).gaps.map((g) => g.result), ["done", "lost"], "пропуски камеры");
    assert.eq(st(nvr).state, "waiting", "общее состояние — худшее из камер");
    assert.ok(st(nvr).gaps.length === 4 && st(nvr).gaps.every((g) => g.cameraId), "общий список пропусков регистратора — с cameraId");
    assert.ok(st(nvr).timeLeftSec > 0, "осталось забрать");
    const listed = (await env.list(`/units?kind=storage&serverId=${rep(nvr) && FX.servers[0].id}`)).length;
    assert.ok(listed >= 0, "перечень хранилищ сервера читается");
    const row = (await env.list("/units?kind=storage")).find((u) => u.uid === S.all);
    assert.eq(row.status.observed.replicationStatus.state, "ok", "состояние есть и в перечне GET /units?kind=storage");
  }, { needs: [...needs, "kind:storage"] });

  test("Репликация: mode all ставит камере recordMode replica, off возвращает always; правка камеры меняет mode", async () => {
    const env = await makeEnv();
    let s = await get(env, S.off);
    assert.eq((await get(env, CAM.off)).properties.recordMode, "always", "камера пишет в архив");
    s = await okRep(env, s, { mode: "all" });
    const cam = await get(env, CAM.off);
    assert.eq([rep(s).mode, cam.properties.recordMode, cam.properties.replicaFrom, cam.properties.archiveId], ["all", "replica", undefined, A1], "камера забирает со встроенного хранилища");
    assert.eq(st(s).state === "running" || st(s).state === "ok" || st(s).state === "planned", true, "состояние считает сервер");
    s = await okRep(env, s, { mode: "off" });
    assert.eq([rep(s).mode, (await get(env, CAM.off)).properties.recordMode], ["off", "always"], "выключили: камера снова пишет сама");
    // Скорость не трогает режим камеры
    s = await okRep(env, s, { speedLimitMbps: 5 });
    assert.eq([rep(s).mode, rep(s).speedLimitMbps, (await get(env, CAM.off)).properties.recordMode], ["off", 5, "always"], "скорость отдельно");
    // Старый путь: камеру переключили руками — mode хранилища следует за ней
    const c = await get(env, CAM.all);
    assert.eq(rep(await get(env, S.all)).mode, "all", "replica камеры = mode all");
    const res = await env.call("PATCH", U(c.uid), { properties: { recordMode: "always" } }, v(c));
    assert.status(res, 200, null, "PATCH камеры");
    assert.eq(rep(await get(env, S.all)).mode, "off", "камера не replica — mode off");
    const c2 = await get(env, CAM.all);
    const back = await env.call("PATCH", U(c2.uid), { properties: { recordMode: "replica" } }, v(c2));
    assert.status(back, 200, null, "replica обратно");
    assert.eq(rep(await get(env, S.all)).mode, "all", "и обратно");
    // Откат правки хранилища возвращает режим камеры
    const s2 = await get(env, S.off);
    const on = await okRep(env, s2, { mode: "all" });
    assert.eq((await get(env, CAM.off)).properties.recordMode, "replica", "включили");
    const undone = await env.call("PATCH", U(on.uid), { properties: { replication: { mode: "off" } } }, v(on));
    assert.status(undone, 200, null, "и выключили");
    assert.eq((await get(env, CAM.off)).properties.recordMode, "always", "выключили");
  }, { needs: [...needs, "kind:camera"] });

  test("Репликация регистратора: excludedCameras — камере always, остальным replica; mode off — всем always; удаление камеры снимает её из списка", async () => {
    const env = await makeEnv();
    let s = await get(env, S.nvr);
    const mode = async (cid) => (await get(env, cid)).properties.recordMode;
    assert.eq([await mode(NVR.cam9), await mode(NVR.cam5)], ["always", "replica"], "исключённая пишет сама");
    s = await okRep(env, s, { excludedCameras: [NVR.cam9, NVR.cam5] });
    assert.eq([await mode(NVR.cam5), await mode(NVR.lift), rep(s).mode], ["always", "replica", "all"], "камеру исключили");
    assert.eq(st(s).cameras.find((c) => c.cameraId === NVR.cam5).excluded, true, "excluded в состоянии камеры");
    s = await okRep(env, s, { excludedCameras: [NVR.cam9] });
    assert.eq(await mode(NVR.cam5), "replica", "камеру вернули");
    s = await okRep(env, s, { mode: "off" });
    assert.eq([rep(s).mode, await mode(NVR.corr1), await mode(NVR.lift)], ["off", "always", "always"], "выключили у всех");
    s = await okRep(env, s, { mode: "all", archiveId: id(50000002) });
    assert.eq([(await get(env, NVR.lift)).properties.archiveId, await mode(NVR.lift), await mode(NVR.cam9)], [id(50000002), "replica", "always"], "хранилище назначения — всем камерам, кроме исключённой");
    const gone = await env.call("DELETE", U(NVR.cam9), undefined, v(await get(env, NVR.cam9)));
    assert.ok(gone.status < 300, "камеру удалили");
    assert.eq(rep(await get(env, S.nvr)).excludedCameras, [], "удалённая камера ушла из excludedCameras");
  }, { needs: [...needs, "kind:ipsrv"] });

  test("Репликация: ошибки правки — поле /properties/replication; режим вне off и all, предел скорости, чужие камеры, архив без replica", async () => {
    const env = await makeEnv();
    const s = await get(env, S.off), nvr = await get(env, S.nvr);
    field(await setRep(env, s, { mode: "gaps" }), "VALIDATION_FAILED", "/properties/replication/mode", "режим вне перечня");
    field(await setRep(env, s, { speedLimitMbps: -1 }), "VALIDATION_FAILED", "/properties/replication/speedLimitMbps", "предел меньше 0");
    field(await setRep(env, s, { speedLimitMbps: 1001 }), "VALIDATION_FAILED", "/properties/replication/speedLimitMbps", "предел больше 1000");
    field(await setRep(env, s, { excludedCameras: [NVR.cam5] }), "VALIDATION_FAILED", P("replication"), "у хранилища камеры исключать некого");
    field(await setRep(env, nvr, { excludedCameras: [CAM.off] }), "VALIDATION_FAILED", P("replication"), "камера другого устройства");
    field(await setRep(env, s, { archiveId: id(50000099) }), "VALIDATION_FAILED", P("replication"), "нет такого хранилища");
    field(await setRep(env, s, { archiveId: id(50000024), mode: "all" }), "NOT_SUPPORTED", P("replication"), "на резерв при сбое репликация не идёт");
    assert.eq(rep(await get(env, S.off)).mode, "off", "ничего не изменилось");
    // Камера без записи в архив: mode all требует хранилища назначения
    const bare = (await env.list("/units?kind=storage")).find((u) => { const o = FX.devices.find((d) => d.id === u.parentId); return o && o.type === "camera" && !o.archiveId; });
    field(await setRep(env, bare, { mode: "all" }), "VALIDATION_FAILED", P("replication"), "некуда забирать");
    const ok = await okRep(env, bare, { mode: "all", archiveId: A1 });
    assert.eq([rep(ok).mode, rep(ok).archiveId], ["all", A1], "с хранилищем — можно");
    const pr = await env.call("PATCH", U(s.uid), { properties: { sizeBytes: 1 } }, v(await get(env, S.off)));
    assert.status(pr, 422, "NOT_SUPPORTED", "объём обычного хранилища не правится");
    // Хранилище назначения удалили — значение снято
    const lone = (await env.list("/units?implements=vms.archive/1&kind=archive.local")).find((a) => a.uid === id(50000008));
    const t = await get(env, S.card);
    const set = await okRep(env, t, { archiveId: lone.uid });
    assert.eq(rep(set).archiveId, lone.uid, "назначили");
  }, { needs: [...needs, "kind:storage"] });

  test("Состояние: пропуск в очереди у камеры с mode all сервер забирает по часам — running, потом ok; пропуск done; replication.changed и replication.done", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "storage" && seen.push(m), [S.all]);
    await ApiTest.settle();
    const t0 = env.now;
    await gap(env, { deviceId: S.all, from: iso(t0 - 3600e3), to: iso(t0 - 3300e3) });
    let s = await get(env, S.all);
    assert.eq([st(s).state, st(s).gaps[0].result, st(s).timeLeftSec], ["running", "queued", 5 * 4], "5 минут по 4 секунды часов сервера");
    const bytes0 = st(s).bytesToday;
    await env.advance(st(s).timeLeftSec + 1);
    s = await get(env, S.all);
    assert.eq([st(s).state, st(s).gaps[0].result, st(s).timeLeftSec], ["ok", "done", null], "забрано");
    assert.ok(Date.parse(st(s).lastTransferAt) >= t0, "последний забор — после пропуска");
    // Сутки считаются по часам сервера (UTC): если забор пересёк полночь, счётчик начался заново — значение всё равно другое
    assert.ok(st(s).bytesToday !== bytes0, "байты за сутки изменились");
    await ApiTest.settle();
    stop();
    const kinds = seen.filter((m) => m.type === "replication.changed");
    assert.ok(kinds.length >= 2 && kinds.every((m) => m.entityId === S.all && typeof m.payload.state === "string"), "replication.changed с хранилищем и состоянием");
    assert.ok(kinds.some((m) => m.payload.gap && m.payload.gap.result === "queued"), "новый пропуск в событии");
    assert.ok(kinds.some((m) => m.payload.state === "running") && kinds.some((m) => m.payload.state === "ok"), "running и ok");
    const j = await journalOf(env, S.all);
    assert.ok(j.some((e) => e.kind === "replication.done" && e.source === "storage" && e.cameraId === CAM.all), "в журнале — конец забора, камера названа");
  }, { needs: [...needs, "clock", "kind:storage"] });

  test("Состояние: у выключенной репликации пропуск ждёт (planned); нет связи — waiting; связь вернулась — забирает", async () => {
    const env = await makeEnv();
    const t0 = env.now;
    assert.eq(st(await get(env, S.off)).state, "planned", "пропуск ждёт правила");
    await env.advance(3600);
    assert.eq(st(await get(env, S.off)).state, "planned", "время само его не забирает");
    // Камера с mode all без связи: пропуск ждёт связи, не running
    assert.eq(st(await get(env, S.wait)).state, "waiting", "нет связи");
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: CAM.wait, online: true });
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: S.wait, online: true });
    const s = await get(env, S.wait);
    assert.eq(st(s).state, "running", "связь вернулась — сервер забирает");
    await env.advance(st(s).timeLeftSec + 1);
    assert.eq([st(await get(env, S.wait)).state, st(await get(env, S.wait)).gaps[0].result], ["ok", "done"], "забрано");
    assert.ok(t0 > 0, "часы стенда");
  }, { needs: [...needs, "clock", "kind:storage"] });

  test("Потеря: пропуск, который сервер не забрал за срок хранения устройства, — lost; segment.lost камеры с from и to; replication.changed", async () => {
    const env = await makeEnv();
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => (m.type === "replication.changed" || m.type === "journal.event") && seen.push(m), [S.off, CAM.off]);
    await ApiTest.settle();
    const t0 = env.now;
    // Карта 64 ГБ держит около полутора суток; пропуск двухсуточной давности устройство уже стёрло, а старше недели ответ не показывает
    const from = iso(t0 - 9 * 86400e3), to = iso(t0 - 9 * 86400e3 + 600e3);
    await gap(env, { deviceId: S.off, from, to });
    await env.advance(1);
    const s = await get(env, S.off);
    const lost = st(s).gaps.find((g) => g.from === from);
    assert.eq(lost, undefined, "пропуск старше недели в ответе не виден");
    const recent = iso(t0 - 2 * 86400e3);
    await gap(env, { deviceId: S.off, from: recent, to: iso(t0 - 2 * 86400e3 + 600e3) });
    await env.advance(1);
    const after = st(await get(env, S.off)).gaps.find((g) => g.from === recent);
    assert.eq(after.result, "lost", "устройство записало поверх");
    await ApiTest.settle();
    stop();
    const ev = (await journalOf(env, CAM.off)).find((e) => e.kind === "segment.lost" && e.fields && e.fields.from === recent);
    assert.ok(ev && ev.fields.to === iso(t0 - 2 * 86400e3 + 600e3), "segment.lost камеры: from и to");
    assert.ok(seen.some((m) => m.type === "replication.changed" && m.payload.gap && m.payload.gap.result === "lost"), "в потоке — пропуск lost");
    field(await env.call("POST", "/test/events", { type: "edge.gap", deviceId: S.off, from: "x", to: "y" }), "VALIDATION_FAILED", "from", "период не дата");
    field(await env.call("POST", "/test/events", { type: "edge.gap", deviceId: S.nvr, from, to }), "VALIDATION_FAILED", "cameraId", "у регистратора нужна камера");
    assert.status(await env.call("POST", "/test/events", { type: "edge.gap", deviceId: CAM.off, from, to }), 422, "NOT_SUPPORTED", "камера не хранилище");
  }, { needs: [...needs, "clock", "kind:storage"] });

  test("Правило с командой replicate: offline забирает пропуски, last и event — период; нет связи, носитель, нет архива — replication.failed (журнал и правила)", async () => {
    const env = await makeEnv();
    const blank = (over) => Object.assign({ name: "Репликация", enabled: true, logOnly: false, logOnlySince: null, start: "event", runMode: "always", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
      runAt: null, repeat: "skip", triggers: [], conditions: [], steps: [], owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true }, over);
    const motion = { source: "unit", kinds: ["camera"], event: "motion", target: dev(CAM.off), match: {} };
    const step = (params) => ({ type: "unitAction", action: "replicate", target: dev(CAM.off), params });
    const unitEvent = (deviceId, eventId, match) => env.ok("POST", "/test/events", { type: "unit.event", deviceId, eventId, match: match || {} });
    const mk = async (body) => {
      const res = await env.call("POST", "/rules", body);
      assert.status(res, 201, null, `правило «${body.name}»: ${JSON.stringify(res.body && res.body.params)}`);
      return res.body;
    };
    const rule = await mk(blank({ triggers: [motion], steps: [step({ period: "offline" })] }));
    assert.eq(st(await get(env, S.off)).gaps[0].result, "queued", "пропуск в очереди");
    await unitEvent(CAM.off, "motion");
    let s = await get(env, S.off);
    assert.eq(st(s).state, "running", "правило заказало забор пропуска");
    await env.advance(st(s).timeLeftSec + 1);
    assert.eq([st(await get(env, S.off)).state, st(await get(env, S.off)).gaps[0].result], ["ok", "done"], "забрано");
    // last: период без пропуска — забор идёт, байты растут
    const before = st(await get(env, S.off)).bytesToday;
    await env.ok("PUT", `/rules/${rule.id}`, rbody(rule, { steps: [step({ period: "last", minutes: 30 })] }), v(rule));
    await unitEvent(CAM.off, "motion");
    s = await get(env, S.off);
    assert.eq([st(s).state, st(s).timeLeftSec], ["running", 30 * 4], "последние 30 минут");
    await env.advance(30 * 4 + 1);
    assert.ok(st(await get(env, S.off)).bytesToday !== before, "счётчик «за сутки» изменился");
    // Нет связи: отказ с причиной в журнале
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: S.off, online: false });
    await unitEvent(CAM.off, "motion");
    let fails = (await journalOf(env, S.off)).filter((e) => e.kind === "replication.failed");
    assert.eq(fails.map((e) => e.fields.reason), ["no_link"], "нет связи");
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: S.off, online: true });
    await env.ok("POST", "/test/events", { type: "edge.check", deviceId: S.off, mediaOk: false });
    assert.eq((await get(env, S.off)).status.observed.mediaOk, false, "носитель с ошибкой");
    await unitEvent(CAM.off, "motion");
    fails = (await journalOf(env, S.off)).filter((e) => e.kind === "replication.failed");
    assert.eq(fails.map((e) => e.fields.reason).sort(), ["media", "no_link"], "ошибка носителя");
    await env.ok("POST", "/test/events", { type: "edge.check", deviceId: S.off, mediaOk: true, profileG: false });
    assert.eq((await get(env, S.off)).status.observed.profileG, false, "Profile G");
    // Правило слушает replication.failed хранилища
    const watch = await mk(blank({ name: "Сбой репликации", triggers: [{ source: "unit", kinds: ["storage"], event: "replication.failed", target: dev(S.off), match: { reason: "space" } }],
      steps: [{ type: "unitAction", action: "alarm", target: dev(CAM.off), params: { priority: "high", text: "Репликация не идёт" } }] }));
    await env.ok("POST", "/test/events", { type: "edge.fail", deviceId: S.off, reason: "no_link" });
    assert.eq((await env.list(`/rules/${watch.id}/fires`)).length, 0, "другая причина — правило молчит");
    await env.ok("POST", "/test/events", { type: "edge.fail", deviceId: S.off, reason: "space" });
    assert.eq((await env.list(`/rules/${watch.id}/fires`)).length, 1, "причина space — правило сработало");
    field(await env.call("POST", "/test/events", { type: "edge.fail", deviceId: S.off, reason: "boom" }), "VALIDATION_FAILED", "reason", "причина вне перечня");
    // Нет хранилища назначения: у камеры нет записи в архив
    const bare = (await env.list("/units?kind=storage")).find((u) => { const o = FX.devices.find((d) => d.id === u.parentId); return o && o.type === "camera" && !o.archiveId; });
    const cam2 = bare.parentId;
    const r2 = await mk(blank({ name: "Без архива", triggers: [{ source: "unit", kinds: ["camera"], event: "motion", target: dev(cam2), match: {} }], steps: [{ type: "unitAction", action: "replicate", target: dev(cam2), params: { period: "whole" } }] }));
    await unitEvent(cam2, "motion");
    assert.eq((await journalOf(env, bare.uid)).filter((e) => e.kind === "replication.failed").map((e) => e.fields.reason), ["archive"], "нет хранилища назначения");
    assert.ok(r2.id, "правило создано");
  }, { needs: [...needs, "clock", "kind:storage", "createRule"] });

  test("Команда replicate: параметры period (offline, whole, last, event), minutes, beforeSec, afterSec, archive проверяются по описанию вида", async () => {
    const env = await makeEnv();
    const act = (await env.ok("GET", "/kinds/camera")).actions.find((a) => a.id === "replicate");
    assert.eq(act.params.properties.period.enum, ["event", "offline", "whole", "last"], "периоды: прежние и новые");
    assert.eq(Object.keys(act.params.properties).sort(), ["afterSec", "archive", "beforeSec", "minutes", "period"], "параметры");
    assert.eq([act.ruleOnly, act.ruleAction], [true, true], "команда только шагом правила");
    const blank = (params) => ({ name: "Заготовка", enabled: false, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
      runAt: null, repeat: "skip", triggers: [], conditions: [], steps: [{ type: "unitAction", action: "replicate", target: dev(CAM.off), params }], owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true });
    for (const params of [{ period: "whole" }, { period: "last", minutes: 15 }, { period: "event", beforeSec: 10, afterSec: 30 }, { period: "offline", archive: A1 }]) assert.status(await env.call("POST", "/rules", blank(params)), 201, null, JSON.stringify(params));
    for (const params of [{ period: 5 }, { period: "last", minutes: "10" }, { period: "event", afterSec: 1.5 }, { period: "offline", archive: 7 }])
      assert.status(await env.call("POST", "/rules", blank(params)), 422, "VALIDATION_FAILED", `тип: ${JSON.stringify(params)}`);
    const live = Object.assign(blank({ period: "weekly" }), { enabled: true, start: "event", runMode: "always", triggers: [{ source: "unit", kinds: ["camera"], event: "motion", target: dev(CAM.off), match: {} }] });
    assert.status(await env.call("POST", "/rules", live), 422, "NOT_SUPPORTED", "включённое правило с неизвестным периодом");
    assert.status(await env.call("POST", `/units/${CAM.off}/actions/replicate`, { params: { period: "whole" } }), 404, null, "вне правила команды нет");
    const events = (await env.ok("GET", "/kinds/storage")).events.map((e) => e.id);
    assert.eq(events, ["replication.done", "replication.failed"], "события хранилища");
    assert.ok((await env.ok("GET", "/kinds/camera")).events.some((e) => e.id === "device.restored"), "связь восстановлена — событие камеры");
  }, { needs: [...needs, "createRule", "kind:camera"] });

  test("Расписание: nextTransferAt — ближайший запуск правила-расписания с replicate на камеру; без правила — null; планирование: ok → planned", async () => {
    const env = await makeEnv();
    assert.eq([st(await get(env, S.all)).nextTransferAt, st(await get(env, S.all)).state], [null, "ok"], "правил нет");
    const blank = { name: "Ночью забрать", enabled: true, logOnly: false, logOnlySince: null, start: "schedule", runMode: "always", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
      runAt: { days: [1, 2, 3, 4, 5, 6, 7], time: "01:00", everyMin: 1440 }, repeat: "skip", triggers: [], conditions: [], steps: [{ type: "unitAction", action: "replicate", target: dev(CAM.all), params: { period: "whole" } }],
      owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true };
    const r = await env.ok("POST", "/rules", blank);
    const s = await get(env, S.all);
    assert.ok(Date.parse(st(s).nextTransferAt) > env.now && Date.parse(st(s).nextTransferAt) - env.now <= 86400e3 + 60e3, "ближайшая ночь");
    assert.eq(st(s).state, "planned", "ждёт времени запуска");
    assert.eq(st(await get(env, S.off)).nextTransferAt, null, "другая камера — не затронута");
    await env.ok("PUT", `/rules/${r.id}`, rbody(r, { enabled: false }), v(r));
    assert.eq([st(await get(env, S.all)).nextTransferAt, st(await get(env, S.all)).state], [null, "ok"], "правило выключили");
  }, { needs: [...needs, "createRule", "kind:storage"] });

  test("Ручной забор периода: POST /units/{uid}/archive-fetch забирает со встроенного хранилища камеры пропуски периода; другой период их не трогает", async () => {
    const env = await makeEnv();
    const s = await get(env, S.off), queued = st(s).gaps.find((g) => g.result === "queued");
    assert.eq(st(s).state, "planned", "пропуск ждёт заказа");
    const other = await env.call("POST", `/units/${CAM.off}/archive-fetch`, { archiveId: A1, from: iso(Date.parse(queued.from) - 7200e3), to: iso(Date.parse(queued.from) - 3600e3) });
    assert.status(other, 200, null, "другой период");
    assert.eq(st(await get(env, S.off)).state, "planned", "чужой период пропуск не заказал");
    const res = await env.call("POST", `/units/${CAM.off}/archive-fetch`, { archiveId: A1, from: queued.from, to: queued.to });
    assert.status(res, 200, null, "archive-fetch");
    assert.ok(res.body.accepted > 0, "принято");
    const mid = await get(env, S.off);
    assert.eq([st(mid).state, st(mid).timeLeftSec], ["running", 28 * 4], "сервер забирает 28 минут по 4 секунды");
    await env.advance(st(mid).timeLeftSec + 1);
    assert.eq(st(await get(env, S.off)).gaps.map((g) => g.result), ["done", "done"], "пропуск закрыт");
  }, { needs: [...needs, "clock", "kind:camera"] });


  /* ----- Разбор замечаний: цикл правил, смешанный режим, квота, носитель, память о режиме ----- */
  const rule = (over) => Object.assign({ name: "Правило", enabled: true, logOnly: false, logOnlySince: null, start: "event", runMode: "always", operatorMenu: false, ratePerMinute: 60, windowSec: 0,
    runAt: null, repeat: "skip", triggers: [], conditions: [], steps: [], owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true }, over);
  const replicate = (uid, params) => ({ type: "unitAction", action: "replicate", target: dev(uid), params: params || { period: "offline" } });
  const onFailed = (uid) => ({ source: "unit", kinds: ["storage"], event: "replication.failed", target: dev(uid), match: {} });

  test("Цикл: правило «replication.failed → replicate той же камеры» не уходит в рекурсию; allowChain: false его не слышит", async () => {
    const env = await makeEnv();
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: S.off, online: false });
    const r = await env.ok("POST", "/rules", rule({ triggers: [onFailed(S.off)], steps: [replicate(CAM.off)], allowChain: true }));
    const res = await env.call("POST", "/test/events", { type: "edge.fail", deviceId: S.off, reason: "no_link" });
    assert.status(res, 200, null, "событие принято, стек цел");
    const fires = (await env.list(`/rules/${r.id}/fires`)).length, failed = (await journalOf(env, S.off)).filter((e) => e.kind === "replication.failed").length;
    assert.ok(fires >= 1 && fires <= 60 && failed >= 2 && failed <= 60, `цепочка конечна: запусков ${fires}, отказов ${failed}`);
    const env2 = await makeEnv();
    await env2.ok("POST", "/test/events", { type: "device.signal", deviceId: S.off, online: false });
    const r2 = await env2.ok("POST", "/rules", rule({ triggers: [onFailed(S.off)], steps: [replicate(CAM.off)], allowChain: false }));
    await env2.ok("POST", "/test/events", { type: "edge.fail", deviceId: S.off, reason: "no_link" });
    assert.eq((await env2.list(`/rules/${r2.id}/fires`)).length, 1, "allowChain: false — правило слышит событие один раз, свой же отказ не слышит");
  }, { needs: [...needs, "kind:storage", "createRule"] });

  test("Правка скорости не трогает камеры; mode all — только если все камеры (кроме исключённых) забирают с хранилища; смешанное — off", async () => {
    const env = await makeEnv();
    let n = await get(env, S.nvr);
    const ver = async (uid) => (await get(env, uid)).version;
    const before = await Promise.all([NVR.corr1, NVR.lift, NVR.cam5].map(ver));
    n = await okRep(env, n, { speedLimitMbps: 7 });
    assert.eq(await Promise.all([NVR.corr1, NVR.lift, NVR.cam5].map(ver)), before, "версии камер те же");
    const c = await get(env, NVR.lift);
    assert.status(await env.call("PATCH", U(c.uid), { properties: { recordMode: "motion" } }, v(c)), 200, null, "одна камера пишет сама");
    n = await get(env, S.nvr);
    assert.eq(rep(n).mode, "off", "смешанное состояние — off");
    const cam5 = await get(env, NVR.cam5), a2 = id(50000002);
    n = await okRep(env, n, { excludedCameras: [NVR.cam9, NVR.lift] });
    assert.eq([rep(n).mode, (await get(env, NVR.lift)).properties.recordMode], ["all", "motion"], "исключили её: остальные забирают — mode all; исключённой запись не тронута");
    n = await okRep(env, n, { archiveId: a2 });
    assert.eq([(await get(env, NVR.cam5)).properties.archiveId, rep(n).archiveId], [a2, a2], "в mode all archiveId — общий архив камер");
    assert.ok(cam5.properties.archiveId !== a2, "до правки архив был другой");
  }, { needs: [...needs, "kind:ipsrv"] });

  test("Память о камере: сервер возвращает прежние режим и архив при выключении и исключении; ничего не помнил — always", async () => {
    const env = await makeEnv();
    let s = await get(env, S.off);
    const cam = await get(env, CAM.off);
    assert.status(await env.call("PATCH", U(cam.uid), { properties: { recordMode: "motion" } }, v(cam)), 200, null, "motion");
    s = await okRep(env, await get(env, S.off), { mode: "all", archiveId: id(50000002) });
    assert.eq([(await get(env, CAM.off)).properties.recordMode, (await get(env, CAM.off)).properties.archiveId], ["replica", id(50000002)], "включили");
    s = await okRep(env, s, { mode: "off" });
    const back = await get(env, CAM.off);
    assert.eq([back.properties.recordMode, back.properties.archiveId], ["motion", A1], "вернулись motion и прежний архив");
    const n = await get(env, S.nvr);
    await okRep(env, n, { excludedCameras: [NVR.cam9, NVR.cam5] });
    assert.eq((await get(env, NVR.cam5)).properties.recordMode, "always", "seeded replica без памяти — always");
  }, { needs: [...needs, "kind:camera"] });

  test("Пустые значения: excludedCameras: null — пустой список, replication: null — mode off с прежними исключениями; archive-fetch не тратит квоту", async () => {
    const env = await makeEnv();
    let n = await get(env, S.nvr);
    n = await okRep(env, n, { excludedCameras: null });
    assert.eq(rep(n).excludedCameras, [], "null — пусто");
    n = await okRep(env, n, { excludedCameras: [NVR.cam9] });
    const res = await env.call("PATCH", U(n.uid), { properties: { replication: null } }, v(n));
    assert.status(res, 200, null, "replication: null");
    assert.eq([rep(res.body).mode, rep(res.body).excludedCameras], ["off", [NVR.cam9]], "mode off, исключения остались");
    // Квота «закрепить» (7 на человека) заказу пропусков не мешает
    const q = st(await get(env, S.off)).gaps.find((g) => g.result === "queued");
    for (let i = 0; i < 8; i++) await env.call("POST", `/units/${CAM.off}/archive-fetch`, { archiveId: A1, from: iso(env.now - (i + 2) * 86400e3), to: iso(env.now - (i + 1) * 86400e3) });
    const only = await env.call("POST", `/units/${CAM.off}/archive-fetch`, { archiveId: A1, from: q.from, to: q.to, edgeOnly: true });
    assert.status(only, 200, null, "edgeOnly");
    assert.eq([only.body.accepted, only.body.refused, only.body.edgeOrdered], [0, [], 1], "квота исчерпана, пропуск всё равно заказан");
    assert.eq(st(await get(env, S.off)).state, "running", "и забор идёт сразу");
  }, { needs: [...needs, "kind:ipsrv"] });

  test("Забор начинается сразу: пропуск, заказ, правка — остаток правдив после /test/clock; носитель и Profile G: waiting и отказ", async () => {
    const env = await makeEnv();
    await gap(env, { deviceId: S.all, from: iso(env.now - 3600e3), to: iso(env.now - 3000e3) });
    const t = st(await get(env, S.all)).timeLeftSec;
    assert.eq(t, 10 * 4, "10 минут по 4 секунды");
    await env.advance(t - 1);
    assert.eq(st(await get(env, S.all)).state, "running", "ещё идёт");
    await env.advance(2);
    assert.eq([st(await get(env, S.all)).state, st(await get(env, S.all)).gaps[0].result], ["ok", "done"], "закончил в срок");
    // Носитель с ошибкой: ждёт, один отказ media; Profile G — отказ profile
    await env.ok("POST", "/test/events", { type: "edge.check", deviceId: S.all, mediaOk: false });
    await gap(env, { deviceId: S.all, from: iso(env.now - 1800e3), to: iso(env.now - 1200e3) });
    await env.advance(30);
    assert.eq([st(await get(env, S.all)).state, st(await get(env, S.all)).timeLeftSec], ["waiting", null], "носитель: ждёт, не running навсегда");
    await env.advance(30);
    assert.eq((await journalOf(env, S.all)).filter((e) => e.kind === "replication.failed" && e.fields.reason === "media").length, 1, "один отказ media");
    await env.ok("POST", "/test/events", { type: "edge.check", deviceId: S.all, mediaOk: true, profileG: false });
    await env.advance(30);
    assert.eq(st(await get(env, S.all)).state, "waiting", "Profile G: ждёт");
    assert.eq((await journalOf(env, S.all)).filter((e) => e.fields && e.fields.reason === "profile").length, 1, "отказ profile");
    await env.ok("POST", "/test/events", { type: "edge.check", deviceId: S.all, profileG: true });
    await env.advance(1);
    assert.eq(st(await get(env, S.all)).state, "running", "причина ушла — забор пошёл");
  }, { needs: [...needs, "clock", "kind:storage"] });

  test("Связь и события: связь камеры — связь её хранилища; правка режима камеры сообщает хранилищу; «за сутки» обнуляется", async () => {
    const env = await makeEnv();
    assert.eq((await get(env, S.wait)).status.link, "offline", "хранилище камеры без связи");
    await env.ok("POST", "/test/events", { type: "device.signal", deviceId: CAM.wait, online: true });
    assert.eq((await get(env, S.wait)).status.link, "online", "связь камеры вернулась — вернулась и у хранилища");
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.type === "replication.changed" && seen.push(m), [S.all]);
    await ApiTest.settle();
    const c = await get(env, CAM.all);
    assert.status(await env.call("PATCH", U(c.uid), { properties: { recordMode: "always" } }, v(c)), 200, null, "камера пишет сама");
    await ApiTest.settle();
    stop();
    assert.ok(seen.some((m) => m.entityId === S.all), "хранилище получило replication.changed");
    await env.advance(86400 + 5);
    assert.eq(st(await get(env, S.all)).bytesToday, 0, "новые сутки — счётчик с нуля");
  }, { needs: [...needs, "clock", "kind:storage"] });


  test("Память о режиме не устаревает: правка камеры забывает её; невозможный прежний режим — always; mode: null — выключено", async () => {
    const env = await makeEnv();
    const cam = async () => (await get(env, CAM.off)).properties;
    let c = await get(env, CAM.off);
    assert.status(await env.call("PATCH", U(c.uid), { properties: { recordMode: "motion" } }, v(c)), 200, null, "motion");
    let s = await okRep(env, await get(env, S.off), { mode: "all" });
    c = await get(env, CAM.off);
    assert.status(await env.call("PATCH", U(c.uid), { properties: { recordMode: "always" } }, v(c)), 200, null, "пользователь: always");
    c = await get(env, CAM.off);
    assert.status(await env.call("PATCH", U(c.uid), { properties: { recordMode: "replica" } }, v(c)), 200, null, "пользователь: replica");
    s = await okRep(env, await get(env, S.off), { mode: "off" });
    assert.eq((await cam()).recordMode, "always", "motion давно забыт: выключение даёт always, а не устаревшее motion");
    // mode: null — то же, что replication: null
    s = await okRep(env, s, { mode: "all" });
    s = await okRep(env, s, { mode: null });
    assert.eq([rep(s).mode, (await cam()).recordMode], ["off", "always"], "mode: null — выключено, камера снова пишет сама");
  }, { needs: [...needs, "kind:camera"] });

  ApiTest.loaded("api-edge.js");
})();
