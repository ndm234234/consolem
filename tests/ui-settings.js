/* Сценарии интерфейса: опции, лицензии, журнал. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until }) => {
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
