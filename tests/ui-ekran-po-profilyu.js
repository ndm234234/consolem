/* Сценарий интерфейса: экран по профилю (часть 07 переделки по слоям). Ручной экран выбирается по профилю вида
   (implements), а не по коду вида: ступень 1 — своя страница (screenPageStep, до части 05 — форма по схеме у вида с
   setupUi), ступень 2 — ручной экран по SCREEN_OF_PROFILE (handScreenOf), ступень 3 — форма по схеме. Раздел А — выбор
   экрана; раздел Г — профиль снят с вида при открытой карточке (kinds.changed); Г2 — то же у других кодов ручных экранов
   (замок, сервер); Г3 — вкладка «Репликация» на состоянии без ожидаемых полей; Д — версия профиля от сервера (прототип 82); Е — сервер старше консоли прячет поля (правило 2, из прототипа 83); Ж — поле absent без значения (ответ w2c на 154325Z, п. 3.1). Виды теста ставятся в KINDS на время
   проверки и снимаются в finally с kindsApply(). Сценарий пришёл с прототипом 78 (index_78_ekran-po-profilyu.html, удалён), теперь проверяет index.html.
   Охрана screenFor — для прототипов, скопированных с index.html до переноса; на index.html она — сбой (absent). */
UiCheck(async ({ ok, until, sleep, absent }) => {
  if (typeof screenFor !== "function") { absent("screenFor"); return; }
  const main = () => document.getElementById("main");
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // Описания на время проверки: прежние возвращаются, новые снимаются
  const withKinds = async (defs, fn) => {
    const was = new Map(defs.map((d) => [d.kind, KINDS.get(d.kind)]));
    defs.forEach((d) => KINDS.set(d.kind, d));
    kindsApply();
    try { return await fn(); }
    finally {
      was.forEach((v, k) => (v ? KINDS.set(k, v) : KINDS.delete(k)));
      kindsApply();
    }
  };
  // Объект набора под другим кодом вида: GET /units/{uid} и списки GET /units отдают его с kind (как asPlug в ui-unknown.js)
  const asKind = async (uid, kind, fn) => {
    const realGet = API.get;
    const as = (u) => (u && u.uid === uid ? Object.assign({}, u, { kind }) : u);
    API.get = function (path, params) {
      return realGet.call(this, path, params).then((r) => {
        if (path === `/units/${uid}`) return as(r);
        if (path === "/units" && r && Array.isArray(r.items)) return Object.assign({}, r, { items: r.items.map(as) });
        // Ветка дерева тоже несёт вид строки: иначе дочитанная ветка вернула бы узел с прежним видом
        if (path === "/tree/children" && r && Array.isArray(r.items)) return Object.assign({}, r, { items: r.items.map((x) => (x && x.id === uid ? Object.assign({}, x, { kind }, x.unit ? { unit: Object.assign({}, x.unit, { kind }) } : {}) : x)) });
        return r;
      });
    };
    try { return await fn(); }
    finally { API.get = realGet; }
  };
  // Узел заново из ответа сервера: из кэша убран, pick читает строку и полную запись
  // Ветки дерева, которые ещё читаются, дочитываются до удаления узла: по HTTP ответ ветки приходит позже и вернул бы
  // узел из ответа, прочитанного до подмены вида (на встроенном сервере ответ успевает раньше)
  const reopen = async (uid) => {
    await until(() => ![...treeBr.values()].some((b) => b.busy), 10000);
    hwRemoveDevice(uid);
    pick(uid, { force: true, tab: "gen" });
    return until(() => sel === uid && find(uid) && !find(uid).n._row && !!main().querySelector(".cs-cq, [data-schema-card]"));
  };
  const kinds = (await API.get("/kinds")).items;
  const kindOf = (k) => clone(kinds.find((x) => x.kind === k));
  const like = Object.assign(kindOf("camera"), { kind: "test.camera-like", implements: ["vms.camera/1"], label: { text: "Камера по профилю", lang: "ru" } });
  const cam2 = Object.assign(kindOf("camera"), { kind: "test.camera2", implements: ["vms.camera/2"] });
  const acs = Object.assign(kindOf("acfa_lock"), { kind: "acme.acs" });
  const campos = Object.assign(kindOf("camera"), { kind: "acme.campos", implements: ["vms.pos/1", "vms.camera/1"] });
  const sens = Object.assign(kindOf("sensor"), { kind: "acme.sensor", implements: [] });
  const srvK = Object.assign(kindOf("server"), { kind: "acme.srv" });
  const domK = Object.assign(kindOf("domain"), { kind: "acme.dom" });
  const fldK = Object.assign(kindOf("folder"), { kind: "acme.fld" });

  // ── А. Выбор экрана ──
  goApp("hw");
  await withKinds([like, cam2, acs, campos, sens, srvK, domK, fldK], async () => {
    ok(screenFor("test.camera-like") === "hand:camera" && screenType("test.camera-like") === "camera", "вид с vms.camera/1 и другим кодом — экран камеры");
    ok(screenFor("test.camera2") === "schema" && isSchemaKind("test.camera2"), "незнакомая старшая версия vms.camera/2 — форма по схеме");
    ok(screenFor("acme.acs") === "schema" && screenFor("acfa_lock") === "hand:acfa_lock" && screenFor("acfa") === "hand:acfa",
      "неоднозначный vms.acs/1 — экран по коду среди своих, чужой код — форма по схеме");
    ok(screenFor("acme.campos") === "hand:camera", "камера и касса — экран камеры: порядок SCREEN_OF_PROFILE");
    ok(screenFor("sensor") === "hand:sensor" && screenFor("acme.sensor") === "schema", "экран без профиля — только по своему коду");
    ok(screenPageStep("camera") === null && screenFor("security_controller/CONTROLLER") === "schema", "ступень 1 до части 05: вид с setupUi — форма по схеме");
    ok(kindText("test.camera-like") === "Камера по профилю" && kindText("camera") === i18n(LB.camera), "подпись вида плагина — из /kinds, встроенного — словарь экрана");
    // Сервер, домен и папка плагина: узел ручного экрана хранит свой вид
    const srvU = (await API.get("/units", { kind: "server", limit: 1 })).items[0];
    const domU = (await API.get("/units", { kind: "domain", limit: 1 })).items[0];
    const fldU = (await API.get("/units", { kind: "folder", limit: 1 })).items[0];
    const asS = Object.assign(await API.get(`/units/${srvU.uid}`), { kind: "acme.srv" });
    const asD = Object.assign(await API.get(`/units/${domU.uid}`), { kind: "acme.dom" });
    const asF = Object.assign(await API.get(`/units/${fldU.uid}`), { kind: "acme.fld" });
    ok(unitNode(asS).type === "server" && nodeKind(unitNode(asS)) === "acme.srv" && nodeKind(unitNode(asD)) === "acme.dom" && nodeKind(unitNode(asF)) === "acme.fld",
      "сервер, домен и папка плагина хранят свой вид");
  });
  // Код camera без vms.camera/1 (vms.camera/2 и пустой implements): форма по схеме, а не экран по коду
  const camU = (await API.get("/units", { kind: "camera", limit: 50 })).items.find((u) => !u.hasChildren) || (await API.get("/units", { kind: "camera", limit: 1 })).items[0];
  const camFull = await API.get(`/units/${camU.uid}`);
  for (const im of [["vms.camera/2"], []]) {
    await withKinds([Object.assign(kindOf("camera"), { implements: im })], async () => {
      ok(screenFor("camera") === "schema" && isSchemaKind("camera") && isSchemaNode(unitNode(camFull)),
        `код camera с implements [${im.join()}] — форма по схеме, а не экран по коду; узел объекта — узел формы по схеме`);
    });
    await withKinds([like, Object.assign(kindOf("camera"), { implements: im })], async () => {
      ok(kindsOfScreen("camera").includes("test.camera-like") && !kindsOfScreen("camera").includes("camera"),
        `виды экрана камеры — без кода camera с implements [${im.join()}]: ` + kindsOfScreen("camera").join());
    });
  }
  // Список дочерних у узла формы по схеме — по описанию вида (children) и hasChildren, а не по DEV_WITH_KIDS экрана камеры
  await withKinds([Object.assign(kindOf("camera"), { implements: [], children: [] })], async () => {
    const n = unitNode(Object.assign(clone(camFull), { hasChildren: false }));
    ok(isSchemaNode(n) && n.devices === undefined, "камера формы по схеме без дочерних в описании — без списка дочерних (DEV_WITH_KIDS — только ручной экран)");
  });
  // Описаний нет (listKinds не объявлен, /kinds не прочитан): встроенные экраны — по коду, как прежде
  {
    const saved = new Map(KINDS);
    KINDS.clear();
    try {
      ok(screenFor("camera") === "hand:camera" && screenFor("archive.local") === "hand:archive" && screenFor("volume") === "hand:vol" && screenFor("acme.x") === "schema",
        "описаний нет — экран по коду, как прежде");
    } finally {
      saved.forEach((v, k) => KINDS.set(k, v));
    }
  }
  // Ступень 1 не меняет тип узла (С4): страница у вида с ручным экраном оставляет узел ручным
  {
    const was = window.screenPageStep;
    window.screenPageStep = () => "page";
    try {
      ok(screenFor("camera") === "page" && !isSchemaKind("camera") && screenType("camera") === "camera", "своя страница (ступень 1) не меняет тип узла: камера остаётся ручным экраном");
    } finally {
      window.screenPageStep = was;
    }
  }
  // Карточка: камера набора, отданная как test.camera-like, и как test.camera2
  pick(camU.uid, { force: true, tab: "gen" });
  await until(() => sel === camU.uid && !find(camU.uid)?.n._row && !!main().querySelector(".cs-cq"));
  const camTabs = tabsFor(find(camU.uid).n).map((t) => t[0]).join();
  await withKinds([like, cam2], async () => {
    await asKind(camU.uid, "test.camera-like", async () => {
      await reopen(camU.uid);
      const n = find(camU.uid)?.n;
      ok(!!n && tabsFor(n).map((t) => t[0]).join() === camTabs && nodeKind(n) === "test.camera-like" && !!main().querySelector(".cs-cq"),
        "карточка вида с профилем камеры — вкладки и экран камеры: " + (n ? tabsFor(n).map((t) => t[0]).join() : "нет узла"));
    });
    await asKind(camU.uid, "test.camera2", async () => {
      await reopen(camU.uid);
      const n2 = find(camU.uid)?.n;
      ok(isSchemaNode(n2) && !!main().querySelector("[data-schema-card]"), "объект вида vms.camera/2 открывается формой по схеме");
    });
  });
  await reopen(camU.uid);
  ok(!isSchemaNode(find(camU.uid)?.n) && nodeKind(find(camU.uid)?.n) === "camera" && !!main().querySelector(".cs-cq"), "камера снова под своим кодом — экран камеры");

  // ── Б. Ручной экран читает свой вид, а не вид с кодом экрана ──
  // Вид плагина на экране камеры: своя схема (маска приватности до трёх областей, своё свойство covProbe); касса плагина —
  // свои умолчания; команды, создание и чтение по профилю — по всем видам экрана, а не по коду
  {
    const likeB = Object.assign(clone(like), { schema: clone(like.schema) });
    likeB.schema.properties.privacyMasks = Object.assign(clone(likeB.schema.properties.privacyMasks || {}), { maxItems: 3 });
    likeB.schema.properties.covProbe = { type: "string", "x-label": { text: "Проба", lang: "ru" } };
    const pos = Object.assign(kindOf("eventsrc"), { kind: "acme.pos" });
    pos.schema.properties.baudRate = Object.assign({}, pos.schema.properties.baudRate, { default: 19200 });
    const srvNoProbe = Object.assign(kindOf("server"), { actions: (kindOf("server").actions || []).filter((a) => a.id !== "probe") });
    const srvProbe = Object.assign(kindOf("server"), { kind: "acme.srv" });
    const edge = Object.assign(kindOf("storage"), { kind: "acme.edge" });
    const storageNoEdge = Object.assign(kindOf("storage"), { implements: kindOf("storage").implements.filter((p) => p !== "vms.edge/1") });
    const sub = Object.assign(kindOf("subdet"), { kind: "acme.subdet" });
    const domMake = Object.assign(kindOf("domain"), { kind: "acme.dom" });
    const domNoCreate = Object.assign(kindOf("domain"), { capabilities: kindOf("domain").capabilities.filter((c) => c !== "create") });
    const evU = (await API.get("/units", { kind: "eventsrc", limit: 1 })).items[0];
    const evFull = await API.get(`/units/${evU.uid}`);
    const camNode = unitNode(camFull), evNode = unitNode(evFull);
    await withKinds([likeB, pos], async () => {
      const likeNode = unitNode(Object.assign(clone(camFull), { kind: "test.camera-like" }));
      const posNode = unitNode(Object.assign(clone(evFull), { kind: "acme.pos" }));
      ok(pmSchema(likeNode)?.maxItems === 3 && pmSchema(camNode)?.maxItems === 16, "маска приватности — по схеме вида узла");
      ok(posDef(posNode, "baudRate") === 19200 && posDef(evNode, "baudRate") === 9600, "касса читает умолчания своего вида");
      const likeNodeWithProbe = Object.assign(likeNode, { covProbe: "x" });
      const u = nodeToUnit(likeNodeWithProbe);
      ok(u.kind === "test.camera-like" && u.properties.covProbe === "x", "новый объект — со своим видом и полями своей схемы: " + JSON.stringify({ kind: u.kind, covProbe: u.properties.covProbe }));
    });
    await withKinds([srvNoProbe, srvProbe], async () => {
      ok(typeof screenActionOn === "function" && screenActionOn("server", "probe") === true, "опрос адресов: команду объявил вид плагина с vms.server/1");
    });
    await withKinds([srvNoProbe], async () => {
      ok(typeof screenActionOn === "function" && screenActionOn("server", "probe") === false, "ни один вид экрана сервера не объявил probe");
    });
    await withKinds([edge, storageNoEdge], async () => {
      ok(edgeOn() === true, "встроенное хранилище — по vms.edge/1, а не по коду storage");
      const wasLoad = edgeLoad;
      window.CONSOLEM_TRACE = [];
      edgeLoad = null;
      edgeLoadAll();
      await until(() => edgeLoad?.done);
      const trace = window.CONSOLEM_TRACE;
      delete window.CONSOLEM_TRACE;
      if (wasLoad?.done) edgeLoad = wasLoad;
      ok(trace.some((t) => /implements=vms\.edge%2F1|implements=vms.edge\/1/.test(t.path)) && !trace.some((t) => /kind=storage/.test(t.path)),
        "встроенные хранилища читаются по профилю: " + trace.filter((t) => /^\/units\?/.test(t.path)).map((t) => t.path).join(" "));
    });
    {
      const savedSub = KINDS.get("subdet");
      KINDS.delete("subdet");
      try {
        await withKinds([sub], async () => ok(dwSubsOk() === true, "поддетекторы — по vms.subdetector/1 с create"));
      } finally {
        KINDS.set("subdet", savedSub);
        kindsApply();
      }
    }
    await withKinds([domMake, domNoCreate], async () => {
      ok(kindsLike("domain").includes("acme.dom") && canCreateKind("domain") && typeof kindToCreate === "function" && kindToCreate("domain", null) === "acme.dom",
        "создать домен — видом, который умеет create");
    });
    // Нет createParents — под существующим объектом и в корне оператор вид не создаёт (контракт, UnitKind.createParents)
    const domNoParents = Object.assign(clone(domMake), { createParents: undefined });
    delete domNoParents.createParents;
    await withKinds([domNoParents, domNoCreate], async () => {
      ok(kindToCreate("domain", null) === "domain", "вид без createParents не создают в корне: " + kindToCreate("domain", null));
    });
  }

  // ── В. Поля своего экрана и счёт покрытия ──
  {
    const sameSet = (a, b) => { const A = new Set(a), B = new Set(b); return A.size === a.length && A.size === B.size && [...B].every((x) => A.has(x)); };
    const likeV = Object.assign(clone(like), { schema: clone(like.schema) });
    likeV.schema.properties.covProbe = { type: "string", "x-label": { text: "Проба", lang: "ru" } };
    await withKinds([likeV, cam2, campos, acs], async () => {
      const camProfiles = ["vms.camera/1", "vms.live/1", "vms.ptz/1", "vms.timeline/1"].flatMap((id) => profileProps(KIND_PROFILES.get(id)));
      ok(sameSet(handScreenFields("camera"), camProfiles), "поля экрана камеры — профили камеры, видео, PTZ и шкалы: ");
      ok(!handScreenFields("acme.campos").includes("overlays") && handScreenFields("acme.campos").includes("fps"), "экран камеры не считает поля кассы своими");
      ok(handScreenFields("test.camera2").length === 0, "у вида с vms.camera/2 полей ручного экрана нет");
      ok(handScreenFields("acfa_lock").length > 0 && profileProps(KIND_PROFILES.get("vms.acs/1")).every((f) => handScreenFields("acfa_lock").includes(f)), "поля vms.acs/1 — у экрана СКУД, чей код входит в массив");
      ok(handScreenFields("acme.acs").length === 0, "вид СКУД с чужим кодом — экрана нет, полей нет");
      const c = screenCoverage("test.camera-like", handScreenFields("test.camera-like"));
      ok(c.total === Object.values(likeV.schema.properties).filter((p) => !p["x-hidden"]).length && c.missing.includes("covProbe") && c.unknown.length === 0 && c.shown.length === c.total - c.missing.length, "счёт покрытия: всего (без x-hidden), показаны, не показаны");
      ok(screenCoverage("camera", ["fps", "nope"]).unknown.join() === "nope", "поле, которого нет в схеме, — отдельно");
      ok(kindExtraProps("test.camera-like").includes("covProbe") && !kindExtraProps("acme.campos").includes("fps"), "«сверх профиля» — по полям своего экрана");
      ok(profileProps({ properties: ["a", "b"] }).join() === "a,b" && profileProps({ properties: { a: {}, b: {} } }).join() === "a,b" && profileProps({}).length === 0, "имена профиля — из массива или из объекта (часть 02)");
    });
  }

  // ── Г. Профиль снят с вида при открытой карточке ──
  // Открыта карточка камеры с неприменённой правкой; PUT /test/kinds/camera без vms.camera/1 → kinds.changed. Карточка без
  // перезагрузки становится формой по схеме, правка переходит в черновик формы по схеме. Поле, которого в новой схеме нет
  // (короткое имя), консоль называет в уведомлении. Обратный PUT — снова экран камеры
  const camK = kindOf("camera");
  const NEW_IP = "10.77.0.7", NEW_NAME = "Камера после смены вида", NEW_SHORT = "КПС";
  const noCam = Object.assign(clone(camK), { implements: camK.implements.filter((p) => p !== "vms.camera/1") });
  delete noCam.schema.properties.short;
  // Стенд с testSupport меняет описание сам (PUT /test/kinds) и шлёт kinds.changed; без служебных операций новое описание
  // отдаёт перехваченный GET /kinds, событие приходит тем же apiOnEvent (приём ui-access.js)
  // Возвращает обработку kinds.changed: следующее описание консоль читает уже после прежнего
  let rawW = null;
  const kindPut = async (code, def, orig, tag) => {
    if (rawW) { API.raw = rawW; rawW = null; }
    const put = await API.raw("PUT", `/test/kinds/${code}`, def);
    if (put.status < 300) return kindsBusy;
    if (def === orig) { apiOnEvent({ type: "kinds.changed", kinds: [code] }); return kindsBusy; }
    rawW = API.raw;
    const real = rawW;
    API.raw = function (method, path, body, headers) {
      if (method !== "GET" || path !== "/kinds") return real.call(this, method, path, body, headers);
      return real.call(this, method, path, body).then((r) => Object.assign({}, r, { status: 200, headers: Object.assign({}, r.headers, { etag: `"${tag}"` }),
        body: Object.assign({}, r.body, { items: r.body.items.map((k) => (k.kind === code ? def : k)) }) }));
    };
    apiOnEvent({ type: "kinds.changed", kinds: [code] });
    return kindsBusy;
  };
  const camPut = (def, tag) => kindPut("camera", def, camK, tag);
  // Уведомления живут 2 с: сценарий собирает все, что консоль показала
  const toasts = [];
  const toastTick = setInterval(() => { const t = document.getElementById("tt")?.textContent; if (t && toasts[toasts.length - 1] !== t) toasts.push(t); }, 20);
  const menuText = (n) => { openTreeCtx(n, { x: 10, y: 10 }); const t = document.getElementById("tctx").textContent; closeTreeCtx(); return t; };
  const HAND_MENU = /Добавить детекторы…|Применить настройки к другим…/;
  try {
    ok(HAND_MENU.test(menuText(find(camU.uid).n)), "меню строки камеры — пункты ручного экрана камеры");
    // У детектора своё меню (rcSliceItems), но общая форма вида у него тоже есть: «Все параметры» — и в меню строки, и в «Ещё»
    if (KINDS.has("det")) {
      const dn = allNodes().find((x) => handOf(x, "det") && hasBaseForm(x));
      ok(!!dn && /Все параметры/.test(menuText(dn)), "меню строки детектора — «Все параметры» (общая форма вида): «" + (dn ? menuText(dn) : "детектора нет") + "»");
      // Короткие меню срезов (rcSliceItems) тоже несут пункт: камера, сервер и детектор с общей формой — во всех срезах
      const srvN = allNodes().find((x) => handOf(x, "server") && hasBaseForm(x));
      const wasSl = slice;
      try {
        for (const [what, x] of [["камеры", find(camU.uid).n], ["сервера", srvN], ["детектора", dn]]) {
          if (!x) continue;
          const miss = ["all", "cam", "acfa", "det", "arch"].filter((s) => { slice = s; return !/Все параметры/.test(menuText(x)); });
          ok(!miss.length, `меню строки ${what} — «Все параметры» во всех срезах дерева` + (miss.length ? `; нет в: ${miss.join(", ")}` : ""));
        }
      } finally { slice = wasSl; }
      if (dn) {
        // Пункт открывает общую форму детектора, «Вернуться к настройке» — его экран; выбор помнится по виду, поэтому снимаем
        pick(dn.id, { force: true, tab: "gen" });
        await until(() => sel === dn.id && !find(dn.id)?.n._row);
        formAllSet(true);
        ok(await until(() => !!main().querySelector("[data-base-head]"), 5000), "детектор: «Все параметры» открывает общую форму вида");
        formAllSet(false);
        ok(await until(() => !main().querySelector("[data-base-head]"), 5000), "детектор: «Вернуться к настройке» возвращает его экран");
        pick(camU.uid, { force: true, tab: "gen" });
        await until(() => sel === camU.uid && !find(camU.uid)?.n._row && !!main().querySelector(".cs-cq"));
      }
    }
    const n0 = find(camU.uid).n;
    n0.ip = NEW_IP;
    n0.name = NEW_NAME;
    n0.short = NEW_SHORT;
    setD(true);
    ok(cardDraft?.id === camU.uid && cardDiff().length >= 3, "черновик камеры: " + cardDiff().map((r) => r.label).join(", "));
    toasts.length = 0;
    await camPut(noCam, "ui-ekran-no-camera");
    const became = await until(() => {
      const n = find(camU.uid)?.n;
      return !!n && isSchemaNode(n) && !n._row && sel === camU.uid && !!main().querySelector("[data-schema-card]");
    });
    const n1 = find(camU.uid)?.n;
    ok(became, "kinds.changed: открытая карточка камеры без перезагрузки стала формой по схеме");
    ok(!!n1 && n1.props?.ip === NEW_IP && n1.name === NEW_NAME && cardDraft?.id === camU.uid && cardDiff().length >= 2,
      "неприменённая правка перенесена в форму по схеме: " + (n1 ? `ip ${n1.props?.ip}, имя «${n1.name}»` : "нет узла"));
    await until(() => toasts.some((t) => /Короткое имя/.test(t)), 3000);
    const note = toasts.find((t) => /Описание вида изменилось/.test(t)) || "";
    ok(/^Описание вида изменилось, поэтому консоль показывает «Камера после смены вида» другим экраном\. Консоль не перенесла изменения полей «Короткое имя», потому что на новом экране этих полей нет\. Остальные изменения консоль перенесла\.$/.test(note),
      "уведомление называет причину и поле, которое консоль не перенесла: «" + (note || toasts.join(" | ")) + "»");
    ok(!HAND_MENU.test(menuText(n1)), "меню строки камеры формы по схеме — без пунктов ручного экрана камеры");
    // Узел формы по схеме с кодом camera — не камера ручного экрана: не считается камерой без записи, в срезе «Детекторы»
    // не предлагает «Добавить детекторы…», не IP-устройство
    ok(!unrecordedCameras().some((x) => x.id === camU.uid), "камера формы по схеме не считается камерой без записи");
    {
      const wasSlice = slice;
      slice = "det";
      try {
        const items = (rcSliceItems(n1) || []).flat().join("");
        ok(!/Добавить детекторы…/.test(items), "срез «Детекторы»: у камеры формы по схеме нет «Добавить детекторы…»");
      } finally { slice = wasSlice; }
    }
    ok(!devIsIp(n1), "камера формы по схеме — не IP-устройство (devIsIp)");
    // Камера в списке типов (Set, includes): шаг учётных данных групповой правки, устройства правил, родитель мастера
    ok(!canCreds(n1), "камера формы по схеме — без шага учётных данных групповой правки (canCreds)");
    ok(!ruleDtHit(n1, ["camera"]) && !ruleUniverse(["camera"]).some((x) => x.id === camU.uid), "камера формы по схеме — не камера правил (ruleDtHit, ruleUniverse)");
    ok(!configuredDevices().some((x) => x.id === camU.uid), "камера формы по схеме — не в списке заведённых IP-устройств мастера (configuredDevices)");
  } finally {
    await camPut(camK);
  }
  const back = await until(() => {
    const n = find(camU.uid)?.n;
    return !!n && !isSchemaNode(n) && n.type === "camera" && !n._row && !!main().querySelector(".cs-cq");
  });
  const n3 = find(camU.uid)?.n;
  ok(back && n3.ip === NEW_IP && n3.name === NEW_NAME, "профиль вернулся — снова экран камеры, правка цела: " + (n3 ? `ip ${n3.ip}` : "нет узла"));
  if (cardDraft) { cardRestore(); gear(); }

  // Полную запись прочитать не удалось: консоль не теряет правку молча, а называет все поля, которые не перенесла
  {
    const realGet = API.get;
    try {
      find(camU.uid).n.ip = NEW_IP;
      setD(true);
      toasts.length = 0;
      API.get = function (path, params) {
        if (path === `/units/${camU.uid}`) return Promise.reject({ status: 503, problem: { code: "SERVER_OFFLINE", message: "нет связи" } });
        return realGet.call(this, path, params);
      };
      await camPut(noCam, "ui-ekran-no-camera-2");
      const seen = await until(() => toasts.some((t) => /Консоль не прочитала/.test(t)));
      const t = toasts.find((x) => /Консоль не прочитала/.test(x)) || toasts.join(" | ");
      ok(seen && /Консоль не перенесла изменения полей «IP»/.test(t) && !/Остальные изменения/.test(t),
        "запись не прочиталась — уведомление называет все поля правки: «" + t + "»");
    } finally {
      API.get = realGet;
      await camPut(camK);
    }
    ok(await until(() => { const n = find(camU.uid)?.n; return !!n && !isSchemaNode(n) && n.type === "camera"; }), "описание камеры вернулось — снова экран камеры");
    if (cardDraft) { cardRestore(); gear(); }
  }
  clearInterval(toastTick);

  // ── Г2. Другие коды ручных экранов: узел формы по схеме — не узел этого экрана ──
  // Правило handCam — для всех кодов (handOf, typeIn): узел формы по схеме, у которого код вида совпал с кодом ручного
  // экрана, ведёт себя как узел любого другого вида без ручного экрана — без пунктов меню, срезов и списков экрана
  {
    // Замок без vms.acs/1: kinds.changed пересобирает узлы замков формой по схеме (как камеру в разделе Г)
    const lockK = kindOf("acfa_lock");
    let lockId = null;
    walkAll((n) => { if (!lockId && n.type === "acfa_lock" && !isSchemaNode(n)) lockId = n.id; });
    ok(!!lockId && ruleDtHit(find(lockId).n, ["acfa_lock"]), "замок ручного экрана — единица СКУД правил (ruleDtHit)");
    try {
      await kindPut("acfa_lock", Object.assign(clone(lockK), { implements: lockK.implements.filter((p) => p !== "vms.acs/1") }), lockK, "ui-ekran-no-acs");
      ok(await until(() => isSchemaNode(find(lockId)?.n)), "замок без vms.acs/1 — форма по схеме");
      const n = find(lockId).n;
      ok(!/Добавить единицу СКУД|Все параметры/.test(menuText(n)), "меню строки замка формы по схеме — без пунктов ручного экрана: «" + menuText(n) + "»");
      ok(!ruleDtHit(n, ["acfa_lock"]) && !ruleUniverse(["acfa_lock"]).some((x) => x.id === lockId), "замок формы по схеме — не единица СКУД правил (ruleDtHit, ruleUniverse)");
      ok(!typeIn(n, ACS_TYPES) && !typeIn(n, ["acfa_lock"]) && typeIn(find(lockId).p, ACS_TYPES), "typeIn: замок формы по схеме — не в списке экранов СКУД, его родитель — в списке");
    } finally {
      await kindPut("acfa_lock", lockK, lockK);
    }
    ok(await until(() => { const n = find(lockId)?.n; return !!n && !isSchemaNode(n) && n.type === "acfa_lock"; }), "описание замка вернулось — снова экран замка");

    // Сервер без vms.server/1. Инфраструктуру kinds.changed не пересобирает (её экран меняется после перезагрузки), поэтому
    // проверка идёт путями прихода объекта: вход по чужому id (hwEnsure → GET /units?ids=) и ответ POST /units
    // (hwAddUnits). Объект — копия сервера набора с другим uid: его отдаёт перехваченный GET /units?ids=
    const srvK = kindOf("server"), srv0 = servers.find((s) => domainOf(s.id) && !isUnallocated(s.id));
    const srvU = await API.get(`/units/${srv0.id}`), dom = domainOf(srv0.id);
    const copyU = (uid, name) => Object.assign(clone(srvU), { uid, parentId: null, domainId: dom.id, name, version: srvU.version });
    const drop = (uid) => {
      const i = devicePool.findIndex((x) => x.id === uid); if (i >= 0) devicePool.splice(i, 1);
      const k = servers.findIndex((x) => x.id === uid); if (k >= 0) servers.splice(k, 1);
      domains.forEach((d) => ["servers", "unallocServers"].forEach((f) => { const a = d[f] || [], m = a.findIndex((x) => x.id === uid); if (m >= 0) a.splice(m, 1); }));
      delete DEVICE_DOMAIN[uid]; hwVer.delete(uid); hwIdxDrop();
    };
    const asHandSrv = (uid) => servers.some((x) => x.id === uid) || domains.some((d) => (d.servers || []).some((x) => x.id === uid));
    const sid = "2fffffff-0000-4000-8000-0000000000aa", sid2 = "2fffffff-0000-4000-8000-0000000000ab";
    const realGet = API.get;
    await withKinds([Object.assign(clone(srvK), { implements: srvK.implements.filter((p) => p !== "vms.server/1") })], async () => {
      const wasSlice = slice;
      API.get = function (path, params) {
        if (path === "/units" && params && String(params.ids || "").split(",").includes(sid)) return Promise.resolve({ items: [copyU(sid, "Сервер формы по схеме")] });
        return realGet.call(this, path, params);
      };
      try {
        await hwEnsure([sid]);
        const n = find(sid)?.n;
        ok(!!n && isSchemaNode(n) && n.type === "server" && !typeIn(n, ["server"]) && !asHandSrv(sid),
          "вход по чужому id (hwEnsure): сервер без vms.server/1 — узел формы по схеме, не сервер экрана в servers и domain.servers");
        if (n) {
          const m = menuText(n);
          ok(!/Исключить из домена|Добавить службу|Создать хранилище…|Добавить устройства…/.test(m), "меню строки сервера формы по схеме — без пунктов ручного экрана сервера: «" + m + "»");
          slice = "det";
          ok(!/Добавить детекторы…/.test((rcSliceItems(n) || []).flat().join("")), "срез «Детекторы»: сервер формы по схеме не предлагает «Добавить детекторы…»");
          slice = "arch";
          ok(rcSliceItems(n) === null && !archStaysInSlice(n), "срез «Хранилища»: сервер формы по схеме — без пунктов и строки сервера");
          slice = wasSlice;
          ok(!bulkSolo(n) && typeIn(srv0, BULK_SOLO), "групповая правка: сервер формы по схеме — не одиночный объект экрана сервера (bulkSolo)");
          ok(treeCountVal(n, 7) === 0 && treeCountVal(srv0, 7) === 7, "число в строке дерева: сервер формы по схеме не считает устройства, как сервер экрана (treeCountVal)");
        }
        hwAddUnits([copyU(sid2, "Созданный сервер формы по схеме")]);
        const n2 = find(sid2)?.n;
        ok(!!n2 && isSchemaNode(n2) && !asHandSrv(sid2), "ответ POST /units (hwAddUnits): сервер без vms.server/1 — узел формы по схеме, не сервер экрана");
        // Запись узла (unitRec): форма записи — по ручному экрану, а не по коду вида: родитель и «есть дочерние» не теряются
        const sid3 = "2fffffff-0000-4000-8000-0000000000ac";
        const r = unitRec(Object.assign(copyU(sid3, "Запись формы по схеме"), { parentId: "2fffffff-0000-4000-8000-0000000000ad", hasChildren: true }));
        unitProps.delete(sid3);
        ok(r.type === "server" && r.parentId === "2fffffff-0000-4000-8000-0000000000ad" && r.hasChildren === true,
          "unitRec: сервер без vms.server/1 — запись формы по схеме с parentId и hasChildren, а не запись экрана сервера: " + JSON.stringify({ type: r.type, parentId: r.parentId, hasChildren: r.hasChildren }));
      } finally {
        API.get = realGet;
        slice = wasSlice;
        drop(sid); drop(sid2);
      }
    });
  }

  // ── Г3. Вкладка «Репликация» (vms.edge/1) на значении состояния без ожидаемых полей ──
  // replicationStatus по схеме профиля — {type:"object"}: инструмент покрытия строит {}. Вкладка не падает
  {
    let st = null;
    walkAll((n) => { if (!st && n.type === "storage" && !isSchemaNode(n)) st = n; });
    if (!st) ok(false, "в наборе нет встроенного хранилища: вкладку «Репликация» проверить не на чем");
    else {
      const was = st.replicationStatus;
      for (const v of [{}, { cameras: {}, gaps: {} }, { state: "nope" }]) {
        st.replicationStatus = v;
        let html = "", err = "";
        try { html = edgeRepScreenHtml(st); } catch (e) { err = e.message; }
        const chip = /<span class="er-st\s*">—<\/span>/.test(html);
        ok(!err && chip && edgeStat(st)?.label === "—", "вкладка «Репликация» на replicationStatus " + JSON.stringify(v) + " — без исключения, состояние «—»" + (err ? ": " + err : chip ? "" : ": нет «—» в состоянии"));
      }
      st.replicationStatus = was;
    }
  }

  // ── Д. Версия профиля от сервера (запрос 154325Z, п. 5; из прототипа 82) ──
  // Консоль знает профили набора demo (api/fixture.js). Сервер новее — поле, которого консоль не знает, не входит в поля
  // своего экрана, «Все параметры» отмечают его «новое в версии профиля». Сервер той же версии с лишним полем, версия не по
  // формату, поле другого знакомого профиля экрана — без метки «новое»
  if (typeof profileKnown !== "function") absent("profileKnown");
  else {
    let cam = null;
    walkAll((n) => { if (!cam && handCam(n) && !isSchemaNode(n) && !n._row) cam = n; });
    if (!cam) ok(false, "в наборе нет камеры с полной записью: версию профиля проверить не на чем");
    else {
      const K = KINDS.get("camera"), schemaWas = K.schema, wasProf = new Map(KIND_PROFILES);
      const fieldsWas = handScreenFields("camera").slice().sort().join();
      const withProf = (id, ch) => { const w = KIND_PROFILES.get(id); KIND_PROFILES.set(id, Object.assign({}, w, ch, { properties: ch.properties ? ch.properties(profileProps(w)) : w.properties })); };
      const formAll = () => baseTabs(cam).map(([id]) => baseFormHtml(cam, id)).join("");
      const rowOf = (html, f) => { const d = document.createElement("div"); d.innerHTML = html; return d.querySelector(`[data-sf="${f}"]`)?.parentElement || null; };
      try {
        K.schema = JSON.parse(JSON.stringify(schemaWas));
        K.schema.properties.pvNew = { type: "string", title: "pvNew" };
        // 1. Сервер новее: 1.99 с полем pvNew (заведомо выше версии в файле профиля)
        withProf("vms.camera/1", { version: "1.99", properties: (ps) => ps.concat("pvNew") });
        ok(profileServerNewer("vms.camera/1") && JSON.stringify(kindNewerProps("camera")) === '{"pvNew":"1.99"}', "сервер 1.99 новее консоли: kindNewerProps — pvNew с версией 1.99: " + JSON.stringify(kindNewerProps("camera")));
        ok(handScreenFields("camera").slice().sort().join() === fieldsWas, "поля своего экрана не изменились: pvNew консоль не знает");
        let html = formAll(), row = rowOf(html, "pvNew");
        ok(!!row && /новое в версии профиля 1\.99/.test(row.querySelector("[data-prof-newer]")?.textContent || "") && !row.querySelector("[data-only-here]"),
          "«Все параметры»: у pvNew метка «новое в версии профиля 1.99», без «сверх профиля»");
        ok(/Метка «новое в версии профиля» стоит у свойств/.test(html), "шапка «Все параметры» объясняет метку «новое в версии профиля»");
        // 2. Сервер той же версии с лишним полем — не «новое», а «сверх профиля», как раньше
        KIND_PROFILES.clear(); wasProf.forEach((v, k) => KIND_PROFILES.set(k, v));
        withProf("vms.camera/1", { version: profileVer(profileKnown("vms.camera/1")), properties: (ps) => ps.concat("pvNew") });
        html = formAll(); row = rowOf(html, "pvNew");
        ok(JSON.stringify(kindNewerProps("camera")) === "{}" && !!row?.querySelector("[data-only-here]") && !row.querySelector("[data-prof-newer]"),
          "сервер той же версии с лишним полем: pvNew — «сверх профиля», без «новое в версии профиля»");
        // 3. Версия не по формату — не новее
        KIND_PROFILES.clear(); wasProf.forEach((v, k) => KIND_PROFILES.set(k, v));
        withProf("vms.camera/1", { version: "1.99.2", properties: (ps) => ps.concat("pvNew") });
        ok(profileVer(KIND_PROFILES.get("vms.camera/1")) === null && JSON.stringify(kindNewerProps("camera")) === "{}", "версия «1.99.2» не по формату: сервер не новее, меток «новое» нет");
        // 4. Поле другого знакомого профиля экрана: fps есть у vms.camera/1, новый vms.ptz/1 его приносит — экран fps показывает
        KIND_PROFILES.clear(); wasProf.forEach((v, k) => KIND_PROFILES.set(k, v));
        if (profileProps(profileKnown("vms.camera/1")).includes("fps") && KIND_PROFILES.has("vms.ptz/1")) {
          withProf("vms.ptz/1", { version: "1.9", properties: (ps) => ps.concat("fps") });
          ok(handScreenFields("camera").includes("fps") && !("fps" in kindNewerProps("camera")), "fps приносит vms.camera/1: новый vms.ptz/1 с fps не даёт метки «новое»");
        }
        // 5. Сервер без поля знакомой версии: поле не входит в поля своего экрана
        KIND_PROFILES.clear(); wasProf.forEach((v, k) => KIND_PROFILES.set(k, v));
        const one = profileProps(KIND_PROFILES.get("vms.camera/1")).find((f) => !profileProps(KIND_PROFILES.get("vms.stream/1")).includes(f) && !profileProps(KIND_PROFILES.get("vms.ptz/1")).includes(f));
        withProf("vms.camera/1", { properties: (ps) => ps.filter((f) => f !== one) });
        ok(!!one && !handScreenFields("camera").includes(one), `сервер без поля ${one}: поле не входит в поля своего экрана`);
        // 6. Профиль без version — M.0
        ok(profileVer({ id: "vms.camera/2" }) === "2.0" && profileVer({ id: "vms.camera/1", version: 2 }) === null, "без version — M.0 из id; число вместо строки — не по формату");
      } finally {
        KIND_PROFILES.clear(); wasProf.forEach((v, k) => KIND_PROFILES.set(k, v));
        K.schema = schemaWas;
      }
      ok(handScreenFields("camera").slice().sort().join() === fieldsWas && JSON.stringify(kindNewerProps("camera")) === "{}", "после проверки: поля экрана камеры как до неё, меток «новое» нет");
    }
  }

  // ── Е. Сервер старше консоли: ручной экран прячет поля, которых нет в версии сервера (правило 2, из прототипа 83) ──
  // Поле знакомой версии, которого нет в списке сервера младшей версии, не видно на ручном экране: метка data-prof-field
  // получает hidden, nodeFieldOff — true. Та же версия с неполным списком (vms.detector/1 1.1 в наборах large, xl,
  // one-domain) ничего не прячет. Поле, которое приносит другой профиль вида, остаётся. Пришло из прототипа 83
  if (typeof profHideRefresh !== "function") absent("profHideRefresh");
  else {
    let pos = null;
    walkAll((n) => { if (!pos && !isSchemaNode(n) && (KINDS.get(nodeKind(n))?.implements || []).includes("vms.pos/1") && handScreenOf(nodeKind(n))) pos = n; });
    const pk = profileKnown("vms.pos/1"), pv = pk && profileVer(pk);
    if (!pos || !pv || /\.0$/.test(pv)) ok(false, "нет кассы с ручным экраном или знакомая версия vms.pos/1 — M.0: правило 2 проверить не на чем");
    else {
      const wasProf = new Map(KIND_PROFILES), kind = nodeKind(pos);
      const older = pv.replace(/\.(\d+)$/, (m, d) => "." + (Number(d) - 1));
      const setPos = (version, drop) => { const w = wasProf.get("vms.pos/1"); KIND_PROFILES.set("vms.pos/1", Object.assign({}, w, { version, properties: profileProps(w).filter((f) => !drop.includes(f)) })); profHideRefresh(); };
      const restore = () => { KIND_PROFILES.clear(); wasProf.forEach((v, k) => KIND_PROFILES.set(k, v)); profHideRefresh(); };
      const tagged = (f) => [...main().querySelectorAll(`[data-prof-field="${kind} ${f}"]`)];
      try {
        await until(() => ![...treeBr.values()].some((b) => b.busy), 10000);
        pick(pos.id, { force: true, tab: "gen" });
        await until(() => sel === pos.id && tagged("ip").length > 0, 10000);
        ok(tagged("ip").length > 0 && tagged("ip").every((e) => !e.hidden) && profHideSet.size === 0, "сервер той же версии: поле ip кассы помечено и видно, набор скрытых полей пуст");
        // 1. Та же версия с неполным списком — не старше: ничего не прячем
        setPos(pv, ["ip", "vendor"]);
        ok(!profileServerOlder("vms.pos/1") && profHideSet.size === 0 && tagged("ip").every((e) => !e.hidden), `сервер ${pv} без ip и vendor: не старше, поля видны`);
        // 2. Сервер младшей версии без ip и vendor: метки скрыты, nodeFieldOff — true, другие поля видны
        setPos(older, ["ip", "vendor"]);
        ok(profileServerOlder("vms.pos/1") && JSON.stringify(profileOlderMissing("vms.pos/1").sort()) === '["ip","vendor"]', `сервер ${older}: profileOlderMissing — ip и vendor: ` + JSON.stringify(profileOlderMissing("vms.pos/1")));
        ok(tagged("ip").length > 0 && tagged("vendor").length > 0 && tagged("ip").every((e) => e.hidden && getComputedStyle(e).display === "none") && tagged("vendor").every((e) => e.hidden), `сервер ${older}: поля ip и vendor на открытой карточке скрыты`);
        // Узел формы по схеме того же вида правило 2 не трогает: форму рисует схема сервера
        ok(isSchemaNode(Object.assign({}, pos, { _schema: true })) && !nodeFieldOff(Object.assign({}, pos, { _schema: true }), "ip") && nodeFieldOff(pos, "ip"), "узел формы по схеме: nodeFieldOff — нет, у узла ручного экрана — да");
        ok(nodeFieldOff(pos, "ip") && !nodeFieldOff(pos, "port") && tagged("port").every((e) => !e.hidden), "nodeFieldOff: ip — да, port — нет; port виден");
        // 3. Карточка, нарисованная заново, сразу без полей
        pick(pos.id, { force: true, tab: "gen" });
        await until(() => sel === pos.id && tagged("port").length > 0, 10000);
        await sleep(50);
        ok(tagged("ip").length > 0 && tagged("ip").every((e) => e.hidden), "карточка нарисована заново: поле ip скрыто");
        // 4. Поле, которое приносит другой профиль вида, остаётся: у вида с vms.pos/1 и vms.camera/1 ip даёт камера
        await withKinds([campos], async () => {
          profHideRefresh();
          const camIp = profileProps(KIND_PROFILES.get("vms.camera/1")).includes("ip");
          ok(camIp && !kindFieldOff("acme.campos", "ip") && kindFieldOff(kind, "ip"), "вид с vms.pos/1 и vms.camera/1: ip приносит vms.camera/1 — поле не скрыто, у кассы скрыто");
        });
        // 5. Версия не по формату — не старше
        setPos("1", ["ip"]);
        ok(!profileServerOlder("vms.pos/1") && profHideSet.size === 0, "версия «1» не по формату: не старше, ничего не скрыто");
        // 6. Сервер снова той же версии: hidden снят
        setPos(older, ["ip"]);
        restore();
        ok(profHideSet.size === 0 && tagged("ip").length > 0 && tagged("ip").every((e) => !e.hidden), "сервер снова той же версии: поле ip на открытой карточке снова видно");
        pick(pos.id, { force: true, tab: "gen" });
        await until(() => sel === pos.id && tagged("port").length > 0, 10000);
        ok(tagged("ip").length > 0 && tagged("ip").every((e) => !e.hidden), "карточка нарисована заново после возврата версии: поле ip видно");
      } finally {
        restore();
      }
    }
  }

  // ── Ж. Поле absent без значения: у сервера нет такой возможности (ответ w2c на запрос 154325Z, п. 3.1) ──
  // Файл профиля помечает поле absent: "unsupported" (window.CONSOLEM_PROFILE_ABSENT). Ручной экран прячет такое поле
  // у объекта, если значения нет и править поле нельзя: mac камеры (x-immutable). Пустое поле, которое правится
  // (privacyMasks без Unit.writable), остаётся. Поле без метки не меняется. Unit.writable без поля — поле скрыто
  if (typeof unitFieldAbsentOff !== "function") absent("unitFieldAbsentOff");
  else {
    const marks = window.CONSOLEM_PROFILE_ABSENT || {};
    ok((marks["vms.camera/1"] || []).includes("mac") && (marks["vms.camera/1"] || []).includes("privacyMasks"), "CONSOLEM_PROFILE_ABSENT: у vms.camera/1 помечены mac и privacyMasks");
    let cam = null;
    walkAll((n) => { if (!cam && !isSchemaNode(n) && nodeKind(n) === "camera" && handScreenOf("camera")) cam = n; });
    if (!cam) ok(false, "нет камеры с ручным экраном: правило absent проверить не на чем");
    else {
      // Метка, как её ставит pfa(n, поле) с узлом: элемент в карточке, проход MutationObserver и profHidePass
      const probe = (f) => { const d = document.createElement("div"); d.className = "absent-probe"; d.innerHTML = `<span${pfa(cam, f)}>x</span>`; main().appendChild(d); return d.firstChild; };
      const tagged = (f) => [...main().querySelectorAll(`[data-prof-field="camera ${f}"][data-prof-node="${cam.id}"]`)];
      await until(() => ![...treeBr.values()].some((b) => b.busy), 10000);
      pick(cam.id, { force: true, tab: "gen" });
      await until(() => sel === cam.id && unitProps.has(cam.id) && unitAbsentMeta.has(cam.id) && !!main().querySelector(".cs-cq, [data-schema-card]"), 10000);
      // Карточка дочитывает объект после первого кадра: unitRec снова пишет unitProps — ждём, пока чтение стихнет
      await until(() => ![...treeBr.values()].some((b) => b.busy), 10000);
      await sleep(400);
      const p0 = unitProps.get(cam.id), m0 = unitAbsentMeta.get(cam.id);
      const setUnit = (drop, writable) => {
        const p = Object.assign({}, p0); drop.forEach((f) => delete p[f]);
        unitProps.set(cam.id, p); unitAbsentMeta.set(cam.id, { obs: m0.obs, writable: writable === undefined ? m0.writable : writable });
        profHidePass(document.body);
      };
      try {
        // 0. Значение mac есть — поле видно, метка несёт uid объекта
        setUnit([], null); unitProps.set(cam.id, Object.assign({}, p0, { mac: "00:11:22:33:44:55" })); profHidePass(document.body);
        const pm = probe("mac"), pp = probe("privacyMasks");
        await sleep(30);
        ok(pm.getAttribute("data-prof-node") === cam.id && !pm.hidden && !unitFieldAbsentOff("camera", cam.id, "mac"), "есть значение mac: метка с data-prof-node видна, поле не скрыто");
        // 1. Нет mac, поле x-immutable — скрыто, и метки на карточке тоже
        setUnit(["mac"], null);
        ok(unitFieldAbsentOff("camera", cam.id, "mac") && nodeFieldOff(cam, "mac"), "нет mac, поле x-immutable: unitFieldAbsentOff и nodeFieldOff — да");
        ok(tagged("mac").length > 0 && tagged("mac").every((e) => e.hidden), `метки mac скрыты (${tagged("mac").length})`);
        // 2. Нет privacyMasks, Unit.writable нет, схема разрешает правку — поле остаётся
        setUnit(["mac", "privacyMasks"], null);
        ok(!unitFieldAbsentOff("camera", cam.id, "privacyMasks") && tagged("privacyMasks").every((e) => !e.hidden), "нет privacyMasks, поле правится: не скрыто");
        // 3. Unit.writable без privacyMasks — скрыто
        setUnit(["mac", "privacyMasks"], ["name", "enabled"]);
        ok(unitFieldAbsentOff("camera", cam.id, "privacyMasks") && tagged("privacyMasks").every((e) => e.hidden), "Unit.writable без privacyMasks: поле скрыто");
        // 4. Поле без метки не меняется
        setUnit(["mac", "privacyMasks", "firmware"], ["name"]);
        ok(!unitFieldAbsentOff("camera", cam.id, "firmware") && !nodeFieldOff(cam, "firmware"), "firmware без метки absent: не скрыто");
        // 5. Узел формы по схеме правило не трогает
        ok(!nodeFieldOff(Object.assign({}, cam, { _schema: true }), "mac"), "узел формы по схеме: nodeFieldOff — нет");
      } finally {
        unitProps.set(cam.id, p0); unitAbsentMeta.set(cam.id, m0); profHidePass(document.body);
        main().querySelectorAll(".absent-probe").forEach((e) => e.remove());
      }
      ok(tagged("privacyMasks").every((e) => !e.hidden), "значения вернулись: метки privacyMasks видны");
      // 6. Новая метка в DOM получает hidden сама (MutationObserver), без вызова profHidePass
      setUnit(["mac"], null);
      const late = probe("mac"); await sleep(30);
      ok(late.hidden, "метка mac, добавленная позже, скрыта проходом MutationObserver");
      unitProps.set(cam.id, p0); unitAbsentMeta.set(cam.id, m0); main().querySelectorAll(".absent-probe").forEach((e) => e.remove());
      profHidePass(document.body);
      // 7. Сервер старше консоли метку не обещал: поле не прячем
      const wasCam = KIND_PROFILES.get("vms.camera/1"), kv = profileVer(profileKnown("vms.camera/1"));
      if (kv && !/\.0$/.test(kv)) {
        try {
          setUnit(["mac"], null);
          KIND_PROFILES.set("vms.camera/1", Object.assign({}, wasCam, { version: kv.replace(/\.(\d+)$/, (m, d) => "." + (Number(d) - 1)) }));
          ok(!unitFieldAbsentOff("camera", cam.id, "mac"), "сервер старше консоли: метка absent у mac не действует");
        } finally { KIND_PROFILES.set("vms.camera/1", wasCam); unitProps.set(cam.id, p0); unitAbsentMeta.set(cam.id, m0); profHidePass(document.body); }
      }
      // 8. Хранилище: у всех томов нет usedPercent — доли занятого нет (archUsedOff)
      const ar = (typeof arch !== "undefined" ? arch : []).find((a) => archVols(a).length > 0 && archVols(a).every((v) => unitProps.has(v.id) && unitAbsentMeta.has(v.id)));
      if (!ar) ok(true, "нет хранилища с прочитанными томами: archUsedOff не проверен");
      else {
        const saved = archVols(ar).map((v) => [v.id, unitProps.get(v.id), unitAbsentMeta.get(v.id)]);
        try {
          ok(!archUsedOff(ar), "у томов есть usedPercent: доля занятого видна");
          saved.forEach(([id, p, m]) => { const q = Object.assign({}, p); delete q.usedPercent; const o = Object.assign({}, m.obs); delete o.usedPercent; unitProps.set(id, q); unitAbsentMeta.set(id, { obs: o, writable: m.writable }); });
          ok(archUsedOff(ar), "у всех томов нет usedPercent: archUsedOff — да, «Занято» не рисуется");
        } finally { saved.forEach(([id, p, m]) => { unitProps.set(id, p); unitAbsentMeta.set(id, m); }); }
      }
    }
  }
});
