#!/usr/bin/env node
/* Встроенный сервер прототипа за настоящим HTTP — образец тестового стенда.
   Отвечает по контракту api/openapi.json, со служебными операциями /test/…, потоком SSE (GET /stream,
   досылка по Last-Event-ID) и CORS для страницы с диска (Origin: null) — так, как это описано в
   api/BACKEND.md. Часы идут по-настоящему, пока их не остановит /test/reset.

   Запуск из корня репозитория:  node tools/serve_api.mjs [порт] [--fixture one-domain|large|xl] [--api DIR] [--tests DIR] [--host ADDR] [--page]   (порт по умолчанию 8787, адрес — 127.0.0.1;
   --page — и страницы репозитория на том же порту: http://<адрес>:<порт>/ открывает index.html с этим API)
   Затем: index.html?api=http://127.0.0.1:8787  или  tests/api.html?api=http://127.0.0.1:8787
   ASSIST_BRIDGE_URL=http://127.0.0.1:18600 — ход ассистента идёт в мост Пилота (настоящая модель), без
   неё — прежняя заглушка. Проверка связки на этой машине, не приёмка.
   POST /__report — принять отчёт страницы (?report=…) и напечатать его; с --exit-on-report — и выйти.

   --webui DIR — ещё и консоль VMS так, как её видит WebUI (tools/build_webui.py, tools/check_webui.py):
   сборка DIR — под /backend/ с заголовком CSP консоли, API — под /backend/api/…, сценарии самопроверки —
   под /backend/tests/ (имя папки — из --tests). Нарушения политики браузер шлёт на /__csp (та же политика в режиме «только
   отчёт»), стенд печатает их строкой CSP-VIOLATION. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
// --api DIR — папка API вместо api, --tests DIR — папка сценариев вместо tests (копии папок)
const arg = (name, def) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : def);
const API = arg("api", "api");
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", API);
require(`${API_DIR}/contract.js`);
// Реестр видов, склад и хуки профилей: server.js найдёт их и сам, но порядок подключения — как на странице
for (const f of ["kinds.js", "units.js", "profiles.js"]) require(`${API_DIR}/${f}`);
require(`${API_DIR}/server.js`);
const fixtures = { demo: require(`${API_DIR}/fixtures/demo.json`), "one-domain": require(`${API_DIR}/fixtures/one-domain.json`), large: require(`${API_DIR}/fixtures/large.json`) };
// Наборы-наложения (tools/profile_fixture.py): "$base" — целый набор, остальные поля — поверх него, как в api/fixture.js
// (tools/build_api.py): объекты сливаются по ключам, так что новый ключ базы (например, в stand) не теряется
const deepMerge = (base, over) =>
  base && over && typeof base === "object" && typeof over === "object" && !Array.isArray(base) && !Array.isArray(over)
    ? Object.assign({}, base, Object.fromEntries(Object.entries(over).map(([k, v]) => [k, deepMerge(base[k], v)])))
    : over;
for (const name of ["xl"]) {
  const { $base, ...over } = require(`${API_DIR}/fixtures/${name}.json`);
  fixtures[name] = deepMerge(fixtures[$base], over);
}
const openapi = require(`${API_DIR}/openapi.json`);
// --fixture one-domain — стартовать с набором профиля (тесты всё равно начинают с /test/reset)
const start = process.argv.includes("--fixture") ? process.argv[process.argv.indexOf("--fixture") + 1] : "demo";
if (!fixtures[start]) throw new Error(`Набора ${start} нет: ${Object.keys(fixtures).join(", ")}`);
const webui = process.argv.includes("--webui") ? path.resolve(process.argv[process.argv.indexOf("--webui") + 1]) : null;
// Каталог обучения — как у бэкенда консоли: learn-catalog.json сборки (--webui). По нему заглушка ассистента отвечает
// учебными ссылками (answer.learn); без сборки каталога нет — ответ без ссылок
const learnFile = webui && path.join(webui, "learn-catalog.json");
const learn = () => (learnFile && fs.existsSync(learnFile) ? JSON.parse(fs.readFileSync(learnFile, "utf8")) : null);
const server = window.ConsolemServer.create({ fixture: fixtures[start], fixtures, openapi, testSupport: true, learn });

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8787);
// --host ADDR — где слушать: по умолчанию только эта машина; 0.0.0.0 — вся сеть (зайти с другого компьютера)
const HOST = arg("host", "127.0.0.1");
const exitOnReport = process.argv.includes("--exit-on-report");
const TESTS_NAME = arg("tests", "tests");
const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", TESTS_NAME);
// Заголовок консоли — как прислала команда w2c, без добавлений
const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".json": "application/json", ".mp4": "video/mp4",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webm": "video/webm", ".md": "text/plain; charset=utf-8" };
// --page — страницы репозитория на том же порту, что и API: index.html, прототипы, assets/, tests/. Пути API без расширения,
// с файлами не путаются. В страницу вставляется <meta name="consolem-api" content="/">: API — этот же сервер, ?api= не нужен
const PAGE = process.argv.includes("--page");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function servePage(req, res) {
  if (!PAGE || req.method !== "GET") return false;
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") {
    res.writeHead(302, { Location: "/index.html" }).end();
    return true;
  }
  if (!TYPES[path.extname(url)]) return false;
  const file = path.resolve(ROOT, "." + url);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  let data = fs.readFileSync(file);
  // Страница без ?api= подняла бы свой встроенный сервер на демо-наборе. API — этот же сервер: адрес в разметке, как в
  // сборке для консоли VMS (<meta name="consolem-api">, index.html читает его, если ?api= нет). consolem-fixture — набор
  // запуска: самопроверка сбрасывает стенд на свои наборы, а в конце возвращает этот
  if (path.extname(file) === ".html") data = data.toString("utf8").replace(/<head>/i, `<head><meta name="consolem-api" content="/"><meta name="consolem-fixture" content="${start}">`);
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-store" });
  res.end(data);
  return true;
}

// Файл сборки или сценария: true — отдан
function serveFile(req, res) {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (!webui || req.method !== "GET" || !url.startsWith("/backend/") || url.startsWith("/backend/api/")) return false;
  const rel = url.slice("/backend/".length) || "index.html";
  const [dir, name] = rel.startsWith(TESTS_NAME + "/") ? [TESTS, rel.slice(TESTS_NAME.length + 1)] : [webui, rel];
  const file = path.resolve(dir, name);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return true;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Content-Security-Policy": CSP,
    "Content-Security-Policy-Report-Only": `${CSP}; report-uri /__csp`,
    "Cache-Control": "no-store",
  });
  res.end(fs.readFileSync(file));
  return true;
}

// Ход ассистента через мост: тело то же, поток идёт как есть, без буфера и без предела времени: ход
// модели длится минуты. Клиент ушёл — соединение с мостом закрывается, ход снимается. Мост не ответил —
// событие error по контракту
const BRIDGE = process.env.ASSIST_BRIDGE_URL || "";
function assistBridge(raw, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const fail = (why) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type: "error", code: "UPSTREAM_UNAVAILABLE", message: `Мост ассистента недоступен: ${why}` })}

`);
    res.end();
  };
  const up = http.request(new URL("/assist/turns", BRIDGE), { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", "Content-Length": Buffer.byteLength(raw) } }, (r) => {
    if (r.statusCode !== 200) return fail(`ответ ${r.statusCode}`);
    r.on("data", (c) => res.write(c));
    r.on("end", () => res.end());
    r.on("error", (e) => fail(e.message));
  });
  up.on("error", (e) => fail(e.message));
  res.on("close", () => up.destroy());
  up.end(raw);
}

function cors(req, res) {
  // Страница с диска приходит с Origin: null; на стенде пускаем любой — и с куками
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-Match, If-None-Match, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "ETag, Location, Retry-After");
  res.setHeader("Vary", "Origin");
}

http
  .createServer((req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (serveFile(req, res)) return;
    if (servePage(req, res)) return;
    // API консоли — под /backend/api/
    if (webui && req.url.startsWith("/backend/api/")) req.url = req.url.slice("/backend/api".length);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/__csp")) {
        let r = {};
        try {
          r = JSON.parse(raw)["csp-report"] || {};
        } catch (e) {}
        console.log(`CSP-VIOLATION ${r["violated-directive"] || "?"} ${r["blocked-uri"] || ""} ${r["source-file"] || ""}:${r["line-number"] || ""} ${(r["script-sample"] || "").slice(0, 80)}`);
        return res.writeHead(204).end();
      }
      if (req.method === "POST" && req.url.startsWith("/__report")) {
        console.log(raw);
        res.writeHead(204).end();
        if (exitOnReport) setTimeout(() => process.exit(raw.trim().endsWith("RESULT pass") ? 0 : 1), 50);
        return;
      }
      if (req.method === "GET" && req.url.split("?")[0] === "/stream") {
        const refused = server.handle("GET", req.url);
        if (refused.status === 422) {
          res.writeHead(422, { "Content-Type": "application/problem+json" });
          return res.end(JSON.stringify(refused.body));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": stand\n\n");
        const watch = new URL(req.url, "http://stand").searchParams.get("watch");
        const stop = server.subscribe((m) => res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`), req.headers["last-event-id"], watch ? watch.split(",") : []);
        // Соединение закрылось — отписаться (у запроса «close» приходит сразу после тела, у ответа — при обрыве)
        res.on("close", stop);
        return;
      }
      if (BRIDGE && req.method === "POST" && req.url.split("?")[0] === "/assist/turns") return assistBridge(raw, res);
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/problem+json" });
        return res.end(JSON.stringify({ code: "VALIDATION_FAILED", message: "Тело — не JSON" }));
      }
      const out = server.handle(req.method, req.url, body, req.headers);
      Object.entries(out.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
      if (out.status === 204 || out.body === null || out.body === undefined) return res.writeHead(out.status).end();
      // Ход ассистента: встроенный сервер отдаёт поток массивом, по HTTP это строки data:
      if (out.headers && out.headers["Content-Type"] === "text/event-stream") {
        res.writeHead(out.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        return res.end(out.body.map((m) => `data: ${JSON.stringify(m)}\n\n`).join(""));
      }
      res.writeHead(out.status, { "Content-Type": out.status >= 400 ? "application/problem+json" : "application/json" });
      res.end(JSON.stringify(out.body));
    });
  })
  .listen(port, HOST, () => console.error(`Стенд: http://${HOST}:${port}`));
