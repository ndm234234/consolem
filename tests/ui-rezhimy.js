/* Сценарии интерфейса: «Режимы» — одно понятие (контракт 0.4.0). Страница режимов, кнопка в шапке и её меню, ручное включение на срок,
   правила, которые режим выключает (окно и флажки в карточке правила), расписание режима без пересечений, скрытое условие
   «Режим объекта» не теряется при сохранении правила. Данные — только GET/PUT /modes и GET/POST /modes/current. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  const R1 = "70000001-0000-4000-8000-000000000000";   // «Охрана входа ночью»: в эталонном наборе её выключает «Рабочее время»
  const r = (id) => rules.find((x) => x.id === id);
  const undo = (prefix) => [...document.querySelectorAll(".ttu")].reverse().find((e) => e.id.startsWith("ttu-" + prefix))?.querySelector(".ttu-act");
  const srv = async () => (await API.get("/modes")).items;
  goApp("rules");
  await until(() => umReady && UMODES.length);

  // Страница: «Обычная работа» — строка без объекта, остальные строки — режимы сервера
  ruleOpen("modes");
  const svc = UMODES.find((m) => m.sys), work = UMODES.find((m) => m.code === "work");
  ok(!!svc && svc.off.all && !svc.sched, "встроенный режим «Обслуживание»: только вручную, все правила");
  ok(!!document.querySelector("tr.um-base") && UMODES.every((m) => document.querySelector(`tr[data-mode="${m.id}"]`)), "строки: «Обычная работа» и все режимы сервера");
  const now0 = (await API.get("/modes/current")).modeId;   // зависит от часа и дня недели
  ok(!!document.querySelector(now0 ? `tr[data-mode="${now0}"] .um-on` : "tr.um-base .um-on"), "действует то, что сказал сервер: " + (now0 ? umName(umById(now0)) : "«Обычная работа»"));
  ok(document.querySelector(`tr[data-mode="${svc.id}"] button[disabled]`), "встроенный режим не удалить");
  ok(!/Окна обслуживания|Режимы объекта/.test(document.getElementById("aside").textContent) && /Режимы/.test(document.getElementById("aside").textContent), "в дереве — «Режимы», окон обслуживания нет");

  // Кнопка в шапке и её меню
  const hd = document.getElementById("hdMode");
  ok(!hd.hidden && hd.textContent.includes(umName(umCurrent())) && !hd.classList.contains("manual"), "шапка показывает действующий режим: " + hd.textContent.trim());
  hdModeMenu({ stopPropagation() {}, currentTarget: hd });
  ok(/Включить «Обслуживание»…/.test(document.getElementById("tctx").textContent) && /Режимы…/.test(document.getElementById("tctx").textContent), "меню предлагает режимы");
  closeTreeCtx();

  // Ручное включение на срок: окно, срок не больше 8 часов, POST /modes/current, шапка, статус правила
  ruleModeSwitch(svc.id);
  ok(/Выключит все правила|выключит все правила/.test(document.getElementById("bmBody").textContent), "окно говорит, что выключит все правила");
  modeSwTerm(0);
  modeSw.at = umHM(new Date(Date.now() + 9 * 3600 * 1000));
  modeSwPaint();
  ok(document.querySelector("#bmBody .nt.err") && document.querySelector("#bmFoot .btn.pri").disabled, "срок больше 8 часов: ошибка, «Включить» неактивна");
  modeSwTerm(240);
  ok(!document.querySelector("#bmBody .nt.err") && !document.querySelector("#bmFoot .btn.pri").disabled, "4 часа подходят");
  modeSwGo();
  ok(await until(() => umManNow() && umCur.id === svc.id), "режим включён вручную");
  const cur = await API.get("/modes/current");
  ok(cur.source === "manual" && cur.modeId === svc.id && cur.by, "на сервере: вручную, кто включил — " + cur.by);
  const left = Date.parse(cur.until) - Date.now();
  ok(left <= 4 * 3600 * 1000 + 5000 && left >= 4 * 3600 * 1000 - 120000, "срок на сервере — 4 часа: " + Math.round(left / 60000) + " мин");
  ok(hd.classList.contains("manual") && /вручную до/.test(hd.textContent), "шапка стала жёлтой и показывает срок");
  ok(ruleMaintNow(r(R1)) === umCurrent(), "правило выключено режимом");
  ruleOpen(R1);
  ok([...document.querySelectorAll("#main .nt")].some((e) => /выключил правило/.test(e.textContent)), "в карточке правила — «Режим … выключил правило»");
  ok(r(R1).status && ["watching", "off"].includes((await API.get(`/rules/${R1}`)).status.state) && (await API.get(`/rules/${R1}`)).status.state === "off", "сервер: статус правила — off");
  // Вернуть по расписанию
  umOff();
  ok(await until(() => !umManNow() && umCur.src === "schedule"), "«Вернуть по расписанию»");
  undo("umoff").click();
  ok(await until(() => umManNow() && umCur.id === svc.id), "«Отменить» вернуло ручной режим на прежний срок");
  umOff();
  await until(() => !umManNow());

  // Обычная работа вручную: modeId null со сроком
  ruleModeSwitch(svc.id);
  modeSwGo();
  await until(() => umManNow());
  ruleModeSwitch("none");
  modeSwGo();
  ok(await until(() => umManNow() && umCur.id === null), "«Обычная работа» вручную на срок");
  ok((await API.get("/modes/current")).modeId === null, "на сервере modeId null");
  umOff();
  await until(() => !umManNow());

  // Что выключает режим: флажки в карточке правила, окно «Выбрать…»
  ruleOpen(R1);
  const box = (m) => document.querySelector(`fieldset.rl-tags input[type=checkbox]`) && [...document.querySelectorAll("fieldset.rl-tags label")].find((l) => l.textContent.includes(m.name))?.querySelector("input");
  ok(box(work).checked && !box(work).disabled, "флажок «Рабочее время» отмечен у правила, которое режим выключает");
  ok(box(svc).checked && box(svc).disabled, "«Обслуживание» выключает все правила: флажок отмечен и неактивен");
  modeToggleRule(work.id, R1);
  ok(await until(async () => !(await srv()).find((m) => m.id === work.id).off.ruleIds.includes(R1)), "флажок снят: на сервере правило ушло из режима");
  ok(await until(() => undo("mode:")), "в уведомлении есть «Отменить»");
  undo("mode:").click();
  ok(await until(async () => (await srv()).find((m) => m.id === work.id).off.ruleIds.includes(R1)), "«Отменить» вернуло правило в режим");
  ruleOpen("modes");
  umRulesOpen(work.id);
  ok(document.querySelector("#umQ") && document.querySelector("#umCnt").textContent.includes("Показано"), "окно выбора правил: поиск и итог «Показано N из M»");
  umDlgQ("входа");
  const found = [...document.querySelectorAll("#umList .um-ck")].map((l) => l.textContent);
  ok(found.some((t) => /Охрана входа ночью/.test(t)) && found.length < rules.length, "поиск сужает список: " + found.length + " из " + rules.length);
  umDlgKind("all");
  umDlgSave();
  ok(await until(async () => (await srv()).find((m) => m.id === work.id).off.all), "режим выключает все правила: на сервере off.all");
  modeOffKind(work.id, "some");
  ok(await until(() => !umById(work.id).off.all), "снова выбранные правила");

  // Расписание режима: пересечение сервер не принимает, режим и первое пересечение названы в уведомлении
  const workSched = work.sched;
  const night = UMODES.find((m) => m.code === "night");
  ok(!!workSched && !!night && !!night.sched, "у «Рабочего времени» и «Ночи» есть расписания");
  const before = (await API.get("/modes")).version;
  modeSched(svc.id, night.sched);
  ok(await until(() => /пересекается с режимом «Ночь»/.test(document.getElementById("tt")?.textContent || "")), "уведомление: " + document.getElementById("tt")?.textContent);
  ok((await API.get("/modes")).version === before && !umById(svc.id).sched, "ничего не записано, расписание режима прежнее");

  // Новый режим, переименование, расписание «Никогда» не пересекается; удаление с вводом числа
  const n0 = UMODES.length;
  modeAdd();
  ok(await until(() => UMODES.length === n0 + 1), "режим добавлен");
  const nm = UMODES[UMODES.length - 1];
  modeRename(nm.id, "Праздник");
  ok(await until(async () => (await srv()).some((m) => m.name === "Праздник")), "переименован на сервере");
  modeDelAsk(nm.id);
  ok(!!document.getElementById("confirmCountInp"), "удаление просит ввести число");
  await confirmWith(1);
  ok(await until(() => UMODES.length === n0, 40000), "после отсчёта режим удалён");
  ok((await srv()).length === n0, "на сервере");
  document.getElementById("confirmCount")?.remove();
  modeDelAsk(svc.id);
  ok(!document.getElementById("confirmCount"), "встроенный режим не удаляется: диалога нет");

  // Скрытое условие «Режим объекта» (устарело): интерфейс его не показывает и не теряет
  const made = await API.post("/rules", { name: "Старое условие", enabled: false, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
    runAt: null, repeat: "skip", triggers: [], conditions: [{ kind: "mode", modeIds: [night.id] }], steps: [], owner: "", purpose: "", serverId: null, runAsRoleId: null, allowChain: true });
  ruleSet(made);
  ok(r(made.id).cond.length === 0 && r(made.id).condHid.length === 1, "условия «Режим объекта» в форме нет");
  ok(JSON.stringify(ruleBody(r(made.id)).conditions) === JSON.stringify(made.conditions), "но в записи при сохранении оно остаётся");

  // «Или» между условиями не меняется на «и», когда одно из условий скрыто
  const two = await API.post("/rules", { name: "Два условия", enabled: false, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
    runAt: null, repeat: "skip", triggers: [], condLogic: "any", steps: [], owner: "", purpose: "", serverId: null, runAsRoleId: null, allowChain: true,
    conditions: [{ kind: "mode", modeIds: [night.id] }, { kind: "online", target: { include: [{ uid: "30000013-0000-4000-8000-000000000000" }], exclude: [], gone: [], fromEvent: false } }] });
  ruleSet(two);
  ok(r(two.id).cond.length === 1 && ruleBody(r(two.id)).condLogic === "any", "условие «или» сохраняется: " + ruleBody(r(two.id)).condLogic);

  // Окно обслуживания (устарело) выключило правило: причина видна только для чтения — в полосе правила и в обзоре
  const R2 = "70000002-0000-4000-8000-000000000000";
  const always = (await API.get("/schedules")).items.find((x) => x.kind === "always");
  const { id: _i, version: _v, builtin: _b, ...sch } = always;
  await API.post("/maintenance-windows", { name: "Старое окно", enabled: true, ruleIds: [R2], schedule: Object.assign({}, sch, { name: "Всегда (окно)", owner: null }) });
  ruleSet(await API.get(`/rules/${R2}`));
  ok(r(R2).status.windowId && /Старое окно/.test(ruleStatusBand(r(R2))), "полоса правила называет окно: " + r(R2).status.reason);
  ruleOpen("overview");
  ok(/Выключены окном обслуживания/.test(document.getElementById("main").textContent) && /Старое окно/.test(document.getElementById("main").textContent), "в обзоре — окно и его имя");

  // Режим в отсчёте удаления сервер ещё применяет: он остаётся действующим в шапке
  const tmp = UMODES[UMODES.length - 1];
  const keep = umCur;
  umCur = { id: tmp.id, src: "manual", until: new Date(Date.now() + 3600e3), by: "x" };
  tmp._pend = true;
  ok(umCurrent() === tmp, "режим в отсчёте удаления остаётся действующим");
  delete tmp._pend;
  umCur = keep;
});
