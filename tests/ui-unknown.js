/* Сценарии интерфейса: объект незнакомого вида (test.unknown, security_controller/*) — без кода под вид. Дерево, карточка
   и мастер по схеме вида из /kinds, план правки, ошибка по указателю, команды, удаление с вводом числа, kinds.changed при
   черновике, страница плагина, поиск по полям x-search и чип вида. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  const main = () => document.getElementById("main");
  const sf = (name) => main().querySelector(`[data-sf="${name}"]`);
  const type = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  const kinds = (await API.get("/kinds")).items;
  const kindOf = (k) => kinds.find((x) => x.kind === k);
  // Отбор по виду идёт ограниченным проходом: страница бывает неполной, читаем до конца
  const unitsOf = async (k) => {
    const out = [];
    let cursor = null;
    do { const r = await API.get("/units", { kind: k, limit: 100, cursor }); out.push(...r.items); cursor = r.nextCursor || null; } while (cursor);
    return out;
  };
  const TU = kindOf("test.unknown");
  const tu = (await unitsOf("test.unknown")).find((u) => !u.parentId);
  const ctrls = await unitsOf("security_controller/CONTROLLER");
  const ctrl = ctrls.find((u) => (u.folders || []).length) || ctrls[0];
  const ctrl2 = ctrls.find((u) => u.uid !== ctrl.uid);
  const open = async (uid, t) => {
    pick(uid, { force: true, tab: "gen" });
    if (t) goTab(t);
    return until(() => sel === uid && !find(uid)?.n._row && !!main().querySelector("[data-schema-card]"));
  };

  // Дерево: узел незнакомого вида — с подписью вида из /kinds, тип узла — код вида
  ok(KINDS.get("test.unknown")?.label?.text === TU.label.text && screenType("test.unknown") === "test.unknown", "каталог видов — из /kinds, тип узла незнакомого вида — его код");
  ok(screenType("camera") === "camera" && screenType("archive.local") === "archive" && screenType("volume") === "vol", "известные виды — на свои ручные экраны по профилю");
  await open(tu.uid);
  ok(await until(() => !!document.querySelector(`#tree .n[data-pick="${tu.uid}"]`)) && LB["test.unknown"] === TU.label.text && main().textContent.includes(TU.label.text),
    "объект test.unknown виден в дереве с подписью из /kinds");

  // Карточка по схеме: вкладки — x-ui-tab, группы — x-ui-group, порядок — x-ui-order, enum — x-enum-labels
  const tabs = [...document.querySelectorAll(".hd .tabs .tab")].map((b) => b.textContent.trim());
  const groups = [...main().querySelectorAll("[data-schema-card] .ch")].map((x) => x.textContent.trim());
  const mode = sf("mode");
  const opts = mode ? [...mode.options].map((o) => o.textContent.trim()) : [];
  const order = [...main().querySelectorAll("[data-sf],[data-sf-ro]")].map((el) => el.dataset.sf || el.dataset.sfRo);
  ok(tabs.includes("Основное") && tabs.includes("Дополнительно") && groups.includes("Опознание") && groups.includes("Подключение") &&
    mode?.tagName === "SELECT" && ["Сам", "Вручную", "Выключен"].every((x) => opts.includes(x)) && mode.value === "manual" &&
    order.indexOf("title") < order.indexOf("serial") && order.indexOf("serial") < order.indexOf("port") &&
    main().querySelector('[data-sf="tags"] input[value="a"]')?.checked === true && /Альфа/.test(main().querySelector('[data-sf="tags"]')?.textContent || "") &&
    !!main().querySelector('[data-sf-ro="serial"]') &&
    sf("secret")?.type === "password" && sf("secret")?.value === "",
    `карточка: вкладки и группы по x-ui-*, enum с подписями — вкладки ${tabs.join("/")}, группы ${groups.join("/")}`);
  ok(/%/.test(main().textContent) && sf("active")?.getAttribute("role") === "switch", "единица x-ui-unit и переключатель x-ui-widget switch");

  // Мультивыбор с ошибкой: класс одной строкой — подсветка .sf-multi.sf-bad работает
  const bx = document.createElement("div");
  bx.innerHTML = sfFieldHtml("card", tu.uid, "tags", TU.schema.properties.tags, ["a"], { err: "Неверно" });
  ok(bx.querySelector(".sf-multi")?.classList.contains("sf-bad") && bx.querySelector(".sf-multi").title === "Неверно", "мультивыбор с ошибкой — подсвечен (sf-bad на .sf-multi)");

  // Команда с confirm.typeCount (не удаление): поле числа есть, но подпись — не «удаляемых объектов»
  actd = { uid: tu.uid, desc: { id: "wipe", label: { text: "Сброс" }, confirm: { text: { text: "Настройки пропадут" }, typeCount: true } } };
  unitActConfirm();
  const cntLabel = document.querySelector("#confirmCount label")?.textContent || "";
  ok(!!document.getElementById("confirmCountInp") && document.getElementById("confirmOk").disabled && !/удаляемых/.test(cntLabel) && /объектов команды/.test(cntLabel),
    "подтверждение команды числом — без слов про удаление: " + cntLabel);
  document.getElementById("confirmCancel").click();
  actd = null;

  // Правка поля → «Показать план» → «Применить»: шаг операции {uid, patch}, версия новая
  const v0 = hwVer.get(tu.uid);
  type(sf("title"), "Пульт охраны — смена");
  ok(cardDiff().length === 1 && cardDiff()[0].label === "Заголовок" && /Показать план \(1\)/.test(document.getElementById("cardFoot")?.textContent || ""), "правка поля — строка черновика с подписью из схемы");
  cardPlan();
  ok(await until(() => document.getElementById("bmodal")?.classList.contains("open") && /Пульт охраны — смена/.test(document.getElementById("bmBody").textContent)), "план: было → станет");
  [...document.querySelectorAll("#bmFoot button")].find((b) => /Применить/.test(b.textContent)).click();
  let srvTu = null;
  ok(await until(() => { API.get(`/units/${tu.uid}`).then((u) => (srvTu = u)); return srvTu?.properties.title === "Пульт охраны — смена" && hwVer.get(tu.uid) === srvTu.version; }) && srvTu.version !== v0,
    "правка поля → Показать план → Применить → PATCH прошёл, версия новая");
  ok(await until(() => !bq || bq.finished) && find(tu.uid).n.props.title === "Пульт охраны — смена", "кэш взял ответ сервера");

  // Ошибка сервера (проверка по схеме вида) — поле подсвечено по указателю /properties/port
  await open(tu.uid);
  type(sf("port"), "70000");
  cardPlan();
  ok(await until(() => sf("port")?.classList.contains("sf-bad")) && !document.getElementById("bmodal").classList.contains("open") && /65535/.test(sf("port").title),
    "ошибка сервера подсвечивает поле по указателю");
  cardReset();

  // Поле неизвестного типа (x-ui-widget hologram, x-future) — текст только для чтения, карточка не падает
  await open(tu.uid, schemaTabs(find(tu.uid).n).find(([, l]) => l === "Дополнительно")[0]);
  const holo = main().querySelector('[data-sf-ro="hologram"]');
  ok(!!holo && holo.disabled && /layers/.test(holo.value) && !sf("hologram") && !!sf("camera") && !!sf("debug"), "поле неизвестного типа — только чтение");

  // Мастер под контроллером: только датчик (createParents / creatable), создаётся POST /units
  await open(ctrl.uid);
  ok(!!main().querySelector("[data-schema-add]"), "у контроллера — кнопка добавления");
  await schemaAddOpen(ctrl.uid);
  const kindSel = document.getElementById("swKind");
  ok(await until(() => document.getElementById("bmodal").classList.contains("open")) && [...(kindSel?.options || [])].map((o) => o.value).join() === "security_controller/SENSOR",
    "мастер под контроллером предлагает только датчик");
  type(document.querySelector("[data-sw-name]"), "Датчик подвала");
  type(document.querySelector('[data-sw="zone"]'), "Подвал");
  const before = new Set((await API.get("/units", { parentId: ctrl.uid, limit: 100 })).items.map((u) => u.uid));
  document.getElementById("swCreate").click();
  let made = null;
  ok(await until(() => { API.get("/units", { parentId: ctrl.uid, limit: 100 }).then((r) => (made = r.items.find((u) => !before.has(u.uid)))); return made && find(made.uid); }) &&
    made.kind === "security_controller/SENSOR" && made.properties.zone === "Подвал" && made.name === "Датчик подвала",
    "мастер под контроллером предлагает только датчик, создаёт его");

  // Команда без параметров: ARM — instant, состояние из ответа
  await open(ctrl.uid);
  const armed0 = !!(await API.get(`/units/${ctrl.uid}`)).status?.observed?.armed;
  main().querySelector(`[data-act="${armed0 ? "DISARM" : "ARM"}"]`).click();
  ok(await until(() => !!find(ctrl.uid)?.n._st?.observed?.armed === !armed0) && !!(await API.get(`/units/${ctrl.uid}`)).status?.observed?.armed === !armed0,
    "команда ARM меняет состояние");
  // Команда с параметрами — форма по ActionDescriptor.params
  await open(tu.uid);
  main().querySelector('[data-act="ping"]').click();
  ok(await until(() => document.getElementById("bmodal").classList.contains("open") && !!document.querySelector('[data-ap="count"]')), "параметры команды — форма по схеме");
  closeBulkModal();

  // Страница плагина: setupUi.mode tab — ссылка с ?type=&id=&lang=
  await open(ctrl.uid);
  const a = main().querySelector("a[data-plugin]");
  const u = a ? new URL(a.getAttribute("href")) : null;
  ok(!!u && a.target === "_blank" && u.searchParams.get("type") === "security_controller/CONTROLLER" && u.searchParams.get("id") === ctrl.uid && u.searchParams.get("lang") === uiLang,
    "Страница плагина — ссылка с ?type=&id=&lang=");

  // Удаление: подтверждение вводом числа (1), затем отсчёт и DELETE на сервере
  pick(made.uid, { force: true });
  confirmDeleteNodes([made.uid]);
  const okBtn = document.getElementById("confirmOk");
  ok(!!document.getElementById("confirmCountInp") && okBtn.disabled, "удаление: без числа кнопка неактивна");
  await confirmWith(1);
  let gone = false;
  ok(await until(() => { API.get(`/units/${made.uid}`).then(() => (gone = false), (e) => (gone = e.status === 404)); return gone && !find(made.uid); }, 40000), "удаление требует ввода числа 1");

  // kinds.changed при черновике: черновик цел, новое поле появилось после перечитывания /kinds
  await open(tu.uid);
  type(sf("title"), "Черновик");
  const next = JSON.parse(JSON.stringify(TU));
  next.schema.properties.extraNote = { type: "string", maxLength: 50, "x-label": { key: "field.test.extraNote", text: "Пометка смены", lang: "ru" },
    "x-ui-tab": TU.schema.properties.title["x-ui-tab"], "x-ui-group": TU.schema.properties.title["x-ui-group"], "x-ui-order": 9 };
  // Стенд с testSupport меняет описание сам (PUT /test/kinds) и шлёт kinds.changed; встроенный сервер страницы служебных
  // операций не держит — там новое описание отдаёт перехваченный GET /kinds, событие приходит тем же apiOnEvent
  const put = await API.raw("PUT", `/test/kinds/${encodeURIComponent("test.unknown")}`, next);
  let realRaw = null;
  if (put.status >= 300) {
    realRaw = API.raw;
    API.raw = function (method, path, body, headers) {
      if (method !== "GET" || path !== "/kinds") return realRaw.call(this, method, path, body, headers);
      return realRaw.call(this, method, path, body).then((r) => Object.assign({}, r, { status: 200, headers: Object.assign({}, r.headers, { etag: '"ui-unknown-next"' }),
        body: Object.assign({}, r.body, { items: r.body.items.map((k) => (k.kind === "test.unknown" ? next : k)) }) }));
    };
    apiOnEvent({ type: "kinds.changed", kinds: ["test.unknown"] });
  }
  ok(await until(() => !!sf("extraNote") && /Пометка смены/.test(main().textContent)) && sf("title")?.value === "Черновик" && cardDiff().length === 1,
    "kinds.changed при черновике — черновик цел, новое поле появилось");
  if (realRaw) API.raw = realRaw;
  cardReset();

  // Известный вид: свойства сверх профилей были бы на вкладке «Дополнительно». У камеры их нет (configMode и templateId —
  // в профиле vms.camera/1), вкладки нет — как в базе
  const camKind = kindOf("camera");
  const camProfiles = new Set((await API.get("/kinds")).profiles.filter((p) => camKind.implements.includes(p.id)).flatMap((p) => p.properties || []));
  const camExtra = Object.keys(camKind.schema.properties).filter((x) => !camProfiles.has(x));
  const cam = (await API.get("/units", { kind: "camera", limit: 20 })).items[0];
  pick(cam.uid, { force: true });
  await until(() => sel === cam.uid && !find(cam.uid)?.n._row);
  const camTabs = tabsFor(find(cam.uid).n);
  ok(!camExtra.length && !camTabs.some(([id]) => id === "extra"), "у камеры вкладки «Дополнительно» нет, как в базе: сверх профиля — " + (camExtra.join(", ") || "ничего"));
  // Действие только для правил (ruleOnly) кнопкой не показывается: вызов ответил бы 404
  ok(camKind.actions.some((a) => a.ruleOnly) && !camKind.actions.filter((a) => a.ruleOnly).some((a) => new RegExp(`data-act="${a.id}"`).test(unitActionsHtml(find(cam.uid).n))),
    "действия ruleOnly — без кнопок");

  // Корень: объект вида без своего мастера (createParents [null]) — кнопкой «Объект» у домена, вид — только такие
  const dom = domains[0];
  pick(dom.id, { force: true });
  goTab("gen");
  ok(await until(() => !!main().querySelector("[data-schema-root]")), "у домена — кнопка «Объект»");
  main().querySelector("[data-schema-root]").click();
  await until(() => document.getElementById("bmodal").classList.contains("open") && !!document.getElementById("swKind"));
  const rootKinds = [...(document.getElementById("swKind")?.options || [])].map((o) => o.value);
  ok( rootKinds.includes("security_controller/CONTROLLER") && rootKinds.includes("test.unknown") && !rootKinds.includes("camera") && !rootKinds.includes("security_controller/SENSOR"),
    "мастер в корне — виды без своего мастера: " + rootKinds);
  type(document.getElementById("swKind"), "security_controller/CONTROLLER");
  type(document.querySelector("[data-sw-name]"), "Контроллер охраны — подвал");
  type(document.querySelector('[data-sw="ip_address"]'), "192.168.1.99");
  document.getElementById("swCreate").click();
  let rootMade = null;
  ok(await until(() => { unitsOf("security_controller/CONTROLLER").then((l) => (rootMade = l.find((u) => u.name === "Контроллер охраны — подвал"))); return rootMade && find(rootMade.uid); }) &&
    rootMade.parentId === null && rootMade.domainId === dom.id && rootMade.properties.ip_address === "192.168.1.99" && sel === rootMade.uid,
    "объект вида без своего мастера создаётся в корне домена");

  // Строка поиска: GET /units?q= находит контроллер по ip_address; поле ip_address — в фильтре полей с подписью из схемы
  ok(SEARCH_FIELDS.some(([k, l]) => k === "ip_address" && l === "IP-адрес"), "в фильтре полей — ip_address с подписью из схемы");
  const ip = ctrl2.properties.ip_address;
  // Находка — от сервера, а не совпадение в кэше: в журнале запросов есть GET /units?q=<ip> (и ?fields=ip_address ниже)
  const unitsAsked = (test) => (window.CONSOLEM_TRACE || []).some((t) => t.method === "GET" && t.status === 200 && /^\/units\?/.test(t.path) && test(new URLSearchParams(t.path.slice(7))));
  window.CONSOLEM_TRACE = [];
  goApp("hw");
  const gq = document.getElementById("gq");
  gq.focus();
  type(gq, ip);
  goInput(ip);
  ok(await until(() => !!find(ctrl2.uid) && goHits.some((t) => t.goId === ctrl2.uid) || treeShownKeys().has(ctrl2.uid)) && await until(() => unitsAsked((q) => q.get("q") === ip)),
    "строка поиска находит контроллер по ip_address запросом GET /units?q=, в фильтре полей есть его поле");
  // Переход из поиска: место, куда пришли, моргает
  const hit = goTargets().find((t) => t.goId === ctrl2.uid);
  hit.go();
  ok(await until(() => sel === ctrl2.uid && !!document.querySelector("#tree .n.on.acc-flash, .hd h1.acc-flash")), "переход из поиска на объект моргает");
  goClose();
  clearTreeQ();

  // Фильтр дерева по полю: fields=ip_address
  window.CONSOLEM_TRACE = [];
  searchFields.add("ip_address");
  setTreeQ(ip);
  ok(await until(() => fs && fs.done && !fs.busy) && fs.hits.has(ctrl2.uid) && unitsAsked((q) => q.get("q") === ip && (q.get("fields") || "").split(",").includes("ip_address")),
    "фильтр дерева по полю ip_address — GET /units?fields=ip_address");
  searchFields.clear();
  clearTreeQ();
  // Поле экрана («ID») — как в базе: только подсвечивает, fields= не уходит, сервер ищет q везде (и номер датчика 4.1.1)
  CONSOLEM_TRACE.length = 0;
  searchFields.add("id");
  setTreeQ("1");
  ok(await until(() => fs && fs.done && !fs.busy, 60000) && unitsAsked((q) => q.get("q") === "1" && !q.has("fields")) && !unitsAsked((q) => q.get("q") === "1" && q.has("fields")) &&
    [...fs.hits].some((id) => ["sensor", "relay"].includes(find(id)?.n?.type)),
    "фильтр дерева по полю «ID» — без fields=, как в базе: находки " + fs?.hits.size);
  delete window.CONSOLEM_TRACE;
  searchFields.clear();
  clearTreeQ();

  // Чип вида: в фильтре дерева только объекты этого вида
  ok((TYPE_FILTERS.all || []).some(([k, l]) => k === "security_controller/CONTROLLER" && l === kindOf("security_controller/CONTROLLER").label.text), "чип вида — в фильтрах дерева, подпись из /kinds");
  const ctrlsNow = await unitsOf("security_controller/CONTROLLER");
  typeFilts.add("security_controller/CONTROLLER");
  applyFiltersFromState();
  ok(await until(() => fs && fs.done && !fs.busy) && fs.hits.size === ctrlsNow.length && [...fs.hits].every((id) => find(id)?.n.type === "security_controller/CONTROLLER"),
    "чип вида security_controller в фильтре дерева оставляет только его объекты");
  typeFilts.clear();
  applyFiltersFromState();

  // Групповое удаление — одним запросом, как база: POST /objects/delete на всю выборку, не DELETE на каждый объект
  window.CONSOLEM_TRACE = [];
  confirmDeleteNodes([rootMade.uid, ctrl.uid]);
  ok(document.getElementById("confirmOk").disabled, "групповое удаление: без числа 2 кнопка неактивна");
  await confirmWith(2);
  let both = false;
  ok(await until(() => { Promise.all([rootMade.uid, ctrl.uid].map((id) => API.raw("GET", `/units/${id}`))).then((r) => (both = r.every((x) => x.status === 404))); return both && !find(rootMade.uid) && !find(ctrl.uid); }, 40000),
    "групповое удаление: оба объекта удалены");
  const delTrace = CONSOLEM_TRACE.filter((t) => t.method === "DELETE" || t.path === "/objects/delete");
  ok(delTrace.length === 1 && delTrace[0].method === "POST" && delTrace[0].status === 200, "групповое удаление — один POST /objects/delete: " + delTrace.map((t) => t.method + " " + t.path).join(" "));
  delete window.CONSOLEM_TRACE;

  // Второй вид камеры от плагина (профиль vms.camera/1): экран камеры привязан к профилю, а не к коду camera — такой вид
  // находится в выборе камер сценария, в дочитывании целей правила и чипом «Камера». В наборе такого вида нет: описание
  // добавляется в KINDS, а одна камера набора «становится» объектом вида плагина — ответы GET /units подменяются так, как
  // ответил бы сервер с этим видом (отбор kind= видит её только под кодом плагина, implements= — по профилю)
  const PK = "acme.cam";
  const plugKind = Object.assign(JSON.parse(JSON.stringify(camKind)), { kind: PK, label: { key: "kind.acme.cam", text: "Камера Acme", lang: "ru" } });
  goApp("rules");
  ruleOpen("between");
  await until(() => SCEN.doc);
  const pc = devicePool.find((n) => n.type === "camera" && deviceDomain(n.id) === SCEN.did && !!n.name);
  const realGet = API.get, asked = [];
  const asPlug = (u) => (u && u.uid === pc.id ? Object.assign({}, u, { kind: PK }) : u);
  API.get = function (path, params) {
    const want = path === "/units" && params && params.kind ? String(params.kind).split(",") : null;
    if (path === "/units") asked.push(Object.assign({}, params));
    const p = want ? Object.assign({}, params, { kind: [...new Set(want.map((k) => (k === PK ? "camera" : k)))].join(",") }) : params;
    return realGet.call(this, path, p).then((r) => {
      if (path === `/units/${pc.id}`) return asPlug(r);
      if (path !== "/units" || !r || !Array.isArray(r.items)) return r;
      const items = r.items.map(asPlug).filter((u) => !want || want.includes(u.kind));
      return Object.assign({}, r, { items });
    });
  };
  try {
    KINDS.set(PK, plugKind);
    kindsApply();
    ok(screenType(PK) === "camera" && kindsOfScreen("camera").includes(PK) && kindsOfScreen("camera").includes("camera"), "вид плагина с vms.camera/1 — экран камеры, виды экрана — оба");
    // Выбор камер сценария — по профилю
    scenNew();
    asked.length = 0;
    scenCamFind("when", pc.name);
    ok(await until(() => SCEN.found.when.some((x) => x.id === pc.id)) && asked.some((q) => q.implements === "vms.camera/1" && !q.kind),
      "вид плагина с профилем vms.camera/1 находится в выборе камер сценария (GET /units?implements=vms.camera/1)");
    scenCancel();
    // Дочитывание целей правила: типы экранов пункта → виды этих экранов
    ruleTypesRead.delete("camera");
    asked.length = 0;
    await ruleTypesNeed(["camera"]);
    ok(asked.some((q) => (q.kind || "").split(",").includes(PK) && (q.kind || "").split(",").includes("camera")), "цели правила дочитываются по видам экрана камеры, вид плагина среди них");
    // Чип «Камера» в дереве: на сервер — все виды экрана камеры
    goApp("hw");
    setSlice("all");
    asked.length = 0;
    typeFilts.add("camera");
    applyFiltersFromState();
    ok(await until(() => fs && fs.done && !fs.busy) && fs.hits.has(pc.id) && asked.some((q) => (q.kind || "").split(",").includes(PK)),
      "чип «Камера» находит камеру вида плагина с профилем vms.camera/1");
    typeFilts.clear();
    applyFiltersFromState();
    // Хранилище копий удержаний — по x-archive, не по коду archive.incidents
    const inc = kindOf("archive.incidents");
    KINDS.set("acme.holds", Object.assign(JSON.parse(JSON.stringify(inc)), { kind: "acme.holds" }));
    ok(archHoldKinds().includes("acme.holds") && archHoldKinds().includes("archive.incidents") && !archHoldKinds().includes("archive.local"),
      "держатель удержаний ищется среди хранилищ копий по x-archive: " + archHoldKinds());
    KINDS.delete("acme.holds");
    // Значок вида плагина — UnitKind.icon, а не общий «•»; код вида с дефисом мастер не режет
    ok(ic(PK).includes(IC.camera) && !ic(PK).includes("•") && ic("acme.nothing").includes("•"), "значок вида плагина — по UnitKind.icon");
    KINDS.set("acme-cam", Object.assign(JSON.parse(JSON.stringify(plugKind)), { kind: "acme-cam" }));
    ok(wizKind("acme-cam") === "acme-cam" && wizKind("ipsrv-nvr") === "ipsrv" && canAdd("ipsrv-nvr") === canAdd("ipsrv"), "код вида с дефисом — целиком, отрезается только подвид мастера");
    KINDS.delete("acme-cam");
  } finally {
    API.get = realGet;
    KINDS.delete(PK);
    kindsApply();
    if (find(pc.id)) delete find(pc.id).n._kind;
  }

  // Срез «Камеры» читает и виды без ручного экрана: папка, где лежит только контроллер, после чтения среза не серая,
  // раскрывается и показывает его. Контроллер убран из кэша — его приносит только чтение среза
  {
    const c = await API.get(`/units/${ctrl2.uid}`);
    const [fld] = (await API.post("/units", { idempotencyKey: "ui-unknown-cam-folder", items: [{ kind: "folder", name: "Только контроллер", domainId: c.domainId, properties: {} }] })).done.flatMap((d) => d.units || []);
    const op = await API.post("/operations", { idempotencyKey: "ui-unknown-cam-folder-put", items: [{ uid: c.uid, folders: [fld.uid] }], expectedVersions: { [c.uid]: c.version }, wait: true });
    ok(op.state === "done" && !(op.failed || []).length, "контроллер положен в новую папку одной операцией");
    await apiReload();
    goApp("hw");
    setSlice("all");
    hwRemoveDevice(c.uid);
    treeReset();
    window.CONSOLEM_TRACE = [];
    setGroup("folder");
    setSlice("cam");
    ok(await until(() => sliceReads.get(sliceReadKey())?.done, 20000), "срез «Камеры» прочитан");
    const reads = CONSOLEM_TRACE.map((t) => new URL(t.path, "http://x").searchParams.get("kind")).filter(Boolean);
    ok(reads.some((k) => k.split(",").includes("security_controller/CONTROLLER") && k.split(",").includes("camera")), "чтение среза «Камеры» берёт и вид контроллера: " + reads.join(" | "));
    delete window.CONSOLEM_TRACE;
    const row = () => document.querySelector(`#tree .n[data-pick="${fld.uid}"]`);
    renderTree();
    if (!row()) toggleNode(c.domainId, { stopPropagation() {} });  // домен раскрыт — папка в его ветке
    ok(await until(() => !!row()) && !row().classList.contains("n-slice-empty") && !!row().querySelector(".tw-chev"),
      "папка только с контроллером в «Камерах» — не серая и со стрелкой: " + (row()?.className || "нет строки"));
    row()?.querySelector(".tw")?.click();
    ok(await until(() => !!document.querySelector(`#tree .n[data-pick="${c.uid}"]`)), "раскрытая папка показывает контроллер");
    setSlice("all");
  }
});
