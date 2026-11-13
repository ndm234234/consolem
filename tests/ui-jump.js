/* Сценарий интерфейса: поиск и путь приводят к объекту: цель — видимая строка дерева, прокрученная к ней,
   при любом срезе. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until }) => {
  const serverOfDet = (d) => cameraTreeServer(d.parentId)?.id;
  const devices = (await uiDevices()).filter((d) => find(d.id));
  const shown = (id, on) => {
    const box = document.getElementById("tree").getBoundingClientRect();
    return [...document.querySelectorAll(`#tree .n${on ? ".on" : ""}[data-pick="${id}"]`)].some((el) => {
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null && r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    });
  };
  // «Папки» меняются только от нажатия: в раскладке по папкам у не встроенного детектора своей строки нет,
  // подсвечена строка его камеры (в срезе «Детекторы» — и у встроенного). Во всех остальных случаях цель — строка самого объекта
  const shownDev = (d) => d.type === "det" && (!d.builtin || slice === "det") && group() === "folder" ? shown(d.parentId, true) : shown(d.id);
  const note = (bad, key, name) => (bad[key] = bad[key] || []).push(name);
  const report = (bad) => Object.entries(bad).map(([k, v]) => `${k}=${v.length} [${v.slice(0, 2).join(", ")}]`).join(" | ").slice(0, 1200);
  // Каждое устройство: поиск, затем его родитель и каждый шаг пути
  const noJump = {}, noParent = {}, noCrumb = {};
  const crumbs = new Set(), parents = new Set();
  for (const d of devices) {
    goApp("hw");
    jumpToNode(find(d.id).n);
    // Ветка могла ещё читаться: строка появляется после неё
    await until(() => shownDev(d), 300);
    if (!shownDev(d)) note(noJump, `${d.type}/${slice}/${group()}`, d.name);
    document.querySelectorAll(".cr-it[data-id]:not(.cr-last)").forEach((el) => crumbs.add(el.dataset.id));
    // Родитель: один раз на родителя, сразу после перехода к его ребёнку
    if (d.parentId && !parents.has(d.parentId)) {
      parents.add(d.parentId);
      pick(d.parentId, { force: true });
      await until(() => shown(d.parentId), 300);
      if (sel !== d.parentId || !shown(d.parentId)) note(noParent, `${d.type}/${slice}`, d.name);
    }
  }
  ok(!Object.keys(noJump).length, `поиск: все ${devices.length} устройств — видимая строка` + (Object.keys(noJump).length ? ": " + report(noJump) : ""));
  ok(!Object.keys(noParent).length, "родитель в пути: видимая строка" + (Object.keys(noParent).length ? ": " + report(noParent) : ""));
  for (const id of crumbs) {
    if (!find(id)) continue;
    goApp("hw");
    pick(id, { force: true });
    await until(() => shown(id), 300);
    if (!shown(id)) note(noCrumb, `${find(id).n.type}/${slice}`, id);
  }
  ok(crumbs.size > 0 && !Object.keys(noCrumb).length, `шаги пути: ${crumbs.size}` + (Object.keys(noCrumb).length ? ": " + report(noCrumb) : ""));
  // При любом срезе: по одному устройству каждого вида
  const kinds = [...new Map(devices.map((d) => [d.type + (d.builtin ? ":b" : "") + (d.parentId ? ":c" : ""), d])).values()];
  for (const s of Object.keys(SLICE_GROUPS)) {
    const bad = {};
    for (const d of kinds) {
      slice = s;
      syncViews();
      goApp("hw");
      jumpToNode(find(d.id).n);
      // Под нагрузкой (самопроверка гонит сценарии параллельно) ветка читается дольше одного тика
      await until(() => shownDev(d), 2000);
      if (!shownDev(d)) note(bad, `${d.type}/${slice}/${group()}`, d.name);
    }
    ok(!Object.keys(bad).length, `срез ${s}: поиск ведёт к строке` + (Object.keys(bad).length ? ": " + report(bad) : ""));
  }
  // Длинная ветка: цель внизу дерева прокручена в окно
  const last = devices[devices.length - 1];
  document.getElementById("tree").scrollTop = 0;
  jumpToNode(find(last.id).n);
  await until(() => shown(last.id), 2000);
  ok(shown(last.id), "цель внизу дерева прокручена к ней");
  // Без сервера — прямо под доменом, после серверов, со своими детьми; с сервером — под ним, раскладка не меняется
  const atServers = () => { slice = "all"; groupBy.all = "server"; syncViews(); };
  const loose = devices.find((d) => d.type === "ipsrv" && !d.serverId);
  const did = deviceDomain(loose.id);
  atServers();
  jumpToNode(find(loose.id).n);
  await until(() => shown(loose.id), 2000);
  const rowsAll = [...document.querySelectorAll("#tree .n[data-pick]")];
  const looseRow = rowsAll.find((el) => el.dataset.pick === loose.id);
  ok(shown(loose.id) && slice === "all" && group() === "server", "устройство без сервера видно в раскладке по серверам");
  ok(looseRow?.style.getPropertyValue("--l") === "1", "прямо под доменом");
  ok(!/Без сервера/.test(document.getElementById("tree").textContent), "группы «Без сервера» нет");
  const lastSrv = Math.max(...domains.find((x) => x.id === did).servers.map((s) => rowsAll.findIndex((el) => el.dataset.pick === s.id)));
  ok(rowsAll.indexOf(looseRow) > lastSrv, "после серверов домена");
  const kid = devices.find((d) => d.parentId === loose.id);
  atServers();
  jumpToNode(find(kid.id).n);
  await until(() => shown(kid.id), 2000);
  ok(shown(kid.id) && slice === "all" && group() === "server", "ребёнок раскрыт под ним");
  const moxa = devices.find((d) => d.type === "ipsrv" && d.serverId && !devices.some((x) => x.parentId === d.id && x.type === "camera"));
  const pos = devices.find((d) => d.type === "eventsrc");
  for (const d of [moxa, pos]) {
    atServers();
    jumpToNode(find(d.id).n);
    await until(() => shown(d.id), 2000);
    ok(shown(d.id) && slice === "all" && group() === "server", d.name + " стоит под своим сервером");
  }
  const det = devices.find((d) => d.type === "det" && d.builtin);
  slice = "cam"; groupBy.cam = "server"; syncViews();
  jumpToNode(find(det.id).n);
  await until(() => shown(det.id), 2000);
  const row = document.querySelector(`#tree .n[data-pick="${det.id}"]`), parentRow = row?.previousElementSibling;
  ok(slice === "cam" && shown(det.id), "встроенный детектор виден в срезе «Камеры»");
  ok(!!parentRow && [...document.querySelectorAll(`#tree .n[data-pick="${det.parentId}"]`)].length > 0, "под своей камерой");
  ok(!gpuCameras(serverOfDet(det)).some((x) => x.dets.some((y) => y.id === det.id)), "под GPU сервера его нет");
});
