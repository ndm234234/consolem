/* План добавления устройств. Один вход в шапке, три источника в один план, в системе ничего
   нет до «Применить», отказы — по строкам, повтор неудачных. */
UiCheck(async ({ ok, until, confirmWith }) => {
  goApp("hw");
  const d1 = domains[0];
  const headText = () => [...document.querySelectorAll("#main .hd-act button")].map((b) => b.textContent.trim());
  // 1. Шапка домена: один вход, остальное — в меню стрелки
  pick(d1.id);
  goTab("gen");
  let head = headText();
  ok(head.filter((t) => /^Добавить устройства/.test(t)).length === 1, "в шапке домена один вход: " + head.join(" | "));
  ok(!head.some((t) => /^(Найденные|Вручную|Из файла)$|^Хранилище/.test(t)), "в шапке нет «Найденные», «Вручную», «Из файла», «Хранилище»");
  document.querySelector("#main .btn-split-arrow").click();
  let menu = document.getElementById("tctx");
  ok(menu.classList.contains("open") && /Серверы?…/.test(menu.textContent) && /Хранилище…/.test(menu.textContent), "меню стрелки у домена: " + menu.textContent.trim().replace(/\s+/g, " "));
  closeTreeCtx();
  const srv = servers.find((s) => !isUnallocated(s.id) && SERVER_DOMAIN[s.id] === d1.id) || servers.find((s) => !isUnallocated(s.id));
  pick(srv.id);
  goTab("gen");
  head = headText();
  ok(head.filter((t) => /^Добавить устройства/.test(t)).length === 1 && !head.some((t) => /^(Найденные|Вручную|Из файла)$|^Хранилище/.test(t)), "у сервера — тоже один вход");
  document.querySelector("#main .btn-split-arrow").click();
  menu = document.getElementById("tctx");
  ok(/Службу…/.test(menu.textContent) && /Хранилище…/.test(menu.textContent), "меню стрелки у сервера: " + menu.textContent.trim().replace(/\s+/g, " "));
  closeTreeCtx();

  // 2. Три источника — в один план; на сервере пока ничего
  pick(d1.id);
  goTab("gen");
  // детектор движения у камеры — тоже запись списка: считаем устройства без детекторов
  const countDev = async () => (await uiDevices()).filter((d) => d.type !== "det").length;
  const n0 = await countDev();
  const addBtn = [...document.querySelectorAll("#main .hd-act button")].find((b) => /^Добавить устройства/.test(b.textContent.trim()));
  addBtn.click();
  ok(document.getElementById("wiz").classList.contains("open") && !document.getElementById("planPanel"), "ящик открыт, на первом шаге источники без панели плана");
  wizStepGo(1);
  ok(!!document.getElementById("planPanel") && /отметьте устройства и нажмите «В план»|отметить устройства и нажать «В план»/.test(document.getElementById("planPanel").textContent), "пустой план на шаге «План» подсказывает, что делать");
  wizStepGo(0);
  ok(document.querySelectorAll(".plan-tab").length === (can("startDiscovery") ? 3 : 2) && /Добавить устройства/.test(document.getElementById("wizT").textContent), "три вкладки и заголовок «Добавить устройства»");
  ok(!/Добавить вручную|Добавить из файла|К результатам поиска/.test(document.getElementById("wizFoot").textContent), "в подвале нет старых кнопок вкладок");
  const srvSel = document.getElementById("planSrv");
  const onlineSrv = planServerList().filter((s) => s.online !== false);
  ok(!srvSel || [...srvSel.options].filter((o) => o.disabled).length === planServerList().length - onlineSrv.length, "офлайн-серверы в списке погашены");
  ok(await until(() => wizd.devState === "done" && wizd.devResults.length > 2), "поиск в сети завершён: " + wizd.devResults.length);
  // у двух находок общий адрес (конфликт MAC): в план берём по одному адресу
  const good = wizd.devResults.filter((r, i, l) => r.status === "ok" && l.findIndex((x) => x.ip === r.ip) === i).slice(0, 2);
  // Галочка «все найденные» — про строки поиска, а не про объекты дерева за окном
  const treeBefore = [...treeSel].join();
  document.getElementById("devSelectAll").click();
  const pickable = selectableDeviceResults();
  ok(pickable.length > 0 && pickable.every((r) => wizd.devSelected.has(r.id)), "галочка отмечает все найденные: " + wizd.devSelected.size + " из " + pickable.length);
  ok([...treeSel].join() === treeBefore, "галочка не трогает выбор в дереве: " + treeSel.size);
  ok(document.getElementById("devSelectAll").checked, "после перерисовки галочка стоит");
  document.getElementById("devSelectAll").click();
  ok(wizd.devSelected.size === 0, "снятая галочка очищает выбор");
  good[0].user = "admin";
  good[0].pass = "secret";
  good.forEach((r) => wizd.devSelected.add(r.id));
  planAddFound();
  ok(addPlan.rows.length === 2 && addPlan.rows.every((x) => x.source === "found"), "найденные — в плане: " + addPlan.rows.length);
  ok(good.every((r) => r.planned) && selectableDeviceResults().every((r) => !r.planned), "в списке слева они помечены и не выбираются");
  ok(document.querySelectorAll("#wbd .dev-result.planned").length >= 2 && /В плане/.test(document.querySelector("#wbd .dev-result.planned").textContent), "строки слева — «В плане»");
  planAddFound([good[0]]);
  ok(addPlan.rows.length === 2, "тот же адрес второй раз не добавляется");
  const sid = planServerId();
  ok(addPlan.rows.every((x) => x.serverId === sid && planAllowedArchives(x.serverId, x.domainId).some((a) => a.id === x.r.arch || !x.r.arch)), "строки на выбранном сервере, архив — из его списка");
  setDeviceTab("manual");
  Object.assign(wizd.manual, { type: "camera", ip: "10.7.7.1", port: "80", vendor: "Axis", model: "P3245-LV", user: "admin", pass: "pw1", name: "Ручная камера", identifier: "", short: "", rtsp: "" });
  planAddManual();
  ok(addPlan.rows.length === 3 && addPlan.rows[2].source === "manual", "ручная камера — в плане");
  ok(wizd.manual.ip === "" && wizd.manual.name === "" && wizd.manual.vendor === "Axis" && wizd.manual.user === "admin" && wizd.manual.pass === "pw1", "форма очищена, производитель и логин остались");
  ok(document.activeElement?.id === "devManIp", "курсор — в поле IP");
  setDeviceTab("csv");
  const row = (o) => ({ id: "csv" + o.ip, short: "", identifier: "", port: "80", user: "admin", pass: "1", group: "", arch: "", record: "none", lat: "", lon: "", azimuth: "", errors: [], ...o });
  wizd.csvRows = [row({ name: "Камера из файла", ip: "10.7.7.2", vendor: "Axis", model: "P3245-LV" })];
  toggleCsvAll(true);
  planAddCsv();
  ok(addPlan.rows.length === 4 && addPlan.rows[3].source === "csv" && wizd.csvRows[0].planned, "строка файла — в плане");
  ok(/В плане/.test(document.getElementById("wbd").textContent), "источник: строка файла помечена «В плане»");
  wizStepGo(1);
  ok(/План · 4/.test(document.getElementById("planPanel").textContent), "панель: «План · 4»");
  wizStepGo(0);
  ok((await countDev()) === n0 && (await uiDevices()).every((d) => !["10.7.7.1", "10.7.7.2"].includes(d.ip)), "на сервере устройств столько же: " + n0);

  // 3. Убрать и «Очистить» с «Вернуть»
  setDeviceTab("search");
  const gone = addPlan.rows[1];
  planRemove(gone.pid);
  ok(addPlan.rows.length === 3 && !good[1].planned && selectableDeviceResults().includes(good[1]), "убранная строка снова доступна слева");
  good[1].user = "admin";
  good[1].pass = "";
  wizd.devSelected.add(good[1].id);
  planAddFound();
  ok(addPlan.rows.length === 4, "и добавляется снова");
  planClear();
  ok(addPlan.rows.length === 0 && !good[0].planned && !wizd.csvRows[0].planned, "план очищен, метки сняты");
  document.querySelector("#ttu-planclear .ttu-act").click();
  ok(addPlan.rows.length === 4 && good[0].planned && wizd.csvRows[0].planned, "«Вернуть» вернуло 4 строки и метки");
  ok(!document.getElementById("confirm").classList.contains("open"), "без окна подтверждения");

  // 4. Ошибки и предупреждения
  wizStepGo(1);
  const camId = (await uiDevices()).find((d) => d.type === "camera" && d.identifier).id;
  const takenId = (await uiRec(camId)).identifier;
  const csvRow = addPlan.rows.find((x) => x.source === "csv");
  csvRow.r.identifier = takenId;
  ok(planRowIssues(csvRow).some((i) => i.err && /уже используется/.test(i.text)), "занятый ID — ошибка строки");
  planRender();
  const nOk = planOkRows().length;
  ok(nOk === 3 && /Добавить 3 устройства/.test(document.getElementById("planApplyBtn").textContent), "в «Добавить» — только строки без ошибок: 3");
  ok(/1 строка с ошибкой останется в плане/.test(document.getElementById("wizFoot").textContent), "строка про оставшиеся с ошибками");
  const noPass = addPlan.rows.find((x) => x.src === good[1]);
  ok(noPass && planRowIssues(noPass).some((i) => !i.err && /Нет пароля/.test(i.text)), "без пароля — предупреждение, не ошибка");
  ok(planOkRows().includes(noPass), "строка с предупреждением применяется");
  const expand = document.querySelector(`.plan-row[data-pid="${csvRow.pid}"] .plan-row-main`);
  expand.click();
  ok(document.querySelector(`.plan-row[data-pid="${csvRow.pid}"] .plan-edit`) && document.querySelector(`.plan-row[data-pid="${csvRow.pid}"] input[type=password]`), "строка раскрывается: поля и пароль");

  // 5. Применить: один POST /units, подтверждение из-за предупреждения
  const posts = [];
  const realPost = API.post;
  API.post = function (path, body, ...rest) {
    if (path === "/units") posts.push(body);
    return realPost.call(this, path, body, ...rest);
  };
  planApply();
  const dlg = document.getElementById("confirm");
  ok(dlg.classList.contains("open") && /Применить план/.test(document.getElementById("confirmTitle").textContent) && /(Нет логина или пароля — добавятся выключенными|Нет логина или пароля\. Консоль добавит устройства выключенными): 1/.test(document.getElementById("confirmMsg").textContent), "предупреждение — окно: " + document.getElementById("confirmMsg").textContent);
  ok(!document.getElementById("confirmCountInp"), "число вводить не нужно");
  ok(document.getElementById("confirmOk").textContent === "Добавить 3", "кнопка «Добавить 3»");
  const applyRows = planOkRows().slice();
  await confirmWith();
  ok(await until(() => !addPlan.applying && addPlan.added.length === 3), "план применён");
  ok(posts.length === 1 && posts[0].items.length === 3, "ушёл один POST /units на 3 устройства");
  const after = await uiDevices();
  ok(after.filter((d) => d.type !== "det").length === n0 + 3, "на сервере +3 устройства: " + (n0 + 3));
  const made = applyRows.map((x) => after.find((d) => d.ip === x.r.ip));
  ok(made.every(Boolean) && made.every((d, i) => d.serverId === applyRows[i].serverId), "устройства на выбранном сервере");
  ok(made.every((d, i) => (d.archiveId || d.archives?.[0]?.archiveId || null) === (applyRows[i].r.arch || null) || !applyRows[i].r.arch), "архив — выбранный в строке");
  ok(addPlan.rows.length === 1 && addPlan.rows[0] === csvRow && csvRow.state === "plan", "строка с ошибкой осталась в плане");
  ok(good[0].added && good[0].addedId && !good[0].planned, "исходная строка слева — «добавлено»");
  ok(/Добавлено \(3\)/.test(document.getElementById("planPanel").textContent) && document.querySelectorAll("#planPanel .plan-added-row .lk-act").length === 3, "раздел «Добавлено (3)» со ссылками");
  const nodeNoPass = after.find((d) => d.ip === noPass.r.ip);
  ok(nodeNoPass.enabled === false, "без пароля добавлено выключенным");
  document.querySelector("#planPanel .plan-added-row .lk-act").click();
  ok(!document.getElementById("wiz").classList.contains("open") && sel_ok(), "«Перейти» открыло устройство");
  function sel_ok() {
    return !!find(sel);
  }
  ok(await until(() => document.querySelector("#main .acc-flash, .acc-flash")), "переход подсвечен");

  // 6. Отказ по строке и повтор только неудачных
  planRemove(csvRow.pid);
  pick(d1.id);
  goTab("gen");
  planOpen("manual");
  await API.post("/units", { idempotencyKey: "occupy-9001", items: [{ kind: "camera", name: "Занято", parentId: null, domainId: d1.id, properties: { identifier: "9001", rtspUrl: "rtsp://10.9.9.9/1" } }] }).then((r) => ok(r.done.length === 1, "занято: " + JSON.stringify(r.failed)), (e) => ok(false, "occupy " + JSON.stringify(e)));
  const mk = (ip, id) => {
    Object.assign(wizd.manual, { type: "camera", ip, port: "80", vendor: "Axis", model: "P3245-LV", user: "admin", pass: "pw", name: "Камера " + ip, identifier: id, short: "", rtsp: "" });
    planAddManual();
  };
  mk("10.7.8.1", "");
  mk("10.7.8.2", "9001");
  ok(addPlan.rows.length === 2 && planOkRows().length === 2, "две строки; занятость «9001» кэш интерфейса не видит");
  posts.length = 0;
  planApply();
  ok(await until(() => !addPlan.applying && posts.length === 1), "ушёл один запрос");
  const bad = addPlan.rows;
  ok(bad.length === 1 && bad[0].state === "fail" && bad[0].code === "IDENTIFIER_TAKEN", "отказ по строке остался в плане: " + bad[0]?.code);
  wizStepGo(1);
  ok(/не добавлено 1/.test(document.getElementById("planPanel").textContent) && /Повторить неудачные/.test(document.getElementById("planFoot").textContent), "сводка и «Повторить неудачные»");
  ok(/уже используется/i.test(document.getElementById("planPanel").textContent), "причина — по-русски");
  planEdit(bad[0].pid, "name", "Камера 10.7.8.2 (правка)");
  ok(planFailIssue(bad[0]) === null && bad[0].state === "fail", "правка снимает прежнюю причину, строка остаётся к повтору");
  planEdit(bad[0].pid, "identifier", "");
  const nFail = await countDev();
  posts.length = 0;
  planRetry();
  ok(await until(() => !addPlan.applying && posts.length === 1), "повтор — один запрос");
  ok(posts[0].items.length === 1, "в повторе только неудачная строка");
  ok(addPlan.rows.length === 0 && (await countDev()) === nFail + 1, "после повтора план пуст, устройство добавлено");

  // Обрыв связи: строки целы, ключ повтора тот же
  mk("10.7.8.3", "");
  const keys = [];
  let cut = true;
  API.post = function (path, body, ...rest) {
    if (path === "/units") {
      keys.push(body.idempotencyKey);
      if (cut) {
        cut = false;
        return Promise.reject(new TypeError("Failed to fetch"));   // ответа нет: связь оборвалась
      }
    }
    return realPost.call(this, path, body, ...rest);
  };
  planApply();
  ok(await until(() => !addPlan.applying && keys.length === 1), "первый запрос оборвался");
  ok(addPlan.rows.length === 1 && addPlan.rows[0].state === "plan" && !!addPlan.key, "строка на месте, ключ запомнен");
  planApply();
  ok(await until(() => !addPlan.applying && addPlan.rows.length === 0), "повтор прошёл");
  ok(keys.length === 2 && keys[0] === keys[1], "повтор — с тем же ключом");
  API.post = realPost;

  // 7. План переживает закрытие ящика и переход
  planOpen("manual");
  mk("10.7.8.4", "");
  closeWizard();
  ok(addPlan.rows.length === 1, "после закрытия ящика план на месте");
  const other = servers.find((s) => !isUnallocated(s.id) && s.id !== srv.id) || srv;
  pick(other.id);
  goTab("gen");
  ok(addPlan.rows.length === 1, "и после перехода к другому узлу");
  // Счётчик плана — на верхней панели: виден из любого раздела и узла, на кнопках добавления его нет
  const hdPlan = document.getElementById("hdPlan");
  ok(!hdPlan.hidden && hdPlan.textContent === "В плане: 1", "на верхней панели — счётчик плана: " + hdPlan.textContent);
  ok(!headText().some((t) => /В плане/.test(t)), "на кнопках шапки метки плана нет: " + headText().join(" | "));
  // Кнопки устройства ведут в тот же план; «Добавить службу» в план не ведёт
  const headAdd = () => [...document.querySelectorAll("#main .hd-act > button")].find((b) => /^Добавить/.test(b.textContent.trim()));
  const allDevs = (await uiUnitsAll()).filter(uiIsDevice).map(uiFlat);
  const devOf = (fn) => allDevs.find((d) => fn(d) && find(d.id));
  for (const [what, d] of [["камера", devOf((x) => x.type === "camera")], ["ACFA", devOf((x) => x.type === "acfa")]]) {
    pick(d.id);
    await until(() => headAdd());
    ok(!/В плане/.test(headAdd().textContent) && !hdPlan.hidden, what + ": метка на верхней панели, не на кнопке — " + headAdd().textContent.trim());
    headAdd().click();
    ok(wizd.mode === "device-add" && !document.getElementById("wn").disabled, what + ": кнопка открывает мастер с этим планом");
    wizStepGo(1);
    ok(document.querySelectorAll("#planPanel .plan-row").length === 1, what + ": на шаге «План» строка плана на месте");
    closeWizard();
  }
  for (const type of ["email", "sms", "export"]) {
    const d = devOf((x) => x.type === type);
    pick(d.id);
    await until(() => /службу/.test(headAdd()?.textContent || ""));
    ok(!/В плане/.test(headAdd().textContent) && !hdPlan.hidden, type + ": на «Добавить службу» метки нет, на верхней панели счётчик есть");
    hdPlan.click();
    ok(planInDrawer() && document.getElementById("wizDr").classList.contains("device-wizard") && document.querySelectorAll("#planPanel .plan-row").length === 1, type + ": счётчик открывает этот план и со службы");
    const planWiz = wizd;
    hdPlan.click();
    ok(wizd === planWiz && planInDrawer(), type + ": повторный клик открытое окно не пересоздаёт");
    closeWizard();
    headAdd().click();
    ok(wizd.mode !== "device-add" && wizd.view === "sys" && document.getElementById("wizT").textContent === "Добавить службу" && !document.getElementById("planPanel"), type + ": открывается мастер служб, а не план");
    closeWizard();
    ok(addPlan.rows.length === 1, type + ": план на месте");
  }
  pick(other.id);
  goTab("gen");
  planOpen("manual");
  wizStepGo(1);
  ok(document.querySelectorAll("#planPanel .plan-row").length === 1, "после повторного открытия строка в панели");
  closeWizard();
  addPlan.rows = [];
  planTouch();

  // Занятый адрес: камеры лежат в devicePool, в другом домене тот же адрес — другая сеть
  const poolCam = find(devOf((x) => x.type === "camera" && find(x.id).n.ip).id).n;
  const poolRow = { source: "manual", r: { ip: poolCam.ip, port: poolCam.port || 80 }, domainId: nodeDomainId(poolCam) };
  ok(planAddrInPool(poolRow), "адрес существующей камеры: строка плана о нём знает");
  ok(!planAddrInPool({ ...poolRow, domainId: "другой домен" }) && !planAddrInPool({ ...poolRow, r: { ip: "10.250.250.250", port: 80 } }), "другой домен или адрес — не занято");

  // Карточка найденного в дереве: в систему — только через план
  await Promise.all(domains.map((d) => discLoad(d.id)));
  await until(() => domains.some((d) => foundAll(d.id).length));
  const fdDom = domains.find((d) => foundAll(d.id).some((r) => r.status === "ok" && !r.added));
  if (fdDom) {
    const fdRow = foundAll(fdDom.id).find((r) => r.status === "ok" && !r.added);
    const fdPosts = [];
    API.post = function (path, body, ...rest) {
      if (path === "/units") fdPosts.push(body);
      return realPost.call(this, path, body, ...rest);
    };
    pick(`fdev:${fdDom.id}:${fdRow.id}`);
    goTab("gen");
    const fdBtn = (re) => [...document.querySelectorAll("#main .sc button")].find((b) => re.test(b.textContent));
    ok(await until(() => fdBtn(/^В план$/)) && !fdBtn(/Добавить устройство/), "карточка найденного: кнопка «В план», прямого добавления нет");
    fdBtn(/^В план$/).click();
    ok(addPlan.rows.length === 1 && fdRow.planned && !fdPosts.length, "карточка найденного: строка в плане, запроса нет");
    ok(await until(() => fdBtn(/Открыть план/) && fdBtn(/^Убрать$/)) && !fdBtn(/^В план$/), "карточка найденного: видно, что устройство в плане");
    fdBtn(/^Убрать$/).click();
    ok(addPlan.rows.length === 0 && !fdRow.planned, "карточка найденного: «Убрать» снимает строку");
    ok(await until(() => fdBtn(/^В план$/)), "карточка найденного: кнопка вернулась");
    fdBtn(/^В план$/).click();
    fdBtn(/Открыть план/).click();
    wizStepGo(1);
    ok(sel === fdDom.id && planInDrawer() && document.querySelectorAll("#planPanel .plan-row").length === 1, "карточка найденного: «Открыть план» открывает план домена со строкой");
    closeWizard();
    API.post = realPost;
    addPlan.rows = [];
    planTouch();
    planRemark();
    fdRow.planned = null;
  } else ok(false, "в наборе нет найденного устройства для проверки карточки");

  // F4: ошибки строки исправляются в самой строке
  pick(d1.id);
  goTab("gen");
  planOpen("manual");
  mk("10.7.9.1", "");
  wizStepGo(1);
  const fixRow = addPlan.rows[0];
  planEdit(fixRow.pid, "vendor", "");
  ok(planRowIssues(fixRow).some((i) => i.err && /производителя/.test(i.text)) && planOkRows().length === 0, "без производителя — ошибка строки");
  fixRow.open = true;
  planRender();
  ok(["ip", "port", "vendor", "model", "identifier", "user"].every((k) => document.querySelector(`.plan-row[data-pid="${fixRow.pid}"] [data-pf="${k}"]`)), "в форме строки — адрес, порт, производитель, модель, ID");
  planEdit(fixRow.pid, "vendor", "Axis");
  ok(planOkRows().length === 1, "правка производителя возвращает строку в «готово»");
  planRemove(fixRow.pid);

  // F1: таблица «Устройства» за открытым ящиком не отбирает у него wizd
  closeWizard();
  pick(d1.id);
  goTab("cams");
  planOpen("manual");
  gear();
  ok(wizd.mode === "device-add" && !wizd.lanOwner && planInDrawer(), "после перерисовки таблицы за ящиком wizd остался ящика");
  mk("10.7.9.2", "");
  wizStepGo(1);
  ok(/План · 1/.test(document.getElementById("planPanel").textContent), "панель видит добавленную строку: «План · 1»");
  planApply();
  ok(await until(() => !addPlan.applying && addPlan.added.length === 1), "применено при открытой вкладке «Устройства»");
  ok(/Добавлено \(1\)/.test(document.getElementById("planPanel").textContent) && !/идёт…/.test(document.getElementById("planPanel").textContent), "панель показывает «Добавлено (1)», а не «идёт…»");
  await API.post("/units", { idempotencyKey: "occupy-9002", items: [{ kind: "camera", name: "Занято 2", parentId: null, domainId: d1.id, properties: { identifier: "9002", rtspUrl: "rtsp://10.9.9.8/1" } }] });
  // кэш интерфейса уже знает «9002» из потока событий: на время проверки отключаем его знание, чтобы отказал сервер
  const realTaken = planIdTaken;
  planIdTaken = () => false;
  mk("10.7.9.3", "9002");
  planApply();
  ok(await until(() => !addPlan.applying && planFailRows().length === 1), "отказ при открытой таблице");
  ok(/уже используется/i.test(document.getElementById("planPanel").textContent) && /Повторить неудачные/.test(document.getElementById("planFoot").textContent), "причина и «Повторить» видны в панели");
  planIdTaken = realTaken;
  planEdit(planFailRows()[0].pid, "identifier", "");
  planRetry();
  ok(await until(() => !addPlan.applying && addPlan.rows.length === 0), "F4: повтор после исправления ID прошёл");
  ok((await uiDevices()).some((d) => d.ip === "10.7.9.3"), "строка с исправленным ID добавлена");
  closeWizard();

  // F3: два кандидата с одним адресом — разные строки
  planOpen();
  await until(() => wizd.devState === "done");
  const twins = wizd.devResults.filter((r) => r.ip === wizd.devResults[0].ip);
  if (twins.length > 1) {
    planAddFound([twins[0]]);
    ok(twins[0].planned && !twins[1].planned && selectableDeviceResults().includes(twins[1]), "F3: двойник по адресу не помечен «В плане»");
    planAddFound([twins[1]]);
    ok(addPlan.rows.length === 2 && planRowIssues(addPlan.rows[1]).some((i) => i.err), "F3: оба в плане, повтор адреса — ошибка второй строки");
    planRemove(addPlan.rows[0].pid);
    ok(!twins[0].planned && twins[1].planned === addPlan.rows[0].pid, "F3: «Убрать» снимает свою строку, а не чужую");
  } else ok(true, "F3: двойников в наборе нет");
  planClear();
  closeWizard();

  // F5: ящик открыт на втором домене — поиск и папка из него
  if (domains.length > 1) {
    const d2 = domains[1];
    pick(d2.id);
    goTab("gen");
    planOpen();
    ok(wizd.domain === d2.id && wizd.searchDomain === d2.id, "F5: поиск идёт в домене ящика: " + wizd.searchDomain);
    wizardFolder();
    ok(folderDomain(wizd.folder) === d2.id, "F5: папка ящика — из его домена");
    closeWizard();
    pick(foundId(d2.id));
    ok(addContext().domain === null && initDeviceWizard(addContext()).domain === d2.id, "F6: из «Найденных» домена 2 мастер — домена 2");
  } else ok(true, "F5/F6: второго домена нет");

  // F7: хранилище привязано к серверу — строка из сети встаёт на этот сервер
  pick(d1.id);
  goTab("cams");
  await until(() => lan.state === "done" && lan.net.length > 0);
  const localArch = arch.find((a) => a.server && SERVER_DOMAIN[a.server] === d1.id && planServerList(d1.id).some((s) => s.id === a.server && s.online !== false));
  const netRow = lan.net.find((r) => r.status !== "bad" && r.vendor);
  if (localArch && netRow) {
    lanPrefill(find(lan.owner).n, netRow);
    netRow.arch = localArch.id;
    ok(planFromLan("n:" + netRow.id), "F7: строка из сети в плане");
    const lr = addPlan.rows[addPlan.rows.length - 1];
    ok(lr.serverId === localArch.server && lr.r.arch === localArch.id && !lr.archWas, "F7: сервер — хранилища, архив не заменён");
    planRemove(lr.pid);
  } else ok(true, "F7: нет подходящего хранилища сервера или строки сети");

  // F8: регистратор из файла встаёт на сервер строки; у него нет предупреждения об архиве
  planOpen("csv");
  const nvrRow = row({ name: "NVR из файла", ip: "10.7.9.5", vendor: "Dahua", model: "Dahua NVR 5216" });
  wizd.csvRows = [nvrRow];
  toggleCsvAll(true);
  planAddCsv();
  const nrow = addPlan.rows[addPlan.rows.length - 1];
  ok(!planRowIssues(nrow).some((i) => /архив/i.test(i.text)), "F8: у регистратора из файла нет предупреждения об архиве");
  planApply();
  ok(await until(() => !addPlan.applying && addPlan.added.length === 1), "F8: регистратор применён");
  const nvrId = addPlan.added[0].id;
  ok((await uiRec(nvrId)).serverId === nrow.serverId, "F8: регистратор — на сервере строки");
  closeWizard();
  addPlan.rows = [];
  planTouch();

  // A1: строка файла — камера: архив, папка, предупреждение; регистратор — нет
  pick(d1.id);
  goTab("gen");
  const online = planServerList(d1.id).filter((x) => x.online !== false);
  planOpen("csv");
  wizd.csvRows = [row({ name: "Камера A1", ip: "10.7.10.1", vendor: "Axis", model: "P3245-LV" }), row({ name: "NVR A1", ip: "10.7.10.2", vendor: "Dahua", model: "Dahua NVR 5216" })];
  toggleCsvAll(true);
  planAddCsv();
  const [camR, nvrR] = addPlan.rows;
  wizStepGo(1);
  ok(planIsCam(camR) && !planIsCam(nvrR), "A1: камера из файла — камера, регистратор — нет");
  ok(planRowIssues(camR).some((i) => /Без архива/.test(i.text)) && !planRowIssues(nvrR).some((i) => /Без архива/.test(i.text)), "A1: у камеры «Без архива», у регистратора нет");
  camR.open = true;
  planRender();
  ok(document.querySelector(`.plan-row[data-pid="${camR.pid}"] [data-pf="arch"]`) && document.querySelector(`.plan-row[data-pid="${camR.pid}"] [data-pf="group"]`), "A1: у камеры из файла есть выбор архива и папки");

  // A3: заголовок сервера есть и при одной группе
  planRemove(nvrR.pid);
  ok(document.querySelector("#planPanel .plan-grp") && document.querySelector("#planPanel .plan-grp").textContent.includes(locName(find(camR.serverId).n)), "A3: у одной группы есть заголовок сервера");
  if (online.length > 1) {
    const other = online.find((x) => x.id !== camR.serverId);
    planSetServer(other.id);
    ok(document.querySelector("#planPanel .plan-grp").textContent.includes(locName(find(camR.serverId).n)) && camR.serverId !== other.id, "A3: после смены сервера в строке панель всё равно показывает сервер строки");
  }

  // Фокус в поле строки переживает перерисовку, как при приходе находок
  setDeviceTab("search");
  await until(() => wizd.devState === "done");
  wizStepGo(1);
  camR.open = true;
  planRender();
  document.querySelector(`.plan-row[data-pid="${camR.pid}"] [data-pf="pass"]`).focus();
  wizd.devResults.unshift({ ...wizd.devResults[0], id: "fnew-1" }, { ...wizd.devResults[0], id: "fnew-2" });
  renderDeviceWizard();
  ok(document.activeElement?.dataset?.pf === "pass" && document.activeElement.closest(".plan-row")?.dataset.pid === camR.pid, "фокус остался в пароле своей строки");
  planClear();

  // F1: «Найденные» под открытым ящиком не подменяют его мастера
  setDeviceTab("manual");
  wizd.manual.ip = "1.2.3.4";
  const keepW = wizd;
  pick(foundId(d1.id));
  ok(wizd === keepW && wizd.deviceTab === "manual" && wizd.manual.ip === "1.2.3.4" && planInDrawer(), "F1: после выбора «Найденных» wizd, вкладка и форма те же");
  closeWizard();

  // F5: папка выбрана в домене 1, ящик открыт на домене 2
  if (domains.length > 1) {
    const d2 = domains[1];
    const f1 = flatFolders().find((f) => folderDomain(f.id) === d1.id);
    pick(f1.id);
    pick(d2.id);
    planOpen("manual");
    ok(wizd.domain === d2.id && folderDomain(wizd.folder) === d2.id, "F5: папка ящика — из его домена, не из прежней выборки");
    mk("10.7.11.1", "");
    const fr = addPlan.rows[addPlan.rows.length - 1];
    // Папка формы — выбранная в панели «Папка» или «Без папки» (по умолчанию)
    const curFolder = wizd.noFolder ? null : wizd.folder;
    const shownFolder = document.querySelector('#wbd .dev-manual input[data-ck="updateManual|group"]')?.value || "";
    ok((fr.folderId || null) === curFolder && shownFolder === (curFolder ? locName(folderById(curFolder)) : "Без папки"), "F5: папка строки совпадает с папкой формы: " + shownFolder);
    planClear();
    closeWizard();
  } else ok(true, "F5: второго домена нет");

  // F7: сервер в строке «Сервер» главнее привязки архива найденного
  if (online.length > 1) {
    pick(d1.id);
    goTab("gen");
    planOpen();
    await until(() => wizd.devState === "done");
    const sA = planServerId(), sB = online.find((x) => x.id !== sA).id;
    const archA = arch.find((a) => a.server === sA);
    const fr0 = wizd.devResults.find((r) => r.status === "ok");
    if (archA) fr0.arch = archA.id;   // предустановка прежнего сервера
    planSetServer(sB);
    planAddFound([fr0]);
    const fr1 = addPlan.rows[addPlan.rows.length - 1];
    ok(fr1.serverId === sB, "F7: строка встала на сервер из строки «Сервер»");
    ok(planAllowedArchives(sB, fr1.domainId).some((x) => x.id === fr1.r.arch) || !fr1.r.arch, "F7: у строки архив, доступный серверу из строки «Сервер»");
    ok(!planRowIssues(fr1).some((i) => /недоступен/.test(i.text)) && !fr1.archWas, "F7: без предупреждения об архиве, которого человек не выбирал");
    planClear();
    closeWizard();
  } else ok(true, "F7: в домене один сервер");
  addPlan.rows = [];
  planTouch();

  // U3: меню стрелки берёт фокус и возвращает его по Esc
  pick(d1.id);
  goTab("gen");
  const arrow = document.querySelector("#main .btn-split-arrow");
  arrow.focus();
  arrow.click();
  ok(document.getElementById("tctx").contains(document.activeElement), "U3: после открытия фокус в меню");
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(!document.getElementById("tctx").classList.contains("open") && document.activeElement === arrow, "U3: по Esc фокус вернулся на стрелку");

  // U1, U2: фокус на строке плана
  planOpen("manual");
  mk("10.7.12.1", "");
  wizStepGo(1);
  const u = addPlan.rows[0];
  u.open = true;
  planRender();
  const mainBtn = document.querySelector(`.plan-row[data-pid="${u.pid}"] .plan-row-main`);
  mainBtn.focus();
  renderDeviceWizard();
  ok(document.activeElement?.classList.contains("plan-row-main") && document.activeElement.closest(".plan-row").dataset.pid === u.pid, "U1: фокус на кнопке строки пережил перерисовку ящика");
  const rowEl = document.querySelector(`.plan-row[data-pid="${u.pid}"]`);
  const ttl = planRowTitle(u).title;
  ok(["name", "user", "identifier"].every((k) => rowEl.querySelector(`[data-pf="${k}"]`).getAttribute("aria-label").endsWith(" · " + ttl)) && rowEl.querySelector('[data-pf="arch"]').getAttribute("aria-label").endsWith(" · " + ttl) && rowEl.querySelector('[data-pf="pass"]').getAttribute("aria-label").endsWith(" · " + ttl), "U2: подписи полей называют строку: " + ttl);
  planRemove(u.pid);
  ok(document.activeElement === document.getElementById("wb"), "U1: после последней строки фокус на «Назад»");

  // U6, U7: строка таблицы «Устройства» в плане
  closeWizard();
  pick(d1.id);
  goTab("cams");
  await until(() => lan.state === "done" && lan.net.length > 0);
  const lk = lan.net.find((r) => r.status !== "bad" && r.vendor && !r.planned && lanRows(find(lan.owner).n).some((x) => x.key === "n:" + r.id));
  planFromLanOne("n:" + lk.id);
  ok(/всего 1/.test(document.getElementById("tt")?.textContent || ""), "U7: тост из таблицы — со счётом «всего»");
  lanSetQ(lk.ip);   // строка сети может оказаться не на первой странице
  const chk = document.querySelector("tr.lan-net input.ts-chk:disabled");
  ok(chk && /плане/i.test(chk.title), "U6: у погашенной отметки строки плана есть причина: " + (chk && chk.title));
  planClear();
  addPlan.rows = [];
  planTouch();

  // Срез 2. Хранилище создают и на сервере, и на домене: с домена — только общее, которому сервер не нужен
  const d2Nas = (n) => ["", "", "nas" + n, "vms"].join(String.fromCharCode(92));
  const d2Dom = domains[0];
  const d2Srv = servers.find((s) => !isUnallocated(s.id) && SERVER_DOMAIN[s.id] === d2Dom.id);
  const srvMenu = (n) => { openTreeCtx(n, { x: 10, y: 10 }); const t = document.getElementById("tctx").textContent; closeTreeCtx(); return t; };
  const d2Main = () => document.querySelector("#main");
  const d2DomBtns = () => [...d2Main().querySelectorAll("button")].filter((b) => /Создать хранилище…/.test(b.textContent));
  ok(/Создать хранилище…/.test(srvMenu(d2Dom)), "хранилище: в меню дерева домена есть");
  ok(/Создать хранилище/.test(srvMenu(d2Srv)), "хранилище: в меню дерева сервера есть");
  pick(d2Dom.id);
  goTab("gen");
  ok(/Создать хранилище…/.test(document.querySelector(".dom-acts").textContent), "хранилище: в «Действиях» домена есть");
  ok(addSplitItems(d2Dom).some(([l]) => /^Хранилище…/.test(l)), "хранилище: в меню кнопки домена есть");
  ok(addSplitItems(d2Dom).some(([l]) => /Серверы( по IP)?…/.test(l)), "в меню кнопки домена — серверы по IP");
  ok(addSplitItems(d2Srv).some(([l]) => /Хранилище…/.test(l)), "хранилище: в меню кнопки сервера есть");
  goTab("srvs");
  ok(d2DomBtns().length === 1, "вкладка «Серверы» домена: одна кнопка над списком");
  const d2Opened = (what) => { ok(an && !an.server && an.domain === d2Dom.id, what + " открывает диалог домена"); archNewCancel(); };
  const d2MenuItem = (re) => [...document.querySelectorAll("#tctx button")].find((b) => re.test(b.textContent));
  openTreeCtx(d2Dom, { x: 10, y: 10 });
  d2MenuItem(/Создать хранилище…/).click();
  d2Opened("меню дерева");
  goTab("gen");
  d2Main().querySelector(".btn-split-arrow").click();
  d2MenuItem(/Хранилище…/).click();
  d2Opened("меню кнопки");
  [...document.querySelectorAll(".dom-acts button")].find((b) => /Создать хранилище…/.test(b.textContent)).click();
  d2Opened("«Действия»");
  goTab("srvs");
  ok(/выберите вид и сервер|выбрать вид и сервер/.test(d2Main().querySelector("[data-arch-where]")?.textContent || ""), "вкладка «Серверы» домена: подсказка, где создают диски");

  // С домена: в окне все виды, но первым выбран вид без обязательного сервера; сервер выбирают, по умолчанию — весь домен, владелец — домен
  const d2Body = () => document.getElementById("bmBody");
  d2DomBtns()[0].click();
  ok(an && !an.server && kindOf(an.kind).serverRequired === false, "диалог домена: первым выбран вид без обязательного сервера — " + (an && an.kind));
  ok(d2Body().querySelectorAll(".an-kind").length === refArchKinds.length, "диалог домена: в окне все виды");
  ok(/Весь домен/.test(d2Body().querySelector(".an-srv select")?.textContent || "") && d2Body().querySelector(".an-srv select").value === "", "диалог домена: поле «Сервер», выбрано «Весь домен»");
  ok(/любой сервер домена|Любой сервер домена/.test(d2Body().querySelector("[data-arch-where]")?.textContent || ""), "диалог домена: подсказка, что писать может любой сервер");
  ok(/Новое хранилище/.test(document.getElementById("bmTitle").textContent) && document.getElementById("bmTitle").textContent.includes(locName(d2Dom)), "диалог домена: заголовок про хранилище и домен");
  const d2Need = refArchKinds.find((k) => k.serverRequired);
  if (d2Need) {
    anSet("kind", d2Need.kind);
    ok(/Выберите сервер/.test(anBlock()), "диалог домена: виду с обязательным сервером без сервера дальше нельзя — " + anBlock());
    anSet("kind", "network");
  }
  anSet("name", "Общее хранилище — срез 2", true);
  anSet("disk", d2Nas(79), true);
  anSet("user", "svc", true);
  ok(!anBlock(), "диалог домена: можно создать — " + anBlock());
  ok(anArchive().serverId === null && anArchive().domainId === d2Dom.id, "диалог домена: в запросе домен, сервера нет");
  open.delete(d2Dom.id);
  createArchive();
  ok(await until(() => !an && arch.some((a) => a.name === "Общее хранилище — срез 2")), "диалог домена: хранилище создано, диалог закрыт");
  ok(open.has(d2Dom.id) && !open.has(undefined) && document.querySelectorAll("#tree .n.on").length === 1, "созданное видно и выделено в дереве, домен раскрыт");
  const d2Made = arch.find((a) => a.name === "Общее хранилище — срез 2");
  const d2SharedRec = await uiRec(d2Made.id);
  ok(!d2SharedRec.serverId && d2SharedRec.domainId === d2Dom.id && domainArchives(d2Dom.id).includes(d2Made), "на сервере — хранилище домена, оно в его списке");
  pick(d2Dom.id);
  goTab("srvs");
  ok(d2Main().textContent.includes("из " + domainArchives(d2Dom.id).length + " хранилищ"), "созданное учтено в списке домена: всего " + domainArchives(d2Dom.id).length);

  // Список виден и пустым: над ним кнопка. Домен без серверов — сначала добавить сервер
  const d2List = () => /Сетевые хранилища домена/.test(d2Main().textContent);
  const d2Empty = domains.find((x) => !domainArchives(x.id).length);
  ok(!!d2Empty, "есть домен без своих хранилищ");
  pick(d2Empty.id);
  goTab("srvs");
  ok(d2List() && d2DomBtns().length === 1, "домен без хранилищ: список с кнопкой");
  const d2Srvs = d2Empty.servers;
  d2Empty.servers = [];
  paint();
  ok(/сначала добавьте его|Сначала добавить сервер/.test(d2Main().querySelector("[data-arch-where]")?.textContent || ""), "домен без серверов: сначала добавить сервер");
  d2Empty.servers = d2Srvs;
  paint();

  // Система без видов на весь домен: на домене нет ни одной точки создания, пустого списка тоже
  const d2Kinds = refArchKinds;
  refArchKinds = d2Kinds.filter((k) => k.serverRequired);
  paint();
  ok(!d2List() && d2DomBtns().length === 0, "нет видов домена: нет кнопки и пустого списка");
  // Хранилище на дисках создают и с домена: сервер выбирают в окне
  ok(/Создать хранилище…/.test(srvMenu(d2Empty)) && addSplitItems(d2Empty).some(([l]) => /^Хранилище…/.test(l)), "нет видов домена: в меню хранилище остаётся");
  goTab("gen");
  ok(/Создать хранилище…/.test(document.querySelector(".dom-acts").textContent), "нет видов домена: в «Действиях» кнопка остаётся");
  addArchive(d2Empty.id);
  ok(an && !an.server && kindOf(an.kind).serverRequired && /Выберите сервер/.test(anBlock()), "нет видов домена: окно открыто, вид на дисках просит сервер — " + (an && anBlock()));
  archNewCancel();
  refArchKinds = d2Kinds;
  // Созданные раньше хранилища видны и тогда
  pick(d2Dom.id);
  goTab("srvs");
  refArchKinds = d2Kinds.filter((k) => k.serverRequired);
  paint();
  ok(d2List() && d2DomBtns().length === 1, "нет видов домена: созданные раньше видны, кнопка создания остаётся");
  refArchKinds = d2Kinds;
  paint();

  // С сервера: все виды, сервер подставлен в поле «Сервер»; виду на дисках «Весь домен» не предлагают; сетевое привязано к нему
  addArchive(d2Srv.id);
  ok(d2Body().querySelectorAll(".an-kind").length === refArchKinds.length && an.server === d2Srv.id && !!an.server, "диалог сервера: все виды, сервер подставлен");
  ok(d2Body().querySelector(".an-srv select")?.value === d2Srv.id && !/Весь домен/.test(d2Body().querySelector(".an-srv select").textContent), "диалог сервера: в поле выбран сервер, виду на дисках «Весь домен» не предлагают");
  ok(d2Body().querySelector(".an-srv select").selectedOptions[0].textContent.startsWith(locName(d2Srv)), "диалог сервера: имя сервера видно в поле");
  ok(locName(d2Srv) && document.getElementById("bmTitle").textContent.includes(locName(d2Srv)), "диалог сервера: сервер в заголовке");
  ok(!d2Body().querySelector("[data-arch-where]"), "диалог сервера: у локального подсказки нет");
  anSet("kind", "network");
  ok(/[Тт]олько этот сервер.*«Весь домен»/.test(d2Body().querySelector("[data-arch-where]")?.textContent || "") && /Весь домен/.test(d2Body().querySelector(".an-srv select").textContent), "диалог сервера: у сетевого видно, что оно этого сервера, а общее — «Весь домен»");
  ok(d2Body().querySelector(".an-srv select").value === d2Srv.id && an.server === d2Srv.id, "диалог сервера: смена вида сервер не сбрасывает");
  const d2KindsAll = refArchKinds;
  refArchKinds = d2KindsAll.map((k) => ({ ...k, serverRequired: true }));
  renderArchNew();
  ok(/[Тт]олько этот сервер/.test(d2Body().querySelector("[data-arch-where]")?.textContent || "") && !/Весь домен/.test(d2Body().querySelector("[data-arch-where]").textContent), "диалог сервера: «Весь домен» недоступен — про него не пишем");
  refArchKinds = d2KindsAll;
  renderArchNew();
  anSet("disk", d2Nas(78), true);
  anSet("user", "svc", true);
  anSet("name", "Сетевое на сервере — срез 2", true);
  ok(!anBlock(), "диалог сервера: можно создать — " + anBlock());
  ok(anArchive().serverId === d2Srv.id && anArchive().domainId === null, "диалог сервера: в запросе сервер, домена нет");
  ok(anArchive().firstVolume.disk === d2Nas(78), "путь NAS дошёл до запроса: " + anArchive().firstVolume.disk);
  createArchive();
  ok(await until(() => arch.some((a) => a.name === "Сетевое на сервере — срез 2")), "сетевое хранилище создано с сервера");
  const d2Rec = await uiRec(arch.find((a) => a.name === "Сетевое на сервере — срез 2").id);
  ok(d2Rec.serverId === d2Srv.id, "на сервере: сетевое хранилище этого сервера, serverId " + d2Rec.serverId);
  ok(serverArchives(d2Srv.id).some((a) => a.id === d2Rec.id), "оно в списке хранилищ сервера");
  pick(d2Srv.id);
  goTab("disk");
  ok([...d2Main().querySelectorAll("button")].some((b) => /Создать хранилище…/.test(b.textContent)), "вкладка дисков сервера: кнопка создания");

  // Шестой вид — «Облачное» (S3): форма показывает то, что объявил сервер. В наборе его пока нет: запрос mockup — виды и производители
  if (refArchKinds.some((k) => k.kind === "cloud")) {
  ok(refArchKinds.map((k) => k.kind).join() === "local,network,cloud,backup,edge,incidents", "S3: шесть видов, облачное рядом с удалённым — " + refArchKinds.map((k) => k.kind));
  addArchive(d2Srv.id);
  const d2Cards = () => [...d2Body().querySelectorAll(".an-kind")];
  ok(d2Cards().length === 6, "S3: на сервере шесть карточек");
  ok(new Set(d2Cards().map((c) => c.offsetTop)).size === 2 && new Set(d2Cards().map((c) => c.offsetLeft)).size === 3, "S3: сетка три на два, без одинокой карточки");
  ok(/Облачное/.test(d2Cards()[2].textContent) && /Amazon S3/.test(d2Cards()[2].textContent), "S3: в карточке вида есть название и S3: " + d2Cards()[2].textContent);
  anSet("kind", "cloud");
  ok(d2Body().querySelectorAll(".an-provs button").length === CLOUD_PROVIDERS.length, "S3: на выбор все провайдеры");
  anGo(2);
  ok([...d2Body().querySelectorAll(".g label")].some((l) => l.textContent.trim() === "Бакет") && !/Путь к папке/.test(d2Body().textContent), "S3: на шаге «Первый том» поле бакета вместо полей NAS");
  ok(/Проверить подключение/.test(document.getElementById("bmFoot").textContent), "S3: есть проверка подключения");
  ok(/Укажите бакет/.test(anBlock()), "S3: без бакета создать нельзя — " + anBlock());
  anSet("bucket", "vms-archive", true);
  anSet("name", "S3 на сервере — срез 2", true);
  ok(!anBlock(), "S3: с бакетом можно создать — " + anBlock());
  createArchive();
  ok(await until(() => !an && arch.some((a) => a.name === "S3 на сервере — срез 2")), "S3: создано с сервера");
  const d2S3 = arch.find((a) => a.name === "S3 на сервере — срез 2");
  const d2S3Rec = await uiRec(d2S3.id);
  ok(d2S3Rec.kind === "cloud" && d2S3Rec.provider === "s3" && d2S3Rec.storage === "object" && d2S3Rec.serverId === d2Srv.id, "S3: сервер записал вид, провайдера и владельца — " + d2S3Rec.kind + ", " + d2S3Rec.provider);
  ok(document.querySelector("#tree .n.on") && !document.querySelector("#tree .n.on .tag-cloud") && serverArchives(d2Srv.id).includes(d2S3), "S3: строка хранилища в дереве без метки вида (вид — в подсказке), хранилище в списке сервера");
  ok(/^s3:\/\/vms-archive\//.test(archDiskLabel(d2S3)), "S3: в строке списка адрес бакета, а не код провайдера — " + archDiskLabel(d2S3));
  // Прототип 67: последний том не удаляют (как в Axxon One) — окно тома не открывается, адрес бакета видно в окне хранилища
  const d2S3Last = typeof volDelWhy === "function" && !!volDelWhy(archVols(d2S3)[0]);
  if (d2S3Last) {
    deleteVolume(archVols(d2S3)[0].id);
    ok(!document.getElementById("confirm").classList.contains("open"), "S3: последний том не удаляется — окно не открылось");
    deleteArchive(d2S3.id);
    ok(/объекты в папке бакета/.test(document.getElementById("confirmMsg").textContent), "S3: в удалении хранилища — объекты в папке бакета — " + document.getElementById("confirmMsg").textContent);
  } else {
    deleteVolume(archVols(d2S3)[0].id);
    ok(/s3:\/\/vms-archive\//.test(document.getElementById("confirmMsg").textContent), "S3: в удалении тома адрес бакета — " + document.getElementById("confirmMsg").textContent);
  }
  document.getElementById("confirmCancel").click();
  addArchive(d2Dom.id);
  ok(d2Cards().length === 6 && an.kind === "network", "S3: на домене те же шесть карточек, выбрано удалённое");
  anSet("storage", "block");
  anSet("kind", "cloud");
  ok(an.storage === "object", "S3: бакет всегда объектный");
  anSet("kind", "network");
  ok(an.storage === "block", "S3: выбор «Блочное» вернулся при уходе с облачного");
  ok(new Set(d2Cards().map((c) => c.offsetTop)).size === 2 && new Set(d2Cards().map((c) => c.offsetLeft)).size === 3, "S3: на домене сетка три на два, без одинокой карточки");
  anSet("kind", "cloud");
  anSet("provider", "minio");
  ok(/Укажите бакет/.test(anBlock()), "S3 с домена: без бакета создать нельзя — " + anBlock());
  anSet("bucket", "shared", true);
  ok(/Укажите хост MinIO/.test(anBlock()), "S3 с домена: MinIO просит хост — " + anBlock());
  anSet("host", "minio.local", true);
  anSet("name", "S3 на домене — срез 2", true);
  createArchive();
  ok(await until(() => !an && arch.some((a) => a.name === "S3 на домене — срез 2")), "S3: создано с домена");
  const d2S3Dom = await uiRec(arch.find((a) => a.name === "S3 на домене — срез 2").id);
  ok(d2S3Dom.kind === "cloud" && d2S3Dom.provider === "minio" && !d2S3Dom.serverId && d2S3Dom.domainId === d2Dom.id, "S3 с домена: владелец — домен, провайдер MinIO");
  } else ok(!arch.some((a) => a.kind === "cloud"), "S3: вид не объявлен — форма его не предлагает");
  pick(d2Srv.id);
  goTab("disk");

  // Хранилище не заводится — нигде не предлагается. Завести объект вида — возможность вида (UnitKind.capabilities create):
  // у всех видов хранилищ её сняли
  const archKindsSaved = new Map([...KINDS].filter(([k]) => screenType(k) === "archive"));
  archKindsSaved.forEach((k, kind) => KINDS.set(kind, Object.assign({}, k, { capabilities: (k.capabilities || []).filter((c) => c !== "create") })));
  ok(!canCreateKind("archive") && can("createUnits"), "возможность create у видов хранилищ снята");
  ok(!/Создать хранилище/.test(srvMenu(d2Srv)) && addSplitItems(d2Srv).every(([l]) => !/Хранилище/.test(l)), "без операции: в меню сервера нет");
  paint();
  ok(![...d2Main().querySelectorAll("button")].some((b) => /Создать хранилище…/.test(b.textContent)), "без операции: кнопки на вкладке дисков нет");
  pick(d2Empty.id);
  goTab("srvs");
  ok(!d2List() && d2DomBtns().length === 0, "без операции: на вкладке домена нет кнопки и пустого списка");
  ok(!d2Main().querySelector("[data-arch-where]"), "без операции: подсказки на домене нет");
  ok(!/хранилище/i.test(srvMenu(d2Empty)) && addSplitItems(d2Empty).every(([l]) => !/хранилище/i.test(l)), "без операции: в меню домена нет");
  goTab("gen");
  ok(!/хранилище/i.test(document.querySelector(".dom-acts").textContent), "без операции: в «Действиях» домена нет");
  archKindsSaved.forEach((k, kind) => KINDS.set(kind, k));
  goTab("gen");

  // Срез 3. Метка плана, поле с автокомплитом, порядок формы «По адресу», производители драйвер-пака, файл
  const s3Type = (el, text) => { el.focus(); el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const s3Key = (el, key) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const s3Cb = (ck) => [...document.querySelectorAll("input[data-ck]")].find((x) => x.dataset.ck.startsWith(ck));
  const s3Opts = () => [...document.querySelectorAll("#comboPop .combo-opt")].map((o) => o.textContent);
  const s3Pop = () => document.getElementById("comboPop")?.textContent || "";
  const s3Labels = () => [...document.querySelectorAll("#wbd .dev-grid > div > label")].map((l) => l.textContent.trim());
  const s3Leave = async (el) => { el.blur(); comboBlur(el); await until(() => !combo); };
  const s3Cam = (ip, x = {}) => { Object.assign(wizd.manual, { type: "camera", ip, port: "80", vendor: "Axis", model: "P3245-LV", user: "admin", pass: "pw", name: "Срез 3 " + ip, identifier: "", short: "", group: "", rtsp: "", ...x }); renderDeviceWizard(); };
  const s3Dom = d1;
  pick(s3Dom.id);
  goTab("gen");
  planClear();
  ok(hdPlan.hidden && getComputedStyle(hdPlan).display === "none", "счётчик: план пуст — кнопки на панели нет");
  planOpen("manual");

  // Порядок формы: сначала кто, потом куда; поля RTSP нет
  s3Cam("10.8.0.1");
  ok(s3Labels().slice(0, 5).join() === "Тип устройства,Производитель,Модель,IP-адрес,Порт", "форма: производитель и модель перед адресом — " + s3Labels().slice(0, 5));
  ok(!s3Labels().includes("RTSP"), "форма: отдельного поля RTSP нет");
  planAddManual();
  ok(!hdPlan.hidden && hdPlan.textContent === "В плане: 1" && /Применить план/.test(hdPlan.title) && getComputedStyle(hdPlan).backgroundColor !== "rgba(0, 0, 0, 0)", "счётчик: «В плане: 1», подсветка, подсказка объясняет — " + hdPlan.title);
  // Из другого раздела счётчик ведёт в «Оборудование» и открывает план
  closeWizard();
  goApp("log");
  ok(!hdPlan.hidden && hdPlan.getBoundingClientRect().width > 0, "счётчик виден и в другом разделе");
  hdPlan.click();
  ok(app === "hw" && planInDrawer() && document.querySelectorAll("#planPanel .plan-row").length === 1, "счётчик из другого раздела открывает план: " + app);
  wizStepGo(0);
  setDeviceTab("manual");

  // Производитель RTSP: поле адреса называется RTSP, порта и «Определить» нет
  s3Cam("");
  let s3V = s3Cb("changeManualVendor");
  s3Type(s3V, "rtsp");
  ok(combo && s3Opts()[0] === "RTSP", "автокомплит: совпадение с начала имени — первым: " + s3Opts().slice(0, 3));
  s3Key(s3V, "Enter");
  await until(() => !combo);
  ok(wizd.manual.vendor === "RTSP", "автокомплит: Enter выбирает — " + wizd.manual.vendor);
  ok(s3Labels().slice(0, 5).join() === "Тип устройства,Производитель,Модель,Каналы,RTSP" && !s3Labels().includes("Порт") && !s3Labels().includes("IP-адрес"), "RTSP: поле адреса переименовано, порта нет, есть «Каналы» — " + s3Labels().slice(0, 5));
  ok(!/Определить/.test(document.querySelector("#wbd .dev-grid").textContent), "RTSP: «Определить» не предлагается");
  ok(document.activeElement === s3Cb("changeManualVendor"), "автокомплит: после выбора фокус в том же поле");
  planAddManual();
  ok(addPlan.rows.length === 1, "RTSP: без адреса в план не идёт");
  const s3Url = "rtsp://10.8.0.2:554/main";
  document.getElementById("devManIp").value = s3Url;
  updateManual("rtsp", s3Url);
  wizd.manual.ip = "10.8.0.99";
  planAddManual();
  const s3Rt = addPlan.rows[addPlan.rows.length - 1];
  ok(addPlan.rows.length === 2 && s3Rt.r.rtspUrl === s3Url && !s3Rt.r.ip && !planRowIssues(s3Rt).some((i) => i.err), "RTSP: в строке только адрес потока, ошибок нет");
  s3Cam("10.8.0.3", { rtsp: "rtsp://старый" });
  s3V = s3Cb("changeManualVendor");
  s3Type(s3V, "axis");
  await s3Leave(s3V);
  ok(wizd.manual.vendor === "Axis" && s3Labels().includes("IP-адрес") && s3Labels().includes("Порт"), "ушли из поля: регистр поправлен по списку, поле снова IP-адрес");
  planAddManual();
  const s3Ax = addPlan.rows[addPlan.rows.length - 1];
  ok(s3Ax.r.ip === "10.8.0.3" && !s3Ax.r.rtspUrl && !s3Ax.r.rtsp, "обычная камера: прежний адрес RTSP в строку не попадает");

  // Папка: длинное имя в одну строку, поиск, выбор только из списка
  const s3F = flatFolders()[0], s3FName = s3F.name;
  s3F.name = "Очень длинное имя папки, которое не помещается в поле формы и раньше ломало строку ".repeat(3);
  s3Cam("10.8.0.4", { group: s3F.id });
  let s3G = s3Cb("updateManual|group");
  const s3Plain = s3Cb("updateManual|model");
  ok(s3G.offsetHeight === s3Plain.offsetHeight && s3G.scrollWidth > s3G.clientWidth && getComputedStyle(s3G).textOverflow === "ellipsis", "папка: длинное имя в одну строку с многоточием, высота " + s3G.offsetHeight);
  ok(s3G.title === folderPathName(s3F.id), "папка: полный путь в подсказке");
  comboClick(s3G);
  ok(combo && s3Opts().length === Math.min(COMBO_MAX, flatFolders().filter((f) => folderDomain(f.id) === wizd.domain).length + 1) && document.querySelector("#comboPop .combo-opt.cur") !== null, "папка: при открытии весь список папок домена ящика, текущая отмечена — " + s3Opts().length);
  const s3Rect = document.getElementById("comboPop").getBoundingClientRect();
  ok(s3Rect.left >= 0 && s3Rect.right <= innerWidth && s3Rect.bottom <= innerHeight, "список: в пределах окна");
  s3Type(s3G, "zzzq");
  ok(/Ничего не найдено/.test(s3Pop()), "папка: нет совпадений — так и написано");
  s3Key(s3G, "Escape");
  ok(!combo && s3G.value === folderPathName(s3F.id) && document.getElementById("wiz").classList.contains("open"), "Esc: закрыл список, вернул значение, ящик открыт");
  const s3Other = flatFolders().find((f) => f.id !== s3F.id);
  s3Type(s3G, s3Other.name);
  ok(s3Opts().some((t) => t.includes(s3Other.name)), "папка: поиск по части имени");
  s3Key(s3G, "ArrowDown");
  s3Key(s3G, "ArrowUp");
  s3Key(s3G, "Enter");
  await until(() => !combo);
  ok(wizd.manual.group && folderById(wizd.manual.group), "папка: стрелки и Enter выбирают — " + wizd.manual.group);
  const s3Was = wizd.manual.group;
  s3G = s3Cb("updateManual|group");
  s3Type(s3G, "такой папки нет");
  await s3Leave(s3G);
  ok(wizd.manual.group === s3Was && s3G.value === folderPathName(s3Was), "папка: своё значение не принимается, остаётся прежнее");
  s3F.name = s3FName;

  // Архив и модель; в форме нет обычных списков папок и архивов
  renderDeviceWizard();
  const s3A = s3Cb("updateManual|arch");
  comboClick(s3A);
  ok(s3Opts()[0] === "Не задано" && s3Opts().length === wizArchList().length + 1, "архив: весь список и «Не задано»");
  ok(wizArchList().length ? /·|Локальное|Удалённое/.test(s3Opts()[1]) : true, "архив: рядом вид и владелец — " + s3Opts()[1]);
  comboClose();
  ok(![...document.querySelectorAll("#wbd .dev-manual select option")].some((o) => flatFolders().some((f) => f.id === o.value) || arch.some((a) => a.id === o.value)), "форма: обычных списков папок и архивов нет");
  DEVICE_MODELS["Длинный список"] = Array.from({ length: 300 }, (_, i) => "M-" + i);
  s3Cam("10.8.0.5", { vendor: "Длинный список", model: "M-1" });
  const s3M = s3Cb("updateManual|model");
  comboClick(s3M);
  ok(s3Opts().length === COMBO_MAX && /из 300/.test(s3Pop()), "модель: длинный список ограничен, сказано уточнить");
  s3Type(s3M, "m-29");
  ok(s3Opts().length === 11 && !/из 300/.test(s3Pop()), "модель: поиск сужает — " + s3Opts().length);
  s3Type(s3M, "Своя модель");
  ok(/останется то, что введено|сохранит введённое значение/.test(s3Pop()), "модель: своё значение можно оставить");
  await s3Leave(s3M);
  ok(wizd.manual.model === "Своя модель", "модель: своё значение сохранилось");
  delete DEVICE_MODELS["Длинный список"];
  // Перерисовка окна при открытом списке (события поиска): ввод не теряется
  s3Cam("10.8.0.6");
  s3Type(s3Cb("changeManualVendor"), "Hik");
  renderDeviceWizard();
  await until(() => combo && combo.inp.isConnected);
  ok(combo.inp.value === "Hik" && s3Opts().some((t) => t === "Hikvision"), "перерисовка: список и ввод на месте");
  s3Key(combo.inp, "Escape");

  // Найденные в сети и массовая правка — те же поля
  setDeviceTab("search");
  if (wizd.devState === "idle") refreshDeviceSearch();
  await until(() => wizd.devState === "done");
  setDeviceViewMode("extended");
  const s3R = selectableDeviceResults().find((r) => r.status !== "bad");
  ok(!!s3R, "есть что найдено");
  ["updateFoundDevice|" + s3R.id + "|group", "updateFoundDevice|" + s3R.id + "|arch", "changeFoundVendor|" + s3R.id, "updateFoundDevice|" + s3R.id + "|model"].forEach((k) => ok(!!s3Cb(k), "найденное: поле с автокомплитом " + k));
  const s3Fg = s3Cb("updateFoundDevice|" + s3R.id + "|group");
  s3Type(s3Fg, s3Other.name);
  s3Key(s3Fg, "Enter");
  await until(() => !combo);
  ok(s3R.group === s3Other.id || !!folderById(s3R.group), "найденное: папка выбрана");
  wizd.devSelected.add(s3R.id);
  toggleBulkEdit(true);
  ["updateBulkEditField|vendor", "updateBulkEditField|group", "updateBulkEditField|arch"].forEach((k) => ok(!!s3Cb(k), "массовая правка: поле с автокомплитом " + k));
  comboClick(s3Cb("updateBulkEditField|group"));
  ok(s3Opts()[0] === "— не менять —", "массовая правка: «не менять» на месте");
  comboClose();
  toggleBulkEdit(false);
  wizd.devSelected.clear();

  // Файл: регистр поправлен, производитель вне списка в план идёт и там же правится
  ok(Object.keys(DEVICE_MODELS).length > 300 && DEVICE_MODELS.RTSP && !Object.keys(DEVICE_MODELS).some((v) => /joystick|^Vendor Name$/i.test(v)), "драйвер-пак: весь список, без джойстиков — " + Object.keys(DEVICE_MODELS).length);
  planClear();
  setDeviceTab("csv");
  wizd.csvRows = parseCsvDeviceRows(["10.8.1.1,80,hikvision,DS-2CD2143G2,admin,pw", `10.8.1.2,80,BOSCH,${DEVICE_MODELS.Bosch[0]},admin,pw`, "10.8.1.3,80,Нет такого,M1,admin,pw", "10.8.1.4,80,Axis,Нет такой,admin,pw"].join(String.fromCharCode(10)));
  ok(csvImportableRows(wizd.csvRows).length === 4, "файл: все строки можно отправить в план");
  ok(wizd.csvRows[0].vendor === "Hikvision" && !wizd.csvRows[0].warns.length, "файл: регистр производителя поправлен");
  ok(wizd.csvRows[2].warns.length === 1 && wizd.csvRows[3].warns.length === 1 && !wizd.csvRows[1].warns.length, "файл: предупреждения только у неизвестных");
  renderDeviceWizard();
  ok(/исправ(ьте|ить) в плане/.test(document.querySelector(".csv-preview").textContent), "файл: в таблице сказано, где исправить");
  toggleCsvAll(true);
  planAddCsv();
  ok(addPlan.rows.length === 4, "файл: строки в плане — " + addPlan.rows.length);
  const s3Row = (ip) => addPlan.rows.find((x) => x.r.ip === ip);
  ok(!planRowIssues(s3Row("10.8.1.1")).some((i) => i.err) && !planRowIssues(s3Row("10.8.1.2")).some((i) => i.err), "файл: известные производители без ошибок");
  ok(planRowIssues(s3Row("10.8.1.3")).some((i) => i.err && /нет в списке драйверов/.test(i.text)), "файл: неизвестный производитель — ошибка строки, применить нельзя");
  ok(planRowIssues(s3Row("10.8.1.4")).some((i) => !i.err && /нет в справочнике/.test(i.text)), "файл: неизвестная модель — предупреждение");
  wizStepGo(1);
  planToggle(s3Row("10.8.1.3").pid);
  const s3Pl = () => document.querySelector(`.plan-row[data-pid="${s3Row("10.8.1.3").pid}"]`);
  ["vendor", "model", "arch", "group"].forEach((k) => ok(s3Pl().querySelector(`input[data-combo][data-pf="${k}"]`), "план: поле с автокомплитом " + k));
  const s3Pv = s3Pl().querySelector('input[data-pf="vendor"]');
  s3Type(s3Pv, "bosch");
  s3Key(s3Pv, "Enter");
  await until(() => !combo);
  ok(!planRowIssues(s3Row("10.8.1.3")).some((i) => i.err), "файл: производитель поправлен в плане, ошибки нет — " + s3Row("10.8.1.3").r.vendor);
  ok(manualModels(s3Row("10.8.1.3").r.vendor).length || s3Row("10.8.1.3").r.model === "M1", "план: модель, которую нечем заменить, остаётся");
  planEdit(s3Row("10.8.1.3").pid, "vendor", "RTSP");
  const s3Pid = addPlan.rows.find((x) => x.r.vendor === "RTSP").pid;
  const s3Rp = document.querySelector(`.plan-row[data-pid="${s3Pid}"]`);
  ok([...s3Rp.querySelectorAll(".dev-field label")].some((l) => l.textContent === "RTSP") && ![...s3Rp.querySelectorAll(".dev-field label")].some((l) => l.textContent === "IP-адрес"), "план: производитель RTSP — поле RTSP вместо IP");
  planEdit(s3Pid, "vendor", "ABUS");
  planEdit(s3Pid, "ip", "10.8.1.3");
  planSend(addPlan.rows.slice(), false);
  await until(() => !addPlan.applying && !addPlan.rows.length);
  ok(!addPlan.rows.length, "файл: план применён целиком");
  const s3Got = addPlan.added.find((x) => x.ip === "10.8.1.2"), s3Made = s3Got && (await uiRec(s3Got.id));
  ok(s3Made && s3Made.vendor === "Bosch", "на сервере производитель из файла, регистр поправлен — " + (s3Made && s3Made.vendor));

  // Находки ревью: положение списка, тот же выбор, Enter, адрес, которого не видно, найденное со своим текстом
  wizStepGo(0);
  setDeviceTab("manual");
  const s3Clear = (el) => { const p = document.getElementById("comboPop").getBoundingClientRect(), r = el.getBoundingClientRect(); return p.top >= 0 && p.bottom <= innerHeight && (p.top >= r.bottom || p.bottom <= r.top); };
  s3Cam("10.8.2.1", { vendor: "Hikvision", model: "Своя" });
  ["updateManual|group", "updateManual|arch", "changeManualVendor", "updateManual|model"].forEach((k) => {
    const el = s3Cb(k);
    el.scrollIntoView({ block: "end" });
    comboClick(el);
    ok(s3Clear(el), "список не закрывает поле и не выходит за окно: " + k);
    comboClose();
  });
  s3V = s3Cb("changeManualVendor");
  comboClick(s3V);
  ok(s3Opts()[0] === "Hikvision" && document.querySelector("#comboPop .combo-opt.cur.on") !== null, "текущий за первой сотней виден и выделен: " + s3Opts()[0]);
  s3Key(s3V, "Enter");
  await until(() => !combo);
  ok(wizd.manual.vendor === "Hikvision" && wizd.manual.model === "Своя", "тот же производитель: модель не сброшена — " + wizd.manual.model);
  let s3Mm = s3Cb("updateManual|model");
  s3Type(s3Mm, "DS-");
  s3Key(s3Mm, "Enter");
  await until(() => !combo);
  ok(wizd.manual.model === "DS-", "модель: Enter оставляет введённое — " + wizd.manual.model);
  s3Mm = s3Cb("updateManual|model");
  comboClick(s3Mm);
  s3Key(s3Mm, "ArrowUp");
  ok(combo.idx === s3Opts().length - 1, "стрелка вверх с пустого выбора — на последний");
  comboClose();
  s3V = s3Cb("changeManualVendor");
  s3Type(s3V, "axi");
  s3Key(s3V, "Enter");
  await until(() => !combo);
  ok(wizd.manual.vendor === "Axis", "производитель: Enter берёт первое совпадение — " + wizd.manual.vendor);
  const s3Ar = s3Cb("updateManual|arch");
  s3Type(s3Ar, "zzzq");
  ok(/Ничего не найдено/.test(s3Pop()) && !/Архивы не созданы/.test(s3Pop()), "архив: поиск без совпадений не говорит, что архивов нет");
  s3Key(s3Ar, "Escape");

  planClear();
  setDeviceTab("csv");
  const s3Hd = "IP-адрес,Порт,Производитель,Модель,Логин,Пароль,Адрес RTSP" + String.fromCharCode(10);
  wizd.csvRows = parseCsvDeviceRows(s3Hd + ["10.8.3.1,554,RTSP,Generic,admin,pw,", "10.8.3.2,80,Axis,P3245-LV,admin,pw,rtsp://10.8.3.2/1", "10.8.3.3,80,constructor,M1,admin,pw,"].join(String.fromCharCode(10)));
  ok(/нет адреса RTSP/.test(wizd.csvRows[0].warns.join()), "файл: RTSP без адреса — в таблице сказано");
  toggleCsvAll(true);
  planAddCsv();
  const [s3A1, s3A2, s3A3] = addPlan.rows;
  ok(!s3A1.r.ip && +s3A1.r.port === 80 && planRowIssues(s3A1).some((i) => i.err && i.text === "Укажите адрес RTSP"), "файл: RTSP без адреса — ошибка про RTSP, IP из файла не уйдёт");
  ok(planRowIssues(s3A3).some((i) => i.err && /нет в списке драйверов/.test(i.text)), "файл: производитель constructor — обычная ошибка, план не падает");
  wizStepGo(1);
  [s3A1, s3A2].forEach((x) => { x.open = false; planToggle(x.pid); });
  const s3Fl = (x) => [...document.querySelectorAll(`.plan-row[data-pid="${x.pid}"] .dev-field label`)].map((l) => l.textContent);
  ok(s3Fl(s3A1).includes("RTSP") && !s3Fl(s3A1).includes("IP-адрес") && !s3Fl(s3A1).includes("Порт"), "план: у RTSP только поле потока");
  ok(s3Fl(s3A2).includes("RTSP") && s3Fl(s3A2).includes("IP-адрес"), "план: в файле и IP, и поток — видны оба, раз уходят оба");
  planEdit(s3A2.pid, "vendor", "RTSP");
  ok(!s3A2.r.ip && +s3A2.r.port === 80 && s3A2.r.rtspUrl, "план: стал RTSP — IP и порт не уйдут, поток остался");
  planClear();
  // Источник событий — не камера: производитель RTSP его адрес не трогает
  wizStepGo(0);
  setDeviceTab("manual");
  s3Cam("10.8.3.4", { type: "eventsrc" });
  planAddManual();
  const s3Ev = addPlan.rows[addPlan.rows.length - 1];
  planEdit(s3Ev.pid, "vendor", "RTSP");
  ok(s3Ev.r.ip === "10.8.3.4", "источник событий: адрес на месте");
  planClear();
  // Найденное со своим текстом в поле: ошибка видна и правится в строке плана
  setDeviceTab("search");
  const s3Fr = selectableDeviceResults().find((r) => r.status !== "bad" && !r.added && !r.planned);
  const [s3Fv, s3Fm] = [s3Fr.vendor, s3Fr.model];
  s3Fr.vendor = "Опечатка";
  planAddOne(s3Fr.id);
  const s3Fp = addPlan.rows[addPlan.rows.length - 1];
  ok(planRowIssues(s3Fp).some((i) => i.err && /нет в списке драйверов/.test(i.text)), "найденное: производитель не из списка — ошибка");
  s3Fp.open = false;
  wizStepGo(1);
  planToggle(s3Fp.pid);
  const s3Fe = document.querySelector(`.plan-row[data-pid="${s3Fp.pid}"]`);
  ok(s3Fe.querySelector('input[data-pf="vendor"]') && s3Fe.querySelector('input[data-pf="model"]') && !s3Fe.querySelector('input[data-pf="ip"]'), "найденное: производитель и модель правятся в строке, адрес — нет");
  planEdit(s3Fp.pid, "vendor", "RTSP");
  ok(s3Fp.r.ip, "найденное: адрес остаётся при любом производителе");
  planEdit(s3Fp.pid, "vendor", s3Fv);
  planEdit(s3Fp.pid, "model", "");
  ok(planRowIssues(s3Fp).some((i) => i.err && /производителя и модель/.test(i.text)), "найденное: пустая модель — ошибка");
  planEdit(s3Fp.pid, "model", s3Fm);
  ok(!planRowIssues(s3Fp).some((i) => i.err), "найденное: поправили — ошибки нет");
  s3Fr.vendor = s3Fv;
  planClear();

  // Срез 4. «В план» на своей вкладке; строки файла отмечают и ищут, как найденные в сети
  const s4Df = () => document.querySelector("#wiz .df");
  wizStepGo(0);
  setDeviceTab("manual");
  const s4Btn = document.getElementById("manualToPlan");
  ok(s4Btn && s4Btn.closest(".plan-left") && !s4Btn.closest(".plan-right") && !s4Df().contains(s4Btn) && !!s4Df().querySelector("#wn"), "по адресу: кнопка «В план» в левой колонке, в общем подвале только переход «Далее»");
  const s4BR = s4Btn.getBoundingClientRect(), s4PR = document.querySelector(".plan-left").getBoundingClientRect();
  ok(s4BR.bottom <= innerHeight && s4BR.right <= s4PR.right + 1 && s4BR.top >= s4PR.top, "по адресу: кнопка видна и не выходит за колонку");
  ok(document.querySelector(".plan-left-ft #devModeWrap"), "по адресу: профиль рядом с кнопкой");
  setDeviceTab("search");
  ok([...s4Df().querySelectorAll("button")].every((b) => !/^В план/.test(b.textContent.trim())), "в сети: в подвале кнопки «В план» тоже нет");
  planClear();
  wizd.csvRows = [];
  setDeviceTab("csv");
  ok(!document.getElementById("csvToPlan") && /Перетащите/.test(document.querySelector(".csv-drop").textContent), "файл не загружен: зона загрузки, кнопки нет");
  wizd.csvName = "cams.csv";
  wizd.csvRows = parseCsvDeviceRows(["IP-адрес,Порт,Производитель,Модель,Логин,Пароль,ID,Название", "10.8.4.1,80,Axis,P3245-LV,admin,pw,4101,Вход север", "10.8.4.2,80,Axis,P3245-LV,admin,pw,4102,Вход юг", "10.8.4.3,80,Hikvision,DS-2CD2143G2,admin,pw,4103,Склад", "10.8.4.4,80,Нет такого,M1,admin,pw,4104,Двор", "10.8.4.5,80,Axis,P3245-LV,admin,pw,неверный ид,Плохая", ",,,,,,,Отчёт"].join(String.fromCharCode(10)));
  wizd.csvSel = new Set();
  renderDeviceWizard();
  const s4Boxes = () => [...document.querySelectorAll(".csv-preview tbody input[type=checkbox]")];
  const s4To = () => document.getElementById("csvToPlan");
  const s4All = () => document.getElementById("csvSelectAll");
  const s4Find = (v) => { const el = document.getElementById("csvFilter"); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const s4Tick = (i, on = true) => { const el = s4Boxes()[i]; el.checked = on; el.dispatchEvent(new Event("change", { bubbles: true })); };
  ok(s4To().closest(".plan-left") && s4To().disabled && /В план \(0\)/.test(s4To().textContent), "файл: кнопка над таблицей, пока ничего не отмечено — неактивна");
  ok(s4To().getBoundingClientRect().bottom < document.querySelector(".csv-preview").getBoundingClientRect().top + 1, "файл: строка управления выше таблицы");
  ok(document.querySelector(".csv-drop.csv-file") && !/Обязательны/.test(document.querySelector(".plan-left").textContent), "файл: зона загрузки сжалась в строку");
  ok(s4Boxes().length === 6 && s4Boxes().filter((b) => b.disabled).length === 2, "файл: строки с ошибкой и пропуском отметить нельзя");
  s4Tick(0);
  ok(/В план \(1\)/.test(s4To().textContent) && !s4To().disabled && s4All().indeterminate, "файл: отмечена одна — счётчик 1, «все» в промежуточном состоянии");
  s4Find("склад");
  ok(s4Boxes().length === 1 && document.getElementById("csvFilter") === document.activeElement, "поиск: по названию, фокус остаётся в поле");
  ok(/В план \(1\)/.test(s4To().textContent), "поиск: отметка скрытой строки сохранилась и посчитана");
  s4Find("hikv");
  ok(s4Boxes().length === 1, "поиск: по производителю");
  s4Find("10.8.4.2");
  ok(s4Boxes().length === 1, "поиск: по IP");
  s4Find("4101");
  ok(s4Boxes().length === 1, "поиск: по ID");
  s4Find("нет такой строки");
  ok(/Ничего не найдено/.test(document.querySelector(".plan-left").textContent) && s4All().disabled, "поиск: нет совпадений — сказано, «все» неактивна");
  s4Find("вход");
  s4All().checked = true;
  s4All().dispatchEvent(new Event("change", { bubbles: true }));
  ok(/В план \(2\)/.test(s4To().textContent) && s4All().checked, "«все» отмечает только найденное: " + s4To().textContent);
  s4Find("");
  ok(s4Boxes().length === 6 && /В план \(2\)/.test(s4To().textContent) && s4All().indeterminate, "сброс поиска: выбор на месте");
  document.getElementById("csvFocusBtn").click();
  ok(s4Boxes().length === 2, "кнопка «только выбранные»");
  document.getElementById("csvFocusBtn").click();
  document.getElementById("csvFiltBtn").click();
  ok(document.getElementById("csvFiltPop").classList.contains("open"), "фильтр: открыт");
  setCsvStatus("bad", false);
  ok(s4Boxes().length === 4 && document.getElementById("csvFiltBtn").classList.contains("hot"), "фильтр: ошибки и пропуски скрыты");
  setCsvStatus("ok", false);
  ok(s4Boxes().length === 1, "фильтр: только что поправить в плане");
  setCsvStatus("ok", true);
  setCsvStatus("bad", true);
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  ok(!document.getElementById("csvFiltPop").classList.contains("open"), "фильтр: клик мимо закрывает");
  s4To().click();
  ok(addPlan.rows.length === 2 && addPlan.rows.every((x) => /^10\.8\.4\.[12]$/.test(x.r.ip)), "в план ушли только отмеченные — " + addPlan.rows.map((x) => x.r.ip));
  ok(s4Boxes().filter((b) => !b.disabled).length === 2 && s4To().disabled, "после добавления: строки в плане отметить нельзя, счётчик сброшен");
  planRemove(addPlan.rows[0].pid);
  ok(s4Boxes().filter((b) => !b.disabled).length === 3 && !s4Boxes().some((b) => b.checked), "убрали из плана: строку снова можно отметить, сама не отмечается");
  s4All().checked = true;
  s4All().dispatchEvent(new Event("change", { bubbles: true }));
  ok(/В план \(3\)/.test(s4To().textContent), "«все» без поиска — все, что можно добавить");
  s4All().checked = false;
  s4All().dispatchEvent(new Event("change", { bubbles: true }));
  ok(s4To().disabled, "снятие «все» снимает отметки");
  // Находки ревью: Esc в фильтре, адрес уже в плане, повтор в файле, «Вернуть», прокрутка
  document.getElementById("csvFiltBtn").click();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(!wizd.csvFiltPop && document.getElementById("wiz").classList.contains("open") && wizd.csvRows.length, "Esc закрывает фильтр, а не окно с файлом");
  s4All().checked = true;
  s4All().dispatchEvent(new Event("change", { bubbles: true }));
  s4To().click();
  const s4Plan = addPlan.rows.length;
  wizd.csvRows = parseCsvDeviceRows(["IP-адрес,Порт,Производитель,Модель,Логин,Пароль,ID,Название", "10.8.4.1,80,Axis,P3245-LV,admin,pw,,Снова север", "10.8.4.6,80,Axis,P3245-LV,admin,pw,,Новая", "10.8.4.6,80,Axis,P3245-LV,admin,pw,,Повтор"].join(String.fromCharCode(10)));
  wizd.csvSel = new Set();
  renderDeviceWizard();
  ok(s4Boxes()[0].disabled && !s4Boxes()[1].disabled && s4Boxes()[2].disabled, "второй файл: адрес из плана и повтор в файле отметить нельзя");
  ok(/В плане/.test(document.querySelectorAll(".csv-preview tbody tr")[0].textContent) && /адрес повторяется/.test(document.querySelectorAll(".csv-preview tbody tr")[2].textContent), "второй файл: причина видна в строке");
  s4All().checked = true;
  s4All().dispatchEvent(new Event("change", { bubbles: true }));
  ok(/В план \(1\)/.test(s4To().textContent), "счётчик равен тому, что добавится");
  s4To().click();
  ok(addPlan.rows.length === s4Plan + 1, "добавилось столько, сколько обещано");
  const s4Id = wizd.csvRows[1].id;
  planClear();
  s4Tick(1);
  document.getElementById("csvFocusBtn").click();
  ok(wizd.csvSelOnly && s4Boxes().length === 1, "только выбранные включены");
  [...document.querySelectorAll("button")].find((b) => /Вернуть/.test(b.textContent)).click();
  ok(wizd.csvRows[1].planned && !wizd.csvSel.has(s4Id) && s4Boxes().length === 3, "«Вернуть»: строка снова в плане, список не застрял на «только выбранных»");
  planClear();
  wizd.csvRows = parseCsvDeviceRows(["IP-адрес,Порт,Производитель,Модель,Логин,Пароль,ID,Название", ...Array.from({ length: 60 }, (_, i) => `10.8.6.${i + 1},80,Axis,P3245-LV,admin,pw,,К${i}`)].join(String.fromCharCode(10)));
  renderDeviceWizard();
  document.querySelector(".csv-preview").scrollTop = 400;
  setDeviceTab("search");
  setDeviceTab("csv");
  ok(document.querySelector(".csv-preview").scrollTop === 0, "смена вкладки: список с начала");
  document.querySelector(".csv-preview").scrollTop = 400;
  await handleCsvFiles([new File(["IP-адрес,Порт,Производитель,Модель" + String.fromCharCode(10) + Array.from({ length: 60 }, (_, i) => `10.8.7.${i + 1},80,Axis,P3245-LV`).join(String.fromCharCode(10))], "b.csv")]);
  ok(document.querySelector(".csv-preview").scrollTop === 0 && wizd.csvName === "b.csv", "другой файл: список с начала");
  planClear();
  closeWizard();
  goTab("gen");

  // Счётчик: за другим окном клик ничего не подменяет
  planOpen("manual");
  s3Cam("10.8.9.1");
  planAddManual();
  closeWizard();
  openW("server");
  const otherWiz = wizd;
  hdPlan.click();
  ok(wizd === otherWiz && wizd.mode !== "device-add", "счётчик за другим окном мастер не подменяет");
  closeWizard();

  // Счётчик: черновик правила спрашивает первым, после ответа план всё равно открывается
  goApp("rules");
  await until(() => rules.length > 0);
  ruleOpen(rules[0].id);
  ruleEdit((x) => { x.name += " черновик"; });
  hdPlan.click();
  ok(app === "rules" && document.getElementById("confirm").classList.contains("open") && !planInDrawer(), "счётчик: с черновиком правила сначала вопрос");
  await confirmWith();
  ok(app === "hw" && planInDrawer() && document.querySelectorAll("#planPanel .plan-row").length === 1, "счётчик: после ответа план открыт — " + app);
  closeWizard();

  // Карточка найденного устройства: перерисовка под планом не сбрасывает его форму, после закрытия «В план» на карточке работает
  planClear();
  pick(d1.id);
  planOpen("manual");
  s3Cam("10.8.9.2");
  planAddManual();
  closeWizard();
  const fdRow = foundAll(d1.id).find((x) => !x.planned && !x.added && x.status !== "bad");
  ok(fdRow, "есть найденное устройство для карточки");
  pick("fdev:" + d1.id + ":" + fdRow.id);
  hdPlan.click();
  setDeviceTab("manual");
  wizd.manual.ip = "10.9.9.77";
  paint();
  ok(planInDrawer() && wizd.deviceTab === "manual" && wizd.manual.ip === "10.9.9.77", "карточка найденного: перерисовка не сбрасывает форму плана");
  closeWizard();
  const fdBtn = [...document.querySelectorAll("#main button")].find((b) => /^В план$/.test(b.textContent.trim()));
  const fdN = addPlan.rows.length;
  fdBtn.click();
  ok(await until(() => addPlan.rows.length === fdN + 1), "карточка найденного: после закрытия плана «В план» работает — " + addPlan.rows.length);

  // Смешанное «Писать сюда»: новое уходит в план, счётчик видит его сразу, без перерисовки плана
  planClear();
  const lanSrv = d1.servers.find((x) => x.online !== false && serverArchives(x.id).length);
  pick(lanSrv.id);
  lanEnsure(find(lanSrv.id).n);
  await until(() => lan.state === "done" && lan.net.length > 0);
  const lanN = find(lanSrv.id).n;
  const lanNet = lanRows(lanN).find((r) => r.kind === "net" && lanAction(lanN, r).pri);
  const lanSys = lanRows(lanN).find((r) => r.kind === "sys" && lanAction(lanN, r).pri);
  lanBindKeys([lanSys.key, lanNet.key]);
  ok(addPlan.rows.length === 1 && !hdPlan.hidden && hdPlan.textContent === "В плане: 1", "смешанное «Писать сюда»: счётчик сразу — " + hdPlan.textContent);
  planClear();

  // Ctrl+A в «Оборудовании» — выбор в дереве, а не строки поиска
  goTab("gen");
  const treeN = treeSel.size;
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
  ok(treeSel.size > treeN, "Ctrl+A отмечает дерево: " + treeSel.size);
  clearTreeSel();
});
