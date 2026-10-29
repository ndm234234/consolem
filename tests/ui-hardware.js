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
  closeBulkModal();
  // Поля карточки по подписи (SMTP, канал, титры, детектор в карточке камеры) — тоже операцией на сервере
  const first=t=>{let x=null;walkAll(n=>{if(!x&&n.type===t&&isApiDevice(n)&&!hasNoSignal(srv(n.id)||{}))x=n});return x};
  const setFld=(l,v)=>{const el=document.querySelector(`[data-df="${l}"]`);el.value=v;el.dispatchEvent(new Event(el.tagName==="SELECT"?"change":"input"))};
  const viaApi=async(what,check)=>{
    cardApply();
    ok(!!(bq&&bq.api),what+" — операцией на сервере");
    ok(await until(()=>bq.finished)&&bq.fail===0,what+": операция без отказов");
    ok(await check(),what+": на сервере");
  };
  const em=first("email");
  pick(em.id,{force:true});goTab("gen");setFld("SMTP сервер","smtp.test.local");setFld("Режим","SMTP сервер");
  await viaApi("email: SMTP и режим",async()=>{const r=await API.get("/devices/"+em.id);return r.smtp==="smtp.test.local"&&r.mode==="smtp"});
  const ev=first("eventsrc");
  pick(ev.id,{force:true});goTab("overlay");setFld("Задержка, мс","250");setFld("Длительность, с","7");
  await viaApi("титры: задержка и длительность",async()=>{const r=await API.get("/devices/"+ev.id);return r.overlayDelayMs===250&&r.overlayDurationSec===7});
  ok(document.querySelector('[data-df="Задержка, мс"]')?.value==="250","карточка показывает значение сервера");
  const kid=first("relay")||first("sensor");
  pick(kid.id,{force:true});goTab("gen");setFld("Канал","5");
  await viaApi("канал начинки",async()=>(await API.get("/devices/"+kid.id)).channel===5);
  // Детектор: в карточке камеры — у выбранного детектора; новый остаётся выбранным после «Применить»
  pick(cam.id,{force:true});goTab("det");
  const d0=camDetectors(cam)[0];detSel=d0.id;gear();
  setFld("Чувствительность","33");
  await viaApi("чувствительность детектора из карточки камеры",async()=>(await API.get("/devices/"+d0.id)).sensitivity===33);
  addDetector(cam.id);
  const tmp=detSel;
  cardApply();
  ok(await until(()=>bq.finished&&detSel!==tmp&&hwVer.has(detSel)),"новый детектор после «Применить» — выбран, с id сервера");
  ok([...document.querySelectorAll('input[data-df="Имя"]')].some(x=>x.value===i18n("Новый детектор"))&&locName(find(detSel).n)===i18n("Новый детектор"),"в карточке — параметры нового детектора");
  // Неприменённый детектор удаляется из черновика, без запроса
  addDetector(cam.id);
  const draftDet=detSel;
  deleteDetector(cam.id,draftDet);
  await confirmWith(1);
  ok(await until(()=>!camDetectors(cam).some(d=>d.id===draftDet),20000),"неприменённый детектор удалён");
  ok(cardDiff().length===0,"черновик пуст");
  // Черновик карточки переживает перечитывание всего кэша (удаление другого объекта, потеря потока)
  setCamRec(cam.id,cam.rec==="motion"?"always":"motion");
  const want=cam.rec;
  apiOnEvent({type:"stream.reset"});
  ok(await until(()=>find(cam.id)?.n!==cam),"кэш перечитан");
  const cam3=find(cam.id).n;
  ok(cardDiff().length===1&&cam3.rec===want,"черновик на месте: "+cardDiff().map(r=>r.label).join(", "));
  cardReset();
});
