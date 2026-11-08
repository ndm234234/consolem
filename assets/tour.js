/* Обучение: виртуальный курсор сам проходит задачу в настоящем интерфейсе, а подпись объясняет каждый шаг.
   Темы задаёт assets/tour-demos.js: Tour.add({id, title, why, steps}), в конце Tour.start(). Глава начинается шагом с полем ch:{title, why}.
   Шаг: {say:"текст", at:()=>элемент, act:"click"|"type", text:"что ввести", before:()=>…, ch:{…}}.
   ?tour=K&demo=N — тема K (с 1), шаг N (с 0). &play — идти сразу, без него ждать на шаге; &all — вся тема, без остановок между главами.
   Учебный режим — это ?demo в адресе: страница работает на встроенном сервере (см. API в index.html), localStorage — копия в памяти,
   настоящие черновики и настройки не меняются. Данные живут до перезагрузки: запуск и «Назад» перезагружают страницу и быстро проходят шаги до нужного.
   В сборке для консоли (tools/build_webui.py) сервер показа лежит в demo/ и грузится только при ?demo; с --without-learn раздела нет.
   Изоляция закрыта по умолчанию: не удалось подменить localStorage или не загрузился сервер показа — показ не идёт (Tour.refused),
   страница не обращается к API и сама в рабочий режим не уходит (index.html, learnRefuse). ?demoFail=storage|server — проверка
   этих отказов: параметр только отказывает, другого хода он не включает. */
