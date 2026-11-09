/* Сценарии интерфейса: единый правый клик. Меню браузера внутри макета нет,
   меню содержит только действия того, по чему щёлкнули, поле ввода показывает своё меню.
   На странице без единого правого клика (старые прототипы) сценарий молчит. У прототипов на основе 21
   своя таблица детекторов и свой мастер серверов: их ветки — по наличию функций.
   Запуск — python3 tools/check_ui.py tests/ui-rc-menu.js */
UiCheck(async ({ ok, sleep, until, confirmWith }) => {
  if (typeof rcOnContext !== "function") { ok(true, "на этой странице единого правого клика нет"); return; }
  const menuEl = () => document.getElementById("tctx");
  const opened = () => menuEl().classList.contains("open");
  const items = () => opened() ? [...menuEl().querySelectorAll("button")].map(b => b.innerText.replace(/\s+/g, " ").trim()) : [];
  const has = (re) => items().some(t => re.test(t));
  // Правый клик по элементу: true, если страница отменила меню браузера
  const rc = (el, extra = {}) => {
    closeTreeCtx();
    const r = el.getBoundingClientRect();
    return !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.x + 4, clientY: r.y + 4, ...extra }));
  };
  const main = () => document.getElementById("main");
  const aside = () => document.getElementById("aside");
  const dom = domains[0], server = servers.find(s => domainOf(s.id));

  // 1. Меню браузера: нет нигде, кроме Shift
  pick(dom.id); await sleep(150);
  ok(rc(main()), "пустое место карточки: меню браузера отменено");
  ok(rc(document.body), "пустое место страницы: меню браузера отменено");
  ok(!rc(main(), { shiftKey: true }), "Shift + правый клик оставляет меню браузера");
  closeTreeCtx();

  // 2. Пустое место карточки — меню объекта карточки
  rc(main());
  ok(has(/Добавить устройства/) && has(/Удалить домен/), "пустое место карточки домена показывает меню домена");
  // Кнопка: её действие и так на виду
  const btn = main().querySelector("button");
  rc(btn);
  ok(!opened(), "кнопка не открывает меню");

  // 3. Закрытие и граница окна
  rc(main(), { clientX: innerWidth - 2, clientY: innerHeight - 2 });
  const box = menuEl().getBoundingClientRect();
  ok(box.right <= innerWidth && box.bottom <= innerHeight, "меню не выходит за край окна");
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(30);
  ok(!opened(), "Esc закрывает меню");
  rc(main());
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await sleep(30);
  ok(!opened(), "клик снаружи закрывает меню");

  // 4. Поле ввода
  const inp = document.createElement("input");
  inp.value = "текст";
  main().appendChild(inp);
  ok(rc(inp), "поле ввода: меню браузера отменено");
  ok(["Вырезать", "Копировать", "Вставить", "Выделить всё"].every(l => has(new RegExp(l))) && items().length === 4, "поле ввода показывает своё короткое меню");
  closeTreeCtx();
  inp.remove();

  // 5. Меню по срезу
  setSlice("det"); await sleep(150);
  rc(aside());
  if (typeof detCreateOpen === "function") ok(has(/Добавить детекторы/) && !has(/Создать домен/), "«Детекторы»: пустое место дерева предлагает детекторы, не домен");
  else {
    ok(!opened(), "«Детекторы»: на пустом месте дерева домен не предлагается");
    const camD = devicePool.find(d => d.type === "camera");
    openTreeCtx(camD, { x: 40, y: 40 });
    ok(has(/Добавить детектор/) && !has(/Переименовать/), "«Детекторы»: у камеры только добавление детектора");
    closeTreeCtx();
  }
  const det = camDetectors(devicePool.find(d => d.type === "camera" && camDetectors(d).length))[0];
  ok(!!det && canTreeCtx(det), "строка детектора: у неё есть меню");
  openTreeCtx(det, { x: 40, y: 40 });
  ok(has(/Удалить/), "строка детектора: в меню есть удаление");
  closeTreeCtx();
  setSlice("arch"); await sleep(150);
  openTreeCtx(server, { x: 40, y: 40 });
  // Кнопки «Исключить из домена» внизу карточки нет: пункт есть в «Ещё» на всех срезах с карточкой сервера
  ok(has(/Создать хранилище/) && has(/Исключить из домена/), "«Хранилища»: у сервера есть «Исключить из домена»");
  closeTreeCtx();
  setSlice("all"); await sleep(150);

  // Выбор таблицы детекторов не действует вне неё
  if (typeof dl !== "undefined") {
    const dets = devicePool.filter(d => d.type === "camera").flatMap(camDetectors).slice(0, 2);
    dl.sel = new Set(dets.map(d => d.id));
    const row = document.createElement("div");
    row.setAttribute("data-on-click", JSON.stringify([["detFromCam", dets[0].id]]));
    main().appendChild(row);
    rc(row);
    ok(!has(/\(2\)/), "вне таблицы детекторов старый выбор не даёт групповое меню");
    row.remove();
    dl.sel.clear();
  }

  // Строка с несколькими вызовами ведёт к своему объекту, чужой щелчок — не меню карточки
  pick(dom.id); await sleep(100);
  const cam2 = devicePool.find(d => d.type === "camera");
  const link = document.createElement("div");
  link.setAttribute("data-on-click", JSON.stringify([["goApp", "hw"], ["pick", cam2.id]]));
  main().appendChild(link);
  rc(link);
  ok(!has(/Удалить домен/) && opened(), "строка с goApp и pick показывает меню своего объекта, не домена");
  link.remove();
  const own = document.createElement("div");
  own.setAttribute("data-on-click", JSON.stringify([["toast", "x"]]));
  main().appendChild(own);
  rc(own);
  ok(!opened(), "элемент со своим щелчком не открывает меню карточки");
  own.remove();

  // Меню поля поверх окна, Esc закрывает меню, а не окно
  const addServers = () => { if (typeof openAddServers === "function") openAddServers(dom.id); else { pick(dom.id); openW("server"); } };
  addServers(); await sleep(50);
  const fld = document.querySelector("#wbd input,#wbd textarea");
  rc(fld);
  const mb = menuEl().getBoundingClientRect();
  ok(menuEl().contains(document.elementFromPoint(mb.x + 10, mb.y + 10)), "меню поля видно поверх мастера");
  fld.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(30);
  ok(!opened() && wizOpen(), "Esc закрывает меню поля, мастер остаётся");
  closeWizard(); await sleep(30);

  // 6. Единица СКУД в кнопке добавления, подтверждение числом
  ok(addSplitItems(dom).some(i => /СКУД/.test(i[0])) && addSplitItems(server).some(i => /СКУД/.test(i[0])), "«Единицу СКУД…» в кнопке добавления домена и сервера");
  excludeFromDomain(server.id);
  ok(document.getElementById("confirm").classList.contains("open") && !!document.getElementById("confirmCountInp") && document.getElementById("confirmOk").disabled, "«Исключить из домена»: подтверждение с вводом числа");
  closeConfirm();

  // 7. Все мастера добавления открываются (размер окна идёт за шагом, у разных мастеров он разный)
  pick(server.id); await sleep(100);
  const wizOn = [];
  for (const open of [() => planOpen(), () => openW("svc"), () => openW("unit"), addServers]) {
    open(); await sleep(30);
    wizOn.push(wizOpen());
    closeWizard(); await sleep(30);
  }
  ok(wizOn.length === 4 && wizOn.every(Boolean), "все мастера добавления открываются: " + wizOn.join(", "));

  // 8. Пункт меню действует: сначала открывает объект, затем выполняет действие
  pick(dom.id); await sleep(100);
  openTreeCtx(server, { x: 40, y: 40 });
  ok(sel === dom.id, "меню не переходит к объекту");
  [...menuEl().querySelectorAll("button")].find(b => /Исключить из домена/.test(b.innerText)).click();
  ok(sel === server.id && document.getElementById("confirm").classList.contains("open"), "пункт меню открывает объект и его подтверждение");
  closeConfirm(); await sleep(30);

  // 9. Строка со ссылкой openNode показывает меню объекта
  if (RC_LINKS.openNode) {
    const nodeLink = document.createElement("div");
    nodeLink.setAttribute("data-on-click", JSON.stringify([["openNode", dom.id]]));
    main().appendChild(nodeLink);
    rc(nodeLink);
    ok(opened(), "строка с openNode показывает меню объекта");
    closeTreeCtx();
    nodeLink.remove();
  }

  // 10. Удаление детектора из его карточки: на экране его камера, а не пустое место
  const camOfDet = devicePool.find(d => d.type === "camera" && camDetectors(d).some(x => x.id === det.id));
  pick(det.id); await sleep(100);
  ok(sel === det.id, "карточка детектора открыта");
  deleteDetector(camOfDet.id, det.id);
  await confirmWith(1);
  ok(await until(() => !camDetectors(camOfDet).some(x => x.id === det.id) && sel === camOfDet.id, 30000), "после удаления детектора открыта его камера");
});
