/* Клиент API конфигуратора (api/openapi.json). Интерфейс говорит только с ним. Два режима:
   - встроенный (по умолчанию): запрос уходит во встроенный сервер api/server.js в этой же вкладке —
     прототип работает без сети и с диска;
   - внешний (baseUrl: ?api=https://… или относительный «api» из <meta name="consolem-api"> сборки):
     тот же запрос уходит на настоящий бэкенд по HTTP, поток событий — по SSE. Относительный адрес
     считается от адреса страницы. С другого адреса бэкенд должен разрешать запросы (CORS, api/BACKEND.md).
     Ответ 401 — сессии нет: вызывается onUnauthorized (интерфейс ведёт на вход).
   Ответы всегда приходят обещанием, как по сети, и копируются: интерфейс не может поменять данные
   сервера. Ошибка — объект { status, problem }. Версия записи уходит в If-Match, приходит в ETag.
   latency — искусственная задержка ответа, мс (?latency=300): интерфейс должен её выдерживать. */
(() => {
  function create(opts) {
    const copy = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
    const latency = Math.max(0, Number(opts.latency) || 0);
    const later = (value) => (latency ? new Promise((resolve) => setTimeout(() => resolve(value), latency)) : value);

    if (opts.baseUrl) {
      const base = opts.baseUrl.replace(/\/$/, "");
      const raw = (method, path, body, headers) =>
        fetch(base + path, {
          method,
          headers: Object.assign(body === undefined ? {} : { "Content-Type": "application/json" }, headers || {}),
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "include",
        }).then(async (res) => {
          if (res.status === 401 && opts.onUnauthorized) opts.onUnauthorized();
          const text = await res.text();
          // Имена заголовков — строчными, как их отдаёт fetch. ETag виден странице, только если
          // бэкенд перечислил его в Access-Control-Expose-Headers
          const got = {};
          res.headers.forEach((value, name) => (got[name] = value));
          return later({ status: res.status, body: text ? JSON.parse(text) : null, headers: got });
        });
      // onReconnect — поток переподключился после обрыва: пока он стоял, могло пропасть то, что сервер
      // не дошлёт по Last-Event-ID, — клиент перечитывает данные.
      // Обрыв связи браузер переподключает сам. Ответ не 200 (в том числе 401) он не переподключает и кода
      // не показывает: поток закрыт. Тогда — GET /me: 401 уходит в onUnauthorized, иначе через 3 с новое
      // подключение (Last-Event-ID у нового нет — данные перечитываются по onReconnect)
      const subscribe = (fn, onReconnect) => {
        let source = null;
        let dropped = false;
        let stopped = false;
        const open = () => {
          source = new EventSource(`${base}/stream`, { withCredentials: true });
          source.onerror = () => {
            dropped = true;
            if (source.readyState !== EventSource.CLOSED || stopped) return;
            raw("GET", "/me").then(
              (res) => res.status !== 401 && !stopped && setTimeout(() => !stopped && open(), 3000),
              () => !stopped && setTimeout(() => !stopped && open(), 3000)
            );
          };
          source.onopen = () => {
            if (dropped && onReconnect) onReconnect();
            dropped = false;
          };
          // Сообщения без имени (без строки event:), тип — в data.type; id: — для Last-Event-ID
          source.onmessage = (e) => fn(JSON.parse(e.data));
        };
        open();
        return () => {
          stopped = true;
          source.close();
        };
      };
      return wrap(raw, subscribe);
    }

    const server = opts.server;
    const raw = (method, path, body, headers) =>
      Promise.resolve().then(() => {
        const res = server.handle(method, path, copy(body), copy(headers));
        const got = {};
        Object.entries(res.headers || {}).forEach(([name, value]) => (got[name.toLowerCase()] = String(value)));
        return later({ status: res.status, body: copy(res.body), headers: got });
      });
    const subscribe = (fn) => server.subscribe((message) => (latency ? setTimeout(() => fn(copy(message)), latency) : fn(copy(message))));
    return wrap(raw, subscribe);
  }

  // raw — ответ как есть: { status, body, headers }. Остальные методы отдают тело, ошибку — исключением.
  // withEtag — тело и версия: { body, etag }
  function wrap(raw, subscribe) {
    const request = (method, path, body, headers) =>
      raw(method, path, body, headers).then((res) => {
        if (res.status >= 400) throw { status: res.status, problem: res.body };
        return res;
      });
    const qs = (params) => {
      const pairs = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
      return pairs.length ? `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : "";
    };
    const ifMatch = (version) => (version === undefined || version === null ? {} : { "If-Match": `"${version}"` });
    const body = (p) => p.then((res) => res.body);
    return {
      raw,
      get: (path, params) => body(request("GET", path + qs(params))),
      getWithEtag: (path) => request("GET", path).then((res) => ({ body: res.body, etag: res.headers.etag })),
      post: (path, data, headers) => body(request("POST", path, data || {}, headers)),
      put: (path, data, version) => body(request("PUT", path, data || {}, ifMatch(version))),
      patch: (path, data, version) => body(request("PATCH", path, data || {}, ifMatch(version))),
      del: (path, version) => body(request("DELETE", path, undefined, ifMatch(version))),
      subscribe,
    };
  }

  window.ConsolemApi = { create };
})();
