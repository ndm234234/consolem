/* Тесты API: хранилища и тома. Пути ядра (/units): смысл — хуки профилей vms.archive/1 и vms.volume/1. */
(() => {
  const { test, makeEnv, assert, key, FX } = ApiTest;
  const GB = 1024 ** 3;
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const U = (uid) => `/units/${uid}`;
  // Свободный диск сервера: на нём нет томов локальных хранилищ этого сервера
  const usedDisks = (sid) =>
    new Set(FX.volumes.filter((x) => FX.archives.some((a) => a.id === x.archiveId && a.kind === "local" && a.serverId === sid)).map((x) => x.disk));
  // Сервер, у которого свободных дисков хватит на три тома
  const srv = FX.servers.find((s) => s.allocated && s.online && s.disks.filter((d) => !d.system && !usedDisks(s.id).has(d.disk)).length >= 3);
  const freeDisks = srv.disks.filter((d) => !d.system && !usedDisks(srv.id).has(d.disk)).map((d) => d.disk);
  const localArch = FX.archives.find((a) => a.kind === "local" && a.serverId === srv.id) || null;
  const offlineArch = FX.archives.find((a) => a.serverId && !FX.servers.find((s) => s.id === a.serverId).online);
  const otherDomain = FX.domains.find((d) => d.id !== srv.domainId);
  // Шифрование — необязательная возможность: без неё хранилища создаются нешифрованными
  const enc = () => ApiTest.can("feature:archiveEncryption");
  // Том строкой UnitCreate: под хранилищем той же строки или под parentId
  const vol = (disk, over, props) => Object.assign({ kind: "volume", name: disk, properties: Object.assign({ disk, sizeBytes: GB, mode: "dir" }, props) }, over);
  // Локальное хранилище на сервере srv с первым томом — дочерним той же строки
  const local = (props, first, over) => Object.assign({ kind: "archive.local", parentId: srv.id, name: "Хранилище — тест",
    properties: Object.assign({ storage: "object", encrypted: enc(), retentionDays: 14, provider: null }, props),
    children: [first || vol(freeDisks[0], { name: `${freeDisks[0]}\\AxxonArchive\\Тест` }, { sizeBytes: 500 * GB, dir: `${freeDisks[0]}\\AxxonArchive\\Тест` })] }, over);
  const cloud = (first) => ({ kind: "archive.cloud", domainId: FX.domains[0].id, name: "Облако", properties: { storage: "block", encrypted: enc(), retentionDays: 30, provider: "s3" },
    children: [first || { kind: "volume", name: "s3://b/v", properties: { disk: "s3", sizeBytes: 10240 * GB, bucket: "b", region: "eu-central-1", path: "v", keyId: "AKIA", secret: "s" } }] });
  const create = (env, ...items) => env.ok("POST", "/units", { idempotencyKey: key(), items });
  async function made(env, spec) {
    const res = await create(env, spec);
    assert.eq(res.failed.map((x) => [x.code, x.field]), [], `создан ${spec.kind}`);
    return res.done[0].units;
  }
  const refused = async (env, spec) => (await create(env, spec)).failed.map((x) => [x.code, x.field]);

  test("Хранилище: создать локальное с первым томом — 200, оба в списках", async () => {
    const env = await makeEnv();
    const [archive, volume] = await made(env, local());
    assert.eq([archive.kind, archive.properties.storage, archive.properties.encrypted, archive.parentId, volume.parentId, volume.properties.state, volume.status.observed.usedPercent],
      ["archive.local", "object", enc(), srv.id, archive.uid, "ready", 0], "объекты");
    assert.ok((await env.list(`/units?kind=archive.local&parentId=${srv.id}`)).some((a) => a.uid === archive.uid), "хранилище в списке");
    assert.eq((await env.ok("GET", U(volume.uid))).parentId, archive.uid, "том под хранилищем");
  }, { needs: ["createUnits", "implements:vms.archive/1", "implements:vms.volume/1"] });

  test("Хранилище: блочное не шифруется; бакет — всегда объектное; раздел целиком — неотформатирован", async () => {
    const env = await makeEnv();
    const [block, part] = await made(env, local({ storage: "block" }, vol(freeDisks[0], {}, { sizeBytes: 4096 * GB, mode: "part" })));
    assert.eq([block.properties.encrypted, part.properties.state], [false, "unfmt"], "блочное, раздел");
    const [bucket, first] = await made(env, cloud());
    assert.eq([bucket.properties.storage, bucket.properties.encrypted, first.secrets && first.secrets.secret, "secret" in first.properties], ["object", enc(), true, false], "облачное, секрет скрыт");
  }, { needs: ["createUnits", "kind:archive.cloud"] });

  test("Хранилище: отказы — нет имени, домен не сервера, локальное без сервера, облако без бакета, чужой диск", async () => {
    const env = await makeEnv();
    assert.eq(await refused(env, local({}, null, { name: " " })), [["NAME_REQUIRED", "/name"]], "без имени");
    if (otherDomain) assert.eq(await refused(env, local({}, null, { domainId: otherDomain.id })), [["VALIDATION_FAILED", "/domainId"]], "домен не тот, что у сервера");
    assert.eq(await refused(env, local({}, null, { parentId: null, domainId: FX.domains[0].id })), [["PARENT_MISMATCH", "/parentId"]], "локальное — на сервере");
    assert.eq(await refused(env, cloud({ kind: "volume", name: "x", properties: { disk: "s3", sizeBytes: GB } })), [["VALIDATION_FAILED", "/children/0/properties/bucket"]], "без бакета");
    assert.eq(await refused(env, local({}, vol("Z:"))), [["VALIDATION_FAILED", "/children/0/properties/disk"]], "нет такого диска");
    assert.eq(await refused(env, local({}, null, { parentId: "20009999-0000-4000-8000-000000000000" })), [["VALIDATION_FAILED", "/parentId"]], "сервера нет");
  }, { needs: ["createUnits", "kind:archive.cloud"] });

  test("Том только с новым хранилищем (createParents пуст): хранилище с первым томом создаётся, том под существующим — NOT_SUPPORTED", async () => {
    const env = await makeEnv();
    const kind = await env.ok("GET", "/kinds/volume");
    if ((kind.createParents || []).length) return "тома у этой системы заводятся и под существующим хранилищем";
    // create у тома может быть снят (профиль «один домен»): первый том всё равно идёт дочерней строкой хранилища
    const [archive, first] = await made(env, local());
    assert.eq([archive.kind, first.kind, first.parentId], ["archive.local", "volume", archive.uid], "хранилище с первым томом");
    assert.eq(await refused(env, vol(freeDisks[1], { parentId: archive.uid })), [["NOT_SUPPORTED", "/kind"]], "том под существующим хранилищем");
    const step = await env.runOperation({ idempotencyKey: key(), items: [{ uid: archive.uid, createUnit: vol(freeDisks[1]) }], expectedVersions: {} });
    assert.eq(step.items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "шаг createUnit — тоже");
  }, { needs: ["createUnits", "getKind", "createOperation", "implements:vms.volume/1"] });

  test("Том: добавить на свободный диск; тот же диск в этом хранилище и раздел на занятом диске — DISK_TAKEN", async () => {
    const env = await makeEnv();
    const [archive] = await made(env, local());
    const second = freeDisks[1];
    await made(env, vol(second, { parentId: archive.uid }, { sizeBytes: 500 * GB, dir: `${second}\\A` }));
    assert.eq(await refused(env, vol(second, { parentId: archive.uid })), [["DISK_TAKEN", "/properties/disk"]], "тот же диск");
    const [other] = await made(env, local({}, vol(freeDisks[2]), { name: "Второе" }));
    assert.eq(await refused(env, vol(second, { parentId: other.uid }, { mode: "part" })), [["DISK_TAKEN", "/properties/disk"]], "раздел на диске с томами");
    assert.eq(await refused(env, vol("x", { parentId: "20009999-0000-4000-8000-000000000000" })), [["VALIDATION_FAILED", "/parentId"]], "хранилища нет");
  }, { needs: ["createUnits", "under:volume"] });

  test("Новое хранилище с двумя томами на одном диске одной строкой — DISK_TAKEN у второго тома, ничего не создано", async () => {
    const env = await makeEnv();
    const d = freeDisks[0];
    const two = local({}, vol(d, { name: `${d}\\A` }, { sizeBytes: GB, dir: `${d}\\A` }));
    two.children.push(vol(d, { name: `${d}\\B` }, { sizeBytes: GB, dir: `${d}\\B` }));
    assert.eq(await refused(env, two), [["DISK_TAKEN", "/children/1/properties/disk"]], "второй том на том же диске");
    two.children[1] = vol(freeDisks[1], { name: `${freeDisks[1]}\\B` }, { sizeBytes: GB, dir: `${freeDisks[1]}\\B` });
    const [archive, a, b] = await made(env, two);
    assert.eq([a.parentId, b.parentId, a.properties.disk, b.properties.disk], [archive.uid, archive.uid, d, freeDisks[1]], "разные диски — создано");
  }, { needs: ["createUnits", "implements:vms.archive/1", "implements:vms.volume/1"] });

  test("Хранилище и том: PATCH с версией; пароль NAS — только запись", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => x.kind === "network");
    const res = await env.call("PATCH", U(a.id), { name: "NAS — главный", properties: { retentionDays: 90 } }, v(a));
    assert.status(res, 200);
    assert.eq([res.body.name, res.body.properties.retentionDays], ["NAS — главный", 90], "хранилище");
    assert.ok(res.body.version !== a.version, "версия изменилась");
    assert.status(await env.call("PATCH", U(a.id), { kind: "archive.local" }, { "If-Match": res.headers.etag }), 422, "VALIDATION_FAILED", "вид не меняют");
    const vl = FX.volumes.find((x) => x.archiveId === a.id);
    const pv = await env.ok("PATCH", U(vl.id), { properties: { login: "VMS\\svc2", password: "p@ss", sizeBytes: 2048 * GB, confirmShrinkBytes: 2048 * GB } }, v(vl));
    assert.eq([pv.properties.login, pv.secrets.password, "password" in pv.properties, pv.properties.sizeBytes, "confirmShrinkBytes" in pv.properties], ["VMS\\svc2", true, false, 2048 * GB, false], "том; подтверждение не хранится");
    assert.status(await env.call("PATCH", U(vl.id), { properties: { state: "ready" } }, { "If-Match": `"${pv.version}"` }), 422, "VALIDATION_FAILED", "состояние — только «Форматировать»");
    assert.status(await env.call("PATCH", U(vl.id), { name: "x" }), 428, "PRECONDITION_REQUIRED");
  }, { needs: ["patchUnit", "implements:vms.archive/1", "implements:vms.volume/1"] });

  test("Том: форматировать (команда format) — сразу format, через 1,5 с ready и 0%; повторно во время — 409", async () => {
    const env = await makeEnv();
    const vl = FX.volumes.find((x) => x.usedPercent > 0);
    const res = await env.call("POST", `${U(vl.id)}/actions/format`, {});
    assert.status(res, 202);
    assert.eq((await env.ok("GET", U(vl.id))).properties.state, "format", "начато");
    assert.status(await env.call("POST", `${U(vl.id)}/actions/format`, {}), 409, "BUSY");
    if (env.frozen) {
      const fired = await env.advance(2);
      assert.ok(fired.some((f) => f.kind === "volume" && f.id === vl.id), "в ответе часов — форматирование завершилось");
    }
    const done = await env.until(async () => {
      const x = await env.ok("GET", U(vl.id));
      return x.properties.state === "ready" && x;
    }, "форматирование закончилось");
    assert.eq([done.properties.state, done.status.observed.usedPercent], ["ready", 0], "готов, пуст");
    assert.eq((await env.finished(res.body.id)).items.map((x) => x.state), ["ok"], "операция команды закончилась");
  }, { needs: ["runUnitAction", "implements:vms.volume/1"] });

  test("Том: удалить — 204, его нет; хранилище остаётся", async () => {
    const env = await makeEnv();
    const vl = FX.volumes[0];
    assert.status(await env.call("DELETE", U(vl.id), undefined, v(vl)), 204);
    assert.status(await env.call("GET", U(vl.id)), 404, "NOT_FOUND");
    assert.status(await env.call("GET", U(vl.archiveId)), 200, null, "хранилище на месте");
  }, { needs: ["deleteUnit", "cap:volume:delete"] });

  test("Хранилище: удалить — тома удалены, камеры остаются: основным — следующее, без него запись выключена", async () => {
    const env = await makeEnv();
    const a = localArch || FX.archives.find((x) => x.serverId);
    const other = FX.archives.find((x) => x.id !== a.id);
    const cams = FX.devices.filter((d) => d.type === "camera" && d.archiveId === a.id);
    assert.ok(cams.length >= 2, `камер, которые пишут в «${a.name}»: ${cams.length}`);
    await env.ok("PATCH", U(cams[0].id), { properties: { preRecordSec: 5, extraArchives: [{ archiveId: other.id, recordMode: "motion", stream: "sub", preRecordSec: 12 }] } }, v(cams[0]));
    assert.status(await env.call("DELETE", U(a.id), undefined, v(a)), 204);
    const [c0, c1] = await Promise.all([cams[0], cams[1]].map((c) => env.ok("GET", U(c.id)).then((u) => u.properties)));
    assert.eq([c0.archiveId, c0.recordMode, c0.stream, c0.extraArchives], [other.id, "motion", "sub", []], "следующее стало основным");
    assert.eq(c0.preRecordSec, 12, "своя предзапись строки (0.7.0) перешла к камере");
    assert.eq([c1.archiveId == null, c1.recordMode], [true, "none"], "без хранилищ — не пишет");
    assert.eq((await env.list(`/units?parentId=${a.id}`)).length, 0, "томов нет");
    assert.eq((await env.list("/units?kind=camera")).length, FX.devices.filter((d) => d.type === "camera").length, "камеры на месте");
  }, { needs: ["deleteUnit", "patchUnit", "implements:vms.archive/1"] });

  test("Проверка подключения (команда check): NAS без пользователя и облако без бакета — не подключились", async () => {
    const env = await makeEnv();
    const nasArch = FX.archives.find((x) => x.kind === "network");
    const check = (uid, params) => env.ok("POST", `${U(uid)}/actions/check`, { params }).then((r) => r.result);
    const nas = { name: "\\\\nas\\v", disk: "\\\\nas\\v", sizeBytes: GB };
    assert.eq(await check(nasArch.id, { volume: { ...nas, login: "svc" } }), { ok: true, code: null }, "NAS");
    assert.eq(await check(nasArch.id, { provider: null, volume: nas }), { ok: false, code: "CONNECTION_FAILED" }, "NAS без пользователя");
    if (ApiTest.can("kind:archive.cloud")) {
      const [bucket] = await made(env, cloud());
      assert.eq((await check(bucket.uid, { provider: "s3", volume: { name: "x", disk: "s3", sizeBytes: GB } })).ok, false, "бакета нет");
    }
    assert.status(await env.call("POST", `${U(localArch.id)}/actions/check`, { params: { volume: nas } }), 404, "NOT_FOUND", "у локального проверки нет");
  }, { needs: ["runUnitAction", "implements:vms.archive/1"] });

  test("Операция: план карточек хранилища и тома; хранилище сервера без связи — fail SERVER_OFFLINE", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => x.kind === "network");
    const vl = FX.volumes.find((x) => x.archiveId === a.id);
    const op = await env.runOperation({ idempotencyKey: key(), items: [
      { uid: a.id, patch: { properties: { retentionDays: 120 } } },
      { uid: vl.id, patch: { properties: { sizeBytes: 100 * GB, confirmShrinkBytes: 100 * GB } } },
      { uid: offlineArch.id, patch: { properties: { retentionDays: 1 } } },
    ], expectedVersions: { [a.id]: a.version, [vl.id]: vl.version, [offlineArch.id]: offlineArch.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null], ["ok", null], ["fail", "SERVER_OFFLINE"]], "по шагам");
    assert.eq((await env.ok("GET", U(vl.id))).properties.sizeBytes, 100 * GB, "том изменён");
  }, { needs: ["createOperation", "implements:vms.archive/1"] });

  test("Хранилище: удалить путём ядра — replicaFrom (onDelete: keep) остаётся, запись ждёт: waiting, SOURCE_GONE; удаление назад не вернуть", async () => {
    const env = await makeEnv();
    const cam = FX.devices.find((d) => d.type === "camera" && (d.extraArchives || []).some((x) => x.replicaFrom === d.archiveId));
    if (!cam) return "в наборе нет камеры, которая забирает из своего основного хранилища";
    const a = FX.archives.find((x) => x.id === cam.archiveId);
    const kind = await env.ok("GET", "/kinds/camera");
    assert.eq(kind.schema.properties.replicaFrom["x-ref"].onDelete, "keep", "у replicaFrom камеры — onDelete: keep");
    assert.status(await env.call("DELETE", U(a.id), undefined, v(a)), 204);
    const p = (await env.ok("GET", U(cam.id))).properties;
    assert.ok(p.archiveId !== a.id, "основное — следующее (хук хранилища)");
    assert.ok(p.replicaFrom === a.id || (p.extraArchives || []).some((x) => x.replicaFrom === a.id), "ссылка на снятый источник осталась");
    // Состояние записи считает профиль камеры: что система говорит о записи — status.observed
    const seen = (await env.ok("GET", U(cam.id))).status.observed || {};
    assert.eq([seen.recordState, /Источник снят/.test(seen.recordReason || "")], ["waiting", true], "запись ждёт, причина словами");
    const back = await undo(env, await top(env));
    assert.eq(back.items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "хранилище не возвращается");
  }, { needs: ["deleteUnit", "revertOperation", "implements:vms.archive/1"] });

  test("Хранилище: удалить путём ядра — ссылка без keep (onDelete по умолчанию — clear) снимается", async () => {
    const env = await makeEnv();
    // Вид без профиля со ссылкой на хранилище: хук хранилища про неё не знает, снимает общая очистка
    const desc = await env.ok("GET", "/kinds/test.unknown");
    desc.schema.properties.store = { type: ["string", "null"], "x-ref": { implements: ["vms.archive/1"] }, "x-label": { key: "test.store", text: "Хранилище", lang: "ru" } };
    assert.status(await env.call("PUT", "/test/kinds/test.unknown", desc), 200, null, "поле-ссылка добавлено");
    const a = FX.archives.find((x) => x.kind === "network");
    const t = (await env.list("/units?kind=test.unknown"))[0];
    const set = await env.ok("PATCH", U(t.uid), { properties: { store: a.id } }, { "If-Match": `"${t.version}"` });
    assert.eq(set.properties.store, a.id, "ссылается на хранилище");
    assert.status(await env.call("DELETE", U(a.id), undefined, v(a)), 204);
    const after = await env.ok("GET", U(t.uid));
    assert.eq([after.properties.store, after.version !== set.version], [null, true], "ссылка снята, версия изменилась");
  }, { needs: ["deleteUnit", "kind:test.unknown"] });

  test("Удаление хранилища путём ядра: entity.deleted несёт вид хранилища (archive.network), а не archive", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => x.kind === "network");
    const u = await env.ok("GET", U(a.id));
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => seen.push(m), [u.domainId]);
    await ApiTest.settle();
    assert.status(await env.call("DELETE", U(a.id), undefined, v(u)), 204);
    await ApiTest.settle();
    stop();
    const gone = seen.filter((m) => m.type === "entity.deleted" && m.entityId === a.id);
    assert.eq(gone.map((m) => m.kind), [u.kind], "вид в событии");
    assert.eq(u.kind, "archive.network", "вид хранилища");
  }, { needs: ["deleteUnit", "kind:archive.network"] });

  test("Том во время format — как в базе: не занят, правится и удаляется (DELETE, /objects/delete, шаг delete); повторный format — 409 BUSY", async () => {
    const env = await makeEnv();
    const vols = FX.volumes.filter((x) => x.usedPercent > 0).slice(0, 3);
    for (const vl of vols) await env.ok("POST", `${U(vl.id)}/actions/format`, {});
    const [a, b, c] = await Promise.all(vols.map((vl) => env.ok("GET", U(vl.id))));
    assert.eq([a, b, c].map((x) => x.properties.state), ["format", "format", "format"], "форматируются");
    assert.status(await env.call("POST", `${U(a.uid)}/actions/format`, {}), 409, "BUSY", "повторный format");
    // Правка во время форматирования — как PATCH /volumes базы: проходит
    const renamed = await env.call("PATCH", U(a.uid), { name: "Том — во время format" }, v(a));
    assert.status(renamed, 200, null, "PATCH во время format");
    assert.eq(renamed.body.properties.state, "format", "форматирование идёт дальше");
    assert.status(await env.call("DELETE", U(a.uid), undefined, { "If-Match": renamed.headers.etag }), 204, null, "DELETE /units/{uid}");
    const res = await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: [{ id: b.uid, version: b.version }] });
    assert.eq([res.done, res.failed], [[b.uid], []], "/objects/delete");
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: c.uid, delete: true }], expectedVersions: { [c.uid]: c.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null]], "шаг delete");
    await env.advance(2);
    for (const vl of vols) assert.status(await env.call("GET", U(vl.id)), 404, "NOT_FOUND", "тома нет");
  }, { needs: ["runUnitAction", "deleteUnit", "deleteObjects", "createOperation", "clock", "cap:volume:delete"] });

  test("Том: format шагом групповой операции — шаг ok, том сразу format, по часам — ready", async () => {
    const env = await makeEnv();
    const vl = FX.volumes.find((x) => x.usedPercent > 0);
    const op = await env.runOperation({ idempotencyKey: key(), items: [{ uid: vl.id, action: "format" }], expectedVersions: {} });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null]], "шаг выполнен, не BUSY");
    assert.eq((await env.ok("GET", U(vl.id))).properties.state, "format", "форматируется");
    const done = await env.until(async () => {
      const x = await env.ok("GET", U(vl.id));
      return x.properties.state === "ready" && x;
    }, "форматирование закончилось");
    assert.eq(done.status.observed.usedPercent, 0, "пуст");
  }, { needs: ["createOperation", "implements:vms.volume/1"] });

  // Откат: правки хранилищ и томов — в той же стопке, что правки устройств
  const undo = async (env, op) => env.finished((await env.ok("POST", `/operations/${op.id}/revert`)).id);
  // Верхняя в стопке: самая новая строка списка может быть сам откат
  const top = async (env) => (await env.ok("GET", "/operations")).items.find((x) => x.revertible);

  test("Откат: правка хранилища и имени тома — одиночные операции, значения возвращаются", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => x.kind === "network");
    const vl = FX.volumes.find((x) => x.archiveId === a.id);
    await env.ok("PATCH", U(a.id), { properties: { retentionDays: 90 } }, v(a));
    const opA = await top(env);
    assert.eq([opA.single, opA.revertible, opA.items[0].targetId], [true, true, a.id], "правка хранилища — в стопке");
    await env.ok("PATCH", U(vl.id), { name: "Том — другое имя" }, v(vl));
    const opV = await top(env);
    assert.eq([opV.single, opV.items[0].targetId], [true, vl.id], "правка тома — в стопке");
    assert.eq((await undo(env, opV)).ok, 1, "имя тома возвращено");
    assert.eq((await env.ok("GET", U(vl.id))).name, vl.name, "имя как было");
    assert.eq((await undo(env, opA)).ok, 1, "срок возвращён");
    assert.eq((await env.ok("GET", U(a.id))).properties.retentionDays, a.retentionDays, "срок как был");
  }, { needs: ["patchUnit", "revertOperation"] });

  test("Откат: адрес и размер тома — шаг fail NOT_SUPPORTED; прочие шаги той же операции идут", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => x.kind === "network");
    const vl = FX.volumes.find((x) => x.archiveId === a.id);
    const op = await env.runOperation({ idempotencyKey: key(), items: [
      { uid: a.id, patch: { properties: { retentionDays: 120 } } },
      { uid: vl.id, patch: { properties: { disk: "\\\\nas99\\vms" } } },
      { uid: vl.id, patch: { properties: { login: "VMS\\svc9" } } },
    ], expectedVersions: { [a.id]: a.version, [vl.id]: vl.version } });
    assert.eq(op.items.map((x) => x.state), ["ok", "ok", "ok"], "выполнено");
    const back = await undo(env, op);
    assert.eq(back.items.map((x) => [x.state, x.code]), [["ok", null], ["fail", "NOT_SUPPORTED"], ["ok", null]], "по шагам, назад");
    const now = await env.ok("GET", U(vl.id));
    assert.eq([now.properties.disk, now.properties.login], ["\\\\nas99\\vms", vl.login], "адрес остался, логин вернулся");
    assert.eq((await env.ok("GET", U(a.id))).properties.retentionDays, a.retentionDays, "срок вернулся");
    const big = await env.ok("PATCH", U(vl.id), { properties: { sizeBytes: now.properties.sizeBytes + GB } }, { "If-Match": `"${now.version}"` });
    const size = await undo(env, await top(env));
    assert.eq(size.items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "размер не возвращается");
    assert.eq((await env.ok("GET", U(vl.id))).properties.sizeBytes, big.properties.sizeBytes, "размер остался");
  }, { needs: ["createOperation", "revertOperation"] });

  test("Откат: созданное хранилище и том снимаются; с записью камеры или изменённое — NOT_SUPPORTED", async () => {
    const env = await makeEnv();
    const [archive, first] = await made(env, local());
    const [added] = await made(env, vol(freeDisks[1], { parentId: archive.uid }, { dir: `${freeDisks[1]}\\A` }));
    assert.eq((await undo(env, await top(env))).ok, 1, "том снят");
    assert.status(await env.call("GET", U(added.uid)), 404, "NOT_FOUND", "тома нет");
    assert.eq((await undo(env, await top(env))).ok, 1, "хранилище снято");
    assert.status(await env.call("GET", U(archive.uid)), 404, "NOT_FOUND", "хранилища нет");
    assert.status(await env.call("GET", U(first.uid)), 404, "NOT_FOUND", "и его первого тома");
    // Хранилище, в которое уже пишет камера, откат не снимает: привязка не откатилась — шаг менял пароль
    const [second] = await made(env, local({}, null, { name: "С камерой" }));
    const create = await top(env);
    const cam = FX.devices.find((d) => d.type === "camera" && !d.archiveId && !d.parentId);
    await env.ok("PATCH", U(cam.id), { properties: { archiveId: second.uid, recordMode: "always", password: "новый" } }, v(cam));
    assert.eq((await undo(env, await top(env))).items.map((x) => x.code), ["NOT_SUPPORTED"], "пароль не возвращается");
    assert.eq((await undo(env, create)).items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "камера всё ещё пишет туда");
    assert.status(await env.call("GET", U(second.uid)), 200, null, "хранилище на месте");
    // Созданное меняли: откат правки вернул значение, но объект уже не тот, что создан
    const [third] = await made(env, local({}, vol(freeDisks[2], {}, { dir: `${freeDisks[2]}\\A` }), { name: "Третье" }));
    const make = await top(env);
    await env.ok("PATCH", U(third.uid), { properties: { retentionDays: 3 } }, { "If-Match": `"${third.version}"` });
    await undo(env, await top(env));
    assert.eq((await undo(env, make)).items.map((x) => [x.state, x.code]), [["fail", "NOT_SUPPORTED"]], "изменённое не снимается");
  }, { needs: ["createUnits", "patchUnit", "revertOperation", "under:volume"] });

  test("Откат: удаление хранилища — в стопке, шаг fail NOT_SUPPORTED; форматирование в стопку не попадает", async () => {
    const env = await makeEnv();
    const vl = FX.volumes.find((x) => x.usedPercent > 0 && x.archiveId !== FX.volumes[0].archiveId);
    const fmt = await env.ok("POST", `${U(vl.id)}/actions/format`, {});
    const done = await env.finished(fmt.id);
    assert.eq(done.revertible, false, "записи не возвращаются: откатить нечего");
    assert.status(await env.call("POST", `/operations/${fmt.id}/revert`), 409, "NOT_REVERTIBLE");
    const a = FX.archives.find((x) => x.kind === "network");
    assert.status(await env.call("DELETE", U(a.id), undefined, v(a)), 204);
    assert.eq((await undo(env, await top(env))).items.map((x) => x.code), ["NOT_SUPPORTED"], "хранилище не возвращается");
  }, { needs: ["runUnitAction", "deleteUnit", "revertOperation"] });

  ApiTest.loaded("api-storage.js");
})();
