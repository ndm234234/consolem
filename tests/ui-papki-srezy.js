/* «Папки» и статус в ряду срезов за чертой (из прототипа 29); в «Серверах» и «Хранилищах» кнопка неактивна и хранит положение.
   Запуск — python3 tools/check_ui.py tests/ui-papki-srezy.js */
UiCheck(async ({ ok, sleep }) => {
  if (!document.getElementById("phSliceLast")) { ok(true, "на этой странице «Папок» в ряду срезов нет"); return; }
  const btn = () => document.getElementById("viewBtn");
  const on = () => btn().getAttribute("aria-pressed") === "true";
  const click = (s) => document.querySelector(`#aside [data-slice="${s}"]`).click();
  const top = (el) => Math.round(el.getBoundingClientRect().top);
  const last = () => document.getElementById("phSliceLast");
  const statusBtn = () => document.getElementById("filtBtn");
  const collapseBtn = () => document.getElementById("treeCollapseBtn");
  const mid = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
  const sameLine = () => top(last()) === top(btn()) && top(btn()) === top(statusBtn()) && Math.abs(mid(collapseBtn()) - mid(statusBtn())) <= 1;
  const fits = () => collapseBtn().getBoundingClientRect().right <= document.getElementById("aside").getBoundingClientRect().right;

  // Место в шапке
  click("all");
  const sliceGroup = document.querySelector(`#aside [role="group"][aria-label="${i18n("Срез дерева")}"]`);
  ok(sliceGroup && sliceGroup.querySelectorAll("[data-slice]").length === Object.keys(SLICE).length - 1 && sliceGroup.getAttribute("aria-owns") === "phSliceLast", "группа срезов называет все срезы, последний — через aria-owns");
  ok(last().dataset.slice === Object.keys(SLICE).at(-1), "последний срез — в общем ряду");
  ok(!btn().closest('[role="group"]') && !document.getElementById("filtBtn").closest('[role="group"]'), "«Папки» и статус — вне группы срезов");
  const fold = btn().parentElement;
  ok(fold.classList.contains("ph-fold") && fold.contains(document.getElementById("filtBtn")), "«Папки» и статус за одной чертой");
  ok(getComputedStyle(fold, ":before").width === "1px", "черта перед настройками");
  // Шапка дерева — одна строка: «Свернуть всё» за статусом и за своей чертой, «Показать в дереве» — за ним; «Развернуть всё» убрано
  ok(document.querySelectorAll("#aside .ph .ph-row").length === 1, "шапка дерева — одна строка");
  ok(statusBtn().nextElementSibling === collapseBtn() && fold.contains(collapseBtn()), "«Свернуть всё» — сразу за статусом");
  ok(getComputedStyle(collapseBtn(), ":before").width === "1px", "черта перед «Свернуть всё»");
  ok(!document.getElementById("treeExpandBtn"), "нет «Развернуть всё»");
  // «Показать в дереве» вернулось в index.html; прототипы — копии прежнего макета — живут без него
  const revealBtn = document.getElementById("treeRevealBtn");
  ok(!revealBtn || (collapseBtn().nextElementSibling === revealBtn && fold.contains(revealBtn)), "«Показать в дереве» — сразу за «Свернуть всё»");

  // Настройки не уезжают отдельно: ни при какой подписи статуса, ни на самой узкой панели
  setAsideWidth(100);
  ok(asideW === ASIDE_MIN, `ширина дерева не меньше ${ASIDE_MIN}: ${asideW}`);
  for (const st of ["", "nosignal", "license", "nosignal:auth"]) {
    pickStatus(st);
    await sleep(30);
    ok(sameLine() && fits(), `статус «${st || "все"}»: последний срез, «Папки», статус и «Свернуть всё» в одной строке и в ширине панели`);
  }
  pickStatus("");

  // Свой вид нажатия
  ok(on(), "при старте «Папки» нажаты");
  const bg = (el) => getComputedStyle(el).backgroundColor;
  const sliceBg = bg(document.querySelector('#aside .ph-choice.on[data-slice="all"]'));
  pickStatus("nosignal");
  await sleep(30);
  const look = (el) => { const c = getComputedStyle(el); return c.backgroundColor + " " + c.borderTopColor; };
  ok(look(btn()) === look(statusBtn()), `нажатые «Папки» — как статус с фильтром: ${look(btn())}`);
  pickStatus("");
  await sleep(30);
  ok(bg(btn()) !== sliceBg || getComputedStyle(btn()).borderTopColor !== "rgba(0, 0, 0, 0)", "нажатые «Папки» отличаются от выбранного среза");

  // Положение сохраняется: нажаты
  for (const s of ["srv", "arch"]) {
    click(s);
    ok(btn().disabled && on() && btn().title === i18n("В этом срезе нет папок"), `срез ${s}: кнопка неактивна, положение видно, причина названа`);
    btn().click();
    ok(slice === s && btn().disabled && on(), `срез ${s}: нажатие ничего не меняет`);
  }
  click("cam");
  ok(!btn().disabled && on() && group() === "folder", "«Камеры»: кнопка активна, дерево по папкам");

  // Положение сохраняется: отжаты, и возврат их не включает
  btn().click();
  ok(!on() && group() === "server", "«Камеры»: «Папки» выключены");
  for (const s of ["srv", "arch"]) {
    click(s);
    ok(btn().disabled && !on(), `срез ${s}: кнопка неактивна, положение «выключено» видно`);
  }
  for (const s of ["cam", "acfa", "all"]) {
    click(s);
    ok(!btn().disabled && !on() && group() === "server", `срез ${s}: «Папки» сами не включились`);
  }

  // «Детекторы» — то же положение: «выключено» там значит виды, инверсии нет
  click("det");
  ok(group() === "kind" && !on() && !btn().disabled, "«Детекторы»: «Папки» выключены — виды");
  btn().click();
  ok(on() && group() === "folder", "«Детекторы»: включили «Папки»");
  for (const s of ["srv", "arch"]) { click(s); ok(btn().disabled && on(), `срез ${s}: кнопка неактивна и включена`); }
  for (const s of ["acfa", "cam", "all"]) { click(s); ok(on() && group() === "folder", `срез ${s}: «Папки» включены, дерево по папкам`); }
  click("det");
  ok(on() && group() === "folder", "снова «Детекторы»: «Папки» включены");
  btn().click();
  ok(!on() && group() === "kind", "«Детекторы»: выключили «Папки»");
  for (const s of ["acfa", "cam", "all"]) { click(s); ok(!on() && group() === "server", `срез ${s}: «Папки» выключены`); }
  btn().click();
  ok(on(), "вернули включёнными");
  click("det");
  ok(on() && group() === "folder", "«Детекторы» снова по папкам");
  click("all");

  // Статус на любом срезе: дерево остаётся деревом, в нём только найденное
  const rows = () => [...document.querySelectorAll("#tree .n")];
  const loading = (r) => r.classList.contains("n-more") && /Загрузка|Ищем дальше/.test(r.textContent);
  const settle = async () => {
    await sleep(30);
    for (let i = 0; i < 400 && fs && (!fs.done || fs.busy); i++) await sleep(25);
    // Срез дочитывается отдельно: строка загрузки законна, пока не прошло 5 с
    for (let i = 0; i < 200 && rows().some(loading); i++) await sleep(25);
    await sleep(60);
  };
  const level = (r) => Number(r.style.getPropertyValue("--l") || 0);
  const emptyParents = () => {
    const list = rows();
    return list.filter((r, i) => {
      const id = r.dataset.pick;
      const parent = id && (domains.some((d) => d.id === id) || servers.some((x) => x.id === id) || folderById(id) || (slice === "det" && find(id)?.n.type === "camera"));
      return parent && !(list[i + 1] && level(list[i + 1]) > level(r));
    }).length;
  };
  const found = () => Number((/Найдено: (\d+)/.exec(document.getElementById("filtHint").textContent) || [])[1]);
  for (const folders of [true, false]) {
    for (const s of ["all", "cam", "acfa", "srv", "arch", "det"]) {
      click(s);
      if (!btn().disabled && on() !== folders) btn().click();
      for (const st of ["run", "nosignal", "off", "license"]) {
        pickStatus(st);
        await settle();
        const name = `${s}, ${st}, папки ${folders ? "вкл" : "выкл"}`;
        ok(!rows().some(loading), `${name}: нет вечной загрузки`);
        // В «Серверах» сервер — сам найденный объект
        if (s !== "srv") ok(emptyParents() === 0, `${name}: нет родителя без найденного (${emptyParents()})`);
        if (!found()) ok(/Ничего не найдено/.test(document.getElementById("tree").textContent), `${name}: пусто — так и сказано`);
      }
      pickStatus("");
    }
  }
  if (!on()) { click("all"); btn().click(); }

  click("acfa");
  pickStatus("run");
  await settle();
  ok(fs && !fs.flat && rows().some((r) => domains.some((d) => d.id === r.dataset.pick)), "СКУД, «Работает»: дерево, а не плоский список");
  ok(!filtParams(fs).kind.split(",").some((k) => screenType(k) === "camera"), "СКУД, «Работает»: запрос вернул только виды среза");

  click("det");
  await settle();
  const nodes = () => rows().filter((r) => r.dataset.pick).map((r) => find(r.dataset.pick)?.n).filter(Boolean);
  const picked = nodes();
  ok(picked.some((n) => n.type === "det") && fs.order.every((id) => find(id)?.n.type === "det"), "«Детекторы», «Работает»: найдены только детекторы");
  ok(!picked.some((n) => n.type === "camera" && !(n.devices || []).some((d) => d.type === "det" && matchesStatus(d))), "«Детекторы», «Работает»: камера показана только со своим детектором");
  ok(found() === new Set(picked.filter((n) => n.type === "det").map((n) => n.id)).size, `«Детекторы», «Работает»: «Найдено» ${found()} — столько детекторов в дереве`);

  click("arch");
  await settle();
  const archRows = nodes();
  ok(found() === new Set(archRows.filter((n) => n.type === "archive").map((n) => n.id)).size, `«Хранилища», «Работает»: «Найдено» ${found()} — столько хранилищ в дереве`);
  ok(!/Серверы без хранилищ/.test(document.getElementById("tree").textContent), "«Хранилища», «Работает»: серверов без хранилищ нет");
  pickStatus("");

  // Статус вместе с текстом и поиск без статуса
  const empty = () => /Ничего не найдено/.test(document.getElementById("tree").textContent);
  click("all");
  const folderName = folders.find((f) => f.name)?.name;
  setTreeQ(folderName);
  await settle();
  ok(rows().some((r) => folderById(r.dataset.pick) && r.dataset.tid), "поиск без статуса: найденная папка со стрелкой");
  setTreeQ("");
  click("cam");
  const lock = devicePool.find((n) => n.type === "acfa_lock" && treeKind(n) === "cam");
  if (lock) {
    setTreeQ(locName(lock));
    await settle();
    ok(found() >= 1, "«Камеры»: замок под камерой находится поиском");
    setTreeQ("");
  }
  pickStatus("run");
  await settle();
  ok(fs && !fs.flat && filtHitCount() <= LIM.idsMax, `«Камеры», «Работает»: ${filtHitCount()} — дерево: чужие ответы сервера не в счёт`);
  pickStatus("");
  click("det");
  pickStatus("run");
  setTreeQ(domains[0].name);
  await settle();
  ok(found() > 0 || empty(), "«Детекторы», «Работает», имя домена: пусто — так и сказано");
  const cam = devicePool.find((n) => n.type === "camera" && !statusIs(n, "run") && (n.devices || []).some((d) => d.type === "det" && statusIs(d, "run")));
  if (cam) {
    setTreeQ(cam.name);
    await settle();
    ok(nodes().some((n) => n.type === "det" && (cam.devices || []).includes(n)), "«Детекторы», «Работает»: камера с другим статусом показывает работающий детектор");
  }
  setTreeQ("1");
  await settle();
  ok(found() === new Set(nodes().filter((n) => n.type === "det").map((n) => n.id)).size, `«Детекторы», «Работает», широкий текст: «Найдено» ${found()} — столько детекторов в дереве`);
  setTreeQ("");
  pickStatus("");
  click("all");
  if (on()) btn().click();
  pickStatus("run");
  setTreeQ("NVIDIA");
  await settle();
  ok(empty() && !found(), "«Работает», «NVIDIA», по серверам: GPU не объект среза");
  setTreeQ("");
  pickStatus("");
  btn().click();
  click("arch");
  ok(statusCount("run") === new Set(arch.filter((a) => statusIs(a, "run")).map((a) => a.id)).size, "«Хранилища»: счёт в меню статуса — только хранилища");
  click("all");
  await settle();
});
