#!/usr/bin/env node
/* Сценарий tools/check_live.py: настоящая мышь по CDP, настоящие кадры. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [chrome, root, pagePath = "index.html"] = process.argv.slice(2);
const PORT = 9400 + (process.pid % 400);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "consolem-live-"));
const url = `file://${root}/${pagePath}`;
const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox", "--allow-file-access-from-files", `--user-data-dir=${prof}`, "--window-size=1500,1000", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--remote-debugging-port=${PORT}`, url], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failed++;
};
async function tabs() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = l.find((t) => t.type === "page");
      if (p) return p;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error("Chrome не поднялся");
}
const page = await tabs();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const wait = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) (wait.get(m.id)(m.result), wait.delete(m.id));
};
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await cmd("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (x, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(x)) return true; await sleep(100); } return false; };
const box = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e||e.hidden)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
async function click(sel) {
  const b = await box(sel);
  if (!b) return false;
  await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
  await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await sleep(40);
  await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await sleep(100);
  return true;
}
const video = () => ev(`(()=>{const v=document.querySelector("#main video");return v?{w:v.videoWidth,h:v.videoHeight,t:v.currentTime,paused:v.paused}:null})()`);

try {
  await ev("window.appReady");
  await sleep(500);
  await ev(`window.uiCam=devicePool.find(n=>n.type==="camera"&&n.online!==false&&!n._row)||devicePool.find(n=>n.type==="camera"&&n.online!==false);pick(uiCam.id,{force:true});null`);
  await until(`!uiCam._row&&sel===uiCam.id`);
  ok(await click(`#main .tab[data-tab="view"]`), "закладка «Просмотр»: мышью");
  ok(await until(`tab==="view"`), "открылась");
  ok(await click(`[data-live-go]`), "«Смотреть»: мышью");
  ok(await until(`/Идёт/.test(document.querySelector("[data-live-state]").textContent)`), "идёт: " + (await ev(`document.querySelector("[data-live-state]").textContent`)));
  ok(await until(`document.querySelector("#main video")?.videoWidth>0`), "кадры пришли");
  const a = await video();
  await sleep(2000);
  const b = await video();
  ok(a?.w === 640 && a?.h === 360, `video.videoWidth×videoHeight ${a?.w}×${a?.h}`);
  ok(b?.t > a?.t + 1, `currentTime растёт: ${a?.t.toFixed(2)} → ${b?.t.toFixed(2)} за 2 с`);
  ok(!b?.paused, "не на паузе");
  ok(/настоящего видео на стенде нет|На стенде нет настоящего видео/.test(await ev(`document.querySelector(".live-note").textContent`)), "подпись на кадре: не камера");
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, Buffer.from((await cmd("Page.captureScreenshot", { format: "png" })).data, "base64"));
  // Часть 2: PTZ мышью, разговор на подставном микрофоне браузера, реле
  await ev(`window.uiPtz=devicePool.find(n=>n.type==="camera"&&n.ptz&&n.online!==false);window.uiPuts=[];const p0=API.put;API.put=(p,b,v)=>(/\\/ptz$/.test(p)&&uiPuts.push(b),p0(p,b,v));null`);
  if (await ev(`!!uiPtz`)) {
    await ev(`pick(uiPtz.id,{force:true});null`);
    await until(`!uiPtz._row&&sel===uiPtz.id`);
    await click(`#main .tab[data-tab="view"]`);
    await until(`tab==="view"`);
    const b = await box(`[data-cv-onvid] .cv-hold`);
    await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
    await sleep(1800);
    ok((await ev(`uiPtz&&uiPuts.length`)) >= 2 && (await ev(`!!cvMove`)), "PTZ: держим кнопку зума на кадре мышью, аренда продлена");
    await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
    await sleep(150);
    ok(await ev(`!cvMove`), "PTZ: отпустили, стоп");
  }
  await ev(`window.uiSpk=devicePool.find(n=>n.type==="camera"&&n.name==="Главный вход");pick(uiSpk.id,{force:true});null`);
  await until(`!uiSpk._row&&sel===uiSpk.id`);
  await click(`#main .tab[data-tab="view"]`);
  await until(`tab==="view"&&!!document.querySelector("[data-tl-bar]")&&!document.querySelector("[data-talk]").hidden`);
  ok(await click(`[data-talk]`), "«Говорить»: мышью");
  ok(await until(`talk?.sess&&talk.pc.connectionState==="connected"`), "разговор соединён: " + (await ev(`document.querySelector("[data-talk-state]").textContent`)));
  ok(await click(`[data-talk]`), "«Закончить разговор»: мышью");
  ok(await until(`!talk`), "разговор закончен");
  ok(await click(`[data-vw-tab="relay"]`), "вкладка «Реле»: мышью");
  ok(await click(`[data-relay] button`), "реле «Замкнуть»: мышью");
  ok(await until(`/замкнуто/.test(document.body.textContent)`), "реле: ответ словами");

  // Часть 3: окно, щелчок по шкале, кусок играет, следующий по окончании
  ok(await click(`[data-tl-win="all"]`), "окно «Всё»: мышью");
  ok(await until(`lv.tl.win==="all"&&!lv.tl.busy&&lv.tl.spans.length>10`), "шкала прочитана");
  const hit = await ev(`(()=>{const t=lv.tl,s=t.spans.filter(x=>!x.fenced&&x.source==="live"&&!x.backupOnly).at(-3),i=t.spans.indexOf(s);const e=document.querySelector('[data-span="'+i+'"]');e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: hit.x, y: hit.y });
  await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
  await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
  ok(await until(`lv.pb?.piece`), "щелчок по шкале мышью: кусок");
  ok(await until(`liveEl.videoWidth>0`), "кадры куска: " + (await ev(`liveEl.videoWidth+"×"+liveEl.videoHeight`)));
  const t0 = await ev(`liveEl.currentTime`);
  await sleep(1500);
  ok((await ev(`liveEl.currentTime`)) > t0, `кусок играет: currentTime ${t0.toFixed(2)} → ${(await ev(`liveEl.currentTime`)).toFixed(2)}`);
  ok(/настоящей записи на стенде нет|На стенде нет настоящей записи/.test(await ev(`document.querySelector(".live-note").textContent`)), "подпись на куске");
  if (process.env.SHOT2) fs.writeFileSync(process.env.SHOT2, Buffer.from((await cmd("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const first = await ev(`lv.pb.piece.to`);
  await ev(`liveEl.currentTime=liveEl.duration-1;null`);
  ok(await until(`lv.pb?.piece&&lv.pb.piece.from===${first}`), "кусок кончился, следующий сам");
  ok(await until(`liveEl.currentTime>0.2&&!liveEl.paused`), "следующий играет");

  // Часть 4: отметка, удержание мышью
  ok(await click(`[data-vw-tab="marks"]`), "вкладка «Отметки»: мышью");
  await click(`[data-mark-note]`);
  await cmd("Input.insertText", { text: "Отметка мышью" });
  ok(await click(`[data-mark-add]`), "«Отметить»: мышью");
  ok(await until(`lv.marks.some(m=>m.note==="Отметка мышью")`), "отметка на месте");
  ok(await click(`[data-vw-tab="holds"]`), "вкладка «Удержания»: мышью");
  ok(await click(`[data-hold-add]`), "«Удержать показанное»: мышью");
  ok(await until(`!!document.getElementById("holdFrom")`), "окно удержания");
  await click(`#holdNote`);
  await cmd("Input.insertText", { text: "Инцидент" });
  ok(await click(`#confirmOk`), "«Удержать»: мышью");
  ok(await until(`lv.holds.length===1`), "удержание в списке");
  ok(await click(`[data-hold-verify]`), "«Проверить»: мышью");
  ok(await until(`/цело/.test(document.querySelector("[data-hold-result]")?.textContent||"")`), "проверка словами");
  ok(await click(`[data-hold-del]`), "«Снять»: мышью");
  ok(await until(`!!document.getElementById("confirmCountInp")`), "ввод числа");
  await click(`#confirmCountInp`);
  await cmd("Input.insertText", { text: "1" });
  ok(await click(`#confirmOk`), "подтверждение мышью");
  ok(await until(`lv.holds.length===0`, 20000), "удержание снято");
  if (await ev(`!!document.querySelector("[data-tl-fix]")`)) {
    ok(await click(`[data-tl-fix]`), "«Закрепить»: мышью");
    ok(await until(`/Подано просьб/.test(document.body.textContent)`), "закрепить: ответ словами");
  }
  await ev(`lv&&lv.state==="idle"&&liveStart();null`);
  ok(await click(`[data-live-go]`), "«Остановить»: мышью");
  ok(await until(`!ConsolemWhepStub.sessions.size`), "сессия снята");
  ok(await until(`document.querySelector("#main video")?.srcObject===null||!document.querySelector("#main video")`), "поток элемента снят");
} catch (e) {
  ok(false, "исключение: " + e.message);
}
const gone = new Promise((r) => proc.once("exit", r));
proc.kill();
await Promise.race([gone, sleep(3000)]);
try {
  fs.rmSync(prof, { recursive: true, force: true, maxRetries: 3 });
} catch (e) {}
process.exit(failed ? 1 : 0);