(() => {
  const Q = new URLSearchParams(location.search);
  const DEMO = /[?&]demo\b/.test(location.search) && !/[?&]selftest(-run)?\b/.test(location.search);
  // Почему показ не идёт: storage — хранилище не отделено, server — нет сервера показа, nolearn — нет обучения в сборке
  let refused = null;
  if (DEMO) {
    let realStore = null;
    try {
      realStore = window.localStorage;
    } catch {}
    // В показ идут только тема и ширина панели: черновики и раскрытые папки увели бы шаги в сторону. Запись остаётся в памяти этой страницы
    const mem = new Map();
    try {
      ["kit-theme", "cfg.asideW"].forEach((k) => {
        const v = realStore.getItem(k);
        if (v != null) mem.set(k, v);
      });
    } catch {}
    const fake = {
      getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
      setItem: (k, v) => void mem.set(String(k), String(v)),
      removeItem: (k) => void mem.delete(String(k)),
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    };
    // Подмена не удалась — показ не идёт: на настоящем хранилище учебные шаги изменили бы черновики и настройки человека
    try {
      if (Q.get("demoFail") === "storage") throw new Error("проверка отказа");
      Object.defineProperty(window, "localStorage", { value: fake, configurable: true });
      if (window.localStorage !== fake) throw new Error("localStorage не подменился");
    } catch {
      refused = "storage";
    }
  }
  // Сборка для консоли: сервера показа нет на обычной странице, он загружается только в учебном режиме, до кода страницы
  const lazy = document.querySelector('meta[name="consolem-demo-files"]')?.content || "";
  // Отказ уже известен — сервер показа не нужен. ?demoFail=server — как будто файлы не загрузились
  if (DEMO && lazy && !refused && Q.get("demoFail") !== "server") lazy.split(",").forEach((src) => document.write(`<script src="${src}"><\/script>`));
  const t = (s) => {
    try {
      return typeof i18n === "function" ? i18n(s) : s;
    } catch {
      return s;
    }
  };
  const CSS = `
.tour-block{position:fixed;inset:0;z-index:100000;background:transparent}
.tour-cur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:100003;pointer-events:none;transition:transform .75s cubic-bezier(.45,.05,.25,1);filter:drop-shadow(0 2px 3px #0009)}
.tour-cur svg{display:block;width:22px;height:22px;transition:transform .12s}
.tour-cur.down svg{transform:scale(.8)}
.tour-ring{position:fixed;left:0;top:0;z-index:100001;pointer-events:none;border:2px solid var(--one-focus-ring,#3b82f6);border-radius:8px;box-shadow:0 0 0 4px color-mix(in srgb,var(--one-focus-ring,#3b82f6) 28%,transparent);transition:opacity .2s}
.tour-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;z-index:100002;pointer-events:none;border-radius:50%;border:2px solid var(--one-focus-ring,#3b82f6);animation:tour-rip .45s ease-out forwards}
@keyframes tour-rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
.tour-panel{position:fixed;left:16px;top:16px;z-index:100004;width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:14px 16px;background:var(--p,#1a2129);color:var(--tx,#e4e9ef);border:1px solid var(--ln,#2d3743);border-radius:10px;box-shadow:0 10px 32px #0007;font-size:14px;line-height:1.45}
.tour-panel.tour-fly{transition:left .3s ease,top .3s ease}
.tour-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}
.tour-n{font-size:12px;color:var(--mu,#97a4b3);margin:0}
.tour-speed{display:flex;gap:2px}
.tour-speed button{min-width:30px;height:24px;padding:0 6px;border:0;border-radius:5px;background:transparent;color:var(--mu,#97a4b3);font:600 12px/1 inherit;cursor:pointer}
.tour-speed button:hover{color:var(--tx,#e4e9ef)}
.tour-speed button[aria-pressed="true"]{background:var(--one-focus-ring,#3b82f6);color:#fff}
.tour-say{margin:0 0 12px;min-height:40px}
.tour-hint{margin:-4px 0 12px;font-size:12px;color:var(--mu,#97a4b3)}
.tour-bar{height:3px;margin:0 0 10px;background:var(--ln,#2d3743);border-radius:2px;overflow:hidden}
.tour-bar i{display:block;height:100%;background:var(--one-focus-ring,#3b82f6);transition:width .3s}
.tour-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.tour-ti{margin:0 0 2px;font-weight:600}
/* Над слоем .tour-block: выйти из учебных данных можно и во время показа */
.tour-mode{position:relative;z-index:100001;display:flex;align-items:center;justify-content:center;gap:12px;padding:6px 16px;background:var(--one-warning-bg,#4a3a10);color:var(--one-warning-text,#ffe9a8);font-size:13px;line-height:1.3}
.tour-mode b{font-weight:600}
.tour-mode button{font:inherit;font-weight:600;color:inherit;background:none;border:1px solid currentColor;border-radius:6px;padding:3px 10px;cursor:pointer}
.tour-mode button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.app.tour-on{grid-template-rows:auto minmax(0,1fr)}
@media(prefers-reduced-motion:reduce){.tour-cur,.tour-panel.tour-fly{transition:none}.tour-ripple{display:none}}`;
  const ARROW = '<svg viewBox="0 0 22 22" aria-hidden="true"><path d="M4 2l13.5 11.2-6.3.5 3.6 6.9-2.7 1.4-3.6-7L4 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const reduced = () => matchMedia("(prefers-reduced-motion:reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const make = (tag, cls, html) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  };
  const button = (label, cls, fn) => {
    const b = make("button", cls);
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  // Скорость переживает перезагрузку на «Назад» и новый запуск в этой вкладке; настоящий localStorage показ не трогает
  const SPEEDS = [1, 2, 4, 8];
  const loadSpeed = () => {
    try {
      const v = Number(sessionStorage.getItem("tourSpeed"));
      return SPEEDS.includes(v) ? v : 1;
    } catch {
      return 1;
    }
  };
  const saveSpeed = (v) => {
    try {
      sessionStorage.setItem("tourSpeed", String(v));
    } catch {}
  };
  // Показ всегда на чистых данных: сценарий рассчитан на набор, каким он был при загрузке
  const urlFor = (params) => {
    const u = new URL(location.href);
    ["tour", "demo", "play", "all", "demoFail"].forEach((k) => u.searchParams.delete(k));
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    // Без якоря: адрес с одним только якорем страницу не перезагрузит
    u.hash = "";
    return u;
  };
  const leave = (k, c) => {
    const u = urlFor({});
    u.hash = `learn=${c == null ? k : `${k}.${c}`}`;
    // Без записи в историю: «Назад» после выхода не запускает показ снова
    location.replace(u.href);
  };

  function run(topic, k, startAt, opts) {
    const steps = topic.steps, chapters = topic.chapters, last = steps.length - 1;
    const chOf = (at) => Math.max(0, chapters.findIndex((c) => at >= c.from && at <= c.to));
    let ch = chOf(startAt), from = opts.all ? 0 : chapters[ch].from, to = opts.all ? last : chapters[ch].to, nextCh = false;
    const reloadAt = (step, play) => {
      location.href = urlFor({ tour: k + 1, demo: step, ...(play ? { play: 1 } : {}), ...(opts.all ? { all: 1 } : {}) }).href;
    };
    let i = 0, paused = false, stopped = false, skip = false, back = false, ended = false, target = null, goal = null, corner = "bl", flyTimer = 0, pinned = false, triedAt = null, frame = 0, speed = loadSpeed();
    const block = make("div", "tour-block"), cur = make("div", "tour-cur", ARROW), ring = make("div", "tour-ring"), panel = make("div", "tour-panel");
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    const ti = make("p", "tour-ti"), n = make("p", "tour-n"), bar = make("div", "tour-bar", "<i></i>"), say = make("p", "tour-say"), hint = make("p", "tour-hint"), btns = make("div", "tour-btns");
    hint.hidden = true;
    const top = make("div", "tour-top"), speeds = make("div", "tour-speed");
    speeds.setAttribute("role", "group");
    speeds.setAttribute("aria-label", t("Скорость показа"));
    const speedBtns = SPEEDS.map((v) => {
      const b = button(`×${v}`, "", () => setSpeed(v));
      speeds.append(b);
      return b;
    });
    function setSpeed(v) {
      speed = v;
      saveSpeed(v);
      speedBtns.forEach((b, k) => b.setAttribute("aria-pressed", String(SPEEDS[k] === v)));
      cur.style.transitionDuration = `${0.75 / v}s`;
    }
    setSpeed(speed);
    top.append(n, speeds);
    panel.append(ti, top, bar, say, hint, btns);
    const goBack = () => {
      if (i > from) back = true;
    };
    const goNext = () => {
      if (!ended) skip = true;
      else if (to < last) nextCh = true;
    };
    const backBtn = button(t("Назад"), "btn s", goBack);
    const pauseBtn = button(t("Пауза"), "btn s", () => (ended ? reloadAt(from, true) : setPaused(!paused)));
    const nextBtn = button(t("Дальше"), "btn s", goNext);
    const tryBtn = button(t("Попробовать самому"), "btn s", tryIt);
    tryBtn.style.display = "none";
    btns.append(backBtn, pauseBtn, tryBtn, nextBtn, button(t("Закрыть"), "btn s", stop));
    ring.style.opacity = "0";
    cur.style.transform = `translate(${innerWidth / 2}px,${innerHeight / 2}px)`;
    document.body.append(block, ring, cur, panel);
    function setPaused(v) {
      paused = v;
      pauseBtn.textContent = t(v ? "Продолжить" : "Пауза");
    }
    function setEnded(v) {
      ended = v;
      hint.hidden = !v;
      tryBtn.style.display = v ? "" : "none";
      nextBtn.style.display = v && to >= last ? "none" : "";
      hint.textContent = t(to >= last ? "Это конец темы. Её можно посмотреть снова или попробовать самому на тех же учебных данных." : "Глава окончена. Её можно посмотреть снова, перейти к следующей или попробовать самому на тех же учебных данных.");
      nextBtn.textContent = t(v ? "Следующая глава" : "Дальше");
      nextBtn.className = v ? "btn pri s" : "btn s";
      pauseBtn.textContent = t(v ? "Показать снова" : paused ? "Продолжить" : "Пауза");
      // Высота панели изменилась: сразу на место, а не со следующим кадром
      place();
    }
    // Клавиши на время показа — только его: стрелка иначе пойдёт по дереву, Esc закроет окно
    const key = (e) => {
      e.stopImmediatePropagation();
      // Enter и пробел на кнопке панели и кнопке выхода нажимают её
      const exit = document.querySelector(".tour-mode button");
      if ((e.key === "Enter" || e.key === " ") && (panel.contains(e.target) || e.target === exit)) return;
      e.preventDefault();
      if (e.type !== "keydown") return;
      if (e.key === "Tab") {
        // Фокус ходит только по панели и кнопке выхода
        const all = [...panel.querySelectorAll("button:not(:disabled)"), exit].filter(Boolean);
        const at = all.indexOf(document.activeElement);
        all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      } else if (e.key === "Escape") stop();
      else if (e.key === " " && !ended) setPaused(!paused);
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goBack();
      else if (SPEEDS.includes(Number(e.key))) setSpeed(Number(e.key));
    };
    const KEYS = ["keydown", "keypress", "keyup"];
    KEYS.forEach((t) => window.addEventListener(t, key, true));
    // Подсветка следует за элементом: окно перерисовывается, поэтому искать его заново на каждом кадре
    const place = () => {
      const el = target && target();
      let r = null;
      if (el && el.isConnected) {
        r = el.getBoundingClientRect();
        // Строки выше догрузились и увели цель за край окна: возвращаем её на экран, курсор идёт следом. Цель, которую вернуть
        // нельзя (выше окна, вне прокрутки), не трогаем снова, пока она не сдвинулась; после клика прокрутка — уже дело страницы
        const off = r.bottom > innerHeight + 1 || r.top < -1;
        if (pinned && off && !(triedAt && Math.abs(r.top - triedAt[0]) <= 1 && Math.abs(r.height - triedAt[1]) <= 1)) {
          el.scrollIntoView({ block: "nearest" });
          r = el.getBoundingClientRect();
          triedAt = [r.top, r.height];
          point(el);
        }
        ring.style.opacity = "1";
        ring.style.transform = `translate(${r.left - 4}px,${r.top - 4}px)`;
        ring.style.width = `${r.width + 8}px`;
        ring.style.height = `${r.height + 8}px`;
      } else ring.style.opacity = "0";
      dock(r);
    };
    // Панель в углу, где не закрывает цель, а из свободных — ещё и курсор с его путём к цели. Сначала только цель: её площадь
    // не меняется, пока курсор едет, поэтому большая цель не дёргает панель туда-сюда. Пока в текущем углу не мешает — панель стоит
    const dock = (r) => {
      const w = panel.offsetWidth, h = panel.offsetHeight, c = cur.getBoundingClientRect();
      const way = cur.style.opacity === "0" ? [] : Array.from({ length: 13 }, (_, k) => {
        const t = goal ? k / 12 : 0;
        return [c.left + ((goal ? goal[0] : c.left) - c.left) * t, c.top + ((goal ? goal[1] : c.top) - c.top) * t];
      });
      const cost = (name) => {
        const x = name[1] === "l" ? 16 : innerWidth - 16 - w, y = name[0] === "t" ? 16 : innerHeight - 16 - h;
        const area = !r ? 0 : Math.max(0, Math.min(r.right + 12, x + w) - Math.max(r.left - 12, x)) * Math.max(0, Math.min(r.bottom + 12, y + h) - Math.max(r.top - 12, y));
        const hits = way.filter(([a, b]) => a + 34 > x && a - 12 < x + w && b + 34 > y && b - 12 < y + h).length;
        return { name, x, y, area, hits };
      };
      // Первым — нынешний угол, он выигрывает при равенстве; затем соседний по горизонтали, по вертикали и напротив
      const flip = (name, at) => name.replace(name[at], { t: "b", b: "t", l: "r", r: "l" }[name[at]]);
      const best = [corner, flip(corner, 1), flip(corner, 0), flip(flip(corner, 0), 1)].map(cost).reduce((a, b) => (b.area < a.area || (b.area === a.area && b.hits < a.hits) ? b : a));
      // Анимируется только перелёт: смена высоты панели от текста не должна выглядеть как полёт
      if (best.name !== corner) {
        corner = best.name;
        panel.classList.add("tour-fly");
        clearTimeout(flyTimer);
        flyTimer = setTimeout(() => panel.classList.remove("tour-fly"), 320);
      }
      panel.style.left = `${best.x}px`;
      panel.style.top = `${best.y}px`;
    };
    const follow = () => {
      if (stopped) return;
      place();
      frame = requestAnimationFrame(follow);
    };
    place();
    frame = requestAnimationFrame(follow);
    function clear() {
      stopped = true;
      cancelAnimationFrame(frame);
      KEYS.forEach((t) => window.removeEventListener(t, key, true));
      block.remove(); cur.remove(); ring.remove();
    }
    function stop() {
      clear();
      panel.remove();
      leave(k, opts.all ? null : ch);
    }
    // Страница остаётся на учебных данных: выйти можно кнопкой в полосе режима
    function tryIt() {
      clear();
      panel.remove();
      Tour.at = [k, ch];
    }
    function broken() {
      clear();
      n.textContent = t("Показ прервался");
      speeds.remove();
      bar.remove();
      say.textContent = t("На экране нет того, что нужно показать дальше. Обычно дело в узком окне: в нём карточка скрыта. Откройте окно пошире.");
      btns.replaceChildren(button(t("Показать снова"), "btn s", () => reloadAt(from, true)), button(t("Закрыть"), "btn pri s", stop));
    }
    function draw(s) {
      ch = chOf(i);
      ti.textContent = `${t(topic.title)} · ${t(chapters[ch].title)}`;
      n.textContent = `${t("Шаг")} ${i - from + 1} ${t("из")} ${to - from + 1}`;
      bar.firstChild.style.width = `${Math.round(((i - from + 1) / (to - from + 1)) * 100)}%`;
      say.textContent = t(s.say);
      backBtn.disabled = i === from;
      place();
    }
    // Ждать, уважая паузу; «Дальше» и «Назад» обрывают ожидание. Нажатые, пока курсор кликал или вводил, сработают здесь
    async function hold(ms) {
      let left = ms;
      while ((left > 0 || paused) && !stopped && !skip && !back) {
        await sleep(50);
        if (!paused) left -= 50 * speed;
      }
      skip = false;
    }
    async function waitFor(at) {
      for (let t = 0; t < 100 && !stopped; t++) {
        const el = at();
        if (el && el.isConnected && el.getClientRects().length) return el;
        await sleep(50);
      }
      return null;
    }
    const point = (el) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(r.left + Math.min(r.width / 2, 60), innerWidth - 24), y = Math.min(r.top + Math.min(r.height / 2, 18), innerHeight - 24);
      cur.style.transform = `translate(${x}px,${y}px)`;
      goal = [x, y];
      return [x, y];
    };
    async function press(el) {
      const [x, y] = point(el);
      await sleep(reduced() ? 0 : 780 / speed);
      cur.classList.add("down");
      const rip = make("div", "tour-ripple");
      rip.style.left = `${x}px`;
      rip.style.top = `${y}px`;
      document.body.append(rip);
      setTimeout(() => rip.remove(), 500);
      await sleep(120 / speed);
      cur.classList.remove("down");
    }
    async function type(el, text) {
      el.focus();
      for (const ch of text) {
        if (stopped) return;
        el.value += ch;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        if (!reduced()) await sleep(38 / speed);
      }
    }
    // Шаги до нужного — без курсора и ожиданий: они только восстанавливают состояние
    async function rewind() {
      ti.textContent = `${t(topic.title)} · ${t(chapters[ch].title)}`;
      n.textContent = "";
      say.textContent = t("Готовлю учебные данные…");
      cur.style.opacity = "0";
      for (i = 0; i < startAt && !stopped; i++) {
        const s = steps[i];
        if (s.before) await s.before();
        const el = s.at ? await waitFor(s.at) : null;
        if (stopped) return;
        if (s.at && !el) return broken();
        if (el && s.act === "click") el.click();
        else if (el && s.act === "type") {
          el.value = s.text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await sleep(30);
      }
      cur.style.opacity = "";
      skip = false;
      setPaused(!opts.play);
    }
    (async () => {
      await rewind();
      while (!stopped) {
        const s = steps[i];
        draw(s);
        if (s.before) await s.before();
        const el = s.at ? await waitFor(s.at) : null;
        if (stopped) return;
        if (s.at && !el) return broken();
        target = s.at || null;
        pinned = !!el;
        triedAt = null;
        if (el) {
          el.scrollIntoView({ block: "nearest" });
          point(el);
        }
        place();
        if (i === to) {
          setEnded(true);
          while (!stopped && !back && !nextCh) await sleep(50);
          if (nextCh) {
            nextCh = false;
            from = chapters[chOf(to + 1)].from;
            to = chapters[chOf(from)].to;
            setPaused(false);
            setEnded(false);
          }
        } else await hold(Math.max(2500, s.say.length * 55));
        if (stopped) return;
        if (back) return reloadAt(i - 1, false);
        if (el && s.act === "click") {
          const fresh = s.at() || el;
          await press(fresh);
          if (stopped) return;
          pinned = false;
          fresh.click();
          await sleep(350 / speed);
        } else if (el && s.act === "type") {
          await press(el);
          await type(s.at() || el, s.text);
          await sleep(300 / speed);
        }
        i++;
      }
    })().catch((e) => {
      console.error(e);
      broken();
    });
  }

  const mount = () => {
    const st = make("style", "");
    st.textContent = CSS;
    document.head.append(st);
    if (!DEMO || Tour.refused) return;
    const q = new URLSearchParams(location.search), k = Number(q.get("tour")) - 1, topic = Tour.topics[k];
    const app = document.querySelector(".app"), bar = make("div", "tour-mode");
    bar.setAttribute("role", "status");
    bar.append(make("span", "", `<b>${t("Учебные данные.")}</b> ${t("Настоящая система не меняется.")}`), button(t("Выйти из учебных данных"), "", () => leave(...(Tour.at || [Math.max(k, 0), null]))));
    app.classList.add("tour-on");
    app.prepend(bar);
    if (!topic) return;
    const at = Number(q.get("demo"));
    run(topic, k, Number.isInteger(at) ? Math.max(0, Math.min(at, topic.steps.length - 1)) : 0, { play: q.has("play") || q.get("demo") === "", all: q.has("all") });
  };
  // Примерное время при скорости ×1: как в run — чтение подписи, плюс ход курсора
  const secs = (steps) => steps.reduce((sum, s) => sum + Math.max(2500, s.say.length * 55) + (s.act ? 1300 : 0), 0) / 1000;
  const Tour = {
    demo: DEMO,
    lazy: !!lazy,
    refused,
    // Куда выходит человек из учебного режима и из отказа показа
    exitUrl: () => urlFor({}).href,
    // Сервер показа есть? Нет — отказ показа (index.html проверяет до API)
    serverMissing: () => Q.get("demoFail") === "server" || typeof ConsolemServer === "undefined",
    topics: [],
    add(topic) {
      const chapters = [];
      topic.steps.forEach((s, at) => {
        if (s.ch || !chapters.length) chapters.push({ ...(s.ch || { title: topic.title, why: topic.why }), from: at, to: at });
        chapters[chapters.length - 1].to = at;
      });
      chapters.forEach((c) => (c.secs = secs(topic.steps.slice(c.from, c.to + 1))));
      Tour.topics.push({ ...topic, chapters, secs: secs(topic.steps) });
    },
    // Запуск главы c темы k; без c — вся тема подряд. Перезагрузка: показ идёт на чистых данных
    play(k, c) {
      const all = c == null;
      // Показ идёт на русском: шаги ищут элементы по русским подписям. Язык возвращается при выходе (learnFromHash в index.html)
      const lang = typeof uiLang !== "undefined" && uiLang !== "ru" ? { lang: uiLang } : {};
      location.href = urlFor({ tour: k + 1, demo: all ? 0 : Tour.topics[k].chapters[c].from, play: 1, ...(all ? { all: 1 } : {}), ...lang }).href;
    },
    // Вызов в конце файла с темами: темы уже известны, страница — после загрузки данных
    start() {
      (window.appReady || Promise.resolve()).then(() => {
        mount();
        window.learnFromHash?.();
      });
    },
  };
  window.Tour = Tour;
})();
