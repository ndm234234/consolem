/* Тесты API: ядро универсальной модели — описания видов (/kinds) и объекты склада (/units), дерево на складе. Чтение и запись
   объектов видов без профиля: создание, правка, удаление, перенос, команды, проверка без записи, шаги операций по uid. */
(() => {
  const { makeEnv, assert, FX } = ApiTest;
  // Виды плагинов и тестовые виды есть не в каждой системе (профиль «один домен» их не объявляет): тест, где вид назван
  // (литерал или CONTROLLER, SENSOR), получает needs "kind:<вид>" сам и без вида пропускается
  const PLUGIN_NEEDS = [[/CONTROLLER/, "kind:security_controller/CONTROLLER"], [/\bSENSOR\b|security_controller\/SENSOR/, "kind:security_controller/SENSOR"], [/test\.unknown|\bT\b|\bt[12]\(\)/, "kind:test.unknown"],
    [/test\.perunit|\bPER\b/, "kind:test.perunit"], [/w2c\.example\/rows|\bROWS\b/, "kind:w2c.example/rows"], [/domain\.shared|\bDOC\b/, "kind:domain.shared"]];
  const test = (name, fn, opts) => {
    const text = name + String(fn), needs = ((opts && opts.needs) || []).slice();
    PLUGIN_NEEDS.forEach(([re, need]) => re.test(text) && !needs.includes(need) && needs.push(need));
    ApiTest.test(name, fn, Object.assign({}, opts, { needs }));
  };
  const UNKNOWN = "30009999-0000-4000-8000-000000000000";
  const CONTROLLER = "security_controller/CONTROLLER";
  const SENSOR = "security_controller/SENSOR";
  const kindPath = (kind) => `/kinds/${encodeURIComponent(kind)}`;
  const units = () => FX.units || [];
  const kindOf = (code) => (FX.kinds || []).find((k) => k.kind === code);
  const ofKind = (code) => units().filter((u) => u.kind === code);
  const sorted = (list) => list.slice().sort();
  const uids = (list) => list.map((u) => u.uid);
  const dom1 = () => units().find((u) => u.kind === "domain").uid;
  const query = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  // Перечень страницами по limit: каждая страница не длиннее limit, без повторов
  async function paged(env, path, limit) {
    const out = [];
    let cursor = null, pages = 0;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const res = await env.ok("GET", `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.ok(res.items.length <= limit, `${path}: страница ${res.items.length} > limit ${limit}`);
      out.push(...res.items);
      cursor = res.nextCursor || null;
      assert.ok(++pages < 1000, `${path}: страницы не кончаются`);
    } while (cursor);
    assert.eq(new Set(uids(out)).size, out.length, `${path}: без повторов`);
    return out;
  }

  // Ссылки объекта: значения свойств с x-ref по схеме его вида (и во вложенных строках массива)
  function refsOf(u) {
    const out = [];
    const walk = (schema, value) => {
      if (!schema || value == null) return;
      if (schema["x-ref"] && typeof value === "string") out.push(value);
      if (Array.isArray(value)) value.forEach((x) => walk(schema.items, x));
      else if (typeof value === "object") Object.entries(value).forEach(([k, v]) => walk((schema.properties || {})[k], v));
    };
    const k = kindOf(u.kind);
    if (k) walk(k.schema, u.properties);
    return out;
  }

  test("/kinds отдаёт все виды набора и ETag; повтор с If-None-Match — 304", async () => {
    const env = await makeEnv();
    const res = await env.call("GET", "/kinds");
    assert.status(res, 200, null, "GET /kinds");
    assert.eq(res.body.items.map((k) => k.kind), FX.kinds.map((k) => k.kind), "все виды набора, по порядку");
    assert.eq((res.body.profiles || []).map((p) => p.id), (FX.profiles || []).map((p) => p.id), "профили набора");
    const tag = res.headers.etag;
    assert.ok(tag, "ETag есть");
    const again = await env.call("GET", "/kinds", undefined, { "If-None-Match": tag });
    assert.status(again, 304, null, "повтор с тем же ETag");
    assert.eq(again.headers.etag, tag, "ETag в 304 тот же");
    assert.status(await env.call("GET", "/kinds", undefined, { "If-None-Match": '"other"' }), 200, null, "чужой ETag — описания целиком");
    const one = await env.call("GET", kindPath(CONTROLLER));
    assert.status(one, 200, null, "GET /kinds/{kind} с «/» в коде");
    assert.eq(one.body, res.body.items.find((k) => k.kind === CONTROLLER), "описание вида — как в перечне");
    assert.ok(one.headers.etag, "у описания вида ETag");
    assert.status(await env.call("GET", kindPath("no.such/KIND")), 404, "NOT_FOUND", "нет вида");
    return `видов ${res.body.items.length}`;
  }, { needs: ["listKinds", "getKind"] });

  test("/units?kind=security_controller/CONTROLLER — объекты набора", async () => {
    const env = await makeEnv();
    const got = await env.pages(`/units?${query({ kind: CONTROLLER })}`);
    assert.eq(sorted(uids(got)), sorted(uids(ofKind(CONTROLLER))), "контроллеры набора");
    assert.ok(got.length >= 2 && got.every((u) => u.kind === CONTROLLER && u.domainId && u.version && u.properties), "объекты целиком");
    const both = await env.pages(`/units?${query({ kind: `${CONTROLLER},${SENSOR}` })}`);
    assert.eq(sorted(uids(both)), sorted(uids(ofKind(CONTROLLER).concat(ofKind(SENSOR)))), "kind через запятую — ИЛИ");
    const one = await env.call("GET", `/units/${got[0].uid}`);
    assert.status(one, 200, null, "GET /units/{uid}");
    assert.eq(one.body, got[0], "объект — как в перечне");
    assert.eq(one.headers.etag, `"${got[0].version}"`, "версия в ETag");
    assert.status(await env.call("GET", `/units/${UNKNOWN}`), 404, "NOT_FOUND", "нет объекта");
  }, { needs: ["listUnits", "getUnit"] });

  test("/units?parentId=, ?domainId=, ?implements=vms.camera/1, ?ref=<uid камеры>, ?folderId=, ?ids= — страницами в пределах limits", async () => {
    const env = await makeEnv();
    const limits = (await env.ok("GET", "/reference")).limits;
    const ctrl = ofKind(CONTROLLER)[0];
    assert.eq(sorted(uids(await paged(env, `/units?parentId=${ctrl.uid}`, 1))), sorted(uids(units().filter((u) => u.parentId === ctrl.uid))), "parentId — дети контроллера");
    const dom = dom1();
    assert.eq(sorted(uids(await paged(env, `/units?domainId=${dom}`, 97))), sorted(uids(units().filter((u) => u.domainId === dom))), "domainId — объекты домена");
    const cams = await paged(env, `/units?${query({ implements: "vms.camera/1" })}`, 50);
    assert.eq(sorted(uids(cams)), sorted(uids(ofKind("camera"))), "implements — камеры");
    const cam = ctrl.properties.primary_camera;
    const refs = await paged(env, `/units?ref=${cam}`, 2);
    assert.eq(sorted(uids(refs)), sorted(uids(units().filter((u) => refsOf(u).includes(cam)))), "ref — объекты со ссылкой на камеру");
    assert.ok(uids(refs).includes(ctrl.uid), "среди них контроллер (x-ref на камеру у незнакомого вида)");
    const folder = ctrl.folders[0];
    const inFolder = await paged(env, `/units?folderId=${folder}`, 3);
    assert.eq(sorted(uids(inFolder)), sorted(uids(units().filter((u) => (u.folders || []).includes(folder)))), "folderId — состав папки любых видов");
    const ids = [ctrl.uid, cam, UNKNOWN, ofKind("test.unknown")[0].uid];
    const byIds = await env.ok("GET", `/units?ids=${ids.join(",")}`);
    assert.eq(uids(byIds.items), ids.filter((x) => x !== UNKNOWN), "ids — по записи, неизвестный пропущен");
    const many = Array.from({ length: limits.idsMax + 1 }, () => cam).join(",");
    assert.status(await env.call("GET", `/units?ids=${many}`), 422, "VALIDATION_FAILED", "больше idsMax");
    assert.status(await env.call("GET", `/units?limit=${limits.pageMax + 1}`), 422, "VALIDATION_FAILED", "limit больше pageMax");
    const all = await env.call("GET", `/units?limit=${limits.pageMax}`);
    assert.ok(all.body.items.length <= limits.pageMax && all.body.total === units().length, "без отбора — итог total");
  }, { needs: ["listUnits"] });

  test("объект: секрет не возвращается, secrets[имя]=true", async () => {
    const env = await makeEnv();
    const t1 = ofKind("test.unknown").find((u) => (u.secrets || {}).secret);
    const got = await env.ok("GET", `/units/${t1.uid}`);
    assert.ok(!("secret" in got.properties), "значения секрета нет");
    assert.eq(got.secrets, { secret: true }, "secrets.secret");
    // Секрет камеры: пароль — writeOnly в схеме вида, логин читается
    const cam = ofKind("camera").find((u) => !u.parentId);
    const etag = await env.etag(`/units/${cam.uid}`);
    await env.ok("PATCH", `/units/${cam.uid}`, { properties: { login: "operator", password: "Secret-123" } }, { "If-Match": etag });
    const unit = await env.ok("GET", `/units/${cam.uid}`);
    assert.ok(unit.properties.login === "operator" && !("password" in unit.properties), "логин в properties, пароля нет");
    assert.eq([unit.secrets.login, unit.secrets.password], [undefined, true], "в secrets — только password");
    const listed = (await env.ok("GET", `/units?ids=${cam.uid}`)).items[0];
    assert.ok(listed.properties.login === "operator" && listed.secrets.password === true, "в перечне так же");
    assert.ok(!JSON.stringify(listed).includes("Secret-123"), "пароля нет нигде в ответе");
  }, { needs: ["getUnit", "patchUnit"] });

  test("объект вида без описания читается (kind есть, properties как есть)", async () => {
    const odd = { uid: "30009001-0000-4000-8000-000000000000", kind: "vendor.gone/THING", parentId: null, domainId: dom1(), name: "Объект без описания", version: "1",
      properties: { a: 1, nested: { b: "x", list: [1, 2] } }, status: { link: "online" } };
    const env = await makeEnv({ fixturePatch: { units: units().concat(odd) } });
    assert.status(await env.call("GET", kindPath(odd.kind)), 404, "NOT_FOUND", "описания вида нет");
    const got = await env.ok("GET", `/units/${odd.uid}`);
    assert.eq([got.kind, got.name, got.properties], [odd.kind, odd.name, odd.properties], "вид и свойства как есть");
    const listed = await env.pages(`/units?${query({ kind: odd.kind })}`);
    assert.eq(uids(listed), [odd.uid], "находится по kind");
    assert.eq(uids((await env.ok("GET", `/units?${query({ q: "без описания" })}`)).items).includes(odd.uid), true, "имя ищется и у вида без описания");
  }, { needs: ["getUnit", "getKind"] });

  test("/tree/children layout=servers — узлы с kind=вид объекта, icon, implements", async () => {
    const env = await makeEnv();
    const kinds = Object.fromEntries((await env.ok("GET", "/kinds")).items.map((k) => [k.kind, k]));
    const top = (await env.ok("GET", "/tree/children?layout=servers")).items;
    assert.ok(top.length && top.every((n) => n.kind === "domain"), "верхний уровень — домены");
    const dom = top.find((n) => n.id === dom1());
    const kids = await env.pages(`/tree/children?layout=servers&parentId=${dom.id}`);
    const check = (n, where) => {
      if (n.kind === "unalloc") return assert.ok(!n.unit, `${where}: у нераспределённых объекта нет`);
      const k = kinds[n.kind];
      assert.ok(k, `${where}: вид ${n.kind} есть в /kinds`);
      assert.eq([n.icon, n.implements], [k.icon, k.implements || []], `${where} ${n.name}: icon и implements из описания вида`);
      assert.eq([n.unit.uid, n.unit.kind, n.unit.name, n.unit.parentId === undefined], [n.id, n.kind, n.name, false], `${where} ${n.name}: краткий объект`);
    };
    [dom].concat(kids).forEach((n) => check(n, "домен"));
    const servers = kids.filter((n) => n.kind === "server");
    assert.ok(servers.length && servers.every((n) => n.implements.includes("vms.server/1")), "серверы — вид server");
    const devs = kids.filter((n) => n.kind === "camera" || n.kind === "ipsrv");
    assert.ok(devs.length && devs.every((n) => !("row" in n) && n.unit.uid === n.id), "устройство под доменом — вид устройства, строки row нет");
    assert.ok(!kids.some((n) => n.kind === "domain.shared"), "общие настройки домена (shape: document) — не узел");
    let server = null, under = [];
    for (const n of servers) {
      under = await env.pages(`/tree/children?layout=servers&parentId=${n.id}`);
      if (under.some((x) => x.kind === "camera")) {
        server = n;
        break;
      }
    }
    assert.ok(server, "есть сервер с камерами");
    const cams = under.filter((n) => n.kind === "camera");
    assert.ok(cams.length && cams.every((n) => n.implements.includes("vms.camera/1") && !("row" in n) && n.unit.uid === n.id), "под сервером — камеры: вид camera, краткий объект");
    under.forEach((n) => check(n, "сервер"));
    // Незнакомый вид — тоже узел дерева: контроллер под доменом, датчики под ним
    const ctrl = ofKind(CONTROLLER).find((u) => u.domainId === dom.id);
    const node = kids.find((n) => n.id === ctrl.uid);
    assert.ok(node && node.kind === CONTROLLER && node.hasChildren, "контроллер под доменом, с детьми");
    const sensors = await env.pages(`/tree/children?layout=servers&parentId=${ctrl.uid}`);
    assert.eq(sorted(sensors.map((n) => n.id)), sorted(uids(units().filter((u) => u.parentId === ctrl.uid))), "датчики контроллера");
    sensors.forEach((n) => check(n, "контроллер"));
    const archives = await env.pages(`/tree/children?layout=archives&parentId=${server.id}`);
    archives.forEach((n) => assert.ok(n.kind.startsWith("archive.") && n.implements.includes("vms.archive/1"), `хранилище ${n.name} — вид archive.*`));
  }, { needs: ["getTreeChildren", "listKinds"] });

  test("/units/{uid}/creatable под контроллером — только SENSOR", async () => {
    const env = await makeEnv();
    const ctrl = ofKind(CONTROLLER)[0];
    const res = await env.ok("GET", `/units/${ctrl.uid}/creatable`);
    assert.eq(res.items.filter((x) => x.allowed).map((x) => x.kind), [SENSOR], "создаётся только датчик");
    const cam = ofKind("camera").find((u) => !u.parentId);
    const under = await env.ok("GET", `/units/${cam.uid}/creatable`);
    assert.ok(under.items.some((x) => x.kind === "det" && x.allowed), "под камерой — детектор");
    assert.ok(!under.items.some((x) => x.kind === SENSOR), "датчика контроллера под камерой нет");
    assert.status(await env.call("GET", `/units/${UNKNOWN}/creatable`), 404, "NOT_FOUND", "нет объекта");
  }, { needs: ["getCreatable"] });

  test("/units/{uid}/schema — схема объекта у вида со schemaPerUnit, у остальных — 422", async () => {
    const env = await makeEnv();
    const [a, b] = ofKind("test.perunit");
    const sa = await env.ok("GET", `/units/${a.uid}/schema`);
    const sb = await env.ok("GET", `/units/${b.uid}/schema`);
    assert.eq([sa.properties.channels.maximum, sb.properties.channels.maximum], [4, 16], "ветка модели объекта");
    assert.ok(!sa.if && sa.properties.model, "схема — для этого объекта, без условия");
    assert.status(await env.call("GET", `/units/${ofKind(CONTROLLER)[0].uid}/schema`), 422, "NOT_SUPPORTED", "вид без schemaPerUnit");
    assert.status(await env.call("GET", `/units/${UNKNOWN}/schema`), 404, "NOT_FOUND", "нет объекта");
  }, { needs: ["getUnitSchema"] });

  test("/units?q= находит камеру по адресу и контроллер security_controller по ip_address, match.field верный", async () => {
    const env = await makeEnv();
    const cam = ofKind("camera").find((u) => u.properties.ip);
    const found = await env.pages(`/units?${query({ q: cam.properties.ip })}`);
    const hit = found.find((u) => u.uid === cam.uid);
    assert.ok(hit, "камера по адресу");
    assert.eq(hit.match, { field: "ip" }, "камера: нашлось в ip");
    const ctrl = ofKind(CONTROLLER)[0];
    const byIp = await env.pages(`/units?${query({ q: ctrl.properties.ip_address })}`);
    assert.eq(byIp.find((u) => u.uid === ctrl.uid)?.match, { field: "ip_address" }, "контроллер: нашлось в ip_address");
    const byName = await env.pages(`/units?${query({ q: ctrl.name })}`);
    assert.eq(byName.find((u) => u.uid === ctrl.uid)?.match, { field: "name" }, "по имени — name");
    assert.eq((await env.pages(`/units?${query({ q: ctrl.uid })}`)).map((u) => [u.uid, u.match.field]), [[ctrl.uid, "uid"]], "по uid — uid");
    const off = await env.pages(`/units?${query({ q: ctrl.properties.ip_address, kind: SENSOR })}`);
    assert.eq(off.length, 0, "отбор kind вместе с q");
  }, { needs: ["listUnits"] });

  test("/units?q=&fields=vendor — только по производителю", async () => {
    const env = await makeEnv();
    const cam = ofKind("camera").find((u) => u.properties.vendor);
    const vendor = cam.properties.vendor;
    const got = await env.pages(`/units?${query({ q: vendor, fields: "vendor" })}`);
    assert.eq(sorted(uids(got)), sorted(uids(units().filter((u) => String(u.properties.vendor || "").toLowerCase().includes(vendor.toLowerCase())))), "все с этим производителем");
    assert.ok(got.every((u) => u.match.field === "vendor"), "match.field — vendor");
    assert.eq((await env.pages(`/units?${query({ q: cam.name, fields: "vendor" })}`)).length, 0, "имя не ищется, если его нет в fields");
    const two = await env.pages(`/units?${query({ q: cam.name, fields: "vendor,name" })}`);
    assert.ok(two.some((u) => u.uid === cam.uid && u.match.field === "name"), "fields через запятую");
  }, { needs: ["listUnits"] });

  test("/units?q= не ищет по свойству без x-search", async () => {
    const env = await makeEnv();
    const t1 = ofKind("test.unknown").find((u) => u.properties.firmwareFile);
    const schema = kindOf("test.unknown").schema.properties;
    assert.ok(!schema.firmwareFile["x-search"] && schema.serial["x-search"], "в наборе: firmwareFile без x-search, serial с x-search");
    assert.eq((await env.pages(`/units?${query({ q: t1.properties.firmwareFile })}`)).length, 0, "по firmwareFile не ищется");
    assert.eq((await env.pages(`/units?${query({ q: t1.properties.firmwareFile, fields: "firmwareFile" })}`)).length, 0, "и через fields — тоже");
    const bySerial = await env.pages(`/units?${query({ q: t1.properties.serial })}`);
    assert.eq(bySerial.map((u) => [u.uid, u.match.field]), [[t1.uid, "serial"]], "по serial — находится");
  }, { needs: ["listUnits"] });

  // Домен объекта — у всех потомков по parentId: хранилища сервера, их тома, объекты незнакомых видов
  test("сервер в другой домен — его хранилища и тома в /units с новым domainId", async () => {
    const env = await makeEnv();
    const srv = FX.servers.find((s) => s.allocated && FX.archives.some((a) => a.serverId === s.id && FX.volumes.some((v) => v.archiveId === a.id)));
    const arc = FX.archives.find((a) => a.serverId === srv.id && FX.volumes.some((v) => v.archiveId === a.id));
    const vol = FX.volumes.find((v) => v.archiveId === arc.id);
    // Домен на связи: у домена без связи стенд прячет чужие серверы (hiddenServers), и перечень их не покажет
    const other = FX.domains.find((d) => d.id !== srv.domainId && d.online !== false).id;
    const res = await env.call("POST", `/units/${srv.id}/move`, { parentId: other }, { "If-Match": await env.etag(`/units/${srv.id}`) });
    assert.status(res, 200, null, "сервер перенесён");
    const got = await Promise.all([srv.id, arc.id, vol.id].map((uid) => env.ok("GET", `/units/${uid}`)));
    assert.eq(got.map((u) => u.domainId), [other, other, other], "сервер, хранилище, том — в новом домене");
    const inNew = uids(await env.pages(`/units?${query({ domainId: other })}`));
    assert.ok([arc.id, vol.id].every((x) => inNew.includes(x)), "находятся по domainId нового домена");
    const inOld = uids(await env.pages(`/units?${query({ domainId: srv.domainId })}`));
    assert.ok(![srv.id, arc.id, vol.id].some((x) => inOld.includes(x)), "по старому — нет");
  }, { needs: ["moveUnit", "getUnit", "listUnits", "cap:domain:create"] });

  test("после удаления домена с moveTo /units?domainId=<старый> пуст, объекты незнакомых видов — в целевом", async () => {
    const env = await makeEnv();
    const [d1, d2] = FX.domains;
    const odd = units().filter((u) => u.domainId === d1.id && !FX.devices.some((d) => d.id === u.uid) && !["domain", "server", "folder", "volume", "stream"].includes(u.kind) && !u.kind.startsWith("archive."));
    assert.ok(odd.length > 0, "в домене есть объекты незнакомых видов");
    const etag = await env.etag(`/units/${d1.id}`);
    assert.status(await env.call("DELETE", `/units/${d1.id}?moveTo=${d2.id}`, undefined, { "If-Match": etag }), 204);
    assert.eq(await env.pages(`/units?${query({ domainId: d1.id })}`), [], "объектов удалённого домена нет");
    const moved = await Promise.all(odd.map((u) => env.ok("GET", `/units/${u.uid}`)));
    assert.ok(moved.every((u) => u.domainId === d2.id), "объекты незнакомых видов — в домене moveTo");
    return `незнакомых видов перенесено: ${odd.length}`;
  }, { needs: ["deleteUnit", "cap:domain:delete", "listUnits"] });

  test("домен только с объектами незнакомых видов без moveTo — 422 DOMAIN_NOT_EMPTY, с moveTo — переносятся", async () => {
    const base = units().find((u) => u.kind === "domain");
    const dom = Object.assign(JSON.parse(JSON.stringify(base)), { uid: "10000099-0000-4000-8000-000000000000", name: "Домен без устройств" });
    const odd = { uid: "30009002-0000-4000-8000-000000000000", kind: "vendor.gone/THING", parentId: null, domainId: dom.uid, name: "Незнакомый в своём домене",
      version: "1", properties: {} };
    const env = await makeEnv({ fixturePatch: { units: units().concat(dom, odd) } });
    const etag = await env.etag(`/units/${dom.uid}`);
    assert.status(await env.call("DELETE", `/units/${dom.uid}`, undefined, { "If-Match": etag }), 422, "DOMAIN_NOT_EMPTY", "без moveTo");
    assert.status(await env.call("DELETE", `/units/${dom.uid}?moveTo=${dom1()}`, undefined, { "If-Match": etag }), 204, null, "с moveTo");
    assert.eq((await env.ok("GET", `/units/${odd.uid}`)).domainId, dom1(), "объект — в домене moveTo");
  }, { needs: ["deleteUnit", "cap:domain:delete", "getUnit"] });

  /* ----- Запись: виды без профиля (задача 4) ----- */

  const T = "test.unknown", ROWS = "w2c.example/rows", PER = "test.perunit", DOC = "domain.shared";
  const t1 = () => ofKind(T).find((u) => !u.parentId);
  const t2 = () => ofKind(T).find((u) => u.parentId);
  const online = (u) => (u.status || {}).link === "online";
  const unitPath = (uid) => `/units/${uid}`;
  const actionPath = (uid, id) => `/units/${uid}/actions/${encodeURIComponent(id)}`;
  const testKindPath = (kind) => `/test/kinds/${encodeURIComponent(kind)}`;
  const copy = (v) => JSON.parse(JSON.stringify(v));
  // Правка с If-Match из свежего чтения — как у клиента, который только что открыл объект
  async function patch(env, uid, body) {
    return env.call("PATCH", unitPath(uid), body, { "If-Match": await env.etag(unitPath(uid)) });
  }
  // 422 ядра: code, field — JSON Pointer в теле, params.keyword — слово схемы; errors[0] — та же ошибка
  function invalid(res, field, keyword, msg, code = "VALIDATION_FAILED") {
    assert.status(res, 422, code, msg);
    assert.eq(res.body.field, field, `${msg}: field`);
    if (keyword) assert.eq((res.body.params || {}).keyword, keyword, `${msg}: params.keyword`);
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length && res.body.errors[0].field === field, `${msg}: errors[0] — та же ошибка`);
  }
  // Сообщения потока, пока выполняется fn. watch — наблюдаемые (события устройств и журнала приходят только им)
  async function events(fn, watch) {
    const seen = [];
    const stop = ApiTest.subscribeForTest((m) => seen.push(m), watch);
    await ApiTest.settle();
    await fn();
    await ApiTest.settle();
    stop();
    return seen;
  }

  test("создать test.unknown: 200, version, entity.created; повтор с тем же ключом ничего не создаёт", async () => {
    const env = await makeEnv();
    const folder = t1().folders[0];
    const body = { idempotencyKey: ApiTest.key(), items: [{ kind: T, domainId: dom1(), name: "Новый пульт", folders: [folder],
      properties: { title: "Новый", mode: "auto", serial: "TU-0100", secret: "Secret-new-1" },
      children: [{ kind: T, properties: { title: "Дочерний", mode: "off" } }] }] };
    let res;
    const seen = await events(async () => (res = await env.call("POST", "/units", body)));
    assert.status(res, 200, null, "POST /units");
    assert.eq(res.body.failed, [], "без отказов");
    const [root, child] = res.body.done[0].units;
    assert.eq([res.body.done[0].index, root.kind, root.name, root.parentId, root.domainId, root.folders], [0, T, "Новый пульт", null, dom1(), [folder]], "корень");
    assert.ok(root.version && child.version, "у объектов есть version");
    assert.eq([child.kind, child.parentId, child.domainId], [T, root.uid, dom1()], "дочерний — под корнем, в его домене");
    assert.ok(child.name, "имя дочернего — по шаблону вида");
    assert.ok(!("secret" in root.properties) && root.secrets.secret === true && !JSON.stringify(res.body).includes("Secret-new-1"), "секрета в ответе нет");
    const got = await env.call("GET", unitPath(root.uid));
    assert.status(got, 200, null, "GET созданного");
    assert.eq(got.headers.etag, `"${root.version}"`, "ETag — версия из ответа создания");
    const created = seen.filter((m) => m.type === "entity.created");
    assert.eq(sorted(created.map((m) => m.entityId)), sorted([root.uid, child.uid]), "entity.created на оба объекта");
    assert.ok(created.every((m) => m.kind === T && m.version), "kind события — вид объекта, с версией");
    const again = await env.call("POST", "/units", body);
    assert.eq(again.body, res.body, "повтор с тем же ключом — тот же ответ");
    assert.eq((await env.pages(`/units?${query({ kind: T })}`)).length, ofKind(T).length + 2, "новых объектов — два");
    const dup = await env.ok("POST", "/units", { items: [{ kind: T, domainId: dom1(), properties: { title: "Дубль", mode: "auto", serial: t1().properties.serial } }] });
    assert.eq(dup.failed.map((x) => [x.index, x.code, x.field, x.params.keyword]), [[0, "VALIDATION_FAILED", "/properties/serial", "x-unique"]], "серийный номер занят — x-unique");
  }, { needs: ["createUnits", "getUnit"] });

  test("PATCH merge-patch с If-Match; без If-Match — 428; чужая версия — 412 с current", async () => {
    const env = await makeEnv();
    const u = t1();
    const etag = await env.etag(unitPath(u.uid));
    assert.status(await env.call("PATCH", unitPath(u.uid), { name: "Без версии" }), 428, "PRECONDITION_REQUIRED", "без If-Match");
    const res = await env.call("PATCH", unitPath(u.uid), { name: "Пульт охраны — новый", properties: { notes: null, tags: ["b"], port: 8081 } }, { "If-Match": etag });
    assert.status(res, 200, null, "PATCH");
    const got = res.body;
    assert.eq([got.name, "notes" in got.properties, got.properties.tags, got.properties.port, got.properties.title, got.properties.zone],
      ["Пульт охраны — новый", false, ["b"], 8081, u.properties.title, u.properties.zone], "слито: null удаляет, массив заменён целиком, остальное как было");
    assert.ok(got.version !== u.version && res.headers.etag === `"${got.version}"`, "новая версия — в ETag");
    const stale = await env.call("PATCH", unitPath(u.uid), { name: "По старой версии" }, { "If-Match": etag });
    assert.status(stale, 412, "VERSION_MISMATCH", "старая версия");
    assert.eq([stale.body.current.uid, stale.body.current.version, stale.body.current.name], [u.uid, got.version, got.name], "current — актуальный объект");
    assert.ok(!("secret" in stale.body.current.properties) && stale.body.current.secrets.secret === true, "в current секрета нет, только secrets");
  }, { needs: ["patchUnit"] });

  test("нарушение схемы — 422 VALIDATION_FAILED, field=/properties/<имя>, params.keyword", async () => {
    const env = await makeEnv();
    const u = t1();
    const cases = [
      [{ port: 70000 }, "/properties/port", "maximum"],
      [{ port: "8080" }, "/properties/port", "type"],
      [{ mode: "sometimes" }, "/properties/mode", "enum"],
      [{ title: "" }, "/properties/title", "minLength"],
      [{ tags: ["a", "b", "c", "a"] }, "/properties/tags", "maxItems"],
      [{ zone: [[0.1, 0.1], [2, 0.1], [0.5, 0.9]] }, "/properties/zone/1/0", "maximum"],
      [{ nope: 1 }, "/properties/nope", "additionalProperties"],
      [{ title: null }, "/properties/title", "required"],
      // mode: manual — по if/then нужен count
      [{ count: null }, "/properties/count", "required"],
    ];
    const was = (await env.ok("GET", unitPath(u.uid))).version;
    for (const [props, field, keyword] of cases) invalid(await patch(env, u.uid, { properties: props }), field, keyword, JSON.stringify(props));
    assert.eq((await env.ok("GET", unitPath(u.uid))).version, was, "ничего не записано");
    return `случаев ${cases.length}`;
  }, { needs: ["patchUnit"] });

  test("readOnly в теле — 422", async () => {
    const env = await makeEnv();
    invalid(await patch(env, t1().uid, { properties: { firmwareVersion: "9.9.9" } }), "/properties/firmwareVersion", "readOnly", "PATCH");
    const res = await env.ok("POST", "/units", { items: [{ kind: T, domainId: dom1(), properties: { title: "С прошивкой", mode: "auto", firmwareVersion: "1.0" } }] });
    assert.eq([res.done.length, res.failed[0].code, res.failed[0].field, res.failed[0].params.keyword], [0, "VALIDATION_FAILED", "/properties/firmwareVersion", "readOnly"], "создание: строка с отказом");
  }, { needs: ["patchUnit", "createUnits"] });

  test("readOnly: null в правке — 422 readOnly, поле на месте (сервер, том, камера, поток)", async () => {
    const env = await makeEnv();
    const cases = [["server", "allocated"], ["volume", "state"], ["camera", "codec"], ["stream", "streamId"]];
    let n = 0;
    for (const [kind, name] of cases) {
      const u = ofKind(kind).find((x) => x.properties && x.properties[name] !== undefined);
      if (!u) continue;
      const was = await env.ok("GET", unitPath(u.uid));
      invalid(await patch(env, u.uid, { properties: { [name]: null } }), `/properties/${name}`, "readOnly", `${kind}.${name}: null`);
      const now = await env.ok("GET", unitPath(u.uid));
      assert.eq([now.version, now.properties[name]], [was.version, was.properties[name]], `${kind}.${name}: не снято`);
      n++;
    }
    assert.ok(n >= 3, `проверено видов: ${n}`);
    return `видов ${n}`;
  }, { needs: ["patchUnit"] });

  test("x-immutable после создания — 422", async () => {
    const env = await makeEnv();
    const u = t1();
    invalid(await patch(env, u.uid, { properties: { serial: "TU-0099" } }), "/properties/serial", "x-immutable", "смена серийного номера");
    assert.status(await patch(env, u.uid, { properties: { serial: u.properties.serial, title: "Тот же номер" } }), 200, null, "тот же номер — не смена");
    const made = await env.ok("POST", "/units", { items: [{ kind: T, domainId: dom1(), properties: { title: "Новый", mode: "auto", serial: "TU-0200" } }] });
    assert.eq(made.done[0].units[0].properties.serial, "TU-0200", "при создании номер задаётся");
    invalid(await patch(env, ofKind(PER)[0].uid, { properties: { model: "tp-200" } }), "/properties/model", "x-immutable", "модель test.perunit");
  }, { needs: ["patchUnit", "createUnits"] });

  test("bound-to требует секрет: смена host без secret — 422 с указателем на поле секрета", async () => {
    const env = await makeEnv();
    const u = t1();
    const res = await patch(env, u.uid, { properties: { host: "10.0.0.5" } });
    invalid(res, "/properties/secret", "x-bound-to", "host без секрета");
    assert.eq(res.body.params.field, "host", "params.field — поле, которое меняли");
    const ok = await patch(env, u.uid, { properties: { host: "10.0.0.5", secret: "Bound-secret-1" } });
    assert.status(ok, 200, null, "host с новым секретом");
    assert.eq([ok.body.properties.host, ok.body.secrets, "secret" in ok.body.properties], ["10.0.0.5", { secret: true }, false], "секрет задан, значения нет");
    assert.ok(!JSON.stringify(ok.body).includes("Bound-secret-1"), "значения секрета нет нигде в ответе");
    assert.status(await patch(env, u.uid, { properties: { port: 9090 } }), 200, null, "другое поле — без секрета");
  }, { needs: ["patchUnit"] });

  test("запись: секрет не возвращается — ни при создании, ни в правке, ни в 412, ни в потоке", async () => {
    const env = await makeEnv();
    let made;
    const seen = await events(async () => (made = await env.ok("POST", "/units", { items: [{ kind: T, domainId: dom1(), properties: { title: "С паролем", mode: "auto", secret: "Create-secret-7" } }] })));
    const u = made.done[0].units[0];
    const etag = await env.etag(unitPath(u.uid));
    const res = await env.call("PATCH", unitPath(u.uid), { properties: { secret: "Patch-secret-8" } }, { "If-Match": etag });
    assert.status(res, 200, null, "новый секрет");
    const stale = await env.call("PATCH", unitPath(u.uid), { name: "По старой версии" }, { "If-Match": etag });
    assert.status(stale, 412, "VERSION_MISMATCH", "старая версия");
    const listed = await env.ok("GET", `/units?ids=${u.uid}`);
    const all = JSON.stringify([made, res.body, stale.body, listed, await env.ok("GET", unitPath(u.uid)), seen]);
    assert.ok(!all.includes("Create-secret-7") && !all.includes("Patch-secret-8"), "значения секрета нет ни в одном ответе и сообщении");
    assert.eq([u.secrets, res.body.secrets, listed.items[0].secrets], [{ secret: true }, { secret: true }, { secret: true }], "secrets.secret = true");
    assert.eq((await patch(env, u.uid, { properties: { secret: null } })).body.secrets, undefined, "null снимает секрет");
  }, { needs: ["createUnits", "patchUnit"] });

  test("parent не из parents — 422 PARENT_MISMATCH, field=/parentId", async () => {
    const env = await makeEnv();
    const ctrl = ofKind(CONTROLLER)[0], u = t1();
    const etag = await env.etag(unitPath(u.uid));
    invalid(await env.call("POST", `/units/${u.uid}/move`, { parentId: ctrl.uid }, { "If-Match": etag }), "/parentId", null, "test.unknown под контроллер", "PARENT_MISMATCH");
    invalid(await env.call("POST", `/units/${u.uid}/move`, { parentId: t2().uid }, { "If-Match": etag }), "/parentId", null, "под своего потомка", "PARENT_MISMATCH");
    const res = await env.ok("POST", "/units", { items: [
      { kind: SENSOR, parentId: u.uid, properties: { zone: "Не туда" } },
      { kind: SENSOR, domainId: dom1(), properties: { zone: "Без хозяина" } },
      { kind: SENSOR, parentId: ctrl.uid, properties: { zone: "Под контроллером" } },
    ] });
    assert.eq(res.failed.map((x) => [x.index, x.code, x.field]), [[0, "PARENT_MISMATCH", "/parentId"], [1, "PARENT_MISMATCH", "/parentId"]], "строки не под своим родителем");
    assert.eq(res.done.map((x) => [x.index, x.units[0].parentId, x.units[0].domainId]), [[2, ctrl.uid, ctrl.domainId]], "под контроллером — создан");
  }, { needs: ["moveUnit", "createUnits"] });

  test("move: дочерний test.unknown в корень домена и обратно; вид без move — 422", async () => {
    const env = await makeEnv();
    const a = t1(), b = t2();
    assert.status(await env.call("POST", `/units/${b.uid}/move`, { parentId: null }), 428, "PRECONDITION_REQUIRED", "без If-Match");
    const res = await env.call("POST", `/units/${b.uid}/move`, { parentId: null }, { "If-Match": await env.etag(unitPath(b.uid)) });
    assert.status(res, 200, null, "в корень");
    assert.eq([res.body.parentId, res.body.domainId], [null, a.domainId], "в корне своего домена");
    assert.ok(res.body.version !== b.version && res.headers.etag === `"${res.body.version}"`, "новая версия — в ETag");
    assert.ok(!(await env.pages(`/units?parentId=${a.uid}`)).some((x) => x.uid === b.uid), "у прежнего родителя его нет");
    const top = await env.pages(`/tree/children?layout=servers&parentId=${a.domainId}`);
    assert.ok(top.some((n) => n.id === b.uid && n.kind === T), "узел — под доменом");
    const back = await env.call("POST", `/units/${b.uid}/move`, { parentId: a.uid }, { "If-Match": res.headers.etag });
    assert.status(back, 200, null, "обратно");
    assert.eq(back.body.parentId, a.uid, "снова под родителем");
    const ctrl = ofKind(CONTROLLER)[0];
    invalid(await env.call("POST", `/units/${ctrl.uid}/move`, { parentId: null }, { "If-Match": await env.etag(unitPath(ctrl.uid)) }), "/parentId", null, "у вида нет move в capabilities", "NOT_SUPPORTED");
  }, { needs: ["moveUnit"] });

  test("действие instant ARM — 200 result, status.observed.armed, событие", async () => {
    const env = await makeEnv();
    const ctrl = ofKind(CONTROLLER).find(online);
    let res;
    const seen = await events(async () => (res = await env.call("POST", actionPath(ctrl.uid, "ARM"), {})));
    assert.status(res, 200, null, "ARM");
    assert.eq([res.body.result, res.body.unit.uid, res.body.unit.status.observed.armed], [{}, ctrl.uid, true], "на охране");
    const got = await env.ok("GET", unitPath(ctrl.uid));
    assert.eq([got.status.observed.armed, got.version], [true, ctrl.version], "состояние — в status.observed, версия настроек та же");
    const ev = seen.find((m) => m.type === "entity.changed" && m.entityId === ctrl.uid);
    assert.ok(ev && ev.kind === CONTROLLER && ev.version === ctrl.version, "entity.changed с kind вида");
    assert.eq((await env.ok("POST", actionPath(ctrl.uid, "DISARM"), {})).unit.status.observed.armed, false, "DISARM — снят с охраны");
    const sensor = ofKind(SENSOR).find((u) => u.parentId === ctrl.uid);
    assert.eq((await env.ok("POST", actionPath(sensor.uid, "BYPASS"), {})).unit.status.observed.bypassed, true, "BYPASS — bypassed");
    assert.eq((await env.ok("POST", actionPath(sensor.uid, "UNBYPASS"), {})).unit.status.observed.bypassed, false, "UNBYPASS");
    const off = ofKind(CONTROLLER).find((u) => !online(u));
    assert.status(await env.call("POST", actionPath(off.uid, "DISARM"), {}), 409, "DEVICE_OFFLINE", "контроллер без связи");
    assert.status(await env.call("POST", actionPath(ctrl.uid, "SELF_DESTRUCT"), {}), 404, "NOT_FOUND", "такой команды у вида нет");
  }, { needs: ["runUnitAction"] });

  test("действие instant: событие вида с тем же смыслом — в журнал и поток journal.event", async () => {
    const env = await makeEnv();
    const ctrl = ofKind(CONTROLLER).find(online);
    const desc = copy(kindOf(CONTROLLER));
    desc.events = desc.events.concat({ id: "ARMED", label: { key: "security_controller.event.armed", text: "Поставлен на охрану", lang: "ru" }, severity: "warning" });
    assert.status(await env.call("PUT", testKindPath(CONTROLLER), desc), 200, null, "у вида появилось событие ARMED");
    const seen = await events(() => env.ok("POST", actionPath(ctrl.uid, "ARM"), {}), [ctrl.uid]);
    const j = seen.find((m) => m.type === "journal.event" && m.entityId === ctrl.uid);
    assert.ok(j, "journal.event после ARM");
    assert.eq([j.payload.kind, j.payload.deviceId, j.payload.source], ["ARMED", ctrl.uid, CONTROLLER], "событие вида: код, объект, вид");
    const none = await events(() => env.ok("POST", actionPath(ctrl.uid, "DISARM"), {}), [ctrl.uid]);
    assert.ok(!none.some((m) => m.type === "journal.event"), "у DISARM события того же смысла нет — журнал молчит");
  }, { needs: ["runUnitAction"] });

  test("действие longRunning — 202, операция доходит до ok", async () => {
    const env = await makeEnv();
    const u = t1();
    const res = await env.call("POST", actionPath(u.uid, "calibrate"), { params: { level: "high" } });
    assert.status(res, 202, null, "calibrate");
    assert.eq([res.body.total, res.body.items[0].targetId, res.body.state], [1, u.uid, "running"], "операция из одного шага");
    const op = await env.finished(res.body.id);
    assert.eq([op.ok, op.failed, op.items[0].state], [1, 0, "ok"], "шаг выполнен");
    assert.ok(!op.revertible, "команду назад не откатить: операция не в стопке отката");
    const got = await env.ok("GET", unitPath(u.uid));
    assert.ok(got.status.observed.calibrate && got.status.observed.calibrate.at, "время калибровки — в status.observed");
    assert.eq(got.version, u.version, "версия настроек та же");
  }, { needs: ["runUnitAction", "getOperation"] });

  test("действие с параметрами не по схеме — 422 field=/params/<имя>", async () => {
    const env = await makeEnv();
    const u = t1();
    invalid(await env.call("POST", actionPath(u.uid, "ping"), {}), "/params/count", "required", "без count");
    invalid(await env.call("POST", actionPath(u.uid, "ping"), { params: { count: 11 } }), "/params/count", "maximum", "count больше 10");
    invalid(await env.call("POST", actionPath(u.uid, "ping"), { params: { count: 2, extra: true } }), "/params/extra", "additionalProperties", "лишний параметр");
    invalid(await env.call("POST", actionPath(u.uid, "calibrate"), { params: { level: "mid" } }), "/params/level", "enum", "уровень не из перечня");
    const ok = await env.ok("POST", actionPath(u.uid, "ping"), { params: { count: 3, note: "проверка" } });
    assert.ok(typeof ok.result.rttMs === "number", "result — по ActionDescriptor.result");
    assert.ok(ok.unit.status.observed.ping && ok.unit.status.observed.ping.at, "время команды — в status.observed");
  }, { needs: ["runUnitAction"] });

  test("set по разным видам — частичный успех, failed с указателем", async () => {
    const env = await makeEnv();
    const u = t1(), ctrl = ofKind(CONTROLLER)[0], sensor = ofKind(SENSOR)[0];
    const items = [{ uid: u.uid, patch: { properties: { mode: "off" } } }, { uid: ctrl.uid, patch: { properties: { mode: "manual" } } }, { uid: sensor.uid, patch: { properties: { mode: "auto" } } }];
    const expectedVersions = Object.fromEntries([u, ctrl, sensor].map((x) => [x.uid, x.version]));
    const op = await env.runOperation({ idempotencyKey: ApiTest.key(), items, expectedVersions });
    assert.eq(op.items.map((x) => [x.targetId, x.state, x.code]), [[u.uid, "ok", null], [ctrl.uid, "ok", null], [sensor.uid, "fail", "VALIDATION_FAILED"]], "у датчика нет поля mode — отказ строки");
    assert.eq([op.items[2].params.field, op.items[2].params.keyword], ["/properties/mode", "additionalProperties"], "указатель на поле");
    const got = await env.ok("GET", `/units?ids=${[u.uid, ctrl.uid, sensor.uid].join(",")}`);
    assert.eq(got.items.map((x) => x.properties.mode), ["off", "manual", undefined], "записаны только прошедшие шаги");
    assert.eq(op.items[0].version, got.items[0].version, "версия после шага");
  }, { needs: ["createOperation", "getOperation"] });

  test("шаги операции по uid: action, createUnit, folders, delete; без версии — 428, чужая — 412, занятый — 409", async () => {
    const env = await makeEnv();
    const u = t1(), ctrl = ofKind(CONTROLLER).find(online), sensor = ofKind(SENSOR).find((x) => x.parentId === ctrl.uid);
    const folder = units().find((x) => x.kind === "folder" && x.domainId === u.domainId && !(u.folders || []).includes(x.uid));
    const owner = ofKind(ROWS)[0].parentId;
    const items = [{ uid: ctrl.uid, action: "ARM" }, { uid: ctrl.uid, createUnit: { kind: SENSOR, properties: { zone: "Новая" } } }, { uid: u.uid, folders: [folder.uid] }, { uid: sensor.uid, delete: true },
      { uid: owner, createUnit: { kind: ROWS, properties: { slot: 5, channelType: "io" } } }];
    assert.status(await env.call("POST", "/operations", { idempotencyKey: ApiTest.key(), items, expectedVersions: {} }), 428, "PRECONDITION_REQUIRED", "нет версий для folders и delete");
    const stale = await env.call("POST", "/operations", { idempotencyKey: ApiTest.key(), items, expectedVersions: { [u.uid]: "old", [sensor.uid]: sensor.version } });
    assert.status(stale, 412, "VERSION_MISMATCH", "чужая версия");
    assert.eq(stale.body.current.uid, u.uid, "current — объект, чья версия не совпала");
    assert.status(await env.call("POST", "/operations", { idempotencyKey: ApiTest.key(), items: [{ uid: u.uid, patch: {}, delete: true }], expectedVersions: { [u.uid]: u.version } }), 422, "VALIDATION_FAILED", "в шаге два действия");
    // wait не делает мгновенной операцию с командой, созданием и удалением: 202, шаги по часам
    const start = await env.call("POST", "/operations", { idempotencyKey: ApiTest.key(), items, expectedVersions: { [u.uid]: u.version, [sensor.uid]: sensor.version }, wait: true });
    assert.status(start, 202, null, "POST /operations");
    assert.eq(start.body.state, "running", "с wait, но шаги не мгновенные — идёт по шагам");
    if (env.frozen) assert.status(await patch(env, u.uid, { name: "Пока идёт операция" }), 409, "BUSY", "объект операции занят");
    const op = await env.finished(start.body.id);
    assert.eq(op.items.map((x) => x.state), ["ok", "ok", "ok", "ok", "ok"], "все шаги выполнены");
    const made = await env.ok("GET", unitPath(op.items[1].createdId));
    assert.eq([made.kind, made.parentId, made.properties.zone], [SENSOR, ctrl.uid, "Новая"], "датчик создан под контроллером");
    assert.eq((await env.ok("GET", unitPath(u.uid))).folders, [folder.uid], "папки заданы набором");
    assert.ok((await env.pages(`/units?folderId=${folder.uid}`)).some((x) => x.uid === u.uid), "в составе папки");
    assert.status(await env.call("GET", unitPath(sensor.uid)), 404, "NOT_FOUND", "датчик удалён");
    assert.eq((await env.ok("GET", unitPath(ctrl.uid))).status.observed.armed, true, "команда выполнена");
    const row = await env.ok("GET", unitPath(op.items[4].createdId));
    assert.eq([row.kind, row.parentId, row.properties.slot], [ROWS, owner, 5], "строка таблицы — под камерой-хозяином");
  }, { needs: ["createOperation", "getOperation"] });

  test("validate не пишет", async () => {
    const env = await makeEnv();
    const u = t1();
    const was = await env.ok("GET", unitPath(u.uid));
    let res;
    const seen = await events(async () => (res = await env.ok("POST", "/units/validate", { items: [
      { uid: u.uid, patch: { properties: { port: 0 } } },
      { uid: u.uid, patch: { name: "Только проверка", properties: { port: 8082 } } },
      { create: { kind: T, domainId: dom1(), properties: { title: "Без режима" } } },
      { create: { kind: SENSOR, domainId: dom1(), properties: {} } },
      { uid: UNKNOWN, patch: { name: "Нет такого" } },
    ] })));
    assert.eq(res.items.map((x) => [x.index, x.ok]), [[0, false], [1, true], [2, false], [3, false], [4, false]], "итог по строкам");
    assert.eq([res.items[0].errors[0].field, res.items[0].errors[0].params.keyword], ["/properties/port", "minimum"], "порт меньше 1");
    assert.eq([res.items[2].errors[0].field, res.items[2].errors[0].params.keyword], ["/properties/mode", "required"], "создание без обязательного mode");
    assert.eq([res.items[3].errors[0].code, res.items[3].errors[0].field], ["PARENT_MISMATCH", "/parentId"], "датчик без контроллера");
    assert.eq(res.items[4].errors[0].code, "NOT_FOUND", "нет объекта");
    const got = await env.ok("GET", unitPath(u.uid));
    assert.eq([got.version, got.name, got.properties.port], [was.version, was.name, was.properties.port], "объект не изменился");
    assert.eq((await env.pages(`/units?${query({ kind: T })}`)).length, ofKind(T).length, "новых объектов нет");
    assert.ok(!seen.some((m) => m.type.startsWith("entity.")), "в потоке изменений нет");
    const both = await env.call("POST", "/units/validate", { items: [{ uid: u.uid, patch: { name: "Правка" } }, { uid: u.uid, patch: { name: "x" }, create: { kind: T, domainId: dom1(), properties: { title: "И то и другое", mode: "auto" } } }] });
    assert.status(both, 422, "VALIDATION_FAILED", "в строке и правка, и создание");
    assert.eq(both.body.field, "/items/1", "указатель на строку");
  }, { needs: ["validateUnits"] });

  test("DELETE с детьми — каскад по parents, откат стопкой", async () => {
    const env = await makeEnv();
    const a = t1(), b = t2();
    assert.status(await patch(env, a.uid, { properties: { title: "Перед удалением" } }), 200, null, "правка перед удалением");
    const etag = await env.etag(unitPath(a.uid));
    assert.status(await env.call("DELETE", unitPath(a.uid)), 428, "PRECONDITION_REQUIRED", "без If-Match");
    let res;
    const seen = await events(async () => (res = await env.call("DELETE", unitPath(a.uid), undefined, { "If-Match": etag })));
    assert.status(res, 204, null, "DELETE");
    for (const x of [a, b]) assert.status(await env.call("GET", unitPath(x.uid)), 404, "NOT_FOUND", `${x.name} удалён`);
    assert.eq(sorted(seen.filter((m) => m.type === "entity.deleted").map((m) => `${m.kind} ${m.entityId}`)), sorted([a, b].map((x) => `${T} ${x.uid}`)), "entity.deleted на родителя и дочерний, kind — вид");
    // Стопка отката: сначала удаление, затем правка
    const top = (await env.ok("GET", "/operations?limit=1")).items[0];
    assert.ok(top.single && top.revertible, "удаление — верх стопки отката");
    const undo = await env.finished((await env.ok("POST", `/operations/${top.id}/revert`, {})).id);
    assert.eq(undo.items.map((x) => x.state), ["ok"], "удаление откачено");
    const back = await env.ok("GET", `/units?ids=${a.uid},${b.uid}`);
    assert.eq(back.items.map((x) => [x.uid, x.parentId]), [[a.uid, null], [b.uid, a.uid]], "объекты вернулись с теми же uid и родителем");
    assert.eq([back.items[0].properties.title, back.items[0].secrets, back.items[0].folders], ["Перед удалением", { secret: true }, a.folders], "свойства, секрет, папки — как были");
    const next = (await env.ok("GET", "/operations?limit=10")).items.find((x) => x.revertible);
    assert.ok(next && next.single, "следующая в стопке — правка");
    await env.finished((await env.ok("POST", `/operations/${next.id}/revert`, {})).id);
    assert.eq((await env.ok("GET", unitPath(a.uid))).properties.title, a.properties.title, "правка откачена следом");
    // Повтор — в обратном порядке: правка, затем удаление
    await env.finished((await env.ok("POST", `/operations/${next.id}/redo`, {})).id);
    assert.eq((await env.ok("GET", unitPath(a.uid))).properties.title, "Перед удалением", "правка повторена");
    const redo = await env.finished((await env.ok("POST", `/operations/${top.id}/redo`, {})).id);
    assert.eq(redo.items.map((x) => x.state), ["ok"], "удаление повторено");
    for (const x of [a, b]) assert.status(await env.call("GET", unitPath(x.uid)), 404, "NOT_FOUND", `${x.name} снова удалён`);
  }, { needs: ["deleteUnit", "patchUnit", "revertOperation", "redoOperation"] });

  test("/objects/delete по uid любого вида: с дочерними, откат возвращает", async () => {
    const env = await makeEnv();
    const a = t1(), b = t2(), sensor = ofKind(SENSOR)[0], row = ofKind(ROWS)[0];
    const res = await env.ok("POST", "/objects/delete", { idempotencyKey: ApiTest.key(), items: [{ id: a.uid, version: a.version }, { id: b.uid, version: b.version }, { id: sensor.uid, version: "stale" }, { id: row.uid, version: row.version }] });
    assert.eq(sorted(res.done), sorted([a.uid, b.uid, row.uid]), "удалены: объект с дочерним и строка таблицы");
    assert.eq(res.failed, [{ id: sensor.uid, code: "VERSION_MISMATCH" }], "чужая версия — отказ строки");
    for (const x of [a, b, row]) assert.status(await env.call("GET", unitPath(x.uid)), 404, "NOT_FOUND", `${x.name} удалён`);
    const top = (await env.ok("GET", "/operations?limit=1")).items[0];
    const undo = await env.finished((await env.ok("POST", `/operations/${top.id}/revert`, {})).id);
    assert.eq(undo.items.map((x) => x.state), ["ok", "ok"], "оба удаления откачены");
    for (const x of [a, b, row]) assert.status(await env.call("GET", unitPath(x.uid)), 200, null, `${x.name} вернулся`);
  }, { needs: ["deleteObjects", "revertOperation"] });

  test("PUT /test/kinds добавляет поле — kinds.changed, новый ETag, PATCH с новым полем проходит", async () => {
    const env = await makeEnv();
    const ctrl = ofKind(CONTROLLER)[0];
    const before = await env.call("GET", "/kinds");
    invalid(await patch(env, ctrl.uid, { properties: { siren: true } }), "/properties/siren", "additionalProperties", "поля ещё нет");
    const desc = copy(kindOf(CONTROLLER));
    desc.schema.properties.siren = { type: "boolean", "x-label": { key: "security_controller.param.siren", text: "Сирена", lang: "ru" } };
    let res;
    const seen = await events(async () => (res = await env.call("PUT", testKindPath(CONTROLLER), desc)));
    assert.status(res, 200, null, "PUT /test/kinds/{kind}");
    assert.eq(res.body, desc, "описание — как прислано");
    const msg = seen.find((m) => m.type === "kinds.changed");
    assert.ok(msg && msg.payload.kinds.includes(CONTROLLER), "kinds.changed с кодом вида");
    const after = await env.call("GET", "/kinds", undefined, { "If-None-Match": before.headers.etag });
    assert.status(after, 200, null, "старый ETag — описания целиком");
    assert.ok(after.headers.etag && after.headers.etag !== before.headers.etag, "новый ETag");
    assert.eq(after.body.items.find((k) => k.kind === CONTROLLER).schema.properties.siren.type, "boolean", "поле — в описании вида");
    const ok = await patch(env, ctrl.uid, { properties: { siren: true } });
    assert.status(ok, 200, null, "PATCH с новым полем");
    assert.eq(ok.body.properties.siren, true, "значение записано");
    invalid(await env.call("PUT", testKindPath("other.kind"), desc), "/kind", null, "код вида в пути и в теле разные");
    const fresh = { kind: "test.fresh", label: { key: "kind.test.fresh", text: "Новый вид", lang: "ru" }, parents: [null], createParents: [null], capabilities: ["create", "delete"],
      schema: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } } };
    assert.status(await env.call("PUT", testKindPath(fresh.kind), fresh), 200, null, "новый вид");
    const made = await env.ok("POST", "/units", { items: [{ kind: fresh.kind, domainId: dom1(), properties: { note: "есть" } }] });
    assert.eq([made.done.length, made.done[0].units[0].kind], [1, fresh.kind], "объект нового вида создаётся");
  }, { needs: ["patchUnit", "listKinds", "createUnits"] });

  test("PATCH отвечает сразу; status.observedVersion догоняет version, условие Applied", async () => {
    const env = await makeEnv();
    const u = t1();
    const res = await patch(env, u.uid, { properties: { port: 8090 } });
    assert.status(res, 200, null, "PATCH");
    const applied = (x) => ((x.status || {}).conditions || []).find((c) => c.type === "Applied") || {};
    assert.ok(res.body.status.observedVersion && res.body.status.observedVersion !== res.body.version, "ещё не применилось: observedVersion ≠ version");
    assert.eq(applied(res.body).status, "false", "Applied: false");
    const got = await env.until(async () => {
      const x = await env.ok("GET", unitPath(u.uid));
      return x.status.observedVersion === x.version && x;
    }, "правка применилась");
    assert.eq([applied(got).status, got.version, got.properties.port], ["true", res.body.version, 8090], "Applied: true, версия та же");
  }, { needs: ["patchUnit"] });

  test("строка w2c.example/rows создаётся под хозяином, без хозяина — 422", async () => {
    const env = await makeEnv();
    const owner = units().find((u) => u.uid === ofKind(ROWS)[0].parentId);
    const other = ofKind("camera").find((u) => !u.parentId && u.uid !== owner.uid && u.domainId === owner.domainId);
    const res = await env.ok("POST", "/units", { items: [
      { kind: ROWS, parentId: owner.uid, properties: { slot: 3, channelType: "io", note: "Новый вход" } },
      { kind: ROWS, domainId: owner.domainId, properties: { slot: 4, channelType: "io" } },
      { kind: ROWS, parentId: owner.uid, properties: { slot: 1, channelType: "audio" } },
      { kind: ROWS, parentId: other.uid, properties: { slot: 1, channelType: "audio" } },
    ] });
    // Отказ строки — код из 422 (PARENT_MISMATCH, VALIDATION_FAILED) в failed: создание по строкам, частичный успех
    assert.eq(res.failed.map((x) => [x.index, x.code, x.field]), [[1, "PARENT_MISMATCH", "/parentId"], [2, "VALIDATION_FAILED", "/properties/slot"]], "без хозяина — PARENT_MISMATCH; занятый номер у того же хозяина — отказ");
    assert.eq(res.failed[1].params.keyword, "x-unique", "x-unique — в пределах хозяина");
    assert.eq(res.done.map((x) => [x.index, x.units[0].parentId, x.units[0].domainId]), [[0, owner.uid, owner.domainId], [3, other.uid, other.domainId]], "строки — под хозяином, в его домене");
    const rows = await env.pages(`/units?parentId=${owner.uid}&${query({ kind: ROWS })}`);
    assert.eq(rows.map((r) => r.properties.slot).sort(), [1, 2, 3], "строки хозяина");
  }, { needs: ["createUnits"] });

  test("domain.shared: PATCH документа целиком с If-Match, наследуемое поле объекта показывает inherited.from=domain", async () => {
    const env = await makeEnv();
    const doc = ofKind(DOC)[0], own = t2(), bare = t1();
    const site = kindOf(T).schema.properties.site;
    let a = await env.ok("GET", unitPath(bare.uid));
    assert.eq([a.properties.site, a.inherited.site.from, a.inherited.site.uid], [doc.properties[T].site, "domain", doc.uid], "своего значения нет — из документа домена");
    assert.eq((await env.ok("GET", unitPath(own.uid))).inherited.site, { from: "unit" }, "своё значение — from: unit");
    assert.status(await env.call("PATCH", unitPath(doc.uid), { properties: { [T]: { site: "Склад" } } }), 428, "PRECONDITION_REQUIRED", "документ — с If-Match");
    const res = await patch(env, doc.uid, { properties: { [T]: { site: "Склад" } } });
    assert.status(res, 200, null, "документ записан");
    a = await env.ok("GET", unitPath(bare.uid));
    assert.eq([a.properties.site, a.inherited.site], ["Склад", { from: "domain", uid: doc.uid, version: res.body.version }], "новое значение документа и его версия");
    const whole = await patch(env, doc.uid, { properties: {} });
    assert.eq([whole.status, whole.body.properties], [200, {}], "документ — запись целиком: пустые свойства снимают всё");
    a = await env.ok("GET", unitPath(bare.uid));
    assert.eq([a.properties.site, a.inherited.site], [site.default, { from: "default" }], "в документе нет — умолчание схемы");
    invalid(await patch(env, doc.uid, { properties: { [T]: { site: 5 } } }), `/properties/${T}/site`, "type", "документ — по схеме вида");
    invalid(await env.call("DELETE", unitPath(doc.uid), undefined, { "If-Match": await env.etag(unitPath(doc.uid)) }), "/kind", null, "документ не удаляется", "NOT_SUPPORTED");
  }, { needs: ["patchUnit"] });

  test("test.perunit: /units/{uid}/schema отдаёт схему объекта, PATCH проверяется по ней", async () => {
    const env = await makeEnv();
    const [a, b] = ofKind(PER);
    const sa = await env.ok("GET", `/units/${a.uid}/schema`);
    const res = await patch(env, a.uid, { properties: { channels: 8 } });
    invalid(res, "/properties/channels", "maximum", "tp-100: больше 4 каналов");
    assert.eq(res.body.params.limit, sa.properties.channels.maximum, "предел — из схемы объекта");
    invalid(await patch(env, a.uid, { properties: { resolution: "3840x2160" } }), "/properties/resolution", "enum", "tp-100: разрешение не своей модели");
    assert.status(await patch(env, b.uid, { properties: { channels: 8, resolution: "1920x1080" } }), 200, null, "tp-200: 8 каналов можно");
    assert.status(await patch(env, a.uid, { properties: { channels: 2 } }), 200, null, "tp-100: в пределах");
  }, { needs: ["getUnitSchema", "patchUnit"] });

  test("запись ядром: вид без описания и вид с профилем vms.* — 422 NOT_SUPPORTED, field=/kind", async () => {
    const odd = { uid: "30009003-0000-4000-8000-000000000000", kind: "vendor.gone/THING", parentId: null, domainId: dom1(), name: "Объект без описания", version: "1", properties: { a: 1 } };
    const env = await makeEnv({ fixturePatch: { units: units().concat(odd) } });
    invalid(await env.call("PATCH", unitPath(odd.uid), { name: "Новое имя" }, { "If-Match": '"1"' }), "/kind", null, "правка вида без описания", "NOT_SUPPORTED");
    invalid(await env.call("DELETE", unitPath(odd.uid), undefined, { "If-Match": '"1"' }), "/kind", null, "удаление вида без описания", "NOT_SUPPORTED");
    invalid(await env.call("POST", actionPath(odd.uid, "ARM"), {}), "/kind", null, "команда вида без описания", "NOT_SUPPORTED");
    assert.eq((await env.ok("GET", unitPath(odd.uid))).name, odd.name, "объект на месте");
    // Вид с профилем vms.*, которого сервер не знает (хука нет): смысл профиля исполнить некому — не пишется
    const future = { kind: "vendor.future/THING", label: { key: "kind.future", text: "Будущее", lang: "ru" }, parents: [null], createParents: [null],
      implements: ["vms.future/1"], capabilities: ["create", "rename", "delete"], schema: { type: "object", additionalProperties: false, properties: {} } };
    assert.status(await env.call("PUT", testKindPath(future.kind), future), 200, null, "вид с незнакомым профилем");
    const made = await env.ok("POST", "/units", { items: [{ kind: future.kind, domainId: dom1(), properties: {} }, { kind: odd.kind, domainId: dom1(), properties: {} }] });
    assert.eq(made.failed.map((x) => [x.index, x.code, x.field]), [[0, "NOT_SUPPORTED", "/kind"], [1, "NOT_SUPPORTED", "/kind"]], "создание — отказ строк");
    // Камера (vms.camera/1 — хук есть) пишется ядром
    const cam = ofKind("camera").find((u) => !u.parentId);
    assert.status(await patch(env, cam.uid, { name: "Камера ядром" }), 200, null, "камера — путями ядра");
  }, { needs: ["patchUnit", "deleteUnit", "createUnits"] });

  test("откат POST /units снимает созданное вместе с детьми; индексы parentId и kind чистые", async () => {
    const env = await makeEnv();
    const res = await env.ok("POST", "/units", { items: [{ kind: T, domainId: dom1(), properties: { title: "Откатить", mode: "auto" },
      children: [{ kind: T, properties: { title: "Дочерний", mode: "off" } }] }] });
    const [root, child] = res.done[0].units;
    const top = (await env.ok("GET", "/operations?limit=1")).items[0];
    assert.ok(top.single && top.revertible && top.items[0].createdId === root.uid, "создание — верх стопки отката");
    const undo = await env.finished((await env.ok("POST", `/operations/${top.id}/revert`, {})).id);
    assert.eq(undo.items.map((x) => [x.state, x.code]), [["ok", null]], "созданное снято");
    for (const x of [root, child]) assert.status(await env.call("GET", unitPath(x.uid)), 404, "NOT_FOUND", `${x.name} снят`);
    assert.eq(await env.pages(`/units?parentId=${root.uid}`), [], "?parentId= — пусто");
    const left = uids(await env.pages(`/units?${query({ kind: T })}`));
    assert.ok(left.length === ofKind(T).length && !left.includes(root.uid) && !left.includes(child.uid), "?kind= — как в наборе");
  }, { needs: ["createUnits", "revertOperation"] });

  test("вид с обязательным секретом: правка другого поля проходит, снять секрет — 422 required", async () => {
    const env = await makeEnv();
    const kind = { kind: "test.required-secret", label: { key: "kind.test.required-secret", text: "С обязательным паролем", lang: "ru" }, parents: [null], createParents: [null],
      capabilities: ["create", "rename", "delete"], schema: { type: "object", additionalProperties: false, required: ["pw"],
        properties: { pw: { type: "string", minLength: 4, writeOnly: true }, note: { type: "string" } } } };
    assert.status(await env.call("PUT", testKindPath(kind.kind), kind), 200, null, "вид с обязательным writeOnly");
    const bare = await env.ok("POST", "/units", { items: [{ kind: kind.kind, domainId: dom1(), properties: { note: "без пароля" } }] });
    assert.eq([bare.failed[0].field, bare.failed[0].params.keyword], ["/properties/pw", "required"], "создание без пароля — отказ");
    const made = await env.ok("POST", "/units", { items: [{ kind: kind.kind, domainId: dom1(), properties: { pw: "Secret-req-1" } }] });
    const u = made.done[0].units[0];
    const res = await patch(env, u.uid, { properties: { note: "правка" } });
    assert.status(res, 200, null, "правка другого поля — пароль задан");
    assert.eq([res.body.properties.note, res.body.secrets], ["правка", { pw: true }], "записано, секрет на месте");
    invalid(await patch(env, u.uid, { properties: { pw: null } }), "/properties/pw", "required", "снять обязательный секрет");
    assert.status(await patch(env, u.uid, { properties: { pw: "Secret-req-2" } }), 200, null, "заменить секрет");
  }, { needs: ["createUnits", "patchUnit"] });

  test("шаг delete: потомок занят другой операцией — BUSY", async () => {
    const env = await makeEnv();
    const a = t1(), b = t2(), other = ofKind(CONTROLLER)[0];
    // Операция A: сначала контроллер, затем дочерний b — его шаг ждёт, пока выполняется удаление родителя из операции B
    const opA = await env.ok("POST", "/operations", { idempotencyKey: ApiTest.key(), expectedVersions: { [other.uid]: other.version, [b.uid]: b.version },
      items: [{ uid: other.uid, patch: { properties: { mode: "manual" } } }, { uid: b.uid, patch: { properties: { notes: "занят" } } }] });
    const opB = await env.ok("POST", "/operations", { idempotencyKey: ApiTest.key(), expectedVersions: { [a.uid]: a.version }, items: [{ uid: a.uid, delete: true }] });
    const doneB = await env.finished(opB.id);
    assert.eq([doneB.items[0].state, doneB.items[0].code, (doneB.items[0].params || {}).targetId], ["fail", "BUSY", b.uid], "удаление родителя — отказ: дочерний занят");
    const doneA = await env.finished(opA.id);
    assert.eq(doneA.items.map((x) => x.state), ["ok", "ok"], "операция A выполнена");
    assert.status(await env.call("GET", unitPath(a.uid)), 200, null, "родитель на месте");
  }, { needs: ["createOperation", "getOperation", "clock"] });

  /* ===== Задача 8, шаг 0: краткий объект узла, команды вида, профили ===== */

  test("/tree/paths для любого вида: контроллер, его датчик и test.unknown — цепочки от домена, шаги — коды видов", async () => {
    const env = await makeEnv();
    const ctl = ofKind(CONTROLLER).find((u) => (u.folders || []).length), sensor = ofKind(SENSOR).find((u) => u.parentId === ctl.uid), unk = t1();
    const at = (layout, list) => env.ok("GET", `/tree/paths?${query({ layout, ids: uids(list).join(",") })}`);
    const dom = units().find((u) => u.uid === ctl.domainId);
    for (const layout of ["servers", "folders", "archives", "detectors"]) {
      const res = await at(layout, [ctl, sensor, unk]);
      assert.eq(res.items.map((x) => x.id), uids([ctl, sensor, unk]), `${layout}: цепочки у всех`);
      res.items.forEach((x) => x.chains.forEach((c) => {
        assert.eq([c[0].id, c[0].kind], [dom.uid, "domain"], `${layout}: ${x.id} — от домена`);
        assert.eq(c[c.length - 1].id, x.id, `${layout}: ${x.id} — до объекта`);
        c.forEach((st) => assert.eq(st.kind, units().find((u) => u.uid === st.id).kind, `${layout}: шаг ${st.id} — код вида`));
      }));
      const sc = res.items[1].chains[0];
      assert.eq(sc.slice(-2).map((st) => st.id), [ctl.uid, sensor.uid], `${layout}: датчик — под контроллером`);
    }
    const inFolders = (await at("folders", [ctl])).items[0].chains;
    assert.eq(inFolders.map((c) => c[c.length - 2].id), ctl.folders, "раскладка папок: под своими папками");
    assert.eq(inFolders[0][inFolders[0].length - 2].kind, "folder", "шаг папки");
  }, { needs: ["getTreePaths"] });

  test("Узел дерева: краткий объект несёт enabled, serverId, fault, licenseExceeded; строки row нет", async () => {
    const env = await makeEnv();
    const cams = ofKind("camera").filter((u) => u.properties.serverId);
    const obs = (u) => (u.status || {}).observed || {};
    // Сверх лицензии бывает не в каждой системе (в профиле «один домен» лицензий нет)
    const pick = [cams.find((u) => obs(u).fault), cams.find((u) => obs(u).licenseExceeded), cams.find((u) => u.properties.enabled === false)].filter(Boolean);
    assert.ok(pick.length >= 2, "в наборе есть камеры со сбоем и выключенная");
    for (const u of pick) {
      const nodes = await env.pages(`/tree/children?layout=servers&parentId=${u.parentId || u.properties.serverId}`);
      const n = nodes.find((x) => x.id === u.uid);
      assert.ok(n, `${u.name}: узел под своим родителем`);
      assert.ok(!("row" in n), `${u.name}: строки row нет`);
      assert.eq([n.unit.brief.enabled, n.unit.brief.serverId], [u.properties.enabled !== false, u.properties.serverId], `${u.name}: enabled и serverId в brief`);
      const seen = (n.unit.status || {}).observed || {};
      assert.eq([seen.fault || null, !!seen.licenseExceeded], [obs(u).fault || null, !!obs(u).licenseExceeded], `${u.name}: fault и licenseExceeded в status.observed`);
    }
    // У вида без этих полей их нет и в кратком объекте
    const dom = (await env.ok("GET", "/tree/children?layout=servers")).items[0];
    assert.ok(!("enabled" in ((dom.unit || {}).brief || {})) && !((dom.unit.status || {}).observed), "у домена — ни enabled, ни observed");
  }, { needs: ["getTreeChildren", "kind:camera"] });

  test("Команда вида без объекта: scope kind — POST /kinds/{kind}/actions/{id}; probe камеры, регистратора, сервера, check хранилища", async () => {
    const env = await makeEnv();
    const kinds = Object.fromEntries((await env.ok("GET", "/kinds")).items.map((k) => [k.kind, k]));
    const scope = (kind, id) => ((kinds[kind].actions || []).find((a) => a.id === id) || {}).scope || ["unit"];
    [["camera", "probe"], ["ipsrv", "probe"], ["server", "probe"], ["archive.network", "check"]].forEach(([k, id]) =>
      assert.eq(scope(k, id), ["unit", "kind"], `${k} ${id}: команда и объекта, и вида`));
    assert.eq(scope("relay", "output"), ["unit"], "реле: только у объекта");
    const run = (kind, id, params) => env.call("POST", `${kindPath(kind)}/actions/${id}`, { params });
    const want = { ip: "10.1.2.3", port: 80, vendor: "Axis" };
    const cam = await run("camera", "probe", want);
    assert.status(cam, 200, null, "probe камеры без объекта");
    assert.ok(!("unit" in cam.body), "объекта в ответе команды вида нет");
    const viaUnit = (await env.ok("POST", `/units/${ofKind("camera")[0].uid}/actions/probe`, { params: want })).result;
    assert.eq(cam.body.result, viaUnit, "та же модель, что у команды объекта");
    assert.eq((await env.ok("POST", `${kindPath("ipsrv")}/actions/probe`, { params: want })).result, viaUnit, "регистратор");
    const srv = (await env.ok("POST", `${kindPath("server")}/actions/probe`, { params: { targets: [{ ip: "10.77.0.2", port: 20111 }] } })).result;
    assert.eq([srv.items.length, srv.items[0].serverId], [1, null], "опрос адреса: такого сервера нет");
    const nas = { name: "\\\\nas\\v", disk: "\\\\nas\\v", sizeBytes: 1024 ** 3 };
    assert.eq((await env.ok("POST", `${kindPath("archive.network")}/actions/check`, { params: { volume: Object.assign({ login: "svc" }, nas) } })).result, { ok: true, code: null }, "NAS до создания");
    assert.eq((await env.ok("POST", `${kindPath("archive.network")}/actions/check`, { params: { volume: nas } })).result.ok, false, "NAS без пользователя");
    assert.status(await run("archive.local", "check", { volume: nas }), 404, "NOT_FOUND", "у локального проверки нет");
    assert.status(await run("relay", "output", { state: true }), 404, "NOT_FOUND", "команда объекта — не команда вида");
    assert.status(await run("нет.такого", "probe", want), 404, "NOT_FOUND", "вида нет");
    const bad = await run("camera", "probe", { port: 80 });
    assert.status(bad, 422, "VALIDATION_FAILED", "адрес обязателен");
    assert.eq(bad.body.field, "/params/ip", "указатель на параметр");
  }, { needs: ["runKindAction", "kind:camera", "kind:server", "kind:ipsrv", "kind:relay"] });

  test("Профили: свойства ручных экранов — recordMode у vms.archive/1, channel, enabled, short у vms.talk/1, подключение и единицы у vms.acs/1", async () => {
    const env = await makeEnv();
    const list = await env.ok("GET", "/kinds");
    const prof = Object.fromEntries(list.profiles.map((p) => [p.id, p.properties || []]));
    const has = (id, names) => assert.eq(names.filter((n) => !prof[id].includes(n)), [], `${id}: нет свойств`);
    has("vms.archive/1", ["recordMode"]);
    has("vms.talk/1", ["channel", "enabled", "short"]);
    has("vms.acs/1", ["identifier", "ip", "login", "password", "port", "unitOptions", "vendor", "operations", "properties"]);
    // Свойство профиля есть хотя бы у одного вида, который профиль реализует
    list.profiles.forEach((p) => {
      const own = list.items.filter((k) => (k.implements || []).includes(p.id));
      (p.properties || []).forEach((n) => assert.ok(!own.length || own.some((k) => n in ((k.schema || {}).properties || {})), `${p.id}: ${n} нет ни у одного вида`));
    });
  }, { needs: ["listKinds"] });

  test("hasChildren объекта: потоки дочерними не считаются, дочерние объекты — считаются; как в узле дерева", async () => {
    const env = await makeEnv();
    const kids = (u) => units().filter((x) => x.parentId === u.uid);
    const onlyStreams = ofKind("camera").find((c) => kids(c).length && kids(c).every((x) => x.kind === "stream"));
    const withDevices = ofKind("camera").find((c) => kids(c).some((x) => x.kind !== "stream" && x.kind !== "w2c.example/rows"));
    assert.ok(onlyStreams && withDevices, "в наборе есть камера только с потоками и камера с дочерними объектами");
    assert.eq((await env.ok("GET", `/units/${onlyStreams.uid}`)).hasChildren, false, "только потоки — шеврона нет");
    assert.eq((await env.ok("GET", `/units/${withDevices.uid}`)).hasChildren, true, "есть дочерние объекты — шеврон");
    const node = (await env.pages(`/tree/children?layout=servers&parentId=${dom1()}`)).find((n) => n.id === onlyStreams.parentId);
    if (node) assert.eq(node.hasChildren, true, "узел сервера с камерами");
  }, { needs: ["getUnit", "kind:camera"] });

  test("UnitBrief.subtype — как DeviceRow.subtype: подвид объекта в узле дерева, нет свойства — нет поля", async () => {
    const env = await makeEnv();
    const dom = units().find((u) => u.kind === "domain");
    const servers = (await env.pages(`/tree/children?layout=servers&parentId=${dom.uid}`));
    const nodes = servers.slice();
    for (const n of servers.slice(0, 20)) nodes.push(...(await env.pages(`/tree/children?layout=servers&parentId=${n.id}`)));
    const byUid = new Map(units().map((u) => [u.uid, u]));
    let seen = 0;
    nodes.filter((n) => n.unit).forEach((n) => {
      const sub = (byUid.get(n.id) || { properties: {} }).properties.subtype;
      if (typeof sub === "string" && sub) { seen++; assert.eq(n.unit.subtype, sub, `подвид узла ${n.id}`); }
      else assert.ok(!("subtype" in n.unit), `у узла ${n.id} нет подвида — нет и поля`);
    });
    if (units().some((u) => u.properties && u.properties.subtype)) assert.ok(seen > 0, "в обходе есть узел с подвидом");
  }, { needs: ["getTreeChildren"] });

  test("EventDescriptor.rule и alarm: по умолчанию true; abandoned, disappeared, crowd — не триггеры; other и segment.lost — не тревоги", async () => {
    const env = await makeEnv();
    const events = (await env.ok("GET", "/kinds/camera")).events;
    assert.eq(events.slice(0, 9).map((e) => e.id), ["motion", "linecross", "abandoned", "disappeared", "crowd", "lpr", "silent", "other", "segment.lost"], "порядок событий камеры: прежние первыми");
    assert.ok(["device.lost", "tamper", "plate.list", "alarm.closed", "rec.lost", "arm.off", "ptz.failed"].every((id) => events.some((e) => e.id === id)), "события цепочки правила объявлены");
    const flags = (e) => [e.rule !== false, e.alarm !== false];
    events.forEach((e) => assert.eq(flags(e), [!["abandoned", "disappeared", "crowd"].includes(e.id), !["other", "segment.lost"].includes(e.id)], `флаги ${e.id}`));
    const s = await env.ok("GET", "/settings");
    const tag = { "If-Match": `"${s.version}"` };
    const bad = await env.call("PATCH", "/settings", { values: { "alarms.domain": ["other"] } }, tag);
    assert.status(bad, 422, "VALIDATION_FAILED", "other — не тревога");
    assert.eq(bad.body.field, "alarms.domain", "поле");
    const ok = await env.call("PATCH", "/settings", { values: { "alarms.domain": ["crowd"] } }, tag);
    assert.status(ok, 200, null, "crowd — тревога");
  }, { needs: ["listKinds", "getKind", "patchSettings"] });

  ApiTest.loaded("api-units.js");
})();
