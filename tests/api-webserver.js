/* Тесты API: веб-сервер и RTSP-сервер сервера (профиль vms.webserver/1, контракт 0.11.0).
   Настройка — свойство webServer (enabled, httpPort, httpsPort, urlPrefix, cors, recompress, rtspPort, rtspHttpPort): JSON Merge
   Patch по полям, поля нет — умолчание. Сертификат HTTPS — status.observed.webCertificate, только чтение; загружает его команда
   webcert.set (сертификат и закрытый ключ PEM), убирает — webcert.remove. Ключ сервер хранит у себя и нигде не отдаёт: ни в
   объекте, ни в ответе команды, ни в журнале, ни в операциях. Порты видео для браузера — status.observed.webReservedPorts.
   Встроенный сервер X.509 не разбирает: сведения берёт из заголовка openssl x509 -text перед блоком PEM, «ключ не подходит» —
   ключ стенда со словом mismatch вне блока. */
(() => {
  const { test, makeEnv, assert } = ApiTest;
  const id = (n) => `${n}-0000-4000-8000-000000000000`;
  const v = (rec) => ({ "If-Match": `"${rec.version}"` });
  const U = (uid) => `/units/${uid}`;
  // Офис — с сертификатом в наборе, Склад — без сертификата, Филиал — без связи
  const S = { office: id(20000001), store: id(20000002), off: id(20000003) };
  const DEF = { enabled: true, httpPort: 80, httpsPort: 443, urlPrefix: "/", cors: false, recompress: false, rtspPort: 554, rtspHttpPort: 8554 };
  const needs = ["patchUnit", "runUnitAction", "implements:vms.webserver/1"];
  const get = (env, uid) => env.ok("GET", U(uid));
  const web = (u) => u.properties.webServer;
  const cert = (u) => u.status.observed.webCertificate;
  const setWeb = (env, u, webServer) => env.call("PATCH", U(u.uid), { properties: { webServer } }, v(u));
  const act = (env, uid, action, params) => env.call("POST", `${U(uid)}/actions/${action}`, { params });
  const field = (res, code, name, msg) => { assert.status(res, 422, code, msg); assert.eq(res.body.field, name, `${msg}: поле`); };
  // Сертификат стенда: заголовок openssl x509 -text, затем блоки PEM. Тело ключа — метка, по которой тест ищет утечку
  const day = 86400000;
  const gmt = (ms) => new Date(ms).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$2 $1 $4 $3 GMT");
  const KEY_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCsecretKEYmarker";
  const pem = (type, body) => `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----\n`;
  const certPem = (now, over = {}) => [
    `Certificate:\n    Data:\n        Issuer: C = BE, O = GlobalSign nv-sa, CN = ${over.issuer || "GlobalSign RSA OV SSL CA 2018"}\n`,
    `        Validity\n            Not Before: ${gmt(over.from ?? now - 30 * day)}\n            Not After : ${gmt(over.to ?? now + 300 * day)}\n`,
    `        Subject: C = RU, O = VMS, CN = ${over.subject || "*.vms.test.ru"}\n`,
    `            X509v3 Subject Alternative Name:\n                DNS:${over.subject || "*.vms.test.ru"}, DNS:vms.test.ru\n`,
    pem("CERTIFICATE", "MIIGxDCCBaygAwIBAgIMleaf"),
    over.leafOnly ? "" : pem("CERTIFICATE", "MIIETjCCAzagAwIBAgINintermediate"),
  ].join("");
  const keyPem = (pre = "") => pre + pem("PRIVATE KEY", KEY_BODY);

  test("Веб-сервер: умолчания, сертификат и порты видео в ответе", async () => {
    const env = await makeEnv();
    const office = await get(env, S.office);
    assert.eq(web(office), DEF, "поля webServer нет в наборе — умолчания Axxon One");
    assert.eq([cert(office).subject, cert(office).wildcard, cert(office).chain, cert(office).keyMatches], ["*.vms.example.ru", true, "full", true], "сертификат Офиса");
    assert.eq(office.status.observed.webReservedPorts, { from: 9001, to: 9009 }, "9001 и по одному порту на ядро");
    const store = await get(env, S.store);
    assert.eq(cert(store), null, "у Склада сертификата нет: только HTTP");
    const row = (await env.list("/units?kind=server")).find((u) => u.uid === S.store);
    assert.eq(web(row), DEF, "умолчания — и в перечне GET /units?kind=server");
  }, { needs: ["implements:vms.webserver/1"] });

  test("Веб-сервер: правка — по полям, остальное остаётся; выключение; отказы портов и префикса", async () => {
    const env = await makeEnv();
    let s = await get(env, S.store);
    let res = await setWeb(env, s, { httpPort: 8080, urlPrefix: "/vms" });
    assert.status(res, 200, null, "PATCH httpPort и urlPrefix");
    s = res.body;
    assert.eq(web(s), Object.assign({}, DEF, { httpPort: 8080, urlPrefix: "/vms" }), "изменились только названные поля");
    res = await setWeb(env, s, { enabled: false, cors: true, recompress: true });
    assert.status(res, 200, null, "выключить веб-сервер, CORS и перекодирование");
    s = res.body;
    assert.eq([web(s).enabled, web(s).cors, web(s).recompress, web(s).httpPort], [false, true, true, 8080], "флажки и прежний порт");
    field(await setWeb(env, s, { httpsPort: 8080 }), "PORT_TAKEN", "/properties/webServer/httpsPort", "HTTPS на порту HTTP");
    res = await setWeb(env, s, { rtspPort: 8080 });
    assert.eq(res.body.params, { port: 8080, other: "httpPort" }, "params: порт и поле, которое его занимает");
    field(await setWeb(env, s, { rtspHttpPort: 9004 }), "PORT_TAKEN", "/properties/webServer/rtspHttpPort", "порт из диапазона видео");
    assert.eq((await setWeb(env, s, { rtspHttpPort: 9004 })).body.params.other, "webReservedPorts", "params.other — webReservedPorts");
    field(await setWeb(env, s, { httpPort: 70000 }), "VALIDATION_FAILED", "/properties/webServer/httpPort", "порт больше 65535");
    field(await setWeb(env, s, { httpPort: 0 }), "VALIDATION_FAILED", "/properties/webServer/httpPort", "порт 0");
    field(await setWeb(env, s, { urlPrefix: "vms" }), "VALIDATION_FAILED", "/properties/webServer/urlPrefix", "префикс без «/»");
    field(await setWeb(env, s, { urlPrefix: "/my vms" }), "VALIDATION_FAILED", "/properties/webServer/urlPrefix", "префикс с пробелом");
    field(await setWeb(env, s, { http: 80 }), "VALIDATION_FAILED", "/properties/webServer/http", "незнакомое поле");
    assert.eq(web(await get(env, S.store)), Object.assign({}, DEF, { httpPort: 8080, urlPrefix: "/vms", enabled: false, cors: true, recompress: true }), "отказы ничего не изменили");
    res = await setWeb(env, await get(env, S.store), null);
    assert.status(res, 200, null, "webServer: null");
    assert.eq(web(res.body), DEF, "null — снова умолчания");
  }, { needs });

  test("Веб-сервер: правка шагом операции и откат возвращают прежние значения", async () => {
    const env = await makeEnv();
    const s = await get(env, S.store);
    const op = await env.runOperation({ idempotencyKey: "web-op-1", items: [{ uid: s.uid, patch: { properties: { webServer: { httpPort: 8081, rtspPort: 8554 + 1 } } } }], expectedVersions: { [s.uid]: s.version } });
    assert.eq(op.items.map((x) => x.state), ["ok"], "шаг выполнен");
    assert.eq([web(await get(env, S.store)).httpPort, web(await get(env, S.store)).rtspPort], [8081, 8555], "порты после операции");
    const bad = await env.runOperation({ idempotencyKey: "web-op-2", items: [{ uid: s.uid, patch: { properties: { webServer: { httpsPort: 8081 } } } }], expectedVersions: { [s.uid]: (await get(env, S.store)).version } });
    assert.eq([bad.items[0].state, bad.items[0].code, bad.items[0].params.field], ["fail", "PORT_TAKEN", "/properties/webServer/httpsPort"], "отказ шага — с указателем в теле шага");
    const top = (await env.ok("GET", "/operations?limit=10")).items.find((x) => x.revertible);
    assert.eq(top.id, op.id, "правка — в стопке отката");
    const undo = await env.finished((await env.ok("POST", `/operations/${op.id}/revert`, {})).id);
    assert.eq(undo.items.map((x) => x.state), ["ok"], "откат выполнен");
    assert.eq(web(await get(env, S.store)), DEF, "после отката — умолчания");
  }, { needs: [...needs, "createOperation", "revertOperation"] });

  test("Веб-сервер: обмен портами HTTP и HTTPS двумя шагами одной операции — порты сверяются с итогом", async () => {
    const env = await makeEnv();
    const s = await get(env, S.store);
    const op = await env.runOperation({ idempotencyKey: "web-swap", items: [
      { uid: s.uid, patch: { properties: { webServer: { httpPort: 443 } } } },
      { uid: s.uid, patch: { properties: { webServer: { httpsPort: 80 } } } },
    ], expectedVersions: { [s.uid]: s.version } });
    assert.eq(op.items.map((x) => x.state), ["ok", "ok"], "оба шага выполнены");
    const w = web(await get(env, S.store));
    assert.eq([w.httpPort, w.httpsPort], [443, 80], "порты обменялись");
  }, { needs: [...needs, "createOperation"] });

  test("Сертификат: проверка без сохранения, загрузка, сведения, удаление", async () => {
    const env = await makeEnv();
    const now = env.now;
    let res = await act(env, S.store, "webcert.set", { certificate: certPem(now), privateKey: keyPem(), certificateName: "fullchain.pem", check: true });
    assert.status(res, 200, null, "check: true");
    const info = res.body.result;
    assert.eq([info.subject, info.issuer, info.wildcard, info.chain, info.keyMatches, info.fileName, info.names], ["*.vms.test.ru", "GlobalSign RSA OV SSL CA 2018", true, "full", true, "fullchain.pem", ["*.vms.test.ru", "vms.test.ru"]], "сведения из сертификата");
    assert.ok(Math.abs(Date.parse(info.notAfter) - (now + 300 * day)) < 2000, "срок — Not After");
    assert.eq(cert(await get(env, S.store)), null, "проверка ничего не сохранила");
    res = await act(env, S.store, "webcert.set", { certificate: certPem(now), privateKey: keyPem(), certificateName: "fullchain.pem" });
    assert.status(res, 200, null, "загрузить");
    const saved = cert(await get(env, S.store));
    assert.eq([saved.subject, saved.chain, saved.fileName, !!saved.uploadedAt], ["*.vms.test.ru", "full", "fullchain.pem", true], "сервер хранит сертификат");
    res = await act(env, S.store, "webcert.set", { certificate: certPem(now, { leafOnly: true }), privateKey: keyPem(), check: true });
    assert.eq(res.body.result.chain, "partial", "без промежуточного сертификата — partial");
    res = await act(env, S.store, "webcert.set", { certificate: certPem(now, { subject: "vms-01", issuer: "vms-01", leafOnly: true }), privateKey: keyPem(), check: true });
    assert.eq([res.body.result.chain, res.body.result.wildcard], ["self", false], "самоподписанный");
    res = await act(env, S.store, "webcert.set", { certificate: pem("CERTIFICATE", "MIIBnoheader"), privateKey: keyPem(), check: true });
    assert.eq([res.body.result.subject, res.body.result.chain], ["server.local", "self"], "без заголовка openssl — самоподписанный server.local");
    res = await act(env, S.store, "webcert.remove", {});
    assert.status(res, 200, null, "убрать сертификат");
    assert.eq(cert(await get(env, S.store)), null, "сертификата нет: только HTTP");
  }, { needs });

  test("Сертификат: отказы — не PEM, ключ с паролем, срок, ключ не подходит, нет ключа", async () => {
    const env = await makeEnv();
    const now = env.now;
    const set = (params) => act(env, S.store, "webcert.set", params);
    field(await set({ certificate: "просто текст", privateKey: keyPem() }), "CERTIFICATE_INVALID", "/params/certificate", "сертификат не PEM");
    field(await set({ certificate: certPem(now), privateKey: pem("ENCRYPTED PRIVATE KEY", "MIIFHz") }), "CERTIFICATE_INVALID", "/params/privateKey", "ключ с паролем");
    field(await set({ certificate: certPem(now), privateKey: pem("CERTIFICATE", "MIIx") }), "CERTIFICATE_INVALID", "/params/privateKey", "вместо ключа — сертификат");
    field(await set({ certificate: certPem(now, { to: now - day }), privateKey: keyPem() }), "CERTIFICATE_EXPIRED", "/params/certificate", "срок кончился");
    field(await set({ certificate: certPem(now, { from: now + day }), privateKey: keyPem() }), "CERTIFICATE_EXPIRED", "/params/certificate", "срок не начался");
    field(await set({ certificate: certPem(now), privateKey: keyPem("mismatch\n") }), "KEY_MISMATCH", "/params/privateKey", "ключ не подходит");
    field(await set({ certificate: certPem(now) }), "VALIDATION_FAILED", "/params/privateKey", "нет ключа");
    assert.eq(cert(await get(env, S.store)), null, "отказы ничего не сохранили");
    assert.status(await act(env, S.off, "webcert.set", { certificate: certPem(now), privateKey: keyPem() }), 409, "DEVICE_OFFLINE", "сервер без связи");
  }, { needs });

  test("Закрытый ключ: нигде не отдаётся — объект, ответ команды, журнал; не шаг операции", async () => {
    const env = await makeEnv();
    const now = env.now;
    const res = await act(env, S.store, "webcert.set", { certificate: certPem(now), privateKey: keyPem() });
    assert.status(res, 200, null, "загрузить");
    const leak = (x, where) => assert.ok(!JSON.stringify(x).includes("secretKEYmarker") && !JSON.stringify(x).includes("PRIVATE KEY"), `ключа нет: ${where}`);
    leak(res.body, "ответ команды");
    leak(await get(env, S.store), "GET /units/{uid}");
    leak(await env.list("/units?kind=server"), "GET /units?kind=server");
    leak(await env.ok("GET", "/journal?limit=200"), "GET /journal");
    const step = await env.call("POST", "/operations", { idempotencyKey: "web-key-op", items: [{ uid: S.store, action: "webcert.set", params: { certificate: certPem(now), privateKey: keyPem() } }], expectedVersions: {} });
    field(step, "NOT_SUPPORTED", "/items/0/action", "webcert.set шагом операции");
    assert.eq(step.body.params.reason, "direct", "params.reason: direct");
    leak(await env.ok("GET", "/operations?limit=50"), "GET /operations");
    const kind = await env.ok("GET", "/kinds/server");
    const desc = kind.actions.find((a) => a.id === "webcert.set");
    assert.eq([desc.direct, desc.params.properties.privateKey.writeOnly, !!desc.ruleAction], [true, true, false], "описание команды: direct, ключ writeOnly, не шаг правила");
  }, { needs: [...needs, "createOperation"] });

  test("Закрытый ключ: webcert.set — не шаг правила, и выключенного тоже: правило с ключом не сохраняется", async () => {
    const env = await makeEnv();
    const before = (await env.list("/rules")).length;
    const rule = (enabled) => ({ name: "Сертификат по правилу", enabled, logOnly: false, logOnlySince: null, start: "manual", runMode: "manual", operatorMenu: false, ratePerMinute: 6,
      windowSec: 0, runAt: null, repeat: "skip", triggers: [], conditions: [], owner: "admin", purpose: "", serverId: null, runAsRoleId: null, allowChain: true,
      steps: [{ type: "unitAction", action: "webcert.set", target: { include: [{ uid: S.store }], exclude: [], gone: [], fromEvent: false }, params: { certificate: certPem(env.now), privateKey: keyPem() } }] });
    for (const enabled of [false, true]) {
      const res = await env.call("POST", "/rules", rule(enabled));
      assert.status(res, 422, "NOT_SUPPORTED", `правило с webcert.set, enabled: ${enabled}`);
      assert.eq([res.body.field, res.body.params.reason], ["steps", "direct"], `поле и причина, enabled: ${enabled}`);
    }
    const rules = await env.list("/rules");
    assert.eq(rules.length, before, "правило не сохранено");
    assert.ok(!JSON.stringify(rules).includes("secretKEYmarker"), "ключа нет в GET /rules");
  }, { needs: [...needs, "createRule", "listRules"] });

  ApiTest.loaded("api-webserver.js");
})();
