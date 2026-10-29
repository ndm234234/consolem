#!/usr/bin/env node
/* Встроенный сервер прототипа за настоящим HTTP — образец тестового стенда.
   Отвечает по контракту api/openapi.json, со служебными операциями /test/…, потоком SSE (GET /stream,
   досылка по Last-Event-ID) и CORS для страницы с диска (Origin: null) — так, как это описано в
   api/BACKEND.md. Часы идут по-настоящему, пока их не остановит /test/reset.

   Запуск из корня репозитория:  node tools/serve_api.mjs [порт] [--fixture one-domain]   (порт по умолчанию 8787)
   Затем: index.html?api=http://127.0.0.1:8787  или  tests/api.html?api=http://127.0.0.1:8787
   POST /__report — принять отчёт страницы (?report=…) и напечатать его; с --exit-on-report — и выйти. */
import http from "node:http";
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
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
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
