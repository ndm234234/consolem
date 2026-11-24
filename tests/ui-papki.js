/* Сценарий прототипа 14: «Папки» меняются только от нажатия, статус переживает смену среза, «Найдено» считает показанное,
   службы видны и в раскладке по папкам.
   Запуск — python3 tools/check_ui.py tests/ui-papki.js */
UiCheck(async ({ ok, until, sleep }) => {
  const btn = () => document.getElementById("viewBtn");
  // Прототип 29: кнопка в ряду срезов (aria-pressed), неактивная показывает положение; основной — переключатель (aria-checked)
  const inRow = !!document.getElementById("phSliceLast");
  const on = () => (btn().getAttribute("aria-pressed") ?? btn().getAttribute("aria-checked")) === "true";
  const click = (s) => document.querySelector(`#aside [data-slice="${s}"]`).click();
  const settle = async () => { await until(() => !fs || (fs.done && !fs.busy)); await sleep(50); };
  const hint = () => document.getElementById("filtHint").textContent;
  const treeRows = () => [...document.querySelectorAll("#tree .n[data-pick]")];
  const svcGroups = () => [...document.querySelectorAll('#tree .n[data-tid^="svcs:"]')];
  const shownObjects = () => new Set(treeRows().map((e) => find(e.dataset.pick)?.n).filter((n) => n && (slice === "det" ? n.type === "det" : selfOrDet(n) && !(inRow && slice === "arch" && statusFilts.size && n.type === "server"))).map((n) => n.id)).size;

  // Старт и выбор среза
  ok(slice === "all" && group() === "folder" && on(), "при старте папки включены");
  ok(inRow || (btn().getAttribute("role") === "switch" && btn().querySelector(".sw.on")), "«Папки» — переключатель");
  ok(!btn().closest('[aria-label="' + i18n("Срез дерева") + '"]'), "переключатель не среди срезов");
  for (const s of ["cam", "acfa", "all"]) { click(s); ok(slice === s && on(), `срез ${s} не меняет включённые «Папки»`); }
  // В «Детекторах» у «Папок» своё положение: второе положение — виды, при входе стоят они
  click("det");
  ok(slice === "det" && (inRow ? group() === "folder" && on() : group() === "kind" && !on()), inRow ? "«Детекторы»: положение то же, «Папки» включены" : "«Детекторы»: при входе положение «Виды», «Папки» выключены");
  click("cam");
  btn().click();
  ok(!on() && group() === "server", "выключили в «Камерах»");
  for (const s of ["acfa", "all"]) { click(s); ok(!on(), `срез ${s}: выключенные «Папки» не включились`); }
  click("det");
  ok(group() === "kind" && !on(), "«Детекторы» при выключенных «Папках» — виды");
  btn().click();
  ok(on() && group() === "folder", "включили «Папки» в «Детекторах»");
  click("cam");
  ok(inRow ? on() && group() === "folder" : !on() && group() === "server", inRow ? "«Камеры»: «Папки» включены, положение общее" : "«Камеры»: «Папки» остались выключенными, «Детекторы» их не включили");
  if (!inRow) { btn().click(); ok(on(), "включили обратно"); }
  click("det");
  ok(on() && group() === "folder", "«Детекторы»: «Папки» включены");

  // Серверы и Хранилища: папок нет, срез кнопка не переключает, состояние ждёт возврата
  for (const s of ["srv", "arch"]) {
    click(s);
    ok(btn().disabled && (inRow ? on() : !on()) && (btn().title||btn().dataset.tip) === i18n("В этом срезе нет папок"), `срез ${s}: кнопка неактивна и говорит почему`);
    btn().click();
    ok(slice === s, `срез ${s}: нажатие не сменило срез`);
  }
  click("cam");
  ok(on() && !btn().disabled, "вернулись — «Папки» снова включены");

  // Статус сохраняется, типы снимаются
  pickStatus("nosignal");
  for (const s of ["all", "cam", "acfa", "srv", "arch", "det"]) {
    click(s);
    ok(curStatus() === "nosignal" && /Нет сигнала|Нет связи/.test(document.querySelector(".ph-status-label").textContent), `срез ${s}: статус сохранён`);
  }
  click("cam");
  typeFilts.add("camera");
  click("acfa");
  ok(!typeFilts.size && curStatus() === "nosignal", "типы сняты, статус на месте");

  // «Найдено» — то, что показано в срезе
  for (const status of ["nosignal", "run"]) {
    pickStatus(status);
    for (const s of ["all", "cam", "acfa", "srv", "arch", "det"]) {
      click(s);
      await settle();
      const n = Number((/Найдено: (\d+)/.exec(hint()) || [])[1]);
      ok(n === shownObjects(), `${status}, срез ${s}: «Найдено» ${n}, в дереве ${shownObjects()}`);
    }
  }
  pickStatus("");
  click("all");
  await settle();
  ok(hint() === "", "без фильтра подсказки нет");

  // Очистка поиска убирает прежний счёт
  setTreeQ("Экспорт");
  await settle();
  ok(/Найдено: [1-9]/.test(hint()) && shownObjects() > 0, "поиск находит службы при включённых папках: " + hint());
  setTreeQ("");
  await settle();
  ok(hint() === "", "после очистки поиска «Найдено» нет");

  // «Детекторы»: камера, найденная по имени, показывает детекторы — они в счёт
  const camDet = devicePool.find((n) => n.type === "camera" && (n.devices || []).some((x) => x.type === "det"));
  click("det");
  setTreeQ(camDet.name);
  await settle();
  const nDet = Number((/Найдено: (\d+)/.exec(hint()) || [])[1]);
  ok(nDet > 0 && nDet === shownObjects(), `«Детекторы», поиск камеры: «Найдено» ${nDet}, в дереве ${shownObjects()}`);
  setTreeQ("");
  click("all");
  await settle();

  // Группа «Службы»
  ok(svcGroups().length === domains.length, "у каждого домена группа «Службы»");
  svcGroups()[0].click();
  ok(await until(() => treeRows().some((e) => SVC_TYPES.has(find(e.dataset.pick)?.n.type))), "группа раскрывается по клику");
  const svcId = treeRows().find((e) => SVC_TYPES.has(find(e.dataset.pick)?.n.type)).dataset.pick;
  for (const s of ["cam", "acfa", "det"]) { click(s); ok(!svcGroups().length, `срез ${s}: группы нет`); }
  click("all");
  setGroup("server");
  ok(!svcGroups().length, "в раскладке по серверам группы нет");
  setGroup("folder");

  // Переход не трогает «Папки» без нужды, а когда нужно — шапка показывает правду
  jumpToNode(find(svcId).n);
  ok(on() && !!treeRowOf(svcId), "переход к службе: «Папки» включены, строка на месте");
  const srvNode = domains[0].servers[0];
  jumpToNode(srvNode);
  await settle();
  ok(group() === "server" && !on(), "переход к серверу выключает: в папках его строки нет, шапка это показывает");
  const fold = domainFolders(domains[0].id)[0];
  jumpToNode(fold);
  await settle();
  ok(group() === "folder" && on(), "переход к папке включает, шапка это показывает");

  // Избранное не меняет раскладку, если объект виден и так
  const cam = devicePool.find((n) => n.type === "camera" && cameraTreeServer(n.id));
  toggleFav(cam.id, null);
  const i = favs.findIndex((f) => f.id === cam.id);
  ok(favs[i]?.group === "folder", "избранное сохранено в раскладке по папкам");
  setSlice(favs[i].slice);
  setGroup("server");
  goFav(i);
  await settle();
  const onRow = () => document.querySelector("#tree .n.on")?.dataset.pick;
  ok(group() === "server" && !on() && onRow() === cam.id, "избранное открылось, раскладка прежняя, строка выбрана");
  // Ярлык из папки, открытый в раскладке по серверам, и наоборот: место чужой раскладки не мешает выбору
  const inFolder = devicePool.find((n) => n.type === "camera" && foldersOfDevice(n.id).length && cameraTreeServer(n.id));
  toggleFav(cam.id, null);
  setSlice("cam");
  setGroup("folder");
  pick(inFolder.id, { ctx: "f:" + foldersOfDevice(inFolder.id)[0].id });
  toggleFav(inFolder.id, selCtx);
  const k = favs.findIndex((f) => f.id === inFolder.id);
  setGroup("server");
  pick(domains[0].id);
  goFav(k);
  await settle();
  ok(group() === "server" && onRow() === inFolder.id, "ярлык из папки в раскладке по серверам: строка выбрана");
  favs[k].ctx = "srv:" + cameraTreeServer(inFolder.id).id;
  favs[k].group = "server";
  setGroup("folder");
  pick(domains[0].id);
  goFav(k);
  await settle();
  ok(group() === "folder" && onRow() === inFolder.id, "ярлык с сервера в раскладке по папкам: строка выбрана");
  // Переход без заданного места: в папках строка выбрана и моргать есть чему
  pick(domains[0].id);
  jumpToNode(inFolder);
  await settle();
  ok(group() === "folder" && onRow() === inFolder.id, "переход из поиска: строка в папке выбрана");
  // Статус прячет объект ярлыка: снимается, строка на месте
  const running = devicePool.find((n) => n.type === "camera" && !statusIs(n, "nosignal") && foldersOfDevice(n.id).length);
  favs[k] = { ...favs[k], id: running.id, name: running.name, slice: "cam", ctx: null };
  setSlice("det");
  pickStatus("nosignal");
  await settle();
  goFav(k);
  await settle();
  ok(slice === "cam" && !curStatus() && onRow() === running.id, "статус прячет объект ярлыка: снят, строка выбрана");
  ok(/Нет сигнала|Все статусы/.test(document.querySelector(".ph-status-label").textContent) && !/Нет сигнала/.test(document.querySelector(".ph-status-label").textContent), "шапка показывает снятый статус");
  favs.splice(k, 1);

  // Нет связи с доменом: строка есть в обеих раскладках
  const d = domains[0];
  open.add(d.id);
  d.online = false;
  for (const g of ["server", "folder"]) {
    setSlice("all");
    setGroup(g);
    renderTree();
    ok(/показано только своё|показывает только свои данные/.test(document.getElementById("tree").textContent), `${g}: нет связи с доменом — строка в дереве`);
  }
  d.online = true;
});
