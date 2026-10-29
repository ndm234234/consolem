/* Сценарий интерфейса: система, которая умеет часть контракта (набор one-domain, ?fixture=one-domain —
   так его запускают tools/check_ui.py и самопроверка, см. FIXTURE_OF в tests/selftest.js). Интерфейс
   прочитал capabilities из GET /reference и не показывает неподдержанное: второй домен, поиск в сети,
   лицензии, тома сверх первого, шифрование, роль и сеть сервера, прочие виды устройств. Поддержанное
   работает как обычно. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until }) => {
  goApp("hw");
  const hidden = (el) => !!el && getComputedStyle(el).display === "none";
  ok(!can("createDomain") && !can("getDiscovery") && !can("listLicenses") && can("patchDevice"), "возможности прочитаны: операций " + CAPS.operations.size);
  ok(domains.length === 1 && licenses.length === 0, "один домен, лицензий не читали");
  ok(Object.keys(WIZ).join() === "video" && WIZ.video.types.map((t) => t[0]).join() === "camera", "мастер добавления — только камеры: " + Object.keys(WIZ).join());
  ok(!sysOpts.some((o) => o.id === "lic"), "в опциях нет «Лицензий»");

  // Меню дерева домена: без «Создать домен», «Удалить домен», «Добавить найденные»
  const d = domains[0];
  openTreeCtx(d, { x: 10, y: 10 });
  const menu = document.getElementById("tctx").textContent;
  closeTreeCtx();
  ok(!/Создать домен|Удалить домен|Добавить найденные/.test(menu) && /Добавить вручную/.test(menu), "меню домена — без неподдержанного, «Добавить вручную» есть");

  // Карточка домена: кнопки «Домен» и «Удалить домен» спрятаны
  pick(d.id);
  goTab("gen");
  ok(hidden(document.querySelector('[data-needs="createDomain"]')) && hidden(document.querySelector('[data-needs="deleteDomain"]')), "в карточке домена кнопки домена спрятаны");

  // Сервер: нет вкладки «Сеть» и поля «Роль»
  const s = servers.find((x) => !isUnallocated(x.id));
  ok(!tabsFor(s).some((t) => t[0] === "net"), "у сервера нет вкладки «Сеть»");
  pick(s.id);
  goTab("gen");
  ok(!document.querySelector('[data-df="Роль"]') && !/>Роль</.test(document.querySelector("main")?.innerHTML || document.body.innerHTML), "в карточке сервера нет роли");

  // Хранилище: без шифрования и без «＋ Том»; в меню тома — без «Удалить том»
  const a = arch.find((x) => x.vols.length);
  pick(a.id);
  goTab("arch");
  ok(hidden(document.querySelector('[data-needs="feature:archiveEncryption"]')), "шифрование спрятано");
  ok(hidden(document.querySelector('[data-needs="createVolume"]')), "кнопка «Том» спрятана");
  openTreeCtx(a.vols[0], { x: 10, y: 10 });
  ok(!/Удалить том/.test(document.getElementById("tctx").textContent), "в меню тома нет «Удалить том»");
  closeTreeCtx();
  openTreeCtx(a, { x: 10, y: 10 });
  ok(!/Добавить том/.test(document.getElementById("tctx").textContent), "в меню хранилища нет «Добавить том»");
  closeTreeCtx();

  // Мастер устройств открывается на «Вручную»: поиска в сети нет; виды — только камера
  pick(d.id);
  lanOpenWizard("manual");
  ok(wizd.deviceTab === "manual", "мастер — на «Вручную»");
  const kinds = [...document.querySelectorAll(".dev-manual select")][0];
  ok(kinds && [...kinds.options].map((o) => o.value).join() === "camera", "вид устройства — только камера: " + (kinds ? [...kinds.options].map((o) => o.value).join() : "нет списка"));
  ok(!/К результатам поиска/.test(document.getElementById("wizFoot")?.textContent || ""), "нет ссылки «К результатам поиска»");
  closeWizard();

  // Поддержанное работает: переименовать камеру — запрос, ответ, кэш
  const camId = (await API.get("/devices")).items.find((x) => x.type === "camera").id;
  const before = (await API.get("/devices/" + camId)).version;
  const res = await API.patch("/devices/" + camId, { name: "Камера — профиль" }, before);
  ok(res.name === "Камера — профиль", "переименование через API");
  ok(await until(() => cam(camId)?.name === "Камера — профиль"), "кэш интерфейса — из события потока");

  // Неподдержанное на сервере — 404 NO_ROUTE, интерфейс этого не вызывает
  const nr = await API.post("/domains", { name: "Второй" }).then(() => null, (e) => e?.problem?.code);
  ok(nr === "NO_ROUTE", "POST /domains — 404 NO_ROUTE: " + nr);
});
