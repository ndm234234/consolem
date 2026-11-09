/* Сценарии интерфейса: длинный список выбора открывается с поиском (порог CBX_MIN), короткий — обычный;
   шаблоны на необъявленных событиях скрыты и появляются, когда вид их объявил. */
UiCheck(async ({ ok, until }) => {
  const down = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const mk = (n, attrs = "", host = document.body) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<select ${attrs}><option value="">Выберите…</option>` + Array.from({ length: n }, (_, i) => `<option value="v${i}">Пункт ${i}</option>`).join("") + "</select>";
    const s = wrap.firstChild;
    let got = 0;
    s.addEventListener("change", () => got++);
    host.append(s);
    return { s, count: () => got };
  };
  const big = mk(CBX_MIN), small = mk(CBX_MIN - 1), multi = mk(CBX_MIN, "multiple");

  // Открытие настоящим нажатием мыши, а не вызовом компонента
  down(small.s);
  ok(!document.querySelector(".cbx"), `${CBX_MIN - 1} пунктов: обычный список, пустой пункт не считается`);
  down(multi.s);
  ok(!document.querySelector(".cbx"), "список с множественным выбором — без поиска");
  down(big.s);
  ok(!!document.querySelector(".cbx"), `${CBX_MIN} пунктов: нажатие открывает поиск`);
  const q = document.querySelector(".cbx-q");
  ok(q === document.activeElement, "фокус в поле поиска");
  q.value = "Пункт 3";
  q.dispatchEvent(new Event("input", { bubbles: true }));
  ok(await until(() => document.querySelectorAll(".cbx-o").length === 1), "список сузился");
  ok(/1 из 8/.test(document.querySelector(".cbx-n").textContent.replace(/\s+/g, " ")), "итог «Показано N из M»");
  ok(!!document.querySelector(".cbx-o mark"), "совпадение подсвечено");
  q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok(big.s.value === "v3" && big.count() === 1, "Enter выбирает, обработчик получает change");
  ok(!document.querySelector(".cbx"), "после выбора окно закрыто");
  big.s.dispatchEvent(new KeyboardEvent("keydown", { key: "А", bubbles: true }));
  ok(document.querySelector(".cbx-q")?.value === "А", "буква с клавиатуры открывает поиск с этой буквой");
  document.querySelector(".cbx-q").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(big.s.value === "v3" && big.count() === 1 && !document.querySelector(".cbx"), "Esc отменяет");
  [big, small, multi].forEach((x) => x.s.remove());

  // Шаблоны: сервер объявил событие — шаблон появился, настоящей сборкой каталога из описаний видов
  const tpl = (id) => RULE_TPL.find((t) => t.id === id);
  // Эталонный набор объявляет события цепочки правила сам; чтобы проверить, как шаблон зависит от описания, они снимаются, а в конце возвращаются
  const CHAIN = ["device.lost", "device.restored", "device.auth", "device.enabled", "device.disabled", "tamper", "fire", "smoke", "face.list", "plate.list", "alarm.raised", "alarm.taken", "alarm.closed",
    "alarm.confirmed", "alarm.suspicious", "alarm.false", "alarm.missed", "rec.started", "rec.stopped", "rec.lost", "rec.back", "arm.on", "arm.private", "arm.off", "ptz.moved", "ptz.manual", "ptz.failed",
    "output.on", "server.down", "server.up", "license.lost", "load.high", "sched.edge", "volume.error", "volume.ok"];
  const allKinds = [...KINDS.values()], fullEvents = allKinds.map((k) => k.events);
  allKinds.forEach((k) => { if (k.events) k.events = k.events.filter((e) => !CHAIN.includes(e.id)); });
  ruleCatFromKinds();
  ok(!ruleTplDeclared(tpl("tamp")), "событие не объявлено — шаблона нет");
  ok(ruleTplDeclared(tpl("line")), "шаблон на объявленном событии виден");
  ok(ruleTplDeclared(tpl("lost")), "прежний шаблон на месте");
  const cam = KINDS.get("camera"), was = cam.events;
  const ev = (id, x) => ({ id, label: { key: "t." + id, text: id, lang: "ru" }, ...x });
  const declare = (list) => { cam.events = [...was, ...list]; ruleCatFromKinds(); };
  const presence = { params: { type: "object", properties: { presence: { type: "string", enum: ["yes", "no"] } } } };
  declare([ev("device.lost")]);
  ok(!ruleTplDeclared(tpl("off")), "шаблон не появляется, пока не объявлено событие из его ветки");
  declare([ev("plate.list")]);
  ok(!ruleTplDeclared(tpl("plate")), "шаблон не появляется, пока вид не объявил его уточнение");
  declare([ev("device.lost"), ev("device.restored"), ev("plate.list", presence), ev("alarm.closed"), ev("alarm.confirmed"), ev("tamper"), ev("volume.error"), ev("server.down")]);
  ["plate", "aclose", "aconf", "off", "tamp", "vol", "srv"].forEach((id) => ok(ruleTplDeclared(tpl(id)), `шаблон ${id}: события объявлены — появился`));

  // В мастере теперь больше 7 шаблонов: появляется поиск над карточками
  ruleNewOpen();
  ruleNewGo(1);
  const box = document.querySelector("#bmodal");
  const qt = box.querySelector(".rl-tpl-q");
  ok(!!qt, "шаблонов 8 и больше — над карточками есть поиск");
  ok(box.querySelector('[data-tpl="tamp"]') && box.querySelector(".rl-tpl-g"), "скрытый раньше шаблон показан, карточки в группах");
  ruleTplFilter("закрыли");
  const on = [...box.querySelectorAll("[data-tpl]")].filter((e) => !e.hidden).map((e) => e.dataset.tpl);
  ok(on.length === 1 && on[0] === "tamp", "поиск сузил карточки: " + on.join());
  closeBulkModal();
  cam.events = was;
  ruleCatFromKinds();
  ok(!ruleTplDeclared(tpl("tamp")), "описание вернулось — шаблон снова скрыт");
  allKinds.forEach((k, i) => { k.events = fullEvents[i]; });
  ruleCatFromKinds();
  ok(["plate", "aclose", "aconf", "off", "tamp", "vol", "srv"].every((id) => ruleTplDeclared(tpl(id))), "описания набора вернулись — шаблоны на объявленных событиях видны");

  // Группы в списке событий: регистр кода не важен
  ok(trigGroup({ sub: "unit", kind: "ALARM" }) === "Тревоги", "группа по коду события без учёта регистра");
});
