/* Сценарии интерфейса: виды хранилищ от сервера, камера и вид, том. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  const main = () => document.getElementById("main");
  const open = (id, t = "arch") => { pick(id, { force: true }); goTab(t); };
  const body = () => document.getElementById("bmBody").textContent;
  const ref = await API.get("/reference");
  const list = await uiRecs({ implements: "vms.archive/1" });
  const of = (k) => arch.find((a) => a.kind === k);

  // Выбор вида — то, что отдал сервер, с полями этого вида
  const srvFree = servers.find((s) => !isUnallocated(s.id) && s.online !== false && s.id !== of("backup").server && !arch.some((a) => a.kind === "edge" && a.server === s.id) && volDefaults({ kind: "edge", server: s.id, storage: "block", vols: [], name: "x" }));
  addArchive(srvFree.id);
  // Виды хранилищ — описания видов vms.archive/1 (/kinds, x-archive): у сервера — все, что под сервером заводятся
  const archKinds = (await API.get("/kinds")).items.filter((k) => (k.implements || []).includes("vms.archive/1") && (k.createParents || []).includes("server"));
  ok(archKinds.length >= 4, "видов хранилищ: " + archKinds.length);
  archKinds.forEach((k) => ok(body().includes(i18n(archKindName(k.kind.replace(/^archive\./, "")))), "вид в окне: " + k.kind));
  anSet("kind", "edge");
  anGo(1);
  ok(/Когда писать/.test(body()) && !/Шифрование/.test(body()), "у карты сервера на шаге «Настройка» — режим, без шифрования");
  anGo(2);
  ok(!/Проверить подключение/.test(document.getElementById("bmFoot")?.textContent || ""), "у карты сервера на шаге «Первый том» проверки подключения нет");
  ok(an.server === srvFree.id && !anBlock(), "сервер подставлен, создать можно: " + anBlock());
  anSet("kind", "local");
  anGo(1);
  ok(!/Когда писать/.test(body()), "у локального режима нет");
  const keep = refArchKinds;
  refArchKinds = [{ ...keep.find((k) => k.kind === "network"), address: "bucket" }, keep.find((k) => k.kind === "local")];
  anSet("kind", "network");
  anGo(0);
  ok(!body().includes("Облачное"), "вид network с адресом bucket: «Облачного» в списке видов нет");
  anGo(2);
  ok(/Бакет/.test(body()) && !/Путь к папке/.test(body()), "вид network с адресом bucket: на шаге «Первый том» поля бакета");
  closeBulkModal();
  an = null;
  refArchKinds = keep;

  // Создать карту сервера: камеры этого сервера получают строку только для чтения
  addArchive(srvFree.id);
  anSet("kind", "edge");
  anSet("recordMode", "always");
  anSet("name", "Карта — сценарий", true);
  const n0 = arch.length;
  createArchive();
  ok(await until(() => arch.length === n0 + 1), "архив создан");
  const e = arch[arch.length - 1];
  const srvE = await uiRec(e.id);
  ok(srvE.kind === "edge" && srvE.recordMode === "always", "на сервере: вид и режим");
  const camE = (await uiDevices()).find((d) => d.type === "camera" && d.serverId === srvFree.id);
  if (camE) {
    ok(await until(() => find(camE.id).n.archx?.some((x) => x.arch === e.id && x.ro)), "у камеры сервера — строка");
    open(camE.id, "rec");
    ok(!!main().querySelector(`[data-arch-ro="${e.id}"]`), "строка показана только для чтения");
    ok(!main().querySelector(`[data-arch-ro="${e.id}"] select`), "выбора в строке нет");
  }
  // Карточка: режим правится, шифрования нет
  open(e.id);
  ok(!!main().querySelector("[data-arch-mode]") && !/Шифрование томов/.test(main().textContent), "карточка карты сервера: режим, без шифрования");

  // Выбор архива у камеры: вид и режим
  const inc = of("incidents"), bak = of("backup");
  const cam = (await uiDevices()).find((d) => d.type === "camera" && d.serverId === bak.server && !d.extraArchives && d.archiveId && d.recordMode === "always");
  const c = find(cam.id).n;
  ok(!archChoicesFor(c).includes(bak) && !archChoicesFor(c).includes(inc) && !archChoicesFor(c).includes(of("edge")), "основным резерв, инциденты и карту не выбрать");
  ok(archRowChoices(c).includes(bak) && !archRowChoices(c).includes(inc), "дополнительным — резерв да, инциденты нет");
  open(cam.id, "rec");
  camArchRowAdd(cam.id, bak.id);
  ok(c.archx.some((x) => x.arch === bak.id && x.rec === "backup"), "резерв — сразу с режимом «при сбое»");
  const sel = [...main().querySelectorAll("tbody tr")].find((tr) => tr.textContent.includes(locName(bak)))?.querySelectorAll("select")[2];
  ok(sel && [...sel.options].map((o) => o.value).join() === "backup", "в строке резерва других режимов нет");
  const mainSel = main().querySelector("tbody tr")?.querySelectorAll("select")[2];
  ok(mainSel && ![...mainSel.options].some((o) => o.value === "backup"), "у основной записи резерва нет");
  cardApply();
  ok(await until(() => bq && bq.finished), "план выполнен: не ок " + bq?.fail);
  ok((await uiRec(cam.id)).extraArchives?.some((x) => x.archiveId === bak.id && x.recordMode === "backup"), "на сервере — строка резерва");

  // Репликация: источник — встроенное хранилище или другой архив этой камеры; поток — тот, что можно
  const gate = (await uiDevices()).find((d) => (d.extraArchives || []).some((x) => x.recordMode === "replica" && x.replicaFrom && x.replicaLagSec));
  const gn = find(gate.id).n;
  open(gate.id, "rec");
  ok(!!main().querySelector("[data-replica-src]") && /Откуда забирать/.test(main().textContent), "у строки — откуда забирать");
  ok(main().querySelector("[data-rec-lag]")?.textContent.includes("7 мин"), "отставание в строке: " + main().querySelector("[data-rec-lag]")?.textContent);
  ok(!!main().querySelector("[data-replica-note]") && !!main().querySelector("[data-backup-note]"), "слова о репликации и резерве");
  const rowEl = [...main().querySelectorAll("tbody tr")].find((tr) => tr.querySelector("[data-replica-src]"));
  ok([...rowEl.querySelector("[data-replica-src] select").options].some((o) => o.value === gn.arch), "источник — другой архив камеры");
  ok(![...rowEl.querySelector("[data-replica-src] select").options].some((o) => o.textContent === locName(of("backup"))), "резерв источником не предлагается");
  const streamOpts = [...rowEl.querySelectorAll("td")[1].querySelectorAll("option")];
  ok(streamOpts.length === 1, "поток — только поток источника");
  // Камера без встроенного хранилища: режим по другому архиву
  const all = (await uiDevices());
  const bare = all.find((d) => d.type === "camera" && d.archiveId && d.recordMode === "always" && !d.parentId && !(d.extraArchives || []).length && !all.some((x) => x.type === "storage" && x.parentId === d.id) && d.serverId !== srvFree.id && servers.find((x) => x.id === d.serverId)?.online !== false && !hasNoSignal(domainOf(d.serverId) || {}));
  const bn = find(bare.id).n;
  open(bare.id, "rec");
  ok(/Встроенного хранилища нет/.test(main().textContent), "сказано: только из другого архива");
  ok(main().querySelectorAll("tbody tr select")[2].querySelector('option[value="replica"]').disabled, "основной архив один — забирать неоткуда");
  const nasArch = archRowChoices(bn).find((a) => a.kind === "network");
  camArchRowAdd(bare.id, nasArch.id);
  ok(!main().querySelectorAll("tbody tr")[1].querySelectorAll("select")[2].querySelector('option[value="replica"]').disabled, "у второй строки источник есть");
  camArchRowSet(bare.id, 1, "rec", "replica");
  ok(bn.archx[0].replicaFrom === bn.arch, "источник подставлен");
  ok(replicaSources(bn, camArchs(bn)[0]).length === 0, "основная не может забирать у того, кто забирает у неё");
  cardApply();
  ok(await until(() => bq && bq.finished) && !bq.fail, "план выполнен: " + (bq?.steps.flatMap((x) => x.ops).map((o) => o.msg).join() || "без отказов"));
  const bs = await uiRec(bare.id);
  ok(bs.extraArchives?.[0]?.replicaFrom === bare.archiveId, "на сервере — строка забирает из основного: " + JSON.stringify(bs.extraArchives));
  // Карта камеры w2c
  const cardDev = (await uiDevices()).find((d) => d.type === "storage" && d.writableFields?.includes("sizeBytes"));
  open(cardDev.id, "gen");
  ok(!!main().querySelector("[data-card-mode]") && !!main().querySelector("[data-card-size]"), "карта камеры: режим и объём правятся");
  storageSet(cardDev.id, "rec", "always");
  storageSet(cardDev.id, "size", "512");
  cardApply();
  ok(await until(() => bq && bq.finished), "план карты: не ок " + bq?.fail);
  const cs = await uiRec(cardDev.id);
  ok(cs.recordMode === "always" && cs.sizeBytes === 512 * 1024 ** 3, "на сервере — режим и объём");
  open((await uiDevices()).find((d) => d.type === "storage" && !d.writableFields?.includes("sizeBytes")).id, "gen");
  ok(!main().querySelector("[data-card-mode]") && !main().querySelector("[data-card-size]"), "обычное встроенное — только чтение");

  // Срок и глубина строки, запись по расписанию, микрофон
  const all2 = (await uiDevices());
  const sc = all2.find((d) => d.type === "camera" && d.archiveId && d.recordMode === "always" && !d.parentId && d.serverId && !d.extraArchives && servers.find((x) => x.id === d.serverId)?.online !== false && !hasNoSignal(domainOf(d.serverId) || {}));
  const sn = find(sc.id).n;
  open(sc.id, "rec");
  ok(!!main().querySelector("[data-rec-depth]"), "у строки — срок и глубина");
  camArchRowSet(sc.id, 0, "retentionDays", "12");
  camArchRowSet(sc.id, 0, "minDepthDays", "5");
  camArchRowSet(sc.id, 0, "rec", "sched");
  ok(!!main().querySelector("[data-rec-sched]") && sn.recordScheduleId === recSchedules()[0].id, "у «По расписанию» подставлено расписание");
  cardApply();
  ok(await until(() => bq && bq.finished) && !bq.fail, "план выполнен");
  const ss = await uiRec(sc.id);
  ok(ss.recordMode === "sched" && ss.recordScheduleId === recSchedules()[0].id && ss.retentionDays === 12 && ss.minDepthDays === 5, "на сервере — режим, расписание, срок, глубина");
  const micCam = all2.find((d) => d.audioDeviceId);
  open(micCam.id, "rec");
  ok(main().querySelector("[data-rec-mic] select")?.value === micCam.audioDeviceId, "микрофон записи показан");
  camRecSet(micCam.id, "audioDeviceId", "");
  cardApply();
  ok(await until(() => bq && bq.finished), "план: первый микрофон");
  ok(!("audioDeviceId" in (await uiRec(micCam.id))), "на сервере — первый");

  // Обход и скан — на вкладке «Архив»
  const wd = (await API.get("/archive-watches")).items[0];
  open(wd.deviceId, "rec");
  ok(await until(() => !!main().querySelector(`[data-watch="${wd.id}"]`)), "обход в карточке");
  ok(/стёрло раньше/.test(main().textContent), "сказано, что устройство стёрло раньше");
  rwWatchToggle(wd.id);
  ok(await until(() => rw.watches[0]?.enabled === false), "выключен");
  rwWatchEdit(wd.deviceId, "");
  ok(/Начало обхода/.test(body()) && /Тревожные виды/.test(body()) && /Метки серверов/.test(body()) && /Маска/.test(body()) && /Настройки детектора/.test(body()), "окно обхода: все поля");
  rwSet("detectorKind", "lpr");
  rwSet("keep", "hits");
  rwChip("alarms", "lpr");
  rwChip("labels", refLabels[0]);
  rwSet("params", "plate=ru");
  rwSave();
  ok(await until(() => rw.watches.length === 2), "заведён");
  const made = rw.watches.find((x) => x.detectorKind === "lpr");
  ok(made.keep === "hits" && made.archiveId === find(wd.deviceId).n.arch && made.alarms[0] === "lpr" && made.labels.length === 1 && made.params === "plate=ru", "на сервере — поля");
  rwWatchDel(made.id);
  await confirmWith(null);
  ok(await until(() => rw.watches.length === 1), "снят");
  rwScanNew(wd.deviceId);
  ok(/Скан архива/.test(document.getElementById("bmTitle")?.textContent || "Скан архива") && /Метки серверов/.test(body()), "окно скана");
  rwSave();
  ok(await until(() => rw.scans.some((x) => x.result)), "скан кончился, итог пришёл событием");
  ok(await until(() => /событий/.test(main().textContent)), "итог в карточке");
  rwScanDel(rw.scans[0].id);
  ok(await until(() => !rw.scans.length), "итог убран");

  // Хранилище не принимает записи
  const closed = list.find((a) => a.admits === false && a.kind !== "incidents");
  if (closed) {
    ok(!archChoicesFor(c).some((a) => a.id === closed.id) && !archRowChoices(c).some((a) => a.id === closed.id), "закрытое не предлагается");
    open(closed.id);
    ok(!main().querySelector("[data-arch-admits] .sw.on"), "карточка: не принимает");
  }
  open(inc.id);
  ok(!main().querySelector("[data-arch-admits]") && !!main().querySelector("[data-arch-noadmit]"), "инциденты: переключателя нет, сказано словами");
  const lo = arch.find((a) => a.kind === "local" && a.vols.length && a.server === srvFree.id) || arch.find((a) => a.kind === "local" && a.vols.length);
  open(lo.id);
  archAdmitsToggle(main().querySelector("[data-arch-admits] .sw"), lo.id);
  cardApply();
  ok(await until(() => bq && bq.finished), "план: принимает записи — выключено");
  ok((await uiRec(lo.id)).admits === false, "на сервере admits: false");

  // Меньший объём: второе подтверждение
  const vol = arch.flatMap((a) => a.vols).find((x) => x.bytes > 2 * 1024 ** 3 && x.shrink == null && x.mode !== "part" && archAddr(archById(x.archId)) !== "bucket");
  const wasBytes = vol.bytes;
  open(vol.id, "gen");
  volSet(vol.id, "gb", String(Math.round(vol.bytes / 1024 ** 3 / 2)), true);
  cardApply();
  ok(document.getElementById("confirm").classList.contains("open") && /стёрты|сотрёт/.test(document.getElementById("confirmWarn").textContent), "уменьшение спрашивает второй раз");
  await confirmWith(null);
  ok(await until(() => bq && bq.finished), "план выполнен: не ок " + bq?.fail);
  const v2 = await uiRec(vol.id);
  ok(v2.sizeBytes < wasBytes, "на сервере — меньше: " + v2.sizeBytes);
  // Объявленное и не подтверждённое
  const pend = arch.flatMap((a) => a.vols).find((x) => x.shrink != null);
  open(pend.id, "gen");
  ok(!!main().querySelector("[data-vol-shrink]"), "том говорит об ожидании");
  volShrinkConfirm(pend.id);
  await confirmWith(null);
  ok(await until(() => volById(pend.id).shrink == null), "подтверждено");
  ok((await uiRec(pend.id)).shrinkPendingBytes === undefined, "на сервере ожидания нет");
  // Выключить том
  open(pend.id, "gen");
  volEnabledToggle(main().querySelector("[data-vol-enabled] .sw"), pend.id);
  cardApply();
  ok(await until(() => bq && bq.finished), "план выполнен");
  ok((await uiRec(pend.id)).state === "off", "том выключен");
});
