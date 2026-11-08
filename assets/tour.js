/* Обучение: виртуальный курсор сам проходит задачу в настоящем интерфейсе, а подпись объясняет каждый шаг.
   Темы задаёт assets/tour-demos.js: Tour.add({id, title, why, steps}), в конце Tour.start(). Глава начинается шагом с полем ch:{title, why}.
   Шаг: {say:"текст", at:()=>элемент, act:"click"|"type", text:"что ввести", before:()=>…, ch:{id, title, why}}.
   У темы и главы — устойчивые ID (Tour.ID): глава — «<тема>.<глава>», например rules.simple. Позиция в массиве не адрес.
   ?tour=<тема>&ch=<глава> — показ главы, &all — вся тема без остановок между главами; &demo=N — шаг N темы (с 0), с ним показ
   продолжает после «Назад». &play — идти сразу, без него ждать на шаге. Неизвестная тема или глава — показ не идёт, ближайшую
   по номеру консоль не берёт; прежние номера (?tour=1, #learn=0.1) тоже не адрес.
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
  const urlFor = (params, from) => {
    const u = new URL(from || location.href);
    ["tour", "ch", "demo", "play", "all", "demoFail"].forEach((k) => u.searchParams.delete(k));
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    // Без якоря: адрес с одним только якорем страницу не перезагрузит
    u.hash = "";
    return u;
  };
  // Выход: раздел «Обучение» на той же главе (ID), без темы — на первом экране раздела
  const leave = (tid, cid) => {
    const u = urlFor({});
    u.hash = `learn=${cid || tid || "home"}`;
    // Без записи в историю: «Назад» после выхода не запускает показ снова
    location.replace(u.href);
  };

  function run(topic, startAt, opts) {
    const steps = topic.steps, chapters = topic.chapters, last = steps.length - 1;
    const chOf = (at) => Math.max(0, chapters.findIndex((c) => at >= c.from && at <= c.to));
    let ch = chOf(startAt), from = opts.all ? 0 : chapters[ch].from, to = opts.all ? last : chapters[ch].to, nextCh = false;
    const reloadAt = (step, play) => {
      location.href = urlFor({ tour: topic.id, ...(opts.all ? { all: 1 } : { ch: chapters[chOf(step)].id }), demo: step, ...(play ? { play: 1 } : {}) }).href;
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
      leave(topic.id, opts.all ? null : chapters[ch].id);
    }
    // Страница остаётся на учебных данных: выйти можно кнопкой в полосе режима
    function tryIt() {
      clear();
      panel.remove();
      Tour.at = [topic.id, chapters[ch].id];
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
    const q = new URLSearchParams(location.search), asked = q.get("tour"), cid = q.get("ch"), all = q.has("all");
    const hit = asked ? Tour.find(asked, all ? null : cid) : null, topic = hit?.topic;
    const app = document.querySelector(".app"), bar = make("div", "tour-mode");
    bar.setAttribute("role", "status");
    bar.append(make("span", "", `<b>${t("Учебные данные.")}</b> ${t("Настоящая система не меняется.")}`), button(t("Выйти из учебных данных"), "", () => leave(...(Tour.at || [topic?.id, null]))));
    app.classList.add("tour-on");
    app.prepend(bar);
    // Темы или главы с таким ID нет (удалена, другая версия, прежний номер) — показ не идёт; что есть — в каталоге раздела
    if (asked && (!topic || (!all && cid && !hit.chapter))) return missing();
    if (!topic) return;
    const raw = q.get("demo"), at = raw ? Number(raw) : NaN, last = topic.steps.length - 1, ch = hit.chapter;
    // Без номера шага — начало главы (темы). Шаг вне главы адреса — тоже начало главы: глава задаётся ID, номер шага только продолжает её
    const start = Number.isInteger(at) ? Math.max(0, Math.min(at, last)) : ch ? ch.from : 0;
    run(topic, ch && !all && (start < ch.from || start > ch.to) ? ch.from : start, { play: q.has("play") || q.get("demo") === "", all });
  };
  // Неизвестная тема или глава: панель с объяснением, страница остаётся на учебных данных, выход — в каталог раздела
  const missing = () => {
    const panel = make("div", "tour-panel");
    panel.id = "tourMissing";
    panel.setAttribute("role", "alert");
    const say = make("p", "tour-say");
    say.textContent = t("Такой главы нет в учебном каталоге этой консоли. Консоль не запустила показ. Главы, которые есть, показывает раздел «Обучение».");
    const btns = make("div", "tour-btns");
    btns.append(button(t("Открыть каталог"), "btn pri s", () => leave(null, null)));
    panel.append(make("p", "tour-ti", t("Глава не найдена")), say, btns);
    document.body.append(panel);
  };
  // SHA-256 строки в UTF-8, hex: отпечаток каталога. Свой, синхронный: crypto.subtle есть не на всяком адресе страницы (http не localhost)
  const sha256 = (text) => {
    const K = [], H = [], prime = (n) => { for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
    for (let n = 2, i = 0; i < 64; n++) if (prime(n)) {
      if (i < 8) H[i] = (Math.pow(n, 1 / 2) * 2 ** 32) | 0;
      K[i++] = (Math.pow(n, 1 / 3) * 2 ** 32) | 0;
    }
    const bytes = [...new TextEncoder().encode(text)], bits = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 255);
    const r = (x, n) => (x >>> n) | (x << (32 - n)), w = new Array(64);
    for (let o = 0; o < bytes.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
      }
      [a, b, c, d, e, f, g, h].forEach((x, i) => (H[i] = (H[i] + x) | 0));
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
  };
  const CATALOG_FORMAT = "consolem-learn-catalog/1";
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
    // ID темы и главы: латиница, цифры и «-»; «home» — первый экран раздела, не тема
    ID: /^[a-z][a-z0-9-]*$/,
    // Глава — «<тема>.<ch.id>». Глава или тема без ID (прототип со своими главами) получает ID по номеру с «_» и в каталог
    // (Tour.catalog) не входит: номер не устойчив
    add(topic) {
      const n = Tour.topics.length, tid = Tour.ID.test(topic.id || "") && topic.id !== "home" && !Tour.topics.some((x) => x.id === topic.id) ? topic.id : null;
      if (!tid) console.error(`Обучение: у темы «${topic.title}» нет устойчивого ID или он занят: ${topic.id}`);
      const id = tid || `_${n + 1}`, chapters = [];
      topic.steps.forEach((s, at) => {
        if (s.ch || !chapters.length) {
          const c = s.ch || { title: topic.title, why: topic.why }, own = tid && Tour.ID.test(c.id || "") && !chapters.some((x) => x.id === `${id}.${c.id}`);
          if (s.ch && tid && !own) console.error(`Обучение: у главы «${c.title}» темы ${id} нет устойчивого ID или он занят: ${c.id}`);
          chapters.push({ ...c, id: own ? `${id}.${c.id}` : `${id}._${chapters.length + 1}`, stable: !!own, from: at, to: at });
        }
        chapters[chapters.length - 1].to = at;
      });
      chapters.forEach((c) => (c.secs = secs(topic.steps.slice(c.from, c.to + 1))));
      Tour.topics.push({ ...topic, id, stable: !!tid, chapters, secs: secs(topic.steps) });
    },
    // Тема и глава по ID: {k, topic, c, chapter}; главы нет — chapter null. Тема не та — null. Номер — не ID
    find(tid, cid) {
      const k = Tour.topics.findIndex((x) => x.id === String(tid));
      if (k < 0) return null;
      const topic = Tour.topics[k], c = cid == null ? -1 : topic.chapters.findIndex((x) => x.id === String(cid));
      return { k, topic, c: c < 0 ? null : c, chapter: c < 0 ? null : topic.chapters[c] };
    },
    // Адрес показа: тема и глава по ID; без главы — вся тема подряд. Номер темы и главы этой страницы (прототипы зовут play(k, c))
    // переводится в ID здесь же: страница и показ — одна загрузка
    url(tid, cid, from) {
      const topic = typeof tid === "number" ? Tour.topics[tid] : Tour.find(tid)?.topic;
      const chapter = cid == null ? null : typeof cid === "number" ? topic?.chapters[cid] : Tour.find(tid, cid)?.chapter;
      if (!topic || (cid != null && !chapter)) return null;
      // Показ идёт на русском: шаги ищут элементы по русским подписям. Язык возвращается при выходе (learnFromHash в index.html)
      const lang = typeof uiLang !== "undefined" && uiLang !== "ru" ? { lang: uiLang } : {};
      // demo= пустой — учебный режим с начала главы: номер шага не нужен
      return urlFor({ tour: topic.id, ...(chapter ? { ch: chapter.id } : { all: 1 }), demo: "", play: 1, ...lang }, from).href;
    },
    // Запуск главы; без главы — вся тема подряд. Перезагрузка: показ идёт на чистых данных. Неизвестный ID — ничего
    play(tid, cid) {
      const href = Tour.url(tid, cid);
      if (href) location.href = href;
      return !!href;
    },
    /* Каталог готовых глав для UI и бэкенда VMS — из тех же тем, что исполняет показ, второй копии текстов нет.
       Тема и глава: id, title, goal (зачем, поле why источника), lang (язык показа; шаги ищут элементы по русским подписям — «ru»),
       fixture (учебный набор встроенного сервера). Шагов, before, селекторов и команд в каталоге нет. Главы прототипа без
       устойчивого ID (Tour.add) не входят. version — «sha256:» и SHA-256 строки JSON.stringify({format, topics}) с ключами
       в этом порядке: меняется при любой правке каталога (ID, порядок, название, цель, язык, набор), а не текста шагов.
       available — материал можно запустить в этой поставке: есть движок и сервер показа. Сборка без обучения
       (tools/build_webui.py --without-learn) кладёт файл с available:false и пустым topics. Файл сборки — learn-catalog.json,
       его пишет node tools/learn_catalog.mjs. Формат и место поставки — предложение: их утверждает владелец договора */
    catalog(opts) {
      const avail = opts && "available" in opts ? !!opts.available : Tour.lazy || typeof ConsolemServer !== "undefined";
      const topics = Tour.topics.filter((x) => x.stable).map((x) => {
        const lang = x.lang || "ru", fixture = x.fixture || "demo";
        return { id: x.id, title: x.title, goal: x.why, lang, fixture,
          chapters: x.chapters.filter((c) => c.stable).map((c) => ({ id: c.id, title: c.title, goal: c.why, lang: c.lang || lang, fixture: c.fixture || fixture })) };
      });
      return { format: CATALOG_FORMAT, version: "sha256:" + sha256(JSON.stringify({ format: CATALOG_FORMAT, topics })), available: avail, topics };
    },
    sha256,
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
