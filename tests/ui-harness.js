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
  // Разметка без кода в атрибутах: консоль VMS отдаёт страницу под CSP «script-src 'self'», где onclick="…"
  // не выполняется (index.html, onEv). Всё, что появилось за сценарий: ни одного on…, у data-on-… — JSON
  // со списком вызовов существующих функций. Строка в отчёте — только если что-то не так
  const cspBad = new Set();
  function cspCheck(el) {
    if (el.nodeType !== 1) return;
    for (const a of el.attributes) {
      if (/^on/.test(a.name)) cspBad.add(`<${el.tagName.toLowerCase()} ${a.name}>`);
      else if (a.name.startsWith("data-on-"))
        try {
          JSON.parse(a.value).forEach(([n]) => n[0] !== "." && typeof window[n] !== "function" && cspBad.add(`${a.name}: нет функции ${n}`));
        } catch (e) {
          cspBad.add(`${a.name}: не JSON`);
        }
    }
  }
  const cspScan = (root) => {
    cspCheck(root);
    if (root.querySelectorAll) root.querySelectorAll("*").forEach(cspCheck);
  };
  new MutationObserver((list) =>
    list.forEach((m) => (m.type === "attributes" ? cspCheck(m.target) : m.addedNodes.forEach(cspScan)))
  ).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  function report() {
    cspScan(document.documentElement);
    if (cspBad.size) ok(false, "разметка без кода в атрибутах: " + [...cspBad].slice(0, 6).join("; "));
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
