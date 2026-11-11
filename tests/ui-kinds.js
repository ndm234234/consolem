/* Сценарии интерфейса: виды устройств, которые находит сервер, карточки только для чтения. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  // Прототип с планом камеры (camPlanRows): правка ждёт «Применить» — сценарий применяет план и ждёт итога.
  // В index.html правка уже на сервере, и planApply ничего не делает
  const planApply = async () => {
    if (typeof camPlanRows !== "function" || !cardDraft || !cardDiff().length) return;
    const was = bq;
    cardApply();
    await until(() => bq && bq !== was && bq.finished);
    if (document.getElementById("bmodal")?.classList.contains("open")) closeBulkModal();
  };
  const devices = (await uiDevices());
  const of = (t, more) => devices.find((d) => d.type === t && (!more || more(d)));
  const main = () => document.getElementById("main");
  const open = (id, t = "gen") => { pick(id, { force: true }); goTab(t); };

  // Мастер: находки сервера не заводятся, единицы СКУД — только в СКУД
  const types = (cat) => (WIZ[cat]?.types || []).map((t) => t[0]);
  ok(!["sensor", "relay", "mic"].some((t) => types("io").includes(t)), "датчик, реле и микрофон не заводятся: их находит сервер");
  ok(!types("svc").includes("spk"), "динамика сервера нет");
  ok(types("acfa").includes("relay"), "реле в СКУД заводится");

  // Датчик: имя, включение, norm; номер и лишние настройки — нет
  const s = of("sensor");
  open(s.id);
  ok(!document.querySelector('[data-df="Номер"]') && [...main().querySelectorAll("input[disabled]")].some((i) => i.value === String(s.channel)), "номер датчика только для чтения");
  ok(main().textContent.includes("Нормальное состояние") && !/Задержка срабатывания|Импульс/.test(main().textContent), "параметры — из справочника: только norm");
  ok(!!main().querySelector('.sw[role="switch"]'), "включение правится");

  // Канал и хранилище — только чтение, без переключателя
  open(of("channel").id);
  ok(!main().querySelector('.sw[role="switch"]') && !main().querySelector("[data-df]"), "у канала ничего не правится");
  open(of("storage").id);
  ok(!main().querySelector('.sw[role="switch"]') && !main().querySelector("[data-df]"), "у встроенного хранилища ничего не правится");
  const owner = devices.find((d) => d.type === "camera" && devices.some((x) => x.parentId === d.id && x.type === "storage"));
  open(owner.id, "rec");
  ok(!/Форматировать|Выгрузить записи/.test(main().textContent), "кнопок без операций нет");
  ok(!/IP-устройство с хранилищем/.test(deviceManualHtmlSafe()), "пункта «IP-устройство с хранилищем» нет");

  // Производители и модели — из справочника, своё вводится руками; адрес — rtspUrl
  const ref = await API.get("/reference");
  ok(Object.keys(DEVICE_MODELS).length === ref.deviceModels.length, "модели из reference.deviceModels");
  wizd = initDeviceWizard(addContext());
  ok(/data-ck="updateManual\|model"/.test(deviceManualHtml()) && !/<label>RTSP/.test(deviceManualHtml()), "модель с подсказками, отдельного поля RTSP в ручном добавлении нет");
  const manualVendor = wizd.manual.vendor;
  wizd.manual.vendor = "RTSP";
  ok(/<label>RTSP/.test(deviceManualHtml()), "производитель RTSP: поле адреса называется RTSP");
  wizd.manual.vendor = manualVendor;
  ok(!/MAC-адрес/.test(deviceManualHtml()), "MAC вручную не вводится: он только из поиска");
  // Карточка с «Изменить» у блоков (csEditSet): поля «Подключения» — после «Изменить», поле RTSP — только у производителя
  // RTSP, как в окне добавления. Карточка без этого показывает поле RTSP сразу
  const csMode = typeof csEditSet === "function";
  const rtspOf = (id) => {
    if (csMode) { csEditSet(id, "conn", true); camConnSet(id, "Производитель", "RTSP"); }
    const v = document.querySelector('[data-df="RTSP"]')?.value;
    if (csMode) { cardRestore(); csEditSet(id, "conn", false); }
    return v;
  };
  const withUrl = of("camera", (d) => d.rtspUrl);
  open(withUrl.id);
  ok(rtspOf(withUrl.id) === withUrl.rtspUrl, "карточка показывает rtspUrl");
  const noUrl = of("camera", (d) => !d.rtspUrl && !d.parentId);
  open(noUrl.id);
  ok(rtspOf(noUrl.id) === "", "адреса нет — поле пустое, а не собранное из IP");

  // Видео: своего не подставляем, потоки строками, разрешение — из вариантов
  const video = of("camera", (d) => d.resOptions && d.online);
  open(video.id, "vid");
  // Вкладка «Видео» с режимом потоков (cvCfgOf): в «Настройках камеры» параметры только для чтения, правка — в «Настройках консоли»
  const cvModes = typeof cvCfgOf === "function";
  const resCtl = () => document.querySelector('[data-df="Разрешение"]');
  // «Параметры потоков» с «Изменить» (cvEditStart): поля — после «Изменить»
  const toConsole = (id) => { if (cvModes) { cvCfgOf(find(id).n).mode = "console"; if (typeof cvEditStart === "function") cvEditStart(id); mainSeen.html = null; gear(); } };
  if (cvModes) ok(!resCtl(), "режим «Настройки камеры»: разрешение только для чтения");
  toConsole(video.id);
  const resVals = [...(resCtl()?.options || [])].map((o) => o.value).filter(Boolean);
  ok(resCtl()?.tagName === "SELECT" && resVals.every((v) => video.resOptions.includes(v) || v === find(video.id).n.streams[0]?.res) && (cvModes || !/H\.265|4096|Битрейт/.test(main().textContent)), "разрешение — выбор из resOptions" + (cvModes ? "" : ", H.265 и битрейта нет"));
  ok(await until(() => lv?.id === video.id && lv.sess?.door.whepUrl, 60000), "живое видео запрошено через POST /devices/{id}/live, сессия у шлюза");
  ok(await until(() => /настоящего видео на стенде нет|На стенде нет настоящего видео/.test(main().textContent)), "подпись: подставной поток");
  const free = of("camera", (d) => !d.resOptions && !d.parentId);
  open(free.id, "vid");
  toConsole(free.id);
  ok(resCtl()?.tagName === "INPUT", "нет вариантов — ввод руками");
  open(video.id, "vid");
  const rowsBefore = main().querySelectorAll("[data-stream]").length;
  streamAdd(video.id);
  ok(await until(() => main().querySelectorAll("[data-stream]").length === rowsBefore + 1), "поток добавлен строкой");
  const added = find(video.id).n.streams.at(-1);
  streamDel(video.id, added.id);
  // Прототип с планом камеры: новый поток есть только в черновике, поэтому он уходит без вопроса — на сервере удалять нечего
  if (!added._new) {
    ok(await until(() => document.getElementById("confirmCountInp")), "удаление потока — с вводом числа");
    await confirmWith(1);
    // Отсчёт с «Отменить»; тест не ждёт 10 с, а сразу завершает отсчёт
    const pd = pendingOf(`camstream:${video.id}/${added.id}`);
    ok(!!pd, "удаление потока — отсчёт с «Отменить»");
    if (pd) commitDelete(pd.key);
  }
  ok(await until(() => find(video.id).n.streams.length === rowsBefore), "поток удалён после отсчёта");
  open(video.id, "rec");
  ok(!main().querySelector("select") || [...main().querySelectorAll("option")].some((o) => o.textContent === "Второй") || !camArchs(find(video.id).n).length, "поток записи — из потоков камеры");

  // Поток правится сколько угодно раз, как в базе: версия каждого потока ведётся (If-Match), отказов нет
  const errs = [];
  const realToast = window.toast;
  window.toast = (m, ...a) => { if (/ошибка|изменился|PRECONDITION|не найден/i.test(String(m))) errs.push(String(m)); return realToast(m, ...a); };
  const streamOf = (camId, sid) => (find(camId)?.n.streams || []).find((x) => x.id === sid);
  const onServer = async (uid) => (await API.get(`/units/${uid}`)).name;
  const multi = devices.find((d) => d.type === "camera" && (find(d.id)?.n.streams || []).length > 1);
  open(multi.id, "vid");
  const sub = find(multi.id).n.streams[1];
  streamSet(multi.id, sub.id, "name", "Второй поток");
  ok(await until(() => streamOf(multi.id, sub.id)?.name === "Второй поток") && (await onServer(sub.uid)) === "Второй поток" && !errs.length, "существующий поток переименован: " + (errs[0] || "без отказа"));
  streamSet(multi.id, sub.id, "fps", "12");
  ok(await until(() => streamOf(multi.id, sub.id)?.fps === 12) && !errs.length, "существующий поток: вторая правка проходит: " + (errs[0] || "без отказа"));
  open(video.id, "vid");
  const before2 = find(video.id).n.streams.length;
  streamAdd(video.id);
  await planApply();
  ok(await until(() => find(video.id).n.streams.length === before2 + 1), "новый поток добавлен");
  const fresh = find(video.id).n.streams.at(-1);
  streamSet(video.id, fresh.id, "name", "Поток А");
  ok(await until(() => streamOf(video.id, fresh.id)?.name === "Поток А") && !errs.length, "новый поток: первая правка: " + (errs[0] || "без отказа"));
  streamSet(video.id, fresh.id, "name", "Поток Б");
  ok(await until(() => streamOf(video.id, fresh.id)?.name === "Поток Б") && (await onServer(fresh.uid)) === "Поток Б" && !errs.length, "новый поток: вторая правка: " + (errs[0] || "без отказа"));
  streamDel(video.id, fresh.id);
  ok(await until(() => document.getElementById("confirmCountInp")), "удаление правленого потока — с вводом числа");
  await confirmWith(1);
  const pd2 = pendingOf(`camstream:${video.id}/${fresh.id}`);
  ok(!!pd2, "удаление правленого потока — отсчёт с «Отменить»");
  if (pd2) commitDelete(pd2.key);
  ok(await until(() => find(video.id).n.streams.length === before2), "правленый поток ушёл из черновика после отсчёта");
  await planApply();
  const goneOnServer = async (uid) => { try { await API.get(`/units/${uid}`); return false; } catch { return true; } };
  ok((await goneOnServer(fresh.uid)) && !errs.length, "правленый поток удалён на сервере: " + (errs[0] || "без отказа"));
  window.toast = realToast;

  // Детекторы: новый создаёт мастер — встроенный из того, что умеет камера; линия рисуется мышью в кадре мастера и уходит на сервер
  const camD = devices.find((d) => d.detectorOptions && devices.some((x) => x.parentId === d.id && x.type === "det" && x.detectorKind === "linecross" && x.builtin));
  // Камера, у которой ещё нет этих шаблонов и они не мешают друг другу
  const camT = devices.find((d) => ["tmpl.line", "tmpl.tamper"].every((t) => (d.detectorOptions || []).some((o) => o.template === t) && !devices.some((x) => x.parentId === d.id && x.template === t))
    && !devices.some((x) => x.parentId === d.id && x.template === "tmpl.face"));
  ok(!!camT, "есть камера, где можно создать «Линию» и «Вскрытие корпуса»");
  localStorage.removeItem("cfg.detCreate");
  detCreateOpen(camT.id);
  ok(await until(() => dc && dc.ready), "мастер прочитал камеры");
  ok(!main().textContent.includes("Где работает"), "в карточке камеры выбора, где работает, больше нет: детекторы создаёт мастер");
  dcItemToggle("t:tmpl.tamper", true);
  dcItemToggle("t:tmpl.line", true);
  dcStepGo(dcSteps().findIndex((x) => x.k === "zones"));
  const rows = dcRows();
  const lineRow = rows.find((r) => r.name === "Линия на камере");
  ok(rows.length === 2 && lineRow?.line && zoneDraw?.id === lineRow.id && zoneDraw.shape === "line", "шаг зон: детектору линии сразу рисуется линия");
  const svg = () => document.querySelector(`#bmodal [data-live] svg[data-zone="${lineRow.id}"]`);
  ok(!!svg(), "кадр с зоной в окне мастера");
  const at = (t, fx, fy, el = svg()) => {
    const r = el.getBoundingClientRect();
    (t === "mousedown" ? el : window).dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
  };
  const box = svg().getBoundingClientRect();
  ok(box.width > 0 && box.height > 0, "кадр занял место: " + Math.round(box.width) + "×" + Math.round(box.height));
  at("mousedown", 0.25, 0.5);
  at("mousemove", 0.5, 0.6);
  at("mouseup", 0.75, 0.5);
  const dz = dcZoneOf(lineRow.id);
  ok(dz?.shape === "line" && Math.abs(dz.points[0][0] - 0.25) < 0.01 && Math.abs(dz.points[1][0] - 0.75) < 0.01, "линия нарисована мышью, в долях кадра");
  dcStepGo(dcSteps().findIndex((x) => x.k === "rule"));
  dcRulePick("none");
  dcRun();
  await until(() => !bq || bq.finished);
  const made = async () => (await uiDevices()).find((d) => d.parentId === camT.id && d.template === "tmpl.line" && d.zone?.shape === "line");
  const rec = await made();
  ok(!!rec && rec.builtin === true, "создан встроенный детектор с шаблоном и зоной");
  const tam = (await uiDevices()).find((d) => d.parentId === camT.id && d.template === "tmpl.tamper");
  ok(!!tam && tam.builtin === true, "и встроенный «Вскрытие корпуса» без зоны");
  // Карточка созданного: диапазон шаблона; у шаблона без чувствительности поля нет
  open(tam.id);
  ok(![...main().querySelectorAll("[data-df]")].some((e) => e.dataset.df === "Чувствительность"), "у шаблона без чувствительности поля нет");
  open(rec.id);
  ok([...main().querySelectorAll("[data-df]")].some((e) => e.dataset.df === "Чувствительность") && /1–100/.test(main().textContent), "диапазон шаблона показан");
  // Детектору линии без линии — подсказка
  const bare = devices.find((d) => d.parentId === camD.id && d.type === "det" && d.detectorKind === "linecross" && !d.builtin && !d.zone);
  open(bare.id);
  ok(/линия/i.test(main().textContent), "детектору линии без линии — подсказка");
  // Полигон на готовом детекторе, «Сбросить»
  const line = devices.find((d) => d.parentId === camD.id && d.type === "det" && !d.builtin);
  open(line.id);
  if (main().querySelector("[data-dw]")) {
    // Прототип окна детектора: зону правят на кадре окна, «Применить» там — заглушка без запроса к серверу
    ok(!!main().querySelector("[data-dw] svg"), "окно детектора: кадр с зоной");
  } else {
    zoneMode(line.id, "polygon");
    const pg = () => main().querySelector(`[data-zone="${line.id}"]`);
    [[0.2, 0.2], [0.8, 0.2], [0.5, 0.8]].forEach(([x, y]) => at("mousedown", x, y, pg()));
    zoneClose(line.id);
    ok(find(line.id).n.zone?.shape === "polygon" && find(line.id).n.zone.points.length === 3, "полигон из трёх точек");
    ok(/Показать план/.test(document.getElementById("cardFoot")?.textContent || ""), "зона — в черновике карточки");
    cardApply();
    await until(() => !bq || bq.finished);
    ok((await uiRec(line.id)).zone?.points.length === 3, "зона на сервере");
    open(line.id);
  }
  // Несовместимый: отказ сказан своими словами
  const clash = problemText({ problem: { code: "BUSY", params: { reason: "incompatible", with: line.id } } });
  ok(/несовместим/.test(clash), "несовместимый детектор: " + clash);
  ok(TRIGGER_KINDS.some((k) => k.kind === "other") && ruleDetOthers().some((x) => x[1] === "Вскрытие корпуса"), "другой вид выбирается в правиле по имени шаблона");

  // Карта камеры w2c: меньший объём — со вторым подтверждением
  const cardN = of("storage", (d) => d.writableFields?.includes("sizeBytes"));
  if (cardN) {
    const was = (await uiRec(cardN.id)).sizeBytes;
    open(cardN.id, "gen");
    storageSet(cardN.id, "size", String(Math.round(was / 1024 ** 3) - 8));
    cardApply();
    ok(await until(() => /Уменьшить карту/.test(document.body.textContent)), "спрашивает подтверждение");
    await confirmWith(null);
    ok(await until(() => find(cardN.id).n.bytes < was), "объём уменьшен");
    ok((await uiRec(cardN.id)).sizeBytes < was, "на сервере меньше");
  }

  // Скан и обход: archiveJobs false — кнопок нет, строка вместо них; 403 на правке — понятный отказ, список перечитан
  const off = devices.find((d) => d.archiveJobs === false);
  if (off) {
    open(off.id, "rec");
    ok(/Скан и обход недоступны/.test(main().textContent) && !main().querySelector("[data-scan-add]") && !main().querySelector("[data-watch-add]"), "вместо кнопок строка");
    const watchCam = (await API.get("/archive-watches")).items[0];
    if (watchCam) {
      open(watchCam.deviceId, "rec");
      ok(await until(() => rw.loaded && rw.watches.length), "обходы загружены");
      const realPatch = API.patch;
      let reloaded = 0;
      const realGet = API.get;
      API.patch = () => Promise.reject(Object.assign(new Error("403"), { status: 403, problem: { code: "PERMISSION_DENIED" } }));
      API.get = (p, ...a) => { if (p === "/archive-watches") reloaded++; return realGet(p, ...a); };
      rwWatchToggle(watchCam.id);
      ok(await until(() => reloaded > 0 && /администратор камеры/.test(document.getElementById("tt")?.textContent || "")), "отказ словами, список перечитан");
      API.patch = realPatch;
      API.get = realGet;
      ok(rw.watches[0].enabled === watchCam.enabled, "переключатель прежний");
    }
  }

  // Пресеты: движение арендой, пресет запоминается, в правиле — выбор из списка
  const ptz = of("camera", (d) => d.ptz && d.presets?.length);
  open(ptz.id, "vid");
  ok(main().textContent.includes("Пресеты") && main().querySelector("[data-preset]"), "карточка пресетов");
  ok(!!main().querySelector("[data-preset] input") && !!main().querySelector("[data-preset-max]"), "имя вводится, предел номера виден");
  ok(!(TF_CAM.some((t) => t[0] === "ptz")), "вида PTZ в фильтрах нет");
  const calls = [];
  const realPut = API.put, realDel = API.del;
  API.put = (p, ...a) => (calls.push("PUT " + p), realPut(p, ...a));
  API.del = (p, ...a) => (calls.push("DEL " + p), realDel(p, ...a));
  // Кнопка поворота: прежняя [data-ptz] или кнопка джойстика [data-joy-dir] вкладки «Видео»
  const moving = () => (typeof cvMove !== "undefined" ? cvMove : ptzMove);
  (main().querySelector('[data-ptz="0"]') || main().querySelector('[data-joy-dir="0"]')).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  ok(await until(() => calls.includes(`PUT /units/${ptz.id}/ptz`)), "кнопка нажата — аренда");
  ok(!!moving(), "держим — продлевается");
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  ok(await until(() => calls.includes(`DEL /units/${ptz.id}/ptz`)) && !moving(), "отпустили — стоп");
  API.put = realPut;
  API.del = realDel;
  const count = ptz.presets.length;
  presetAdd(ptz.id);
  ok(await until(() => presetRows(find(ptz.id).n).length === count + 1 && !!main().querySelector(`[data-preset="${count + 1}"]`)), "пресет добавлен строкой с первым свободным номером");
  ok(find(ptz.id).n.presets.length === count + 1 && presetFree(find(ptz.id).n) === count + 2, "без подписи — в Device.presets, номер занят");
  ok(main().querySelector(`[data-preset="${count + 1}"] input`).placeholder.includes(String(count + 1)), "без подписи показан номером");
  presetName(ptz.id, count + 1, "Ворота");
  ok(await until(() => find(ptz.id).n.presets.some((p) => p.name === "Ворота")), "имя задано");
  presetName(ptz.id, count + 1, "");
  ok(await until(() => find(ptz.id).n.presets.some((p) => p.n === count + 1 && !p.name)), "пустое снимает подпись, запись остаётся");
  const newest = find(ptz.id).n.presets.find((p) => !ptz.presets.some((x) => x.n === p.n));
  presetDel(ptz.id, newest.n);
  ok(await until(() => document.getElementById("confirmCountInp")), "удаление пресета — с вводом числа");
  await confirmWith(1);
  ok(await until(() => find(ptz.id).n.presets.length === count), "пресет удалён после отсчёта");
  ok(rulePresetOpts({ ref: ptz.id })?.[0]?.[1] === "1 · Вход" && rulePresetOpts({ ref: ptz.id }).length === ptz.presetMax, "в правиле пресет — номера до предела, с именами");
  ok(rulePresetOpts({ ref: of("camera", (d) => !d.ptz).id }) === null, "нет списка — номер руками");

  // Источник событий: сервер, камера из списка, слова правятся
  const src = of("eventsrc");
  open(src.id);
  ok(/Адрес кассы или сервера/.test(main().textContent) && !!main().querySelector('[data-df="Адрес кассы или сервера"]'), "адрес подписан как адрес кассы или сервера");
  ok([...main().querySelectorAll("label")].some((l) => l.textContent === "Сервер"), "сервер выбирается");
  open(src.id, "overlay");
  const camSel = main().querySelector("select");
  ok([...camSel.options].length > 3 && !/Парковка/.test([...camSel.options].slice(0, 1)[0].textContent), "камера титров — из списка камер");
  const pickCam = find(camSel.options[1].value)?.n;
  overlaySetCam(src.id, pickCam.id);
  open(src.id, "words");
  const wordsWas = find(src.id).n.words.length;
  wordAdd(src.id);
  ok(main().querySelectorAll("[data-word]").length === wordsWas + 1, "слово добавлено строкой");
  wordSet(src.id, wordsWas, "msg", "ВОЗВРАТ");
  cardApply();
  await until(() => !bq || bq.finished);
  const srcNow = await uiRec(src.id);
  ok(srcNow.cameraId === pickCam.id && srcNow.words.at(-1).msg === "ВОЗВРАТ", "камера и слово на сервере");
  ok(TRIGGER_KINDS.some((k) => k.kind === "text") && ruleWordOpts(src.id).some((x) => x[0] === "ВОЗВРАТ"), "в правиле вид text, слова выбранного источника");
  wizd = initDeviceWizard(addContext());
  wizd.manual.type = "eventsrc";
  ok(/Выберет система/.test(deviceManualHtml()), "в мастере — выбор сервера источника");

  // СКУД: мастер единиц, адрес, шаблон, команды, вложенный контроллер, единица под камерой
  const acfaRoot = of("acfa", (d) => !d.parentId);
  open(acfaRoot.id, "kids");
  ok(main().textContent.includes("Контроллер этажа"), "вложенный контроллер виден в подобъектах");
  pick(acfaRoot.id, { force: true });
  openW("unit");
  chooseAdd("object", "acfa", "acfa_lock");
  wnx();
  ok(!!document.getElementById("wizPath") && !document.querySelector('input[data-ck="wizPlace|folder"]'), "у единицы адрес, папку не предлагаем");
  ok([...document.getElementById("wizParent").options].some((o) => /камера|Камера/.test(o.textContent)), "родитель — и камера");
  ok(!!document.getElementById("wizUnitModel"), "шаблон — из unitOptions");
  document.getElementById("wizPath").value = "door/20";
  wnx();
  ok(await until(() => find(sel)?.n?.path === "door/20"), "единица заведена, адрес на месте");
  const lockNow = find(sel).n;
  ok(!!canTreeCtxDelete(lockNow), "единицу можно снять");
  const readyLock = of("acfa_lock", (d) => d.operations?.length);
  open(readyLock.id);
  ok(!!main().querySelector('[data-df="Адрес"]') && [...main().querySelectorAll("input[disabled]")].some((i) => i.value === "Дверь с замком"), "карточка единицы: адрес и шаблон");
  main().querySelector('[data-unit-op="open"]').click();
  ok(await until(() => /выполнено/.test(document.body.textContent)), "команда выполнена");
  ok(/такой команды нет/.test(problemText({ problem: { code: "DEVICE_REFUSED", params: { reason: "noOperation" } } })), "отказ своими словами");
  ok(TRIGGER_KINDS.some((k) => k.kind === "unit") && ACTION_KINDS.some((k) => k.action === "unit") && ruleUnitOps({ ref: readyLock.id })?.length === readyLock.operations.length, "в правиле вид и действие unit, команды единицы");
  ok(ruleUnitWords(readyLock.id).some((x) => x[0] === "forced"), "слова события — из шаблона");

  // Профиль при добавлении: только та же модель, в тексте — то, что копируется на самом деле
  wizd = initDeviceWizard(addContext());
  wizd.deviceTab = "manual";
  const model = of("camera", (d) => d.model && !d.parentId);
  Object.assign(wizd.manual, { vendor: model.vendor, model: model.model });
  ok(deviceTemplates().length > 0 && deviceTemplates().every((c) => c.model === model.model), "источник профиля — камера той же модели");
  ok(!deviceAddModes().some((m) => /буферизац|Прочее/.test(m.hint)), "подсказка без буферизации и «Прочего»");

  // Метки, тревожные виды, состояние записи
  const lab = of("camera", (d) => !d.parentId && d.vendor && d.online && !d.alarmKinds && !d.labels);
  open(lab.id);
  ok(/Размещение и тревоги/.test(main().textContent), "карточка размещения и тревог");
  listToggle(lab.id, "labels", "gpu");
  listToggle(lab.id, "alarmKinds", "motion");
  cardApply();
  await until(() => !bq || bq.finished);
  const labNow = await uiRec(lab.id);
  ok(labNow.labels?.includes("gpu") && labNow.alarmKinds?.includes("motion"), "метка и тревожный вид на сервере");
  const stopped = of("camera", (d) => d.recordReason && d.online);
  open(stopped.id, "rec");
  ok(!!main().querySelector("[data-rec-state]") && main().textContent.includes(stopped.recordReason), "вкладка «Архив» говорит, почему запись не идёт");
  ok(main().textContent.includes(stopped.faultText) || !!main().querySelector("[data-fault-text]"), "причина словами сервера");
  const dLab = of("det", (d) => !d.builtin);
  open(dLab.id);
  ok(!/Сервер детектора/.test(main().textContent) && /где считать/.test(main().textContent), "у детектора метки вместо выбора сервера");
  pick(servers.find((s) => !isUnallocated(s.id)).id, { force: true });
  goTab("gen");
  ok(/Метки сервера/.test(main().textContent), "метки в карточке сервера");

  // Журнал: поиск, условия и счётчики — на сервере (контракт 0.8.0)
  goApp("log");
  logGo("all");
  ok(await until(() => pjRes && document.getElementById("pjList") && pjRes.fac), "журнал: список и счётчики с сервера");
  ok(pjRes.p.levelNot === "service" && pjRes.base >= pjRes.total, "служебные скрыты, «из M» — события периода");
  pjToggle("cats", "audit");
  ok(await until(() => pjRes.p.level === "audit" && pjRes.items.every((e) => pjLevelOf(e) === "audit")), "категория отобрана на сервере");
  ok(!!document.querySelector('#pjaConds [data-ck="pjToggle:cats:audit"]'), "условие — чипом над списком");
  pjaIn = "Вход";
  pjaCommitText();
  ok(await until(() => pjRes.p.q === "Вход" && pjRes.items.every((e) => /вход/i.test(e.text + pjKindName(e.kind)))), "текст — в q");
  pjaResetAll();
  ok(await until(() => !pjRes.p.level && !pjRes.p.q && pjRes.p.levelNot === "service"), "«Сбросить всё»: исходный вид");
  const jev = pjRes.items.find((e) => e.deviceId);
  pjSelId = jev.id;
  pjSelEv = jev;
  pjMountDet();
  ok(await until(() => document.querySelector(`#pjDet .pj-nr.on[data-v="${jev.id}"]`)), "«Рядом» — страница вокруг записи с сервера");
  pjAct("inc", jev.deviceId, "objs");
  ok(await until(() => pjRes.p.deviceId === jev.deviceId && pjRes.p.deviceMatch === "exact" && pjRes.items.every((e) => e.deviceId === jev.deviceId)), "«=» у объекта — условие deviceId");
  pjaResetAll();
  // Контракт 0.9.0: страницы «Назад» и «Вперёд», пояс в списке, два времени и «Кто» в панели, CSV на сервере
  ok(await until(() => /Записи 1–\d+/.test(document.getElementById("pjPg")?.textContent || "")), "листалка: «Записи 1–N из M»");
  ok(/UTC[+-]\d\d:\d\d/.test(document.querySelector(".pj-lh")?.textContent || ""), "пояс в заголовке «Время»");
  pjSetRange("30d");
  ok(await until(() => pjQ.range === "30d" && pjRes.key === pjKey()), "период 30 дней");
  pjSetPageSize(50);
  ok(await until(() => pjRes.items.length === 50 && !!pjRes.next), "размер страницы 50");
  const p1 = pjRes.items[0].id;
  pjPage(1);
  ok(await until(() => pjRes.off === 50 && pjRes.items[0].id !== p1 && /Записи 51–/.test(document.getElementById("pjPg").textContent)), "«Вперёд» — следующая страница");
  pjPage(-1);
  ok(await until(() => pjRes.off === 0 && pjRes.items[0].id === p1 && document.querySelector("#pjPg .pg-b").disabled), "«Назад» — первая страница, «Назад» неактивна");
  pjSetPageSize(100);
  ok(await until(() => pjRes.items.length > 50 || !pjRes.next), "размер страницы 100");
  pjSelId = pjRes.items[0].id;
  pjSelEv = pjRes.items[0];
  pjMountDet();
  ok(/Случилось: .*\(UTC[+-]\d\d:\d\d\)/.test(document.getElementById("pjDet").textContent) && /Записано/.test(document.getElementById("pjDet").textContent) && /Кто/.test(document.getElementById("pjDet").textContent), "панель: «Случилось» с поясом, «Записано», «Кто»");
  ok(pjRes.items.every((e) => !!e.actor), "«Кто» у каждой записи");
  {
    let blob = null;
    const oc = URL.createObjectURL, ac = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { blob = b; return oc.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
    try { await pjCsv(); } finally { URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ac; }
    const text = blob ? await blob.text() : "";
    const lines = text.split("\r\n").filter(Boolean);
    ok(lines.length === pjRes.total + 1 && /T\d\d:\d\d:\d\d[+-]\d\d:\d\d/.test(lines[1] || ""), "CSV: все записи отбора, время ISO со смещением");
  }
  pjaResetAll();

  // Учётки потоков: пароль один раз, удаление с вводом числа
  goApp("acc");
  accGo("streams");
  ok(await until(() => document.querySelector("[data-stream-acc]")), "учётки в «Правах»");
  streamDraftSet("wall-ui");
  streamAccAdd();
  ok(await until(() => document.querySelector("[data-stream-pass]")), "пароль показан один раз");
  closeBulkModal();
  ok(await until(() => document.querySelector('[data-stream-acc="wall-ui"]')), "учётка в списке");
  streamAccOn("wall-ui", false);
  ok(await until(() => /Отключена/.test(document.querySelector('[data-stream-acc="wall-ui"]')?.textContent || "")), "отключена");
  streamAccDel("wall-ui");
  ok(await until(() => document.getElementById("confirmCountInp")), "удаление учётки — с вводом числа");
  await confirmWith(1);
  ok(await until(() => !document.querySelector('[data-stream-acc="wall-ui"]')), "удалена после отсчёта");
  goApp("hw");

  // Удаление: находка и выведенный регистратор — нет
  ok(!canTreeCtxDelete(find(s.id).n), "датчик не удаляется");
  const derived = of("ipsrv", (d) => d.derived);
  ok(!canTreeCtxDelete(find(derived.id).n), "выведенный регистратор не удаляется");
  open(derived.id);
  ok(/своей записи у него нет|нет своей записи/.test(main().textContent) && !main().querySelector("[data-df]"), "выведенный регистратор: подпись, поля только для чтения");
  ok(deviceFoldersCardHtml(find(derived.id).n) === "", "папку выведенному не предлагаем");

  // Вход сквозной по устройству: номера с пропуском, правило берёт его из записи
  const gap = devices.filter((d) => d.type === "sensor" && d.channel === 7);
  ok(gap.length > 0 && !!find(gap[0].id), "вход с номером 7 в дереве");
  const k = TRIGGER_KINDS.find((x) => x.kind === "io.input");
  ok(k.match.length === 1 && k.match[0].id === "value" && k.match[0].opts.join() === "active,normal", "уточнение входа — из справочника, номера нет");
  ok(!ACTION_KINDS.find((x) => x.action === "output").fields.some((x) => x.id === "port"), "у реле нет поля «Выход №»");

  // Запись регистратора снимается, камеры остаются
  const nvr = of("ipsrv", (d) => d.subtype === "nvr" && !d.derived);
  const cam = devices.find((d) => d.parentId === nvr.id && d.type === "camera");
  ok(canTreeCtxDelete(find(nvr.id).n), "регистратор с записью удаляется");
  deleteTreeNode(nvr.id);
  ok(await until(() => /останутся без родителя/.test(document.getElementById("confirmMsg")?.textContent || document.body.textContent)), "в подтверждении сказано, что камеры останутся");
  closeConfirmSafe();
  await API.del(`/units/${nvr.id}`, hwVer.get(nvr.id));
  hwRemoveDevice(nvr.id);
  ok(!!find(cam.id) && !find(cam.id).p, "камера осталась в дереве без родителя");

  // Запись меняет родителя: у камеры появился регистратор
  const top = devices.find((d) => d.type === "camera" && !d.parentId);
  hwApplyDevice({ ...(await uiRec(top.id)), parentId: derived.id });
  ok(find(top.id)?.p?.id === derived.id, "камера переехала под ipsrv");

  function deviceManualHtmlSafe() {
    wizd = initDeviceWizard(addContext());
    return deviceManualHtml();
  }
  function closeConfirmSafe() {
    document.querySelector("#confirm .btn:not(.pri), #confirmCancel")?.click();
  }
});
