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
  const srvA = await uiRec(a.id);
  ok(srvA.name === "Хранилище — сценарий" && srvA.serverId === srvFree.id, "на сервере");
  // Ещё том: «＋ Том» спрашивает, новый том или том с записями
  addVolume(a.id);
  ok(await until(() => document.querySelector("#bmodal.open .av-body")), "«＋ Том» открывает окно выбора");
  ok(av?.src === "new" && !document.querySelector("#bmFoot .btn.pri")?.disabled, "по умолчанию — новый том, «Добавить в план» доступна");
  // Размер тома (пробел F92): диск со свободным местом от сервера (freeBytes, профиль vms.server/1 1.3)
  const fd = serverDisks(a.server).filter((x) => x.free != null && x.free > 1 && !diskUse(a.server, x.disk).part && !archVols(a).some((v) => v.disk === x.disk)).sort((x, y) => y.free - x.free)[0];
  ok(!!fd, "у сервера есть свободный диск, сервер называет его свободное место");
  avVol("disk", fd.disk);
  avVol("mode", "file");
  ok(/Свободно/.test(document.querySelector("#bmodal .vsz-free")?.textContent || ""), "под полем — свободное место диска");
  avVol("unit", "ТБ");
  avVol("num", "9999");
  ok(/свободно только/.test(avBlock(a)) && document.querySelector("#bmFoot .btn.pri")?.disabled, "том больше свободного места — ошибка, кнопка недоступна: " + avBlock(a));
  avVol("unit", "ГБ");
  avVol("num", "0.5");
  ok(/не меньше 1 ГБ/.test(avBlock(a)), "меньше 1 ГБ — ошибка: " + avBlock(a));
  avVol("num", "1500");
  ok(av.vol.size === "1500 " + i18n("ГБ"), "1500 ГБ хранится как ввели, без округления до ТБ: " + av.vol.size);
  ok(volSizeMsg(31, 100, "D:", "").cls === "warn" && !volSizeProblem({ kind: "local" }, { mode: "file", size: "31 ТБ" }, null), "больше 30 ТБ — предупреждение, кнопку не закрывает");
  document.querySelector("#bmodal .vsz-free button")?.click();
  ok(!avBlock(a) && sizeTb(av.vol.size) <= diskFreeTb(a.server, fd.disk, av.vol) + 1e-9, "«Всё свободное» — не больше свободного места: " + av.vol.size);
  avVol("num", "2");
  const tb0 = archSizeTb(a), nOn0 = archVolsOn(a).length;
  avCreate();
  // Новый том идёт в план хранилища, на сервер — по «Применить»
  ok(sel === a.id && a.vols.length === 2 && a.vols[1]._new && cardDiff().some((r) => r.volAdd), "том в плане хранилища");
  ok(archSizeTb(a) === tb0 && archVolsOn(a).length === nOn0, "счётчики хранилища — без тома из плана");
  const free0 = serverDisks(a.server).find((x) => x.disk === fd.disk).free;
  cardApply();
  ok(await until(() => a.vols.length === 2 && /^6/.test(a.vols[1].id)), "том создан по «Применить»");
  ok(await until(() => serverDisks(a.server).find((x) => x.disk === fd.disk).free < free0), "после операции консоль перечитала свободное место диска");
  const v2 = a.vols[1];
  // Правка тома через черновик и операцию
  pick(v2.id);
  goTab("gen");
  // Карточка тома: размер больше свободного места «Применить» не пускает
  volSet(v2.id, "gb", String(Math.ceil((diskFreeTb(a.server, v2.disk, v2) + 1) * 1024)), true);
  ok(/свободно только/.test(cardEditBlock()), "карточка тома: больше свободного места — " + cardEditBlock());
  volSet(v2.id, "gb", "700", true);
  ok(!cardEditBlock(), "700 ГБ — можно");
  const d = cardDiff();
  ok(d.some((r) => r.key === "size"), "в черновике тома — размер");
  // Чужая правка того же тома, пока черновик открыт
  await uiPatch(v2.id, { dir: "X:\\Чужая" }, hwVer.get(v2.id));
  ok(await until(() => v2.dir === "X:\\Чужая"), "чужая правка видна в карточке");
  ok(!cardDiff().some((r) => r.key === "dir"), "и не попала в «было → станет»");
  ok(cardDiff().some((r) => r.key === "size"), "своя правка осталась");
  cardApply();
  ok(await until(() => bq && bq.finished), "операция завершилась: ok " + bq?.ok + ", не ок " + bq?.fail);
  ok((await uiRec(v2.id)).sizeBytes === 700 * 1024 ** 3, "на сервере — 700 ГБ");
  // Правка хранилища через черновик
  pick(a.id);
  goTab("gen");
  archSet(a.id, "days", "45");
  cardApply();
  ok(await until(() => bq && bq.finished && a.days === 45), "глубина хранения 45 дней");
  ok((await uiRec(a.id)).retentionDays === 45, "на сервере");
  // Режим карты сервера: вид предлагает значение и оно уходит явно, «Авто» — выбор оператора, поля нет
  addArchive(srvFree.id);
  anSet("kind", "edge");
  anGo(1);
  const modeSel = () => [...document.querySelectorAll("#bmBody select")].find((x) => [...x.options].some((o) => o.textContent === i18n("Авто")));
  ok(modeSel()?.value === "backup" && anArchive().recordMode === "backup", "предложено значение вида, уходит явно");
  anSet("recordMode", "");
  ok(modeSel()?.value === "" && !("recordMode" in anArchive()), "«Авто»: поля нет");
  closeBulkModal();
  an = null;
  // Карточка архива без поля показывает «Авто», а не первое слово списка
  const edgeA = arch.find((x) => x.kind === "edge");
  if (edgeA) {
    pick(edgeA.id, { force: true });
    goTab("arch");
    const sel0 = () => document.querySelector("[data-arch-mode] select");
    const wasMode = edgeA.recordMode;
    archSet(edgeA.id, "recordMode", "");
    ok(!("recordMode" in edgeA) && JSON.stringify(cardApiItems(edgeA, cardDiff())).includes('"recordMode":null'), "вернуться к «Авто»: уходит null");
    cardRestore();
    gear();
    ok(edgeA.recordMode === wasMode, "черновик сброшен");
    delete edgeA.recordMode;
    gear();
    ok(sel0()?.value === "" && sel0().selectedOptions[0].textContent === i18n("Авто"), "без поля — «Авто»");
    edgeA.recordMode = wasMode;
    gear();
  }
  // Проверка подключения: NAS без пользователя — не подключились
  addArchive(srvFree.id);
  anSet("kind", "network");
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
  // Том с записями: блочное хранилище из найденного тома, без форматирования
  wzCancelQuiet("arch");
  addArchive(srvFree.id);
  anSet("kind", "local");
  anSet("storage", "block");
  anGo(2);
  anSrc("found");
  // Том с записями консоль ищет в папке, которую называет человек (findVolumes с path, профиль vms.volume/1 1.4).
  // Папку тест берёт из ответа сервера без папки: первый блочный том на дисках сервера
  const folderOf = async (sid, skip) => {
    const r = await kindAction("archive.local", "findVolumes", { serverId: sid });
    const f = (r?.items || []).map(foundOf).find((x) => x.storage === "block" && !(skip || []).includes(x.disk));
    return f ? (f.mode === "part" ? f.disk + "\\" : f.dir) : "";
  };
  ok(!!anBlockVol() && /папку/.test(anBlockVol()), "без папки — «Указать папку с записями»: " + anBlockVol());
  const folder = await folderOf(srvFree.id);
  anPath(folder);
  ok(await until(() => !foundLoading() && an.found), "сервер назвал тома с записями в папке " + folder);
  const found = protoFound(anDraft(), true, an.findPath).list, pickedKey = an.found;
  ok(found.length > 0 && found.some((f) => f.key === pickedKey), "найдены тома с записями, первый выбран: " + pickedKey);
  ok(!anBlockVol(), "том выбран — «Далее» доступна");
  anGo(3);
  ok(/без форматирования/.test(document.getElementById("bmBody")?.textContent || ""), "шаг «Проверка»: сервер подключит том без форматирования");
  const nF = arch.length;
  createArchive();
  ok(await until(() => arch.length === nF + 1), "хранилище из тома с записями создано");
  const fa = arch[arch.length - 1], fv = fa.vols[0];
  ok(!!volRec(fv) && fv.state !== "unfmt", "том с записями не «Не отформатирован», период от сервера: " + volStateText(fv));
  ok(!!(await uiRec(fv.id)).recordsFrom, "у тома на сервере есть recordsFrom");
  ok(/без форматирования/.test(toastText()), "тост: «" + toastText() + "»");
  // Подключённый том второй раз не предлагается
  addArchive(srvFree.id);
  anSet("kind", "local");
  anSet("storage", "block");
  anGo(2);
  anSrc("found");
  anPath(folder);
  ok(await until(() => !foundLoading()), "список томов обновлён");
  ok(!protoFound(anDraft(), true, an.findPath).list.some((f) => f.key === pickedKey), "подключённый том в списке больше нет");
  wzCancelQuiet("arch");
  an = null;
  // «＋ Том»: том с записями
  addVolume(fa.id);
  avSrc("found");
  ok(/папку/.test(avBlock(fa)), "окно без папки — «Указать папку с записями»");
  avPath(await folderOf(fa.server, fa.vols.map((v) => v.disk)));
  await until(() => !foundLoading());
  const avL = avList(fa);
  if (avL.length) {
    ok(av.found === avL[0].key || avL.some((f) => f.key === av.found), "в окне «＋ Том» выбран найденный том");
    avCreate();
    // Новый том идёт в план, на сервер — по «Применить»
    ok(fa.vols.length === 2 && fa.vols[1]._new && cardDiff().some((r) => r.volAdd), "том в плане, на сервер ещё не ушёл");
    cardApply();
    ok(await until(() => fa.vols.length === 2 && !fa.vols[1]._new), "том с записями добавлен");
    ok(!!volRec(fa.vols[1]), "второй том — с записями, период от сервера");
  } else {
    ok(!!avBlock(fa), "томов с записями нет — «Добавить в план» недоступна");
    avClose();
  }
  // Удалить том
  deleteVolume(v2.id);
  await confirmWith(1);
  ok(pendingDelHas(v2.id), "отсчёт с «Отменить»");
  // Том ищется по id: «Применить» хранилища возвращает его тома к снимку копиями
  ok(volById(v2.id) && (await API.raw("GET", "/units/" + v2.id)).status === 200, "во время отсчёта том ещё есть — и на сервере");
  ok(await until(() => !volById(v2.id), 30000), "том удалён по истечении отсчёта");
  ok((await API.raw("GET", "/units/" + v2.id)).status === 404, "на сервере — нет");
  // Удалить хранилище, в которое пишут камеры
  const busy = arch.find((x) => archCameras(x.id).length >= 2);
  const cams = archCameras(busy.id).map((c) => c.id);
  deleteArchive(busy.id);
  await confirmWith(1);
  ok(await until(() => !archById(busy.id), 30000), "хранилище удалено");
  const c = find(cams[0])?.n;
  ok(c && c.arch !== busy.id && (c.arch || c.rec === "none"), "камера осталась, запись: " + (c?.arch || c?.rec));
  ok((await uiRec(cams[0])).archiveId !== busy.id, "на сервере камера не ссылается на удалённое");
  // Переименование хранилища и тома в дереве — PATCH, имя держится и после перечитывания
  const a2 = arch.find((x) => x.vols.length && hwVer.has(x.id));
  const v3 = a2.vols[0];
  treeRenameId = a2.id; treeRenameField = "name";
  commitTreeRename(a2.id, "Хранилище — новое имя");
  // По id, а не a2: против стенда событие потока может перечитать хранилища раньше ответа на PATCH
  ok(await until(() => treeRenameId === null && archById(a2.id)?.name === "Хранилище — новое имя"), "хранилище переименовано");
  ok((await uiRec(a2.id)).name === "Хранилище — новое имя", "на сервере — новое имя хранилища");
  treeRenameId = v3.id; treeRenameField = "name";
  commitTreeRename(v3.id, "Том — новое имя");
  ok(await until(() => treeRenameId === null), "том переименован");
  ok((await uiRec(v3.id)).name === "Том — новое имя", "на сервере — новое имя тома");
  apiOnEvent({ type: "stream.reset" });
  ok(await until(() => archById(a2.id) !== a2 && archById(a2.id)?.name === "Хранилище — новое имя"), "после перечитывания имя то же");
});
