/* Сценарий интерфейса: живое видео. Закладка «Просмотр» только у камер, клиент WHEP на подставном шлюзе: повторы и отбой V/08.3,
   выбор потока и сети, другая сеть, другой кластер, H.265, уход с закладки. Воспроизведение идёт в настоящем времени
   только на стенде (виртуальные часы check_ui ICE не ждут); мышью и с кадрами — tools/check_live.py. */
UiCheck(async ({ ok, until, sleep, confirmWith }) => {
  const stub = window.ConsolemWhepStub;
  const main = () => document.getElementById("main");
  const q = (s) => main().querySelector(s);
  const state = () => q("[data-live-state]")?.textContent || "";
  const note = () => q(".live-note")?.textContent || "";
  const offers = () => stub.log.filter((x) => x.method === "POST").length;
  const deletes = () => stub.log.filter((x) => x.method === "DELETE");
  const cams = devicePool.filter((n) => n.type === "camera");
  const cam = cams.find((n) => n.online !== false && !n.parentId) || cams.find((n) => n.online !== false);
  const second = cams.find((n) => n.online !== false && n !== cam);
  const off = cams.find((n) => n.online === false);
  const open = async (n, t) => {
    pick(n.id, { force: true, tab: "gen" });
    await until(() => !n._row && sel === n.id);
    goTab(t);
  };
  // Состояние соединения задаёт сценарий: в виртуальном времени ICE не успевает за часами страницы
  const conn = (pc, st) => {
    Object.defineProperty(pc, "connectionState", { configurable: true, get: () => st });
    pc.dispatchEvent(new Event("connectionstatechange"));
  };

  ok(tabsFor(cam).some(([id]) => id === "view"), "закладка «Просмотр» у камеры");
  ok(!devicePool.filter((n) => n.type !== "camera").some((n) => tabsFor(n).some(([id]) => id === "view")), "только у камер");
  await open(cam, "view");
  ok(!!q("[data-live-view] ") && !q(".live-scene"), "рамка без кадра-заглушки: адрес есть");
  ok(/Остановлено/.test(state()) && !stub.log.length, "сама не включается");

  // Старт: офер на whepUrl с токеном, только приём
  q("[data-live-go]").click();
  ok(/Подключаюсь/.test(state()), "подключаюсь");
  ok(await until(() => lv.sess, 60000), "сессия: 201 и Location");
  const post = stub.log.find((x) => x.method === "POST");
  ok(/^Bearer stub-/.test(post.auth) && /^stub:\/\/live\/whep\//.test(post.url), "офер на whepUrl с токеном");
  ok(/a=recvonly/.test(post.sdp) && !/a=sendrecv/.test(post.sdp), "только приём");
  ok(/width=\d+&height=\d+/.test(post.url), "поток под размер окна");
  conn(lv.pc, "connected");
  ok(/Идёт/.test(state()) && /stub-/.test(state()), "идёт, через какой шлюз: " + state());
  ok(/настоящего видео на стенде нет|На стенде нет настоящего видео/.test(note()), "подпись: настоящего видео нет: " + note());
  ok(q("[data-live-go]").textContent === "Остановить", "кнопка стоп");

  // Стоп: отбой на Location
  const pcOld = lv.pc;
  q("[data-live-go]").click();
  ok(await until(() => deletes().length === 1), "стоп: DELETE на Location");
  ok(/\/whep\/session\//.test(deletes()[0].url) && /^Bearer/.test(deletes()[0].auth), "отбой с токеном");
  ok(pcOld.signalingState === "closed" && !stub.sessions.size, "соединение закрыто, сессии у шлюза нет");
  ok(/Остановлено/.test(state()), "остановлено");

  // Повторы: not yet, 503, 500, сбой — через 1,5 с, в одном счёте
  stub.script.push({ status: 404, body: { error: "not yet" } }, { status: 503, body: { error: "full" } }, { status: 500, body: { error: "answer failed" } });
  const was = offers();
  liveStart();
  ok(await until(() => /Повторяю/.test(state())), "повторяю: " + state());
  ok(await until(() => lv.sess, 60000), "после повторов сессия");
  ok(offers() - was === 4, "четвёртый офер удался");
  liveStop();

  // Отказ потока — слова, без повтора
  stub.script.push({ status: 404, body: { error: "stream refused", detail: "stream s9 is not of camera" } });
  const w2 = offers();
  liveStart();
  ok(await until(() => /is not of camera/.test(state())), "stream refused: слова: " + state());
  await sleep(2000);
  ok(offers() - w2 === 1, "без повтора");

  // Иной ответ — слова отказа
  stub.script.push({ status: 400, body: { error: "bad offer" } });
  liveStart();
  ok(await until(() => /bad offer/.test(state())), "иной ответ: слова");

  // 403: дверь заново один раз
  stub.script.push({ status: 403, body: { error: "token" } });
  const w3 = offers(), p3 = lv.gen;
  liveStart();
  ok(await until(() => lv.sess, 60000), "после 403 новая дверь и офер");
  ok(offers() - w3 === 2 && lv.gen === p3 + 1, "офер после 403 один");
  const tokens = stub.log.filter((x) => x.method === "POST").slice(-2).map((x) => x.auth);
  ok(tokens[0] !== tokens[1], "токен новый");
  liveStop();

  // Исчерпаны 21 офер: дверь один раз заново, тот же адрес — слова
  for (let i = 0; i < 21; i++) stub.script.push({ status: 404, body: { error: "not yet" } });
  const w4 = offers();
  liveStart();
  ok(await until(() => /Шлюз не взял поток/.test(state()), 60000), "шлюз не взял поток");
  ok(offers() - w4 === 21, `оферов 21, а не ${offers() - w4}`);
  stub.script.length = 0;

  // Сессия обрывается: нет связи, пауза, заново
  liveStart();
  ok(await until(() => lv.sess, 60000), "снова сессия");
  conn(lv.pc, "connected");
  const lost = lv.pc;
  conn(lost, "failed");
  ok(/Нет связи/.test(state()), "нет связи: " + state());
  ok(await until(() => lv.pc && lv.pc !== lost && lv.sess, 60000), "переподключение новым соединением");
  conn(lv.pc, "connected");
  const dis = lv.pc;
  conn(dis, "disconnected");
  conn(dis, "connected");
  ok(/Идёт/.test(state()), "disconnected вернулся: ждали и не рвали");
  await sleep(9000);
  ok(lv.pc === dis, "не переподключались");

  // Выбор потока и сети: на ходу — заново, отбой старого
  const stream = camStreams(cam)[1] || camStreams(cam)[0];
  const d1 = deletes().length;
  const sel1 = q("[data-live-stream]");
  sel1.value = stream.id;
  sel1.dispatchEvent(new Event("change", { bubbles: true }));
  ok(await until(() => lv.sess && lv.sess.door.whepUrl.includes("stream=" + encodeURIComponent(stream.id)), 60000), "выбранный поток — в адресе двери");
  ok(deletes().length === d1 + 1, "старая сессия снята");

  // Другая сеть: 409, форма предлагает переразместить
  const net = q("[data-live-net]");
  net.value = "outside";
  net.dispatchEvent(new Event("change", { bubbles: true }));
  ok(await until(() => /другой сети/.test(state())), "раздачу создали для другой сети: " + state());
  ok(lv.state === "refused" && Array.isArray(lv.move), "params.labels дошли до формы");
  const mv = q("[data-live-move]");
  ok(mv && !mv.hidden, "кнопка «Переразместить»");
  mv.click();
  ok(await until(() => document.getElementById("confirmOk")?.textContent === "Переразместить"), "подтверждение: зрители переподключатся");
  await confirmWith(null);
  ok(await until(() => lv.sess, 60000), "переразмещено, сессия");
  ok((await API.post(`/units/${cam.id}/live`, { width: 1, height: 1, network: "outside" })).gateway === "stub-public", "раздача извне");
  ok(q("[data-live-move]").hidden, "кнопка скрыта");

  // Уход с закладки закрывает соединение, вкладка «Видео» той же камеры — нет
  const held = lv.pc;
  goTab("vid");
  ok(lv && lv.pc === held, "вкладка «Видео» той же камеры: то же соединение");
  ok(document.getElementById("main").querySelector("video") === liveEl, "видео в рамке вкладки");
  const d2 = deletes().length;
  goTab("gen");
  ok(!lv && held.signalingState === "closed", "уход с закладки: соединение закрыто");
  ok(await until(() => deletes().length === d2 + 1), "уход: отбой у шлюза");

  // Смена камеры, поздний 201
  await open(cam, "view");
  ok(lv && lv.net === "local", "выбор сети не хранится");
  await API.put(`/units/${cam.id}/live`, { network: "local" });
  const slow = stub.fetch;
  let release;
  const held201 = new Promise((r) => (release = r));
  stub.fetch = async (u, o) => {
    const res = await slow(u, o);
    if ((o.method || "GET") === "POST") await held201;
    return res;
  };
  const w6 = offers();
  liveStart();
  ok(await until(() => offers() > w6 && stub.sessions.size, 60000), "офер ушёл, шлюз ответил, ответ в пути");
  const d3 = deletes().length;
  await open(second, "view");
  ok(lv.id === second.id, "другая камера");
  release();
  stub.fetch = slow;
  ok(await until(() => deletes().length > d3 && !stub.sessions.size, 60000), "поздний 201: сразу отбой");
  ok(lv.state === "idle" && !lv.sess, "поздняя сессия не показана");

  // Настоящий адрес: заголовки и Location через fetch
  const realFetch = window.fetch, seen = [];
  window.fetch = async (u, o) => {
    if (!String(u).startsWith("https://gw/")) return realFetch(u, o);
    seen.push({ u, o });
    if (o.method === "DELETE") return new Response(null, { status: 204 });
    return stub.fetch("stub://live/whep/x", Object.assign({}, o, { headers: { Authorization: "Bearer stub-x" } })).then(async (r) => new Response(await r.text(), { status: 201, headers: { Location: "/whep/session/abc?gateway=gw7" } }));
  };
  const post0 = API.post;
  API.post = async (p, b) => (/\/live$/.test(p) ? { whepUrl: "https://gw/door/whep/cam?width=1&height=1", token: "real", expiresAt: new Date(Date.now() + 60000).toISOString() } : post0(p, b));
  liveStart();
  ok(await until(() => lv.sess, 60000), "настоящий адрес: сессия");
  ok(seen[0].o.headers["Content-Type"] === "application/sdp" && seen[0].o.headers.Authorization === "Bearer real", "application/sdp, Bearer");
  ok(lv.gateway === "gw7", "шлюз из Location, если поля нет");
  ok(!lv.stub, "подписи о стенде нет");
  liveStop();
  ok(await until(() => seen.some((x) => x.o.method === "DELETE")), "отбой");
  ok(seen.find((x) => x.o.method === "DELETE").u === "https://gw/door/whep/session/abc?gateway=gw7", "DELETE на дверь + Location");
  API.post = post0;
  window.fetch = realFetch;
  stub.cut();

  // Свежий токен на отбое
  liveStart();
  ok(await until(() => lv.sess, 60000), "сессия для отбоя");
  lv.sess.door.expiresAt = new Date(Date.now() - 1000).toISOString();
  const oldTok = lv.sess.door.token;
  const d4 = deletes().length;
  liveStop();
  ok(await until(() => deletes().length === d4 + 1), "отбой после срока токена");
  ok(!deletes().at(-1).auth.includes(oldTok), "свежий токен");

  // Закрытие страницы: keepalive
  liveStart();
  ok(await until(() => lv.sess, 60000), "сессия для закрытия");
  window.dispatchEvent(new Event("pagehide"));
  ok(await until(() => deletes().at(-1).keepalive), "закрытие страницы: keepalive");
  liveStop();

  // H.265: браузер без него — отказ словами, без единого запроса
  const h265 = second;
  const streams = h265.streams;
  h265.streams = (streams || [{ id: "s1", name: "Основной" }]).map((s) => Object.assign({}, s, { codec: "H.265" }));
  const caps = RTCRtpReceiver.getCapabilities;
  RTCRtpReceiver.getCapabilities = () => ({ codecs: [{ mimeType: "video/VP8" }] });
  const w5 = offers();
  liveStart();
  ok(await until(() => /H\.265/.test(state())), "отказ словами: " + state());
  ok(offers() === w5, "офер не ушёл");
  RTCRtpReceiver.getCapabilities = () => ({ codecs: [{ mimeType: "video/H265" }] });
  liveStart();
  ok(await until(() => lv.sess, 60000), "браузер с H.265: идёт дальше");
  liveStop();
  RTCRtpReceiver.getCapabilities = caps;
  h265.streams = streams;
  const sdp = "m=video 9 UDP/TLS/RTP/SAVPF 49 50\r\na=rtpmap:49 H265/90000\r\na=rtpmap:50 rtx/90000\r\na=fmtp:50 apt=49\r\n";
  const moved = liveH265Dynamic(sdp);
  ok(!/rtpmap:49 /.test(moved) && /rtpmap:96 H265/.test(moved) && /apt=96/.test(moved) && /^m=video 9 UDP\/TLS\/RTP\/SAVPF 96 50/.test(moved), "номера H.265 перенесены в 96–127");

  // Камера без связи
  if (off) {
    await open(off, "view");
    ok(/без связи/.test(state()) && q("[data-live-go]").disabled, "камера без связи: старт выключен");
  }

  // Другой кластер: кнопка «Открыть»
  await open(cam, "view");
  const w = window.open, urls = [];
  window.open = (u) => urls.push(u);
  const post1 = API.post;
  API.post = (p, b) => (/\/live$/.test(p) ? Promise.reject({ status: 409, problem: { code: "OTHER_CLUSTER", params: { url: "https://b/backend/" } } }) : post1(p, b));
  liveStart();
  ok(await until(() => /другого кластера/.test(state())), "другой кластер словами");
  const op = q("[data-live-open]");
  ok(op && !op.hidden, "кнопка «Открыть»");
  op.click();
  ok(urls[0] === "https://b/backend/", "вход через её кластер");
  cam.direct = false;
  liveStart();
  ok(await until(() => /за NAT/.test(state())), "камера за NAT: та же кнопка");
  delete cam.direct;
  API.post = post1;
  window.open = w;

  // Вкладка «Видео»: сама подключается, тем же клиентом; кадр-заглушка — только без адреса
  await open(cam, "vid");
  ok(await until(() => lv?.sess, 60000), "вкладка «Видео»: сессия сама");
  ok(!!q(".live-scene"), "кадр-заглушка под видео остаётся для рисования");
  ok(!/Кадр-заглушка/.test(note()), "слов про кадр нет, адрес есть");
  goTab("gen");

  // Настоящее воспроизведение: только в настоящем времени
  if (document.querySelector('meta[name="consolem-api"]') || new URLSearchParams(location.search).get("api")) {
    await open(cam, "view");
    liveStart();
    ok(await until(() => liveEl.videoWidth > 0, 20000), `кадры идут: ${liveEl.videoWidth}×${liveEl.videoHeight}`);
    const t1 = liveEl.currentTime;
    await sleep(1500);
    ok(liveEl.currentTime > t1, `время растёт: ${t1} → ${liveEl.currentTime}`);
    ok(/Идёт/.test(state()), "идёт: " + state());
    goTab("gen");
  }
});
