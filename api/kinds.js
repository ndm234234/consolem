/* Реестр описаний видов (UnitKind) встроенного сервера (api/server.js): всё «данное» о виде — из описания, а не из кода.
   ConsolemKinds.create(kinds, profiles, { onPut(kind) }) — описания и профили набора (разделы kinds, profiles); onPut — после
   put нового описания (сервер переиндексирует склад по виду). Реестр отвечает:
   - list, get, etag (хэш описаний и профилей: GET /kinds, If-None-Match → 304), put (PUT /test/kinds/{kind} — меняет etag);
   - profileOf, implementers — профили вида (implements); parentsOk, creatable — родители (parents, createParents);
   - validate — свойства объекта против схемы вида: ошибки {field, code, params} с указателем /properties/…;
   - accessClass — класс доступа (UnitKind.access.class или код вида);
   - refsOf, refNames — ссылки x-ref; searchNames — свойства с x-search; secretNames — writeOnly; briefNames — для краткого
     объекта узла дерева (x-search и x-ui-filter); inheritNames — свойства с x-inherit; uniqueNames — с x-unique;
     unitSchema — схема объекта у вида со schemaPerUnit;
   - action — описание команды вида по коду (ActionDescriptor), documentKinds — виды с shape: document.
   Описание вида не меняется на месте: put кладёт новое. Незнакомые поля описания и ключи x-* реестр пропускает. */
