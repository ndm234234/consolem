/* Сценарии интерфейса: «Оборудование» — карточка устройства через операцию на сервере, «Отменить»,
   переименование в дереве, отказ сервера без связи. Запуск — tools/check_ui.py. */
UiCheck(async ({ ok, until, confirmWith }) => {
  const cam=devicePool.find(n=>n.type==="camera"&&n.name==="Главный вход");
  ok(!!cam&&/^3/.test(cam.id),"камера из API, id — UUID: "+cam?.id);
  goApp("hw");pick(cam.id);goTab("gen");
  const inp=document.querySelector('input[data-df="Имя"]');
  inp.value="Вход — пилот";inp.dispatchEvent(new Event("input"));
  setCamRec(cam.id,"motion");
  const d=cardDiff();ok(d.length===2,"черновик: 2 изменения — "+d.map(r=>r.label).join(", "));
  const v0=hwVer.get(cam.id);
  cardApply();
  ok(bq&&bq.api,"очередь на сервере: "+(bq&&bq.api));
  ok(cam.name==="Главный вход","кэш не меняется до ответа сервера");
  ok(await until(()=>bq&&bq.finished),"операция завершилась: ok "+bq?.ok+", не ок "+bq?.fail);
  ok(await until(()=>cam.name==="Вход — пилот"&&cam.rec==="motion"),"кэш обновлён из потока: "+cam.name+", "+cam.rec);
  const srvRec=await API.get("/devices/"+cam.id);
  ok(srvRec.name==="Вход — пилот"&&srvRec.recordMode==="motion"&&srvRec.version!==v0,"на сервере: "+srvRec.name+", "+srvRec.recordMode+", версия "+srvRec.version);
  ok(document.querySelector(".tree, #tree, aside")?.textContent.includes("Вход — пилот"),"дерево показывает новое имя");
  const undo=document.querySelector("#ttu-undo .ttu-act");
  ok(!!undo,"в тосте есть «Отменить»");
  undo&&undo.click();
  ok(await until(()=>cam.name==="Главный вход"&&cam.rec==="always"),"«Отменить» вернуло на сервере и в кэше: "+cam.name+", "+cam.rec);
  ok((await API.get("/devices/"+cam.id)).name==="Главный вход","на сервере вернулось");
  // Переименование в дереве
  treeRenameId=cam.id;treeRenameField="name";
  commitTreeRename(cam.id,"Главный вход 2");
  ok(cam.name==="Главный вход","до ответа имя прежнее, поле открыто: "+treeRenameId);
  ok(await until(()=>cam.name==="Главный вход 2"&&treeRenameId===null),"переименовано через PATCH");
  treeRenameId=cam.id;commitTreeRename(cam.id,"  ");
  ok(treeRenameId===cam.id,"пустое имя — поле остаётся");
  treeRenameId=null;
  // Сервер без связи: шаг не применён, отчёт
  const off=servers.find(s=>s.online===false&&!isUnallocated(s.id));
  const cam2=devicePool.find(n=>n.type==="camera"&&n.srvId===off.id);
  pick(cam2.id);goTab("gen");
  const inp2=document.querySelector('input[data-df="Имя"]');inp2.value="Не примется";inp2.dispatchEvent(new Event("input"));
  cardApply();
  ok(await until(()=>bq&&bq.finished),"операция над камерой сервера без связи завершилась");
  const op=bq.steps[0].ops[0];
  ok(op.state==="fail"&&/не отвечает/.test(op.msg),"шаг — fail: "+op.msg);
  ok(document.getElementById("bmodal")?.classList.contains("open"),"открыт отчёт");
  ok(cam2.name!=="Не примется","имя не изменилось");
});
