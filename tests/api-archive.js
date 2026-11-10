/* Тесты API: виды хранилищ от сервера, архив на весь сервер, запись камеры по виду, том.
   Пути ядра: хранилище — объект вида archive.<вид> под сервером (POST /units с томом-дочерним), том — volume, камера и карта
   камеры w2c — camera и storage; запись камеры — её свойства (properties), состояние записи — status.observed. Поле отказа —
   JSON Pointer (/properties/<имя>). Обход и скан архива — свои пути (/archive-watches, /archive-scans), камера — по uid. */
(() => {
  const { test, makeEnv, assert, key, FX, fixtureName } = ApiTest;
  const GB = 1024 ** 3;
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const U = (uid) => `/units/${uid}`;
  const of = (kind) => FX.archives.find((a) => a.kind === kind);
  const edge = of("edge");
  const backup = of("backup");
  const incidents = of("incidents");
  const local = FX.archives.find((a) => a.kind === "local" && a.serverId === backup.serverId);
  const camOn = (sid) => FX.devices.find((d) => d.type === "camera" && d.serverId === sid && !d.extraArchives);
  const cam = camOn(backup.serverId);
  const edgeCam = camOn(edge.serverId);
  const emptySrv = FX.servers.find((s) => s.allocated && s.online && !FX.archives.some((a) => a.kind === "edge" && a.serverId === s.id) && s.disks.some((d) => !d.system && !FX.volumes.some((x) => x.disk === d.disk && FX.archives.some((a) => a.id === x.archiveId && a.serverId === s.id))));
  const freeDisk = (s) => s.disks.find((d) => !d.system && !FX.volumes.some((x) => x.disk === d.disk && FX.archives.some((a) => a.id === x.archiveId && a.serverId === s.id))).disk;
  // Карта сервера строкой UnitCreate: хранилище archive.edge под сервером, первый том — дочерний той же строки
  const card = (props, over) => Object.assign({ kind: "archive.edge", parentId: emptySrv.id, name: "Карта",
    properties: Object.assign({ storage: "block", encrypted: false, retentionDays: 3, provider: null }, props),
    children: [{ kind: "volume", name: "D", properties: { disk: freeDisk(emptySrv), sizeBytes: 64 * GB, mode: "dir", dir: "D:\\Edge" } }] }, over);
  const create = (env, ...items) => env.ok("POST", "/units", { idempotencyKey: key(), items });
  const refused = async (env, spec) => (await create(env, spec)).failed.map((x) => [x.code, x.field]);
  const field = (res, code, name, msg) => { assert.status(res, 422, code, msg); assert.eq(res.body.field, name, `${msg}: поле`); };
  const P = (name) => `/properties/${name}`;
  const put = (env, u, properties) => env.call("PATCH", U(u.uid), { properties }, v(u));
  const set = (env, u, properties) => env.ok("PATCH", U(u.uid), { properties }, v(u));
  const get = (env, uid) => env.ok("GET", U(uid));
  // Виды хранилищ и детекторов — в описаниях видов: x-archive видов archive.<вид>, перечень detectorKind вида det
  const archiveKind = (kind) => (FX.kinds.find((k) => k.kind === `archive.${kind}`) || {})["x-archive"];
  const DET_KINDS = (((FX.kinds.find((k) => k.kind === "det") || {}).schema || {}).properties || {}).detectorKind.enum;
  // Потоки камеры — дочерние объекты вида stream, основной — первый
  const streams = async (env, uid) => (await env.list(`/units?parentId=${uid}&kind=stream`)).sort((a, b) => (a.uid < b.uid ? -1 : 1)).map((s) => s.properties.streamId);
  const lastOp = async (env) => (await env.ok("GET", "/operations")).items[0];

  test("Виды: описания archive.<вид> с x-archive; вид вне списка — 422 NOT_SUPPORTED, field: /kind", async () => {
    const env = await makeEnv();
    const ref = await env.ok("GET", "/reference");
    const archives = (await env.ok("GET", "/kinds")).items.filter((k) => (k.implements || []).includes("vms.archive/1"));
    assert.ok(archives.every((k) => k["x-archive"] && Array.isArray(k["x-archive"].recordModes) && Array.isArray(k["x-archive"].archiveModes)), "у каждого вида — x-archive");
    assert.ok(!("archiveKinds" in ref), "справочника archiveKinds нет — виды в /kinds");
    // Эталонный набор — шесть видов с «Облачным» (запрос mockup 2026-11-03), профиль как у w2c — пять, cloud не объявляется
    const kinds = ["backup", "edge", "incidents", "local", "network"].concat(fixtureName === "demo" ? ["cloud"] : []).map((k) => `archive.${k}`).sort();
    assert.eq(archives.map((x) => x.kind).sort(), kinds, fixtureName === "demo" ? "шесть видов с cloud" : "пять видов, cloud не объявляется");
    assert.ok(ref.recordModes.includes("backup"), "значение backup в reference.recordModes");
    assert.eq(await refused(env, card({}, { kind: "archive.tape" })), [["NOT_SUPPORTED", "/kind"]], "вид вне списка");
    // Проверка тома — команда check вида хранилища; у edge её нет
    assert.status(await env.call("POST", `${U(edge.id)}/actions/check`, { params: { volume: { name: "x", disk: "D:", sizeBytes: GB } } }), 404, "NOT_FOUND", "у edge проверки нет");
  }, { needs: ["createUnits", "kind:archive.edge"] });

  test("Карта сервера: сервер обязателен, одна на сервер, режим из archiveModes, шифрования нет", async () => {
    const env = await makeEnv();
    assert.eq(await refused(env, card({}, { parentId: null, domainId: FX.domains[0].id })), [["PARENT_MISMATCH", "/parentId"]], "без сервера");
    assert.eq(await refused(env, card({ recordMode: "motion" })), [["VALIDATION_FAILED", P("recordMode")]], "значения нет в схеме");
    // Шифрования у вида нет — схема вида (const false): VALIDATION_FAILED, как у прочих запретов схемы ядра
    assert.eq(await refused(env, card({ encrypted: true })), [["VALIDATION_FAILED", P("encrypted")]], "шифрования нет");
    const [made] = (await create(env, card())).done[0].units;
    assert.ok(!("recordMode" in made.properties), "нет в теле — нет поля: режим «Авто»");
    const twice = card();
    twice.children[0].properties.dir = "D:\\Edge2";
    assert.eq(await refused(env, twice), [["VALIDATION_FAILED", "/parentId"]], "вторая на сервере");
    const local2 = await set(env, made, { recordMode: "always" });
    assert.eq(local2.properties.recordMode, "always", "режим правится");
    const a = FX.archives.find((x) => x.kind === "local");
    field(await env.call("PATCH", U(a.id), { properties: { recordMode: "always" } }, v(a)), "VALIDATION_FAILED", P("recordMode"), "у локального поля нет");
    // «Авто»: null снимает поле, откат возвращает значение, откат «вернуть режим» — снова отсутствие поля
    assert.eq(archiveKind("edge").archiveModeDefault, "backup", "вид предлагает «при сбое»");
    const auto = await set(env, local2, { recordMode: null });
    assert.ok(!("recordMode" in auto.properties), "null снимает поле");
    const back = await env.finished((await env.ok("POST", `/operations/${(await lastOp(env)).id}/revert`)).id);
    assert.eq(back.ok, 1, "откат прошёл");
    assert.eq((await get(env, made.uid)).properties.recordMode, "always", "откат вернул значение");
    const again = await env.finished((await env.ok("POST", `/operations/${(await env.ok("GET", "/operations")).items.find((o) => !o.revertOf && o.revertible).id}/revert`)).id);
    assert.eq(again.ok, 1, "откат установки режима");
    assert.ok(!("recordMode" in (await get(env, made.uid)).properties), "откат вернул отсутствие поля");
  }, { needs: ["createUnits", "patchUnit", "kind:archive.edge"] });

  test("Карта сервера: строка у всех камер сервера только для чтения, запись — отказ, правка и удаление меняют камеры", async () => {
    const env = await makeEnv();
    const c = await get(env, edgeCam.id);
    const row = (c.properties.extraArchives || []).find((x) => x.archiveId === edge.id);
    assert.eq([row.recordMode, row.readOnly], ["backup", true], "строка");
    assert.ok(!(await get(env, cam.id)).properties.extraArchives, "у камеры другого сервера строки нет");
    field(await put(env, c, { extraArchives: [{ archiveId: edge.id, recordMode: "backup", stream: "main" }] }), "NOT_SUPPORTED", P("extraArchives"), "строку не посылают");
    await env.ok("PATCH", U(edge.id), { properties: { recordMode: "always" } }, v(edge));
    const c2 = await get(env, c.uid);
    assert.eq(c2.properties.extraArchives.find((x) => x.archiveId === edge.id).recordMode, "always", "строка показывает режим архива");
    assert.ok(c2.version !== c.version, "видимое изменилось — версия тоже");
    const fresh = await get(env, edge.id);
    assert.status(await env.call("DELETE", U(edge.id), undefined, v(fresh)), 204);
    assert.ok(!((await get(env, c.uid)).properties.extraArchives || []).some((x) => x.archiveId === edge.id), "архив снят — строки нет");
  }, { needs: ["patchUnit", "deleteUnit", "kind:archive.edge", "kind:camera"] });

  test("Запись камеры по виду: backup — только дополнительный на виде backup, инциденты не привязываются", async () => {
    const env = await makeEnv();
    const c = await get(env, cam.id);
    field(await put(env, c, { recordMode: "backup" }), "NOT_SUPPORTED", P("recordMode"), "основная не бывает backup");
    field(await put(env, c, { archiveId: backup.id, recordMode: "always" }), "NOT_SUPPORTED", P("archiveId"), "архив резерва основным не бывает");
    field(await put(env, c, { extraArchives: [{ archiveId: backup.id, recordMode: "always", stream: "main" }] }), "NOT_SUPPORTED", P("recordMode"), "на архиве резерва только backup");
    field(await put(env, c, { extraArchives: [{ archiveId: local.id, recordMode: "backup", stream: "main" }] }), "NOT_SUPPORTED", P("recordMode"), "backup — только на виде backup");
    field(await put(env, c, { extraArchives: [{ archiveId: incidents.id, recordMode: "always", stream: "main" }] }), "NOT_SUPPORTED", P("extraArchives"), "инциденты");
    const ok = await set(env, c, { extraArchives: [{ archiveId: backup.id, recordMode: "backup", stream: "main" }] });
    assert.eq(ok.properties.extraArchives.map((x) => [x.archiveId, x.recordMode]), [[backup.id, "backup"]], "резерв записан");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Создание камеры: те же правила записи", async () => {
    const env = await makeEnv();
    const row = { kind: "camera", name: "Новая", domainId: FX.domains[0].id, properties: { vendor: "Axis", model: "M3106", archiveId: backup.id, recordMode: "backup" } };
    const res = await create(env, row);
    assert.eq([res.done.length, res.failed.map((f) => [f.code, f.field])], [0, [["NOT_SUPPORTED", P("recordMode")]]], "отказ по строке");
  }, { needs: ["createUnits", "kind:camera"] });

  test("Хранилище снято: резерв на сбой основным не становится", async () => {
    const env = await makeEnv();
    const c = await get(env, cam.id);
    const a = await get(env, c.properties.archiveId);
    await set(env, c, { extraArchives: [{ archiveId: backup.id, recordMode: "backup", stream: "main" }] });
    assert.status(await env.call("DELETE", U(a.uid), undefined, v(a)), 204);
    const now = (await get(env, c.uid)).properties;
    assert.eq([now.archiveId ?? null, now.recordMode, now.extraArchives.length], [null, "none", 1], "основной нет, резерв остался дополнительным");
  }, { needs: ["patchUnit", "deleteUnit", "kind:camera"] });

  test("Архив не принимает записи: новая привязка — отказ, инциденты всегда false", async () => {
    const env = await makeEnv();
    assert.eq(incidents.admits, false, "инциденты");
    field(await env.call("PATCH", U(incidents.id), { properties: { admits: true } }, v(incidents)), "VALIDATION_FAILED", P("admits"), "инциденты всегда false");
    const off = await env.ok("PATCH", U(local.id), { properties: { admits: false } }, v(local));
    assert.eq(off.properties.admits, false, "выключено");
    const free = FX.devices.find((d) => d.type === "camera" && d.serverId === local.serverId && d.archiveId !== local.id);
    if (free) field(await put(env, await get(env, free.id), { archiveId: local.id, recordMode: "always" }), "VALIDATION_FAILED", P("archiveId"), "новая камера");
    const old = FX.devices.find((d) => d.type === "camera" && d.archiveId === local.id && d.recordMode !== "replica");
    assert.status(await put(env, await get(env, old.id), { preRecordSec: 7 }), 200, null, "прежняя запись живёт");
    assert.status(await put(env, await get(env, old.id), { recordMode: "motion" }), 200, null, "и правится");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Том: меньший объём — второе подтверждение, то же число; не хранится", async () => {
    const env = await makeEnv();
    const vol = FX.volumes.find((x) => x.sizeBytes > 2 * GB && x.shrinkPendingBytes == null);
    const less = vol.sizeBytes - GB;
    const patch = (properties, rec) => env.call("PATCH", U(vol.id), { properties }, v(rec || vol));
    field(await patch({ sizeBytes: less }), "VALIDATION_FAILED", P("sizeBytes"), "без подтверждения");
    field(await patch({ sizeBytes: less, confirmShrinkBytes: less + 1 }), "VALIDATION_FAILED", P("confirmShrinkBytes"), "другое число");
    const res = (await patch({ sizeBytes: less, confirmShrinkBytes: less })).body;
    assert.eq([res.properties.sizeBytes, "confirmShrinkBytes" in res.properties], [less, false], "применено");
    // Шаг операции по uid судит выполнение: то же правило — отказ шага
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: vol.id, patch: { properties: { sizeBytes: less - GB } } }], expectedVersions: { [vol.id]: res.version } });
    assert.eq([op.items[0].state, op.items[0].code, op.items[0].params.field], ["fail", "VALIDATION_FAILED", P("sizeBytes")], "в операции то же правило");
  }, { needs: ["patchUnit", "kind:volume"] });

  test("Том: объявленное уменьшение ждёт подтверждения; выключение — состояние off", async () => {
    const env = await makeEnv();
    const vol = FX.volumes.find((x) => x.shrinkPendingBytes != null);
    const n = vol.shrinkPendingBytes;
    const res = await env.ok("PATCH", U(vol.id), { properties: { sizeBytes: n, confirmShrinkBytes: n } }, v(vol));
    assert.eq([res.properties.sizeBytes, "shrinkPendingBytes" in ((res.status || {}).observed || {})], [n, false], "подтверждено, ожидания нет");
    const off = await env.ok("PATCH", U(vol.id), { properties: { enabled: false } }, v(res));
    assert.eq([off.properties.enabled, off.properties.state], [false, "off"], "выключен");
    const back = await env.finished((await env.ok("POST", `/operations/${(await lastOp(env)).id}/revert`)).id);
    assert.eq(back.ok, 1, "выключение откатывается");
    const on = (await get(env, vol.id)).properties;
    assert.eq([on.state, on.enabled ?? true], ["ready", true], "снова готов");
  }, { needs: ["patchUnit", "kind:volume"] });

  // replica: источник — встроенное хранилище или другой архив этой камеры
  const devs = FX.devices;
  const hasStorage = (d) => devs.some((x) => x.type === "storage" && x.parentId === d.id);
  const free = devs.find((d) => d.type === "camera" && d.archiveId && !d.extraArchives && !d.parentId && hasStorage(d) && d.recordMode === "always" && d.streams?.length > 1) || null;
  const bare = devs.find((d) => d.type === "camera" && d.archiveId && !d.parentId && !hasStorage(d) && !d.extraArchives && d.streams?.length) || null;
  const second = (d) => FX.archives.find((a) => a.id !== d.archiveId && a.domainId === d.domainId && a.kind === "network" && a.admits !== false);
  const needs = { needs: ["patchUnit", "kind:storage", "kind:camera"] };

  test("replica: со встроенного — основной поток, поток sub — 422 NOT_SUPPORTED, field: /properties/stream", async () => {
    const env = await makeEnv();
    const c = await get(env, free.id);
    const [main, sub] = await streams(env, c.uid);
    const ok = await set(env, c, { recordMode: "replica", replicaFrom: null });
    assert.eq([ok.properties.recordMode, ok.properties.replicaFrom ?? null], ["replica", null], "основная забирает со встроенного");
    field(await put(env, ok, { stream: sub }), "NOT_SUPPORTED", P("stream"), "второй поток");
    const a = second(free);
    field(await put(env, ok, { extraArchives: [{ archiveId: a.id, recordMode: "replica", stream: sub, replicaFrom: null }] }), "NOT_SUPPORTED", P("stream"), "в строке так же");
    assert.status(await put(env, ok, { extraArchives: [{ archiveId: a.id, recordMode: "replica", stream: main, replicaFrom: null }] }), 200, null, "основной поток можно");
  }, needs);

  test("replica: другой архив камеры, тот же поток; чужой архив, сам у себя, цикл, резерв — 422 VALIDATION_FAILED", async () => {
    const env = await makeEnv();
    const c = await get(env, free.id);
    const [main, sub] = await streams(env, c.uid);
    const a = second(free), row = (over) => ({ archiveId: a.id, recordMode: "replica", stream: main, replicaFrom: free.archiveId, ...over });
    const b = FX.archives.find((x) => x.kind === "backup" && x.serverId === free.serverId) || backup;
    assert.status(await put(env, c, { extraArchives: [row()] }), 200, null, "из основного архива");
    const c2 = await get(env, c.uid);
    assert.eq(c2.properties.extraArchives[0].replicaFrom, free.archiveId, "источник записан");
    field(await put(env, c2, { extraArchives: [row({ stream: sub })] }), "VALIDATION_FAILED", P("stream"), "другой поток");
    field(await put(env, c2, { extraArchives: [row({ replicaFrom: FX.archives.find((x) => x.id !== free.archiveId && x.id !== a.id && x.kind === "local").id })] }), "VALIDATION_FAILED", P("replicaFrom"), "архив не этой камеры");
    field(await put(env, c2, { extraArchives: [row({ replicaFrom: a.id })] }), "VALIDATION_FAILED", P("replicaFrom"), "сам у себя");
    field(await put(env, c2, { recordMode: "replica", replicaFrom: a.id }), "VALIDATION_FAILED", P("replicaFrom"), "забирают друг у друга");
    field(await put(env, c2, { extraArchives: [{ archiveId: b.id, recordMode: "backup", stream: main }, row({ replicaFrom: b.id })] }), "VALIDATION_FAILED", P("replicaFrom"), "резерв источником не бывает");
  }, needs);

  test("replica: без встроенного хранилища — только из другого архива; источник сняли — запись ждёт и говорит причину", async () => {
    const env = await makeEnv();
    const c = await get(env, bare.id);
    const a = second(bare);
    field(await put(env, c, { recordMode: "replica" }), "VALIDATION_FAILED", P("replicaFrom"), "забирать неоткуда");
    const [main] = await streams(env, c.uid);
    assert.status(await put(env, c, { extraArchives: [{ archiveId: a.id, recordMode: "replica", stream: main, replicaFrom: bare.archiveId }] }), 200, null, "из основного архива");
    const c2 = await get(env, c.uid);
    // Сняли основной архив: строка осталась, источник пропал (x-ref replicaFrom — onDelete: keep)
    const src = await get(env, bare.archiveId);
    assert.status(await env.call("DELETE", U(src.uid), undefined, v(src)), 204);
    const c3 = await get(env, c.uid);
    const obs = (c3.status || {}).observed || {};
    assert.eq([obs.recordState === "waiting" || (c3.properties.extraArchives || []).some((x) => x.state === "waiting"), /Источник снят/.test(JSON.stringify(c3))], [true, true], "запись ждёт, причина словами");
    assert.ok(c2.version !== c3.version, "камера изменилась");
  }, { needs: ["patchUnit", "deleteUnit", "kind:camera"] });

  test("replica в наборе: источник из архива, отставание, слово о потере и журнал; план по шагам проверяется целиком", async () => {
    const env = await makeEnv();
    const list = await env.pages("/units?kind=camera&limit=1000");
    const lag = list.find((u) => (u.properties.extraArchives || []).some((x) => x.recordMode === "replica" && x.replicaFrom && x.replicaLagSec != null));
    const row = lag.properties.extraArchives.find((x) => x.replicaFrom);
    assert.ok(row.replicaLagSec > 0 && row.replicaFrom === lag.properties.archiveId, "строка забирает из основного");
    const obs = (u) => (u.status || {}).observed || {};
    const lost = list.find((u) => u.properties.recordMode === "replica" && /Потеряно/.test(obs(u).recordReason || ""));
    assert.ok(lost && obs(lost).replicaLagSec > 0, "слово о потере и отставание у камеры");
    const j = await env.ok("GET", `/journal?deviceId=${lost.uid}`);
    assert.ok(j.items.some((e) => e.kind === "replica.lost"), "потеря — в журнале");
    // Шаги одного плана: сначала режим, потом источник. Проверка — по итогу, а не по шагу
    const a = second(free);
    const c = await get(env, bare.id);
    const [main] = await streams(env, c.uid);
    const step = (properties) => ({ uid: c.uid, patch: { properties } });
    const op = await env.runOperation({ idempotencyKey: key(), items: [
      step({ extraArchives: [{ archiveId: a.id, recordMode: "always", stream: main }] }),
      step({ recordMode: "replica" }),
      step({ replicaFrom: a.id }),
    ], expectedVersions: { [c.uid]: c.version } });
    assert.eq(op.ok, 3, "план выполнен");
    assert.eq((await get(env, c.uid)).properties.replicaFrom, a.id, "источник на месте");
  }, needs);

  test("Режим не replica: источника и отставания в записи нет; поля сервера правка строки не стирает", async () => {
    const env = await makeEnv();
    const c = (await env.pages("/units?kind=camera&limit=1000")).find((u) => (u.properties.extraArchives || []).some((x) => x.replicaLagSec != null && !x.readOnly));
    const rows = c.properties.extraArchives.filter((x) => !x.readOnly);
    const res = await set(env, c, { preRecordSec: 9, extraArchives: rows.map((x) => ({ archiveId: x.archiveId, recordMode: x.recordMode, stream: x.stream, replicaFrom: x.replicaFrom, labels: ["gpu"] })) });
    const r = res.properties.extraArchives.find((x) => x.replicaLagSec != null);
    assert.ok(r && r.labels.length === 1, "отставание осталось, метка записана");
    const row = (await set(env, res, { extraArchives: rows.map((x) => ({ archiveId: x.archiveId, recordMode: x.recordMode === "replica" ? "always" : x.recordMode, stream: x.stream })) })).properties.extraArchives;
    assert.ok(row.every((x) => x.recordMode !== "always" || (!("replicaFrom" in x) && !("replicaLagSec" in x))), "у другого режима этих полей нет");
  }, needs);

  test("Скан и обход: archiveJobs false — 422 deviceId; правка и снятие без права на камеру — 403", async () => {
    const env = await makeEnv();
    const off = FX.devices.find((d) => d.archiveJobs === false);
    const body = { deviceId: off.id, archiveId: off.archiveId, detectorKind: DET_KINDS[0], from: new Date(env.now - 7200000).toISOString().replace(/\.\d{3}Z$/, "Z"), to: new Date(env.now - 3600000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    const scan = await env.call("POST", "/archive-scans", body);
    assert.status(scan, 422, "NOT_SUPPORTED", "скан");
    assert.eq(scan.body.field, "deviceId", "поле");
    const watch = await env.call("POST", "/archive-watches", { deviceId: off.id, detectorKind: body.detectorKind });
    assert.status(watch, 422, "NOT_SUPPORTED", "обход");
    assert.eq(watch.body.field, "deviceId", "поле");
    const adm = FX.access.roles.find((r) => r.global.unr);
    const feats = (u) => u.roleIds.concat(...FX.access.groups.filter((g) => g.memberIds.includes(u.id)).map((g) => g.roleIds)).flatMap((id) => { const r = FX.access.roles.find((x) => x.id === id); return r.global.unr ? ["ADMIN"] : r.global.feat; });
    const reader = FX.access.users.find((u) => u.enabled && !feats(u).includes("ADMIN") && !feats(u).includes("DEVICES_SETUP"));
    const low = await makeEnv({ actAs: reader.login });
    const w = FX.archiveWatches[0], x = FX.archiveScans[0];
    assert.status(await low.call("PATCH", `/archive-watches/${w.id}`, { enabled: !w.enabled }, { "If-Match": `"${w.version}"` }), 403, "PERMISSION_DENIED", "правка обхода");
    assert.status(await low.call("DELETE", `/archive-watches/${w.id}`, undefined, { "If-Match": `"${w.version}"` }), 403, "PERMISSION_DENIED", "снятие обхода");
    assert.status(await low.call("DELETE", `/archive-scans/${x.id}`), 403, "PERMISSION_DENIED", "снятие скана");
    assert.ok(adm && (await low.list("/archive-watches")).some((y) => y.id === w.id), "обход на месте");
  }, { needs: ["createArchiveWatch"] });

  // Что правится у объекта сейчас — Unit.writable: у карты камеры w2c — recordMode, sizeBytes; у обычного встроенного — ничего
  // Правка карты камеры w2c — recordMode и sizeBytes; replication (vms.edge/1) правится у любого встроенного хранилища
  const writable = (u) => (u.writable || []).some((k) => k !== "replication");

  test("Карта камеры w2c: уменьшение только с подтверждением; поле не хранится; откат объёма не возвращает, как у тома", async () => {
    const env = await makeEnv();
    const cardRec = (await env.list("/units?kind=storage")).find((u) => writable(u));
    const size = cardRec.properties.sizeBytes, less = size - 1024 ** 3;
    field(await put(env, cardRec, { sizeBytes: less }), "VALIDATION_FAILED", P("sizeBytes"), "меньше без подтверждения");
    field(await put(env, cardRec, { sizeBytes: less, confirmShrinkBytes: less + 1 }), "VALIDATION_FAILED", P("confirmShrinkBytes"), "другое число");
    const small = await set(env, cardRec, { sizeBytes: less, confirmShrinkBytes: less });
    assert.eq([small.properties.sizeBytes, "confirmShrinkBytes" in small.properties], [less, false], "применено, поле не хранится");
    const big = await set(env, small, { sizeBytes: size });
    assert.eq(big.properties.sizeBytes, size, "больше — без подтверждения");
    const back = await env.finished((await env.ok("POST", `/operations/${(await lastOp(env)).id}/revert`, {})).id);
    assert.eq([back.failed, back.items[0].code], [1, "NOT_SUPPORTED"], "шаг отказал, сервер не упал");
    assert.eq((await get(env, cardRec.uid)).properties.sizeBytes, size, "объём на месте");
  }, { needs: ["patchUnit", "kind:storage"] });

  test("Карта камеры w2c: запись storage, recordMode и sizeBytes правятся, остальное — нет; обычная только чтение", async () => {
    const env = await makeEnv();
    const list = await env.list("/units?kind=storage");
    const cardRec = list.find((u) => writable(u));
    assert.eq([cardRec.writable, list.filter((u) => writable(u)).length], [["recordMode", "sizeBytes", "replication"], 1], "одна карта в наборе");
    assert.ok(list.every((u) => !("writableFields" in ((u.status || {}).observed || {}))), "в status.observed списка правок нет");
    const res = await set(env, cardRec, { recordMode: "always", sizeBytes: cardRec.properties.sizeBytes * 2 });
    assert.eq([res.properties.recordMode, res.properties.sizeBytes], ["always", cardRec.properties.sizeBytes * 2], "режим и объём");
    field(await put(env, res, { recordMode: "motion" }), "VALIDATION_FAILED", P("recordMode"), "только постоянно или при сбое");
    field(await env.call("PATCH", U(res.uid), { name: "Другая" }, v(res)), "NOT_SUPPORTED", "/name", "имя постоянное");
    const plain = list.find((u) => !writable(u));
    assert.eq(plain.writable, ["replication"], "у обычного встроенного — только репликация");
    field(await put(env, plain, { sizeBytes: GB }), "NOT_SUPPORTED", P("sizeBytes"), "обычное — только чтение");
    assert.ok(!(await env.list("/units?implements=vms.archive/1")).some((a) => a.uid === cardRec.uid), "среди хранилищ её нет");
  }, needs);

  // Запись по расписанию, срок и глубина строки, микрофон
  const plainCam = () => FX.devices.find((d) => d.type === "camera" && d.archiveId && d.recordMode === "always" && !d.extraArchives && !d.parentId);

  test("По расписанию: recordScheduleId обязателен, неизвестный — отказ; расписание сняли — запись ждёт", async () => {
    const env = await makeEnv();
    const c = await get(env, plainCam().id);
    const sc = FX.schedules.find((s) => !s.builtin && !s.owner);
    field(await put(env, c, { recordMode: "sched" }), "VALIDATION_FAILED", P("recordScheduleId"), "без расписания");
    field(await put(env, c, { recordMode: "sched", recordScheduleId: "f0009999-0000-4000-8000-000000000000" }), "VALIDATION_FAILED", P("recordScheduleId"), "неизвестное");
    const ok = await set(env, c, { recordMode: "sched", recordScheduleId: sc.id });
    assert.eq(ok.properties.recordScheduleId, sc.id, "записано");
    const fresh = await env.ok("GET", `/schedules/${sc.id}`);
    assert.status(await env.call("DELETE", `/schedules/${sc.id}`, undefined, v(fresh)), 204);
    const now = await get(env, c.uid);
    const obs = (now.status || {}).observed || {};
    assert.eq([obs.recordState, /Расписание снято/.test(obs.recordReason)], ["waiting", true], "запись ждёт, причина словами");
    assert.status(await put(env, now, { preRecordSec: 3 }), 200, null, "прочие правки идут");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Срок и глубина: у записи свои, глубина больше срока — отказ; срок архива их не трогает", async () => {
    const env = await makeEnv();
    const c = await get(env, plainCam().id);
    const a = await get(env, c.properties.archiveId);
    const res = await set(env, c, { retentionDays: 10, minDepthDays: 5 });
    assert.eq([res.properties.retentionDays, res.properties.minDepthDays], [10, 5], "основная запись");
    field(await put(env, res, { minDepthDays: 11 }), "VALIDATION_FAILED", P("minDepthDays"), "глубина больше срока");
    await env.ok("PATCH", U(a.uid), { properties: { retentionDays: 3 } }, v(a));
    assert.eq((await get(env, c.uid)).properties.retentionDays, 10, "срок записи не изменился");
    const other = FX.archives.find((x) => x.id !== c.properties.archiveId && x.kind === "network" && x.domainId === c.domainId && x.admits !== false);
    const fresh = await get(env, c.uid);
    const row = await set(env, fresh, { extraArchives: [{ archiveId: other.id, recordMode: "always", stream: "main", retentionDays: 90, minDepthDays: 30 }] });
    assert.eq([row.properties.extraArchives[0].retentionDays, row.properties.extraArchives[0].minDepthDays], [90, 30], "строка");
  }, { needs: ["patchUnit", "kind:camera"] });

  test("Микрофон записи: запись mic этой камеры, null — первый", async () => {
    const env = await makeEnv();
    const c = FX.devices.find((d) => d.type === "camera" && FX.devices.filter((x) => x.type === "mic" && x.parentId === d.id).length > 1);
    const fresh = await get(env, c.id);
    const mics = FX.devices.filter((x) => x.type === "mic" && x.parentId === c.id);
    assert.eq(fresh.properties.audioDeviceId, mics[1].id, "в наборе — второй");
    const res = await set(env, fresh, { audioDeviceId: mics[0].id });
    assert.eq(res.properties.audioDeviceId, mics[0].id, "выбран");
    field(await put(env, res, { audioDeviceId: FX.devices.find((x) => x.type === "mic" && x.parentId !== c.id).id }), "VALIDATION_FAILED", P("audioDeviceId"), "чужой микрофон");
    assert.ok(!("audioDeviceId" in (await set(env, res, { audioDeviceId: null })).properties), "null — поля нет, первый");
  }, needs);

  test("Настройки: сроки событий и тревог", async () => {
    const env = await makeEnv();
    const s = await env.ok("GET", "/settings");
    assert.eq([s.values["events.retentionDays"], s.values["alarms.retentionDays"]], [90, 365], "в наборе");
    const res = await env.ok("PATCH", "/settings", { values: { "events.retentionDays": 30 } }, v(s));
    assert.eq(res.values["events.retentionDays"], 30, "записано");
    assert.status(await env.call("PATCH", "/settings", { values: { "alarms.retentionDays": -1 } }, v(res)), 422, "VALIDATION_FAILED");
  });

  // Обход и скан
  const watched = FX.archiveWatches?.[0];
  const wbody = (over) => ({ deviceId: free.id, detectorKind: "lpr", ...over });

  test("Обход архива: завести, умолчания, правка, снять; отказы", async () => {
    const env = await makeEnv();
    const list = (await env.ok("GET", `/archive-watches?deviceId=${watched.deviceId}`)).items;
    assert.eq([list.length, list[0].through, list[0].overrunSec], [1, list[0].through, 120], "в наборе: дошёл, стёрто 120 с");
    const w = await env.ok("POST", "/archive-watches", wbody({ params: "plate=ru", alarms: ["lpr"], labels: ["gpu"], mask: { shape: "rect", points: [[0, 0], [1, 1]] } }));
    assert.eq([w.start, w.keep, w.preSec, w.postSec, w.joinSec, w.enabled, w.through, w.overrunSec, w.params, w.mask.shape, w.alarms, w.labels], ["now", "none", 5, 5, 30, true, null, 0, "plate=ru", "rect", ["lpr"], ["gpu"]], "умолчания и поля");
    field(await env.call("POST", "/archive-watches", wbody()), "VALIDATION_FAILED", "detectorKind", "тот же вид у той же камеры");
    field(await env.call("POST", "/archive-watches", wbody({ detectorKind: "tape" })), "VALIDATION_FAILED", "detectorKind", "нет такого вида");
    field(await env.call("POST", "/archive-watches", wbody({ detectorKind: "motion", keep: "hits" })), "VALIDATION_FAILED", "archiveId", "сохранять некуда");
    field(await env.call("POST", "/archive-watches", wbody({ detectorKind: "motion", keep: "hits", archiveId: FX.archives.find((a) => a.id !== free.archiveId && a.kind === "local").id })), "VALIDATION_FAILED", "archiveId", "архив не этой камеры");
    field(await env.call("POST", "/archive-watches", wbody({ detectorKind: "motion", mask: { shape: "rect", points: [[0, 0]] } })), "VALIDATION_FAILED", "mask", "маска");
    field(await env.call("POST", "/archive-watches", wbody({ detectorKind: "motion", alarms: ["нет"] })), "VALIDATION_FAILED", "alarms", "вид события");
    field(await env.call("POST", "/archive-watches", wbody({ deviceId: bare.id, detectorKind: "motion" })), "NOT_SUPPORTED", "deviceId", "нет архива устройства");
    const up = await env.ok("PATCH", `/archive-watches/${w.id}`, { keep: "hits", archiveId: free.archiveId, enabled: false }, v(w));
    assert.eq([up.keep, up.archiveId, up.enabled], ["hits", free.archiveId, false], "правка");
    assert.status(await env.call("PATCH", `/archive-watches/${w.id}`, { deviceId: bare.id }, v(up)), 422, "VALIDATION_FAILED", "камера не меняется");
    assert.status(await env.call("PATCH", `/archive-watches/${w.id}`, { enabled: true }, v(w)), 412, "VERSION_MISMATCH");
    assert.status(await env.call("DELETE", `/archive-watches/${w.id}`), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("DELETE", `/archive-watches/${w.id}`, undefined, v(up)), 204);
    assert.ok(!(await env.ok("GET", "/archive-watches")).items.some((x) => x.id === w.id), "снят");
  }, { needs: ["createArchiveWatch", "kind:storage"] });

  test("Обход архива: снята камера — снят и он; снят архив — только ищет", async () => {
    const env = await makeEnv();
    const a = await get(env, watched.archiveId);
    assert.status(await env.call("DELETE", U(a.uid), undefined, v(a)), 204);
    const w = (await env.ok("GET", "/archive-watches")).items[0];
    assert.eq([w.keep, w.archiveId], ["none", null], "сохранять некуда");
    const c = await get(env, watched.deviceId);
    assert.status(await env.call("DELETE", U(c.uid), undefined, v(c)), 204);
    assert.eq((await env.ok("GET", "/archive-watches")).items.length, 0, "обхода нет");
  }, { needs: ["createArchiveWatch", "deleteUnit", "kind:storage"] });

  test("Скан архива: итог приходит по часам, поля задачи, отказы, отмена", async () => {
    const env = await makeEnv();
    const c = FX.devices.find((d) => d.type === "camera" && d.archiveId && d.online);
    const span = { deviceId: c.id, archiveId: c.archiveId, detectorKind: "motion", from: "2026-10-28T10:00:00Z", to: "2026-10-28T12:00:00Z" };
    const x = await env.ok("POST", "/archive-scans", { ...span, params: "p", alarms: ["motion"], labels: ["gpu"], mask: { shape: "rect", points: [[0, 0], [1, 1]] } });
    assert.eq([x.state, x.result, x.params, x.alarms, x.labels, x.mask.shape], ["running", null, "p", ["motion"], ["gpu"], "rect"], "идёт");
    if (env.frozen) {
      const fired = await env.advance(2);
      assert.ok(fired.some((f) => f.kind === "archiveScan" && f.id === x.id), "итог в ответе часов");
    }
    const done = await env.until(async () => {
      const it = (await env.ok("GET", `/archive-scans?deviceId=${c.id}`)).items.find((y) => y.id === x.id);
      return it.state !== "running" && it;
    }, "скан закончился");
    assert.eq([done.state, done.result.end, done.result.asked, done.result.covered, done.result.events], ["done", "done", 7200, 7200, 12], "итог");
    field(await env.call("POST", "/archive-scans", { ...span, archiveId: FX.archives.find((a) => a.id !== c.archiveId).id }), "VALIDATION_FAILED", "archiveId", "архив не этой камеры");
    field(await env.call("POST", "/archive-scans", { ...span, to: span.from }), "VALIDATION_FAILED", "to", "пустой отрезок");
    field(await env.call("POST", "/archive-scans", { ...span, detectorKind: "tape" }), "VALIDATION_FAILED", "detectorKind", "нет такого вида");
    assert.status(await env.call("DELETE", `/archive-scans/${x.id}`), 204);
    assert.status(await env.call("DELETE", `/archive-scans/${x.id}`), 404, "NOT_FOUND");
  });

  test("Запись камеры w2c: приёмник — PUT /units/{uid}/recording-target, ответ — объект; снять; сервера нет — 422; вид без vms.camera/1 — /kind", async () => {
    const d1 = FX.domains[0];
    const server = FX.servers.find((s) => s.allocated && s.online && s.domainId === d1.id);
    const id = "39999999-0000-4000-8000-000000000000";
    const w2c = { id, type: "camera", parentId: null, domainId: d1.id, name: "Камера w2c", online: true, enabled: true, direct: false, writableFields: ["name", "enabled"], version: "1" };
    const env = await makeEnv({ fixturePatch: { devices: FX.devices.concat(w2c) } });
    const put = (b, uid = id) => env.call("PUT", `${U(uid)}/recording-target`, b);
    const res = await put({ serverId: server.id, copies: [] });
    assert.status(res, 200);
    // Приёмник записи — в status.observed (так его описывает схема вида), сервер — свойство камеры
    const seen = (r) => (r.body.status || {}).observed || {};
    assert.eq([res.body.uid, seen(res).recordingTarget, res.body.properties.serverId], [id, { serverId: server.id, copies: [] }, server.id], "назначено");
    assert.status(await put({ serverId: "20009999-0000-4000-8000-000000000000", copies: [] }), 422, "VALIDATION_FAILED");
    const off = await put({ serverId: null, copies: [] });
    assert.ok(!("recordingTarget" in seen(off)) && !("serverId" in off.body.properties), "снято");
    field(await put({ serverId: server.id, copies: [] }, FX.devices.find((x) => x.type === "det").id), "NOT_SUPPORTED", "/kind", "не камера");
  }, { needs: ["putUnitRecordingTarget"] });

  ApiTest.loaded("api-archive.js");
})();
