/* Поддетектор «Оставленный предмет» под трекером (из прототипа 110, пробелы F118, F119, F120; замечания покрытия det-760,
   det-761; Axxon One doc 292178): что искать (lostObjectType), классы, свои исключения (extraZones, type: ex),
   предупреждение, если трекер не ищет оставленные предметы (detectUnattendedObjects), и поля трекера профиля
   vms.detector/1 1.6 (autoSensitivity, longTimeUnattended, longTimeIdleSec). Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, sleep, absent }) => {
  // Перенесено из прототипа 110. Старая страница без поддетектора «Оставленный предмет» — absent
  if (typeof dwSubLost !== "function") { absent("поддетектора «Оставленный предмет» (dwSubLost)"); return; }
  const TRK = "30000027-0001-4000-8000-000000000000"; // трекер объектов набора demo
  const main = () => document.getElementById("main");
  const apply = async () => {
    const was = bq;
    dwPlan(TRK);
    ok(!!document.querySelector("#bmodal.open .bk-table"), "план открылся");
    document.querySelector("#bmodal.open .btn.pri").click();
    await until(() => bq && bq !== was && bq.finished);
    ok(bq.fail === 0, "операция прошла без отказов");
    ok(await until(() => !document.getElementById("dwRight")?.inert), "после операции окно снова можно править");
  };
  goApp("hw");
  await hwEnsure([TRK]);
  pick(TRK);
  ok(await until(() => main().querySelector(`[data-dw="${TRK}"]`)), "окно трекера открыто");
  await until(() => !dwBusy.has(TRK) && dwLoaded.has(TRK));
  const trk = () => find(TRK).n;

  // F119: новый поддетектор ищет любой предмет, классы — чипы, как у других поддетекторов
  dwSubAdd(TRK, "abandoned");
  const s = dwC(trk()).subs.find((x) => x.kind === "abandoned");
  ok(s && s.lost === "any", "новый «Оставленный предмет» ищет любой предмет");
  ok(await until(() => main().querySelector("[data-dw-lost] button.on")), "выбор «Что искать» на экране");
  ok(/Любой/.test(main().querySelector("[data-dw-lost] button.on").textContent), "выбран «Любой»");
  ok(main().querySelectorAll(".dw-sub.sel .dw-chip").length === 3, "классы объектов — три чипа");
  dwSubLost(TRK, s.id, "taken");
  ok(/Сработать, если предмета нет дольше/.test(main().querySelector(".dw-sub.sel").textContent), "у «Унесённого» своя подпись времени");

  // F120: исключение рисуется протяжкой по кадру
  dwSubExTool(TRK, s.id);
  const st = main().querySelector(".dw-stage"), r = st.getBoundingClientRect();
  const at = (fx, fy) => ({ bubbles: true, button: 0, clientX: r.x + r.width * fx, clientY: r.y + r.height * fy });
  (st.querySelector("svg") || st).dispatchEvent(new MouseEvent("mousedown", at(0.8, 0.7)));
  window.dispatchEvent(new MouseEvent("mousemove", at(0.9, 0.8)));
  window.dispatchEvent(new MouseEvent("mouseup", at(0.9, 0.8)));
  await sleep(50);
  ok(s.ex.length === 1 && s.ex[0].pts.length === 4, "исключение — прямоугольник из четырёх точек");
  ok(await until(() => main().querySelector(`.dw-stage [data-b="subx:${s.id}~${s.ex[0].id}"]`)), "исключение на кадре");
  ok(main().querySelector(`[data-dw-zone="subx:${s.id}~${s.ex[0].id}"]`), "строка исключения в списке областей");

  // Ревью: другой поддетектор снимает фокус исключения и инструмент «Исключение»
  dwSubZoneSel("subx", `${s.id}~${s.ex[0].id}`);
  dwSubExTool(TRK, s.id);
  const dwellId = "30000027-0011-4000-8000-000000000000";
  dwSubSel(dwellId);
  ok(!/^subx:/.test(dw.sel || "") && dw.tool !== "subx", "другой поддетектор: фокус исключения и инструмент сняты");
  dwSubSel(s.id);

  // Раунд 2: над кадром нет кнопок «Нарисовать»; во время рисования — что рисуем и «Отменить»
  ok(!main().querySelector(".dw-tools [data-dw-cal-tool]") && !/Нарисовать:/.test(main().querySelector(".dw-tools").textContent), "над кадром нет кнопок «Нарисовать»");
  dwSubExTool(TRK, s.id);
  ok(await until(() => main().querySelector('[data-dw-drawing="subx"]')), "над кадром: рисуем исключение поддетектора");
  ok(/исключение поддетектора «/.test(main().querySelector("[data-dw-drawing]").textContent), "строка называет поддетектор");
  main().querySelector("[data-dw-draw-off]").click();
  ok(await until(() => !main().querySelector("[data-dw-drawing]")) && !dw.tool, "«Отменить» снимает рисование");

  // Раунд 3: чипы «Зоны на кадре» — фокус совпадает с объектом в панели; остальные зоны бледные и щелчок не ловят
  const fc = () => main().querySelector('.dw-fc[aria-checked="true"]');
  ok(await until(() => fc()?.dataset.fo === s.id), "чип в фокусе — открытый поддетектор");
  ok(main().querySelector('.dw-ov polygon.dim[data-fo="det"]'), "зона детектора бледная");
  ok(getComputedStyle(main().querySelector(".dw-ov .dim")).pointerEvents === "none", "бледные зоны щелчок не ловят");
  main().querySelector('.dw-fc[data-fo="det"]').click();
  ok(await until(() => dwPtab() === "det" && fc()?.dataset.fo === "det"), "чип детектора открыл детектор в панели");
  ok(main().querySelector(".dw-ov polygon[data-b^='area:']:not(.dim)"), "зона детектора яркая");
  main().querySelector('.dw-fc[data-fo="det"]').dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  ok(await until(() => dw.subSel === s.id && document.activeElement?.dataset.fo === s.id), "End на чипах: последний поддетектор, фокус клавиатуры на его чипе");
  const dimS = main().querySelector('.dw-ov .dim[data-fo]:not([data-fo="det"])') || main().querySelector('.dw-ov .dim[data-fo="det"]');
  dwFocusHov(dimS.dataset.fo);
  ok(dimS.isConnected && main().querySelector(`.dw-ov .dim.hov[data-fo="${CSS.escape(dimS.dataset.fo)}"]`), "наведение на чип подсвечивает зоны объекта");
  dwFocusHov("");
  // Ревью: правый щелчок по краю бледной зоны детектора её не правит
  {
    const z = dwC(trk()).areas[0], n0 = z.pts.length, st2 = main().querySelector(".dw-stage"), r2 = st2.getBoundingClientRect();
    const m = [(z.pts[0][0] + z.pts[1][0]) / 2, (z.pts[0][1] + z.pts[1][1]) / 2];
    st2.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r2.x + r2.width * m[0], clientY: r2.y + r2.height * m[1] }));
    await sleep(50);
    ok(dwC(trk()).areas[0].pts.length === n0 && dw.subSel === s.id, "правый щелчок по бледной зоне не добавил точку и не сменил фокус");
  }

  // Ревью: вкладка «Поддетекторы» трекера не бледнит зоны детектора другого вида (пересечение линии)
  {
    dwPtabSet("sub");
    const LC = "30000017-0000-4000-8000-000000000000";
    if (find(LC)) {
      pick(LC);
      ok(await until(() => main().querySelector(`[data-dw="${LC}"] .dw-ov [data-h^="line:"]`)), "у пересечения линии ручки линии на месте");
      ok(!main().querySelector(".dw-ov .dim") && !main().querySelector(".dw-fc"), "у пересечения линии нет бледных зон и чипов");
      pick(TRK);
      ok(await until(() => main().querySelector(`[data-dw="${TRK}"]`)), "окно трекера снова открыто");
      await until(() => !dwBusy.has(TRK) && dwLoaded.has(TRK));
    }
    dwSubSel(s.id);
  }

  // F118: трекер не ищет оставленные предметы — предупреждение; кнопка включает поиск в черновике
  dwFinePut(trk(), "detectUnattendedObjects", false);
  gear();
  ok(await until(() => main().querySelector("[data-dw-unatt]")), "предупреждение: трекер не ищет оставленные предметы");
  main().querySelector("[data-dw-unatt] button").click();
  ok(await until(() => !main().querySelector("[data-dw-unatt]")), "кнопка убрала предупреждение");
  ok(dwC(trk()).fine.detectUnattendedObjects !== false, "поиск у трекера включён в черновике (умолчание — поиск идёт)");

  // det-760, det-761: поля трекера профиля 1.6 в «Тонкой настройке»
  // Время покоя скрыто, когда выключен поиск оставленных предметов (зависимость по цепочке)
  dwFinePut(trk(), "longTimeUnattended", true);
  dwFinePut(trk(), "detectUnattendedObjects", false);
  dwPtabSet("det");
  const fine0 = () => [...main().querySelectorAll("[data-dw-fine]")].map((e) => e.dataset.dwFine);
  ok(await until(() => fine0().includes("detectUnattendedObjects")), "«Тонкая настройка» на экране");
  ok(!fine0().includes("longTimeUnattended") && !fine0().includes("longTimeIdleSec"), "поиск выключен — нет полей надолго оставленных");
  dwFinePut(trk(), "detectUnattendedObjects", true);
  dwFinePut(trk(), "autoSensitivity", true);
  dwFinePut(trk(), "longTimeUnattended", true);
  dwFinePut(trk(), "longTimeIdleSec", 120);
  dwPtabSet("det");
  const fine = () => [...main().querySelectorAll("[data-dw-fine]")].map((e) => e.dataset.dwFine);
  ok(await until(() => fine().includes("longTimeIdleSec")), "время покоя видно при «Надолго оставленных»");
  ok(!fine().includes("abandonedSensitivity"), "при авточувствительности ручной чувствительности к оставленным нет");
  ok(main().querySelector("[data-dw-auto-sens]"), "у чувствительности трекера — пояснение об авточувствительности");

  await apply();
  const t = await uiRec(TRK);
  ok(t.autoSensitivity === true && t.longTimeUnattended === true && t.longTimeIdleSec === 120 && t.detectUnattendedObjects !== false, "на сервере поля трекера 1.5 и поиск не выключен");
  const u = (await uiRecs({ parentId: TRK, kind: "subdet" })).find((x) => x.subdetectorKind === "abandoned");
  ok(u && u.lostObjectType === "taken", "на сервере «Что искать» — унесённый");
  ok(u && u.extraZones?.length === 1 && u.extraZones[0].type === "ex" && u.extraZones[0].points.length === 4, "на сервере своё исключение поддетектора");
  ok(u && Array.isArray(u.classes) && u.classes.length === 3, "на сервере классы поддетектора");

  // Ревью: чужие extraZones другого вида поддетектора окно не правит и в план не кладёт
  const dw0 = await uiRec(dwellId);
  const dwellU = (await API.get(`/units/${dwellId}`));
  await API.patch(`/units/${dwellId}`, { properties: { extraZones: [{ type: "ex", points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] }] } }, dwellU.version);
  ok(await until(() => dwSaved(trk()).subs.some((x) => x.id === dwellId)), "поддетектор «пребывание» в окне");
  await sleep(300);
  ok(!dwC(trk()).subs.find((x) => x.id === dwellId).ex.length, "у другого вида исключений поддетектора в модели нет");
  ok(!dwDiffRows(trk()).length, "чужие extraZones не дают строк плана");
  ok(dw0.subdetectorKind === "dwell", "это поддетектор «пребывание»");

  // Удаление исключения уходит в план и снимает extraZones на сервере
  // Поддетектор после «Применить» — объект сервера: id в черновике — его uid
  await until(() => dwSaved(trk()).subs.find((x) => x.kind === "abandoned" && /^[0-9a-f]{8}-/.test(x.id))?.ex.length === 1);
  const s2 = dwC(trk()).subs.find((x) => x.kind === "abandoned");
  ok(s2 && /^[0-9a-f]{8}-/.test(s2.id) && s2.ex.length === 1, "после «Применить» исключение пришло из объекта");
  dwSubExDel(TRK, s2.id, s2.ex[0].id);
  await apply();
  ok(!(await uiRec(s2.id)).extraZones, "исключение снято на сервере");
});
