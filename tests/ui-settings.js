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
  // Лицензии по ключам — заглушка, пока нет ответа на запрос 2026-11-06-094022Z-mockup-domain-licenses
  ok(/Professional/.test(document.body.textContent) && /72785-4410/.test(document.body.textContent), "лицензии — карточки ключей");
  // Журнал
  goApp("log");
  ok(LOG_ROWS.length > 0 && /^\d\d:\d\d$/.test(LOG_ROWS[0][0]), "журнал с сервера: " + LOG_ROWS.length + ", первое в " + LOG_ROWS[0][0]);
  ok(LOG_ROWS.some((x) => x[1] === "Тревога"), "категории записей — словами");
  // Хранение: сроки событий и тревог; ключа нет у сервера — поля нет
  sys = "keep";
  goApp("sys");
  ok(!!document.querySelector('[data-set="events.retentionDays"]') && !!document.querySelector('[data-set="alarms.retentionDays"]'), "страница «Хранение»");
  settingSet("events.retentionDays", "30");
  ok(await until(() => SETTINGS.find((x) => x.id === "events.retentionDays").value === "30"), "значение пришло с сервера");
  ok((await API.get("/settings")).values["events.retentionDays"] === 30, "на сервере — число");
  const al = SETTINGS.find((x) => x.id === "alarms.retentionDays"), keep = al.value;
  // Тревожные виды на весь домен — на странице «Обработка тревог»: чипы из reference.eventKinds
  sys = "alarm";
  paint();
  const ad = SETTINGS.find((x) => x.id === "alarms.domain");
  ok(!!document.querySelector('[data-set="alarms.domain"] [data-chip="motion"]'), "виды — чипами");
  document.querySelector('[data-set="alarms.domain"] [data-chip="motion"]').click();
  ok(await until(() => (ad.value || []).includes("motion")), "вид отмечен");
  ok((await API.get("/settings")).values["alarms.domain"].join() === "motion", "на сервере — списком");
  ok(await until(() => document.querySelector('[data-set="alarms.domain"] [data-chip="motion"].on')), "страница показывает отмеченное");
  // Ключа нет у сервера — поля нет
  sys = "keep";
  al.value = undefined;
  sysUI();
  ok(!document.querySelector('[data-set="alarms.retentionDays"]'), "ключа нет у сервера — поля нет");
  al.value = keep;
});
