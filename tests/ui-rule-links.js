// Связки «Оборудования» с правилами автоматизации (их нет в прототипе 09): удаление устройства из правила, «Создать правило по событию…».
// Этап А: правила ещё у клиента, id правила — старый («r1»); на этапе Б — с сервера.
UiCheck(async ({ ok, until, confirmWith }) => {
  const id = "30000041-0000-4000-8000-000000000000";            // «Запасной вход» (c2r) — в «Охрана входа ночью»
  const n = find(id).n, r1 = rules.find(r => r.id === "r1");
  ok(JSON.stringify(r1.then).includes(id), "правило ссылается на камеру");
  confirmDeleteNodes([id]);
  ok(/перестанут работать/.test(document.getElementById("confirm").textContent), "в подтверждении — правила, которые перестанут работать");
  await confirmWith(1);
  ok(await until(() => !find(id), 40000), "камера удалена на сервере и пропала из кэша");
  ok(await until(() => JSON.stringify(r1.then).includes("gone:Запасной вход")), "в правиле отмечена удалённой: " + JSON.stringify(r1.then[0].ref));
  ruleFromDevice(devicePool.find(d => d.type === "camera").id);
  ok(!!ruleDraft || !!document.querySelector(".confirm.open"), "«Создать правило по событию…» из устройства открывает новое правило");
});
