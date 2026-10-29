/* Помощники сценариев интерфейса (tests/ui-*.js): ok, until, sleep, confirmWith и UiCheck(fn).
   Сценарий выполняется на загруженной странице прототипа после старта (appReady). Итог — строки PASS/FAIL:
   tools/check_ui.py читает их из <script id="__ui">, самопроверка прототипа (?selftest) получает их
   сообщением от страницы-сценария. */
(() => {
  const log = [];
  const ok = (c, m) => log.push((c ? "PASS  " : "FAIL  ") + m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Ждать условия: ответ сервера и событие потока приходят не сразу
  async function until(fn, ms = 20000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try {
        if (fn()) return true;
      } catch (e) {}
      await sleep(25);
    }
    return false;
  }
  // Подтвердить диалог: ввести число удаляемых объектов (если спрашивают) и нажать кнопку
  async function confirmWith(n) {
    const inp = document.getElementById("confirmCountInp");
    if (inp && n != null) {
      inp.value = String(n);
      inp.dispatchEvent(new Event("input"));
    }
    document.getElementById("confirmOk").click();
  }
  function report() {
    const el = document.createElement("script");
    el.type = "text/plain";
    el.id = "__ui";
    el.textContent = JSON.stringify(log).replace(/</g, "\\u003c");
    document.body.appendChild(el);
    if (window.parent !== window) window.parent.postMessage({ uiCheck: true, name: window.UI_CHECK_NAME || "", log }, "*");
  }
  window.UiCheck = (fn) =>
    window.appReady
      .then(() => fn({ ok, until, sleep, confirmWith }))
      .catch((e) => ok(false, "исключение: " + e.message + " " + (e.stack || "").split("\n")[1]))
      .then(report);
})();