(() => {
  const contract = () => (typeof window !== "undefined" && window.ConsolemContract) || null;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const hashOf = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  // JSON Merge Patch (RFC 7396): объекты сливаются, null удаляет поле, массивы и значения заменяются целиком
  function mergePatch(target, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
    const out = target && typeof target === "object" && !Array.isArray(target) ? clone(target) : {};
    Object.entries(patch).forEach(([key, value]) => {
      if (value === null) delete out[key];
      else out[key] = mergePatch(out[key], value);
    });
    return out;
  }
  const esc = (name) => String(name).replace(/~/g, "~0").replace(/\//g, "~1");
  const AT = "/properties";

  function create(kinds, profiles, hooks) {
    hooks = hooks || {};
    const map = new Map();
    (kinds || []).forEach((k) => map.set(k.kind, k));
    let profileList = profiles || [];
    let tag = null;
    // Выводное по виду — один раз на описание: put сбрасывает
    const memo = new Map();
    const props = (kind) => ((map.get(kind) || {}).schema || {}).properties || {};
    function derived(kind) {
      if (memo.has(kind)) return memo.get(kind);
      const p = props(kind);
      const names = (flag) => Object.keys(p).filter((n) => p[n] && p[n][flag]);
      // Ссылка — x-ref у свойства, у элемента массива или у свойства строки массива (extraArchives[].archiveId)
      const hasRef = (s) => !!s && (!!s["x-ref"] || hasRef(s.items) || Object.values(s.properties || {}).some(hasRef));
      const d = {
        search: names("x-search").filter((n) => !p[n].writeOnly),
        secrets: names("writeOnly"),
        brief: Object.keys(p).filter((n) => p[n] && (p[n]["x-search"] || p[n]["x-ui-filter"]) && !p[n].writeOnly),
        inherit: names("x-inherit"),
        unique: names("x-unique"),
        refs: new Set(Object.keys(p).filter((n) => hasRef(p[n]))),
      };
      memo.set(kind, d);
      return d;
    }

    // Ссылки объекта: [{uid, ref, name}] — значение, x-ref и имя свойства верхнего уровня. Идёт только по заданному
    function refsOf(unit) {
      const out = [];
      const k = map.get(unit.kind);
      if (!k || !unit.properties) return out;
      const p = props(unit.kind), refs = derived(unit.kind).refs;
      const walk = (schema, value, name) => {
        if (!schema || value == null) return;
        if (schema["x-ref"] && typeof value === "string") out.push({ uid: value, ref: schema["x-ref"], name });
        else if (Array.isArray(value)) value.forEach((x) => walk(schema.items, x, name));
        else if (typeof value === "object") Object.keys(value).forEach((key) => walk((schema.properties || {})[key], value[key], name));
      };
      refs.forEach((name) => walk(p[name], unit.properties[name], name));
      return out;
    }

    // Схема объекта у вида со schemaPerUnit: условие if решено по свойствам объекта, ветка слита со схемой. Части allOf
    // (независимые условия: драйвер камеры, «Активировать» у панорамы) решаются так же и сливаются; allOf в ответе нет
    function unitSchema(kind, properties) {
      const k = map.get(kind);
      if (!k) return null;
      const merge = (base, part) => {
        const out = Object.assign({}, base);
        Object.entries(part || {}).forEach(([key, v]) => {
          if (key === "properties") {
            out.properties = Object.assign({}, base.properties);
            Object.entries(v).forEach(([n, s]) => (out.properties[n] = Object.assign({}, out.properties[n], s)));
          } else if (key === "required") out.required = [...new Set((base.required || []).concat(v))];
          else out[key] = v;
        });
        return out;
      };
      const resolve = (schema) => {
        if (schema.allOf) {
          const { allOf: parts, ...rest } = schema;
          return resolve(parts.reduce((acc, part) => merge(acc, resolve(Object.assign({}, part))), rest));
        }
        if (!schema.if) return schema;
        const { if: cond, then: yes, else: no, ...rest } = schema;
        const fits = !contract() || !contract().validate(cond, properties || {}, "", {}).length;
        const branch = fits ? yes : no;
        return resolve(branch ? merge(rest, branch) : rest);
      };
      return resolve(clone(k.schema || { type: "object" }));
    }

    // Свойства против схемы вида. Правка JSON Merge Patch (partial) — в два прохода, как описано в contract.js: сама
    // правка с partial и направлением write (readOnly в правке — ошибка), затем слитое со старым целое без partial и без
    // направления — обязательность и if/then. readOnly целого — то, что уже было (его задаёт система): во втором проходе оно
    // остаётся, чтобы обязательное readOnly и условие if по нему решались по настоящим данным.
    // Плюс расширения: x-immutable — после создания не меняется; x-bound-to — смена поля требует нового секрета.
    // opts.secrets — заданные секреты (writeOnly): их значения хранятся не в свойствах, и в слитом целом их нет; для
    // обязательности они есть, пока правка их не снимает (null)
    function validate(kind, properties, opts) {
      opts = opts || {};
      const k = map.get(kind);
      if (!k) return [{ field: "/kind", code: "NOT_FOUND", params: { kind } }];
      const C = contract();
      const schema = k.schema || { type: "object" };
      const p = props(kind);
      const body = properties || {};
      if (!opts.partial) return C ? C.validate(schema, body, AT, { dir: "write" }) : [];
      const first = C ? C.validate(schema, body, AT, { dir: "write", partial: true }) : [];
      const old = opts.old || {};
      Object.keys(body).forEach((name) => {
        const s = p[name];
        if (!s) return;
        const same = JSON.stringify(old[name]) === JSON.stringify(body[name]);
        if (s["x-immutable"] && opts.old && !same) first.push({ field: `${AT}/${esc(name)}`, code: "VALIDATION_FAILED", params: { keyword: "x-immutable" } });
        const secret = s["x-bound-to"];
        if (secret && opts.old && !same && !(secret in body)) first.push({ field: `${AT}/${esc(secret)}`, code: "VALIDATION_FAILED", params: { keyword: "x-bound-to", field: name } });
      });
      if (first.length) return first;
      const kept = new Set((opts.secrets || []).filter((n) => body[n] !== null).map((n) => `${AT}/${esc(n)}`));
      return C ? C.validate(schema, mergePatch(old, body), AT, {}).filter((e) => !(e.params && e.params.keyword === "required" && kept.has(e.field))) : [];
    }

    return {
      list: () => [...map.values()],
      profiles: () => profileList,
      get: (kind) => map.get(kind) || null,
      etag() {
        if (!tag) tag = `"k${hashOf(JSON.stringify([[...map.values()], profileList])).toString(36)}"`;
        return tag;
      },
      // Новое описание вида. Ссылки x-ref могли измениться: склад, если он есть, переиндексирует объекты вида
      // (onPut — хук сервера: create(kinds, profiles, { onPut(kind) })). PUT /test/kinds/{kind} зовёт put
      put(desc) {
        map.set(desc.kind, desc);
        memo.clear();
        tag = null;
        if (hooks.onPut) hooks.onPut(desc.kind);
      },
      setProfiles(list) {
        profileList = list || [];
        tag = null;
      },
      profileOf: (kind, profile) => ((map.get(kind) || {}).implements || []).includes(profile),
      implementers: (profile) => [...map.values()].filter((k) => (k.implements || []).includes(profile)).map((k) => k.kind),
      parentsOk: (kind, parentKind) => ((map.get(kind) || {}).parents || []).includes(parentKind == null ? null : parentKind),
      // Виды, которые оператор создаёт под объектом этого вида (null — корень домена)
      creatable: (parentKind) => [...map.values()].filter((k) => (k.createParents || []).includes(parentKind == null ? null : parentKind)).map((k) => k.kind),
      validate,
      accessClass: (kind) => (((map.get(kind) || {}).access || {}).class) || kind,
      refsOf,
      refNames: (kind) => derived(kind).refs,
      searchNames: (kind) => derived(kind).search,
      secretNames: (kind) => derived(kind).secrets,
      briefNames: (kind) => derived(kind).brief,
      inheritNames: (kind) => derived(kind).inherit,
      uniqueNames: (kind) => derived(kind).unique,
      action: (kind, id) => (((map.get(kind) || {}).actions || []).find((a) => a.id === id)) || null,
      documentKinds: () => [...map.values()].filter((k) => k.shape === "document").map((k) => k.kind),
      unitSchema,
    };
  }

  const api = { create, mergePatch };
  if (typeof window !== "undefined") window.ConsolemKinds = api;
  if (typeof module !== "undefined") module.exports = api;
})();
