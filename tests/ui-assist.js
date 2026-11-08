/* Сценарии интерфейса: ассистент. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until }) => {
  // Панель рядом с деревом: поверх она закрылась бы на плане настройки, а сценарий смотрит в неё
  asstVariantSet("side");
  // Вход — из поиска: первой строкой «Спросить ассистента», набранное уходит просьбой явным выбором, запрос поиска снимается
  const inp = document.getElementById("gq");
  inp.value = "выключи запись Главный вход";
  goInput(inp.value);
  ok(document.getElementById("goAsk") === document.querySelector("#goList .gores") && /Спросить ассистента/.test(document.getElementById("goAsk").textContent) && /выключи запись Главный вход/.test(document.getElementById("goAsk").textContent), "первой строкой — «Спросить ассистента» с набранным текстом");
  goPick(0);
  // План в панели: у плана настройки — «Открыть в дереве», у плана правил — «Применить»
  const planShown = () => document.getElementById("asstPlanNote") || document.getElementById("asstApply");
  ok(await until(planShown), "из поиска — сразу план");
  ok(inp.value === "" && treeQ === "", "запрос поиска снят");
  goClose();
  // Объекты — страницами GET /units, свойства — в properties
  const unitsAll = async (q) => { const out = []; let cursor = null; do { const r = await API.get("/units", Object.assign({ cursor, limit: 1000 }, q || {})); out.push(...r.items); cursor = r.nextCursor || null; } while (cursor); return out; };
  const recOf = async (uid) => (await API.get(`/units/${uid}`)).properties.recordMode;
  const camId = (await unitsAll({ kind: "camera" })).find((u) => u.name.includes("Главный вход")).uid;
  const before = await recOf(camId);
  // Ответ и уточнение — в поле под ответом, клавиатурой, как человек. Строка поиска — новая просьба, новый разговор
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const enter = () => key(inp, "Enter");
  const typeQ = (t) => { inp.value = t; inp.dispatchEvent(new Event("input", { bubbles: true })); };
  const field = () => document.getElementById("asstText");
  const typeF = (t) => { const f = field(); f.focus(); f.value = t; f.dispatchEvent(new Event("input", { bubbles: true })); };
  const say = (t) => { typeF(t); key(field(), "Enter"); };
  const typeKeys = (e, t) => [...t].forEach((ch) => { key(e, ch); e.value += ch; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true })); });
  const body = () => document.getElementById("asstBlock").textContent;
  const dockOpen = () => !document.getElementById("asstDock").hidden;
  const press = (el) => ["mousedown", "mouseup", "click"].forEach((type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
  const tag = () => document.getElementById("asstTag");
  const treeIds = () => [...document.querySelectorAll("#tree .n[data-pick]")].map((x) => x.dataset.pick);
  // Камера бывает в дереве дважды: под сервером и в группе «Без записи»
  const camRows = () => [...new Set(treeIds().filter((id) => find(id)?.n.type === "camera"))];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const untilA = async (fn, n = 400) => { for (let i = 0; i < n; i++) { if (await fn()) return true; await sleep(25); } return false; };
  // «Применить» плана настройки — только черновиком групповой карточки: «Показать план» → «Применить», мышью
  const cardApply = async () => {
    const foot = document.getElementById("bulkFoot"), show = foot && [...foot.querySelectorAll("button")].find((b) => /Показать план/.test(b.textContent));
    if (!show) return false;
    press(show);
    if (!(await until(() => document.getElementById("bmodal")?.classList.contains("open")))) return false;
    const go = [...document.querySelectorAll("#bmodal button")].find((b) => /^Применить/.test(b.textContent));
    if (!go || go.disabled) return false;
    press(go);
    return until(() => bq && bq.finished);
  };
  const PH = "Имя, IP, раздел, настройка…";

  // Вопрос и ответ
  asstOpen("");
  ok(dockOpen() && !document.getElementById("bmodal").classList.contains("open"), "ассистент в своей панели, окна нет");
  ok(field() && field().placeholder === "Просьба" && document.getElementById("asstSend")?.textContent === "Отправить", "под панелью своё поле и «Отправить»");
  ok(document.activeElement === field(), "курсор в поле просьбы");
  ok(!document.getElementById("asstKind") && !document.querySelector("[data-asst-kind]"), "выбора типа нет");
  ok(inp.placeholder === PH, "подсказка строки поиска прежняя: " + inp.placeholder);
  say("выключи запись");
  ok(await until(() => document.getElementById("asstAsk")), "ассистент спросил");
  ok(field() && field().placeholder === "Ваш ответ" && field().value === "", "поле под вопросом, подпись «Ваш ответ», отправленное снято");
  // Ответ строит план: объекты — в дереве тегом и выбором, значения — в групповой карточке как правка человека
  say("Главный вход");
  ok(await until(() => document.getElementById("asstPlanNote") && bulkActive()), "план показан, открыта групповая карточка");
  ok(/Камеры: \d+/.test(body()) && body().includes("recordMode") && !body().includes("/properties/"), "кого выбрали и что меняется — кодом поля, как в базе: " + body().slice(0, 200));
  ok(!document.getElementById("asstApply") && !document.getElementById("asstDecline") && /в групповой карточке/.test(document.getElementById("asstPlanNote")?.textContent || ""), "в панели «Применить» нет: применение — в карточке");
  const planIds = asst.plan.items.map((x) => x.uid);
  ok(tag()?.textContent === `Ассистент: ${planIds.length}`, "тег над деревом: " + tag()?.textContent);
  ok(treeSel.size === planIds.length && planIds.every((id) => treeSel.has(id)), "все объекты плана отмечены");
  // Камеры сервера без связи раскладка по серверам не раскрывает, по папкам видны все: строки — часть плана, лишних нет
  const onLine = planIds.filter((id) => { const sv = srv(id); return !(sv && hasNoSignal(sv)); });
  ok(onLine.length < planIds.length, "в плане есть камера сервера без связи");
  ok(await until(() => camRows().length === (group() === "server" ? onLine.length : planIds.length)) && camRows().every((id) => planIds.includes(id)), "в дереве только объекты плана: " + camRows().length + " из " + planIds.length);
  const recBox = document.querySelector('[data-bk="rec"]');
  ok(recBox && recBox.classList.contains("bk-set") && recBox.querySelector("select").value === "none", "поле «Режим» заполнено значением плана и подсвечено");
  ok(/по плану ассистента: Нет ×\d+/.test(recBox.textContent), "под полем — значения плана: " + recBox.textContent.slice(0, 160));
  ok((await recOf(camId)) === before, "без «Применить» ничего не записано");
  // «Применить» — черновиком карточки: одна групповая операция с откатом
  ok(await cardApply(), "«Показать план» → «Применить» мышью");
  ok(await untilA(async () => (await recOf(camId)) === "none"), "записано на сервере");
  ok(await until(() => find(camId)?.n.rec === "none"), "дерево обновилось потоком");
  ok(/План применён через карточку/.test(document.getElementById("asstInfo")?.textContent || "") && !document.getElementById("asstPlanNote") && !document.getElementById("asstPlanOpen"), "в панели — что план применён");
  const op1 = (await API.get("/operations", { limit: 1 })).items[0];
  ok(op1 && op1.items.length > 1 && op1.items.every((x) => planIds.includes(x.targetId)), "одна операция на объекты плана: " + op1?.items.length);
  ok(await untilA(async () => (await API.get(`/operations/${op1.id}`)).revertible), "операция откатывается");
  await API.post(`/operations/${op1.id}/revert`);
  ok(await until(() => find(camId)?.n.rec === before), "откат одной операцией: значение вернулось");

  // Отказ: без плана. Новый разговор: заглушка читает просьбу вместе с context, а в нём — «выключи запись»
  goClose();
  asstOpen();
  say("поменяй маску сети на камерах");
  ok(await until(() => document.getElementById("asstRefused")), "отказ показан");
  ok(!planShown(), "плана нет");
  // Устаревший план: версии плана уходят с «Применить», чужая правка после плана — обычный отказ версии, ничего не записано
  goClose();
  asstOpen();
  say("выключи запись Главный вход");
  ok(await until(() => document.getElementById("asstPlanNote") && bulkActive()), "новый план в карточке");
  const d = await API.get(`/units/${camId}`);
  await API.patch(`/units/${camId}`, { name: d.name + " 2" }, d.version);
  ok(await cardApply(), "«Применить» мышью");
  ok(bq.fail > 0 && bq.steps.every((st) => st.ops.every((o) => o.state === "fail" || o.state === "excl" || o.state === "skip")), "отказ всей операции: ни один шаг не выполнен");
  ok(/изменил/.test(bq.steps[0].ops.find((o) => o.state === "fail")?.msg || ""), "причина словами: " + bq.steps[0].ops.find((o) => o.state === "fail")?.msg);
  ok((await recOf(camId)) === before, "ничего не записано");
  closeBulkModal();   // за открытым отчётом план не трогает дерево
  goClose();

  // План правил. Поля типа нет ни в каком разделе: что за реплика, решает сервер по словам
  const kinds = [], stream = API.stream;
  API.stream = (p, b, ...r) => { kinds.push("kind" in b ? b.kind : "-"); return stream(p, b, ...r); };
  const R1 = "70000001-0000-4000-8000-000000000000";
  const server = (id) => API.get("/rules/" + id);
  const rows = () => [...document.querySelectorAll("[data-asst-row]")].map((e) => e.dataset.asstRow);
  const talk = (t) => { goClose(); asstOpen(""); say(t); };
  const planRules = async (rules) => { asst.plan = null; asst.result = null; asstEvent(asst, { type: "plan", summary: "Test", context: "c", rules }); return until(() => document.getElementById("asstApply")); };
  asstOpen("");
  say("выключи запись Главный вход");
  ok(await until(() => document.getElementById("asstPlanNote")), "план устройств");
  ok(kinds.join() === "-", "вне раздела правил поля kind нет");
  ok(!!asst.plan.items && !asst.plan.rules, "плана правил нет");
  goClose();
  goApp("rules");

  // Новое правило: показ словами формы, модель подписана, ход ничего не записал, запись — по нажатию, наблюдающим
  const count0 = (await API.get("/rules")).items.length;
  asstOpen("");
  say("при движении на Запасной вход пиши 5 минут");
  ok(await until(() => document.getElementById("asstApply")), "план правил показан в том же окне");
  ok(kinds[1] === "-", "в разделе правил поля kind тоже нет: план правил — по словам просьбы");
  ok(/Новое правило «Запись при движении: Запасной вход»/.test(body()) && /Детектор: движение/.test(body()) && /Записывать/.test(body()), "показ словами формы: " + body().slice(0, 200));
  ok(/Слова модели: Create a rule/.test(body()), "сводка модели отдельно и подписана");
  ok(/Только журнал/.test(body()), "рядом — что заведётся наблюдающим");
  ok((await API.get("/rules")).items.length === count0, "ход ничего не записал");
  document.getElementById("asstApply").click();
  ok(await until(() => rows().length === 1), "итог по записям");
  const madeId = (await API.get("/rules")).items.find((x) => x.name === "Запись при движении: Запасной вход").id, made = await server(madeId);
  ok(made.enabled && made.logOnly && made.owner === "" && made.runAsRoleId === null && made.logOnlySince, "заведено наблюдающим, умолчания перевода");
  ok(await until(() => rules.some((x) => x.id === madeId)), "правило пришло в раздел потоком");

  // Правило от модели включённым и действующим форма такой не заводит; выключенное остаётся выключенным
  talk("при движении на Запасной вход пиши 5 минут");
  ok(await until(() => document.getElementById("asstApply")), "снова план");
  await planRules([{ table: "scenarios", op: "create", body: Object.assign({}, asst.plan.rules[0].body, { name: "Действующее от модели", enabled: true, logOnly: false }) },
    { table: "scenarios", op: "create", body: Object.assign({}, asst.plan.rules[0].body, { name: "Выключенное от модели", enabled: false, logOnly: false }) }]);
  ok(/Заведётся выключенным|создаст правило выключенным/.test(body()), "выключенное названо");
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "ok,ok"), "обе записи: " + rows().join());
  const all = (await API.get("/rules")).items, live = all.find((x) => x.name === "Действующее от модели"), off = all.find((x) => x.name === "Выключенное от модели");
  ok(live.enabled && live.logOnly, "включённое — только наблюдает");
  ok(!off.enabled, "выключенное — выключенным");

  // Правка: было и станет, выпавшее названо, запись только по нажатию; наблюдения не заводит
  const r0 = await server(R1);
  talk("в правиле Охрана входа ночью убери условия");
  ok(await until(() => document.getElementById("asstApply")), "план правки");
  ok(document.querySelectorAll("[data-asst-gone]").length === r0.conditions.length && /Условие 1/.test(body()) && /выпадает/.test(body()), "выпавшие условия видны до «Применить»: " + body().slice(0, 240));
  ok(/наблюдения нет|без режима «Только журнал»/.test(body()), "предел назван");
  ok((await server(R1)).version === r0.version, "ход ничего не записал");
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "ok"), "записано");
  const r1 = await server(R1);
  ok(r1.conditions.length === 0 && r1.steps.length === r0.steps.length && r1.logOnly === r0.logOnly && r1.triggers.length === r0.triggers.length, "PUT целиком: чтение поверх изменённого, наблюдения нет");
  talk("в правиле Охрана входа ночью убери шаг");
  ok(await until(() => document.querySelectorAll("[data-asst-gone]").length === 1), "выпавший шаг виден: " + body().slice(0, 240));

  // Чужая версия: правило изменили после показа — строка отказа, чужая правка на месте
  await API.put("/rules/" + R1, Object.assign(ruleBody(rules.find((x) => x.id === R1)), { purpose: "чужая правка" }), (await server(R1)).version);
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "fail"), "VERSION_MISMATCH — отказ строки");
  ok(/изменился/.test(body()) && document.getElementById("asstAgain"), "причина словами, предложено спросить заново");
  const r2 = await server(R1);
  ok(r2.purpose === "чужая правка" && r2.steps.length === r0.steps.length, "чужая правка на месте, шаг не выпал");

  // Частичная запись: какие прошли, какая нет, зависящее от незаписанного не идёт и названо
  const sc = (await API.get("/schedules")).items.find((x) => !x.builtin), { id: scId, version: scV, builtin: scB, ...scBody } = sc;
  talk("при движении на Запасной вход пиши 5 минут");
  ok(await until(() => document.getElementById("asstApply")), "план");
  const base = asst.plan.rules[0].body;
  await planRules([{ table: "scenarios", op: "create", body: Object.assign({}, base, { name: "Прошло" }) },
    { table: "scenarios", op: "update", id: "70000099-0000-4000-8000-000000000000", body: { purpose: "нет такого" } },
    { table: "schedules", op: "create", ref: "bad", body: Object.assign({}, scBody, { name: " " }) },
    { table: "scenarios", op: "create", body: Object.assign({}, base, { name: "Со ссылкой", conditions: [{ kind: "time", scheduleId: "@bad" }] }) },
    { table: "scenarios", op: "create", body: Object.assign({}, base, { name: "Последнее" }) }]);
  document.getElementById("asstApply").click();
  ok(await until(() => rows().length === 5), "по строке на запись, молчаливых пропусков нет");
  ok(rows().join() === "ok,fail,fail,fail,ok", "какие прошли, какие нет: " + rows().join());
  ok(/не записано: не создано «bad»/.test(body()), "зависящая запись названа");
  const names = (await API.get("/rules")).items.map((x) => x.name);
  ok(names.includes("Прошло") && names.includes("Последнее") && !names.includes("Со ссылкой"), "записанное осталось, отката нет");

  // Новое расписание плана: виден по имени, правило получает его id. Форма принимает любой законный RuleWrite
  talk("при движении на Запасной вход пиши 5 минут, новое расписание");
  ok(await until(() => document.getElementById("asstApply")), "план с расписанием");
  ok(/Смена из просьбы/.test(body()) && !/удалённое расписание/.test(body()), "условие называет новое расписание: " + body().slice(0, 260));
  const ruleName = asst.plan.rules[1].body.name + " со сменой";
  asst.plan.rules[1].body.name = ruleName;
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "ok,ok"), "расписание и правило: " + rows().join());
  const withSc = (await API.get("/rules")).items.find((x) => x.name === ruleName), newSc = (await API.get("/schedules")).items.find((x) => x.name === "Смена из просьбы");
  ok(withSc.conditions[0].scheduleId === newSc.id, "ссылка «@ref» — id созданного");
  await planRules([{ table: "scenarios", op: "create", body: Object.assign({}, base, { name: "Детектор от модели", steps: [{ type: "unitAction", action: "detect", target: base.steps[0].target, params: { detectorKind: "motion", minutes: 5 } }] }) }]);
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "ok"), "законный RuleWrite с командой detect (unitAction) форма не отказывает");

  // Окно: ссылка на новое расписание — телом окна, без POST /schedules; окно выключено, что бы ни пришло в плане
  const posts = [], post = API.post;
  API.post = (p, ...r) => { posts.push(p); return post(p, ...r); };
  const schCount = async () => (await API.get("/schedules")).items.length;
  const s0 = await schCount();
  talk("заведи окно обслуживания по новому расписанию");
  ok(await until(() => document.getElementById("asstApply")), "план окна");
  ok(/Отдельно не записывается: идёт телом окна|не записывает это отдельно\. Это часть окна/.test(body()) && /Новое окно обслуживания «Окно из просьбы»/.test(body()) && /Заведётся выключенным|создаст окно выключенным/.test(body()), "показ окна: " + body().slice(0, 240));
  asst.plan.rules[1].body.enabled = true;
  posts.length = 0;
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "ok,ok"), "окно записано: " + rows().join());
  ok(posts.join() === "/maintenance-windows", "двери: " + posts.join());
  ok(/записано телом окна/.test(body()), "строка расписания названа");
  const w1 = (await API.get("/maintenance-windows")).items.find((x) => x.name === "Окно из просьбы");
  ok(w1 && w1.enabled === false, "новое окно выключено, хотя в плане стояло включённым");
  ok((await API.get("/schedules/" + w1.scheduleId)).owner?.id === w1.id, "расписание принадлежит окну");
  ok(await schCount() === s0 + 1, "расписание одно: своё у окна");

  // Ссылка и от правила, и от окна: расписание — POST /schedules, у правила id, у окна строка объектом
  talk("при движении на Запасной вход пиши 5 минут, новое расписание, окно обслуживания");
  ok(await until(() => document.getElementById("asstApply")), "план с окном и правилом");
  ok(!/Отдельно не записывается/.test(body()), "расписание записывается своей строкой");
  const both = asst.plan.rules[1].body.name + " с окном";
  asst.plan.rules[1].body.name = both;
  posts.length = 0;
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "ok,ok,ok"), "все три записи: " + rows().join());
  ok(posts.join() === "/schedules,/rules,/maintenance-windows", "двери по порядку: " + posts.join());
  const r3 = (await API.get("/rules")).items.find((x) => x.name === both);
  ok((await API.get("/schedules/" + r3.conditions[0].scheduleId)).name === "Смена из просьбы", "у правила — id созданной строки");

  // Окно с готовым расписанием — копия его строки. Правки расписания и окна нет: отказ строкой, без записи
  talk(`заведи окно обслуживания по расписанию ${sc.name}`);
  ok(await until(() => document.getElementById("asstApply")), "план окна с готовым расписанием");
  ok(asst.plan.rules[0].body.schedule.name === sc.name, "копия строки в теле");
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "ok"), "записано: " + rows().join());
  const sc1 = await API.get("/schedules/" + sc.id), w2 = (await API.get("/maintenance-windows")).items.find((x) => x.name === "Окно из просьбы" && x.id !== w1.id);
  await planRules([{ table: "schedules", op: "update", id: sc.id, body: { name: "Нельзя" } }, { table: "windows", op: "update", id: w1.id, body: { enabled: true } }]);
  ok(/только заводит|только создаёт/.test(body()), "отказ виден до «Применить»");
  posts.length = 0;
  const puts = [], put = API.put;
  API.put = (p, ...r) => { puts.push(p); return put(p, ...r); };
  document.getElementById("asstApply").click();
  ok(await until(() => rows().join() === "fail,fail"), "обе строки — отказ: " + rows().join());
  ok(!posts.length && !puts.length, "ни одной записи");
  ok((await API.get("/schedules/" + sc.id)).version === sc1.version && (await API.get("/maintenance-windows/" + w1.id)).enabled === false && w2, "всё на месте");
  API.post = post;
  API.put = put;

  // logOnlySince — дата записи по часам сервера
  const srvDay = localStamp((await API.get("/me")).serverTime).slice(0, 10);
  ok(made.logOnlySince === srvDay, "дата записи: " + made.logOnlySince);

  // Вопрос оператору и эскалация — план, как любое новое правило: наблюдающим или выключенным, запуск никого не спрашивает
  const planned = async (said, word) => {
    talk(said);
    ok(await until(() => document.getElementById("asstApply")), "план: " + said);
    ok(word.test(body()), "шаг виден в плане: " + body().replace(/\s+/g, " ").slice(0, 240));
    const name = asst.plan.rules[0].body.name;
    document.getElementById("asstApply").click();
    ok(await until(() => rows().join() === "ok"), "записано: " + rows().join());
    return (await API.get("/rules")).items.find((x) => x.name === name);
  };
  const a1 = await planned("при движении на Запасной вход спроси оператора", /Спросить|Подтвердить движение/);
  ok(a1.enabled && a1.logOnly && a1.steps[0].control === "ask" && a1.steps[0].roleId === "80000003-0000-4000-8000-000000000000", "ask: «Только журнал», роль из просьбы");
  const a2 = await planned("эскалация при движении на Запасной вход", /Эскалац/);
  ok(a2.enabled && a2.logOnly && a2.steps[1].control === "escalate" && a2.steps[1].levels.length === 2, "escalate: «Только журнал»");
  await API.post("/rules/update", { idempotencyKey: opKey(), items: [a1, a2].map((x) => ({ ruleId: x.id, version: x.version, set: { enabled: false } })) });
  const a3 = await planned("при движении на Служебный вход спроси оператора, выключенным", /Заведётся выключенным|создаст правило выключенным/);
  ok(a3.enabled === false && a3.steps[0].control === "ask", "просили выключенным — выключено");
  const a4 = await planned("эскалация при движении на Служебный вход, выключенным", /Заведётся выключенным|создаст правило выключенным/);
  ok(a4.enabled === false && a4.steps[1].control === "escalate", "эскалация выключенным");
  ok(!(await API.get("/rule-prompts")).items.length, "вопросов нет");

  // Плана нет: вопрос и отказ — как раньше
  talk("проверь архив на Запасной вход");
  ok(await until(() => /странице консоли/.test(document.getElementById("asstRefused")?.textContent || "")), "отказ со словом о странице консоли");
  ok(!document.getElementById("asstApply"), "плана нет");
  API.stream = stream;
  goClose();

  // Настоящая мышь, а не вызов функции: кнопка перерисовывает окно на mousedown и уходит из DOM, окно при этом не закрывается
  goApp("hw");
  const mouse = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  // «Отправить» мышью
  const typed = (t) => { typeF(t); press(document.getElementById("asstSend")); };
  const popOpen = () => document.getElementById("gopop").classList.contains("open");
  inp.value = "выключи запись Главный вход";
  goInput(inp.value);
  ok(document.getElementById("goAsk"), "строка ассистента в поиске");
  mouse(document.getElementById("goAsk"));
  ok(asst && dockOpen(), "мышь по строке: панель открыта, ход идёт");
  ok(await until(() => document.getElementById("asstPlanNote") && bulkActive() && bulkDraft.planOf === asst.plan), "мышь по строке: ход дошёл до плана, черновик карточки готов");
  ok(!document.getElementById("asstDecline") && document.getElementById("asstSend")?.textContent === "Уточнить", "при плане «Уточнить»; «Отказаться» нет");
  ok(tag() && !document.getElementById("asstPlanOpen"), "план уже в дереве — «Открыть в дереве» нет");
  // Тег снят крестиком — «Открыть в дереве» мышью возвращает отбор, выбор и черновик со своими правками
  goClose();
  bulkSet("pre", "7");
  press(tag().querySelector("button"));
  ok(!asstPick && !tag(), "тег снят крестиком");
  setSelMode(false);
  ok(!bulkActive(), "выбор снят");
  ok(document.getElementById("asstPlanOpen"), "тег снят — «Открыть в дереве» появилась");
  press(document.getElementById("asstPlanOpen"));
  ok(await until(() => tag() && bulkActive() && treeSel.size === asst.plan.items.length), "«Открыть в дереве»: тег, выбор, карточка");
  ok(!document.getElementById("asstPlanOpen"), "снова в дереве — кнопки нет");
  ok(bulkDraft.pre === "7" && bulkDraft.plan?.rec, "черновик прежний: правка человека и значения плана");
  // Поле, заданное человеком, заменяет значения плана: дальше это его правка
  bulkSet("rec", "always");
  ok(!bulkDraft.plan.rec && bulkDraft.rec === "always", "человек сменил поле — значения плана по нему сняты");
  ok(bulkChanges().some((c) => c.key === "rec" && /Всегда/.test(c.label)) && bulkChanges().some((c) => c.key === "pre"), "в плане карточки — его значения");
  bulkResetDraft();
  ok(!bulkDraft.plan && !bulkChanges().length, "«Сбросить» снимает и значения плана");
  goClose();
  asstOpen("");
  typed("выключи запись");
  ok(await until(() => document.getElementById("asstAsk")), "«Отправить» мышью: вопрос");
  ok(asst && dockOpen(), "панель открыта");
  typed("Главный вход");
  // Черновик карточки — после того, как консоль дочитала записи плана: по сети это не сразу
  ok(await until(() => document.getElementById("asstPlanNote") && bulkActive() && bulkDraft.planOf === asst.plan), "ответ на вопрос мышью: план в карточке");
  ok(await cardApply(), "«Применить» в карточке мышью");
  ok(await until(() => /План применён через карточку/.test(body())), "в панели — итог словами");
  ok(asst && dockOpen(), "панель открыта после «Применить»");
  mouse(field());
  ok(asst && dockOpen(), "мышь в поле панели её не закрывает");
  mouse(document.getElementById("asstBlock"));
  ok(asst && dockOpen(), "мышь внутри панели её не закрывает");

  // Уточнить план словами: обычный ход с context плана, план снят сразу, новый показан целиком
  goClose();
  asstOpen("");
  const said = [];
  API.stream = (p, b, ...r) => { said.push(b); return stream(p, b, ...r); };
  typed("включи запись Главный вход");
  ok(await until(() => document.getElementById("asstPlanNote") && bulkDraft.planOf === asst.plan), "план для уточнения в черновике");
  const box = field(), planContext = asst.context;
  ok(box && box.placeholder === "Уточнить" && document.activeElement === box, "поле под планом, подпись «Уточнить», курсор в нём");
  ok(inp.placeholder === PH, "строка поиска под планом прежняя");
  ok(!/Секрет/.test(document.getElementById("asstBlock").textContent), "«Секрет» под планом нет");
  press(document.getElementById("asstSend"));
  ok(document.getElementById("asstPlanNote") && bulkDraft.plan, "пустое уточнение план не снимает");
  typeF("и Переговорная");
  key(field(), "Enter");
  ok(asst.busy && !asst.plan && !planShown() && !bulkDraft.plan, "идёт ход: плана нет, в черновике его значений тоже");
  const saidRows = () => [...document.querySelectorAll("#asstBlock .asst-u")].map((x) => x.textContent);
  ok(saidRows().join("|") === "включи запись Главный вход|и Переговорная" && (body().match(/План снят/g) || []).length === 1, "история просьб: старые сверху, свежая последней, «План снят» один раз — " + saidRows().join("|"));
  ok(said[1].context === planContext && said[1].text === "и Переговорная", "ход с context плана");
  ok(await until(() => document.getElementById("asstPlanNote") && bulkDraft.plan?.rec), "новый план в карточке");
  ok(/Камеры: \d+/.test(body()) && /recordMode: none → always/.test(body()) && asst.context !== planContext && asst.context.includes("Переговорная"), "новый план целиком, было → станет: " + body().slice(0, 200));
  ok(document.activeElement === field(), "курсор снова в поле");
  // Уточнение с context плана: заглушка читает его вместе с просьбой, отказ — на просьбу, которую она не исполняет
  say("проверь архив за ночь");
  ok(await until(() => document.getElementById("asstRefused")), "уточнение кончилось отказом");
  ok(!asst.plan && !planShown() && !bulkDraft.plan, "отказ: прежний план не вернулся");
  ok(saidRows().join("|") === "включи запись Главный вход|и Переговорная|проверь архив за ночь" && !document.querySelector("[data-asst-dropped]"), "история — только просьбы: " + saidRows().join("|"));
  goClose();
  asstOpen("");
  typed("включи запись Главный вход");
  ok(await until(() => document.getElementById("asstPlanNote")), "снова план");
  asst.context = null;
  say("включи");
  ok(await until(() => document.getElementById("asstAsk")), "уточнение кончилось вопросом");
  ok(!asst.plan && !planShown(), "вопрос: прежний план не вернулся");
  API.stream = stream;

  // Панель стоит рядом: клик мимо её не закрывает, Esc в панели закрывает, разговор и набранное на месте.
  // Клик в строке поиска и печать в ней панель не трогают
  const blockEl = document.getElementById("asstBlock"), listEl = document.getElementById("goList");
  const seeing = () => asst && dockOpen() && blockEl.getBoundingClientRect().height > 0;
  const keyQ = (k) => key(inp, k);
  goApp("hw");
  asstOpen("");
  say("включи запись");
  ok(await until(() => document.getElementById("asstAsk")), "вопрос ассистента");
  // После разговора клик в строку поиска и печать: ответ ассистента курсор и текст не забирает
  say("Главный вход");
  ok(document.activeElement === field(), "ответ пишут в поле: курсор там");
  press(inp);
  inp.focus();
  ok(await until(() => document.getElementById("asstPlanNote")), "ответ дошёл до плана");
  ok(document.activeElement === inp && inp.value === "", "конец хода курсор из пустой строки поиска не забрал: " + document.activeElement?.id);
  typeKeys(inp, "камера");
  ok(document.activeElement === inp && inp.value === "камера", "курсор и набранное в строке поиска: " + document.activeElement?.id + " «" + inp.value + "»");
  ok(seeing() && document.getElementById("asstPlanNote"), "панель с планом на месте");
  typeQ("");
  asstOpen("");
  say("включи запись");
  ok(await until(() => document.getElementById("asstAsk")), "снова вопрос ассистента");
  const ctx = asst.context, talkId = asst;
  typeF("недописанный ответ");
  press(document.getElementById("tree"));
  ok(dockOpen() && asst === talkId && asst.ask && asst.context === ctx, "клик мимо панель не закрыл, разговор на месте");
  keyQ("Escape");
  ok(dockOpen() && asst === talkId, "Esc в строке поиска панель не закрывает");
  field().focus();
  key(field(), "Escape");
  ok(!dockOpen() && asst === talkId && asst.text === "недописанный ответ" && asst.ask, "Esc в поле скрыл панель, разговор и набранное на месте");
  asstToggle();
  ok(seeing() && document.getElementById("asstAsk") && field().value === "недописанный ответ", "кнопка вернула панель в том же состоянии");
  typeF("");

  // Поиск при открытой панели: результаты в списке поиска, диалог не трогают. Ввод панель не закрывает
  ok(!/Разделы/.test(blockEl.textContent), "разделов поиска в ленте нет");
  typeQ("вход");
  ok(seeing() && document.getElementById("asstAsk"), "ввод текста панель не закрывает");
  ok(/В дереве|Не в дереве/.test(listEl.textContent) && !/В дереве|Не в дереве/.test(blockEl.textContent), "результаты — в списке поиска, не в ленте: " + listEl.textContent.slice(0, 80));
  typeQ("");
  say("Главный вход");
  ok(await until(() => document.getElementById("asstPlanNote")), "ответ в поле под вопросом: тот же разговор");
  ok(asst === talkId && asst.log.filter((x) => x.u !== undefined).length === 2, "разговор тот же");
  typeQ("вход");
  ok(document.getElementById("asstPlanNote"), "поиск при плане план не трогает");
  keyQ("ArrowDown");
  keyQ("ArrowDown");
  ok(goNav && goSel === 1, "стрелки выбрали строку списка после строки ассистента");
  const before3 = asst, chats3 = asstChats.length;
  enter();
  ok(asst === before3 && asstChats.length === chats3 && !popOpen(), "строка, выбранная стрелками: Enter выбирает её, ассистенту не уходит");
  typeQ("");
  goNav = false;
  // Строка ассистента над результатами: Enter без выбора и выбор строки — новый разговор (Enter проверяет ui-chat.js)
  typeQ("вход");
  const askBtn = () => document.getElementById("goAsk");
  ok(askBtn() && askBtn() === document.querySelector("#goList .gores") && /Спросить ассистента/.test(askBtn().textContent), "нашлось — строка ассистента первая, под ней результаты");
  ok(/В дереве|Не в дереве/.test(listEl.textContent), "под строкой ассистента — результаты поиска");
  mouse(askBtn());
  ok(asst !== talkId && asst.log[0]?.u === "вход" && inp.value === "" && treeQ === "", "выбор строки при найденном — новый разговор, строка очищена");
  ok(await until(() => !asst.busy), "ход кончился");
  typeQ("");
  ok(!askBtn(), "пустая строка — строки ассистента нет");

  // Просьба из строки поиска — новый разговор: context, план и секреты не переходят в него
  const sent = [];
  API.stream = (p, b, ...r) => { sent.push(b); return stream(p, b, ...r); };
  asst.secrets = ["qwerty"];
  asstRender();
  ok(document.querySelector("#asstBlock .asst-sec input, #asstActs .asst-sec input"), "поле секрета у заглушки есть");
  asstClose();
  asstToggle();
  ok(asst.secrets[0] === "qwerty", "скрытая панель секрет не забывает");
  const talking = asst;
  typeQ("абырвалг которого нет");
  ok(askBtn(), "ничего не найдено — строка ассистента есть");
  mouse(askBtn());
  ok(asst && asst !== talking && !asst.secrets.length && !asst.plan, "выбор строки поиска — новый разговор: план и секреты не перешли");
  ok(sent.length === 1 && sent[0].text === "абырвалг которого нет" && !("context" in sent[0]) && !("secrets" in sent[0]), "ход без прежнего context и секретов");
  ok(asst.log.filter((x) => x.u !== undefined).length === 1 && inp.value === "" && treeQ === "", "в разговоре одна реплика, строка поиска очищена");
  ok(await until(() => !asst.busy), "ход кончился");
  asst.secrets = [];
  talking.secrets = [];
  asstRender();
  API.stream = stream;
  goClose();
  // Раздел тип не решает, панель переживает переход
  asstOpen("");
  const after = [];
  API.stream = (p, b, ...r) => { after.push("kind" in b ? b.kind : "-"); return stream(p, b, ...r); };
  goApp("rules");
  ok(seeing(), "переход: панель на месте");
  say("убери условие");
  ok(await until(() => !asst.busy && after.length), "ход после перехода");
  API.stream = stream;
  ok(after[0] === "-" && asst.ask === "Какое правило изменить?", "после перехода поля kind нет, о правилах — по словам просьбы: " + asst.ask);
  goApp("hw");
  await apiReload();
  ok(seeing(), "перечитывание данных: панель на месте");
  const inCard = document.querySelector("main input:not([type=checkbox]):not([disabled])");
  if (inCard) {
    inCard.focus();
    asstEvent(asst, { type: "question", text: "Какой?", context: "c" });
    ok(document.activeElement === inCard, "ответ ассистента не забирает курсор из карточки");
  }
  // Список поиска — как раньше: клик мимо закрывает
  typeQ("камера");
  ok(popOpen(), "список поиска открыт");
  press(document.getElementById("tree"));
  ok(!popOpen(), "клик мимо закрывает список поиска");
  clearTreeQ();
  // Выбор строки поиска мышью: окно закрывается, переход выполнен
  inp.value = "";
  goInput("");
  const row = [...document.querySelectorAll("#gopop .gores")].find((x) => /Автоматизация/.test(x.textContent));
  ok(row, "строка раздела в списке");
  mouse(row);
  ok(!popOpen() && app === "rules", "строка мышью: список закрыт, переход выполнен");
  goApp("hw");

  // Отбор (found): просьба из строки поиска — дерево показывает отобранное тегом над деревом, условия словами
  if (asstPick) press(tag().querySelector("button"));
  setSelMode(false);
  const all0 = treeIds().length;
  const sliceWas = slice;
  const camsAll = await Promise.all((await unitsAll({ kind: "camera" })).map((u) => API.get(`/units/${u.uid}`)));
  const noRec = camsAll.filter((u) => (u.properties.recordMode || "none") === "none");
  typeQ("выведи камеры без записи");
  ok(askBtn(), "строка ассистента");
  mouse(askBtn());
  ok(await until(() => tag() && fs?.pick && fs.done), "отбор пришёл, тег над деревом");
  ok(tag().textContent.startsWith(`Ассистент: ${noRec.length} · тип: камера · запись: нет`), "тег: число и условия словами — " + tag().textContent);
  ok(/Отобрано ассистентом: \d+/.test(document.getElementById("filtHint")?.textContent || ""), "подсказка над деревом: " + document.getElementById("filtHint")?.textContent);
  const want = new Set(asst.found.ids);
  ok(want.size === noRec.length && noRec.every((u) => want.has(u.uid)), "отобраны камеры без записи");
  ok(await until(() => camRows().length === want.size) && camRows().every((id) => want.has(id)), "в дереве только отобранные камеры: " + camRows().length + " из " + want.size);
  ok(document.getElementById("asstFound")?.textContent === asst.found.text && /условия — над деревом|Условия находятся над деревом/.test(document.getElementById("asstFoundNote")?.textContent || ""), "в панели текст и подпись отбора");
  ok(/тип: камера · запись: нет/.test(document.getElementById("asstFoundWhy")?.textContent || "") && /В дереве: \d+/.test(document.getElementById("asstFoundCount")?.textContent || ""), "в панели условия и число");
  ok(!document.getElementById("asstApply") && document.getElementById("asstFoundPick") && !document.getElementById("asstFoundOpen"), "«Применить» нет: отбор ничего не пишет; «Выбрать всё» есть, «Показать в дереве» нет — отбор уже в дереве");
  // «Выбрать всё» мышью — всё отобранное в выборе, групповая карточка
  press(document.getElementById("asstFoundPick"));
  ok(await until(() => treeSel.size === want.size), "«Выбрать всё»: отмечено " + treeSel.size);
  ok([...treeSel].every((id) => want.has(id)) && bulkActive(), "выбор — отобранное, открыта групповая карточка");
  ok(await until(() => new RegExp(`${want.size} камер`).test(document.getElementById("main")?.textContent || "")), "карточка выборки называет число");
  // Крестик тега мышью: дерево как было, выбор остался
  press(tag().querySelector("button"));
  ok(!asstPick && !tag() && slice === sliceWas, "тег снят, срез прежний");
  ok(await until(() => treeIds().length >= all0), "дерево как было: строк " + treeIds().length);
  ok(treeSel.size === want.size, "выбор остался: это правка человека");
  setSelMode(false);
  // «Показать в дереве» возвращает отбор
  ok(document.getElementById("asstFoundOpen"), "тег снят — «Показать в дереве» появилась");
  press(document.getElementById("asstFoundOpen"));
  ok(await until(() => tag() && camRows().length === want.size), "«Показать в дереве» вернул отбор");
  ok(!document.getElementById("asstFoundOpen"), "отбор снова в дереве — кнопки нет");
  // Дерево сменилось на другой раздел — отбора не видно, кнопка есть
  goApp("rules");
  ok(await until(() => document.getElementById("asstFoundOpen")), "другой раздел — «Показать в дереве» есть");
  press(document.getElementById("asstFoundOpen"));
  ok(await until(() => app === "hw" && tag() && !document.getElementById("asstFoundOpen")), "кнопка вернула дерево с отбором");
  // Разговор продолжается с context: уточнить отбор в поле под ответом
  say("а только Axis");
  const axis = noRec.filter((u) => u.properties.vendor === "Axis");
  ok(await until(() => asst.found && asst.found.conditions.length === 3 && tag()?.textContent.includes("производитель: Axis")), "уточнение: третье условие — " + tag()?.textContent);
  ok(await until(() => camRows().length === axis.length) && camRows().every((id) => axis.some((u) => u.uid === id)), "дерево сузилось до уточнённого: " + camRows().length);
  // Пусто — тоже отбор: тег с нулём, «Выбрать всё» неактивна
  say("покажи камеры с именем «такого нет»");
  ok(await until(() => asst.found && asst.found.ids.length === 0 && tag()?.textContent.startsWith("Ассистент: 0")), "пустой отбор: " + tag()?.textContent);
  ok(await until(() => camRows().length === 0) && document.getElementById("asstFoundPick")?.disabled, "дерево пустое, выбирать нечего");
  ok(document.getElementById("asstFound")?.textContent === "Ничего не отобрано.", "словами: " + document.getElementById("asstFound")?.textContent);
  // Сбросить фильтры снимает и отбор
  resetAllFilters();
  ok(!asstPick && !tag(), "«Сбросить фильтры» снимает отбор");
  goClose();

  // Учебные ссылки ответа (answer.learn): карточка из своего каталога, запуск только кнопкой; чужое не исполняется
  goClose();
  asstOpen("");
  const learnBox = () => document.getElementById("asstLearn");
  const dockHtml = () => document.getElementById("asstDock").innerHTML;
  if (learnShown()) {
    const ver = Tour.catalog().version, hrefWas = location.href;
    say("покажи, как создать простое правило");
    await until(() => document.getElementById("asstAnswer"));
    // Стенд без каталога сборки (check_stand) учебных ссылок не даёт: тогда ответ со ссылкой подставляет сценарий
    const standNoCat = !asst.learn && !!(new URLSearchParams(location.search).get("api") || pageMeta("consolem-api")) && !Tour.lazy;
    if (standNoCat) asstEvent(asst, { type: "answer", text: "пример", context: "c", learn: [{ catalog: ver, topic: Tour.topics[0].id, chapter: Tour.topics[0].chapters[0].id }] });
    ok(await until(() => learnBox()?.querySelector(".asst-learn")), "просьба научить — карточка учебного примера" + (standNoCat ? " (ответ подставлен: у стенда нет каталога)" : ""));
    const card = learnBox().querySelector(".asst-learn"), lc = learnParse(card.dataset.learn);
    ok(lc.ch && card.textContent.includes(lc.ch.title) && card.textContent.includes(lc.ch.why) && card.textContent.includes(lc.tp.title), "карточка: название, тема и цель — из каталога консоли");
    ok(/Открыть учебный пример/.test(card.querySelector("button")?.textContent || ""), "кнопка «Открыть учебный пример»");
    ok(asst.learn.every((l) => l.catalog === ver), "ссылка — на эту версию каталога");
    ok(location.href === hrefWas && !Tour.demo, "приход ссылки сам ничего не открыл");
    ok(/проверить по разделу/.test(document.getElementById("asstAnswerNote")?.textContent || ""), "текст ответа подписан, как раньше");
    setUiLang("en");
    asstRender();
    ok(/the demo runs in Russian/.test(learnBox().textContent), "английский интерфейс: видно, что показ на русском");
    setUiLang("ru");
    asstRender();
    const real = asst.learn[0];
    asstEvent(asst, { type: "answer", text: "обычный ответ", context: "c", learn: [{ catalog: ver, topic: real.topic, chapter: real.topic + ".nope" }] });
    ok(!learnBox().querySelector(".asst-learn") && learnBox().querySelector('[data-learn-state="unknown"] button'), "неизвестная глава: карточки нет, предложен каталог");
    asstEvent(asst, { type: "answer", text: "обычный ответ", context: "c", learn: [{ catalog: "sha256:" + "0".repeat(64), topic: real.topic, chapter: real.chapter }] });
    ok(!learnBox().querySelector(".asst-learn") && learnBox().querySelector('[data-learn-state="version"] button'), "чужая версия каталога: карточки нет, предложен каталог");
    learnBox().querySelector('[data-learn-state="version"] button').click();
    ok(app === "learn" && learnSel === "home", "«Открыть каталог» — раздел «Обучение»");
    goApp("hw");
    // Чужие поля, разметка, адрес и код из ответа не исполняются: ответ — текст, ссылка — только ID
    window.__learnPwn = 0;
    asstEvent(asst, { type: "answer", text: '<img src=x onerror="window.__learnPwn=1"> javascript:window.__learnPwn=1 https://evil.example.test', context: "c",
      learn: [{ catalog: ver, topic: real.topic, chapter: '<img src=x onerror="window.__learnPwn=1">', url: "javascript:window.__learnPwn=1", html: '<b id="learnPwn">x</b>', selector: "#hdAsst" }] });
    await sleep(100);
    ok(!document.querySelector("#asstDock img, #learnPwn") && window.__learnPwn === 0 && document.getElementById("asstAnswer").textContent.startsWith("<img"), "разметка и код из ответа не исполнились, текст показан как есть");
    ok(!/evil\.example|javascript:/.test([...document.querySelectorAll("#asstDock a[href], #asstDock [src]")].map((e) => e.getAttribute("href") || e.getAttribute("src")).join(" ")), "адресов из ответа нет в ссылках панели");
    ok(asst.learn.every((l) => Object.keys(l).join() === "catalog,topic,chapter"), "из ссылки взяты только catalog, topic, chapter");
    asstEvent(asst, { type: "answer", text: "ответ без ссылок", context: "c" });
    ok(!learnBox() && document.getElementById("asstAnswer").textContent === "ответ без ссылок", "старый answer без learn — обычный ответ");
    goApp("hw");
  } else {
    // Сборка без обучения: показа нет, кнопки нет, объяснение
    asstEvent(asst, { type: "answer", text: "ответ", context: "c", learn: [{ catalog: "sha256:" + "0".repeat(64), topic: "rules", chapter: "rules.simple" }] });
    ok(learnBox()?.querySelector('[data-learn-state="nocat"]') && !learnBox().querySelector("button"), "без обучения: карточки и кнопки нет, объяснение");
  }
  ok(!document.querySelector("#asstDock [onerror], #asstDock [onclick]") && !/<img/i.test(dockHtml()), "в разметке панели нет элементов и атрибутов из ответа");
  goClose();

  // Учебный режим запрещает внешнюю службу из всех трёх источников, обычная демо-страница — как раньше. Адрес страницы,
  // метки и режим — параметрами asstServiceUrlOf: hostname altumur.github.io в сценарии не подставить иначе
  const SVC = "https://assist.example.test", PUB = "https://public.example.test";
  const metaOf = (m) => (name) => m[name] || "";
  const cases = [
    ["?assist=" + encodeURIComponent(SVC), "localhost", {}, "?assist="],
    ["", "localhost", { "consolem-assist": SVC }, "метка consolem-assist"],
    ["", "altumur.github.io", { "consolem-assist-public": PUB }, "публичная метка на altumur.github.io"],
  ];
  for (const [search, host, m, what] of cases) {
    ok(asstServiceUrlOf(search, host, metaOf(m), false) !== "", `обычная демо-страница: ${what} включает службу`);
    ok(asstServiceUrlOf(search, host, metaOf(m), true) === "", `учебный режим: ${what} службу не включает`);
  }
  ok(asstServiceUrlOf("", "localhost", metaOf({ "consolem-assist-public": PUB }), false) === "", "публичная метка на чужом адресе службу не включает");
});
