/* Сценарии интерфейса: RTSP-регистратор на N каналов (Axxon One, «Configuring connection of multi-channel devices»):
   производитель RTSP и модель N_channel_device дают IP-сервер с N камерами. Мастер «По адресу» — поле «Каналы»,
   шаблон адреса с {канал}, правка адреса канала; строка плана; импорт CSV. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until }) => {
  ok(rtspModelChannels("8_channel_device") === 8 && rtspModelChannels("8_Channel_Device") === 8 && rtspModelChannels("generic") === 0, "модель N_channel_device даёт число каналов");
  ok(rtspChannelUrl("rtsp://10.0.0.5:554/ch{канал}", 3) === "rtsp://10.0.0.5:554/ch3", "шаблон: {канал} → номер канала");
  ok(rtspChannelUrl("rtsp://10.0.0.5:554/main", 3) === "", "шаблон без {канал}: адреса канала нет");

  lanOpenWizard("manual");
  changeManualVendor("RTSP");
  const m = wizd.manual;
  ok(rtspChannelsOf(m) === 1 && !document.querySelector(".rtsp-ch"), "по умолчанию один канал: одна камера, списка каналов нет");
  changeManualChannels(4);
  ok(m.model === "4_channel_device", "4 канала — модель 4_channel_device: " + m.model);
  ok(document.querySelectorAll("[data-rtsp-ch]").length === 4, "в форме список из 4 каналов");
  changeManualChannels(999);
  ok(m.channels === RTSP_CH_MAX, "каналов не больше " + RTSP_CH_MAX);
  changeManualChannels(4);

  m.rtsp = "rtsp://10.9.0.5:554/ch{канал}";
  rtspChPreview();
  ok(document.querySelector('[data-rtsp-ch="2"]').placeholder === "rtsp://10.9.0.5:554/ch2", "пустое поле канала показывает адрес из шаблона");
  updateManualChannelUrl(3, "rtsp://10.9.0.6:554/main");
  ok(document.querySelector('[data-rtsp-ch="3"]').classList.contains("own"), "свой адрес канала отмечен");
  Object.assign(m, { user: "admin", pass: "x", name: "DVR проверка" });

  const n0 = addPlan.rows.length;
  planAddManual();
  const row = addPlan.rows[addPlan.rows.length - 1];
  ok(addPlan.rows.length === n0 + 1 && row.r.channels === 4 && row.r.chUrls[3] === "rtsp://10.9.0.6:554/main", "строка плана: 4 канала и свой адрес канала 3");
  ok(/4 канала/.test(planRowTitle(row).sub), "строка плана называет число каналов: " + planRowTitle(row).sub);
  ok(!planRowIssues(row).some((i) => i.err), "строка плана без ошибок");

  // Регистратор без шаблона: адрес канала указывают позже, строку можно применить
  changeManualChannels(2);
  Object.assign(m, { rtsp: "", user: "admin", pass: "x" });
  planAddManual();
  const bare = addPlan.rows[addPlan.rows.length - 1];
  ok(addPlan.rows.length === n0 + 2, "регистратор без адреса тоже идёт в план");
  ok(!planRowIssues(bare).some((i) => i.err) && planOkRows().includes(bare), "регистратор без шаблона применяется: " + JSON.stringify(planRowIssues(bare)));
  const bareNode = manualNode(bare.r, { id: "x", type: "folder", devices: devicePool }, false, { devMode: "current", templateId: "" });
  ok(bareNode.devices.length === 2 && bareNode.devices.every((c) => !c._f), "регистратор без шаблона: 2 камеры без адреса");
  addPlan.rows.pop();

  // Пробелы в поле канала — не свой адрес
  ok(rtspChannelUrls({ rtsp: "rtsp://a/ch{канал}", chUrls: { 2: "   " } }, 2)[1] === "rtsp://a/ch2", "поле канала из пробелов берёт адрес из шаблона");

  // Модель, набранная руками, задаёт число каналов
  changeManualChannels(1);
  updateManual("model", "6_channel_device");
  ok(rtspChannelsOf(wizd.manual) === 6, "модель 6_channel_device руками — 6 каналов: " + wizd.manual.channels);
  changeManualChannels(4);
  Object.assign(m, { rtsp: "rtsp://10.9.0.5:554/ch{канал}", user: "admin", pass: "x", name: "DVR проверка" });
  updateManualChannelUrl(3, "rtsp://10.9.0.6:554/main");

  const s = { id: wizd.server || "x", type: "folder", devices: devicePool };
  const node = manualNode(row.r, s, false, { devMode: "current", templateId: "" });
  ok(node.type === "ipsrv" && node.model === "4_channel_device" && node.devices.length === 4, "узел: IP-сервер 4_channel_device с 4 камерами");
  ok(node.devices.map((c) => c._f?.RTSP || "").join() === "rtsp://10.9.0.5:554/ch1,rtsp://10.9.0.5:554/ch2,rtsp://10.9.0.6:554/main,rtsp://10.9.0.5:554/ch4", "адреса камер: из шаблона и свой у канала 3");
  ok(node.devices.every((c, i) => c.type === "camera" && c.name === `${i18n("Канал")} ${i + 1}`), "камеры называются «Канал 1…4»");

  // Один канал — прежняя одна камера
  changeManualChannels(1);
  ok(m.model === "" && !document.querySelector(".rtsp-ch"), "1 канал: модель N_channel_device снята, списка нет");
  const one = manualNode({ ...m, rtsp: "rtsp://10.9.0.7/main" }, s, false, { devMode: "current", templateId: "" });
  ok(one.type === "camera" && one._f?.RTSP === "rtsp://10.9.0.7/main", "1 канал: одна камера с адресом RTSP");

  // Смена производителя сбрасывает каналы
  changeManualChannels(8);
  changeManualVendor("Axis");
  ok(rtspChannelsOf(m) === 1 && m.channels === 1, "другой производитель: каналов снова 1");

  // CSV: RTSP + N_channel_device
  const txt = buildDeviceCsvText([{ ip: "10.9.0.20", port: "554", vendor: "RTSP", model: "3_channel_device", user: "admin", pass: "p", identifier: "", short: "dvr", name: "", lat: "", lon: "", azimuth: "", archive: "", record: "Нет", group: "", rtspUrl: "rtsp://10.9.0.20:554/ch{канал}" }]);
  const r = parseCsvDeviceRows(txt.replace(/^﻿/, ""))[0];
  ok(inferCsvDeviceKind(r).channels === 3 && !r.errors.length && r.name === i18n("RTSP-регистратор"), "CSV: строка — регистратор на 3 канала: " + r.name);
  const crow = planPush("csv", r);
  crow.open = true;
  const chtml = planRowHtml(crow);
  ok(/Шаблон адреса RTSP/.test(chtml) && /ch\{канал\}/.test(chtml), "CSV: строка плана называет поле шаблоном адреса");
  ok(/3 канала/.test(planRowTitle(crow).sub), "CSV: заголовок строки называет число каналов: " + planRowTitle(crow).sub);
  addPlan.rows.pop();
  const cn = csvDeviceNode(r, s, false, "current");
  ok(cn.type === "ipsrv" && cn.devices.length === 3 && cn.devices[2]._f?.RTSP === "rtsp://10.9.0.20:554/ch3" && cn.devices[0].short === "dvr.1", "CSV: IP-сервер с 3 камерами, адрес и короткое имя из строки");

  // Правка строки плана: модель не регистратора каналы не трогает, число каналов не перерисовывает строку
  addPlan.rows.splice(0, addPlan.rows.length, row);
  wizStepGo(1);
  row.open = true;
  planRender();
  ok(await until(() => !!document.querySelector('[data-pf="channels"]'), 5000), "строка плана открыта");
  planEdit(row.pid, "model", "DHI-XVR5104");
  ok(row.r.channels === 4 && row.r.model === "DHI-XVR5104", "модель не регистратора оставляет 4 канала: " + row.r.channels);
  planEdit(row.pid, "model", "4_channel_device");
  const chEl = document.querySelector('[data-pf="channels"]');
  chEl.focus();
  planEdit(row.pid, "channels", "6");
  ok(document.querySelector('[data-pf="channels"]') === chEl && document.activeElement === chEl, "правка каналов не заменяет поле: курсор остаётся на месте");
  ok(document.querySelector('[data-pf="model"]').value === "6_channel_device" && /6 каналов/.test(document.querySelector(".plan-row-hd").textContent), "правка каналов обновляет модель и подпись строки");
  planEdit(row.pid, "channels", "4");

  // Применение плана: сервер сохраняет IP-сервер, камеры каналов и папку
  const fold = flatFolders().find((f) => folderDomain(f.id) === row.domainId);
  planEdit(row.pid, "group", fold.id);
  planApply();
  ok(await until(() => addPlan.added.length === 1, 30000), "план применён");
  const rec = find(addPlan.added[0].id)?.n;
  ok(rec?.type === "ipsrv" && rec.model === "4_channel_device" && rec.devices?.filter((c) => c.type === "camera").length === 4, "на сервере: IP-сервер с 4 камерами каналов");
  ok((find(fold.id)?.n?.items || []).includes(rec.id), "регистратор лёг в выбранную папку «" + fold.name + "»");
});
