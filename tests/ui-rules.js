/* Сценарии интерфейса: «Автоматизация» через API — правка правила и «Отменить», новое правило, состояние и
   приглушение группой, порядок, удаление с отсчётом, «Запустить», пробный запуск, история версий, режим
   объекта вручную, расписание, группа особых дней, окно обслуживания. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  const R1 = "70000001-0000-4000-8000-000000000000";   // «Охрана входа ночью»
  const R2 = "70000002-0000-4000-8000-000000000000";   // «Сирена по двери»
  const r = (id) => rules.find((x) => x.id === id);
  const undo = (prefix) => [...document.querySelectorAll(".ttu")].reverse().find((e) => e.id.startsWith("ttu-" + prefix))?.querySelector(".ttu-act");
  goApp("rules");

  // Каталог — из справочника: незнакомый вид не подменяется, необъявленное не предлагается, в правиле — видно
  const strayT = triggerKind({ sub: "acs", kind: "pass" }), strayA = actionKind({ sub: "vms", action: "bell", ref: "x" });
  ok(strayT.label === "acs/pass" && strayA.label === "vms/bell", "незнакомый вид — с подписью-кодом: " + strayT.label + ", " + strayA.label);
  ok(stepBody({ sub: "vms", action: "bell", ref: "", tone: 3 }).tone === 3, "незнакомое поле действия не теряется");
  const wasRef = { ...RULE_REF };
  Object.assign(RULE_REF, { starts: ["manual"], targets: { kinds: ["device"], fromEvent: false } });
  ruleNewOpen();
  ok(rnw.start === "manual" && !ruleAreaOff("device") && ruleAreaOff("folder") && ruleAreaOff("server") && ruleAreaOff("domain") && !srcDeclared(), "способ запуска и виды целей — из справочника");
  closeBulkModal();
  ok(/нет в этой системе/.test(ruleOutOfCat({ start: "manual", when: [], cond: [], then: [{ sub: "rec", action: "record", ref: "$src", minutes: 5 }] })), "«устройство из события» вне каталога — видно");
  ok(/нет в этой системе/.test(ruleOutOfCat({ start: "event", when: [], cond: [], then: [] })), "способ запуска вне каталога — видно");
  Object.assign(RULE_REF, wasRef);

  // Флаги событий (EventDescriptor.rule, alarm; нет поля — true): триггеры правил — без rule:false (abandoned, disappeared,
  // crowd у камеры), «Что считать тревогой» — без alarm:false (other, segment.lost). Порядок — как в GET /kinds
  {
    const evs = (await API.get("/kinds")).items.flatMap((k) => k.events || []);
    const uniq = (l) => [...new Set(l)];
    const noRule = uniq(evs.filter((e) => e.rule === false).map((e) => e.id)), noAlarm = uniq(evs.filter((e) => e.alarm === false).map((e) => e.id));
    ok(["abandoned", "disappeared", "crowd"].every((x) => noRule.includes(x)) && ["other", "segment.lost"].every((x) => noAlarm.includes(x)), "сервер объявил флаги: rule:false — " + noRule.join() + ", alarm:false — " + noAlarm.join());
    const alarmWant = uniq(evs.filter((e) => e.alarm !== false).map((e) => e.id));
    ok(JSON.stringify(refEvents) === JSON.stringify(alarmWant), "тревожные виды — без alarm:false, порядок сервера: " + refEvents.join());
    const baseEv = ["motion", "linecross", "abandoned", "disappeared", "crowd", "lpr", "silent", "io.input", "text", "unit"];
    ok(refEvents.filter((x) => baseEv.includes(x)).join() === baseEv.join(), "тревожные виды демо — прежние в прежнем порядке: " + refEvents.filter((x) => baseEv.includes(x)).join());
    const cam = devicePool.concat(...servers.map((s) => s.devices || [])).find((n) => n.type === "camera");
    const chips = [...new DOMParser().parseFromString(placeCardHtml(cam || { id: "x" }), "text/html").querySelectorAll(".pf-chip")].map((b) => b.dataset.chip);
    ok(chips.length && !chips.some((x) => noAlarm.includes(x)) && ["abandoned", "crowd"].every((x) => chips.includes(x)), "«Что считать тревогой» в карточке: без other и segment.lost: " + chips.join());
    const trig = TRIGGER_KINDS.filter((k) => !k.stray && trigDeclared(k)).map((k) => k.kind);
    ok(!trig.some((x) => noRule.includes(x)) && ["motion", "other", "segment.lost"].every((x) => trig.includes(x)), "триггеры правил — без rule:false: " + trig.join());
    ok(trig.slice(0, 9).join() === "io.input,motion,linecross,lpr,other,text,unit,silent,segment.lost", "триггеры демо — как в базе (reference.ruleTriggers): " + trig.slice(0, 9).join());
    ruleNewOpen(); rnw.tpl = ""; ruleNewCreate();
    ruleEdit((x) => { delete x._auto; x.name = "Флаги событий"; x.start = "event"; const k0 = ruleTrigAdd(); x.when = [{ sub: k0.sub, kind: k0.kind, ref: "", match: {} }]; x.then = [ruleNewAct(ACT_ADD, null, x)]; });
    paint();
    const evSel = document.querySelector('select[aria-label^="Вид события "]'), opts = evSel ? [...evSel.options].map((o) => o.textContent) : [];
    ok(opts.length && !opts.some((t) => /Оставленный предмет|Исчезновение предмета|Скопление людей/.test(t)) && opts.includes("Детектор: другой вид") && opts.includes("Пропал сегмент записи"), "в списке событий правила нет событий rule:false: " + opts.join(" | "));
    ruleRestore(); paint();
    ok(!rules.some((x) => x.name === "Флаги событий"), "черновик проверки снят");
  }

  // Правило по описаниям видов: событие ALARM датчика security_controller → команда ARM контроллера. Списки формы —
  // события и команды видов (/kinds events, actions с ruleAction), подписи — из описаний, параметры команды — формой
  // по её params; на сервер — {source:"unit", kinds, event} и {type:"unitAction", action, params}, цели — {uid}
  {
    const SENS = "30000296-0000-4000-8000-000000000000", CTRL = "30000294-0000-4000-8000-000000000000", UNK = "30000299-0000-4000-8000-000000000000";
    const tk = TRIGGER_KINDS.find((k) => k.kind === "ALARM"), ak = ACTION_KINDS.find((k) => k.action === "ARM"), pk = ACTION_KINDS.find((k) => k.action === "ping");
    ok(tk && tk.label === "Тревога" && tk.devTypes.join() === "security_controller/SENSOR" && trigDeclared(tk), "событие ALARM — из описания вида датчика: " + (tk && tk.label));
    ok(ak && ak.label === "Поставить на охрану" && ak.devTypes.join() === "security_controller/CONTROLLER" && actDeclared(ak), "команда ARM — из описания вида контроллера: " + (ak && ak.label));
    ok(pk && actDeclared(pk) && !ACTION_KINDS.some((k) => k.action === "calibrate") && !ACTION_KINDS.some((k) => k.action === "probe"), "в правилах — только команды с ruleAction");
    ok(ACTION_KINDS.find((k) => k.action === "record")?.devTypes.join() === "camera" && actDeclared(ACTION_KINDS.find((k) => k.action === "record")), "ruleOnly-команды камеры в правилах предлагаются");
    ruleNewOpen(); rnw.tpl = ""; ruleNewCreate();
    ruleEdit((x) => { delete x._auto; x.name = "Охрана по тревоге датчика"; x.start = "event"; const k0 = ruleTrigAdd(); x.when = [{ sub: k0.sub, kind: k0.kind, ref: "", match: {} }]; x.then = [ruleNewAct(ACT_ADD, null, x)]; });
    paint();
    const evSel = document.querySelector('select[aria-label^="Вид события "]'), evOpt = evSel && [...evSel.options].find((o) => o.textContent === "Тревога");
    ok(!!evOpt, "в списке событий — «Тревога»");
    evSel.value = evOpt.value;
    evSel.dispatchEvent(new Event("change", { bubbles: true }));
    // У камеры своя «Поставить на охрану» (arm) — команда контроллера отдельной строкой в группе своего вида
    const stSel = document.querySelector('select[data-ks="0"]'), stOpt = stSel && stSel.querySelector(`option[value="a:${ACTION_KINDS.indexOf(ak)}"]`);
    ok(stOpt && stOpt.textContent === "Поставить на охрану" && stOpt.parentElement.label === ak.grp && ak.grp !== ACTION_KINDS.find((k) => k.action === "arm").grp, "в списке действий — «Поставить на охрану» в группе «" + (stOpt && stOpt.parentElement.label) + "»");
    stSel.value = stOpt.value;
    stSel.dispatchEvent(new Event("change", { bubbles: true }));
    ruleEdit((x) => { x.when[0].ref = SENS; x.then[0].ref = CTRL; x.then.push(ruleNewAct(pk, null, x)); x.then[1].ref = UNK; });
    paint();
    ok(curRule().when[0].kind === "ALARM" && curRule().then[0].action === "ARM", "выбрано списками: " + JSON.stringify([curRule().when[0], curRule().then[0]]));
    const cnt = document.querySelector('[data-rp="count"]');
    ok(cnt && /Сколько раз/.test(cnt.parentElement.textContent), "параметр команды — полем формы по схеме, подпись x-label");
    cnt.value = "3";
    cnt.dispatchEvent(new Event("input", { bubbles: true }));
    ok(curRule().then[1].args?.count === 3, "значение параметра — числом: " + JSON.stringify(curRule().then[1].args));
    ok(!ruleIssues(curRule()).length, "ошибок формы нет: " + ruleIssues(curRule()).join("; "));
    ruleApply();
    ok(await until(() => rules.some((x) => x.name === "Охрана по тревоге датчика" && autoVer.has(x.id))), "сохранено на сервере");
    const sc = await API.get("/rules/" + rules.find((x) => x.name === "Охрана по тревоге датчика").id);
    const t0 = sc.triggers[0], s0 = sc.steps[0], s1 = sc.steps[1];
    ok(t0.source === "unit" && t0.kinds.join() === "security_controller/SENSOR" && t0.event === "ALARM" && t0.target.include[0].uid === SENS && !("kind" in t0.target.include[0]), "триггер на сервере: " + JSON.stringify(t0));
    ok(s0.type === "unitAction" && s0.action === "ARM" && s0.target.include[0].uid === CTRL && JSON.stringify(s0.params) === "{}" && !("source" in s0), "шаг на сервере: " + JSON.stringify(s0));
    ok(s1.action === "ping" && s1.params.count === 3, "параметры команды на сервере: " + JSON.stringify(s1.params));
    const back = ruleNode(sc);
    ok(back.when[0].kind === "ALARM" && /Тревога/.test(triggerLabel(back.when[0])) && /Поставить на охрану/.test(actionLabel(back.then[0])), "правило ALARM датчика → ARM контроллера создаётся из списков описаний");
  }

  // Правка: черновик у клиента, «Применить» — PUT; кэш и история — из ответа
  ruleOpen(R1);
  const v0 = autoVer.get(R1), h0 = (ruleHist[R1] || []).length;
  ruleEdit((x) => { x.name = "Охрана входа — ночь"; });
  ok(ruleDraft && ruleDraft.id === R1 && (await API.get("/rules/" + R1)).name === "Охрана входа ночью", "черновик — у клиента, на сервере прежнее");
  ruleApply();
  ok(await until(() => !ruleDraft && r(R1).name === "Охрана входа — ночь" && autoVer.get(R1) !== v0), "применено: имя и версия — из ответа");
  ok(await until(() => (ruleHist[R1] || []).length === h0 + 1), "в истории новая версия");
  undo("rundo:" + R1).click();
  ok(await until(() => r(R1).name === "Охрана входа ночью" && (ruleHist[R1] || []).length === h0), "«Отменить» — обратный PUT: имя вернулось, отменённая версия истории убрана");
  ok(![v0].includes(autoVer.get(R1)), "версия после «Отменить» — новая: " + autoVer.get(R1));

  // Годность действия и прочие поля события — в содержимом правила, состояние — от сервера, только показ
  ruleOpen(R1);
  ok(r(R1).validFor === 30 && r(R1).status && document.querySelector("[data-rule-status]"), "годность 30, состояние от сервера: " + JSON.stringify(r(R1).status));
  const statusV = autoVer.get(R1);
  setRuleField("validFor", "120");
  setTriggerExtra(0, '{"pass": 3}');
  setTriggerExtra(1, "не JSON");
  ok(curRule().when[0].match.pass === 3 && !("не" in curRule().when[1].match), "поля события: число осталось числом, неверное не принято");
  ok(ruleDiff().some((x) => /Годность/.test(JSON.stringify(x))), "в плане видна годность");
  setRuleField("validFor", "5");
  ok(ruleIssues(curRule()).some((x) => /от 10 до 600/.test(x)), "вне границ — ошибка заранее");
  setRuleField("validFor", "120");
  ruleApply();
  ok(await until(() => !ruleDraft && autoVer.get(R1) !== statusV), "применено");
  const saved = await API.get("/rules/" + R1);
  ok(saved.validForSec === 120 && saved.triggers[0].match.pass === 3 && typeof saved.triggers[0].match.pass === "number", "на сервере: " + JSON.stringify(saved.triggers[0].match));
  undo("rundo:" + R1).click();
  ok(await until(() => r(R1).validFor === 30), "«Отменить» вернул годность");

  // Два действия детектора: в списке видов, поля из справочника, уходят на сервер как в контракте
  const CAM = "30000013-0000-4000-8000-000000000000";
  ruleNewOpen();rnw.tpl = "";ruleNewCreate();
  const dtmp = ruleDraft.id;
  ruleEdit((x) => { delete x._auto; x.name = "Детектор из сценария"; x.then = [ruleNewAct(ACTION_KINDS.find((k) => k.action === "detect"), null, x)]; });
  paint();
  ok([...document.querySelector("select[data-ks]").options].some((o) => /Проверить архив/.test(o.textContent)), "оба действия в списке видов");
  ok(ruleDetKindOpts({ sub: "det", action: "detect" }).some(([x]) => x === "motion"), "виды детектора — из справочника");
  ruleEdit((x) => { x.then = [{ sub: "det", action: "detect", ref: CAM, detectorKind: "motion", minutes: 10 }, { sub: "det", action: "scan", ref: CAM, detectorKind: "motion", beforeSec: 30, after: 90 }]; });
  ok(actionLabel(curRule().then[1]).includes("30") && actionLabel(curRule().then[1]).includes("90"), "подпись окна: " + actionLabel(curRule().then[1]));
  ruleEdit((x) => { x.then[1].beforeSec = 0; x.then[1].after = 0; x.when = [{ sub: "det", kind: "motion", ref: CAM, match: {} }]; });
  ok(ruleIssues(curRule()).some((t) => /нужно окно|задать окно/.test(t)), "пустое окно — ошибка заранее: " + ruleIssues(curRule()).join("; "));
  ruleEdit((x) => { x.then[1].beforeSec = 30; x.then[1].after = 90; });
  ruleApply();
  ok(await until(() => rules.some((x) => x.name === "Детектор из сценария" && /^7/.test(x.id) && autoVer.has(x.id))), "сохранено: " + dtmp);
  const dsaved = await API.get("/rules/" + rules.find((x) => x.name === "Детектор из сценария").id);
  ok(dsaved.steps[0].type === "unitAction" && dsaved.steps[0].action === "detect" && dsaved.steps[0].params.detectorKind === "motion" && dsaved.steps[0].params.minutes === 10 && dsaved.steps[1].action === "scan" && dsaved.steps[1].params.afterSec === 90 && dsaved.steps[1].params.beforeSec === 30, "на сервере: " + JSON.stringify(dsaved.steps[1]));

  // Цели из нескольких доменов: только объявленные шаги, форма говорит заранее
  const OTHER = devicePool.find((d) => d.type === "camera" && deviceDomain(d.id) && deviceDomain(d.id) !== deviceDomain(CAM)).id;
  refRuleCross = ["preset", "output"];
  const cross = { start: "manual", on: true, when: [], cond: [], rate: 6, then: [{ sub: "vms", action: "preset", ref: CAM, n: 1 }, { sub: "rec", action: "record", ref: OTHER, minutes: 5 }] };
  ok(ruleDomains(cross).size === 2 && /нескольких доменов/.test(ruleProblem(cross)), "запись на чужой домен — ошибка заранее: " + ruleProblem(cross));
  ok(!ruleProblem({ ...cross, then: [{ sub: "vms", action: "preset", ref: CAM, n: 1 }, { sub: "vms", action: "preset", ref: OTHER, n: 1 }] }), "пресеты на двух доменах — можно");
  ok(/другом домене/.test(ruleProblem({ ...cross, server: servers.find((x) => domainOf(x.id) && domainOf(x.id).id !== deviceDomain(OTHER)).id, then: [{ sub: "vms", action: "preset", ref: OTHER, n: 1 }] })), "сервер другого домена — ошибка заранее");
  refRuleCross = null;

  // Отказы сервера словами: чужое устройство называется по имени
  ok(/(Нет права на то, что называет правило|Нет прав на объекты в правиле): «.+»/.test(problemText({ problem: { code: "PERMISSION_DENIED", params: { target: { uid: CAM } } } })), "403 правила называет устройство");
  ok(/не исполняет/.test(problemText({ problem: { code: "NOT_SUPPORTED", params: { issue: { code: "action.notDeclared", params: {} } } } })), "422 вне каталога — своими словами");

  // Новое правило: до «Применить» — только у клиента, после — POST, id от сервера
  ruleNewOpen();rnw.tpl = "";ruleNewCreate();
  const tmp = ruleDraft && ruleDraft.id;
  ok(tmp && r(tmp)._new && !autoVer.has(tmp), "новое правило — черновик: " + tmp);
  ruleEdit((x) => { delete x._auto; x.name = "Проверка из сценария"; x.then = [{ sub: "rec", action: "record", ref: "30000013-0000-4000-8000-000000000000", dur: "min", minutes: 5 }]; });
  ruleApply();
  ok(await until(() => rules.some((x) => x.name === "Проверка из сценария" && /^7/.test(x.id) && autoVer.has(x.id))), "создано на сервере, id — с сервера");
  const NEW = rules.find((x) => x.name === "Проверка из сценария").id;
  ok(rule === NEW && !r(tmp), "выбрано правило с id сервера, черновика нет");

  // Состояние и приглушение группой — один запрос с частичным успехом
  ruleSetMode([R1, R2], "watch");
  ok(await until(() => r(R1).watch && r(R2).watch && r(R1).watchSince), "«Только журнал» у обоих, с даты");
  ok((await API.get("/rules/" + R2)).logOnly === true, "на сервере");
  undo("rundo:").click();
  ok(await until(() => !r(R1).watch && !r(R2).watch), "«Отменить» вернуло состояние");
  ruleMuteSetTo([R2], { until: ruleStamp(new Date(Date.now() + 3 * 36e5)), why: "проверка" });
  ok(await until(() => r(R2).mute && r(R2).mute.why === "проверка"), "приглушено: " + JSON.stringify(r(R2).mute));
  const mv = autoVer.get(R2);
  ok((await API.get(`/rules/${R2}/versions`)).items.length === (ruleHist[R2] || []).length, "приглушение версию истории не пишет");

  // Диалог «Приглушить» — событиями разметки: срок считается, поле даты его меняет, кнопка следит за полем
  const muteApply = () => document.getElementById("rmuApply");
  const muteRadio = (i) => document.querySelectorAll('#bmodal input[name="rmuOpt"]')[i];
  const muteDate = (v) => {
    const el = document.querySelector('#bmodal input[type="datetime-local"]');
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  ruleMuteOpen([R1]);
  ok(!muteApply().disabled && !/Время уже прошло/.test(document.getElementById("bmodal").textContent), "«На 1 час»: кнопка доступна сразу, про прошедшее время не говорит");
  muteRadio(1).click();
  ok(rmu.opt === "day" && muteApply().disabled === ruleStamp(new Date()).endsWith(" 23:59"), "«До конца дня»: кнопка доступна, кроме последней минуты дня");
  muteRadio(2).click();
  ok(rmu.opt === "until" && !!document.querySelector('#bmodal input[type="datetime-local"]') && muteApply().disabled, "«До даты и времени»: поле на экране, без даты кнопка неактивна");
  muteDate("2020-01-01T10:00");
  ok(rmu.until === "2020-01-01T10:00" && muteApply().disabled, "дата в прошлом сохранена, кнопка неактивна");
  muteDate("2099-01-01T10:00");
  ok(rmu.until === "2099-01-01T10:00" && !muteApply().disabled, "дата в будущем — кнопка доступна");
  muteApply().click();
  ok(await until(() => r(R1).mute && /^2099-01-01/.test(r(R1).mute.until)), "приглушено до выбранной даты: " + JSON.stringify(r(R1).mute));
  ok(/^2099-01-01/.test((await API.get("/rules/" + R1)).mute?.until || ""), "на сервере — та же дата");
  ruleMuteSetTo([R1], null);
  ok(await until(() => !r(R1).mute), "приглушение снято");
  // Время — в поясе системы, а не браузера: «На 1 час» в браузере с другим поясом — тот же час
  const tz0 = sysTz;
  sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tokyo" ? "Europe/Moscow" : "Asia/Tokyo";
  ruleMuteOpen([R1]);
  muteApply().click();
  ok(await until(() => r(R1).mute), "«На 1 час» в другом поясе: приглушено");
  ok(!!ruleMuteNow(r(R1)), "«На 1 час» в другом поясе: тишина действует, а не истекла сразу");
  const muteLeft = Date.parse((await API.get("/rules/" + R1)).mute?.until || 0) - promptNow();
  ok(muteLeft > 57 * 6e4 && muteLeft <= 60 * 6e4, "«На 1 час» в другом поясе: на сервере через час, минут: " + Math.round(muteLeft / 6e4));
  sysTz = tz0;
  ruleMuteSetTo([R1], null);
  ok(await until(() => !r(R1).mute), "приглушение снято");

  // Порядок на одно событие — POST /rules/reorder
  const r9 = "70000009-0000-4000-8000-000000000000", o1 = r(R1).order, o9 = r(r9).order;
  ruleOrderMove(r9, -1);
  ok(await until(() => r(r9).order < r(R1).order), "порядок: «Вход на видеостене» раньше «Охраны входа» — " + r(r9).order + " < " + r(R1).order);
  undo("rord:" + r9).click();
  ok(await until(() => r(r9).order === o9 && r(R1).order === o1), "«Отменить» вернуло порядок");

  // Удаление: подтверждение с числом, отсчёт, затем запрос
  ruleDeleteAsk([NEW]);
  ok(/Пропадёт/.test(document.getElementById("confirm").textContent), "в подтверждении — что пропадёт");
  await confirmWith(1);
  ok(rulePendingIds().has(NEW) && !!(await API.get("/rules/" + NEW)), "идёт отсчёт, на сервере правило ещё есть");
  ok(await until(() => !r(NEW), 40000), "после отсчёта удалено");
  ok((await API.get("/rules")).items.every((x) => x.id !== NEW), "на сервере удалено");

  // «Запустить»: трасса приходит ответом и ложится в журнал запусков
  ruleOpen("70000005-0000-4000-8000-000000000000");
  const n5 = (ruleFires["70000005-0000-4000-8000-000000000000"] || []).length;
  ruleRunNow();
  await confirmWith(null);
  ok(await until(() => (ruleFires["70000005-0000-4000-8000-000000000000"] || []).length === n5 + 1), "запуск в журнале");
  const f5 = ruleFires["70000005-0000-4000-8000-000000000000"][0];
  ok(f5.by === "manual" && f5.steps.length && f5.steps.every((s) => s.label), "шаги с подписями: " + f5.steps.map((s) => s.label).join(" | "));

  // Запуск с вопросом оператору: трасса говорит, что он ждёт; снятие приходит потоком. Экрана ответа в форме нет
  const askRule = await API.post("/rules", { name: "Вопрос из сценария", enabled: true, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 6, windowSec: 0, runAt: null, repeat: "skip",
    triggers: [], conditions: [], steps: [{ control: "ask", text: "Открыть?", roleId: "80000004-0000-4000-8000-000000000000", sec: 60, default: "no", yes: [{ type: "unitAction", action: "record", target: { include: [{ uid: CAM }], exclude: [], gone: [], fromEvent: false }, params: { duration: "min", minutes: 5 } }], no: [] }],
    owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true });
  ok(await until(() => r(askRule.id)), "правило с вопросом пришло потоком");
  ruleOpen(askRule.id);
  const asked = await ruleFireRun(r(askRule.id));
  ok(asked.res === "waiting" && ruleResInfo(asked)[1] === "ждёт ответа", "запуск ждёт: " + ruleResInfo(asked)[1]);
  ok(/ждёт ответа оператора/.test(ruleTraceHtml(asked)), "в трассе — почему");
  ok((await API.get("/rule-prompts")).items.length === 1, "вопрос на сервере");
  await API.post("/rules/update", { idempotencyKey: opKey(), items: [{ ruleId: askRule.id, version: autoVer.get(askRule.id), set: { enabled: false } }] });
  ok(await until(() => ruleFires[askRule.id][0].res !== "waiting"), "запуск снят, запись обновилась потоком: " + ruleFires[askRule.id][0].res);
  ok(/запуск снят|запуск отменён/.test(ruleTraceHtml(ruleFires[askRule.id][0])), "в трассе — причина");

  // Пробный запуск: считает сервер, «Записать в журнал» — тоже на сервере
  ruleOpen(R1);
  ruleCheckOpen();
  ruleCheckRun();
  ok(await until(() => rck && rck.rec && rck.rec.by === "test"), "проверка посчитана сервером: " + (rck && rck.rec && rck.rec.res));
  const n1 = ruleFires[R1].length;
  ruleCheckLog();
  ok(await until(() => ruleFires[R1].length === n1 + 1), "записано в журнал");
  ok((await API.get(`/rules/${R1}/fires`)).items.length === ruleFires[R1].length, "журнал на сервере — тот же");

  // История: «Вернуть эту версию» — в черновик, «Применить» — PUT с пометкой версии
  ruleHistRestore(R1, 1);
  ok(ruleDraft && ruleDraft.fromVer === 1, "версия 1 — в черновике");
  ruleApply();
  ok(await until(() => !ruleDraft && /Возврат к версии 1/.test(((ruleHist[R1] || []).slice(-1)[0] || {}).note || "")), "версия истории с пометкой: " + ((ruleHist[R1] || []).slice(-1)[0] || {}).note);
  ok(r(R1).name === "Охрана входа", "содержимое версии 1");

  // Режим объекта вручную — POST /modes/current
  const night = modeByCode("night"), cur0 = objMode;
  ruleModeSwitch(night === cur0 ? modeByCode("work") : night);
  ok(await until(() => objModeManual && objMode !== cur0), "режим включён вручную: " + ruleModeName(objMode));
  ok((await API.get("/modes/current")).manual !== null, "на сервере — вручную");
  undo("rmode").click();
  ok(await until(() => !objModeManual && objMode === cur0), "«Отменить» — снова по расписаниям");

  // Расписание: сохранить — PUT, «Отменить» — обратный PUT
  const sw = SCHEDS.find((s) => s.name === "Рабочие дни");
  ruleOpen("sch:" + sw.id);
  const e = schE("p") || schEd;
  ok(!!e, "редактор расписания открыт");
  if (e) {
    e.d.name = "Рабочие дни — офис";
    schSave("p");
    ok(await until(() => schById(sw.id).name === "Рабочие дни — офис"), "сохранено на сервере и в кэше");
    ok((await API.get("/schedules/" + sw.id)).name === "Рабочие дни — офис", "на сервере");
    undo("ssave:" + sw.id).click();
    ok(await until(() => schById(sw.id).name === "Рабочие дни"), "«Отменить» вернуло имя");
  }

  // Группа особых дней: добавить — POST, «Отменить» — DELETE
  const g0 = DAY_GROUPS.length;
  grpAdd();
  ok(await until(() => DAY_GROUPS.length === g0 + 1 && DAY_GROUPS.every((g) => autoVer.has(g.id))), "группа создана на сервере");
  undo("grp:").click();
  ok(await until(() => DAY_GROUPS.length === g0), "«Отменить» удалило её");

  // Окно обслуживания — вместе со своим расписанием; удаление с отсчётом
  const w0 = MAINT_WINDOWS.length, s0 = SCHEDS.length;
  maintAdd();
  ok(await until(() => MAINT_WINDOWS.length === w0 + 1 && SCHEDS.length === s0 + 1), "окно и его расписание созданы");
  const w = MAINT_WINDOWS[MAINT_WINDOWS.length - 1];
  maintDelAsk(w.id);
  await confirmWith(1);
  ok(await until(() => MAINT_WINDOWS.length === w0 && SCHEDS.length === s0, 40000), "после отсчёта удалено — и его расписание");
  ok((await API.get("/maintenance-windows")).items.length === w0, "на сервере");
  ok(mv === autoVer.get(R2), "версия приглушённого правила не менялась сама");

  // Новые «Спросить оператора» и «Эскалация» — с ролями охраны, как в макете
  const roleGd = accRoles().find((x) => x.n === "Охрана"), roleSg = accRoles().find((x) => x.n === "Старший охраны");
  const ask = CTL_KINDS.find((k) => k.ctl === "ask").make(), esc = CTL_KINDS.find((k) => k.ctl === "escalate").make();
  ok(ask.to === roleGd.id && esc.levels[0].to === roleGd.id && esc.levels[1].to === roleSg.id, "роли новых шагов — «Охрана», «Старший охраны»");

  // «Отменить» правки — «Изменено» прежнее; «Только журнал» → «Включить» → «Отменить» — с прежней даты
  const ch0 = JSON.stringify(r(R1).changed);
  ruleOpen(R1);
  ruleEdit((x) => { x.name = "Охрана входа — проверка"; });
  ruleApply();
  ok(await until(() => !ruleDraft && r(R1).name === "Охрана входа — проверка" && undo("rundo:" + R1)), "правка применена, в тосте «Отменить»");
  undo("rundo:" + R1).click();
  ok(await until(() => r(R1).name !== "Охрана входа — проверка"), "и отменена");
  ok(JSON.stringify(r(R1).changed) === ch0, "«Изменено» прежнее: " + JSON.stringify(r(R1).changed));
  const wr = rules.find((x) => x.on && x.watch && x.watchSince);
  if (wr) {
    const since = wr.watchSince;
    ruleSetMode([wr.id], "on");
    ok(await until(() => !r(wr.id).watch && undo("rundo:" + wr.id)), "«Только журнал» → «Работает»");
    undo("rundo:" + wr.id).click();
    ok(await until(() => r(wr.id).watch), "«Отменить» — снова «Только журнал»");
    ok(r(wr.id).watchSince === since, "«в наблюдении» с прежней даты: " + r(wr.id).watchSince);
  }

  // «Задать только здесь…» в условии «Время»: у сохранённого правила — владелец правило сразу,
  // у нового — после того, как правило сохранено
  const here = async (rid, what) => {
    ruleOpen(rid);
    ruleEdit((x) => { (x.cond = x.cond || []).push(condNew("time")); });
    const i = r(rid).cond.length - 1;
    condSched(i, "__here");
    const n0 = SCHEDS.length;
    schSave("d");
    ok(await until(() => SCHEDS.length === n0 + 1 && r(rid).cond[i].sched && schById(r(rid).cond[i].sched)), what + ": расписание создано");
    return r(rid).cond[i].sched;
  };
  const sid = await here(R2, "сохранённое правило");
  ok(schById(sid).own?.k === "rule" && (await API.get("/schedules/" + sid)).owner?.kind === "rule", "владелец на сервере — правило");
  ruleApply();
  ok(await until(() => !ruleDraft), "правило применено");
  ruleNewOpen(); rnw.tpl = ""; ruleNewCreate();
  const tmpRule = ruleDraft.id;
  const sid2 = await here(tmpRule, "новое правило");
  ok(schById(sid2).own?.k === "rule", "в интерфейсе — местное, ещё до сохранения правила");
  ruleEdit((x) => { delete x._auto; x.name = "Правило со своим временем"; x.then = [{ sub: "rec", action: "record", ref: "30000013-0000-4000-8000-000000000000", dur: "min", minutes: 5 }]; });
  ruleApply();
  ok(await until(() => rules.some((x) => x.name === "Правило со своим временем" && autoVer.has(x.id))), "новое правило сохранено");
  const nr = rules.find((x) => x.name === "Правило со своим временем").id;
  ok(await until(() => schById(sid2)?.own?.id === nr && autoVer.get(sid2)), "в интерфейсе владелец — сохранённое правило");
  ok((await API.get("/schedules/" + sid2)).owner?.id === nr, "и на сервере");

  // Цепочка правила: «или» между событиями и условиями, шаги check, after, abort, расписание с интервалом, новые поля. Всё — настоящими
  // полями контракта: ни меток __any:*, __every, ни служебных полей _stub в теле правила нет
  {
    const CAM2 = "30000013-0000-4000-8000-000000000000";
    const rowLabels = () => [...document.querySelectorAll(".rl-row .rl-n")].map((e) => e.textContent.trim());
    const fresh = (name, tplId, start) => {
      ruleNewOpen(); rnw.tpl = tplId || ""; if (start) rnw.start = start; ruleNewCreate();
      ruleEdit((x) => { delete x._auto; x.name = name; });
    };
    // «Или» между событиями: второе событие по умолчанию «любое из событий», окна нет
    fresh("Цепочка: или", "mrec");
    ruleEdit((x) => { x.when[0].ref = CAM2; });
    addTrigger();
    paint();
    ok(curRule().whenAny === true && !curRule().within, "второе событие: любое из событий, окна нет");
    ok(!!document.querySelector(".rl-chips.rl-logic") && !document.querySelector(".rl-win"), "переключатель есть, окна нет");
    ok(rowLabels().slice(0, 2).join() === "Если,или", "строки подписаны «Если», «или»: " + rowLabels().join());
    setWhenLogic("all"); paint();
    ok(curRule().whenAny === false && curRule().within === 30 && !!document.querySelector(".rl-win") && rowLabels().slice(0, 2).join() === "Если,и", "все события: окно 30 с, строка «и»");
    setWhenLogic("any");
    const ev1 = TRIGGER_KINDS.findIndex((k) => k.kind === "linecross");
    setTriggerKind(1, String(ev1));
    ruleEdit((x) => { x.when[1].ref = CAM2; });
    ok(/ или /.test(ruleSummary(curRule(), true)), "в сводке правила — «или»");
    // «Или» между условиями
    ruleEdit((x) => { x.cond = [{ kind: "armed", ref: CAM2, val: true }, { kind: "armed", ref: CAM2, val: false }]; x.condAny = true; });
    paint();
    ok(rowLabels().join().includes("Если,или") && !!document.querySelectorAll(".rl-chips.rl-logic")[1], "условия: «Если», «или» и свой переключатель");
    ruleApply();
    ok(await until(() => rules.some((x) => x.name === "Цепочка: или" && autoVer.has(x.id))), "сохранено");
    const sv = await API.get("/rules/" + rules.find((x) => x.name === "Цепочка: или").id);
    ok(sv.whenLogic === "any" && sv.windowSec === 0 && sv.condLogic === "any" && sv.triggers.length === 2 && sv.conditions.length === 2, "на сервере: whenLogic any, condLogic any, окна нет");
    ok(!(sv.labels || []).some((l) => /^__/.test(l)) && !JSON.stringify(sv).includes("_stub"), "меток-заглушек и _stub в теле нет");
    const back = ruleNode(sv);
    ok(back.whenAny && back.condAny && back.within === 0, "из записи — обратно в правило");
    // Все: окно и логика и/и уходят как были
    ruleOpen(sv.id);
    setWhenLogic("all"); setCondLogic("all");
    ok(ruleDiffLive().some((d) => /Условия/.test(d.label)) && ruleDiffLive().some((d) => /События/.test(d.label)), "переключатели попадают в сравнение: " + ruleDiffLive().map((d) => d.label).join(", "));
    const bd = ruleBody(curRule());
    ok(bd.windowSec === 30 && !("whenLogic" in bd) && !("condLogic" in bd), "все: windowSec 30, полей логики нет — как до цепочки");
    ruleRestore(); paint();

    // Без reference.ruleFeatures форма «или» и интервал не предлагает: второе событие идёт с окном 30 с, как до цепочки
    {
      const wasFeat = RULE_REF.features;
      RULE_REF.features = [];
      fresh("Цепочка: без логики", "mrec");
      ruleEdit((x) => { x.when[0].ref = CAM2; });
      addTrigger();
      paint();
      ok(curRule().whenAny !== true && curRule().within === 30 && !document.querySelector(".rl-chips.rl-logic") && !!document.querySelector(".rl-win"), "логика не объявлена: окно 30 с, переключателя нет");
      ok(!ruleTplDeclared(RULE_TPL.find((x) => x.id === "norec")), "интервал не объявлен: шаблона с интервалом нет");
      ruleRestore();
      RULE_REF.features = wasFeat;
      paint();
      ok(ruleFeat("whenAny") && ruleFeat("condAny") && ruleFeat("every"), "эталонный набор объявляет все три");
    }
    // Что прочитано из записи, уходит обратно как было
    {
      const base2 = { ...sv, whenLogic: "all", condLogic: "all", start: "schedule", runAt: { days: [1], time: "10:00", randomShift: true } };
      const rb = ruleBody(ruleContentNode(base2, "x"));
      ok(rb.whenLogic === "all" && rb.condLogic === "all" && rb.runAt.randomShift === true && !("everyMin" in rb.runAt), "явное all и randomShift без everyMin не теряются: " + JSON.stringify([rb.whenLogic, rb.condLogic, rb.runAt]));
      ok(stepBody({ ctl: "check", what: "armed", ref: "", depth: 120, yes: [], no: [] }).depthSec === 120, "depthSec у armed не теряется");
    }

    // Новые шаги: проверка с ветками, ожидание конца шага, прерывание
    fresh("Цепочка: шаги", "mrec");
    ruleEdit((x) => {
      x.when[0].ref = CAM2;
      x.then = [{ ctl: "check", what: "online", ref: CAM2, depth: 120, yes: [{ ctl: "abort" }], no: [] },
        { sub: "rec", action: "record", ref: CAM2, dur: "min", minutes: 5 }, { ctl: "after", sec: 30 }, { sub: "rec", action: "record", ref: CAM2, dur: "min", minutes: 1 }];
    });
    paint();
    const stSel = document.querySelector('select[data-ks="0"]');
    const labels = stSel ? [...stSel.options].map((o) => o.textContent) : [];
    ok(["Проверить и разветвить", "Дождаться конца предыдущего шага", "Прервать выполнение"].every((x) => labels.includes(x)), "в списке шагов — три новых: " + labels.slice(-6).join(" | "));
    ok(!!document.querySelector('[data-fk^="add:0.yes"]') || !!document.querySelector(".rl-br"), "у проверки — две ветки «если да», «если нет»");
    ok(!ruleIssues(curRule()).length, "ошибок формы нет: " + ruleIssues(curRule()).join("; "));
    ruleEdit((x) => { x.then[0].what = "record"; x.then[0].depth = 0; });
    ok(/[Гг]лубина/.test(ruleIssues(curRule())[0] || ""), "запись без глубины — ошибка: " + ruleIssues(curRule())[0]);
    ruleEdit((x) => { x.then[0].what = "online"; x.then[0].depth = 3600; });
    ruleApply();
    ok(await until(() => rules.some((x) => x.name === "Цепочка: шаги" && autoVer.has(x.id))), "правило с шагами сохранено");
    const st = await API.get("/rules/" + rules.find((x) => x.name === "Цепочка: шаги").id);
    ok(st.steps[0].control === "check" && st.steps[0].what === "online" && st.steps[0].depthSec === 3600 && st.steps[0].target.include[0].uid === CAM2 && st.steps[0].yes[0].control === "abort", "шаг check на сервере: " + JSON.stringify(st.steps[0]));
    ok(st.steps[2].control === "after" && st.steps[2].sec === 30 && !JSON.stringify(st).includes("_stub") && !JSON.stringify(st).includes('"control":"ask"'), "шаг after на сервере, ask и _stub в теле нет");
    const sr = rules.find((x) => x.name === "Цепочка: шаги");
    await API.post("/rules/update", { idempotencyKey: opKey(), items: [{ ruleId: sr.id, version: autoVer.get(sr.id), set: { enabled: true } }] });
    ok(await until(() => r(sr.id).on), "правило включено");
    ruleOpen(sr.id);
    const fr = await ruleFireRun(r(sr.id));
    ok(fr.steps.some((s) => /Проверить/.test(s.label)) && fr.steps.some((s) => /Прервать/.test(s.label)), "в журнале запуска — подписи новых шагов: " + fr.steps.map((s) => s.label).join(" | "));
    ok(fr.steps.filter((s) => !s.ctl).length === 0, "камера на связи, ветка «если да» прервала запуск: выполненных действий нет");

    // Расписание с интервалом
    fresh("Цепочка: интервал", "norec", "sched");
    ruleEdit((x) => { x.then[0].ref = CAM2; });
    paint();
    ok(curRule().sched && curRule().sched.every === 60, "шаблон «Нет записи»: повтор каждые 60 мин");
    ok(/каждые 60 мин/.test(ruleSchedText(curRule().sched)) && !!document.querySelector('input[aria-label="Минут"]'), "расписание показывает интервал");
    ruleEveryRnd(true);
    ruleApply();
    ok(await until(() => rules.some((x) => x.name === "Цепочка: интервал" && autoVer.has(x.id))), "правило с интервалом сохранено");
    const sd = await API.get("/rules/" + rules.find((x) => x.name === "Цепочка: интервал").id);
    ok(sd.runAt.everyMin === 60 && sd.runAt.randomShift === true && !(sd.labels || []).some((l) => /^__/.test(l)), "runAt на сервере: " + JSON.stringify(sd.runAt));
    ok(ruleNode(sd).sched.every === 60 && ruleNode(sd).sched.rnd === true, "из записи — обратно в расписание");
    ruleOpen(sd.id);
    ruleEveryOn(false);
    ok(!("everyMin" in ruleBody(curRule()).runAt), "без повтора everyMin не уходит");
    ruleRestore(); paint();

    // Событие тома архива: том — объект своего вида, его выбирают в окне выбора, на сервере цель — uid тома
    fresh("Цепочка: том", "vol");
    const vol = arch.flatMap((a) => archVols(a)).find((v) => volById(v.id));
    ruleEdit((x) => { x.when[0].ref = vol.id; x.then[0].to = "ops@example.test"; });
    paint();
    ok(refNodes(vol.id, ["vol"]).length === 1 && ruleUniverse(["vol"]).some((v) => v.id === vol.id), "том есть среди выбираемых объектов правила");
    ok(!ruleIssues(curRule()).length, "ошибок формы нет: " + ruleIssues(curRule()).join("; "));
    ruleApply();
    ok(await until(() => rules.some((x) => x.name === "Цепочка: том" && autoVer.has(x.id))), "правило на томе сохранено");
    const sv2 = await API.get("/rules/" + rules.find((x) => x.name === "Цепочка: том").id);
    ok(sv2.triggers[0].event === "volume.error" && sv2.triggers[0].kinds.join() === "volume" && sv2.triggers[0].target.include[0].uid === vol.id, "на сервере: событие volume.error тома " + vol.id);

    // Новые поля и действия: числа — числами, роль — roleId, вложение, методы веб-запроса
    fresh("Цепочка: действия", "mrec");
    const role = accRoles()[0].id;
    ruleEdit((x) => {
      x.when[0].ref = CAM2;
      x.then = [{ sub: "rec", action: "record", ref: CAM2, dur: "min", minutes: 5, preSec: "7", fps: "12" }, { sub: "vms", action: "preset", ref: CAM2, n: 1, speed: "50", holdSec: "9" },
        { sub: "ntf", action: "push", to: "ops", subj: "{камера}", attach: "snapshot" }, { sub: "client", action: "sound", file: "a.wav", to: role }, { sub: "client", action: "view", view: "map", to: role },
        { sub: "net", action: "http", method: "PUT", url: "http://x.test/a", auth: "bearer", headers: "X: 1", body: "{}" }, { sub: "vms", action: "output", ref: "", state: "on" }];
    });
    const b2 = ruleBody(curRule()).steps;
    ok(b2[0].params.preSec === 7 && b2[0].params.fps === 12 && b2[1].params.speed === 50 && b2[1].params.holdSec === 9, "числа record и preset — числами: " + JSON.stringify([b2[0].params, b2[1].params]));
    ok(b2[2].source === "ntf" && b2[2].action === "push" && b2[2].subject === "{камера}" && b2[2].attach === "snapshot", "push: " + JSON.stringify(b2[2]));
    ok(b2[3].roleId === role && b2[3].file === "a.wav" && b2[4].view === "map" && b2[5].method === "PUT" && b2[5].auth === "bearer" && b2[5].headers === "X: 1", "client.* и http: " + JSON.stringify([b2[3], b2[4], b2[5]]));
    ok(b2[6].params.state === true, "реле: включить");
    ruleEdit((x) => { x.then[1].speed = "500"; });
    ok(/Скорость/.test(ruleIssues(curRule())[0] || ""), "скорость вне 1…100 — ошибка: " + ruleIssues(curRule())[0]);
    ruleRestore(); paint();
  }

  // Перечитывание всего (поток потерян) не сбрасывает черновик правила и отсчёт удаления
  const sdel = SCHEDS.find((s) => !s.builtin && !s.own && !s._pend && s.id !== sw.id);
  schDelAsk(sdel.id);
  await confirmWith(1);
  ruleOpen(R1);
  ruleEdit((x) => { x.name = "Черновик при перечитывании"; });
  const was = r(R1);
  apiOnEvent({ type: "stream.reset" });
  ok(await until(() => r(R1) !== was), "всё перечитано");
  ok(ruleDraft && ruleDraft.id === R1 && r(R1).name === "Черновик при перечитывании" && ruleDiff().length === 1, "черновик правила на месте");
  ok(schById(sdel.id)?._pend, "расписание по-прежнему ждёт удаления");
  ok(await until(() => !schById(sdel.id), 30000), "по истечении отсчёта удалено");
  ruleRestore(); paint();
});
