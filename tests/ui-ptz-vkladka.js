/* Вкладка «PTZ» камеры (пробел F38 против Axxon One, из прототипа 97): управление, пресеты и «Патрулирование и предустановки»
   на своей вкладке, на «Видео» — только ссылка. Блок «Поворотное устройство» — свойства профиля vms.ptz/1 1.1 (ptzEnabled,
   ptzSource, ptzPort, ptzProtocol, ptzAddress): правка идёт черновиком карточки, план показывает «было → станет»,
   «Отменить» и «Сбросить» возвращают значения, «Применить» пишет их на сервер. Блок параметров PTZ драйвера правится без
   «Отправлять настройки устройству» (полей x-dev в нём нет). На странице без вкладки «PTZ» сценарий ничего не проверяет.
   Запуск: python3 tools/check_ui.py tests/ui-ptz-vkladka.js */
UiCheck(async ({ ok, until }) => {
  if (typeof camPtzHtml !== "function") { ok(true, "вкладки «PTZ» на странице нет: прототип скопирован с index.html до переноса"); return; }
  const CAM = "30000013-0000-4000-8000-000000000000"; // «1. Главный вход», PTZ
  const main = () => document.getElementById("main");
  const card = () => main().querySelector('[data-sec="ptzdev"]');
  const btnIn = (el, t) => [...(el || document).querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(t));
  const drvCard = () => [...main().querySelectorAll(".card")].find((c) => c.querySelector(".ch")?.textContent.includes("Патрулирование и предустановки"));
  const xp = () => find(CAM).n.xprops || {};
  const edit = async () => { btnIn(card(), "Изменить").click(); return until(() => card()?.querySelector('[role="switch"]')); };
  const toPort = async () => {
    const r = card().querySelector('input[value="port"]');
    r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true }));
    ok(await until(() => card().querySelector("select")), "«Порт другого устройства» открывает порт, протокол и адрес");
    const sel = card().querySelector("select"), opt = [...sel.options].find((o) => /COM1/.test(o.text));
    sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.text;
  };
  const planText = async () => {
    btnIn(document, "Показать план").click();
    await until(() => /План: «/.test(document.body.innerText));
    return document.body.innerText;
  };

  goApp("hw");
  await hwEnsure([CAM]);
  openNode(CAM, { app: "hw", tab: "vid" });
  ok(await until(() => main().querySelector(".ptz-to")), "«Видео»: ссылка «Открыть вкладку «PTZ»»");
  ok(!main().querySelector("[data-preset]"), "«Видео»: пресетов нет");

  openNode(CAM, { app: "hw", tab: "ptz" });
  ok(await until(() => card()), "«PTZ»: блок «Поворотное устройство»");
  ok(!!main().querySelector("[data-preset]"), "«PTZ»: пресеты");
  ok(!!drvCard(), "«PTZ»: блок «Патрулирование и предустановки»");
  ok(/включено/.test(card().textContent) && /Сама камера \(ONVIF\)/.test(card().textContent), "просмотр: включено, телеметрия — сама камера");

  // Параметры PTZ драйвера: замка нет, поля доступны в режиме "device"
  ok((unitProps.get(CAM).streamsMode || "device") === "device", "камера в режиме «Использовать настройки устройства»");
  btnIn(drvCard(), "Изменить").click();
  ok(await until(() => drvCard()?.querySelector("input, select, [role=switch]")), "«Патрулирование и предустановки» открылся на правку");
  ok(!drvCard().querySelector("input:disabled, select:disabled, [aria-disabled=true]"), "поля блока доступны без «Отправлять настройки устройству»");
  btnIn(drvCard(), "Отменить").click();

  // «Отменить» в блоке: черновик — как до «Изменить»
  await edit();
  card().querySelector('[role="switch"]').click();
  ok(await until(() => xp().ptzEnabled === false), "выключатель пишет ptzEnabled: false в черновик");
  btnIn(card(), "Отменить").click();
  ok(await until(() => !("ptzEnabled" in xp())), "«Отменить» убирает правку из черновика");

  // План: строка на свойство, «было → станет» словами
  await edit();
  card().querySelector('[role="switch"]').click();
  await until(() => xp().ptzEnabled === false);
  const portText = await toPort();
  ok(await until(() => xp().ptzPort?.port === "COM1" && xp().ptzProtocol === "Pelco-D"), "порт — {unitId, port}, протокол идёт вместе с портом");
  ok(!("ptzAddress" in xp()), "адрес 1 — умолчание, в черновик не идёт");
  btnIn(card(), "Добавить в план").click();
  const t = await planText();
  ok(/Поворотное устройство: Включить PTZ\s+включён\s+выключен/.test(t), "строка «Включить PTZ: включён → выключен»");
  ok(/Поворотное устройство: Телеметрия\s+Сама камера \(ONVIF\)\s+Порт другого устройства/.test(t), "строка «Телеметрия»");
  ok(t.includes(portText) && /не выбран/.test(t), "строка «Порт»: не выбран → " + portText);
  ok(!/Заглушка: [^\n]*PTZ/.test(t), "строки PTZ — не заглушка");
  btnIn(document, "Назад").click();

  // «Сбросить»: черновик пуст, блок — как на сервере
  btnIn(document, "Сбросить").click();
  ok(await until(() => !PTZ_PROPS.some((f) => f in xp()) && /включено/.test(card()?.textContent || "")), "«Сбросить» возвращает значения");

  // «Применить»: значения на сервере, управление скрыто, слова о выключенном PTZ
  await edit();
  card().querySelector('[role="switch"]').click();
  await until(() => xp().ptzEnabled === false);
  await toPort();
  btnIn(card(), "Добавить в план").click();
  await planText();
  [...document.querySelectorAll("button")].find((b) => /^Применить \(\d+\)/.test(b.textContent.trim())).click();
  ok(await until(() => unitProps.get(CAM)?.ptzEnabled === false && unitProps.get(CAM)?.ptzSource === "port"), "«Применить»: значения пришли с сервера");
  let srv = null;
  // Операция пишет строки плана шагами по одному: ждать последний шаг
  for (let i = 0; i < 40 && srv?.properties?.ptzProtocol !== "Pelco-D"; i++) { srv = await API.get(`/units/${CAM}`); if (srv.properties.ptzProtocol !== "Pelco-D") await new Promise((r) => setTimeout(r, 100)); }
  ok(srv.properties.ptzSource === "port" && srv.properties.ptzPort?.port === "COM1" && srv.properties.ptzProtocol === "Pelco-D", "телеметрия на сервере");
  ok(await until(() => main().querySelector(".ptz-off") && !main().querySelector("[data-preset]")), "PTZ выключен: управления нет, слова почему");
});
