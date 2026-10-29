/* Сценарии интерфейса: права — ссылки на «Оборудование», черновик и «Применить» пакетом, отказ сервера,
   удаление с вводом числа и отсчётом, синхронизация каталога. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  goApp("acc");
  const toastText = () => document.getElementById("tt")?.textContent || "";
  // Права ролей ведут в «Оборудование»: папки и объекты — те же id
  const op = accRoles().find((r) => Object.keys(r.groups).length);
  ok(Object.keys(op.groups).every((k) => folderById(k) || domainById(k)), "права роли «" + op.n + "» — на существующие папки: " + Object.keys(op.groups).length);
  ok(Object.keys(op.objs).filter((k) => !k.includes(":")).every((k) => find(k) || archById(k)), "исключения — на существующие объекты");
  ok(accIssues().length === 20, "проверка: " + accIssues().length);
  // Правка в черновике → «Применить» → сервер
  const u = accUsers().find((x) => x.login === "olga");
  accSetUser(u.id, "email", "olga@new.local");
  const nu = { id: accNewId(), login: "tester", name: "Тестов", email: "", on: true, roles: [op.id], last: null, created: accIso(0), until: {}, expires: "", web: 0, mobile: 0, ldap: "" };
  accSt().users.push(nu);
  accEdited();
  const lines = accPlanLines().length;
  ok(lines >= 2, "в черновике изменений: " + lines);
  const v0 = accVer;
  accPlan();
  await confirmWith(null);
  ok(await until(() => accVer !== v0), "применено, версия " + accVer);
  const v1 = accVer;
  const a = await API.get("/access");
  ok(a.users.find((x) => x.id === u.id).email === "olga@new.local", "на сервере — новый e-mail");
  ok(a.users.some((x) => x.id === nu.id && x.login === "tester" && x.roleIds[0] === op.id), "новый пользователь с UUID и ролью");
  ok(a.history[0].actor === ACC_ME && accSrv().log[0].who === ACC_ME, "история — с автором " + ACC_ME + ": «" + a.history[0].text.slice(0, 50) + "»");
  ok(!accPlanLines().length, "черновик чист");
  // Отказ сервера: без администраторов — 409, снимок не меняется
  accSt().roles.forEach((r) => (r.own.unr = false));
  accEdited();
  accPlan();
  await confirmWith(null);
  ok(await until(() => /без администратора|лишит вас входа/.test(toastText())), "сервер отказал: «" + toastText() + "»");
  ok(accVer === v1 && accSrv().roles.some((r) => r.own.unr), "на сервере не изменилось");
  ACC.ed = accClone(ACC.srv);
  accResolveAll();
  // Удаление пользователя: число, отсчёт, затем — в черновик
  const del = accUsers().find((x) => x.login === "tester");
  accDeleteUser(del.id);
  ok(document.getElementById("confirmOk").disabled, "«Удалить» неактивна до ввода числа");
  await confirmWith(1);
  ok(pendingDelHas(del.id) && accUser(del.id), "отсчёт с «Отменить», пока ещё в черновике");
  ok(await until(() => !accUser(del.id), 30000), "по истечении — удалён из черновика");
  // Удаление роли — так же
  const ext = accRoles().find((r) => r.n === "Подрядчик") || accRoles().find((r) => !r.own.unr && r.id !== op.id);
  accDeleteRole(ext.id, true);
  await confirmWith(1);
  ok(pendingDelHas(ext.id), "роль: отсчёт");
  ok(await until(() => !accRole(ext.id), 30000), "роль удалена из черновика");
  accPlan();
  await confirmWith(null);
  ok(await until(() => accVer !== v1), "применено");
  const b = await API.get("/access");
  ok(!b.users.some((x) => x.id === del.id) && !b.roles.some((x) => x.id === ext.id), "на сервере — ни пользователя, ни роли");
  // Синхронизация каталога
  const c = accCats()[0];
  accSyncRun(c.id);
  ok(await until(() => accCat(c.id).status === "run"), "синхронизация идёт");
  ok(await until(() => accCat(c.id).status === "ok" && /завершена/.test(toastText())), "завершена: «" + toastText() + "»");
  // Синхронизацию ведёт сервер: после неё «Применить» проходит без 412
  const vs = accVer;
  accSetUser(u.id, "email", "olga@after.sync");
  accPlan();
  await confirmWith(null);
  ok(await until(() => accVer !== vs), "после синхронизации «Применить» проходит: версия " + vs + " → " + accVer);
});
