/* Сценарий интерфейса: экран ответа оператора (ADR-0093 доп. (9)). Колокольчик в шапке, панель, ответы настоящими
   событиями мыши, чужой ответ, срок, снятый запуск, «Только журнал», звук, отказ браузера в звуке, нет операции — нет
   колокольчика. Правила 70000010, 70000011 набора — роль «Администратор», та, что у вошедшего. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, sleep }) => {
  const ASK = "70000010-0000-4000-8000-000000000000", ESC = "70000011-0000-4000-8000-000000000000";
  const ADMIN = "80000001-0000-4000-8000-000000000000", GUARD_ROLE = "80000004-0000-4000-8000-000000000000";
  const el = (id) => document.getElementById(id);
  const press = (e) => ["mousedown", "mouseup", "click"].forEach((type) => e.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
  const esc = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const count = () => (el("promptCount").hidden ? 0 : Number(el("promptCount").textContent));
  const panel = () => el("promptPop").classList.contains("open");
  const open = () => { if (!panel()) press(el("promptBell")); };
  const row = (kind) => document.querySelector(`[data-prompt-kind="${kind}"]`);
  const btn = (r, a) => r.querySelector(`[data-prompt-answer="${a}"]`);
  const notes = () => [...document.querySelectorAll("[data-prompt-note]")].map((x) => x.textContent).join(" | ");
  const open0 = () => API.get("/rule-prompts").then((r) => r.items);
  const lastFire = async (id) => { const l = (await API.get(`/rules/${id}/fires`, { limit: 100 })).items; return l.slice().sort((a, b) => (a.at < b.at ? 1 : -1))[0]; };
  // Запуск кнопками формы: «Запустить сейчас» в карточке правила, подтверждение
  const runByForm = async (id) => {
    goApp("rules");
    ruleOpen(id);
    await until(() => document.querySelector('[data-fk="run"]'));
    press(document.querySelector('[data-fk="run"]'));
    await until(() => el("confirm").classList.contains("open"));
    press(el("confirmOk"));
  };
  const MAIL = { source: "ntf", action: "email", to: "a@object.local", subject: "Итог", body: "x" };
  const ruleSet = async (set, id = ASK) => API.post("/rules/update", { idempotencyKey: opKey(), items: [{ ruleId: id, version: (await API.get(`/rules/${id}`)).version, set }] });
  const ruleNew = (name, steps) => API.post("/rules", { name, enabled: true, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 60, windowSec: 0, runAt: null, repeat: "skip", triggers: [], conditions: [], allowChain: true, owner: "", purpose: "", serverId: null, runAsRoleId: null, steps });
  const ruleRun = (id) => API.post(`/rules/${id}/run`, { idempotencyKey: opKey() });
  const beeps = [];
  const fakeAudio = () => {
    window.AudioContext = class {
      constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createGain() { return { gain: {}, connect() {} }; }
      createOscillator() { return { frequency: {}, connect() {}, start() { beeps.push(1); }, stop() {} }; }
    };
    PROMPT.audio = null;
  };
  fakeAudio();

  // Шапка: виден, счётчика нет, на любом экране
  ok(el("hdBell").offsetParent !== null && !el("hdBell").hidden, "колокольчик виден");
  ok(await until(() => PROMPT.seen), "вопросы прочитаны после старта");
  ok(count() === 0, "вопросов нет — счётчика нет");
  ok(el("promptSound").offsetParent !== null, "рядом — выключение звука");
  ["hw", "rules", "acc", "log"].forEach((a) => { goApp(a); ok(el("promptBell").offsetParent !== null, `виден в разделе ${a}`); });
  goApp("hw");

  // Панель: мимо не закрывает, «Закрыть», Esc; с ассистентом — одна из двух
  press(el("promptBell"));
  ok(panel() && el("promptEmpty"), "панель открылась, вопросов нет — словами");
  ok(/Открытых вопросов нет/.test(el("promptPop").textContent), "слова панели");
  press(document.getElementById("main"));
  ok(panel(), "клик мимо не закрывает");
  press(el("promptClose"));
  ok(!panel(), "«Закрыть» закрывает");
  press(el("promptBell"));
  esc();
  ok(!panel(), "Esc закрывает");
  press(el("promptBell"));
  asstOpen("");
  ok(!panel() && !el("asstDock").hidden, "ассистент открылся — панель вопросов закрыта");
  const talk = asst;
  press(el("promptBell"));
  ok(panel() && el("asstDock").hidden && asst === talk, "вопросы открылись — ассистент скрыт, разговор на месте");
  press(el("hdAsst"));
  ok(!panel() && !el("asstDock").hidden && asst === talk, "кнопка «Ассистент» вернула ассистента, вопросы закрыты");
  asstClose();

  // Английские подписи: файл подписей разбирается, колокольчик и панель переведены
  ok(Object.keys(window.I18N_EN || {}).length > 1000, "английские подписи загружены");
  setUiLang("en");
  ok((el("promptBell").title||el("promptBell").dataset.tip) === "Operator questions" && (el("promptSound").title||el("promptSound").dataset.tip) === "Escalation sound is on", "английские подписи колокольчика");
  press(el("promptBell"));
  ok(/No open questions/.test(el("promptPop").textContent), "английские подписи панели");
  press(el("promptClose"));
  setUiLang("ru");
  ok((el("promptBell").title||el("promptBell").dataset.tip) === "Вопросы операторам", "русские вернулись");

  // ask: вопрос, счётчик виден с другого раздела, «Да», ветка пошла дальше. Звука нет
  await runByForm(ASK);
  ok(await until(() => count() === 1), "запуск кнопкой формы поднял вопрос: счётчик 1");
  ok((await lastFire(ASK)).result === "waiting", "запуск ждёт ответа");
  ok(beeps.length === 0, "ask без звука");
  goApp("hw");
  ok(count() === 1, "счётчик виден с другого раздела");
  press(el("promptBell"));
  const r1 = row("ask");
  ok(/Проверка: оператор на месте\?/.test(r1.textContent), "текст вопроса");
  ok(/Вопрос оператору: проверка/.test(r1.textContent), "правило");
  ok(/^[12]:\d\d$/.test(r1.querySelector("[data-prompt-left]").textContent), "таймер: " + r1.querySelector("[data-prompt-left]").textContent);
  ok(btn(r1, "yes") && btn(r1, "no") && !btn(r1, "ack"), "у ask «Да», «Нет»");
  ok(btn(r1, "yes").textContent === "Да" && btn(r1, "no").textContent === "Нет", "подписи кнопок");
  press(btn(r1, "yes"));
  ok(await until(() => !row("ask") && count() === 0), "ответ принят: строка снята, счётчика нет");
  ok(/Ответ принят: Да/.test(notes()), "словами: " + notes());
  ok((await open0()).length === 0, "на сервере вопроса нет");
  let f = await lastFire(ASK);
  ok(f.result !== "waiting" && f.steps.some((s) => s.state === "ok" && s.path === "0.yes.0") , "ветка «Да» пошла дальше: " + f.result + " " + f.steps.map((s) => `${s.path}:${s.state}`).join(","));
  ok(panel(), "панель осталась открытой");
  esc();

  // «Нет» — другая ветка
  await runByForm(ASK);
  ok(await until(() => count() === 1), "второй вопрос");
  open();
  press(btn(row("ask"), "no"));
  ok(await until(() => !row("ask")), "«Нет» принят");
  f = await lastFire(ASK);
  ok(f.steps.some((s) => s.state === "ok" && s.path === "0.no.0"), "ветка «Нет»: " + f.steps.map((s) => `${s.path}:${s.state}`).join(","));
  esc();

  // escalate: звук один раз, «Квитировать», запуск идёт дальше
  await runByForm(ESC);
  ok(await until(() => count() === 1), "эскалация: счётчик 1");
  ok(await until(() => beeps.length === 1), "escalate со звуком");
  open();
  const r2 = row("escalate");
  ok(/Эскалация, уровень 1/.test(r2.textContent) && /Эскалация оператору: проверка/.test(r2.textContent), "текст уровня, правило");
  ok(btn(r2, "ack")?.textContent === "Квитировать" && !btn(r2, "yes"), "у escalate «Квитировать»");
  press(btn(r2, "ack"));
  ok(await until(() => !row("escalate") && count() === 0), "квитировано, строка снята");
  ok(/Ответ принят: Квитировано/.test(notes()), "словами: " + notes());
  f = await lastFire(ESC);
  ok(f.result !== "waiting" && f.steps.some((s) => s.state === "ok" && s.path === "1"), "запуск пошёл дальше: " + f.steps.map((s) => `${s.path}:${s.state}`).join(","));
  esc();

  // Выключение звука, настройка переживает перезагрузку
  press(el("promptSound"));
  ok(localStorage.getItem("consolem-prompt-sound") === "off" && el("promptSound").getAttribute("aria-pressed") === "false", "звук выключен, настройка записана");
  await runByForm(ESC);
  ok(await until(() => count() === 1), "эскалация при выключенном звуке");
  await sleep(50);
  ok(beeps.length === 1, "выключено — тихо");
  await API.post((await open0()).map((p) => `/rule-prompts/${p.id}/answer`)[0], { answer: "ack" });
  ok(await until(() => count() === 0), "квитировано");
  press(el("promptSound"));
  ok(localStorage.getItem("consolem-prompt-sound") === null, "звук включён, настройка снята");

  // Браузер запретил звук: работа идёт. Конструктор бросает; контекст стоит, а resume отказывает
  window.AudioContext = class { constructor() { throw new Error("запрет"); } };
  PROMPT.audio = null;
  await runByForm(ESC);
  ok(await until(() => count() === 1), "конструктор звука бросил: вопрос на месте");
  await API.post((await open0()).map((p) => `/rule-prompts/${p.id}/answer`)[0], { answer: "ack" });
  ok(await until(() => count() === 0), "и закрыт");
  window.AudioContext = class { constructor() { this.state = "suspended"; } resume() { return Promise.reject(new Error("нет жеста")); } };
  PROMPT.audio = null;
  await runByForm(ESC);
  ok(await until(() => count() === 1), "resume отказал: вопрос на месте");
  await API.post((await open0()).map((p) => `/rule-prompts/${p.id}/answer`)[0], { answer: "ack" });
  ok(await until(() => count() === 0), "и закрыт");
  // Хранилище недоступно: выключение действует до конца вкладки, исключения нет
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new Error("запрет"); };
  press(el("promptSound"));
  ok(PROMPT.mute === true && el("promptSound").getAttribute("aria-pressed") === "false", "хранилище отказало: выключено на вкладку");
  Storage.prototype.setItem = setItem;
  press(el("promptSound"));
  fakeAudio();

  // Чужой ответ пришёл потоком: строка снимается, слова — кто ответил
  await runByForm(ASK);
  ok(await until(() => count() === 1), "вопрос для чужого ответа");
  open();
  await API.post(`/rule-prompts/${row("ask").dataset.prompt}/answer`, { answer: "no" });
  ok(await until(() => !row("ask")), "ответ другого: строка снята");
  ok(/Ответил другой оператор \(root\): Нет/.test(notes()), "словами: " + notes());
  esc();

  // Поток опоздал: нажатие приходит на закрытый вопрос. 409 BUSY — слово, строка снимается
  const event = window.promptEvent;
  await runByForm(ASK);
  ok(await until(() => count() === 1), "вопрос для 409 BUSY");
  open();
  window.promptEvent = () => {};
  await API.post(`/rule-prompts/${row("ask").dataset.prompt}/answer`, { answer: "yes" });
  press(btn(row("ask"), "yes"));
  ok(await until(() => !row("ask")), "409 BUSY: строка снята");
  ok(/уже ответил другой оператор: ваш ответ не засчитан|Другой оператор уже ответил на вопрос\. Консоль не учла ваш ответ/.test(notes()), "словами: " + notes());
  window.promptEvent = event;
  esc();

  // 404: запуск снят, поток опоздал
  await runByForm(ASK);
  ok(await until(() => count() === 1), "вопрос для 404");
  open();
  window.promptEvent = () => {};
  const rule = await API.get(`/rules/${ASK}`);
  await ruleSet({ enabled: false });
  ok((await open0()).length === 0, "выключение сняло запуск");
  press(btn(row("ask"), "yes"));
  ok(await until(() => !row("ask")), "404: строка снята");
  ok(/Запуск снят: вопрос больше не действует|Запуск отменён\. Вопрос больше не действует/.test(notes()), "словами: " + notes());
  window.promptEvent = event;
  await ruleSet({ enabled: true });
  ok(rule.enabled, "правило возвращено");
  esc();
  ok(await until(() => rules.find((x) => x.id === ASK).on), "и в форме включено");

  // Запуск снят потоком: те же слова
  await runByForm(ASK);
  ok(await until(() => count() === 1), "вопрос для снятия потоком");
  open();
  await ruleSet({ enabled: false });
  ok(await until(() => !row("ask")), "снят потоком: строка ушла");
  ok(/Запуск снят|Запуск отменён/.test(notes()), "словами: " + notes());
  await ruleSet({ enabled: true });
  ok(await until(() => rules.find((x) => x.id === ASK).on), "правило включено снова");
  esc();

  // Срок вышел, сервер закрыл: строка уходит, ветка default. Встроенный сервер часов не двигает, срок настоящий, две секунды.
  // Свой счёт на это время остановлен: проверяется prompt.closed
  const SHORT = (await ruleNew("Короткий вопрос", [{ control: "ask", text: "Успеете?", roleId: ADMIN, sec: 2, default: "no", yes: [], no: [MAIL] }])).id;
  await ruleRun(SHORT);
  ok(await until(() => count() === 1), "вопрос для срока");
  open();
  clearInterval(PROMPT.timer);
  ok(await until(() => !row("ask") && count() === 0), "срок вышел: строка ушла");
  ok(/Срок вышел: правило пошло веткой по умолчанию|Срок истёк\. Правило выполнило ветку по умолчанию/.test(notes()), "словами: " + notes());
  f = await lastFire(SHORT);
  ok(f.steps.some((s) => s.path === "0.no.0"), "ветка по умолчанию: " + f.steps.map((s) => s.path).join(","));
  esc();

  // Таймер считает сам, по часам сервера: срок вышел раньше события, строка уходит без запроса
  await runByForm(ASK);
  ok(await until(() => count() === 1), "вопрос для своего счёта");
  open();
  const spy = API.get;
  let reads = 0;
  API.get = (p, q) => { if (p === "/rule-prompts") reads++; return spy(p, q); };
  const skew = PROMPT.skew, id0 = row("ask").dataset.prompt;
  const left0 = row("ask").querySelector("[data-prompt-left]").textContent;
  PROMPT.skew = skew + 90000;
  ok(await until(() => row("ask")?.querySelector("[data-prompt-left]").textContent !== left0), `таймер считает: ${left0} → ${row("ask")?.querySelector("[data-prompt-left]").textContent}`);
  PROMPT.skew = skew + 130000;
  ok(await until(() => !row("ask")), "до конца срока досчитал сам: строка ушла");
  ok(/Срок вышел|Срок истёк/.test(notes()), "словами: " + notes());
  ok(reads === 0, "списка никто не перечитывал: опроса нет");
  API.get = spy;
  PROMPT.skew = skew;
  await API.post(`/rule-prompts/${id0}/answer`, { answer: "no" });
  esc();

  // 409 NOT_RUNNABLE: срок вышел, поток опоздал, своего счёта нет
  await ruleRun(SHORT);
  ok(await until(() => count() === 1), "вопрос для 409 NOT_RUNNABLE");
  open();
  clearInterval(PROMPT.timer);
  window.promptEvent = () => {};
  await sleep(2200);
  ok(!(await open0()).length, "на сервере срок вышел");
  press(btn(row("ask"), "yes"));
  ok(await until(() => !row("ask")), "409 NOT_RUNNABLE: строка снята");
  ok(/Срок вышел: ответ не действует|Срок истёк\. Ответ не действует/.test(notes()), "словами: " + notes());
  window.promptEvent = event;
  esc();

  // Вопрос чужой роли: без кнопок, словами, в счётчик не идёт
  const GUARD = (await ruleNew("Вопрос охране", [{ control: "ask", text: "Охрана, на месте?", roleId: GUARD_ROLE, sec: 60, default: "no", yes: [MAIL], no: [] }])).id;
  ok(await until(() => rules.some((x) => x.id === GUARD)), "правило пришло потоком");
  await ruleRun(GUARD);
  ok(await until(() => PROMPT.list.length === 1), "вопрос роли «Охрана»");
  ok(count() === 0, "в счётчик не идёт");
  open();
  const r3 = row("ask");
  ok(/Отвечает роль «Охрана»: у вас её нет/.test(r3.textContent), "словами: " + r3.textContent.replace(/\s+/g, " "));
  ok(!btn(r3, "yes") && !btn(r3, "no"), "кнопок нет");
  ok(/Вопрос охране/.test(row("ask").textContent), "правило видно");
  await ruleSet({ enabled: false }, GUARD);
  ok(await until(() => !row("ask")), "запуск снят, строка ушла");
  esc();

  // Эскалация: уровень чужой роли без звука, свой — со звуком, строка на уровень, квитирование снимает все, слово одно
  const made = await ruleNew("Две роли", [{ control: "escalate", levels: [{ roleId: GUARD_ROLE, via: "client", waitMin: 1 }, { roleId: ADMIN, via: "client", waitMin: 1 }], stop: "ack" }, MAIL]);
  const b0 = beeps.length;
  await ruleRun(made.id);
  ok(await until(() => PROMPT.list.length === 1), "первый уровень — чужая роль");
  await sleep(50);
  ok(beeps.length === b0 && count() === 0, "чужой уровень не звенит и в счётчик не идёт");
  // Первый уровень стоит минуту: срок настоящий, меньше нельзя
  ok(await until(() => PROMPT.list.length === 2 && count() === 1, 90000), "второй уровень — свой, первый открыт");
  ok(await until(() => beeps.length === b0 + 1), "свой уровень звенит");
  open();
  const rows = document.querySelectorAll('[data-prompt-kind="escalate"]');
  ok(rows.length === 2 && rows[0].querySelector("[data-prompt-other]") && btn(rows[1], "ack"), "две строки: чужая без кнопки, своя с кнопкой");
  press(btn(rows[1], "ack"));
  ok(await until(() => !row("escalate") && PROMPT.list.length === 0), "квитирование сняло оба уровня");
  ok(document.querySelectorAll("[data-prompt-note]").length === 1, "слово одно: " + notes());
  esc();

  // «Только журнал» не поднимает вопроса: ни в списке, ни в счётчике, запуск идёт сроком
  const n0 = PROMPT.seq;
  await ruleSet({ logOnly: true });
  ok(await until(() => rules.find((x) => x.id === ASK).watch), "правило в «Только журнал»");
  await runByForm(ASK);
  await sleep(100);
  ok((await lastFire(ASK)).result === "waiting" && (await open0()).length === 0, "запуск ждёт срока, вопроса нет");
  ok(count() === 0 && PROMPT.list.length === 0 && PROMPT.seq === n0, "ни строки, ни счётчика, потоком ничего не пришло");
  await ruleSet({ logOnly: false });

  // Потеря потока: список перечитан
  await ruleRun(ESC);
  ok(await until(() => count() === 1), "вопрос перед потерей потока");
  PROMPT.list = [];
  apiOnEvent({ type: "stream.reset" });
  ok(await until(() => count() === 1 && PROMPT.list.length === 1), "stream.reset: список перечитан");
  await API.post((await open0()).map((p) => `/rule-prompts/${p.id}/answer`)[0], { answer: "ack" });
  ok(await until(() => count() === 0), "закрыт");

  // Операция не объявлена: колокольчика нет, запросов нет, поток не трогает
  CAPS.operations.delete("listRulePrompts");
  promptsMount();
  const rd = API.get;
  let asked = 0;
  API.get = (p, q) => { if (p === "/rule-prompts") asked++; return rd(p, q); };
  ok(el("hdBell").hidden && el("hdBell").offsetParent === null, "нет операции — нет колокольчика");
  await promptsLoad();
  apiOnEvent({ type: "prompt.opened", kind: "rulePrompt", entityId: "x", payload: {} });
  await sleep(20);
  ok(asked === 0, "нет операции — нет запросов");
  API.get = rd;
  CAPS.operations.add("listRulePrompts");
  promptsMount();
  ok(!el("hdBell").hidden, "операция вернулась — колокольчик на месте");
});
