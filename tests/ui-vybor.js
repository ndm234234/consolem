/* Прототип 26: единый выбор на вкладках «Оборудования» и раскрытие дерева. Запуск:
   python tools/check_ui.py tests/ui-vybor.js */
// Без чтения кэша до конца: страница работает так, как у пользователя
window.UI_RAW_CACHE = true;
UiCheck(async ({ ok, until, sleep }) => {
  const tree = () => document.getElementById("tree");
  const rows = () => [...tree().querySelectorAll(".n")];
  const rowNamed = (name) => rows().find((r) => r.querySelector(".nm")?.textContent.trim() === name);
  const shut = (r) => !!r.querySelector(".tw-chev.shut");
  const chip = (id) => document.querySelector(`.ph-choice[data-slice="${id}"] .ph-cnt`)?.textContent.trim();

  goApp("hw");

  // Начальный вид: домены раскрыты, ниже свёрнуто
  setSlice("cam");
  await until(() => sliceReads.get(sliceReadKey())?.done);
  const start = rows().length;
  ok(start < 100, `дерево при входе короткое: ${start} строк`);

  // «Развернуть всё» нет: в большой конфигурации оно читало ветку за веткой. Ветку раскрывают по одной
  ok(typeof treeExpandAll === "undefined" && typeof treeExpandBelow === "undefined", "нет «Развернуть всё» и «Развернуть всё внутри»");

  // У каждой вкладки своё раскрытие
  const dom = domains[0];
  const fld = rows().find((r) => r.classList.contains("fld") && shut(r));
  const fldId = fld.dataset.tid;
  fld.querySelector(".tw").click();
  ok(open.has(fldId), "стрелка раскрыла папку");
  setSlice("arch");
  ok(!open.has(fldId), "другая вкладка папку не раскрывает");
  setSlice("cam");
  ok(open.has(fldId), "вкладка помнит своё раскрытие");
  await until(() => !tree().querySelector(".n-skel"));
  const wide = rows().length;
  ok(wide > start, `раскрытая папка показывает больше строк: ${wide}`);

  // «Свернуть всё внутри» сворачивает ветку, «Свернуть всё» возвращает короткое дерево
  treeCollapseBelow(dom.id);
  ok(!open.has(fldId), "«Свернуть всё внутри» сворачивает ветку");
  treeCollapseAll();
  ok(rows().length <= start, "«Свернуть всё» возвращает короткое дерево");

  // Ветка читается: на месте её строк — скелетон из трёх строк, он проявляется с задержкой и уходит с ответом
  const unread = rows().find((r) => r.dataset.tid && shut(r) && treeUnread(r.dataset.tid));
  if (unread) {
    unread.querySelector(".tw").click();
    const sk = [...tree().querySelectorAll(".n-skel")];
    ok(sk.length === 3 && sk.filter((x) => x.getAttribute("role") === "status").length === 1, "скелетон ветки — три строки, одна из них для экранного диктора");
    ok(parseFloat(sk[0].style.getPropertyValue("--skd")) > 0, "скелетон проявляется с задержкой: " + sk[0].style.getPropertyValue("--skd"));
    ok(await until(() => !tree().querySelector(".n-skel")), "скелетон уходит, когда ветка прочитана");
    treeCollapseAll();
  } else ok(true, "непрочитанной ветки нет — скелетон не проверить");

  // Новый домен открыт: сохранённый список знает только закрытые
  open.delete(dom.id);
  treeOpenSave();
  ok(treeOpenBy.get(treeOpenKey()).includes("!" + dom.id), "закрытый домен запомнен");
  const other = domains[1];
  treeOpenBy.set(treeOpenKey(), treeOpenBy.get(treeOpenKey()).filter((x) => x !== other.id && x !== "!" + other.id));
  treeOpenRestore();
  ok(!open.has(dom.id) && open.has(other.id), "закрытый остался закрытым, неизвестный домен открыт");
  treeCollapseAll();

  // Переход на другую вкладку не смешивает раскрытие вкладок
  const detU = (await API.get("/units", { implements: "vms.detector/1", limit: 1 })).items[0], detTarget = { id: detU.uid, parentId: detU.parentId };
  await hwEnsure([detTarget.parentId, detTarget.id]);
  const detFolders = new Set(foldersOfDevice(detTarget.parentId).flatMap((f) => folderPath(f.id).map((x) => x.id)));
  const camFld = rows().find((r) => r.classList.contains("fld") && shut(r) && !detFolders.has(r.dataset.tid));
  const camFldId = camFld.dataset.tid;
  camFld.querySelector(".tw").click();
  jumpToNode(find(detTarget.id).n);
  renderTree();
  treeOpenSave();
  ok(!(treeOpenBy.get(treeOpenKey()) || []).includes(camFldId), "переход: чужая папка не попала в раскрытие вкладки");
  setSlice("cam");
  ok(open.has(camFldId), "переход: вкладка «Камеры» помнит свою папку");
  treeCollapseAll();

  // Пустой режим выбора переживает смену вкладки
  setSelMode(true);
  setSlice("acfa");
  ok(selMode, "пустой режим выбора остаётся при смене вкладки");
  setSelMode(false);

  // ОПС/СКД: стрелка только у ветки, где есть объекты вкладки или вложенные папки
  setSlice("acfa");
  await until(() => sliceReads.get(sliceReadKey())?.done);
  ok(Number(chip("acfa")) > 0, `цифра на кнопке обновилась: ${chip("acfa")}`);
  const empties = rows().filter((r) => r.classList.contains("fld") && r.classList.contains("n-slice-empty"));
  ok(empties.length > 0, "есть серые папки");
  const leaf = empties.filter((r) => {
    const f = folderById(r.dataset.pick);
    return f && !(f.folders || []).length;
  });
  ok(leaf.length > 0 && leaf.every((r) => !r.querySelector(".tw-chev")), "серая папка без вложенных папок — без стрелки");
  const full = rows().find((r) => r.classList.contains("fld") && !r.classList.contains("n-slice-empty") && shut(r));
  ok(!!full, "папка с объектами — со стрелкой");
  const fullId = full.dataset.tid;
  const before = rows().length;
  full.querySelector(".tw").click();
  await until(() => rows().length > before);
  const fullNow = rows().find((r) => r.dataset.pick === fullId);
  ok(fullNow && !fullNow.classList.contains("n-slice-empty"), "раскрытая папка не посерела");
  treeCollapseAll();

  // Галочка на пустых строках вне режима выбора не видна
  const emptyRow = rows().find((r) => r.classList.contains("n-slice-empty") && r.querySelector(".n-chk"));
  if (emptyRow) ok(getComputedStyle(emptyRow.querySelector(".n-chk")).opacity === "0", "галочка пустой строки скрыта");

  // Детекторы: общий выбор, панель под деревом, карточка выборки, панели над таблицей нет
  setSlice("det");
  await until(() => detRows().length > 2);
  const ids = detKindIds().slice(0, 3);
  ok(ids.length === 3, "есть три детектора");
  ok(typeof detSelSet === "undefined" && typeof detBarHtml === "undefined", "своего выбора у детекторов нет");
  detKindChk(detKindLabel(find(ids[0]).n, find(ids[0]).p));
  ok(selMode && treeSel.has(ids[0]), "галочка вида отмечает его детекторы");
  treeSel.clear();
  selMode = false;
  renderTree();
  ids.forEach((id) => selChkClick(id));
  ok(treeSel.size === 3 && selMode, "галочки отмечают три детектора");
  ok(bulkActive(), "открыта карточка выборки");
  aside();
  gear();
  ok(/Нарисовать зоны/.test(document.body.textContent), "«Нарисовать зоны» — в карточке выборки");
  ok(/3/.test(document.getElementById("selBar")?.textContent || ""), "панель под деревом показывает число");

  // Очередь зон: конец очереди снимает её отметки, остальные остаются
  dzFromSel();
  ok(!!dz && dz.ids.length === 3, "очередь зон из карточки выборки");
  // Несохранённая зона: строка вне очереди спрашивает и не отмечается
  const outside = detKindIds().find((id) => !ids.includes(id));
  expandTo(outside);
  renderTree();
  await until(() => tree().querySelector(`.n[data-pick="${outside}"]`));
  const outRow = tree().querySelector(`.n[data-pick="${outside}"]`);
  ok(!!outRow, "строка вне очереди видна");
  dz.draft = { shape: "rect" };
  outRow.click();
  ok(document.getElementById("confirmTitle").textContent === "Зона не сохранена" && !treeSel.has(outside), "строка вне очереди спрашивает о зоне и не отмечается");
  closeConfirm();
  dz.draft = undefined;
  dzEnd(true);
  ok(!dz && !selMode && !ids.some((id) => treeSel.has(id)), "конец очереди снимает её отметки");
  ids.forEach((id) => selChkClick(id));
  // Удаление детекторов говорит, что пропадёт и что останется
  confirmDeleteNodes(ids.slice(0, 2), null);
  const delText = document.getElementById("confirm").textContent;
  ok(/зонами и настройками/.test(delText) && /записи останутся/.test(delText), "диалог удаления детекторов перечисляет, что пропадёт и что останется");
  closeConfirm();

  // Смена вкладки не теряет отметки
  setSlice("all");
  ok(treeSel.size === 3 && selMode, "отметки пережили смену вкладки");
  ok(/здесь/.test(document.getElementById("selBar")?.textContent || "") || /3/.test(document.getElementById("selBar")?.textContent || ""), "панель показывает общее число");
  setSelMode(false);
  ok(!selMode && !treeSel.size, "выход из режима снимает отметки");

  // Вне режима выбора открытый объект отметкой не считается
  setSlice("cam");
  ok(!selMode, "смена вкладки не включает режим выбора");
});
