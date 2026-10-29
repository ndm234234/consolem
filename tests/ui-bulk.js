/* Сценарии интерфейса: правка выборки одной операцией на сервере (выключить, режим записи, учётные данные,
   папка, детектор), пауза, исключение камер сервера без связи, групповое удаление с вводом числа и отсчётом.
   Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  goApp("hw");
  const online = (c) => !hasNoSignal(srv(c.id));
  const cams = devicePool.filter((n) => n.type === "camera" && online(n) && n.arch).slice(0, 3);
  const folder = flatFolders().find((f) => folderDomain(f.id) === nodeDomainId(cams[0]) && !cams.some((c) => f.items.includes(c.id)));
  treeSel.clear();
  cams.forEach((c) => treeSel.add(c.id));
  const ch = bulkChanges({ enabled: "off", rec: "motion", user: "op", pass: "p", folderAdd: folder.id, addDet: "Пересечение линии" });
  ok(ch.length === 5, "шагов в плане: " + ch.map((s) => s.label).join(", "));
  // Детектор план добавляет только тем, у кого такого ещё нет
  const detCams = ch.find((s) => s.key.startsWith("addDet")).ops.map((o) => o.n);
  const dets0 = detCams.map((c) => camDetectors(c).length);
  bulkRun(ch);
  ok(bq && bq.api, "очередь на сервере");
  ok(cams.every((c) => c.user !== "op"), "кэш не меняется до ответа сервера");
  ok(await until(() => bq.finished), "операция завершилась: ok " + bq.ok + ", не ок " + bq.fail);
  ok(await until(() => cams.every((c) => c.enabled === false && c.rec === "motion" && c.user === "op")), "кэш обновлён из потока");
  ok(cams.every((c) => folder.items.includes(c.id)), "в папке");
  ok(detCams.length > 0 && (await until(() => detCams.every((c, i) => camDetectors(c).length === dets0[i] + 1))), "детекторы созданы: " + detCams.length);
  const r0 = await API.get("/devices/" + cams[0].id);
  ok(r0.enabled === false && r0.recordMode === "motion" && r0.login === "op" && r0.hasPassword, "на сервере — изменено, пароль задан");
  ok(cams[0].pass !== "p", "пароль в кэш не попадает");
  // Пауза: шаги на сервере стоят
  const many = devicePool.filter((n) => n.type === "camera" && online(n)).slice(0, 12);
  treeSel.clear();
  many.forEach((c) => treeSel.add(c.id));
  bulkRun(bulkChanges({ pre: "9" }));
  ok(await until(() => bq.api && bq.api !== "pending" && bq.done > 0), "идёт: " + bq.done + " из " + bq.total);
  queuePause();
  ok(await until(() => bq.paused), "пауза");
  const at = bq.done;
  ok((await API.get("/operations/" + bq.api)).state === "paused", "на сервере — пауза");
  await new Promise((r) => setTimeout(r, 1500));
  ok(bq.done === at, "на паузе шаги стоят: " + bq.done);
  queuePause();
  ok(await until(() => bq.finished), "продолжили и закончили: ok " + bq.ok);
  // Камеры сервера без связи — исключены, на сервер не уходят
  const off = devicePool.filter((n) => n.type === "camera" && !online(n)).slice(0, 2);
  treeSel.clear();
  [cams[1], ...off].forEach((c) => treeSel.add(c.id));
  bulkRun(bulkChanges({ pre: "7" }));
  ok(await until(() => bq.finished), "завершилась");
  const st = bq.steps[0].ops.map((o) => o.state);
  ok(st.filter((s) => s === "excl").length === off.length && st.includes("ok"), "исключены без связи: " + st.join(", "));
  // Групповое удаление: вводим число, отсчёт, затем — одним запросом
  const del = [cams[0].id, cams[1].id];
  deleteSelected(del);
  ok(document.getElementById("confirmOk").disabled, "«Удалить» неактивна до ввода числа");
  await confirmWith(2);
  ok(del.every((id) => pendingDelHas(id)), "отсчёт с «Отменить»");
  ok(await until(() => del.every((id) => !find(id)), 30000), "удалены по истечении отсчёта");
  ok((await API.raw("GET", "/devices/" + del[0])).status === 404, "на сервере — нет");
  // После удаления кэш перечитан — папка ищется заново
  ok(!folderById(folder.id).items.includes(del[0]), "из папки убраны");
  // Имена по шаблону: в выборке и камера, и сервер — одной операцией на сервере, и у сервера тоже
  await until(() => !bq || bq.finished);
  const cam = devicePool.find((n) => n.type === "camera" && online(n));
  const s1 = servers.find((s) => !hasNoSignal(s) && !isUnallocated(s.id));
  treeSel.clear();
  [cam, s1].forEach((x) => treeSel.add(x.id));
  const want = [bulkName(cam, "type-ip"), bulkName(s1, "type-ip")];
  bulkRun(bulkChanges({ rename: "type-ip" }));
  ok(!!(bq && bq.api), "переименование камеры и сервера — операцией на сервере");
  ok(await until(() => bq.finished) && bq.fail === 0, "без отказов");
  const [rc, rs] = await Promise.all([API.get("/devices/" + cam.id), API.get("/servers/" + s1.id)]);
  ok(rc.name === want[0] && rs.name === want[1], "на сервере новые имена: " + rc.name + "; " + rs.name);
  ok(await until(() => find(cam.id)?.n.name === want[0] && find(s1.id)?.n.name === want[1]), "и в дереве");
  // Шаг, который у объекта ничего не меняет (имя уже по шаблону), не уводит всю правку мимо сервера
  const cam2 = devicePool.find((n) => n.type === "camera" && online(n) && n !== cam && bulkCanRename(n) && n.name !== bulkName(n, "type-ip"));
  treeSel.clear();
  [cam, cam2].forEach((x) => treeSel.add(x.id));
  const want2 = bulkName(cam2, "type-ip");
  bulkRun(bulkChanges({ rename: "type-ip" }));
  ok(!!(bq && bq.api), "одно имя уже по шаблону — всё равно операцией на сервере");
  ok(await until(() => bq.finished) && bq.fail === 0 && bq.ok === 2, "оба шага выполнены: ok " + bq.ok);
  ok((await API.get("/devices/" + cam2.id)).name === want2, "на сервере новое имя: " + want2);
  // Учётные данные, скопированные с камеры: пароль источника клиенту не известен — маска на сервер не уходит
  const cp1 = bulkChanges({ user: "op3", pass: "********", passCopied: true }).find((s) => s.key === "creds");
  ok(cp1 && cp1.ops.every((o) => o.api.set.login === "op3" && !("password" in o.api.set)), "копия: на сервер — логин, без пароля");
  bulkDraft = { pass: "********", passCopied: true };
  bulkSet("pass", "new-secret");
  ok(!bulkDraft.passCopied && bulkChanges().find((s) => s.key === "creds")?.ops.every((o) => o.api.set.password === "new-secret"), "введённый пароль уходит как есть");
  bulkDraft = {};
  const gen = cpChangesGeneric(cam, [cam2], new Set(["creds"])).find((s) => s.key === "creds");
  ok(!gen || gen.ops.every((o) => o.api && !("password" in o.api.set)), "«Применить к другим» — тоже без маски");
});
