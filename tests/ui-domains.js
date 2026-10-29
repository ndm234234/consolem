/* Сценарии интерфейса: домены, серверы, папки — создать, переименовать, добавить в домен и исключить,
   групповое исключение с «Отменить», опрос адресов, удаление с вводом числа и отсчётом. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  goApp("hw");
  // Домен: создать, переименовать в дереве, занятое имя
  const before=domains.length;
  addDomain();
  ok(await until(()=>domains.length===before+1&&treeRenameId===domains[domains.length-1].id),"домен создан на сервере, строка открыта на переименование");
  const nd=domains[domains.length-1];
  commitTreeRename(nd.id,"Филиал Юг");
  ok(await until(()=>nd.name==="Филиал Юг"&&treeRenameId===null),"переименован");
  ok((await API.get("/domains/"+nd.id)).name==="Филиал Юг","на сервере — новое имя");
  treeRenameId=nd.id;treeRenameField="name";commitTreeRename(nd.id,domains[0].name);
  ok(treeRenameId===nd.id&&nd.name==="Филиал Юг","занятое имя — отказ, поле открыто");
  treeRenameId=null;
  // Сервер: исключить и вернуть
  const d1=domains[0],s=d1.servers.find(x=>x.online!==false);
  excludeFromDomain(s.id);
  ok(await until(()=>d1.unallocServers.includes(s)&&!d1.servers.includes(s)),"исключён: в «Нераспределённых»");
  ok((await API.get("/servers/"+s.id)).allocated===false,"на сервере — нераспределённый");
  addToDomain(s.id,d1.id);
  ok(await until(()=>d1.servers[d1.servers.length-1]===s),"добавлен обратно — в конец списка");
  ok(unallocDisplayCache[d1.id]?.find(r=>r.id===s.id)?.added,"строка «Нераспределённых» помечена «Добавлен»");
  // Групповое исключение и «Отменить»: серверы — на прежних местах
  const two=d1.servers.slice(0,2),pos=two.map(x=>d1.servers.indexOf(x));
  treeSel.clear();two.forEach(x=>treeSel.add(x.id));
  bulkExcludeServers();
  ok(await until(()=>two.every(x=>d1.unallocServers.includes(x))),"групповое исключение: 2 сервера");
  const undo=document.querySelector("#ttu-bkexcl .ttu-act");ok(!!undo,"«Отменить» в тосте");undo&&undo.click();
  ok(await until(()=>two.every((x,i)=>d1.servers.indexOf(x)===pos[i])),"«Отменить»: на прежних местах "+pos);
  ok((await API.get("/servers/"+two[0].id)).allocated===true,"на сервере вернулись");
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
    addProbedServers();
    ok(await until(()=>servers.length===n0+1&&wizd.ipRows[0].added),"найденный адрес заведён и добавлен в домен");
    const ns=servers[servers.length-1];
    ok(d1.servers.includes(ns)&&(await API.get("/servers/"+ns.id)).allocated,"на сервере: в домене");
  }else ok(true,"адрес не отвечает — добавлять нечего");
  // Папка: создать, очистить, удалить с вводом числа и отсчётом
  const root=folders.find(f=>f.domain===d1.id);
  addSubfolder(root.id);
  ok(await until(()=>root.folders.some(f=>f.name==="Новая папка"&&treeRenameId===f.id)),"папка создана на сервере");
  const nf=root.folders.find(f=>f.name==="Новая папка");
  commitTreeRename(nf.id,"Склад-3");
  ok(await until(()=>nf.name==="Склад-3"),"папка переименована");
  const full=flatFolders().find(f=>f.items.length>1&&folderDomain(f.id)===d1.id);
  clearFolder(full.id);await confirmWith(null);
  ok(await until(()=>full.items.length===0),"папка очищена");
  ok((await API.get("/folders/"+full.id)).deviceIds.length===0,"на сервере — пусто");
  deleteFolder(nf.id);
  ok(document.getElementById("confirmOk").disabled,"«Удалить» неактивна, пока не введено число");
  await confirmWith(1);
  ok(pendingDelHas(nf.id),"отсчёт с «Отменить»");
  ok((await API.raw("GET","/folders/"+nf.id)).status===200,"во время отсчёта на сервере ещё есть");
  ok(await until(()=>!folderById(nf.id)),"по истечении — удалена");
  ok((await API.raw("GET","/folders/"+nf.id)).status===404,"на сервере — нет");
  // Удалить домен с переносом
  const d2=domains[1],moved=d2.servers.length+d2.unallocServers.length;
  deleteDomain(d2.id);
  const sel2=document.getElementById("domMoveTo");if(sel2)sel2.value=d1.id;
  await confirmWith(1);
  ok(await until(()=>!domainById(d2.id),30000),"домен удалён после отсчёта");
  ok((await API.raw("GET","/domains/"+d2.id)).status===404,"на сервере — нет");
  const srvs=(await API.get("/servers")).items.filter(x=>x.domainId===d1.id&&!x.allocated).length;
  ok(domainById(d1.id).unallocServers.length===srvs&&srvs>=moved,"серверы перенесены нераспределёнными: "+srvs);
});
