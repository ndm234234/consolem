/* Петля для проверки клиента API по сети без бэкенда: tests/api.html?api=loopback.
   Service Worker перехватывает запросы страницы к /tests/loopback-api/… и отвечает встроенным сервером
   по HTTP — с заголовками и потоком событий SSE. Так проходит сетевой путь api/client.js (fetch, If-Match,
   ETag, EventSource), которым клиент говорит с настоящим бэкендом. Не проверяются CORS и вход: страница и
   «бэкенд» на одном адресе. Работает только со страницы по http(s): python3 tools/check_loopback.py. */
self.window = self;
importScripts("../api/openapi.js", "../api/fixture.js", "../api/contract.js", "../api/server.js");

// Адрес «бэкенда» — рядом с этим файлом: /tests/loopback-api, где бы ни лежал репозиторий
const PREFIX = new URL("loopback-api", self.location).pathname;
const server = ConsolemServer.create({ fixture: self.CONSOLEM_FIXTURE, fixtures: self.CONSOLEM_FIXTURES, openapi: self.CONSOLEM_OPENAPI, autoTick: false, testSupport: true });

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  event.respondWith(answer(event.request, url.pathname.slice(PREFIX.length) + url.search));
});

async function answer(request, path) {
  // Поток событий: каждое сообщение — без строки event:, id: — его номер, data: — JSON (StreamMessage)
  if (request.method === "GET" && path.split("?")[0] === "/stream") {
    let stop;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(": loopback\n\n"));
        // Переподключение: браузер шлёт Last-Event-ID — сервер досылает пропущенное или stream.reset
        stop = server.subscribe((m) => controller.enqueue(enc.encode(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`)), request.headers.get("Last-Event-ID"));
      },
      cancel() {
        if (stop) stop();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }
  const headers = {};
  request.headers.forEach((value, name) => (headers[name] = value));
  const text = await request.text();
  const res = server.handle(request.method, path, text ? JSON.parse(text) : undefined, headers);
  const out = new Headers(res.headers || {});
  if (res.status === 204 || res.body === null || res.body === undefined) return new Response(null, { status: res.status, headers: out });
  out.set("Content-Type", res.status >= 400 ? "application/problem+json" : "application/json");
  return new Response(JSON.stringify(res.body), { status: res.status, headers: out });
}
