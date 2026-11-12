/* Прототип 25, единый мастер создания: окно не закрывается случайно, черновик, отмена, пароль не в браузере, доведение до конца.
   Запуск:
   python tools/check_ui.py tests/ui-edinyy-master.js */
UiCheck(async ({ ok, until, confirmWith }) => {
  const d = domains[0];
  const wiz = () => document.getElementById("wiz");
  const wizOn = () => wiz().classList.contains("open");
  const wn = () => document.getElementById("wn");
  const draft = (id) => localStorage.getItem("cfg.wz." + id);
  const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const confirmOn = () => document.getElementById("confirm").classList.contains("open");

  // Серверы: окно не закрывается случайно
  goApp("hw");
  pick(d.id);
  openAddServers(d.id);
  ok(wizOn() && document.querySelectorAll("#wst .dc-st").length === 2, "серверы: окно с двумя шагами");
  ok(wn().disabled && /Отметьте|Отметить/.test(document.getElementById("wizFoot").textContent), "серверы: без выбора «Далее» погашена, причина в итоге");
  ok(document.getElementById("wizFoot").textContent.includes(d.name), "серверы: домен виден и без выбора");
  esc();
  ok(wizOn(), "серверы: Escape не закрывает");
  wiz().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  ok(wizOn(), "серверы: клик мимо окна не закрывает");

  // Черновик: закрыть — сохранить, продолжить — то же место, отмена — спросить и удалить
  const net = d.unallocServers.find((s) => s.fingerprint && s.cls !== "camera");
  const row = () => [...document.querySelectorAll(".srv-list .it")].find((r) => r.textContent.includes(net.ip));
  row().click();
  ok(!wn().disabled, "серверы: с выбором «Далее» работает");
  wn().click();
  ok(wizd.srvStep === 1, "серверы: второй шаг");
  wzClose("srv");
  ok(!wizOn() && !!draft("srv") && !!document.getElementById("wzDock-srv"), "закрыть: окна нет, черновик и док есть");
  document.querySelector("#wzDock-srv .btn.pri").click();
  ok(wizOn() && wizd.srvStep === 1, "продолжить: тот же шаг");
  document.getElementById("wc").click();
  ok(await until(confirmOn), "отмена спрашивает");
  ok(wizOn() && !!draft("srv"), "до ответа окно и черновик на месте");
  document.getElementById("confirmOk").click();
  ok(await until(() => !wizOn()), "отмена закрыла окно");
  ok(!draft("srv") && !document.getElementById("wzDock-srv"), "отмена удалила черновик и док");

  // Серверы до конца: сверка отпечатка, потом окно закрывается
  openAddServers(d.id);
  row().click();
  wn().click();
  ok(wizd.srvStep === 1 && !d.servers.some((s) => s.id === net.id), "шаг «Проверка»: сервер ещё не принят");
  wn().click();
  ok(await until(confirmOn), "окно сверки открылось");
  await confirmWith(null);
  ok(await until(() => d.servers.some((s) => s.id === net.id)), "сервер принят");
  ok(await until(() => !wizOn()), "после успеха окно закрыто");
  ok(!draft("srv"), "после успеха черновика нет");

  // Хранилище до конца
  const owner = servers.find((s) => !isUnallocated(s.id) && s.online !== false);
  const nArch = arch.length;
  addArchive(owner.id);
  const next = () => [...document.querySelectorAll("#bmFoot .btn")].find((b) => /Далее/.test(b.textContent));
  ok(document.querySelectorAll("#bmBody .dc-st").length === 4, "хранилище: четыре шага");
  ok(!document.getElementById("anCreate"), "хранилище: кнопки создания на первом шаге нет");
  for (let i = 0; i < 3; i++) next().click();
  ok(an.step === 3 && !!document.getElementById("anCreate"), "хранилище: последний шаг называет результат");
  document.getElementById("anCreate").click();
  ok(await until(() => arch.length === nArch + 1), "хранилище создано");
  ok(!document.getElementById("bmodal").classList.contains("open") && !draft("arch"), "хранилище: окно закрыто, черновика нет");

  // Хранилище с секретом: после перезагрузки просит его заново и не создаёт без него
  addArchive(owner.id);
  const bucketKind = refArchKinds.find((k) => k.address === "bucket");
  ok(!!bucketKind, "в наборе есть вид с бакетом");
  if (bucketKind) {
    anSet("kind", bucketKind.kind);
    an.name = "Проба";
    an.vol.secret = "S3-секрет";
    an.vol.bucket = "b";
    an.vol.size = an.vol.size || 10;
    an.step = 3;
    renderArchNew();
    const nA = arch.length;
    wzClose("arch");
    ok(!draft("arch").includes("S3-секрет"), "секрета хранилища нет в localStorage");
    delete wzMem.arch;
    wzResume("arch");
    ok(an.step === 2 && /заново|снова/.test(document.getElementById("bmFoot").textContent), "после перезагрузки — шаг тома, причина в итоге");
    createArchive();
    ok(arch.length === nA, "без секрета не создаётся");
    wzCancelQuiet("arch");
  }

  // Пользователь: пароль не попадает в браузер и не возвращается из черновика
  goApp("acc");
  accUserDlgOpen();
  const pwd = "Vr9-секрет-пароль";
  accUdSet("login", "wz-proba");
  accUdSet("pwd", pwd);
  wzSave("accUd");
  ok(!!draft("accUd"), "пользователь: черновик записан");
  ok(!JSON.stringify(localStorage).includes(pwd), "пользователь: пароля нет в localStorage");
  ok(/wz-proba/.test(draft("accUd")), "пользователь: логин в черновике");
  wzCancelQuiet("accUd");

  // Роль: две колонки, тело окна не прокручивается, прокрутка колонки переживает клик
  accWzOpen();
  accWz.name = "Проба";
  accWz.step = 1;
  accWzRender();
  const bd = () => document.getElementById("accWizBd");
  const cols = () => [...bd().querySelectorAll(".wz-col")];
  ok(cols().length === 2 && getComputedStyle(bd()).overflowY === "hidden", "«Права»: две колонки, тело окна не прокручивается");
  ok(/Камеры по папкам/.test(cols()[1].textContent) && /Доступ к функциям/.test(cols()[0].textContent), "«Права»: функции слева, камеры справа");
  ok(getComputedStyle(bd().querySelector(".acc-wz-grp")).overflowY === "visible", "«Права»: у таблицы папок нет своей прокрутки");
  cols()[0].scrollTop = 120;
  const was = cols()[0].scrollTop;
  cols()[0].querySelector("input[type=checkbox]").click();
  ok(cols()[0].scrollTop === was, "«Права»: клик по галочке не сбрасывает прокрутку");
  accWz.step = 2;
  accWz.who = "pick";
  accWzRender();
  ok(cols().length === 2 && !!cols()[1].querySelector("#accWzSel") && !!cols()[0].querySelector("#accWzUl"), "«Кому»: список слева, выбранное справа");
  accWzWho("none");
  ok(!bd().querySelector(".wz-cols") && !document.querySelector("#accWiz .wz-win").classList.contains("wz-split"), "«Пока никому»: одна колонка");
  accWzClose();
  wzCancelQuiet("accWiz");

  // Черновик после перезагрузки: секретов нет, мастер не падает
  accUserDlgOpen();
  accUdSet("login", "wz-reload");
  accUdSet("pwd", pwd);
  wzClose("accUd");
  delete wzMem.accUd;
  wzResume("accUd");
  ok(accUd.pwd === "" && accUd.login === "wz-reload" && !!document.querySelector("#accUdFt .btn"), "пользователь: черновик без пароля открывается");
  wzCancelQuiet("accUd");

  // Роль: последний шаг проверяет пройденные
  accWzOpen();
  accWz.name = accRoles()[0].n;
  accWz.step = ACC_WZ.length - 1;
  accWzRender();
  const nRoles = accRoles().length;
  accWzNext();
  ok(accWz?.step === 0 && accRoles().length === nRoles, "роль: занятое имя возвращает на первый шаг, роли не прибавилось");
  wzCancelQuiet("accWiz");

  // Escape закрывает подтверждение поверх мастера, мастер остаётся
  accWzOpen();
  accWz.name = "Проба";
  accWz.step = 1;
  accWzRender();
  wzCancel("accWiz");
  ok(await until(confirmOn), "роль: отмена спрашивает");
  esc();
  ok(!confirmOn() && accWzIsOpen(), "Escape закрыл подтверждение, мастер открыт");
  wzCancelQuiet("accWiz");

  // Серверы: черновик другого домена не пропадает без вопроса
  goApp("hw");
  if (domains.length > 1) {
    const other = domains[1];
    pick(d.id);
    openAddServers(d.id);
    const f = document.getElementById("wizIps");
    f.value = "10.9.9.9";
    ipTextSet(f);
    wzClose("srv");
    delete wzMem.srv;
    ok(!!draft("srv"), "черновик серверов записан");
    openAddServers(other.id);
    ok(await until(confirmOn) && !wizOn() && !!draft("srv"), "другой домен: сначала вопрос, черновик цел");
    await confirmWith(null);
    ok(await until(wizOn) && wizd.domain === other.id && !(wizd.ipText || "").trim(), "начать заново: новое окно в другом домене");
    closeWizard();
    wzDrop("srv");
  }
  wzMem.srv = { domain: d.id, ipText: "10.8.8.8", ipBusy: true, ipAdding: true, srvStep: 0, ipPick: new Set() };
  openAddServers(d.id);
  ok(wizd.ipText === "10.8.8.8" && !wizd.ipBusy && !wizd.ipAdding, "продолжение: текст на месте, флагов запросов нет");
  closeWizard();
  wzDrop("srv");

  // Короткие мастера: крестик сохраняет, «Продолжить» возвращает, «Отмена» спрашивает и удаляет
  const dock = (id) => !!document.getElementById("wzDock-" + id);
  const cancelYes = async (click) => {
    click();
    ok(await until(confirmOn), "отмена спрашивает");
    document.getElementById("confirmOk").click();
    await until(() => !confirmOn());
  };

  // Группа пользователей; пустая форма черновика не оставляет
  goApp("acc");
  accUgOpen();
  wzClose("accUg");
  ok(!draft("accUg") && !dock("accUg"), "группа: пустая форма не оставляет черновика");
  accUgOpen();
  accUgdName("Проба-группа");
  accUgdComment("описание");
  wzClose("accUg");
  ok(!!draft("accUg") && dock("accUg"), "группа: крестик сохранил черновик");
  delete wzMem.accUg;
  accUgOpen();
  ok(accUgd.name === "Проба-группа" && accUgd.comment === "описание" && document.querySelector("#accUgBd input").value === "Проба-группа", "группа: повторный вход продолжает");
  await cancelYes(() => [...document.querySelectorAll("#accUgFt .btn")].find((b) => /Отмена/.test(b.textContent)).click());
  ok(!accDrawerOpen("accUg") && !draft("accUg") && !dock("accUg"), "группа: отмена удалила черновик");
  // Переименование черновик новой группы не трогает
  const ug0 = accGroupsAll().find((g) => !g.src);
  accUgOpen();
  // В заголовке мастера одна кнопка: «Свернуть» рядом с ней делала то же самое
  const ugNew = document.querySelectorAll("#accUg .wz-tools .dc-x");
  ok(ugNew.length === 1 && ugNew[0].getAttribute("aria-label") === "Закрыть" && (ugNew[0].title || ugNew[0].dataset.tip) === "Закрыть: черновик сохранится", "группа: в заголовке одна кнопка «Закрыть», подсказка говорит о черновике");
  accUgdName("Вторая");
  wzClose("accUg");
  const ugRow = document.getElementById("wzDock-accUg");
  ok(!!ugRow && (matchMedia("(prefers-reduced-motion: reduce)").matches || ugRow.classList.contains("wz-dock-flash")), "группа: после закрытия строка черновика в доке моргает");
  accUgOpen(ug0.id);
  ok(accUgd.gid === ug0.id && accUgd.name === ug0.n, "группа: переименование открывает свою группу");
  const ugTools = document.querySelectorAll("#accUg .wz-tools .dc-x");
  ok(ugTools.length === 1 && (ugTools[0].title || ugTools[0].dataset.tip) === "Закрыть", "группа: у переименования только крестик, без слов о черновике");
  document.getElementById("wzDock-accUg")?.classList.remove("wz-dock-flash");
  wzClose("accUg");
  ok(!document.getElementById("wzDock-accUg")?.classList.contains("wz-dock-flash"), "группа: закрытие переименования не подсвечивает черновик новой группы");
  ok(!!draft("accUg"), "группа: после переименования черновик новой группы цел");
  accUgOpen();
  accUgApply();
  ok(!draft("accUg") && !dock("accUg") && accGroupsAll().some((g) => g.n === "Вторая"), "группа: создана, черновика нет");

  // Группа каталога: имя по умолчанию не считается работой
  const cat0 = accCats().find((c) => c.avail?.length);
  ok(!!cat0, "в наборе есть каталог с группами");
  if (cat0) {
    accCgOpen(cat0.id, 0);
    wzClose("accCg");
    ok(!draft("accCg"), "группа каталога: без изменений черновика нет");
    accCgOpen(cat0.id, 0);
    accCgName("Проба-каталог");
    accCg.roles.add(accRoles()[0].id);
    wzClose("accCg");
    ok(!!draft("accCg") && dock("accCg"), "группа каталога: крестик сохранил черновик");
    delete wzMem.accCg;
    wzResume("accCg");
    ok(accCg.name === "Проба-каталог" && accCg.roles.has(accRoles()[0].id), "группа каталога: имя и роли на месте");
    await cancelYes(() => [...document.querySelectorAll("#accCgFt .btn")].find((b) => /Отмена/.test(b.textContent)).click());
    ok(!accCg && !draft("accCg"), "группа каталога: отмена удалила черновик");
    // Каталог изменился — черновик устарел
    accCgOpen(cat0.id, 0);
    accCgName("Проба-старая");
    const dn0 = accCg.dn;
    wzClose("accCg");
    wzMem.accCg.dn = dn0 + "-нет";
    wzResume("accCg");
    ok(!accCg && !draft("accCg"), "группа каталога: устаревший черновик не открывается");
  }

  // Правило: шаг и шаблон
  goApp("rules");
  ruleNewOpen();
  wzClose("rule");
  ok(!draft("rule"), "правило: без выбора черновика нет");
  ruleNewOpen();
  ruleNewGo(1);
  wzClose("rule");
  ok(!document.getElementById("bmodal").classList.contains("open") && !!draft("rule") && dock("rule"), "правило: крестик закрыл окно и сохранил черновик");
  delete wzMem.rule;
  ruleNewOpen();
  ok(rnw.step === 1, "правило: повторный вход на том же шаге");
  await cancelYes(() => [...document.querySelectorAll("#bmFoot .btn")].find((b) => /Отмена/.test(b.textContent)).click());
  ok(!draft("rule") && !document.getElementById("bmodal").classList.contains("open"), "правило: отмена удалила черновик");
  ruleNewOpen();
  ruleNewGo(1);
  wzClose("rule");
  wzResume("rule");
  const nRules = rules.length;
  ruleNewCreate();
  ok(rules.length === nRules + 1 && !draft("rule") && !dock("rule"), "правило: создано, черновика нет");

  // Служба: тип и поля возвращаются, в том числе после смены сервера
  ruleDraft = null; // новое правило не применено: без этого уход из раздела спрашивает
  goApp("hw");
  ok(app === "hw" && !confirmOn(), "служба: раздел «Оборудование», вопросов нет");
  pick(owner.id, { force: true });
  openW("svc");
  wzClose("obj");
  ok(!draft("obj"), "служба: без выбора типа черновика нет");
  openW("svc");
  chooseAdd("object", "svc", "email");
  wn().click();
  ok(ws === 2 && !!document.getElementById("wizName"), "служба: шаг параметров");
  document.getElementById("wizName").value = "Проба-почта";
  document.getElementById("wizSmtp").value = "smtp.proba";
  wzClose("obj");
  ok(!wizOn() && !!draft("obj") && dock("obj"), "служба: крестик сохранил черновик");
  ok(/Проба-почта/.test(draft("obj")), "служба: поля в черновике");
  delete wzMem.obj;
  openW("svc");
  ok(wizOn() && ws === 2 && document.getElementById("wizName").value === "Проба-почта" && document.getElementById("wizSmtp").value === "smtp.proba", "служба: тот же шаг, поля на месте");
  // Единица СКУД — другой вид: сначала вопрос
  openW("unit");
  ok(await until(confirmOn), "единица: чужой черновик — сначала вопрос");
  closeConfirm();
  await until(() => !confirmOn());
  const nDev = (await uiDevices()).length;
  wn().click();
  ok(await until(() => !wizOn()), "служба: создана, окно закрыто");
  ok(!draft("obj") && !dock("obj"), "служба: черновика нет");
  ok(await until(async () => (await uiDevices()).length === nDev + 1), "служба: объект на сервере");
  // «Отмена» спрашивает
  openW("svc");
  chooseAdd("object", "svc", "email");
  await cancelYes(() => document.getElementById("wc").click());
  ok(!wizOn() && !draft("obj"), "служба: отмена удалила черновик");
  openW("svc");
  document.getElementById("wc").click();
  ok(!wizOn() && !confirmOn(), "служба: без выбора отмена закрывает сразу");
  // Повторный клик по выбранному типу поля не сбрасывает
  openW("svc");
  chooseAdd("object", "svc", "email");
  wn().click();
  document.getElementById("wizName").value = "Проба-возврат";
  wizBack();
  chooseAdd("object", "svc", "email");
  wn().click();
  ok(document.getElementById("wizName").value === "Проба-возврат", "служба: тот же тип — поля на месте");
  wzClose("obj");
  // С другого места черновик не продолжается молча
  const otherSrv = domains.flatMap((d) => d.servers).find((s) => s.id !== owner.id && !isUnallocated(s.id));
  ok(!!otherSrv, "в наборе есть другой сервер");
  pick(otherSrv.id, { force: true });
  openW("svc");
  ok(await until(confirmOn), "служба: другой сервер — сначала вопрос");
  closeConfirm();
  await until(() => !confirmOn());
  ok(!wizOn() && !!draft("obj"), "служба: «Оставить» сохранил черновик");
  // Мастер устройств открывается и при чужом черновике, без вопроса
  const tv0 = tview;
  tview = "sys";
  lanOpenWizard("manual");
  ok(wizOn() && wizd.mode === "device-add" && !confirmOn() && !!draft("obj"), "устройства: окно открыто без вопроса, черновик службы цел");
  closeWizard();
  tview = tv0;
  // Черновик помнит свой сервер, когда выделение ушло в другой домен
  const ownDom = domainOf(owner.id);
  const otherDom = domains.find((d) => d.id !== ownDom?.id && d.servers.some((s) => !isUnallocated(s.id)));
  if (otherDom) {
    pick(otherDom.servers.find((s) => !isUnallocated(s.id)).id, { force: true });
    delete wzMem.obj;
    wzResume("obj");
    ok(wizOn() && wizd.server === owner.id, "служба: сервер черновика на месте при выделении в другом домене");
    closeWizard();
  }
  // Из другого раздела черновик ведёт в «Оборудование»
  goApp("acc");
  delete wzMem.obj;
  wzResume("obj");
  ok(app === "hw" && wizOn(), "служба: продолжение открывает «Оборудование»");
  closeWizard();
  wzDrop("obj");
  pick(owner.id, { force: true });

  // Правило: два шага
  goApp("rules");
  ruleNewOpen();
  ok(document.querySelectorAll("#bmBody .dc-st").length === 2, "правило: два шага");
  ruleNewGo(1);
  ok(rnw.step === 1, "правило: второй шаг");
  wzClose("rule");
  ok(!document.getElementById("bmodal").classList.contains("open"), "правило: крестик закрывает окно");
  wzDrop("rule");
});
