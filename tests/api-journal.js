/* Тесты API: поиск в журнале (0.8.0, возможность journalSearch) — текст, списки и «скрыть», группа и автор,
   страница вокруг записи, счётчики по полям, каталог видов. Записи — набора и стенда (stand.journal), если он есть. */
(() => {
  const { test, makeEnv, assert, FX } = ApiTest;
  const LEVELS = ["alarm", "error", "audit", "info", "service"];
  const levelOf = (e) => (LEVELS.includes(e.level) ? e.level : e.category === "audit" ? "audit" : e.category === "alarm" ? "alarm" : "info");
  const ids = (list) => list.map((e) => e.id);
  // Запись набора с текстом из нескольких слов: по ней проверяется синтаксис q
  const SAMPLE = FX.journal.find((e) => e.text.split(" ").length >= 3) || FX.journal[0];

  test("Журнал: q — слова (И), «|» (ИЛИ), фраза в кавычках, «-слово», регистр и «ё»", async () => {
    const env = await makeEnv();
    const [w1, w2] = SAMPLE.text.split(" ");
    const has = async (q) => ids(await env.list(`/journal?limit=1000&q=${encodeURIComponent(q)}`)).includes(SAMPLE.id);
    assert.ok(await has(`${w1} ${w2}`), `оба слова: «${w1} ${w2}»`);
    assert.ok(await has(`${w1.toUpperCase()} ${w2.replace(/е/g, "ё")}`), "регистр и «ё» не важны");
    assert.ok(await has(`"${w1} ${w2}"`), "фраза по порядку");
    assert.ok(!(await has(`"${w2} ${w1}"`)), "фраза в обратном порядке не находится");
    assert.ok(!(await has(`${w1} -${w2}`)), "«-слово» убирает запись");
    assert.ok(await has(`нетакогослова|${w1} ${w2}`), "ИЛИ: вторая группа находит");
    assert.ok(!(await has(`нетакогослова ${w1}`)), "И: лишнее слово не находит");
    const found = await env.list(`/journal?limit=1000&q=${encodeURIComponent(w1)}`);
    assert.ok(found.length > 0, "что-то найдено");
  }, { needs: ["feature:journalSearch", "listJournal"] });

  test("Журнал: списки через запятую и «скрыть» у category, kind, level; deviceMatch=exact", async () => {
    const env = await makeEnv();
    const two = await env.list("/journal?limit=1000&category=audit,alarm");
    assert.ok(two.length && two.every((e) => ["audit", "alarm"].includes(e.category)), "category: audit или alarm");
    assert.ok(two.some((e) => e.category === "audit") && two.some((e) => e.category === "alarm"), "есть обе");
    const notAudit = await env.list("/journal?limit=1000&categoryNot=audit");
    assert.ok(notAudit.length && notAudit.every((e) => e.category !== "audit"), "categoryNot");
    const all = await env.list("/journal?limit=1000");
    assert.eq(two.length + notAudit.filter((e) => e.category !== "alarm").length, all.length, "части дают целое");
    const kinds = [...new Set(all.map((e) => e.kind).filter(Boolean))].slice(0, 2);
    const byKind = await env.list(`/journal?limit=1000&kind=${kinds.join(",")}`);
    assert.eq(byKind.length, all.filter((e) => kinds.includes(e.kind)).length, `kind=${kinds.join(",")}`);
    const noKind = await env.list(`/journal?limit=1000&kindNot=${kinds[0]}`);
    assert.eq(noKind.length, all.filter((e) => e.kind !== kinds[0]).length, "kindNot");
    assert.ok(all.every((e) => LEVELS.includes(e.level)), "level у каждой записи из перечня");
    const lv = await env.list("/journal?limit=1000&level=audit,error");
    assert.eq(lv.length, all.filter((e) => ["audit", "error"].includes(levelOf(e))).length, "level списком");
    const noService = await env.list("/journal?limit=1000&levelNot=service");
    assert.ok(noService.every((e) => levelOf(e) !== "service"), "levelNot");
    const devs = [...new Set(all.map((e) => e.deviceId).filter(Boolean))].slice(0, 2);
    const exact = await env.list(`/journal?limit=1000&deviceMatch=exact&deviceId=${devs.join(",")}`);
    assert.eq(exact.length, all.filter((e) => devs.includes(e.deviceId)).length, "deviceId списком, точно");
    const notDev = await env.list(`/journal?limit=1000&deviceIdNot=${devs[0]}`);
    assert.eq(notDev.length, all.filter((e) => e.deviceId !== devs[0]).length, "deviceIdNot");
  }, { needs: ["feature:journalSearch", "listJournal"] });

  test("Журнал: автор — поле actor, отбор actor и actorNot", async () => {
    const env = await makeEnv();
    const all = await env.list("/journal?limit=1000");
    const who = all.find((e) => e.actor);
    if (!who) return assert.ok(true, "записей с автором в наборе нет — проверять нечего");
    assert.ok(all.every((e) => e.actor === undefined || typeof e.actor === "string"), "actor — строка");
    const mine = await env.list(`/journal?limit=1000&actor=${encodeURIComponent(who.actor)}`);
    assert.eq(mine.length, all.filter((e) => e.actor === who.actor).length, `actor=${who.actor}`);
    const other = await env.list(`/journal?limit=1000&actorNot=${encodeURIComponent(who.actor)}`);
    assert.eq(other.length, all.length - mine.length, "actorNot");
  }, { needs: ["feature:journalSearch", "listJournal"] });

  test("Журнал: around — страница вокруг записи, запись входит при любом отборе; нет записи — 404", async () => {
    const env = await makeEnv();
    const all = await env.list("/journal?limit=1000");
    const mid = all[Math.floor(all.length / 2)];
    const page = await env.ok("GET", `/journal?around=${mid.id}&limit=5`);
    assert.eq(ids(page.items), ids(all.slice(all.indexOf(mid) - 2, all.indexOf(mid) + 3)), "по две записи с каждой стороны");
    assert.ok(!page.nextCursor, "курсора нет");
    const top = await env.ok("GET", `/journal?around=${all[0].id}&limit=5`);
    assert.eq(ids(top.items), ids(all.slice(0, 5)), "у края — сколько есть");
    const other = mid.category === "audit" ? "alarm" : "audit";
    const f = await env.ok("GET", `/journal?around=${mid.id}&limit=7&category=${other}`);
    assert.ok(ids(f.items).includes(mid.id), "запись вне отбора входит");
    assert.ok(f.items.every((e) => e.id === mid.id || e.category === other), "остальные — по отбору");
    const none = await env.call("GET", "/journal?around=c9999999-0000-4000-8000-000000000000");
    assert.eq(none.status, 404, "нет записи");
  }, { needs: ["feature:journalSearch", "listJournal"] });

  test("Журнал: счётчики — total как у списка, поле без своего условия, periodTotal, facetLimit", async () => {
    const env = await makeEnv();
    const all = await env.list("/journal?limit=1000");
    const q = "level=audit,info";
    const f = await env.ok("GET", `/journal/facets?${q}`);
    assert.eq(f.total, (await env.list(`/journal?limit=1000&${q}`)).length, "total = записей списка");
    const byLevel = Object.fromEntries(f.facets.level.map((x) => [x.value, x.count]));
    LEVELS.forEach((l) => assert.eq(byLevel[l] || 0, all.filter((e) => levelOf(e) === l).length, `level ${l} — без условия на level`));
    assert.eq(f.periodTotal, all.filter((e) => levelOf(e) !== "service").length, "periodTotal: service скрыт условием level");
    assert.eq((await env.ok("GET", "/journal/facets")).periodTotal, all.length, "periodTotal без level — все");
    const kindSum = f.facets.kind.reduce((s, x) => s + x.count, 0);
    assert.eq(kindSum, f.total - all.filter((e) => ["audit", "info"].includes(levelOf(e)) && !e.kind).length, "сумма по kind — записи с kind");
    assert.ok(f.facets.kind.every((x, i, a) => !i || a[i - 1].count >= x.count), "больше — первыми");
    const k0 = f.facets.kind[0].value, fk = await env.ok("GET", `/journal/facets?${q}&kind=${encodeURIComponent(k0)}`);
    assert.eq(JSON.stringify(fk.facets.kind), JSON.stringify(f.facets.kind), "kind — без условия на kind");
    assert.eq(fk.total, f.facets.kind[0].count, "total — с условием на kind");
    const bad = await env.list("/journal?limit=1000&from=garbage");
    assert.eq(bad.length, 0, "from не дата — записей нет, как до 0.8.0");
    const cut = await env.ok("GET", "/journal/facets?facetLimit=1");
    assert.ok(Object.values(cut.facets).every((a) => a.length <= 1), "facetLimit режет");
    const kinds = new Set(all.map((e) => e.kind).filter(Boolean)).size;
    if (kinds > 1) assert.eq(cut.more.kind, kinds - 1, "more — сколько не вошло");
    assert.eq((await env.call("GET", "/journal/facets?facetLimit=0")).status, 422, "facetLimit=0 — 422");
  }, { needs: ["feature:journalSearch", "listJournalFacets"] });

  test("Журнал: каталог видов — код, подпись Text, группа; коды не повторяются", async () => {
    const env = await makeEnv();
    const list = (await env.ok("GET", "/journal/kinds")).items;
    assert.ok(list.length > 0, "каталог не пуст");
    assert.eq(new Set(list.map((k) => k.id)).size, list.length, "коды не повторяются");
    assert.ok(list.every((k) => k.label && typeof k.label.text === "string" && k.label.text && LEVELS.includes(k.level)), "подпись и группа");
    const known = new Set(list.map((k) => k.id));
    const events = FX.kinds.flatMap((k) => (k.events || []).map((e) => e.id));
    assert.ok(events.every((id) => known.has(id)), "события видов объектов — в каталоге");
  }, { needs: ["listJournalKinds"] });

  test("Журнал: страницы назад — prevCursor и offset (0.9.0)", async () => {
    const env = await makeEnv();
    const all = await env.list("/journal?limit=1000&level=audit,info");
    const p1 = await env.ok("GET", "/journal?limit=5&level=audit,info");
    assert.ok(!p1.prevCursor, "у первой страницы prevCursor нет");
    if (p1.offset !== undefined) assert.eq(p1.offset, 0, "offset первой страницы");
    const p2 = await env.ok("GET", `/journal?limit=5&level=audit,info&cursor=${encodeURIComponent(p1.nextCursor)}`);
    const p3 = await env.ok("GET", `/journal?limit=5&level=audit,info&cursor=${encodeURIComponent(p2.nextCursor)}`);
    assert.eq(ids(p3.items), ids(all.slice(10, 15)), "третья страница по nextCursor");
    if (p3.offset !== undefined) assert.eq(p3.offset, 10, "offset третьей страницы");
    assert.ok(p3.prevCursor, "у третьей страницы есть prevCursor");
    const back = await env.ok("GET", `/journal?limit=5&level=audit,info&cursor=${encodeURIComponent(p3.prevCursor)}`);
    assert.eq(ids(back.items), ids(p2.items), "prevCursor — предыдущая страница");
    const first = await env.ok("GET", `/journal?limit=5&level=audit,info&cursor=${encodeURIComponent(back.prevCursor)}`);
    assert.eq(ids(first.items), ids(p1.items), "назад до первой");
    assert.ok(!first.prevCursor, "у первой — без prevCursor");
    const wide = await env.ok("GET", `/journal?limit=12&level=audit,info&cursor=${encodeURIComponent(p3.prevCursor)}`);
    assert.eq(ids(wide.items), ids(all.slice(0, 12)), "назад у начала — первая страница целиком");
  }, { needs: ["feature:journalSearch", "feature:journalAudit", "listJournal"] });

  test("Журнал: аудит — изменение через API даёт запись: кто, адрес, операция, «было → стало» (0.9.0)", async () => {
    const env = await makeEnv();
    const me = await env.ok("GET", "/me");
    const all = await env.list("/journal?limit=1000");
    assert.ok(all.every((e) => typeof e.actor === "string" && e.actor), "автор у каждой записи");
    const cam = (await env.ok("GET", "/units?kind=camera&limit=1")).items[0];
    await env.ok("PATCH", `/units/${cam.uid}`, { name: `${cam.name} (проба)` }, { "If-Match": `"${cam.version}"` });
    const top = (await env.ok("GET", "/journal?limit=1")).items[0];
    assert.eq(top.kind, "api.patchUnit", "вид записи — операция");
    assert.eq(top.level, "audit", "группа — аудит");
    assert.eq(top.actor, me.login, "кто — пользователь запроса");
    assert.eq(top.deviceId, cam.uid, "объект записи");
    assert.ok(top.fields && top.fields.ip, "адрес запроса");
    assert.eq(top.fields.operation, "patchUnit", "operation");
    assert.eq(JSON.stringify(top.fields.change), JSON.stringify({ field: "Имя", before: cam.name, after: `${cam.name} (проба)` }), "было → стало");
    const kinds = (await env.ok("GET", "/journal/kinds")).items;
    assert.ok(kinds.some((k) => k.id === "api.patchUnit" && k.level === "audit"), "вид записи — в каталоге");
    const mine = await env.list(`/journal?limit=1000&actor=${encodeURIComponent(me.login)}&kind=api.patchUnit`);
    assert.ok(mine.some((e) => e.id === top.id), "отбор по автору находит запись");
  }, { needs: ["feature:journalSearch", "feature:journalAudit", "listJournal", "patchUnit"] });

  test("Журнал: аудит — секреты не попадают в запись и в CSV; каждое удаление — своя запись с именем (0.9.0)", async () => {
    const env = await makeEnv();
    const r = (await env.ok("GET", "/rules?limit=1")).items[0];
    const got = await env.call("GET", `/rules/${r.id}`);
    const body = JSON.parse(JSON.stringify(got.body));
    ["id", "version", "status", "createdAt", "createdBy", "changedAt", "changedBy", "mute", "order"].forEach((k) => delete body[k]);
    body.steps = [{ source: "net", action: "http", method: "POST", url: "https://admin:S3cr3tPw@hook.example/x?token=abc123", auth: "bearer", headers: "Authorization: Bearer TOPSECRET" }];
    await env.ok("PUT", `/rules/${r.id}`, body, { "If-Match": `"${got.body.version}"` });
    const top = (await env.ok("GET", "/journal?limit=1")).items[0];
    assert.eq(top.kind, "api.putRule", "запись о правиле");
    assert.eq(top.fields.ruleId, r.id, "ссылка на правило");
    const csv = await env.call("GET", "/journal/export?level=audit");
    const text = JSON.stringify(top) + (csv.status === 200 ? csv.body : "");
    assert.ok(!/S3cr3tPw|TOPSECRET|abc123/.test(text), "пароль в адресе, заголовок и токен скрыты");
    const sched = (await env.ok("GET", "/schedules?limit=3")).items.slice(0, 2);
    for (const x of sched) await env.ok("DELETE", `/schedules/${x.id}`, undefined, { "If-Match": `"${x.version}"` });
    const del = (await env.ok("GET", "/journal?limit=5&kind=api.deleteSchedule")).items;
    assert.eq(del.length, sched.length, "каждое удаление — своя запись");
    assert.ok(sched.every((x) => del.some((e) => e.text.includes(x.name))), "в записи — имя удалённого");
  }, { needs: ["feature:journalSearch", "feature:journalAudit", "listJournal", "getRule", "putRule", "deleteSchedule", "exportJournal"] });

  test("Журнал: выгрузка CSV — весь отбор, время со смещением пояса, «Кто», защита от формул (0.9.0)", async () => {
    const env = await makeEnv();
    const list = await env.list("/journal?limit=1000&level=audit");
    const res = await env.call("GET", "/journal/export?level=audit&tz=Asia/Tokyo&delimiter=%3B&lang=en");
    assert.eq(res.status, 200, "ответ 200");
    assert.ok(/text\/csv/.test(res.headers["content-type"] || ""), "тип text/csv");
    assert.ok(/attachment; filename="journal-\d{8}-\d{4}\.csv"/.test(res.headers["content-disposition"] || ""), "имя файла");
    const lines = res.body.replace(/^\ufeff/, "").split("\r\n").filter(Boolean);
    assert.eq(lines.length, list.length + 1, "заголовок и все записи отбора");
    assert.eq(lines[0].split(";")[0], "ID", "заголовок по lang");
    const row = lines[1].split(";");
    assert.eq(row[0], list[0].id, "новые первыми");
    assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/.test(row[1]), `время со смещением tz: ${row[1]}`);
    assert.eq(Date.parse(row[1]), Date.parse(list[0].occurredAt || list[0].at), "то же мгновение");
    assert.ok(lines.slice(1).every((l) => !/^[=+@-]/.test(l.split(";").pop())), "описание не начинается с формулы");
    const top = (await env.ok("GET", "/journal?limit=1")).items[0];
    assert.eq(top.kind, "jexport", "выгрузка — запись аудита");
    assert.eq((await env.call("GET", "/journal/export?tz=Mars/Base")).status, 422, "неизвестный пояс — 422");
  }, { needs: ["feature:journalSearch", "exportJournal"] });

  ApiTest.loaded("api-journal.js");
})();
