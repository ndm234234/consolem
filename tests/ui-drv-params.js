// Параметры драйвера камеры и регистратора: схема объекта с сервера (GET /units/{uid}/schema), блоки по x-ui-*, правка —
// черновик карточки, «Применить» — PATCH. Ответы на запросы mockup о параметрах драйвера камеры (п. 6) и регистратора (п. 2)
UiCheck(async ({ ok, until, sleep }) => {
  const main = () => document.getElementById("main");
  const cams = (await API.get("/units", { kind: "camera", limit: 500 })).items;
  const c0 = cams.find((u) => u.properties.driver === "native" && !u.properties.isVideoBufferOn);
  pick(c0.uid, { force: true });
  await until(() => sel === c0.uid && !find(c0.uid)?.n._row);
  goTab("gen");
  await sleep(50);
  const n = find(c0.uid).n;
  ok(/Обмен с камерой/.test(main().textContent), "block shown: Обмен с камерой");
  ok(!/Размер буфера/.test(main().textContent), "no buffer size before");
  const G = "Обмен с камерой";
  drvEditStart(c0.uid, G);
  sfToggle("drv", c0.uid, "isVideoBufferOn");
  await sleep(20);
  ok(/Размер буфера/.test(main().textContent), "buffer size appears in edit after toggle: xprops=" + JSON.stringify(n.xprops));
  drvEditDone(c0.uid, G);
  await sleep(20);
  const d = cardDiff();
  ok(d.some((r) => r.key === "xprops" && r.schemaProp === "isVideoBufferOn" && /Обмен с камерой: /.test(r.label) && !r.stub), "plan row: " + JSON.stringify(d.map((r) => [r.label, r.fromT, r.toT, r.stub])));
  ok(/Размер буфера/.test(main().textContent), "buffer size in view after done");
  // Базовая форма и своё окно — один черновик параметров драйвера
  ok(!baseChanged(n).length, "правка параметра драйвера не держит возврат из «Все параметры»: " + baseChanged(n).join());
  cardApply();
  ok(await until(() => bq && bq.finished, 15000), "applied, fail=" + bq?.fail);
  const u = await API.get(`/units/${c0.uid}`);
  ok(u.properties.isVideoBufferOn === true, "server has isVideoBufferOn true");
  // Без лишней перерисовки: окно после «Применить» уже показывает поле, которое открыла правка
  await sleep(300);
  const txt = main().textContent;
  ok(/Размер буфера/.test(txt), "after apply, without extra render: buffer size shown");
  const got = drvSchemaGot.get(c0.uid);
  ok(got && got.ver === hwVer.get(c0.uid), "schema cache at current version: " + (got && got.ver) + " vs " + hwVer.get(c0.uid));
  gear(); await sleep(50);
  ok(/Размер буфера/.test(main().textContent), "after explicit gear: buffer size shown");
  // Cancel flow
  drvEditStart(c0.uid, G);
  sfToggle("drv", c0.uid, "isVideoBufferOn");
  drvEditCancel(c0.uid, G);
  ok(!Object.keys(n.xprops || {}).length, "cancel restores draft: " + JSON.stringify(n.xprops));
  // Reset flow
  drvEditStart(c0.uid, G);
  sfToggle("drv", c0.uid, "isVideoBufferOn");
  drvEditDone(c0.uid, G);
  ok(cardDiff().length > 0, "draft present");
  cardReset(); await sleep(20);
  ok(!Object.keys(n.xprops || {}).length && !cardDiff().length, "reset clears draft: " + JSON.stringify(n.xprops));
  // Number field emptied: server has value -> null in draft
  drvEditStart(c0.uid, G);
  const tg = drvTarget(c0.uid);
  ok(tg.vals.videoBufferSize !== undefined, "videoBufferSize default via proxy: " + tg.vals.videoBufferSize);
  drvEditCancel(c0.uid, G);
  // Recorder
  const ips = (await API.get("/units", { kind: "ipsrv", limit: 50 })).items.find((x) => x.properties.subtype === "nvr");
  pick(ips.uid, { force: true });
  await until(() => sel === ips.uid && !find(ips.uid)?.n._row);
  goTab("gen"); await sleep(50);
  ok(/Обмен с устройством/.test(main().textContent) && /Low GOP/.test(main().textContent), "recorder block with Low GOP");
  // channel camera
  const ch = cams.find((x) => x.properties.driver === "native-channel");
  pick(ch.uid, { force: true });
  await until(() => sel === ch.uid && !find(ch.uid)?.n._row);
  goTab("gen"); await sleep(50);
  ok(!/Прервать неиспользуемое/.test(main().textContent), "channel camera: no breakUnusedConnections");
  // Edge storage camera
  const e = cams.find((x) => x.properties.edgeStorage === true);
  pick(e.uid, { force: true });
  await until(() => sel === e.uid && !find(e.uid)?.n._row);
  goTab("rec"); await sleep(100);
  ok(/Встроенное хранилище/.test(main().textContent), "edge card on rec");
  ok(!/Консоль не берёт записи с карты памяти/.test(main().textContent), "edge on: body shown");
  {
  // Recorder apply
  const ips2 = (await API.get("/units", { kind: "ipsrv", limit: 50 })).items.find((x) => x.properties.subtype === "nvr");
  pick(ips2.uid, { force: true });
  await until(() => sel === ips2.uid && !find(ips2.uid)?.n._row);
  goTab("gen"); await sleep(50);
  const GI = "Обмен с устройством";
  drvEditStart(ips2.uid, GI);
  sfToggle("drv", ips2.uid, "lowGop");
  drvEditDone(ips2.uid, GI);
  const d = cardDiff();
  ok(d.some((r) => r.schemaProp === "lowGop"), "ipsrv plan row: " + JSON.stringify(d.map((r) => r.label)));
  cardApply();
  ok(await until(() => bq && bq.finished, 15000), "ipsrv applied, fail=" + bq?.fail);
  ok((await API.get(`/units/${ips2.uid}`)).properties.lowGop === true, "server ipsrv lowGop true");
  // Reset target on a native camera: change an x-dev field first so reset has a row
  const c = cams.find((u) => u.properties.driver === "native");
  pick(c.uid, { force: true });
  await until(() => sel === c.uid && !find(c.uid)?.n._row);
  goTab("vid"); await sleep(50);
  const nc = find(c.uid).n;
  ok(/Изображение/.test(main().textContent), "Изображение block on vid");
  const dev = camDevFields(nc);
  ok(dev.length > 0, "x-dev fields: " + dev.map(([f]) => f).join());
  nc.xprops = nc.xprops || {}; nc.xprops.brightness = 70; setD(true);
  const rows = camTargetRows(nc, camResetTarget(nc, []));
  ok(rows.some((r) => /Яркость/.test(r.label) && !r.stub), "reset row brightness, no stub: " + JSON.stringify(rows.map((r) => [r.label, r.fromT, r.toT, r.stub])));
  rows.forEach((r) => r.set());
  ok(!("brightness" in nc.xprops), "reset to default removes draft key when server equals default: " + JSON.stringify(nc.xprops));
  cardReset(); await sleep(20);
  // Load-from-device rows
  const rep = camDevReported(nc, []);
  const lrows = camTargetRows(nc, rep);
  ok(lrows.every((r) => r.stub), "load rows stub: " + JSON.stringify(lrows.map((r) => [r.label, r.stub])));
  // Base form round trip with drv edit
  goTab("gen"); await sleep(20);
  drvEditStart(c.uid, "Обмен с камерой");
  sfToggle("drv", c.uid, "isVideoBufferOn");
  drvEditDone(c.uid, "Обмен с камерой");
  formAllSet(true); await sleep(20);
  ok(cardFormAll(nc), "opened Все параметры");
  formAllSet(false); await sleep(20);
  ok(!cardFormAll(nc), "can return from Все параметры after drv edit in own screen (cardFormAll=" + cardFormAll(nc) + ")");
  formAllByKind.set(tabMemKey(nc), false);
  cardReset(); await sleep(20);
  // Alternative camera options
  goTab("vid"); await sleep(20);
  drvEditStart(c.uid, "Резервное отображение"); await sleep(20);
  const opts = [...main().querySelectorAll('[data-sec="drv:Резервное отображение"] select option')].map((o) => o.value);
  const dom = nodeDomainId(nc);
  ok(!opts.includes(c.uid), "backup camera list excludes self");
  ok(opts.filter(Boolean).every((id) => nodeDomainId(find(id)?.n) === dom), "backup camera list only own domain: " + opts.filter((id) => id && nodeDomainId(find(id)?.n) !== dom).length + " foreign of " + opts.length);
  drvEditCancel(c.uid, "Резервное отображение");
  }
});
