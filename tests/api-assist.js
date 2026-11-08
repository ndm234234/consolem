/* Тесты API: ассистент — ход разговора потоком, вопрос, план, отказ, ошибка, секрет. Мир ассистента — объекты (Unit)
   и описания видов (UnitKind): шаг плана — {uid, version, patch} как PATCH /units/{uid}, отбор — фильтры GET /units. */
(() => {
  const { test, makeEnv, assert } = ApiTest;
  const NEED = { needs: ["assistTurn"] };
  const types = (got) => got.map((m) => m.type).join(",");
  const CTRL = "security_controller/CONTROLLER";
  const byName = (list) => list.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.uid < b.uid ? -1 : 1)).map((u) => u.uid);
  const kindOf = async (env, kind) => (await env.ok("GET", "/kinds")).items.find((k) => k.kind === kind);
  // Отбор found с filter — те же фильтры GET /units: списки через запятую, флаги — true
  const unitsQuery = (f) => {
    const name = { kinds: "kind" };
    return Object.entries(f).map(([k, v]) => `${name[k] || k}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : String(v))}`).join("&");
  };

  test("Ассистент: план на камеры — шаги {uid, version, patch}, «Применить» — POST /operations шагами patch, старый план — 412 VERSION_MISMATCH", async () => {
    const env = await makeEnv();
    const got = await env.stream("/assist/turns", { text: "выключи запись на камерах Главный вход" });
    const plan = got[got.length - 1];
    assert.eq(plan.type, "plan", "последнее сообщение");
    assert.ok(got[0].type === "progress", "сначала ход работы");
    assert.ok(plan.items.length > 0, "камеры выбраны");
    for (const x of plan.items) {
      const u = await env.ok("GET", `/units/${x.uid}`);
      assert.eq([u.kind, u.version, x.name, "deviceId" in x, "set" in x], ["camera", x.version, u.name, false, false], "шаг — объект по uid и его версия");
      assert.eq(x.patch, { properties: { recordMode: "none" } }, "patch — JSON Merge Patch объекта");
      assert.eq(x.changes, [{ field: "/properties/recordMode", before: u.properties.recordMode, after: "none", why: "просьба" }], "поле — JSON Pointer");
    }
    const items = plan.items.map(({ uid, patch }) => ({ uid, patch }));
    const expectedVersions = Object.fromEntries(plan.items.map((x) => [x.uid, x.version]));
    const op = await env.runOperation({ idempotencyKey: ApiTest.key(), items, expectedVersions });
    // План сверен со схемой вида; смысл профиля (камера сервера без связи) судит шаг при выполнении
    const ok = op.items.filter((x) => x.state === "ok"), fail = op.items.filter((x) => x.state !== "ok");
    assert.ok(ok.length > 0 && fail.every((x) => x.state === "fail" && x.code === "SERVER_OFFLINE"), "применено, кроме камер сервера без связи: " + JSON.stringify(fail));
    for (const x of ok) assert.eq((await env.ok("GET", `/units/${x.targetId}`)).properties.recordMode, "none", "значение");
    const again = await env.call("POST", "/operations", { idempotencyKey: ApiTest.key(), items, expectedVersions });
    assert.status(again, 412, "VERSION_MISMATCH", "объект изменился после плана");
    return `объектов ${items.length}`;
  }, NEED);

  test("Ассистент: вопрос, ответ с context — план; разговор держит клиент", async () => {
    const env = await makeEnv();
    const first = await env.stream("/assist/turns", { text: "включи запись" });
    const q = first[first.length - 1];
    assert.eq([q.type, q.text], ["question", "На каких объектах?"], "уточнение");
    const second = await env.stream("/assist/turns", { text: "Главный вход", context: q.context });
    const plan = second[second.length - 1];
    assert.eq(plan.type, "plan", "по ответу — план");
    assert.ok(plan.items.every((x) => x.patch.properties.recordMode === "always"), "включить запись — режим «всегда»");
    return types(first);
  }, NEED);

  test("Ассистент: отказ по полю и ошибка завершают поток", async () => {
    const env = await makeEnv();
    // Поле ищется по подписям схем видов просьбы: у камеры маски сети нет (она есть у сервера), цвета корпуса нет ни у кого
    for (const text of ["поменяй маску сети на камерах", "поменяй цвет корпуса"]) {
      const end = (await env.stream("/assist/turns", { text })).pop();
      assert.eq([end.type, "field" in end, "items" in end], ["refused", false, false], `«${text}» — поля нет в описании вида: отказ без указателя`);
    }
    const server = (await env.stream("/assist/turns", { text: "поменяй маску сети" })).pop();
    assert.eq([server.type, server.text], ["question", "Какое значение поставить?"], "у сервера поле есть — спросить значение");
    const bad = await env.stream("/assist/turns", { text: "сбой" });
    assert.eq(bad[bad.length - 1].code, "UPSTREAM_UNAVAILABLE", "ошибка");
  }, NEED);

  test("Ассистент: секрет идёт в patch и не показывается в пояснении и в context", async () => {
    const env = await makeEnv();
    const got = await env.stream("/assist/turns", { text: "смени пароль Главный вход на секрет № 2", secrets: ["первый", "второй-S3CRET"] });
    const plan = got[got.length - 1];
    assert.eq(plan.type, "plan", "план");
    assert.eq(plan.items[0].patch.properties.password, "второй-S3CRET", "значение в patch");
    assert.eq(plan.items[0].changes[0].field, "/properties/password", "поле — указатель");
    const shown = JSON.stringify([plan.summary, plan.context, plan.items.map((x) => x.changes)]);
    assert.ok(!shown.includes("S3CRET"), "значения нет в пояснении и context");
    assert.ok(!("before" in plan.items[0].changes[0]), "«было» у секрета нет");
    const q = (await env.stream("/assist/turns", { text: "смени пароль Главный вход на секрет № 3", secrets: ["первый"] })).pop();
    assert.eq([q.type, q.text], ["question", "Какой секрет поставить?"], "секрета с таким номером нет — вопрос");
  }, NEED);

  test("Ассистент: пустая просьба — 422", async () => {
    const env = await makeEnv();
    assert.status(await env.call("POST", "/assist/turns", { text: "" }), 422, "VALIDATION_FAILED");
  }, NEED);

  /* ----- Незнакомый вид: всё из описания вида (подписи, перечни, x-search), кода под вид в заглушке нет ----- */

  test("Ассистент: просьба «смени режим контроллера на manual» — шаг плана с patch /properties/mode, значение из enum схемы", async () => {
    const env = await makeEnv();
    const kind = await kindOf(env, CTRL);
    const mode = kind.schema.properties.mode;
    const ctrls = (await env.pages(`/units?kind=${encodeURIComponent(CTRL)}`));
    const want = ctrls.filter((u) => u.properties.mode !== "manual");
    assert.ok(want.length > 0 && want.length < ctrls.length, "есть и в ручном режиме, и нет: " + want.length + " из " + ctrls.length);
    const plan = (await env.stream("/assist/turns", { text: "смени режим контроллера на manual" })).pop();
    assert.eq(plan.type, "plan", "план");
    assert.eq(plan.items.map((x) => x.uid).sort(), want.map((u) => u.uid).sort(), "контроллеры, где режим не тот; уже в ручном — не в плане");
    for (const x of plan.items) {
      const u = ctrls.find((c) => c.uid === x.uid);
      assert.eq([x.version, x.name, x.patch], [u.version, u.name, { properties: { mode: "manual" } }], "шаг: версия, имя, patch");
      assert.eq(x.changes, [{ field: "/properties/mode", before: u.properties.mode, after: "manual", why: "просьба" }], "что меняется");
      assert.ok(mode.enum.includes(x.patch.properties.mode), "значение из enum схемы");
    }
    // Подпись значения (x-enum-labels) — то же значение
    const byLabel = (await env.stream("/assist/turns", { text: `смени режим контроллера на ${mode["x-enum-labels"].manual.text.toLowerCase()}` })).pop();
    assert.eq(byLabel.items.map((x) => x.patch), plan.items.map((x) => x.patch), "значение по подписи перечня");
    // «Применить» — PATCH /units/{uid} с версией плана
    const [x] = plan.items;
    const done = await env.ok("PATCH", `/units/${x.uid}`, x.patch, { "If-Match": `"${x.version}"` });
    assert.eq(done.properties.mode, "manual", "записано");
    return `контроллеров ${plan.items.length}`;
  }, Object.assign({}, NEED, { needs: ["assistTurn", `kind:${CTRL}`] }));

  test("Ассистент: план со значением вне схемы отклоняется 422 с указателем", async () => {
    const env = await makeEnv();
    const plan = (await env.stream("/assist/turns", { text: "смени режим контроллера на manual" })).pop();
    const [x] = plan.items;
    // Шаг плана — ровно PATCH /units/{uid}: значение вне перечня схемы — 422 с указателем на поле, ничего не записано
    const bad = await env.call("PATCH", `/units/${x.uid}`, { properties: { mode: "turbo" } }, { "If-Match": `"${x.version}"` });
    assert.status(bad, 422, "VALIDATION_FAILED", "значение вне enum");
    assert.eq(bad.body.field, "/properties/mode", "указатель на поле");
    assert.eq((await env.ok("GET", `/units/${x.uid}`)).version, x.version, "ничего не записано");
    // Заглушка сверяет план с описанием вида, как PATCH: вне схемы — отказ с тем же указателем, плана нет
    const no = (await env.stream("/assist/turns", { text: "смени режим контроллера на turbo" })).pop();
    assert.eq([no.type, no.field, "items" in no], ["refused", "/properties/mode", false], "отказ с указателем");
    assert.ok(/turbo/.test(no.text), "отказ называет значение: " + no.text);
  }, { needs: ["assistTurn", `kind:${CTRL}`] });

  test("Ассистент: просьба «поставь контроллеры на охрану» — найденное фильтром kinds=[security_controller/CONTROLLER]", async () => {
    const env = await makeEnv();
    const ctrls = await env.pages(`/units?kind=${encodeURIComponent(CTRL)}`);
    const before = JSON.stringify(ctrls.map((u) => u.version));
    const got = await env.stream("/assist/turns", { text: "поставь контроллеры на охрану" });
    const end = got[got.length - 1];
    assert.eq(types(got), "progress,found", "отбор, а не план");
    assert.eq(end.filter, { kinds: [CTRL] }, "фильтр — вид из описания");
    assert.eq(["ids" in end, end.action, end.total, end.conditions], [false, "ARM", ctrls.length, ["тип: контроллер"]], "команда вида, сколько, условия словами");
    const listed = await env.pages(`/units?${unitsQuery(end.filter)}`);
    assert.eq(listed.map((u) => u.uid).sort(), ctrls.map((u) => u.uid).sort(), "фильтр — тот же отбор GET /units");
    assert.eq(JSON.stringify((await env.pages(`/units?kind=${encodeURIComponent(CTRL)}`)).map((u) => u.version)), before, "ход ничего не выполнил");
  }, { needs: ["assistTurn", `kind:${CTRL}`] });

  test("Ассистент: команда «Включить» у вида не перехватывает правку свойства — «включи запись» остаётся правкой, «Включить контроллеры» — отбор с action", async () => {
    const env = await makeEnv();
    const kinds = (await env.ok("GET", "/kinds")).items;
    // У камеры и у контроллера появилась команда с подписью «Включить»: первые пять букв — как у «включи»
    for (const kind of ["camera", CTRL]) {
      const desc = JSON.parse(JSON.stringify(kinds.find((k) => k.kind === kind)));
      desc.actions = (desc.actions || []).concat({ id: "POWER_ON", label: { key: "test.action.on", text: "Включить", lang: "ru" }, execution: "instant", group: true });
      assert.status(await env.call("PUT", `/test/kinds/${encodeURIComponent(kind)}`, desc), 200, null, `у вида ${kind} — команда «Включить»`);
    }
    const q = (await env.stream("/assist/turns", { text: "включи запись" })).pop();
    assert.eq([q.type, q.text], ["question", "На каких объектах?"], "«включи запись» — правка: вопрос, не отбор");
    const plan = (await env.stream("/assist/turns", { text: "включи запись на камерах Главный вход" })).pop();
    assert.ok(plan.type === "plan" && plan.items.length && plan.items.every((x) => x.patch.properties.recordMode === "always"), "с объектами — план правки: " + plan.type);
    assert.eq(plan.summary, `Камеры: ${plan.items.length}`, "итог — как у базы: «Камеры: N»");
    const ctrls = await env.pages(`/units?kind=${encodeURIComponent(CTRL)}`);
    const got = await env.stream("/assist/turns", { text: "Включить контроллеры" });
    const end = got[got.length - 1];
    assert.eq([types(got), end.action, end.filter, end.total], ["progress,found", "POWER_ON", { kinds: [CTRL] }, ctrls.length], "подпись команды, свойства нет — отбор с action");
  }, { needs: ["assistTurn", `kind:${CTRL}`] });

  /* ----- План правил ----- */

  const FX = ApiTest.FX;
  const RULE_WRITE = ["name", "enabled", "logOnly", "logOnlySince", "start", "runMode", "operatorMenu", "ratePerMinute", "windowSec", "runAt", "repeat",
    "triggers", "conditions", "steps", "owner", "purpose", "serverId", "runAsRoleId", "allowChain", "labels", "validForSec"];
  const DEFAULTS = { enabled: true, logOnly: false, logOnlySince: null, start: "event", runMode: "always", operatorMenu: false, ratePerMinute: 6, windowSec: 0, runAt: null,
    repeat: "skip", triggers: [], conditions: [], steps: [], owner: "", purpose: "", serverId: null, runAsRoleId: null, allowChain: true };
  const pick = (r) => Object.fromEntries(RULE_WRITE.filter((k) => k in r).map((k) => [k, r[k]]));
  const lastOf = (got) => got[got.length - 1];
  const turn = (env, text, extra) => env.stream("/assist/turns", Object.assign({ text }, extra || {}));
  const camera = "Главный вход";
  const named = FX.rules.find((r) => r.name === "Охрана входа ночью");

  test("Что за реплика, решает сервер: поля kind в запросе нет, слова правил — план правил, иначе настройка", async () => {
    const env = await makeEnv();
    const said = `при движении на ${camera} пиши 5 минут`;
    const plain = lastOf(await env.stream("/assist/turns", { text: "выключи запись на камерах Главный вход" }));
    assert.ok(plain.type === "plan" && plain.items.length && !("rules" in plain), "настройка объектов");
    const rules = lastOf(await turn(env, said));
    assert.ok(rules.type === "plan" && rules.rules.length === 1 && !("items" in rules), "слова правил — план правил");
    for (const kind of ["config", "rules", "auto", "explain"]) {
      const bad = await env.call("POST", "/assist/turns", { text: said, kind });
      assert.eq([bad.status, bad.body.code], [422, "VALIDATION_FAILED"], `kind: ${kind} — поля нет в контракте`);
      assert.ok(/kind/.test(bad.body.message), "слово отказа называет поле: " + bad.body.message);
    }
  }, NEED);

  test("Вопрос о системе: «сколько», «какие» — answer без плана; в одном разговоре и вопрос, и правка; типа в событиях нет", async () => {
    const env = await makeEnv();
    const ask = (text, extra) => env.stream("/assist/turns", Object.assign({ text }, extra || {}));
    const seen = [];
    const total = (await env.ok("GET", "/units?limit=1")).total, cams = (await env.pages("/units?kind=camera&limit=1000")).length, ctx = [];
    for (const [text, also] of [["сколько камер", `Камера: ${cams}`], ["сколько объектов", ""], ["какие устройства есть", ""]]) {
      const got = await ask(text);
      seen.push(...got);
      const end = lastOf(got);
      assert.eq(types(got), "progress,answer", `«${text}» — вопрос о системе`);
      assert.ok(end.text.includes(`Объектов: ${total}`) && end.text.includes(also) && typeof end.context === "string", "ответ и context: " + end.text);
      ctx.push(end.context);
    }
    const next = await ask("а правил?", { context: ctx[0] });
    seen.push(...next);
    assert.ok(lastOf(next).type === "answer" && lastOf(next).text === `Правил: ${(await env.list("/rules")).length}.`, "разговор идёт с context: " + lastOf(next).text);
    // Тот же разговор: после вопроса — правка, тип выбран по реплике
    const edit = await ask("выключи запись на камерах Главный вход");
    seen.push(...edit);
    assert.ok(lastOf(edit).type === "plan" && lastOf(edit).items.length, "после вопроса — план настройки");
    const rule = await ask(`при движении на ${camera} пиши 5 минут`, { context: lastOf(edit).context });
    seen.push(...rule);
    assert.ok(lastOf(rule).type === "plan" && lastOf(rule).rules.length, "дальше — план правил");
    assert.ok(seen.every((m) => !("kind" in m)), "поля kind в событиях нет");
    return `событий ${seen.length}`;
  }, NEED);

  test("Отбор: «дай список», «покажи», «выведи» — found, условия — фильтры GET /units и описания видов, ids по имени без повторов", async () => {
    const env = await makeEnv();
    const ask = (text, extra) => env.stream("/assist/turns", Object.assign({ text }, extra || {}));
    const units = (q) => env.pages(`/units?${q}${q ? "&" : ""}limit=1000`);
    const cams = await units("kind=camera");
    const before = JSON.stringify(cams.map((d) => d.version));
    const check = async (text, words, want) => {
      const got = await ask(text);
      const end = lastOf(got);
      assert.eq(types(got), "progress,found", `«${text}» — отбор`);
      assert.eq(end.conditions, words, `условия словами: «${text}»`);
      assert.eq(end.ids, byName(want), `ids по имени: «${text}»`);
      assert.eq([end.total, new Set(end.ids).size, "truncated" in end, "filter" in end, "kind" in end], [want.length, end.ids.length, false, false, false], "total, без повторов, одна форма");
      return end;
    };
    const none = await check("выведи камеры без записи", ["тип: камера", "запись: нет"], await units("kind=camera&noRecord=true"));
    assert.ok(none.ids.length > 0 && /Отобрано: \d+/.test(none.text), "текст: " + none.text);
    // Значение свойства с x-search — подпись из схемы (x-label), отбор — q и fields
    await check("дай список камер Axis", ["тип: камера", "производитель: Axis"], await units("kind=camera&q=Axis&fields=vendor"));
    await check("покажи выключенные камеры", ["тип: камера", "включена: нет"], await units("kind=camera&status=off"));
    await check("выведи камеры не на связи", ["тип: камера", "на связи: нет"], await units("kind=camera&status=offline"));
    const folder = (await units("kind=folder")).find((f) => f.name === "Склад хозчасти");
    await check("покажи камеры в папке Склад хозчасти", ["тип: камера", "папка: Склад хозчасти"], await units(`kind=camera&folderId=${folder.uid}`));
    const domain = (await units("kind=domain")).find((d) => d.name === "Домен 2");
    await check("выведи камеры в домене Домен 2", ["тип: камера", "домен: Домен 2"], await units(`kind=camera&domainId=${domain.uid}`));
    await check("покажи камеры без папки", ["тип: камера", "папка: нет"], await units("kind=camera&noFolder=true"));
    await check("выведи камеры с именем «вход»", ["тип: камера", "имя содержит: вход"], await units("kind=camera&q=" + encodeURIComponent("вход") + "&fields=name"));
    // Без детектора вида — подпись вида детектора из перечня схемы
    const noMotion = await check("выведи камеры без детектора движения", ["тип: камера", "детектор движения: нет"], await units("kind=camera&noDetector=motion"));
    assert.ok(noMotion.ids.length > 0 && noMotion.ids.length < cams.length, "есть и с детектором, и без: " + noMotion.ids.length + " из " + cams.length);
    // Перечень свойства по подписи (x-enum-labels) — у любого вида
    await check("покажи камеры, которые пишут всегда", ["тип: камера", "когда писать: всегда"], cams.filter((u) => u.properties.recordMode === "always"));
    const ctrls = await units(`kind=${encodeURIComponent(CTRL)}`);
    await check("покажи контроллеры в ручном режиме", ["тип: контроллер", "режим: ручной"], ctrls.filter((u) => u.properties.mode === "manual"));
    // Незнакомый вид: значение его свойства с x-search, вид просьбы не назван
    const unknown = await units("kind=test.unknown");
    await check("выведи TU-0001", ["серийный номер: TU-0001"], unknown.filter((u) => u.properties.serial === "TU-0001"));
    // Найдено 0 — тоже found, не отказ
    const empty = lastOf(await ask("покажи камеры с именем «такого нет»"));
    assert.eq([empty.type, empty.ids, empty.total, empty.text], ["found", [], 0, "Ничего не отобрано."], "пусто — found с пустым ids");
    // Разговор продолжается с context: уточнить отбор
    const more = lastOf(await ask("а только Axis", { context: none.context }));
    assert.eq(more.conditions, ["тип: камера", "запись: нет", "производитель: Axis"], "уточнение с context");
    assert.eq(more.ids, byName(await units("kind=camera&noRecord=true&q=Axis&fields=vendor")), "уточнённый отбор");
    // Не понял условие — вопрос
    const q = lastOf(await ask("покажи что-нибудь"));
    assert.eq(q.type, "question", "без условия — вопрос");
    // Отбор ничего не пишет
    assert.eq(JSON.stringify((await units("kind=camera")).map((d) => d.version)), before, "версии камер прежние");
    return `отобрано без записи ${none.ids.length}`;
  }, { needs: ["assistTurn", `kind:${CTRL}`, "kind:test.unknown"] });

  test("Отбор больше selectMax: фильтр GET /units, если условия выражаются фильтром; иначе первые ids и truncated", async () => {
    const env = await makeEnv({ fixturePatch: { reference: { limits: { selectMax: 3 } } } });
    const all = await env.pages("/units?kind=camera&noRecord=true&limit=1000");
    assert.ok(all.length > 3, "камер без записи больше selectMax: " + all.length);
    const end = (await env.stream("/assist/turns", { text: "выведи камеры без записи" })).pop();
    assert.eq([end.type, end.filter, "ids" in end, end.total, end.conditions], ["found", { kinds: ["camera"], noRecord: true }, false, all.length, ["тип: камера", "запись: нет"]], "фильтр вместо ids");
    assert.eq((await env.pages(`/units?${unitsQuery(end.filter)}&limit=1000`)).map((u) => u.uid).sort(), all.map((u) => u.uid).sort(), "фильтр — тот же отбор");
    // Перечень по подписи — не фильтр GET /units: первые по имени и truncated
    const cams = (await env.pages("/units?kind=camera&limit=1000")).filter((u) => u.properties.recordMode === "always");
    const cut = (await env.stream("/assist/turns", { text: "покажи камеры, которые пишут всегда" })).pop();
    assert.eq([cut.ids, cut.total, cut.truncated, "filter" in cut], [byName(cams).slice(0, 3), cams.length, true, false], "первые selectMax и truncated");
  }, NEED);

  test("GET /units?noDetector — без детектора вообще (true) или без детектора этого вида (код из перечня detectorKind)", async () => {
    const env = await makeEnv();
    const cams = await env.pages("/units?kind=camera&limit=1000");
    const dets = (await env.pages("/units?implements=vms.detector/1&limit=1000"));
    const kindsOf = (uid) => new Set(dets.filter((x) => x.parentId === uid || Object.values(x.properties).includes(uid)).map((x) => x.properties.detectorKind));
    const rows = await env.pages("/units?noDetector=motion&limit=1000");
    const want = cams.filter((u) => !kindsOf(u.uid).has("motion")).map((u) => u.uid).sort();
    assert.eq(rows.map((r) => r.uid).sort(), want, "noDetector=motion — камеры без детектора движения");
    assert.ok(rows.every((r) => r.kind === "camera") && want.length < cams.length, "только камеры, не все");
    const bare = await env.pages("/units?noDetector=true&limit=1000");
    assert.eq(bare.map((r) => r.uid).sort(), cams.filter((u) => !kindsOf(u.uid).size).map((u) => u.uid).sort(), "noDetector=true — без детекторов");
    const page = await env.ok("GET", "/units?noDetector=motion&limit=5");
    assert.ok(!("total" in page), "полного числа нет: ограниченный проход");
    const nope = await env.call("GET", "/units?noDetector=nope");
    assert.status(nope, 422, "VALIDATION_FAILED");
    assert.eq(nope.body.field, "noDetector", "поле");
    return `без детектора движения ${want.length} из ${cams.length}`;
  }, NEED);

  test("План правил: новое правило — запись плана словами контракта, ход ничего не пишет, заведено logOnly", async () => {
    const env = await makeEnv();
    const before = (await env.list("/rules")).length;
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "rule" && seen.push(m.type));
    await ApiTest.settle();
    const plan = lastOf(await turn(env, `при движении на ${camera} пиши 5 минут`));
    const [e] = plan.rules;
    assert.eq([e.table, e.op, "id" in e], ["scenarios", "create", false], "запись плана");
    const [t] = e.body.triggers, [s] = e.body.steps;
    assert.eq([e.body.enabled, e.body.logOnly, t.source, t.event, s.type, s.action, s.params.minutes], [true, true, "unit", "motion", "unitAction", "record", 5], "поля Rule: событие и действие вида");
    assert.eq((await env.list("/rules")).length, before, "ход ничего не записал");
    await ApiTest.settle();
    assert.eq(seen, [], "событий нет");
    const made = await env.ok("POST", "/rules", Object.assign({}, DEFAULTS, e.body));
    stop();
    assert.eq([made.enabled, made.logOnly, made.owner, made.serverId, made.runAsRoleId], [true, true, "", null, null], "заведено наблюдающим, умолчания перевода");
  }, NEED);

  test("План правил: просили выключенным — выключенным", async () => {
    const env = await makeEnv();
    const [e] = lastOf(await turn(env, `при движении на ${camera} пиши 5 минут, заведи выключенным`)).rules;
    assert.eq([e.body.enabled, "logOnly" in e.body], [false, false], "план");
    const made = await env.ok("POST", "/rules", Object.assign({}, DEFAULTS, e.body));
    assert.eq([made.enabled, "status" in made], [false, false], "не следит");
  }, NEED);

  test("План правил: правка — только изменённые поля, PUT целиком с версией, чужая версия — 412 VERSION_MISMATCH", async () => {
    const env = await makeEnv();
    const [e] = lastOf(await turn(env, `в правиле ${named.name} убери условия`)).rules;
    assert.eq([e.table, e.op, e.id, Object.keys(e.body)], ["scenarios", "update", named.id, ["conditions"]], "запись плана");
    const read = await env.ok("GET", `/rules/${e.id}`);
    assert.eq(read.conditions.length, named.conditions.length, "ход ничего не записал");
    const done = await env.ok("PUT", `/rules/${e.id}`, Object.assign(pick(read), e.body), { "If-Match": `"${read.version}"` });
    assert.eq([done.conditions, done.logOnly, done.enabled, done.steps.length], [[], read.logOnly, read.enabled, read.steps.length], "прочее на месте, наблюдения не завелось");
    const stale = await env.call("PUT", `/rules/${e.id}`, Object.assign(pick(read), { ratePerMinute: 7 }), { "If-Match": `"${read.version}"` });
    assert.status(stale, 412, "VERSION_MISMATCH");
    assert.eq(stale.body.current.version, done.version, "актуальная запись в ответе");
    assert.eq((await env.ok("GET", `/rules/${e.id}`)).ratePerMinute, read.ratePerMinute, "чужая версия ничего не записала");
  }, NEED);

  test("План правил: новое расписание — запись с ref, правило ссылается на него «@ref»", async () => {
    const env = await makeEnv();
    const plan = lastOf(await turn(env, `при движении на ${camera} пиши 5 минут, новое расписание`));
    const [s, r] = plan.rules;
    assert.eq([s.table, s.op, s.ref, r.body.conditions[0].scheduleId], ["schedules", "create", "shift", "@shift"], "порядок и ссылка");
    assert.ok(!(await env.list("/schedules")).some((x) => x.name === s.body.name), "расписания нет");
    const sc = await env.ok("POST", "/schedules", s.body);
    const made = await env.ok("POST", "/rules", Object.assign({}, DEFAULTS, r.body, { conditions: [{ kind: "time", scheduleId: sc.id }] }));
    assert.eq(made.conditions[0].scheduleId, sc.id, "ссылка подставлена");
  }, NEED);

  test("План правил: окно со ссылкой на новое расписание — строка объектом в теле окна, POST /schedules нет; новое окно выключено", async () => {
    const env = await makeEnv();
    const [sh, w] = lastOf(await turn(env, "заведи окно обслуживания по новому расписанию")).rules;
    assert.eq([sh.table, sh.ref, w.table, w.op, w.body.schedule, w.body.enabled], ["schedules", "shift", "windows", "create", "@shift", false], "план");
    const n = (await env.list("/schedules")).length, m = (await env.list("/maintenance-windows")).length;
    assert.eq([(await env.list("/schedules")).length, (await env.list("/maintenance-windows")).length], [n, m], "ход ничего не записал");
    const made = await env.ok("POST", "/maintenance-windows", Object.assign({}, w.body, { schedule: sh.body }));
    assert.eq([made.window.enabled, (await env.list("/schedules")).length], [false, n + 1], "одно расписание, его завела дверь окна");
    const ref = await env.call("POST", "/maintenance-windows", Object.assign({}, w.body, { schedule: "@shift" }));
    assert.status(ref, 422, "VALIDATION_FAILED", "ссылки дверь не берёт");
  }, NEED);

  test("План правил: расписание со ссылкой от правила и окна — своя запись; окно с готовым расписанием — копия строки", async () => {
    const env = await makeEnv();
    const plan = lastOf(await turn(env, `при движении на ${camera} пиши 5 минут, новое расписание, окно обслуживания`)).rules;
    assert.eq(plan.map((e) => e.table), ["schedules", "scenarios", "windows"], "порядок");
    assert.eq([plan[1].body.conditions[0].scheduleId, plan[2].body.schedule], ["@shift", "@shift"], "обе ссылки");
    const ready = FX.schedules.find((x) => !x.builtin);
    const [w] = lastOf(await turn(env, `заведи окно обслуживания по расписанию ${ready.name}`)).rules;
    assert.eq([w.body.schedule.name, "id" in w.body.schedule], [ready.name, false], "копия строки");
    assert.status(await env.call("POST", "/maintenance-windows", w.body), 201, null, "дверь берёт копию");
  }, NEED);

  test("План правил: вопрос, ответ с context; чего форма не выражает — отказ словом о странице консоли", async () => {
    const env = await makeEnv();
    const q = lastOf(await turn(env, "при движении пиши 5 минут"));
    assert.eq([q.type, q.text], ["question", "На какой камере?"], "вопрос");
    const p = lastOf(await turn(env, camera, { context: q.context }));
    assert.eq(p.type, "plan", "по ответу — план");
    const no = lastOf(await turn(env, `проверь архив на ${camera}`));
    assert.ok(no.type === "refused" && /странице консоли/.test(no.text) && !("rules" in no), "отказ");
  }, NEED);

  test("План правил: вопрос оператору и эскалация — план с шагами ask, escalate, заведённый наблюдающим", async () => {
    const env = await makeEnv();
    const q = lastOf(await turn(env, "спроси оператора"));
    assert.eq([q.type, q.text], ["question", "На какой камере?"], "вопрос о камере");
    const ask = lastOf(await turn(env, `при движении на ${camera} спроси оператора`));
    assert.eq(ask.type, "plan", "план ask");
    const [row] = ask.rules, step = row.body.steps[0];
    assert.eq([row.table, row.op, row.body.logOnly, step.control, step.default], ["scenarios", "create", true, "ask", "no"], "наблюдает, шаг ask");
    const esc = lastOf(await turn(env, `эскалация при движении на ${camera}`));
    const levels = esc.rules[0].body.steps[1].levels;
    assert.eq([esc.type, esc.rules[0].body.logOnly, esc.rules[0].body.steps[1].control, levels.length], ["plan", true, "escalate", 2], "план escalate");
    const off = lastOf(await turn(env, `при движении на ${camera} спроси оператора, выключенным`));
    assert.eq([off.rules[0].body.enabled, "logOnly" in off.rules[0].body], [false, false], "просили выключенным");
  }, NEED);

  // План выгрузки (ADR-0093 доп. (47)): «выгрузи», «экспорт», «кадр с камеры» — plan с export (AssistExport). Камеры заказа —
  // по uid объекта, как ExportCamera; ход ничего не пишет, тело годится для POST /exports/check как есть
  test("План выгрузки: «выгрузи», «кадр», «живой кадр» — plan с export, камеры по uid; маска — refused; без камер — вопрос; без createExport плана нет", async () => {
    const env = await makeEnv();
    const ref = (await env.ok("GET", "/reference")).export;
    const cams = await env.pages("/units?implements=vms.camera/1&limit=1000");
    const room = "Переговорная", main = cams.find((u) => u.name === room);
    const fmtOf = (kind) => ref.formats.find((f) => f.kind === kind).id;
    const video = lastOf(await turn(env, `выгрузи ${room} за 15 минут`));
    const e = video.export;
    assert.eq([video.type, video.summary, "items" in video, "rules" in video], ["plan", `Выгрузка: ${room}`, false, false], "план выгрузки, а не настройки");
    assert.eq([e.mode, e.cameras, e.format, e.periods.length], ["video", [{ uid: main.uid }], fmtOf("video"), 1], "имя камеры целиком — только она, по uid");
    const span = (x) => Math.round((Date.parse(x.periods[0].to) - Date.parse(x.periods[0].from)) / 60000);
    assert.eq(span(e), 15, "за последние 15 минут");
    assert.ok(!["password", "supervisor", "idempotencyKey"].some((k) => k in e), "пароля, супервизора и ключа в плане нет");
    // Ход ничего не пишет: заданий нет; тело плана — заказ для /exports/check, камера принята
    assert.eq((await env.list("/exports")).length, 0, "ход не создал выгрузку");
    const chk = await env.call("POST", "/exports/check", e);
    assert.status(chk, 200, null, "проверка заказа по плану");
    assert.ok(!(chk.body.errors || []).some((x) => /^\/cameras/.test(x.field || "")), "камера плана — объект склада: " + JSON.stringify(chk.body.errors));
    // Имени целиком в просьбе нет — по словам имени: «главные» — все камеры со словом «главн»
    const words = lastOf(await turn(env, "выгрузи главные"));
    const sorted = (list) => list.slice().sort();
    const withWord = cams.filter((u) => u.name.toLowerCase().includes("главн")).map((u) => u.uid);
    assert.ok(withWord.length > 1 && withWord.length <= ref.limits.maxCameras, "в наборе несколько камер со словом «главн»");
    assert.eq([words.type, sorted(words.export.cameras.map((c) => c.uid)), span(words.export)], ["plan", sorted(withWord), 10], "по слову имени, 10 минут по умолчанию");
    const frame = lastOf(await turn(env, `кадр с камеры ${room}`)).export;
    assert.eq([frame.mode, frame.cameras, frame.format, "source" in frame], ["frame", [{ uid: main.uid }], fmtOf("frame"), false], "кадр архива одной камеры");
    assert.ok(Math.abs(Date.parse(frame.at) - (env.now - 60000)) < 5000, "кадр — минуту назад: " + frame.at);
    const live = lastOf(await turn(env, `живой кадр с камеры ${room}`)).export;
    assert.eq([live.mode, live.source, "at" in live], ["frame", "live", false], "живой кадр");
    const mask = lastOf(await turn(env, `выгрузи ${room} с маской`));
    assert.eq([mask.type, "export" in mask], ["refused", false], "маскирования нет — отказ");
    const who = lastOf(await turn(env, "выгрузи запись"));
    assert.eq([who.type, who.text], ["question", "С каких камер выгрузить?"], "камер нет — вопрос");
    const ans = lastOf(await turn(env, room, { context: who.context }));
    assert.eq([ans.type, ans.export && ans.export.cameras], ["plan", [{ uid: main.uid }]], "ответ с context — план");
    // Без createExport такого плана нет
    const ops = (await env.ok("GET", "/reference")).capabilities.operations.filter((o) => o !== "createExport");
    const off = await makeEnv({ fixturePatch: { reference: { capabilities: { operations: ops } } } });
    const got = await turn(off, `выгрузи ${room} за 15 минут`);
    assert.ok(got.every((m) => !("export" in m)), "без createExport — не план выгрузки: " + types(got));
    return `камер по слову: ${withWord.length}`;
  }, { needs: ["assistTurn", "createExport"] });

  // Учебные ссылки (запрос w2c, ADR-VMS-0004): answer.learn — {catalog, topic, chapter} из каталога обучения консоли. Каталог даёт
  // страница, у встроенного сервера своего нет: тест ставит маленький каталог в window.ApiTestLearnCatalog (harness.js).
  // Стенд бэкенда каталог знает сам: там проверяется только форма — схемой, общей проверкой в конце прогона
  const LEARN_CAT = {
    format: "consolem-learn-catalog/1", version: "sha256:" + "ab".repeat(32), available: true,
    topics: [
      { id: "rules", title: "Как создать правило автоматизации", goal: "Правило само реагирует на событие.", lang: "ru", fixture: "demo",
        chapters: [{ id: "rules.simple", title: "Простое правило: «Если» и «То»", goal: "Простое правило отвечает на два вопроса: что случилось и что сделать.", lang: "ru", fixture: "demo" },
          { id: "rules.template", title: "Шаблон", goal: "Шаблон сразу даёт рабочую логику.", lang: "ru", fixture: "demo" }] },
      { id: "tree", title: "Как найти объект в дереве", goal: "Срезы, папки и статус сужают дерево.", lang: "ru", fixture: "demo",
        chapters: [{ id: "tree.status", title: "Отбор по статусу", goal: "Статус показывает, что требует внимания.", lang: "ru", fixture: "demo" }] },
    ],
  };
  test("Ассистент: «покажи, как …», «как настроить …» — answer с учебными ссылками learn из каталога; нет главы или каталога — answer без learn; отбор «покажи» прежний", async () => {
    const env = await makeEnv();
    const end = async (text) => (await env.stream("/assist/turns", { text })).pop();
    if (ApiTest.external) {
      const e = await end("покажи, как создать правило");
      assert.ok(["answer", "question", "refused", "error"].includes(e.type), "просьба научить — конечное событие без плана: " + e.type);
      assert.ok(!e.learn || e.type === "answer", "learn — только у answer");
      return e.learn ? `ссылок: ${e.learn.length}` : "стенд ответил без учебных ссылок";
    }
    try {
      window.ApiTestLearnCatalog = LEARN_CAT;
      const rule = await end("покажи, как создать простое правило");
      assert.eq([rule.type, typeof rule.text, typeof rule.context], ["answer", "string", "string"], "ответ — answer с текстом и context");
      assert.eq(rule.learn && rule.learn[0], { catalog: LEARN_CAT.version, topic: "rules", chapter: "rules.simple" }, "первая ссылка — глава каталога по ID");
      assert.ok(rule.learn.every((l) => l.catalog === LEARN_CAT.version && l.chapter.startsWith(l.topic + ".") && LEARN_CAT.topics.some((t) => t.id === l.topic && t.chapters.some((c) => c.id === l.chapter))), "все ссылки — из каталога, глава своей темы");
      assert.ok(rule.learn.every((l) => Object.keys(l).join() === "catalog,topic,chapter") && !/https?:|<|javascript:/i.test(JSON.stringify(rule.learn)), "в ссылке только ID: ни адреса, ни разметки");
      const status = await end("как настроить отбор по статусу");
      assert.eq(status.learn && status.learn.map((l) => l.chapter), ["tree.status"], "«как настроить …» — своя глава");
      const none = await end("как погладить кота");
      assert.eq([none.type, "learn" in none], ["answer", false], "главы нет — обычный answer без learn");
      window.ApiTestLearnCatalog = Object.assign({}, LEARN_CAT, { available: false });
      const off = await end("покажи, как создать правило");
      assert.eq([off.type, "learn" in off], ["answer", false], "материал недоступен — answer без learn");
      window.ApiTestLearnCatalog = null;
      const nocat = await end("покажи, как создать правило");
      assert.eq([nocat.type, "learn" in nocat], ["answer", false], "каталога нет — answer без learn");
      const found = await end("покажи камеры без детектора движения");
      assert.eq(found.type, "found", "«покажи» без «как» — прежний отбор");
      const count = await end("сколько камер");
      assert.eq([count.type, "learn" in count], ["answer", false], "вопрос о системе — answer без learn");
      return `ссылок на «создать правило»: ${rule.learn.length}`;
    } finally {
      window.ApiTestLearnCatalog = null;
    }
  }, NEED);

  ApiTest.loaded("api-assist.js");
})();
