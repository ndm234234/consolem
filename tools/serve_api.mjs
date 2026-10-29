#!/usr/bin/env node
/* Встроенный сервер прототипа за настоящим HTTP — образец тестового стенда.
   Отвечает по контракту api/openapi.json, со служебными операциями /test/…, потоком SSE (GET /stream,
   досылка по Last-Event-ID) и CORS для страницы с диска (Origin: null) — так, как это описано в
   api/BACKEND.md. Часы идут по-настоящему, пока их не остановит /test/reset.

   Запуск из корня репозитория:  node tools/serve_api.mjs [порт] [--fixture one-domain]   (порт по умолчанию 8787)
   Затем: index.html?api=http://127.0.0.1:8787  или  tests/api.html?api=http://127.0.0.1:8787
   POST /__report — принять отчёт страницы (?report=…) и напечатать его; с --exit-on-report — и выйти.

   --webui DIR — ещё и консоль VMS так, как её видит WebUI (tools/build_webui.py, tools/check_webui.py):
   сборка DIR — под /backend/ с заголовком CSP консоли, API — под /backend/api/…, сценарии самопроверки —
   под /backend/tests/. Нарушения политики браузер шлёт на /__csp (та же политика в режиме «только
   отчёт»), стенд печатает их строкой CSP-VIOLATION. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require("../api/contract.js");
require("../api/server.js");
const fixtures = { demo: require("../api/fixtures/demo.json"), "one-domain": require("../api/fixtures/one-domain.json") };
const openapi = require("../api/openapi.json");
// --fixture one-domain — стартовать с набором профиля (тесты всё равно начинают с /test/reset)
const start = process.argv.includes("--fixture") ? process.argv[process.argv.indexOf("--fixture") + 1] : "demo";
if (!fixtures[start]) throw new Error(`Набора ${start} нет: ${Object.keys(fixtures).join(", ")}`);
const server = window.ConsolemServer.create({ fixture: fixtures[start], fixtures, openapi, testSupport: true });

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8787);
const exitOnReport = process.argv.includes("--exit-on-report");
const webui = process.argv.includes("--webui") ? path.resolve(process.argv[process.argv.indexOf("--webui") + 1]) : null;
const TESTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "tests");
// Заголовок консоли — как прислала команда w2c, без добавлений
const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".json": "application/json" };

// Файл сборки или сценария: true — отдан
function serveFile(req, res) {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (!webui || req.method !== "GET" || !url.startsWith("/backend/") || url.startsWith("/backend/api/")) return false;
  const rel = url.slice("/backend/".length) || "index.html";
  const [dir, name] = rel.startsWith("tests/") ? [TESTS, rel.slice("tests/".length)] : [webui, rel];
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

function cors(req, res) {
  // Страница с диска приходит с Origin: null; на стенде пускаем любой — и с куками
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-Match, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "ETag");
  res.setHeader("Vary", "Origin");
}

http
  .createServer((req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (serveFile(req, res)) return;
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
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": stand\n\n");
        const stop = server.subscribe((m) => res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`), req.headers["last-event-id"]);
        // Соединение закрылось — отписаться (у запроса «close» приходит сразу после тела, у ответа — при обрыве)
        res.on("close", stop);
        return;
      }
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
      res.writeHead(out.status, { "Content-Type": out.status >= 400 ? "application/problem+json" : "application/json" });
      res.end(JSON.stringify(out.body));
    });
  })
  .listen(port, "127.0.0.1", () => console.error(`Стенд: http://127.0.0.1:${port}`));
