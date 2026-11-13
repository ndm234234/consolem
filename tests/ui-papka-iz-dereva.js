/* Сценарии интерфейса: папка объекта из меню строки дерева — «Переместить в папку…» и «Добавить в папку…».
   Пункты видит только объект: домен, сервер и папка их не получают. Список папок — папки домена объекта,
   с поиском и итогом «Показано N из M». На странице без этих пунктов (старые прототипы) сценарий молчит.
   Запуск — python3 tools/check_ui.py tests/ui-papka-iz-dereva.js */
UiCheck(async ({ ok, sleep, until }) => {
  if (typeof tfOpen !== "function") { ok(true, "на этой странице папки из дерева нет"); return; }
  const items = () => [...document.querySelectorAll("#tctx button")].map((b) => b.innerText.replace(/\s+/g, " ").trim());
  const has = (re) => items().some((t) => re.test(t));
  const openCtx = (id) => { closeTreeCtx(); openTreeCtx(find(id).n, { x: 20, y: 20 }); };
  const rows = () => [...document.querySelectorAll("#tctx .tf-list button")];

  goApp("hw");
  const devs = await uiDevices();
  const cam = devs.find((d) => d.type === "camera" && canFolderPick(find(d.id)?.n));
  ok(!!cam, "есть камера, которой можно выбрать папку");
  if (!cam) return;
  const dom = nodeDomainId(find(cam.id).n);
  const mine = flatFolders().filter((f) => folderDomain(f.id) === dom);
  ok(mine.length >= 2, `у домена камеры папок: ${mine.length}`);

  // 1. Меню строки: пункты у объекта, у домена и папки их нет
  openCtx(cam.id);
  ok(has(/Переместить в папку/), "меню камеры: «Переместить в папку…»");
  ok(has(/Добавить в папку/), "меню камеры: «Добавить в папку…»");
  openCtx(dom);
  ok(!has(/Переместить в папку/), "меню домена: пункта нет");
  openCtx(mine[0].id);
  ok(!has(/Переместить в папку/), "меню папки: пункта нет");
  closeTreeCtx();

  // 2. Список предлагает папки домена объекта, с поиском и итогом
  tfOpen(document.getElementById("tree"), cam.id, "add");
  await sleep(50);
  ok(rows().length === mine.length, `список: папок ${rows().length} из ${mine.length} домена`);
  const foot = document.querySelector("#tctx .tf-foot");
  if (mine.length >= CBX_MIN) {
    ok(!!document.getElementById("tfq"), "длинный список открылся с поиском");
    ok(/Показано\s+\d+\s+из\s+\d+/.test(foot?.textContent || ""), `итог: ${foot?.textContent.trim()}`);
    const target = mine.find((f) => !(f.items || []).includes(cam.id));
    tfType(folderPathName(target.id));
    await sleep(50);
    ok(rows().length < mine.length, `поиск сузил список до ${rows().length}`);
    ok(!!document.querySelector("#tctx .tf-list mark"), "совпадение подсвечено");
  }
  closeTreeCtx();

  // 3. «Добавить» оставляет прежние папки
  const was = cardFolders(cam.id);
  const add = mine.find((f) => !was.includes(f.id));
  tfOpen(document.getElementById("tree"), cam.id, "add");
  await sleep(50);
  tfPick(add.id);
  ok(await until(() => cardFolders(cam.id).includes(add.id), 30000), `камера в папке «${locName(add)}»`);
  ok(was.every((id) => cardFolders(cam.id).includes(id)), `прежние папки остались: ${was.length}`);

  // 4. Папка, где объект уже лежит: «Добавить» туда нечего
  tfOpen(document.getElementById("tree"), cam.id, "add");
  await sleep(50);
  const here = rows().find((b) => b.innerText.includes("уже здесь"));
  ok(!!here && here.disabled, "«Добавить»: папка объекта неактивна");
  closeTreeCtx();

  // 5. «Переместить» убирает прежние папки
  const move = mine.find((f) => !cardFolders(cam.id).includes(f.id));
  tfOpen(document.getElementById("tree"), cam.id, "move");
  await sleep(50);
  tfPick(move.id);
  ok(await until(() => cardFolders(cam.id).join() === move.id, 30000), `после переноса папка одна: «${locName(move)}»`);
  ok(folderPath(move.id).every((f) => open.has(f.id)), "путь к папке раскрыт");
  ok(tfPickState === null, "выбор папки не пережил меню");
});
