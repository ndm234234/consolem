/* Общее правило страницы на встроенном сервере: tools/check_api.py читает отсюда JSON со списком расхождений.
   Каждый перечень таблицы предложения: limit, обход до конца без потерь и повторов, чужой курсор, пределы limit. Пустая страница
   с nextCursor на фильтре и в папке. Обе формы version в /objects/delete. Перечни объектов — /units, предметные API —
   /units/{uid}/…, в /objects/delete — Unit.version объекта и Rule.version правила. */
global.window = global;
// Папка API — первый аргумент (по умолчанию api): node tools/check_pages.js [DIR]
const API = require("path").resolve(__dirname, "..", process.argv[2] || "api");
require(API + "/contract.js");
require(API + "/server.js");
const raw = require(API + "/fixtures/demo.json");
// Набор хранит только units: записи для выборки ниже (domains, devices…) выводим из них тем же мостом, что у сервера
const fx = window.ConsolemServer.legacyFixture(raw);
const openapi = require(API + "/openapi.json");
const s = window.ConsolemServer.create({ fixture: raw, fixtures: { demo: raw }, openapi, autoTick: false, testSupport: true });
const bad = [];
const get = (p) => s.handle("GET", p);
const sep = (p) => (p.includes("?") ? "&" : "?");
const rule = fx.ruleFires[0].ruleId, did = fx.domains[0].id;
const OBJ = "/units";
const LISTS = ["/units", "/journal", "/operations", `/rules/${rule}/fires`, "/archive-watches", "/archive-scans",
  "/access/users", "/access/groups", "/access/history", "/access/cell-history", `/access/roles/${fx.access.roles[0].id}/objects`, `/tree/children?layout=servers&parentId=${did}`];
const recCam = fx.devices.find((d) => d.type === "camera" && d.archiveId);
LISTS.push(`${OBJ}/${recCam.id}/timeline`, `${OBJ}/${recCam.id}/holds`, `${OBJ}/${recCam.id}/bookmarks`);
[["2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"], ["2026-01-02T00:00:00Z", "2026-01-02T01:00:00Z"]].forEach(([from, to]) => {
  s.handle("POST", `${OBJ}/${recCam.id}/holds`, { from, to });
  s.handle("POST", `${OBJ}/${recCam.id}/bookmarks`, { note: "проба", occurred: from });
});
const first = fx.devices[0], firstVersion = get(`/units/${first.id}`).body.version;
s.handle("PATCH", `${OBJ}/${first.id}`, { name: "Проба" }, { "If-Match": `"${firstVersion}"` });
for (const path of LISTS) {
  const all = [];
  let cursor = null, n = 0;
  do {
    const r = get(`${path}${sep(path)}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (r.status !== 200) { bad.push(`${path}: ${r.status}`); break; }
    if (r.body.items.length > 1) bad.push(`${path}: больше limit`);
    all.push(...r.body.items);
    cursor = r.body.nextCursor || null;
    if (++n > 3000) { bad.push(`${path}: страницы не кончаются`); break; }
  } while (cursor);
  const key = (x) => x.id || x.uid || x.objectId || x.spanId;
  if (new Set(all.map(key)).size !== all.length) bad.push(`${path}: повтор строки`);
  // Сверка — обход страницами по 1000: перечень бывает длиннее одной страницы (журнал стенда — 2 000 записей)
  const whole = [];
  let wc = null, wn = 0;
  do {
    const r = get(`${path}${sep(path)}limit=1000${wc ? `&cursor=${encodeURIComponent(wc)}` : ""}`).body;
    whole.push(...r.items);
    wc = r.nextCursor || null;
  } while (wc && ++wn < 100);
  if (whole.length !== all.length) bad.push(`${path}: обход дал ${all.length} из ${whole.length}`);
  if (get(`${path}${sep(path)}limit=0`).status !== 422 || get(`${path}${sep(path)}limit=1001`).status !== 422) bad.push(`${path}: limit вне 1–1000`);
  if (get(`${path}${sep(path)}cursor=чужой`).body.code !== "INVALID_CURSOR") bad.push(`${path}: чужой курсор`);
}
// Пустая страница с живым nextCursor законна. Встроенный сервер дописывает страницу до limit или бюджета времени, и на demo
// её не бывает: стенд stand.sparsePages — бэкенд, который не дописывает (ровно scanPartsMax разделов на запрос)
s.handle("POST", "/test/reset", { fixture: "demo", fixturePatch: { stand: { sparsePages: true } } });
const cam = fx.devices.find((d) => d.type === "camera");
let empties = 0, cur = null;
do {
  const r = get(`${OBJ}?q=${encodeURIComponent(cam.name)}${cur ? `&cursor=${encodeURIComponent(cur)}` : ""}`).body;
  if (!r.items.length && r.nextCursor) empties++;
  cur = r.nextCursor || null;
} while (cur);
if (!empties) bad.push(`${OBJ}: нет пустой страницы с nextCursor`);
// Обе формы version
const a = fx.devices.find((d) => d.type === "camera" && !d.parentId && d.serverId);
const del = (id, version) => s.handle("POST", "/objects/delete", { idempotencyKey: `probe-${id}-${version}`, items: [{ id, version }] }).body;
const versionOf = (d) => get(`/units/${d.id}`).body.version;
if (del(a.id, versionOf(a) + "x").failed[0]?.code !== "VERSION_MISMATCH") bad.push("/objects/delete: чужая версия прошла");
// Объект — по Unit.version, правило — по Rule.version
if (del(a.id, versionOf(a)).done[0] !== a.id) bad.push("/objects/delete: форма Unit.version не принята");
const r = fx.rules[0];
if (del(r.id, get(`/rules/${r.id}`).body.version).done[0] !== r.id) bad.push("/objects/delete: форма Rule.version не принята");
console.log(JSON.stringify(bad));
process.exit(0);
