/* Тесты API: хранилища и тома. */
(() => {
  const { test, makeEnv, assert, key, FX } = ApiTest;
  const GB = 1024 ** 3;
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  // Свободный диск сервера: на нём нет томов локальных хранилищ этого сервера
  const usedDisks = (sid) =>
    new Set(FX.volumes.filter((x) => FX.archives.some((a) => a.id === x.archiveId && a.kind === "local" && a.serverId === sid)).map((x) => x.disk));
  // Сервер, у которого свободных дисков хватит на три тома
  const srv = FX.servers.find((s) => s.allocated && s.online && s.disks.filter((d) => !d.system && !usedDisks(s.id).has(d.disk)).length >= 3);
  const freeDisks = srv.disks.filter((d) => !d.system && !usedDisks(srv.id).has(d.disk)).map((d) => d.disk);
  const localArch = FX.archives.find((a) => a.kind === "local" && a.serverId === srv.id) || null;
  const offlineArch = FX.archives.find((a) => a.serverId && !FX.servers.find((s) => s.id === a.serverId).online);
  // Шифрование — необязательная возможность: без неё хранилища создаются нешифрованными
  const enc = () => ApiTest.can("feature:archiveEncryption");
  const local = (over) => ({ name: "Хранилище — тест", kind: "local", storage: "object", encrypted: enc(), retentionDays: 14, provider: null, serverId: srv.id, domainId: null,
    firstVolume: { name: `${freeDisks[0]}\\AxxonArchive\\Тест`, disk: freeDisks[0], sizeBytes: 500 * GB, mode: "dir", dir: `${freeDisks[0]}\\AxxonArchive\\Тест` }, ...over });

  test("Хранилище: создать локальное с первым томом — 201, оба в списках", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/archives", local());
    assert.status(res, 201);
    const { archive, volumes } = res.body;
    assert.eq([archive.kind, archive.storage, archive.encrypted, archive.serverId, volumes.length, volumes[0].state, volumes[0].usedPercent], ["local", "object", enc(), srv.id, 1, "ready", 0], "запись");
    assert.ok((await env.list("/archives")).some((a) => a.id === archive.id), "хранилище в списке");
    assert.eq((await env.ok("GET", `/volumes/${volumes[0].id}`)).archiveId, archive.id, "том в списке");
  });

  test("Хранилище: блочное не шифруется; облачное — всегда объектное; раздел целиком — неотформатирован", async () => {
    const env = await makeEnv();
    const block = await env.ok("POST", "/archives", local({ storage: "block", encrypted: enc(), firstVolume: { name: freeDisks[0], disk: freeDisks[0], sizeBytes: 4096 * GB, mode: "part" } }));
    assert.eq([block.archive.encrypted, block.volumes[0].state], [false, "unfmt"], "блочное, раздел");
    const cloud = await env.ok("POST", "/archives", { name: "Облако", kind: "cloud", storage: "block", encrypted: enc(), retentionDays: 30, provider: "s3", serverId: null, domainId: FX.domains[0].id,
      firstVolume: { name: "s3://b/v", disk: "s3", sizeBytes: 10240 * GB, bucket: "b", region: "eu-central-1", path: "v", keyId: "AKIA", secret: "s" } });
    assert.eq([cloud.archive.storage, cloud.archive.encrypted, cloud.volumes[0].hasSecret, "secret" in cloud.volumes[0]], ["object", enc(), true, false], "облачное, секрет скрыт");
  });

  test("Хранилище: отказы — нет имени, двух владельцев, локальное без сервера, облако без бакета, чужой диск", async () => {
    const env = await makeEnv();
    assert.status(await env.call("POST", "/archives", local({ name: " " })), 422, "NAME_REQUIRED");
    assert.status(await env.call("POST", "/archives", local({ domainId: FX.domains[0].id })), 422, "VALIDATION_FAILED", "два владельца");
    assert.status(await env.call("POST", "/archives", local({ serverId: null, domainId: FX.domains[0].id })), 422, "VALIDATION_FAILED", "локальное — на сервере");
    assert.status(await env.call("POST", "/archives", { ...local(), kind: "cloud", provider: "s3", firstVolume: { name: "x", disk: "s3", sizeBytes: GB } }), 422, "VALIDATION_FAILED", "без бакета");
    assert.status(await env.call("POST", "/archives", local({ firstVolume: { name: "Z:", disk: "Z:", sizeBytes: GB, mode: "dir" } })), 422, "VALIDATION_FAILED", "нет такого диска");
    assert.status(await env.call("POST", "/archives", local({ serverId: "20009999-0000-4000-8000-000000000000" })), 404, "NOT_FOUND");
  });

  test("Том: добавить на свободный диск; тот же диск в этом хранилище и раздел на занятом диске — 409 DISK_TAKEN", async () => {
    const env = await makeEnv();
    const { archive } = await env.ok("POST", "/archives", local());
    const second = freeDisks[1];
    const res = await env.call("POST", `/archives/${archive.id}/volumes`, { name: second, disk: second, sizeBytes: 500 * GB, mode: "dir", dir: `${second}\\A` });
    assert.status(res, 201);
    assert.status(await env.call("POST", `/archives/${archive.id}/volumes`, { name: second, disk: second, sizeBytes: GB, mode: "dir" }), 409, "DISK_TAKEN", "тот же диск");
    const other = await env.ok("POST", "/archives", local({ name: "Второе", firstVolume: { name: freeDisks[2], disk: freeDisks[2], sizeBytes: GB, mode: "dir" } }));
    assert.status(await env.call("POST", `/archives/${other.archive.id}/volumes`, { name: second, disk: second, sizeBytes: GB, mode: "part" }), 409, "DISK_TAKEN", "раздел на диске с томами");
    assert.status(await env.call("POST", `/archives/20009999-0000-4000-8000-000000000000/volumes`, { name: "x", disk: "x", sizeBytes: GB }), 404, "NOT_FOUND");
  }, { needs: ["createVolume"] });

  test("Хранилище и том: PATCH с версией; пароль NAS — только запись", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => x.kind === "remote");
    const res = await env.ok("PATCH", `/archives/${a.id}`, { name: "NAS — главный", retentionDays: 90 }, v(a));
    assert.eq([res.name, res.retentionDays], ["NAS — главный", 90], "хранилище");
    assert.ok(res.version !== a.version, "версия изменилась");
    assert.status(await env.call("PATCH", `/archives/${a.id}`, { kind: "cloud" }, { "If-Match": `"${res.version}"` }), 422, "VALIDATION_FAILED", "вид не меняют");
    const vol = FX.volumes.find((x) => x.archiveId === a.id);
    const pv = await env.ok("PATCH", `/volumes/${vol.id}`, { login: "VMS\\svc2", password: "p@ss", sizeBytes: 2048 * GB }, v(vol));
    assert.eq([pv.login, pv.hasPassword, "password" in pv, pv.sizeBytes], ["VMS\\svc2", true, false, 2048 * GB], "том");
    assert.status(await env.call("PATCH", `/volumes/${vol.id}`, { state: "ready" }, { "If-Match": `"${pv.version}"` }), 422, "VALIDATION_FAILED", "состояние — только «Форматировать»");
    assert.status(await env.call("PATCH", `/volumes/${vol.id}`, { name: "x" }), 428, "PRECONDITION_REQUIRED");
  });

  test("Том: форматировать — сразу format, через 1,5 с ready и 0%; повторно во время — 409", async () => {
    const env = await makeEnv();
    const vol = FX.volumes.find((x) => x.usedPercent > 0);
    const res = await env.call("POST", `/volumes/${vol.id}/format`);
    assert.status(res, 202);
    assert.eq(res.body.state, "format", "начато");
    assert.status(await env.call("POST", `/volumes/${vol.id}/format`), 409, "BUSY");
    if (env.frozen) {
      const fired = await env.advance(2);
      assert.ok(fired.some((f) => f.kind === "volume" && f.id === vol.id), "в ответе часов — форматирование завершилось");
    }
    const done = await env.until(async () => {
      const x = await env.ok("GET", `/volumes/${vol.id}`);
      return x.state === "ready" && x;
    }, "форматирование закончилось");
    assert.eq([done.state, done.usedPercent], ["ready", 0], "готов, пуст");
  });

  test("Том: удалить — 204, его нет; хранилище остаётся", async () => {
    const env = await makeEnv();
    const vol = FX.volumes[0];
    assert.status(await env.call("DELETE", `/volumes/${vol.id}`, undefined, v(vol)), 204);
    assert.status(await env.call("GET", `/volumes/${vol.id}`), 404, "NOT_FOUND");
    assert.status(await env.call("GET", `/archives/${vol.archiveId}`), 200, null, "хранилище на месте");
  }, { needs: ["deleteVolume"] });

  test("Хранилище: удалить — тома удалены, камеры остаются: основным — следующее, без него запись выключена", async () => {
    const env = await makeEnv();
    const a = localArch || FX.archives.find((x) => x.serverId);
    const other = FX.archives.find((x) => x.id !== a.id);
    const cams = FX.devices.filter((d) => d.type === "camera" && d.archiveId === a.id);
    assert.ok(cams.length >= 2, `камер, которые пишут в «${a.name}»: ${cams.length}`);
    await env.ok("PATCH", `/devices/${cams[0].id}`, { extraArchives: [{ archiveId: other.id, recordMode: "motion", stream: "sub" }] }, v(cams[0]));
    assert.status(await env.call("DELETE", `/archives/${a.id}`, undefined, v(a)), 204);
    const c0 = await env.ok("GET", `/devices/${cams[0].id}`);
    const c1 = await env.ok("GET", `/devices/${cams[1].id}`);
    assert.eq([c0.archiveId, c0.recordMode, c0.stream, c0.extraArchives], [other.id, "motion", "sub", []], "следующее стало основным");
    assert.eq([c1.archiveId, c1.recordMode], [null, "none"], "без хранилищ — не пишет");
    assert.eq((await env.list("/volumes")).filter((x) => x.archiveId === a.id).length, 0, "томов нет");
    assert.eq((await env.list("/devices")).length, FX.devices.length, "камеры на месте");
  });

  test("Проверка подключения: NAS без пользователя и облако без бакета — не подключились", async () => {
    const env = await makeEnv();
    const nas = { name: "\\\\nas\\v", disk: "\\\\nas\\v", sizeBytes: GB };
    assert.eq(await env.ok("POST", "/archives/check", { kind: "remote", provider: null, volume: { ...nas, login: "svc" } }), { ok: true, code: null }, "NAS");
    assert.eq(await env.ok("POST", "/archives/check", { kind: "remote", provider: null, volume: nas }), { ok: false, code: "CONNECTION_FAILED" }, "NAS без пользователя");
    assert.eq((await env.ok("POST", "/archives/check", { kind: "cloud", provider: "s3", volume: { name: "x", disk: "s3", sizeBytes: GB } })).ok, false, "облако без бакета");
  });

  test("Операция: план карточек хранилища и тома; хранилище сервера без связи — fail SERVER_OFFLINE", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => x.kind === "remote");
    const vol = FX.volumes.find((x) => x.archiveId === a.id);
    const op = await env.runOperation({ idempotencyKey: key(), items: [
      { targetId: a.id, set: { retentionDays: 120 } },
      { targetId: vol.id, set: { sizeBytes: 100 * GB } },
      { targetId: offlineArch.id, set: { retentionDays: 1 } },
    ], expectedVersions: { [a.id]: a.version, [vol.id]: vol.version, [offlineArch.id]: offlineArch.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["ok", null], ["ok", null], ["fail", "SERVER_OFFLINE"]], "по шагам");
    assert.eq((await env.ok("GET", `/volumes/${vol.id}`)).sizeBytes, 100 * GB, "том изменён");
  });

  ApiTest.loaded("api-storage.js");
})();
