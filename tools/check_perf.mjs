#!/usr/bin/env node
/* Сценарий tools/check_perf.py: скорость интерфейса в настоящем времени, на стенде large (или xl: --fixture xl, 4 домена — шаги по первому).

   check_ui.py и check_scale.py идут в виртуальном времени (--virtual-time-budget) и секунд не видят. Здесь страница
   открывается в headless Chrome по CDP без виртуального времени, шаги — те же функции страницы, что в сценариях
   tests/scale-large.js и tests/ui-*.js, ввод — настоящими клавишами (Input.dispatchKeyEvent).

   У каждого шага есть ожидание (expect): что должно стать на странице — группировка, срез, карточка нужного объекта,
   вкладка, отметки, результат поиска для набранного текста, новые состояния 100 камер, и полнота: дерево и карточка
   перерисованы, нет «Загрузка», на месте строки всех серверов (папок). Шаг ждёт, пока ожидание держится И страница
   стихла: 1 с без запросов, долгих задач и заметной занятости главного потока. Конец шага — кадр после последней работы
   до «тихо»: долгой задачи, запроса или отрезка между опросами, где поток занят больше WORK_SHARE (короткие задачи,
   отложенная или порезанная на куски дорисовка), и не раньше, чем сбылось ожидание.
   Ожидание не сбылось до сторожа — шаг FAIL с причиной, а не PASS.
   На каждый шаг: время, самая длинная задача главного потока, занятость главного потока за шаг до его конца (сумма
   всех задач, Performance.getMetrics TaskDuration). Для ввода время — результат: от последней клавиши до конца шага
   (кадр с результатом для всего текста, после последней работы), и отдельно отклик буквы — самая долгая буква от
   клавиши до кадра, на котором она видна в поле. Пределы — LIMITS ниже, умноженные на множитель машины (калибровка в
   той же сессии Chrome, что и шаги). Медиана N прогонов, сторож.

   Запуск — через tools/check_perf.py; напрямую: node tools/check_perf.mjs --root DIR [--page FILE] [--chrome PATH]
   [--runs N | --quick] [--steps a,b] [--behavior] [--fixture large|xl|""] [--timeout С] [--json FILE] [--cpu N]
   --behavior — только проверки поведения ввода (шаги BEHAVE_STEPS): путь с паузой в наборе, настоящими клавишами
   Код выхода 1, если хоть один шаг за пределом, не выполнен или упал хотя бы в одном прогоне; 2 — неверные параметры. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Пределы, мс ────────────────────────────────────────────────────────────
// Цель после починки, по мерке «интерфейс отвечает»: столько оператор ждёт, не теряя нити. Откуда числа:
// - click 300 — клик или открытие. Мгновенным ответ кажется до ~100 мс (RAIL), до ~300 мс он ещё воспринимается
//   как ответ на своё действие, дальше человек ждёт и теряет нить. 300 — верх этой полосы для тяжёлой формы
// - key 150 — отклик буквы ввода: от клавиши до кадра, где буква видна в поле. Эхо медленнее 100–150 мс заметно при
//   наборе, буквы «догоняют» палец
// - результат ввода — TYPE_PAUSE_MS + click: поиск и фильтр страница запускает после паузы в наборе, а после паузы
//   ответ — как на клик. Множитель машины — только на click: пауза — таймер, а не работа
// - task 200 — самая длинная задача главного потока: всё это время страница не отвечает на клик и клавишу.
//   У старта не проверяется (длинная задача старта — построение набора large во встроенном сервере, ~0,4 с: заглушка);
//   у грубых шагов равна их пределу — одна перерисовка целиком им разрешена
// - stream 2000 — 100 событий связи камер разом: настоящий поток шлёт сотни в минуту, пачка обязана уложиться в секунды
// - flds 1000 — вкладка домена «Папки»: первая страница папок, как ветка дерева, а не чтение всего домена
// - load 2000 — старт до дерева, с которым можно работать, и до «тихо»
// - coarse 500 — грубые шаги, где перерисовывается тысяча и больше строк дерева: раскрыть сервер на 1 000 камер,
//   смена группировки и возврат в «Все» на 2 700 строк
// Занятость главного потока за шаг не больше предела времени шага (для ввода — отклик буквы × число букв и click на
// результат): работа, порезанная на короткие задачи или отложенная, всё равно занимает поток, пока оператор ждёт
const LIMITS = { click: 300, key: 150, task: 200, stream: 2000, flds: 1000, load: 2000, coarse: 500 };
// Пауза в наборе, после которой страница ищет, — TYPE_PAUSE_MS самой страницы: инструмент читает её после старта.
// Нет константы — страница ищет на каждую букву (index.html), пауза 0: результат — как клик, отклик буквы большой
const resultLimit = (factor, pause) => pause + LIMITS.click * factor;
// Калибровка: фиксированная работа JS и раскладки (CALIB ниже), медиана 7 повторов, в той же сессии Chrome, что и шаги:
// в начале и в конце каждого прогона. В счёт — медиана всех калибровок. Эталон — машина, на которой записаны пределы:
// 16 ядер, Linux (VMware), Chrome 157 headless=new, 2026-11-05: 351–380 мс. Множитель — отношение «эта / эталон»,
// без скачков: в полосе ±15 % (шум калибровки) — 1, дальше — отношение, поделённое на край полосы. Не больше 1,3: машина,
// которой нужно больше, занята, и ослаблять пределы нельзя — WARN, пределы ×1,3
const REF_CALIB_MS = 362;
const CALIB_NOISE = 0.15;
const FACTOR_MAX = 1.3;
// Сторож на шаг, с: шаг дольше — итог «> предела», сессия Chrome перезапускается, предыдущие шаги повторяются без замера.
// На xl (4 домена) тот же: у прототипа 28 шаги в него укладываются, самый долгий — «Отметить всё», ~15 с (api/TESTS.md, § 9)
const STEP_TIMEOUT_S = 20;
const QUIET_MS = 1000; // «тихо»: столько без запросов, долгих задач и занятости потока сверх простоя
const QUIET_BUSY_MS = 60; // занятость за последнюю секунду сверх простоя, при которой страница ещё считается тихой
// Между буквами — как у человека: 80–120 мс, берём середину. Меньше паузы страницы (TYPE_PAUSE_MS, 200 мс): посреди
// слова поиск не запускается. Пауза посреди слова — отдельный шаг search-pause
const KEY_GAP_MS = 100;
// Пауза посреди слова в шаге search-pause: дольше паузы страницы, поиск успевает начаться
const MID_PAUSE_MS = 400;
// Отрезок между двумя опросами (~0,1 с) — работа шага, если поток занят в нём больше WORK_SHARE сверх простоя и
// разметка в нём менялась не раз (дорисовка порциями), или занят больше WORK_FULL (счёт без разметки). Фон слабее
// (события потока, таймеры заглушки) и CSS-анимация без правки разметки (вспышка «пришли сюда» на большом дереве без
// GPU занимает до 45 % потока, но кадры идут) — не работа
const WORK_SHARE = 0.3, WORK_FULL = 0.8;

// ── Параметры ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, def) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--" + name && i + 1 < argv.length) return argv.splice(i, 2)[1];
    if (argv[i].startsWith("--" + name + "=")) return argv.splice(i, 1)[0].slice(name.length + 3);
  }
  return def;
}
const flag = (name) => (argv.includes("--" + name) ? (argv.splice(argv.indexOf("--" + name), 1), true) : false);
function usage(msg) {
  console.log(msg);
  console.log("RESULT fail");
  process.exit(2);
}
const ROOT = path.resolve(opt("root", path.dirname(path.dirname(new URL(import.meta.url).pathname))));
const PAGE = opt("page", "index.html");
const CHROME = opt("chrome", "google-chrome");
const FIXTURE = opt("fixture", "large");
const QUICK = flag("quick");
const BEHAVIOR = flag("behavior"); // только проверки поведения ввода (шаги behave), без замера скорости
const RUNS = QUICK ? 1 : Math.max(1, +opt("runs", 3) || 3);
const ONLY = (opt("steps", "") || "").split(",").filter(Boolean);
const TIMEOUT_MS = (+opt("timeout", STEP_TIMEOUT_S) || STEP_TIMEOUT_S) * 1000;
const JSON_OUT = opt("json", "");
const CPU = +opt("cpu", 0) || 0; // Emulation.setCPUThrottlingRate: проверка калибровки на «медленной машине»
if (argv.length) usage("Неизвестные параметры: " + argv.join(" "));
if (!fs.existsSync(path.join(ROOT, PAGE))) usage("Нет страницы " + path.join(ROOT, PAGE));

// ── Шаги ───────────────────────────────────────────────────────────────────
// prep — выражения до замера (каждое — до «тихо»; там же отводим страницу от целевого состояния, чтобы шаг не прошёл
// вхолостую), act — выражение замера (выполняется задачей setTimeout, как обработчик клика), type — набор keys
// настоящими клавишами в поле field (applied — запрос, который страница применила; box — где рисуется результат),
// expect — список [условие, причина]: условие — выражение страницы, true или строка-причина от помощников __perf.
// post — уборка без замера. replay:false — шаг не повторяется при перезапуске сессии. Шаги идут по порядку одной
// сессией: состояние каждого — итог предыдущих, как у оператора. limit — ключ LIMITS
// Шаги идут по первому домену. На xl доменов четыре по 250 000 камер и 500 серверов (stand.large.domains): меряется домен
// размером с large, а склад и прочие домены — фоном (старт, поиск по всем доменам, итог круга)
const S0 = `domains[0].servers[0].id`;
const D0 = `domains[0].id`;
const ROWS = `document.querySelectorAll("#tree .n[data-pick]").length`;
// Полнота дерева: все серверы домена (в группировке «Серверы» их строки видны во всех срезах, кроме «Хранилищ») и все
// папки (в группировке «Папки»)
const ALL_SRV = [`__perf.allIn(domains[0].servers)`, "в дереве не все серверы домена"];
// Папки кэша — первого домена всегда и других раскрытых доменов. Большой домен страница по умолчанию держит свёрнутым
// (xl: 4 домена), у свёрнутого строк папок нет. Первый домен — якорь: свёрнут он — шаг не проходит (FLD_OPEN), а пустой
// отбор не даёт пройти вхолостую
const ALL_FLD = [`__perf.allIn(folders.filter(f=>{const d=folderDomain(f.id);return d===domains[0].id||open.has(d)}))`, "в дереве не все папки первого и раскрытых доменов"];
const FLD_OPEN = [`open.has(domains[0].id)`, "первый домен свёрнут"];
const sliceStep = (id, title, v, other, full) => ({
  id, title, limit: "click", prep: [`if(slice===${JSON.stringify(v)})setSlice(${JSON.stringify(other)})`], act: `setSlice(${JSON.stringify(v)})`,
  expect: [[`slice===${JSON.stringify(v)}`, `срез не «${v}»`], [`__perf.treeDone()`, "дерево"], ...(full ? [[`group()!=="server"||(${full[0]})`, full[1]]] : [])],
});
// ── Проверки поведения ввода (behave) ───────────────────────────────────────
// Сценарии tests/ui-*.js шлют синтетический input (isTrusted=false), и страница применяет его сразу: путь с паузой в
// наборе (typeLater, Enter, Esc, крестик, уход из поля, стрелки, волна прежнего текста) проверяют только эти шаги —
// настоящими клавишами и мышью по CDP. ops — по порядку: type (буквы с KEY_GAP_MS, без паузы после последней), key
// (Enter, Escape, ArrowDown, Backspace, Tab), click (селектор — настоящая мышь в центр), sleep, run (выражение),
// check ([условие, причина] — в этот миг, иначе шаг FAIL с причиной). expect — итог после «тихо», как у прочих шагов.
// Время не ограничено: шаг проверяет поведение. Идут и на demo, и на large; отдельно — ключ --behavior
const GQ = `document.getElementById("gq")`;
const POP = `document.getElementById("gopop").classList.contains("open")`;
const HAS_DELAY = `if(typeof typeLater!=="function")throw new Error("на странице нет поиска после паузы (typeLater)")`;
const gqPrep = [HAS_DELAY, `if(app!=="hw")goApp("hw");clearTreeQ();goClose();${GQ}.focus()`];
const gqPost = [`clearTreeQ();goClose();${GQ}.blur()`];
const MARK = { run: `__perf.mark=performance.now()` };
const behave = (id, title, ops, expect, extra = {}) => Object.assign({ id, title, limit: "behave", replay: false, behave: true, ops, expect, prep: gqPrep, post: gqPost }, extra);
const BEHAVE_STEPS = [
  behave("gq-pause", "поиск: буква сразу, поиск после паузы", [
    MARK, { type: "Кам" },
    { check: [`${GQ}.value==="Кам"&&treeQ===""&&typePending("gq")`, "сразу после набора: в поле не набранное, или запрос уже применён, или поиск не ждёт паузы"] },
    { check: [`__perf.mutTree<__perf.mark`, "дерево перерисовано до паузы"] },
    { sleep: 400 },
    { check: [`treeQ==="Кам"&&!typePending("gq")&&${POP}`, "через паузу запрос не применён или списка нет"] },
  ], [[`treeQ==="Кам"`, "запрос"]]),
  // Без ассистента: Enter — «набранное — фильтр»
  behave("gq-enter", "поиск: Enter — сразу", [
    { type: "Кам" }, { check: [`typePending("gq")`, "поиск не ждёт паузы"] }, { key: "Enter" },
    { check: [`treeQ==="Кам"&&!typePending("gq")&&!${POP}`, "Enter не применил запрос сразу или список открыт"] },
  ], [[`treeQ==="Кам"`, "запрос"]], {
    prep: [...gqPrep, `window.__perfCan=can;can=(k,...a)=>k==="feature:assist"?false:__perfCan(k,...a)`],
    post: [`can=__perfCan;delete window.__perfCan`, ...gqPost],
  }),
  // С ассистентом Enter начинает разговор, запрос поиска снимается: отложенный поиск не должен прийти после. Без
  // ассистента (на one-domain его нет: feature:assist) шаг не выполняется: итог «не проверялось», ни PASS, ни FAIL
  behave("gq-enter-asst", "поиск: Enter к ассистенту", [
    { type: "Кам" }, { key: "Enter" },
    { check: [`!can("feature:assist")||(!typePending("gq")&&treeQ===""&&${GQ}.value===""&&asstDockOpen)`, "Enter: нет разговора или запрос не снят"] },
    { sleep: 400 },
    { check: [`!can("feature:assist")||treeQ===""`, "после паузы отложенный поиск всё же пришёл"] },
  ], [[`!can("feature:assist")||treeQ===""`, "запрос"]], { post: [`if(asstDockOpen)asstClose()`, ...gqPost], skipIf: `!can("feature:assist")&&"нет ассистента"` }),
  behave("gq-esc", "поиск: Esc во время паузы", [
    { type: "Ка" }, { key: "Escape" },
    { check: [`treeQ==="Ка"&&!typePending("gq")&&!${POP}&&${GQ}.value==="Ка"`, "первый Esc: дерево не сужено набранным или список открыт"] },
    { key: "Escape" },
    { check: [`treeQ===""&&${GQ}.value===""`, "второй Esc не снял запрос"] },
    { sleep: 400 },
    { check: [`treeQ===""&&!${POP}`, "после паузы запрос или список вернулись"] },
  ], [[`treeQ===""`, "запрос"]]),
  behave("gq-clear", "поиск: крестик во время паузы", [
    { type: "Кам" }, { click: "#goClear" }, { sleep: 400 },
    { check: [`treeQ===""&&${GQ}.value===""&&!typePending("gq")`, "после крестика пришёл отложенный поиск"] },
  ], [[`treeQ===""`, "запрос"]]),
  behave("gq-leave", "поиск: уход из поля во время паузы", [
    { type: "Кам" }, { key: "Tab" },
    { check: [`document.activeElement!==${GQ}`, "Tab не увёл фокус из поля"] },
    { sleep: 400 },
    { check: [`treeQ==="Кам"&&!${POP}`, "ушёл из поля: дерево не сужено или список прежнего текста открыт"] },
  ], [[`treeQ==="Кам"`, "запрос"]]),
  behave("gq-arrow", "поиск: стрелка во время паузы", [
    { type: "Кам" }, { key: "ArrowDown" },
    { check: [`treeQ==="Кам"&&!typePending("gq")`, "стрелка не применила набранное сразу"] },
    { check: [`!${POP}||goNav`, "стрелка не ходит по списку"] },
  ], [[`treeQ==="Кам"`, "запрос"]]),
  // Волна поиска на каждой странице зовёт filtPaint (дерево и шапка фильтра). Пока новый текст ждёт паузы, волна
  // прежнего текста дерево не перерисовывает и набранное не стирает
  behave("gq-wave", "поиск: волна прежнего текста во время паузы", [
    MARK, { type: "е" }, { run: `filtPaint();updateFiltChrome()` },
    { check: [`treeQ==="Кам"&&__perf.mutTree<__perf.mark`, "волна прежнего текста перерисовала дерево"] },
    { check: [`${GQ}.value==="Каме"`, "перерисовка шапки стёрла набранное"] },
    { sleep: 400 },
    { check: [`treeQ==="Каме"`, "после паузы новый текст не применён"] },
  ], [[`treeQ==="Каме"`, "запрос"]], {
    prep: [...gqPrep, `goInput("Кам");${GQ}.focus();${GQ}.setSelectionRange(3,3)`],
  }),
  behave("lan-keys", "фильтр «Устройства»: пауза, Enter, очистка", [
    MARK, { type: "Кам" },
    { check: [`lan.q==="Кам"&&typePending("lan")&&__perf.mutMain<__perf.mark`, "во время паузы список перерисован или фильтр не ждёт"] },
    { key: "Enter" },
    { check: [`!typePending("lan")&&__perf.mutMain>__perf.mark`, "Enter не применил фильтр сразу"] },
    { sleep: 100 },
    { check: [`document.activeElement?.id==="lanQ"`, "курсор не вернулся в поле"] },
    { key: "Backspace" }, { key: "Backspace" }, { key: "Backspace" },
    { check: [`lan.q===""&&!typePending("lan")`, "очистка поля не применилась сразу"] },
  ], [[`lan.q===""`, "фильтр"], [`__perf.mainDone()`, "карточка"]], {
    prep: [HAS_DELAY, `goApp("hw")`, `pick(${S0},{force:true})`, `goTab("cams")`, `lanSetQ("")`, `document.getElementById("lanQ").focus()`],
    post: [`lanSetQ("")`],
  }),
  // Окно закрыли, пока ждали паузы: перерисовка по таймеру не должна открыть его снова
  behave("cp-esc", "окно «Применить настройки»: Esc во время паузы", [
    { type: "К" }, { key: "Escape" },
    { check: [`!document.getElementById("bmodal").classList.contains("open")`, "Esc не закрыл окно"] },
    { sleep: 400 },
    { check: [`!document.getElementById("bmodal").classList.contains("open")`, "окно открылось снова после паузы"] },
  ], [[`!document.getElementById("bmodal").classList.contains("open")`, "окно"]], {
    prep: [HAS_DELAY, `if(app!=="hw")goApp("hw")`,
      `{const n=devicePool.find(n=>n.type==="camera"&&cpCanCopy(n)&&cpCandidates(n).length>0);if(!n)throw new Error("нет камеры для копирования");openCopyDialog(n.id)}`,
      `{const i=document.querySelector("#bmodal.open .cp-sq input");if(!i)throw new Error("окно копирования не открылось");i.focus()}`],
    post: [`cp=null;closeBulkModal()`],
  }),
];
const STEPS = [
  {
    id: "load", title: "старт: дерево, с которым можно работать", limit: "load",
    expect: [[`window.appReadyDone`, "старт не закончен"], [`domains.length>0`, "нет доменов"], [`!!__perf.row(${D0})`, "нет строки домена"],
      [`${ROWS}>=10`, "в дереве меньше 10 строк"], [`!/Загрузка/.test(document.getElementById("tree").textContent)`, "дерево ещё грузится"],
      [`/\\d/.test(document.querySelector('#aside [data-slice="all"]')?.textContent||"")`, "в шапке среза нет числа объектов"]],
  },
  {
    id: "group-server", title: "группировка «Серверы»", limit: "click", prep: [`if(group()==="server")setGroup("folder")`], act: `setGroup("server")`,
    expect: [[`group()==="server"`, "группировка не «Серверы»"], [`__perf.treeDone()`, "дерево"], [`!!__perf.row(${S0})`, "нет строки сервера"],
      [`${ROWS}>domains[0].servers.length`, "строк меньше, чем серверов"], ALL_SRV],
  },
  {
    id: "server-expand", title: "раскрыть сервер (1 000 камер)", limit: "coarse", prep: [`if(open.has(${S0}))treeToggleId(${S0})`], act: `treeToggleId(${S0})`,
    expect: [[`open.has(${S0})`, "сервер не раскрыт"], [`__perf.treeDone()`, "дерево"],
      [`document.querySelectorAll('#tree .n[data-ctx="srv:'+${S0}+'"]').length>0`, "под сервером нет строк"]],
  },
  {
    id: "pick-camera", title: "открыть камеру", limit: "click",
    prep: [`{const id=[...document.querySelectorAll('#tree .n[data-pick][data-ctx="srv:'+${S0}+'"]')].map(e=>e.dataset.pick).find(id=>devicePool.some(n=>n.id===id&&n.type==="camera"&&id!==sel));if(!id)throw new Error("нет камеры под сервером");window.__perfCam={id,name:devicePool.find(n=>n.id===id).name}}`],
    act: `__perf.row(__perfCam.id).click()`, expect: [[`__perf.card(__perfCam.id,__perfCam.name)`, "карточка камеры"]],
  },
  { id: "pick-server", title: "открыть сервер", limit: "click", act: `__perf.row(${S0}).click()`, expect: [[`__perf.card(${S0},domains[0].servers[0].name)`, "карточка сервера"]] },
  { id: "pick-domain", title: "открыть домен", limit: "click", act: `__perf.row(${D0}).click()`, expect: [[`__perf.card(${D0},domains[0].name)`, "карточка домена"]] },
  {
    id: "domain-cams", title: "вкладка домена «Устройства»", limit: "click", act: `goTab("cams")`,
    expect: [[`tab==="cams"`, "вкладка не «Устройства»"], [`__perf.card(${D0},null,"Устройства")`, "вкладка домена"]],
  },
  {
    id: "domain-folders", title: "вкладка домена «Папки»", limit: "flds", act: `goTab("flds")`, replay: false,
    expect: [[`tab==="flds"`, "вкладка не «Папки»"], [`__perf.card(${D0},null,"Папки")`, "вкладка домена"]],
  },
  {
    id: "pick-archive", title: "открыть хранилище", limit: "click", prep: [`window.__perfObj={id:arch[0].id,name:arch[0].name}`],
    act: `pick(__perfObj.id)`, expect: [[`__perf.card(__perfObj.id,__perfObj.name)`, "карточка хранилища"]],
  },
  {
    id: "pick-volume", title: "открыть том", limit: "click", prep: [`window.__perfObj={id:arch.find(a=>(a.vols||[]).length).vols[0].id}`],
    act: `pick(__perfObj.id)`, expect: [[`__perf.card(__perfObj.id,null)`, "карточка тома"]],
  },
  {
    id: "pick-folder", title: "открыть папку", limit: "click", prep: [`window.__perfObj={id:folders[0].id,name:folders[0].name}`],
    act: `pick(__perfObj.id)`, expect: [[`__perf.card(__perfObj.id,__perfObj.name)`, "карточка папки"]],
  },
  sliceStep("slice-cam", "срез «Камеры»", "cam", "all", ALL_SRV),
  sliceStep("slice-arch", "срез «Хранилища»", "arch", "all"),
  sliceStep("slice-all", "срез «Все»", "all", "cam", ALL_SRV),
  {
    id: "group-folder", title: "группировка «Папки»", limit: "click", prep: [`if(group()==="folder")setGroup("server")`], act: `setGroup("folder")`,
    expect: [[`group()==="folder"`, "группировка не «Папки»"], [`__perf.treeDone()`, "дерево"], FLD_OPEN, ALL_FLD],
  },
  {
    id: "group-server-big", title: "«Папки» → «Серверы» (2 700 строк)", limit: "coarse", prep: [`if(group()==="server")setGroup("folder")`], act: `setGroup("server")`,
    expect: [[`group()==="server"`, "группировка не «Серверы»"], [`__perf.treeDone()`, "дерево"], [`!!__perf.row(${S0})`, "нет строки сервера"], ALL_SRV],
  },
  {
    id: "slice-all-back", title: "возврат в «Все» (2 700 строк)", limit: "coarse", prep: [`setSlice("arch")`], act: `setSlice("all")`,
    expect: [[`slice==="all"`, "срез не «Все»"], [`__perf.treeDone()`, "дерево"], [`!!__perf.row(${D0})`, "нет строки домена"], ALL_SRV],
  },
  {
    id: "search-kamera", title: "поиск в дереве «Камера»", limit: "key", replay: false, keys: "Камера",
    type: { field: "gq", applied: "treeQ", box: "tree" }, prep: [`document.getElementById("gq").focus()`], post: [`clearTreeQ()`],
  },
  {
    id: "search-klaster", title: "поиск в дереве «Кластер»", limit: "key", replay: false, keys: "Кластер",
    type: { field: "gq", applied: "treeQ", box: "tree" }, prep: [`document.getElementById("gq").focus()`], post: [`clearTreeQ()`],
  },
  {
    id: "sel-on", title: "режим выбора вкл.", limit: "click", prep: [`if(selMode)setSelMode(false)`], act: `setSelMode(true)`,
    expect: [[`selMode===true`, "режим выбора не включён"], [`!document.getElementById("selBar").hidden`, "нет панели отметок"], [`__perf.treeDone()`, "дерево"]],
  },
  {
    id: "sel-all", title: "«Отметить всё»", limit: "click", act: `selectAllFiltered()`,
    expect: [[`treeSel.size>1`, "ничего не отмечено"], [`!!document.querySelector("#tree .n-chk.on,#tree .n-chk.part")`, "в дереве нет отметок"], [`__perf.treeDone()`, "дерево"]],
  },
  {
    id: "sel-panel", title: "групповая панель", limit: "click", prep: [`pick(${S0},{force:true})`], act: `bulkPeekOff()`,
    expect: [[`bulkPeek===false&&treeSel.size>1`, "панель не для выборки"], [`!!document.querySelector("#main .bk-hd-ic")`, "нет групповой карточки"], [`__perf.mainDone()`, "карточка"]],
  },
  {
    id: "sel-clear", title: "снять выбор", limit: "click", act: `clearTreeSel()`, post: [`setSelMode(false)`],
    expect: [[`treeSel.size===0`, "отметки остались"], [`!document.querySelector("#tree .n-chk.on,#tree .n-chk.part")`, "в дереве остались отметки"], [`__perf.treeDone()`, "дерево"]],
  },
  {
    id: "acc-enter", title: "«Права»: вход", limit: "click", act: `goApp("acc")`,
    expect: [[`app==="acc"`, "раздел не «Права»"], [`!!document.querySelector('#tree .n[data-go^="role:"]')`, "нет ролей в дереве"], [`__perf.treeDone()`, "дерево"], [`__perf.mainDone()`, "карточка"]],
  },
  {
    id: "acc-role", title: "«Права»: клик по роли", limit: "click",
    prep: [`{const r=document.querySelectorAll('#tree .n[data-go^="role:"]')[2];if(!r)throw new Error("нет строки роли");window.__perfRole={go:r.dataset.go,name:r.querySelector(".nm")?.textContent.trim()||""}}`],
    act: `document.querySelector('#tree .n[data-go="'+__perfRole.go+'"]').click()`,
    expect: [[`document.querySelector('#tree .n[data-go="'+__perfRole.go+'"]')?.classList.contains("on")`, "строка роли не выбрана"], [`__perf.mainDone()`, "карточка"],
      [`!__perfRole.name||(document.querySelector("#main .hd")?.textContent||"").includes(__perfRole.name)`, "в карточке не та роль"]],
  },
  {
    id: "server-filter", title: "фильтр «Устройства» сервера", limit: "key", replay: false, keys: "Камера 1",
    type: { field: "lanQ", applied: "lan.q", box: "main" },
    prep: [`goApp("hw")`, `pick(${S0},{force:true})`, `goTab("cams")`, `document.getElementById("lanQ").focus()`],
  },
  {
    id: "stream-100", title: "поток: 100 событий связи камер", limit: "stream", replay: false,
    // Камеры — видные в дереве: у них меняется строка, и поток следит за их веткой; без find()
    // Видных камер меньше 100 (demo) — раскрыть ещё серверы домена, чтобы пачка была пачкой
    prep: [`if(app!=="hw")goApp("hw")`, `if(__perf.camRows()<100){domains[0].servers.slice(0,20).forEach(x=>open.add(x.id));renderTree()}`, `__perf.burstPrep(100)`],
    act: `__perfBurst.forEach(([id,on])=>API.post("/test/events",{type:"device.signal",deviceId:id,online:on}).catch(e=>__perf.err=String(e&&e.status||e)))`,
    expect: [[`__perf.burstDone()`, "события не применены"]],
  },
  // Шаги, добавленные после задачи 3а, — в конце: перед замеряемыми шагами они не стоят и их чисел не сдвигают (кэш
  // после поиска, карточка, lan.q). Сравнение «до» и «после» по прежним шагам остаётся честным
  // Пауза посреди слова дольше паузы страницы: поиск по «Кам» уже идёт, когда приходят «ера». Отклик этих букв показывает,
  // ждёт ли буква поиск
  {
    id: "search-pause", title: `поиск «Кам», пауза ${MID_PAUSE_MS} мс, «ера»`, limit: "key", replay: false, keys: "Камера", pause: [3, MID_PAUSE_MS],
    type: { field: "gq", applied: "treeQ", box: "tree" }, post: [`clearTreeQ()`],
    // Шаг идёт после потока: тот на large упирается в сторожа, и после перезапуска страница стоит в «Правах» (последний
    // повторяемый шаг). Поиск меряется в «Оборудовании», как «Камера» и «Кластер»
    prep: [`if(app!=="hw")goApp("hw")`, `clearTreeQ();goClose()`, `document.getElementById("gq").focus()`],
  },
  // Журнал (контракт 0.8.0): на large 200 000 записей за 30 суток; отбор и счётчики — на сервере
  {
    id: "log-enter", title: "«Журнал»: вход (200 000 записей)", limit: "coarse", prep: [`goApp("hw")`, `pjRes=null;pjQ=pjQ0();pjaClearText()`], act: `goApp("log")`,
    expect: [[`app==="log"&&!!pjRes&&pjRes.total>0`, "нет записей журнала"], [`!!document.querySelector("#pjList .pj-r[data-id]")`, "нет строк списка"], [`!!document.querySelector("#tree .pjb-sec")`, "нет счётчиков слева"]],
  },
  {
    id: "log-filter", title: "«Журнал»: категория «Аудит»", limit: "coarse", prep: [`if(app!=="log")goApp("log")`, `pjQ=pjQ0();pjaClearText();pjPaint()`], act: `pjToggle("cats","audit")`,
    expect: [[`!!pjRes&&pjRes.p.level==="audit"&&pjRes.items.every(e=>pjLevelOf(e)==="audit")`, "категория не отобрана"], [`!!document.querySelector('#pjaConds [data-ck="pjToggle:cats:audit"]')`, "нет условия над списком"]],
  },
  ...BEHAVE_STEPS,
];
const KNOWN = new Set(STEPS.map((s) => s.id));
if (BEHAVIOR) ONLY.push(...BEHAVE_STEPS.map((s) => s.id).filter((x) => !ONLY.includes(x)));
const bad = ONLY.filter((x) => !KNOWN.has(x));
if (bad.length) usage(`Нет шагов: ${bad.join(", ")}. Есть: ${[...KNOWN].join(", ")}`);
const measured = (s) => !ONLY.length || ONLY.includes(s.id);
// Ожидание — одна функция страницы: true или строка-причина
function expectCode(list) {
  const body = list.map(([c, why]) => `{const r=(${c});if(r!==true&&(typeof r==="string"||!r))return typeof r==="string"?${JSON.stringify(why + ": ")}+r:${JSON.stringify(why)}}`).join("");
  return `(()=>{${body}return true})`;
}

// ── Замер внутри страницы ──────────────────────────────────────────────────
// Ставится до скриптов страницы. Долгие задачи (longtask) и долгие кадры (long-animation-frame) — PerformanceObserver;
// запросы — обёртка handle у встроенного сервера (ConsolemServer.create, заодно testSupport: true для /test/events),
// доставленные события потока — обёртка subscribe (считаются, «тихо» не продлевают: поиск устройств заглушки шлёт их
// долго); изменения разметки — MutationObserver: когда менялись #tree и #main; кадры — цикл requestAnimationFrame,
// в нём же проверка ожидания (то, что проверено в rAF, и будет нарисовано), конец кадра — сообщение из него
const LOAD_EXPECT = expectCode(STEPS[0].expect);
const INSTR = `(() => {
  if (window.__perf) return;
  const now = () => performance.now();
  const P = (window.__perf = { lt: [], loaf: [], frames: [], act: 0, t0: 0, lt0: 0, reqs: 0, reqs0: 0, keys: [], log: [], err: null,
    mutTree: 0, mutMain: 0, mark: 0, muts: [], exp: null, okAt: 0, why: "", typing: null, inputs: 0, delivered: new Map(), self: 0 });
  const touch = (t) => { if (t > P.act) P.act = t; };
  const obs = (type, arr) => { try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { arr.push([e.startTime, e.duration]); touch(e.startTime + e.duration); })).observe({ type, buffered: true }); } catch (e) {} };
  obs("longtask", P.lt);
  obs("long-animation-frame", P.loaf);
  new MutationObserver((list) => {
    const t = now();
    P.muts.push(t);
    if (P.muts.length > 20000) P.muts.splice(0, 10000);
    for (const m of list) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!el || !el.closest) continue;
      if (el.closest("#tree")) P.mutTree = t;
      else if (el.closest("#main")) P.mutMain = t;
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  // Ожидание проверяется в rAF; кадр, в котором оно впервые (и с тех пор) держится, — его конец
  const check = () => {
    if (!P.exp) return false;
    let r;
    try { r = P.exp(); } catch (e) { r = "исключение: " + ((e && e.message) || e); }
    if (r === true) return true;
    P.why = String(r);
    P.okAt = 0;
    return false;
  };
  // Отклик буквы: кадр, в котором буква дошла до поля (input) и видна в нём — значение поля начинается с текста,
  // набранного к этой букве. Конец кадра — сообщение из rAF, как у ожидания
  const shown = () => {
    const T = P.typing;
    if (!T) return [];
    const el = document.getElementById(T.field);
    if (!el) return [];
    return P.keys.filter((k) => !k.shown && k.inputAt && typeof k.text === "string" && el.value.startsWith(k.text));
  };
  const mc = new MessageChannel();
  let pending = null;
  mc.port1.onmessage = () => {
    if (!pending) return;
    const [t, ok, keys] = pending, end = now();
    pending = null;
    P.frames.push([t, end]);
    if (P.frames.length > 6000) P.frames.splice(0, 3000);
    if (ok && P.exp && !P.okAt) P.okAt = end;
    keys.forEach((k) => (k.shown = end));
  };
  // Своё время (проверки ожидания и букв) копится в P.self: из занятости шага и из «тихо» оно вычитается
  const loop = () => { const t = now(); pending = [t, check(), shown()]; P.self += now() - t; mc.port2.postMessage(0); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  addEventListener("keydown", (e) => { if (P.typing) P.keys.push({ k: e.key, at: e.timeStamp, inputAt: 0, text: null, shown: 0 }); }, true);
  addEventListener("input", (e) => {
    const k = P.keys[P.keys.length - 1];
    if (!P.typing || !k || k.inputAt) return;
    k.inputAt = now(); k.text = e.target.value; k.field = e.target.id;
    if (e.target.id === P.typing.field) P.inputs++;
  }, true);
  let real;
  Object.defineProperty(window, "ConsolemServer", { configurable: true, get: () => real, set(v) {
    const create = v.create;
    v.create = (o) => {
      const s = create(Object.assign({}, o, { testSupport: true })), h = s.handle, sub = s.subscribe;
      s.handle = (...a) => { P.reqs++; if (P.log.length < 40) P.log.push([Math.round(now() - P.t0), a[0] + " " + String(a[1]).slice(0, 120)]); try { return h(...a); } finally { touch(now()); } };
      s.subscribe = (fn, ...rest) => sub((m) => { if (m && m.entityId != null) P.delivered.set(m.entityId, (P.delivered.get(m.entityId) || 0) + 1); return fn(m); }, ...rest);
      return s;
    };
    real = v;
  } });
  // Помощники ожиданий
  P.row = (id) => document.querySelector('#tree .n[data-pick="' + id + '"]');
  P.treeAfter = () => P.mutTree > P.t0;
  P.mainAfter = () => P.mutMain > P.t0;
  // Полнота: перерисовано после действия, нет «Загрузка…» и пустоты; allIn — у каждого объекта списка есть строка
  const LOADING = /Загрузка|Загружаем/;
  P.treeDone = () => {
    if (!P.treeAfter()) return "не перерисовано";
    const t = document.getElementById("tree");
    if (LOADING.test(t.textContent)) return "ещё грузится";
    return !!t.querySelector(".n") || "пустое";
  };
  P.mainDone = () => (!P.mainAfter() ? "не перерисована" : LOADING.test(document.getElementById("main").textContent) ? "ещё грузится" : true);
  P.allIn = (list) => {
    const have = new Set([...document.querySelectorAll("#tree .n[data-pick]")].map((e) => e.dataset.pick));
    const miss = list.filter((x) => !have.has(x.id));
    return !miss.length || "нет " + miss.length + " из " + list.length;
  };
  P.card = (id, name, tabLabel) => {
    if (sel !== id) return "открыт не тот объект";
    if (!P.mainAfter()) return "карточка не перерисована";
    const main = document.getElementById("main"), hd = main && main.querySelector(".hd");
    if (!hd) return "нет шапки карточки";
    if (/Загрузка…/.test(main.textContent)) return "карточка ещё грузится";
    if (name && !hd.textContent.includes(name) && !hd.querySelector('[data-id="' + id + '"]')) return "в шапке не тот объект";
    if (tabLabel && (main.querySelector(".tab.on")?.textContent.trim() || "") !== tabLabel) return "открыта не та вкладка";
    return true;
  };
  P.camRows = () => { const pool = new Map(devicePool.map((x) => [x.id, x])); return new Set([...document.querySelectorAll("#tree .n[data-pick]")].map((e) => e.dataset.pick).filter((id) => pool.get(id)?.type === "camera")).size; };
  P.burstPrep = (n) => {
    const pool = new Map(devicePool.map((x) => [x.id, x]));
    // Только видные в дереве: поток следит за раскрытыми ветками, события о прочих странице не приходят. Выключенные —
    // мимо: у них строка от связи не зависит
    const ids = [...new Set([...document.querySelectorAll("#tree .n[data-pick]")].map((e) => e.dataset.pick))].filter((id) => pool.get(id)?.type === "camera" && pool.get(id).enabled !== false).slice(0, n);
    if (!ids.length) throw new Error("в дереве нет камер");
    window.__perfBurst = ids.map((id) => [id, pool.get(id).online === false]);
    P.burst = ids.map((id) => ({ id, want: pool.get(id).online === false, sig: P.row(id)?.outerHTML || null, got0: P.delivered.get(id) || 0, ev: false, flag: false, rowOk: false }));
  };
  P.burstDone = () => {
    const pool = new Map(devicePool.map((x) => [x.id, x]));
    // Отметки липкие: строку, которая уже сменилась, не сериализуем снова — проверка не должна сама занимать поток
    let ev = 0, rows = 0, flags = 0, shown = 0;
    const same = [];
    for (const b of P.burst) {
      if (!b.ev && (P.delivered.get(b.id) || 0) > b.got0) b.ev = true;
      if (b.ev) ev++;
      if ((pool.get(b.id)?.online !== false) === b.want) flags++;
      if (b.sig == null) continue;
      shown++;
      if (!b.rowOk && b.ev) { const r = P.row(b.id); if (r && r.outerHTML !== b.sig) b.rowOk = true; }
      if (b.rowOk) rows++;
      else if (same.length < 3) same.push(pool.get(b.id)?.name || b.id);
    }
    const n = P.burst.length;
    if (ev < n) return "доставлено событий " + ev + " из " + n;
    if (flags < n) return "состояние в кэше сменилось у " + flags + " из " + n;
    if (rows < shown) return "строка дерева сменилась у " + rows + " из " + shown + ": не сменилась " + same.join(", ");
    return true;
  };
  // Результат ввода: место результата (#tree, #main) перерисовано после последней буквы. Вместе с «поле и применённый
  // запрос равны набранному» (typeExpect) — на экране результат для всего текста
  P.resultDrawn = () => {
    const T = P.typing, k = P.keys[P.keys.length - 1];
    if (!T || !k || !k.inputAt) return "нет ввода";
    return (T.box === "tree" ? P.mutTree : P.mutMain) > k.inputAt || "не перерисовано после последней буквы";
  };
  P.watch = (code) => { P.exp = code ? (0, eval)(code) : null; P.okAt = 0; P.why = ""; };
  P.typeBegin = (field, applied, box) => { P.typing = { field, applied: (0, eval)("(()=>(" + applied + "))"), box }; P.inputs = 0; P.keys = []; };
  P.begin = () => { P.t0 = now(); P.act = P.t0; P.lt0 = P.lt.length; P.reqs0 = P.reqs; P.log = []; P.err = null; P.okAt = 0; return P.t0; };
  P.run = (code) => new Promise((res) => setTimeout(() => { P.begin(); try { (0, eval)(code); } catch (e) { P.err = String((e && e.message) || e); } touch(now()); res(P.err); }, 0));
  P.poll = () => { const t = now(), ok = !!P.okAt && check(); P.self += now() - t; return { idle: t - P.act, ok, why: P.why, now: now(), self: P.self }; };
  P.frameAfter = (t) => { const f = P.frames.find((x) => x[0] >= t && x[1]); return f ? f[1] : t; };
  // Последнее изменение разметки в (a, b] — где кончилась короткая работа, которую видно только по занятости
  P.lastMut = (a, b) => { let n = 0, last = 0; for (let i = P.muts.length - 1; i >= 0; i--) { const t = P.muts[i]; if (t <= a) break; if (t <= b) { n++; if (!last) last = t; } } return [n, last]; };
  // Конец шага: кадр после последней работы — долгой задачи, запроса, короткой работы до «тихо» (workAt, её находит
  // node по занятости) — и не раньше, чем сбылось ожидание. Для ввода результат — от последней клавиши до него же
  P.end = (workAt = 0) => {
    const lt = P.lt.slice(P.lt0).filter((x) => x[0] + x[1] > P.t0);
    const work = Math.max(P.act, workAt || 0), end = Math.max(P.okAt || 0, P.frameAfter(work));
    const r = { ms: end - P.t0, endAt: end, workMs: work - P.t0, okMs: P.okAt ? P.okAt - P.t0 : null, ok: !!P.okAt && check(), why: P.why, longest: Math.max(0, ...lt.map((x) => x[1])), longCount: lt.length,
      loaf: Math.max(0, ...P.loaf.filter((x) => x[0] + x[1] > P.t0).map((x) => x[1])), reqs: P.reqs - P.reqs0, err: P.err,
      rows: document.querySelectorAll("#tree .n").length, log: P.log, burstN: P.burst ? P.burst.length : null };
    if (P.typing) {
      const last = P.keys[P.keys.length - 1];
      r.keys = P.keys.map((k) => (k.shown ? k.shown - k.at : null)); r.texts = P.keys.map((k) => k.text); r.inputs = P.inputs;
      r.result = last && r.ok ? end - last.at : null;
      P.typing = null;
    }
    P.exp = null;
    return r;
  };
  P.watch(${JSON.stringify(LOAD_EXPECT)});
})()`;

// Калибровка: та же работа на любой машине — объекты, строки, сортировка, Map (сборка строк дерева) и разбор,
// стили, раскладка 2 000 строк по ~20 узлов со встроенными SVG (перерисовка дерева)
const CALIB = `(() => {
  const once = () => {
    const t0 = performance.now();
    const a = [];
    for (let i = 0; i < 150000; i++) a.push({ id: "id" + i, n: "Камера " + ((i * 7919) % 150000), v: i % 13 });
    a.sort((x, y) => (x.n < y.n ? -1 : x.n > y.n ? 1 : 0));
    const m = new Map(a.map((x) => [x.id, x]));
    let s = 0;
    for (let i = 0; i < 150000; i++) s += m.get("id" + ((i * 31) % 150000)).v;
    s += JSON.parse(JSON.stringify(a.slice(0, 40000))).length;
    const t1 = performance.now();
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:400px;height:900px;overflow:auto;font:13px sans-serif";
    document.body.appendChild(host);
    let html = "";
    for (let i = 0; i < 2000; i++) html += '<div class="r" style="display:flex;gap:4px;padding-left:' + (i % 5) * 16 + 'px"><span class="tw"></span><span class="ic"><svg width="16" height="16" viewBox="0 0 24 24"><path d="M3 3h18v18H3z"/><circle cx="12" cy="12" r="4"/></svg></span><span class="nm">Камера ' + i + '</span><small>' + i + '</small><button><svg width="12" height="12" viewBox="0 0 24 24"><path d="M1 1h10"/></svg></button><button><svg width="12" height="12" viewBox="0 0 24 24"><circle cx="5" cy="5" r="2"/></svg></button></div>';
    for (let k = 0; k < 2; k++) {
      host.innerHTML = html;
      host.scrollTop = 500 + k;
      s += host.scrollHeight;
      host.style.fontSize = 13 + (k % 2) + "px";
      s += host.firstChild.getBoundingClientRect().height;
    }
    host.remove();
    return [t1 - t0, performance.now() - t1, s];
  };
  once();
  const r = Array.from({ length: 7 }, once), med = (xs) => xs.slice().sort((x, y) => x - y)[3];
  return { ms: med(r.map((x) => x[0] + x[1])), js: med(r.map((x) => x[0])), layout: med(r.map((x) => x[1])) };
})()`;

// ── Chrome и CDP ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Trip extends Error {}
let current = null; // открытая сессия: закрыть при любом выходе
async function launch() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "consolem-perf-"));
  const args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files", "--window-size=1600,1000",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    `--user-data-dir=${prof}`, "--remote-debugging-port=0", "about:blank"];
  // Своя группа процессов: закрываем Chrome по своему PID вместе с его детьми, ничего чужого
  const proc = spawn(CHROME, args, { stdio: "ignore", detached: true, env: Object.assign({}, process.env, { TZ: "Europe/Moscow" }) });
  const s = { proc, prof, id: 0, wait: new Map(), ws: null, closed: false, idleRate: 0 };
  current = s;
  proc.on("error", () => {});
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    try {
      port = +fs.readFileSync(path.join(prof, "DevToolsActivePort"), "utf8").split("\n")[0];
    } catch (e) {}
    if (!port) await sleep(100);
  }
  if (!port) throw new Error("Chrome не поднялся: " + CHROME);
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch (e) {}
    if (!target) await sleep(100);
  }
  s.ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((s.ws.onopen = r), (s.ws.onerror = j)));
  s.ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && s.wait.has(m.id)) (s.wait.get(m.id)(m), s.wait.delete(m.id));
  };
  await send(s, "Performance.enable", { timeDomain: "timeTicks" });
  if (CPU > 1) await send(s, "Emulation.setCPUThrottlingRate", { rate: CPU });
  return s;
}
// Команда CDP со сроком: страница, занятая навсегда, не отвечает — это Trip, а не зависание инструмента
function send(s, method, params = {}, ms = TIMEOUT_MS) {
  return new Promise((res, rej) => {
    const i = ++s.id;
    const t = setTimeout(() => (s.wait.delete(i), rej(new Trip(method))), Math.max(1, ms));
    s.wait.set(i, (m) => (clearTimeout(t), m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)));
    s.ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function ev(s, expr, ms) {
  const r = await send(s, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || "").split("\n")[0]);
  return r.result.value;
}
// Занятость главного потока страницы с начала, мс (сумма всех задач, не только долгих)
async function taskMs(s, ms) {
  const r = await send(s, "Performance.getMetrics", {}, ms);
  return 1000 * (r.metrics.find((m) => m.name === "TaskDuration")?.value || 0);
}
async function close(s) {
  if (!s || s.closed) return;
  s.closed = true;
  if (current === s) current = null;
  try {
    s.ws?.close();
  } catch (e) {}
  const gone = new Promise((r) => (s.proc.exitCode !== null || s.proc.signalCode !== null ? r() : s.proc.once("exit", r)));
  try {
    if (s.proc.exitCode === null && s.proc.signalCode === null) process.kill(-s.proc.pid, "SIGKILL");
  } catch (e) {}
  await Promise.race([gone, sleep(3000)]);
  try {
    fs.rmSync(s.prof, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {}
}
// Ctrl+C приходит и node, и обёртке, а та пересылает ещё SIGTERM: итог печатается один раз
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
  if (stopping) return;
  stopping = true;
  await close(current);
  console.log("RESULT fail");
  process.exit(130);
});

// ── Шаг: подготовка, замер, «тихо» ─────────────────────────────────────────
// Ждать «тихо» до срока deadline: 1 с без запросов и долгих задач, занятость потока за последнюю секунду — не больше
// простоя и QUIET_BUSY_MS; needOk — ещё и ожидание шага держится. Страница, которая не отвечает, — Trip
async function quiet(s, deadline, needOk, all = []) {
  const hist = [];
  let last = null;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw Object.assign(new Trip("тихо"), { why: !last ? null : needOk && !last.ok ? last.why : `страница не стихла: ${last.idle < QUIET_MS ? "запросы или долгие задачи" : `занята ${last.busy} мс за секунду`}` });
    let p;
    try {
      p = await ev(s, "__perf.poll()", left);
    } catch (e) {
      if (e instanceof Trip) e.why = "страница не отвечает: главный поток занят без перерыва";
      throw e;
    }
    const td = await taskMs(s, deadline - Date.now());
    last = p;
    hist.push([p.now, td, p.self]);
    all.push([p.now, td, p.self]);
    while (hist.length > 2 && hist[1][0] <= p.now - QUIET_MS) hist.shift();
    const span = p.now - hist[0][0], busy = td - hist[0][1] - (p.self - hist[0][2]) - s.idleRate * span;
    last.busy = Math.round(busy);
    if (p.idle >= QUIET_MS && span >= QUIET_MS * 0.9 && busy <= QUIET_BUSY_MS && (!needOk || p.ok)) return p;
    await sleep(100);
  }
}
async function exec(s, expr, deadline) {
  const err = await ev(s, `__perf.run(${JSON.stringify(expr)})`, deadline - Date.now());
  if (err) throw new Error(err);
}
// pause — [после скольких букв, мс]: пауза посреди слова вместо KEY_GAP_MS
async function typeKeys(s, text, deadline, pause) {
  let n = 0;
  for (const ch of text) {
    if (Date.now() >= deadline) throw Object.assign(new Trip("набор"), { why: `набор не кончился за срок: отправлено ${n} из ${[...text].length} букв` });
    const key = { key: ch, text: ch, unmodifiedText: ch, code: ch === " " ? "Space" : "" };
    try {
      await send(s, "Input.dispatchKeyEvent", Object.assign({ type: "keyDown" }, key), deadline - Date.now());
    } catch (e) {
      if (e instanceof Trip) e.why = `набор не кончился за срок: страница приняла ${n} из ${[...text].length} букв`;
      throw e;
    }
    await send(s, "Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: key.code }, deadline - Date.now());
    n++;
    await sleep(pause && n === pause[0] ? pause[1] : KEY_GAP_MS);
  }
}
// ── Клавиши и мышь для проверок поведения ──────────────────────────────────
const NAMED_KEYS = { Enter: [13, "\r"], Escape: [27], ArrowDown: [40], ArrowUp: [38], Backspace: [8], Tab: [9] };
async function pressKey(s, k, deadline) {
  const [vk, text] = NAMED_KEYS[k] || [];
  if (!vk) throw new Error("нет клавиши " + k);
  const base = { key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send(s, "Input.dispatchKeyEvent", Object.assign({ type: text ? "keyDown" : "rawKeyDown" }, base, text ? { text } : {}), deadline - Date.now());
  await send(s, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base), deadline - Date.now());
}
// Буквы с KEY_GAP_MS между ними, без паузы после последней: следующая проверка — сразу
async function typeText(s, text, deadline) {
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], key = { key: ch, text: ch, unmodifiedText: ch, code: ch === " " ? "Space" : "" };
    await send(s, "Input.dispatchKeyEvent", Object.assign({ type: "keyDown" }, key), deadline - Date.now());
    await send(s, "Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: key.code }, deadline - Date.now());
    if (i < chars.length - 1) await sleep(KEY_GAP_MS);
  }
}
async function clickAt(s, sel, deadline) {
  const r = await ev(s, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return b.width&&b.height?[b.left+b.width/2,b.top+b.height/2]:null})()`, deadline - Date.now());
  if (!r) throw new Error("не на экране: " + sel);
  for (const type of ["mousePressed", "mouseReleased"]) await send(s, "Input.dispatchMouseEvent", { type, x: r[0], y: r[1], button: "left", clickCount: 1 }, deadline - Date.now());
}
// Шаг проверки поведения: ops по порядку, check — в этот миг. Не сбылось — ошибка шага с причиной
async function behaveOps(s, st, deadline) {
  for (const op of st.ops) {
    if (op.type) await typeText(s, op.type, deadline);
    else if (op.key) await pressKey(s, op.key, deadline);
    else if (op.click) await clickAt(s, op.click, deadline);
    else if (op.sleep) await sleep(op.sleep);
    else if (op.run) await ev(s, op.run, deadline - Date.now());
    else if (op.check) {
      const r = await ev(s, `${expectCode([op.check])}()`, deadline - Date.now());
      if (r !== true) throw new Error(String(r));
    }
  }
}
// Ожидание набора: поле, применённый запрос и результат — для всего текста; каждая буква видна в поле
const typeExpect = (st) => expectCode([
  [`document.activeElement&&document.activeElement.id===${JSON.stringify(st.type.field)}`, "фокус ушёл из поля"],
  [`document.getElementById(${JSON.stringify(st.type.field)})?.value===${JSON.stringify(st.keys)}`, "в поле не набранный текст"],
  [`(${st.type.applied})===${JSON.stringify(st.keys)}`, "страница не применила запрос"],
  [`__perf.keys.length===${[...st.keys].length}&&__perf.keys.every(k=>k.shown)`, "не все буквы видны в поле"],
  [`__perf.resultDrawn()`, "результат"],
]);
// Выполнить шаг. measure=false — только привести страницу в состояние (повтор после перезапуска, невыбранный шаг)
async function runStep(s, st, measure) {
  const deadline = Date.now() + TIMEOUT_MS;
  // Проверять нечего (skipIf — причина-строка): шаг не выполняется, итог «не проверялось» — ни PASS, ни FAIL
  const skip = st.skipIf ? await ev(s, st.skipIf, deadline - Date.now()) : false;
  if (skip) return { skipped: String(skip) };
  for (const p of st.prep || []) {
    await exec(s, p, deadline);
    await quiet(s, deadline, false);
  }
  const t = Date.now() + TIMEOUT_MS; // сторож замера — свой, подготовка в него не входит
  const td0 = await busyMark(s, t - Date.now());
  let res = null, tripped = null;
  try {
    if (st.behave) {
      await ev(s, `__perf.begin();__perf.watch(${JSON.stringify(expectCode(st.expect))})`, t - Date.now());
      await behaveOps(s, st, t);
    } else if (st.keys) {
      const f = JSON.stringify(st.type.field);
      const focus = await ev(s, `document.activeElement&&document.activeElement.id===${f}`, t - Date.now());
      if (!focus) throw new Error(`поле #${st.type.field} не в фокусе`);
      await ev(s, `__perf.typeBegin(${f},${JSON.stringify(st.type.applied)},${JSON.stringify(st.type.box)});__perf.begin();__perf.watch(${JSON.stringify(typeExpect(st))})`, t - Date.now());
      await typeKeys(s, st.keys, t, st.pause);
    } else {
      await ev(s, `__perf.watch(${JSON.stringify(expectCode(st.expect))})`, t - Date.now());
      await exec(s, st.act, t);
    }
    const samples = [[td0.now, td0.td, td0.self]];
    await quiet(s, t, true, samples);
    if (measure) {
      res = await ev(s, `__perf.end(${await lastWork(s, samples, t)})`, t - Date.now());
      res.busy = busyUntil(s, samples, td0, res.endAt);
      res.work = workSeries(s, samples, td0.now);
    } else await ev(s, "__perf.end()", t - Date.now());
  } catch (e) {
    if (!(e instanceof Trip)) {
      // Проверка поведения не сбылась: уборка всё равно — следующие шаги идут с прежнего состояния (ассистент, can)
      if (st.behave) {
        await ev(s, "__perf.end()", 5000).catch(() => {});
        for (const p of st.post || []) await exec(s, p, deadline + TIMEOUT_MS).then(() => quiet(s, deadline + TIMEOUT_MS, false)).catch(() => {});
      }
      throw e;
    }
    tripped = e;
  }
  if (tripped) {
    // Буквы, дошедшие до кадра, и причина — итог шага, даже если страница не стихла (тогда сессия перезапускается)
    if (measure) res = await ev(s, "__perf.end()", 5000).catch(() => null);
    throw Object.assign(tripped, { res, why: tripped.why || (res && !res.ok && res.why) || null });
  }
  for (const p of st.post || []) {
    await exec(s, p, deadline + TIMEOUT_MS);
    await quiet(s, deadline + TIMEOUT_MS, false);
  }
  return res;
}
// Последняя работа до «тихо»: последний отрезок между опросами, где шла работа (WORK_SHARE, WORK_FULL). Внутри него
// конец работы — последнее изменение разметки, а если разметка не менялась — конец отрезка. Так время шага охватывает
// и работу, порезанную на короткие задачи или отложенную таймером: она длинных задач не даёт. Первый отрезок (от
// действия до первого опроса) — всегда работа: в нём само действие
async function lastWork(s, samples, deadline) {
  for (let i = samples.length - 1; i > 0; i--) {
    const [a, tdA, selfA] = samples[i - 1], [b, tdB, selfB] = samples[i];
    const busy = tdB - tdA - (selfB - selfA) - s.idleRate * (b - a);
    if (busy <= WORK_SHARE * (b - a)) continue;
    const [n, last] = await ev(s, `__perf.lastMut(${a},${b})`, deadline - Date.now());
    if (i > 1 && n < 2 && busy <= WORK_FULL * (b - a)) continue;
    return last || b;
  }
  return 0;
}
// Занятость по отрезкам между опросами, для --json: [конец отрезка от начала шага, занятость сверх простоя], мс
const workSeries = (s, samples, t0) => samples.slice(1).map(([b, td, self], i) => {
  const [a, tdA, selfA] = samples[i];
  return [Math.round(b - t0), Math.round(td - tdA - (self - selfA) - s.idleRate * (b - a))];
});
// Занятость с начала шага до его конца: замер TaskDuration в первом опросе после конца, без простоя после конца.
// Конец шага — после последней работы (lastWork), поэтому занятость охватывает всю работу до «тихо»
function busyUntil(s, samples, start, endAt) {
  const i = samples.findIndex((x) => x[0] >= endAt);
  const [t, td, self] = i >= 0 ? samples[i] : samples[samples.length - 1];
  return Math.max(0, td - start.td - (self - start.self) - s.idleRate * Math.max(0, t - endAt));
}
// Точка отсчёта занятости: TaskDuration и своё время замера сейчас
async function busyMark(s, ms) {
  const p = await ev(s, "({self:__perf.self,now:performance.now()})", ms);
  return { td: await taskMs(s, ms), self: p.self, now: p.now };
}
// Простой страницы: занятость потока за 1 с без действий (кадры, таймер заглушки) — вычитается из занятости шага
async function idleRate(s) {
  const a = await taskMs(s), t0 = Date.now();
  await sleep(1000);
  return Math.max(0, ((await taskMs(s)) - a) / (Date.now() - t0));
}
// Калибровка в этой же сессии Chrome, на пустой странице
async function calibrate(s) {
  if (s.scriptId) await send(s, "Page.removeScriptToEvaluateOnNewDocument", { identifier: s.scriptId });
  s.scriptId = null;
  await send(s, "Page.navigate", { url: "about:blank" });
  await sleep(300);
  return await ev(s, CALIB, 120000);
}
// Страница, старт до «тихо». measure — вернуть итог старта
async function openPage(s, measure) {
  await send(s, "Page.enable");
  s.scriptId = (await send(s, "Page.addScriptToEvaluateOnNewDocument", { source: INSTR })).identifier;
  const url = "file://" + path.join(ROOT, PAGE) + (FIXTURE ? "?fixture=" + encodeURIComponent(FIXTURE) : "");
  const td0 = { td: await taskMs(s), self: 0 };
  await send(s, "Page.navigate", { url });
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Trip("старт");
    const r = await ev(s, "!!window.__perf&&!!window.appReadyDone", deadline - Date.now()).catch((e) => {
      if (e instanceof Trip) throw e;
      return false;
    });
    if (r) break;
    await sleep(50);
  }
  let res = null;
  const samples = [];
  try {
    await quiet(s, deadline, true, samples);
  } catch (e) {
    if (!(e instanceof Trip)) throw e;
    if (measure) res = await ev(s, "__perf.end()", 5000).catch(() => null);
    throw Object.assign(e, { res, why: e.why || (res && !res.ok && res.why) || null });
  }
  // Пауза в наборе — со страницы (TYPE_PAUSE_MS); нет константы — страница ищет на каждую букву, пауза 0
  s.typePause = await ev(s, `typeof TYPE_PAUSE_MS==="number"?TYPE_PAUSE_MS:0`).catch(() => null);
  // Новый документ мог уйти в новый процесс страницы: тогда счётчик TaskDuration начался заново
  const base = samples.length && samples[0][1] < td0.td ? { td: 0, self: 0 } : td0;
  samples.unshift([0, base.td, 0]);
  if (measure) res = await ev(s, `__perf.end(${await lastWork(s, samples, deadline + 5000)})`);
  else await ev(s, "__perf.end()");
  s.idleRate = await idleRate(s);
  if (res) (res.busy = busyUntil(s, samples, base, res.endAt)), (res.work = workSeries(s, samples, 0));
  return res;
}

// ── Прогон: все шаги одной сессией, перезапуск после сторожа ──────────────
const log = (m) => process.stderr.write(m + "\n");
async function oneRun(r, cals) {
  const out = {};
  const done = []; // шаги, после которых состояние надо повторить при перезапуске
  const lost = new Set(); // шаги replay:false, чьё состояние перезапуск потерял
  const ranOnce = new Set(); // шаги replay:false, выполненные в этом прогоне
  let s = null;
  let restartNeeded = false;
  const restart = async () => {
    await close(s);
    s = await launch();
    await openPage(s, false);
    for (const st of done) await runStep(s, st, false);
  };
  const calOnce = async (where) => {
    const c = await calibrate(s);
    cals.push(Object.assign(c, { run: r, where }));
    log(`  калибровка прогона ${r} (${where}): ${num(c.ms)} мс (JS ${num(c.js)}, раскладка ${num(c.layout)})`);
  };
  try {
    s = await launch();
    await calOnce("начало");
    for (const st of STEPS) {
      const m = measured(st);
      if (st.id === "load") {
        try {
          out.load = await openPage(s, m);
          out.typePause = s.typePause;
        } catch (e) {
          if (!(e instanceof Trip)) throw e;
          out.load = Object.assign(e.res || {}, { trip: true, why: e.why });
          log(`  прогон ${r}: старт не дождался рабочего дерева за ${TIMEOUT_MS / 1000} с${e.why ? ` (${e.why})` : ""} — прогон прерван`);
          return out;
        }
        if (m) log(`  прогон ${r}: ${st.id} ${fmtMs(out.load.ms)}`);
        continue;
      }
      if (!m && st.replay === false) continue;
      if (restartNeeded) {
        restartNeeded = false;
        try {
          await restart();
        } catch (e2) {
          log(`  прогон ${r}: перезапуск не удался (${e2.message}) — остальные шаги прогона не выполнены`);
          return out;
        }
      }
      const mark = (res) => (res && lost.size ? Object.assign(res, { lost: [...lost] }) : res);
      try {
        const res = await runStep(s, st, m);
        if (m) out[st.id] = mark(res);
        if (st.replay !== false) done.push(st);
        else ranOnce.add(st.id);
        if (m) log(`  прогон ${r}: ${st.id} ${st.keys ? `результат ${fmtMs(stepValue(st, res))}, буква до ${fmtMs(echoValue(st, res))}` : fmtMs(stepValue(st, res))}`);
      } catch (e) {
        if (!(e instanceof Trip)) {
          if (m) out[st.id] = mark({ error: e.message });
          log(`  прогон ${r}: ${st.id} ошибка: ${e.message}`);
          if (st.replay !== false) done.push(st);
          continue;
        }
        if (m) out[st.id] = mark(Object.assign(e.res || {}, { trip: true, why: e.why }));
        log(`  прогон ${r}: ${st.id} — сторож ${TIMEOUT_MS / 1000} с${e.why ? ` (${e.why})` : ""}${e.res && st.keys && e.res.keys ? `, отклик букв ${e.res.keys.map((x) => (x == null ? "?" : Math.round(x))).join(" ")}` : ""}; страница перезапускается`);
        restartNeeded = true;
        // Перезапуск повторит только шаги с replay; состояние остальных до этого места пропадёт
        if (st.replay === false) ranOnce.add(st.id);
        ranOnce.forEach((x) => lost.add(x));
      }
    }
    if (!restartNeeded) await calOnce("конец");
    else {
      await close(s);
      s = await launch();
      await calOnce("конец, новая сессия");
    }
    return out;
  } finally {
    await close(s);
  }
}

// ── Итог ───────────────────────────────────────────────────────────────────
// Значение шага: время до ожидания и «тихо», для ввода — результат: от последней клавиши до того же конца. Сторож или
// несбывшееся ожидание — Infinity; ошибка — null
function stepValue(st, res) {
  if (!res || res.error) return null;
  if (res.trip || res.ok === false) return Infinity;
  if (st.keys) return res.result != null ? res.result : Infinity;
  return res.ms;
}
// Отклик букв шага ввода — самая долгая буква до кадра, где она видна в поле. Буква, не дошедшая до поля или до кадра
// (сторож), — Infinity. Отклик считается и у шага, который упёрся в сторожа: буквы к тому времени уже набраны
function echoValue(st, res) {
  if (!st.keys || !res || res.error || !res.keys) return null;
  const n = [...st.keys].length;
  return res.keys.length === n && res.keys.every((x) => x != null) ? Math.max(...res.keys) : Infinity;
}
const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const num = (x) => Math.round(x).toLocaleString("ru-RU").replace(/ /g, " ");
function fmtMs(x) {
  if (x == null) return "—";
  if (x === Infinity) return `> ${TIMEOUT_MS / 1000} с`;
  return num(x) + " мс";
}
function taskLimitKey(st) {
  if (st.limit === "load") return null;
  if (st.limit === "coarse") return "coarse";
  return "task";
}
const busyLimit = (st) => (st.keys ? LIMITS.key * [...st.keys].length + LIMITS.click : LIMITS[st.limit]);
function factorOf(cals) {
  const ms = median(cals.map((c) => c.ms));
  const ratio = ms / REF_CALIB_MS;
  let f = ratio > 1 + CALIB_NOISE ? ratio / (1 + CALIB_NOISE) : ratio < 1 - CALIB_NOISE ? ratio / (1 - CALIB_NOISE) : 1;
  const warn = [];
  if (f > FACTOR_MAX) {
    warn.push(`WARN машина занята или медленная: отношение ${ratio.toFixed(2)}, множитель ограничен ${FACTOR_MAX} — пределы не ослаблены сверх этого`);
    f = FACTOR_MAX;
  }
  const lo = Math.min(...cals.map((c) => c.ms)), hi = Math.max(...cals.map((c) => c.ms));
  if (cals.length > 1 && (hi - lo) / ms > 0.2) warn.push(`WARN калибровка шумит: ${cals.map((c) => num(c.ms)).join(", ")} мс — на машине идёт чужая работа, числа шагов тоже могут плыть`);
  return { ms, ratio, factor: Math.round(f * 100) / 100, warn };
}

async function main() {
  const started = Date.now();
  console.log(`Скорость в настоящем времени: ${PAGE}${FIXTURE ? "?fixture=" + FIXTURE : " (demo)"}, прогонов ${RUNS}, сторож ${TIMEOUT_MS / 1000} с${CPU > 1 ? `, ЦП ×${CPU}` : ""}`);
  const cals = [];
  const runs = [];
  for (let r = 1; r <= RUNS; r++) runs.push(await oneRun(r, cals));
  const { ms: calMs, ratio, factor, warn } = factorOf(cals);
  const pause = runs.map((o) => o.typePause).find((x) => x != null) ?? 0;
  const calLine = `Калибровка: медиана ${num(calMs)} мс из ${cals.map((c) => num(c.ms)).join(", ")}; эталон ${REF_CALIB_MS} мс, отношение ${ratio.toFixed(2)} — множитель пределов ${factor.toFixed(2)}`;
  console.log(calLine);
  warn.forEach((w) => console.log(w));
  const rows = [];
  let failed = 0;
  for (const st of STEPS.filter(measured)) {
    const per = runs.map((o) => o[st.id]);
    const skippedWhy = per.length && per.every((x) => x && x.skipped) ? per[0].skipped : null;
    const vals = per.map((x) => stepValue(st, x));
    const ms = median(vals);
    const okRuns = per.filter((x) => x && !x.error);
    const longest = median(okRuns.map((x) => (x.longest != null ? x.longest : null)));
    const busy = median(okRuns.map((x) => (x.busy != null ? x.busy : null)));
    // Ввод: время — результат (предел — пауза страницы и click), отдельно отклик буквы (key)
    const lim = st.behave ? null : st.keys ? resultLimit(factor, pause) : LIMITS[st.limit] * factor;
    const echoes = st.keys ? per.map((x) => echoValue(st, x)) : [];
    const echo = st.keys ? median(echoes) : null, klim = st.keys ? LIMITS.key * factor : null;
    const tk = st.behave ? null : taskLimitKey(st), tlim = tk ? LIMITS[tk] * factor : null, blim = st.behave ? null : busyLimit(st) * factor;
    const errs = per.filter((x) => x && x.error).map((x) => x.error);
    const missing = per.filter((x) => !x).length;
    const whys = [...new Set(per.filter((x) => x && (x.trip || x.ok === false) && x.why).map((x) => x.why))];
    // Любая ошибка, пропуск или несбывшееся ожидание хотя бы в одном прогоне — FAIL шага
    // Проверка поведения: все проверки и итог сбылись, время не ограничено
    const pass = st.behave ? !errs.length && !missing && vals.every((v) => v != null && v !== Infinity)
      : !errs.length && !missing && vals.every((v) => v != null && v !== Infinity) && ms <= lim && (tlim == null || (longest != null && longest <= tlim)) && busy != null && busy <= blim &&
        (!st.keys || (echoes.every((v) => v != null && v !== Infinity) && echo <= klim));
    if (!pass && !skippedWhy) failed++;
    const notes = [];
    if (st.keys && okRuns.length) {
      const keys = okRuns.map((x) => x.keys || []);
      const first = median(keys.map((k) => (k.length ? (k[0] == null ? Infinity : k[0]) : null)));
      const rest = median(keys.map((k) => (k.length > 1 ? Math.max(...k.slice(1).map((x) => (x == null ? Infinity : x))) : null)));
      notes.push(`отклик: первая буква ${fmtMs(first)}, следующие до ${fmtMs(rest)}`);
      const part = okRuns.filter((x) => x.keys && x.keys.some((k) => k == null));
      if (part.length) {
        const k = part[0].keys.filter((x) => x != null);
        notes.push(`за ${TIMEOUT_MS / 1000} с видны в поле ${k.length} из ${[...st.keys].length} букв${k.length ? ", самая долгая " + fmtMs(Math.max(...k)) : ""}`);
      }
      const inputs = okRuns.filter((x) => x.inputs != null && x.inputs !== [...st.keys].length);
      if (inputs.length) notes.push(`в поле дошло ${inputs[0].inputs} из ${[...st.keys].length} букв`);
    }
    if (st.id === "stream-100" && okRuns.some((x) => x.burstN != null && x.burstN !== 100)) notes.push(`камер в дереве ${median(okRuns.map((x) => x.burstN))} — событий столько же`);
    if (st.id === "load" && okRuns.length) notes.push(`рабочее дерево ${fmtMs(median(okRuns.map((x) => x.okMs)))}`);
    if (okRuns.length && okRuns.some((x) => x.reqs != null)) notes.push(`запросов ${num(median(okRuns.map((x) => x.reqs || 0)))}`);
    if (whys.length) notes.push("не сбылось: " + whys.join(" | "));
    if (errs.length) notes.push(`ошибка в ${errs.length} из ${RUNS}: ${errs[0]}`);
    if (missing) notes.push(`не выполнен в ${missing} из ${RUNS}`);
    const lostRuns = per.filter((x) => x && x.lost && x.lost.length);
    if (lostRuns.length) notes.push(`после перезапуска (без ${[...new Set(lostRuns.flatMap((x) => x.lost))].join(", ")}) в ${lostRuns.length} из ${RUNS}`);
    if (skippedWhy) notes.unshift(`не проверялось (${skippedWhy})`);
    rows.push({ st, ms: skippedWhy ? null : ms, echo, longest, busy, lim, klim, tlim, blim, pass: skippedWhy ? null : pass, notes, vals, echoes, per });
  }
  const W = Math.max(...rows.map((x) => x.st.title.length), 4);
  const head = ["шаг".padEnd(W), "время".padStart(10), "буква".padStart(10), "задача".padStart(8), "занят".padStart(8), "предел".padStart(25), "итог"].join("  ");
  console.log("");
  console.log(head);
  console.log("-".repeat(head.length));
  const short = (x) => (x == null ? "—" : x < 50 ? "< 50" : num(x));
  for (const x of rows) {
    const lim = x.st.behave ? "проверка" : `${num(x.lim)}/${x.klim != null ? num(x.klim) : "—"}/${x.tlim != null ? num(x.tlim) : "—"}/${num(x.blim)} мс`;
    console.log([x.st.title.padEnd(W), fmtMs(x.ms).padStart(10), (x.st.keys ? fmtMs(x.echo) : "—").padStart(10), short(x.longest).padStart(8), (x.busy == null ? "—" : num(x.busy)).padStart(8), lim.padStart(25), (x.pass == null ? "—" : x.pass ? "PASS" : "FAIL").padEnd(4)].join("  ") + (x.notes.length ? "  " + x.notes.join("; ") : ""));
  }
  const total = (Date.now() - started) / 1000;
  console.log("");
  console.log(`Время — медиана ${RUNS} прогонов до кадра после последней работы шага (ожидание сбылось, страница стихла); у ввода — результат: от последней клавиши до того же кадра, предел — пауза страницы (${pause} мс) + ${LIMITS.click} мс. Проверки поведения ввода (предел «проверка») — без предела времени: проверки в заданные мгновения и итог. Буква — отклик ввода: самая долгая буква от клавиши до кадра, где она видна в поле. Задача — самая длинная (< 50 — долгих не было); занят — занятость главного потока за шаг. Предел — время/буква/задача/занятость`);
  console.log(`Прогон инструмента: ${num(total)} с`);
  if (JSON_OUT) {
    const data = {
      page: PAGE, fixture: FIXTURE, runs: RUNS, timeoutSec: TIMEOUT_MS / 1000, cpu: CPU || 1, calibrations: cals, calibrationMs: calMs, refCalibMs: REF_CALIB_MS, ratio, factor, warn, limits: LIMITS,
      at: new Date().toISOString(), totalSec: total,
      typePauseMs: pause, keyGapMs: KEY_GAP_MS, midPauseMs: MID_PAUSE_MS,
      steps: rows.map((x) => ({ id: x.st.id, title: x.st.title, limit: x.st.limit, limitMs: x.lim, echoLimitMs: x.klim, taskLimitMs: x.tlim, busyLimitMs: x.blim, ms: x.ms === Infinity ? null : x.ms, tripped: x.ms === Infinity,
        echo: x.echo === Infinity ? null : x.echo, longest: x.longest, busy: x.busy, pass: x.pass,
        runs: x.per.map((p, i) => (p ? Object.assign({ value: x.vals[i] === Infinity ? null : x.vals[i] }, x.st.keys ? { echo: x.echoes[i] === Infinity ? null : x.echoes[i] } : {}, p) : null)) })),
    };
    fs.writeFileSync(JSON_OUT, JSON.stringify(data, null, 1));
  }
  console.log(`Множитель пределов ${factor.toFixed(2)} (отношение калибровки ${ratio.toFixed(2)})${warn.length ? " — см. WARN выше" : ""}`);
  console.log(`RESULT ${failed ? "fail" : "pass"}`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  async (e) => {
    console.log("FAIL  " + (e && e.stack ? e.stack : e));
    await close(current);
    console.log("RESULT fail");
    process.exit(1);
  }
);
