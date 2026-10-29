/* Сценарии интерфейса: хранилища и тома — создать с первым томом, добавить том, правка карточек хранилища
   и тома через операцию, черновик при чужой правке, форматирование, проверка подключения, удаление тома и
   хранилища с вводом числа и отсчётом. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  goApp("hw");
  const toastText = () => document.getElementById("tt")?.textContent || "";
  // Сервер, у которого есть свободные диски
  const srvFree = servers.find((s) => !isUnallocated(s.id) && s.online !== false && volDefaults({ kind: "local", server: s.id, storage: "object", vols: [], name: "x" }));
  addArchive(srvFree.id);
  ok(!!an && an.server === srvFree.id, "окно «Новое хранилище» с сервером");
  an.name = "Хранилище — сценарий";
  const n0 = arch.length;
  createArchive();
  ok(an !== null || arch.length === n0, "до ответа сервера хранилища в кэше нет");
  ok(await until(() => arch.length === n0 + 1), "хранилище создано");
  const a = arch[arch.length - 1];
  ok(/^5/.test(a.id) && a.vols.length === 1, "id с сервера, первый том на месте: " + a.vols[0]?.name);
  const srvA = await API.get("/archives/" + a.id);
  ok(srvA.name === "Хранилище — сценарий" && srvA.serverId === srvFree.id, "на сервере");
  // Ещё том
  addVolume(a.id);
  ok(await until(() => a.vols.length === 2 && sel === a.vols[1].id), "том добавлен, открыт");
  const v2 = a.vols[1];
  // Правка тома через черновик и операцию
  pick(v2.id);
  goTab("gen");
  volSet(v2.id, "gb", "700", true);
  const d = cardDiff();
  ok(d.some((r) => r.key === "size"), "в черновике тома — размер");
  // Чужая правка того же тома, пока черновик открыт
  await API.patch("/volumes/" + v2.id, { dir: "X:\\Чужая" }, hwVer.get(v2.id));
  ok(await until(() => v2.dir === "X:\\Чужая"), "чужая правка видна в карточке");
  ok(!cardDiff().some((r) => r.key === "dir"), "и не попала в «было → станет»");
  ok(cardDiff().some((r) => r.key === "size"), "своя правка осталась");
  cardApply();
  ok(await until(() => bq && bq.finished), "операция завершилась: ok " + bq?.ok + ", не ок " + bq?.fail);
  ok((await API.get("/volumes/" + v2.id)).sizeBytes === 700 * 1024 ** 3, "на сервере — 700 ГБ");
  // Правка хранилища через черновик
  pick(a.id);
  goTab("gen");
  archSet(a.id, "days", "45");
  cardApply();
  ok(await until(() => bq && bq.finished && a.days === 45), "глубина хранения 45 дней");
  ok((await API.get("/archives/" + a.id)).retentionDays === 45, "на сервере");
  // Проверка подключения: NAS без пользователя — не подключились
  addArchive(srvFree.id);
  anSet("kind", "remote");
  an.vol.user = "";
  anCheck();
  ok(await until(() => /подключиться/i.test(toastText())), "NAS без пользователя: «" + toastText() + "»");
  closeBulkModal();
  an = null;
  // Форматирование раздела
  const part = arch.flatMap((x) => x.vols).find((x) => x.mode === "part" && x.state !== "format");
  formatVolume(part.id);
  await confirmWith(null);
  ok(await until(() => part.state === "format"), "форматируется");
  ok(await until(() => part.state === undefined && part.used === "0%"), "готов, 0%");
  ok(await until(() => /отформатирован/.test(toastText())), "тост «Том отформатирован»");
  // Удалить том
  deleteVolume(v2.id);
  await confirmWith(1);
  ok(pendingDelHas(v2.id), "отсчёт с «Отменить»");
  // Том ищется по id: «Применить» хранилища возвращает его тома к снимку копиями
  ok(volById(v2.id) && (await API.raw("GET", "/volumes/" + v2.id)).status === 200, "во время отсчёта том ещё есть — и на сервере");
  ok(await until(() => !volById(v2.id), 30000), "том удалён по истечении отсчёта");
  ok((await API.raw("GET", "/volumes/" + v2.id)).status === 404, "на сервере — нет");
  // Удалить хранилище, в которое пишут камеры
  const busy = arch.find((x) => archCameras(x.id).length >= 2);
  const cams = archCameras(busy.id).map((c) => c.id);
  deleteArchive(busy.id);
  await confirmWith(1);
  ok(await until(() => !archById(busy.id), 30000), "хранилище удалено");
  const c = find(cams[0])?.n;
  ok(c && c.arch !== busy.id && (c.arch || c.rec === "none"), "камера осталась, запись: " + (c?.arch || c?.rec));
  ok((await API.get("/devices/" + cams[0])).archiveId !== busy.id, "на сервере камера не ссылается на удалённое");
  // Переименование хранилища и тома в дереве — PATCH, имя держится и после перечитывания
  const a2 = arch.find((x) => x.vols.length && hwVer.has(x.id));
  const v3 = a2.vols[0];
  treeRenameId = a2.id; treeRenameField = "name";
  commitTreeRename(a2.id, "Хранилище — новое имя");
  ok(await until(() => treeRenameId === null && a2.name === "Хранилище — новое имя"), "хранилище переименовано");
  ok((await API.get("/archives/" + a2.id)).name === "Хранилище — новое имя", "на сервере — новое имя хранилища");
  treeRenameId = v3.id; treeRenameField = "name";
  commitTreeRename(v3.id, "Том — новое имя");
  ok(await until(() => treeRenameId === null), "том переименован");
  ok((await API.get("/volumes/" + v3.id)).name === "Том — новое имя", "на сервере — новое имя тома");
  apiOnEvent({ type: "stream.reset" });
  ok(await until(() => archById(a2.id) !== a2 && archById(a2.id)?.name === "Хранилище — новое имя"), "после перечитывания имя то же");
});
