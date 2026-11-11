/* Клиент API конфигуратора (api/openapi.json). Интерфейс говорит только с ним. Два режима:
   - встроенный (по умолчанию): запрос уходит во встроенный сервер api/server.js в этой же вкладке —
     прототип работает без сети и с диска;
   - внешний (baseUrl: ?api=https://… или относительный «api» из <meta name="consolem-api"> сборки):
     тот же запрос уходит на настоящий бэкенд по HTTP, поток событий — по SSE. Относительный адрес
     считается от адреса страницы. С другого адреса бэкенд должен разрешать запросы (CORS, api/BACKEND.md).
     Ответ 401 — сессии нет: вызывается onUnauthorized (интерфейс ведёт на вход).
   Ответы всегда приходят обещанием, как по сети, и копируются: интерфейс не может поменять данные
   сервера. Ошибка — объект { status, problem }. Версия записи уходит в If-Match, приходит в ETag.
   latency — искусственная задержка ответа, мс (?latency=300): интерфейс должен её выдерживать.
   assistTurn — отдельно от обоих режимов: ход в службу ассистента демо-страницы, со своим адресом и кодом. */
(() => {
  // Сообщения потока ответа на POST: строки data:, закрыть поток — signal запроса
  async function readSse(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    for (;;) {
      const { done, value } = await reader.read();
      tail += done ? "\n\n" : decoder.decode(value, { stream: true });
      const blocks = tail.split("\n\n");
      tail = blocks.pop();
      blocks.forEach((block) => {
        const lines = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
        if (lines.length) onEvent(JSON.parse(lines.join("\n")));
      });
      if (done) return;
    }
  }

  /* Ход в службу ассистента демо-страницы: POST <url>/assist/turns, ответ потоком. Заголовок X-Assist-Code — только если
     код введён: служба открыта всем, код нужен, если её закрыли.
     data.world — снимок AssistWorld, его собирает страница: описания видов (kinds) и объекты (units) вместо устройств,
     папок и серверов; шаги плана службы — {uid, version, patch} (AssistPlanItem), отбор — фильтры GET /units (AssistFoundFilter).
     Служба — не бэкенд консоли: куки не уходят, а 401 здесь значит «нужен код», это не выход из системы,
     поэтому onUnauthorized сюда не подключён. secrets не уходят никогда, что бы ни пришло в data.
     Отказ службы — исключение { status, problem, retryAfter }: retryAfter, с — из Retry-After, если заголовок виден
     странице (CORS: Access-Control-Expose-Headers), иначе 0. Нет соединения, обрыв и поток без завершающего
     сообщения — { status: 0, problem: { code: "UPSTREAM_UNAVAILABLE" } }. Отмена — исключение AbortError. */
  async function assistTurn(url, code, data, onEvent, opts) {
    const { secrets, ...body } = data;
    const signal = opts && opts.signal;
    const down = (e) => {
      if (e && e.name === "AbortError") return e;
      return { status: 0, problem: { code: "UPSTREAM_UNAVAILABLE" } };
    };
    let res;
    try {
      res = await fetch(`${url.replace(/\/$/, "")}/assist/turns`, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json", Accept: "text/event-stream" }, code ? { "X-Assist-Code": code } : {}),
        body: JSON.stringify(body),
        credentials: "omit",
        signal,
      });
    } catch (e) {
      throw down(e);
    }
    if (res.status !== 200) {
      let problem = null;
      try {
        problem = JSON.parse(await res.text());
      } catch (e) {}
      throw { status: res.status, problem, retryAfter: Number(res.headers.get("Retry-After")) || 0 };
    }
    let ended = false;
    try {
      await readSse(res, (m) => {
        if (opts && opts.ends && opts.ends(m)) ended = true;
        onEvent(m);
      });
    } catch (e) {
      throw down(e);
    }
    if (!ended) throw down();
  }

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
          // Тело — JSON; ответ другого типа (text/csv выгрузки журнала) — строкой
          const type = got["content-type"] || "";
          return later({ status: res.status, body: text ? (!type || /json/.test(type) ? JSON.parse(text) : text) : null, headers: got });
        });
      // onReconnect — поток переподключился после обрыва: пока он стоял, могло пропасть то, что сервер
      // не дошлёт по Last-Event-ID, — клиент перечитывает данные.
      // Обрыв связи браузер переподключает сам. Ответ не 200 (в том числе 401) он не переподключает и кода
      // не показывает: поток закрыт. Тогда — GET /me: 401 уходит в onUnauthorized, иначе через 3 с новое
      // подключение (Last-Event-ID у нового нет — данные перечитываются по onReconnect)
      // reopen(ids) — новый поток со списком наблюдаемых в запросе открытия: PUT наблюдения пришёл на другой экземпляр
      // (404). Браузер при обрыве переподключается по этому же адресу, актуальный список форма присылает после hello
      const subscribe = (fn, onReconnect) => {
        let source = null;
        let dropped = false;
        let stopped = false;
        let watch = [];
        const open = () => {
          const mine = new EventSource(`${base}/stream${watch.length ? `?watch=${watch.map(encodeURIComponent).join(",")}` : ""}`, { withCredentials: true });
          const again = () => source === mine && !stopped && setTimeout(() => source === mine && !stopped && open(), 3000);
          source = mine;
          source.onerror = () => {
            dropped = true;
            if (mine.readyState !== EventSource.CLOSED || stopped) return;
            raw("GET", "/me").then((res) => res.status !== 401 && again(), again);
          };
          source.onopen = () => {
            if (dropped && onReconnect) onReconnect();
            dropped = false;
          };
          // Сообщения без имени (без строки event:), тип — в data.type; id: — для Last-Event-ID
          source.onmessage = (e) => fn(JSON.parse(e.data));
        };
        open();
        const stop = () => {
          stopped = true;
          source.close();
        };
        stop.reopen = (ids) => {
          watch = ids;
          dropped = false;
          source.close();
          open();
        };
        return stop;
      };
      // Поток ответа на POST: fetch, а не EventSource. Сообщения — строками data:, закрыть поток — signal
      const stream = async (path, data, onEvent, signal) => {
        const res = await fetch(base + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(data),
          credentials: "include",
          signal,
        });
        if (res.status === 401 && opts.onUnauthorized) opts.onUnauthorized();
        if (res.status !== 200) {
          const text = await res.text();
          throw { status: res.status, problem: text ? JSON.parse(text) : null };
        }
        await readSse(res, onEvent);
      };
      return wrap(raw, subscribe, stream);
    }

    const server = opts.server;
    const raw = (method, path, body, headers) =>
      Promise.resolve().then(() => {
        const res = server.handle(method, path, copy(body), copy(headers));
        const got = {};
        Object.entries(res.headers || {}).forEach(([name, value]) => (got[name.toLowerCase()] = String(value)));
        return later({ status: res.status, body: copy(res.body), headers: got });
      });
    const subscribe = (fn) => {
      const deliver = (message) => (latency ? setTimeout(() => fn(copy(message)), latency) : fn(copy(message)));
      let close = server.subscribe(deliver);
      const stop = () => close();
      stop.reopen = (ids) => {
        close();
        close = server.subscribe(deliver, undefined, ids);
      };
      return stop;
    };
    // Встроенный сервер отдаёт поток массивом сообщений: по одному, как по сети
    const stream = async (path, data, onEvent, signal) => {
      const res = await raw("POST", path, data);
      if (res.status !== 200) throw { status: res.status, problem: res.body };
      for (const message of res.body) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(latency, 1)));
        if (signal && signal.aborted) throw { name: "AbortError" };
        onEvent(message);
      }
    };
    return wrap(raw, subscribe, stream);
  }

  // raw — ответ как есть: { status, body, headers }. Остальные методы отдают тело, ошибку — исключением.
  // withEtag — тело и версия: { body, etag }
  // stream — поток ответа на POST; завершающее сообщение ends(m). Поток без него — обрыв
  function wrap(rawSend, subscribe, streamRaw) {
    // window.CONSOLEM_TRACE — журнал запросов для tools/check_scale.py: размер ответа и есть ли продолжение
    const raw = (method, path, body, headers) =>
      rawSend(method, path, body, headers).then((res) => {
        if (window.CONSOLEM_TRACE) {
          const text = res.body === null || res.body === undefined ? "" : JSON.stringify(res.body);
          window.CONSOLEM_TRACE.push({ method, path, status: res.status, bytes: text.length, more: !!(res.body && res.body.nextCursor), empty: !!(res.body && Array.isArray(res.body.items) && !res.body.items.length) });
        }
        return res;
      });
    const stream = async (path, data, onEvent, opts) => {
      let ended = false;
      await streamRaw(path, data, (m) => {
        if (opts && opts.ends && opts.ends(m)) ended = true;
        onEvent(m);
      }, opts && opts.signal);
      if (opts && opts.ends && !ended) throw { status: 0, problem: { code: "UPSTREAM_UNAVAILABLE" } };
    };
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
      stream,
    };
  }

  window.ConsolemApi = { create, assistTurn };
})();
