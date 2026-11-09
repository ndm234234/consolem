/* Сценарии интерфейса: карточка POS-устройства (источник событий, контракт 0.5.0): камеры титров и зона на каждой, вид титров,
   разбор чека, подсветка слов с флажками, строки от кассы, приём и разбор данных. Всё — свойства вида eventsrc и
   GET /units/{uid}/pos/raw; устаревший cameraId сервер держит равным первой камере. Запуск — tools/check_ui.py */
UiCheck(async ({ ok, until }) => {
  const devices = await uiDevices();
  const src = devices.find((d) => d.type === "eventsrc");
  const main = () => document.getElementById("main");
  const open = (t) => { pick(src.id, { force: true }); goTab(t); };
  const node = () => find(src.id).n;
  const apply = async () => { cardApply(); await until(() => !bq || bq.finished); return uiRec(src.id); };
  const [cam1, cam2] = overlayCameras(src);

  // Строки от кассы: читаются при открытии вкладки; «Обновить» читает ещё раз. Встроенный сервер без служебных операций
  // отдаёт пример чека (на стенде строки подкладывает POST /test/events — tests/api-devices.js)
  open("overlay");
  ok(await until(() => posRaw.get(src.id)?.items?.length > 5), "строки от кассы прочитаны с сервера");
  const L = posRaw.get(src.id).items.map((x) => x.text), n0 = L.length;
  ok(main().querySelectorAll("[data-raw]").length === n0 && main().textContent.includes(L[n0 - 1]), "строки показаны в карточке");
  const getWas = API.get, calls = [];
  API.get = function (path, ...r) { if (/pos\/raw/.test(path)) calls.push(path); return getWas.call(this, path, ...r); };
  posRawLoad(src.id, true);
  ok(await until(() => !posRaw.get(src.id).load) && calls.length === 1 && main().querySelectorAll("[data-raw]").length === n0, "«Обновить» шлёт второй запрос и читает строки ещё раз");
  gear(); gear();
  ok(calls.length === 1, "перерисовка карточки не читает строки заново");
  // Сбой чтения: один запрос, ошибка словами, без повторов при перерисовке; «Обновить» пробует снова
  API.get = function (path, ...r) { if (/pos\/raw/.test(path)) { calls.push(path); return Promise.reject(new Error("x")); } return getWas.call(this, path, ...r); };
  posRawLoad(src.id, true);
  ok(await until(() => posRaw.get(src.id).err && !posRaw.get(src.id).load), "сбой чтения замечен");
  const afterFail = calls.length;
  gear(); gear(); gear();
  await new Promise((r) => setTimeout(r, 50));
  ok(calls.length === afterFail && /Консоль не смогла прочитать строки от кассы/.test(main().textContent), "после сбоя запросы не повторяются, ошибка на экране");
  API.get = getWas;
  posRawLoad(src.id, true);
  ok(await until(() => !posRaw.get(src.id).err && posRaw.get(src.id).items?.length === n0), "«Обновить» после сбоя читает строки");
  const iStart = L.findIndex((t) => /^ЧЕК/.test(t)), iEnd = L.findIndex((t) => /^ИТОГО/.test(t)), iWord = L.findIndex((t) => /^Отмена/.test(t));

  // Камера титров: без неё нет кадра, а зона и подсветка видны только на кадре
  ok(/Добавить камеру, на которой оператор увидит титры/.test(main().textContent), "без камеры кадр просит добавить камеру");
  overlaySetCam(src.id, cam1.id);
  ok(!!main().querySelector("[data-pos-txt]"), "с камерой на кадре зона с примером чека");

  // Разбор чека по живым строкам: кнопки строки добавляют слова
  ok(/Нет слов начала или конца чека/.test(main().textContent), "без слов начала и конца карточка предупреждает");
  posRawUse(src.id, iStart, "start");
  posRawUse(src.id, iEnd, "end");
  ok(node().receiptStartWords[0] === L[iStart].trim() && node().receiptEndWords[0] === L[iEnd].trim(), "слова — строка целиком, как пришла от кассы");
  ok(main().querySelector(`[data-raw="${iStart}"].is-s`) && main().querySelector(`[data-raw="${iEnd}"].is-e`) && main().textContent.includes(`Пример: консоль взяла строки ${iStart + 1}–${iEnd + 1} из ${n0} как чек.`), "границы чека отмечены в строках");
  posTog(src.id, "billsOnly");
  ok(!/КАССА 3/.test(main().querySelector("[data-pos-txt]").textContent) && /Молоко/.test(main().querySelector("[data-pos-txt]").textContent), "«Только строки чека» убирает строки вне чека");
  posSet(src.id, "receiptSplit", "none");
  ok(!main().querySelector('[data-pos-list="receiptEndWords"] .pos-list-in:not([disabled])'), "при делении по началу слова конца не нужны");
  posSet(src.id, "receiptSplit", "skip");
  posTog(src.id, "ignoreCase");
  ok(node().ignoreCase === false, "регистр слов начала и конца: флажок снят");

  // Подсветка: слово из строки, флажки «С учётом регистра», «Вся строка», «Менять фон»
  const wordsWas = (node().words || []).length;
  posRawUse(src.id, iWord, "word");
  ok(node().words.length === wordsWas + 1 && node().words.at(-1).msg === L[iWord].trim(), "слово добавлено из строки");
  wordFlag(src.id, wordsWas, "wholeLine");
  wordFlag(src.id, wordsWas, "caseSensitive");
  wordFlag(src.id, wordsWas, "bgEnabled");
  const w = node().words[wordsWas];
  ok(w.wholeLine === true && w.caseSensitive === true && w.bgEnabled === false, "флажки слова записаны");
  ok(main().querySelectorAll(`[data-word="${wordsWas}"] input[type=checkbox]`).length === 3 && main().querySelector(`[data-word="${wordsWas}"] .pos-sw[disabled]`), "без «Менять фон» цвет фона недоступен");
  ok(/<mark/.test(main().querySelector("[data-pos-txt]").innerHTML), "подсветка слова видна в зоне");

  // Вид титров
  posSet(src.id, "overlayFont", "Consolas");
  posSet(src.id, "overlayFontSize", "14");
  posSet(src.id, "overlayColor", "#ffee00");
  posSet(src.id, "overlayBgTransparency", "60");
  ok(/Consolas/.test(main().querySelector("[data-pos-txt]").getAttribute("style")) && node().overlayFontSize === 14, "вид титров виден в зоне, размер — числом");

  // Несколько камер: чипы, зона каждой, числа и пресеты
  posCamAdd(src.id, cam2.id);
  ok(main().querySelectorAll(".pos-cam").length === 2 && node().overlays.length === 2 && node().overlays[0].cameraId === cam1.id, "две камеры титров");
  ok(posCur(node()) === cam2.id, "новая камера выбрана на кадре");
  posAreaNum(src.id, "x", "30");
  ok(Math.abs(node().overlays[1].area.x - 0.3) < 1e-9 && Math.abs(node().overlays[0].area.x - POS_AREA0.x) < 1e-9, "зона правится у выбранной камеры");
  posPreset(src.id, "br");
  ok(node().overlays[1].area.x === 0.46 && node().overlays[1].area.y === 0.22, "пресет «Справа внизу»");
  posAreaAll(src.id);
  ok(JSON.stringify(node().overlays[0].area) === JSON.stringify(node().overlays[1].area), "«Эту зону — всем камерам»");
  // Зона тянется мышью: доли кадра, в карточку — когда кнопку отпустили
  const el = main().querySelector("[data-pos-area]"), box = el.parentElement.getBoundingClientRect(), x0 = node().overlays[1].area.x;
  ok(box.width > 50, "кадр с зоной имеет ширину: " + box.width);
  posAreaDown(el, { button: 0, clientX: 100, clientY: 100, target: el, preventDefault() {} }, src.id);
  dispatchEvent(new MouseEvent("mousemove", { clientX: 100 - box.width * 0.1, clientY: 100 }));
  dispatchEvent(new MouseEvent("mouseup", {}));
  ok(node().overlays[1].area.x < x0, "зона сдвинута мышью влево");
  posAreaNum(src.id, "x", "90");
  posAreaNum(src.id, "w", "3");
  const za = node().overlays[1].area;
  ok(za.w >= 0.08 && za.x + za.w <= 1 + 1e-9, "узкая ширина не выводит зону за кадр: " + JSON.stringify(za));

  // Приём и разбор данных (вкладка «Подключение»)
  open("gen");
  posSet(src.id, "protocol", "rs232");
  ok(node().comPort === "COM1" && node().baudRate === 9600 && !main().querySelector('[data-df="Адрес кассы или сервера"]'), "RS-232: порт и скорость по умолчанию, адреса нет");
  posSet(src.id, "baudRate", "19200");
  posSet(src.id, "encoding", "dos2win");
  posSet(src.id, "parserFile", "pos_kassa3.prl");
  posSet(src.id, "timeOffsetMs", "-300");
  ok(node().baudRate === 19200 && node().timeOffsetMs === -300, "числа — числами");
  ok(cardApiItems(node(), cardDiff()).filter((x) => x.set && ("protocol" in x.set)).length === 1, "смена протокола на RS-232 — один шаг, а не по шагу на поле");
  const plan = cardDiff().map((r) => r.label);
  ok(cardDiff().find((r) => r.key === "overlays")?.toT.includes("%"), "в плане у камер титров видна зона");
  ok(plan.includes("Камеры титров") && plan.includes("Приём данных") && !plan.includes("COM-порт"), "в плане — подписи полей: " + plan.join("; "));

  // Применить: поля на сервере, cameraId (устарело) — первая камера
  const srv = await apply();
  ok(srv.overlays.length === 2 && srv.cameraId === cam1.id && srv.overlays[0].cameraId === cam1.id, "камеры на сервере, cameraId — первая");
  ok(srv.overlayFont === "Consolas" && srv.overlayFontSize === 14 && srv.overlayColor === "#ffee00" && srv.overlayBgTransparency === 60, "вид титров на сервере");
  ok(srv.protocol === "rs232" && srv.comPort === "COM1" && srv.baudRate === 19200 && srv.encoding === "dos2win" && srv.parserFile === "pos_kassa3.prl" && srv.timeOffsetMs === -300, "приём и разбор данных на сервере: " + JSON.stringify([srv.protocol, srv.comPort, srv.baudRate, srv.encoding, srv.parserFile, srv.timeOffsetMs]));
  ok(srv.receiptStartWords[0] === L[iStart].trim() && srv.ignoreCase === false && srv.billsOnly === true, "разбор чека на сервере");
  ok(srv.words.at(-1).wholeLine === true && srv.words.at(-1).caseSensitive === true && srv.words.at(-1).bgEnabled === false, "флажки слова на сервере");

  // Назад на TCP: поля RS-232 уходят, список камер можно сократить
  open("gen");
  posSet(src.id, "protocol", "tcp");
  ok(node().comPort === undefined && node().baudRate === undefined, "при TCP полей RS-232 нет");
  ok(cardApiItems(node(), cardDiff()).filter((x) => x.set && ("protocol" in x.set)).length === 1, "смена протокола на TCP — тоже один шаг");
  posCamDel(src.id, cam1.id);
  const back = await apply();
  ok(back.protocol === "tcp" && back.comPort === undefined && back.overlays.length === 1 && back.cameraId === cam2.id, "TCP, одна камера, cameraId — оставшаяся");

  // Клиент 0.4.0 пишет одно cameraId: первая камера списка заменена
  await uiPatch(src.id, { cameraId: cam1.id }, hwVer.get(src.id));
  const old = await uiRec(src.id);
  ok(old.overlays.length === 1 && old.overlays[0].cameraId === cam1.id && old.cameraId === cam1.id, "правка cameraId меняет первую камеру списка");

  hwApplyUnit(await API.get(`/units/${src.id}`));   // правку сделал клиент 0.4.0 мимо кэша

  // Система без overlays в схеме вида: одна камера через cameraId, без зоны, пресетов и списка
  const kp = KINDS.get("eventsrc").schema.properties, ovDef = kp.overlays;
  delete kp.overlays;
  DEVICE_PATCH.delete("overlays");
  try {
    open("overlay");
    ok(!main().querySelector(".pos-presets") && !main().querySelector(".pos-nums") && !main().querySelector(".pos-h"), "без overlays нет пресетов, чисел и ручек зоны");
    ok(!main().querySelector(".pos-cam-add"), "пока камера задана, «+ Камера» скрыта");
    posCamDel(src.id, posCur(node()));
    ok(main().querySelectorAll(".pos-cam").length === 0, "камера убрана");
    const gone = await apply();
    ok(gone.cameraId == null, "cameraId снят на сервере");
    posCamAdd(src.id, cam2.id);
    const set = await apply();
    ok(set.cameraId === cam2.id, "камера ушла на сервер через cameraId: " + set.cameraId);
  } finally {
    kp.overlays = ovDef;
    DEVICE_PATCH.add("overlays");
  }
});
