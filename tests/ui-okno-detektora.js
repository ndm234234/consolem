/* Окно детектора (из прототипа 55): настройки и поддетекторы читаются из объектов детектора и subdet, «Применить» —
   одна операция POST /operations. Запуск: python tools/check_ui.py tests/ui-okno-detektora.js */
UiCheck(async ({ ok, until, sleep, confirmWith }) => {
  const TRK = "30000027-0001-4000-8000-000000000000"; // трекер объектов, объект вида det: other + analyticsKind tracker
  const SUB_DWELL = "30000027-0011-4000-8000-000000000000";
  const SUB_LINE = "30000027-0012-4000-8000-000000000000";
  const MOTION = "30000016-0000-4000-8000-000000000000"; // движение: зона-прямоугольник и зона-исключение
  const main = () => document.getElementById("main");
  const subs = () => uiUnitsAll({ parentId: TRK, kind: "subdet" });
  const opsCount = async () => (await API.get("/operations", { limit: 1000 })).items.length;
  // Применить: план → «Применить» → ждать конца очереди
  const apply = async (id) => {
    const was = bq;
    dwPlan(id);
    ok(!!document.querySelector("#bmodal.open .bk-table"), "план открылся");
    document.querySelector("#bmodal.open .btn.pri").click();
    // Пока идёт операция плана, окно только для чтения: черновик не меняется, «Сбросить» ничего не делает
    if (!roSeen && bq && bq !== was && !bq.finished) {
      roSeen = true;
      const c0 = JSON.stringify(dwC(find(id).n));
      dwRevert(id);
      ok(document.getElementById("dwRight")?.inert && main().querySelector(".dw.dw-ro") && /Консоль применяет изменения/.test(document.getElementById("cardFoot")?.textContent || "") && JSON.stringify(dwC(find(id).n)) === c0,
        "во время операции окно только для чтения, «Сбросить» не трогает черновик");
    }
    await until(() => bq && bq !== was && bq.finished);
    ok(await until(() => !document.getElementById("dwRight")?.inert), "после операции окно снова можно править");
  };
  let roSeen = false;
  const show = async (id) => {
    goApp("hw");
    await hwEnsure([id]);
    pick(id);
    ok(await until(() => main().querySelector(`[data-dw="${id}"]`)), "окно детектора открыто");
    await until(() => !dwBusy.has(id) && dwLoaded.has(id));
  };

  // Вид окна и поддетекторы — из объектов: трекер, два поддетектора, размер объекта с сервера
  await show(TRK);
  const trk = find(TRK).n;
  ok(dwKindOf(trk) === "tracker", "вид окна — трекер: detectorKind other + analyticsKind tracker");
  ok(dwKindOf(find(MOTION).n) === "motion", "вид окна у движения — motion");
  const tabs = [...main().querySelectorAll("[data-dw-ptab]")].map((e) => e.dataset.dwPtab);
  ok(tabs.join() === "det,sub,rules", "вкладки: детектор, поддетекторы, автоматизация");
  ok(dwC(trk).subs.length === 2 && dwC(trk).subs.map((s) => s.kind).sort().join() === "dwell,line", "в окне два поддетектора с сервера");
  ok(dwC(trk).min.join() === "0.03,0.06" && dwC(trk).max.join() === "0.5,0.6", "размер объекта — с сервера");
  ok(dwDiffRows(trk).length === 0, "без правок плана нет");

  // Вкладки: смена вкладки показывает свой список
  const tab = (v) => main().querySelector(`[data-dw-ptab="${v}"]`).click();
  tab("sub");
  ok(await until(() => main().querySelectorAll("[data-dw-sub]").length === 2), "вкладка «Поддетекторы»: два поддетектора");
  ok(!main().querySelector("[data-dw-size-sec]"), "на вкладке поддетекторов размера детектора нет");
  tab("det");
  ok(await until(() => main().querySelector("[data-dw-size-sec]")), "вкладка «Детектор»: раздел «Размер объекта»");
  tab("rules");
  ok(await until(() => main().querySelector(".dw-rules")), "вкладка «Автоматизация»");
  tab("det");

  // Размер: правка → строка плана → одна операция → objectSize на сервере, остальные поля не тронуты
  const zoneBefore = JSON.stringify((await uiRec(TRK)).zone);
  const verBefore = (await uiRec(TRK)).version;
  const ops0 = await opsCount();
  dwSet(TRK, "min.0", "5");
  ok(await until(() => /Размер объекта не меньше/.test(document.getElementById("cardFoot")?.textContent + "" + dwDiffRows(trk).map((r) => r.label).join())), "правка размера — в плане");
  ok(dwDiffRows(trk).length === 1 && dwDiffRows(trk)[0].label === "Размер объекта не меньше", "одна строка плана");
  await apply(TRK);
  ok((await uiRec(TRK)).objectSize.min[0] === 0.05, "objectSize.min на сервере изменён");
  ok(JSON.stringify((await uiRec(TRK)).zone) === zoneBefore, "зона не переписана");
  ok((await uiRec(TRK)).version !== verBefore, "версия детектора выросла");
  ok((await opsCount()) === ops0 + 1, "ушла ровно одна операция");
  ok(await until(() => !dwChanged(find(TRK).n)), "после «Применить» плана нет: окно прочитало объект");
  ok(dwC(find(TRK).n).min[0] === 0.05, "окно показывает новый размер");

  // Размер «без ограничения»: убрали min — свойство min исчезает из objectSize
  dwSet(TRK, "min.0", "0");
  dwSet(TRK, "min.1", "0");
  await apply(TRK);
  const os = (await uiRec(TRK)).objectSize;
  ok(os && !os.min && os.max.join() === "0.5,0.6", "нулевой минимум — без ограничения: min убран, max остался");

  // Новый поддетектор: кнопка → тип → черновик → план → subdet под детектором на сервере
  tab("sub");
  dwSubNewOpen();
  ok(await until(() => main().querySelector("[data-dw-new]")), "список типов поддетекторов открыт");
  dwSubAdd(TRK, "enter");
  const draft = dwC(find(TRK).n).subs.find((s) => s.kind === "enter");
  ok(!!draft && dwDiffRows(trk).some((r) => /Поддетектор/.test(r.label)), "новый поддетектор — в плане");
  ok((await subs()).length === 2, "до «Применить» на сервере два поддетектора");
  const ops1 = await opsCount();
  await apply(TRK);
  const after = await subs();
  const made = after.find((u) => u.properties.subdetectorKind === "enter");
  ok(after.length === 3 && made && made.parentId === TRK && made.kind === "subdet", "на сервере третий поддетектор вида subdet под детектором");
  ok(made.properties.zone.shape === "polygon" && made.properties.zone.points.length === 4, "у поддетектора зона — многоугольник");
  ok((await opsCount()) === ops1 + 1, "создание — одна операция");
  ok(await until(() => dwC(find(TRK).n).subs.length === 3 && dwC(find(TRK).n).subs.some((s) => s.id === made.uid)), "окно показывает его под uid сервера");
  ok(await until(() => !dwChanged(find(TRK).n)), "плана нет: поддетектор применён");

  // Правка поддетектора и детектора вместе: одна операция, шаги patch детектора и patch поддетектора
  const ops2 = await opsCount();
  dwSubSet(TRK, SUB_DWELL, "time", "45");
  dwSet(TRK, "sens", "70");
  ok(dwDiffRows(trk).length === 2, "две строки плана: чувствительность и поддетектор");
  await apply(TRK);
  ok((await uiRec(SUB_DWELL)).timeSec === 45 && (await uiRec(TRK)).sensitivity === 70, "оба объекта изменены");
  ok((await opsCount()) === ops2 + 1, "обе правки — одна операция");

  // Удаление поддетектора: подтверждение с числом 1, до «Применить» объект на сервере остаётся
  tab("sub");
  dwSubDel(TRK, SUB_LINE);
  ok(!!document.getElementById("confirmCountInp"), "удаление просит ввести число");
  await confirmWith(1);
  ok(await until(() => !dwC(find(TRK).n).subs.some((s) => s.id === SUB_LINE)), "из черновика убран");
  ok((await subs()).some((u) => u.uid === SUB_LINE), "до «Применить» на сервере он есть");
  await apply(TRK);
  ok(!(await subs()).some((u) => u.uid === SUB_LINE), "после «Применить» поддетектора на сервере нет");
  ok(await until(() => !find(SUB_LINE) && !dwC(find(TRK).n).subs.some((s) => s.id === SUB_LINE)), "из окна и кэша он ушёл");

  // «Изменить размер у детектора»: у поддетектора размер — как у детектора, кнопка ведёт к разделу
  dwSubPick(TRK, SUB_DWELL);
  ok(await until(() => main().querySelector("[data-dw-sub].sel .dw-sub-b")), "поддетектор раскрыт");
  ok(dwPtab() === "sub", "открыта вкладка «Поддетекторы»");
  const go = [...main().querySelectorAll(".dw-sub-b button")].find((b) => /Изменить размер у детектора/.test(b.textContent));
  ok(!!go, "в поддетекторе есть «Изменить размер у детектора»");
  go.click();
  ok(await until(() => dwPtab() === "det" && main().querySelector("[data-dw-size-sec]")), "кнопка открыла вкладку «Детектор» с разделом размера");
  ok(await until(() => main().querySelector("[data-dw-size-sec].acc-flash, [data-dw-size-sec] .acc-flash, .acc-flash")), "раздел моргнул");

  // Дерево: детектор раскрывается до поддетекторов
  setSlice("det");
  pick(TRK);
  ok(await until(() => document.querySelector(`#tree [data-tid$="${TRK}"]`)), "трекер — в дереве среза «Детекторы»");
  const row = document.querySelector(`#tree [data-tid$="${TRK}"]`);
  if (!open.has(row.dataset.tid)) treeToggleId(row.dataset.tid);
  ok(await until(() => document.querySelectorAll("#tree [data-dwsub]").length === 2), "под трекером в дереве два поддетектора");
  ok([...document.querySelectorAll("#tree [data-dwsub]")].some((e) => /Долго у входа/.test(e.textContent)), "в строках — имена с сервера");
  document.querySelector("#tree [data-dwsub]").click();
  ok(await until(() => main().querySelector("[data-dw-sub].sel")), "строка поддетектора открывает его в окне");

  // Ссылка на поддетектор по uid открывает окно детектора, а не форму по схеме
  const link = (await subs())[0].uid;
  setSlice("all");
  pick(link);
  ok(await until(() => main().querySelector(`[data-dw="${TRK}"]`) && dw.subSel === link), "переход к поддетектору открывает окно его детектора");
  ok(!main().querySelector("[data-schema-add], .sf-form"), "формы по схеме нет");

  // Прямоугольник не переписывается: правка одного условия у движения оставляет zone и extraZones как были
  await show(MOTION);
  const mo = find(MOTION).n;
  const zoneRaw = JSON.stringify((await uiRec(MOTION)).zone);
  const exRaw = JSON.stringify((await uiRec(MOTION)).extraZones);
  ok(dwC(mo).areas.length === 2 && dwC(mo).areas[0].pts.length === 4, "зона-прямоугольник показана четырьмя точками, исключение — второй зоной");
  dwSet(MOTION, "delay", "4");
  await apply(MOTION);
  const mrec = await uiRec(MOTION);
  ok(mrec.minDurationSec === 4, "minDurationSec записан");
  ok(JSON.stringify(mrec.zone) === zoneRaw && JSON.stringify(mrec.extraZones) === exRaw, "zone и extraZones не переписаны");
  ok(mrec.zone.shape === "rect", "zone осталась прямоугольником");

  // Чужая правка при открытом черновике: черновик берёт её, план показывает только свои строки, чужой поддетектор не удаляется
  await show(TRK);
  const tk = () => find(TRK).n;
  dwSet(TRK, "sens", "33");
  ok(dwDiffRows(tk()).map((r) => r.label).join() === "Чувствительность", "своя правка — одна строка плана");
  const r0 = await uiRec(TRK);
  await API.patch(`/units/${TRK}`, { properties: { objectSize: { max: [0.6, 0.7] } } }, r0.version);
  ok(await until(() => dwSaved(tk()).max.join() === "0.6,0.7"), "чужая правка размера пришла потоком");
  ok(dwC(tk()).max.join() === "0.6,0.7" && dwC(tk()).sens === 33, "черновик: чужой размер и своя чувствительность");
  ok(dwDiffRows(tk()).map((r) => r.label).join() === "Чувствительность", "в плане только своя строка, без «Размер объекта не больше»");
  // Чужой поддетектор: запрос мимо кэша (unitsCreate отметил бы запись своей), окно узнаёт о нём из потока
  const elsewhere = async (name, zone) => (await API.post("/units", { idempotencyKey: opKey(), items: [{ kind: "subdet", parentId: TRK, name, properties: { subdetectorKind: "enter", zone } }] })).done[0].units[0];
  const other = await elsewhere("Чужой поддетектор", { shape: "polygon", points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]] });
  ok(await until(() => dwSaved(tk()).subs.some((x) => x.id === other.uid)), "чужой поддетектор пришёл в окно");
  ok(dwC(tk()).subs.some((x) => x.id === other.uid), "черновик его не убрал");
  ok(!dwDiffRows(tk()).some((r) => r.toT === "консоль удалит"), "в плане нет «консоль удалит»");
  await apply(TRK);
  const r1 = await uiRec(TRK);
  ok(r1.sensitivity === 33 && r1.objectSize.max.join() === "0.6,0.7", "на сервере своя чувствительность и чужой размер");
  ok((await subs()).some((u) => u.uid === other.uid), "чужой поддетектор на сервере остался");

  // Угол рамки размера: значение не больше 100 % кадра, минимум не выше максимума
  if (!dw.lay.size) dwLay("size");
  ok(await until(() => main().querySelector('.dw-stage [data-h="min"]')), "рамки размеров на кадре");
  const drag = async (h, fx, fy) => {
    const st = main().querySelector(".dw-stage"), el = st.querySelector(`[data-h="${h}"]`), a = el.getBoundingClientRect(), r = st.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: a.x + a.width / 2, clientY: a.y + a.height / 2 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: r.x + r.width * fx, clientY: r.y + r.height * fy }));
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    await sleep(50);
  };
  await drag("min", 1, 0);
  let cz = dwC(tk());
  ok(cz.min.every((v) => v <= 1) && cz.max.every((v) => v <= 1), "минимум за краем кадра — не больше 100 %");
  ok(cz.min[0] <= cz.max[0] && cz.min[1] <= cz.max[1], "минимум поднял максимум");
  await drag("max", 0.12, 0.96);
  cz = dwC(tk());
  ok(cz.max.every((v) => v >= 0.01) && cz.min[0] <= cz.max[0] && cz.min[1] <= cz.max[1], "максимум опустил минимум");
  dwRevert(TRK);
  dwLay("size");

  // Поддетектор-прямоугольник: правка точки уходит зоной целиком (polygon), сервер принимает
  const rc = await elsewhere("Прямоугольник", { shape: "rect", points: [[0.6, 0.2], [0.8, 0.4]] });
  ok(await until(() => dwC(tk()).subs.some((x) => x.id === rc.uid)), "поддетектор-прямоугольник в окне");
  dwC(tk()).subs.find((x) => x.id === rc.uid).area.pts[0] = [0.62, 0.22];
  ok(dwDiffRows(tk()).length === 1, "точка поддетектора — строка плана");
  await apply(TRK);
  ok(bq.fail === 0, "операция прошла без отказов");
  const rz = (await uiRec(rc.uid)).zone;
  ok(rz.shape === "polygon" && rz.points.length === 4 && rz.points[0].join() === "0.62,0.22", "на сервере многоугольник с новой точкой");
});
