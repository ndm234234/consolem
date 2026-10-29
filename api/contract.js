/* Сверка значений со схемами контракта api/openapi.json (api/openapi.js). Ею пользуются встроенный
   сервер (тела запросов → 422 VALIDATION_FAILED), тесты API и самопроверка прототипа (ответы сервера).
   Подмножество JSON Schema, которым пользуется контракт: type (и списком, с null), properties, required,
   additionalProperties, items, enum, $ref, anyOf/oneOf, format, minimum/maximum, pattern, minLength, minItems. Поле, которого
   нет в схеме, — тоже расхождение: контракт описывает всё, что ходит по сети. */
(() => {
  const FORMATS = {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    date: /^\d{4}-\d\d-\d\d$/,
    "date-time": /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/,
  };
  const kindOf = (v) =>
    v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v === "number" ? "number" : typeof v;

  function check(spec, schema, value, where, out) {
    if (!schema || out.length > 40) return out;
    if (schema.$ref) return check(spec, spec.components.schemas[schema.$ref.split("/").pop()], value, where, out);
    const alts = schema.anyOf || schema.oneOf;
    if (alts) {
      if (alts.some((alt) => !check(spec, alt, value, where, []).length)) return out;
      const errs = check(spec, alts.find((a) => a.type !== "null") || alts[0], value, where, []);
      out.push(...(errs.length ? errs : [`${where}: не подходит ни под один вариант`]));
      return out;
    }
    const types = [].concat(schema.type || []);
    const kind = kindOf(value);
    if (types.length && !types.includes(kind) && !(kind === "integer" && types.includes("number"))) {
      out.push(`${where}: ${kind} вместо ${types.join("|")}`);
      return out;
    }
    if (schema.enum && !schema.enum.includes(value)) out.push(`${where}: ${JSON.stringify(value)} нет в перечислении`);
    if (kind === "string") {
      const re = FORMATS[schema.format];
      if (re && !re.test(value)) out.push(`${where}: ${JSON.stringify(value)} — не ${schema.format}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${where}: ${JSON.stringify(value)} не подходит под ${schema.pattern}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${where}: короче ${schema.minLength}`);
    }
    if (kind === "integer" || kind === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: ${value} меньше ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: ${value} больше ${schema.maximum}`);
    }
    if (kind === "array" && schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where}: меньше ${schema.minItems} элементов`);
    if (kind === "array" && schema.items) value.forEach((item, i) => check(spec, schema.items, item, `${where}[${i}]`, out));
    if (kind === "object") {
      const props = schema.properties || {};
      (schema.required || []).forEach((name) => {
        if (!(name in value)) out.push(`${where}: нет обязательного поля ${name}`);
      });
      const extra = schema.additionalProperties === undefined ? true : schema.additionalProperties;
      Object.entries(value).forEach(([name, v]) => {
        if (props[name]) check(spec, props[name], v, `${where}.${name}`, out);
        else if (extra === false) out.push(`${where}: поле ${name} не описано в контракте`);
        else if (typeof extra === "object") check(spec, extra, v, `${where}.${name}`, out);
      });
    }
    return out;
  }

  // Операция контракта по методу и пути запроса: шаблон с наименьшим числом параметров
  // (/operations/{id}/pause, а не /operations/{id})
  function operationOf(spec, method, path) {
    const bare = path.split("?")[0];
    let best = null;
    Object.entries(spec.paths).forEach(([template, item]) => {
      const op = item[method.toLowerCase()];
      if (!op) return;
      const names = (template.match(/\{\w+\}/g) || []).length;
      const re = new RegExp(`^${template.replace(/\{\w+\}/g, "[^/]+")}$`);
      if (re.test(bare) && (!best || names < best.names)) best = { template, op, names };
    });
    return best;
  }

  // Тело запроса против requestBody операции: список расхождений, пустой — подходит
  function requestProblems(spec, method, path, body) {
    const found = operationOf(spec, method, path);
    const schema = found && found.op.requestBody && found.op.requestBody.content["application/json"].schema;
    return schema ? check(spec, schema, body === undefined ? {} : body, "body", []) : [];
  }

  // Записанные ответы против схем: { method, template, status, body, kind: "http"|"stream" }
  function problems(spec, recorded) {
    const out = [];
    recorded.forEach((r) => {
      if (r.kind === "stream") {
        check(spec, { $ref: "#/components/schemas/StreamMessage" }, r.body, `поток ${r.body && r.body.type}`, out);
        return;
      }
      const item = spec.paths[r.template];
      const op = item && item[r.method.toLowerCase()];
      if (!op) return out.push(`${r.method} ${r.template}: нет в контракте`);
      const res = op.responses[String(r.status)] || op.responses.default;
      if (!res) return out.push(`${r.method} ${r.template}: код ${r.status} не описан`);
      const resolved = res.$ref ? spec.components.responses[res.$ref.split("/").pop()] : res;
      const content = resolved.content;
      if (!content) {
        if (r.body !== null && r.body !== undefined && r.body !== "") out.push(`${r.method} ${r.template} ${r.status}: тело есть, а в контракте его нет`);
        return;
      }
      const schema = (content["application/json"] || content["application/problem+json"] || {}).schema;
      check(spec, schema, r.body, `${r.method} ${r.template} ${r.status}`, out);
      if (resolved.headers && resolved.headers.ETag && !(r.headers || {}).etag) out.push(`${r.method} ${r.template} ${r.status}: нет заголовка ETag`);
    });
    return out;
  }

  window.ConsolemContract = { check, operationOf, requestProblems, problems };
})();
