/* Хуки профилей встроенного сервера (api/server.js): смысл известных видов, которого нет в описании вида (UnitKind).
   Описание вида говорит, какие у объекта свойства, родители и команды; хук профиля — что при этом происходит: проверки сверх
   схемы, умолчания нового объекта, удаление со своим каскадом, сервер-исполнитель шага, команды с поведением.
   Смысл перенесён сюда из старых путей (/domains, /servers, /devices, /folders, /archives, /volumes; сняты, остались пути
   ядра /units…). Коды и тексты ошибок — прежние, field — имя поля записи (name, ip, disk, moveTo…): пути ядра переводят его
   в указатель (/name, /properties/disk, /params/targets).

   ConsolemProfiles.HOOKS[профиль] — хук получает ctx сервера: {units, kinds, db, problem, send, now} и общие помощники
   моста записей (byId, legacy, bump, changed, lockedProblem, isAdmin…; состав — у pctx в server.js). Интерфейс плана:
   - view(unit, ctx) → unit — вычисляемое в ответе (status.observed): unit — копия для ответа, её можно дополнять;
   - beforeCreate(unit, parent, ctx) → Problem|null — новый объект, ещё не на складе: проверка и умолчания (хук дополняет
     unit). parent — объект склада, null — корень, { fresh, kind, parentId, domainId } — родитель из той же строки POST /units;
   - beforeSet(unit, patch, whole, ctx) → Problem|null — правка (UnitPatch, копия: имя хук может привести к виду записи);
   - afterSet(unit, before, ctx) — после правки (before — обратная правка) и после создания (before — null);
   - dependents(unit, ctx) → {remove, detach} — что ещё затрагивает удаление: проверка занятости групповой операцией;
   - executor(unit, ctx) → uid сервера, который применяет изменение: сервер без связи — шаг операции SERVER_OFFLINE;
   - actions[id](unit, params, ctx) → {result} | {operation: {until}} | Problem — команда с поведением; operation — долгая:
     идёт до момента until по часам сервера.
   Сверх интерфейса плана:
   - beforeDelete(unit, params, ctx) → Problem|null, remove(unit, params, ctx) → {record} — своё удаление вместо каскада ядра
     (params.moveTo — у домена). record: true — в стопке отката шаг, который назад не вернуть (как у DELETE старых путей);
   - beforeMove(unit, parentId, params, ctx) → Problem|null, move(unit, parentId, params, ctx) → unit — свой перенос: сервер
     принимают в домен (parentId — домен) и исключают (null, params.domainId — в другой домен); ответ — объект после переноса
     (камера w2c — новая запись); moveBack(unit, ctx) → {parentId, params} — как вернуть объект туда, где он сейчас: откат переноса;
   - actions[id] с scope kind (POST /kinds/{kind}/actions/{id}) зовутся без объекта: unit — черновик {uid: null, kind};
   - fixed — свойства, правку которых откат не возвращает;
   - остальное в хуке — общий код старого и нового пути (nameProblem, assign, check, format…). */
