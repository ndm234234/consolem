/* Тесты API: правила автоматизации, опции, лицензии. */
(() => {
  const { test, makeEnv, assert } = ApiTest;
  const FX = ApiTest.FX;
  const r1 = FX.rules[0];
  const body = (r, over) => ({ name: r.name, enabled: r.enabled, ratePerMinute: r.ratePerMinute, windowSec: r.windowSec, triggers: r.triggers, actions: r.actions, ...over });

  test("Правило: сохранить целиком — события и действия по порядку, версия +1", async () => {
    const env = await makeEnv();
    const triggers = r1.triggers.slice().reverse().concat({ source: "vms", kind: "silent", unit: "Касса 5" });
    const actions = [{ source: "vms", action: "output", unit: "Сирена", port: 2, state: "pulse", pulseMs: 800 }];
    const res = await env.call("PUT", `/rules/${r1.id}`, body(r1, { name: "Ночь — вход", enabled: false, triggers, actions }), { "If-Match": `"${r1.version}"` });
    assert.status(res, 200);
    assert.eq([res.body.name, res.body.enabled, res.body.triggers.map((x) => x.unit), res.body.actions, res.body.version],
      ["Ночь — вход", false, triggers.map((x) => x.unit), actions, r1.version + 1], "сохранено");
    assert.eq((await env.ok("GET", `/rules/${r1.id}`)).triggers.length, triggers.length, "перечитано");
  });

  test("Правило: незаконченное сохраняется (без действий, окно у одного события) — проверка смысла в интерфейсе", async () => {
    const env = await makeEnv();
    const res = await env.call("PUT", `/rules/${r1.id}`, body(r1, { triggers: r1.triggers.slice(0, 1), actions: [], windowSec: 30 }), { "If-Match": `"${r1.version}"` });
    assert.status(res, 200);
  });

  test("Правило: без версии — 428, старая — 412, пустое название и чужой тип поля — 422, нет правила — 404", async () => {
    const env = await makeEnv();
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(r1)), 428, "PRECONDITION_REQUIRED");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(r1), { "If-Match": `"${r1.version + 1}"` }), 412, "VERSION_MISMATCH");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(r1, { name: " " }), { "If-Match": `"${r1.version}"` }), 422, "NAME_REQUIRED");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(r1, { actions: [{ source: "vms", action: "output", port: "2" }] }), { "If-Match": `"${r1.version}"` }), 422, "VALIDATION_FAILED", "номер реле — числом");
    assert.status(await env.call("PUT", `/rules/${r1.id}`, body(r1, { ratePerMinute: 0 }), { "If-Match": `"${r1.version}"` }), 422, "VALIDATION_FAILED", "потолок — от 1");
    assert.status(await env.call("PUT", "/rules/70009999-0000-4000-8000-000000000000", body(r1), { "If-Match": '"1"' }), 404, "NOT_FOUND");
  });

  test("Опции: изменить часть — остальное на месте, версия +1; чужой ключ и значение не из списка — 422", async () => {
    const env = await makeEnv();
    const s = FX.settings;
    const res = await env.call("PATCH", "/settings", { values: { "ntp.server": "time.local", "sec.pwdage": 30 } }, { "If-Match": `"${s.version}"` });
    assert.status(res, 200);
    assert.eq([res.body.values["ntp.server"], res.body.values["sec.pwdage"], res.body.values["mail.smtp"], res.body.version], ["time.local", 30, s.values["mail.smtp"], s.version + 1], "сохранено");
    assert.status(await env.call("PATCH", "/settings", { values: { "sec.2fa": "always" } }, { "If-Match": `"${s.version + 1}"` }), 422, "VALIDATION_FAILED");
    assert.status(await env.call("PATCH", "/settings", { values: { "ui.theme": "dark" } }, { "If-Match": `"${s.version + 1}"` }), 422, "VALIDATION_FAILED");
    assert.status(await env.call("PATCH", "/settings", { values: {} }), 428, "PRECONDITION_REQUIRED");
  });

  ApiTest.loaded("api-rules.js");
})();
