/* Наложение текста на видео камеры (пробел F37, PMD-5967): вкладка «Видео» → раздел «Наложение текста».
   Свойство камеры overlayTexts (профиль vms.camera/1 1.5): надписи из набора, добавление щелчком и ввод на кадре
   (Enter, Esc), двойной щелчок и Enter/F2 — правка текста, перетаскивание за любое место, стрелки, Delete, поля вида
   и «Слева, %»/«Сверху, %», предупреждение «выходит за край кадра», предел из схемы вида, черновик → одна строка плана
   «Надписи на кадре», «Сбросить» возвращает надписи, «Применить» сохраняет их на сервере (с проверкой сервером),
   «Применить к другим…» с группой «Надписи на кадре» — шаг patch у камеры-получателя.
   Запуск: python3 tools/check_ui.py tests/ui-nalozhenie-teksta.js */
UiCheck(async ({ ok, until, absent }) => {
  if (typeof otSecHtml !== "function") return absent("раздела «Наложение текста»");
  const CAM = "30000013-0000-4000-8000-000000000000"; // «1. Главный вход»
  const CAM2 = "30000041-0000-4000-8000-000000000000"; // «2а. Запасной вход»
  const main = () => document.getElementById("main");
  const stage = () => main().querySelector("[data-ot-stage]");
  const geo = () => stage().querySelector("[data-ot-geo]");
  const at = (fx, fy, extra = {}) => { const r = stage().getBoundingClientRect(); return { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: r.x + r.width * fx, clientY: r.y + r.height * fy, ...extra }; };
  const down = (el, fx, fy) => el.dispatchEvent(new MouseEvent("mousedown", at(fx, fy)));
  const up = (fx, fy) => window.dispatchEvent(new MouseEvent("mouseup", at(fx, fy)));
  const move = (fx, fy) => window.dispatchEvent(new MouseEvent("mousemove", at(fx, fy)));
  const key = (k, extra = {}) => stage().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
  const list = () => otOf(find(CAM).n);
  const sum = () => main().querySelector("[data-ot-sum]")?.textContent || "";
  const rect = (id) => geo().querySelector(`[data-o="${id}"]`);
  const inl = () => stage().querySelector(".ot-inl");
  const addBtn = () => [...main().querySelectorAll(".ot-sec button")].find((b) => b.textContent.trim() === "Добавить надпись");
  const row = () => cardDiff().find((r) => r.schemaProp === "overlayTexts");
  const planT = () => row()?.toT || "";

  goApp("hw");
  await hwEnsure([CAM, CAM2]);
  openNode(CAM, { app: "hw", tab: "vid" });
  ok(await until(() => stage()), "вкладка «Видео»: раздел «Наложение текста» с кадром");
  const name0 = "Главный вход";
  ok(list().length === 1 && list()[0].text === name0 && list()[0].size === 64, "из набора: одна надпись «Главный вход», остальные поля — по умолчанию");
  ok(list()[0].font === "Arial" && list()[0].color === "#ffffff" && list()[0].outline === true && list()[0].bgClear === 40, "поля, которых нет в записи, заполнены умолчаниями схемы");
  ok(sum() === "1 надпись", "итог раздела — «1 надпись»");
  ok(!main().querySelector(".ot-sec .cv-stub"), "заглушки в разделе нет");
  ok(!cardDiff().length, "без правок плана нет");

  // Добавление: инструмент, щелчок по кадру — надпись по умолчанию и ввод на кадре
  otTool(CAM);
  ok(ot.tool && stage().classList.contains("draw"), "«Добавить надпись» включает инструмент");
  key("Escape");
  ok(!ot.tool, "Esc снимает инструмент");
  otTool(CAM);
  down(geo(), 0.4, 0.5); up(0.4, 0.5);
  ok(await until(() => list().length === 2 && inl()), "щелчок по кадру добавил надпись и открыл ввод на кадре");
  const nid = list()[1].id;
  ok(Math.abs(list()[1].pos[0] - 0.4) < 0.01 && Math.abs(list()[1].pos[1] - 0.5) < 0.01, "надпись стоит там, где щёлкнули");
  ok(document.activeElement === inl(), "фокус — в поле ввода на кадре");
  inl().value = "NORTH-St 22";
  inl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok(await until(() => !inl() && list()[1].text === "NORTH-St 22"), "Enter сохранил текст и закрыл ввод");
  ok(sum() === "2 надписи", "итог — «2 надписи»");
  ok(cardDiff().filter((r) => r.schemaProp === "overlayTexts").length === 1 && row().label === "Надписи на кадре" && row().fromT === "1 надпись", "план: одна строка «Надписи на кадре», было — «1 надпись»");
  ok(planT().includes("добавлена «NORTH-St 22»"), "план: «добавлена «NORTH-St 22»»");
  ok(Array.isArray(row().to) && row().to.length === 2 && !("id" in row().to[1]) && row().to[1].font === "Arial" && row().to[1].size === 56, "значение строки — список надписей в виде свойства схемы, без id");

  // Правка текста: Enter/F2 у выбранной надписи, Esc отменяет; двойной щелчок
  ok(ot.sel === nid, "новая надпись выбрана");
  key("F2");
  ok(await until(() => inl()), "F2 открыл ввод текста");
  inl().value = "не сохранять";
  inl().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  ok(await until(() => !inl() && list()[1].text === "NORTH-St 22"), "Esc закрыл ввод без правки");
  rect(nid).dispatchEvent(new MouseEvent("dblclick", at(0.42, 0.52, { detail: 2 })));
  ok(await until(() => inl()), "двойной щелчок по надписи открыл ввод на кадре");
  inl().value = "NORTH-St 23";
  inl().dispatchEvent(new FocusEvent("blur"));
  ok(await until(() => !inl() && list()[1].text === "NORTH-St 23"), "уход фокуса сохранил текст");

  // Перетаскивание за любое место окна надписи
  const p0 = list()[1].pos.slice();
  down(rect(nid), 0.42, 0.52); move(0.52, 0.42); up(0.52, 0.42);
  ok(await until(() => Math.abs(list()[1].pos[0] - (p0[0] + 0.1)) < 0.01 && Math.abs(list()[1].pos[1] - (p0[1] - 0.1)) < 0.01), "перетаскивание сдвинуло надпись");
  // Стрелки: шаг 1 %, с Shift — 5 %
  stage().focus();
  const p1 = list()[1].pos.slice();
  key("ArrowRight"); key("ArrowDown", { shiftKey: true });
  ok(Math.abs(list()[1].pos[0] - p1[0] - 0.01) < 0.001 && Math.abs(list()[1].pos[1] - p1[1] - 0.05) < 0.001, "стрелки сдвигают на 1 %, с Shift — на 5 %");
  // Поля «Слева, %» и «Сверху, %» — без перетаскивания
  otSet(CAM, nid, "x", "10"); otSet(CAM, nid, "y", "20");
  ok(list()[1].pos[0] === 0.1 && list()[1].pos[1] === 0.2, "поля «Слева, %» и «Сверху, %» ставят место");
  otSet(CAM, nid, "x", "150");
  { const b = otBox(list()[1]); ok(Math.abs(list()[1].pos[0] - (1 - b.w / DW_X)) < 0.001, "«Слева, %» не выводит надпись за правый край кадра"); }
  otSet(CAM, list()[0].id, "x", "20");
  ok(planT().includes(`«${name0}»: место — слева 3 %, сверху 4 % → слева 20 %, сверху 4 %`), "план: место — «слева 3 %, сверху 4 % → слева 20 %, сверху 4 %»");

  // Вид: размер в пределах, цвет, обводка, фон; длинный текст — предупреждение
  otSet(CAM, nid, "x", "10");
  otSet(CAM, nid, "size", "500");
  ok(list()[1].size === 200, "размер не больше 200 пт");
  otSet(CAM, nid, "size", "3");
  ok(list()[1].size === 8, "размер не меньше 8 пт");
  otSet(CAM, nid, "color", "#ffd60a");
  ok(await until(() => main().querySelector('.ot-c.on[aria-label="Жёлтый"][tabindex="0"]')), "быстрый цвет отмечен, Tab попадает на него");
  main().querySelector('.ot-c.on').focus();
  main().querySelector('.ot-c.on').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  ok(await until(() => list()[1].color === "#3ddc84" && document.activeElement?.getAttribute("aria-label") === "Зелёный"), "стрелка выбрала соседний цвет, фокус на нём");
  otSet(CAM, nid, "color", "#ffd60a");
  // Смена поля не уводит фокус: блок перерисован, фокус на том же поле
  const fs = main().querySelector('.ot-row.on select[id$="-font"]');
  fs.focus(); fs.value = "Verdana"; fs.dispatchEvent(new Event("change", { bubbles: true }));
  ok(await until(() => list()[1].font === "Verdana" && document.activeElement?.id === fs.id && document.activeElement !== fs), "после смены шрифта фокус — на поле «Шрифт»");
  otSet(CAM, nid, "font", "Arial");
  otSet(CAM, nid, "color", "red\"><b>x");
  ok(list()[1].color === "#ffffff", "цвет не по образцу #rrggbb не принят");
  otSet(CAM, nid, "color", "#ffd60a");
  otSet(CAM, nid, "bg", true);
  ok(geo().querySelectorAll("g > rect:not(.ot-a)").length === 1, "фон рисует подложку под текстом");
  otSet(CAM, nid, "text", "Северный въезд на территорию склада, ворота 2, полоса для грузовых машин");
  otSet(CAM, nid, "size", "64");
  ok(await until(() => main().querySelector(".ot-msg.bad") && rect(nid).classList.contains("bad")), "длинный текст: предупреждение у полей и рамка на кадре");
  ok(main().querySelector(".ot-row.on .ot-warn"), "длинный текст: знак в строке списка");
  otSet(CAM, nid, "text", "NORTH-St 23");
  ok(!main().querySelector(".ot-msg.bad"), "короткий текст — предупреждения нет");
  ok(planT().includes("добавлена «NORTH-St 23»"), "план: новая надпись с текущим текстом");

  // Ввод на кадре: уход фокуса на кнопку блока не перестраивает блок — щелчок по кнопке не теряется
  await until(() => !document.querySelector("#main .ot-inl"));
  stage().focus(); key("F2");
  ok(await until(() => inl()), "F2 открыл ввод перед уходом фокуса");
  const del = [...main().querySelectorAll(".ot-row.on .pm-del")][0];
  inl().value = "NORTH-St 24"; del.focus(); inl()?.dispatchEvent(new FocusEvent("blur"));
  ok(!inl() && list()[1].text === "NORTH-St 24" && del.isConnected, "уход фокуса сохранил текст, кнопка «Убрать надпись» на месте");
  stage().focus(); key("F2"); await until(() => inl());
  inl().value = "   "; inl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok(await until(() => !inl() && list()[1].text === "NORTH-St 24"), "пустой текст не сохраняется");
  otSet(CAM, nid, "text", "NORTH-St 23");

  // «Как видит оператор»: без рамок и без правки
  otView(CAM);
  ok(!geo().querySelector(".ot-a") && geo().querySelectorAll("text").length === 2, "«Как видит оператор»: текст без рамок");
  otView(CAM);

  // Delete убирает выбранную, план называет убранную надпись
  const first = list()[0].id;
  otSel(CAM, first); stage().focus(); key("Delete");
  ok(list().length === 1 && !list().some((a) => a.id === first), "Delete убрал выбранную надпись");
  ok(planT().includes(`убрана «${name0}»`), "план: «убрана «Главный вход»»");

  // Добавление с клавиатуры: инструмент, Enter на кадре
  const k0 = list().length;
  otTool(CAM); stage().focus(); key("Enter");
  ok(await until(() => list().length === k0 + 1 && inl()), "Enter с инструментом добавил надпись и открыл ввод");
  inl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => !inl());
  ok(new Set(list().map((a) => a.id)).size === list().length, "id надписей не повторяются");

  // Предел числа надписей
  const MAX = nodeProps(find(CAM).n).overlayTexts.maxItems;
  ok(MAX === 8 && otMax(find(CAM).n) === MAX, "предел числа надписей — из схемы вида камеры");
  while (list().length < MAX) { otTool(CAM); down(geo(), 0.05, 0.05 + list().length * 0.1); up(0.05, 0.05); otInlEnd(CAM, ot.inl, "x"); }
  ok(list().length === MAX && addBtn().disabled && /Сначала убрать одну надпись/.test(addBtn().dataset.tip || ""), `${MAX} надписей: «Добавить надпись» неактивна, причина в подсказке`);

  // «Сбросить» возвращает надписи до плана; на сервере ничего не менялось
  ok(row().to.length === MAX, "план несёт весь список");
  cardReset();
  ok(await until(() => stage() && list().length === 1 && list()[0].text === name0), "«Сбросить» вернул надписи до плана");
  ok(!cardDiff().length && !find(CAM).n.xprops?.overlayTexts, "после «Сбросить» плана нет");
  ok(unitProps.get(CAM).overlayTexts.length === 1, "на сервере надпись прежняя");
  // Правка, равная значению сервера, строки плана не даёт
  otSet(CAM, list()[0].id, "size", "70");
  ok(!!row(), "правка размера — строка плана");
  otSet(CAM, list()[0].id, "size", "64");
  ok(!row() && !find(CAM).n.xprops?.overlayTexts, "возврат значения сервера снимает строку плана");
  // Пустой текст: в список и в план не идёт, поле показывает ввод, под ним правило
  otSel(CAM, list()[0].id);
  { const id0 = list()[0].id, before = JSON.stringify(cardDiff().map((r) => r.to)), inp = main().querySelector(".ot-row.on .ot-inp");
    ok(!!inp, "у выбранной надписи открыты поля вида");
    inp.value = "   "; otSet(CAM, id0, "text", "   ");
    ok(list()[0].text === name0 && !row() && JSON.stringify(cardDiff().map((r) => r.to)) === before, "пустой текст: список и план не изменились");
    ok(main().querySelector(".ot-row.on .ot-inp")?.value === "   " && main().querySelector("[data-ot-empty]")?.style.display === "", "поле показывает введённое, правило видно под ним");
    otSet(CAM, id0, "text", "Вход");
    ok(!!row() && list()[0].text === "Вход" && main().querySelector("[data-ot-empty]")?.style.display === "none", "текст не пустой: строка плана есть, правило скрыто");
    otSet(CAM, id0, "text", name0);
    ok(!row(), "возврат текста снимает строку плана"); }
  // Текст новой надписи — имя камеры, не длиннее maxLength схемы
  { const n = find(CAM).n, nm = n.name; n.name = "Я".repeat(300);
    otTool(CAM); down(geo(), 0.2, 0.5); up(0.2, 0.5);
    ok(await until(() => list().length === 2), "добавлена надпись у камеры с длинным именем");
    ok(list()[1].text.length === 128 && row().to[1].text.length === 128, "текст по умолчанию обрезан до maxLength схемы (128)");
    otInlEnd(CAM, ot.inl, "Ж".repeat(300));
    ok(list()[1].text.length === 128, "ввод на кадре обрезан до maxLength");
    n.name = nm; cardReset();
    ok(await until(() => stage() && list().length === 1 && !cardDiff().length), "«Сбросить» убрал надпись"); }

  // «Применить»: сервер проверяет список, надписи сохранены вместе с видом
  otSet(CAM, list()[0].id, "color", "#ffd60a");
  otSet(CAM, list()[0].id, "outline", false);
  otSet(CAM, list()[0].id, "text", "Въезд");
  ok(planT().includes("цвет — белый → жёлтый") && planT().includes("обводка — вкл. → выкл.") && planT().includes("текст — «Главный вход» → «Въезд»"), "план называет изменённые поля со значениями");
  cardApply();
  ok(await until(() => bq && bq.finished), "план выполнен: не ок " + bq?.fail);
  { const r = unitProps.get(CAM).overlayTexts; ok(r.length === 1 && r[0].text === "Въезд" && r[0].color === "#ffd60a" && r[0].outline === false && !("id" in r[0]), "на сервере — одна надпись с новым видом, без id"); }
  ok(await until(() => stage() && list().length === 1 && list()[0].text === "Въезд" && !cardDiff().length), "после «Применить» блок показывает значение сервера, плана нет");
  // Список равен серверному после снятия всех надписей — на сервер уходит пустой список
  otDel(CAM, list()[0].id);
  ok(list().length === 0 && sum() === "нет надписей" && row()?.to.length === 0, "все убраны: итог «нет надписей», в плане пустой список");
  cardApply();
  ok(await until(() => bq && bq.finished && (unitProps.get(CAM).overlayTexts || []).length === 0), "пустой список сохранён на сервере");
  ok(await until(() => stage() && list().length === 0), "блок показывает пустой список");
  cardReset();
  // Надпись «Главный вход» возвращаем для проверки копирования
  otTool(CAM); down(geo(), 0.03, 0.04); up(0.03, 0.04); otInlEnd(CAM, ot.inl, "Главный вход");
  cardApply();
  ok(await until(() => bq && bq.finished && unitProps.get(CAM).overlayTexts?.[0]?.text === "Главный вход"), "надпись сохранена снова");
  await until(() => stage() && list().length === 1 && !cardDiff().length);
  // Сервер не принимает цвет не по образцу: правка отклонена, на сервере прежнее
  { let st = 0; try { await API.patch(`/units/${CAM}`, { properties: { overlayTexts: [{ text: "x", pos: [0, 0], color: "red" }] } }, hwVer.get(CAM)); } catch (e) { st = e.status; }
    ok(st === 422 && unitProps.get(CAM).overlayTexts[0].text === "Главный вход", "сервер: цвет «red» — 422, надпись прежняя"); }

  // Сервер без свойства overlayTexts: блока нет (правило 5 design-rules); только для чтения: поля и кнопки неактивны
  { const ps = KINDS.get("camera").schema.properties, keep = ps.overlayTexts, n = find(CAM).n;
    ok(otSecHtml(n).includes("data-prof-field"), "у блока метка профиля (скрытие по absent)");
    delete ps.overlayTexts;
    ok(otSecHtml(n) === "" && !cpGroups(n).some((g) => g.key === "osd"), "вид камеры без overlayTexts: раздела нет и группы «Надписи на кадре» нет");
    ps.overlayTexts = Object.assign({}, keep, { readOnly: true });
    const h = otSecHtml(n);
    ps.overlayTexts = keep;
    const rw = otSecHtml(n);
    ok(/id="ot-add"[^>]*disabled/.test(h) && !/data-ot-stage="[^"]*"[^>]*mousedown/.test(h) && /data-ot-stage="[^"]*"[^>]*mousedown/.test(rw) && /Только для просмотра|только для просмотра/.test(h), "схема readOnly: «Добавить надпись» неактивна, на кадре правки нет");
    // Unit.writable без overlayTexts: у объекта без значения блок прячет профиль (absent), с значением — только чтение (canWrite)
    const c2 = find(CAM2).n, m2 = unitAbsentMeta.get(CAM2), pr = unitProps.get(CAM2), w0 = c2.writableFields, mw = m2?.writable;
    ok(!!m2 && !("overlayTexts" in pr), "у камеры 2 значения надписей нет");
    c2.writableFields = ["name"]; m2.writable = ["name"];
    const box = document.createElement("div"); box.innerHTML = otSecHtml(c2);
    profHideApply(box.firstElementChild);
    ok(otRo(c2) && box.firstElementChild.hasAttribute("hidden"), "writable без overlayTexts, значения нет: блок скрыт (absent), правка закрыта (canWrite)");
    ok(!otCanGet(c2), "такая камера не получает надписи из «Применить к другим…»");
    pr.overlayTexts = [{ text: "x", pos: [0, 0] }];
    box.innerHTML = otSecHtml(c2); profHideApply(box.firstElementChild);
    ok(!box.firstElementChild.hasAttribute("hidden") && /id="ot-add"[^>]*disabled/.test(box.innerHTML), "значение есть, правка закрыта: блок виден только для чтения");
    delete pr.overlayTexts;
    if (w0) c2.writableFields = w0; else delete c2.writableFields;
    if (mw) m2.writable = mw; else delete m2.writable;
    ok(otCanGet(c2), "правка снова разрешена: камера получает надписи"); }
  // «Применить к другим…»: группа «Надписи на кадре» уже отмечена, план копирования меняет надписи камеры-получателя
  otCopy(CAM);
  ok(await until(() => cp && cp.groups.has("osd")), "«Применить к другим…» открыл окно с группой «Надписи на кадре»");
  ok(cpGroups(find(CAM).n).some((g) => g.key === "osd" && !g.tag && !g.off), "группа без пометки «заглушка», доступна");
  ok(cpCanGet(find(CAM2).n), "камера-получатель может взять надписи");
  closeBulkModal(); cp = null;
  // Шаг копирования: операция на сервере, шаг patch свойства overlayTexts у камеры-получателя
  const copy = [otWire(otNew("q", "COPY", [0.1, 0.1], { size: 40, color: "#22d3ee" }))];
  const ch = bulkChanges({ osdCopy: copy }, [find(CAM2).n]);
  const ops = ch.flatMap((c) => c.ops);
  ok(ch.length === 1 && ch[0].key === "osd" && ops.length === 1, "план копирования: шаг «Надписи на кадре» у получателя");
  const it = opItems(opsToItems(ops))[0];
  ok(it.uid === CAM2 && it.patch?.properties?.overlayTexts?.[0]?.text === "COPY" && !("id" in it.patch.properties.overlayTexts[0]), "шаг — patch свойства overlayTexts без id");
  // Путь пользователя: окно копирования → «Показать план» → «Применить»
  otCopy(CAM);
  ok(await until(() => cp && cp.groups.has("osd")), "окно копирования открыто снова");
  cp.picked.clear(); cp.picked.add(CAM2);
  cpShowPlan();
  ok(Array.isArray(bulkDraft.osdCopy) && bulkDraft.osdCopy.length === 1 && bulkDraft.osdCopy[0].text === name0 && !("id" in bulkDraft.osdCopy[0]), "cpShowPlan: в черновике группы — надписи образца без id");
  { const st = bulkChanges().find((s) => s.key === "osd");
    ok(st && st.ops.length === 1 && st.ops[0].n.id === CAM2 && st.ops[0].api.set.overlayTexts[0].text === name0, "шаг «Надписи на кадре» — у камеры 2, в нём надписи образца");
    ok(/Надписи на кадре: 1/.test(st.label), "подпись шага — «Надписи на кадре: 1»"); }
  closeBulkModal(); bulkApply();
  ok(await until(() => bq && bq.finished), "операция копирования выполнена: не ок " + bq?.fail);
  ok((unitProps.get(CAM2).overlayTexts || [])[0]?.text === name0 && unitProps.get(CAM2).overlayTexts[0].size === 56, "на сервере у получателя — надписи образца");
  ok(bulkChanges({ osdCopy: otOf(find(CAM).n).map(otWire) }, [find(CAM2).n]).length === 0, "получателю с теми же надписями шаг не нужен");
  // Английский: строки блока переведены
  const was = uiLang; uiLang = "en";
  ok(i18n("Наложение текста") === "Text overlay" && i18n("Добавить надпись") === "Add text", "английский: строки блока переведены (assets/i18n-en.js)");
  uiLang = was;
});