(() => {
  const GB = 1024 ** 3;
  const TB = 1024 ** 4;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const props = (u) => u.properties || (u.properties = {});
  const statusOf = (u) => u.status || (u.status = {});
  const observedOf = (u) => {
    const s = statusOf(u);
    return s.observed || (s.observed = {});
  };
  // UnitPatch → поля записи старого пути: у этих видов свойства и есть поля записи, имя — рядом
  const flat = (patch) => Object.assign({}, (patch && patch.properties) || {}, patch && patch.name !== undefined ? { name: patch.name } : {});
  const trimmed = (v) => String(v == null ? "" : v).trim();
  const isProblem = (r) => !!r && typeof r.status === "number" && !!r.body;

  /* ===== vms.domain/1 — домен ===== */

  function domainNameProblem(name, exceptId, ctx) {
    const v = trimmed(name);
    if (!v) return ctx.problem(422, "NAME_REQUIRED", "Укажите имя домена", { field: "name" });
    if (ctx.db.domains.some((d) => d.id !== exceptId && d.name.trim().toLowerCase() === v.toLowerCase())) return ctx.problem(409, "NAME_TAKEN", "Домен с таким именем уже есть", { field: "name" });
    return null;
  }
  // Итог круга по камерам домена: числа не пересекаются, выключенные вне total; отстаёт на круг (VIEW_ROUND_MS).
  // Круг — один проход по устройствам на все домены сразу (Map домен → итог): на стенде xl четыре домена по 250 000 камер,
  // проход на каждый был бы четырьмя проходами по миллиону. Итог, которому круг ещё не вышел, проход не трогает: число
  // и время у каждого домена — как при подсчёте поодиночке
  function domainSummary(id, ctx) {
    const db = ctx.db;
    if (db.stand.summaryOff) return null;
    const all = ctx.state.summaries || (ctx.state.summaries = new Map());
    const t = ctx.now(), fresh = (s) => !!s && t - Date.parse(s.at) < ctx.VIEW_ROUND_MS;
    if (fresh(all.get(id))) return all.get(id);
    const at = ctx.iso(t), next = new Map();
    db.domains.map((d) => d.id).concat(id).forEach((x) => !fresh(all.get(x)) && next.set(x, { total: 0, offline: 0, silent: 0, at }));
    db.devices.forEach((d) => {
      const s = next.get(d.domainId);
      if (!s || d.type !== "camera" || d.enabled === false) return;
      s.total++;
      // Встроенный сервер фаз не знает: связь есть у всех, кто online; поток упал — fault drv
      if (d.online === false && d.fault === "drv") s.silent++;
      else if (d.online === false || d.licenseExceeded) s.offline++;
    });
    next.forEach((s, x) => {
      if (db.stand.unread) s.unread = db.stand.unread;
      all.set(x, s);
    });
    return all.get(id);
  }
  // Удалить домен: не последний; непустой — только с moveTo (другой домен); над содержимым не идёт операция
  function domainDeleteProblem(u, params, ctx) {
    const db = ctx.db;
    if (db.domains.length < 2) return ctx.problem(409, "LAST_DOMAIN", "Последний домен удалить нельзя");
    // Содержимое домена — все объекты склада с его domainId, в том числе незнакомых видов (сам домен — корень, без domainId)
    const busyWith = ctx.units.byDomain(u.uid).some((x) => x.uid !== u.uid);
    const to = params.moveTo ? ctx.byId("domains", params.moveTo) : null;
    if (busyWith && (!to || to.id === u.uid)) return ctx.problem(422, "DOMAIN_NOT_EMPTY", "Укажите домен, куда перенести содержимое", { field: "moveTo" });
    const inside = (r) => r.domainId === u.uid;
    return ctx.lockedProblem([db.servers, db.devices, db.archives].flatMap((t) => t.filter(inside).map((r) => r.id)));
  }
  // Ничего не пропадает: серверы становятся нераспределёнными в домене moveTo, папки, устройства и сетевые хранилища
  // меняют домен, найденное поиском переходит туда же
  function domainRemove(u, params, ctx) {
    const db = ctx.db;
    const d = ctx.legacy.view(u);
    const inside = (r) => r.domainId === d.id;
    const to = params.moveTo ? ctx.byId("domains", params.moveTo) : null;
    const move = (table, kind, extra) =>
      db[table].filter(inside).forEach((r) => {
        Object.assign(r, { domainId: to.id }, extra || {});
        ctx.bump(r);
        ctx.changed(kind, r);
      });
    if (to) {
      move("servers", "server", { allocated: false });
      move("folders", "folder");
      move("devices", "device");
      move("archives", "archive");
      // Остальное склада — объекты незнакомых видов и их потомки — тоже в домен moveTo
      ctx.units.byDomain(d.id).filter((x) => x.uid !== d.id).forEach((x) => {
        x.domainId = to.id;
        ctx.units.reindex(x.uid);
      });
      const from = db.discovery.find((x) => x.domainId === d.id);
      if (from) {
        const into = db.discovery.find((x) => x.domainId === to.id);
        if (into) into.candidateIds = into.candidateIds.concat(from.candidateIds.filter((c) => !into.candidateIds.includes(c)));
        else from.domainId = to.id;
      }
      db.network.forEach((c) => (c.domainIds = [...new Set(c.domainIds.map((x) => (x === d.id ? to.id : x)))]));
    }
    db.discovery = db.discovery.filter((x) => x.domainId !== d.id);
    db.domains = db.domains.filter((x) => x !== d);
    ctx.send("entity.deleted", { kind: "domain", entityId: d.id });
    return { record: false };
  }

  const domain = {
    nameProblem: domainNameProblem,
    summary: domainSummary,
    view(out, ctx) {
      const s = domainSummary(out.uid, ctx);
      if (s) {
        out.status = Object.assign({}, out.status);
        out.status.observed = Object.assign({}, out.status.observed, { stateSummary: clone(s) });
      }
      return out;
    },
    beforeCreate(u, parent, ctx) {
      const bad = domainNameProblem(u.name, null, ctx);
      if (bad) return bad;
      u.name = trimmed(u.name);
      u.parentId = null;
      u.domainId = null;
      if (props(u).license === undefined) props(u).license = "";
      statusOf(u).link = "online";
      return null;
    },
    beforeSet(u, patch, whole, ctx) {
      if (patch.name === undefined) return null;
      const bad = domainNameProblem(patch.name, u.uid, ctx);
      if (!bad) patch.name = trimmed(patch.name);
      return bad;
    },
    beforeDelete: domainDeleteProblem,
    remove: domainRemove,
  };

  /* ===== vms.server/1 — сервер ===== */

  // Найденный опросом сервер сообщает о себе имя, нагрузку и диски; встроенный сервер их придумывает
  const SERVER_DISKS = [["C:", 256 * GB, true], ["D:", 4 * TB], ["E:", 6 * TB], ["F:", 8 * TB], ["G:", 12 * TB]];
  function serverCreate(u, parent, ctx) {
    const p = props(u);
    const ip = trimmed(p.ip);
    if (!/^[\w.-]+$/.test(ip)) return ctx.problem(422, "INVALID_IP", "Неверный адрес", { field: "ip" });
    if (ctx.db.servers.some((s) => s.ip.toLowerCase() === ip.toLowerCase() && s.port === p.port)) return ctx.problem(409, "ADDRESS_TAKEN", "Сервер с таким адресом уже есть", { field: "ip" });
    if (u.name === undefined) u.name = `Сервер — ${ip}`;
    Object.assign(p, { ip, role: p.role || "node", allocated: false });
    Object.assign(observedOf(u), { class: "server", telemetry: { cpu: 5, ram: 18, net: 2, disk: 0 }, gpu: null,
      disks: SERVER_DISKS.map(([disk, sizeBytes, system]) => ({ disk, sizeBytes, system: !!system })) });
    statusOf(u).link = "online";
    return null;
  }
  // Опрос адресов: отвечает ли адрес — у встроенного сервера по хешу адреса, так же, как в макете на константах
  function probe(targets, ctx) {
    const max = ctx.db.reference.limits.ipScanMax;
    if (targets.length > max) return ctx.problem(422, "IP_RANGE_TOO_LARGE", `За раз — не больше ${max} адресов`, { params: { max } });
    const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0);
    const items = targets.map(({ ip, port }) => {
      const s = ctx.db.servers.find((x) => x.ip.toLowerCase() === ip.toLowerCase() && x.port === port);
      if (s) return { ip, port, status: s.allocated ? "in-domain" : "found", serverId: s.id, domainId: s.allocated ? s.domainId : null };
      return { ip, port, status: hash(`${ip}:${port}`) % 3 === 0 ? "dead" : "found", serverId: null, domainId: null };
    });
    return { result: { items } };
  }
  // Приём в домен и исключение — x {domainId, allocated, fingerprint}: код отказа или null. Версию и занятость сверяет
  // тот, кто зовёт (у строки /servers/assign — своя версия, у переноса ядра — If-Match или expectedVersions)
  function assignCode(s, x, ctx) {
    if (x.allocated && !s.allocated && s.fingerprint && x.fingerprint !== s.fingerprint) return "FINGERPRINT_MISMATCH";
    if (!ctx.byId("domains", x.domainId)) return "NOT_FOUND";
    return null;
  }
  // Применить приём или исключение. Добавленный встаёт в конец списка — там, где его и ждут увидеть. Камера w2c: после
  // приёма записи сервера нет, это запись camera. Ответ: запись сервера, какой она стала, и камера, если появилась
  function assign(s, x, ctx) {
    const db = ctx.db;
    if (s.domainId !== x.domainId || s.allocated !== x.allocated) {
      Object.assign(s, { domainId: x.domainId, allocated: x.allocated });
      ctx.bump(s);
      db.servers = db.servers.filter((r) => r !== s).concat(s);
      ctx.changed("server", s);
    }
    const server = clone(s);
    let camera = null;
    if (s.class === "camera" && s.allocated) {
      db.servers = db.servers.filter((r) => r !== s);
      ctx.send("entity.deleted", { kind: "server", entityId: s.id });
      camera = ctx.legacy.add("devices", { id: ctx.uuid("device"), type: "camera", parentId: null, domainId: s.domainId, name: s.name, online: s.online !== false, enabled: true, direct: false, writableFields: ["name", "enabled", "labels"], version: ctx.newVersion() });
      ctx.send("entity.created", { kind: "device", entityId: camera.id, version: camera.version });
    }
    return { server, camera };
  }
  // Перенос ядра → приём: родитель — домен приёма (распределён), null — исключить: в свой домен или в params.domainId
  const assignOf = (u, parentId, params) => ({ domainId: parentId == null ? (params || {}).domainId || u.domainId : parentId, allocated: parentId != null, fingerprint: (params || {}).fingerprint });

  const server = {
    probe,
    assignCode,
    assign,
    beforeCreate: serverCreate,
    beforeSet: (u, patch, whole, ctx) => ctx.featureProblem("server", flat(patch)),
    executor: (u) => u.uid,
    actions: {
      probe: (u, params, ctx) => probe(params.targets || [], ctx),
    },
    beforeMove(u, parentId, params, ctx) {
      // Приём меняет состав домена: судит администратор домена, а не право на кластер
      if (!ctx.isAdmin()) return ctx.problem(403, "PERMISSION_DENIED", "Принять и исключить может администратор домена");
      const par = parentId == null ? null : ctx.units.get(parentId);
      if (par && par.kind !== "domain") return ctx.problem(422, "PARENT_MISMATCH", "Сервер принимают в домен", { field: "parentId", params: { kind: u.kind, parentKind: par.kind } });
      const to = (params || {}).domainId;
      if (to !== undefined && (parentId != null || typeof to !== "string")) return ctx.problem(422, "VALIDATION_FAILED", "domainId — домен, куда исключить: только при parentId null", { field: "/params/domainId" });
      const code = assignCode(ctx.legacy.view(u), assignOf(u, parentId, params), ctx);
      if (code === "FINGERPRINT_MISMATCH") return ctx.problem(409, code, "Отпечаток сервера не тот, что видел администратор", { field: "fingerprint" });
      return code ? ctx.problem(404, code, "Домен не найден", { field: to !== undefined ? "/params/domainId" : "parentId" }) : null;
    },
    // Как вернуть сервер туда, где он сейчас (откат переноса): распределён — приём в свой домен (с отпечатком, если он есть),
    // нет — исключение в свой домен
    moveBack(u, ctx) {
      const s = ctx.legacy.view(u);
      return s.allocated ? { parentId: s.domainId, params: s.fingerprint ? { fingerprint: s.fingerprint } : {} } : { parentId: null, params: { domainId: s.domainId } };
    },
    move(u, parentId, params, ctx) {
      const { camera } = assign(ctx.legacy.view(u), assignOf(u, parentId, params), ctx);
      return camera ? ctx.legacy.unitOf(camera) : u;
    },
  };

  /* ===== vms.folder/1 — папка ===== */

  // Папки ведёт администратор, и только при связи с центром домена
  function folderProblem(domainId, ctx) {
    if (!ctx.isAdmin()) return ctx.problem(403, "PERMISSION_DENIED", "Папки ведёт только администратор");
    return ctx.domainDown(domainId) ? ctx.problem(409, "SERVER_OFFLINE", "Нет связи с доменом") : null;
  }
  // Папка с подпапками (uid)
  function withSubfolders(f, ctx) {
    const all = new Set([f.uid]);
    for (let grew = true; grew; ) {
      grew = false;
      ctx.db.folders.forEach((x) => {
        if (x.parentId && all.has(x.parentId) && !all.has(x.id)) {
          all.add(x.id);
          grew = true;
        }
      });
    }
    return all;
  }
  // Кто в папках: устройства и объекты любых видов с Unit.folders
  const membersOf = (gone, ctx) => [...new Set([...gone].flatMap((id) => ctx.units.byFolder(id).map((x) => x.uid)))];
  // Папка — вместе с подпапками; сами объекты остаются в системе, из их папок удалённые уходят
  function folderRemove(u, params, ctx) {
    const gone = withSubfolders(u, ctx);
    const members = membersOf(gone, ctx);
    ctx.db.folders = ctx.db.folders.filter((x) => !gone.has(x.id));
    members.forEach((id) => {
      const x = ctx.units.get(id);
      if (!x || !x.folders) return;
      x.folders = x.folders.filter((f) => !gone.has(f));
      if (!x.folders.length) delete x.folders;
      ctx.units.reindex(id);
    });
    ctx.dropStreamGrants((g) => {
      g.folderIds = g.folderIds.filter((x) => !gone.has(x));
    });
    gone.forEach((id) => ctx.send("entity.deleted", { kind: "folder", entityId: id }));
    return { record: false };
  }
  // Членство объекта в папках (Unit.folders): меняет только «Администратор» (как состав папки в базе), центр домена папки на
  // связи, запись в папки входит. Сервер-исполнитель объекта не участвует: папки ведёт центр домена
  function memberProblem(x, folderIds, ctx) {
    if (folderIds.length && !ctx.isAdmin()) return ctx.problem(403, "PERMISSION_DENIED", "Папки ведёт только администратор", { field: "folders" });
    if (folderIds.some((f) => ctx.domainDown((ctx.units.get(f) || {}).domainId))) return ctx.problem(409, "SERVER_OFFLINE", "Нет связи с доменом");
    if (ctx.legacy.isDevice(x) && !ctx.folderable(ctx.legacy.view(x))) return ctx.problem(422, "NOT_SUPPORTED", "Эта запись в папки не входит", { field: "folders" });
    return null;
  }

  const folder = {
    problem: folderProblem,
    memberProblem,
    withSubfolders,
    beforeCreate(u, parent, ctx) {
      if (!ctx.isAdmin()) return ctx.problem(403, "PERMISSION_DENIED", "Папки ведёт только администратор");
      if (!ctx.byId("domains", u.domainId)) return ctx.problem(404, "NOT_FOUND", "Домен не найден(а)");
      if (ctx.domainDown(u.domainId)) return ctx.problem(409, "SERVER_OFFLINE", "Нет связи с доменом");
      if (!trimmed(u.name)) return ctx.problem(422, "NAME_REQUIRED", "Укажите имя папки", { field: "name" });
      if (u.parentId) {
        const p = ctx.byId("folders", u.parentId);
        if (!p) return ctx.problem(404, "NOT_FOUND", "Папка не найден(а)");
        if (p.domainId !== u.domainId) return ctx.problem(422, "VALIDATION_FAILED", "Родительская папка — в другом домене", { field: "parentId" });
      }
      u.name = trimmed(u.name);
      return null;
    },
    beforeSet(u, patch, whole, ctx) {
      const bad = folderProblem(u.domainId, ctx);
      if (bad) return bad;
      if (patch.name === undefined) return null;
      if (!trimmed(patch.name)) return ctx.problem(422, "NAME_REQUIRED", "Укажите имя папки", { field: "name" });
      patch.name = trimmed(patch.name);
      return null;
    },
    dependents(u, ctx) {
      const gone = withSubfolders(u, ctx);
      return { remove: [...gone], detach: membersOf(gone, ctx) };
    },
    beforeDelete(u, params, ctx) {
      const bad = folderProblem(u.domainId, ctx);
      if (bad) return bad;
      const d = folder.dependents(u, ctx);
      return ctx.lockedProblem(d.remove.concat(d.detach), ctx.held);
    },
    remove: folderRemove,
  };

  /* ===== vms.archive/1 — хранилище ===== */

  // Вид хранилища (reference.archiveKinds): адрес, режимы, шифрование. Код — без «archive.»
  const archSpec = (kind, ctx) => ctx.specOf({ kind: String(kind).replace(/^archive\./, "") });
  // Режим, приём записей и шифрование — как у вида; необязательное шифрование — если система его умеет
  function archiveSetProblem(kind, set, ctx) {
    const spec = archSpec(kind, ctx);
    if (set.recordMode != null && !spec.archiveModes.includes(set.recordMode)) return ctx.problem(422, "NOT_SUPPORTED", `У вида ${String(kind).replace(/^archive\./, "")} такого режима нет`, { field: "recordMode" });
    if (set.admits === true && !spec.admits) return ctx.problem(422, "VALIDATION_FAILED", "Этот вид записи не принимает", { field: "admits" });
    if (set.encrypted === true && !spec.encryption) return ctx.problem(422, "NOT_SUPPORTED", "У этого вида нет шифрования", { field: "encrypted" });
    return null;
  }
  // Новое хранилище: архив на весь сервер — один на сервер; поля — как у вида (бакет — всегда объектное, шифруются
  // только объектное и бакет, провайдер — только у бакета, приём записей — если вид его знает)
  function archiveCreate(u, parent, ctx) {
    const spec = archSpec(u.kind, ctx);
    const p = props(u);
    if (!trimmed(u.name)) return ctx.problem(422, "NAME_REQUIRED", "Укажите имя хранилища", { field: "name" });
    const serverId = parent && !parent.fresh ? parent.uid : null;
    if (spec.serverWide && ctx.db.archives.some((x) => `archive.${x.kind}` === u.kind && x.serverId === serverId)) return ctx.problem(422, "VALIDATION_FAILED", "На сервере уже есть такой архив: он один на сервер", { field: "serverId" });
    const bad = ctx.featureProblem("archive", p) || (p.recordMode != null || p.admits != null || p.encrypted ? archiveSetProblem(u.kind, Object.assign({}, p.recordMode != null ? { recordMode: p.recordMode } : {}, p.admits != null ? { admits: p.admits } : {}, p.encrypted ? { encrypted: true } : {}), ctx) : null);
    if (bad) return bad;
    const bucket = spec.address === "bucket";
    u.name = trimmed(u.name);
    p.storage = bucket ? "object" : p.storage;
    p.encrypted = !!p.encrypted && spec.encryption && (bucket || p.storage === "object");
    p.provider = bucket ? (p.provider === undefined ? null : p.provider) : null;
    p.admits = spec.admits && p.admits !== false;
    if (!(spec.archiveModes.length && p.recordMode)) delete p.recordMode;
    return null;
  }
  // В хранилище уже пишут камеры: основным или дополнительным
  const writes = (d, id) => d.archiveId === id || (d.extraArchives || []).some((x) => x.archiveId === id);
  // Хранилище — с томами. Камеры остаются: основным становится первое дополнительное хранилище, без него
  // запись выключается
  function archiveRemove(u, params, ctx) {
    const db = ctx.db;
    const a = ctx.legacy.view(u);
    db.devices.forEach((d) => {
      const extra = (d.extraArchives || []).filter((x) => x.archiveId !== a.id);
      const main = d.archiveId === a.id;
      if (!main && extra.length === (d.extraArchives || []).length) return;
      if (d.extraArchives) d.extraArchives = extra;
      if (main) {
        // Резерв на сбой основным не становится
        const i = extra.findIndex((x) => x.recordMode !== "backup");
        const next = i >= 0 ? extra.splice(i, 1)[0] : null;
        if (next) Object.assign(d, { archiveId: next.archiveId, recordMode: next.recordMode, stream: next.stream });
        else Object.assign(d, { archiveId: null, recordMode: "none" });
        ["replicaFrom", "replicaLagSec", "retentionDays", "minDepthDays"].forEach((k) => {
          if (next && k in next) d[k] = next[k];
          else delete d[k];
        });
      }
      ctx.bump(d);
      ctx.changed("device", d);
    });
    db.volumes.filter((v) => v.archiveId === a.id).forEach((v) => volumeRemove(ctx.legacy.unitOf(v), {}, ctx));
    db.archives = db.archives.filter((x) => x !== a);
    // Вид — самого хранилища (archive.local, archive.network…), как у остальных событий ядра: объект уже снят со склада
    ctx.send("entity.deleted", { kind: ctx.evKind("archive", u), entityId: a.id });
    if (archSpec(u.kind, ctx).serverWide) ctx.serverWideChanged(a);
    // Минуты из обхода сохранять больше некуда: обход остаётся и только ищет
    db.archiveWatches.filter((w) => w.archiveId === a.id).forEach((w) => {
      Object.assign(w, { archiveId: null, keep: "none" });
      ctx.bump(w);
      ctx.send("entity.changed", { kind: "archiveWatch", entityId: w.id, version: w.version });
    });
    return { record: true };
  }
  // Проверка подключения: встроенный сервер не ходит в сеть — подключение «удаётся», если заполнено то, без чего не подключиться
  function archiveCheck(kind, v, ctx) {
    const spec = ctx.kindSpec(String(kind).replace(/^archive\./, ""));
    if (!spec || !spec.check) return ctx.problem(422, "NOT_SUPPORTED", `У вида ${kind} нет проверки подключения`, { field: "kind" });
    v = v || {};
    const missing = spec.address === "nas" ? !trimmed(v.disk) || !trimmed(v.login) : spec.address === "bucket" ? !trimmed(v.bucket) : false;
    return { result: { ok: !missing, code: missing ? "CONNECTION_FAILED" : null } };
  }

  const archive = {
    spec: archSpec,
    setProblem: archiveSetProblem,
    check: archiveCheck,
    writes,
    beforeCreate: archiveCreate,
    beforeSet(u, patch, whole, ctx) {
      const set = flat(patch);
      return archiveSetProblem(u.kind, set, ctx) || ctx.featureProblem("archive", set);
    },
    // Режим архива на весь сервер виден у всех камер сервера: создание, смена режима — их запись изменилась
    afterSet(u, before, ctx) {
      if (before && !("recordMode" in ((before.properties) || {}))) return;
      if (!before && !archSpec(u.kind, ctx).serverWide) return;
      ctx.serverWideChanged(ctx.legacy.view(u));
    },
    executor: (u) => (u.parentId || null),
    dependents(u, ctx) {
      return { remove: [u.uid].concat(ctx.db.volumes.filter((v) => v.archiveId === u.uid).map((v) => v.id)), detach: ctx.db.devices.filter((d) => writes(d, u.uid)).map((d) => d.id) };
    },
    beforeDelete(u, params, ctx) {
      const d = archive.dependents(u, ctx);
      return ctx.lockedProblem(d.remove.concat(d.detach), ctx.held);
    },
    remove: archiveRemove,
    actions: {
      check: (u, params, ctx) => archiveCheck(u.kind, params.volume, ctx),
    },
  };

  /* ===== vms.volume/1 — том ===== */

  // Том годится для хранилища: у локального — диск его сервера, не занятый разделом и не повторяющийся
  // в этом хранилище; у облачного — бакет. a — хранилище: {uid, kind, parentId} (uid null — создаётся той же строкой)
  // rows — тома той же строки нового хранилища, уже проверенные (UnitCreate.children): их ещё нет в таблице
  function volumeProblem(a, v, ctx, rows) {
    const db = ctx.db;
    v = v || {};
    if (!trimmed(v.disk)) return ctx.problem(422, "VALIDATION_FAILED", "Укажите диск или путь", { field: "disk" });
    const address = archSpec(a.kind, ctx).address;
    if (address === "bucket" && !trimmed(v.bucket)) return ctx.problem(422, "VALIDATION_FAILED", "Укажите бакет", { field: "bucket" });
    if (address !== "disk") return null;
    const s = ctx.byId("servers", a.parentId);
    if (!s || !(s.disks || []).some((d) => d.disk === v.disk)) return ctx.problem(422, "VALIDATION_FAILED", `На сервере нет диска ${v.disk}`, { field: "disk" });
    const onDisk = db.volumes.filter((x) => x.disk === v.disk && db.archives.some((y) => y.id === x.archiveId && ctx.specOf(y).address === "disk" && y.serverId === a.parentId));
    if (onDisk.some((x) => x.archiveId === a.uid || x.mode === "part") || (v.mode === "part" && onDisk.length)) return ctx.problem(409, "DISK_TAKEN", `Диск ${v.disk} занят`, { field: "disk" });
    if ((rows || []).some((x) => (x.properties || {}).disk === v.disk)) return ctx.problem(409, "DISK_TAKEN", `Диск ${v.disk} занят другим томом этого хранилища`, { field: "disk" });
    return null;
  }
  // Меньшая квота стирает старое: применяется, только если подтверждение называет то же число
  function volumePatchProblem(rec, patch, ctx) {
    if ("confirmShrinkBytes" in patch && patch.confirmShrinkBytes !== patch.sizeBytes) return ctx.problem(422, "VALIDATION_FAILED", "Подтверждение не совпадает с новым объёмом", { field: "confirmShrinkBytes" });
    if (patch.sizeBytes != null && patch.sizeBytes < rec.sizeBytes && patch.confirmShrinkBytes !== patch.sizeBytes) return ctx.problem(422, "VALIDATION_FAILED", "Уменьшение стирает старые записи: нужно подтверждение", { field: "sizeBytes" });
    return null;
  }
  // Что правка тома меняет сверх себя: включение меняет состояние, подтверждённое уменьшение снимает ожидание.
  // rec — запись тома (до правки или после: ни state, ни shrinkPendingBytes правка сама не трогает)
  function volumeDerived(rec, set) {
    const out = {};
    if ("enabled" in set && (rec.state === "ready" || rec.state === "off")) out.state = set.enabled === false ? "off" : "ready";
    if (rec.shrinkPendingBytes != null && set.sizeBytes != null && set.sizeBytes <= rec.shrinkPendingBytes) out.shrinkPendingBytes = null;
    return out;
  }
  // Изменение тома старого пути → поля записи: подтверждение не хранится
  function volumeSet(rec, set) {
    const out = Object.assign({}, set, volumeDerived(rec, set));
    delete out.confirmShrinkBytes;
    return out;
  }
  function volumeRemove(u, params, ctx) {
    const v = ctx.legacy.view(u);
    ctx.db.volumes = ctx.db.volumes.filter((x) => x !== v);
    ctx.formatting.delete(v.id);
    ctx.send("entity.deleted", { kind: "volume", entityId: v.id });
    return { record: true };
  }
  // Форматирование: сразу «Форматируется», «Готов» и 0% — по часам сервера (ctx.formatting, FORMAT_MS). Записи стёрты:
  // назад не возвращается. Том на это время не занят (free), как в базе: правится и удаляется; занят только для нового format
  function volumeFormat(u, ctx) {
    const v = ctx.legacy.view(u);
    if (v.state === "format") return ctx.problem(409, "BUSY", "Том уже форматируется");
    // Занятость — кроме своей операции: шаг format групповой операции сам держит том (ctx.held видит это)
    const locked = ctx.lockedProblem([v.id], ctx.held);
    if (locked) return locked;
    v.state = "format";
    ctx.bump(v);
    const until = ctx.now() + ctx.FORMAT_MS;
    ctx.formatting.set(v.id, until);
    ctx.changed("volume", v);
    return { operation: { until, free: true } };
  }
  // Адрес и объём тома откат не возвращает: записи на нём уже стёрты или лежат по новому адресу
  const VOLUME_FIXED = ["sizeBytes", "disk", "mode", "dir", "file", "bucket", "region", "path", "host", "port", "proto", "endpoint", "style", "account"];

  const volume = {
    problem: volumeProblem,
    patchProblem: volumePatchProblem,
    set: volumeSet,
    fixed: VOLUME_FIXED,
    format: volumeFormat,
    // Держатель тома: сервер хранилища на связи. Хранилище на весь домен — первый живой сервер; stand.noHolder — нет
    holder(v, ctx) {
      const a = ctx.byId("archives", v.archiveId), srv = a && a.serverId ? ctx.byId("servers", a.serverId) : ctx.db.servers.find((s) => s.allocated && s.online);
      return !ctx.db.stand.noHolder && srv && srv.online !== false ? srv.name : null;
    },
    view(out, ctx) {
      const held = volume.holder({ archiveId: out.parentId }, ctx);
      out.status = Object.assign({}, out.status);
      out.status.observed = Object.assign({}, out.status.observed, { heldBy: held });
      return out;
    },
    // Раздел целиком подключают неотформатированным: форматируют отдельно, когда решат
    beforeCreate(u, parent, ctx) {
      const a = parent ? { uid: parent.fresh ? null : parent.uid, kind: parent.kind, parentId: parent.parentId || null } : null;
      if (!a) return ctx.problem(404, "NOT_FOUND", "Хранилище не найден(а)");
      const bad = volumeProblem(a, props(u), ctx, parent && parent.fresh ? (parent.rows || []).filter((x) => x.kind === u.kind) : []);
      if (bad) return bad;
      if (u.name === undefined) u.name = props(u).disk;
      props(u).state = archSpec(a.kind, ctx).address === "disk" && props(u).mode === "part" ? "unfmt" : "ready";
      observedOf(u).usedPercent = 0;
      statusOf(u).link = "online";
      return null;
    },
    beforeSet: (u, patch, whole, ctx) => volumePatchProblem(ctx.legacy.view(u), flat(patch), ctx),
    afterSet(u, before, ctx) {
      if (!before || !before.properties) return;
      const rec = ctx.legacy.view(u);
      const set = Object.fromEntries(Object.keys(before.properties).map((k) => [k, rec[k]]));
      Object.entries(volumeDerived(rec, set)).forEach(([k, v]) => {
        if (v === null) delete rec[k];
        else rec[k] = v;
      });
    },
    executor(u, ctx) {
      const a = ctx.units.get(u.parentId);
      return (a && a.parentId) || null;
    },
    beforeDelete: () => null,
    remove: volumeRemove,
    actions: {
      format: (u, params, ctx) => volumeFormat(u, ctx),
    },
  };

  /* ===== Устройства — общее у всех видов таблицы devices (DEVICE): и у видов с профилем, и без него (ipsrv, eventsrc, mic…) =====
     Сервер зовёт DEVICE первым из хуков вида устройства, затем хуки его профилей (vms.camera/1, vms.stream/1, vms.detector/1,
     vms.acs/1…). rec — запись устройства старых путей: представление объекта склада (ctx.legacy.view), её поля — properties
     и status.observed объекта. Проверки старых путей работают с ней и на путях ядра. Где вид заводит оператор и под чем он
     бывает — только из описания вида (createParents, parents), а не из таблиц в коде */

  // Что за вид — из его описания, а не из справочника. Находит сервер: вид без create или бывает там, где его заводит не
  // оператор (parents ⊄ createParents: реле регистратора). Единица СКУД: заводят только под объектом СКУД (createParents без
  // корня, среди них вид с vms.acs/1) — входы, замки, ограждения, реле замка
  const found = (type, ctx) => {
    const k = ctx.kinds.get(type);
    return !!k && (!(k.capabilities || []).includes("create") || (k.parents || []).some((p) => !(k.createParents || []).includes(p)));
  };
  const unitType = (type, ctx) => {
    const cp = (ctx.kinds.get(type) || {}).createParents || [];
    return cp.length > 0 && !cp.includes(null) && cp.some((p) => acsKind(p, ctx));
  };
  const recOf = (u, ctx) => ctx.legacy.view(u);
  const parentRec = (d, ctx) => (d.parentId ? ctx.byId("devices", d.parentId) : null);
  const acsKind = (kind, ctx) => !!kind && ctx.kinds.profileOf(kind, "vms.acs/1");
  // Строка создания ядра (черновик объекта) → поля записи старого пути: вид, имя, свойства. Секретов в черновике нет
  const specOf = (u) => Object.assign({ type: u.kind }, u.name !== undefined ? { name: u.name } : {}, u.properties || {});
  // То, что строка UnitCreate несёт сверх черновика: x-transient-свойства (configMode, templateId) и candidateId
  const rowOf = (u) => u.spec || {};
  const rowProps = (u) => rowOf(u).properties || {};
  const stripUndefined = (o) => {
    Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]);
    return o;
  };

  // Единица СКУД: вид-единица (unitType), найденный сервером, — только под объектом СКУД (vms.acs/1): реле замка
  function isUnit(d, ctx) {
    if (!unitType(d.type, ctx)) return false;
    if (!found(d.type, ctx)) return true;
    const p = parentRec(d, ctx);
    return !!p && acsKind(p.type, ctx);
  }
  // В папках лежат камеры, регистраторы с записью, источники событий, СКУД; входы, выходы и единицы — нет
  const folderable = (d, ctx) => !found(d.type, ctx) && !unitType(d.type, ctx) && !d.derived && !(d.type === "acfa" && d.parentId);
  // Сервер устройства: свой (камера, регистратор, детектор, служба) или ближайшего родителя
  function serverOf(dev, ctx) {
    for (let d = dev; d; d = parentRec(d, ctx)) if (d.serverId) return ctx.byId("servers", d.serverId);
    return null;
  }
  const offline = (s) => !!s && s.online === false && s.allocated;
  // Камера w2c молчит сама: своего сервера у неё нет. Устройство сервера молчит с ним
  function silentProblem(rec, ctx) {
    if (rec.direct === false && rec.online === false) return ctx.problem(409, "DEVICE_OFFLINE", "Камера не отвечает");
    return offline(serverOf(rec, ctx)) ? ctx.problem(409, "SERVER_OFFLINE", "Сервер не отвечает") : null;
  }
  // У контроллера (acfa с родителем) своего подключения нет
  const OWN_LINK = ["ip", "port", "vendor"];
  // Что можно менять у записи сверх схемы вида: Unit.writable объекта (writableFields записи); у выведенного ipsrv — ничего.
  // Что не правится у вида целиком, судит схема вида (readOnly). Отказ — по первому полю вне списка
  function fieldProblem(rec, patch, ctx) {
    if (rec.type === "acfa" && rec.parentId) {
      const link = OWN_LINK.find((k) => k in patch);
      if (link) return ctx.problem(422, "NOT_SUPPORTED", "У контроллера нет своего подключения", { field: link });
    }
    // Что правится — Unit.writable записи (в старой записи writableFields); нет списка — решает описание вида.
    // Адрес path — только у единицы СКУД: у реле и объектов СКУД вне системы СКУД его нет
    const w = rec.derived ? [] : rec.writableFields;
    const keys = Object.keys(patch).filter((k) => k !== "confirmShrinkBytes");
    const pathKind = rec.type === "relay" || acsKind(rec.type, ctx);
    const field = keys.find((k) => (w && !w.includes(k)) || (k === "path" && pathKind && !isUnit(rec, ctx)));
    if (!field) return null;
    return ctx.problem(422, "NOT_SUPPORTED", w && !w.length ? "У этой записи нет правок" : `Поле ${field} у этого вида не правится`, { field });
  }
  // Касса подключается к адресу сервера или к имени кассы: «все адреса» склеили бы источники
  const wildIp = (ip) => ip === "0.0.0.0" || ip === "::";
  const posProblem = (type, patch, ctx) => (type === "eventsrc" && wildIp(patch.ip) ? ctx.problem(422, "VALIDATION_FAILED", "Нужен адрес сервера или имя кассы", { field: "ip" }) : null);
  // Ссылки ведут в существующие записи, имя не пустое
  function refsProblem(patch, ctx) {
    if ("name" in patch && !trimmed(patch.name)) return ctx.problem(422, "NAME_REQUIRED", "Имя не может быть пустым", { field: "name" });
    const refs = { serverId: "servers", archiveId: "archives", cameraId: "devices" };
    for (const [field, table] of Object.entries(refs)) {
      if (patch[field] != null && !ctx.byId(table, patch[field])) return ctx.problem(422, "VALIDATION_FAILED", `Нет записи ${patch[field]}`, { field });
    }
    for (const x of patch.extraArchives || []) {
      if (!ctx.byId("archives", x.archiveId)) return ctx.problem(422, "VALIDATION_FAILED", `Нет хранилища ${x.archiveId}`, { field: "extraArchives" });
    }
    return null;
  }
  const deleteProblem = (d, ctx) => (d.derived || (found(d.type, ctx) && !isUnit(d, ctx)) ? ctx.problem(422, "NOT_SUPPORTED", "Запись не удаляется: её ведёт сервер", { field: "type" }) : null);

  // Номер устройства (ID в системе) — у камер, регистраторов, источников событий и СКУД; без своего номера считается
  // короткое имя, если оно числом. Новому без номера номер выдаёт сервер — следующий после самого большого
  const NUMBERED = new Set(["camera", "ipsrv", "eventsrc", "acfa"]);
  const numberOf = (d) => (d.identifier != null && d.identifier !== "" ? String(d.identifier) : /^\d+$/.test(String(d.short || "")) ? String(d.short) : "");
  const nextIdentifier = (ctx) => String(Math.max(0, ...ctx.db.devices.filter((d) => NUMBERED.has(d.type)).map((d) => Number(numberOf(d)) || 0)) + 1);
  function identifierProblem(s, ctx) {
    if (!NUMBERED.has(s.type) || s.identifier == null || s.identifier === "") return null;
    return ctx.db.devices.some((d) => NUMBERED.has(d.type) && numberOf(d) === String(s.identifier)) ? ctx.problem(409, "IDENTIFIER_TAKEN", `Номер ${s.identifier} уже занят`, { field: "identifier" }) : null;
  }
  // Сервер источника: не задан — выбирает система; второй на тот же порт сервера не запустится
  function placeSource(d, ctx) {
    if (!d.serverId) {
      const s = ctx.db.servers.find((x) => x.domainId === d.domainId && x.allocated && x.online);
      if (s) d.serverId = s.id;
      d.faultText = "Сервер выбран системой, переноса при падении нет";
    }
    if (ctx.db.devices.some((x) => x !== d && x.type === "eventsrc" && x.serverId === d.serverId && x.port === d.port)) {
      d.online = false;
      d.fault = "conn";
      d.faultText = `Порт ${d.port} на этом сервере занят другим источником`;
    }
  }
  // Что пропадает с записью: дочерние. Камеры регистратора остаются — снимается только запись устройства
  function goneWith(rec, ctx) {
    const gone = ctx.withChildren(rec.id);
    if (rec.type !== "ipsrv") return gone;
    ctx.db.devices.filter((d) => d.parentId === rec.id && d.type === "camera").forEach((c) => ctx.withChildren(c.id).forEach((x) => gone.delete(x)));
    return gone;
  }
  // Что меняет удаление (занятость групповой операцией): запись с дочерними и камеры, что пишут по её детекторам
  function touched(rec, ctx) {
    const gone = ctx.withChildren(rec.id);
    return [...gone].concat(ctx.db.devices.filter((d) => (d.recordDetectorIds || []).some((x) => gone.has(x))).map((d) => d.id));
  }

  /* ----- Правка камеры за NAT ----- */

  // Камера за NAT применяет правку сама, с периодом отчёта: правка хранится, а ответ — 409 SERVER_OFFLINE с kept, срок вышел.
  // Настоящий бэкенд ждёт исход в пределах срока маршрута (V/11.4 Н1.13); здесь срок всегда выходит: так виден случай.
  // Отложенные правки — ctx.state.kept: id записи → {id, set, at, core}; применяет keptTick по часам сервера.
  // core — правка пришла путём ядра: событие о применении несёт вид объекта (camera), а не вид таблицы (device)
  const KEPT_MS = 60000;
  const keptOf = (ctx) => ctx.state.kept || (ctx.state.kept = new Map());
  function keptProblem(rec, set, ctx) {
    if (rec.direct !== false) return null;
    const was = keptOf(ctx).get(rec.id);
    if (was && JSON.stringify(was.set) !== JSON.stringify(set)) return ctx.problem(412, "VERSION_MISMATCH", "Прежняя правка камеры ещё не применилась", { current: clone(rec) });
    const edit = was || { id: ctx.uuid("operation"), set: clone(set), at: ctx.now() + KEPT_MS, core: !!ctx.core };
    keptOf(ctx).set(rec.id, edit);
    return ctx.problem(409, "SERVER_OFFLINE", "Правка принята и применится с периодом камеры", { params: { targetId: rec.id, kept: edit.id } });
  }
  function keptTick(ctx) {
    keptOf(ctx).forEach((e, id) => {
      if (e.at > ctx.now()) return;
      keptOf(ctx).delete(id);
      const rec = ctx.byId("devices", id);
      if (!rec) return;
      ctx.applyPatch(rec, e.set);
      // keptTick идёт по часам, вне запроса: вид события — по пути, которым пришла правка
      const u = e.core && ctx.units.get(id);
      ctx.changed(u ? u.kind : "device", rec);
    });
  }

  /* ----- Определить модель и реле ----- */

  // Модель «сообщает» устройство; у встроенного сервера — по сумме чисел адреса, как в макете. Драйверу нужен вход: стенд
  // с stand.probeNeedsLogin без логина модели не называет
  function probeModel(body, ctx) {
    const models = (ctx.db.reference.deviceModels.find((m) => m.vendor === body.vendor) || {}).models || [];
    if (!models.length || (ctx.db.stand.probeNeedsLogin && !(body.login && body.password))) return { model: null };
    const sum = String(body.ip).split(".").reduce((s, x) => s + (Number(x) || 0), 0);
    return { model: models[Math.abs(sum) % models.length] };
  }
  // Команда устройства: у реле — output с состоянием, у единицы СКУД — из её operations. Problem или {done}
  function deviceCommand(rec, operation, body, ctx) {
    if (rec.type === "relay") {
      if (rec.online === false) return ctx.problem(409, "DEVICE_OFFLINE", "Реле без связи");
      if (operation !== "output") return ctx.problem(409, "DEVICE_REFUSED", "Такой команды у реле нет", { params: { reason: "noOperation", operation } });
      if (!body || typeof body.state !== "boolean") return ctx.problem(422, "VALIDATION_FAILED", "Укажите состояние реле", { field: "state" });
      return { done: true };
    }
    if (!isUnit(rec, ctx)) return ctx.problem(422, "NOT_SUPPORTED", "Команды — только у единиц СКУД", { field: "type" });
    if (rec.online === false) return ctx.problem(409, "DEVICE_OFFLINE", "Единица без связи");
    if (!(rec.operations || []).includes(operation)) return ctx.problem(409, "DEVICE_REFUSED", "Такой команды у единицы нет", { params: { reason: "noOperation", operation } });
    return { done: true };
  }
  // Команда устройства путём ядра: итог — {result}
  const commandAction = (u, params, ctx, id) => {
    const r = deviceCommand(recOf(u, ctx), id, params, ctx);
    return isProblem(r) ? r : { result: r };
  };

  // Запись устройства в ответе старого пути: вычисляемое у детектора и камеры (cameraShow)
  function recordShow(out, rec, ctx) {
    // Детектор просит метку: нет сервера с ней — считать негде, причина словами
    const miss = rec.type === "det" && !rec.builtin ? (rec.labels || []).find((l) => !ctx.db.servers.some((s) => s.domainId === rec.domainId && (s.labels || []).includes(l))) : null;
    if (miss && !out.faultText) out.faultText = `Нет сервера с меткой ${miss}`;
    if (rec.type === "camera") cameraShow(out, rec, ctx, () => [...detKindsOf(rec.id, ctx)]);
    else {
      const edge = serverWideRows(rec, ctx);
      if (edge.length) out.extraArchives = (out.extraArchives || []).concat(edge);
    }
    return out;
  }

  const device = {
    // Помощники моста server.js: единица СКУД, запись в папки, связь, номер, что уходит с устройством, отложенные правки
    isUnit, folderable, offline, numberOf, goneWith, keptTick,
    // Единица СКУД (вид): создаётся только под объектом СКУД — GET /units/{uid}/creatable сверяет с шаблоном контроллера
    unitKind: unitType,
    // Объём карты камеры w2c (запись storage) откат не возвращает — как у тома: записи на карте уже легли
    fixed: ["sizeBytes"],
    view(out, ctx) {
      if (out.kind !== "det" || (out.status && out.status.observed && out.status.observed.faultText)) return out;
      const u = ctx.units.get(out.uid);
      const shown = u ? recordShow({}, recOf(u, ctx), ctx) : {};
      if (shown.faultText) out.status = Object.assign({}, out.status, { observed: Object.assign({}, (out.status || {}).observed, { faultText: shown.faultText }) });
      return out;
    },
    // Новое устройство путями ядра. Где его заводит оператор, судит ядро по createParents; здесь — система без вида, папки,
    // ссылки, адрес кассы, шаблон реле СКУД, занятый номер. Умолчания: номер, включено, на связи; MAC — только из поиска
    beforeCreate(u, parent, ctx) {
      const s = specOf(u), p = props(u);
      if (u.folders && u.folders.length && !folderable(Object.assign({ parentId: u.parentId || (parent ? "new" : null) }, s), ctx)) return ctx.problem(422, "NOT_SUPPORTED", "Эта запись в папки не входит", { field: "folders" });
      const par = parent && !parent.fresh ? recOf(parent, ctx) : parent && parent.fresh ? { type: parent.kind, fresh: true } : null;
      const bad = refsProblem(s, ctx) || posProblem(u.kind, s, ctx) || (u.kind === "relay" ? acsCreateProblem(s, par, ctx) : null) || identifierProblem(s, ctx);
      if (bad) return bad;
      if (["camera", "eventsrc", "acfa"].includes(u.kind) && !rowOf(u).candidateId) delete p.mac;
      if (!parent && NUMBERED.has(u.kind) && (p.identifier == null || p.identifier === "")) p.identifier = nextIdentifier(ctx);
      if (!("enabled" in p)) p.enabled = true;
      statusOf(u).link = "online";
      return null;
    },
    // Создан: источнику событий — сервер и порт; добавленное из найденного уходит из итога поиска
    afterSet(u, before, ctx) {
      if (before) return;
      const d = recOf(u, ctx);
      if (d.type === "eventsrc") placeSource(d, ctx);
      const cand = rowOf(u).candidateId;
      const job = cand ? ctx.db.discovery.find((y) => y.domainId === u.domainId) : null;
      if (job) job.candidateIds = job.candidateIds.filter((c) => c !== cand);
    },
    beforeSet(u, patch, whole, ctx) {
      const rec = recOf(u, ctx), set = flat(patch);
      return silentProblem(rec, ctx) || fieldProblem(rec, set, ctx) || posProblem(rec.type, set, ctx) || refsProblem(set, ctx) || (rec.type === "storage" ? cardProblem(rec, set, ctx) : null);
    },
    // Перед тем как правка применится (PATCH и шаг операции, не /units/validate): камера за NAT применяет её сама — правка
    // отложена, 409 SERVER_OFFLINE с kept; шаг операции не включает устройство с превышенной лицензией
    beforeApply(u, patch, step, ctx) {
      const rec = recOf(u, ctx), set = flat(patch);
      const held = keptProblem(rec, set, ctx);
      if (held) return held;
      return step && set.enabled === true && rec.licenseExceeded ? ctx.problem(409, "LICENSE_EXCEEDED", "Лицензия превышена: включить нельзя") : null;
    },
    executor(u, ctx) {
      const s = serverOf(recOf(u, ctx), ctx);
      return s && s.allocated ? s.id : null;
    },
    dependents(u, ctx) {
      const rec = recOf(u, ctx);
      const gone = goneWith(rec, ctx);
      return { remove: [...gone], detach: touched(rec, ctx).filter((id) => !gone.has(id)) };
    },
    beforeDelete(u, params, ctx) {
      const rec = recOf(u, ctx);
      return deleteProblem(rec, ctx) || ctx.lockedProblem(touched(rec, ctx), ctx.held);
    },
    // Вместе с дочерними (у регистратора камеры остаются), строками незнакомых видов под камерой (dependents камеры),
    // из папок, записи по детекторам, доступа учёток потоков. Назад не вернуть: в стопке — шаг NOT_SUPPORTED
    remove(u, params, ctx) {
      ctx.removeDevice(u.uid);
      return { record: true };
    },
    actions: {
      // Определить модель по адресу (бывший POST /devices/probe): у регистратора и камеры
      probe: (u, params, ctx) => ({ result: probeModel(params, ctx) }),
      // Реле: замкнуть, разомкнуть, импульс (бывший POST /devices/{id}/operations/output)
      output: commandAction,
    },
  };

  /* ===== vms.camera/1 — камера: запись, архив на весь сервер, replica, профиль при добавлении, назначение записи ===== */

  const RECORD_FIELDS = ["archiveId", "recordMode", "stream", "extraArchives", "replicaFrom", "recordScheduleId", "retentionDays", "minDepthDays", "audioDeviceId"];
  const SOURCE_GONE = "Источник снят: запись ждёт";
  const archiveWrites = (d, id) => d.archiveId === id || (d.extraArchives || []).some((x) => x.archiveId === id);
  // Выводное поле камеры «детекторы»: виды встроенных и серверных (cameraId) детекторов, без повторов
  function detKindsOf(camId, ctx) {
    const out = new Set();
    ctx.db.devices.forEach((d) => d.type === "det" && (d.parentId === camId || d.cameraId === camId) && d.detectorKind && out.add(d.detectorKind));
    return out;
  }
  // То же по складу: дети и ссылки камеры по индексам — для ответов ядра на любом размере домена
  function detKindsByStore(camId, ctx) {
    const out = new Set();
    ctx.units.byParent(camId).concat(ctx.units.byRef(camId)).forEach((x) => x.kind === "det" && x.properties && x.properties.detectorKind && out.add(x.properties.detectorKind));
    return [...out];
  }
  // replica: поля только у этого режима; источник сняли — запись ждёт, уже забранное живёт своим сроком
  function replicaView(out) {
    const has = (id) => out.archiveId === id || (out.extraArchives || []).some((x) => x.archiveId === id);
    if (out.recordMode !== "replica") {
      delete out.replicaFrom;
      delete out.replicaLagSec;
    } else if (out.replicaFrom && !has(out.replicaFrom)) Object.assign(out, { recordState: "waiting", recordReason: SOURCE_GONE });
    (out.extraArchives || []).forEach((x) => {
      if (x.recordMode !== "replica") {
        delete x.replicaFrom;
        delete x.replicaLagSec;
      } else if (x.replicaFrom && !has(x.replicaFrom)) Object.assign(x, { state: "waiting", reason: SOURCE_GONE });
    });
  }
  // Архив на весь сервер работает со всеми его камерами: привязывать не надо, строка только для чтения
  function serverWideRows(rec, ctx) {
    if (rec.type !== "camera") return [];
    const s = serverOf(rec, ctx);
    if (!s) return [];
    const main = (streamsOf(rec)[0] || {}).id;
    return ctx.db.archives.filter((a) => a.serverId === s.id && ctx.specOf(a).serverWide).map((a) => stripUndefined({ archiveId: a.id, recordMode: a.recordMode, stream: main, readOnly: true }));
  }
  // Строки на весь сервер видны у всех его камер: их изменение меняет запись камеры
  function serverWideChanged(a, ctx) {
    if (!a.serverId) return;
    ctx.db.devices.filter((d) => d.type === "camera" && (serverOf(d, ctx) || {}).id === a.serverId).forEach((d) => {
      ctx.bump(d);
      ctx.changed("device", d);
    });
  }
  // Вычисляемое в записи камеры: строки архива на весь сервер, виды детекторов, replica, ожидание расписания. out — копия
  function cameraShow(out, rec, ctx, detKinds) {
    const edge = serverWideRows(rec, ctx);
    if (edge.length) out.extraArchives = (out.extraArchives || []).concat(edge);
    out.detectorKinds = detKinds();
    replicaView(out);
    if ((out.recordMode === "sched" || (out.extraArchives || []).some((x) => x.recordMode === "sched")) && out.recordScheduleId && !ctx.byId("schedules", out.recordScheduleId)) Object.assign(out, { recordState: "waiting", recordReason: "Расписание снято: запись ждёт" });
    return out;
  }
  // Запись камеры и вид хранилища: камера привязывается только туда, где её режим допустим. Основной бывает только на виде
  // с режимом кроме backup. Новая привязка к архиву, который не принимает записи, — отказ
  function archiveRowProblem(x, main, was, ctx) {
    const a = ctx.byId("archives", x.archiveId);
    if (!a) return null;
    const spec = ctx.specOf(a);
    const field = main ? "archiveId" : "extraArchives";
    if (main && x.recordMode === "backup") return ctx.problem(422, "NOT_SUPPORTED", "Резерв на сбой — только дополнительная запись", { field: "recordMode" });
    if (main ? !spec.recordModes.some((m) => m !== "backup") : !spec.recordModes.length) return ctx.problem(422, "NOT_SUPPORTED", `На архив вида ${a.kind} камера не привязывается`, { field });
    if (x.recordMode && x.recordMode !== "none" && !spec.recordModes.includes(x.recordMode)) return ctx.problem(422, "NOT_SUPPORTED", `Режим ${x.recordMode} на архиве вида ${a.kind} недоступен`, { field: "recordMode" });
    if (a.admits === false && !was) return ctx.problem(422, "VALIDATION_FAILED", "Архив не принимает записи", { field });
    return null;
  }
  function recordingProblem(rec, patch, ctx) {
    // Карта камеры w2c (запись storage) — своя запись: режим карты и объём
    if (rec.type === "storage") return cardProblem(rec, patch, ctx);
    if (rec.type !== "camera" || !RECORD_FIELDS.some((k) => k in patch)) return null;
    const next = Object.assign({}, rec, patch);
    const main = next.archiveId ? archiveRowProblem({ archiveId: next.archiveId, recordMode: next.recordMode }, true, next.archiveId === rec.archiveId, ctx) : next.recordMode === "backup" ? ctx.problem(422, "NOT_SUPPORTED", "Резерв на сбой — только дополнительная запись", { field: "recordMode" }) : null;
    if (main) return main;
    for (const x of next.extraArchives || []) {
      const bad = archiveRowProblem(x, false, archiveWrites(rec, x.archiveId), ctx);
      if (bad) return bad;
    }
    const rows = (next.archiveId ? [{ archiveId: next.archiveId, recordMode: next.recordMode, stream: next.stream, replicaFrom: next.replicaFrom, retentionDays: next.retentionDays, minDepthDays: next.minDepthDays }] : []).concat(next.extraArchives || []);
    return replicaProblem(rec, rows, ctx) || scheduleProblem(rec, next, rows, ctx) || depthProblem(rows, ctx) || micProblem(rec, patch, ctx);
  }
  // Режим sched без своего расписания записывать нечем. Снятое позже — запись ждёт
  function scheduleProblem(rec, next, rows, ctx) {
    if (!rows.some((x) => x.recordMode === "sched")) return null;
    if (next.recordScheduleId && ctx.byId("schedules", next.recordScheduleId)) return null;
    if (next.recordScheduleId && next.recordScheduleId === rec.recordScheduleId) return null;
    return ctx.problem(422, "VALIDATION_FAILED", "Для записи по расписанию нужно расписание", { field: "recordScheduleId" });
  }
  function depthProblem(rows, ctx) {
    const days = (x) => (x.retentionDays != null ? x.retentionDays : (ctx.byId("archives", x.archiveId) || {}).retentionDays || 0);
    const bad = rows.some((x) => x.minDepthDays != null && days(x) > 0 && x.minDepthDays > days(x));
    return bad ? ctx.problem(422, "VALIDATION_FAILED", "Наименьшая глубина больше срока хранения", { field: "minDepthDays" }) : null;
  }
  function micProblem(rec, patch, ctx) {
    if (patch.audioDeviceId == null || !rec.id) return null;
    const m = ctx.byId("devices", patch.audioDeviceId);
    return m && m.type === "mic" && m.parentId === rec.id ? null : ctx.problem(422, "VALIDATION_FAILED", "Микрофон — запись mic этой камеры", { field: "audioDeviceId" });
  }
  // Карта камеры w2c (запись storage): режим самой карты и её объём — как у тома
  function cardProblem(rec, patch, ctx) {
    if ("recordMode" in patch && !["always", "backup"].includes(patch.recordMode)) return ctx.problem(422, "VALIDATION_FAILED", "У карты — постоянно или только при сбое", { field: "recordMode" });
    return volumePatchProblem(rec, patch, ctx);
  }
  // Встроенное хранилище — под самой камерой или под её регистратором
  const hasBuiltIn = (rec, ctx) => [rec.id, rec.parentId].filter(Boolean).some((id) => ctx.units.byParent(id).some((x) => x.kind === "storage"));
  const archiveRowOf = (rec, archiveId) => (rec.archiveId === archiveId ? rec : (rec.extraArchives || []).find((x) => x.archiveId === archiveId)) || null;
  function replicaProblem(rec, rows, ctx) {
    const bad = (text) => ctx.problem(422, "VALIDATION_FAILED", text, { field: "replicaFrom" });
    const main = (streamsOf(rec)[0] || {}).id;
    const sources = rows.concat(serverWideRows(rec, ctx));
    for (const x of rows) {
      if (x.recordMode !== "replica") continue;
      const from = x.replicaFrom == null ? null : x.replicaFrom;
      if (from === null) {
        // У новой камеры хранилище ещё не найдено: запись дождётся
        if (rec.id && !hasBuiltIn(rec, ctx)) return bad("У камеры нет встроенного хранилища: назовите другой архив");
        if (x.stream != null && main != null && x.stream !== main) return ctx.problem(422, "NOT_SUPPORTED", "Со встроенного хранилища забирается только основной поток", { field: "stream" });
        continue;
      }
      if (from === x.archiveId) return bad("Архив не забирает записи у самого себя");
      const src = sources.find((y) => y.archiveId === from);
      if (!src) {
        const was = archiveRowOf(rec, x.archiveId);
        if (was && was.replicaFrom === from) continue;
        return bad("Источник — другой архив этой камеры");
      }
      const a = ctx.byId("archives", from);
      if (!a || !ctx.specOf(a).replicaSource) return bad("Этот архив источником не бывает");
      if ((src.stream == null ? main : src.stream) !== (x.stream == null ? main : x.stream)) return ctx.problem(422, "VALIDATION_FAILED", "Забирать можно только поток источника", { field: "stream" });
    }
    const next = new Map(rows.filter((x) => x.recordMode === "replica" && x.replicaFrom).map((x) => [x.archiveId, x.replicaFrom]));
    for (const start of next.keys()) {
      const seen = new Set();
      for (let at = start; next.has(at); at = next.get(at)) {
        if (seen.has(at)) return bad("Архивы забирают записи друг у друга");
        seen.add(at);
      }
    }
    return null;
  }
  // Адрес камеры: свой rtspUrl или адрес драйвера по производителю и модели. Правка не оставляет камеру без адреса
  const hasAddress = (d) => !!d.rtspUrl || (!!d.vendor && !!d.model);
  const addressProblem = (rec, patch, ctx) => {
    if (rec.type !== "camera" || rec.parentId || !["rtspUrl", "vendor", "model"].some((k) => k in patch)) return null;
    return hasAddress(Object.assign({}, rec, patch)) ? null : ctx.problem(422, "VALIDATION_FAILED", "Нужен адрес камеры или производитель и модель", { field: "rtspUrl" });
  };
  // Профиль при добавлении — разовый выбор: default — умолчания модели (у встроенного сервера одни на всех), template — копия
  // с камеры той же модели; связи с источником после создания нет
  const MODEL_DEFAULT = { res: "1920x1080", fps: 25 };
  function profileProblem(spec, ctx) {
    if (spec.configMode === "default" && !(spec.vendor && spec.model)) return { code: "VALIDATION_FAILED", field: "configMode" };
    if (spec.configMode !== "template") return null;
    const src = spec.templateId ? ctx.byId("devices", spec.templateId) : null;
    return src && src.type === "camera" && src.vendor === spec.vendor && src.model === spec.model ? null : { code: "VALIDATION_FAILED", field: "templateId" };
  }
  function applyProfile(d, s, ctx) {
    if (s.configMode === "default") Object.assign(d, MODEL_DEFAULT);
    if (s.configMode !== "template") return;
    const src = ctx.byId("devices", s.templateId);
    ["res", "fps", "firmware"].forEach((k) => { if (k in src) d[k] = src[k]; });
    if (src.streams) d.streams = src.streams.map(({ id, name, res, fps, width, height }) => stripUndefined({ id, name, res, fps, width, height, online: true }));
  }
  // Основной поток новой камеры: из Device.res и Device.fps
  const mainStream = (d) => Object.assign({ id: "main", name: "Основной", online: true }, d.res ? { res: d.res, ...sizeOf(d.res) } : {}, d.fps ? { fps: d.fps } : {});
  // Назначение записи камеры w2c и камеры другого кластера: основной приёмник и копии-кластеры. Problem или null — назначено
  function setTarget(rec, body, ctx) {
    const locked = ctx.lockedProblem([rec.id]);
    if (locked) return locked;
    if (body.serverId === null) {
      if (body.copies.length) return ctx.problem(422, "VALIDATION_FAILED", "Назначение снято: копий быть не может", { field: "copies" });
      delete rec.recordingTarget;
      delete rec.serverId;
    } else {
      const s = ctx.byId("servers", body.serverId);
      if (!s || !s.allocated) return ctx.problem(422, "VALIDATION_FAILED", "Нет такого сервера", { field: "serverId" });
      const why = ctx.copiesProblem(s, body.copies);
      if (why) return ctx.problem(422, "VALIDATION_FAILED", why, { field: "copies" });
      if (offline(s)) return ctx.problem(409, "SERVER_OFFLINE", "Сервер не отвечает");
      rec.recordingTarget = { serverId: s.id, copies: clone(body.copies) };
      rec.serverId = s.id;
    }
    ctx.bump(rec);
    ctx.changed("device", rec);
    return null;
  }
  // Правка строк записи не стирает поля сервера (состояние, причина, отставание replica): они переходят из прежней строки
  // того же архива; строку только для чтения (архив на весь сервер) не хранят
  function keepRows(rec, patch) {
    if (!patch.extraArchives) return patch;
    const rows = patch.extraArchives.map((x) => {
      const was = (rec.extraArchives || []).find((y) => y.archiveId === x.archiveId);
      const row = Object.assign({}, x);
      ["state", "reason", "replicaLagSec", "readOnly"].forEach((k) => delete row[k]);
      if (was) ["state", "reason", "replicaLagSec"].forEach((k) => { if (k in was) row[k] = was[k]; });
      return row;
    });
    return Object.assign({}, patch, { extraArchives: rows });
  }
  // Строки незнакомых видов под камерой (w2c.example/rows и потомки): уходят вместе с ней
  function cameraRows(u, ctx) {
    const out = [];
    const walk = (id) => ctx.units.byParent(id).forEach((x) => {
      if (!ctx.legacy.isDevice(x) && x.kind !== "stream") out.push(x.uid);
      walk(x.uid);
    });
    walk(u.uid);
    return out;
  }

  const camera = {
    RECORD_FIELDS, SOURCE_GONE, recordingProblem, cardProblem, serverWideRows, serverWideChanged, replicaView, detKindsOf, hasBuiltIn,
    archiveRowOf, hasAddress, addressProblem, profileProblem, applyProfile, mainStream, setTarget, keepRows, writes: archiveWrites,
    // Ответ ядра: строки архива на весь сервер (readOnly) — в properties.extraArchives, состояние записи и виды детекторов —
    // в status.observed (recordState, recordReason, replicaLagSec, detectorKinds); у режима не replica источника в ответе нет
    view(out, ctx) {
      const u = ctx.units.get(out.uid);
      if (!u) return out;
      const obs = Object.assign({}, (out.status || {}).observed);
      const o = cameraShow(Object.assign({}, out.properties, obs), recOf(u, ctx), ctx, () => detKindsByStore(u.uid, ctx));
      ["extraArchives", "replicaFrom"].forEach((k) => {
        if (k in o) out.properties[k] = o[k];
        else delete out.properties[k];
      });
      ["replicaLagSec", "recordState", "recordReason", "detectorKinds"].forEach((k) => {
        if (k in o) obs[k] = o[k];
        else delete obs[k];
      });
      out.status = Object.assign({}, out.status, { observed: obs });
      return out;
    },
    // Камере без регистратора нужен адрес; запись — по правилам вида хранилища; профиль при добавлении (x-transient)
    beforeCreate(u, parent, ctx) {
      const s = specOf(u);
      if (!parent && !hasAddress(s)) return ctx.problem(422, "VALIDATION_FAILED", "Нужен адрес камеры или производитель и модель", { field: "rtspUrl" });
      const bad = recordingProblem({ type: "camera" }, s, ctx);
      if (bad) return bad;
      const prof = profileProblem(Object.assign({}, s, rowProps(u)), ctx);
      return prof ? ctx.problem(422, prof.code, "Профиль при добавлении не подходит", { field: prof.field }) : null;
    },
    // Создана: профиль при добавлении и основной поток (дочерний объект вида stream). Правка res, fps — это основной поток
    afterSet(u, before, ctx) {
      const d = recOf(u, ctx);
      if (before) {
        // Режим записи камеры решает mode встроенного хранилища: хранилище сообщает, что оно изменилось (vms.edge/1)
        const was = before.properties || {};
        // Пользователь сам поменял режим или архив: сервер забывает, что помнил
        if (["recordMode", "archiveId"].some((k) => k in was)) edgeMemo(ctx).delete(u.uid);
        if (["recordMode", "replicaFrom", "archiveId"].some((k) => k in was)) {
          const st = edgeStorageOf(u, ctx);
          if (st) edgeChanged(st, ctx);
        }
        return syncMain(d, was);
      }
      applyProfile(d, Object.assign({}, rowProps(u), { vendor: d.vendor, model: d.model }), ctx);
      if (!streamsOf(d).length) d.streams = [mainStream(d)];
    },
    // Адрес, разрешение и поток записи, запись по правилам вида хранилища. Шаг операции проверяет запись по всему плану
    // камеры (ctx.plan — правки этого и следующих шагов): режим и источник в разных шагах — одна запись
    beforeSet(u, patch, whole, ctx) {
      const rec = recOf(u, ctx), set = flat(patch);
      const bad = addressProblem(rec, set, ctx) || videoProblem(rec, set, ctx) || recordingProblem(rec, ctx.plan ? flat(ctx.plan) : set, ctx);
      // Правка приводится к виду записи (patch — копия зовущего): поля сервера в строках записи остаются
      if (!bad && patch.properties && patch.properties.extraArchives) patch.properties.extraArchives = keepRows(rec, { extraArchives: patch.properties.extraArchives }).extraArchives;
      return bad;
    },
    dependents: (u, ctx) => ({ remove: cameraRows(u, ctx), detach: [] }),
  };

  /* ===== vms.stream/1 — поток камеры: дочерний объект вида stream; основной поток — Device.res и Device.fps ===== */

  const RES = /^(\d+)x(\d+)$/;
  const sizeOf = (res) => {
    const m = RES.exec(res || "");
    return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
  };
  const streamsOf = (rec) => rec.streams || [];
  // Разрешение — из вариантов устройства, если устройство их назвало
  const resProblem = (options, res, ctx) => (res != null && options && !options.includes(res) ? ctx.problem(422, "VALIDATION_FAILED", `Разрешение ${res} камера не поддерживает`, { field: "res" }) : null);
  // Поток записи — один из потоков камеры
  function streamRefProblem(rec, patch, ctx) {
    if (!rec.streams) return null;
    const known = (id) => id == null || rec.streams.some((s) => s.id === id);
    if ("stream" in patch && !known(patch.stream)) return ctx.problem(422, "VALIDATION_FAILED", `Нет потока ${patch.stream}`, { field: "stream" });
    return (patch.extraArchives || []).some((x) => !known(x.stream)) ? ctx.problem(422, "VALIDATION_FAILED", "Нет такого потока", { field: "extraArchives" }) : null;
  }
  const videoProblem = (rec, patch, ctx) => resProblem(rec.resOptions, patch.res, ctx) || streamRefProblem(rec, patch, ctx);
  // Device.res, Device.fps — это основной поток
  function syncMain(rec, patch) {
    const main = streamsOf(rec)[0];
    if (!main || !("res" in patch || "fps" in patch)) return;
    ["res", "fps"].forEach((k) => { if (k in rec) main[k] = rec[k]; else delete main[k]; });
    Object.assign(main, sizeOf(main.res));
  }
  // Поток используется записью камеры или её детектором
  const streamUsed = (rec, id, ctx) => rec.stream === id || (rec.extraArchives || []).some((x) => x.stream === id) || ctx.db.devices.some((d) => d.parentId === rec.id && d.stream === id);
  const nextStreamId = (rec) => {
    let n = 1;
    while (streamsOf(rec).some((s) => s.id === `s${n}`)) n++;
    return `s${n}`;
  };
  // Новый поток, правка, снятие: Problem или новый состав потоков (старые пути /devices/{id}/streams; применяет сервер)
  function streamAdd(rec, body, ctx) {
    if (!trimmed(body.name)) return ctx.problem(422, "NAME_REQUIRED", "Укажите имя потока", { field: "name" });
    const locked = ctx.lockedProblem([rec.id]);
    if (locked) return locked;
    return streamsOf(rec).concat(Object.assign({ id: nextStreamId(rec), online: true }, clone(body), { name: body.name.trim() }, sizeOf(body.res)));
  }
  function streamEdit(rec, st, body, ctx) {
    if ("name" in body && !trimmed(body.name)) return ctx.problem(422, "NAME_REQUIRED", "Укажите имя потока", { field: "name" });
    const bad = resProblem(st.resOptions, body.res, ctx) || ctx.lockedProblem([rec.id]);
    if (bad) return bad;
    return streamsOf(rec).map((s) => (s === st ? Object.assign(clone(s), clone(body), sizeOf(body.res)) : clone(s)));
  }
  function streamDropProblem(rec, streamId, ctx) {
    const i = streamsOf(rec).findIndex((s) => s.id === streamId);
    if (i === 0) return ctx.problem(422, "NOT_SUPPORTED", "Основной поток не удаляется", { field: "streamId" });
    if (streamUsed(rec, streamId, ctx)) return ctx.problem(422, "VALIDATION_FAILED", "Поток используется записью или детектором", { field: "stream" });
    return ctx.lockedProblem([rec.id]);
  }
  // uid потока: uid камеры с номером потока во второй группе (30000013-0001-…)
  const streamUid = (cam, n) => `${cam.slice(0, 9)}${String(n).padStart(4, "0")}${cam.slice(13)}`;
  const streamNo = (uid) => parseInt(uid.slice(9, 13), 10) || 0;
  const camOfStream = (u, ctx) => (u.parentId ? ctx.byId("devices", u.parentId) : null);

  const stream = {
    sizeOf, streamsOf, resProblem, streamRefProblem, videoProblem, syncMain, add: streamAdd, edit: streamEdit, dropProblem: streamDropProblem,
    // uid нового потока — по камере, следующий номер
    newUid(u, parent, ctx) {
      const n = ctx.units.byParent(parent.uid).filter((x) => x.kind === "stream").reduce((m, x) => Math.max(m, streamNo(x.uid)), 0);
      return streamUid(parent.uid, n + 1);
    },
    // Поток путём ядра: имя обязательно, код потока (streamId) и размер кадра выдаёт сервер; над камерой не идёт операция
    beforeCreate(u, parent, ctx) {
      if (!trimmed(u.name)) return ctx.problem(422, "NAME_REQUIRED", "Укажите имя потока", { field: "name" });
      const cam = parent && !parent.fresh ? recOf(parent, ctx) : null;
      const locked = cam ? ctx.lockedProblem([cam.id]) : null;
      if (locked) return locked;
      u.name = trimmed(u.name);
      Object.assign(props(u), { streamId: cam ? nextStreamId(cam) : `s${Date.now() % 1000}` }, sizeOf(props(u).res));
      statusOf(u).link = "online";
      return null;
    },
    beforeSet(u, patch, whole, ctx) {
      const cam = camOfStream(u, ctx);
      const p = (patch && patch.properties) || {};
      return resProblem(props(u).resOptions, p.res, ctx) || (cam ? ctx.lockedProblem([cam.id]) : null);
    },
    // Размер кадра — по разрешению; основной поток — это Device.res и Device.fps камеры
    afterSet(u, before, ctx) {
      if (!before || !before.properties) return;
      const p = props(u);
      if ("res" in before.properties) {
        delete p.width;
        delete p.height;
        Object.assign(p, sizeOf(p.res));
      }
      const cam = camOfStream(u, ctx);
      const main = cam && streamsOf(cam)[0];
      if (!main || main.id !== p.streamId || !("res" in before.properties || "fps" in before.properties)) return;
      ["res", "fps"].forEach((k) => {
        if (k in p) cam[k] = p[k];
        else delete cam[k];
      });
      ctx.bump(cam);
      ctx.changed("device", cam);
    },
    beforeDelete(u, params, ctx) {
      const cam = camOfStream(u, ctx);
      return cam ? streamDropProblem(cam, props(u).streamId, ctx) : null;
    },
  };

  /* ===== vms.detector/1 — детектор: шаблон камеры, зона, чувствительность, несовместимые на одном канале ===== */

  const detOption = (d, cam, ctx) => ((cam || parentRec(d, ctx) || {}).detectorOptions || []).find((o) => o.template === d.template) || null;
  function zoneProblem(z, ctx) {
    if (!z) return null;
    const n = z.points.length;
    const fits = (z.shape === "polygon" ? n >= 3 : n === 2) && z.points.every((p) => p.length === 2 && p.every((v) => v >= 0 && v <= 1));
    return fits ? null : ctx.problem(422, "VALIDATION_FAILED", "Зона: rect и line — две точки, polygon — от трёх, доли от 0 до 1", { field: "zone" });
  }
  // Чувствительность — своя у детектора; настройки нет — и поля нет
  function sensProblem(d, value, cam, ctx) {
    const o = detOption(d, cam, ctx);
    if (value == null || !o) return null;
    if (o.sensitivityMin == null) return ctx.problem(422, "NOT_SUPPORTED", "У детектора нет чувствительности", { field: "sensitivity" });
    return value < o.sensitivityMin || value > o.sensitivityMax ? ctx.problem(422, "VALIDATION_FAILED", `Чувствительность от ${o.sensitivityMin} до ${o.sensitivityMax}`, { field: "sensitivity" }) : null;
  }
  // Включённый детектор, с которым этот на одном канале вместе не работает
  function conflictWith(d, cam, ctx) {
    const own = detOption(d, cam, ctx);
    if (!own) return null;
    return ctx.db.devices.find((x) => {
      if (x.parentId !== (cam ? cam.id : d.parentId) || x.id === d.id || x.type !== "det" || x.enabled === false) return false;
      const o = detOption(x, cam, ctx);
      return !!o && ((own.conflicts || []).includes(o.template) || (o.conflicts || []).includes(own.template));
    }) || null;
  }
  const conflictParams = (x) => ({ reason: "incompatible", with: x.id });
  const detProblem = (rec, patch, ctx) => (rec.type === "det" ? zoneProblem(patch.zone, ctx) || sensProblem(rec, patch.sensitivity, null, ctx) : null);
  // Включение несовместимого: в запросе — 409, в групповой операции — fail шага
  function clashProblem(rec, patch, ctx) {
    const x = rec.type === "det" && patch.enabled === true && rec.enabled === false ? conflictWith(rec, null, ctx) : null;
    return x ? ctx.problem(409, "BUSY", "Детектор несовместим с включённым на этом канале", { field: "enabled", params: conflictParams(x) }) : null;
  }
  // Новый детектор: шаблон из того, что умеет камера. cam — запись родителя, если она уже есть. {code, field} или null
  function detCreateProblem(spec, cam, ctx) {
    if (spec.type !== "det") return null;
    if (zoneProblem(spec.zone, ctx)) return { code: "VALIDATION_FAILED", field: "zone" };
    if (!spec.builtin || !cam) return null;
    if (!cam.detectorOptions) return { code: "NOT_SUPPORTED", field: "builtin" };
    if (!detOption(spec, cam, ctx)) return { code: "VALIDATION_FAILED", field: "template" };
    const s = sensProblem(spec, spec.sensitivity, cam, ctx);
    if (s) return { code: s.body.code, field: "sensitivity" };
    if (spec.enabled !== false && conflictWith(spec, cam, ctx)) return { code: "BUSY", field: "enabled" };
    return null;
  }

  const detector = {
    detOption, zoneProblem, sensProblem, conflictWith, conflictParams, detProblem, clashProblem, createProblem: detCreateProblem,
    beforeCreate(u, parent, ctx) {
      const s = specOf(u);
      const bad = detCreateProblem(s, parent && !parent.fresh ? recOf(parent, ctx) : null, ctx);
      if (bad) return ctx.problem(bad.code === "BUSY" ? 409 : 422, bad.code, "Детектор этой камеры так не заводится", { field: bad.field });
      // Серверный детектор без меток считает на сервере с GPU
      if (!s.builtin && !("labels" in props(u))) props(u).labels = ["gpu"];
      return null;
    },
    beforeSet(u, patch, whole, ctx) {
      const rec = recOf(u, ctx), set = flat(patch);
      return detProblem(rec, set, ctx) || clashProblem(rec, set, ctx);
    },
  };

  /* ===== vms.acs/1 — единицы СКУД: шаблон из unitOptions родителя, контроллер без своего подключения, команды ===== */

  // Шаблоны единиц — у ближайшего родителя, который их назвал
  function unitOptionsFor(parent, ctx) {
    for (let p = parent; p && !p.fresh; p = parentRec(p, ctx)) if (p.unitOptions) return p.unitOptions;
    return null;
  }
  // Новая единица: под каким родителем — из описания вида (ядро, createParents); контроллер (acfa с родителем) — без своего
  // подключения; шаблон (model) — из unitOptions родителя. parent — запись родителя, { fresh, type } — из той же строки
  function acsCreateProblem(spec, parent, ctx) {
    if (!acsKind(spec.type, ctx) && !(spec.type === "relay" && parent && acsKind(parent.type, ctx))) return null;
    if (spec.type === "acfa" && parent) {
      const field = OWN_LINK.find((k) => k in spec);
      return field ? ctx.problem(422, "NOT_SUPPORTED", "У контроллера нет своего подключения", { field }) : null;
    }
    const list = spec.type === "acfa" ? null : unitOptionsFor(parent, ctx);
    if (list && spec.model != null && !list.some((o) => o.model === spec.model && o.type === spec.type)) return ctx.problem(422, "VALIDATION_FAILED", "Такого шаблона у родителя нет", { field: "model" });
    return null;
  }

  const acs = {
    unitOptionsFor, createProblem: acsCreateProblem,
    beforeCreate(u, parent, ctx) {
      return acsCreateProblem(specOf(u), parent && !parent.fresh ? recOf(parent, ctx) : parent ? { type: parent.kind, fresh: true } : null, ctx);
    },
    // Команды единицы — из её operations (шаблон unitOptions): нет у единицы — 409 DEVICE_REFUSED
    actions: { "*": commandAction },
  };

  /* ===== vms.live/1 — живое видео ===== */

  // Раздача камеры (V/03.1): создаётся первым зрителем, держится LIVE_GRACE_SEC, метки — сеть, для которой создана
  const LIVE_GRACE_SEC = 60;
  const liveLabels = (network) => (network === "outside" ? ["public-address"] : []);
  const liveFan = (rec, ctx) => {
    const f = (ctx.db.stand.live || {})[rec.id];
    return f && f.until > ctx.now() ? f : null;
  };
  const liveKeep = (rec, labels, ctx) => {
    ctx.db.stand.live = ctx.db.stand.live || {};
    ctx.db.stand.live[rec.id] = { labels, until: ctx.now() + LIVE_GRACE_SEC * 1000 };
  };
  const otherCluster = (rec, id, ctx) => {
    const url = (ctx.db.stand.otherCluster || {})[id];
    return url ? ctx.problem(409, "OTHER_CLUSTER", "Камера другого кластера: откройте вход через него", { params: { url } }) : null;
  };
  // Камера другого кластера, без связи — отказ (вид без профиля судит путь: старый — type, ядро — /kind)
  const liveRefused = (rec, ctx) => otherCluster(rec, rec.id, ctx) || (rec.online === false ? ctx.problem(409, "DEVICE_OFFLINE", "Камера без связи") : null);

  const live = {
    LIVE_GRACE_SEC,
    refused: liveRefused,
    start(rec, body, ctx) {
      const bad = liveRefused(rec, ctx);
      if (bad) return bad;
      if (body.streamId !== undefined && !streamsOf(rec).some((s) => s.id === body.streamId)) return ctx.problem(422, "VALIDATION_FAILED", "У камеры нет такого потока", { field: "streamId" });
      const labels = liveLabels(body.network), fan = liveFan(rec, ctx);
      if (fan && JSON.stringify(fan.labels) !== JSON.stringify(labels)) return ctx.problem(409, "OTHER_NETWORK", "Раздачу создали для другой сети", { params: { labels: fan.labels } });
      liveKeep(rec, labels, ctx);
      const ask = body.streamId !== undefined ? `stream=${encodeURIComponent(body.streamId)}` : `width=${body.width}&height=${body.height}`;
      // Настоящего видео встроенный сервер не отдаёт: на stub:// отвечает сама страница, api/whep-stub.js
      return { status: 200, body: { whepUrl: `stub://live/whep/${rec.id}?${ask}`, token: `stub-${ctx.newVersion()}`, expiresAt: ctx.iso(ctx.now() + LIVE_GRACE_SEC * 1000), gateway: labels.length ? "stub-public" : "stub-local" } };
    },
    move(rec, body, ctx) {
      const bad = liveRefused(rec, ctx);
      if (bad) return bad;
      if (ctx.db.stand.liveMoveDenied) return ctx.problem(403, "PERMISSION_DENIED", "Нет права переразмещать раздачу");
      liveKeep(rec, liveLabels(body.network), ctx);
      return { status: 204, body: null };
    },
  };

  /* ===== vms.talk/1 — разговор через динамик ===== */

  const talk = {
    start(rec, ctx) {
      const owner = rec.parentId || rec.id;
      const far = otherCluster(rec, owner, ctx);
      if (far) return far;
      if (rec.online === false || rec.enabled === false) return ctx.problem(409, "DEVICE_OFFLINE", "Динамик без связи");
      if (ctx.db.stand.talkDenied) return ctx.problem(403, "PERMISSION_DENIED", "Нет права говорить через этот динамик");
      if (ctx.db.stand.talkRefused) return ctx.problem(409, "DEVICE_REFUSED", "Устройство отказало", { params: { reason: "refused" } });
      return { status: 200, body: { url: `stub://live/talk/${owner}/${rec.id}`, token: `stub-${ctx.newVersion()}`, expiresAt: ctx.iso(ctx.now() + LIVE_GRACE_SEC * 1000), gateway: "stub-local" } };
    },
  };

  /* ===== vms.ptz/1 — PTZ: аренда движения и пресеты; PTZ — свойство камеры ===== */

  // Аренда — на человека и камеру (ctx.state.ptz). Встроенный сервер камерами не движет: только срок
  const leasesOf = (ctx) => ctx.state.ptz || (ctx.state.ptz = new Map());
  const ptzKind = (rec, ctx) => ctx.kinds.profileOf(rec.type, "vms.ptz/1");
  function ptzProblem(rec, ctx) {
    if (!ptzKind(rec, ctx) || !rec.ptz) return ctx.problem(422, "NOT_SUPPORTED", "У камеры нет PTZ", { field: "ptz" });
    return rec.online === false ? ctx.problem(409, "DEVICE_OFFLINE", "Камера без связи") : null;
  }
  const presetCameraProblem = (rec, ctx) => (ptzKind(rec, ctx) ? null : ctx.problem(422, "NOT_SUPPORTED", "Пресеты бывают только у камеры", { field: "ptz" }));
  const presetNotFound = (ctx) => ctx.problem(404, "NOT_FOUND", "Пресет не найден(а)");

  const ptz = {
    problem: ptzProblem,
    // PUT presets/{n}: Problem | {same} — записи менять не надо | {presets} — новый состав (применяет сервер)
    put(rec, n, body, ctx) {
      // Имя устройству не идёт: связь и ptz его не судят
      const named = "name" in body;
      const bad = (named ? presetCameraProblem(rec, ctx) : ptzProblem(rec, ctx)) || ctx.lockedProblem([rec.id]);
      if (bad) return bad;
      // Положение пишет устройство в момент просьбы: у камеры за NAT связи нет, входа тоже. Подпись идёт правкой: ADR-0111 доп. (1)
      if (!named && rec.direct === false) return ctx.problem(409, "OTHER_CLUSTER", "Камера за NAT: положение пресета здесь не сохранить");
      if (!Number.isInteger(n) || n < 1) return ctx.problem(422, "VALIDATION_FAILED", "Номер пресета — с 1", { field: "n" });
      if (rec.presetMax != null && n > rec.presetMax) return presetNotFound(ctx);
      const had = (rec.presets || []).find((x) => x.n === n);
      // Без имени — положение: встроенный сервер камерами не движет, запись появляется с пустым именем
      if (!named && had) return { same: true };
      const name = named ? String(body.name).trim() : "";
      return { presets: (rec.presets || []).filter((x) => x.n !== n).map(clone).concat([{ n, name }]) };
    },
    // DELETE presets/{n}: запись снимается всегда; просьба камере забыть положение у встроенного сервера не моделируется
    drop(rec, n, ctx) {
      const bad = presetCameraProblem(rec, ctx) || ctx.lockedProblem([rec.id]);
      if (bad) return bad;
      if (rec.presetMax != null && n > rec.presetMax) return presetNotFound(ctx);
      if (!(rec.presets || []).some((x) => x.n === n)) return { same: true };
      return { presets: rec.presets.filter((x) => x.n !== n).map(clone) };
    },
    lease(rec, body, me, ctx) {
      const bad = ptzProblem(rec, ctx) || (rec.direct === false ? ctx.problem(422, "NOT_SUPPORTED", "Движение арендой недоступно: камера за NAT", { field: "direct" }) : null);
      if (bad) return bad;
      const expiresAt = ctx.iso(ctx.now() + body.ttlSec * 1000);
      leasesOf(ctx).set(`${rec.id}:${me}`, expiresAt);
      return { status: 200, body: { expiresAt } };
    },
    release(rec, me, ctx) {
      leasesOf(ctx).delete(`${rec.id}:${me}`);
      return { status: 204, body: null };
    },
  };

  /* ===== vms.timeline/1 — архив камеры: шкала, куски, удержания, отметки, дозапись ===== */

  // Шкала заглушки считается из id и часов, не хранится: так она живёт и на 250 000 камер. Сетка 4 часа: спаны не меняются
  // с ходом часов, spanId держится. Вторая по времени сетка — две эпохи над одним отрезком, дальше дозапись, резерв, устройство
  const TL_STEP = 4 * 3600000, TL_LEN = 3 * 3600000, TL_CELLS = 42;
  function camSpans(rec, ctx) {
    const main = rec.archiveId || ((rec.extraArchives || [])[0] || {}).archiveId;
    if (!main) return [];
    const t = ctx.now(), base = Math.floor(t / TL_STEP) * TL_STEP, out = [], extra = ((rec.extraArchives || [])[0] || {}).archiveId || main;
    const add = (startMs, endMs, epoch, source, over) => {
      const s = Object.assign({ startMs, endMs, epoch, source, backupOnly: false, fenced: false, archiveId: main, recordingId: rec.id }, over);
      s.spanId = `${s.recordingId}.e${epoch}.${source}.${s.fenced ? "f" : "n"}.${startMs}`;
      out.push(s);
    };
    for (let i = 0; i < TL_CELLS; i++) {
      const start = base - i * TL_STEP, end = i ? start + TL_LEN : Math.max(start + 60000, Math.floor(t / 60000) * 60000);
      add(start, end, 2, i === 2 ? "backfill" : "live");
      if (i === 1) add(start, end, 1, "live", { fenced: true });
      if (i === 3) add(end, start + TL_STEP - 60000 * 30, 1, "live", { backupOnly: true, archiveId: extra, recordingId: `${rec.id}-backup` });
      if (i === 4) add(end, start + TL_STEP - 60000 * 30, 1, "device", { backupOnly: false });
    }
    return out.filter((s) => s.endMs > s.startMs);
  }
  const spanShow = (s, ctx) => ({ spanId: s.spanId, start: ctx.iso(s.startMs), end: ctx.iso(s.endMs), archiveId: s.archiveId, recordingId: s.recordingId, epoch: s.epoch, source: s.source, backupOnly: s.backupOnly, fenced: s.fenced });
  const recordingsOf = (rec, ctx) => [...new Set(camSpans(rec, ctx).map((s) => s.recordingId))];
  function timelineGone(rec, ctx) {
    const out = clone(ctx.db.stand.timelineUnavailable || []), srv = rec.serverId && ctx.byId("servers", rec.serverId);
    if (srv && srv.online === false) out.push({ what: "server", id: srv.id, reason: "Регистратор не отвечает: архив не утрачен, лента может быть неполной" });
    return out;
  }
  const holdsAll = (ctx) => ctx.db.holds || (ctx.db.holds = []);
  const marksAll = (ctx) => ctx.db.bookmarks || (ctx.db.bookmarks = []);
  const holdShow = (h, ctx) => {
    const rec = ctx.byId("devices", h.deviceId), ids = [...new Set(camSpans(rec, ctx).map((s) => s.archiveId))];
    return Object.assign(clone(h), { states: ids.map((archiveId) => ({ archiveId, state: ctx.db.stand.holdState || "here" })) });
  };
  // Запись удержаний, отметок и дозаписи чужого кластера не идёт: чтение есть, правка — нет
  const keepRefused = (rec, ctx) => otherCluster(rec, rec.id, ctx) || (ctx.db.stand.keepDenied ? ctx.problem(403, "PERMISSION_DENIED", "Нет права") : null);
  const backTime = (at) => String(9e15 - Date.parse(at)).padStart(17, "0");
  // Закладка — момент или отрезок (ADR-0117 доп. (1) п. 2): у старых строк типа нет, это момент
  const markShow = (m) => Object.assign({ type: "moment" }, clone(m));
  const markEnd = (m) => Date.parse(m.type === "span" && m.to ? m.to : m.occurred);
  // Сутки с записью — в поясе системы (Me.timezone)
  const recDay = (ms, ctx) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: ctx.db.timezone || "UTC" });

  const timeline = {
    camSpans, timelineGone, holdShow, keepRefused, holdsAll, marksAll,
    spans(rec, q, ctx) {
      const from = q.from ? Date.parse(q.from) : -Infinity, to = q.to ? Date.parse(q.to) : Infinity;
      if (from >= to) return ctx.problem(422, "VALIDATION_FAILED", "Конец окна раньше начала", { field: "to" });
      const rows = camSpans(rec, ctx).filter((s) => s.startMs < to && s.endMs > from);
      return ctx.pageList(q, `timeline:${rec.id}`, rows, (s) => `${String(s.startMs).padStart(15, "0")}|${s.spanId}`, (s) => spanShow(s, ctx), { unavailable: timelineGone(rec, ctx) });
    },
    playback(rec, q, ctx) {
      const at = Date.parse(q.at);
      if (!(at > 0)) return ctx.problem(422, "VALIDATION_FAILED", "Укажите момент", { field: "at" });
      const list = camSpans(rec, ctx), over = list.filter((s) => s.startMs <= at && at < s.endMs);
      const span = q.spanId ? list.find((s) => s.spanId === q.spanId && s.startMs <= at && at < s.endMs) : over.find((s) => !s.fenced) || over[0];
      if (!span) return ctx.problem(404, "NOT_FOUND", "Запись не найден(а)");
      const k = Math.floor((at - span.startMs) / 60000), from = span.startMs + k * 60000, end = Math.min(from + 60000, span.endMs);
      return { status: 200, body: { url: `stub://piece/${rec.id}/e${span.epoch}/${from}-${end}.mp4?t=stub-${ctx.newVersion()}`, from: ctx.iso(from), to: ctx.iso(end), expiresAt: ctx.iso(ctx.now() + 120000), spanId: span.spanId } };
    },
    holds: (rec, q, ctx) => ctx.pageList(q, `holds:${rec.id}`, holdsAll(ctx).filter((h) => h.deviceId === rec.id), (h) => h.id, (h) => holdShow(h, ctx)),
    hold(rec, body, ctx) {
      const bad = keepRefused(rec, ctx);
      if (bad) return bad;
      const from = Math.floor(Date.parse(body.from) / 1000), to = Math.floor(Date.parse(body.to) / 1000);
      if (!(to > from)) return ctx.problem(422, "VALIDATION_FAILED", "Конец позже начала", { field: "to" });
      const id = `${rec.id}-${from}-${to}`, ids = body.recordingIds || recordingsOf(rec, ctx);
      const was = holdsAll(ctx).find((h) => h.id === id);
      if (was) {
        was.recordingIds = [...new Set(was.recordingIds.concat(ids))];
        ctx.send("entity.changed", { kind: "hold", entityId: id, payload: { deviceId: rec.id } });
        return { status: 200, body: holdShow(was, ctx) };
      }
      const h = { id, deviceId: rec.id, from: ctx.iso(from * 1000), to: ctx.iso(to * 1000), recordingIds: ids, by: ctx.myLogin(), at: ctx.iso(ctx.now()), releasedAt: null };
      if (body.note) h.note = body.note;
      holdsAll(ctx).push(h);
      ctx.send("entity.created", { kind: "hold", entityId: id, payload: { deviceId: rec.id } });
      return { status: 201, body: holdShow(h, ctx) };
    },
    bookmarks(rec, q, ctx) {
      if (ctx.db.stand.keepDenied) return ctx.problem(403, "PERMISSION_DENIED", "Нет права на отметки");
      const from = q.from ? Date.parse(q.from) : -Infinity, to = q.to ? Date.parse(q.to) : Infinity;
      // Отрезок попадает в окно, если пересекает его
      const rows = marksAll(ctx).filter((m) => m.deviceId === rec.id && markEnd(m) >= from && Date.parse(m.occurred) <= to);
      return ctx.pageList(q, `bookmarks:${rec.id}`, rows, (m) => `${backTime(m.occurred)}|${m.id}`, markShow);
    },
    bookmark(rec, body, ctx) {
      const bad = keepRefused(rec, ctx);
      if (bad) return bad;
      if (!trimmed(body.note)) return ctx.problem(422, "VALIDATION_FAILED", "Напишите заметку", { field: "note" });
      const at = ctx.iso(ctx.now()), type = body.type || "moment";
      const m = { id: ctx.uuid("bookmark"), deviceId: rec.id, note: body.note.trim(), type, occurred: body.occurred || at, at, by: ctx.myLogin() };
      if (type === "span") {
        if (!(Date.parse(body.to) > Date.parse(m.occurred))) return ctx.problem(422, "VALIDATION_FAILED", "Конец отрезка позже начала", { field: "to" });
        m.to = body.to;
      } else if (body.to) return ctx.problem(422, "VALIDATION_FAILED", "Конец — только у отрезка", { field: "to" });
      marksAll(ctx).push(m);
      ctx.send("entity.created", { kind: "bookmark", entityId: m.id, payload: { deviceId: rec.id } });
      return { status: 201, body: markShow(m) };
    },
    // Сутки с записью для календаря окна выгрузки (GET /units/{uid}/recording-days): from, to — даты, нет — последние 31 сутки
    days(rec, q, ctx) {
      const day = 86400000, to = q.to ? Date.parse(q.to + "T12:00:00Z") : ctx.now(), from = q.from ? Date.parse(q.from + "T12:00:00Z") : to - 30 * day;
      if (!(to >= from)) return ctx.problem(422, "VALIDATION_FAILED", "Конец раньше начала", { field: "to" });
      if ((to - from) / day > 366) return ctx.problem(422, "VALIDATION_FAILED", "Не больше года", { field: "from" });
      const got = new Set();
      camSpans(rec, ctx).forEach((s) => { for (let t = s.startMs; t < s.endMs; t += 3600000) got.add(recDay(t, ctx)); got.add(recDay(s.endMs - 1, ctx)); });
      const days = [];
      for (let t = from; t <= to + 1; t += day) { const d = recDay(t, ctx); if (!days.length || days[days.length - 1].date !== d) days.push({ date: d, recorded: got.has(d) }); }
      return { status: 200, body: { days, unavailable: timelineGone(rec, ctx) } };
    },
    fetch(rec, body, ctx) {
      const bad = keepRefused(rec, ctx);
      if (bad) return bad;
      const from = Date.parse(body.from), to = Date.parse(body.to);
      if (!(to > from)) return ctx.problem(422, "VALIDATION_FAILED", "Конец позже начала", { field: "to" });
      if (rec.archiveId !== body.archiveId) return ctx.problem(409, "NO_PRIMARY", "Основной записи своего кластера нет: закрепить некуда", { field: "archiveId" });
      // Камера со встроенным хранилищем: пропуски внутри периода заказываются отдельно от просьб «закрепить» и квоту не тратят (vms.edge/1)
      const edgeOrdered = edgePull(rec.id, from, to, ctx);
      if (body.edgeOnly === true) return { status: 200, body: { accepted: 0, refused: [], edgeOrdered } };
      const parts = [];
      for (let a = from; a < to; a += 86400000) parts.push({ from: ctx.iso(a), to: ctx.iso(Math.min(a + 86400000, to)) });
      const free = 7 - (ctx.db.stand.fetchTaken || 0), ok = parts.slice(0, Math.max(free, 0));
      ctx.db.stand.fetchTaken = (ctx.db.stand.fetchTaken || 0) + ok.length;
      return { status: 200, body: { accepted: ok.length, refused: parts.slice(ok.length).map((x) => Object.assign(x, { reason: "per_person" })), edgeOrdered } };
    },
  };

  /* ===== vms.pos/1 — источник событий (касса): камеры титров, вид титров, разбор чека, приём данных, сырые строки ===== */

  // Зона титров, пока администратор её не задал: слева вверху, как пресет формы
  const POS_AREA = { x: 0.02, y: 0.04, w: 0.52, h: 0.74 };
  const POS_RAW_KEEP = 200;
  const POS_RAW_SAMPLE = [["КАССА 3   СМЕНА 128", 20], ["ЧЕК 004512   08.11.2026 10:42", 18], ["Молоко 3,2% 1 л          89,90", 16], ["Хлеб бородинский         54,00", 15],
    ["Пиво светлое 0,5 л      129,00", 13], ["Отмена позиции: Пиво    -129,00", 11], ["СКИДКА 10%               -14,39", 10], ["ИТОГО                   129,51", 9],
    ["Оплата: карта ****1234", 8], ["СПАСИБО ЗА ПОКУПКУ", 8], ["КАССА 3   ОЖИДАНИЕ", 1]];
  const rawOf = (ctx) => ctx.state.posRaw || (ctx.state.posRaw = new Map());
  const RS232_ONLY = ["comPort", "baudRate", "parity"];
  // Правка (или новый объект) приводится к согласованному виду: cameraId (устарело) — первая камера overlays; поля RS-232 и UDP
  // — только у своего протокола. set — свойства правки (JSON Merge Patch; хук дополняет её), old — свойства объекта сейчас
  function posNorm(set, old, ctx) {
    const bad = (m) => ctx.problem(422, "VALIDATION_FAILED", m, { field: "overlays" });
    const oldList = Array.isArray(old.overlays) ? old.overlays : [];
    if ("overlays" in set) {
      const list = set.overlays || [];
      set.overlays = list;
      if (list.length) set.cameraId = list[0].cameraId;
      else if (old.cameraId != null || set.cameraId != null) set.cameraId = null;
      else delete set.cameraId;
    } else if ("cameraId" in set) {
      const c = set.cameraId;
      if (c == null) {
        if (oldList.length) set.overlays = [];
      } else {
        const cam = ctx.byId("devices", c);
        if (!cam || !ctx.kinds.profileOf(cam.type, "vms.camera/1")) return ctx.problem(422, "VALIDATION_FAILED", `Нет камеры ${c}`, { field: "cameraId" });
        // Камера встаёт первой и берёт зону прежней первой; остальные остаются, повтор снимается
        const next = oldList.length && oldList[0].cameraId === c ? oldList : [{ cameraId: c, area: clone((oldList[0] || {}).area || POS_AREA) }].concat(oldList.slice(1).filter((o) => o.cameraId !== c));
        if (JSON.stringify(next) !== JSON.stringify(oldList)) set.overlays = next;
      }
    }
    for (const o of set.overlays || []) {
      const cam = ctx.byId("devices", o.cameraId);
      if (!cam || !ctx.kinds.profileOf(cam.type, "vms.camera/1")) return bad(`Нет камеры ${o.cameraId}`);
      if (o.area.x + o.area.w > 1 + 1e-9 || o.area.y + o.area.h > 1 + 1e-9) return bad("Зона выходит за кадр: x + w и y + h не больше 1");
    }
    if (new Set((set.overlays || []).map((o) => o.cameraId)).size !== (set.overlays || []).length) return bad("Камера в списке титров одна");
    const final = Object.assign({}, old, set);
    const proto = final.protocol || "tcp";
    const stray = (names, want) => {
      if (proto === want) return null;
      const name = names.find((k) => set[k] != null);
      if (name) return ctx.problem(422, "VALIDATION_FAILED", `Поле ${name} — только при protocol = ${want}`, { field: name });
      names.forEach((k) => old[k] != null && !(k in set) && (set[k] = null));
      return null;
    };
    return stray(RS232_ONLY, "rs232") || stray(["udpMaxPacket"], "udp");
  }
  const pos = {
    // cameraId — копия первой камеры overlays: камеры, снятые удалением, не оставляют в нём чужого значения
    view(out) {
      const p = out.properties, list = p && p.overlays;
      if (Array.isArray(list)) p.cameraId = list.length ? list[0].cameraId : null;
    },
    beforeCreate(u, parent, ctx) {
      const set = props(u), bad = posNorm(set, {}, ctx);
      Object.keys(set).forEach((k) => set[k] === null && delete set[k]);
      return bad;
    },
    beforeSet(u, patch, whole, ctx) {
      return patch.properties ? posNorm(patch.properties, props(u), ctx) : null;
    },
    // Сырые строки: от старых к новым, последние limit. Пока источнику ничего не подкладывали (и не очищали), вместо строк —
    // пример чека (заглушка стенда): он не хранится, первая подложенная строка начинает список с []
    raw(rec, q, ctx) {
      const n = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > 200) return ctx.problem(422, "VALIDATION_FAILED", "limit от 1 до 200", { field: "/limit" });
      const list = rawOf(ctx).get(rec.id) || POS_RAW_SAMPLE.map(([text, ago]) => ({ at: ctx.iso(ctx.now() - ago * 1000), text }));
      return { status: 200, body: { items: clone(list.slice(-n)) } };
    },
    // Строка от кассы по at (позже всех — в конец); clear: true очищает список, пример чека больше не возвращается
    push(rec, body, ctx) {
      const all = rawOf(ctx);
      if (body.clear === true) {
        all.set(rec.id, []);
        return { status: 200, body: { applied: true } };
      }
      const text = body.text;
      if (typeof text !== "string" || !text || text.length > 1000) return ctx.problem(422, "VALIDATION_FAILED", "text: строка до 1000 символов", { field: "text" });
      const at = body.at === undefined ? ctx.iso(ctx.now()) : body.at;
      if (Number.isNaN(Date.parse(at))) return ctx.problem(422, "VALIDATION_FAILED", "at: дата и время", { field: "at" });
      const list = all.get(rec.id) || [];
      let i = list.length;
      while (i > 0 && Date.parse(list[i - 1].at) > Date.parse(at)) i--;
      list.splice(i, 0, { at, text });
      all.set(rec.id, list.slice(-POS_RAW_KEEP));
      return { status: 200, body: { applied: true } };
    },
  };

  /* ===== vms.edge/1 — встроенное хранилище камеры и регистратора: репликация в архив сервера ===== */

  // Состояние репликации — status.observed.replicationStatus; свойство replication — настройка. Сервер хранит факты (пропуски, последний
  // забор, байты за сутки), а state, timeLeftSec, nextTransferAt, cameras считает при чтении. mode all и recordMode replica камеры
  // без replicaFrom — одно и то же: правка хранилища ставит режим камерам, правка камеры меняет mode при чтении
  const EDGE_KEEP_MS = 7 * 86400000;
  const EDGE_SEC_PER_MIN = 4; // секунд часов сервера на забор одной минуты записи
  const EDGE_BYTES_PER_MIN = 30 * 1024 * 1024; // около 4 Мбит/с
  const EDGE_WORST = ["waiting", "running", "planned", "ok", "off"];
  const edgeRuns = (ctx) => ctx.state.edgeRuns || (ctx.state.edgeRuns = new Map());
  const edgeSeen = (ctx) => ctx.state.edgeSeen || (ctx.state.edgeSeen = new Map());
  const edgeOwner = (u, ctx) => (u.parentId ? ctx.units.get(u.parentId) : null);
  const edgeIsNvr = (u, ctx) => (edgeOwner(u, ctx) || {}).kind === "ipsrv";
  function edgeCams(u, ctx) {
    const o = edgeOwner(u, ctx);
    if (!o) return [];
    return o.kind === "camera" ? [o] : ctx.units.byParent(o.uid).filter((x) => x.kind === "camera");
  }
  const edgeEmbedded = (c) => props(c).recordMode === "replica" && !props(c).replicaFrom;
  const obsGet = (u, k) => ((u.status || {}).observed || {})[k];
  const EDGE_NONE = { gaps: [], bytesToday: 0 };
  const edgeRead = (u) => obsGet(u, "replicationStatus") || EDGE_NONE;
  // Факты пишутся только здесь: чтение (view) их не создаёт. Хранилище с фактами попадает в такт часов (edgeActive)
  function edgeFacts(u, ctx) {
    const o = observedOf(u);
    if (!o.replicationStatus) o.replicationStatus = { gaps: [], bytesToday: 0 };
    edgeActive(ctx).add(u.uid);
    return o.replicationStatus;
  }
  // Такт часов не обходит все хранилища (на большом стенде их тысячи): только те, у кого есть факты репликации
  function edgeActive(ctx) {
    if (!ctx.state.edgeActive) ctx.state.edgeActive = new Set(ctx.units.byKind("storage").filter((x) => obsGet(x, "replicationStatus")).map((x) => x.uid));
    return ctx.state.edgeActive;
  }
  // Носитель с ошибкой или устройство не отдаёт записи по Profile G: сервер ничего не заберёт (reason media или profile)
  const edgeBlocked = (u) => (obsGet(u, "mediaOk") === false ? "media" : obsGet(u, "profileG") === false ? "profile" : null);
  const edgeLinkOk = (...list) => list.every((x) => !x || (x.status || {}).link !== "offline");
  // Настройка, как её видит клиент. mode all — только если КАЖДАЯ камера, кроме исключённых, забирает с этого хранилища (replica без
  // replicaFrom); иначе off (смешанное состояние: часть камер пишет сама). В mode all archiveId — общий архив этих камер, если он один
  function edgeRepOf(u, ctx) {
    const st = props(u).replication || {}, cams = edgeCams(u, ctx), ids = new Set(cams.map((c) => c.uid));
    const excluded = (st.excludedCameras || []).filter((id) => ids.has(id));
    const active = cams.filter((c) => !excluded.includes(c.uid));
    const all = active.length > 0 && active.every(edgeEmbedded);
    const arcs = new Set(active.map((c) => props(c).archiveId || null));
    const first = active[0] || cams[0];
    const archiveId = all && arcs.size === 1 ? [...arcs][0] : st.archiveId != null ? st.archiveId : first ? props(first).archiveId || null : null;
    return { mode: all ? "all" : "off", archiveId, speedLimitMbps: st.speedLimitMbps || 0, excludedCameras: excluded };
  }
  // Сколько живёт запись на устройстве: объём / (около 43 ГБ в сутки на камеру); без объёма устройство не стирает (null)
  function edgeKeepMs(u, ctx) {
    const size = props(u).sizeBytes;
    return size ? (size / GB / (43 * Math.max(1, edgeCams(u, ctx).length))) * 86400000 : null;
  }
  const edgeGapsOf = (u, c, f, ctx) => (f.gaps || []).filter((g) => !edgeIsNvr(u, ctx) || g.cameraId === c.uid);
  const gapView = (g, withCamera) => {
    const out = {};
    if (withCamera && g.cameraId) out.cameraId = g.cameraId;
    out.from = g.from;
    out.to = g.to;
    out.result = g.result;
    return out;
  };
  const gapMin = (g) => Math.max(1, Math.round((Date.parse(g.to) - Date.parse(g.from)) / 60000));
  // Состояние одной камеры (у хранилища камеры — единственной)
  function edgeScope(u, c, rep, f, ctx) {
    const now = ctx.now(), gaps = edgeGapsOf(u, c, f, ctx), queued = gaps.filter((g) => g.result === "queued");
    const run = edgeRuns(ctx).get(`${u.uid}|${c.uid}`);
    const eligible = edgeEmbedded(c) && !rep.excludedCameras.includes(c.uid);
    const online = edgeLinkOk(u, edgeOwner(u, ctx), c) && !edgeBlocked(u);
    const next = ctx.nextReplication(c);
    // У регистратора последний забор — у каждой камеры свой; у исключённой камеры чужого забора нет
    const last = edgeIsNvr(u, ctx) ? (f.lastBy && f.lastBy[c.uid]) || (eligible ? f.lastTransferAt : null) : f.lastTransferAt;
    let state, timeLeftSec = null;
    if (run && run.until > now) {
      state = "running";
      timeLeftSec = Math.ceil((run.until - now) / 1000);
    } else if (queued.length) {
      state = !online ? "waiting" : eligible || queued.some((g) => g.want) ? "running" : "planned";
      if (state === "running") timeLeftSec = queued.reduce((a, g) => a + gapMin(g), 0) * EDGE_SEC_PER_MIN;
    } else if (eligible) state = online ? "ok" : "waiting";
    else state = last || gaps.some((g) => g.result === "done") ? "ok" : "off";
    if ((state === "ok" || state === "off") && next) state = "planned";
    return { state, timeLeftSec, nextTransferAt: next, lastTransferAt: last || null, eligible, gaps: gaps.filter((g) => Date.parse(g.to) >= now - EDGE_KEEP_MS).sort((x, y) => Date.parse(y.from) - Date.parse(x.from)) };
  }
  function edgeStatus(u, ctx) {
    const rep = edgeRepOf(u, ctx), f = edgeRead(u), nvr = edgeIsNvr(u, ctx), cams = edgeCams(u, ctx);
    const scopes = cams.map((c) => [c, edgeScope(u, c, rep, f, ctx)]);
    const state = scopes.length ? EDGE_WORST.find((w) => scopes.some(([, s]) => s.state === w)) : "off";
    const left = scopes.map(([, s]) => s.timeLeftSec).filter((x) => x != null);
    const lags = cams.filter((c) => edgeEmbedded(c) && obsGet(c, "replicaLagSec") != null).map((c) => obsGet(c, "replicaLagSec"));
    const out = { state, bytesToday: f.bytesToday || 0, lastTransferAt: f.lastTransferAt || null };
    if (lags.length) out.lagSec = Math.max(...lags);
    out.timeLeftSec = left.length ? left.reduce((a, b) => a + b, 0) : null;
    out.nextTransferAt = scopes.map(([, s]) => s.nextTransferAt).filter(Boolean).sort()[0] || null;
    out.gaps = scopes.flatMap(([, s]) => s.gaps).map((g) => gapView(g, nvr)).sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
    if (nvr) out.cameras = scopes.map(([c, s]) => ({ cameraId: c.uid, state: s.state, excluded: rep.excludedCameras.includes(c.uid), lastTransferAt: s.lastTransferAt, nextTransferAt: s.nextTransferAt, gaps: s.gaps.map((g) => gapView(g, false)) }));
    return out;
  }
  // Состояния, которые клиент уже получил, — по ним сервер видит смену (replication.changed)
  const edgeSnapshot = (u, ctx) => {
    const s = edgeStatus(u, ctx);
    return JSON.stringify([s.state, edgeRepOf(u, ctx).mode, (s.cameras || []).map((c) => [c.cameraId, c.state]), s.gaps]);
  };
  function edgeChanged(u, ctx, extra) {
    const s = edgeStatus(u, ctx);
    edgeSeen(ctx).set(u.uid, edgeSnapshot(u, ctx));
    ctx.send("replication.changed", { kind: "storage", entityId: u.uid, payload: Object.assign({ state: s.state }, extra || {}) });
  }
  // Событие хранилища: запись журнала и запуск правил, которые его слушают
  const edgeEvent = (u, id, fields, ctx) => ctx.unitEvent(u, id, fields, fields);
  function edgeFail(u, reason, cameraId, ctx) {
    edgeEvent(u, "replication.failed", cameraId ? { reason, cameraId } : { reason }, ctx);
    return null;
  }
  function edgeStart(u, c, run, ctx) {
    edgeRuns(ctx).set(`${u.uid}|${c.uid}`, run);
  }
  // Запуск забора камеры: на связи, носитель в порядке, есть что забрать (всё в очереди у камеры с mode all, иначе — заказанное)
  function edgeMaybeStart(u, c, rep, f, ctx) {
    const key = `${u.uid}|${c.uid}`;
    if (edgeRuns(ctx).has(key) || !edgeLinkOk(u, edgeOwner(u, ctx), c) || edgeBlocked(u)) return;
    const eligible = edgeEmbedded(c) && !rep.excludedCameras.includes(c.uid);
    const take = edgeGapsOf(u, c, f, ctx).filter((g) => g.result === "queued" && (eligible || g.want));
    if (!take.length) return;
    const mins = take.reduce((a, g) => a + gapMin(g), 0);
    edgeStart(u, c, { until: ctx.now() + Math.min(600, Math.max(3, mins * EDGE_SEC_PER_MIN)) * 1000, bytes: mins * EDGE_BYTES_PER_MIN, keys: take }, ctx);
  }
  // Забор начинается сразу, а не на следующем такте: /test/clock сразу после заказа или пропуска видит настоящий остаток
  function edgeKick(u, ctx) {
    const rep = edgeRepOf(u, ctx), f = edgeRead(u);
    edgeCams(u, ctx).forEach((c) => edgeMaybeStart(u, c, rep, f, ctx));
  }
  // Заказ забора: правило (replicate) или ручной «Забрать период»; камера одна. Нет связи, ошибка носителя, нет хранилища — отказ
  // с replication.failed. Что вернулось: true — принято
  function edgeOrder(u, c, order, ctx) {
    const rep = edgeRepOf(u, ctx), f = edgeFacts(u, ctx);
    if (!edgeLinkOk(u, edgeOwner(u, ctx), c)) return edgeFail(u, "no_link", c.uid, ctx);
    if (edgeBlocked(u)) return edgeFail(u, edgeBlocked(u), c.uid, ctx);
    const archive = order.archive || rep.archiveId || props(c).archiveId;
    if (!archive || !ctx.byId("archives", archive)) return edgeFail(u, "archive", c.uid, ctx);
    const gaps = edgeGapsOf(u, c, f, ctx).filter((g) => g.result === "queued");
    let minutes = 0, take = [];
    if (order.period === "last") minutes = order.minutes || 10;
    else if (order.period === "event") minutes = Math.max(1, Math.ceil(((order.beforeSec || 0) + (order.afterSec || 0) + 30) / 60));
    else {
      take = order.gaps || gaps;
      take.forEach((g) => (g.want = true));
    }
    if (minutes) {
      const run = edgeRuns(ctx).get(`${u.uid}|${c.uid}`);
      const until = Math.max(run && run.until > ctx.now() ? run.until : 0, ctx.now() + Math.max(3, minutes * EDGE_SEC_PER_MIN) * 1000);
      if (run && run.until > ctx.now()) {
        run.until = until;
        run.bytes += minutes * EDGE_BYTES_PER_MIN;
      } else edgeStart(u, c, { until, bytes: minutes * EDGE_BYTES_PER_MIN, keys: [] }, ctx);
    } else edgeMaybeStart(u, c, rep, f, ctx);
    edgeChanged(u, ctx);
    return true;
  }
  // Встроенное хранилище камеры: свое или регистратора
  const edgeStorageOf = (cam, ctx) => ctx.units.byParent(cam.uid).find((x) => x.kind === "storage") || (cam.parentId ? ctx.units.byParent(cam.parentId).find((x) => x.kind === "storage") : null);
  // Ручной забор периода (POST /units/{uid}/archive-fetch): пропуски камеры внутри периода уходят в заказ; сколько пропусков заказано
  function edgePull(camId, from, to, ctx) {
    const cam = ctx.units.get(camId), st = cam && edgeStorageOf(cam, ctx);
    if (!st) return 0;
    const gaps = edgeGapsOf(st, cam, edgeRead(st), ctx).filter((g) => g.result === "queued" && Date.parse(g.from) < to && Date.parse(g.to) > from);
    return gaps.length && edgeOrder(st, cam, { period: "offline", gaps }, ctx) ? gaps.length : 0;
  }
  // Часы идут: потерянное устройством, начало и конец забора. Вызывает tick() сервера
  function edgeTick(ctx, fired) {
    const now = ctx.now(), seen = edgeSeen(ctx), day = ctx.iso(now).slice(0, 10);
    edgeActive(ctx).forEach((uid) => {
      const u = ctx.units.get(uid);
      if (!u) return edgeActive(ctx).delete(uid);
      const f = edgeRead(u), keep = edgeKeepMs(u, ctx), nvr = edgeIsNvr(u, ctx), cams = edgeCams(u, ctx), rep = edgeRepOf(u, ctx);
      // Сутки по часам сервера: «за сутки забрано» начинается заново
      if (f.day !== day) {
        if (f.day) f.bytesToday = 0;
        f.day = day;
      }
      const before = seen.has(uid) ? seen.get(uid) : edgeSnapshot(u, ctx);
      let extra = null;
      cams.forEach((c) => {
        const gaps = edgeGapsOf(u, c, f, ctx), key = `${uid}|${c.uid}`, run = edgeRuns(ctx).get(key);
        // Устройство записало поверх: пропуск, который сервер не успел забрать за срок хранения, потерян
        gaps.filter((g) => g.result === "queued" && keep != null && now - Date.parse(g.from) > keep).forEach((g) => {
          g.result = "lost";
          delete g.want;
          extra = { cameraId: nvr ? c.uid : undefined, gap: gapView(g, false) };
          ctx.unitEvent(c, "segment.lost", { from: g.from, to: g.to }, { from: g.from, to: g.to });
        });
        if (run && run.until <= now) {
          edgeRuns(ctx).delete(key);
          run.keys.forEach((g) => g.result === "queued" && (g.result = "done"));
          f.lastTransferAt = ctx.iso(run.until);
          if (nvr) (f.lastBy || (f.lastBy = {}))[c.uid] = f.lastTransferAt;
          f.bytesToday = (f.bytesToday || 0) + run.bytes;
          edgeEvent(u, "replication.done", nvr ? { cameraId: c.uid } : {}, ctx);
          fired.push({ kind: "storage", id: uid });
        } else if (!run) {
          // Есть что забрать, а носитель или Profile G мешают: один отказ, пока причина не пропала
          const block = edgeBlocked(u), flag = `${key}|${block}`, flags = ctx.state.edgeFlags || (ctx.state.edgeFlags = new Set());
          const wants = gaps.some((g) => g.result === "queued" && ((edgeEmbedded(c) && !rep.excludedCameras.includes(c.uid)) || g.want));
          if (block && wants && edgeLinkOk(u, edgeOwner(u, ctx), c)) {
            if (!flags.has(flag)) {
              flags.add(flag);
              edgeFail(u, block, c.uid, ctx);
            }
          } else {
            ["media", "profile"].forEach((r) => flags.delete(`${key}|${r}`));
            edgeMaybeStart(u, c, rep, f, ctx);
          }
        }
      });
      if (edgeSnapshot(u, ctx) !== before) edgeChanged(u, ctx, extra || undefined);
      else seen.set(uid, before);
    });
  }
  const edgeDue = (ctx) => [...edgeRuns(ctx).values()].map((r) => r.until);
  // Пропуск, проверка носителя, отказ — тестовые события стенда (POST /test/events)
  function edgeTest(u, body, ctx) {
    const bad = (m, field) => ctx.problem(422, "VALIDATION_FAILED", m, { field });
    const nvr = edgeIsNvr(u, ctx), cams = edgeCams(u, ctx);
    if (body.cameraId != null && !cams.some((c) => c.uid === body.cameraId)) return bad("Камера не принадлежит этому хранилищу", "cameraId");
    if (nvr && !body.cameraId && body.type !== "edge.check") return bad("У регистратора нужна камера", "cameraId");
    if (body.type === "edge.check") {
      ["mediaOk", "profileG"].forEach((k) => typeof body[k] === "boolean" && (observedOf(u)[k] = body[k]));
      edgeChanged(u, ctx);
    } else if (body.type === "edge.fail") {
      if (!["no_link", "media", "archive", "space", "profile"].includes(body.reason)) return bad("reason: no_link, media, archive, space или profile", "reason");
      edgeFail(u, body.reason, body.cameraId, ctx);
    } else {
      if (Number.isNaN(Date.parse(body.from)) || Number.isNaN(Date.parse(body.to)) || Date.parse(body.to) <= Date.parse(body.from)) return bad("from и to: период, to позже from", "from");
      const result = body.result || "queued";
      if (!["queued", "done", "lost"].includes(result)) return bad("result: queued, done или lost", "result");
      const g = Object.assign(body.cameraId && nvr ? { cameraId: body.cameraId } : {}, { from: body.from, to: body.to, result });
      edgeFacts(u, ctx).gaps.push(g);
      const cam = cams.find((c) => c.uid === body.cameraId) || cams[0];
      if (result === "queued") edgeKick(u, ctx);
      edgeChanged(u, ctx, { cameraId: nvr ? body.cameraId : undefined, gap: gapView(g, false) });
      if (result === "lost" && cam) ctx.unitEvent(cam, "segment.lost", { from: g.from, to: g.to }, { from: g.from, to: g.to });
    }
    return { status: 200, body: { applied: true } };
  }
  // Настройка против камер: mode all без хранилища для записей, лишние камеры, режим replica камеры, которая его не принимает
  function edgeProblem(u, set, ctx) {
    const bad = (m) => ctx.problem(422, "VALIDATION_FAILED", m, { field: "replication" });
    const cams = edgeCams(u, ctx), nvr = edgeIsNvr(u, ctx);
    const next = Object.assign({}, edgeRepOf(u, ctx), set);
    if (!nvr && (next.excludedCameras || []).length) return bad("excludedCameras — только у хранилища регистратора");
    if ((next.excludedCameras || []).some((id) => !cams.some((c) => c.uid === id))) return bad("excludedCameras — камеры этого регистратора");
    if (next.archiveId) {
      const a = ctx.byId("archives", next.archiveId);
      if (!a) return bad(`Нет хранилища ${next.archiveId}`);
      if (!ctx.specOf(a).recordModes.includes("replica")) return ctx.problem(422, "NOT_SUPPORTED", `На архив вида ${a.kind} репликация не идёт`, { field: "replication" });
    }
    if (next.mode !== "all") return null;
    const targets = cams.filter((c) => !next.excludedCameras.includes(c.uid));
    if (!targets.length) return bad("Нет камер, у которых сервер будет забирать записи");
    for (const c of targets) {
      // Архив камеры меняется, только если назван в правке или у камеры его нет; иначе остаётся её архив
      const archiveId = set.archiveId || props(c).archiveId || next.archiveId;
      if (!archiveId) return bad("Для mode all нужен archiveId: у камеры нет записи в архив");
      const rec = ctx.byId("devices", c.uid);
      const err = recordingProblem(rec, { archiveId, recordMode: "replica", replicaFrom: null }, ctx);
      if (err) return err;
    }
    return null;
  }
  // Что сервер помнит о камере, когда сам ставит ей replica: прежние режим и архив — вернуть при выключении или исключении
  const edgeMemo = (ctx) => ctx.state.edgeMemo || (ctx.state.edgeMemo = new Map());
  // Камерам — replica (mode all) или прежний режим (mode off, исключённые): так же, как это сделал бы PATCH камеры. Трогаются только камеры,
  // чья цель изменилась. it: что назвала правка — mode (all, off; null — не назван и режим смешанный), archive, excl
  function edgeSync(u, ctx, it) {
    const st = props(u).replication || {}, excl = st.excludedCameras || [], memo = edgeMemo(ctx);
    edgeCams(u, ctx).forEach((c) => {
      const rec = ctx.byId("devices", c.uid), has = edgeEmbedded(c), excluded = excl.includes(c.uid), p = props(c);
      let patch = null;
      if (it.mode === "all" && !excluded) {
        patch = {};
        const m = memo.get(c.uid) || {};
        if (!has) {
          Object.assign(patch, { recordMode: "replica", replicaFrom: null });
          m.recordMode = p.recordMode;
        }
        const archiveId = (it.archive || !p.archiveId) && st.archiveId ? st.archiveId : null;
        if (archiveId && p.archiveId !== archiveId) {
          patch.archiveId = archiveId;
          m.archiveId = p.archiveId;
          m.setArchive = archiveId;
        }
        if (Object.keys(patch).length) memo.set(c.uid, m);
      } else if (has && (it.mode === "off" || excluded)) {
        const m = memo.get(c.uid) || {};
        patch = { recordMode: m.recordMode && m.recordMode !== "replica" ? m.recordMode : "always" };
        if (m.archiveId && m.setArchive === p.archiveId && m.archiveId !== p.archiveId) patch.archiveId = m.archiveId;
        // Прежний режим мог стать невозможным (расписание, архив сняли): тогда always
        if (patch.recordMode !== "always" && recordingProblem(rec, patch, ctx)) patch = { recordMode: "always" };
        memo.delete(c.uid);
      }
      if (!patch || !Object.keys(patch).length) return;
      ctx.applyPatch(rec, patch);
      ctx.changed("device", rec);
    });
  }
  const edge = {
    view(out, ctx) {
      const u = ctx.units.get(out.uid);
      if (!u) return out;
      out.properties = Object.assign({}, out.properties, { replication: edgeRepOf(u, ctx) });
      const obs = Object.assign({}, (out.status || {}).observed, { replicationStatus: edgeStatus(u, ctx) });
      obs.mediaOk = obs.mediaOk !== false;
      obs.profileG = obs.profileG !== false;
      out.status = Object.assign({}, out.status, { observed: obs });
      return out;
    },
    // null и пустые поля приводятся к виду: replication: null — mode off с прежними исключениями; excludedCameras: null — пустой список.
    // Что назвала правка (mode, archiveId, excludedCameras), решает, какие камеры тронет сервер: правка скорости камер не трогает
    beforeSet(u, patch, whole, ctx) {
      ctx.state.edgeIntent = null;
      if (!patch.properties || !("replication" in patch.properties)) return null;
      if (patch.properties.replication === null) patch.properties.replication = { mode: "off" };
      const set = patch.properties.replication;
      if ("mode" in set && set.mode == null) set.mode = "off";   // mode: null — как replication: null, выключено
      if ("excludedCameras" in set && set.excludedCameras == null) set.excludedCameras = [];
      if ("speedLimitMbps" in set && set.speedLimitMbps == null) set.speedLimitMbps = 0;
      const bad = edgeProblem(u, set, ctx);
      if (bad) return bad;
      const cur = edgeRepOf(u, ctx);
      ctx.state.edgeIntent = ("mode" in set || "archiveId" in set || "excludedCameras" in set)
        ? { uid: u.uid, mode: "mode" in set ? set.mode : cur.mode === "all" ? "all" : null, archive: "archiveId" in set, excl: "excludedCameras" in set } : null;
      // mode в хранилище лежит явно: откат правки возвращает его
      if (!set.mode) set.mode = cur.mode;
      props(u).replication = Object.assign({}, props(u).replication, { mode: cur.mode });
      return null;
    },
    afterSet(u, before, ctx) {
      const it = ctx.state.edgeIntent;
      ctx.state.edgeIntent = null;
      if (!before || !it || it.uid !== u.uid) return;
      edgeSync(u, ctx, it);
      edgeKick(u, ctx);
      edgeChanged(u, ctx);
    },
    tick: edgeTick,
    due: edgeDue,
    test: edgeTest,
    status: edgeStatus,
  };
  // Команда replicate шагом правила: камера забирает со своего встроенного хранилища или с диска регистратора
  camera.actions = {
    replicate(u, params, ctx) {
      const st = edgeStorageOf(u, ctx);
      if (!st) return { result: {} };
      edgeOrder(st, u, { period: params.period || "offline", minutes: params.minutes, beforeSec: params.beforeSec, afterSec: params.afterSec, archive: params.archive }, ctx);
      return { result: {} };
    },
  };

  const HOOKS = {
    "vms.domain/1": domain, "vms.server/1": server, "vms.folder/1": folder, "vms.archive/1": archive, "vms.volume/1": volume,
    "vms.camera/1": camera, "vms.stream/1": stream, "vms.detector/1": detector, "vms.acs/1": acs,
    "vms.live/1": live, "vms.ptz/1": ptz, "vms.talk/1": talk, "vms.timeline/1": timeline, "vms.pos/1": pos, "vms.edge/1": edge,
  };

  // DEVICE — хуки всех видов таблицы devices: сервер зовёт их первыми, затем хуки профилей вида
  const api = { HOOKS, DEVICE: device, flat, isProblem };
  if (typeof window !== "undefined") window.ConsolemProfiles = api;
  if (typeof module !== "undefined") module.exports = api;
})();
