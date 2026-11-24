/* Сценарий интерфейса: чат ассистента в своей панели. Запуск — tools/check_ui.py tests/ui-chat.js */
UiCheck(async ({ ok, until }) => {
  const el = (id) => document.getElementById(id);
  const btn = () => el("hdAsst");
  const dock = () => el("asstDock");
  const store = () => localStorage.getItem(ASST_STORE) || "";
  const say = (t) => { asst.text = t; asstSendText(); };
  // Ход держим открытым: так видно, что он переживает закрытие панели и другой разговор
  const realStream = API.stream;
  let gates = [];
  const hold = () => { API.stream = function (...args) { return new Promise((r) => gates.push(r)).then(() => realStream.apply(API, args)); }; };
  const free = () => { API.stream = realStream; gates.splice(0).forEach((r) => r()); };
  localStorage.removeItem(ASST_STORE);
  localStorage.removeItem(ASST_VAR_KEY);
  localStorage.removeItem(ASST_W_KEY);
  // В самопроверке хранилище общее: страница уже прочла разговоры соседнего сценария
  asstChats = [];
  asst = null;
  asstRender();
  goApp("hw");

  // Кнопка всегда на месте, панель закрыта
  ok(btn() && btn().textContent.trim() === "Ассистент", "кнопка «Ассистент» в шапке");
  ok(dock().hidden, "панель закрыта");
  ok(!document.querySelector("#gopop #asstBlock"), "разговора нет в окне поиска");

  // Enter в поиске при ассистенте — новый разговор, что бы ни нашёл поиск (слово владельца, 3ed4962)
  const inp = el("gq");
  inp.focus();
  inp.value = "камера";
  goInput(inp.value);
  const askRow = el("goAsk");
  ok(askRow && askRow === document.querySelector("#goList .gores"), "строка ассистента — первая в списке");
  ok(/Спросить ассистента/.test(askRow.textContent) && /камера/.test(askRow.textContent), "строка говорит, что случится и с каким текстом");
  goKey({ key: "Enter", target: inp, preventDefault() {} });
  ok(asstChats.length === 1 && !dock().hidden, "Enter начал разговор и открыл панель");
  ok(inp.value === "" && treeQ === "", "Enter снял запрос поиска");
  // Разговор «камера» ждёт ответа человека, а «Ждёт ответа» на кнопке важнее «Готов ответ»: дальше он мешает, убираем
  const camChat = asst;
  asstChats = [];
  asst = null;
  asstRender();

  // Выбор строки: новый разговор, запрос поиска снят
  inp.value = "сколько камер";
  goInput(inp.value);
  hold();
  goPick(0);
  ok(asstChats.length === 1 && asst && asst !== camChat && !dock().hidden, "выбор строки открыл панель с новым разговором");
  ok(inp.value === "" && treeQ === "", "запрос поиска снят");
  ok(el("asstBlock").textContent.includes("сколько камер"), "просьба в ленте");
  ok(btn().classList.contains("run") && /Отвечает/.test(btn().textContent), "кнопка: отвечает");

  // Закрытие не снимает ход, о готовности говорит кнопка
  const first = asst;
  asstClose();
  ok(dock().hidden && first.busy && !first.abort.signal.aborted, "закрытие не снимает ход");
  free();
  ok(await until(() => !first.busy), "ход закончился при закрытой панели");
  ok(first.answer && first.unread, "ответ получен и ждёт человека");
  ok(btn().classList.contains("ready") && /Готов ответ/.test(btn().textContent), "кнопка: готов ответ");
  ok(/Готов ответ/.test(el("asstLive").textContent) && el("asstLive").getAttribute("role") === "status", "статус для экранного диктора");
  ok(document.activeElement !== el("asstText"), "ответ не забирает фокус");
  asstToggle();
  ok(!dock().hidden && asst === first && !first.unread, "кнопка открывает готовый ответ");
  ok(el("asstAnswer")?.textContent === first.answer, "ответ виден");
  ok(btn().textContent.trim() === "Ассистент", "прочитано: кнопка в покое");

  // История: прежний ответ не пропадает при новом ходе
  const answer1 = first.answer;
  say("а серверов сколько");
  ok(await until(() => !first.busy), "второй ход закончился");
  const thread = el("asstBlock").textContent;
  ok(thread.includes(answer1) && thread.includes("сколько камер") && thread.includes("а серверов сколько"), "лента хранит все реплики и прежний ответ");

  // Новый разговор при идущем ходе: прежний продолжается и остаётся в истории
  hold();
  say("долгий вопрос");
  ok(first.busy, "ход первого разговора идёт");
  asstNewPress();
  const second = asst;
  ok(second !== first && asstChats.includes(first) && first.busy && !first.abort.signal.aborted, "новый разговор не снимает прежний");
  say("второй разговор");
  asstHistToggle();
  const rows = () => [...el("asstBlock").querySelectorAll(".asst-hrow")];
  ok(rows().length === 2 && el("asstFoot").hidden, "список разговоров из двух строк");
  ok(rows().every((r) => /отвечает/.test(r.textContent)), "в списке видно, что оба идут");
  free();
  ok(await until(() => !first.busy && !second.busy), "оба хода закончились");
  ok(rows().some((r) => /готов ответ/.test(r.textContent)), "в списке видно готовый ответ");
  ok(second.unread, "ответ при открытом списке не считается прочитанным");
  asstSwitch(first.id);
  ok(asst === first && el("asstBlock").textContent.includes("долгий вопрос"), "переход к прежнему разговору");

  // Сохранение: пароль и его контекст не пишутся
  asstOpen("");
  const secretChat = asst;
  secretChat.secrets = ["S3cret-value"];
  say("задай пароль Qwerty123 на камере");
  ok(await until(() => !secretChat.busy), "ход с секретом закончился");
  const saved = store();
  ok(saved && !saved.includes("S3cret-value") && !saved.includes("Qwerty123"), "пароль не сохранён");
  ok(JSON.parse(saved).find((c) => c.id === secretChat.id).context === null, "контекст такого разговора не сохранён");
  ok(JSON.parse(saved).find((c) => c.id === first.id).log.length >= 4, "обычный разговор сохранён");

  // Панель вопросов лежит под панелью ассистента: на экране одна из двух, разговор на месте
  const chatNow = asst;
  ok(asstDockOpen, "панель ассистента открыта");
  promptPanel(true);
  ok(PROMPT.open && dock().hidden && asst === chatNow, "вопросы открылись — ассистент скрыт, разговор на месте");
  asstToggle();
  ok(!PROMPT.open && !dock().hidden, "кнопка вернула ассистента, вопросы закрыты");
  promptPanel(true);
  asstOpen("");
  ok(!PROMPT.open && !dock().hidden, "новый разговор закрыл вопросы");

  // Разговор о пароле: значение не сохраняется ни в одной реплике, ни после перезагрузки
  const savedOf = (a) => JSON.parse(store()).find((c) => c.id === a.id);
  asstOpen("");
  const talk = asst;
  say("поставь Abcde777 на камеру");
  ok(await until(() => !talk.busy), "первая реплика без слова «пароль»");
  ok(store().includes("Abcde777"), "пока о пароле речи нет, реплика в истории");
  say("это пароль");
  ok(await until(() => !talk.busy), "вторая реплика о пароле");
  say("Zxcvb999");
  ok(await until(() => !talk.busy), "следующая реплика того же разговора");
  ok(!/Abcde777|Zxcvb999/.test(store()), "ни прежняя, ни следующая реплика не сохранены");
  ok(savedOf(talk).noStore && savedOf(talk).title !== talk.title && savedOf(talk).context === null, "заголовка и контекста нет, признак сохранён");
  asstOpen("");
  const asked = asst;
  say("сколько камер");
  ok(await until(() => !asked.busy), "ход перед вопросом");
  asked.ask = "Какой пароль задать?";
  asstSave();
  ok(savedOf(asked).noStore, "вопрос о пароле: разговор не сохраняется");
  asked.ask = "";

  // Вопрос ассистента переживает перезагрузку и остаётся вопросом
  asstOpen("");
  const q = asst;
  say("сколько камер");
  ok(await until(() => !q.busy), "ход перед обычным вопросом");
  q.ask = "На какой камере?";
  q.answer = "";
  q.context = "stub:вопрос";
  q.ctxLive = false;
  q.unread = true;
  asstSave();
  const keepChats = asstChats, keepAsst = asst;
  asstChats = [];
  asstLoad();
  const restored = asstChats.find((c) => c.id === q.id);
  ok(restored.ask === "На какой камере?" && !restored.log.some((x) => x.k === "ask"), "вопрос восстановлен один раз");
  ok(asstState(restored)[0] === "wait", "кнопка: ждёт ответа");
  asstChats = keepChats;
  asst = keepAsst;
  q.ask = "";
  q.unread = false;

  // Контекст заглушки службе не уходит
  const realMode = window.asstMode, realTurn = window.asstServiceTurn;
  let sent = null;
  window.asstMode = () => "on";
  window.asstServiceTurn = (a, body) => { sent = body; return Promise.resolve(); };
  say("Главный вход");
  ok(sent && !("context" in sent), "контекст другого режима не ушёл");
  window.asstMode = realMode;
  window.asstServiceTurn = realTurn;
  ok(await until(() => !q.busy), "ход закончился");

  // Ход другого разговора не уводит курсор и не трогает дерево
  asstOpen("");
  const focused = asst;
  asstSecretAdd();
  const secretInput = document.querySelector("#asstActs input[type=password]");
  secretInput.focus();
  asstEvent(first, { type: "progress", text: "читаю" });
  ok(document.activeElement === secretInput, "строка хода другого разговора оставила курсор в поле секрета");
  focused.secrets = [];
  asstRender();
  document.activeElement.blur();
  asstEvent(first, { type: "progress", text: "читаю" });
  ok(document.activeElement === document.body, "пустой фокус панель не забирает");
  first.line = "";

  // Открытый список разговоров: ответ не считается увиденным, дерево не трогаем
  asstOpen("");
  const listed = asst;
  asstHistToggle();
  asstEvent(listed, { type: "found", text: "отбор", ids: [], total: 0, conditions: [] });
  ok(listed.found && !asstPick, "при открытом списке отбор не ушёл в дерево");
  ok(document.getElementById("asstHistBtn"), "кнопка списка на месте");
  document.getElementById("asstHistBtn").focus();
  asstRender();
  ok(document.activeElement.id === "asstHistBtn", "фокус не теряется");
  asstHistToggle();

  // Что снято с экрана, остаётся в ленте
  asstOpen("");
  const held = asst;
  say("сколько камер");
  ok(await until(() => !held.busy && held.answer), "ответ получен");
  const heldAnswer = held.answer;
  asstHoldSecret(held);
  ok(el("asstBlock").textContent.includes(heldAnswer) && held.err, "отказ в пароле не стёр прежний ответ");
  held.err = "";
  held.answer = "прежний ответ";
  asstModeChanged(held);
  asstRender();
  ok(el("asstBlock").textContent.includes("прежний ответ"), "смена режима не стёрла ответ");

  // Стрелки на краю панели не ведут по дереву
  let reached = 0;
  const count = () => { reached += 1; };
  document.addEventListener("keydown", count);
  el("asstGrip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  document.removeEventListener("keydown", count);
  ok(reached === 0, "стрелка осталась на краю панели");
  asstWidthSet(400, true);

  // Щелчок по тексту панели оставляет фокус в ней: Esc закрывает панель, а не выбор в дереве
  ok(dock().tabIndex === -1, "панель принимает фокус при щелчке");
  dock().focus();
  ok(!!document.activeElement.closest("#asstDock"), "фокус в панели");

  // Плашка черновика детектора не закрывает кнопку панели
  const bar = document.createElement("div");
  bar.className = "dc-dock";
  document.body.append(bar);
  asstVariantSet("side");
  if (innerWidth > 860) ok(parseFloat(getComputedStyle(bar).right) >= asstWidth, "плашка левее панели");
  ok(+getComputedStyle(dock()).zIndex > +getComputedStyle(bar).zIndex, "панель над плашкой");
  bar.remove();

  // Голос: подставное распознавание. Текст приходит в поле, отправляет человек
  const RealRec = window.SpeechRecognition, RealWk = window.webkitSpeechRecognition;
  let recs = [];
  class FakeRec {
    constructor() { recs.push(this); this.started = false; this.stopped = false; this.aborted = false; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    say(t, isFinal) { const r = [{ transcript: t }]; r.isFinal = isFinal; this.onresult({ results: [r] }); }
  }
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
  asstOpen("");
  const voice = asst;
  ok(el("asstMicBtn").disabled && /не распознаёт/.test((el("asstMicBtn").title||el("asstMicBtn").dataset.tip)), "браузер без распознавания: кнопка выключена, причина названа");
  window.SpeechRecognition = FakeRec;
  asstRender();
  ok(!el("asstMicBtn").disabled, "браузер с распознаванием: кнопка работает");
  voice.text = "камера:";
  asstRender();
  el("asstMicBtn").click();
  const rec1 = recs[0];
  ok(rec1?.started && el("asstMicBtn").getAttribute("aria-pressed") === "true" && el("asstText").placeholder === "Говорите…", "микрофон включён и это видно");
  rec1.say("главный вход", false);
  ok(el("asstText").value === "камера: главный вход" && voice.text === el("asstText").value, "распознанное в поле, к уже написанному");
  ok(!voice.log.length && !voice.busy, "голос сам не отправляет");
  el("asstMicBtn").click();
  ok(rec1.stopped && asstMic, "выключение ждёт последний итог");
  rec1.say("главный вход сервер", true);
  ok(el("asstText").value === "камера: главный вход сервер", "последний итог дошёл");
  rec1.onend();
  ok(!asstMic && el("asstMicBtn").getAttribute("aria-pressed") === "false", "микрофон выключен");
  // Закрытие, список и другой разговор выключают микрофон
  el("asstMicBtn").click();
  const rec2 = recs[1];
  asstClose();
  ok(rec2.stopped, "закрытие панели выключило микрофон");
  rec2.onend();
  asstToggle();
  asst = voice;
  asstRender();
  el("asstMicBtn").click();
  const rec3 = recs[2];
  asstHistToggle();
  ok(rec3.stopped, "список разговоров выключил микрофон");
  rec3.onend();
  asstHistToggle();
  el("asstMicBtn").click();
  const rec4 = recs[3];
  asstNewPress();
  ok(rec4.stopped, "новый разговор выключил микрофон");
  rec4.say("поздний итог", true);
  ok(voice.text.includes("поздний итог") && !asst.text.includes("поздний итог"), "поздний итог не попал в другой разговор");
  rec4.onend();
  // Отправка и ввод руками: поздний итог поле не переписывает
  asstSwitch(voice.id);
  el("asstMicBtn").click();
  const rec5 = recs[4];
  voice.text = "сколько камер";
  asstSendText();
  ok(rec5.aborted && !asstMic, "отправка сняла микрофон");
  rec5.say("поздний итог после отправки", true);
  ok(voice.text === "", "поздний итог не лёг в поле после отправки");
  ok(await until(() => !voice.busy), "ход после голоса закончился");
  el("asstMicBtn").click();
  const rec6 = recs[5];
  asstInput("пишу руками");
  ok(rec6.aborted && !asstMic && voice.text === "пишу руками", "ввод руками снял микрофон");
  voice.text = "";
  // Отказ браузера словами
  el("asstMicBtn").click();
  const rec7 = recs[6];
  rec7.onerror({ error: "not-allowed" });
  ok(/не дал доступ|не разрешил доступ/.test(el("tt").textContent), "отказ в микрофоне назван");
  rec7.onend();
  el("asstMicBtn").click();
  const rec8 = recs[7];
  rec8.onerror({ error: "no-speech" });
  ok(/не услышана|не услышал речь/.test(el("tt").textContent), "тишина названа");
  rec8.onend();
  // Отказ в пароле в службу снимает микрофон: просьба не возвращается в поле
  const modeWas = window.asstMode;
  window.asstMode = () => "on";
  el("asstMicBtn").click();
  const rec9 = recs[8];
  rec9.say("задай пароль на камере", false);
  asstSendText();
  ok(rec9.aborted && !asstMic && voice.text === "", "отказ в пароле снял микрофон");
  rec9.say("задай пароль на камере", true);
  ok(voice.text === "", "просьба о пароле не вернулась в поле");
  window.asstMode = modeWas;
  voice.err = "";
  // Панель вопросов, смена разговора: красная кнопка только у слушающего разговора
  asstRender();
  el("asstMicBtn").click();
  const rec10 = recs[9];
  promptPanel(true);
  ok(rec10.stopped, "панель вопросов выключила микрофон");
  promptPanel(false);
  asstToggle();
  ok(el("asstMicBtn").getAttribute("aria-pressed") === "false", "пока микрофон договаривает, кнопка не красная");
  el("asstMicBtn").click();
  ok(rec10.aborted && recs[10]?.started, "повторное нажатие начинает заново");
  recs[10].abort();
  asstMicDrop();
  window.SpeechRecognition = RealRec;
  window.webkitSpeechRecognition = RealWk;

  // Файлы: добавить, снять, отправить. Содержимое никуда не уходит
  asstOpen("");
  const filed = asst;
  const big = new File(["x"], "big.bin");
  Object.defineProperty(big, "size", { value: 11 * 1048576 });
  const evil = "<img src=x onerror=window.__x=1><b>x</b>.log";
  asstFileAdd([new File(["abc"], evil), new File(["abc"], evil), big]);
  ok(filed.files.length === 1, "повтор и слишком большой файл не добавлены");
  ok(el("asstFiles").textContent.includes(evil) && !el("asstFiles").querySelector("img, b"), "имя показано как текст");
  el("asstFiles").querySelector("button").click();
  ok(!filed.files.length && el("asstFiles").children.length === 0 && document.activeElement.id === "asstFilePress", "файл снят, фокус на скрепке");
  asstFileAdd([1, 2, 3, 4, 5, 6].map((i) => new File(["abc"], `f${i}.txt`)));
  ok(filed.files.length === ASST_FILE_MAX, "не больше пяти файлов");
  filed.files.splice(1);
  filed.files.push({ name: evil, size: 3 });
  asstRender();
  const streamReal = API.stream;
  let turnBody = null;
  API.stream = (p, b, ...r) => { turnBody = b; return streamReal.call(API, p, b, ...r); };
  filed.text = "сколько камер";
  asstSendText();
  API.stream = streamReal;
  ok(turnBody && Object.keys(turnBody).join() === "text", "в ход ушёл только контрактный текст");
  ok(!filed.files.length && !el("asstFiles").children.length, "поле файлов очищено");
  ok(el("asstBlock").querySelector(".asst-u-files .asst-file")?.textContent.includes("f1.txt"), "имя файла в ленте");
  ok(el("asstBlock").textContent.includes(evil) && !el("asstBlock").querySelector(".asst-u-files img, .asst-u-files b"), "в ленте имя тоже текст");
  ok(/файлы ему не ушли|не отправила ему файлы/.test(el("asstBlock").textContent), "лента честно говорит, что файл не ушёл");
  ok(await until(() => !filed.busy), "ход с файлом закончился");
  ok(savedOf(filed).log.some((x) => x.files?.[0]?.name === "f1.txt"), "имя файла в истории");
  // Черновик с файлом виден в списке разговоров и открывается
  asstOpen("");
  const draft = asst;
  asstFileAdd([new File(["abc"], "draft.txt")]);
  asstOpen("");
  const draftRow = () => [...el("asstBlock").querySelectorAll(".asst-hrow")].find((r) => r.dataset.asstChat === draft.id);
  asstHistToggle();
  ok(draftRow(), "черновик с файлом в списке");
  draftRow().click();
  ok(asst === draft && el("asstFiles").textContent.includes("draft.txt"), "черновик открылся с файлом");
  draft.files = [];
  // Имя файла о пароле: разговор не сохраняется, как и текст о пароле
  asstOpen("");
  const passFile = asst;
  asstFileAdd([new File(["abc"], "пароли-камер.xlsx")]);
  passFile.text = "сколько камер";
  asstSendText();
  ok(await until(() => !passFile.busy), "ход с файлом о паролях закончился");
  ok(!store().includes("пароли-камер") && savedOf(passFile).noStore, "имя файла о паролях не сохранено");
  asstOpen("");
  asst.text = "x";
  asstSendText();
  ok(await until(() => !asst.busy), "ещё один разговор для перетаскивания");
  asst.text = "";
  // Файл мимо панели не уводит страницу
  const outsideDt = new DataTransfer();
  outsideDt.items.add(new File(["abc"], "out.txt"));
  const outDrop = new DragEvent("drop", { dataTransfer: outsideDt, bubbles: true, cancelable: true });
  el("main").dispatchEvent(outDrop);
  ok(outDrop.defaultPrevented, "файл мимо панели браузер не откроет");
  const filed2 = asst;
  // Перетаскивание
  const dt = new DataTransfer();
  dt.items.add(new File(["abc"], "drop.txt"));
  const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
  dock().dispatchEvent(over);
  ok(over.defaultPrevented && dock().classList.contains("asst-drop"), "панель принимает перетаскивание");
  dock().dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  ok(!dock().classList.contains("asst-drop") && filed2.files[0]?.name === "drop.txt", "файл перетащен на панель");
  filed2.files = [];
  asstRender();

  // Положение и ширина
  const oldW = asstWidth;
  asstVariantSet("side");
  ok(dock().dataset.variant === "side" && el("ws").classList.contains("asst-side"), "«Рядом» сужает рабочую область");
  asstVariantSet("over");
  ok(dock().dataset.variant === "over" && !el("ws").classList.contains("asst-side"), "«Поверх» не сужает");
  asstVariantSet("auto");
  const room = el("ws").getBoundingClientRect().right - el("main").getBoundingClientRect().left;
  ok(asstPos() === (innerWidth > 860 && room - asstWidth >= ASST_FORM_MIN ? "side" : "over"), "«Авто» считает место под форму");
  asstWidthSet(100, false);
  ok(asstWidth === ASST_W_MIN, "ширина не меньше предела");
  asstWidthSet(5000, false);
  ok(asstWidth <= ASST_W_MAX, "ширина не больше предела");
  asstWidthSet(oldW, false);

  // Панель закрыта: отбор не меняет дерево под руками
  asstOpen("");
  const fChat = asst;
  asstClose();
  const fakeFound = { type: "found", text: "отбор", ids: [], total: 0, conditions: [] };
  asstEvent(fChat, fakeFound);
  ok(fChat.found === fakeFound && !asstPick, "закрытая панель: дерево не тронуто");

  // Поверх: план настройки закрывает панель, чтобы показать карточку
  asstVariantSet("over");
  asstOpen("");
  const pChat = asst;
  say("выключи запись Главный вход");
  ok(await until(() => !pChat.busy && pChat.plan?.items), "план настройки пришёл");
  ok(!asstDockOpen, "панель поверх закрылась");
  ok(treeSel.size > 0, "объекты плана отмечены");
  ok(btn().classList.contains("wait") && /Ждёт ответа/.test(btn().textContent), "кнопка: ждёт ответа");
  ok(await until(() => bulkDraft.planOf === pChat.plan), "черновик карточки из плана");
  asstPickClear();
  treeSel.clear();
  bulkDraft = {};
  asstVariantSet("auto");

  // Переход к другому разговору, пока отбор грузится: план всё равно приходит в карточку
  asstVariantSet("side");
  asstOpen("");
  const swA = asst;
  say("выключи запись Главный вход");
  ok(await until(() => swA.plan?.items), "план для перехода пришёл");
  asstOpen("");
  ok(await until(() => bulkDraft.planOf === swA.plan), "другой разговор не помешал плану дойти до карточки");
  asstPickClear();
  treeSel.clear();
  bulkDraft = {};

  // План пришёл без взгляда на панель: заметки «отмечены» нет, есть «Открыть в дереве»
  asstSwitch(swA.id);
  ok(!el("asstPlanNote") && el("asstPlanOpen"), "план не в дереве: заметки нет, кнопка есть");
  // Правки человека план сам не заменяет
  bulkDraft = { pre: "7" };
  asstOpen("");
  const edited = asst;
  say("выключи запись Главный вход");
  ok(await until(() => !edited.busy && edited.plan?.items), "план при правках в карточке");
  ok(bulkDraft.pre === "7" && !bulkDraft.planOf && !asstPick, "правки человека на месте, дерево не тронуто");
  ok(!el("asstPlanNote") && el("asstPlanOpen"), "план ждёт кнопку");
  asstPlanOpen();
  ok(el("confirm").classList.contains("open") && bulkDraft.pre === "7", "кнопка спрашивает о замене");
  closeConfirm();
  bulkDraft = {};
  asstVariantSet("auto");

  // Итог правил при закрытой панели виден на кнопке и в истории
  asstVariantSet("side");
  asstOpen("");
  const rulesChat = asst;
  say("при движении на Запасной вход пиши 5 минут");
  ok(await until(() => el("asstApply")), "план правил");
  const rulesText = rulesChat.plan.summary;
  asstClose();
  asstApply();
  ok(await until(() => rulesChat.result), "правила применены при закрытой панели");
  ok(rulesChat.unread && asstState(rulesChat)[0] === "ready", "кнопка говорит об итоге");
  ok(savedOf(rulesChat).log.some((x) => x.t && x.t.includes(rulesText)), "план и итог в истории");
  asstVariantSet("auto");

  // Пароль другими словами и в ответе: в историю не попадает
  asstOpen("");
  const pwd = asst;
  say("поставь камере pwd Zx9Vb1");
  ok(await until(() => !pwd.busy), "реплика с pwd");
  ok(!store().includes("Zx9Vb1") && savedOf(pwd).noStore, "pwd не сохранён");
  asstOpen("");
  const pss = asst;
  say("смени пасс на Mn8Kj1");
  ok(await until(() => !pss.busy), "реплика с «пасс»");
  ok(!store().includes("Mn8Kj1") && savedOf(pss).noStore, "«пасс» не сохранён");
  asstOpen("");
  const ans = asst;
  ans.log.push({ k: "answer", t: "пароль камеры: Qw3rty1" });
  asstSave();
  ok(!store().includes("Qw3rty1") && savedOf(ans).noStore, "ответ с паролем не сохранён");
  asstOpen("");
  const passive = asst;
  say("покажи пассивные датчики");
  ok(await until(() => !passive.busy), "реплика со словом «пассивные»");
  ok(store().includes("пассивные") && !savedOf(passive).noStore, "похожее слово сохраняется");

  // Панель рядом не закрывает окна и черновики; за открытым окном план не меняет дерево
  asstVariantSet("side");
  asstOpen("");
  const hit = (b) => { const r = b.getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("#wizDr, #bmodal"); };
  const wizBtn = () => document.getElementById("wn");
  document.documentElement.style.setProperty("--asst-w", "560px");
  document.getElementById("tt")?.remove();   // тост от прошлого шага лежит над кнопкой мастера
  planOpen();
  ok(wizOpen() && hit(wizBtn()), "панель не закрывает кнопку мастера");
  ok(document.getElementById("wizDr").getBoundingClientRect().right <= dock().getBoundingClientRect().left, "мастер — левее панели");
  ok(!asstSeen(asst), "за открытым мастером панель не считается видимой");
  closeWizard();
  ok(asstSeen(asst), "мастер закрыт — панель видна");
  document.documentElement.style.removeProperty("--asst-w");
  addArchive(domains[0].id);
  const bm = document.querySelector("#bmodal .dc-box");
  if (bm) ok(hit(document.querySelector("#bmodal .btn.pri, #bmFoot .btn")), "панель не закрывает кнопку окна");
  ok(!asstSeen(asst), "за открытым окном панель не считается видимой");
  closeBulkModal();
  an = null;
  const wd = document.createElement("div");
  wd.className = "wz-docks";
  wd.textContent = "черновик";
  document.body.appendChild(wd);
  ok(wd.getBoundingClientRect().right <= dock().getBoundingClientRect().left, "черновики — левее панели");
  wd.remove();
  // Ctrl+I при открытом подтверждении не уводит фокус под маску
  askConfirm("Проверка", "", "", "Да", () => {}, { typeCount: 1 });
  const wasOpen = !dock().hidden, wasFocus = document.activeElement;
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true }));
  ok(!dock().hidden === wasOpen && document.activeElement === wasFocus, "Ctrl+I при подтверждении ничего не меняет");
  closeConfirm();
  // В «Детекторах» строк камер нет: отбор камер уводит на срез, где они есть
  setSlice("det");
  const camIds = devicePool.filter((d) => d.type === "camera").slice(0, 2).map((d) => d.id);
  asstPickSet({ ids: camIds, total: camIds.length });
  ok(slice === "all", "отбор камер из «Детекторов» — на срезе с камерами");
  asstPickClear();
  setSlice("all");
  asstVariantSet("auto");
  asstClose();

  // Перезагрузка: история на месте, идущий ход отмечен потерянным
  const raw = JSON.parse(store());
  raw[0].running = true;
  localStorage.setItem(ASST_STORE, JSON.stringify(raw));
  asstChats = [];asst = null;
  asstLoad();
  ok(asstChats.length === raw.length && asst.interrupted && /перезагрузили|перезагрузилась/.test(asst.err), "потерянный ход назван");
  asstToggle();
  ok(el("asstAgain"), "есть «Спросить заново»");
  asstClose();
  localStorage.removeItem(ASST_STORE);
});
