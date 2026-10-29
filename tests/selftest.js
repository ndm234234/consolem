/* Самопроверка основного макета: index.html?selftest (и прототипов, скопированных с него).
   Прототип сам проходит основные действия через API — те же сценарии tests/ui-*.js, что гоняет
   tools/check_ui.py. Каждый сценарий — в своей невидимой копии страницы (?selftest-run=<файл>) со своим
   встроенным сервером на эталонном наборе, все параллельно; итог приходит сообщением. Отчёт — панель
   поверх страницы, итог — data-selftest="pass|fail" у <html>. С ?latency=300 сценарии идут с задержкой
   ответа. Отсчёты удаления настоящие, поэтому прогон занимает около минуты.
   С ?api=<стенд> — против тестового стенда бэкенда: сценарии идут по одному, перед каждым — POST /test/reset
   с идущими часами (данные у стенда одни на всех). С ?report=<адрес> итог уходит туда POST-запросом. */
(() => {
  const q = new URLSearchParams(location.search);
  const SCENARIOS = ["ui-hardware.js", "ui-domains.js", "ui-storage.js", "ui-devices.js", "ui-bulk.js", "ui-rule-links.js", "ui-rules.js", "ui-settings.js", "ui-access.js", "ui-profile.js"];
  // Сценарии не на эталонном наборе: страница сценария открывается с ?fixture=, стенд сбрасывается на него.
  // Отсюда же берёт наборы tools/check_ui.py
  const FIXTURE_OF = { "ui-profile.js": "one-domain" };
  const load = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`${src} не загрузился`));
      document.body.appendChild(s);
    });

  // Страница одного сценария: помощники, затем сценарий; итог уходит родителю (tests/ui-harness.js)
  const one = q.get("selftest-run");
  if (one) {
    window.UI_CHECK_NAME = one;
    load("tests/ui-harness.js")
      .then(() => load(`tests/${one}`))
      .catch((e) => window.parent.postMessage({ uiCheck: true, name: one, log: [`FAIL  ${e.message}`] }, "*"));
    return;
  }

  const results = {};
  const started = Date.now();
  const panel = document.createElement("div");
  panel.id = "selftest";
  panel.style.cssText =
    "position:fixed;right:16px;top:16px;z-index:100;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;" +
    "background:var(--one-popup);color:var(--one-text,inherit);border:1px solid var(--one-border);border-radius:8px;padding:12px 16px;" +
    "font:12px/1.5 ui-monospace,monospace;box-shadow:0 8px 24px rgba(0,0,0,.25)";
  document.body.appendChild(panel);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  // «Копировать» — отчёт текстом целиком, со всеми строками сценариев: переслать тому, кто разбирается
  let lastDone = false;
  let copiedAt = 0;
  function reportText() {
    const lines = [panel.querySelector("b").textContent, location.href, new Date().toISOString(), ""];
    SCENARIOS.forEach((n) => {
      const log = results[n];
      if (!log) return lines.push(`… ${n}`);
      const fails = log.filter((l) => !l.startsWith("PASS"));
      lines.push(`${fails.length ? "✗" : "✓"} ${n}: ${log.length - fails.length} из ${log.length}`, ...log.map((l) => `   ${l}`));
    });
    return lines.join("\n");
  }
  function copyReport() {
    const text = reportText();
    const done = () => {
      copiedAt = Date.now();
      render(lastDone);
      setTimeout(() => render(lastDone), 1600);
    };
    // С диска и без разрешения буфера navigator.clipboard может отказать — тогда через выделение
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  panel.addEventListener("click", (e) => e.target.closest("#selftestCopy") && copyReport());
  function render(done) {
    lastDone = done;
    const all = Object.values(results).flat();
    const bad = all.filter((l) => !l.startsWith("PASS")).length;
    const head = done
      ? `${bad ? "Самопроверка: не прошло" : "Самопроверка: всё прошло"} — ${all.length - bad} из ${all.length}, ${Math.round((Date.now() - started) / 1000)} с`
      : `Самопроверка идёт: сценариев ${Object.keys(results).length} из ${SCENARIOS.length}…`;
    const copied = Date.now() - copiedAt < 1500;
    panel.innerHTML =
      `<b style="display:block;padding-right:110px;font:600 14px/1.4 system-ui,sans-serif">${esc(head)}</b>` +
      `<button type="button" class="btn s" id="selftestCopy" style="position:absolute;top:10px;right:12px" title="Отчёт текстом — со всеми строками сценариев">${copied ? "Скопировано" : "Копировать"}</button>` +
      SCENARIOS.map((n) => {
        const log = results[n];
        if (!log) return `<div style="margin-top:8px">… ${esc(n)}</div>`;
        const fails = log.filter((l) => !l.startsWith("PASS"));
        return `<details style="margin-top:8px" ${fails.length ? "open" : ""}><summary>${fails.length ? "✗" : "✓"} ${esc(n)}: ${log.length - fails.length} из ${log.length}</summary>` +
          `<pre style="white-space:pre-wrap;margin:4px 0 0">${esc((fails.length ? fails : log).join("\n"))}</pre></details>`;
      }).join("");
    if (done) {
      document.documentElement.dataset.selftest = bad ? "fail" : "pass";
      console.log(`SELFTEST ${bad ? "fail" : "pass"} ${all.length - bad}/${all.length}`);
      const to = q.get("report");
      if (to) fetch(to, { method: "POST", body: all.concat(head, `RESULT ${bad ? "fail" : "pass"}`).join("\n") }).catch(() => {});
    }
  }
  const waiting = {};
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !d.uiCheck || !SCENARIOS.includes(d.name)) return;
    results[d.name] = d.log;
    render(Object.keys(results).length === SCENARIOS.length);
    if (waiting[d.name]) waiting[d.name]();
  });
  const base = location.href.split("?")[0].split("#")[0];
  const stand = q.get("api");
  const extra = (q.get("latency") ? `&latency=${encodeURIComponent(q.get("latency"))}` : "") + (stand ? `&api=${encodeURIComponent(stand)}` : "");
  const frame = (name) => {
    const f = document.createElement("iframe");
    f.src = `${base}?selftest-run=${name}${extra}${FIXTURE_OF[name] ? `&fixture=${FIXTURE_OF[name]}` : ""}`;
    f.title = `Самопроверка: ${name}`;
    f.style.cssText = "position:absolute;left:-20000px;top:0;width:1600px;height:1000px;border:0";
    document.body.appendChild(f);
    return new Promise((resolve) => (waiting[name] = () => (f.remove(), resolve())));
  };
  render(false);
  if (!stand) SCENARIOS.forEach(frame);
  else
    SCENARIOS.reduce(
      (p, name) =>
        p
          .then(() => API.raw("POST", "/test/reset", { fixture: FIXTURE_OF[name] || "demo", freezeClock: false }))
          .then((r) => {
            if (r.status !== 200) throw new Error(`POST /test/reset → ${r.status}: у стенда нет служебных операций`);
            return frame(name);
          }),
      Promise.resolve()
    ).catch((e) => {
      SCENARIOS.filter((n) => !results[n]).forEach((n) => (results[n] = [`FAIL  ${e.message}`]));
      render(true);
    });
})();
