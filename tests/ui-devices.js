/* Сценарии интерфейса: поиск в сети и мастер добавления (найденные, вручную), детекторы камеры, вкладка
   «Сеть». Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  goApp("hw");
  const d1 = domains[0];
  // Поиск в сети домена: на сервере, найденное — по одному
  ensureFoundWizard(d1.id);
  const before = wizd.devResults.length;
  ok(before > 0 && /^f/.test(wizd.devResults[0].id), "итог прошлого поиска — с сервера: " + before);
  refreshDeviceSearch();
  ok(wizd.devState === "searching" && wizd.devResults.length === 0, "поиск начат, список пуст");
  ok(await until(() => wizd.devState === "searching" && wizd.devResults.length > 0 && wizd.devResults.length < before), "находки приходят по одной");
  ok(await until(() => wizd.devState === "done" && wizd.devResults.length === before), "поиск закончен: " + wizd.devResults.length);
  ok((await API.get(`/domains/${d1.id}/discovery`)).state === "done", "на сервере — закончен");
  // Добавить выбранные
  const pickRows = wizd.devResults.filter((r) => r.status === "ok").slice(0, 2);
  pickRows.forEach((r) => {
    r.user = "admin";
    r.pass = "secret";
    wizd.devSelected.add(r.id);
  });
  const n0 = devicePool.length;
  addSelectedFoundDevices();
  ok(await until(() => pickRows.every((r) => r.added)), "выбранные добавлены");
  ok(devicePool.length === n0 + 2, "в кэше — два новых устройства");
  const added = await API.get("/devices/" + pickRows[0].addedId);
  ok(added.ip === pickRows[0].ip && added.hasPassword && /^\d+$/.test(added.identifier), "на сервере: адрес, пароль задан, номер " + added.identifier);
  ok(pickRows[0].identifier === added.identifier, "номер в строке — тот, что выдал сервер");
  ok((await API.get(`/domains/${d1.id}/discovery`)).candidates.every((c) => !pickRows.some((r) => r.id === c.id)), "добавленные ушли из найденных на сервере");
  // Вручную: определить модель и добавить
  wizd.manual = { type: "camera", name: "Камера — вручную", identifier: "", short: "", ip: "10.5.5.5", port: "80", vendor: "Axis", model: "", user: "admin", pass: "1", record: "none", arch: "", lat: "", lon: "", azimuth: "", group: wizd.folder };
  detectManualModel();
  ok(await until(() => !!wizd.manual.model), "модель определена: " + wizd.manual.model);
  commitManualDevice(false);
  ok(await until(() => !!wizd.manualAddedId), "добавлено вручную");
  ok((await API.get("/devices/" + wizd.manualAddedId)).model === wizd.manual.model, "на сервере — с моделью");
  // Импорт CSV: камера и регистратор с каналами; номера — по порядку, короткие имена каналов — от номера регистратора
  const row = (o) => ({ id: "csv" + o.ip, short: "", identifier: "", port: "80", user: "admin", pass: "1", group: "", arch: "", record: "none", lat: "", lon: "", azimuth: "", errors: [], ...o });
  wizd.csvRows = [row({ name: "Камера CSV", ip: "10.6.6.6", vendor: "Axis", model: "P3245-LV" }), row({ name: "NVR CSV", ip: "10.6.6.7", vendor: "Dahua", model: "Dahua NVR 5216" })];
  const pool0 = devicePool.length;
  importCsvDevices();
  ok(await until(() => wizd.csvRows.every((r) => r.added)), "CSV импортирован");
  const nvr = find(wizd.csvRows[1].addedId)?.n;
  ok(devicePool.length === pool0 + 2 && nvr?.type === "ipsrv", "камера и регистратор в кэше");
  const nvrRec = await API.get("/devices/" + nvr.id);
  const kids = (await API.get("/devices")).items.filter((d) => d.parentId === nvr.id);
  ok(kids.length > 0 && kids.every((k) => String(k.short || "").startsWith(nvrRec.identifier + ".")), "каналы: " + kids.map((k) => k.short).join(", ") + " — от номера " + nvrRec.identifier);
  // Детектор из карточки камеры: шаг create, затем удаление
  const cam = devicePool.find((n) => n.type === "camera" && n.name === "Главный вход");
  const dets0 = camDetectors(cam).length;
  pick(cam.id);
  goTab("det");
  addDetector(cam.id);
  ok(cardDiff().some((r) => r.add), "в черновике — «Добавить: Детектор»");
  cardApply();
  ok(await until(() => bq && bq.finished && camDetectors(cam).length === dets0 + 1 && /^3/.test(camDetectors(cam).slice(-1)[0].id)), "детектор создан на сервере, id — с сервера");
  const det = camDetectors(cam).slice(-1)[0];
  ok((await API.get("/devices/" + det.id)).parentId === cam.id, "на сервере под камерой");
  deleteDetector(cam.id, det.id);
  await confirmWith(1);
  ok(await until(() => camDetectors(cam).length === dets0, 30000), "детектор удалён по истечении отсчёта");
  ok((await API.raw("GET", "/devices/" + det.id)).status === 404, "на сервере — нет");
  // Вкладка «Сеть» сервера: поиск и добавление нового
  const s = d1.servers.find((x) => x.online !== false && serverArchives(x.id).length);
  pick(s.id);
  lanEnsure(find(s.id).n);
  ok(lan.state === "searching", "поиск на вкладке «Сеть»");
  ok(await until(() => lan.state === "done" && lan.net.length > 0), "найдено в сети: " + lan.net.length);
  const net = lan.net.find((r) => !lanRows(find(s.id).n).some((x) => x.kind === "sys" && x.ip === r.ip)) || lan.net[0];
  const key = "n:" + net.id;
  const before2 = devicePool.length;
  lanAddNew(key);
  if (document.getElementById("confirm")?.classList.contains("open")) await confirmWith(null);
  ok(await until(() => devicePool.length === before2 + 1), "добавлено из «Сети»");
  const nd = devicePool[devicePool.length - 1];
  const rec = await API.get("/devices/" + nd.id);
  ok(rec.archiveId === lan.arch && rec.serverId === s.id, "на сервере: пишет в хранилище сервера, сервер — " + (rec.serverId === s.id));
  // Введённое в «Найденных» и свёрнутый узел переживают перечитывание всего кэша
  let did = null, fr = null;
  for (const k of Object.keys(found)) {
    const ids = new Set((await API.get(`/domains/${k}/discovery`)).candidates.map((c) => c.id));
    fr = foundAll(k).find((x) => !x.added && ids.has(x.id));
    if (fr) { did = k; break; }
  }
  fr.name = "Камера — введено"; fr.user = "admin"; fr.pass = "secret";
  open.delete(foundId(did));
  apiOnEvent({ type: "stream.reset" });
  ok(await until(() => foundAll(did).some((x) => x.id === fr.id) && foundAll(did).find((x) => x.id === fr.id) !== fr), "«Найденные» перечитаны");
  const fr2 = foundAll(did).find((x) => x.id === fr.id);
  ok(fr2.name === "Камера — введено" && fr2.user === "admin" && fr2.pass === "secret", "введённое на месте");
  ok(!open.has(foundId(did)), "свёрнутое осталось свёрнутым");
});
