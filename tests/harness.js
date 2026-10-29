/* Стенд тестов API: окружение, проверки, запуск и отчёт.
   Тесты говорят с сервером только запросами из api/openapi.json — как интерфейс и бэкенд. Каждый тест
   начинает с POST /test/reset (эталонный набор api/fixtures/demo.json, часы остановлены), время сдвигает
   POST /test/clock. Поэтому один и тот же набор проходит:
   - встроенный сервер прототипа (по умолчанию: tests/api.html);
   - тестовый стенд бэкенда: tests/api.html?api=https://адрес — нужны служебные операции /test/… и CORS;
   - петля: tests/api.html?api=loopback со страницы по http — тот же встроенный сервер, но за сетевым
     клиентом: fetch, заголовки, поток SSE (tests/loopback-sw.js).
   Ответы сверяются со схемами контракта, покрытие — по операциям контракта.
   Отчёт: <pre id="apitest-log">, итог — data-apitest="pass|fail" у <html>. */
(() => {
  const tests = [];
  const params = new URLSearchParams(location.search);
  const apiBase = params.get("api");
  const spec = window.CONSOLEM_OPENAPI;
  const FX = window.CONSOLEM_FIXTURE;

  let api = null;
  async function connect() {
    if (apiBase === "loopback") {
      if (location.protocol === "file:" || !("serviceWorker" in navigator)) {
        throw new Error("петля работает только со страницы по http(s): python3 tools/check_loopback.py");
      }
      await navigator.serviceWorker.register("loopback-sw.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
      }
      return ConsolemApi.create({ baseUrl: new URL("loopback-api", location.href).href });
    }
    if (apiBase) return ConsolemApi.create({ baseUrl: apiBase });
    return ConsolemApi.create({ server: ConsolemServer.create({ fixture: FX, openapi: spec, autoTick: false, testSupport: true }) });
  }

  // Каждый ответ запоминается вместе с операцией контракта — для сверки схем и покрытия
  const recorded = [];
  async function raw(method, path, body, headers) {
    const res = await api.raw(method, path, body, headers);
    const found = ConsolemContract.operationOf(spec, method, path);
    // 404 на адрес, которого нет в контракте, — правильный ответ, сверять нечего
    if (found || res.status !== 404) {
      recorded.push({ method, template: found ? found.template : path.split("?")[0], status: res.status, body: res.body, headers: res.headers || {}, kind: "http" });
    }
    return res;
  }

  class Failure extends Error {}
  const fmt = (v) => JSON.stringify(v);
  const assert = {
    ok(cond, msg) {
      if (!cond) throw new Failure(msg || "условие не выполнено");
    },
    eq(actual, expected, msg) {
      if (fmt(actual) !== fmt(expected)) throw new Failure(`${msg || "значение"}: ${fmt(actual)} вместо ${fmt(expected)}`);
    },
    status(res, status, code, msg) {
      const got = `${res.status}${res.body && res.body.code ? " " + res.body.code : ""}`;
      const want = `${status}${code ? " " + code : ""}`;
      if (res.status !== status || (code && (!res.body || res.body.code !== code))) {
        throw new Failure(`${msg || "ответ"}: ${got} вместо ${want}${res.body && res.body.message ? ` — ${res.body.message}` : ""}`);
      }
    },
  };

  // Окружение теста: стенд сброшен, часы стоят. fixturePatch — изменения набора на этот тест
  async function makeEnv(opts) {
    const reset = await raw("POST", "/test/reset", { fixture: "demo", fixturePatch: (opts && opts.fixturePatch) || undefined, actAs: (opts && opts.actAs) || undefined });
    if (reset.status !== 200) throw new Error(`Тестовый стенд не сбросился: POST /test/reset → ${reset.status}`);
    const env = {
      now: Date.parse(reset.body.now),
      call: (method, path, body, headers) => raw(method, path, body, headers),
      async ok(method, path, body, headers) {
        const res = await raw(method, path, body, headers);
        if (res.status >= 400) throw new Failure(`${method} ${path} → ${res.status} ${res.body && res.body.code} ${res.body && res.body.message}`);
        return res.body;
      },
      list: async (path) => (await env.ok("GET", path)).items,
      // Версия записи для If-Match — из ETag свежего чтения, как у клиента, который только что её открыл
      async etag(path) {
        const res = await raw("GET", path);
        if (res.status !== 200) throw new Failure(`GET ${path} → ${res.status}`);
        if (!res.headers.etag) throw new Failure(`GET ${path}: нет заголовка ETag`);
        return res.headers.etag;
      },
      // Время идёт вперёд, сервер выполняет всё, что за это время должно было сработать
      async advance(sec) {
        const res = await raw("POST", "/test/clock", { advanceSec: sec });
        if (res.status !== 200) throw new Failure(`POST /test/clock → ${res.status}`);
        env.now = Date.parse(res.body.now);
        return res.body.fired;
      },
      // Операция до конца: запустить, сдвигать часы, пока не завершится
      async runOperation(body) {
        const res = await raw("POST", "/operations", body);
        assert.status(res, 202, null, "POST /operations");
        for (let i = 0; i < 100; i++) {
          const op = await env.ok("GET", `/operations/${res.body.id}`);
          if (op.state === "done") return op;
          await env.advance(1);
        }
        throw new Failure("операция не завершилась за 100 с");
      },
    };
    return env;
  }

  let keySeq = 0;
  const key = () => `test-${Date.now().toString(36)}-${++keySeq}`;

  function test(name, fn) {
    tests.push({ name, fn });
  }

  // Операции контракта, которые тесты не обязаны вызывать (пусто — покрыто всё)
  const NOT_COVERED = [];

  function finish(lines, summary, failed) {
    const reportTo = params.get("report");
    if (reportTo) fetch(reportTo, { method: "POST", body: lines.concat(summary, `RESULT ${failed ? "fail" : "pass"}`).join("\n") }).catch(() => {});
    document.documentElement.dataset.apitest = failed ? "fail" : "pass";
    lines.forEach((l) => console.log(`APITEST ${l}`));
    console.log(`APITEST ${summary}`);
    document.getElementById("apitest-summary").textContent = summary;
    document.getElementById("apitest-log").textContent = lines.join("\n");
  }

  const declared = new Set();
  const loaded = (name) => declared.add(name);

  async function run() {
    const lines = [`INFO  Сервер: ${apiBase === "loopback" ? "петля: встроенный сервер по сети" : apiBase || "встроенный сервер прототипа"}`];
    let failed = 0;
    try {
      api = await connect();
    } catch (err) {
      lines.push(`FAIL  Тестовый стенд доступен — ${err.message}`);
      return finish(lines, "Тесты API не запущены: стенд недоступен", true);
    }
    api.subscribe((message) => recorded.push({ method: "GET", template: "/stream", status: 200, body: message, kind: "stream" }));
    const probe = await api.raw("POST", "/test/reset", { fixture: "demo" }).catch((err) => ({ status: 0, error: err }));
    if (probe.status !== 200) {
      const why =
        probe.status === 0
          ? "сервер не ответил: нет сети, неверный адрес или бэкенд не разрешает запросы со страницы (CORS)"
          : `POST /test/reset → ${probe.status}: на сервере нет служебных операций тестового стенда`;
      lines.push(`FAIL  Тестовый стенд доступен — ${why}`);
      return finish(lines, "Тесты API не запущены: стенд недоступен", true);
    }
    // Файлы тестов загрузились целиком: каждый в конце объявляет себя (loaded)
    const files = [...document.scripts].map((x) => (x.getAttribute("src") || "").split("/").pop()).filter((n) => /^api-.+\.js$/.test(n));
    const broken = files.filter((n) => !declared.has(n)).map((n) => `${n} не загрузился целиком`).concat(window.API_LOAD_ERRORS || []);
    if (broken.length) {
      failed += 1;
      lines.push(`FAIL  Файлы тестов загрузились — ${broken.join("; ")}`);
    } else lines.push(`PASS  Файлы тестов загрузились — ${files.length}`);
    const only = params.get("only");
    for (const t of tests) {
      if (only && t.name !== only) continue;
      try {
        const note = await t.fn();
        lines.push(`PASS  ${t.name}${note ? ` — ${note}` : ""}`);
      } catch (err) {
        failed += 1;
        lines.push(`FAIL  ${t.name} — ${err instanceof Failure ? err.message : err && err.stack ? err.stack.split("\n").slice(0, 2).join(" ") : JSON.stringify(err)}`);
      }
    }
    // Поток: последние сообщения могли ещё не дойти
    await new Promise((resolve) => setTimeout(resolve, 50));
    const problems = ConsolemContract.problems(spec, recorded);
    if (problems.length) {
      failed += 1;
      lines.push(`FAIL  Ответы соответствуют openapi.json — расхождений ${problems.length}: ${problems.slice(0, 12).join("; ")}`);
    } else lines.push(`PASS  Ответы соответствуют openapi.json — ${recorded.length} ответов и сообщений потока`);
    if (only) return finish(lines, failed ? `Тесты API: ${failed} не прошли` : "Тесты API: прошли", failed);
    const called = new Set(recorded.map((r) => `${r.method} ${r.template}`));
    const ops = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((m) => ["get", "post", "put", "patch", "delete"].includes(m))
        .map((m) => `${m.toUpperCase()} ${path}`)
    );
    const uncovered = ops.filter((op) => !called.has(op) && !NOT_COVERED.includes(op));
    if (uncovered.length) {
      failed += 1;
      lines.push(`FAIL  Каждая операция контракта покрыта тестами — без тестов: ${uncovered.join(", ")}`);
    } else lines.push(`PASS  Каждая операция контракта покрыта тестами — ${ops.length - NOT_COVERED.length} операций${NOT_COVERED.length ? `, исключения: ${NOT_COVERED.join(", ")}` : ""}`);
    const total = tests.length + 3;
    finish(lines, failed ? `Тесты API: ${failed} из ${total} не прошли` : `Тесты API: все ${total} прошли`, failed);
  }

  // Сообщения потока для одного теста; возвращает «отписаться»
  const subscribeForTest = (fn) => api.subscribe(fn);

  window.ApiTest = { test, loaded, run, makeEnv, assert, key, subscribeForTest, FX, external: Boolean(apiBase) };
})();
