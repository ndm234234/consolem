// ЗАГЛУШКА прототипов 47–50 (ui-draft «Журнал»): 200 000 событий создаёт браузер,
// отбор, счётчики и гистограмма — тоже в браузере. В контракте 0.6.0 этого нет:
// поиск по тексту, пользователь, вид события, счётчики по полям, гистограмма,
// «было → стало». После утверждения вида — правка контракта, отбор на сервере.
// Внешний мир — через ctx в PJ.init: объекты, пользователи и переходы консоли.
(function(){
"use strict";
const PJ={};
const MIN=6e4,HOUR=36e5,DAY=864e5;
function rng(seed){let s=(seed>>>0)||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296}}
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
PJ.esc=esc;
PJ.num=n=>Number(n).toLocaleString("ru-RU");
PJ.plural=(n,f)=>{const [a,b,c]=f.split("|"),m10=n%10,m100=n%100;return m10===1&&m100!==11?a:m10>=2&&m10<=4&&(m100<12||m100>14)?b:c};

// ── Категории и виды событий ──
const CATS=[
  {id:"alarm",n:"Тревога"},{id:"error",n:"Ошибка"},{id:"audit",n:"Аудит"},
  {id:"info",n:"Информация"},{id:"debug",n:"Служебное"}];
PJ.CATS=CATS;
const CI=Object.fromEntries(CATS.map((c,i)=>[c.id,i]));
const pick=(r,a)=>a[Math.floor(r()*a.length)];
const CAM_SET=[["Разрешение","1920×1080","2560×1440"],["Частота кадров","25 к/с","15 к/с"],["Битрейт","4 Мбит/с","2 Мбит/с"],
  ["Режим записи","Постоянно","По движению"],["Поток для записи","Основной","Второй"],["Звук","Выключен","Включён"],["Детектор движения","Выключен","Включён"]];
const RULE_SET=[["Расписание","Всегда","Рабочие часы"],["Состояние","Работает","Выключено"],["Действие","Запись","Запись и письмо охране"]];
const ROLE_SET=[["Экспорт видео","запрещено","разрешено"],["Управление PTZ","разрешено","запрещено"],["Просмотр архива","запрещено","разрешено"]];
const ROLES=["Операторы","Охрана","Администраторы","Подрядчики"];
const STO=["Хранилище — Офис","Хранилище — Склад","Хранилище — Парковка"];
const PRESETS=["Ворота","Касса","Вход","Парковка"];
const hm=t=>{const d=new Date(t);return`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`};
// v — значения события из его зерна: текст и подробности берут одни и те же
const KINDS=[
  {id:"det.start",cat:"debug",n:"Детектор: начало",on:"cam",w:14,text:v=>`Детектор движения камеры «${v.o}» начал срабатывание`},
  {id:"det.end",cat:"debug",n:"Детектор: конец",on:"cam",w:14,text:v=>`Детектор движения камеры «${v.o}» закончил срабатывание`},
  {id:"rule.fire",cat:"debug",n:"Срабатывание правила",on:"rule",w:8,val:r=>({act:pick(r,["Запись","Тревога","Письмо охране"])}),text:v=>`Правило «${v.o}» запустило действие «${v.act}»`},
  {id:"rec.start",cat:"info",n:"Начало записи",on:"cam",w:10,val:r=>({sto:pick(r,STO)}),text:v=>`Камера «${v.o}» начала запись в «${v.sto}»`,more:v=>[["Хранилище",v.sto]]},
  {id:"rec.stop",cat:"info",n:"Конец записи",on:"cam",w:8,val:r=>({sto:pick(r,STO)}),text:v=>`Камера «${v.o}» закончила запись в «${v.sto}»`,more:v=>[["Хранилище",v.sto]]},
  {id:"cam.online",cat:"info",n:"Камера в сети",on:"cam",w:3,text:v=>`Сервер «${v.s}» восстановил связь с камерой «${v.o}»`},
  {id:"ntp",cat:"info",n:"Синхронизация времени",on:"srv",w:2,val:r=>({ms:3+Math.floor(r()*40)}),text:v=>`Сервер «${v.o}» сверил время с NTP, сдвиг ${v.ms} мс`},
  {id:"srv.start",cat:"info",n:"Запуск сервера",on:"srv",w:.1,text:v=>`Сервер «${v.o}» запустил службы`},
  {id:"al.motion",cat:"alarm",n:"Тревога: движение",on:"cam",w:6,video:1,text:v=>`Детектор движения камеры «${v.o}» поднял тревогу`,more:()=>[["Детектор","Детектор движения"]]},
  {id:"al.line",cat:"alarm",n:"Тревога: пересечение линии",on:"cam",w:3,video:1,val:r=>({dir:pick(r,["внутрь","наружу"])}),text:v=>`Объект пересёк линию на камере «${v.o}», направление ${v.dir}`,more:v=>[["Детектор","Пересечение линии"],["Направление",v.dir]]},
  {id:"al.tamper",cat:"alarm",n:"Тревога: вскрытие корпуса",on:"cam",w:.5,video:1,text:v=>`Камера «${v.o}» сообщила о вскрытии корпуса`},
  {id:"al.ack",cat:"alarm",n:"Оценка тревоги",on:"cam",who:1,w:3,video:1,val:r=>({verdict:pick(r,["подтверждённая","ложная","ложная","подозрительная"])}),text:v=>`Оценка тревоги камеры «${v.o}»: ${v.verdict}`,more:v=>[["Оценка",v.verdict]]},
  {id:"cam.offline",cat:"error",n:"Камера не в сети",on:"cam",w:2,text:v=>`Сервер «${v.s}» потерял связь с камерой «${v.o}»`},
  {id:"rec.lost",cat:"error",n:"Потеря записи",on:"cam",w:.8,val:r=>({min:2+Math.floor(r()*30),sto:pick(r,STO)}),text:v=>`Камера «${v.o}» не записала ${v.min} мин: хранилище «${v.sto}» не отвечало`,more:v=>[["Потеряно",`${v.min} мин`],["Хранилище",v.sto]]},
  {id:"disk.full",cat:"error",n:"Хранилище заполнено",on:"srv",w:.4,val:r=>({pct:95+Math.floor(r()*5),sto:pick(r,STO)}),text:v=>`Хранилище «${v.sto}» сервера «${v.o}» заполнено на ${v.pct}%`},
  {id:"cam.auth",cat:"error",n:"Ошибка входа камеры",on:"cam",w:.6,text:v=>`Камера «${v.o}» отклонила имя и пароль сервера «${v.s}»`},
  {id:"login",cat:"audit",n:"Вход",on:"none",who:1,w:3,text:v=>`Вход ${v.u} с адреса ${v.ip}`},
  {id:"logout",cat:"audit",n:"Выход",on:"none",who:1,w:2.6,text:v=>`Выход ${v.u}`},
  {id:"login.fail",cat:"audit",n:"Неудачный вход",on:"none",who:1,w:.5,text:v=>`Неверный пароль для ${v.u}, адрес ${v.ip}`},
  {id:"cam.set",cat:"audit",n:"Изменение камеры",on:"cam",who:1,w:1.2,val:r=>{const[p,a,b]=pick(r,CAM_SET);return r()<.5?{p,a,b}:{p,a:b,b:a}},text:v=>`Камера «${v.o}», ${v.p}: ${v.a} → ${v.b}`,diff:1},
  {id:"dev.add",cat:"audit",n:"Добавление устройства",on:"cam",who:1,w:.15,val:r=>({cip:`10.30.${Math.floor(r()*20)}.${10+Math.floor(r()*200)}`}),text:v=>`Сервер «${v.s}» подключил камеру «${v.o}», адрес ${v.cip}`},
  {id:"dev.del",cat:"audit",n:"Удаление устройства",on:"cam",who:1,w:.08,text:v=>`Камера «${v.o}» больше не подключена к серверу «${v.s}»`},
  {id:"rule.set",cat:"audit",n:"Изменение правила",on:"rule",who:1,w:.5,val:r=>{const[p,a,b]=pick(r,RULE_SET);return r()<.5?{p,a,b}:{p,a:b,b:a}},text:v=>`Правило «${v.o}», ${v.p}: ${v.a} → ${v.b}`,diff:1},
  {id:"role.set",cat:"audit",n:"Изменение роли",on:"none",who:1,w:.2,val:r=>{const[p,a,b]=pick(r,ROLE_SET);return{role:pick(r,ROLES),p,a,b}},text:v=>`Роль «${v.role}», право «${v.p}»: ${v.a} → ${v.b}`,diff:1,more:v=>[["Роль",v.role]]},
  {id:"arch.view",cat:"audit",n:"Просмотр архива",on:"cam",who:1,w:4,video:1,val:r=>({back:5+Math.floor(r()*600)}),text:v=>`Архив камеры «${v.o}» за ${hm(v.t-v.back*MIN)}–${hm(v.t-v.back*MIN+15*MIN)}`},
  {id:"live.view",cat:"audit",n:"Просмотр видео",on:"cam",who:1,w:5,video:1,text:v=>`Живое видео камеры «${v.o}»`},
  {id:"export",cat:"audit",n:"Экспорт видео",on:"cam",who:1,w:.5,video:1,val:r=>({back:30+Math.floor(r()*900),mb:20+Math.floor(r()*900)}),text:v=>`Камера «${v.o}», фрагмент ${hm(v.t-v.back*MIN)}–${hm(v.t-v.back*MIN+10*MIN)}, файл MP4 ${v.mb} МБ`},
  {id:"ptz",cat:"audit",n:"Управление PTZ",on:"cam",who:1,w:1,val:r=>({pr:pick(r,PRESETS)}),text:v=>`Камера «${v.o}» повернулась к предустановке «${v.pr}»`},
  {id:"jexport",cat:"audit",n:"Экспорт журнала",on:"none",who:1,w:.05,val:r=>({rows:100+Math.floor(r()*50000)}),text:v=>`Файл CSV, ${PJ.num(v.rows)} строк`}
];
KINDS.forEach((k,i)=>{k.i=i;k.ci=CI[k.cat]});
PJ.KINDS=KINDS;

// ── Хранилище: столбцы, новые события первыми ──
const S={n:0,now:0,T:null,K:null,O:null,U:null,X:null,TEXT:null,HAY:null,objs:[],users:[],ctx:null};
PJ.S=S;
PJ.ready=()=>S.n>0;
const FALLBACK_USERS=["root","admin","ivanov","petrova","operator1","operator2","integrator"];
PJ.init=function(ctx,n){
  if(S.n)return;
  const t0=performance.now();
  S.ctx=ctx;n=n||200000;
  const now=Math.ceil((ctx.now||Date.now())/MIN)*MIN;S.now=now;
  // Объекты консоли: ссылки из события ведут на настоящие карточки
  const objs=[];
  (ctx.cams||[]).forEach(c=>objs.push({id:c.id,name:c.name,type:"cam",srv:c.srv||""}));
  (ctx.srvs||[]).forEach(s=>objs.push({id:s.id,name:s.name,type:"srv",srv:s.name}));
  (ctx.rules||[]).forEach(r=>objs.push({id:r.id,name:r.name,type:"rule",srv:""}));
  if(!objs.some(o=>o.type==="cam"))for(let i=1;i<=24;i++)objs.push({id:"cam"+i,name:`Камера ${i}`,type:"cam",srv:"Сервер 1"});
  if(!objs.some(o=>o.type==="srv"))objs.push({id:"srv1",name:"Сервер 1",type:"srv",srv:"Сервер 1"});
  if(!objs.some(o=>o.type==="rule"))["Движение — запись","Тревога по линии"].forEach((n,i)=>objs.push({id:"rule"+i,name:n,type:"rule",srv:""}));
  objs.forEach((o,i)=>o.i=i);
  S.objs=objs;
  const ul=[...new Set([...(ctx.users||[]),...FALLBACK_USERS])].slice(0,40);
  S.users=ul.map((u,i)=>({login:u,i,ip:`10.20.${1+(i*7)%40}.${5+(i*37)%240}`}));
  const byType={cam:[],srv:[],rule:[]};objs.forEach(o=>byType[o.type].push(o));
  const r=rng(20261110);
  // Шумные камеры: каждая восьмая даёт впятеро больше событий
  const camW=byType.cam.map((c,i)=>i%8===3?5:1),camCum=cum(camW);
  const userW=S.users.map((u,i)=>i===0?6:i===1?4:i<5?2:1),userCum=cum(userW);
  const kindCum=cum(KINDS.map(k=>k.w));
  const T=new Float64Array(n),K=new Uint8Array(n),O=new Uint16Array(n),U=new Uint8Array(n),X=new Uint32Array(n);
  // Время: ночью событий меньше, днём больше; масштаб — 30 суток
  const gaps=new Float64Array(n);let sum=0,tt=now;
  for(let i=0;i<n;i++){const h=new Date(tt).getHours(),f=h<6?2.4:h>=9&&h<19?.6:1.1;const g=-Math.log(1-r())*f;gaps[i]=g;sum+=g;tt-=g*13e3}
  const scale=30*DAY/sum;
  // Сбои: в окне сбоя камеры одного сервера теряют связь и запись
  const inc=[];for(let j=0;j<7;j++)inc.push({at:now-(.3+r()*29)*DAY,len:(8+r()*25)*MIN,srv:pick(r,byType.srv)});
  let t=now-r()*MIN;
  for(let i=0;i<n;i++){
    t-=gaps[i]*scale;T[i]=t;X[i]=(r()*4294967295)>>>0;
    const hit=inc.find(x=>t<=x.at&&t>x.at-x.len);
    let k=KINDS[bs(kindCum,r()*kindCum[kindCum.length-1])];
    if(hit&&r()<.55){const id=pick(r,["cam.offline","cam.offline","rec.lost","cam.online","al.tamper"]);k=KINDS.find(q=>q.id===id)}
    K[i]=k.i;
    let o=65535;
    if(k.on==="cam"){
      const pool=hit&&k.cat!=="audit"?byType.cam.filter(c=>c.srv===hit.srv.name):null;
      o=(pool&&pool.length?pick(r,pool):byType.cam[bs(camCum,r()*camCum[camCum.length-1])]).i;
    }else if(k.on==="srv")o=pick(r,byType.srv).i;
    else if(k.on==="rule")o=pick(r,byType.rule).i;
    O[i]=o;
    U[i]=k.who?bs(userCum,r()*userCum[userCum.length-1]):255;
  }
  Object.assign(S,{T,K,O,U,X});
  const TEXT=new Array(n),HAY=new Array(n);
  for(let i=0;i<n;i++){const v=vals(i);TEXT[i]=KINDS[K[i]].text(v);
    HAY[i]=`${TEXT[i]} ${KINDS[K[i]].n} ${CATS[KINDS[K[i]].ci].n} ${v.u||""} ${v.ip||""}`.toLowerCase()}
  Object.assign(S,{n,T,K,O,U,X,TEXT,HAY});
  S.genMs=Math.round(performance.now()-t0);
  injectCss();
};
function cum(w){const a=[];let s=0;w.forEach(x=>{s+=x;a.push(s)});return a}
function bs(a,x){let lo=0,hi=a.length-1;while(lo<hi){const m=(lo+hi)>>1;if(a[m]<x)lo=m+1;else hi=m}return lo}
function vals(i){
  const k=KINDS[S.K[i]],o=S.O[i]===65535?null:S.objs[S.O[i]],u=S.U[i]===255?null:S.users[S.U[i]];
  const r=rng(S.X[i]);
  return{t:S.T[i],o:o?.name||"",s:o?.srv||"",u:u?.login||"",ip:u?.ip||"",...(k.val?k.val(r):{})};
}
// Строка — по индексу: всё, что нужно списку и панели
PJ.row=function(i){
  const k=KINDS[S.K[i]],v=vals(i);
  return{i,t:S.T[i],kind:k,cat:CATS[k.ci],obj:S.O[i]===65535?null:S.objs[S.O[i]],user:S.U[i]===255?null:S.users[S.U[i]],text:S.TEXT[i],v};
};
// Первая строка не новее t: строки упорядочены от новых к старым
PJ.rowAt=function(t){let lo=0,hi=S.n;while(lo<hi){const m=(lo+hi)>>1;if(S.T[m]>t)lo=m+1;else hi=m}return lo};

// ── Текст: «|» — ИЛИ, пробел — И, кавычки — точная фраза (как в Axxon One) ──
PJ.parseText=function(s){
  s=String(s||"").trim();if(!s)return null;
  const groups=[];let cur="",q=false;
  for(const ch of s){if(ch==='"'){q=!q;cur+=ch}else if(ch==="|"&&!q){groups.push(cur);cur=""}else cur+=ch}
  groups.push(cur);
  const out=groups.map(g=>{const terms=[];g.replace(/"([^"]*)"|(\S+)/g,(m,a,b)=>{const x=(a??b).trim().toLowerCase();if(x)terms.push(x)});return terms}).filter(g=>g.length);
  return out.length?out:null;
};
PJ.terms=g=>g?[...new Set(g.flat())]:[];
PJ.hl=function(text,terms){
  let h=esc(text);if(!terms||!terms.length)return h;
  const re=new RegExp(`(${terms.map(t=>esc(t).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})`,"gi");
  return h.replace(re,"<mark>$1</mark>");
};

// ── Отбор: q = {from,to,cats,kinds,objs,users,text,showDebug}; наборы — Set индексов или null ──
// nkinds, nobjs, nusers — исключения: события с этими значениями не попадают в список
// Счётчики поля считаются без отбора по самому полю: видно, сколько даст другой выбор
PJ.query=function(q){
  const t0=performance.now(),n=S.n;
  const lo=q.to!=null?PJ.rowAt(q.to):0,hi=q.from!=null?PJ.rowAt(q.from):n;
  const groups=PJ.parseText(q.text);
  const idx=new Uint32Array(Math.max(0,hi-lo));let m=0;
  const cc=new Int32Array(CATS.length),kc=new Int32Array(KINDS.length),oc=new Int32Array(S.objs.length+1),uc=new Int32Array(S.users.length+1);
  let hidden=0;
  const cats=q.cats,kinds=q.kinds,objs=q.objs,users=q.users,dbg=CI.debug,hideDbg=!q.showDebug&&!(cats&&cats.has(dbg));
  const nk=q.nkinds,no=q.nobjs,nu=q.nusers;
  for(let i=lo;i<hi;i++){
    if(groups&&!match(S.HAY[i],groups))continue;
    const k=S.K[i],ci=KINDS[k].ci,o=S.O[i],u=S.U[i];
    const pc=cats?cats.has(ci):!(hideDbg&&ci===dbg),pk=(kinds?kinds.has(k):true)&&!(nk&&nk.has(k)),po=(objs?objs.has(o):true)&&!(no&&no.has(o)),pu=(users?users.has(u):true)&&!(nu&&nu.has(u));
    const fails=(!pc)+(!pk)+(!po)+(!pu);
    if(fails===0){idx[m++]=i;cc[ci]++;kc[k]++;oc[o===65535?S.objs.length:o]++;uc[u===255?S.users.length:u]++}
    else if(fails===1){
      if(!pc){cc[ci]++;if(!cats&&ci===dbg)hidden++}
      else if(!pk)kc[k]++;else if(!po)oc[o===65535?S.objs.length:o]++;else uc[u===255?S.users.length:u]++;
    }
  }
  return{idx:idx.subarray(0,m),total:m,cc,kc,oc,uc,hidden,groups,ms:Math.round(performance.now()-t0),span:hi-lo};
};
function match(h,groups){
  for(const g of groups){let ok=true;for(const t of g)if(!h.includes(t)){ok=false;break}if(ok)return true}
  return false;
}
// Гистограмма: те же условия, кроме времени; три слоя — тревоги и ошибки, аудит, остальное
PJ.hist=function(q,from,to,nb){
  const lo=PJ.rowAt(to),hi=PJ.rowAt(from),step=(to-from)/nb,a=new Int32Array(nb*3);
  const groups=PJ.parseText(q.text),cats=q.cats,kinds=q.kinds,objs=q.objs,users=q.users,dbg=CI.debug,hideDbg=!q.showDebug&&!(cats&&cats.has(dbg));
  for(let i=lo;i<hi;i++){
    const k=S.K[i],ci=KINDS[k].ci;
    if(cats?!cats.has(ci):hideDbg&&ci===dbg)continue;
    if(kinds&&!kinds.has(k))continue;if(objs&&!objs.has(S.O[i]))continue;if(users&&!users.has(S.U[i]))continue;
    if(q.nkinds&&q.nkinds.has(k))continue;if(q.nobjs&&q.nobjs.has(S.O[i]))continue;if(q.nusers&&q.nusers.has(S.U[i]))continue;
    if(groups&&!match(S.HAY[i],groups))continue;
    const b=Math.min(nb-1,Math.floor((S.T[i]-from)/step));if(b<0)continue;
    a[b*3+(ci<=1?0:ci===2?1:2)]++;
  }
  let max=1;for(let b=0;b<nb;b++)max=Math.max(max,a[b*3]+a[b*3+1]+a[b*3+2]);
  return{a,nb,from,to,step,max};
};
// sel — [первый, последний] выбранный столбик; hot — столбик под курсором
PJ.histSvg=function(h,o={}){
  const H=o.height||48,W=h.nb*10,sx=10,bars=[];
  for(let b=0;b<h.nb;b++){
    const v=[h.a[b*3],h.a[b*3+1],h.a[b*3+2]];let y=H;
    const on=!o.sel||(b>=o.sel[0]&&b<=o.sel[1]);
    [[2,"pj-h-info"],[1,"pj-h-audit"],[0,"pj-h-alarm"]].forEach(([j,cl])=>{if(!v[j])return;const hh=Math.max(1,v[j]/h.max*(H-2));y-=hh;bars.push(`<rect x="${b*sx+1}" y="${y.toFixed(1)}" width="${sx-2}" height="${hh.toFixed(1)}" class="${cl}${on?"":" pj-h-off"}"/>`)});
    bars.push(`<rect x="${b*sx}" y="0" width="${sx}" height="${H}" class="pj-h-hit" data-b="${b}"><title>${esc(PJ.fmtSpan(h.from+b*h.step,h.from+(b+1)*h.step))}: ${PJ.num(v[0]+v[1]+v[2])}</title></rect>`);
  }
  return`<svg class="pj-hist" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${bars.join("")}</svg>`;
};
// Протяжка: done(from,to) по границам столбиков; щелчок — один столбик
PJ.brush=function(box,h,done){
  const svg=box.querySelector("svg");if(!svg)return;
  let sel=box.querySelector(".pj-brush");if(!sel){sel=document.createElement("div");sel.className="pj-brush";box.appendChild(sel)}
  const at=x=>{const r=svg.getBoundingClientRect();return Math.max(0,Math.min(.9999,(x-r.left)/r.width))};
  const bar=f=>Math.floor(f*h.nb);
  box.onpointerdown=e=>{
    if(e.button!==0)return;const b0=bar(at(e.clientX)),x0=e.clientX;let moved=false;
    try{box.setPointerCapture(e.pointerId)}catch(_){}
    const span=b=>{const a=Math.min(b0,b),c=Math.max(b0,b);sel.style.cssText=`display:block;left:${a/h.nb*100}%;width:${(c-a+1)/h.nb*100}%`;return[a,c]};
    box.onpointermove=ev=>{if(Math.abs(ev.clientX-x0)>4){moved=true;span(bar(at(ev.clientX)))}};
    box.onpointerup=ev=>{box.onpointermove=box.onpointerup=null;sel.style.display="none";
      const[a,c]=moved?span(bar(at(ev.clientX))):[b0,b0];done(h.from+a*h.step,h.from+(c+1)*h.step)};
  };
};
PJ.histAxis=function(h,n=6){
  const out=[];for(let j=0;j<=n;j++){const t=h.from+(h.to-h.from)*j/n;out.push(`<span style="left:${(j/n*100).toFixed(2)}%">${esc(PJ.fmtTick(t,h.to-h.from))}</span>`)}
  return`<div class="pj-axis">${out.join("")}</div>`;
};

// ── Время ──
const MON=["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const MONF=["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const WD=["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
const p2=x=>String(x).padStart(2,"0");
function dayDiff(t){const a=new Date(S.now),b=new Date(t);a.setHours(0,0,0,0);b.setHours(0,0,0,0);return Math.round((a-b)/DAY)}
PJ.fmtDay=t=>{const d=new Date(t),dd=dayDiff(t);return dd===0?"сегодня":dd===1?"вчера":`${d.getDate()} ${MON[d.getMonth()]}`};
PJ.fmt=t=>{const d=new Date(t);return`${PJ.fmtDay(t)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`};
PJ.fmtFull=t=>{const d=new Date(t);return`${WD[d.getDay()]}, ${d.getDate()} ${MONF[d.getMonth()]} ${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`};
PJ.fmtTick=(t,span)=>{const d=new Date(t);return span>3*DAY?`${d.getDate()} ${MON[d.getMonth()]}`:span>20*HOUR?`${PJ.fmtDay(t)} ${p2(d.getHours())}:00`:`${p2(d.getHours())}:${p2(d.getMinutes())}`};
PJ.fmtSpan=(a,b)=>{const da=new Date(a),db=new Date(b);const same=dayDiff(a)===dayDiff(b-1);
  return same?`${PJ.fmtDay(a)} ${p2(da.getHours())}:${p2(da.getMinutes())}–${p2(db.getHours())}:${p2(db.getMinutes())}`:`${PJ.fmtDay(a)} ${p2(da.getHours())}:${p2(da.getMinutes())} – ${PJ.fmtDay(b)} ${p2(db.getHours())}:${p2(db.getMinutes())}`};
// Быстрые периоды: от «сейчас» назад
PJ.RANGES=[["1h","1 час",HOUR],["24h","24 часа",DAY],["7d","7 дней",7*DAY],["30d","30 дней",30*DAY]];
PJ.range=id=>{const x=PJ.RANGES.find(r=>r[0]===id);return x?{from:S.now-x[2],to:S.now+MIN}:{from:S.now-DAY,to:S.now+MIN}};
PJ.MIN=MIN;PJ.HOUR=HOUR;PJ.DAY=DAY;

// ── Список: строки рисуются только в окне прокрутки ──
// Широкий список — одна строка на событие; узкий — две: описание уходит на вторую
PJ.list=function(host,o){
  // o: {idx, terms, sel, cols:"full"|"compact", onPick(i), onFilter(field,value), empty, flash(el)}
  if(!host)return null;
  const compact=o.cols==="compact";
  host.innerHTML=`<div class="pj-l${compact?" pj-l-c":""}"><div class="pj-lh" role="row"></div>
    <div class="pj-ls" tabindex="0" role="grid" aria-label="События"><div class="pj-lsp"></div><div class="pj-lr"></div></div></div>`;
  const box=host.firstElementChild,hd=host.querySelector(".pj-lh"),sc=host.querySelector(".pj-ls"),sp=host.querySelector(".pj-lsp"),rows=host.querySelector(".pj-lr");
  const st={idx:o.idx,sel:o.sel??-1,terms:o.terms||[],two:null,rh:32};
  function mode(){
    const two=(host.clientWidth||900)<(compact?620:860);
    if(two===st.two)return false;
    st.two=two;st.rh=two?48:32;box.classList.toggle("pj-two",two);
    hd.innerHTML=`<span>Время</span><span>Событие</span>${compact?"":"<span>Объект</span>"}<span>Кто</span>${two?"":"<span>Описание</span>"}`;
    sp.style.height=`${st.idx.length*st.rh}px`;return true;
  }
  let raf=0;
  function draw(){
    raf=0;mode();const RH=st.rh;
    if(!st.idx.length){rows.style.transform="";rows.innerHTML=`<div class="pj-empty">${o.empty||"Событий нет. Измените условия поиска."}</div>`;return}
    const top=sc.scrollTop,vh=sc.clientHeight||600,a=Math.max(0,Math.floor(top/RH)-8),b=Math.min(st.idx.length,Math.ceil((top+vh)/RH)+8);
    let h="";
    for(let j=a;j<b;j++){
      const r=PJ.row(st.idx[j]);
      h+=`<div class="pj-r${r.i===st.sel?" on":""}" data-i="${r.i}" role="row">
        <span class="pj-t" title="${esc(PJ.fmtFull(r.t))}">${esc(PJ.fmt(r.t))}</span>
        <span class="pj-k" title="${esc(r.cat.n)}"><i class="pj-dot pj-c-${r.cat.id}"></i>${PJ.hl(r.kind.n,st.terms)}</span>
        ${compact?"":`<span>${r.obj?`<button type="button" class="pj-cell" data-f="obj" data-v="${r.obj.i}" title="Только события объекта «${esc(r.obj.name)}»">${PJ.hl(r.obj.name,st.terms)}</button>`:'<span class="pj-mu">—</span>'}</span>`}
        <span>${r.user?`<button type="button" class="pj-cell" data-f="user" data-v="${r.user.i}" title="Только события пользователя ${esc(r.user.login)}">${PJ.hl(r.user.login,st.terms)}</button>`:'<span class="pj-mu">—</span>'}</span>
        <span class="pj-x" title="${esc(r.text)}">${PJ.hl(r.text,st.terms)}</span></div>`;
    }
    rows.style.transform=`translateY(${a*RH}px)`;rows.innerHTML=h;
    o.onScroll&&o.onScroll(st.idx[Math.min(st.idx.length-1,Math.floor(top/RH))]);
  }
  const ask=()=>{if(!raf)raf=requestAnimationFrame(draw)};
  sc.addEventListener("scroll",ask,{passive:true});
  if(window.ResizeObserver)new ResizeObserver(ask).observe(host);
  rows.addEventListener("click",e=>{
    const c=e.target.closest(".pj-cell");
    if(c&&o.onFilter){e.stopPropagation();o.onFilter(c.dataset.f,+c.dataset.v);return}
    const r=e.target.closest(".pj-r");if(!r)return;
    ctl.select(+r.dataset.i);o.onPick&&o.onPick(+r.dataset.i);
  });
  sc.addEventListener("keydown",e=>{
    if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return;e.preventDefault();
    if(!st.idx.length)return;
    let j=st.idx.indexOf(st.sel);j=j<0?0:Math.max(0,Math.min(st.idx.length-1,j+(e.key==="ArrowDown"?1:-1)));
    ctl.select(st.idx[j]);ctl.reveal(j);o.onPick&&o.onPick(st.idx[j]);
  });
  const ctl={
    select(i){st.sel=i;rows.querySelectorAll(".pj-r").forEach(el=>el.classList.toggle("on",+el.dataset.i===i))},
    reveal(j){const y=j*st.rh;if(y<sc.scrollTop)sc.scrollTop=y;else if(y+st.rh>sc.scrollTop+sc.clientHeight)sc.scrollTop=y+st.rh-sc.clientHeight},
    scrollToRow(j,center){mode();sc.scrollTop=Math.max(0,j*st.rh-(center?sc.clientHeight/2-st.rh:0));ask()},
    flash(i){setTimeout(()=>{const el=rows.querySelector(`.pj-r[data-i="${i}"]`);if(el&&o.flash)o.flash(el)},40)},
    get sc(){return sc}
  };
  mode();draw();
  return ctl;
};

// ── Панель события ──
PJ.detailHtml=function(i,o={}){
  if(i==null||i<0)return`<div class="pj-det pj-det-0"><p class="pj-mu">Выберите событие в списке. Здесь появятся подробности, ссылки на объект и видео, события рядом.</p></div>`;
  const r=PJ.row(i),k=r.kind,v=r.v,ctx=S.ctx||{};
  const kv=[];
  const fx=(f,v)=>`<span class="pj-fx"><button type="button" data-pj-act="inc" data-f="${f}" data-v="${v}" title="Добавить условие: только такие" aria-label="Только такие">=</button><button type="button" data-pj-act="exc" data-f="${f}" data-v="${v}" title="Скрыть такие события" aria-label="Скрыть такие">≠</button></span>`;
  kv.push(["Событие",`${esc(k.n)}${fx("kinds",k.i)}`]);
  if(r.obj)kv.push(["Объект",`<button type="button" class="lk" data-pj-act="obj" data-v="${r.obj.i}">${esc(r.obj.name)}</button>${fx("objs",r.obj.i)}`]);
  if(r.obj&&r.obj.type==="cam"&&r.obj.srv)kv.push(["Сервер",esc(r.obj.srv)]);
  if(r.user)kv.push(["Пользователь",`<button type="button" class="lk" data-pj-act="user" data-v="${r.user.i}">${esc(r.user.login)}</button>${fx("users",r.user.i)}`]);
  if(r.user&&(k.id==="login"||k.id==="login.fail"))kv.push(["Адрес",esc(r.user.ip)]);
  (k.more?k.more(v):[]).forEach(([a,b])=>kv.push([a,esc(b)]));
  const diff=k.diff?`<div class="pj-diff"><div class="pj-diff-p">${esc(v.p)}</div><div><span class="pj-mu">Было</span><s>${esc(v.a)}</s></div><div><span class="pj-mu">Стало</span><b>${esc(v.b)}</b></div></div>`:"";
  // События рядом: у того же объекта или пользователя, три до и три после
  const byTime=PJ.nearMode==="time"||!(r.obj||r.user),near=nearRows(r,3,byTime);
  const nm=r.obj||r.user?`<span class="pj-seg pj-seg-s" role="group" aria-label="Что показать рядом"><button type="button" class="${byTime?"":"on"}" data-pj-act="near" data-v="0">${r.obj?"Этот объект":"Этот пользователь"}</button><button type="button" class="${byTime?"on":""}" data-pj-act="near" data-v="1">Весь журнал</button></span>`:"";
  const nearHtml=near.length?`<div class="pj-near"><div class="pj-near-h"><span>Рядом</span>${nm}</div>${near.map(j=>{const x=PJ.row(j);return`<button type="button" class="pj-nr${j===i?" on":""}" data-pj-act="pick" data-v="${j}"><span class="pj-t">${esc(PJ.fmt(x.t))}</span><i class="pj-dot pj-c-${x.cat.id}"></i><span>${esc(x.kind.n)}${byTime&&x.obj?`<span class="pj-mu"> · ${esc(x.obj.name)}</span>`:""}</span></button>`}).join("")}</div>`:"";
  const acts=[
    k.video&&r.obj&&ctx.openVideo?`<button type="button" class="btn s pri" data-pj-act="video" data-v="${r.obj.i}">Открыть видео на ${esc(PJ.fmt(r.t).replace(/:\d\d$/,""))}</button>`:"",
    `<button type="button" class="btn s" data-pj-act="similar" data-v="${i}" title="Тот же вид события${r.obj?" и тот же объект":""}">Найти похожие</button>`,
    `<button type="button" class="btn s" data-pj-act="copy" data-v="${i}">Копировать ссылку</button>`
  ].join("");
  return`<div class="pj-det">
    <div class="pj-det-hd"><span class="pj-tag pj-c-${r.cat.id}">${esc(r.cat.n)}</span><b>${esc(k.n)}</b></div>
    <div class="pj-det-t">${esc(PJ.fmtFull(r.t))}</div>
    <p class="pj-det-x">${esc(r.text)}</p>${diff}
    <dl class="pj-kv">${kv.map(([a,b])=>`<dt>${esc(a)}</dt><dd>${b}</dd>`).join("")}</dl>
    <div class="pj-acts">${acts}</div>${nearHtml}${o.extra||""}</div>`;
};
PJ.nearMode="obj";
function nearRows(r,k,byTime){
  const same=byTime?()=>true:j=>r.obj?S.O[j]===r.obj.i:r.user?S.U[j]===r.user.i:true;
  const before=[],after=[];
  for(let j=r.i+1;j<S.n&&before.length<k&&j<r.i+40000;j++)if(same(j)&&S.K[j]!==undefined&&KINDS[S.K[j]].cat!=="debug")before.push(j);
  for(let j=r.i-1;j>=0&&after.length<k&&j>r.i-40000;j--)if(same(j)&&KINDS[S.K[j]].cat!=="debug")after.push(j);
  return[...after.reverse(),r.i,...before];
}
// Действия панели: obj, user, video, similar, copy, pick
PJ.bindActs=function(el,fn){
  if(!el||el._pjActs)return;el._pjActs=true;
  el.addEventListener("click",e=>{const b=e.target.closest("[data-pj-act]");if(!b||!el.contains(b))return;fn(b.dataset.pjAct,+b.dataset.v,b.dataset.f,b)});
};
PJ.openAct=function(act,v){
  const ctx=S.ctx||{};
  if(act==="obj"){const o=S.objs[v];if(o&&ctx.openObj)ctx.openObj(o);return true}
  if(act==="user"){const u=S.users[v];if(u&&ctx.openUser)ctx.openUser(u.login);return true}
  if(act==="video"){const o=S.objs[v];if(o&&ctx.openVideo)ctx.openVideo(o);return true}
  return false;
};

// ── Стили: только токены темы консоли ──
function injectCss(){
  if(document.getElementById("pj-css"))return;
  const st=document.createElement("style");st.id="pj-css";st.textContent=`
.pj{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 var(--pad,16px) var(--pad,16px);gap:10px}
.pj-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pj-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px}
.pj-body.pj-nodet{grid-template-columns:minmax(0,1fr)}
.pj-main{min-height:0;display:flex;flex-direction:column;gap:8px}
.pj-listbox{flex:1;min-height:0;border:1px solid var(--ln);border-radius:8px;background:var(--p);overflow:hidden}
.pj-l{height:100%;display:flex;flex-direction:column}
.pj-lh,.pj-r{display:grid;grid-template-columns:128px minmax(150px,200px) minmax(120px,190px) 88px minmax(0,1fr);gap:8px;align-items:center;padding:0 10px}
.pj-l-c .pj-lh,.pj-l-c .pj-r{grid-template-columns:128px minmax(150px,200px) 88px minmax(0,1fr)}
.pj-two .pj-lh,.pj-two .pj-r{grid-template-columns:116px minmax(0,1.2fr) minmax(0,1fr) 84px}
.pj-l-c.pj-two .pj-lh,.pj-l-c.pj-two .pj-r{grid-template-columns:116px minmax(0,1fr) 84px}
.pj-two .pj-r{height:48px;grid-template-rows:20px 18px;align-content:center;row-gap:2px}
.pj-two .pj-x{grid-column:1/-1;font-size:12px;color:var(--mu)}
.pj-lh{height:30px;font-size:12px;color:var(--mu);border-bottom:1px solid var(--ln);background:var(--p2)}
.pj-ls{flex:1;min-height:0;overflow:auto;position:relative;scrollbar-gutter:stable;outline:none}
.pj-lr{position:absolute;left:0;right:0;top:0}
.pj-r{height:32px;box-sizing:border-box;font-size:13px;border-bottom:1px solid color-mix(in srgb,var(--ln) 55%,transparent);cursor:pointer;white-space:nowrap}
.pj-r>span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.pj-r:hover{background:var(--p2)}.pj-r.on{background:color-mix(in srgb,var(--bl) 16%,transparent)}
.pj-ls:focus-visible .pj-r.on{outline:2px solid var(--bl);outline-offset:-2px}
.pj-t{font-variant-numeric:tabular-nums;color:var(--mu)}
.pj-k{font-weight:500}.pj-mu{color:var(--mu)}
.pj-cell{all:unset;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle;border-radius:4px;padding:0 3px;margin:0 -3px}
.pj-cell:hover{background:color-mix(in srgb,var(--bl) 18%,transparent);color:var(--tx)}
.pj-cell:focus-visible{outline:2px solid var(--bl)}
.pj-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;background:var(--mu)}
.pj-c-alarm.pj-dot,.pj-tag.pj-c-alarm{background:var(--rd)}.pj-c-error.pj-dot,.pj-tag.pj-c-error{background:var(--one-warning-icon,#d89614)}
.pj-c-audit.pj-dot,.pj-tag.pj-c-audit{background:var(--bl)}.pj-c-info.pj-dot,.pj-tag.pj-c-info{background:var(--mu)}.pj-c-debug.pj-dot,.pj-tag.pj-c-debug{background:var(--one-fg-subtle,#888)}
.pj-tag{color:#fff;font-size:11px;border-radius:4px;padding:1px 6px}
.pj-empty{padding:24px;color:var(--mu);text-align:center}
mark{background:color-mix(in srgb,var(--one-warning-icon,#d89614) 40%,transparent);color:inherit;border-radius:2px}
.pj-sum{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:13px;color:var(--mu);min-height:24px}
.pj-sum b{color:var(--tx)}
.pj-histbox{position:relative;padding-bottom:16px;cursor:crosshair;user-select:none;touch-action:none}
.pj-brush{display:none;position:absolute;top:0;bottom:16px;background:color-mix(in srgb,var(--bl) 28%,transparent);border-left:1px solid var(--bl);border-right:1px solid var(--bl);pointer-events:none}
.pj-sum .lk{white-space:nowrap}.pj-sum .lk svg{width:13px;height:13px;vertical-align:-2px;display:inline}
.pj-fx{display:inline-flex;gap:2px;margin-left:6px;vertical-align:1px}
.pj-fx button{all:unset;cursor:pointer;font-size:12px;line-height:18px;width:20px;text-align:center;border:1px solid var(--ln);border-radius:4px;color:var(--mu)}
.pj-fx button:hover,.pj-fx button:focus-visible{color:var(--tx);border-color:var(--bl)}
.pj-seg.pj-seg-s button{height:22px;line-height:22px;font-size:11px;padding:0 6px}
.pj-chip.ex{border-style:dashed}.pj-chip.ex b{color:var(--rd,#e5484d);font-weight:600}
.pj-hist{width:100%;display:block}
.pj-h-alarm{fill:var(--rd)}.pj-h-audit{fill:var(--bl)}.pj-h-info{fill:color-mix(in srgb,var(--mu) 55%,transparent)}
.pj-h-off{opacity:.25}.pj-h-hit{fill:transparent;cursor:pointer}.pj-h-hit:hover{fill:color-mix(in srgb,var(--tx) 10%,transparent)}
.pj-axis{position:absolute;left:0;right:0;bottom:0;height:14px;font-size:11px;color:var(--mu)}
.pj-axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}.pj-axis span:first-child{transform:none}.pj-axis span:last-child{transform:translateX(-100%)}
.pj-side{min-height:0;overflow:auto;border:1px solid var(--ln);border-radius:8px;background:var(--p);scrollbar-gutter:stable}
.pj-det{padding:12px 14px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.pj-det-hd{display:flex;gap:8px;align-items:center;font-size:15px}
.pj-det-t{color:var(--mu)}.pj-det-x{margin:0;line-height:1.45}
.pj-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}
.pj-kv dt{color:var(--mu)}.pj-kv dd{margin:0;overflow-wrap:anywhere}
.pj-diff{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;border:1px solid var(--ln);border-radius:6px;padding:8px 10px}
.pj-diff-p{grid-column:1/-1;font-weight:500}.pj-diff span{display:block;font-size:11px}.pj-diff s{color:var(--mu)}
.pj-acts{display:flex;flex-wrap:wrap;gap:6px}
.pj-near{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--ln);padding-top:8px}
.pj-near-h{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--mu);margin-bottom:4px}
.pj-nr{all:unset;cursor:pointer;display:grid;grid-template-columns:118px 14px minmax(0,1fr);align-items:center;padding:3px 6px;border-radius:4px;font-size:12px;white-space:nowrap}
.pj-nr>span{overflow:hidden;text-overflow:ellipsis}.pj-nr:hover{background:var(--p2)}.pj-nr.on{background:color-mix(in srgb,var(--bl) 16%,transparent)}
.pj-seg{display:inline-flex;border:1px solid var(--ln);border-radius:6px;overflow:hidden}
.pj-seg button{all:unset;cursor:pointer;padding:0 10px;height:30px;line-height:30px;font-size:13px;white-space:nowrap;border-right:1px solid var(--ln)}
.pj-seg button:last-child{border-right:0}.pj-seg button:hover{background:var(--p2)}
.pj-seg button.on{background:color-mix(in srgb,var(--bl) 22%,transparent);color:var(--tx)}
.pj-seg button:focus-visible{outline:2px solid var(--bl);outline-offset:-2px}
.pj-chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 4px 0 9px;border-radius:13px;font-size:13px;white-space:nowrap;background:color-mix(in srgb,var(--bl) 18%,transparent);border:1px solid color-mix(in srgb,var(--bl) 45%,transparent)}
.pj-chip i{font-style:normal;color:var(--mu)}
.pj-chip button{all:unset;cursor:pointer;width:18px;height:18px;border-radius:50%;text-align:center;line-height:18px;color:var(--mu)}
.pj-chip button:hover{background:var(--p2);color:var(--tx)}
.pj-tree-h{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mu);padding:12px 12px 4px}
.pj-tree-p{font-size:12px;color:var(--mu);padding:0 12px;margin:0}
.pj-tree-n{margin-left:auto;padding-right:8px;font-size:12px;color:var(--mu);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.pj *{transition:none!important;animation:none!important}}
`;document.head.appendChild(st)}
window.PJ=PJ;
})();
