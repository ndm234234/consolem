/* Сценарии интерфейса: форма «По адресу» — режим «Несколько устройств» с диапазоном IP (прототип 88, пробел F3 против
   Axxon One: web-configurator manually-add-camera — переключатель Single / Bulk, ip_address {min, max}, maxRange 500,
   порт 1–65535). Проверка адреса и порта под полем, строка плана на каждый адрес, повтор
   адреса не попадает в план. Флажка «Break Unused Connections» в форме нет: редкая настройка, решение владельца макета.
   Функции нет в index.html: там сценарий только отмечает пропуск. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until }) => {
  if (typeof manualRangeIps !== "function") {
    ok(true, "режима «Несколько устройств» на этой странице нет: проверять нечего");
    return;
  }
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

  // Одно устройство: проверка адреса и порта под полем
  set("devManIp", "192.168.1.300");
  ok(/IPv4/.test(document.getElementById("devManIpErr").textContent), "неверный адрес — текст ошибки под полем");
  ok(document.getElementById("devManIp").classList.contains("dev-bad"), "неверный адрес — красная рамка");
  ok(document.getElementById("manualToPlan").disabled, "с ошибкой «В план» неактивна");
  set("devManIp", "192.168.1.12");
  set("devManPort", "70000");
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
  set("devManIpTo", "192.168.1.5x");
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

  // У RTSP и GB/T диапазона нет
  changeManualVendor("GBT28181");
  ok(!document.querySelector(".dev-ipmode") && !manualIsRange(wizd.manual), "у GB/T28181 переключателя нет");
  for (const t of ["eventsrc", "acfa"]) {
    if (!canAdd(t)) continue;
    changeManualType(t);
    ok(!document.querySelector(".dev-ipmode"), "у типа " + t + " переключателя нет");
  }
  closeWizard();
  addPlan.rows = [];
});
