/* Сценарии интерфейса: «Автоматизация» через API — правка правила и «Отменить», новое правило, состояние и
   приглушение группой, порядок, удаление с отсчётом, «Запустить», пробный запуск, история версий, режим
   объекта вручную, расписание, группа особых дней, окно обслуживания. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  const R1 = "70000001-0000-4000-8000-000000000000";   // «Охрана входа ночью»
  const R2 = "70000002-0000-4000-8000-000000000000";   // «Сирена по двери»
  const r = (id) => rules.find((x) => x.id === id);
  const undo = (prefix) => [...document.querySelectorAll(".ttu")].reverse().find((e) => e.id.startsWith("ttu-" + prefix))?.querySelector(".ttu-act");
  goApp("rules");

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
