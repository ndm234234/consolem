/* Пресет PTZ: записано ли положение и какое, диафрагма (пробел F39, профиль vms.ptz/1 1.2, контракт 0.37.0). На вкладке «PTZ»
   камеры «1. Главный вход»: у пресета с положением подсказка номера называет поворот, наклон и зум; у пресета только с именем
   (savedOnDevice: false) рамка номера пунктиром и подсказка говорит, что положения нет; «Записать положение» пишет его без
   вопроса, и метка уходит. Кнопки «Диафрагма» шлют аренду с полем iris. На странице без вкладки «PTZ» сценарий ничего не
   проверяет. Запуск: python3 tools/check_ui.py tests/ui-ptz-preset-pos.js */
UiCheck(async ({ ok, until }) => {
  if (typeof presetTip !== "function") { ok(true, "положения пресета на странице нет: прототип скопирован с index.html до F39"); return; }
  const CAM = "30000013-0000-4000-8000-000000000000";
  const main = () => document.getElementById("main");
  const pn = (no) => main().querySelector(`[data-cv-pl] [data-preset="${no}"] .cv-pn`);
  goApp("hw");
  await hwEnsure([CAM]);
  openNode(CAM, { app: "hw", tab: "ptz" });
  ok(await until(() => pn(1)), "«PTZ»: список пресетов");
  ok(/Положение: поворот по горизонтали 0, наклон -0,1, зум 0,2\. Положение записано в камере/.test(pn(1).dataset.tip), "подсказка номера: положение и «записано в камере» — " + pn(1).dataset.tip);
  ok(!pn(1).hasAttribute("data-preset-nopos"), "у пресета с положением рамка сплошная");
  ok(pn(3).hasAttribute("data-preset-nopos") && getComputedStyle(pn(3)).borderStyle === "dashed", "пресет только с именем: рамка пунктиром");
  ok(/только имя/.test(pn(3).dataset.tip), "подсказка: положения нет");
  // Перейти в пресет без положения: камера не поворачивается, тост называет причину
  pn(3).click();
  ok(await until(() => /нет положения/.test(document.body.innerText)), "переход в пресет без положения: тост «нет положения»");
  ok(!main().querySelector('[data-cv-pl] [data-preset="3"]').classList.contains("on"), "пресет без положения не стал текущим");
  // Записать положение: вопроса нет — прежнего положения нет
  main().querySelector('[data-cv-pl] [data-preset="3"] [data-preset-save]').click();
  ok(!document.querySelector(".mask:not([hidden]) .bk-del"), "вопроса «Записать новое положение?» нет");
  ok(await until(() => pn(3) && !pn(3).hasAttribute("data-preset-nopos")), "после записи рамка сплошная");
  const srv = await API.get(`/units/${CAM}`);
  const p3 = srv.properties.presets.find((x) => x.n === 3);
  ok(p3.savedOnDevice === true && typeof p3.pan === "number", "на сервере: savedOnDevice и положение");
  // Диафрагма: аренда с iris
  const sent = [], put = API.put;
  API.put = (p, b, ...r) => { sent.push([p, b]); return put(p, b, ...r); };
  try {
    const b = main().querySelector('[data-cv-iris] [data-cv-hold="iris+"]');
    ok(!!b, "кнопки «Диафрагма»");
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    ok(await until(() => sent.some(([p, x]) => p.endsWith("/ptz") && x.iris > 0)), "аренда с iris > 0");
    ok(/открываю диафрагму/.test(main().querySelector("[data-cv-say]").textContent), "строка движения: «открываю диафрагму»");
    window.dispatchEvent(new MouseEvent("mouseup"));
  } finally { API.put = put; }
});
