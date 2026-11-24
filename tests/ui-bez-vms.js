/* Сценарий интерфейса: механизм без VMS (часть 04 переделки по слоям) на наборе agents — оркестратор агентов, система не
   из мира VMS. Срезы дерева идут от раскладок, которые объявила система (GET /kinds → layouts): у оркестратора нет камер,
   серверов, хранилищ и детекторов, поэтому их кнопок нет, а свои раскладки (agent.pipelines, agent.models) — срезы lay:<id>.
   Сервер без layouts (старый бэкенд) — прежние шесть срезов: slicesFor(null). Набор — FIXTURE_OF в tests/selftest.js.
   Сценарий пришёл с прототипом 79 (index_79_mehanizm-bez-vms.html, удалён), теперь проверяет index.html.
   Охрана slicesFor, appsFor и autoRef — для прототипов, скопированных с index.html до переноса; на index.html она — сбой (absent). */
UiCheck(async ({ ok, until, absent }) => {
  if (typeof slicesFor !== "function") { absent("срезов от раскладок (slicesFor)"); return; }
  const tree = () => document.getElementById("tree");
  const treeRowsText = () => tree()?.textContent || "";
  const row = (id) => tree()?.querySelector(`.n[data-pick="${id}"]`);
  const level = (id) => parseFloat(row(id)?.style.getPropertyValue("--l")) || 0;
  const chip = (id) => document.querySelector(`.ph-choice[data-slice="${id}"]`);
  // Имена из набора agents
  const MODEL = "30000001-0000-4000-8000-000000000000"; // «Локальная модель»
  const AGENT = "30000021-0000-4000-8000-000000000000"; // «Агент поддержки», modelId — «Локальная модель»
  const LOOSE = "30000023-0000-4000-8000-000000000000"; // «Агент без модели», modelId: null
  const PIPE = "30000031-0000-4000-8000-000000000000"; // конвейер «Обработка обращения»
  const STEP = "30000041-0000-4000-8000-000000000000"; // шаг «Принять» конвейера
  const CLOUD = "30000002-0000-4000-8000-000000000000"; // «Облачная модель»
  const REPORT = "30000022-0000-4000-8000-000000000000"; // «Агент отчётов», modelId — «Облачная модель»
  const TOOL = "30000011-0000-4000-8000-000000000000"; // инструмент: нет ни в одной своей раскладке
  // Строка-родитель: ближайшая строка выше с меньшим уровнем
  const parentOf = (id) => {
    const rows = [...tree().querySelectorAll(".n[data-pick]")], i = rows.indexOf(row(id));
    for (let j = i - 1; j >= 0; j--) if ((parseFloat(rows[j].style.getPropertyValue("--l")) || 0) < level(id)) return rows[j].dataset.pick;
    return null;
  };

  // Старый бэкенд без layouts — прежние срезы и четыре раскладки
  ok(slicesFor(null).join() === "all,cam,acfa,srv,arch,det", "без layouts — прежние срезы: " + slicesFor(null).join());
  ok(typeof layoutDeclared === "function", "layoutDeclared есть");
  ok(Array.isArray(TREE_LAYOUTS) && TREE_LAYOUTS.some((l) => l.id === "agent.models"), "TREE_LAYOUTS — из GET /kinds: " + (TREE_LAYOUTS || []).map((l) => l.id).join());
  ok(layoutDeclared("folders") && !layoutDeclared("servers") && layoutDeclared("agent.models"), "layoutDeclared — по объявленным раскладкам");
  ok(slicesFor(TREE_LAYOUTS).join() === "all,lay:agent.pipelines,lay:agent.models", "срезы набора agents: " + slicesFor(TREE_LAYOUTS).join());

  goApp("hw");
  await until(() => chip("all"));
  const chips = [...document.querySelectorAll(".ph-choice[data-slice]")].map((b) => b.textContent).join(" | ");
  ok(!/Камеры|ОПС|Серверы|Хранилища|Детекторы/.test(chips), "кнопок срезов VMS нет: " + chips);
  ok(/Конвейеры/.test(chips) && /По моделям/.test(chips), "кнопки своих раскладок — с подписью системы: " + chips);
  ok(document.getElementById("viewBtn").disabled, "«Папки» неактивна: второй раскладки у среза нет");
  ok(treeLayout() === "folders", "«Оборудование» на agents — раскладка folders: " + treeLayout());

  // Раскладка по ссылке: модели под рабочим пространством, агенты — под своей моделью
  setSlice("lay:agent.models");
  ok(slice === "lay:agent.models" && treeLayout() === "agent.models", "срез lay:agent.models → раскладка agent.models: " + treeLayout());
  ok(chip("lay:agent.models")?.classList.contains("on"), "кнопка среза находится по data-slice и нажата");
  ok(document.getElementById("viewBtn").disabled, "в срезе раскладки «Папки» неактивна");
  ok(await until(() => treeRowsText().includes("Локальная модель") && treeRowsText().includes("Облачная модель")), "модели в дереве");
  ok(await until(() => !!row(LOOSE)), "агент без модели — в дереве");
  ok(level(LOOSE) === level(MODEL), `агент без модели — прямо под рабочим пространством (уровень ${level(LOOSE)}, у модели ${level(MODEL)})`);
  ok(!row(AGENT), "агент модели не виден, пока модель свёрнута");
  ok(!!row(MODEL)?.dataset.tid, "у модели с агентами есть стрелка");
  row(MODEL).querySelector(".tw").click();
  ok(await until(() => !!row(AGENT)), "раскрыть модель → под ней агент этой модели");
  ok(level(AGENT) === level(MODEL) + 1, `агент — уровнем ниже модели (${level(AGENT)})`);
  ok(parentOf(AGENT) === MODEL, "строка-родитель агента — его модель");
  row(CLOUD).querySelector(".tw").click();
  ok(await until(() => !!row(REPORT)), "раскрыть вторую модель → её агент");
  ok(parentOf(REPORT) === CLOUD && parentOf(AGENT) === MODEL, "агент другой модели — под своей моделью, а не под этой");

  // Строка открывает карточку объекта
  row(AGENT).click();
  ok(await until(() => sel === AGENT && document.getElementById("main").textContent.includes("Агент поддержки")), "клик по строке открывает карточку агента");

  // Раскладка по родителю: шаги под конвейером
  setSlice("lay:agent.pipelines");
  ok(await until(() => !!row(PIPE)), "конвейер в дереве");
  if (!row(STEP)) row(PIPE).querySelector(".tw").click();
  ok(await until(() => !!row(STEP)), "раскрыть конвейер → под ним шаги");
  ok(level(STEP) === level(PIPE) + 1, "шаг — уровнем ниже конвейера");
  ok(!row(MODEL), "в срезе конвейеров моделей нет");

  // Переход по ссылке в срезе своей раскладки: место цели раскрывается в этой раскладке, строка выбрана
  setSlice("lay:agent.models");
  open.delete(MODEL); renderTree();
  ok(await until(() => !!row(MODEL) && !row(AGENT)), "модель свёрнута");
  openNode(AGENT, { app: "hw" });
  ok(await until(() => row(AGENT)?.classList.contains("on")), "переход к агенту раскрывает его модель, строка агента выбрана");
  ok(slice === "lay:agent.models", "переход не меняет срез своей раскладки");
  // Ветки ещё не прочитаны (как при входе по ссылке): место — по GET /tree/paths и чтению веток цепочки
  openNode(domains[0].id, { app: "hw" });
  treeReset(); open.delete(MODEL); renderTree();
  ok(await until(() => !!row(MODEL) && !row(AGENT)), "ветки перечитаны, модель свёрнута");
  openNode(AGENT, { app: "hw" });
  ok(await until(() => row(AGENT)?.classList.contains("on")), "переход к агенту по непрочитанным веткам раскрывает его модель");
  // Цели в этой раскладке нет (конвейер не лежит «по моделям») — срез, где она есть
  openNode(PIPE, { app: "hw" });
  ok(await until(() => row(PIPE)?.classList.contains("on")), "переход к конвейеру из среза моделей находит его строку: срез " + slice);
  ok(slice === "lay:agent.pipelines", "переход ведёт в срез, где цель есть: " + slice);

  // Код с точкой и дефисом переживает смену среза и перерисовку
  setSlice("all"); setSlice("lay:agent.models");
  ok(slice === "lay:agent.models", "срез с точкой в коде переживает смену среза");
  renderTree(); aside();
  ok(chip("lay:agent.models")?.classList.contains("on") && slice === "lay:agent.models", "срез переживает перерисовку");
  ok(await until(() => !!row(AGENT)), "раскрытие модели — за срезом: после возврата агент снова виден");
  // Подсказка кнопки и значок в поиске по разделам — от системы; без подсказки — подпись
  ok((chip("lay:agent.models").title||chip("lay:agent.models").dataset.tip) === "По моделям", "без hint подсказка кнопки — подпись раскладки: " + (chip("lay:agent.models").title||chip("lay:agent.models").dataset.tip));
  const declared = TREE_LAYOUTS;
  layoutsApply(declared.map((l) => (l.id === "agent.models" ? Object.assign({}, l, { hint: { text: "Модель → агенты" }, icon: "server" }) : l)));
  aside();
  ok((chip("lay:agent.models")?.title||chip("lay:agent.models")?.dataset.tip) === "Модель → агенты", "подсказка кнопки — hint раскладки: " + (chip("lay:agent.models")?.title||chip("lay:agent.models")?.dataset.tip));
  const jumpSlice = jumpSources.flatMap((f) => { try { return f(); } catch (e) { return []; } }).find((x) => x.kind === "Срез" && x.title === "По моделям");
  ok(jumpSlice?.icon === "server", "значок среза в поиске по разделам — icon раскладки: " + jumpSlice?.icon);
  // Система объявила пустой список раскладок: кнопок срезов нет, кнопки «undefined» нет
  layoutsApply([]);
  aside();
  const bar = [...document.querySelectorAll("#aside .ph-slices button, #aside .ph-tail .ph-choice[data-slice], #aside [data-slice]")].map((b) => b.textContent).join("|");
  ok(!/undefined/.test(document.getElementById("aside").textContent) && !document.querySelector("#aside [data-slice]"), "layouts: [] — кнопок срезов нет и нет «undefined»: " + bar);
  layoutsApply(declared);
  treeReset(); aside();
  ok(await until(() => (chip("lay:agent.models")?.title||chip("lay:agent.models")?.dataset.tip) === "По моделям"), "раскладки вернулись");
  setSlice("lay:unknown");
  ok(slice === "lay:agent.models", "необъявленная раскладка — срез не меняется");
  // Поиск в своей раскладке находит объект в непрочитанной ветке, а не «Ничего не найдено» по прочитанному
  setSlice("lay:agent.models");
  treeReset(); open.delete(MODEL); open.delete(CLOUD); renderTree();
  ok(await until(() => !!row(MODEL) && !row(REPORT)), "ветки моделей не прочитаны");
  setTreeQ("Агент отчётов");
  ok(await until(() => !!row(REPORT)), "поиск находит агента в непрочитанной ветке: " + treeRowsText().slice(0, 200));
  ok(!/Ничего не найдено/.test(treeRowsText()), "нет «Ничего не найдено», когда совпадение есть");
  ok(!!row(CLOUD) && !row(MODEL) && !row(LOOSE), "поиск сужает срез: видна только ветка совпадения");
  setTreeQ("Такого объекта нет");
  ok(await until(() => /Ничего не найдено/.test(treeRowsText())), "нет совпадений — «Ничего не найдено»");
  setTreeQ("");
  ok(await until(() => !!row(MODEL) && !!row(LOOSE)), "поиск снят — строки вернулись");
  // Статус сужает срез своей раскладки: «Выключен» — только агент без модели
  pickStatus("off");
  ok(await until(() => !!row(LOOSE) && !row(MODEL) && !row(CLOUD)), "статус «выключен» сужает срез: " + treeRowsText().slice(0, 200));
  pickStatus("");
  ok(await until(() => !!row(MODEL) && !!row(LOOSE)), "статус снят — модели снова видны");

  // Перебор срезов при переходе не спрашивает места в своей раскладке, где узла цели нет: ответ там отбрасывается.
  // Система без «папок» (среза «Оборудование» нет), цель — инструмент, которого нет ни в одной своей раскладке
  {
    const declared = TREE_LAYOUTS;
    layoutsApply(declared.filter((l) => l.id !== "folders"));
    setSlice("lay:agent.pipelines"); treeReset(); aside();
    ok(!chip("all") && slice === "lay:agent.pipelines", "без folders среза «Оборудование» нет: " + slice);
    const realGet = API.get, asked = [];
    API.get = function (path, params) { if (path === "/tree/paths" && params && params.layout === "agent.models") asked.push(params.ids); return realGet.apply(this, arguments); };
    try {
      openNode(TOOL, { app: "hw" });
      await until(() => sel === TOOL);
      await new Promise((r) => setTimeout(r, 1500));
    } finally { API.get = realGet; layoutsApply(declared); treeReset(); setSlice("all"); aside(); }
    ok(asked.length <= 1, "место в чужой своей раскладке спрошено один раз (layElsewhere), а не на каждом переборе: " + asked.length);
  }

  // Вход по ссылке #node=…&slice=lay:agent.models: срез открывается после kindsLoad, строка цели выбрана
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;width:1200px;height:800px;left:-3000px;top:0;border:0";
  f.src = new URL(`${location.pathname}?fixture=agents#node=${AGENT}&slice=lay:agent.models`, location.href).href;
  document.body.appendChild(f);
  try {
    const w = () => f.contentWindow;
    // Срез копии — по нажатой кнопке среза в шапке дерева, без eval: консоль VMS отдаёт страницу под CSP без unsafe-eval
    const frameSlice = () => f.contentDocument?.querySelector('#aside .ph-choice[data-slice][aria-pressed="true"]')?.dataset.slice || "";
    ok(await until(() => w()?.appReady && frameSlice() === "lay:agent.models" && !!f.contentDocument.querySelector(`#tree .n.on[data-pick="${AGENT}"]`), 60000), "ссылка со срезом lay:agent.models открывает срез и строку агента: " + frameSlice());
  } finally { f.remove(); }
  setSlice("all");

  // Разделы приложения объявляет система: GET /reference → capabilities.sections. Без поля — прежние разделы по операциям
  if (typeof appsFor !== "function") { absent("разделов от системы (appsFor)"); return; }
  goApp("hw");
  // Старый бэкенд без sections: рельс — прежние разделы по операциям (appsShown при CAPS_SECTIONS = null)
  {
    const declared = CAPS_SECTIONS;
    CAPS_SECTIONS = null;
    let old;
    try { old = appsShown().map((a) => a.id).join(); } finally { CAPS_SECTIONS = declared; }
    ok(appsFor(null, can).join() === old && /^hw,rules,acc,sys,log(,learn)?$/.test(old), "без sections — прежние разделы: " + old);
  }
  ok(appsFor(CAPS_SECTIONS, can).join() === "hw,rules,acc,log", "разделы agents: " + appsFor(CAPS_SECTIONS, can).join());
  ok(appsFor([{ id: "automation" }], () => false).length === 0, "раздел без своих операций не виден");
  ok(appsFor([{ id: "unknown.section" }, { id: "access" }], can).join() === "acc", "незнакомый код раздела пропущен");
  paint();
  const rail = [...document.querySelectorAll("#rail .asw")].map((b) => b.textContent.trim());
  ok(rail.join() === "Агенты,Автоматизация,Права,Журнал", "рельс: " + rail.join());
  ok(!/Оборудование|Экспорт|Опции|Обучение/.test(document.getElementById("rail").textContent), "разделов VMS на рельсе нет");
  goApp("sys"); ok(app === "hw", "необъявленный раздел не открывается: " + app);
  // Внутренние переходы идут через ту же охрану: система без objects и settings — ни переход к объекту, ни ссылка
  // #opt=…, ни прямой setApp не открывают скрытый раздел
  {
    const declared = CAPS_SECTIONS, hash = location.hash;
    CAPS_SECTIONS = [{ id: "automation" }, { id: "journal" }];
    try {
      setApp("rules");
      openNode(AGENT, { app: "hw" }); ok(app === "rules", "openNode не открывает необъявленный раздел: " + app);
      setApp("hw"); ok(app === "rules", "setApp не открывает необъявленный раздел: " + app);
      ruleGoDevice(AGENT); ok(app === "rules", "переход к объекту из правила не открывает необъявленный раздел: " + app);
      history.replaceState(null, "", location.pathname + location.search + "#opt=ntp");
      applyDeepLink(); ok(app === "rules", "ссылка #opt= не открывает необъявленные «Опции»: " + app);
    } finally { history.replaceState(null, "", location.pathname + location.search + hash); CAPS_SECTIONS = declared; setApp("hw"); }
    ok(app === "hw", "разделы вернулись: " + app);
  }
  // Переходы в «Автоматизацию» и «Экспорт» проверяют ответ setApp: раздел не объявлен — ни правило, ни мастер, ни вкладка
  // не меняются
  {
    const declared = CAPS_SECTIONS, was = { rule, tab };
    CAPS_SECTIONS = [{ id: "objects" }, { id: "journal" }];
    try {
      setApp("hw");
      hdModeGo(); ok(app === "hw" && rule === was.rule && tab === was.tab, "hdModeGo без «Автоматизации» — на месте: " + [app, rule, tab].join());
      ruleGoRule((rules[0] || {}).id || "overview"); ok(app === "hw" && rule === was.rule && tab === was.tab, "ruleGoRule без «Автоматизации» — на месте: " + [app, rule, tab].join());
      camRecSchOpen("x"); ok(app === "hw" && rule === was.rule, "camRecSchOpen без «Автоматизации» — на месте: " + [app, rule].join());
      ruleFromLog("движение"); ok(app === "hw" && !document.querySelector("#bmodal.open"), "ruleFromLog без «Автоматизации» — мастер не открыт");
    } finally { closeBulkModal(); CAPS_SECTIONS = declared; setApp("hw"); }
  }
  ok(appLabel("hw") === "Агенты" && appLabel("rules") === "Автоматизация", "подпись раздела — label системы, без него — подпись консоли");
  {
    const noEn = [...CAPS_SECTIONS.map((s) => s.label?.text), ...TREE_LAYOUTS.flatMap((l) => [l.label?.text, l.hint?.text]), ...[...KINDS.values()].map((k) => k.label?.text)].filter((t) => t && !(window.I18N_EN || {})[t]);
    ok(!noEn.length, "подписи разделов, раскладок и видов agents — с английским: " + ([...new Set(noEn)].join(" | ") || "все"));
  }
  ok(/^Агенты/.test(navTitle()), "заголовок раздела — подпись системы: " + navTitle());
  await until(() => chip("all"));
  ok(chip("all")?.textContent.includes("Агенты"), "срез «все» — подписью раздела: " + chip("all")?.textContent);
  // Страницы «Опций» — по видам и операциям системы
  ok(typeof sysPageShown === "function" && !sysPageShown({ id: "ptz" }) && !sysPageShown({ id: "export" }) && sysPageShown({ id: "ntp" }), "страницы «Опций» VMS на agents не видны, общие — видны");
  ok(!sysOpts.some((o) => ["keys", "ptz", "cloud", "maps", "alarm", "export", "lic"].includes(o.id)), "sysOpts без страниц VMS: " + sysOpts.map((o) => o.id).join());
  // Система объявила пустой список разделов: рельс пуст, рабочая область это говорит
  {
    const declared = CAPS_SECTIONS;
    CAPS_SECTIONS = [];
    try {
      paint();
      ok(!document.querySelector("#rail .asw") && /Система не объявила ни одного раздела/.test(document.getElementById("main").textContent), "sections: [] — разделов нет, текст в рабочей области");
    } finally { CAPS_SECTIONS = declared; paint(); }
    ok(document.querySelectorAll("#rail .asw").length === 4, "разделы вернулись");
  }

  // Карточка рабочего пространства: область найдена по core.domain/1, вкладки VMS (устройства, серверы, лицензии,
  // топология) — только при условиях DOMAIN_TAB_NEEDS, а на agents их нет
  goApp("hw");
  ok(domains.length > 0 && handOf(domains[0], "domain") && (KINDS.get(nodeKind(domains[0]))?.implements || []).includes("core.domain/1"), "область — по core.domain/1: " + domains.map((d) => nodeKind(d)).join());
  pick(domains[0].id);
  ok(await until(() => sel === domains[0].id && !!document.querySelector("#main .tabs, #main .hd")), "карточка рабочего пространства открыта");
  const domTabs = tabsFor(find(domains[0].id).n).map(([id]) => id);
  ok(domTabs.every((id) => ["flds", "gen"].includes(id)), "вкладки области — только папки и общие: " + domTabs.join());
  const vmsTabs = /Серверы|Устройства|Лицензии|Топология/;
  ok(!vmsTabs.test(document.getElementById("rail").textContent), "на рельсе нет вкладок VMS");
  ok(!vmsTabs.test(document.querySelector("#main .tabs")?.textContent || ""), "в шапке карточки нет вкладок VMS: " + (document.querySelector("#main .tabs")?.textContent || ""));
  // «Общие» области: имя и папки остаются, плиток серверов, устройств и лицензий VMS нет, кнопок их добавления нет
  goTab("gen");
  const mainText = () => document.getElementById("main").textContent;
  ok(await until(() => /Папок/.test(mainText())), "«Общие» области: плитка «Папок» на месте");
  const cardHeads = [...document.querySelectorAll("#main .card .ch")].map((h) => h.textContent.trim());
  ok(cardHeads.includes("Рабочее пространство") && !cardHeads.includes("Домен"), "блок области — подписью вида, а не «Домен»: " + cardHeads.join(" | "));
  const vmsTiles = /Серверов|Нераспределённых|Служб на серверах|Сетевых хранилищ|Устройств|Лицензии камер|Лицензий камер|Ключ домена|Серийный номер лицензии/;
  ok(!vmsTiles.test(mainText()), "в «Общих» нет плиток и полей VMS: " + (mainText().match(vmsTiles) || [""])[0]);
  const btns = () => [...document.querySelectorAll("#main button")].map((b) => b.textContent.trim());
  ok(!btns().some((t) => /^Серверы$|Добавить устройства|Добавить серверы|Создать хранилище/.test(t)), "кнопок добавления серверов, устройств, хранилищ нет: " + btns().filter((t) => /Сервер|Добавить|хранилищ/.test(t)).join(" | "));
  ok(!canInspectorAdd(domains[0]) && addSplitItems(domains[0]).length === 0, "у области нет «Добавить серверы» и пунктов «Серверы…»");
  // Меню строки области и папки — без пунктов VMS
  const ctxText = (n) => { openTreeCtx(n, { x: 10, y: 10 }); const t = document.getElementById("tctx").textContent; closeTreeCtx(); return t; };
  const domCtx = ctxText(domains[0]);
  ok(!/Добавить устройства|Добавить серверы/.test(domCtx) && /Создать папку/.test(domCtx), "меню области — без устройств и серверов: " + domCtx);
  const fld = folders.find((x) => x.domainId === domains[0].id) || folders[0];
  ok(!!fld && !/Добавить устройства/.test(ctxText(fld)), "меню папки — без «Добавить устройства»");
  pick(fld.id);
  ok(await until(() => sel === fld.id), "карточка папки открыта");
  await new Promise((r) => setTimeout(r, 300));
  ok(!btns().some((t) => /Добавить в папку|Добавить устройства/.test(t)), "у папки нет «Добавить в папку»: " + btns().filter((t) => /Добавить/.test(t)).join(" | "));

  // Справочники VMS и каталог правил — из описаний видов и каталога справочника (контракт 0.30.0, 0.31.0; ключи reference
  // сняты в 0.32.0). У оркестратора их нет: списков VMS нет, а редактор правил предлагает только объявленное — HTTP-запрос, запуск
  // правила и команды видов, без «Открыть раскладку». Страница со старым autoRef(ref) — проверять нечего
  if (typeof autoRef !== "function" || autoRef.length < 2) { absent("справочников из описаний видов (autoRef(ref, kinds))"); return; }
  autoRef(REF_LAST, KINDS);
  try {
    const vmsLists = { DEVICE_MODELS: Object.keys(DEVICE_MODELS), refLabels, DET_AK_CLASH: Object.keys(DET_AK_CLASH), RULE_LAYOUTS, RULE_MONS, refScenKinds: refScenKinds || [], REF_LAYOUT: [...REF_LAYOUT], REF_MONITOR: [...REF_MONITOR] };
    const full = Object.entries(vmsLists).filter(([, v]) => v.length).map(([k]) => k);
    ok(!full.length && !EXP_REF, "списки VMS на agents пусты: " + (full.join() || "все") + (EXP_REF ? ", EXP_REF" : ""));
    const offered = ACTION_KINDS.filter(actDeclared);
    const has = (sub, action) => offered.some((k) => k.sub === sub && k.action === action);
    ok(has("net", "http") && has("rule", "runrule"), "редактор правил предлагает net.http и rule.runrule: " + offered.map((k) => `${k.sub}.${k.action}`).join());
    ok(offered.some((k) => k.unit && k.gen && (k.kinds || []).includes("agent.agent")), "и команды объектов (unitAction) — из описаний видов: " + offered.filter((k) => k.unit).map((k) => k.action).join());
    ok(!has("client", "layout") && !offered.some((k) => k.sub === "client"), "«Открыть раскладку» и действия клиента VMS не предлагаются");
    const sel = stepKindSel({ sub: "net", action: "http" }, "0", 0, 1);
    ok(!sel.includes(i18n("Открыть раскладку")) && !sel.includes(i18n("Показать на видеостене")), "в списке вида пункта нет «Открыть раскладку» и видеостены");
    ok(!ruleAreaOff("folder") && !ruleAreaOff("domain") && ruleAreaOff("server"), "области цели — ruleTargets.areas: папка и рабочее пространство, сервера нет");
    // Строка условия в трассе: код хука профиля notSupported и незнакомый код — не «камера … на охране»
    const why = fireWhy({ code: "cond.devices", params: { items: [{ deviceId: AGENT, code: "notSupported" }, { deviceId: AGENT, code: "agent.busy" }] } }, {});
    ok(!/охран/.test(why) && /не проверяет это условие/.test(why) && /agent\.busy/.test(why) && /Агент поддержки/.test(why), "cond.devices: notSupported — своим текстом, незнакомый код — как есть: " + why);
  } finally { autoRef(REF_LAST, KINDS); }
});
