/* Туры PTZ камеры (пробел F40): свойство tours профиля vms.ptz/1 1.3. Список туров приходит с сервера; «Добавить в план»
   в редакторе и удаление тура идут черновиком карточки — одна строка плана «Туры PTZ» («было → станет» словами, не заглушка);
   «Сбросить» возвращает туры сервера, «Применить» пишет список на сервер (id, имя, точки, запуск без оператора).
   Пуск тура остаётся симуляцией страницы: в контракте нет пуска (ждёт API видео).
   На странице без свойства tours у вида камеры сценарий ничего не проверяет.
   Запуск: python3 tools/check_ui.py tests/ui-ptz-tury.js */
UiCheck(async ({ ok, until }) => {
  if (typeof cvToursOn !== "function") { ok(true, "туров через API на странице нет: прототип скопирован с index.html до пробела F40"); return; }
  const CAM = "30000013-0000-4000-8000-000000000000"; // «1. Главный вход», PTZ, пресеты 1 и 2, тур «Обход входа»
  const main = () => document.getElementById("main");
  const btnIn = (el, t) => [...(el || document).querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(t));
  const xp = () => find(CAM).n.xprops || {};
  const rows = () => [...main().querySelectorAll("[data-tour]")];
  // «Назад» плана — последняя кнопка «Назад» на странице: окно плана поверх карточки
  const planBack = async () => { [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Назад").pop().click(); await until(() => !/План: «/.test(document.body.innerText)); };
  const planText = async () => {
    ok(await until(() => btnIn(document, "Показать план")), "подвал карточки: «Показать план»");
    btnIn(document, "Показать план").click();
    await until(() => /План: «/.test(document.body.innerText));
    return document.body.innerText;
  };
  const toTours = async () => {
    await until(() => main().querySelector('[data-cv-tab="tours"]'));
    main().querySelector('[data-cv-tab="tours"]').click();
    return until(() => main().querySelector("[data-tour]") || main().querySelector(".cv-trl, .cv-pl-empty"));
  };

  goApp("hw");
  await hwEnsure([CAM]);
  openNode(CAM, { app: "hw", tab: "ptz" });
  ok(await until(() => cvToursOn(find(CAM).n)), "вид камеры объявил tours (профиль vms.ptz/1 1.3)");
  await toTours();
  ok(rows().length === 1 && /Обход входа/.test(rows()[0].textContent) && /2 точки/.test(rows()[0].textContent), "тур с сервера: «Обход входа», 2 точки");

  // Редактор: имя и время в точке; «Добавить в план» — черновик карточки, не сервер
  rows()[0].querySelector(".cv-tr-name").click();
  ok(await until(() => main().querySelector("[data-cv-te]")), "редактор тура открылся");
  const name = main().querySelector("[data-tour-name]");
  name.value = "Обход двора"; name.dispatchEvent(new Event("input", { bubbles: true }));
  const dwell = main().querySelector('[data-tstep="1"] input[type="number"]');
  dwell.value = "20"; dwell.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => main().querySelector('[data-tstep="1"] input[type="number"]')?.value === "20");
  btnIn(main().querySelector(".cv-te-f"), "Добавить в план").click();
  ok(await until(() => Array.isArray(xp().tours)), "тур ушёл в черновик карточки (xprops.tours)");
  const w = xp().tours[0];
  ok(w.id === "t1" && w.name === "Обход двора" && w.steps[1].dwellSec === 20 && w.steps[1].preset === 2 && w.onManual === "pause", "черновик в полях контракта: id, name, steps[].preset и dwellSec, onManual");
  ok((unitProps.get(CAM).tours || [])[0]?.name === "Обход входа", "сервер не изменился до «Применить»");

  // Новый тур: второй строкой того же черновика
  await toTours();
  btnIn(main().querySelector(".cv-pre-add"), "Тур").click();
  ok(await until(() => main().querySelector("[data-cv-te]")), "новый тур: редактор");
  btnIn(main().querySelector(".cv-te-f"), "Добавить в план").click();
  ok(await until(() => xp().tours?.length === 2), "новый тур в черновике");

  const t = await planText();
  ok(/Туры PTZ\s+1 тур\s+изменит «Обход входа» → «Обход двора»; добавит «Тур 2»/.test(t), "одна строка «Туры PTZ»: 1 тур → изменит и добавит");
  ok(!/Заглушка: [^\n]*[Тт]ур/.test(t), "строка туров — не заглушка");
  await planBack();

  // «Сбросить»: черновик пуст, список — как на сервере
  btnIn(document, "Сбросить").click();
  ok(await until(() => !("tours" in xp()) && rows().length === 1 && /Обход входа/.test(rows()[0].textContent)), "«Сбросить» возвращает туры сервера");

  // «Применить»: список на сервере
  rows()[0].querySelector(".cv-tr-name").click();
  await until(() => main().querySelector("[data-cv-te]"));
  const n2 = main().querySelector("[data-tour-name]");
  n2.value = "Обход двора"; n2.dispatchEvent(new Event("input", { bubbles: true }));
  btnIn(main().querySelector(".cv-te-f"), "Добавить в план").click();
  await until(() => Array.isArray(xp().tours));
  await planText();
  [...document.querySelectorAll("button")].find((b) => /^Применить \(\d+\)/.test(b.textContent.trim())).click();
  ok(await until(() => unitProps.get(CAM)?.tours?.[0]?.name === "Обход двора" && !("tours" in xp())), "«Применить»: тур пришёл с сервера, черновик пуст");
  const srv = await API.get(`/units/${CAM}`);
  ok(srv.properties.tours.length === 1 && srv.properties.tours[0].id === "t1" && srv.properties.tours[0].name === "Обход двора", "тур на сервере");

  // Сохранение без правки: строки плана нет
  const openT1 = async () => { await toTours(); rows()[0].querySelector(".cv-tr-name").click(); return until(() => main().querySelector("[data-cv-te]")); };
  await openT1();
  btnIn(main().querySelector(".cv-te-f"), "Добавить в план").click();
  ok(await until(() => !main().querySelector("[data-cv-te]")) && !("tours" in xp()), "сохранение без правки — черновика нет");

  // Время в точке выше предела схемы (3600) — консоль ставит предел, а не шлёт то, что сервер отклонит
  await openT1();
  const d2 = main().querySelector('[data-tstep="0"] input[type="number"]');
  d2.value = "5000"; d2.dispatchEvent(new Event("change", { bubbles: true }));
  ok(await until(() => main().querySelector('[data-tstep="0"] input[type="number"]')?.value === "3600"), "время в точке — не больше 3600 с (схема)");

  // Запуск без оператора: idleStartSec у тура
  const idle = main().querySelector('[data-cv-fk="te-idle"]');
  idle.checked = true; idle.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => cvTourEdit?.idle);
  btnIn(main().querySelector(".cv-te-f"), "Добавить в план").click();
  ok(await until(() => xp().tours?.[0]?.idleStartSec === 120 && xp().tours[0].steps[0].dwellSec === 3600), "черновик: idleStartSec 120, dwellSec 3600");
  const t2 = await planText();
  ok(/сам, когда камерой не управляют: «Обход двора», через 2 мин/.test(t2), "строка плана называет запуск без оператора");
  await planBack();
  btnIn(document, "Сбросить").click();
  await until(() => !("tours" in xp()));

  // Удаление: подтверждение числом, отсчёт, черновик — пустой список, строка «удалит»
  await toTours();
  rows()[0].querySelector('[aria-label^="Удалить тур"]').click();
  ok(await until(() => document.getElementById("confirmCountInp")), "удаление тура спрашивает число");
  const cnt = document.getElementById("confirmCountInp");
  cnt.value = "1"; cnt.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => !document.getElementById("confirmOk").disabled);
  document.getElementById("confirmOk").click();
  ok(await until(() => Array.isArray(xp().tours) && xp().tours.length === 0, 15000), "после отсчёта черновик — пустой список туров");
  const t3 = await planText();
  ok(/Туры PTZ\s+1 тур\s+удалит «Обход двора»/.test(t3), "строка плана: удалит «Обход двора»");
  await planBack();
  btnIn(document, "Сбросить").click();
  ok(await until(() => !("tours" in xp()) && rows().length === 1), "«Сбросить» возвращает удалённый тур");
});
