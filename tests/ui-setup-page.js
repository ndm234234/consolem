/* Сценарий интерфейса: своя страница подсистемы в карточке (часть 05 переделки по слоям, шаг 1, api/SETUP-UI.md).
   Вид security_controller/KEYPAD со setupUi.mode: iframe показывает тестовую страницу стенда в рамке: правило экрана
   (ступень 1), рамка вне разметки карточки, ready и init по схеме api/setup-ui.schema.json, высота по сообщению height,
   перерисовка не трогает рамку, ручной экран со страницей (камера) оставляет вкладку механизма «Доступ», незнакомая
   версия протокола и mode: tab — не страница, поздний адрес, страница не загрузилась и «Загрузить страницу снова».
   Правка и «Применить»: change в черновике карточки, invalid, flush перед планом, applied, errors, revert, draft, только просмотр.
   Страница: index.html (из прототипа 80). Режим сравнения есть только в прототипе index_80_svoya-stranica.html:
   его шаги идут только там. На странице без своей страницы подсистемы сценарию проверять нечего. */
UiCheck(async ({ ok, until, sleep }) => {
  // Своя страница подсистемы есть в index.html (из прототипа 80): на нём её отсутствие — отказ. Пропуск — только у прототипа
  // без этой функции. Прототип узнаём по имени его файла английских текстов (assets/i18n-en-NN.js): check_ui.py и
  // самопроверка открывают страницу под другим именем
  const protoFile = [...document.querySelectorAll("script[src]")].map((x) => x.getAttribute("src")).find((x) => /i18n-en-\d+\.js$/.test(x));
  if (typeof suiOn !== "function") {
    ok(!!protoFile, protoFile ? "своей страницы подсистемы в прототипе (" + protoFile + ") нет: проверять нечего" : "своей страницы подсистемы нет, а в index.html она должна быть");
    return;
  }
  const SUI_KIND = "security_controller/KEYPAD";
  const SUI_UNIT = "30000306-0000-4000-8000-000000000000";
  const SUI_TEST_PAGE = "api/plugins/security_controller/setup/index.html";
  const main = () => document.getElementById("main");
  const slot = () => main().querySelector("[data-sui-slot]");
  const dockFrame = () => document.querySelector("#suiDock iframe");
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // Шпион: всё, что consolem отправляет странице (suiPost — единственная отправка)
  const sent = [];
  const realPost = suiPost;
  suiPost = (t, d) => { sent.push({ proto: "setup/1", type: t, ...d }); return realPost(t, d); };
  // Схема сообщений — та же, что сверяет check_api.py
  if (!window.CONSOLEM_SETUP_UI_SCHEMA) {
    const s = document.createElement("script");
    s.src = "api/setup-ui.schema.js";
    document.head.appendChild(s);
  }
  ok(await until(() => !!window.CONSOLEM_SETUP_UI_SCHEMA), "схема сообщений setup/1 загружена");
  const S = window.CONSOLEM_SETUP_UI_SCHEMA;
  const errsOf = (m) => (m && S.$defs[m.type] ? ConsolemContract.check({ components: { schemas: S.$defs } }, S.$defs[m.type], m, m.type, []) : ["нет сообщения"]);
  const valid = (m) => !errsOf(m).length;
  // Подмена POST /units/{uid}/setup-ui (P9: suiOpen зовёт API.post в момент вызова)
  const realApiPost = API.post;
  const stubSetup = (fn) => {
    API.post = function (path, ...rest) {
      if (/^\/units\/[^/]+\/setup-ui$/.test(path)) return fn(path, () => realApiPost.call(this, path, ...rest));
      return realApiPost.call(this, path, ...rest);
    };
  };
  const unstub = () => { API.post = realApiPost; };
  const open = async (uid, t) => {
    pick(uid, { force: true, tab: t || "gen" });
    return until(() => sel === uid && !!find(uid)?.n && !find(uid).n._row);
  };
  const cams = (await API.get("/units", { kind: "camera", limit: 5 })).items;
  // Вторая камера — объект, на который карточка уходит со страницы. Нет её — проверки ухода пропущены с причиной
  const cam = cams[0].uid, cam2 = cams[1] ? cams[1].uid : null;
  // Заметка — не проверка: она не входит в число PASS, а только пишется в консоль
  const note = (m) => console.info("ЗАМЕТКА ui-setup-page: " + m);
  // Док рамки скрыт, а рамка в нём жива: visibility hidden и высота 0, а не display none (рамка без кадров не знает свою высоту)
  const dockOff = () => { const d = document.getElementById("suiDock"); return !!d && !d.hidden && getComputedStyle(d).visibility === "hidden" && d.style.height === "0px"; };
  const dockOn = () => { const d = document.getElementById("suiDock"); return !!d && !d.hidden && !d.classList.contains("sui-off"); };
  try {
    // Ступень 1 (P2): вид стенда — страница; незнакомая версия протокола и mode: tab — не страница
    ok(screenFor(SUI_KIND) === "page" && screenPageStep(SUI_KIND) === "page" && screenPageStep("security_controller/CONTROLLER") === null && screenPageStep("camera") === null,
      "ступень 1: KEYPAD — страница, mode: tab и камера без setupUi — нет");

    // Объект стенда: одна вкладка «Настройка», страница вместо формы по схеме
    ok(await open(SUI_UNIT), "карточка «Клавиатура у входа» открыта");
    const n = find(SUI_UNIT).n;
    ok(suiOn(n) && JSON.stringify(tabsFor(n)) === JSON.stringify([["gen", "Настройка"]]), "вид с iframe: одна вкладка «Настройка» — " + JSON.stringify(tabsFor(n)));
    ok(await until(() => !!slot()) && !main().querySelector("[data-schema-card]") && !!main().querySelector("[data-schema-head]"),
      "страница вместо формы по схеме, строка вида остаётся");
    ok(await until(() => !!dockFrame()), "рамка создана в #suiDock");
    const fr = dockFrame();
    // Правило стенда: consolem с диска даёт рамке allow-same-origin (иначе Chrome не грузит скрипты страницы с диска),
    // на http того же происхождения — без него
    const wantSandbox = location.protocol === "file:" ? "allow-scripts allow-forms allow-same-origin" : "allow-scripts allow-forms";
    ok(fr && fr.getAttribute("sandbox") === wantSandbox && new RegExp(SUI_TEST_PAGE.replace(/[./]/g, "\\$&") + "\\?").test(fr.src) && fr.src.includes("id=" + SUI_UNIT) &&
      !main().contains(fr) && fr.title === i18n("Страница подсистемы"),
      "стенд: sandbox «" + (fr && fr.getAttribute("sandbox")) + "», адрес тестовой страницы, рамка вне карточки");
    ok(await until(() => suiFrame?.state === "ready", 15000), "страница прислала ready");
    const init = sent.find((m) => m.type === "init");
    // host — по полям (P7 части 06): у хоста шага 2 есть ещё bridge, его проверяет tests/ui-stranica-most.js
    ok(valid(init) && init.host.proto === "setup/1" && init.host.apply === "button" && init.readOnly === false && init.unit.version === hwVer.get(SUI_UNIT) &&
      JSON.stringify(init.draft) === "{}" && init.uid === SUI_UNIT && init.kind === SUI_KIND && init.lang === uiLang && init.unit.properties.code_length === 6,
      "init: по схеме, host с proto и apply, readOnly false, версия объекта — " + JSON.stringify(errsOf(init)));
    ok(JSON.stringify(suiFrame.fields) === JSON.stringify(["/properties/code_length", "/properties/display_text", "/properties/backlight", "/properties/beep"]), "ready.fields — четыре поля");
    // Высота: под check_ui в рамке не идут кадры (ResizeObserver и requestAnimationFrame молчат), поэтому height
    // приходит событием от окна рамки, как от страницы
    const fromPage = (d) => window.dispatchEvent(new MessageEvent("message", { data: { proto: "setup/1", ...d }, origin: suiFrame.star ? "null" : suiFrame.origin, source: suiFrame.win }));
    fromPage({ type: "height", px: 437 });
    ok(await until(() => suiFrame.h === 437 && parseInt(slot().style.height) === 437 && parseInt(document.getElementById("suiDock").style.height) === 437), "высота места и рамки — по сообщению height");
    ok(!!document.querySelector("#suiDock:not(.sui-off)") && !slot().textContent.trim(), "после ready рамка видна поверх места");
    // Прокрутка карточки: док идёт за местом и обрезан по видимой части .sc; место ушло из вида — док скрыт.
    // Под check_ui событий прокрутки нет (кадров нет), поэтому suiPlace() — прямым вызовом, как из слушателя scroll
    {
      const sc = slot().closest(".sc"), dock = document.getElementById("suiDock"), pad = sc.style.paddingBottom;
      sc.style.paddingBottom = "3000px";
      sc.scrollTop = Math.max(0, slot().getBoundingClientRect().top - sc.getBoundingClientRect().top + 40);
      suiPlace();
      const r = slot().getBoundingClientRect(), v = sc.getBoundingClientRect();
      const placed = Math.abs(parseFloat(dock.style.top) - r.top) < 1 && new RegExp("^inset\\(" + Math.round(v.top - r.top) + "px").test(dock.style.clipPath) && !dock.classList.contains("sui-off");
      sc.scrollTop = sc.scrollTop + 2000;
      suiPlace();
      const gone = dock.classList.contains("sui-off");
      sc.scrollTop = 0; sc.style.paddingBottom = pad;
      suiPlace();
      ok(placed && gone && !dock.classList.contains("sui-off"), "прокрутка: док идёт за местом и обрезан по видимой части, ушёл из вида — скрыт");
    }
    // Страница с диска не достаёт до consolem. Проверка — из окна рамки, если окно доступно; недоступно — значит, и
    // рамке consolem недоступен. Ключ Chrome --allow-file-access-from-files (его ставит check_ui) даёт файлам общий доступ:
    // тогда защиты нет, и сценарий только называет это (правило стенда, api/SETUP-UI.md)
    const reach = (() => { try { return fr.contentWindow.eval("!!window.parent.document.body"); } catch (e) { return false; } })();
    const fileAccess = await new Promise((res) => {
      if (location.protocol !== "file:") return res(false);
      const x = new XMLHttpRequest();
      x.onload = () => res(!!x.responseText); x.onerror = () => res(false);
      try { x.open("GET", new URL("api/setup-ui.schema.js", document.baseURI).href); x.send(); } catch (e) { res(false); }
    });
    if (fileAccess) note("браузер дал файлам общий доступ (--allow-file-access-from-files), страница с диска " + (reach ? "достаёт" : "не достаёт") + " до consolem. Это только стенд, поэтому сценарий изоляцию не проверяет");
    else ok(!reach, "страница в рамке не достаёт до window.parent.document");

    // Перерисовка не трогает рамку (Review Focus 1): gear, paint, событие чужого объекта
    const el0 = suiFrame.el, inits = sent.filter((m) => m.type === "init").length;
    gear(); paint();
    apiOnEvent({ type: "entity.changed", entityId: cam, kind: "camera", version: "x-" + Date.now() });
    await sleep(300);
    ok(suiFrame?.el === el0 && el0.isConnected && sent.filter((m) => m.type === "init").length === inits && suiFrame.state === "ready", "перерисовка не трогает рамку, init не уходит второй раз");
    // Чужое окно и чужое происхождение: сообщение не принимается
    const h0 = suiFrame.h;
    window.dispatchEvent(new MessageEvent("message", { data: { proto: "setup/1", type: "height", px: 1234 }, origin: "null", source: window }));
    window.dispatchEvent(new MessageEvent("message", { data: { proto: "setup/1", type: "height", px: 1234 }, origin: "https://evil.example", source: suiFrame.win }));
    ok(suiFrame.h === h0, "сообщение не от рамки или не с её происхождения — пропуск");
    fromPage({ type: "height", px: 5 });
    ok(await until(() => suiFrame.h === 80 && parseInt(slot().style.height) === 80), "высота зажата снизу: 80 px");
    fromPage({ type: "height", px: 99999 });
    ok(await until(() => suiFrame.h === 20000), "высота зажата сверху: 20 000 px");
    fromPage({ type: "height", px: 437 });
    fromPage({ type: "nope" });
    fromPage({ type: "height", px: 300, proto: "setup/9" });
    ok(suiFrame.state === "ready" && suiFrame.h === 437, "незнакомый type и чужая версия proto — пропуск");
    // Тема: страница получает theme
    const th = document.documentElement.dataset.theme;
    setTheme(th === "light" ? "dark" : "light");
    const thMsg = sent.filter((m) => m.type === "theme").pop();
    setTheme(th);
    ok(valid(thMsg) && thMsg.theme.mode === (th === "light" ? "dark" : "light") && typeof thMsg.theme.tokens["--one-accent"] === "string" && thMsg.theme.tokens["--one-accent"].length > 0,
      "смена темы — сообщение theme с токенами --one-…");

    // ready, когда объекта нет в кэше (по http так бывает после test.reset: поток перечитывает данные, а рамка уже
    // открыта): консоль читает объект GET /units/{uid} и шлёт init. Чтение не удалось — сбой с причиной.
    // Объект прячется от find только на время ready: потом карточка его снова видит
    {
      const realFind = find, realGet = API.get;
      const hidden = (fn) => { find = (id, ...r) => (id === SUI_UNIT ? undefined : realFind(id, ...r)); try { fn(); } finally { find = realFind; } };
      const isUnit = (p) => typeof p === "string" && p.split("?")[0] === "/units/" + encodeURIComponent(SUI_UNIT);
      const reads = [];
      API.get = function (p, ...r) { if (isUnit(p)) reads.push(p); return realGet.call(this, p, ...r); };
      const inits0 = sent.filter((m) => m.type === "init").length;
      hidden(() => fromPage({ type: "ready", fields: suiFrame.fields }));
      ok(await until(() => sent.filter((m) => m.type === "init").length === inits0 + 1), "ready без объекта в кэше: init уходит после чтения объекта");
      const i2 = sent.filter((m) => m.type === "init").pop();
      ok(reads.length === 1 && valid(i2) && i2.uid === SUI_UNIT && i2.kind === SUI_KIND && i2.unit.version === hwVer.get(SUI_UNIT) && suiFrame.state === "ready",
        "init после GET /units/{uid}: по схеме, тот же объект и версия — " + JSON.stringify({ reads: reads.length, errs: errsOf(i2) }));
      API.get = function (p, ...r) { if (isUnit(p)) return Promise.reject({ problem: { code: "SERVER_OFFLINE" } }); return realGet.call(this, p, ...r); };
      const inits1 = sent.filter((m) => m.type === "init").length;
      hidden(() => fromPage({ type: "ready", fields: suiFrame.fields }));
      ok(await until(() => suiFrame?.state === "failed" && !!suiFrame.why) && sent.filter((m) => m.type === "init").length === inits1,
        "чтение объекта не удалось — сбой с причиной «" + (suiFrame?.why || "") + "», init не ушёл");
      API.get = realGet;
      ok(await until(() => !!main().querySelector("[data-sui-fail]")), "карточка называет сбой и предлагает загрузить страницу снова");
      suiRetry();
      ok(await until(() => suiFrame?.state === "ready" && !!slot() && sent.filter((m) => m.type === "init").length === inits1 + 1, 15000), "«Загрузить страницу снова» — страница снова готова, init ушёл");
      fromPage({ type: "height", px: 437 });
    }

    // ── Правка и «Применить» (задача 7): change, invalid, flush, applied, errors, revert, readOnly ──
    {
      const un = () => find(SUI_UNIT).n;
      const bm = () => document.getElementById("bmodal").classList.contains("open");
      const lastOf = (t) => sent.filter((m) => m.type === t).pop();
      // Документ страницы стенда: под check_ui (--allow-file-access-from-files) он доступен, иначе проверки по странице — пропуск
      const pageDoc = () => { try { return suiFrame?.el?.contentDocument || null; } catch (e) { return null; } };
      const pageInput = (id, v) => { const d = pageDoc(), el = d && d.getElementById(id); if (!el) return false; el.value = v; el.dispatchEvent(new d.defaultView.Event("input")); return true; };
      const warns = [], realWarn = console.warn;
      console.warn = (...a) => { warns.push(a.join(" ")); return realWarn.apply(console, a); };
      try {
        fromPage({ type: "change", patch: { display_text: "Код, пожалуйста" } });
        ok(cardDiff().length === 1 && un().props.display_text === "Код, пожалуйста" && !!document.querySelector("#cardFoot:not([hidden])"), "change — строка черновика, подвал виден");
        // Review Focus 5: ключ вне схемы — не в черновик, console.warn один раз на ключ
        fromPage({ type: "change", patch: { display_text: "Код, пожалуйста", nope: 1 } });
        fromPage({ type: "change", patch: { display_text: "Код, пожалуйста", nope: 2 } });
        ok(cardDiff().length === 1 && !("nope" in un().props) && warns.filter((w) => /«nope»/.test(w)).length === 1, "ключ вне схемы не попадает в черновик, предупреждение одно");
        // Review Focus 2: сообщение не от рамки
        window.dispatchEvent(new MessageEvent("message", { data: { proto: "setup/1", type: "change", patch: { beep: false } }, origin: "null", source: window }));
        ok(un().props.beep === true && cardDiff().length === 1, "сообщение не от рамки пропущено");
        fromPage({ type: "invalid", fields: ["/properties/display_text"], message: "x" });
        const dis = document.querySelector("#cardFoot button.pri[disabled]");
        ok(!!dis && (dis.title||dis.dataset.tip) === i18n("Страница нашла ошибку ввода. Чтобы показать план, исправить ошибку на странице."), "invalid — «Показать план» неактивна, подсказка называет причину");
        fromPage({ type: "invalid", fields: [] });
        ok(!!document.querySelector("#cardFoot button.pri") && !document.querySelector("#cardFoot button.pri[disabled]"), "пустой invalid снимает запрет");
        const flushes = sent.filter((m) => m.type === "flush").length;
        cardPlan();
        ok(await until(() => sent.filter((m) => m.type === "flush").length === flushes + 1) && valid(lastOf("flush")) && await until(bm), "план: сначала flush, страница ответила flushed, план открыт");
        ok(/Текст на экране/.test(document.getElementById("bmodal").textContent), "в плане — строка «Текст на экране»");
        // Страница сообщила ошибку ввода, пока открыт план: applied снимает её (страница показывает записанное)
        fromPage({ type: "invalid", fields: ["/properties/display_text"] });
        document.querySelector("#bmodal .btn.pri").click();
        ok(await until(() => !!lastOf("applied")), "applied после «Применить»");
        const ap = lastOf("applied");
        ok(valid(ap) && ap.unit.properties.display_text === "Код, пожалуйста" && ap.unit.version === hwVer.get(SUI_UNIT) &&
          (await API.get(`/units/${SUI_UNIT}`)).properties.display_text === "Код, пожалуйста" && !cardDiff().length,
          "сервер записал, странице — новый unit, черновик пуст — " + JSON.stringify(errsOf(ap)));
        await sleep(300);
        ok(sent.at(-1).type === "applied" && suiFrame.applying === null, "после applied — ни revert, ни draft");
        ok(suiFrame.invalid === null, "applied снимает ошибку ввода страницы");
        ok(!pageDoc() || await until(() => pageDoc().getElementById("f-display_text").value === "Код, пожалуйста"), "страница стенда показывает записанный текст");

        // Страница стенда сама: ввод — change и invalid (код 4–8 цифр); исправленный ввод снимает запрет
        if (pageDoc()) {
          pageInput("f-code_length", "12");
          ok(await until(() => un().props.code_length === 12 && !!document.querySelector("#cardFoot button.pri[disabled]")), "страница: длина кода 12 — change и invalid, «Показать план» неактивна");
          pageInput("f-display_text", "x".repeat(33));
          ok(await until(() => JSON.stringify(suiFrame.invalid?.fields) === JSON.stringify(["/properties/code_length", "/properties/display_text"])), "страница: текст длиннее 32 знаков — второе поле в invalid");
          cardPlan();
          await sleep(300);
          ok(!bm() && /ошибку ввода/.test(document.getElementById("tt")?.textContent || ""), "invalid — «Показать план» называет причину и не открывает план");
          pageInput("f-code_length", "6");
          pageInput("f-display_text", "Код, пожалуйста");
          ok(await until(() => !cardDiff().length && suiFrame.invalid === null && document.getElementById("cardFoot")?.hidden === true), "страница: ввод исправлен — invalid пуст, черновик пуст");
        } else note("документ страницы недоступен, ввод на странице не проверен");

        // 422: поле на странице — только странице
        fromPage({ type: "change", patch: { code_length: 12 } });
        cardPlan();
        ok(await until(() => !!lastOf("errors")) && !bm(), "422 — errors странице, плана нет");
        const er = lastOf("errors");
        ok(valid(er) && er.problem.errors.some((e) => e.field === "/properties/code_length") && !main().querySelector("[data-sui-errs]"), "ошибка поля страницы — только странице — " + JSON.stringify(errsOf(er)));
        // Problem — как у сервера (errsProblem): первая ошибка — в code, field и params, все — в errors с их params
        {
          const e0 = er.problem.errors[0] || {};
          ok(!!e0.params && er.problem.code === e0.code && er.problem.field === e0.field && JSON.stringify(er.problem.params) === JSON.stringify(e0.params),
            "errors: первая ошибка — в code, field и params Problem — " + JSON.stringify(er.problem));
        }
        ok(!pageDoc() || await until(() => pageDoc().querySelector('[data-field="code_length"]').classList.contains("bad")), "страница стенда отметила поле «Длина кода»");
        // 422: поле не на странице — список под местом с «Все параметры»
        const ers = sent.filter((m) => m.type === "errors").length;
        fromPage({ type: "change", patch: { lock_after_tries: 99 } });
        cardPlan();
        ok(await until(() => /Блокировать после попыток/.test(main().querySelector("[data-sui-errs]")?.textContent || "")) && sent.filter((m) => m.type === "errors").length === ers + 1,
          "ошибка поля вне страницы — списком под рамкой");
        ok(!!main().querySelector("[data-sui-errs] button") && main().querySelector("[data-sui-errs]").textContent.includes(i18n("Сервер не примет поля, которых нет на странице. Чтобы исправить их, открыть «Все параметры».")), "в списке — причина и «Все параметры»");
        ok(!pageDoc() || await until(() => /Блокировать после попыток|lock_after_tries/.test(pageDoc().getElementById("error").textContent)), "страница стенда показала ошибку поля, которого у неё нет");
        // Новая правка страницы снимает список ошибок сервера и на экране, а не только в модели
        fromPage({ type: "change", patch: { lock_after_tries: 98 } });
        ok(!suiFrame.errs && !main().querySelector("[data-sui-errs]"), "правка страницы убирает список ошибок сервера с экрана");
        fromPage({ type: "invalid", fields: ["/properties/code_length"] });
        cardReset();
        ok(suiFrame.invalid === null && !document.querySelector("#cardFoot button.pri[disabled]"), "«Сбросить» снимает ошибку ввода страницы");
        ok(await until(() => sent.at(-1).type === "revert") && valid(sent.at(-1)) && sent.at(-1).unit.properties.lock_after_tries !== 99, "«Сбросить» — revert");
        ok(!main().querySelector("[data-sui-errs]"), "после «Сбросить» списка ошибок нет");

        // «Все параметры» меняет черновик — странице draft
        fromPage({ type: "change", patch: {} });
        un().props.backlight = "high"; setD(true); paint();
        ok(await until(() => sent.at(-1).type === "draft") && valid(sent.at(-1)) && sent.at(-1).patch.backlight === "high", "черновик изменили вне страницы — draft");
        cardReset();
        ok(await until(() => sent.at(-1).type === "revert"), "черновик опустел по «Сбросить» — revert");

        // Чужая правка при пустом черновике — revert с новой версией
        const before = hwVer.get(SUI_UNIT);
        fromPage({ type: "invalid", fields: ["/properties/beep"] });
        const pr = await API.raw("PATCH", `/units/${SUI_UNIT}`, { properties: { beep: false } }, { "If-Match": `"${before}"` });
        await hwFull(SUI_UNIT).catch(() => {});
        paint();
        ok(pr.status < 300 && hwVer.get(SUI_UNIT) !== before && await until(() => sent.at(-1).type === "revert" && sent.at(-1).unit.version === hwVer.get(SUI_UNIT) && sent.at(-1).unit.properties.beep === false),
          "объект изменился на сервере, черновик пуст — revert с новым unit");
        ok(suiFrame.invalid === null, "revert снимает ошибку ввода страницы");

        // flush без ответа: страница молчит — уведомление через 2 с, план всё равно открыт
        const spy = suiPost;
        suiPost = (t, d) => { if (t === "flush") { sent.push({ proto: "setup/1", type: t, ...d }); return; } return spy(t, d); };
        fromPage({ type: "change", patch: { display_text: "Без ответа" } });
        cardPlan();
        ok(await until(() => /не ответила за 2 секунды/.test(document.getElementById("tt")?.textContent || ""), 6000) && await until(bm), "нет flushed за 2 с — уведомление, план всё равно открыт");
        suiPost = spy;
        closeBulkModal();
        cardReset();
        await until(() => sent.at(-1).type === "revert");

        // Конец очереди без отказов, но GET /units/{uid} не прошёл: ошибка — в консоль, а не молча
        {
          const q = { fail: 0, steps: [] }, g = API.get;
          suiFrame.applyQ = q;
          API.get = function (path, params) { return path === `/units/${SUI_UNIT}` ? Promise.reject({ status: 503, problem: { code: "UNAVAILABLE", message: "нет связи" } }) : g.call(this, path, params); };
          try {
            suiQueueDone(q);
            ok(await until(() => warns.some((w) => /GET \/units/.test(w))) && await until(() => suiFrame.applying === null), "GET объекта после «Применить» не прошёл — предупреждение в консоли");
          } finally { API.get = g; }
        }

        // Язык: новая рамка, новый init с lang "en", черновик прежний
        fromPage({ type: "change", patch: { beep: !un().props.beep } });
        const want = clone(suiDraftOf(un())), elL = suiFrame.el;
        setUiLang("en");
        ok(await until(() => suiFrame?.el && suiFrame.el !== elL && suiFrame.state === "ready", 15000) && lastOf("init").lang === "en" && JSON.stringify(lastOf("init").draft) === JSON.stringify(want),
          "смена языка — новая рамка, init с lang en и прежним черновиком");
        setUiLang("ru");
        ok(await until(() => suiFrame?.state === "ready" && lastOf("init").lang === "ru", 15000), "язык обратно — init с lang ru");
        cardReset();
        await until(() => !cardDiff().length);

        // «Все параметры» (задача 8): у объекта по схеме — форма по схеме на том же черновике n.props
        {
          const sf = (name) => main().querySelector(`[data-sf="${name}"]`);
          const type = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
          const elA = suiFrame.el, hA = suiFrame.h ?? SUI_H0;
          fromPage({ type: "change", patch: { display_text: "А" } });
          formAllSet(true);
          ok(await until(() => !!main().querySelector("[data-schema-card]")) && sf("display_text")?.value === "А" && dockOff() && suiFrame?.el === elA && elA.isConnected,
            "«Все параметры»: форма по схеме с правкой страницы, рамка скрыта (visibility hidden, высота 0), но жива");
          ok(!!main().querySelector("[data-base-head]") && !main().querySelector("[data-base-head] [data-form-back][disabled]") && !slot() &&
            JSON.stringify(tabsFor(un())) === JSON.stringify(schemaTabs(un())), "«Все параметры»: строка «Вернуться к настройке» без запрета, вкладки формы по схеме");
          ok(!un().xprops && cardDiff().length === 1, "у объекта по схеме нет xprops, строка черновика одна");
          // Ввод в форме перерисовку не зовёт: правку формы странице отдаёт сверка после возврата, одним draft
          const nSent = sent.length;
          type(sf("display_text"), "Б");
          formAllSet(false);
          ok(await until(() => sent.at(-1).type === "draft") && sent.at(-1).patch.display_text === "Б" && valid(sent.at(-1)), "вернулись — странице draft с правкой формы");
          ok(await until(() => !!slot() && dockOn()) && suiFrame?.el === elA, "вернулись — то же место и та же рамка");
          const dk = document.getElementById("suiDock");
          ok(parseInt(dk.style.height) === hA && parseInt(slot().style.height) === hA && await until(() => Math.round(dk.getBoundingClientRect().height) === hA), "вернулись — высота места и рамки прежняя: " + hA + " px, док " + dk.style.height);
          await sleep(300);
          // result — ответ моста на запрос самой страницы (её блоки шага 2 читают объекты сами, по http — успевают), не сверка
          const sentNow = sent.slice(nSent).map((m) => m.type).filter((t) => t !== "result");
          ok(JSON.stringify(sentNow) === '["draft"]', "вернулись — странице ушёл только этот draft: " + JSON.stringify(sentNow));
          ok(/Все параметры/.test(formAllCtxItem(un(), (f, v) => ["x"]) || ""), "пункт «Все параметры» в «Ещё» у страницы");
          cardReset();
          await until(() => !cardDiff().length && sent.at(-1).type === "revert");
        }

        // Режим сравнения (задача 9): переключатель «Свой / Общие» и строка покрытия полей. Он есть только в прототипе 80
        // (решение владельца О6), в index.html его не переносят. Прототип 80 узнаём по его файлу английских текстов
        if (!!document.querySelector('script[src$="i18n-en-80.js"]') || typeof cmpSet === "function") {
          const cover = () => main().querySelector("[data-cover]");
          try {
            const c = suiCoverOf(un());
            ok(JSON.stringify(c.missing) === '["lock_after_tries"]' && !c.extra.length && /4 из 5/.test(cover()?.textContent || ""),
              "покрытие страницы: 4 из 5, не показан lock_after_tries — " + JSON.stringify(c) + " / " + (cover()?.textContent || "нет строки"));
            // Строка покрытия — целое предложение одним ключом i18n, с точкой внутри ключа: склонение не зависит от числа
            {
              const want = i18n("Свой экран показывает полей вида: {n} из {m}.").replace("{n}", "4").replace("{m}", "5");
              ok(cover()?.querySelector(".cmp-row > span")?.textContent === want, "строка покрытия — «" + want + "»: " + (cover()?.querySelector(".cmp-row > span")?.textContent || "нет строки"));
            }
            // Раскрытие списка «Нет на своём экране»: строка остаётся, список виден, aria-expanded
            const tg = cover()?.querySelector("[data-cover-toggle]");
            tg?.click();
            ok(!!tg && cover()?.classList.contains("open") && tg.getAttribute("aria-expanded") === "true" && /lock_after_tries|Блокировать после попыток/.test(cover().querySelector("[data-cover-list]")?.textContent || ""),
              "раскрытие: список полей, которых нет на своём экране");
            suiCoverToggle();
            ok(!cover()?.classList.contains("open"), "второе нажатие сворачивает список");
            suiFrame.fields = ["/properties/code_length", "/properties/nope"]; gear();
            ok(JSON.stringify(suiCoverOf(un()).extra) === '["nope"]' && /ошибка описания/.test(main().textContent) && !!cover()?.querySelector("[data-cover-extra]"), "поле вне схемы — отдельной строкой");
            suiFrame.fields = null; gear();
            ok(suiCoverOf(un()).own === null && /Страница не сообщила свои поля/.test(main().textContent), "без ready.fields — строка об этом");
            suiFrame.fields = ["/properties/code_length", "/properties/display_text", "/properties/backlight", "/properties/beep"]; gear();
            // Переключатель — справа перед «Ещё», только у объекта со своим экраном
            const tuu = (await API.get("/units", { kind: "test.unknown", limit: 1 })).items[0];
            ok(!!tuu, "есть объект test.unknown");
            const sw = main().querySelector("[data-cmp]"), more = [...main().querySelectorAll("button[aria-haspopup=menu]")].pop();
            ok(!!sw && sw.getAttribute("role") === "radiogroup" && !!more && !!(sw.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING) && sw.nextElementSibling === more,
              "переключатель «Свой / Общие» стоит перед «Ещё»");
            ok(sw.querySelector('[aria-checked="true"]')?.textContent === i18n("Свой") && sw.querySelector('[aria-checked="true"]').tabIndex === 0 && sw.querySelector('[aria-checked="false"]').tabIndex === -1, "по умолчанию — «Свой», в порядке Tab только отмеченная кнопка");
            // Стрелки в переключателе (role radiogroup): вправо — «Общие», влево — «Свой», фокус на отмеченной кнопке
            sw.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
            ok(await until(() => cmpGeneral === true && !slot() && document.activeElement?.getAttribute("aria-checked") === "true" && document.activeElement.textContent === i18n("Общие")) && sel === SUI_UNIT, "стрелка вправо — «Общие», фокус на ней, выбор в дереве тот же");
            main().querySelector("[data-cmp]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
            ok(await until(() => cmpGeneral === false && !!slot() && document.activeElement?.textContent === i18n("Свой")) && sel === SUI_UNIT, "стрелка влево — «Свой», выбор в дереве тот же");
            const elC = suiFrame.el;
            cmpSet(true);
            ok(localStorage.getItem("consolem.cmpGeneral") === "1" && cmpGeneral === true && await until(() => !!main().querySelector("[data-schema-card]")) && !slot() &&
              dockOff() && suiFrame?.el === elC, "«Общие» — форма по схеме, рамка скрыта, выбор запомнен");
            ok(/4 из 5/.test(cover()?.textContent || "") && main().querySelector('[data-cmp] [aria-checked="true"]')?.textContent === i18n("Общие"), "«Общие»: строка покрытия над формой, отмечено «Общие»");
            // «Вернуться к настройке» в режиме «Общие» возвращает «Свой»
            formAllSet(false);
            ok(cmpGeneral === false && localStorage.getItem("consolem.cmpGeneral") === "0" && await until(() => !!slot()), "«Вернуться к настройке» — снова «Свой»");
            cmpSet(true);
            await until(() => !slot());
            // Камера — ручной экран: покрытие по профилям вида; «Общие» перекрывает выбор «Все параметры» у вида
            await open(cam);
            await hwFull(cam).catch(() => {});
            gear();
            const cn = find(cam).n;
            ok(JSON.stringify(suiCoverOf(cn).missing) === JSON.stringify(kindExtraProps("camera")) && JSON.stringify(suiCoverOf(cn).own) === JSON.stringify(handScreenFields("camera")),
              "покрытие ручного экрана — по профилям вида");
            ok(cardFormAll(cn) === true && await until(() => !!main().querySelector("[data-base-head]")) && !!cover(), "камера в режиме «Общие» — базовая форма и строка покрытия");
            // Правка базовой формы: «Свой» не включается, уведомление называет причину
            const f0 = Object.keys(KINDS.get("camera").schema.properties)[0];
            cn.xprops = { [f0]: { cmpTest: 1 } };
            cmpSet(false);
            ok(cmpGeneral === true && localStorage.getItem("consolem.cmpGeneral") === "1" && (document.getElementById("tt")?.textContent || "").includes(i18n(FORM_BACK_WHY)),
              "правка в базовой форме — «Свой» не включается, уведомление «" + i18n(FORM_BACK_WHY) + "»");
            cn.xprops = {}; cardReset();
            // Строка покрытия у ручного экрана — только на первой вкладке
            cmpSet(false);
            {
              const ts = tabsFor(cn);
              tabGo(ts[0][0]);
              ok(ts.length > 1 && await until(() => tab === ts[0][0] && !!cover()), "камера «Свой», первая вкладка («" + ts[0][1] + "») — строка покрытия есть");
              tabGo(ts[1][0]);
              ok(await until(() => tab === ts[1][0] && !!main().querySelector("[data-cmp]")) && !cover(), "вторая вкладка («" + ts[1][1] + "») — строки покрытия нет");
              tabGo(ts[0][0]);
            }
            cmpSet(true);
            await open(tuu.uid);
            ok(await until(() => !!main().querySelector("[data-schema-card]")) && !cmpSwitchHtml(find(tuu.uid).n) && !main().querySelector("[data-cmp]") && !cover(),
              "переключатель и строка покрытия — только у объекта со своим экраном");
            // Выбор держится после перезагрузки: значение при старте — из localStorage
            ok(localStorage.getItem(CMP_KEY) === "1", "выбор лежит в localStorage под ключом " + CMP_KEY);
            cmpSet(false);
            ok(localStorage.getItem("consolem.cmpGeneral") === "0" && !cardFormAll(cn) && !cardFormAll(un()), "«Свой» — снова свой экран и страница");
          } finally {
            if (typeof cmpSet === "function") cmpGeneral = false;
            localStorage.removeItem("consolem.cmpGeneral");
          }
          await open(SUI_UNIT);
          ok(await until(() => suiFrame?.state === "ready" && !!slot(), 15000), "назад к «Клавиатуре»: страница прислала ready");
        } else ok(!document.querySelector("[data-cmp],[data-cover]") && typeof cmpSet === "undefined" && typeof suiCoverOf === "undefined", "режима сравнения на этой странице нет: ни переключателя, ни строки покрытия, ни cmpSet");
      } finally {
        console.warn = realWarn;
      }

      // Только просмотр: SetupUiLink.readOnly true — init.readOnly, строка о праве, change не принят, подвала нет
      stubSetup((p, real) => real().then((r) => Object.assign({}, r, { readOnly: true })));
      suiClose(); gear();
      ok(await until(() => suiFrame?.state === "ready" && lastOf("init")?.readOnly === true, 15000) && !!main().querySelector("[data-sui-ro]") &&
        main().querySelector("[data-sui-ro]").textContent === i18n("У вас есть только право на просмотр, поэтому консоль не применит изменения на странице."), "readOnly — init.readOnly true, строка о праве");
      unstub();
      ok(!pageDoc() || await until(() => !pageDoc().getElementById("readonly").hidden && pageDoc().getElementById("f-beep").disabled), "страница стенда: «Только просмотр», поля закрыты");
      fromPage({ type: "change", patch: { beep: false } });
      ok(!cardDiff().length && document.getElementById("cardFoot")?.hidden === true, "readOnly — change не принят, подвала нет");
      un().props.display_text = "ro"; setD(true); cardFootRefresh();
      ok(document.getElementById("cardFoot")?.hidden === true, "readOnly — подвала нет и при черновике");
      cardReset();
      suiClose(); gear();
      ok(await until(() => suiFrame?.state === "ready" && lastOf("init")?.readOnly === false, 15000), "обычное право — init.readOnly false");
    }

    // Ручной экран со страницей (P3, RF4): камера с setupUi.mode: iframe — «Настройка» и вкладка механизма «Доступ».
    // Стенд с testSupport меняет описание сам (PUT /test/kinds) и шлёт kinds.changed. Встроенный сервер страницы служебных
    // операций не держит: тогда новое описание отдаёт перехваченный GET /kinds, отметку setupUi — GET /units/{uid}, адрес —
    // POST /setup-ui (приём ui-unknown.js)
    const camWas = clone(KINDS.get("camera"));
    const camPage = Object.assign(clone(camWas), { setupUi: { mode: "iframe", url: SUI_TEST_PAGE } });
    const put = await API.raw("PUT", "/test/kinds/camera", camPage);
    const realRaw = API.raw, realGet = API.get;
    const stubKind = (def, tag) => {
      API.raw = function (method, path, body, headers) {
        if (method !== "GET" || path !== "/kinds") return realRaw.call(this, method, path, body, headers);
        return realRaw.call(this, method, path, body).then((r) => Object.assign({}, r, { status: 200, headers: Object.assign({}, r.headers, { etag: `"${tag}"` }),
          body: Object.assign({}, r.body, { items: r.body.items.map((k) => (k.kind === "camera" ? def : k)) }) }));
      };
    };
    if (put.status >= 300) {
      stubKind(camPage, "ui-setup-page-cam");
      API.get = function (path, params) { return realGet.call(this, path, params).then((r) => (path === `/units/${cam}` ? Object.assign({}, r, { capabilities: ["setupUi"] }) : r)); };
      stubSetup((path, real) => (path === `/units/${encodeURIComponent(cam)}/setup-ui`
        ? Promise.resolve({ url: `${SUI_TEST_PAGE}?type=camera&id=${encodeURIComponent(cam)}&lang=${uiLang}&t=ui`, expiresAt: new Date(Date.now() + 300000).toISOString(), readOnly: false })
        : real()));
      apiOnEvent({ type: "kinds.changed", kinds: ["camera"] });
    }
    try {
      ok(await until(() => KINDS.get("camera")?.setupUi?.mode === "iframe"), "вид camera получил setupUi.mode: iframe (kinds.changed)");
      ok(screenType("camera") === "camera" && screenFor("camera") === "page", "ступень 1 не меняет тип узла: камера остаётся ручным экраном");
      await open(cam);
      await hwFull(cam);
      const cn = find(cam).n;
      ok((cn._caps || []).includes("setupUi") && !isSchemaNode(cn), "у ручного узла камеры — отметка setupUi из Unit.capabilities");
      ok(JSON.stringify(tabsFor(cn)) === JSON.stringify([["gen", "Настройка"], ["acc", "Доступ"]]), "камера со страницей: «Настройка» и «Доступ» — " + JSON.stringify(tabsFor(cn)));
      gear();
      ok(await until(() => suiFrame?.uid === cam && suiFrame.state === "ready", 15000), "камера: страница прислала ready");
      const camInit = sent.filter((m) => m.type === "init").pop();
      ok(valid(camInit) && camInit.uid === cam && camInit.kind === "camera" && JSON.stringify(camInit.unit.properties) === JSON.stringify(unitProps.get(cam)), "камера: init с полями объекта, как их отдал сервер");
      // Вкладка механизма: места нет, рамка жива и скрыта
      const elc = suiFrame.el;
      tabGo("acc");
      ok(await until(() => !slot() && !!document.querySelector("#suiDock.sui-off")) && suiFrame?.el === elc && elc.isConnected, "вкладка «Доступ»: рамка скрыта, но жива");
      tabGo("gen");
      ok(await until(() => !!slot() && !document.querySelector("#suiDock.sui-off")) && suiFrame?.el === elc, "назад на «Настройка» — та же рамка");
      // «Все параметры» у ручного экрана со страницей — базовая форма ручного экрана на n.xprops (задача 8, RF4)
      formAllSet(true);
      ok(await until(() => !!main().querySelector("[data-base-head]") && !slot()) && JSON.stringify(tabsFor(cn)) === JSON.stringify(baseTabs(cn)) &&
        dockOff() && suiFrame?.el === elc && elc.isConnected, "камера: «Все параметры» — базовая форма ручного экрана, рамка скрыта, но жива");
      formAllSet(false);
      ok(await until(() => !!slot() && dockOn()) && suiFrame?.el === elc, "камера: назад к странице — та же рамка");
      // Правка страницы ручного экрана: change → черновик n.xprops → план → «Применить» → applied с записанным значением
      {
        const fpage = (d) => window.dispatchEvent(new MessageEvent("message", { data: { proto: "setup/1", ...d }, origin: suiFrame.star ? "null" : suiFrame.origin, source: suiFrame.win }));
        const bm = () => document.getElementById("bmodal").classList.contains("open");
        const az0 = unitProps.get(cam)?.azimuth ?? null, az = az0 === 123 ? 124 : 123;
        fpage({ type: "change", patch: { azimuth: az } });
        ok(cn.xprops?.azimuth === az && JSON.stringify(suiDraftOf(cn)) === JSON.stringify({ azimuth: az }) && cardDiff().some((r) => r.key === "xprops" && r.schemaProp === "azimuth"), "камера: change — черновик n.xprops и строка плана — " + JSON.stringify(suiDraftOf(cn)));
        // Страница стенда знает только поля KEYPAD: на flush она отдала бы свой черновик без azimuth. Поэтому flushed — от сценария
        const spyC = suiPost;
        suiPost = (t, d) => { if (t === "flush") { sent.push({ proto: "setup/1", type: t, ...d }); setTimeout(() => fpage({ type: "flushed", seq: d.seq }), 0); return; } return spyC(t, d); };
        cardPlan();
        suiPost = spyC;
        ok(await until(bm), "камера: план открыт");
        document.querySelector("#bmodal .btn.pri").click();
        const apC = () => sent.filter((m) => m.type === "applied" && m.unit?.uid === cam).pop();
        ok(await until(() => !!apC()) && valid(apC()) && apC().unit.properties.azimuth === az && (await API.get(`/units/${cam}`)).properties.azimuth === az && !cardDiff().length,
          "камера: «Применить» — сервер записал, странице applied с новым значением");
        // Вернуть значение набора
        const v = hwVer.get(cam);
        await API.raw("PATCH", `/units/${cam}`, { properties: { azimuth: az0 } }, { "If-Match": `"${v}"` });
        await hwFull(cam).catch(() => {});
        paint();
      }
      // Сбой страницы у ручного экрана: текст не говорит о форме по схеме, пользователь видит вкладки камеры
      suiFail("проверка");
      tabGo(tabsFor(cn)[0][0]);
      ok(await until(() => !!main().querySelector("[data-sui-fail]")) && !/по схеме вида/.test(main().querySelector("[data-sui-fail]").textContent) &&
        main().querySelector("[data-sui-fail]").textContent.includes(i18n("Страница подсистемы недоступна, поэтому консоль показывает обычные вкладки объекта.")) && tabsFor(cn).some(([id]) => id === "vid"),
        "камера: сбой страницы — текст без «по схеме вида», вкладки камеры");
      suiRetry();
      ok(await until(() => suiFrame?.uid === cam && suiFrame.state === "ready", 15000), "камера: страница снова прислала ready");
      // Полный Unit без capabilities снимает отметку setupUi (_caps)
      {
        const full = clone(await API.get(`/units/${cam}`));
        delete full.capabilities;
        hwApplyUnit(full);
        ok(!(find(cam).n._caps || []).includes("setupUi") && !suiOn(find(cam).n), "полный Unit без capabilities — отметки setupUi нет");
        hwApplyUnit(await API.get(`/units/${cam}`));
        ok((find(cam).n._caps || []).includes("setupUi"), "полный Unit с capabilities — отметка вернулась");
        gear();
        await until(() => suiFrame?.uid === cam && suiFrame.state === "ready", 15000);
      }
      // Незнакомая версия протокола (Review Focus 4): не страница, вкладки ручного экрана
      const su = KINDS.get("camera").setupUi;
      KINDS.get("camera").setupUi = { mode: "iframe", protocol: "setup/9", url: SUI_TEST_PAGE };
      ok(screenPageStep("camera") === null && !suiOn(cn) && tabsFor(cn).some(([id]) => id === "vid"), "setup/9: не страница, вкладки ручного экрана");
      gear();
      ok(await until(() => suiFrame === null && !dockFrame()), "setup/9: рамки нет");
      KINDS.get("camera").setupUi = su;
    } finally {
      unstub();
      API.get = realGet;
      if (put.status < 300) await API.raw("PUT", "/test/kinds/camera", camWas);
      else { stubKind(camWas, "ui-setup-page-back"); apiOnEvent({ type: "kinds.changed", kinds: ["camera"] }); }
      ok(await until(() => !KINDS.get("camera")?.setupUi), "камера: описание вида вернулось без setupUi");
      API.raw = realRaw;
      await hwFull(cam).catch(() => {});
    }
    // mode: tab — прежняя ссылка «Страница плагина»
    const ctrl = (await API.get("/units", { kind: "security_controller/CONTROLLER", limit: 1 })).items[0];
    await open(ctrl.uid);
    ok(await until(() => !!main().querySelector("[data-plugin]") && !slot() && !!main().querySelector("[data-schema-card]")), "mode: tab — ссылка «Страница плагина», форма по схеме");

    // Правило стенда — только для тестовой страницы стенда: относительный адрес или адрес под api/plugins/ на происхождении
    // консоли (у консоли с диска — только под api/plugins/). Другой адрес на происхождении консоли и подсказка origin, равная происхождению
    // консоли, при чужом адресе — сбой с причиной, рамки нет
    {
      const SAME = i18n("У страницы подсистемы то же происхождение, что у консоли, поэтому консоль не открывает страницу.");
      const sameFail = () => suiFrame?.uid === SUI_UNIT && suiFrame.state === "failed" && suiFrame.why === SAME && !dockFrame();
      const elsewhere = new URL("tools/setup-page.html", document.baseURI).href;
      stubSetup(() => Promise.resolve({ url: elsewhere, expiresAt: new Date(Date.now() + 300000).toISOString(), readOnly: false }));
      await open(SUI_UNIT);
      ok(await until(sameFail, 3000), "адрес на происхождении консоли вне api/plugins/ — сбой «то же происхождение»: " + JSON.stringify(suiFrame && { state: suiFrame.state, why: suiFrame.why }));
      // Консоль с диска даёт рамке allow-same-origin: там и относительный адрес — только под api/plugins/, «..» не выводит наружу
      if (location.protocol === "file:") {
        for (const rel of ["tools/setup-page.html", "api/plugins/../../tools/setup-page.html"]) {
          stubSetup(() => Promise.resolve({ url: rel, expiresAt: new Date(Date.now() + 300000).toISOString(), readOnly: false }));
          suiRetry();
          ok(await until(sameFail, 3000), `консоль с диска: относительный адрес ${rel} вне api/plugins/ — сбой «то же происхождение»: ` + JSON.stringify(suiFrame && { state: suiFrame.state, why: suiFrame.why }));
        }
      }
      const hintHere = location.protocol === "file:" ? "file://" : location.origin;
      stubSetup(() => Promise.resolve({ url: "https://pages.example/setup/index.html", origin: hintHere, expiresAt: new Date(Date.now() + 300000).toISOString(), readOnly: false }));
      suiRetry();
      ok(await until(sameFail, 3000), "подсказка origin — происхождение консоли, адрес чужой — сбой «то же происхождение»: " + JSON.stringify(suiFrame && { state: suiFrame.state, why: suiFrame.why }));
      unstub();
      await open(ctrl.uid);
      await until(() => suiFrame === null);
    }

    // Уход со страницы на вторую камеру: поздний адрес, зависший POST, страница не ответила. Без второй камеры — пропуск
    if (!cam2) note("в наборе одна камера: проверки ухода со страницы пропущены");
    else {
      // Поздний адрес (Review Focus 3): A → B → A. Первый ответ POST /setup-ui (метка 1) приходит через 800 мс, когда открыта
      // уже вторая загрузка того же объекта (метка 2). Он не создаёт вторую рамку и не меняет адрес текущей
      {
        let calls = 0;
        const link = (mark) => ({ url: `${SUI_TEST_PAGE}?type=${encodeURIComponent(SUI_KIND)}&id=${SUI_UNIT}&lang=${uiLang}&t=late${mark}`, expiresAt: new Date(Date.now() + 300000).toISOString(), readOnly: false });
        stubSetup(() => (++calls === 1 ? sleep(800).then(() => link(1)) : Promise.resolve(link(2))));
        await open(SUI_UNIT);
        ok(await until(() => !!slot()) && /загружает страницу подсистемы/.test(slot().textContent) && !dockFrame(), "до ready место пишет, что консоль загружает страницу");
        pick(cam2, { force: true, tab: "gen" });
        ok(await until(() => suiFrame === null), "другой объект: рамки нет");
        await open(SUI_UNIT);
        ok(await until(() => !!dockFrame() && /[?&]t=late2\b/.test(dockFrame().src)), "вторая загрузка: рамка с меткой 2");
        await sleep(1200);
        const frames = document.querySelectorAll("#suiDock iframe");
        ok(calls === 2 && frames.length === 1 && /[?&]t=late2\b/.test(frames[0].src) && suiFrame?.gen === suiGen,
          `поздний адрес: одна рамка, метка 2, gen текущий — рамок ${frames.length}, src ${frames[0]?.src.replace(/^.*\?/, "?")}`);
        unstub();
        pick(cam2, { force: true, tab: "gen" });
        await until(() => suiFrame === null);
      }

      // Адрес не пришёл: POST /setup-ui завис — срок ready идёт с запроса, через 10 с сбой, а не вечная загрузка
      stubSetup(() => new Promise(() => {}));
      await open(SUI_UNIT);
      ok(await until(() => suiFrame?.state === "failed", 15000) && await until(() => !!main().querySelector("[data-sui-fail]")) && !dockFrame(), "POST /setup-ui завис — через 10 с сбой с причиной");
      unstub();
      pick(cam2, { force: true, tab: "gen" });
      await until(() => suiFrame === null);

      // Страница не ответила: адрес без страницы → нет ready за 10 с → причина и форма по схеме
      stubSetup(() => Promise.resolve({ url: "api/plugins/security_controller/langs/ru.json", expiresAt: new Date(Date.now() + 300000).toISOString(), readOnly: false }));
      await open(SUI_UNIT);
      ok(await until(() => suiFrame?.state === "failed", 15000) && await until(() => /не ответила за 10 секунд/.test(main().textContent)) && !!main().querySelector("[data-schema-card]") &&
        !!main().querySelector("[data-sui-fail]") && !!main().querySelector("[data-sui-retry]") && !dockFrame(),
        "нет ready за 10 с — текст с причиной и форма по схеме");
      ok(JSON.stringify(tabsFor(find(SUI_UNIT).n)) === JSON.stringify(schemaTabs(find(SUI_UNIT).n)), "сбой: вкладки формы по схеме");
      // Сервер отказал: причина — текст ответа
      const rej = { status: 500, problem: { code: "INTERNAL", message: "Дверь не ответила" } };
      stubSetup(() => Promise.reject(rej));
      suiRetry();
      ok(await until(() => suiFrame?.state === "failed" && main().querySelector("[data-sui-fail]")?.textContent.includes(problemText(rej))), "500 на POST /setup-ui — сбой, в тексте причина ответа: " + problemText(rej));
      // Адрес — javascript: → не открывается
      stubSetup(() => Promise.resolve({ url: "javascript:alert(1)", expiresAt: new Date(Date.now() + 300000).toISOString(), readOnly: false }));
      suiRetry();
      ok(await until(() => suiFrame?.state === "failed") && !dockFrame(), "адрес javascript: — сбой, рамки нет");
      unstub();
      // «Загрузить страницу снова» берёт новый адрес
      main().querySelector("[data-sui-retry]").click();
      ok(await until(() => suiFrame?.state === "ready", 15000) && !!dockFrame() && !!slot(), "«Загрузить страницу снова» — страница прислала ready");
    }

    // Уход на другой объект: рамка убрана
    await open(cam);
    ok(await until(() => suiFrame === null && !dockFrame()), "уход с карточки — рамки нет");
  } finally {
    unstub();
    suiPost = realPost;
  }
});
