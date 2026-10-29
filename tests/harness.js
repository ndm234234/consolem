/* Стенд тестов API: окружение, проверки, запуск и отчёт.
   Тесты говорят с сервером только запросами из api/openapi.json — как интерфейс и бэкенд. Каждый тест
   начинает с POST /test/reset (набор ?fixture=, по умолчанию эталонный demo; часы остановлены), время
   сдвигает POST /test/clock. С ?clock=real часы идут по-настоящему, /test/clock не вызывается: тест ждёт
   результат, пока он не наступит, а тесты, которым нужны остановленные часы, пропускаются.
   Что система умеет — GET /reference → capabilities: тесты неподдержанного пропускаются (SKIP), покрытие
   считается по объявленным операциям, необъявленные обязаны отвечать 404 NO_ROUTE.
   Поэтому один и тот же набор проходит:
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
  const fixtureName = params.get("fixture") || "demo";
  const FX = (window.CONSOLEM_FIXTURES || {})[fixtureName] || null;
  // Часы стенда: остановлены (по умолчанию) или идут по-настоящему (?clock=real)
  const frozen = params.get("clock") !== "real";
  // Что умеет система — из GET /reference, читается перед тестами
  let CAPS = null;

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
    return ConsolemApi.create({ server: ConsolemServer.create({ fixture: FX, fixtures: window.CONSOLEM_FIXTURES, openapi: spec, autoTick: !frozen, testSupport: true }) });
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const resetBody = (opts) => ({
    fixture: fixtureName,
    fixturePatch: (opts && opts.fixturePatch) || undefined,
    freezeClock: frozen ? undefined : false,
    actAs: (opts && opts.actAs) || undefined,
  });

  // Окружение теста: стенд сброшен, часы стоят (или идут с ?clock=real). fixturePatch — изменения набора на этот тест
  async function makeEnv(opts) {
    const reset = await raw("POST", "/test/reset", resetBody(opts));
    if (reset.status !== 200) throw new Error(`Тестовый стенд не сбросился: POST /test/reset → ${reset.status}`);
    const env = {
      frozen,
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
      // Время идёт вперёд, сервер выполняет всё, что за это время должно было сработать. Только при
      // остановленных часах: тест, который его вызывает, объявляет needs: ["clock"] или проверяет env.frozen
      async advance(sec) {
        if (!frozen) throw new Failure("часы идут по-настоящему: /test/clock не вызывается — тесту нужно needs: [\"clock\"]");
        const res = await raw("POST", "/test/clock", { advanceSec: sec });
        if (res.status !== 200) throw new Failure(`POST /test/clock → ${res.status}`);
        env.now = Date.parse(res.body.now);
        return res.body.fired;
      },
      // Пусть пройдёт время: часы стоят — сдвинуть, идут — подождать
      wait: (sec) => (frozen ? env.advance(sec) : sleep(sec * 1000)),
      // Ждать результата: fn() вернула не пустое — это и есть ответ. Часы стоят — сдвигать по секунде,
      // идут — спрашивать четыре раза в секунду. Не дождались за maxSec — провал с тем, чего ждали
      async until(fn, what, maxSec = 60) {
        for (let waited = 0; ; ) {
          const got = await fn();
          if (got) return got;
          if (waited >= maxSec) throw new Failure(`не дождались за ${maxSec} с: ${what}`);
          if (frozen) {
            await env.advance(1);
            waited += 1;
          } else {
            await sleep(250);
            waited += 0.25;
          }
        }
      },
      // Операция завершилась
      finished: (id, maxSec) =>
        env.until(async () => {
          const op = await env.ok("GET", `/operations/${id}`);
          return op.state === "done" && op;
        }, `операция ${id} завершилась`, maxSec),
      // Операция до конца: запустить и дождаться
      async runOperation(body) {
        const res = await raw("POST", "/operations", body);
        assert.status(res, 202, null, "POST /operations");
        return env.finished(res.body.id, 100);
      },
    };
    return env;
  }

  let keySeq = 0;
  const key = () => `test-${Date.now().toString(36)}-${++keySeq}`;

  // needs — что тесту нужно от системы: operationId, "type:<вид устройства>", "feature:<возможность>",
  // "clock" — остановленные часы. Чего нет — тест пропускается (SKIP) и не считается провалом
  function test(name, fn, opts) {
    tests.push({ name, fn, needs: (opts && opts.needs) || [] });
  }
  function lacks(needs) {
    return needs.filter((n) => {
      if (n === "clock") return !frozen;
      if (n.startsWith("type:")) return !CAPS.deviceTypes.includes(n.slice(5));
      if (n.startsWith("feature:")) return !CAPS.features.includes(n.slice(8));
      return !CAPS.operations.includes(n);
    });
  }
  const can = (need) => !lacks([need]).length;

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
    const lines = [`INFO  Сервер: ${apiBase === "loopback" ? "петля: встроенный сервер по сети" : apiBase || "встроенный сервер прототипа"}; набор ${fixtureName}; часы ${frozen ? "остановлены" : "идут по-настоящему"}`];
    let failed = 0;
    if (!FX) {
      lines.push(`FAIL  Набор ${fixtureName} есть — в api/fixture.js только: ${Object.keys(window.CONSOLEM_FIXTURES || {}).join(", ")}`);
      return finish(lines, "Тесты API не запущены: нет набора", true);
    }
    try {
      api = await connect();
    } catch (err) {
      lines.push(`FAIL  Тестовый стенд доступен — ${err.message}`);
      return finish(lines, "Тесты API не запущены: стенд недоступен", true);
    }
    api.subscribe((message) => recorded.push({ method: "GET", template: "/stream", status: 200, body: message, kind: "stream" }));
    const probe = await api.raw("POST", "/test/reset", resetBody()).catch((err) => ({ status: 0, error: err }));
    if (probe.status !== 200) {
      const why =
        probe.status === 0
          ? "сервер не ответил: нет сети, неверный адрес или бэкенд не разрешает запросы со страницы (CORS)"
          : `POST /test/reset → ${probe.status}${probe.body && probe.body.message ? ` (${probe.body.message})` : ""}: на сервере нет служебных операций тестового стенда, набора ${fixtureName}${frozen ? " или остановки часов (?clock=real)" : ""}`;
      lines.push(`FAIL  Тестовый стенд доступен — ${why}`);
      return finish(lines, "Тесты API не запущены: стенд недоступен", true);
    }
    const ref = await api.raw("GET", "/reference");
    CAPS = ref.status === 200 && ref.body && ref.body.capabilities;
    if (!CAPS) {
      lines.push(`FAIL  Система объявляет возможности — GET /reference → ${ref.status}, нет capabilities`);
      return finish(lines, "Тесты API не запущены: неизвестно, что умеет система", true);
    }
    const undeclared = allOps().filter((op) => !op.test && !CAPS.operations.includes(op.id));
    lines.push(`INFO  Возможности: операций ${CAPS.operations.length}, видов устройств ${CAPS.deviceTypes.length}, необязательных ${CAPS.features.length}${undeclared.length ? `; не поддержаны: ${undeclared.map((o) => o.id).join(", ")}` : ""}`);
    // Файлы тестов загрузились целиком: каждый в конце объявляет себя (loaded)
    const files = [...document.scripts].map((x) => (x.getAttribute("src") || "").split("/").pop()).filter((n) => /^api-.+\.js$/.test(n));
    const broken = files.filter((n) => !declared.has(n)).map((n) => `${n} не загрузился целиком`).concat(window.API_LOAD_ERRORS || []);
    if (broken.length) {
      failed += 1;
      lines.push(`FAIL  Файлы тестов загрузились — ${broken.join("; ")}`);
    } else lines.push(`PASS  Файлы тестов загрузились — ${files.length}`);
    const only = params.get("only");
    let skipped = 0;
    for (const t of tests) {
      if (only && t.name !== only) continue;
      const missing = lacks(t.needs);
      if (missing.length) {
        skipped += 1;
        lines.push(`SKIP  ${t.name} — система не умеет: ${missing.map((n) => (n === "clock" ? "остановленные часы" : n)).join(", ")}`);
        continue;
      }
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
    // Необъявленные операции — 404 NO_ROUTE до разбора тела и адреса: клиент так узнаёт «не поддержано»
    const wrongRoute = [];
    for (const op of undeclared) {
      const res = await api.raw(op.method, op.path.replace(/\{\w+\}/g, "00000000-0000-4000-8000-000000000000"), op.method === "GET" || op.method === "DELETE" ? undefined : {});
      if (res.status !== 404 || !res.body || res.body.code !== "NO_ROUTE") wrongRoute.push(`${op.id} → ${res.status} ${(res.body && res.body.code) || ""}`);
    }
    if (wrongRoute.length) {
      failed += 1;
      lines.push(`FAIL  Неподдержанные операции отвечают 404 NO_ROUTE — ${wrongRoute.join("; ")}`);
    } else lines.push(`PASS  Неподдержанные операции отвечают 404 NO_ROUTE — ${undeclared.length ? undeclared.length : "система объявила все операции"}`);
    // Покрытие — по объявленным операциям; служебные стенда — те, что нужны в этом режиме часов
    const called = new Set(recorded.map((r) => `${r.method} ${r.template}`));
    const ops = allOps().filter((op) => (op.test ? op.id !== "testClock" || frozen : CAPS.operations.includes(op.id))).map((op) => `${op.method} ${op.path}`);
    const uncovered = ops.filter((op) => !called.has(op) && !NOT_COVERED.includes(op));
    if (uncovered.length) {
      failed += 1;
      lines.push(`FAIL  Каждая объявленная операция покрыта тестами — без тестов: ${uncovered.join(", ")}`);
    } else lines.push(`PASS  Каждая объявленная операция покрыта тестами — ${ops.length - NOT_COVERED.length} операций${NOT_COVERED.length ? `, исключения: ${NOT_COVERED.join(", ")}` : ""}`);
    const total = tests.length - skipped + 4;
    const skip = skipped ? `, пропущено ${skipped} — система этого не умеет` : "";
    finish(lines, failed ? `Тесты API: ${failed} из ${total} не прошли${skip}` : `Тесты API: все ${total} прошли${skip}`, failed);
  }

  // Операции контракта: метод, путь, operationId, служебная ли (test-support)
  function allOps() {
    return Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([m]) => ["get", "post", "put", "patch", "delete"].includes(m))
        .map(([m, o]) => ({ method: m.toUpperCase(), path, id: o.operationId, test: (o.tags || []).includes("test-support") }))
    );
  }

  // Сообщения потока для одного теста; возвращает «отписаться». По сети поток подключается не сразу, а
  // события до подключения не досылаются: settle() — дождаться подключения (и доставки после действий)
  const subscribeForTest = (fn) => api.subscribe(fn);
  const settle = () => new Promise((r) => setTimeout(r, apiBase ? 400 : 20));

  window.ApiTest = { test, loaded, run, makeEnv, assert, key, subscribeForTest, settle, FX, spec, can, caps: () => CAPS, frozen, fixtureName, external: Boolean(apiBase) };
})();
