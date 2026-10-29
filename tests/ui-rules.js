/* Сценарии интерфейса: правила автоматизации, опции, лицензии, журнал. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until }) => {
  // Правила: правка уходит на сервер правилом целиком, экран — по ответу
  goApp("rules");
  const r = curRule();
  ok(/^7/.test(r.id) && rules.length === 4, "правила с сервера: " + rules.length);
  ok((ruleFires[r.id] || []).length > 0 && /^\d\d:\d\d:\d\d$/.test(ruleFires[r.id][0][0]), "срабатывания: " + ruleFires[r.id].length + ", первое в " + ruleFires[r.id][0][0]);
  setRuleField("name", "Охрана входа — ночь");
  ok(r.name !== "Охрана входа — ночь" || curRule() !== r, "до ответа кэш прежний");
  ok(await until(() => curRule().name === "Охрана входа — ночь"), "переименовано");
  toggleRule();
  ok(await until(() => curRule().on === false), "выключено");
  const n0 = curRule().when.length;
  addTrigger();
  ok(await until(() => curRule().when.length === n0 + 1), "событие добавлено");
  setActionField(1, "port", "3");
  ok(await until(() => String(curRule().then[1].port) === "3"), "номер реле изменён");
  const srv = await API.get("/rules/" + r.id);
  ok(srv.name === "Охрана входа — ночь" && srv.enabled === false && srv.triggers.length === n0 + 1 && srv.actions[1].port === 3, "на сервере: имя, выключено, событий " + srv.triggers.length + ", реле " + srv.actions[1].port + " числом");
  delAction(0);
  ok(await until(() => curRule().then.length === srv.actions.length - 1), "действие убрано");
  // Опции: значение сохраняется при смене
  goApp("sys");
  sys = "ntp";
  paint();
  settingSet("ntp.server", "time.local");
  ok(await until(() => SETTINGS.find((s) => s.id === "ntp.server").value === "time.local"), "сервер времени изменён");
  settingSet("sec.2fa", "Обязательно админам");
  ok(await until(() => SETTINGS.find((s) => s.id === "sec.2fa").value === "Обязательно админам"), "2FA изменена");
  const st = await API.get("/settings");
  ok(st.values["ntp.server"] === "time.local" && st.values["sec.2fa"] === "admins", "на сервере — кодом: " + st.values["sec.2fa"]);
  sys = "lic";
  paint();
  ok(/48\/64/.test(document.body.textContent), "лицензии с сервера");
  // Журнал
  goApp("log");
  ok(LOG_ROWS.length === 24 && /^\d\d:\d\d$/.test(LOG_ROWS[0][0]), "журнал с сервера: " + LOG_ROWS.length + ", первое в " + LOG_ROWS[0][0]);
  ok(LOG_BY_CAT.alarm.length > 0 && LOG_BY_CAT.alarm.every((x) => x[1] === "Тревога"), "по категориям");
});
