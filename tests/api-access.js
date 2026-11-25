/* Тесты API: права — применение черновика пакетом, проверки, защита от самоблокировки, синхронизация каталога. */
(() => {
  ApiTest.fileLayer("mechanism");
  const { makeEnv, assert, FX, FOLDER } = ApiTest;
  // Слой теста по началу имени; остальные тесты файла идут в слое файла
  const test = ApiTest.prefixLayers([
    ["PTZ — как в базе", "video"],
  ]);
  const A = FX.access;
  const meId = FX.me.userId;
  const draft = () => {
    const a = JSON.parse(JSON.stringify(A));
    return { roles: a.roles, users: a.users, groups: a.groups, catalogs: a.catalogs };
  };
  // Проверки пишут черновик целиком, как раньше форма: сюда он приходит и уходит изменениями. Ответ для них — полный снимок
  const changesOf = (from, to) => {
    const out = [];
    const list = (kind, was, now) => {
      const byId = new Map(was.map((x) => [x.id, x]));
      now.forEach((x) => {
        const old = byId.get(x.id);
        const { objectAccess, ...rest } = x;
        const row = kind === "role" ? Object.assign(rest, { objectAccessCount: Object.keys(objectAccess || {}).length }) : x;
        const oldRow = old && (kind === "role" ? (({ objectAccess: o, ...r }) => Object.assign(r, { objectAccessCount: Object.keys(o || {}).length }))(old) : old);
        if (JSON.stringify(oldRow) !== JSON.stringify(row)) out.push({ kind, id: x.id, op: "set", value: row });
        if (kind === "role") {
          const a = (old && old.objectAccess) || {}, b = objectAccess || {};
          Object.keys(b).forEach((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && out.push({ kind: "roleObject", id: x.id, op: "set", value: { objectId: k, levels: b[k] } }));
          Object.keys(a).forEach((k) => !(k in b) && out.push({ kind: "roleObject", id: x.id, op: "set", value: { objectId: k, levels: null } }));
        }
      });
      was.forEach((x) => !now.some((y) => y.id === x.id) && out.push({ kind, id: x.id, op: "delete" }));
    };
    list("role", from.roles, to.roles);
    list("user", from.users, to.users);
    list("group", from.groups, to.groups);
    list("catalog", from.catalogs, to.catalogs);
    if (to.streamGrants && JSON.stringify(to.streamGrants) !== JSON.stringify(from.streamGrants)) out.push({ kind: "streamGrants", id: "grants", op: "set", value: { grants: to.streamGrants } });
    return out;
  };
  const apply = async (env, access, opts) => {
    const was = (opts && opts.base) || (await env.access());
    const version = opts && opts.version !== undefined ? opts.version : was.version;
    const body = Object.assign({ version, changes: changesOf(was, access), history: [], cellHistory: [] }, opts && opts.body);
    const res = await env.call("POST", "/access/apply", body);
    return res.status === 200 && res.body.access ? Object.assign({}, res, { body: Object.assign({}, res.body, { access: await env.access() }) }) : res;
  };
  const NEW_ID = "9fff0001-0000-4000-8000-000000000001";

  test("Права: применить черновик — роль переименована, новый пользователь с ролью, история с автором, версия +1", async () => {
    const env = await makeEnv();
    const d = draft();
    const role = d.roles.find((r) => !r.global.unr);
    role.name = role.name + " (смена)";
    d.users.push({ id: NEW_ID, login: "new.user", name: "Новый", email: "", enabled: true, roleIds: [role.id], roleUntil: {}, lastLoginDate: null, expiresDate: null, webSessions: 0, mobileSessions: 0, catalogId: null });
    const res = await apply(env, d, { body: { history: [{ text: "Создан пользователь new.user", userId: NEW_ID, roleId: role.id }], cellHistory: [{ roleId: role.id, key: FX.domains[0].id, field: "cam", from: null, to: "FULL" }] } });
    assert.status(res, 200);
    const a = res.body.access;
    assert.eq([res.body.applied, res.headers.etag], [true, `"${a.version}"`], "применено, новая версия в ETag");
    assert.ok(a.version !== A.version, "версия изменилась");
    assert.eq(a.roles.find((r) => r.id === role.id).name, role.name, "роль");
    assert.ok(a.users.some((u) => u.id === NEW_ID && u.roleIds[0] === role.id), "пользователь с ролью");
    const login = A.users.find((u) => u.id === meId).login;
    assert.eq([a.history[0].text, a.history[0].actor, a.history.length], ["Создан пользователь new.user", login, A.history.length + 1], "история: сверху, с автором");
    assert.eq([a.cellHistory.length, a.cellHistory[0].to], [1, "FULL"], "история ячеек");
    assert.eq((await env.access()).version, a.version, "перечитано");
  }, { needs: ["kind:camera"] });

  test("Права: dryRun — проверка без записи", async () => {
    const env = await makeEnv();
    const d = draft();
    d.roles[1].name = "Проверка";
    const res = await apply(env, d, { body: { dryRun: true } });
    assert.eq([res.status, res.body.applied, res.body.access], [200, false, null], "только проверено");
    assert.eq((await env.access()).roles[1].name, A.roles[1].name, "ничего не записано");
  });

  test("Права: повторы имён и логинов (без учёта регистра) — 409; ссылка в никуда — 422", async () => {
    const env = await makeEnv();
    let d = draft();
    d.users[1].login = d.users[0].login.toUpperCase();
    assert.status(await apply(env, d), 409, "LOGIN_TAKEN");
    d = draft();
    d.roles[1].name = " " + d.roles[0].name.toLowerCase() + " ";
    assert.status(await apply(env, d), 409, "NAME_TAKEN");
    d = draft();
    d.users[1].roleIds = ["8fff9999-0000-4000-8000-000000000000"];
    assert.status(await apply(env, d), 422, "VALIDATION_FAILED", "нет роли");
    d = draft();
    d.groups[0].memberIds.push("9fff9999-0000-4000-8000-000000000000");
    assert.status(await apply(env, d), 422, "VALIDATION_FAILED", "нет пользователя");
  });

  test("Права: защита от самоблокировки — без администраторов и без себя нельзя", async () => {
    const env = await makeEnv();
    const adm = A.roles.find((r) => r.global.unr);
    let d = draft();
    d.users.forEach((u) => (u.roleIds = u.roleIds.filter((x) => x !== adm.id)));
    d.groups.forEach((g) => (g.roleIds = g.roleIds.filter((x) => x !== adm.id)));
    assert.status(await apply(env, d), 409, "SELF_LOCKOUT", "ни одного администратора");
    d = draft();
    d.users.find((u) => u.id === meId).enabled = false;
    assert.status(await apply(env, d), 409, "SELF_LOCKOUT", "себя выключить");
    d = draft();
    d.users = d.users.filter((u) => u.id !== meId);
    d.groups.forEach((g) => (g.memberIds = g.memberIds.filter((x) => x !== meId)));
    assert.status(await apply(env, d), 409, "SELF_LOCKOUT", "себя удалить");
  });

  test("Встроенная роль: меняются только назначения; имя, описание, права, удаление — 409 BUILTIN; unr у другой и снятие — 422", async () => {
    const env = await makeEnv();
    const adm = A.roles.find((r) => r.global.unr);
    const spoil = (fn) => { const d = draft(); fn(d, d.roles.find((r) => r.id === adm.id)); return d; };
    assert.status(await apply(env, spoil((d, r) => (r.name = "Главный"))), 409, "BUILTIN", "имя");
    assert.status(await apply(env, spoil((d, r) => (r.comment = "другое"))), 409, "BUILTIN", "описание");
    assert.status(await apply(env, spoil((d, r) => (r.global.feat = ["WEB_UI_LOGIN"]))), 409, "BUILTIN", "права");
    assert.status(await apply(env, spoil((d, r) => (r.objectAccess = { [FX.devices[0].id]: { cam: "FORBID" } }))), 409, "BUILTIN", "исключение на встроенной");
    assert.status(await apply(env, spoil((d) => {
      d.roles = d.roles.filter((r) => r.id !== adm.id);
      d.roles.forEach((r) => { if (r.supervision.roleId === adm.id) r.supervision = { roleId: null, login: false, export: false }; });
      d.users.forEach((u) => { u.roleIds = u.roleIds.filter((x) => x !== adm.id); delete u.roleUntil[adm.id]; });
      d.groups.forEach((g) => (g.roleIds = g.roleIds.filter((x) => x !== adm.id)));
    })), 409, "BUILTIN", "удаление");
    const off = await apply(env, spoil((d, r) => (r.global.unr = false)));
    assert.status(off, 422, "NOT_SUPPORTED", "снять у встроенной");
    assert.eq(off.body.field, "global.unr", "поле");
    const on = await apply(env, spoil((d) => (d.roles.find((r) => r.id !== adm.id).global.unr = true)));
    assert.status(on, 422, "NOT_SUPPORTED", "у другой роли");
    assert.eq(on.body.field, "global.unr", "поле");
    const other = A.users.find((u) => u.id !== meId && !u.roleIds.includes(adm.id));
    const res = await apply(env, spoil((d) => d.users.find((u) => u.id === other.id).roleIds.push(adm.id)));
    assert.status(res, 200);
    assert.ok(res.body.access.users.find((u) => u.id === other.id).roleIds.includes(adm.id), "назначение меняется");
  }, { needs: ["kind:camera"] });

  test("Последний администратор: срок учётной записи, назначения, ролей группы не считается — 409 SELF_LOCKOUT", async () => {
    const env = await makeEnv();
    const adm = A.roles.find((r) => r.global.unr);
    const only = (fn) => {
      const d = draft();
      d.users.filter((u) => u.id !== meId).forEach((u) => (u.roleIds = u.roleIds.filter((x) => x !== adm.id)));
      d.groups.forEach((g) => (g.roleIds = g.roleIds.filter((x) => x !== adm.id)));
      fn(d, d.users.find((u) => u.id === meId));
      return d;
    };
    const far = "2099-01-01";
    assert.status(await apply(env, only((d, u) => (u.expiresDate = far))), 409, "SELF_LOCKOUT", "срок учётной записи");
    assert.status(await apply(env, only((d, u) => (u.roleUntil[adm.id] = far))), 409, "SELF_LOCKOUT", "срок назначения");
    assert.status(await apply(env, only(() => {})), 200);
  });

  test("Самоблокировка: снять с себя «Администратора» нельзя и при втором администраторе", async () => {
    const env = await makeEnv();
    const adm = A.roles.find((r) => r.global.unr);
    const d = draft();
    d.users.find((u) => u.id !== meId).roleIds.push(adm.id);
    const me = d.users.find((u) => u.id === meId);
    me.roleIds = me.roleIds.filter((x) => x !== adm.id);
    d.groups.forEach((g) => (g.memberIds = g.roleIds.includes(adm.id) ? g.memberIds.filter((x) => x !== meId) : g.memberIds));
    assert.status(await apply(env, d), 409, "SELF_LOCKOUT");
  }, { needs: ["kind:camera"] });

  test("Справочник: joins — «Просмотр» и «Просмотр архива» вместе дают «Просмотр и архив»", async () => {
    const env = await makeEnv();
    const j = (await env.ok("GET", "/reference")).access.joins;
    assert.eq(j, [{ kind: "cam", levels: ["MON", "ONLY_ARCHIVE"], level: "ARCHIVE" }], "пара объявлена");
  }, { needs: ["kind:camera"] });

  test("Пароль: новый пользователь и смена, в ответах нет; политика — 422 PASSWORD_POLICY", async () => {
    const env = await makeEnv();
    const d = draft();
    const role = d.roles.find((r) => !r.global.unr);
    const nu = { id: NEW_ID, login: "pw.user", name: "Пароль", email: "", enabled: true, roleIds: [role.id], roleUntil: {}, lastLoginDate: null, expiresDate: null, webSessions: 0, mobileSessions: 0, catalogId: null };
    d.users.push(Object.assign({}, nu, { password: "Abcdef12" }));
    const res = await apply(env, d);
    assert.status(res, 200);
    const made = res.body.access.users.find((u) => u.id === NEW_ID);
    assert.eq([made.hasPassword, "password" in made, made.passwordByAdmin], [true, false, true], "задан администратором, значения нет");
    const a = await env.access();
    assert.ok(!JSON.stringify(a).includes("Abcdef12"), "пароля нет в снимке");
    const bad = async (password, login) => {
      const x = { roles: a.roles, users: JSON.parse(JSON.stringify(a.users)), groups: a.groups, catalogs: a.catalogs };
      const u = x.users.find((y) => y.id === NEW_ID);
      u.password = password;
      if (login) u.login = login;
      return apply(env, x, { base: a });
    };
    const policy = FX.reference.access.passwordPolicy;
    const short = await bad("A1");
    assert.status(short, 422, "PASSWORD_POLICY", "короткий");
    assert.eq(short.body.field, "password", "поле");
    assert.status(await bad("1".repeat(policy.minLength)), 422, "PASSWORD_POLICY", "без буквы");
    assert.status(await bad("a".repeat(policy.minLength)), 422, "PASSWORD_POLICY", "без цифры");
    assert.status(await bad("xpw.user12"), 422, "PASSWORD_POLICY", "логин внутри");
    const ok = await bad("Zyxwvu98");
    assert.status(ok, 200);
    assert.eq(ok.body.access.users.find((u) => u.id === NEW_ID).hasPassword, true, "смена пароля");
  }, { needs: ["kind:camera"] });

  // Управляющий: роль с USERS_RIGHTS_SETUP, человек не администратор
  const managerEnv = async () => {
    const roles = JSON.parse(JSON.stringify(A.roles));
    const adm = roles.find((r) => r.global.unr);
    const mgr = roles.find((r) => !r.global.unr && r.global.feat.includes("WEB_UI_LOGIN"));
    mgr.global.feat.push("USERS_RIGHTS_SETUP");
    mgr.global.ur = "ALL";
    const man = A.users.find((u) => u.enabled && u.id !== meId && u.roleIds.includes(mgr.id) && !u.roleIds.includes(adm.id) && !u.catalogId);
    const env = await makeEnv({ actAs: man.login, fixturePatch: { access: { roles } } });
    const a = await env.access();
    const wr = (x) => apply(env, x, { base: a });
    return { env, a, adm, mgr, man, wr, copy: () => JSON.parse(JSON.stringify(a)) };
  };

  test("Управляющий: ведёт пользователей, но «Администратора» не трогает — 403 на весь пакет, ничего не записано", async () => {
    const { env, a, adm, mgr, man, wr, copy } = await managerEnv();
    const root = a.users.find((u) => u.id === meId);
    const plain = a.users.find((u) => u.id !== man.id && u.id !== meId && !u.roleIds.includes(adm.id) && !a.groups.some((g) => g.memberIds.includes(u.id) && g.roleIds.includes(adm.id)));
    const cases = {
      "назначить себе": (x) => x.users.find((u) => u.id === man.id).roleIds.push(adm.id),
      "снять с администратора": (x) => { const u = x.users.find((y) => y.id === root.id); u.roleIds = u.roleIds.filter((r) => r !== adm.id); },
      "выключить администратора": (x) => (x.users.find((u) => u.id === root.id).enabled = false),
      "сменить пароль администратору": (x) => (x.users.find((u) => u.id === root.id).password = "Abcdef12"),
      "удалить администратора": (x) => (x.users = x.users.filter((u) => u.id !== root.id)),
      "включить функцию управляющего": (x) => { const r = x.roles.find((y) => y.id !== mgr.id && !y.global.unr && !y.global.feat.includes("USERS_RIGHTS_SETUP")); r.global.feat.push("USERS_RIGHTS_SETUP"); r.global.ur = "ALL"; },
    };
    for (const [name, fn] of Object.entries(cases)) {
      const x = copy();
      x.users.find((u) => u.id === plain.id).name = "Заодно";
      fn(x);
      assert.status(await wr(x), 403, "PERMISSION_DENIED", name);
    }
    assert.eq((await env.access()).users.find((u) => u.id === plain.id).name, plain.name, "ничего не записано");
    const fine = copy();
    fine.users.find((u) => u.id === plain.id).name = "Новое имя";
    assert.status(await wr(fine), 200);
  }, { needs: ["kind:camera"] });

  test("Управляющий: снимок целиком без изменений у администратора проходит; пароль, заданный им, не даёт назначить «Администратора»", async () => {
    const { env, a, adm, man, wr, copy } = await managerEnv();
    const plain = a.users.find((u) => u.id !== man.id && u.id !== meId && !u.roleIds.includes(adm.id) && !u.catalogId && !a.groups.some((g) => g.memberIds.includes(u.id) && g.roleIds.includes(adm.id)));
    const x = copy();
    x.users.find((u) => u.id === plain.id).password = "Abcdef12";
    const res = await wr(x);
    assert.status(res, 200);
    assert.eq(res.body.access.users.find((u) => u.id === plain.id).passwordByAdmin, false, "задал не администратор");
    const db = await env.access();
    assert.eq(db.users.find((u) => u.id === plain.id).passwordByAdmin, false, "сохранено");
  }, { needs: ["kind:camera"] });

  test("Повышение: «Администратор» пользователю с чужим паролем — 409 PASSWORD_NOT_ADMIN, после смены пароля можно", async () => {
    const env = await makeEnv();
    const adm = A.roles.find((r) => r.global.unr);
    const u = A.users.find((x) => x.passwordByAdmin === false);
    let d = draft();
    d.users.find((x) => x.id === u.id).roleIds.push(adm.id);
    const res = await apply(env, d);
    assert.status(res, 409, "PASSWORD_NOT_ADMIN");
    assert.eq([res.body.field, res.body.params.id], ["roleIds", u.id], "поле и пользователь");
    d = draft();
    const g = d.groups.find((x) => x.roleIds.includes(adm.id));
    if (g) {
      g.memberIds.push(u.id);
      assert.status(await apply(env, d), 409, "PASSWORD_NOT_ADMIN", "через группу");
    }
    d = draft();
    const y = d.users.find((x) => x.id === u.id);
    y.roleIds.push(adm.id);
    y.password = "Abcdef12";
    const done = await apply(env, d);
    assert.status(done, 200);
    assert.eq(done.body.access.users.find((x) => x.id === u.id).passwordByAdmin, true, "пароль сменил администратор");
  }, { needs: ["kind:camera"] });

  test("Почта: администратор и управляющий видят всех, остальные — только свою", async () => {
    const adm = A.roles.find((r) => r.global.unr);
    const withMail = A.users.filter((u) => u.email);
    const reader = A.users.find((u) => u.enabled && !u.roleIds.includes(adm.id) && !A.groups.some((g) => g.memberIds.includes(u.id) && g.roleIds.includes(adm.id)) && !u.roleIds.some((id) => A.roles.find((r) => r.id === id).global.feat.includes("USERS_RIGHTS_SETUP")));
    const env = await makeEnv({ actAs: reader.login });
    const a = await env.access();
    assert.ok(a.users.every((u) => u.id === reader.id || u.email === ""), "чужой почты нет: " + withMail.length);
    assert.eq(a.users.find((u) => u.id === reader.id).email, reader.email, "своя есть");
    const { a: b } = await managerEnv();
    assert.eq(b.users.filter((u) => u.email).length, withMail.length, "управляющий видит всех");
  }, { needs: ["kind:camera"] });

  test("Без функции «Настройка прав пользователей» применить нельзя — 403", async () => {
    const adm = A.roles.find((r) => r.global.unr);
    const reader = A.users.find((u) => u.enabled && !u.roleIds.includes(adm.id) && !A.groups.some((g) => g.memberIds.includes(u.id) && g.roleIds.includes(adm.id)) && !u.roleIds.some((id) => A.roles.find((r) => r.id === id).global.feat.includes("USERS_RIGHTS_SETUP")));
    const env = await makeEnv({ actAs: reader.login });
    const a = await env.access();
    const send = (x, v) => apply(env, x, { base: a, version: v });
    const x = JSON.parse(JSON.stringify(a));
    x.users.find((u) => u.id === reader.id).name = "Новое";
    assert.status(await send(x, a.version), 403, "PERMISSION_DENIED");
    x.users.find((u) => u.id === reader.id).name = reader.name;
    assert.status(await send(x, a.version), 200, undefined, "снимок без правок: чужая пустая почта правкой не считается");
    assert.eq((await env.access()).users.length, a.users.length, "на месте");
  }, { needs: ["kind:camera"] });

  test("Папки ведёт только «Администратор»: функция роли и права на папку этого не дают — 403", async () => {
    const adm = A.roles.find((r) => r.global.unr);
    const reader = A.users.find((u) => u.enabled && !u.roleIds.includes(adm.id) && !A.groups.some((g) => g.memberIds.includes(u.id) && g.roleIds.includes(adm.id)));
    const env = await makeEnv({ actAs: reader.login });
    const f = FX.folders[0];
    const made = await env.ok("POST", "/units", { idempotencyKey: ApiTest.key(), items: [{ kind: "folder", name: "Новая", domainId: FX.domains[0].id, parentId: null, properties: {} }] });
    assert.eq(made.failed.map((x) => x.code), ["PERMISSION_DENIED"], "создать");
    assert.status(await env.call("PATCH", `/units/${f.id}`, { name: "Другая" }, { "If-Match": `"${f.version}"` }), 403, "PERMISSION_DENIED", "переименовать");
    assert.status(await env.call("DELETE", `/units/${f.id}`, undefined, { "If-Match": `"${f.version}"` }), 403, "PERMISSION_DENIED", "удалить");
    // Состав папки — тоже: PATCH {folders}, шаг folders и шаг patch только с folders (база: POST /folders/{id}/devices — 403)
    const g = FX.folders.find((x) => (x.deviceIds || []).length);
    const dev = await env.ok("GET", `/units/${g.deviceIds[0]}`);
    const next = (dev.folders || []).filter((x) => x !== g.id);
    const denied = await env.call("PATCH", `/units/${dev.uid}`, { folders: next }, { "If-Match": `"${dev.version}"` });
    assert.status(denied, 403, "PERMISSION_DENIED", "состав папки: PATCH {folders}");
    assert.eq(denied.body.field, "/folders", "указатель — на папки");
    for (const item of [{ uid: dev.uid, folders: next }, { uid: dev.uid, patch: { folders: next } }]) {
      const op = await env.runOperation({ idempotencyKey: ApiTest.key(), items: [item], expectedVersions: { [dev.uid]: dev.version } });
      assert.eq(op.items.map((x) => [x.state, x.code]), [["fail", "PERMISSION_DENIED"]], `состав папки: шаг ${item.folders ? "folders" : "patch {folders}"}`);
    }
    assert.eq((await env.ok("GET", `/units/${dev.uid}`)).folders, dev.folders, "папки объекта на месте");
  }, { needs: ["createUnits", "patchUnit", "deleteUnit", "createOperation", `implements:${FOLDER}`, "kind:camera"] });

  test("Перенос папки ведёт только «Администратор» — 403, папка на месте", async () => {
    const adm = A.roles.find((r) => r.global.unr);
    const reader = A.users.find((u) => u.enabled && !u.roleIds.includes(adm.id) && !A.groups.some((g) => g.memberIds.includes(u.id) && g.roleIds.includes(adm.id)));
    const env = await makeEnv({ actAs: reader.login });
    const f = FX.folders.find((x) => x.parentId);
    const res = await env.call("POST", `/units/${f.id}/move`, { parentId: null }, { "If-Match": `"${f.version}"` });
    assert.status(res, 403, "PERMISSION_DENIED", "перенести");
    assert.eq((await env.ok("GET", `/units/${f.id}`)).parentId, f.parentId, "родитель прежний");
    const op = await env.runOperation({ idempotencyKey: ApiTest.key(), items: [{ uid: f.id, move: null }], expectedVersions: { [f.id]: f.version } });
    assert.eq(op.items.map((x) => [x.state, x.code]), [["fail", "PERMISSION_DENIED"]], "шаг move");
  }, { needs: ["moveUnit", "createOperation", `implements:${FOLDER}`, "cap:folder:move"] });

  test("Учётки потоков: доступ к камерам через Access; ссылки проверяются; удаление учётки, камеры и папки убирает доступ", async () => {
    const env = await makeEnv();
    const a = await env.access();
    const g = a.streamGrants.find((x) => x.account === "videowall");
    assert.ok(g && g.folderIds.length && g.deviceIds.length, "из набора");
    const send = async (list) => {
      const now = await env.access();
      const d = { roles: now.roles, users: now.users, groups: now.groups, catalogs: now.catalogs };
      if (list) d.streamGrants = list;
      return apply(env, d, { base: now });
    };
    const res = await send([{ account: "videowall", all: true, folderIds: [], deviceIds: [] }]);
    assert.status(res, 200);
    assert.eq(res.body.access.streamGrants[0].all, true, "все камеры");
    assert.eq((await (await send()).body.access).streamGrants.length, 1, "нет поля — не меняется");
    assert.status(await send([{ account: "нет такой", all: true, folderIds: [], deviceIds: [] }]), 422, "VALIDATION_FAILED", "учётки нет");
    const two = { account: "videowall", all: true, folderIds: [], deviceIds: [] };
    assert.status(await send([two, two]), 422, "VALIDATION_FAILED", "повтор");
    const notCam = FX.devices.find((x) => x.type !== "camera");
    assert.status(await send([{ account: "videowall", all: false, folderIds: [], deviceIds: [notCam.id] }]), 422, "VALIDATION_FAILED", "не камера");
    assert.status(await send([{ account: "videowall", all: false, folderIds: ["bfff9999-0000-4000-8000-000000000000"], deviceIds: [] }]), 422, "VALIDATION_FAILED", "папки нет");
    assert.status(await send([g]), 200);
    assert.status(await env.call("DELETE", `/units/${g.deviceIds[0]}`, undefined, { "If-Match": `"${(await env.ok("GET", `/units/${g.deviceIds[0]}`)).version}"` }), 204);
    assert.eq((await env.access()).streamGrants[0].deviceIds, [], "камеры нет");
    const v = (await env.access()).version;
    assert.status(await env.call("DELETE", "/stream-accounts/videowall"), 204);
    const after = await env.access();
    assert.eq(after.streamGrants, [], "учётки нет — доступа нет");
    assert.ok(after.version !== v, "версия снимка сдвинулась");
  }, { needs: ["feature:streamGrants", "deleteUnit"] });

  test("Учётки потоков: без возможности непустой список — 422 NOT_SUPPORTED", async () => {
    const env = await makeEnv({ fixturePatch: { reference: { capabilities: { features: [] } }, access: { streamGrants: [], catalogs: [], groups: [] } } });
    const now = await env.access();
    now.users.forEach((u) => { u.webSessions = 0; u.mobileSessions = 0; u.catalogId = null; delete u.syncedGroupId; });
    now.roles.forEach((r) => { r.loginSchedule = 0; r.supervision = { roleId: null, login: false, export: false }; r.global.depth = 0; r.global.restr = {}; if (!r.global.unr) r.global.ur = r.global.feat.includes("USERS_RIGHTS_SETUP") ? "ALL" : "NO"; });
    const res = await apply(env, Object.assign({}, now, { streamGrants: [{ account: "videowall", all: true, folderIds: [], deviceIds: [] }] }), { base: await env.access() });
    assert.status(res, 422, "NOT_SUPPORTED");
    assert.eq(res.body.field, "streamGrants", "поле");
  }, { needs: ["listStreamAccounts"] });

  test("Права: без версии — 422, старая — 412; состояние синхронизации от клиента не берётся", async () => {
    const env = await makeEnv();
    assert.status(await env.call("POST", "/access/apply", { changes: [], history: [], cellHistory: [] }), 422, "VALIDATION_FAILED", "версия обязательна");
    assert.status(await apply(env, draft(), { version: "stale" }), 412, "VERSION_MISMATCH");
  });

  test("Каталог: состояние синхронизации от клиента не берётся", async () => {
    const env = await makeEnv();
    const d = draft();
    d.catalogs[0].status = "err";
    d.catalogs[0].message = "подделка";
    const res = await apply(env, d);
    assert.eq([res.body.access.catalogs[0].status, res.body.access.catalogs[0].message], [A.catalogs[0].status, A.catalogs[0].message], "у сервера");
  }, { needs: ["feature:accessCatalogs"] });

  test("Части прав: возможности нет — 422 NOT_SUPPORTED с полем; значение по умолчанию проходит", async () => {
    const env = await makeEnv({ fixturePatch: { reference: { capabilities: { features: [] } }, access: { catalogs: [], groups: [], streamGrants: [] } } });
    const base = await env.access();
    const fresh = () => {
      const a = JSON.parse(JSON.stringify(base));
      a.users.forEach((u) => { u.webSessions = 0; u.mobileSessions = 0; u.catalogId = null; delete u.syncedGroupId; });
      a.roles.forEach((r) => {
        r.loginSchedule = 0;
        r.supervision = { roleId: null, login: false, export: false };
        r.global.depth = 0;
        r.global.restr = {};
        if (!r.global.unr) r.global.ur = r.global.feat.includes("USERS_RIGHTS_SETUP") ? "ALL" : "NO";
      });
      return { roles: a.roles, users: a.users, groups: a.groups, catalogs: a.catalogs };
    };
    const send = (d) => apply(env, d, { base });
    const role = (d) => d.roles.find((r) => !r.global.unr);
    const cases = [
      ["global.depth", (d) => (role(d).global.depth = 24)],
      ["global.restr", (d) => (role(d).global.restr = { watermark: true })],
      ["global.ur", (d) => (role(d).global.ur = "ALL")],
      ["loginSchedule", (d) => (role(d).loginSchedule = 1)],
      ["supervision", (d) => (role(d).supervision.login = true)],
      ["webSessions", (d) => (d.users[0].webSessions = 2)],
      ["mobileSessions", (d) => (d.users[0].mobileSessions = 2)],
    ];
    for (const [field, spoil] of cases) {
      const d = fresh();
      spoil(d);
      const res = await send(d);
      assert.status(res, 422, "NOT_SUPPORTED", field);
      assert.eq(res.body.field, field, "путь поля");
    }
    assert.status(await send(fresh()), 200);
  }, { needs: ["kind:camera"] });

  // Уровни класса cam без ONLY_ARCHIVE: и в описаниях видов, и в справочнике
  const camLess = (levels) => levels.filter((x) => x !== "ONLY_ARCHIVE");
  const withoutLevel = () => ({
    kinds: FX.kinds.map((k) => (k.access && k.access.class === "cam" ? Object.assign({}, k, { access: Object.assign({}, k.access, { levels: camLess(k.access.levels) }) }) : k)),
    reference: { access: { levels: { cam: camLess(FX.reference.access.levels.cam) } } },
  });

  test("Справочник: уровень, класс, функция, запрет, плагин вне описаний видов и reference.access — 422 NOT_SUPPORTED", async () => {
    const env = await makeEnv({ fixturePatch: withoutLevel() });
    const cases = [
      ["folderAccess.cam", (r) => (r.folderAccess[FX.domains[0].id] = { cam: "ONLY_ARCHIVE" })],
      ["objectAccess.cam", (r) => (r.objectAccess[FX.devices.find((x) => x.type === "camera").id] = { cam: "ONLY_ARCHIVE" })],
      ["kindAccess.cam", (r) => (r.kindAccess.cam = "ONLY_ARCHIVE")],
      ["kindAccess.no-such", (r) => (r.kindAccess["no-such"] = "view")],
      ["kindAccess.security_controller", (r) => (r.kindAccess.security_controller = "FULL")],
      ["global.feat", (r) => r.global.feat.push("NO_SUCH_FEATURE")],
      ["objectAccess", (r) => (r.objectAccess["plug:no-such"] = {})],
    ];
    for (const [field, spoil] of cases) {
      const d = draft();
      d.roles.filter((r) => !r.global.unr).forEach((r) => {
        if (r.kindAccess.cam === "ONLY_ARCHIVE") r.kindAccess.cam = "FORBID";
        [r.folderAccess, r.objectAccess].forEach((m) => Object.values(m).forEach((row) => { if (row.cam === "ONLY_ARCHIVE") row.cam = "FORBID"; }));
      });
      spoil(d.roles.find((r) => !r.global.unr));
      const res = await apply(env, d);
      assert.status(res, 422, "NOT_SUPPORTED", field);
      assert.eq(res.body.field, field, "путь поля");
    }
  }, { needs: ["kind:camera"] });

  /* ----- Права по описаниям видов: Role.kindAccess, классы и уровни из UnitKind.access, право команды и предметного API ----- */

  const kindOf = (code) => FX.kinds.find((k) => k.kind === code);
  const classesOf = (k) => (k.access ? [k.access].concat(k.access.also || []) : []);
  // Роль и человек с одной этой ролью: правки роли — поверх «Аудитора» без прав
  const NEW_ROLE = "8fff0001-0000-4000-8000-000000000001", NEW_USER = "9fff0002-0000-4000-8000-000000000002";
  const asRole = (over, patch) => {
    const base = A.roles.find((r) => !r.global.unr && !Object.keys(r.folderAccess).length);
    const role = Object.assign(JSON.parse(JSON.stringify(base)), { id: NEW_ROLE, name: "Проверка прав" }, over);
    const user = Object.assign(JSON.parse(JSON.stringify(A.users.find((u) => u.id !== meId))), { id: NEW_USER, login: "rights-check", name: "Проверка прав", roleIds: [NEW_ROLE], roleUntil: {}, enabled: true, expiresDate: null });
    return makeEnv({ actAs: user.login, fixturePatch: Object.assign({ access: { roles: A.roles.concat([role]), users: A.users.concat([user]) } }, patch || {}) });
  };

  test("Роль: kindAccess {класс: уровень} вместо dCam, dSens…; уровни не беднеют — классы и уровни из описаний видов, tel — дополнительный класс камеры", async () => {
    const env = await makeEnv();
    const a = await env.access();
    const cam = await env.ok("GET", "/kinds/camera");
    assert.eq([cam.access.class, (cam.access.also || []).map((x) => x.class)], ["cam", ["tel"]], "камера: основной класс cam, дополнительный tel");
    const ref = FX.reference.access;
    Object.entries(ref.levels).forEach(([cls, levels]) => FX.kinds.forEach((k) => classesOf(k).filter((x) => x.class === cls).forEach((x) =>
      assert.eq(x.levels, levels, `уровни класса ${cls} у вида ${k.kind} — те же, что в справочнике`))));
    ref.defaults.forEach((d) => assert.ok(ref.levels[d.levels], "у класса умолчания есть уровни: " + d.key));
    a.roles.forEach((r) => {
      assert.ok(!Object.keys(r.global).some((k) => /^d[A-Z]/.test(k)), "в global нет умолчаний dCam…: " + r.name);
      Object.entries(r.kindAccess).forEach(([cls, v]) => assert.ok((ref.levels[cls] || []).includes(v), `${r.name}: ${cls} = ${v} — уровень класса`));
    });
    const op = a.roles.find((r) => r.name === "Оператор");
    assert.eq([op.kindAccess.cam, op.kindAccess.tel, op.kindAccess.relay], ["MON", "LOW", "FORBID"], "умолчания роли — по классам");
    assert.ok(Object.keys(op.folderAccess).every((k) => FX.units.some((u) => u.uid === k && ["folder", "domain"].includes(u.kind))), "folderAccess — по uid папки или домена");
  }, { needs: ["class:tel"] });

  test("Команда объекта: право — уровень класса вида (ActionDescriptor.right); роль с kindAccess security_controller=view не может ARM — 403", async () => {
    const ctrl = FX.units.find((u) => u.kind === "security_controller/CONTROLLER" && u.status.link === "online");
    const arm = kindOf(ctrl.kind).actions.find((x) => x.id === "ARM");
    assert.eq(arm.right, { level: "edit" }, "ARM нужен уровень edit класса вида");
    const view = await asRole({ kindAccess: { security_controller: "view" } });
    const no = await view.call("POST", `/units/${ctrl.uid}/actions/ARM`, { params: {} });
    assert.status(no, 403, "PERMISSION_DENIED", "view ниже edit");
    assert.eq(no.body.params.right, { class: "security_controller", level: "edit" }, "какое право нужно");
    assert.eq((await view.ok("GET", `/units/${ctrl.uid}`)).status.observed.armed, false, "команда не выполнена");
    const none = await asRole({ kindAccess: {} });
    assert.status(await none.call("POST", `/units/${ctrl.uid}/actions/ARM`, { params: {} }), 403, "PERMISSION_DENIED", "уровня класса нет — права нет");
    const edit = await asRole({ kindAccess: { security_controller: "edit" } });
    assert.status(await edit.call("POST", `/units/${ctrl.uid}/actions/ARM`, { params: {} }), 200, null, "edit — можно");
    const own = await asRole({ kindAccess: { security_controller: "view" }, objectAccess: { [ctrl.uid]: { security_controller: "admin" } } });
    assert.status(await own.call("POST", `/units/${ctrl.uid}/actions/ARM`, { params: {} }), 200, null, "исключение объекта по uid поднимает уровень");
    const low = await asRole({ kindAccess: { security_controller: "admin" }, objectAccess: { [ctrl.uid]: { security_controller: "view" } } });
    assert.status(await low.call("POST", `/units/${ctrl.uid}/actions/ARM`, { params: {} }), 403, "PERMISSION_DENIED", "и опускает");
    const folder = (ctrl.folders || [])[0];
    if (folder) {
      const f = await asRole({ kindAccess: { security_controller: "view" }, folderAccess: { [folder]: { security_controller: "edit" } } });
      assert.status(await f.call("POST", `/units/${ctrl.uid}/actions/ARM`, { params: {} }), 200, null, "папка по uid даёт уровень своим объектам");
    }
  }, { needs: ["runUnitAction", "kind:security_controller/CONTROLLER"] });

  test("PTZ — как в базе: путь /units/{uid}/ptz правом роли не судится (у камеры нет apiRights); вид, объявивший apiRights, — 403 по классу", async () => {
    const env = await makeEnv();
    const c = (await env.pages("/units?kind=camera&limit=1000")).find((u) => u.properties.ptz && u.status.link === "online");
    assert.ok(!("apiRights" in kindOf("camera")), "у камеры права на пути профилей нет — в базе PTZ не судится");
    const low = await asRole({ kindAccess: { cam: "FULL", tel: "NO" } });
    assert.status(await low.call("PUT", `/units/${c.uid}/ptz`, { pan: 0.5, ttlSec: 3 }), 200, null, "tel NO — PTZ как в базе");
    // Механизм: вид объявляет право профиля — сервер судит его по классу вида
    const need = { class: "tel", level: "LOWEST" };
    const kinds = FX.kinds.map((k) => (k.kind === "camera" ? Object.assign({}, k, { apiRights: { "vms.ptz/1": need } }) : k));
    const judged = await asRole({ kindAccess: { cam: "FULL", tel: "NO" } }, { kinds });
    const no = await judged.call("PUT", `/units/${c.uid}/ptz`, { pan: 0.5, ttlSec: 3 });
    assert.status(no, 403, "PERMISSION_DENIED", "камеры — да, телеметрии нет");
    assert.eq(no.body.params.right, need, "какое право нужно");
    assert.status(await judged.call("PUT", `/units/${c.uid}/presets/1`, { name: "Вход" }), 403, "PERMISSION_DENIED", "пресеты — тоже PTZ");
    const ok = await asRole({ kindAccess: { cam: "MON", tel: "LOWEST" } }, { kinds });
    assert.status(await ok.call("PUT", `/units/${c.uid}/ptz`, { pan: 0.5, ttlSec: 3 }), 200, null, "tel с LOWEST — можно");
  }, { needs: ["putUnitPtz", "implements:vms.ptz/1", "class:tel"] });

  test("Синхронизация каталога: сразу run, через 1,5 с ok и время; во время — 409; группа отдельно", async () => {
    const env = await makeEnv();
    const c = A.catalogs[0];
    const res = await env.call("POST", `/access/catalogs/${c.id}/sync`, { groupId: null });
    assert.status(res, 202);
    assert.eq(res.body.status, "run", "идёт");
    assert.status(await env.call("POST", `/access/catalogs/${c.id}/sync`, { groupId: null }), 409, "BUSY");
    if (env.frozen) {
      const fired = await env.advance(2);
      assert.ok(fired.some((f) => f.kind === "catalog"), "в ответе часов");
    }
    const now = await env.until(async () => {
      const x = (await env.access()).catalogs.find((y) => y.id === c.id);
      return x.status !== "run" && x;
    }, "синхронизация закончилась");
    assert.eq([now.status, Date.parse(now.lastSyncAt) > Date.parse(c.lastSyncAt)], ["ok", true], "закончена");
    const g = A.groups.find((x) => x.source && x.source.catalogId === c.id);
    await env.ok("POST", `/access/catalogs/${c.id}/sync`, { groupId: g.id });
    assert.eq((await env.access()).catalogs.find((x) => x.id === c.id).status, "ok", "каталог не трогается при синхронизации группы");
    assert.status(await env.call("POST", "/access/catalogs/bfff9999-0000-4000-8000-000000000000/sync", { groupId: null }), 404, "NOT_FOUND");
  }, { needs: ["syncCatalog"] });

  test("Учётки потоков: создать, пароль один раз, отключить, новый пароль, удалить", async () => {
    const env = await makeEnv();
    const was = (await env.list("/stream-accounts")).length;
    const made = await env.call("POST", "/stream-accounts", { name: "wall-2" });
    assert.status(made, 201);
    assert.ok(made.body.password, "пароль в ответе");
    const row = (await env.list("/stream-accounts")).find((x) => x.name === "wall-2");
    assert.eq([row.disabled, row.password], [false, undefined], "в списке пароля нет");
    assert.status(await env.call("POST", "/stream-accounts", { name: "WALL-2" }), 409, "NAME_TAKEN", "имя занято");
    assert.status(await env.call("POST", "/stream-accounts", { name: "  " }), 422, "NAME_REQUIRED", "пустое");
    assert.eq((await env.ok("PATCH", "/stream-accounts/wall-2", { disabled: true })).disabled, true, "отключена");
    const next = await env.ok("POST", "/stream-accounts/wall-2/password", {});
    assert.ok(next.password && next.password !== made.body.password, "новый пароль");
    assert.status(await env.call("DELETE", "/stream-accounts/wall-2"), 204);
    assert.eq((await env.list("/stream-accounts")).length, was, "удалена");
    assert.status(await env.call("PATCH", "/stream-accounts/wall-2", { disabled: false }), 404, "NOT_FOUND");
  }, { needs: ["listStreamAccounts"] });

  test("Роль на весь домен: запись одна, отказ одного кластера не откатывает прочие, расхождение видно, повтор", async () => {
    const names = (i) => (i % 2 ? `Кластер2/Сервер ${i}` : `Кластер1/Сервер ${i}`);
    const servers = FX.servers.map((s, i) => Object.assign({}, s, { name: names(i) }));
    const env = await makeEnv({ fixturePatch: { servers, stand: { refuseClusters: ["Кластер2"] } } });
    const a = await env.access();
    const d = JSON.parse(JSON.stringify(a));
    const role = d.roles.find((r) => !r.global.unr);
    role.global.feat = role.global.feat.includes("WEB_UI_LOGIN") ? role.global.feat.filter((x) => x !== "WEB_UI_LOGIN") : role.global.feat.concat("WEB_UI_LOGIN");
    const res = await apply(env, d, { base: a });
    assert.status(res, 200);
    const raw = await env.ok("GET", "/access");
    assert.eq(raw.roles.filter((r) => r.spread).map((r) => [r.id, r.spread.map((x) => [x.cluster, x.state])]), [[role.id, [["Кластер2", "refused"]]]], "расхождение у роли, один кластер");
    assert.eq(raw.roles.filter((r) => r.id === role.id).length, 1, "роль одна");
    assert.ok((await env.pages("/access/history"))[0].text.includes("на кластере Кластер2 не применены"), "строка истории от системы");
    const body = (over) => Object.assign({ version: raw.version, changes: [], history: [], cellHistory: [] }, over);
    const again = await env.ok("POST", "/access/apply", body({ retryClusters: ["Кластер2"] }));
    assert.eq([again.applied, again.notApplied.map((x) => x.cluster)], [true, ["Кластер2"]], "повтор: кластер всё ещё отказывает");
    assert.ok(again.clusters >= 2, "итог по числу кластеров");
    const healed = await makeEnv({ fixturePatch: { servers } });
    const h = await healed.access();
    const x = JSON.parse(JSON.stringify(h));
    x.roles.find((r) => !r.global.unr).comment = "только имя и описание";
    const plain = await apply(healed, x, { base: h });
    assert.status(plain, 200);
    assert.ok(!plain.body.notApplied, "сама роль пишется одной записью");
  }, { needs: ["kind:camera"] });

  ApiTest.loaded("api-access.js");
})();
