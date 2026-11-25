/* Сценарий интерфейса: каскад включения канала ввода-вывода (пробелы F66, F67, из прототипа 98). Запуск — tools/check_ui.py
   Вход или выход под выключенным каналом включается вместе с каналом: строка канала в плане карточки входа, одно
   «Применить» на оба объекта, «Сбросить» и повторное выключение возвращают канал; выключение входа канал не трогает. */
UiCheck(async ({ ok, until }) => {
  const devices = await uiDevices();
  const main = () => document.getElementById("main");
  const sw = () => main().querySelector('.ln-sw .sw[role="switch"]');
  const open = (id) => { pick(id, { force: true }); goTab("gen"); };
  const rows = () => cardDiff().map((r) => `${r.node?.id === cardDraft?.id ? "self" : r.node?.id}:${r.key}:${r.toT}`);
  const srvOn = async (id) => (await API.get(`/units/${id}`)).properties.enabled !== false;
  const apply = async () => {
    const was = bq;
    cardApply(true);
    await until(() => bq && bq !== was && bq.finished);
    if (document.getElementById("bmodal")?.classList.contains("open")) closeBulkModal();
  };
  const toggle = async (expectOn) => { sw().click(); await until(() => sw()?.classList.contains("on") === expectOn); };

  // Канал, под которым есть и вход, и выход
  const ch = devices.find((d) => d.type === "channel" && ["sensor", "relay"].every((t) => devices.some((x) => x.type === t && find(x.id)?.p?.id === d.id)));
  ok(!!ch, "канал с входом и выходом");
  const kid = (t) => devices.find((x) => x.type === t && find(x.id)?.p?.id === ch.id);
  const s = kid("sensor"), r = kid("relay");

  // Вход выключить под включённым каналом: канал не меняется
  open(s.id);
  await until(() => sw());
  await toggle(false);
  ok(find(ch.id).n.enabled !== false, "выключение входа: канал в модели включён");
  ok(rows().length === 1 && rows()[0].startsWith("self:enabled"), "выключение входа — одна строка");
  await apply();
  ok(!(await srvOn(s.id)) && (await srvOn(ch.id)), "вход выключен, канал на сервере включён");

  // Канал выключить — его карточка
  open(ch.id);
  await until(() => sw());
  await toggle(false);
  await apply();
  ok(!(await srvOn(ch.id)), "канал выключен на сервере");
  open(s.id);
  await until(() => sw());

  // Включить вход: строка канала в плане, метка в дереве
  await toggle(true);
  ok(rows().some((x) => x.startsWith(`${ch.id}:enabled`)) && rows().length === 2, "включение входа добавляет строку канала");
  ok(find(ch.id).n.enabled === true, "канал включён в черновике");
  decorateTreeSel();
  await until(() => document.querySelector(`#tree .n[data-pick="${ch.id}"]`));
  ok(!!document.querySelector(`#tree .n[data-pick="${ch.id}"] .draft-chip`), "строка канала в дереве — «не применено»");

  // Сервер прислал канал заново (событие канала): строка канала остаётся, канал в черновике включён
  hwApplyUnit(await API.get(`/units/${ch.id}`));
  ok(find(ch.id).n.enabled === true && rows().some((x) => x.startsWith(`${ch.id}:enabled`)), "перечитанный канал: строка канала остаётся");

  // Снова выключить до «Применить» — канал назад (до cardDiff), строк нет
  await toggle(false);
  ok(find(ch.id).n.enabled === false, "повторное выключение возвращает канал");
  ok(rows().length === 0, "после повторного выключения строк нет");

  // Событие ветки стёрло правку входа: строка канала уходит, канал назад
  await toggle(true);
  hwAddRow((await API.get("/units", { ids: s.id })).items[0]);
  ok(rows().length === 0 && find(ch.id).n.enabled === false && !cardDraft?.ioCh, "правка входа стёрта сервером — канал назад");
  if (cardDraft) cardReset();
  open(s.id);
  await until(() => sw());

  // Правка соседа на сервере не попадает в план входа
  await toggle(true);
  const sib = kid("relay"), u = await API.get(`/units/${sib.id}`);
  await API.patch(`/units/${sib.id}`, { name: "Чужое имя" }, `"${u.version}"`);
  await until(() => find(sib.id).n.name === "Чужое имя");
  ok(rows().length === 2 && !rows().some((x) => x.startsWith(`${sib.id}:`)), "правка соседа не в плане");
  cardReset();
  await until(() => !cardDraft);
  ok(find(sib.id).n.name === "Чужое имя", "«Сбросить» не возвращает имя соседа");

  // Включить и «Сбросить»
  open(s.id);
  await until(() => sw());
  await toggle(true);
  cardReset();
  await until(() => !cardDraft);
  ok(find(ch.id).n.enabled === false && find(s.id).n.enabled === false, "«Сбросить» возвращает вход и канал");

  // Включить и применить: оба на сервере одной операцией
  open(s.id);
  await until(() => sw());
  await toggle(true);
  const items = cardApiItems(find(s.id).n, cardDiff()) || [];
  ok(items.length === 2 && items.some((x) => x.targetId === ch.id && x.set?.enabled === true), "одна операция: вход и канал");
  await apply();
  ok((await srvOn(s.id)) && (await srvOn(ch.id)), "вход и канал включены на сервере");

  // Выход, уже включённый под выключенным каналом, канал не включает
  open(ch.id);
  await until(() => sw());
  await toggle(false);
  await apply();
  open(r.id);
  await until(() => sw());
  ok(sw().classList.contains("on"), "выход включён");
  await toggle(false);
  await toggle(true);
  ok(!rows().some((x) => x.startsWith(`${ch.id}:`)), "уже включённый выход канал не включает");
  cardReset();
});
