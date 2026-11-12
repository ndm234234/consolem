/* Точки зоны детектора (из прототипа 60, пробел C2 против Axxon One): зона — многоугольник от 3 до 64 точек; точку
   добавляют «+» на стороне и правым щелчком, удаляют правым щелчком и Delete; новую зону рисуют щелчками; список точек —
   у зоны в фокусе; поддетекторы — в срезе «Детекторы» и в списке «Все детекторы».
   Запуск: python tools/check_ui.py tests/ui-tochki-zony.js */
UiCheck(async ({ ok, until, sleep }) => {
  const MOTION = "30000016-0000-4000-8000-000000000000"; // движение: зона-прямоугольник, исключение, поддетектор «Вход у двери»
  const SUB = "30000016-0011-4000-8000-000000000000";
  const main = () => document.getElementById("main");
  const stage = () => main().querySelector(".dw-stage");
  const at = (fx, fy, extra = {}) => { const r = stage().getBoundingClientRect(); return { bubbles: true, button: 0, detail: 1, clientX: r.x + r.width * fx, clientY: r.y + r.height * fy, ...extra }; };
  const down = (el, fx, fy, extra) => el.dispatchEvent(new MouseEvent("mousedown", at(fx, fy, extra)));
  const up = (fx, fy) => window.dispatchEvent(new MouseEvent("mouseup", at(fx, fy)));
  const move = (fx, fy) => window.dispatchEvent(new MouseEvent("mousemove", at(fx, fy)));
  const key = (k) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const ctx = (el, fx, fy) => el.dispatchEvent(new MouseEvent("contextmenu", at(fx, fy, { button: 2, cancelable: true })));
  const ov = () => stage().querySelector(".dw-ov");
  const d = () => find(MOTION).n;
  const z0 = () => dwC(d()).areas.find((a) => a.id === "z0");
  const apply = async (id) => {
    const was = bq;
    dwPlan(id);
    ok(!!document.querySelector("#bmodal.open .bk-table"), "план открылся");
    document.querySelector("#bmodal.open .btn.pri").click();
    await until(() => bq && bq !== was && bq.finished);
    ok(await until(() => !document.getElementById("dwRight")?.inert), "после операции окно снова можно править");
  };

  goApp("hw");
  await hwEnsure([MOTION]);
  pick(MOTION);
  ok(await until(() => main().querySelector(`[data-dw="${MOTION}"] [data-dw-geo] .dw-a`)), "окно детектора движения открыто");
  await until(() => !dwBusy.has(MOTION) && dwLoaded.has(MOTION));

  // Фокус зоны: щелчок по зоне на кадре открывает список точек, строка — кнопка раскрытия
  ok(!main().querySelector(".dw-pts"), "без фокуса списка точек нет");
  const row0 = () => main().querySelector('[data-dw-zone="z0"] .dw-ar-t');
  ok(row0()?.getAttribute("aria-expanded") === "false", "строка зоны — кнопка раскрытия, закрыта");
  down(main().querySelector('.dw-a[data-b="area:z0"]'), 0.5, 0.5); up(0.5, 0.5);
  ok(await until(() => dw.sel === "z0" && main().querySelectorAll(".dw-pts .dw-pt").length === 4), "щелчок по зоне: фокус и список из четырёх точек");
  ok(row0()?.getAttribute("aria-expanded") === "true", "строка зоны раскрыта");
  ok(main().querySelectorAll(".dw-mid").length === 4, "у зоны в фокусе — «+» на каждой стороне");
  down(ov(), 0.02, 0.04); up(0.02, 0.04);
  ok(await until(() => dw.sel === null && !main().querySelector(".dw-pts")), "щелчок по пустому кадру снимает фокус и прячет список");

  // Правый щелчок по стороне добавляет точку, Delete удаляет выбранную
  dwSelect("z0");
  await until(() => main().querySelector(".dw-pts"));
  ctx(ov(), 0.3, 0.152);
  ok(await until(() => z0().pts.length === 5 && dw.pt?.b === "area:z0" && dw.pt.i === 1), "правый щелчок по верхней стороне: пятая точка, она выбрана");
  key("Delete");
  ok(await until(() => z0().pts.length === 4), "Delete удалил выбранную точку");

  // «+» на стороне: протяжка добавляет точку и тянет её; поле X идёт за точкой
  await until(() => main().querySelector('.dw-mid[data-m="area:z0:0"]'));
  const mid = main().querySelector('.dw-mid[data-m="area:z0:0"] circle');
  down(mid, 0.5, 0.15); move(0.5, 0.3); up(0.5, 0.3);
  ok(await until(() => z0().pts.length === 5 && Math.abs(z0().pts[1][1] - 0.3) < 0.01), "«+» на стороне: новая точка там, куда её протянули");
  ok(await until(() => Math.abs(+main().querySelector('[data-dw-pt="area:z0:1:1"]')?.value - 30) < 1), "поле Y новой точки — 30 %");
  const h1 = main().querySelector('[data-h="area:z0:1"]');
  down(h1, 0.5, 0.3); move(0.45, 0.35); up(0.45, 0.35);
  ok(await until(() => Math.abs(+main().querySelector('[data-dw-pt="area:z0:1:0"]')?.value - 45) < 1), "протяжка выбранной точки: поле X показывает новое значение");

  // Поле X двигает точку на кадре
  dwPtSet(MOTION, "area", "z0", 1, 0, "40");
  ok(z0().pts[1][0] === 0.4, "поле X поставило точку на 40 %");

  // Меньше трёх точек нельзя
  const ex = () => dwC(d()).areas.find((a) => a.type === "ex");
  dwPtDel("area", ex().id, 0);
  ok(ex().pts.length === 3, "исключение: четвёртая точка удалена");
  dwPtDel("area", ex().id, 0);
  ok(ex().pts.length === 3 && /не меньше трёх точек/.test(document.getElementById("tt")?.textContent || ""), "третью точку консоль не удаляет и говорит почему");
  dwSelect(ex().id);
  ok(await until(() => main().querySelector(".dw-pts .dw-del[disabled]")), "в списке у трёх точек кнопка удаления неактивна");

  // Многоугольник щелчками: точки, Backspace убирает последнюю, Enter замыкает
  dwTool("ex");
  await until(() => stage().classList.contains("draw"));
  const n0 = dwC(d()).areas.length;
  for (const [x, y] of [[0.15, 0.6], [0.3, 0.55], [0.35, 0.8], [0.25, 0.85]]) { down(ov(), x, y); up(x, y); await sleep(20); }
  ok(dw.poly?.pts.length === 4, "четыре щелчка — четыре точки черновика");
  stage().dispatchEvent(new MouseEvent("mousemove", at(0.2, 0.9)));
  ok(!!dw.poly.q && (stage().querySelector(".dw-pl")?.getAttribute("points") || "").split(" ").length === 5, "сторона к курсору нарисована");
  key("Backspace");
  ok(dw.poly.pts.length === 3, "Backspace убрал последнюю точку");
  key("Enter");
  ok(await until(() => !dw.poly && dwC(d()).areas.length === n0 + 1), "Enter замкнул зону");
  const made = dwC(d()).areas[dwC(d()).areas.length - 1];
  ok(made.type === "ex" && made.pts.length === 3 && dw.sel === made.id, "новое исключение из трёх точек, оно в фокусе");

  // Щелчок по первой точке замыкает, Esc отменяет черновик и оставляет зоны как были
  dwTool("in");
  for (const [x, y] of [[0.6, 0.6], [0.7, 0.6], [0.7, 0.7]]) { down(ov(), x, y); up(x, y); await sleep(20); }
  down(ov(), 0.6, 0.6); up(0.6, 0.6);
  ok(await until(() => !dw.poly && dwC(d()).areas.length === n0 + 2), "щелчок по первой точке замкнул зону");
  dwTool("in");
  for (const [x, y] of [[0.1, 0.9], [0.2, 0.9]]) { down(ov(), x, y); up(x, y); await sleep(20); }
  key("Escape");
  ok(await until(() => !dw.poly && !dw.tool && dwC(d()).areas.length === n0 + 2), "Esc отменил черновик, зоны остались");
  // Убираем вторую новую зону: в плане остаются правка зоны и новое исключение
  dwAreaDel(MOTION, dwC(d()).areas[dwC(d()).areas.length - 1].id);

  // «Применить»: zone — многоугольник с пятью точками, extraZones — исключение из трёх точек и новое из трёх
  await apply(MOTION);
  const rec = await uiRec(MOTION);
  ok(rec.zone.shape === "polygon" && rec.zone.points.length === 5 && rec.zone.points[1][0] === 0.4, "на сервере zone — многоугольник из пяти точек");
  ok(rec.extraZones.length === 2 && rec.extraZones.every((z) => z.type === "ex" && z.points.length === 3), "на сервере extraZones — два исключения по три точки");

  // Область поддетектора: щелчок на кадре ведёт панель к поддетектору, список точек — в его карточке
  await until(() => main().querySelector(`.dw-sa[data-b="sub:${SUB}"]`));
  dwPtabSet("det");
  await until(() => dwPtab() === "det");
  const sa = main().querySelector(`.dw-sa[data-b="sub:${SUB}"]`);
  const pts = dwC(d()).subs.find((s) => s.id === SUB).area.pts, cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  down(sa, cx, cy); up(cx, cy);
  ok(await until(() => dwPtab() === "sub" && dw.subSel === SUB && dw.sel === `sub:${SUB}`), "щелчок по области поддетектора: вкладка «Поддетекторы», его карточка, фокус области");
  ok(await until(() => main().querySelector(`[data-dw-zone="sub:${SUB}"]`) && main().querySelectorAll(".dw-sub-b .dw-pts .dw-pt").length === pts.length), "в карточке поддетектора — список точек области");
  down(main().querySelector('.dw-a[data-b="area:z0"]'), 0.5, 0.5); up(0.5, 0.5);
  ok(await until(() => dwPtab() === "det" && dw.sel === "z0"), "щелчок по зоне детектора возвращает вкладку «Детектор»");

  // Срез «Детекторы» по видам: у детектора — метка числа поддетекторов, раскрытие — строки поддетекторов
  setSlice("det");
  setGroup("kind");
  ok(await until(() => document.querySelector("#tree [data-detk]")), "дерево среза по видам");
  const kk = "detk:" + detKindLabel(d(), find(MOTION).p);
  if (!open.has(kk)) treeToggleId(kk);
  ok(await until(() => document.querySelector(`#tree [data-tid="${MOTION}"] .dw-tsub`)), "строка детектора в дереве — с меткой числа поддетекторов");
  if (!open.has(MOTION)) treeToggleId(MOTION);
  ok(await until(() => document.querySelector(`#tree [data-dwsub="${MOTION}|${SUB}"]`)), "под детектором в дереве — строка поддетектора");

  // Список «Все детекторы»: стрелка у детектора раскрывает строки поддетекторов, щелчок открывает поддетектор
  detKindPick(null);
  ok(await until(() => main().querySelector(".dl-tbl")), "список «Все детекторы»");
  const drow = () => [...main().querySelectorAll(".dl-tbl tr.dl-r:not(.dl-sr)")].find((r) => r.querySelector(".dw-tsub"));
  ok(!!drow(), "у детектора с поддетекторами в списке — метка числа");
  ok(!main().querySelector(".dl-tbl td.lan-chk") || getComputedStyle(main().querySelector(".dl-tbl td.lan-chk")).textOverflow !== "ellipsis", "столбец флажков без многоточия");
  drow().querySelector("button.dl-tw").click();
  ok(await until(() => [...main().querySelectorAll(".dl-sr")].some((r) => /Вход у двери/.test(r.textContent))), "раскрытие показало строку поддетектора");
  [...main().querySelectorAll(".dl-sr")].find((r) => /Вход у двери/.test(r.textContent)).click();
  ok(await until(() => main().querySelector(`[data-dw="${MOTION}"]`) && dw.subSel === SUB), "щелчок по строке открыл поддетектор в окне детектора");
});
