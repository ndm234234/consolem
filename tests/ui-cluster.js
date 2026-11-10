/* Сценарий интерфейса: домен шире кластера — приём с отпечатком, камера без закреплённого сервера, приёмник записи, камера за NAT, домен без серверов. */
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
  const d = domains[0];
  goApp("hw");
  // Приём: сверка отпечатка до «Добавить»
  const knock = d.unallocServers.find((s) => s.fingerprint && s.cls !== "camera");
  const done = addToDomain(knock.id, d.id);
  ok(document.getElementById("fpShown")?.textContent === knock.fingerprint, "окно показывает отпечаток");
  ok(!d.servers.includes(knock), "до подтверждения не принят");
  await confirmWith(null);
  ok(await until(() => d.servers.some((s) => s.id === knock.id)), "принят после сверки");
  await done;
  ok((await uiRec(knock.id)).allocated === true, "на сервере");
  // Камера: где serverId только для чтения, архив выбирается без оглядки на сервер, сервер не закрепляется
  const cam = devicePool.find((n) => n.type === "camera" && n.srvId && n.arch);
  ok(archReach(cam).length < arch.length, "сервер объявлен настройкой: выбор ограничен им");
  const was = cam.writableFields;
  cam.writableFields = (CAPS.writable.camera || []).filter((x) => x !== "serverId");
  ok(archReach(cam).length === arch.length, "serverId только для чтения: выбор зависит только от вида");
  const free = { type: "camera", id: "x", writableFields: cam.writableFields };
  pinCamServer(free);
  bindArchServer(free);
  ok(!free.srvId, "сервер не закреплён");
  // Приёмник записи — на вкладке «Архив»
  pick(cam.id, { force: true });
  goTab("rec");
  ok(!!document.getElementById("recTarget"), "выбор приёмника на вкладке «Архив»");
  const server = d.servers.find((s) => s.online !== false && s.id !== cam.srvId);
  recTargetSet(cam.id, server.id);
  ok(await until(() => cam.recordingTarget?.serverId === server.id), "назначение в кэше");
  await planApply();
  ok((await uiRec(cam.id)).recordingTarget.serverId === server.id, "на сервере");
  await API.put(`/units/${cam.id}/recording-target`, { serverId: null, copies: [] });

  // Копии: выбираются серверами явно, мышью, поиском среди /servers; занятый кластер не предлагается, и это сказано
  const press = (e) => ["mousedown", "mouseup", "click"].forEach((type) => e.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
  const named = (name) => d.servers.find((s) => s.name === name);
  const office = named("Центр/Сервер — Офис"), hall = named("Центр/Сервер — Цех"), hangar = named("Склады/Сервер — Ангар"), gate = named("Склады/Сервер — КПП"), park = named("Периметр/Сервер — Парковка");
  const rec = () => uiRec(cam.id).then((x) => x.recordingTarget);
  const typeQ = (v) => { const i = document.getElementById("recCopyQ"); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); };
  const pickBtn = (s) => document.querySelector(`[data-rec-pick="${s.id}"]`);
  const copyRows = () => [...document.querySelectorAll("[data-rec-copy]")].map((x) => x.dataset.recCopy);
  // Камера набора со своим сервером: запись с сервера вернула бы ей writableFields, а карточка приёмника — у камеры без него
  const pinned = window.serverPinned;
  window.serverPinned = () => false;
  await API.put(`/units/${cam.id}/recording-target`, { serverId: null, copies: [] }).then((r) => { hwApplyUnit(r); gear(); });
  ok(!document.getElementById("recCopies"), "нет приёмника — копий нет");
  await recTargetSet(cam.id, office.id);
  await planApply();
  ok(await until(() => document.getElementById("recCopyQ")), "приёмник назначен — выбор копий на месте");
  ok(document.getElementById("recNoCopies"), "копий нет — словами");
  ok(/кластер Центр/.test(document.getElementById("recTarget").selectedOptions[0].textContent), "кластер рядом с сервером: " + document.getElementById("recTarget").selectedOptions[0].textContent);
  ok(/Назначение держит кластер «Центр»/.test(document.getElementById("recCluster").textContent), "кто держит назначение, словами");
  ok(!pickBtn(hall) && !pickBtn(office), "свой кластер не предлагается");
  ok(/занятых кластеров: «Центр»/.test(document.getElementById("recCopyTaken").textContent), "словами: " + document.getElementById("recCopyTaken").textContent);
  const inputKept = document.getElementById("recCopyQ");
  typeQ("ангар");
  ok(document.getElementById("recCopyQ") === inputKept, "поиск не перерисовывает поле");
  ok(pickBtn(hangar) && !pickBtn(park), "поиск сужает список");
  press(pickBtn(hangar));
  ok(await until(() => copyRows().join() === hangar.id), "копия выбрана мышью");
  await planApply();
  ok((await rec()).copies.join() === hangar.id, "на сервере");
  ok(document.getElementById("recCopyQ").value === "", "поиск очищен");
  ok(!pickBtn(gate), "второй сервер кластера копии не предлагается");
  ok(/«Склады»/.test(document.getElementById("recCopyTaken").textContent), "занятый копией кластер назван");
  ok(![...document.getElementById("recTarget").options].some((o) => o.value === gate.id), "в приёмнике сервер кластера копии не предлагается");
  ok(/(занятых копиями|уже хранят копии): «Склады»/.test(document.getElementById("recMainTaken").textContent), "и это сказано");
  typeQ("парковка");
  press(pickBtn(park));
  ok(await until(() => copyRows().join() === [hangar.id, park.id].join()), "вторая копия");
  press(document.querySelector(`[data-rec-copy="${park.id}"] [data-rec-up]`));
  ok(await until(() => copyRows().join() === [park.id, hangar.id].join()), "порядок меняется");
  await planApply();
  ok((await rec()).copies.join() === [park.id, hangar.id].join(), "порядок на сервере");
  // Смена приёмника копии не теряет
  await recTargetSet(cam.id, hall.id);
  await planApply();
  ok(await until(() => cam.recordingTarget?.serverId === hall.id) && (await rec()).copies.length === 2, "смена приёмника копии сохранила");
  // Отказ сервера — тостом, копии как были. Форма занятого не предлагает, отказ — на случай чужой правки
  const put0 = API.put;
  API.put = () => Promise.reject({ status: 422, problem: { code: "VALIDATION_FAILED", field: "copies" } });
  await recCopyDrop(cam.id, 0);
  await planApply();
  API.put = put0;
  ok(copyRows().length === 2, "отказ: копии как были");
  press(document.querySelector(`[data-rec-copy="${park.id}"] [data-rec-drop]`));
  ok(await until(() => copyRows().join() === hangar.id), "копия убрана");
  await planApply();
  // На чтении вернулся другой сервер того же кластера: это не чужая правка
  const recBefore = await uiRec(cam.id);
  hwApplyDevice(Object.assign({}, recBefore, { recordingTarget: { serverId: office.id, copies: [gate.id] } }));
  gear();
  ok(await until(() => document.getElementById("recTarget")?.value === office.id), "показан сервер, что вернулся");
  ok(!/изменил|Изменено другим/i.test(document.getElementById("tt")?.textContent || "") && !cardDraft, "чужой правкой не считается");
  ok(/кластер Склады/.test(document.querySelector(`[data-rec-copy="${gate.id}"]`).textContent), "у копии кластер рядом с сервером");
  await API.put(`/units/${cam.id}/recording-target`, { serverId: null, copies: [] }).then((r) => { hwApplyUnit(r); gear(); });
  window.serverPinned = pinned;
  cam.writableFields = was;
  if (was === undefined) delete cam.writableFields;
  // Камера за NAT: кнопки движения выключены, «Запомнить здесь» тоже, подпись пресета можно
  const ptz = devicePool.find((n) => n.type === "camera" && n.ptz && n.online !== false);
  ptz.direct = false;
  pick(ptz.id, { force: true });
  await until(() => !ptz._row);
  ptz.direct = false;
  ok(/disabled/.test(ptzCardHtml(ptz).split('data-ptz="0"')[1].slice(0, 200)), "движение выключено");
  // ADR-0111 доп. (1): положение не запомнить, подпись сохраняется. Настоящим кликом
  goTab("vid");
  delete ptz.direct;
  if (!presetRows(ptz).length) await presetPut(ptz.id, 1, { name: "" });
  ptz.direct = false;
  gear();
  ok(await until(() => document.querySelector("[data-preset-save]")), "пресеты на вкладке «Видео»");
  const saveBtn = document.querySelector("[data-preset-save]"), presetNo = Number(saveBtn.closest("[data-preset]").dataset.preset);
  ok(saveBtn.disabled, "«Запомнить здесь» неактивна");
  ok(/за NAT/.test(saveBtn.title), "подсказка почему: " + saveBtn.title);
  ok(/за NAT/.test(document.querySelector("[data-preset-nat]").textContent), "слова на карточке");
  ok(!/канал|вход/i.test(document.querySelector("[data-preset-nat]").textContent + saveBtn.title), "ни канала домена, ни входа не обещает");
  const presetPuts = [], putBefore = API.put;
  API.put = (p, b, ...r) => { if (/\/presets\//.test(p)) presetPuts.push(b); return putBefore(p, b, ...r); };
  press(saveBtn);
  await new Promise((r) => setTimeout(r, 50));
  ok(!presetPuts.length, "клик по неактивной ничего не шлёт");
  const label = "За воротами " + presetNo, nameInput = document.querySelector(`[data-preset="${presetNo}"] input`);
  press(nameInput);
  nameInput.value = label;
  nameInput.dispatchEvent(new Event("change", { bubbles: true }));
  ok(await until(() => presetPuts.length === 1), "подпись ушла");
  ok(presetPuts[0].name === label && Object.keys(presetPuts[0]).join() === "name", "только имя: положение не трогается");
  // Запрос замечен при отправке: по HTTP чтение обогнало бы ответ. Ответ применён — тогда и спрашивать сервер
  ok(await until(() => presetRows(find(ptz.id).n).find((x) => x.n === presetNo)?.name === label), "подпись пришла в форму");
  ok((await uiRec(ptz.id)).presets.find((x) => x.n === presetNo).name === label, "подпись сохранена на сервере");
  API.put = putBefore;
  ok(/^камера за NAT(: связи с ней нет, действие недоступно|\. Связи с ней нет, поэтому действие недоступно)$/.test(problemText({ problem: { code: "OTHER_CLUSTER" } }, { id: ptz.id, direct: false })), "problemText: за NAT без обещания входа");
  ok(/^камера другого кластера(: откройте вход через него|\. Открыть вход через этот кластер)$/.test(problemText({ problem: { code: "OTHER_CLUSTER", params: { url: "https://x" } } }, { id: ptz.id })), "problemText: есть ссылка — есть вход");
  ok(/^камера другого кластера[:.] [оО]тсюда это недоступно$/.test(problemText({ problem: { code: "OTHER_CLUSTER" } }, { id: ptz.id })), "problemText: ссылки нет — входа не обещает");
  delete ptz.direct;
  // Камера-кластер: правка принята, это не отказ. Настоящая камера, приём сервера вида camera
  const knockCam = d.unallocServers.find((s) => s.cls === "camera" && s.fingerprint) || d.unallocServers.find((s) => s.cls === "camera");
  const camsBefore = new Set((await uiDevices()).map((x) => x.id));
  const taken = addToDomain(knockCam.id, d.id);
  await until(() => document.getElementById("fpShown") || !document.getElementById("confirm").classList.contains("open"));
  if (document.getElementById("confirm").classList.contains("open")) await confirmWith(null);
  await taken;
  let wc = null;
  ok(await until(() => { wc = devicePool.find((n) => n.direct === false && !camsBefore.has(n.id)) || null; return wc; }, 8000), "камера-кластер принята: " + (wc && wc.name));
  const wrec = await uiRec(wc.id);
  const kept1 = await uiPatch(wc.id, { name: wrec.name + " 2" }, wrec.version).catch((e) => e);
  ok(kept1.status === 409 && problemKept(kept1), "стенд: 409 SERVER_OFFLINE с kept");
  ok(problemText(kept1, wc) === "Принято, применится", "словами: принято");
  ok(problemText({ problem: { code: "SERVER_OFFLINE" } }, wc) !== "Принято, применится", "без kept — прежнее слово");
  keptNote(wc.id);
  const v412 = await uiPatch(wc.id, { name: wrec.name + " 3" }, wrec.version).catch((e) => e);
  ok(v412.status === 412 && /прежняя правка камеры ещё не применилась|предыдущее изменение камеры ещё не применено/.test(problemText(v412, wc)), "вторая правка до применения: " + problemText(v412, wc));
  hwApplyDevice(Object.assign({}, wrec, { version: wrec.version + "x" }));
  ok(!KEPT_WAIT.has(wc.id), "новая версия пришла — ожидание снято");
  // Групповая: строка элемента, не отказ, «Отменить» нет
  const fakeOps = [{ n: wc, state: "run", done: false }, { n: wc, state: "wait", done: false }];
  bq = { steps: [{ label: "Правка", ops: fakeOps }], title: "Правка", total: 2, done: 0, ok: 0, fail: 0, skipped: 0, api: "op-k", apiOps: fakeOps, finished: false, cur: "" };
  apiOnEvent({ kind: "operation", type: "operation.progress", entityId: "op-k", payload: { item: { index: 0, targetId: wc.id, state: "fail", code: "SERVER_OFFLINE", params: { targetId: wc.id, kept: "k1" } } } });
  ok(fakeOps[0].state === "ok" && fakeOps[0].msg === "Принято, применится" && bq.fail === 0 && bq.ok === 1, "kept в групповой — не отказ, строкой элемента");
  apiOnEvent({ kind: "operation", type: "operation.progress", entityId: "op-k", payload: { item: { index: 1, targetId: wc.id, state: "fail", code: "SERVER_OFFLINE" } } });
  ok(fakeOps[1].state === "fail" && bq.fail === 1, "без kept — отказ");
  bq = null;
  KEPT_WAIT.clear();
  // Домен без серверов: конфигуратор на самой камере. Приём камерой (шаг move операции) снимает запись сервера — кэш
  // перечитан, объект домена новый: берётся тот, что в кэше сейчас
  const dn = domainById(d.id), list = dn.servers, un = dn.unallocServers;
  dn.servers = [];
  dn.unallocServers = [];
  pick(dn.id, { force: true });
  goTab("topo");
  ok(G7.g.nodes.length === 1 && /нет серверов/.test(document.getElementById("g7Empty")?.textContent || ""), "домен без серверов: один узел и слова");
  renderTree();
  ok(!!document.querySelector(`#tree .n[data-pick="${dn.id}"]`), "дерево выдержало");
  goTab("gen");
  dn.servers = list;
  dn.unallocServers = un;
  // Отказ словами
  ok(/другого кластера/.test(problemText({ problem: { code: "OTHER_CLUSTER", params: { url: "x" } } })), "другой кластер: словами");
  ok(/не отвечает/.test(problemText({ problem: { code: "DEVICE_OFFLINE" } })), "камера не отвечает, а не сервер");
});
