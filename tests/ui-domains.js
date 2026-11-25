/* Сценарии интерфейса: домены, серверы, папки — создать, переименовать, добавить в домен и исключить,
   групповое исключение с «Отменить», опрос адресов, удаление с вводом числа и отсчётом. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  goApp("hw");
  // Блок «Общие» домена VMS: заголовок — подпись вида области («Домен»; у оркестратора — «Рабочее пространство», ui-bez-vms.js).
  // Свойства license у домена нет (снято в 0.32.0): ключ и его серийный номер — на вкладке «Лицензии», поля номера нет
  pick(domains[0].id);goTab("gen");
  ok(await until(()=>[...document.querySelectorAll("#main .card .ch")].some(h=>h.textContent.trim().startsWith("Домен"))),"блок области на demo — «Домен»: "+[...document.querySelectorAll("#main .card .ch")].map(h=>h.textContent.trim()).join(" | "));
  ok(!/Серийный номер лицензии/.test(document.getElementById("main").textContent),"в «Общих» домена нет поля номера лицензии");
  if(tabsFor(find(domains[0].id).n).some(([id])=>id==="lic")){
    goTab("lic");
    ok(await until(()=>/Лиценз/.test(document.getElementById("main").textContent))&&!/Серийный номер лицензии/.test(document.getElementById("main").textContent),"на вкладке «Лицензии» нет поля номера: ключ — в карточке ключа");
  }
  // Домен: создать, переименовать в дереве, занятое имя
  const before=domains.length;
  addDomain();
  ok(await until(()=>domains.length===before+1&&treeRenameId===domains[domains.length-1].id),"домен создан на сервере, строка открыта на переименование");
  const nd=domains[domains.length-1];
  // Перерисовка дерева во время ввода: поле открыто, набранное на месте (Chrome шлёт blur заменяемому полю)
  ok(await until(()=>document.querySelector("#tree .nm-inp")),"поле переименования в дереве");
  const ri=document.querySelector("#tree .nm-inp");
  ri.focus();ri.value="Фил";ri.dispatchEvent(new Event("input",{bubbles:true}));
  renderTree();
  ok(await until(()=>document.querySelector("#tree .nm-inp")?.value==="Фил")&&treeRenameId===nd.id,"перерисовка не закрыла поле и не стёрла набранное");
  commitTreeRename(nd.id,"Филиал Юг");
  ok(await until(()=>nd.name==="Филиал Юг"&&treeRenameId===null),"переименован");
  ok((await uiRec(nd.id)).name==="Филиал Юг","на сервере — новое имя");
  treeRenameId=nd.id;treeRenameField="name";commitTreeRename(nd.id,domains[0].name);
  ok(treeRenameId===nd.id&&nd.name==="Филиал Юг","занятое имя — отказ, поле открыто");
  // Предел длины — из вида (UnitKind.nameSchema.maxLength 100, контракт 0.38.0): 101 знак — отказ до запроса, 100 — можно
  ok(domainNameRule().maxLength===100,"предел имени домена пришёл с видом: "+domainNameRule().maxLength);
  ok(/100/.test(domainNameError("Д".repeat(101),nd.id))&&!domainNameError("Д".repeat(100),nd.id),"101 знак — отказ с пределом, 100 — можно");
  window.CONSOLEM_TRACE=[];
  commitTreeRename(nd.id,"Д".repeat(101));
  ok(treeRenameId===nd.id&&nd.name==="Филиал Юг"&&!CONSOLEM_TRACE.some(t=>t.method==="PATCH"&&t.path===`/units/${nd.id}`),"длинное имя — отказ без запроса, поле открыто");
  delete window.CONSOLEM_TRACE;
  treeRenameId=null;
  // Карточка: поле «Имя» с 101 знаком — план не открывается, «Применить» ничего не шлёт (у предела нет отказа сервера)
  pick(nd.id);goTab("gen");
  ok(await until(()=>[...document.querySelectorAll("#main .card input")].some(i=>i.value===nd.name)),"поле имени в карточке домена");
  const ci=[...document.querySelectorAll("#main .card input")].find(i=>i.value===nd.name);
  ci.value="Д".repeat(101);ci.dispatchEvent(new Event("input",{bubbles:true}));
  ok(/100/.test(ci.parentElement.querySelector(".fld-err")?.textContent||""),"под полем — предел из вида");
  window.CONSOLEM_TRACE=[];
  cardPlan();cardApply();
  await until(()=>false,500);
  ok(!/Станет/.test(document.getElementById("bmodal")?.textContent||"")&&!CONSOLEM_TRACE.some(t=>t.method==="POST"&&t.path==="/operations"),"длинное имя в карточке: плана нет, операции нет");
  delete window.CONSOLEM_TRACE;
  cardReset();
  // Сервер: исключить и вернуть
  // Не сервер сессии (Me.serverId, пробел F85): его исключение закрывает сессию
  const meSrv=typeof ME_SERVER!=="undefined"?ME_SERVER:null;
  const d1=domains[0],s=d1.servers.find(x=>x.online!==false&&x.id!==meSrv);
  excludeFromDomain(s.id);
  if(document.getElementById("confirm").classList.contains("open"))await confirmWith(1);   // прототип с подтверждением числом
  ok(await until(()=>d1.unallocServers.includes(s)&&!d1.servers.includes(s)),"исключён: в «Нераспределённых»");
  ok((await uiRec(s.id)).allocated===false,"на сервере — нераспределённый");
  // Приём — операцией (шаг move): поток может переставить сервер раньше, чем придёт её итог, поэтому ждётся итог
  const added=await addToDomain(s.id,d1.id);
  ok(added&&await until(()=>d1.servers[d1.servers.length-1]===s),"добавлен обратно — в конец списка");
  ok(unallocDisplayCache[d1.id]?.find(r=>r.id===s.id)?.added,"строка «Нераспределённых» помечена «Добавлен»");
  // Групповое исключение и «Отменить»: серверы — на прежних местах
  const two=d1.servers.filter(x=>x.id!==meSrv).slice(0,2),pos=two.map(x=>d1.servers.indexOf(x));
  treeSel.clear();two.forEach(x=>treeSel.add(x.id));
  window.CONSOLEM_TRACE=[];
  bulkExcludeServers();
  if(document.getElementById("confirm").classList.contains("open"))await confirmWith(2);   // прототип с подтверждением числом
  ok(await until(()=>two.every(x=>d1.unallocServers.includes(x))),"групповое исключение: 2 сервера");
  // Как база одним POST /servers/assign: одна операция с шагами move, не перенос на каждый сервер
  const exclTrace=CONSOLEM_TRACE.filter(t=>t.method==="POST"&&(t.path==="/operations"||/\/move$/.test(t.path)));
  ok(exclTrace.length===1&&exclTrace[0].path==="/operations","групповое исключение — одна операция POST /operations: "+exclTrace.map(t=>t.path).join(" "));
  delete window.CONSOLEM_TRACE;
  ok(await until(()=>!!document.querySelector("#ttu-bkexcl .ttu-act")),"«Отменить» в тосте");
  const undo=document.querySelector("#ttu-bkexcl .ttu-act");undo&&undo.click();
  ok(await until(()=>two.every((x,i)=>d1.servers.indexOf(x)===pos[i])),"«Отменить»: на прежних местах "+pos);
  ok((await uiRec(two[0].id)).allocated===true,"на сервере вернулись");
  // Отказ — по строке, как у /servers/assign базы: сервер, которого нет, и сервер с устаревшей версией не роняют остальных
  const [sa,sb]=d1.servers.filter(x=>x.online!==false).slice(-2);
  const ghost={id:"2fffffff-0000-4000-8000-000000000000",name:"Призрак"};
  const r1=await serversAssign([{s:sa,domainId:d1.id,allocated:false},{s:ghost,domainId:d1.id,allocated:false}]);
  r1.done.forEach(hwApplyServer);
  ok(r1.done.length===1&&r1.done[0].id===sa.id&&r1.failed.length===1&&r1.failed[0].serverId===ghost.id&&(await uiRec(sa.id)).allocated===false,
    "сервера нет — отказ его строки, второй исключён: "+JSON.stringify(r1.failed));
  const realVer=hwVer.get(sa.id);hwVer.set(sa.id,"stale-ui-domains");
  const r2=await serversAssign([{s:sa,domainId:d1.id,allocated:true},{s:sb,domainId:d1.id,allocated:false}]);
  r2.done.forEach(hwApplyServer);
  ok(r2.done.length===1&&r2.done[0].id===sb.id&&r2.failed.length===1&&r2.failed[0].serverId===sa.id&&r2.failed[0].code==="VERSION_MISMATCH"&&(await uiRec(sb.id)).allocated===false,
    "устаревшая версия — отказ её строки, второй исключён: "+JSON.stringify(r2.failed.map(x=>x.code)));
  hwVer.set(sa.id,realVer);
  const r3=await serversAssign([{s:sa,domainId:d1.id,allocated:true},{s:sb,domainId:d1.id,allocated:true}]);
  r3.done.forEach(placeInDomain);
  ok(r3.done.length===2&&(await uiRec(sa.id)).allocated&&(await uiRec(sb.id)).allocated,"оба вернулись");
  // Карточка сервера: имя через план и операцию
  pick(s.id);goTab("gen");
  const inp=document.querySelector('input[data-df="Имя"]');inp.value="Сервер — проверка";inp.dispatchEvent(new Event("input"));
  cardApply();
  ok(bq&&bq.api,"карточка сервера — операцией на сервере");
  ok(await until(()=>bq.finished&&s.name==="Сервер — проверка"),"имя сервера изменено: "+s.name);
  // Опрос адресов и добавление найденного
  wizd.ipText="10.77.0.5:20111\n"+s.ip+":20111";wizd.domain=d1.id;wizd.ipPick=new Set();
  runIpProbe();
  ok(await until(()=>wizd.ipPhase==="done"&&wizd.ipRows?.length===2),"опрос: "+(wizd.ipRows||[]).map(r=>r.status).join(", "));
  ok(wizd.ipRows[1].status==="in-domain","известный сервер — «уже в домене»");
  if(wizd.ipRows[0].status==="found"){
    const n0=servers.length;
    // Добавляют из открытого окна: из закрытого прототип 13 в домен не ставит
    document.getElementById("wiz").classList.add("open");
    addProbedServers();
    ok(await until(()=>servers.length===n0+1&&wizd.ipRows[0].added),"найденный адрес заведён и добавлен в домен");
    document.getElementById("wiz").classList.remove("open");
    const ns=servers[servers.length-1];
    ok(d1.servers.includes(ns)&&(await uiRec(ns.id)).allocated,"на сервере: в домене");
  }else ok(true,"адрес не отвечает — добавлять нечего");
  // Папка: создать, очистить, удалить с вводом числа и отсчётом
  const root=folders.find(f=>f.domain===d1.id);
  addSubfolder(root.id);
  ok(await until(()=>root.folders.some(f=>f.name==="Новая папка"&&treeRenameId===f.id)),"папка создана на сервере");
  const nf=root.folders.find(f=>f.name==="Новая папка");
  commitTreeRename(nf.id,"Склад-3");
  ok(await until(()=>nf.name==="Склад-3"),"папка переименована");
  const full=flatFolders().find(f=>f.items.length>1&&folderDomain(f.id)===d1.id);
  window.CONSOLEM_TRACE=[];
  const fullN=full.items.length;clearFolder(full.id);await confirmWith(fullN);
  ok(await until(()=>full.items.length===0),"папка очищена");
  // Как база одним POST /folders/{id}/devices: шаги folders одной операцией, не PATCH на каждый объект
  ok(CONSOLEM_TRACE.filter(t=>t.method==="POST"&&t.path==="/operations").length===1&&!CONSOLEM_TRACE.some(t=>t.method==="PATCH"),"очистка папки — одна операция POST /operations, без PATCH по объектам");
  delete window.CONSOLEM_TRACE;
  ok((await uiFolderIds(full.id)).length===0,"на сервере — пусто");
  addSubfolder(nf.id);
  ok(await until(()=>(nf.folders||[]).length===1),"в ней подпапка");
  treeRenameId=null;
  const sub=nf.folders[0];
  // Удаление папки не перечитывает всё: черновик «Прав» и прочее введённое остаются
  let reloads=0;const reload0=window.apiReload;window.apiReload=()=>{reloads++;reload0()};
  const ed0=ACC.ed;
  deleteFolder(nf.id);
  ok(document.getElementById("confirmOk").disabled,"«Удалить» неактивна, пока не введено число");
  await confirmWith(1);
  ok(pendingDelHas(nf.id),"отсчёт с «Отменить»");
  ok((await API.raw("GET", "/units/" + nf.id)).status===200,"во время отсчёта на сервере ещё есть");
  ok(await until(()=>!folderById(nf.id)),"по истечении — удалена");
  ok((await API.raw("GET", "/units/" + nf.id)).status===404,"на сервере — нет");
  await new Promise(r=>setTimeout(r,400));
  window.apiReload=reload0;
  ok(reloads===0&&ACC.ed===ed0,"без полного перечитывания: черновик «Прав» тот же (перечитываний "+reloads+")");
  ok(!hwVer.has(nf.id)&&!hwVer.has(sub.id)&&!folderById(sub.id),"папка и подпапка ушли из кэша");
  // «Камера-коробка» и обычный сервер одним приёмом: в итоге оба, как база (шаг называет созданную камеру, createdId) —
  // тост «Добавлено серверов: 2», коробка — камерой. Принятый сервер — последним и после перечитывания
  const ttx=()=>document.getElementById("tt")?.textContent||"";
  const box=d1.unallocServers.find(x=>x.cls==="camera"),plain=d1.unallocServers.find(x=>x.cls!=="camera"&&x.online!==false);
  addUnallocServers([box.id,plain.id],d1.id);
  // Отпечаток коробки сверяется до приёма (как база)
  ok(await until(()=>document.getElementById("confirm")?.classList.contains("open")),"отпечатки — до приёма");
  await confirmWith(null);
  ok(await until(()=>/Добавлено серверов: 2/.test(ttx())),"коробка и сервер одним приёмом: «"+ttx()+"»");
  ok(await until(()=>devicePool.some(n=>n.type==="camera"&&n.name===box.name)),"коробка принята камерой");
  ok(await until(()=>domainById(d1.id).servers.at(-1)?.id===plain.id),"принятый сервер — последним");
  apiReload();
  await new Promise(r=>setTimeout(r,1500));
  ok(await until(()=>domainById(d1.id).servers.at(-1)?.id===plain.id),"после перечитывания принятый сервер — по-прежнему последним: "+domainById(d1.id).servers.at(-1)?.name);
  // Удалить домен с переносом
  const d2=domains[1],moved=d2.servers.length+d2.unallocServers.length;
  deleteDomain(d2.id);
  const sel2=document.getElementById("domMoveTo");if(sel2)sel2.value=d1.id;
  await confirmWith(1);
  ok(await until(()=>!domainById(d2.id),30000),"домен удалён после отсчёта");
  ok((await API.raw("GET", "/units/" + d2.id)).status===404,"на сервере — нет");
  const srvs=(await uiRecs({kind:"server",domainId:d1.id})).filter(x=>!x.allocated).length;
  ok(domainById(d1.id).unallocServers.length===srvs&&srvs>=moved,"серверы перенесены нераспределёнными: "+srvs);
});
