/* Тесты API: групповые операции над выборкой и групповое удаление. */
(() => {
  const { test, makeEnv, assert, key, FX } = ApiTest;
  // Родитель с дочерним: регистратор с каналом или камера с детектором — что есть в наборе
  const nvr = FX.devices.find((d) => !d.parentId && FX.devices.some((x) => x.parentId === d.id));
  const nvrKid = FX.devices.find((x) => x.parentId === nvr.id);
  const cam = FX.devices.find((d) => d.type === "camera" && !d.parentId && d.id !== nvr.id);
  // Папка без подпапок, где нет удаляемых устройств: иначе её версия сменится раньше, чем дойдёт черёд
  const folder = FX.folders.find((f) => !FX.folders.some((x) => x.parentId === f.id) && !f.deviceIds.some((id) => id === nvr.id || id === nvrKid.id));
  const vol = FX.volumes[0];

  test("Групповое удаление: устройства, папка, том одним запросом; дочернее удалённого родителя — тоже удалено", async () => {
    const env = await makeEnv();
    // Том — только в системе, где тома удаляют (deleteVolume): иначе у хранилища ровно один том
    const gone = [["devices", nvr], ["devices", nvrKid], ["folders", folder]].concat(ApiTest.can("deleteVolume") ? [["volumes", vol]] : []);
    const res = await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: gone.map(([, r]) => ({ id: r.id, version: r.version })).concat([
      { id: cam.id, version: "stale" },
      { id: "30009999-0000-4000-8000-000000000000", version: "1" },
    ]) });
    assert.eq(res.done, gone.map(([, r]) => r.id), "удалено");
    assert.eq(res.failed.map((f) => f.code), ["VERSION_MISMATCH", "NOT_FOUND"], "отказы");
    for (const [path, id] of gone.map(([table, r]) => [table, r.id])) {
      assert.status(await env.call("GET", `/${path}/${id}`), 404, "NOT_FOUND", `${path} ${id}`);
    }
    assert.status(await env.call("GET", `/devices/${cam.id}`), 200, null, "устаревшая версия — не тронут");
  });

  test("Групповое удаление: хранилище — камеры переходят на следующее или перестают писать, как у одиночного", async () => {
    const env = await makeEnv();
    const a = FX.archives.find((x) => FX.devices.some((d) => d.archiveId === x.id));
    const c = FX.devices.find((d) => d.archiveId === a.id);
    const res = await env.ok("POST", "/objects/delete", { idempotencyKey: key(), items: [{ id: a.id, version: a.version }] });
    assert.eq(res.done, [a.id], "удалено");
    assert.eq((await env.ok("GET", `/devices/${c.id}`)).archiveId, null, "камера не пишет в удалённое");
    assert.eq((await env.list("/volumes")).filter((v) => v.archiveId === a.id).length, 0, "тома удалены");
  });

  test("Правка выборки: включить, учётные данные, папка, детектор — одной операцией, «Отменить» возвращает всё", async () => {
    const env = await makeEnv();
    const cams = FX.devices.filter((d) => d.type === "camera" && !d.parentId && FX.servers.find((s) => s.id === d.serverId)?.online).slice(0, 2);
    const f = FX.folders.find((x) => x.domainId === cams[0].domainId && !cams.some((c) => x.deviceIds.includes(c.id)));
    const items = cams.flatMap((c) => [
      { targetId: c.id, set: { login: "op", password: "p" } },
      { targetId: c.id, folderIds: FX.folders.filter((x) => x.deviceIds.includes(c.id)).map((x) => x.id).concat(f.id) },
      { targetId: c.id, create: { type: "det", name: "Пересечение линии", detectorKind: "linecross", sensitivity: 12 } },
    ]);
    const op = await env.runOperation({ idempotencyKey: key(), items, expectedVersions: Object.fromEntries(cams.map((c) => [c.id, c.version])) });
    assert.eq([op.ok, op.failed], [6, 0], "выполнено");
    assert.ok((await env.ok("GET", `/folders/${f.id}`)).deviceIds.includes(cams[1].id), "в папке");
    const back = await env.ok("POST", `/operations/${op.id}/revert`);
    const done = await env.finished(back.id);
    assert.eq([done.ok, done.failed], [6, 0], "откат выполнен");
    assert.ok(!(await env.ok("GET", `/folders/${f.id}`)).deviceIds.some((id) => cams.some((c) => c.id === id)), "из папки убраны");
    const c0 = await env.ok("GET", `/devices/${cams[0].id}`);
    assert.eq([c0.login, !!c0.hasPassword], [cams[0].login, !!cams[0].hasPassword], "учётные данные вернулись");
    const kids = (await env.list("/devices")).filter((d) => d.parentId === cams[0].id && d.detectorKind === "linecross" && d.name === "Пересечение линии");
    assert.eq(kids.length, 0, "созданные детекторы удалены");
  });

  ApiTest.loaded("api-bulk.js");
})();
