/* Сценарий интерфейса: раздел «Обучение» и учебный режим. Запуск — tools/check_ui.py tests/ui-learn.js */
UiCheck(async ({ ok, until }) => {
  // Сборка без обучения (tools/build_webui.py --without-learn): раздела нет, каталог сборки — пустой с признаком
  if (!window.Tour) {
    ok(!learnShown() && !appsShown().some((a) => a.id === "learn"), "без обучения: вкладки «Обучение» нет");
    const cat = await fetch(new URL("learn-catalog.json", location.href)).then((r) => (r.ok ? r.json() : null), () => null);
    ok(cat && cat.available === false && cat.topics.length === 0 && cat.version === null, "без обучения: learn-catalog.json сборки — available:false, тем нет");
    return;
  }
  goApp("learn");
  const main = () => document.getElementById("main");
  const rows = () => [...document.querySelectorAll("#tree .n")];

  // Раздел и дерево
  ok(appsShown().some((a) => a.id === "learn"), "вкладка «Обучение» в рельсе");
  ok(Tour.topics.length >= 6, "темы на месте: " + Tour.topics.length);
  ok(/Ничего не сломается/.test(main().textContent), "первый экран объясняет, зачем раздел");
  const closed = rows().length;
  ok(closed === Tour.topics.length + 1, "дерево свёрнуто: «С чего начать» и темы, строк: " + closed);
  ok(!Tour.demo && !document.querySelector(".tour-panel,.tour-mode"), "пока показ не запущен, учебного режима нет");

  const T0 = Tour.topics[0], T1 = Tour.topics[1];
  learnTree(T0.id);
  ok(/Зачем это нужно/.test(main().textContent), "экран темы: таблица глав");
  ok(rows().length === closed + Tour.topics[0].chapters.length, "тема раскрылась");
  ok(getComputedStyle(document.querySelector(".lrn-tbl")).tableLayout === "fixed", "таблица глав не двигает столбцы");

  const ch = T0.chapters[1];
  learnTree(ch.id);
  ok(main().querySelector("h1, .hd")?.textContent.includes(ch.title), "экран главы: заголовок");
  ok(document.querySelectorAll(".lrn-steps li").length === ch.to - ch.from + 1, "экран главы: текст всех шагов");
  ok(/\d+ шаг/.test(document.querySelector(".lrn-meta").textContent), "экран главы: число шагов");

  // Стрелка темы раскрывает и сворачивает, выбор не меняется
  learnTree("home");
  learnOpen.clear();
  renderTree();
  const arrow = () => document.querySelector(`#tree .n[data-go="learn:${T1.id}"] .tw`);
  const n0 = rows().length;
  arrow().click();
  ok(rows().length === n0 + Tour.topics[1].chapters.length && learnSel === "home", "стрелка раскрыла тему, выбор на месте");
  arrow().click();
  ok(rows().length === n0 && learnSel === "home", "стрелка свернула тему");

  // Ссылка моргает на месте прихода
  learnLink(T0.id);
  ok(await until(() => document.querySelector("#tree .acc-flash")), "ссылка подсвечивает строку дерева");

  // Адрес #learn — по ID: глава, тема; неверная глава ведёт к теме, неверная тема и прежний номер — на первый экран раздела
  const atHash = (h) => {
    history.replaceState(history.state, "", location.pathname + location.search + h);
    learnFromHash();
  };
  atHash(`#learn=${ch.id}`);
  ok(learnSel === ch.id && document.querySelector("#tree .n.on"), "#learn с ID главы выбирает главу");
  atHash(`#learn=${T0.id}.nope`);
  ok(learnSel === T0.id && document.querySelector("#tree .n.on"), "#learn с неверной главой выбирает тему");
  learnSel = "home";
  atHash("#learn=nope");
  ok(learnSel === "home", "#learn с неверной темой ничего не выбирает");
  atHash("#learn=0.1");
  ok(learnSel === "home", "#learn прежним номером (0.1) главу по номеру не выбирает: первый экран раздела");
  ok(location.hash === "", "якорь снят");

  // Устойчивые ID: у каждой темы и главы свой, латиницей, глава — «<тема>.<глава>», без повторов
  const allIds = Tour.topics.flatMap((t) => [t.id, ...t.chapters.map((c) => c.id)]);
  ok(Tour.topics.every((t) => t.stable && Tour.ID.test(t.id) && t.chapters.every((c) => c.stable && c.id.startsWith(t.id + ".") && Tour.ID.test(c.id.slice(t.id.length + 1)))), "у тем и глав устойчивые ID");
  ok(new Set(allIds).size === allIds.length, "ID без повторов");
  // Перестановка и удаление: глава находится по ID, а не по месту; удалённую главу консоль не берёт и ближайшую не подставляет
  const keep = Tour.topics.slice();
  const step = (id, title, say) => ({ ch: { id, title, why: "проверка" }, say });
  Tour.add({ id: "zz-check", title: "Проверка", why: "проверка", steps: [step("one", "Первая", "1"), step("two", "Вторая", "2")] });
  const before2 = Tour.find("zz-check", "zz-check.two");
  Tour.topics.splice(0, Tour.topics.length, ...keep);
  Tour.add({ id: "zz-check", title: "Проверка", why: "проверка", steps: [step("two", "Вторая", "2"), step("new", "Новая", "0"), step("one", "Первая", "1")] });
  const after2 = Tour.find("zz-check", "zz-check.two"), after1 = Tour.find("zz-check", "zz-check.one");
  ok(before2.c === 1 && after2.c === 0 && after2.chapter.title === "Вторая" && after1.chapter.title === "Первая", "перестановка и новая соседняя глава: ID ведёт к той же главе");
  ok(new URL(Tour.url("zz-check", "zz-check.one"), location.href).searchParams.get("ch") === "zz-check.one", "адрес показа — ID главы, не номер");
  Tour.topics.splice(0, Tour.topics.length, ...keep);
  Tour.add({ id: "zz-check", title: "Проверка", why: "проверка", steps: [step("two", "Вторая", "2")] });
  ok(Tour.find("zz-check", "zz-check.one").chapter === null && Tour.url("zz-check", "zz-check.one") === null && Tour.play("zz-check", "zz-check.one") === false, "удалённая глава: не найдена, показа нет");
  ok(Tour.find("nope", null) === null && Tour.url("nope", null) === null, "неизвестная тема: показа нет");
  Tour.topics.splice(0, Tour.topics.length, ...keep);
  // Каталог — из тех же тем: ID, название, цель, язык, учебный набор, отпечаток; шагов и кода показа в нём нет
  const cat = Tour.catalog();
  ok(cat.format === "consolem-learn-catalog/1" && /^sha256:[0-9a-f]{64}$/.test(cat.version) && cat.available === true, "каталог: формат, отпечаток, материал доступен");
  ok(cat.topics.length === Tour.topics.length && cat.topics.every((t, n) => t.id === Tour.topics[n].id && t.chapters.length === Tour.topics[n].chapters.length), "каталог: все темы и главы");
  ok(cat.topics.every((t) => t.title && t.goal && t.lang === "ru" && t.fixture === "demo" && t.chapters.every((c) => c.title && c.goal && c.lang === "ru" && c.fixture === "demo" && Object.keys(c).join() === "id,title,goal,lang,fixture")), "каталог: у глав только id, title, goal, lang, fixture");
  ok(!/"(say|before|at|act|steps|text)"/.test(JSON.stringify(cat)), "каталог: шагов, селекторов и действий нет");
  ok(Tour.catalog().version === cat.version, "отпечаток повторяется");
  Tour.add({ id: "zz-check", title: "Проверка", why: "проверка", steps: [step("one", "Первая", "1")] });
  ok(Tour.catalog().version !== cat.version, "новая глава меняет отпечаток");
  Tour.topics.splice(0, Tour.topics.length, ...keep);
  ok(Tour.catalog().version === cat.version, "без неё отпечаток прежний");
  // Сборка: learn-catalog.json — тот же каталог, что у страницы (tools/learn_catalog.mjs исполняет те же файлы)
  if (Tour.lazy) {
    const file = await fetch(new URL("learn-catalog.json", location.href)).then((r) => (r.ok ? r.json() : null), () => null);
    ok(file && file.version === cat.version && file.available === true && JSON.stringify(file.topics) === JSON.stringify(cat.topics), "learn-catalog.json сборки совпадает с каталогом страницы");
  }
  // Номер темы и главы этой страницы (так зовут play прототипы) становится ID в адресе
  ok(new URL(Tour.url(0, 1), location.href).searchParams.get("ch") === T0.chapters[1].id, "номер этой страницы переводится в ID");

  // Обычная страница сборки не загружает сервер показа
  if (Tour.lazy) ok(!performance.getEntriesByType("resource").some((e) => /\/demo\//.test(e.name)), "обычная страница без файлов demo/");

  // Главы идут подряд, без пропусков; подписи для нового пользователя
  for (const t of Tour.topics) {
    ok(t.chapters[0].from === 0 && t.chapters.at(-1).to === t.steps.length - 1 && t.chapters.every((c, n) => !n || c.from === t.chapters[n - 1].to + 1), `«${t.title}»: главы идут подряд`);
    ok(t.chapters.every((c) => c.title && c.why), `«${t.title}»: у каждой главы есть имя и зачем`);
    ok(!t.steps.some((s) => /раньше|прототип/i.test(s.say)), `«${t.title}»: подписи без «раньше» и «прототип»`);
  }

  // Поиск в дереве оставляет подходящие главы
  setTreeQ(Tour.topics[0].chapters[1].title);
  ok(rows().some((r) => r.textContent.includes(Tour.topics[0].chapters[1].title)), "поиск находит главу");
  setTreeQ("");

  // Учебный режим — страница в окне, на всю ширину. Адрес API задан нарочно: запросы туда идти не должны
  const API_ADDR = "http://127.0.0.1:9";
  const open = (query, withApi = true) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;width:1440px;height:900px;left:-3000px;top:0;border:0";
    f.src = new URL(`index.html?${withApi ? `api=${encodeURIComponent(API_ADDR)}&` : ""}${query}`, document.baseURI).href;
    document.body.appendChild(f);
    return f;
  };
  const btnIn = (f, name) => [...(f.contentDocument?.querySelectorAll(".tour-btns button") || [])].find((b) => b.textContent.trim() === name && b.style.display !== "none");
  const sayIn = (f) => f.contentDocument?.querySelector(".tour-say")?.textContent;
  // Настоящий localStorage: черновик и раскрытые папки не должны попасть в показ, и показ не должен их изменить
  const SENTRY = "learnSentry", THEME = "kit-theme";
  const themeWas = localStorage.getItem(THEME), openWas = localStorage.getItem(TREE_OPEN_LS);
  localStorage.setItem(SENTRY, "до показа");
  localStorage.setItem(THEME, "light");
  localStorage.setItem(TREE_OPEN_LS, JSON.stringify({ all: ["svcs:*"] }));
  // Раскрытие дерева в снимок не входит: в сборке под CSP внешняя страница стенда сама пишет его в то же хранилище
  // в любой момент. Утечку папок из показа ловит отдельная проверка ниже.
  const snap = () => JSON.stringify(Object.keys(localStorage).filter((k) => k !== TREE_OPEN_LS).sort().map((k) => [k, localStorage.getItem(k)]));
  const snapBefore = snap();
  for (let k = 0; k < Tour.topics.length; k++) {
    const t = Tour.topics[k], last = t.steps.length - 1, want = t.steps[last].say;
    const f = open(`tour=${t.id}&ch=${t.chapters.at(-1).id}&demo=${last}`);
    // Кнопка появляется, когда последний шаг выполнен: одной подписи мало, она видна раньше
    const reached = await until(() => sayIn(f) === want && btnIn(f, "Показать снова"), 90000);
    ok(reached, `«${t.title}»: показ дошёл до последнего шага` + (reached ? "" : `, на экране: ${sayIn(f)}`));
    const d = f.contentDocument, w = f.contentWindow;
    if (reached) {
      ok(d.querySelector(".tour-mode")?.textContent.includes("Учебные данные"), `«${t.title}»: видна полоса учебного режима`);
      const urls = w.performance.getEntriesByType("resource").map((e) => e.name);
      ok(!urls.some((u) => u.startsWith(API_ADDR)), `«${t.title}»: запросов к адресу API нет`);
      ok(w.localStorage.getItem(SENTRY) === null && w.localStorage.getItem(TREE_OPEN_LS) !== localStorage.getItem(TREE_OPEN_LS), `«${t.title}»: черновики и папки в показ не попали`);
      ok(w.localStorage.getItem(THEME) === "light", `«${t.title}»: тема пришла в показ`);
      w.localStorage.setItem(SENTRY, "из показа");
      ok(w.localStorage.getItem(SENTRY) === "из показа", `«${t.title}»: запись остаётся в памяти показа`);
      // Скорость живёт в этой вкладке, настоящий localStorage не меняет
      [...d.querySelectorAll(".tour-panel button")].find((b) => b.textContent.trim() === "×2")?.click();
    }
    ok(snap() === snapBefore, `«${t.title}»: настоящий localStorage не изменился`);
    const demoOpen = reached ? w.localStorage.getItem(TREE_OPEN_LS) : null;
    ok(demoOpen == null || localStorage.getItem(TREE_OPEN_LS) !== demoOpen, `«${t.title}»: раскрытие дерева из показа не попало в настоящий localStorage`);
    f.remove();
  }
  sessionStorage.removeItem("tourSpeed");

  // Глава целиком, настоящим ходом курсора; без ?api= — адрес API из разметки сборки, если он есть
  const chapters = Tour.topics[0].chapters, lastCh = chapters.at(-1);
  const pl = open(`tour=${T0.id}&ch=${lastCh.id}&demo=&play`, false);
  ok(await until(() => sayIn(pl) === Tour.topics[0].steps[lastCh.to].say && btnIn(pl, "Показать снова"), 120000), "глава прошла настоящим ходом до конца: " + sayIn(pl));
  ok(!pl.contentWindow.performance.getEntriesByType("resource").some((e) => /\/backend\/api\//.test(e.name)), "показ без ?api=: запросов к API сборки нет");
  pl.remove();

  // Конец главы: кнопки и переход к следующей главе без перезагрузки
  const f = open(`tour=${T0.id}&ch=${chapters[0].id}&demo=${chapters[0].to}`);
  ok(await until(() => btnIn(f, "Следующая глава") && btnIn(f, "Попробовать самому") && btnIn(f, "Показать снова"), 60000), "конец главы: следующая глава, попробовать самому, показать снова");
  const mark = (f.contentWindow.__sameLoad = {});
  btnIn(f, "Следующая глава")?.click();
  ok(await until(() => f.contentDocument?.querySelector(".tour-ti")?.textContent.includes(chapters[1].title), 60000), "«Следующая глава» открыла следующую главу");
  ok(f.contentWindow.__sameLoad === mark, "страница не перезагружалась");
  f.remove();

  // Неизвестная глава, неизвестная тема и прежний адрес по номерам: показа нет, ближайшая глава не запускается, выход — в каталог
  for (const [q, what] of [[`tour=${T0.id}&ch=${T0.id}.nope&demo=&play`, "неизвестная глава"], ["tour=nope&ch=nope.one&demo=&play", "неизвестная тема"], ["tour=1&demo=3&play", "прежний номер темы"]]) {
    const mf = open(q);
    const seen = await until(() => mf.contentDocument?.getElementById("tourMissing"), 60000);
    ok(seen && !mf.contentDocument.querySelector(".tour-cur,.tour-block"), `${what}: показ не идёт, объяснение на экране`);
    ok(seen && mf.contentDocument.querySelector(".tour-mode"), `${what}: страница на учебных данных`);
    if (seen) {
      [...mf.contentDocument.querySelectorAll("#tourMissing button")].find((b) => /Открыть каталог/.test(b.textContent))?.click();
      ok(await until(() => mf.contentWindow?.appReady && !/demo/.test(mf.contentWindow.location.search) && mf.contentDocument.querySelector('#tree .n.on[data-go="learn:home"]'), 60000), `${what}: «Открыть каталог» — раздел «Обучение»`);
    }
    mf.remove();
  }

  // Выход: раздел на той же главе, учебного режима нет, язык вернулся, у записи истории есть состояние для «Назад»
  const ex = open(`tour=${T0.id}&ch=${chapters[1].id}&demo=&lang=en`, false);
  const barBtn = () => ex.contentDocument?.querySelector(".tour-mode button");
  ok(await until(() => barBtn() && ex.contentDocument.querySelector(".tour-block"), 60000), "полоса учебного режима с кнопкой выхода");
  // Настоящий клик попадает в кнопку, а не в слой, который закрывает страницу на время показа
  const br = barBtn().getBoundingClientRect();
  ok(ex.contentDocument.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) === barBtn(), "во время показа кнопка выхода доступна мышью");
  barBtn()?.click();
  ok(await until(() => ex.contentWindow?.appReady && ex.contentWindow.location.hash === "" && !/demo/.test(ex.contentWindow.location.search) && ex.contentDocument?.querySelector("#tree .n.on"), 60000), "выход: обычная страница");
  const xw = ex.contentWindow;
  ok(!xw.Tour.demo && !ex.contentDocument.querySelector(".tour-mode"), "выход: полосы нет");
  ok(xw.document.documentElement.lang === "en" && !/lang=/.test(xw.location.search), "выход: язык вернулся, параметр снят");
  ok(xw.history.state != null, "выход: запись истории не потеряла состояние");
  ex.remove();

  // Отказ показа закрыт по умолчанию: сервер показа не загрузился или хранилище не подменилось. Глава известная, каталог полный.
  // Каждый отказ — с рабочим адресом в ?api= и без него (тогда адрес — метка consolem-api, если страница её задаёт: в сборке под CSP).
  // Отказ виден, учебные параметры на месте, страница к API не обращается, настоящий localStorage не меняется
  const metaApi = pageMeta("consolem-api"), metaApiUrl = metaApi ? new URL(metaApi, location.href).href : "";
  const workHits = (w) => w.performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.startsWith(API_ADDR) || (metaApiUrl && u.startsWith(metaApiUrl)));
  const sleepR = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const why of ["server", "storage"]) {
    for (const withApi of [true, false]) {
      const where = withApi ? "адрес в ?api=" : metaApi ? "адрес в метке consolem-api" : "без адреса API";
      const before = snap();
      const f = open(`tour=${T0.id}&ch=${T0.chapters[0].id}&demo=&play&demoFail=${why}`, withApi);
      const shown = await until(() => f.contentDocument?.querySelector(`#learnRefused[data-why="${why}"]`), 30000);
      ok(shown, `отказ «${why}», ${where}: понятный отказ показа`);
      if (shown) {
        const w = f.contentWindow, d = f.contentDocument;
        ok(/Показ не запущен/.test(d.getElementById("learnRefused").textContent) && /Настоящая система не изменилась/.test(d.getElementById("learnRefused").textContent), `отказ «${why}»: текст называет, что случилось`);
        await sleepR(1500);
        ok(/[?&]demo\b/.test(w.location.search) && /[?&]tour=/.test(w.location.search), `отказ «${why}», ${where}: учебные параметры на месте, перехода нет`);
        ok(!w.appReady && !d.querySelector(".tour-panel,.tour-mode"), `отказ «${why}»: страница дальше не пошла, показа нет`);
        ok(workHits(w).length === 0, `отказ «${why}», ${where}: запросов к рабочему API нет` + (workHits(w).length ? ": " + workHits(w)[0] : ""));
        if (why === "storage") ok(w.localStorage.getItem(SENTRY) === "до показа", "отказ «storage»: хранилище не подменилось — потому показ и не идёт");
      }
      ok(snap() === before, `отказ «${why}», ${where}: настоящий localStorage не изменился`);
      f.remove();
    }
  }
  // Выход из отказа — только кнопкой человека: обычная страница без учебных параметров
  const rf = open(`tour=${T0.id}&ch=${T0.chapters[0].id}&demo=&demoFail=server`, false);
  ok(await until(() => rf.contentDocument?.querySelector("#learnRefused button"), 30000), "в отказе есть кнопка «Вернуться к работе»");
  rf.contentDocument.querySelector("#learnRefused button")?.click();
  ok(await until(() => rf.contentWindow?.appReady && !/demo/.test(rf.contentWindow.location.search) && !rf.contentDocument.getElementById("learnRefused"), 60000), "«Вернуться к работе»: обычная страница");
  rf.remove();

  // Учебный режим: внешней службы ассистента нет ни из ?assist=, ни из метки consolem-assist. Разговор идёт на заглушке
  const SVC = "https://assist.example.test";
  const af = open(`tour=${T0.id}&ch=${T0.chapters[0].id}&demo=${T0.chapters[0].to}&assist=${encodeURIComponent(SVC)}`, false);
  ok(await until(() => af.contentWindow?.appReady && af.contentDocument.querySelector(".tour-mode"), 60000), "учебный режим с ?assist= открылся");
  const aw = af.contentWindow;
  if (aw?.asstServiceUrl) {
    ok(aw.asstServiceUrl() === "" && aw.asstMode(null) === "off", "учебный режим: ?assist= не включает службу");
    const m = aw.document.createElement("meta");
    m.name = "consolem-assist";
    m.content = SVC;
    aw.document.head.append(m);
    ok(aw.asstServiceUrl() === "", "учебный режим: метка consolem-assist не включает службу");
    aw.document.querySelectorAll(".tour-block,.tour-panel").forEach((e) => e.remove());
    aw.asstOpen("");
    const ta = aw.document.getElementById("asstText");
    ta.value = "сколько камер";
    ta.dispatchEvent(new aw.Event("input", { bubbles: true }));
    aw.document.getElementById("asstSend").click();
    ok(await until(() => aw.document.getElementById("asstAnswer")), "учебный разговор: ответила заглушка");
    ok(!aw.performance.getEntriesByType("resource").some((e) => e.name.startsWith(SVC)), "учебный разговор: обращений к службе нет");
    ok(workHits(aw).length === 0, "учебный разговор: запросов к рабочему API нет");
  }
  af.remove();

  localStorage.removeItem(SENTRY);
  if (themeWas == null) localStorage.removeItem(THEME); else localStorage.setItem(THEME, themeWas);
  if (openWas == null) localStorage.removeItem(TREE_OPEN_LS); else localStorage.setItem(TREE_OPEN_LS, openWas);
  goApp("hw");
});
