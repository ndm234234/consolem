/* Сценарии интерфейса: форма «По адресу» — режим «Несколько устройств» с диапазоном IP (index.html, из прототипа 90; пробел F3 против
   Axxon One: web-configurator manually-add-camera — переключатель Single / Bulk, ip_address {min, max}, maxRange 500,
   порт 1–65535). Проверка адреса и порта под полем, строка плана на каждый адрес, повтор
   адреса не попадает в план. Флажка «Break Unused Connections» в форме нет: редкая настройка, решение владельца макета.
   Из прототипа 89 (объединён с 90): ошибка видна после ухода из поля, Enter или «В план», а верное значение её снимает;
   у источника событий адрес может быть именем хоста; у ACFA полей адреса нет; Enter в поле адреса — «Определить»;
   вставка «первый-последний» включает «Несколько устройств»; строка плана проверяет адрес и порт.
   Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, absent }) => {
  // Охрана manualRangeIps — для прототипов, скопированных с index.html до переноса; на index.html она — сбой (absent)
  if (typeof manualRangeIps !== "function") { absent("режима «Несколько устройств» (manualRangeIps)"); return; }
  // Разбор адресов
  ok(ipv4Num("192.168.1.10") === 3232235786, "адрес IPv4 в число");
  ok(ipv4Num("192.168.1.300") === null && ipv4Num("10.0.0") === null && ipv4Num("a.b.c.d") === null, "неверный IPv4 — null");
  ok(ipv4Str(3232235786) === "192.168.1.10", "число в адрес IPv4");

  lanOpenWizard("manual");
  ok(await until(() => !!document.getElementById("devManIp"), 10000), "форма «По адресу» открыта");
  const m = wizd.manual;
  m.model = (DEVICE_MODELS[m.vendor] || [])[0] || "X";
  ok(!!document.querySelector(".dev-ipmode"), "у IP-устройства есть переключатель «Одно устройство / Несколько устройств»");
  const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); };
  const blur = (id) => document.getElementById(id).dispatchEvent(new FocusEvent("blur"));
  // Значение и уход из поля: ошибку форма показывает только после ухода
  const put = (id, v) => { set(id, v); blur(id); };
  const paste = (id, text) => {
    const dt = new DataTransfer(); dt.setData("text", text);
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById(id).dispatchEvent(e);
    return e.defaultPrevented;
  };

  // Одно устройство: пока адрес набирают, ошибки нет; после ухода из поля — есть
  set("devManIp", "192.168.");
  ok(document.getElementById("devManIpErr").textContent === "" && !document.getElementById("manualToPlan").disabled, "адрес набирают — ошибки нет, «В план» активна");
  put("devManIp", "192.168.1.300");
  ok(/IPv4/.test(document.getElementById("devManIpErr").textContent), "неверный адрес — текст ошибки под полем");
  ok(document.getElementById("devManIp").classList.contains("dev-bad"), "неверный адрес — красная рамка");
  ok(document.getElementById("manualToPlan").disabled, "с ошибкой «В план» неактивна");
  set("devManIp", "192.168.1.12");
  ok(document.getElementById("devManIpErr").textContent === "" && !document.getElementById("devManIp").classList.contains("dev-bad"), "верный адрес сразу снимает ошибку");
  put("devManPort", "70000");
  ok(/65535/.test(document.getElementById("devManPortErr").textContent), "порт вне 1–65535 — ошибка под полем");
  set("devManPort", "80");
  ok(!document.getElementById("manualToPlan").disabled, "без ошибок «В план» активна");
  set("devManIp", "192.168.1.012");
  set("devManPort", "080");
  const n0 = addPlan.rows.length;
  planAddManual();
  ok(addPlan.rows.length === n0 + 1, "одно устройство — одна строка плана");
  const one = addPlan.rows[addPlan.rows.length - 1].r;
  ok(one.ip === "192.168.1.12" && String(one.port) === "80", "адрес и порт в строке — в одном виде: " + one.ip + ":" + one.port);

  // Несколько устройств
  setManualIpMode("range");
  ok(!!document.getElementById("devManIpTo"), "режим диапазона: поле «Последний IP-адрес»");
  set("devManIp", "192.168.1.10");
  put("devManIpTo", "192.168.1.5x");
  ok(/IPv4/.test(document.getElementById("devManIpToErr").textContent), "неверный последний адрес — ошибка под полем");
  set("devManIpTo", "192.168.1.5");
  ok(/меньше первого/.test(document.getElementById("devManIpToErr").textContent), "последний адрес меньше первого — ошибка");
  ok(document.getElementById("manualToPlan").disabled, "обратный диапазон — «В план» неактивна");
  set("devManIpTo", "192.168.3.10");
  ok(/513/.test(document.getElementById("devManIpToErr").textContent), "больше 500 адресов — ошибка с числом адресов");
  set("devManIpTo", "192.168.1.50");
  ok(/41/.test(document.getElementById("devRangeSum").textContent), "итог: 41 адрес в диапазоне");
  ok(/Уже в плане: 1/.test(document.getElementById("devRangeSum").textContent), "итог называет адрес, который уже в плане");
  ok(document.getElementById("manualToPlan").textContent.includes("41"), "на кнопке — число адресов");
  const idInp = [...document.querySelectorAll(".dev-grid > div")].find((d) => d.querySelector("label")?.textContent === "ID")?.querySelector("input");
  ok(!!idInp && idInp.disabled && !wizd.manualAddedId, "в режиме диапазона ID назначает консоль");

  const n1 = addPlan.rows.length;
  planAddManual();
  const added = addPlan.rows.slice(n1);
  ok(added.length === 40, "диапазон 41 адрес, один уже в плане — 40 новых строк: " + added.length);
  ok(new Set(addPlan.rows.map((x) => x.r.ip)).size === addPlan.rows.length, "адрес в плане не повторяется");
  ok(added.every((x) => x.r.identifier === ""), "строки диапазона: ID авто");
  ok(m.ip === "" && m.ipTo === "", "после «В план» поля диапазона пусты");
  ok(!document.querySelector(".dev-break"), "флажка «Прервать неиспользуемое соединение» в форме нет");

  // Нажатие «В план» с ошибкой, которую ещё не показывали: ошибка появляется, строк нет
  set("devManIp", "192.168.1.70");
  set("devManIpTo", "192.168.1.6x");
  const nH = addPlan.rows.length;
  planAddManual();
  ok(addPlan.rows.length === nH && /IPv4/.test(document.getElementById("devManIpToErr").textContent), "«В план» показывает скрытую ошибку и не добавляет строк");

  // Диапазон целиком из повторов: в план ничего не легло — набранный диапазон остаётся в форме
  setManualIpMode("range");
  set("devManIp", "192.168.1.20");
  set("devManIpTo", "192.168.1.22");
  const n2 = addPlan.rows.length;
  planAddManual();
  ok(addPlan.rows.length === n2 && m.ip === "192.168.1.20" && m.ipTo === "192.168.1.22", "все адреса уже в плане — строк нет, поля не очищены");

  // Назад к одному устройству: поля «Последний IP-адрес» нет, кнопка без числа
  setManualIpMode("one");
  ok(!document.getElementById("devManIpTo") && !manualIsRange(m), "режим «Одно устройство»: одно поле адреса");
  ok(document.getElementById("manualToPlan").textContent === "В план", "кнопка без числа адресов");

  // Набранный руками дефис диапазон не раскладывает: только вставка
  set("devManIp", "10.0.0.1-10.0.0.2");
  ok(!manualIsRange(m), "набранный «10.0.0.1-10.0.0.2» не раскладывается, пока его набирают");
  set("devManIp", "");
  // Вставка «первый-последний» в поле адреса включает «Несколько устройств»
  ok(paste("devManIp", "10.0.0.1-10.0.0.9"), "вставка диапазона перехвачена");
  ok(manualIsRange(m) && m.ip === "10.0.0.1" && m.ipTo === "10.0.0.9" && document.activeElement?.id === "devManIpTo", "вставка диапазона разложена по двум полям, фокус в последнем");
  ok(document.activeElement.selectionStart === document.activeElement.value.length, "курсор в конце поля «Последний IP-адрес»");
  paste("devManIp", "10.0.1.1-10.0.1.5");
  ok(m.ip === "10.0.1.1" && m.ipTo === "10.0.1.5", "в режиме диапазона вставка тоже раскладывается");
  // Перерисовка, пока поле с фокусом, не показывает его ошибку
  setManualIpMode("one");
  wizd.manualShow = new Set();
  set("devManIp", "1.2.3");
  renderDeviceWizard();
  manualFieldBlur("ip", document.createElement("input"));   // так приходит blur поля, которое перерисовка убрала из документа
  ok(!wizd.manualShow.has("ip") && document.getElementById("devManIpErr").textContent === "", "перерисовка не считается уходом из поля");
  set("devManIp", "");
  // «В план» не забирает фокус у поля: иначе blur выключит кнопку раньше click
  const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  document.getElementById("manualToPlan").dispatchEvent(md);
  ok(md.defaultPrevented, "mousedown на «В план» не уводит фокус из поля");
  // Пустой порт: «В план» показывает ошибку порта
  set("devManIp", "192.168.1.98");
  set("devManPort", "");
  const nP = addPlan.rows.length;
  planAddManual();
  ok(addPlan.rows.length === nP && /65535/.test(document.getElementById("devManPortErr").textContent), "пустой порт — «В план» показывает ошибку и не добавляет строку");
  set("devManPort", "80");
  ok(document.getElementById("devManPortErr").textContent === "", "введённый порт снимает ошибку");

  // Enter в поле адреса: один верный адрес — «Определить»
  let detected = 0;
  const realDetect = window.detectManualModel;
  window.detectManualModel = () => { detected++; };
  set("devManIp", "192.168.1.99");
  document.getElementById("devManIp").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok(detected === 1, "Enter в поле адреса запускает «Определить»");
  put("devManIp", "192.168.1.999");
  document.getElementById("devManIp").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok(detected === 1, "Enter с неверным адресом «Определить» не запускает");
  window.detectManualModel = realDetect;
  set("devManIp", "");

  // Строка плана проверяет адрес и порт так же, как форма
  const rowBad = { source: "manual", r: { type: "camera", ip: "10.0.0.300", port: 80, vendor: m.vendor, model: m.model } };
  ok(/IPv4/.test(planConnError(rowBad)), "строка плана с неверным адресом — ошибка: " + planConnError(rowBad));

  // У RTSP и GB/T диапазона нет
  changeManualVendor("GBT28181");
  ok(!document.querySelector(".dev-ipmode") && !manualIsRange(wizd.manual), "у GB/T28181 переключателя нет");
  for (const t of ["eventsrc", "acfa"]) {
    if (!canAdd(t)) continue;
    changeManualType(t);
    ok(!document.querySelector(".dev-ipmode"), "у типа " + t + " переключателя нет");
  }
  // Источник событий: адрес — IPv4 или имя хоста
  const ev = { type: "eventsrc", ip: "pos-01.shop.local", port: 80 };
  ok(!manualFieldErrors(ev).ip, "у источника событий имя хоста проходит");
  ok(/имя хоста/.test(manualFieldErrors({ ...ev, ip: "плохой адрес" }).ip || ""), "у источника событий неверный адрес — ошибка с именем хоста");
  ok(!!manualFieldErrors({ ...ev, ip: "10.0.0.1-10.0.0.5" }).ip, "у источника событий диапазон — не имя хоста, ошибка");
  // ACFA: адреса и порта нет, проверять нечего
  ok(Object.keys(manualFieldErrors({ type: "acfa", ip: "x", port: "0" })).length === 0, "у ACFA адрес и порт не проверяются");
  if (canAdd("acfa")) {
    changeManualType("acfa");
    ok(document.getElementById("devManIp")?.disabled && document.getElementById("devManPort")?.disabled, "у ACFA поля адреса и порта заблокированы");
    ok(![...document.querySelectorAll(".dev-grid button")].some((b) => /Определить/.test(b.textContent)), "у ACFA кнопки «Определить» нет");
  }
  closeWizard();
  addPlan.rows = [];
});
