/* Интервалы расписания (прототип 103, пробелы F109, F113, F114): редактор недели на странице «Расписания».
   Выделение мышью — шаг 5 минут, по нескольким дням сразу; режим «Стирать» (и интервал через полночь);
   «Копировать в…» у дня; вид «Список интервалов» (строка — время и дни недели); «Шаг назад» и «Шаг вперёд».
   Данные — по-прежнему по дням недели (контракт week[7]). На странице без этих функций сценарий ничего не проверяет.
   Запуск: python3 tools/check_ui.py --page index_103_intervaly-nedeli.html tests/ui-intervaly-nedeli.js */
UiCheck(async ({ ok, until }) => {
  if (typeof schErase !== "function" || typeof schCopyGo !== "function") { ok(true, "редактора интервалов прототипа 103 на странице нет"); return; }
  const SID = "f0000001-0001-4000-8000-000000000000"; // «Рабочие дни»: пн–пт 08:00–20:00
  const J = (x) => JSON.stringify(x);
  const E = () => schE("p");
  const W = () => E().d.week;
  const bars = () => [...document.querySelectorAll('#main .sch-bar[data-p^="w:"]')];
  // Выделение мышью от минуты m0 в строке r0 до минуты m1 в строке r1 (события указателя, как у человека)
  const drag = (r0, m0, r1, m1) => {
    const b = bars(), a = b[r0].getBoundingClientRect(), z = b[r1].getBoundingClientRect();
    const x = (m) => a.left + (m / 1440) * a.width;
    const ev = (t, mx, y) => new PointerEvent(t, { bubbles: true, button: 0, clientX: mx, clientY: y, pointerId: 1 });
    b[r0].dispatchEvent(ev("pointerdown", x(m0), a.top + a.height / 2));
    b[r0].onpointermove(ev("pointermove", x(m1), z.top + z.height / 2));
    b[r0].onpointerup(ev("pointerup", x(m1), z.top + z.height / 2));
  };
  const set = (w) => schMut("p", (s) => { s.week = J(w) && JSON.parse(J(w)); });

  goApp("rules");
  ruleOpen("sch:" + SID);
  ok(await until(() => bars().length === 7), "редактор недели открыт: 7 полос");
  ok(!!document.querySelector(".sch-vseg") && !!document.querySelector(".sch-mseg"), "переключатели вида и режима на месте");
  ok(!document.querySelector(".sch-undo button:not([disabled])"), "до правок «Шаг назад» и «Шаг вперёд» недоступны");

  // 1. Шаг 5 минут и несколько дней: сб и вс 10:00–14:15
  drag(5, 600, 6, 855);
  ok(J(W()[5]) === J([["10:00", "14:15"]]) && J(W()[6]) === J([["10:00", "14:15"]]), "выделение по двум дням: сб и вс 10:00–14:15 (шаг 5 минут)");
  ok(J(W()[4]) === J([["08:00", "20:00"]]), "пятница не задета");
  // Выделение до конца суток
  drag(5, 1320, 5, 1440);
  ok(J(W()[5]) === J([["10:00", "14:15"], ["22:00", "00:00"]]), "выделение до 24:00 — интервал до полуночи");

  // 2. Стирание по нескольким дням: пн–ср 12:00–13:00
  schSetMode("p", "erase");
  ok(await until(() => document.querySelector('.sch-mseg [aria-checked="true"]')?.textContent.includes("Стирать")), "режим «Стирать» включён");
  drag(0, 720, 2, 780);
  ok([0, 1, 2].every((i) => J(W()[i]) === J([["08:00", "12:00"], ["13:00", "20:00"]])), "стирание по трём дням: пн–ср 08:00–12:00 и 13:00–20:00");
  ok(J(W()[3]) === J([["08:00", "20:00"]]), "четверг не задет");

  // 3. Стирание и интервал через полночь
  set([[["22:00", "06:00"]], [], [], [], [], [], []]);
  drag(0, 1380, 0, 1440);
  ok(J(W()[0]) === J([["22:00", "23:00"]]) && J(W()[1]) === J([["00:00", "06:00"]]), "стирание 23:00–24:00 в пн: в пн 22:00–23:00, утро уходит во вторник");
  set([[["22:00", "06:00"]], [], [], [], [], [], []]);
  drag(1, 120, 1, 180);
  ok(J(W()[0]) === J([["22:00", "02:00"]]) && J(W()[1]) === J([["03:00", "06:00"]]), "стирание 02:00–03:00 во вт режет интервал понедельника через полночь");
  set([[["22:00", "06:00"]], [], [], [], [], [], []]);
  drag(0, 600, 0, 720);
  ok(J(W()[0]) === J([["22:00", "06:00"]]), "стирание мимо интервала ничего не меняет");
  schSetMode("p", "add");

  // 4. «Копировать в…»
  set([[["08:00", "12:00"], ["13:00", "17:00"]], [], [], [], [], [], []]);
  schCopyOpen("p", 0);
  ok(await until(() => document.querySelector(".sch-pop")), "окошко «Копировать в…» открыто");
  const go = () => [...document.querySelectorAll(".sch-pop button")].pop();
  ok(go().disabled, "без отмеченных дней кнопка копирования недоступна");
  schCopyTick("p", 2, true); schCopyTick("p", 4, true);
  ok(await until(() => /в 2 дня/.test(go().textContent) && !go().disabled), "кнопка называет число дней");
  go().click();
  ok(await until(() => !document.querySelector(".sch-pop")), "после копирования окошко закрыто");
  ok(J(W()[2]) === J(W()[0]) && J(W()[4]) === J(W()[0]) && J(W()[1]) === "[]", "ср и пт получили интервалы пн, вт — нет");
  schCopyOpen("p", 3); schCopyAll("p");
  ok(E().copySel.length === 6 && !E().copySel.includes(3), "«Все дни» отмечает все дни, кроме источника");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(await until(() => !document.querySelector(".sch-pop")), "Esc закрывает окошко");

  // 5. Вид «Список интервалов»
  set([[["08:00", "18:00"]], [["08:00", "18:00"]], [["08:00", "18:00"]], [["08:00", "18:00"]], [["08:00", "18:00"]], [["10:00", "14:00"]], []]);
  schSetView("p", "list");
  ok(await until(() => document.querySelectorAll(".sch-li").length === 2), "одинаковые интервалы — одна строка: 2 строки");
  const g = schGroups(E());
  ok(J(g.map((r) => [r.iv, r.days])) === J([[["08:00", "18:00"], [0, 1, 2, 3, 4]], [["10:00", "14:00"], [5]]]), "строки: 08:00–18:00 пн–пт и 10:00–14:00 сб");
  schLsDay("p", "10:00", "14:00", 6, true);
  ok(J(W()[6]) === J([["10:00", "14:00"]]), "флажок «вс» добавил интервал в воскресенье");
  schLsDay("p", "08:00", "18:00", 4, false);
  ok(J(W()[4]) === "[]", "снятый флажок «пт» убрал интервал из пятницы");
  schLsTime("p", "08:00", "18:00", 1, "19:00");
  ok([0, 1, 2, 3].every((i) => J(W()[i]) === J([["08:00", "19:00"]])), "конец 19:00 — во всех днях строки");
  schLsAll("p", "08:00", "19:00", true);
  ok(W().every((l) => l.some((x) => x[0] === "08:00" && x[1] === "19:00")), "«Все» — интервал во всех днях");
  schLsDel("p", "08:00", "19:00");
  ok(W().every((l) => !l.some((x) => x[0] === "08:00" && x[1] === "19:00")), "удаление строки убрало интервал из всех дней");
  schLsAdd("p");
  ok(await until(() => document.querySelector(".sch-li.pend")), "новая строка без дней видна и помечена");
  ok(W().every((l) => !l.some((x) => x[0] === "09:00" && x[1] === "18:00")), "строка без дней не попала в данные");
  schLsAdd("p");
  ok(await until(() => document.querySelectorAll(".sch-li.pend").length === 2), "две новые строки с одинаковым временем");
  schLsTime("p", "09:00", "18:00", 1, "17:00", 1);
  ok(J(E().lpend) === J([["09:00", "18:00"], ["09:00", "17:00"]]), "время второй новой строки меняется только у неё");
  schLsDel("p", "09:00", "18:00", 0);
  ok(J(E().lpend) === J([["09:00", "17:00"]]), "«Убрать» убирает только свою новую строку");
  schLsDay("p", "09:00", "17:00", 2, true, 0);
  ok(J(W()[2]) === J([["09:00", "17:00"]]) && !E().lpend.length, "первый флажок дня переносит строку в данные");
  schSetView("p", "grid");
  ok(await until(() => bars().length === 7), "обратно в вид «По дням»");

  // Режим «Стирать» не переходит в другой тип и вид: там переключателя нет
  schSetMode("p", "erase");
  schSetView("p", "list");
  ok(E().mode === "add", "смена вида возвращает режим «Добавлять»");
  schSetView("p", "grid");
  schSetMode("p", "erase");
  schSetKind("p", "cycle");
  ok(E().mode === "add" && !schErasing(E()), "смена типа возвращает режим «Добавлять»");
  schUndo("p");
  ok(await until(() => E().d.kind === "week" && bars().length === 7), "шаг назад вернул тип «По дням недели»");

  // 6. Шаг назад и шаг вперёд
  set([[["08:00", "20:00"]], [], [], [], [], [], []]);
  const before = J(W());
  drag(1, 540, 1, 600);
  const after = J(W());
  ok(after !== before, "правка выделением");
  schUndo("p");
  ok(J(W()) === before, "«Шаг назад» вернул неделю до выделения");
  schRedo("p");
  ok(J(W()) === after, "«Шаг вперёд» повторил выделение");
  schUndo("p");
  drag(2, 540, 2, 600);
  ok(!E().fut.length, "новая правка стирает шаги вперёд");
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "я", code: "KeyZ", ctrlKey: true, bubbles: true }));
  ok(J(W()) === before, "Ctrl+Z — шаг назад, и в русской раскладке");
  ok(await until(() => document.querySelector(".sch-undo button:not([disabled])")), "кнопки шагов доступны после правок");

  // 7. Окно расписания: Esc закрывает окошко «Копировать в…», а не окно
  schDlgOpen(SID);
  ok(await until(() => schDlgIsOpen() && document.querySelector('#schdlg .sch-bar[data-p="w:0"]')), "окно расписания открыто");
  schCopyOpen("d", 0);
  ok(await until(() => document.querySelector("#schdlg .sch-pop")), "в окне открыто «Копировать в…»");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(await until(() => !document.querySelector("#schdlg .sch-pop")), "Esc закрыл окошко");
  ok(schDlgIsOpen(), "окно расписания осталось открытым");
});
