/* Тесты API: что система объявляет об «Автоматизации» (события и действия объектов — описания видов UnitKind.events,
   actions с ruleAction; остальное — reference.rule*), поля правила, действия детектора, права при записи правила, ход с
   ответом оператора, правила на несколько доменов. */
(() => {
  const { test, makeEnv, assert } = ApiTest;
  const FX = ApiTest.FX;
  const ref = FX.reference;
  const CONTENT = ["name", "enabled", "logOnly", "logOnlySince", "start", "runMode", "operatorMenu", "ratePerMinute", "windowSec", "runAt", "repeat",
    "triggers", "conditions", "steps", "owner", "purpose", "serverId", "runAsRoleId", "allowChain"];
  const body = (r, over) => Object.assign(Object.fromEntries(CONTENT.map((k) => [k, JSON.parse(JSON.stringify(r[k]))])), over || {});
  const etag = (r) => ({ "If-Match": `"${r.version}"` });
  // Цель: объект по uid, область — {area, uid}
  const dev = (uid) => ({ include: [{ uid }], exclude: [], gone: [], fromEvent: false });
  const area = (a, uid) => ({ include: [{ area: a, uid }], exclude: [], gone: [], fromEvent: false });
  const cam = FX.devices.find((d) => d.type === "camera" && d.online && d.enabled);
  // Действие на объекте: команда вида с ruleAction
  const act = (action, target, params) => ({ type: "unitAction", action, target, params: params || {} });
  const with_ = (a, params) => Object.assign({}, a, { params: Object.assign({}, a.params, params) });
  const at_ = (a, target) => Object.assign({}, a, { target });
  const step = act("record", dev(cam.id), { duration: "min", minutes: 5 });
  const blank = (over) => Object.assign({
    name: "Проверка", enabled: true, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 6, windowSec: 0,
    runAt: null, repeat: "skip", triggers: [], conditions: [], steps: [step],
    owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true,
  }, over || {});
  // Каталог без действия: у видов (действие на объекте) и в справочнике (действие без объекта)
  const kindsWith = (fn) => FX.kinds.map((k) => fn(JSON.parse(JSON.stringify(k))));
  const noAction = (action) => ({
    kinds: kindsWith((k) => Object.assign(k, k.actions ? { actions: k.actions.filter((a) => a.id !== action) } : {})),
    reference: { ruleActions: ref.ruleActions.filter((a) => a.action !== action) },
  });
  const issue = (res) => res.body.params.issue.code;

  /* ----- Каталог ----- */

  test("Каталог: события и действия объектов — в описаниях видов; в справочнике — способы запуска, области целей, действия без объекта", async () => {
    const env = await makeEnv();
    const r = await env.ok("GET", "/reference");
    assert.ok(r.ruleStarts.length > 0 && r.ruleTargets.areas.length > 0 && r.ruleActions.length > 0, "каталог не пуст");
    assert.ok(r.ruleTargets.areas.every((k) => ["folder", "server", "domain"].includes(k)), "области целей — из контракта");
    assert.ok(!("ruleTriggers" in r) && !("eventKinds" in r) && r.ruleActions.every((a) => !("deviceTypes" in a)), "событий и действий устройств в справочнике нет");
    const camera = await env.ok("GET", "/kinds/camera");
    assert.ok(camera.events.some((e) => e.id === "motion" && e.ends) && camera.actions.some((a) => a.id === "record" && a.ruleAction && a.ruleOnly), "у камеры: события и действия правил");
  });

  test("Каталог: включённое вне каталога — 422 NOT_SUPPORTED с полем и причиной, выключенное хранится и читается", async () => {
    const env = await makeEnv({ fixturePatch: noAction("preset") });
    const s = act("preset", dev(cam.id), { preset: 1 });
    const bad = await env.call("POST", "/rules", blank({ steps: [s] }));
    assert.status(bad, 422, "NOT_SUPPORTED");
    assert.eq([bad.body.field, issue(bad), bad.body.params.issue.params.action], ["steps", "action.notDeclared", "preset"], "шаг и причина");
    const off = await env.call("POST", "/rules", blank({ enabled: false, steps: [s] }));
    assert.status(off, 201, null, "выключенное хранится");
    const read = await env.ok("GET", `/rules/${off.body.id}`);
    assert.eq(read.steps[0].action, "preset", "шаг не потерян");
    const up = await env.ok("POST", "/rules/update", { idempotencyKey: ApiTest.key(), items: [{ ruleId: read.id, version: read.version, set: { enabled: true } }] });
    assert.eq(up.failed.map((x) => x.code), ["NOT_SUPPORTED"], "включить группой нельзя");
    const put = await env.call("PUT", `/rules/${read.id}`, body(read, { enabled: true }), etag(read));
    assert.status(put, 422, "NOT_SUPPORTED", "включить правкой нельзя");
  });

  test("Каталог: уже включённое вне каталога не запускается — 409 NOT_RUNNABLE, причина кодом", async () => {
    const r = FX.rules.find((x) => x.enabled && x.steps.some((s) => s.action));
    const a = r.steps.find((s) => s.action).action;
    const env = await makeEnv({ fixturePatch: noAction(a) });
    const res = await env.call("POST", `/rules/${r.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.status(res, 409, "NOT_RUNNABLE");
    assert.eq(res.body.params.reason.code, "action.notDeclared", "причина");
    assert.eq((await env.ok("GET", `/rules/${r.id}`)).status.state, "refused", "сервер говорит: отказано");
  });

  test("Каталог: способ запуска, вид цели, «устройство из события», значение и поле действия", async () => {
    // Запись — только на минуты: у действия record камеры нет afterSec, duration — только min
    const minutesOnly = (k) => {
      (k.actions || []).filter((a) => a.id === "record" && a.ruleAction).forEach((a) => {
        delete a.params.properties.afterSec;
        a.params.properties.duration.enum = ["min"];
      });
      return k;
    };
    const env = await makeEnv({ fixturePatch: { kinds: kindsWith(minutesOnly), reference: { ruleStarts: ["manual", "event"], ruleTargets: { areas: [], fromEvent: false } } } });
    const say = async (over, field, code) => {
      const res = await env.call("POST", "/rules", blank(over));
      assert.status(res, 422, "NOT_SUPPORTED", code);
      assert.eq([res.body.field, issue(res)], [field, code], code);
    };
    await say({ start: "schedule", runMode: "always", runAt: { days: [1], time: "10:00" } }, "start", "rule.startNotDeclared");
    const folder = FX.folders[0];
    await say({ steps: [at_(step, area("folder", folder.id))] }, "steps", "target.notDeclared");
    await say({ steps: [at_(step, { include: [], exclude: [], gone: [], fromEvent: true })] }, "steps", "target.notDeclared");
    await say({ steps: [with_(step, { duration: "event" })] }, "steps", "action.fieldNotDeclared");
    await say({ steps: [with_(step, { afterSec: 5 })] }, "steps", "action.fieldNotDeclared");
    assert.status(await env.call("POST", "/rules", blank()), 201, null, "объявленное сохраняется");
  });

  test("Каталог: событие и условие вне справочника — поле раздела", async () => {
    const env = await makeEnv({ fixturePatch: {
      kinds: kindsWith((k) => Object.assign(k, k.events ? { events: k.events.filter((e) => e.id !== "motion") } : {})),
      reference: { ruleConditions: ref.ruleConditions.filter((c) => c.kind !== "online") },
    } });
    const tr = { source: "unit", kinds: ["camera"], event: "motion", target: dev(cam.id), match: {} };
    const a = await env.call("POST", "/rules", blank({ start: "event", runMode: "always", triggers: [tr] }));
    assert.status(a, 422, "NOT_SUPPORTED");
    assert.eq([a.body.field, issue(a)], ["triggers", "trigger.notDeclared"], "событие");
    const b = await env.call("POST", "/rules", blank({ conditions: [{ kind: "online", target: dev(cam.id) }] }));
    assert.status(b, 422, "NOT_SUPPORTED");
    assert.eq([b.body.field, issue(b)], ["conditions", "cond.notDeclared"], "условие");
  });

  /* ----- Поля правила ----- */

  test("Правило: годность действия — 30 по умолчанию, 10–600, вне границ — 422", async () => {
    const env = await makeEnv();
    const made = await env.ok("POST", "/rules", blank());
    assert.eq(made.validForSec, 30, "умолчание");
    const put = await env.ok("PUT", `/rules/${made.id}`, body(made, { validForSec: 120 }), etag(made));
    assert.eq(put.validForSec, 120, "сохранено");
    for (const v of [9, 601]) {
      const res = await env.call("PUT", `/rules/${made.id}`, body(put, { validForSec: v }), etag(put));
      assert.status(res, 422, "VALIDATION_FAILED", `значение ${v}`);
      assert.eq(res.body.field, "validForSec", "поле");
    }
    const h = await env.list(`/rules/${made.id}/versions`);
    assert.eq(h[h.length - 1].rule.validForSec, 120, "в истории");
  });

  test("Правило: состояние от сервера — следит, отказано, не годится, не проверено; у выключенного нет; в версию не входит", async () => {
    const env = await makeEnv();
    const on = await env.ok("POST", "/rules", blank());
    assert.eq(on.status, { state: "watching", reason: "" }, "следит");
    const off = await env.ok("POST", "/rules", blank({ enabled: false }));
    assert.ok(!("status" in off), "выключенное не следит");
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: cam.id, online: false }), 200);
    const seen = await env.ok("GET", `/rules/${on.id}`);
    assert.eq([seen.status.state, seen.version], ["unchecked", on.version], "не проверено, версия та же");
    assert.ok(seen.status.reason.includes(cam.name), "причина словами");
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: cam.id, online: true }), 200);
    const list = await env.list("/rules");
    assert.eq(list.find((r) => r.id === on.id).status.state, "watching", "в списке — тоже");
  });

  test("Правило: не годится — пресета нет на камере", async () => {
    const dev0 = FX.devices.find((d) => d.type === "camera" && d.presetMax && d.online);
    if (!dev0) return;
    const env = await makeEnv();
    const on = await env.ok("POST", "/rules", blank({ steps: [act("preset", dev(dev0.id), { preset: dev0.presetMax + 1 })] }));
    assert.eq(on.status.state, "unfit", "не годится");
    assert.ok(on.status.reason.includes(String(dev0.presetMax + 1)), "причина: " + on.status.reason);
  });

  test("Правило: уточнение события открыто — любой ключ, тип значения сохраняется, сравнение строгое", async () => {
    const env = await makeEnv();
    const tr = { source: "unit", kinds: ["camera"], event: "motion", target: dev(cam.id), match: { pass: 3 } };
    const made = await env.ok("POST", "/rules", blank({ enabled: false, start: "event", runMode: "always", triggers: [tr] }));
    assert.eq((await env.ok("GET", `/rules/${made.id}`)).triggers[0].match, { pass: 3 }, "как есть, числом");
    const run = (value) => env.ok("POST", "/rules/test", { ruleId: null, rule: body(made), events: [{ source: "unit", event: "motion", deviceId: cam.id, match: { pass: value } }], at: null, branches: {}, log: false });
    assert.ok((await run(3)).checks.some((c) => c.code === "event.came"), "число совпало");
    assert.ok(!(await run("3")).checks.some((c) => c.code === "event.came"), "строка — другое значение");
  });

  /* ----- Действия детектора ----- */

  const detect = (over, target) => act("detect", target || dev(cam.id), Object.assign({ detectorKind: "motion", minutes: 10 }, over));
  const scan = (over, target) => act("scan", target || dev(cam.id), Object.assign({ detectorKind: "motion" }, over));

  test("Детектор на время и проверка архива: в каталоге, сохраняются, выполняются в запуске", async () => {
    const env = await makeEnv();
    const camera = await env.ok("GET", "/kinds/camera");
    const a = camera.actions.find((x) => x.id === "detect"), b = camera.actions.find((x) => x.id === "scan");
    assert.eq([a.ruleAction, b.ruleAction, Object.keys(b.params.properties), a.params.required], [true, true, ["detectorKind", "beforeSec", "afterSec", "archive", "params"], ["detectorKind", "minutes"]], "каталог — действия вида");
    assert.ok(a.params.properties.detectorKind.enum.includes("motion"), "виды детекторов — перечисление параметра");
    const c = FX.devices.find((d) => d.type === "camera" && d.online && d.enabled && d.archiveId);
    const made = await env.ok("POST", "/rules", blank({ steps: [detect({ params: "{\"limit\":3}" }, dev(c.id)), scan({ beforeSec: 30, afterSec: 90, archive: c.archiveId }, dev(c.id))] }));
    assert.eq([made.steps[1].params.beforeSec, made.steps[1].params.afterSec, made.steps[0].params.params], [30, 90, "{\"limit\":3}"], "поля");
    const f = await env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.eq(f.steps.map((s) => [s.action.action, s.state]), [["detect", "ok"], ["scan", "ok"]], "трасса");
  });

  test("Детектор на время и проверка архива: границы и пустое окно — 422 RULE_INVALID, выключенное хранится", async () => {
    const env = await makeEnv();
    const bad = await env.call("POST", "/rules", blank({ steps: [detect({ minutes: 1441 })] }));
    assert.status(bad, 422, "RULE_INVALID");
    assert.eq(issue(bad), "action.field", "минуты");
    const none = await env.call("POST", "/rules", blank({ steps: [detect({ detectorKind: "" })] }));
    assert.status(none, 422, "RULE_INVALID", "нет вида");
    const win = await env.call("POST", "/rules", blank({ steps: [scan({ beforeSec: 0, afterSec: 0 })] }));
    assert.status(win, 422, "RULE_INVALID");
    assert.eq(issue(win), "action.scanWindow", "окно");
    assert.status(await env.call("POST", "/rules", blank({ enabled: false, steps: [scan({ beforeSec: 0, afterSec: 0 })] })), 201, null, "незаконченное выключенное");
  });

  test("Проверка архива: камере без записи нечего проверять — шаг не выполнен, правило не годится", async () => {
    const c = FX.devices.find((d) => d.type === "camera" && d.online && d.enabled && !d.archiveId && !(d.extraArchives || []).length);
    if (!c) return;
    const env = await makeEnv();
    const made = await env.ok("POST", "/rules", blank({ steps: [scan({}, dev(c.id))] }));
    assert.eq(made.status.state, "unfit", "не годится");
    const f = await env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.eq([f.steps[0].state, f.steps[0].reason.code, f.result], ["fail", "target.noRecord", "fail"], "шаг");
  });

  /* ----- Цели и права ----- */

  const roleOf = (fn) => FX.access.roles.find(fn);
  const guard = FX.access.users.find((u) => u.login === "olga"), guardRole = guard.roleIds[0];

  test("Цели: новое устройство в области входит в правило само, новой версии нет", async () => {
    const f = FX.folders.find((x) => x.deviceIds.some((id) => (FX.devices.find((d) => d.id === id) || {}).type === "camera"));
    const other = FX.devices.find((d) => d.type === "camera" && d.domainId === f.domainId && !f.deviceIds.includes(d.id));
    if (!other) return;
    const env = await makeEnv();
    const made = await env.ok("POST", "/rules", blank({ steps: [at_(step, area("folder", f.id))] }));
    const n0 = (await env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() })).steps.length;
    const u = await env.ok("GET", `/units/${other.id}`);
    await env.ok("PATCH", `/units/${other.id}`, { folders: (u.folders || []).concat(f.id) }, { "If-Match": `"${u.version}"` });
    const n1 = (await env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() })).steps.length;
    assert.eq([n1, (await env.ok("GET", `/rules/${made.id}`)).version], [n0 + 1, made.version], "шаг на новую камеру, версия та же");
  }, { needs: ["patchUnit"] });

  test("Права: автор отвечает за всё, что называет правило; нет права — 403, ничего не записано", async () => {
    const env = await makeEnv({ actAs: guard.login });
    const before = (await env.list("/rules")).length;
    const bad = await env.call("POST", "/rules", blank());
    assert.status(bad, 403, "PERMISSION_DENIED");
    assert.eq(bad.body.params.target, { uid: cam.id }, "что именно");
    assert.eq((await env.list("/rules")).length, before, "не записано");
    const dom = await env.call("POST", "/rules", blank({ steps: [at_(step, area("domain", FX.domains[0].id))] }));
    assert.status(dom, 403, "PERMISSION_DENIED", "весь домен — нужно право на всё");
    const r = FX.rules.find((x) => x.name === "Охрана входа ночью");
    assert.status(await env.call("PUT", `/rules/${r.id}`, body(r, { name: "Чужое" }), etag(r)), 403, "PERMISSION_DENIED", "правка правила с чужой камерой");
    const tr = { source: "unit", kinds: ["camera"], event: "motion", target: dev(cam.id), match: {} };
    assert.status(await env.call("POST", "/rules", blank({ enabled: false, start: "event", runMode: "always", triggers: [tr] })), 403, "PERMISSION_DENIED", "и у выключенного, и в событии");
  });

  test("Права: своё право годится, умолчание роли и точечное исключение", async () => {
    const own = roleOf((x) => x.id === guardRole);
    const id = Object.keys(own.objectAccess).find((k) => (own.objectAccess[k].cam === "FULL") && FX.devices.some((d) => d.id === k && d.type === "camera"));
    if (!id) return;
    const env = await makeEnv({ actAs: guard.login });
    const res = await env.call("POST", "/rules", blank({ enabled: false, steps: [at_(step, dev(id))] }));
    assert.status(res, 201, null, "камера, где у роли FULL");
  });

  test("Права: роль запуска ограничивает выполнение; автор выбирает любую роль; нет роли — 422", async () => {
    const env = await makeEnv();
    const weak = roleOf((x) => !x.global.unr && x.kindAccess.cam === "MON" && !x.objectAccess[cam.id]);
    const c2 = FX.devices.find((d) => d.type === "camera" && d.online && d.enabled && !FX.folders.some((f) => f.deviceIds.includes(d.id) && weak.folderAccess[f.id]) );
    if (!c2) return;
    const s = at_(step, dev(c2.id));
    const free = await env.ok("POST", "/rules", blank({ steps: [s] }));
    assert.eq((await env.ok("POST", `/rules/${free.id}/run`, { idempotencyKey: ApiTest.key() })).steps[0].state, "ok", "от имени системы — без ограничений");
    const made = await env.ok("POST", "/rules", blank({ runAsRoleId: weak.id, steps: [s] }));
    assert.eq(made.runAsRoleId, weak.id, "роль, которой у автора нет, выбрать можно");
    const f = await env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.eq([f.steps[0].state, f.steps[0].reason.code, f.steps[0].reason.params.roleId], ["fail", "role.denied", weak.id], "у роли нет права — шаг не выполнен");
    const none = await env.call("POST", "/rules", blank({ runAsRoleId: "80000099-0000-4000-8000-000000000000" }));
    assert.status(none, 422, "VALIDATION_FAILED");
    assert.eq(none.body.field, "runAsRoleId", "поле");
  });

  /* ----- Ход с ответом оператора ----- */

  const base = FX.rules.find((r) => r.name === "Тревога на периметре");
  const other = FX.access.users.find((u) => u.login === "commissioning");
  const rec = (id) => act("record", dev(id), { duration: "min", minutes: id === cam.id ? 5 : 6 });
  const ask = (over) => Object.assign({ control: "ask", text: "Подтвердить: {правило}?", roleId: guardRole, sec: 60, default: "no", yes: [rec(cam.id)], no: [] }, over || {});
  const levels = (a, b) => [{ roleId: a, via: "client", waitMin: 5 }, { roleId: b, via: "client", waitMin: 10 }];
  const escalate = (over) => Object.assign({ control: "escalate", levels: levels(guardRole, other.roleIds[0]), stop: "ack" }, over || {});
  // Правило набора с нужными шагами: заводить его через API нельзя — автор и оператор разные люди
  const patched = (over) => ({ rules: FX.rules.map((r) => (r.id === base.id ? Object.assign({}, r, { start: "manual", runMode: "manual", triggers: [], conditions: [], windowSec: 0, repeat: "skip", logOnly: false, logOnlySince: null, mute: null }, over) : r)) });
  const envWith = (over, who) => makeEnv({ fixturePatch: patched(over), actAs: (who || guard).login });
  const run = (env, id) => env.ok("POST", `/rules/${id || base.id}/run`, { idempotencyKey: ApiTest.key() });
  const fireOf = async (env, id) => (await env.list(`/rules/${base.id}/fires`)).find((f) => f.id === id);
  const PROMPTS = ["listRulePrompts", "answerRulePrompt"];

  test("Вопрос: запуск встаёт на шаге, вопрос виден со всеми полями, в потоке — prompt.opened", async () => {
    const env = await envWith({ steps: [ask()] });
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "rulePrompt" && seen.push(m));
    await ApiTest.settle();
    const f = await run(env);
    assert.eq([f.result, f.steps.map((s) => s.state)], ["waiting", ["waiting"]], "запуск ждёт");
    const [p, ...rest] = await env.list("/rule-prompts");
    assert.eq(rest.length, 0, "один вопрос");
    assert.eq([p.ruleId, p.fireId, p.step, p.kind, p.text, p.roleId, p.level, p.canAnswer], [base.id, f.id, "0", "ask", `Подтвердить: ${base.name}?`, guardRole, null, true], "поля");
    assert.eq(Date.parse(p.until) - Date.parse(p.openedAt), 60000, "срок — sec шага");
    await ApiTest.settle();
    stop();
    assert.eq(seen.map((m) => [m.type, m.entityId, m.payload.fireId, m.payload.roleId]), [["prompt.opened", p.id, f.id, guardRole]], "поток");
  }, { needs: PROMPTS });

  test("Вопрос: первый ответ считается — ветка идёт, запись запуска та же, вопрос закрыт, повтор — 409", async () => {
    const env = await envWith({ steps: [ask()] });
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => (m.kind === "rulePrompt" || m.kind === "ruleFire") && seen.push(m));
    await ApiTest.settle();
    const f = await run(env);
    const [p] = await env.list("/rule-prompts");
    const res = await env.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "yes" });
    assert.status(res, 202);
    assert.eq(await env.list("/rule-prompts"), [], "вопрос закрыт");
    const now = await fireOf(env, f.id);
    assert.eq([now.result, now.steps.filter((s) => s.action).map((s) => s.state)], ["ok", ["ok"]], "ветка «да» выполнена");
    const row = now.steps.find((s) => s.control && !s.skip);
    assert.eq([row.state, row.note.code, row.note.params.answer, row.note.params.login], ["ok", "ask.answer", "yes", guard.login], "кто ответил");
    const again = await env.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "no" });
    assert.status(again, 409, "BUSY");
    assert.eq(again.body.params.reason, "answered", "уже ответили");
    assert.eq((await fireOf(env, f.id)).result, "ok", "второй ответ ничего не меняет");
    await ApiTest.settle();
    stop();
    const closed = seen.find((m) => m.type === "prompt.closed");
    assert.eq([closed.entityId, closed.payload.reason, closed.payload.answer, closed.payload.by], [p.id, "answered", "yes", guard.login], "prompt.closed");
    assert.ok(seen.some((m) => m.type === "entity.changed" && m.kind === "ruleFire" && m.entityId === f.id && m.payload.ruleId === base.id), "запуск изменился — событие");
  }, { needs: PROMPTS });

  test("Вопрос: ответ «нет» — ветка «нет», «да» пропущена", async () => {
    const env = await envWith({ steps: [ask({ yes: [], no: [rec(cam.id)] })] });
    const f = await run(env);
    const [p] = await env.list("/rule-prompts");
    assert.status(await env.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "no" }), 202);
    const now = await fireOf(env, f.id);
    assert.eq([now.result, now.steps.some((s) => s.path === "0.yes" && s.skip), now.steps.filter((s) => s.action).length], ["ok", true, 1], "ветка");
  }, { needs: PROMPTS });

  test("Вопрос: чужая роль — 403, canAnswer false; не тот вид ответа — 422, вопрос открыт; нет вопроса — 404", async () => {
    const env = await envWith({ steps: [ask()] }, other);
    await run(env);
    const [p] = await env.list("/rule-prompts");
    assert.eq(p.canAnswer, false, "роли нет");
    const no = await env.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "yes" });
    assert.status(no, 403, "PERMISSION_DENIED");
    assert.eq((await env.list("/rule-prompts")).length, 1, "вопрос открыт");
    assert.status(await env.call("POST", "/rule-prompts/f0009999-0008-4000-8000-000000000000/answer", { answer: "yes" }), 404, "NOT_FOUND");
    const own = await envWith({ steps: [ask()] });
    await run(own);
    const [q] = await own.list("/rule-prompts");
    const kind = await own.call("POST", `/rule-prompts/${q.id}/answer`, { answer: "ack" });
    assert.status(kind, 422, "VALIDATION_FAILED");
    assert.eq(kind.body.field, "answer", "поле");
    assert.status(await own.call("POST", `/rule-prompts/${q.id}/answer`, { answer: "maybe" }), 422, "VALIDATION_FAILED", "не из списка");
    assert.eq((await own.list("/rule-prompts")).length, 1, "вопрос открыт");
  }, { needs: PROMPTS });

  test("Вопрос: срок вышел — ветка default, вопрос закрыт, ответ после срока не действует", async () => {
    const env = await envWith({ steps: [ask({ sec: 30, default: "yes" })] });
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.kind === "rulePrompt" && seen.push(m));
    await ApiTest.settle();
    const f = await run(env);
    const [p] = await env.list("/rule-prompts");
    await env.advance(29);
    assert.eq((await env.list("/rule-prompts")).length, 1, "срок не вышел");
    await env.advance(1);
    assert.eq(await env.list("/rule-prompts"), [], "закрыт по сроку");
    const late = await env.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "no" });
    assert.status(late, 409, "NOT_RUNNABLE");
    assert.eq(late.body.params.reason.code, "over", "не ждёт");
    const now = await fireOf(env, f.id);
    assert.eq([now.result, now.steps.find((s) => s.control && !s.skip).note.code, now.steps.filter((s) => s.action).length], ["ok", "ask.noAnswer", 1], "пошло по default");
    await ApiTest.settle();
    stop();
    assert.eq(seen.filter((m) => m.type === "prompt.closed").map((m) => m.payload.reason), ["expired"], "причина");
  }, { needs: [...PROMPTS, "clock"] });

  test("Вопрос: шаг за шагом — второй вопрос после первого, вложенный в ветку", async () => {
    const env = await envWith({ steps: [ask({ yes: [ask({ text: "Ещё раз?", yes: [rec(cam.id)] })] }), step] });
    const f = await run(env);
    const [p] = await env.list("/rule-prompts");
    await env.ok("POST", `/rule-prompts/${p.id}/answer`, { answer: "yes" });
    const [q, ...more] = await env.list("/rule-prompts");
    assert.eq([q.step, q.text, more.length, (await fireOf(env, f.id)).result], ["0.yes.0", "Ещё раз?", 0, "waiting"], "второй вопрос");
    await env.ok("POST", `/rule-prompts/${q.id}/answer`, { answer: "yes" });
    const now = await fireOf(env, f.id);
    assert.eq([now.result, now.steps.filter((s) => s.action).length], ["ok", 2], "дошло до конца: и следующий шаг");
  }, { needs: PROMPTS });

  test("Вопрос: «Только журнал» никого не спрашивает: срок, ветка default, действий нет; пробный запуск вопросов не открывает", async () => {
    const env = await envWith({ logOnly: true, steps: [ask()] });
    const r = await env.ok("GET", `/rules/${base.id}`);
    const t = await env.ok("POST", "/rules/test", { ruleId: base.id, rule: body(r), events: [], at: null, branches: { 0: "yes" }, log: false });
    assert.ok(t.result !== "waiting", "пробный запуск не ждёт");
    assert.eq(await env.list("/rule-prompts"), [], "вопросов нет");
    const f = await run(env);
    assert.eq(f.result, "waiting", "ждёт свой срок");
    assert.eq(await env.list("/rule-prompts"), [], "настоящий запуск вопроса не завёл");
    await env.advance(ask().sec + 1);
    const now = await fireOf(env, f.id);
    assert.eq(now.result, "watch", "только журнал");
    assert.ok(JSON.stringify(now.steps).includes("ask.noAnswer"), "в трассе — без ответа, веткой default");
    assert.ok(now.steps.filter((s) => s.action).every((s) => s.state === "would"), "действия не исполнены");
  }, { needs: PROMPTS.concat("clock") });

  test("Эскалация: «Только журнал» никого не спрашивает и кончается сроком последнего уровня", async () => {
    const env = await envWith({ logOnly: true, steps: [escalate(), step] });
    const f = await run(env);
    assert.eq([f.result, await env.list("/rule-prompts")], ["waiting", []], "ждёт, вопросов нет");
    await env.advance(5 * 60);
    assert.eq(await env.list("/rule-prompts"), [], "второй уровень тоже молчит");
    assert.eq((await fireOf(env, f.id)).result, "waiting", "ждёт дальше");
    await env.advance(10 * 60 + 1);
    assert.eq((await fireOf(env, f.id)).result, "watch", "кончилась сроком");
  }, { needs: PROMPTS.concat("clock") });

  test("Вопрос: роль без строк грантов не видна — canAnswer ложь, 403; закрытый вопрос после ухода из памяти — 404", async () => {
    const roles = FX.access.roles.map((r) => (r.id === guardRole ? Object.assign({}, r, { folderAccess: {}, objectAccess: {} }) : r));
    const env = await makeEnv({ fixturePatch: Object.assign(patched({ steps: [ask()] }), { access: { roles } }), actAs: guard.login });
    await run(env);
    const [hidden] = await env.list("/rule-prompts");
    assert.eq(hidden.canAnswer, false, "не видна");
    assert.status(await env.call("POST", `/rule-prompts/${hidden.id}/answer`, { answer: "yes" }), 403, "PERMISSION_DENIED");
    const live = await envWith({ steps: [ask()] });
    await run(live);
    const [p] = await live.list("/rule-prompts");
    await live.advance(ask().sec + 1);
    assert.status(await live.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "yes" }), 409, "NOT_RUNNABLE", "кончился, имя в памяти");
    await live.advance(86400);
    assert.status(await live.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "yes" }), 404, "NOT_FOUND", "имя ушло");
  }, { needs: PROMPTS.concat("clock") });

  test("Эскалация: уровни по сроку, прежний остаётся открыт, ack на любом останавливает, уровень в трассе", async () => {
    const env = await envWith({ steps: [escalate(), step] });
    const f = await run(env);
    let list = await env.list("/rule-prompts");
    assert.eq(list.map((p) => [p.kind, p.level, p.roleId, p.text, p.step]), [["escalate", 1, guardRole, "", "0"]], "первый уровень");
    assert.eq(Date.parse(list[0].until) - Date.parse(list[0].openedAt), 15 * 60000, "срок — вся эскалация");
    await env.advance(5 * 60);
    list = await env.list("/rule-prompts");
    assert.eq(list.map((p) => [p.level, p.roleId, p.canAnswer]), [[1, guardRole, true], [2, other.roleIds[0], false]], "второй уровень открылся, первый открыт");
    assert.eq((await fireOf(env, f.id)).result, "waiting", "ждёт");
    const bad = await env.call("POST", `/rule-prompts/${list[0].id}/answer`, { answer: "yes" });
    assert.status(bad, 422, "VALIDATION_FAILED", "эскалации отвечают ack");
    assert.status(await env.call("POST", `/rule-prompts/${list[1].id}/answer`, { answer: "ack" }), 403, "PERMISSION_DENIED", "уровень чужой роли");
    assert.status(await env.call("POST", `/rule-prompts/${list[0].id}/answer`, { answer: "ack" }), 202);
    assert.eq(await env.list("/rule-prompts"), [], "закрыты все уровни");
    const now = await fireOf(env, f.id);
    assert.eq([now.result, now.steps.filter((s) => s.action).length], ["ok", 1], "пошёл дальше");
    assert.ok(now.steps.some((s) => s.label && s.label.code === "esc.ack" && s.label.params.login === guard.login), "кто квитировал");
  }, { needs: [...PROMPTS, "clock"] });

  test("Эскалация: никто не квитировал — конец последнего уровня, запуск идёт дальше", async () => {
    const env = await envWith({ steps: [escalate({ levels: [{ roleId: guardRole, via: "client", waitMin: 1 }, { roleId: guardRole, via: "client", waitMin: 0 }] }), step] });
    const f = await run(env);
    await env.advance(60);
    assert.eq(await env.list("/rule-prompts"), [], "закрыто");
    const now = await fireOf(env, f.id);
    assert.eq([now.result, now.steps.some((s) => s.label && s.label.code === "esc.none")], ["ok", true], "итог");
  }, { needs: [...PROMPTS, "clock"] });

  test("Эскалация: stop: reset — конец события останавливает, вопросы закрываются с reason: reset", async () => {
    const sensor = FX.devices.find((d) => d.type === "sensor");
    const tr = { source: "unit", kinds: ["sensor"], event: "io.input", target: dev(sensor.id), match: { value: "active" } };
    const env = await envWith({ start: "event", runMode: "always", triggers: [tr], steps: [escalate({ stop: "reset" }), step] });
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => m.type === "prompt.closed" && seen.push(m.payload.reason));
    await ApiTest.settle();
    const before = (await env.list(`/rules/${base.id}/fires`)).length;
    assert.status(await env.call("POST", "/test/events", { type: "io.input", deviceId: sensor.id, value: "active" }), 200);
    const fires = await env.list(`/rules/${base.id}/fires`);
    assert.eq([fires.length, fires[0].result, fires[0].by], [before + 1, "waiting", "event"], "запуск по событию ждёт");
    assert.eq((await env.list("/rule-prompts")).length, 1, "вопрос открыт");
    assert.status(await env.call("POST", "/test/events", { type: "io.input", deviceId: sensor.id, value: "normal" }), 200);
    assert.eq(await env.list("/rule-prompts"), [], "закрыт");
    const now = await fireOf(env, fires[0].id);
    assert.eq([now.result, now.steps.some((s) => s.label && s.label.code === "esc.reset")], ["ok", true], "итог");
    await ApiTest.settle();
    stop();
    assert.eq(seen, ["reset"], "причина");
  }, { needs: [...PROMPTS, "type:sensor"] });

  test("Ход: правку, выключение, удаление правила запуск не переживает — вопросы закрыты, ответ не действует", async () => {
    const off = async (change) => {
      const env = await envWith({ steps: [ask()] }, { login: "root" });
      const f = await run(env);
      const [p] = await env.list("/rule-prompts");
      const seen = [];
      const stop = ApiTest.subscribeForTest((m) => m.type === "prompt.closed" && seen.push(m.payload.reason));
      await ApiTest.settle();
      await change(env, await env.ok("GET", `/rules/${base.id}`));
      assert.eq(await env.list("/rule-prompts"), [], "вопросов нет");
      await ApiTest.settle();
      stop();
      assert.eq(seen, ["stopped"], "причина");
      const fires = await env.list(`/rules/${base.id}/fires`).catch(() => null);
      if (fires) assert.ok(fires.find((x) => x.id === f.id).result !== "waiting", "запуск снят");
      assert.status(await env.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "yes" }), 404, "NOT_FOUND", "снятый запуск — 404");
      return p;
    };
    await off((env, r) => env.ok("PUT", `/rules/${r.id}`, body(r, { purpose: "другое" }), etag(r)));
    await off((env, r) => env.ok("POST", "/rules/update", { idempotencyKey: ApiTest.key(), items: [{ ruleId: r.id, version: r.version, set: { enabled: false } }] }));
    await off((env, r) => env.ok("POST", "/objects/delete", { idempotencyKey: ApiTest.key(), items: [{ id: r.id, version: r.version }] }));
    await off(async (env, r) => {
      const camera = r.steps[0].yes[0].target.include[0].uid;
      await env.ok("DELETE", `/units/${camera}`, undefined, { "If-Match": await env.etag(`/units/${camera}`) });
    });
    const env = await envWith({ steps: [ask()] }, { login: "root" });
    await run(env);
    const r = await env.ok("GET", `/rules/${base.id}`);
    assert.status(await env.call("POST", "/rules/update", { idempotencyKey: ApiTest.key(), items: [{ ruleId: r.id, version: r.version, set: { enabled: true } }] }), 200);
    assert.eq((await env.list("/rule-prompts")).length, 1, "то же значение запуск не снимает");
    const r2 = await env.ok("GET", `/rules/${base.id}`);
    await env.ok("POST", "/rules/update", { idempotencyKey: ApiTest.key(), items: [{ ruleId: r2.id, version: r2.version, set: { mute: { until: new Date(env.now + 3600000).toISOString().replace(/\.\d+Z$/, "Z"), reason: "" } } }] });
    assert.eq((await env.list("/rule-prompts")).length, 1, "приглушение запуск не снимает");
  }, { needs: PROMPTS });

  test("Ход: repeat — skip пропускает, restart снимает прежний, queue идёт следом, сверх 16 — как skip", async () => {
    let env = await envWith({ repeat: "skip", steps: [ask()] });
    await run(env);
    const s = await run(env);
    assert.eq([s.result, s.checks.find((c) => c.code === "busy").reason.code, (await env.list("/rule-prompts")).length], ["skip", "busy.skip", 1], "skip");
    env = await envWith({ repeat: "restart", steps: [ask()] });
    const a = await run(env);
    const [p] = await env.list("/rule-prompts");
    const b = await run(env);
    const [q, ...more] = await env.list("/rule-prompts");
    assert.eq([b.result, q.fireId, more.length, q.id !== p.id], ["waiting", b.id, 0, true], "restart: новый вопрос");
    assert.ok((await fireOf(env, a.id)).result !== "waiting", "прежний снят");
    env = await envWith({ repeat: "queue", steps: [ask(), step] });
    const first = await run(env);
    const second = await run(env);
    assert.eq([second.result, second.steps.length, second.checks.find((c) => c.code === "busy").reason.code, (await env.list("/rule-prompts")).length], ["waiting", 0, "busy.queue", 1], "queue: ждёт очереди, вопроса нет");
    const [x] = await env.list("/rule-prompts");
    await env.ok("POST", `/rule-prompts/${x.id}/answer`, { answer: "yes" });
    const [y] = await env.list("/rule-prompts");
    assert.eq([y.fireId, (await fireOf(env, first.id)).result], [second.id, "ok"], "очередь пошла концом прежнего");
    for (let i = 0; i < 15; i++) assert.eq((await run(env)).result, i < 15 ? "waiting" : "skip", "место в очереди");
    assert.eq((await run(env)).result, "skip", "сверх 16 — как skip");
  }, { needs: PROMPTS });

  /* ----- Домен ----- */

  test("Тревожные виды на весь домен: Settings.values, только из событий видов (UnitKind.events)", async () => {
    const env = await makeEnv();
    const s = await env.ok("GET", "/settings");
    const kinds = (await env.ok("GET", "/kinds/camera")).events.map((e) => e.id);
    const done = await env.ok("PATCH", "/settings", { values: { "alarms.domain": kinds.slice(0, 2) } }, etag(s));
    assert.eq(done.values["alarms.domain"], kinds.slice(0, 2), "сохранено");
    const bad = await env.call("PATCH", "/settings", { values: { "alarms.domain": ["нет такого"] } }, etag(done));
    assert.status(bad, 422, "VALIDATION_FAILED");
    assert.eq(bad.body.field, "alarms.domain", "поле");
  });

  test("Правило на несколько доменов: только объявленные шаги, прочее — 422 NOT_SUPPORTED, field: steps; сервер выбирает домен", async () => {
    const cams = (d) => FX.devices.filter((x) => x.type === "camera" && x.domainId === d.id);
    const [a, b] = FX.domains.filter((d) => cams(d).length).map((d) => cams(d)[0]);
    const free = await makeEnv();
    const any = await free.call("POST", "/rules", blank({ steps: [at_(step, dev(a.id)), at_(step, dev(b.id))] }));
    assert.status(any, 201, null, "поля нет — ограничения нет");
    const env = await makeEnv({ fixturePatch: { reference: { ruleCrossDomainActions: ["preset", "output"] } } });
    const preset = (id) => act("preset", dev(id), { preset: 1 });
    assert.status(await env.call("POST", "/rules", blank({ steps: [preset(a.id), preset(b.id)] })), 201, null, "пресеты");
    const bad = await env.call("POST", "/rules", blank({ steps: [preset(a.id), at_(step, dev(b.id))] }));
    assert.status(bad, 422, "NOT_SUPPORTED");
    assert.eq([bad.body.field, issue(bad), bad.body.params.issue.params.step], ["steps", "rule.crossDomain", "record"], "шаг");
    assert.status(await env.call("POST", "/rules", blank({ enabled: false, steps: [preset(a.id), at_(step, dev(b.id))] })), 201, null, "выключенное хранится");
    const srv = FX.servers.find((s) => s.domainId !== b.domainId);
    const home = await env.call("POST", "/rules", blank({ serverId: srv.id, steps: [at_(step, dev(b.id))] }));
    assert.status(home, 422, "VALIDATION_FAILED");
    assert.eq(home.body.field, "serverId", "цели в другом домене");
  }, { needs: ["cap:domain:create"] });

  /* ----- Цепочка правила: «или», проверка, ожидание, прерывание, интервал, новые события и команды ----- */

  const cams = FX.devices.filter((d) => d.type === "camera" && d.online && d.enabled);
  const [camA, camB] = cams;
  const trig = (event, id, match) => ({ source: "unit", kinds: ["camera"], event, target: dev(id), match: match || {} });
  const onEvent = (over) => blank(Object.assign({ start: "event", runMode: "always" }, over));
  const fireList = (env, id) => env.list(`/rules/${id}/fires`);
  const check = (what, target, yes, no, over) => Object.assign({ control: "check", what, target, yes: yes || [], no: no || [] }, over || {});
  const recB = () => act("record", dev(camB.id), { duration: "min", minutes: 3 });
  const unitEvent = (env, deviceId, eventId, match) => env.call("POST", "/test/events", { type: "unit.event", deviceId, eventId, match: match || {} });

  test("«Или» между событиями: whenLogic any — любое событие запускает правило, окна нет; без any нужно окно", async () => {
    const env = await makeEnv();
    const t2 = [trig("motion", camA.id), trig("linecross", camA.id)];
    const noWin = await env.call("POST", "/rules", onEvent({ triggers: t2 }));
    assert.status(noWin, 422, "RULE_INVALID");
    assert.eq(issue(noWin), "rule.noWindow", "all без окна");
    const win = await env.call("POST", "/rules", onEvent({ triggers: t2, whenLogic: "any", windowSec: 30 }));
    assert.status(win, 422, "RULE_INVALID");
    assert.eq(issue(win), "rule.extraWindow", "any с окном");
    assert.status(await env.call("POST", "/rules", onEvent({ triggers: t2, whenLogic: "some" })), 422, "VALIDATION_FAILED", "значение вне any и all");
    const made = await env.ok("POST", "/rules", onEvent({ triggers: t2, whenLogic: "any" }));
    assert.eq([made.whenLogic, made.windowSec], ["any", 0], "сохранено");
    const n = (await fireList(env, made.id)).length;
    assert.status(await unitEvent(env, camA.id, "linecross"), 200);
    let fires = await fireList(env, made.id);
    const last = (l) => l[l.length - 1];
    assert.eq([fires.length, last(fires).by, last(fires).events.map((e) => e.event)], [n + 1, "event", ["linecross"]], "второе событие запустило само");
    assert.status(await unitEvent(env, camA.id, "motion"), 200);
    fires = await fireList(env, made.id);
    assert.eq([fires.length, last(fires).events.map((e) => e.event)], [n + 2, ["motion"]], "первое событие тоже");
    assert.status(await unitEvent(env, camA.id, "silent"), 200);
    assert.eq((await fireList(env, made.id)).length, n + 2, "чужое событие правило не слышит");
    const one = { source: "unit", event: "motion", match: {}, deviceId: camA.id };
    const test = (rule) => env.ok("POST", "/rules/test", { ruleId: null, rule, events: [one], at: null, branches: {}, log: false });
    const any = await test(onEvent({ triggers: t2, whenLogic: "any" }));
    assert.ok(any.checks.length > 0 && any.checks.every((c) => c.ok) && any.checks.some((c) => c.code === "event.came"), "пробный запуск: одного события хватает");
    const second = await env.ok("POST", "/rules/test", { ruleId: null, rule: onEvent({ triggers: t2, whenLogic: "any" }), events: [{ source: "unit", event: "linecross", match: {}, deviceId: camA.id }], at: null, branches: {}, log: false });
    assert.ok(second.checks.every((c) => c.ok) && second.checks.some((c) => c.code === "event.came" && c.params.trigger.event === "linecross") && !second.checks.some((c) => c.code === "event.other"), "пробный запуск any: подошло событие второго триггера");
    const all = await test(onEvent({ triggers: t2, windowSec: 30 }));
    assert.ok(all.checks.some((c) => c.code === "event.missing" && !c.ok), "пробный запуск all: второго события нет");
  }, { needs: ["kind:camera"] });

  test("«Или» между условиями: condLogic any — достаточно одного, all — нужны все; ни одно не выполнено — запуск пропущен", async () => {
    const env = await makeEnv();
    const armed = (value) => ({ kind: "armed", target: dev(camA.id), value });
    const mk = (over) => env.ok("POST", "/rules", blank(over));
    const run = (r) => env.ok("POST", `/rules/${r.id}/run`, { idempotencyKey: ApiTest.key() });
    const all = await mk({ conditions: [armed(true), armed(false)] });
    assert.eq(all.condLogic === undefined || all.condLogic === "all", true, "умолчание — all");
    let f = await run(all);
    assert.eq([f.result, f.checks.filter((c) => !c.ok).length], ["skip", 1], "all: одно из двух условий не выполнено — запуск пропущен");
    const any = await mk({ conditions: [armed(true), armed(false)], condLogic: "any" });
    f = await run(any);
    assert.eq([any.condLogic, f.result, f.steps.map((s) => s.state)], ["any", "ok", ["ok"]], "any: одно из двух выполнено — запуск идёт");
    assert.ok(f.checks.length > 0 && f.checks.every((c) => c.ok), "в проверках — выполненное");
    const state = await env.ok("GET", `/units/${camA.id}`);
    const isArmed = !!((state.status && state.status.observed) || {}).armed || !!(state.properties || {}).armed;
    const none = await mk({ conditions: [armed(!isArmed), armed(!isArmed)], condLogic: "any" });
    f = await run(none);
    assert.eq([f.result, f.checks.filter((c) => !c.ok).length, f.steps.every((s) => s.state === "skip")], ["skip", 2, true], "any: оба условия не выполнены — запуск пропущен");
    assert.status(await env.call("POST", "/rules", blank({ conditions: [armed(true)], condLogic: "both" })), 422, "VALIDATION_FAILED", "значение вне any и all");
  }, { needs: ["kind:camera"] });

  test("Шаг check: проверка по состоянию сервера — ветка yes или no, исход видно в трассе; пробный запуск задаёт исход сам", async () => {
    const env = await makeEnv();
    const made = await env.ok("POST", "/rules", blank({ steps: [check("online", dev(camA.id), [recB()], [act("record", dev(camB.id), { duration: "min", minutes: 7 })], { depthSec: 60 })] }));
    const run = () => env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() });
    let f = await run();
    assert.eq(f.steps[0].label.code, "ctl.check", "подпись шага");
    assert.eq(f.steps[0].note.code, "check.yes", "камера на связи — да");
    assert.eq(f.steps.filter((s) => !s.control).map((s) => [s.path, s.state]), [["0.yes.0", "ok"]], "выполнилась ветка yes");
    assert.ok(f.steps.some((s) => s.path === "0.no" && s.skip), "ветка no пропущена");
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: camA.id, online: false }), 200);
    f = await run();
    assert.eq([f.steps[0].note.code, f.steps.filter((s) => !s.control).map((s) => s.path)], ["check.no", ["0.no.0"]], "камеры нет на связи — ветка no");
    const t = await env.ok("POST", "/rules/test", { ruleId: made.id, rule: body(made), events: [], at: null, branches: { 0: "yes" }, log: false });
    assert.ok(t.steps.some((s) => s.path === "0.yes.0"), "в пробном запуске исход задан в branches");
    const rec = cams.find((c) => c.archiveId && c.recordMode && c.recordMode !== "none" && (c.recordState === undefined || c.recordState === "running"));
    const wait = FX.devices.find((c) => c.type === "camera" && c.archiveId && c.recordMode && c.recordMode !== "none" && c.recordState === "waiting");
    if (wait) {
      const r3 = await env.ok("POST", "/rules", blank({ steps: [check("record", dev(wait.id), [recB()], [], { depthSec: 3600 })] }));
      f = await env.ok("POST", `/rules/${r3.id}/run`, { idempotencyKey: ApiTest.key() });
      assert.eq(f.steps[0].note.code, "check.no", "запись настроена, но ждёт (recordState: waiting) — не пишет сейчас");
    }
    if (rec) {
      const r2 = await env.ok("POST", "/rules", blank({ steps: [check("record", dev(rec.id), [recB()], [], { depthSec: 3600 })] }));
      f = await env.ok("POST", `/rules/${r2.id}/run`, { idempotencyKey: ApiTest.key() });
      assert.eq(f.steps[0].note.code, "check.yes", "камера пишет — проверка record проходит");
    }
  }, { needs: ["kind:camera", "clock"] });

  test("Шаг check: цель, вид и глубина проверяются — 422 RULE_INVALID у включённого, выключенное хранится", async () => {
    const env = await makeEnv();
    const bad = async (s, code, why) => {
      const res = await env.call("POST", "/rules", blank({ steps: [step, s] }));
      assert.status(res, 422, "RULE_INVALID", why);
      assert.eq(issue(res), code, why);
    };
    await bad(check("online", null), "control.noTarget", "нет цели");
    await bad(check("record", dev(camA.id)), "control.depth", "record без глубины");
    await bad(check("record", dev(camA.id), [], [], { depthSec: 0 }), "control.depth", "глубина 0");
    const tooDeep = await env.call("POST", "/rules", blank({ steps: [step, check("safe", dev(camA.id), [], [], { depthSec: 86401 })] }));
    assert.status(tooDeep, 422, "VALIDATION_FAILED", "глубина больше суток — граница схемы");
    await bad(check("armed", { include: [], exclude: [], gone: [], fromEvent: true }), "control.noEventDevice", "объекта из события нет");
    assert.status(await env.call("POST", "/rules", blank({ steps: [check("fresh", dev(camA.id))] })), 422, "VALIDATION_FAILED", "вид проверки вне перечня");
    assert.status(await env.call("POST", "/rules", blank({ steps: [step, check("armed", dev(camA.id))] })), 201, null, "armed без глубины");
    assert.status(await env.call("POST", "/rules", blank({ enabled: false, steps: [check("record", null)] })), 201, null, "выключенное хранится");
    const noCtl = makeEnv({ fixturePatch: { reference: { ruleControls: ref.ruleControls.filter((c) => c.control !== "check") } } });
    const res = await (await noCtl).call("POST", "/rules", blank({ steps: [check("armed", dev(camA.id))] }));
    assert.status(res, 422, "NOT_SUPPORTED");
    assert.eq([res.body.field, issue(res)], ["steps", "control.notDeclared"], "система не объявила check");
  }, { needs: ["kind:camera"] });

  test("Шаг after: ждёт конца предыдущего шага, не дольше sec; запись в трассе между шагами; sec вне 1…3600 — 422", async () => {
    const env = await makeEnv();
    const made = await env.ok("POST", "/rules", blank({ steps: [step, { control: "after", sec: 30 }, recB()] }));
    const f = await env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.eq(f.steps.map((s) => [s.path, s.control, s.state]), [["0", false, "ok"], ["1", true, "ok"], ["2", false, "ok"]], "шаги идут по порядку");
    assert.eq([f.steps[1].label.code, f.steps[1].label.params.sec], ["ctl.after", 30], "подпись");
    assert.status(await env.call("POST", "/rules", blank({ steps: [step, { control: "after", sec: 0 }] })), 422, "VALIDATION_FAILED", "sec от 1");
    assert.status(await env.call("POST", "/rules", blank({ steps: [step, { control: "after", sec: 3601 }] })), 422, "VALIDATION_FAILED", "sec до 3600");
  }, { needs: ["kind:camera"] });

  test("Шаг abort: прерывает выполнение — шагов после него, в том числе вне ветки, нет; без abort шаги идут", async () => {
    const env = await makeEnv();
    const steps = [check("online", dev(camA.id), [{ control: "abort" }], [], { depthSec: 60 }), recB()];
    const made = await env.ok("POST", "/rules", blank({ steps }));
    const run = () => env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() });
    let f = await run();
    assert.eq(f.steps.filter((s) => !s.control).length, 0, "камера на связи — yes, abort: запись не началась");
    assert.eq([f.steps.some((s) => s.label && s.label.code === "ctl.abort"), f.result], [true, "ok"], "прерывание в трассе, итог по выполненному");
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: camA.id, online: false }), 200);
    f = await run();
    assert.eq(f.steps.filter((s) => !s.control).map((s) => s.path), ["1"], "камеры нет на связи — ветка no пуста, шаг 1 идёт");
    const only = await env.ok("POST", "/rules", blank({ steps: [{ control: "abort" }, recB()] }));
    assert.status(await env.call("POST", "/rules", blank({ steps: [{ control: "abort" }] })), 422, "RULE_INVALID", "в правиле должно быть действие");
    f = await env.ok("POST", `/rules/${only.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.eq(f.steps.length, 1, "после abort в списке верхнего уровня — ничего");
  }, { needs: ["kind:camera", "clock"] });

  test("Расписание с интервалом: runAt.everyMin запускает правило по часам, randomShift сдвигает запуск в своём интервале", async () => {
    const env = await makeEnv();
    const runAt = (over) => Object.assign({ days: [1, 2, 3, 4, 5, 6, 7], time: "00:00" }, over);
    const sched = (over) => blank(Object.assign({ start: "schedule", runMode: "always", runAt: runAt({ everyMin: 60 }) }, over));
    const noEvery = await env.call("POST", "/rules", sched({ runAt: runAt({ randomShift: true }) }));
    assert.status(noEvery, 422, "RULE_INVALID");
    assert.eq(issue(noEvery), "rule.noEvery", "сдвиг без интервала");
    assert.status(await env.call("POST", "/rules", sched({ runAt: runAt({ everyMin: 0 }) })), 422, "VALIDATION_FAILED", "интервал от 1");
    assert.status(await env.call("POST", "/rules", sched({ runAt: runAt({ everyMin: 10081 }) })), 422, "VALIDATION_FAILED", "интервал до недели");
    const plain = await env.ok("POST", "/rules", sched());
    const shifted = await env.ok("POST", "/rules", sched({ runAt: runAt({ everyMin: 60, randomShift: true }) }));
    const once = await env.ok("POST", "/rules", sched({ runAt: runAt() }));
    assert.eq([plain.runAt.everyMin, shifted.runAt.randomShift], [60, true], "поля сохранены");
    const n = async (r) => (await fireList(env, r.id)).length;
    const was = [await n(plain), await n(shifted), await n(once)];
    await env.advance(3 * 3600);
    const got = [await n(plain), await n(shifted), await n(once)];
    const d = got.map((v, i) => v - was[i]);
    assert.eq([d[0], d[2]], [3, 0], "за 3 часа — по запуску в каждый час; без everyMin часы не запускают");
    assert.ok(d[1] >= 2 && d[1] <= 4, "со сдвигом — по запуску в своём часу, последний мог выйти за границу: " + d[1]);
    const fires = await fireList(env, shifted.id);
    assert.eq([fires[fires.length - 1].by, new Set(fires.map((f) => f.at)).size - new Set(fires.slice(0, fires.length - d[1]).map((f) => f.at)).size], ["sched", d[1]], "запуски по расписанию в разные моменты");
    await env.advance(30 * 60);
    assert.eq((await n(plain)) - got[0] <= 1, true, "дальше — не чаще интервала");
  }, { needs: ["kind:camera", "clock"] });

  test("Новые события видов: объявлены в описаниях, принимаются /test/events, запускают правило; уточнение presence — строго", async () => {
    const env = await makeEnv();
    const camera = await env.ok("GET", "/kinds/camera");
    const ids = camera.events.map((e) => e.id);
    ["device.lost", "device.restored", "tamper", "fire", "smoke", "face.list", "plate.list", "alarm.closed", "alarm.confirmed", "rec.lost", "arm.off", "ptz.failed"]
      .forEach((id) => assert.ok(ids.includes(id), `у камеры есть событие ${id}`));
    const lost = camera.events.find((e) => e.id === "device.lost");
    assert.eq(lost.params.properties.thresholdSec.enum, ["10", "30", "60", "300"], "уточнение порога обрыва");
    const plate = camera.events.find((e) => e.id === "plate.list");
    assert.eq([plate.params.properties.presence.enum, camera.events.find((e) => e.id === "fire").ends], [["yes", "no"], true], "presence yes и no, огонь имеет конец");
    const made = await env.ok("POST", "/rules", onEvent({ triggers: [trig("plate.list", camA.id, { presence: "yes" })] }));
    const n = async () => (await fireList(env, made.id)).length;
    const was = await n();
    assert.status(await unitEvent(env, camA.id, "plate.list", { presence: "no" }), 200);
    assert.eq(await n(), was, "нет в списке — правило не слышит");
    assert.status(await unitEvent(env, camA.id, "plate.list", { presence: "yes" }), 200);
    assert.eq(await n(), was + 1, "есть в списке — запуск");
    assert.status(await unitEvent(env, camA.id, "tamper"), 200, null, "tamper принят");
    // События других видов: объявлены и принимаются, пока в наборе есть объект такого вида
    const byKind = { relay: ["output.on"], server: ["server.down", "server.up", "license.lost", "load.high", "sched.edge"], volume: ["volume.error", "volume.ok"] };
    for (const [kind, list] of Object.entries(byKind)) {
      const u = (FX.units || []).find((x) => x.kind === kind);
      const desc = await env.call("GET", `/kinds/${kind}`);
      if (!u || desc.status !== 200) continue;
      list.forEach((id) => assert.ok(desc.body.events.some((e) => e.id === id), `у вида ${kind} есть событие ${id}`));
      for (const id of list) assert.status(await unitEvent(env, u.uid, id), 200, null, `${kind}: ${id} принято`);
    }
    const vol = (FX.units || []).find((x) => x.kind === "volume");
    if (vol) {
      const r = await env.ok("POST", "/rules", onEvent({ triggers: [{ source: "unit", kinds: ["volume"], event: "volume.error", target: dev(vol.uid), match: {} }] }));
      const w = (await fireList(env, r.id)).length;
      assert.status(await unitEvent(env, vol.uid, "volume.error"), 200);
      assert.eq((await fireList(env, r.id)).length, w + 1, "ошибка тома запускает правило на томе");
    }
  }, { needs: ["kind:camera"] });

  test("Новые команды и действия: export, replicate, ptz.tour, program, service, play, push, client.* — объявлены, проверяются, пишутся в журнал запуска", async () => {
    const env = await makeEnv();
    const kindsAct = async (kind) => { const r = await env.call("GET", `/kinds/${kind}`); return r.status === 200 ? r.body.actions || [] : []; };
    const camera = await kindsAct("camera");
    ["export", "replicate", "ptz.tour"].forEach((id) => assert.ok(camera.some((a) => a.id === id && a.ruleAction && a.ruleOnly), `у камеры команда ${id}`));
    const props = (id) => ((camera.find((a) => a.id === id) || {}).params || {}).properties || null;
    const fields = { record: ["preSec", "fps"], alarm: ["mode", "comment"], alarmclose: ["resolution"], preset: ["speed", "holdSec"] };
    Object.entries(fields).forEach(([id, list]) => props(id) && assert.ok(list.every((f) => f in props(id)), `новые поля команды ${id}: ${list}`));
    assert.ok(props("record") && props("preset"), "record и preset есть у любой системы с камерами");
    const steps = [act("export", dev(camA.id), { mode: "clip", beforeSec: 10, afterSec: 20 }), act("replicate", dev(camA.id), { period: "event" }), act("ptz.tour", dev(camA.id), { command: "start", tour: "1" }),
      act("record", dev(camA.id), { duration: "min", minutes: 5, preSec: 5, fps: 12 }), act("preset", dev(camA.id), { preset: 1, speed: 50, holdSec: 10 })];
    const made = await env.ok("POST", "/rules", blank({ steps }));
    let f = await env.ok("POST", `/rules/${made.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.eq(f.steps.map((s) => [s.action.action, s.state]), steps.map((s) => [s.action, "ok"]), "команды камеры в журнале запуска");
    assert.status(await env.call("POST", "/rules", blank({ steps: [act("record", dev(camA.id), { duration: "min", minutes: 5, fps: 500 })] })), 422, "RULE_INVALID", "fps вне предела");
    const srv = (FX.units || []).find((u) => u.kind === "server");
    if (srv && (await kindsAct("server")).some((a) => a.id === "program")) {
      const s2 = [act("program", dev(srv.uid), { path: "/usr/bin/true", args: "-q" }), act("service", dev(srv.uid), { state: "off", service: "ntp" })];
      const r2 = await env.ok("POST", "/rules", blank({ steps: s2 }));
      f = await env.ok("POST", `/rules/${r2.id}/run`, { idempotencyKey: ApiTest.key() });
      assert.eq(f.steps.map((s) => [s.action.action, s.state]), [["program", "ok"], ["service", "ok"]], "команды сервера");
    }
    const spk = (FX.units || []).find((u) => u.kind === "spk");
    if (spk && (await kindsAct("spk")).some((a) => a.id === "play")) {
      const r3 = await env.ok("POST", "/rules", blank({ steps: [act("play", dev(spk.uid), { file: "siren.wav" })] }));
      f = await env.ok("POST", `/rules/${r3.id}/run`, { idempotencyKey: ApiTest.key() });
      assert.eq(f.steps.map((s) => [s.action.action, s.state]), [["play", "ok"]], "звук на динамике");
    }
    // Действия системы: справочник объявляет, поля с перечнем проверяются
    const have = (s, a) => ref.ruleActions.find((x) => x.source === s && x.action === a);
    if (!have("ntf", "push")) return;
    const role = FX.access.roles[0].id;
    const sys = [{ source: "ntf", action: "push", to: "ops", subject: "{камера}", attach: "snapshot" }, { source: "client", action: "sound", file: "a.wav", roleId: role }, { source: "client", action: "voice", roleId: role },
      { source: "client", action: "view", view: "map", roleId: role }, { source: "client", action: "program", path: "/bin/true", roleId: role }, { source: "net", action: "http", method: "PUT", url: "http://x.test/a", auth: "bearer", headers: "X: 1", body: "{}" }];
    const r4 = await env.ok("POST", "/rules", blank({ steps: [step, ...sys.filter((x) => have(x.source, x.action))] }));
    f = await env.ok("POST", `/rules/${r4.id}/run`, { idempotencyKey: ApiTest.key() });
    assert.ok(f.steps.length > 1 && f.steps.every((s) => s.state === "ok"), "действия системы пишутся в журнал запуска");
    const badAttach = await env.call("POST", "/rules", blank({ steps: [{ source: "ntf", action: "push", to: "ops", subject: "x", attach: "audio" }] }));
    assert.status(badAttach, 422, "VALIDATION_FAILED", "attach вне перечня");
    const noSubj = await env.call("POST", "/rules", blank({ steps: [{ source: "ntf", action: "push", to: "ops" }] }));
    assert.status(noSubj, 422, "RULE_INVALID", "тема обязательна");
  }, { needs: ["kind:camera"] });

  test("Шаг check до вопроса: при возобновлении исход проверки тот же, что был при остановке запуска", async () => {
    const env = await envWith({ steps: [check("online", dev(cam.id), [rec(cam.id)], []), ask({ yes: [], no: [] })] });
    const f = await run(env);
    assert.eq(f.steps[0].note.code, "check.yes", "камера на связи — yes");
    assert.status(await env.call("POST", "/test/events", { type: "device.signal", deviceId: cam.id, online: false }), 200);
    const [p] = await env.list("/rule-prompts");
    assert.status(await env.call("POST", `/rule-prompts/${p.id}/answer`, { answer: "yes" }), 202);
    const now = await fireOf(env, f.id);
    assert.eq([now.steps[0].note.code, now.steps.filter((s) => s.action).map((s) => s.path)], ["check.yes", ["0.yes.0"]], "запись запуска сохранила прежнюю ветку, хотя камера уже без связи");
  }, { needs: [...PROMPTS, "clock"] });

  test("Расписание с интервалом: выключенное правило не догоняет пропущенное, /test/reset очищает память", async () => {
    const env = await makeEnv();
    const mk = (over) => blank(Object.assign({ start: "schedule", runMode: "always", runAt: { days: [1, 2, 3, 4, 5, 6, 7], time: "00:00", everyMin: 60 } }, over));
    const r = await env.ok("POST", "/rules", mk());
    await env.list(`/rules/${r.id}/fires`);
    const off = (await env.ok("POST", "/rules/update", { idempotencyKey: ApiTest.key(), items: [{ ruleId: r.id, version: r.version, set: { enabled: false } }] })).done[0];
    await env.advance(5 * 3600);
    const n = (await fireList(env, r.id)).length;
    await env.ok("POST", "/rules/update", { idempotencyKey: ApiTest.key(), items: [{ ruleId: r.id, version: off.version, set: { enabled: true } }] });
    assert.eq((await fireList(env, r.id)).length, n, "включили — пропущенные за 5 часов запуски не выполнены");
    await env.advance(2 * 3600);
    assert.ok((await fireList(env, r.id)).length - n >= 1 && (await fireList(env, r.id)).length - n <= 2, "дальше правило идёт по часам");
  }, { needs: ["kind:camera", "clock"] });

  test("Что система не объявила в reference.ruleFeatures, того включённое правило не получает: 422 NOT_SUPPORTED", async () => {
    const t2 = [trig("motion", camA.id), trig("linecross", camA.id)];
    const run0 = await makeEnv();
    assert.ok((await run0.ok("GET", "/reference")).ruleFeatures.join() === "whenAny,condAny,every", "эталонный набор объявляет все три");
    const env = await makeEnv({ fixturePatch: { reference: { ruleFeatures: [] } } });
    const expect = async (rule, field, feature, why) => {
      const res = await env.call("POST", "/rules", rule);
      assert.status(res, 422, "NOT_SUPPORTED", why);
      assert.eq([res.body.field, issue(res), res.body.params.issue.params.feature], [field, "rule.featureNotDeclared", feature], why);
    };
    await expect(onEvent({ triggers: t2, whenLogic: "any" }), "triggers", "whenAny", "whenLogic: any");
    await expect(blank({ conditions: [{ kind: "armed", target: dev(camA.id), value: true }], condLogic: "any" }), "conditions", "condAny", "condLogic: any");
    await expect(blank({ start: "schedule", runMode: "always", runAt: { days: [1], time: "10:00", everyMin: 30 } }), "start", "every", "everyMin");
    assert.status(await env.call("POST", "/rules", onEvent({ triggers: t2, whenLogic: "all", windowSec: 30 })), 201, null, "all — как всегда");
    assert.status(await env.call("POST", "/rules", onEvent({ enabled: false, triggers: t2, whenLogic: "any" })), 201, null, "выключенное хранится");
  }, { needs: ["kind:camera"] });

  test("Шаг check без цели в пробном запуске — 422 RULE_INVALID control.noTarget, а не сбой сервера", async () => {
    const env = await makeEnv();
    const res = await env.call("POST", "/rules/test", { ruleId: null, rule: blank({ enabled: false, steps: [step, check("armed", null)] }), events: [], at: null, branches: {}, log: false });
    assert.status(res, 422, "RULE_INVALID");
    assert.eq(issue(res), "control.noTarget", "причина");
  }, { needs: ["kind:camera"] });

  ApiTest.loaded("api-automation.js");
})();
