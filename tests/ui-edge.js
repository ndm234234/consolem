/* Сценарии интерфейса: встроенное хранилище камеры и регистратора и репликация в архив сервера (контракт 0.6.0, профиль vms.edge/1).
   Страница хранилища: постоянная репликация (PATCH replication, камерам режим ставит сервер), предел скорости, исключённые камеры
   регистратора, проверки носителя, ручной забор периода (archive-fetch), состояние и пропуски, правила репликации. Общий вид
   у сервера и домена, вкладка архива с групповой настройкой, строка в «Периферии», событие replication.changed. Запуск — tools/check_ui.py */
UiCheck(async ({ ok, until, confirmWith }) => {
  const devices = await uiDevices();
  const main = () => document.getElementById("main");
  const id = (n) => `${n}-0000-4000-8000-000000000000`;
  const S = { off: id(30000029), all: id(30000042), wait: id(30000040), nvr: id(30000047), card: id(30000124) };
  const CAM = { off: id(30000013), all: id(30000041) };
  const NVR = { corr1: id(30000048), lift: id(30000051), cam5: id(30000065), cam9: id(30000069), cam10: id(30000070) };
  const SRV = id(20000001), ARCH = id(50000001);
  const open = (uid, t = "rep") => { pick(uid, { force: true }); goTab(t); };
  const srv = async (uid) => uiRec(uid);
  const mode = async (uid) => (await srv(uid)).replication.mode;
  const camMode = async (uid) => (await srv(uid)).recordMode;
  const text = () => main().textContent;
  // Вкладка камеры читает только хранилище этой камеры: не все хранилища системы
  const gets = [], getWas = API.get;
  API.get = function (path, ...r) { gets.push(path + " " + JSON.stringify(r[0] || "")); return getWas.call(this, path, ...r); };
  open(CAM.off, "io");
  ok(await until(() => [...main().querySelectorAll(".pf-nm")].some((b) => /хранилище/i.test(b.textContent))), "«Периферия» камеры показывает её встроенное хранилище");
  API.get = getWas;
  ok(gets.some((g) => /kind.*storage/.test(g) && g.includes(CAM.off)) && !gets.some((g) => /kind.*storage/.test(g) && !g.includes("parentId")), "прочитано хранилище этой камеры (parentId), а не все хранилища: " + gets.filter((g) => /storage/.test(g)).join(" | "));
  await edgeLoadAll();
  ok(await until(() => edgeLoad?.done), "встроенные хранилища загружены одним перечнем");
  const st = (uid) => find(uid).n;
  // Страница хранилища камеры: два постоянных типа, выбран «Забирать всё»; состояние и носитель — с сервера
  open(S.all);
  ok(main().querySelectorAll(".er-types[role=radiogroup] .er-t").length === 2 && main().querySelector(".er-types .er-t.on")?.textContent.includes("Забирать всё"), "два постоянных типа, выбран «Забирать всё» — по replication.mode сервера");
  ok(!main().querySelector(".er-stub") && !/заглушк/i.test(text()), "ярлыков «заглушка» нет");
  ok(/в норме/.test(text()) && main().querySelectorAll(".er-ck.ok").length === 2, "состояние «в норме»; носитель и Profile G проверены");
  ok(/Пропусков за 7 дней нет/.test(text()), "пропусков нет");
  // Тип «Выключена» уходит запросом, камера пишет сама; «Забирать всё» возвращает режим replica
  edgeSet(S.all, "type", "off");
  ok((await until(() => st(S.all).replication?.mode === "off")), "выключили: узел хранилища обновлён после PATCH");
  ok(await mode(S.all) === "off" && await camMode(CAM.all) === "always", "на сервере mode off, камера снова пишет в архив (recordMode always)");
  ok(await until(() => main().querySelector(".er-types .er-t.on")?.textContent.includes("Выключена")), "выбранный тип сменился на экране");
  edgeSet(S.all, "type", "all");
  ok(await until(() => st(S.all).replication?.mode === "all") && await camMode(CAM.all) === "replica", "«Забирать всё»: mode all, камере сервер поставил replica");
  // Предел скорости
  edgeSet(S.all, "speed", "40");
  ok(await until(() => st(S.all).replication?.speedLimitMbps === 40) && (await srv(S.all)).replication.speedLimitMbps === 40, "предел скорости сохранён на сервере");

  // Хранилище без репликации: ждёт правила; проверки для типа «Выключена» не показаны
  open(S.off);
  ok(/Выключена/.test(main().querySelector(".er-types .er-t.on")?.textContent || "") && !main().querySelector(".er-checks"), "тип «Выключена»: проверок носителя нет");
  ok(/ждёт запуска/.test(text()) && /в очереди/.test(text()) && /сервер забрал/.test(text()), "пропуск в очереди ждёт правила, прежний забран");
  // Тип «Забирать всё» с хранилища без выбранного архива: консоль берёт архив камеры
  edgeSet(S.off, "type", "all");
  ok(await until(() => st(S.off).replication?.mode === "all") && (await srv(S.off)).replication.archiveId === ARCH, "mode all, архив назначения — архив записи камеры");
  ok(await camMode(CAM.off) === "replica", "камера «Главный вход» теперь replica");
  ok(main().querySelectorAll(".er-ck").length === 2, "для «Забирать всё» показаны проверки носителя");
  edgeSet(S.off, "type", "off");
  ok(await until(() => st(S.off).replication?.mode === "off") && await camMode(CAM.off) === "always", "и обратно: камера снова пишет в архив");

  // Ошибка носителя: проверка красная
  open(S.card);
  edgeSet(S.card, "type", "all");
  ok(await until(() => st(S.card).replication?.mode === "all"), "включили репликацию у хранилища с ошибкой носителя");
  ok(await until(() => main().querySelector(".er-ck.bad") && /не видит носитель/.test(text())), "носитель с ошибкой — проверка с «!» и пояснением");
  edgeSet(S.card, "type", "off");
  await until(() => st(S.card).replication?.mode === "off");

  // Регистратор: состояние по камерам, исключённая камера, правила не затронуты
  open(S.nvr);
  ok(main().querySelectorAll(".er-cams tbody tr").length === 10, "таблица камер регистратора: все десять");
  const box = (uid) => [...main().querySelectorAll(".er-cams tbody tr")].find((r) => r.textContent.includes(locName(find(uid).n)))?.querySelector("input[type=checkbox]");
  ok(box(NVR.cam9) && !box(NVR.cam9).checked && box(NVR.cam5).checked, "исключённая камера без флажка, остальные с флажком");
  edgeExclToggle(S.nvr, NVR.cam5);
  ok((await until(() => st(S.nvr).replication.excludedCameras.includes(NVR.cam5))), "камеру исключили: список на сервере");
  ok(await camMode(NVR.cam5) === "always" && await camMode(NVR.lift) === "replica", "исключённой сервер поставил always, остальным replica");
  ok(await until(() => box(NVR.cam5) && !box(NVR.cam5).checked), "флажок снят на экране");
  edgeExclToggle(S.nvr, NVR.cam5);
  ok(await until(() => !st(S.nvr).replication.excludedCameras.includes(NVR.cam5)) && await camMode(NVR.cam5) === "replica", "камеру вернули: replica");
  ok(/ждёт связи/.test(text()) || /забирает/.test(text()), "общее состояние регистратора — худшее из камер");

  // Ручной забор периода: просьба «закрепить» для каждой камеры с основной записью
  const calls = [], postWas = API.post;
  API.post = function (path, body, ...r) { if (/archive-fetch/.test(path)) calls.push([path, body]); return postWas.call(this, path, body, ...r); };
  open(S.off);
  edgePullAsk(S.off);
  ok(document.getElementById("confirm").classList.contains("open") && document.getElementById("erPullFrom") && document.getElementById("erPullTo"), "«Забрать период…» открывает окно с началом и концом");
  const q = st(S.off).replicationStatus.gaps.find((g) => g.result === "queued");
  document.getElementById("erPullFrom").value = new Date(Date.parse(q.from) - 300e3).toISOString().slice(0, 16);
  document.getElementById("erPullTo").value = new Date(Date.parse(q.to) + 300e3).toISOString().slice(0, 16);
  await confirmWith();
  ok(await until(() => calls.length === 1) && calls[0][0] === `/units/${CAM.off}/archive-fetch` && calls[0][1].archiveId === ARCH, "забор: archive-fetch камеры с её основным архивом");
  ok(await until(() => st(S.off).replicationStatus.state === "running" || st(S.off).replicationStatus.gaps.some((g) => g.result === "done" && g.from === q.from)), "сервер начал забирать пропуск периода");
  API.post = postWas;

  // Правила репликации: шаблоны ведут в мастер правила с камерами хранилища; «Отмена» возвращает на страницу
  open(S.off);
  ok(/Репликация по правилам/.test(text()) && main().querySelectorAll(".er-t-rule").length === 3, "три шаблона правил на странице хранилища");
  main().querySelector(".er-t-rule").click();
  ok(await until(() => document.querySelector("#bmodal.open [data-rnw]")), "мастер правила открыт с шаблоном");
  ok(document.querySelector("#bmBody .rl-opt.on")?.textContent.includes("Связь вернулась"), "выбран шаблон «Связь вернулась: забрать пропуски с карты»");
  [...document.querySelectorAll("#bmFoot .btn")].find((b) => /Отмена/.test(b.textContent)).click();
  ok(await until(() => app === "hw" && sel === S.off && tab === "rep"), "«Отмена» возвращает на страницу хранилища");
  // Правило набора «Заполнять пропуски после обрыва связи» видно у хранилищ своих камер
  ok(edgeRulesFor(st(S.off)).length === 1 && /Заполнять пропуски после обрыва связи/.test(text()), "правило набора с командой replicate видно на странице хранилища камеры «Главный вход»");
  open(S.nvr);
  ok(edgeRulesFor(st(S.nvr)).length === 0, "у регистратора правил репликации нет");

  // Периферия камеры и карточка «Архив»
  open(CAM.off, "io");
  ok(await until(() => [...main().querySelectorAll(".pf-nm")].some((b) => /хранилище/i.test(b.textContent))), "встроенное хранилище — строка в «Периферии»");
  ok(/правил репликации: 1|репликация выключена|репликация: забирать всё/.test(text()), "в строке — подпись репликации");
  [...main().querySelectorAll(".pf-nm")].find((b) => /хранилище/i.test(b.textContent)).click();
  ok(await until(() => sel === S.off && tab === "rep"), "строка ведёт на вкладку «Репликация»");
  open(CAM.off, "rec");
  ok(/Встроенное хранилище/.test(text()) && /Настроить репликацию/.test(text()), "карточка «Архив» камеры: итог и переход к настройке");

  // Общий вид у сервера: камеры со встроенным хранилищем, проблемы наверху, фильтр по состоянию
  setSlice("arch");
  open(SRV, "edges");
  ok(await until(() => main().querySelector(".eo-tbl")), "у сервера вкладка «Встроенные хранилища» — таблица камер");
  const rows = () => [...main().querySelectorAll(".eo-row")];
  const names = rows().map((r) => r.querySelector(".er-nm b")?.textContent);
  ok(rows().length >= 14, "строка на камеру: камеры с картой и все камеры регистратора");
  ok(/записи потеряны/.test(rows()[0].textContent), "проблемы наверху: первая строка — «записи потеряны»");
  ok(names.includes("Камера NVR 9") && rows().find((r) => /Камера NVR 9/.test(r.textContent)).textContent.includes("не входит"), "исключённая камера регистратора — «не входит»");
  ok(rows().find((r) => /Лифт/.test(r.textContent)).textContent.includes("забирает"), "камера регистратора, которую сервер забирает сейчас, — «забирает»");
  ok(rows().find((r) => /Камера NVR 10/.test(r.textContent)).textContent.includes("нет связи"), "камера регистратора без связи — «нет связи»");
  const before = rows().length;
  eoFacet("state", "нет связи");
  ok(rows().length > 0 && rows().length < before && rows().every((r) => /нет связи/.test(r.querySelector(".er-st")?.textContent || "")), "фильтр «нет связи» оставляет такие камеры; стандартный блок .bk-scope");
  ok(/Показано/.test(main().querySelector(".bk-scope-sum")?.textContent || ""), "итог «Показано N из M»");
  eoFacetClear();
  ok(rows().length === before, "«все» возвращает строки");
  main().querySelector(".eo-row .er-go").click();
  ok(await until(() => find(sel)?.n.type === "storage" && tab === "rep"), "строка камеры открывает её встроенное хранилище");
  // Тот же вид у домена
  setSlice("arch");
  open(devices.find((d) => d.id === CAM.off).domainId, "edges");
  ok(await until(() => main().querySelector(".eo-tbl")), "и у домена");

  // Вкладка архива: хранилища сервера и групповая настройка
  open(ARCH, "edge");
  ok(await until(() => main().querySelector(".er-bulk")), "у хранилища сервера вкладка «Встроенные хранилища»");
  edgeArchPickToggle(S.off);
  edgeArchPickToggle(S.wait);
  ok(main().querySelector(".er-bulk.on") && /Отмечено 2/.test(main().querySelector(".er-bulk-n").textContent), "отметили два устройства");
  edgeArchBulk(ARCH, "off");
  ok((await until(() => st(S.wait).replication?.mode === "off")), "групповое «Выключена»: каждое хранилище — отдельный PATCH");
  ok(await mode(S.wait) === "off" && await camMode(id(30000038)) === "always", "камеру «Парковка» сервер вернул на always");
  // Часы сервера идут: пропуск камеры «Лифт» регистратора забран, сервер сообщил об этом событием, страница перечитала хранилище
  open(S.nvr);
  const lift = () => st(S.nvr).replicationStatus?.cameras?.find((c) => c.cameraId === NVR.lift);
  for (let i = 0; i < 22 && lift()?.state !== "ok"; i++) { await new Promise((r) => setTimeout(r, 5000)); await API.get(`/units/${CAM.off}`); }
  ok(lift()?.state === "ok" && lift().gaps.every((g) => g.result !== "queued"), "пропуск «Лифта» забран: replication.changed дошёл до открытой страницы, состояние камеры стало «ok» без чтения хранилища");
  // Ошибка правки: сервер отказал — консоль говорит об этом, настройка остаётся как была
  const patchWas = API.patch;
  API.patch = () => Promise.reject(Object.assign(new Error("x"), { status: 422 }));
  edgeSet(S.wait, "type", "all");
  ok(await until(() => document.getElementById("tt")?.textContent.trim()) && st(S.wait).replication.mode === "off", "отказ сервера: уведомление с причиной, настройка на экране не изменилась");
  API.patch = patchWas;

  // Профиль vms.edge/1 и права: без профиля вкладок репликации нет, без права на replication редактор только для чтения
  const impl = KINDS.get("storage").implements;
  KINDS.get("storage").implements = [];
  ok(!tabsFor(st(S.off)).some((x) => x[0] === "rep") && !tabsFor(find(ARCH).n).some((x) => x[0] === "edge") && edgeStorageCardHtml(find(CAM.off).n) === "", "без профиля vms.edge/1: нет вкладки «Репликация», вкладки архива и карточки на «Архиве»");
  KINDS.get("storage").implements = impl;
  ok(tabsFor(st(S.off)).some((x) => x[0] === "rep"), "с профилем вкладка есть");
  const bk = find("50000024-0000-4000-8000-000000000000")?.n;
  ok(!bk || !tabsFor(bk).some((x) => x[0] === "edge"), "у резерва при сбое (нет режима replica) вкладки «Встроенные хранилища» нет");
  const wf = st(S.off).writableFields;
  st(S.off).writableFields = [];
  open(S.off);
  ok(main().querySelectorAll(".er-types[role=radiogroup] .er-t[disabled]").length === 2, "без права на replication типы нельзя выбрать");
  st(S.off).writableFields = wf;
  open(S.off);
  ok(main().querySelectorAll(".er-types[role=radiogroup] .er-t[disabled]").length === 0, "с правом — можно");
  // Ссылка на страницу хранилища моргает
  open(S.nvr, "gen");
  edgeOpen(S.off);
  ok(await until(() => document.querySelector(".acc-flash")), "переход на страницу хранилища подсвечивает место, куда пришли");
  // Шаблоны и параметры команды
  ok(!("minutes" in (actionKind({ sub: "rec", action: "replicate" }).def || {})), "команда по умолчанию не несёт minutes: он нужен только периоду «последние минуты»");
  ok(RULE_TPL.some((x) => x.name === "Связь вернулась: забрать пропуски с карты") && RULE_TPL.some((x) => x.name === "Движение: забрать фрагмент с карты") && RULE_TPL.find((x) => x.id === "rsch").make().sched.every === 1440, "названия шаблонов без тире; шаблон по расписанию несёт every 1440 (сервер запускает только такие)");
  // Анимация раскрытия
  if (CSS.supports("selector(::details-content)")) {
    open(S.all);
    const adv = main().querySelector(".er-adv");
    ok(adv && /block-size/.test(getComputedStyle(adv, "::details-content").transitionProperty), "«Дополнительно» раскрывается плавно (высота анимируется)");
  } else ok(true, "браузер не знает ::details-content: раскрытие без анимации");
  // Ручной забор: просьба с edgeOnly; отказ по камере называет её; групповая настройка считает отказы
  const pcalls = [], postWas2 = API.post;
  API.post = function (path, body, ...r) {
    if (/archive-fetch/.test(path)) { pcalls.push([path, body]); if (path.includes(NVR.lift)) return Promise.reject(new Error("x")); }
    return postWas2.call(this, path, body, ...r);
  };
  const lostFrom = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 16), lostTo = new Date(Date.now()).toISOString().slice(0, 16);
  edgePull(S.nvr, lostFrom, lostTo);
  ok(await until(() => pcalls.length >= 9) && pcalls.every((c) => c[1].edgeOnly === true), "забор у регистратора: по просьбе на камеру, все с edgeOnly (квоту не тратят)");
  ok(await until(() => /Сервер отказал для камер/.test(document.getElementById("tt")?.textContent || "") && document.getElementById("tt").textContent.includes(locName(find(NVR.lift).n))), "камера, которой сервер отказал, названа в уведомлении");
  API.post = postWas2;
  const pw = API.patch;
  API.patch = function (path, ...r) { return path.includes(S.wait) ? Promise.reject(new Error("x")) : pw.call(this, path, ...r); };
  setSlice("arch");
  open(ARCH, "edge");
  edgeArchPickToggle(S.off); edgeArchPickToggle(S.wait);
  edgeArchBulk(ARCH, "all");
  ok(await until(() => /Сервер отказал: 1/.test(document.getElementById("tt")?.textContent || "")), "групповая настройка: в уведомлении число отказов");
  API.patch = pw;

  // Событие пришло, когда экран хранилищ закрыт: вкладки камеры потом читают хранилище заново, а не показывают старое
  open(CAM.off, "gen");
  edgeOwnDone.add(CAM.off);
  edgeOnEvent({ type: "replication.changed", kind: "storage", entityId: S.off, payload: { state: "ok" } });
  await new Promise((r) => setTimeout(r, 400));
  ok(!edgeOwnDone.has(CAM.off), "экран хранилищ закрыт: владелец снят с «уже прочитано», вкладка камеры прочитает заново");
});
