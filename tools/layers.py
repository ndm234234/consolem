#!/usr/bin/env python3
"""Слои контракта: что в api/openapi.json делает каждый бэкенд (механизм), а что нужно только тому,
кто объявил профиль подсистемы.

Слой пишется расширением x-layer:
  - у схемы components.schemas.<Имя> целиком;
  - у пути paths.<путь> целиком;
  - у поля общей (непомеченной) схемы — в KNOWN_LEAKS, пока поле не вынесут в схему вида (часть 04 вынесла справочники
    reference; остальное — после части 04, решение владельца).
Значение — id профиля из набора (vms.pos/1…), «video» (просмотр, архив, выгрузка — будущий API видео)
или «vms» (часть VMS без своего профиля). Нет пометки — механизм.

Модуль статический: читает контракт и файлы профилей, git не трогает. Клиент пропускает x-layer, как
любой ключ x-*. Проверку границы вызывает tools/check_api.py, проверку самого модуля —
tools/check_layers.py.
"""
import json
import os
import re

import profile_files

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LAYER_EXTRA = ("video", "vms")
DEFAULT_OWNER = "mockup"
DEFAULT_REVIEWERS = ["w2c"]

# Поля подсистем в общих схемах: путь поля (как в check_api.schema_removed) → кто его выносит.
# Список только сокращается, как PENDING в check_api.py: новое поле подсистемы в общей схеме — не сюда,
# а в схему вида.
KNOWN_LEAKS = {
    "AssistEvent.export": "API видео",
    "AssistFoundFilter.noDetector": "после части 04",
    "AssistFoundFilter.noRecord": "после части 04",
    "Me.serverId": "0.39.0: сервер сессии, пробел F85",
    "RuleTrigger.match.detector": "после части 04",
    "TestEventRequest.eventId": "после части 04",
    "TestEventRequest.status": "после части 04",
    "TestEventRequest.type": "после части 04",
    "UnitKind.x-archive": "после части 04",
    "UnitMoveRequest.params": "после части 04",
    "UnitStatus.observed.replicaLagSec": "после части 04",
    "UnitStatus.observed.replicationStatus": "после части 04",
    "UnitStatus.observed.webCertificate": "после части 04",
    "UnitStatus.observed.webReservedPorts": "после части 04",
}

# Поля общих схем, где id профиля в описании — пример, а не поле подсистемы: путь поля → почему.
EXAMPLE_MENTIONS = {
    "Profile": "описание схемы называет профиль как пример",
    "Profile.id": "id профиля в описании — пример записи",
    "UnitKind": "описание схемы называет профили как пример",
    "UnitKind.implements": "id профиля в описании — пример значения",
    "UnitKind.apiRights": "id профиля в описании — пример значения",
}

# id профиля в описании: профили подсистемы vms.* и профили механизма core.* (с 0.28.0: core.domain/1, core.folder/1)
_PROFILE_MENTION = re.compile(r"\b(?:vms|core)\.[a-z][a-z0-9]*/\d+")
_VARIANTS = ("anyOf", "oneOf", "allOf")


def _abs(rel):
    return rel if os.path.isabs(rel) else os.path.join(ROOT, rel)


def _load(rel):
    """JSON-файл; None — файла нет. Сломанный файл — ValueError с его именем: молчаливое умолчание скрыло бы ошибку."""
    path = _abs(rel)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except ValueError as e:
        raise ValueError(f"{rel}: не читается как JSON — {e}") from e


def profile_file(pid, api_dir="api"):
    """«vms.camera/1» → «<api_dir>/profiles/vms.camera.json»; старшая N ≥ 2 лежит рядом:
    «vms.camera/2» → «<api_dir>/profiles/vms.camera.2.json» (profile_files.file_name)."""
    return f"{api_dir}/profiles/{profile_files.file_name(pid)}"


def profile_ids(api_dir="api"):
    """id профилей: из demo.json (profiles) и из файлов api/profiles/*.json, если они есть."""
    ids = set()
    demo = _load(f"{api_dir}/fixtures/demo.json") or {}
    ids.update(p["id"] for p in demo.get("profiles", []) if isinstance(p, dict) and "id" in p)
    folder = _abs(f"{api_dir}/profiles")
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            if name.endswith(".json"):
                data = _load(f"{api_dir}/profiles/{name}")
                if isinstance(data, dict) and "id" in data:
                    ids.add(data["id"])
    return ids


def owner_of(pid, api_dir="api"):
    data = _load(profile_file(pid, api_dir))
    return data["owner"] if isinstance(data, dict) and data.get("owner") else DEFAULT_OWNER


def reviewers_of(pid, api_dir="api"):
    data = _load(profile_file(pid, api_dir))
    if isinstance(data, dict) and isinstance(data.get("reviewers"), list):
        return list(data["reviewers"])
    return list(DEFAULT_REVIEWERS)


def layer_of_schema(spec, name):
    """Слой схемы components.schemas.<name>; None — механизм (или схемы нет)."""
    return ((spec.get("components") or {}).get("schemas") or {}).get(name, {}).get("x-layer")


def layer_of_path(spec, path):
    """Слой пути paths.<path>; None — механизм (или пути нет)."""
    return (spec.get("paths") or {}).get(path, {}).get("x-layer")


def _children(node, path):
    """Узлы схемы под node с путём поля: properties — .имя, items — [], additionalProperties — {}, варианты — |N."""
    for k, v in (node.get("properties") or {}).items():
        yield f"{path}.{k}", v
    if isinstance(node.get("items"), dict):
        yield path + "[]", node["items"]
    if isinstance(node.get("additionalProperties"), dict):
        yield path + "{}", node["additionalProperties"]
    for key in _VARIANTS:
        for i, v in enumerate(node.get(key) or []):
            yield f"{path}|{i}", v


class _Scan:
    """Один обход контракта: пометки полей, упоминания профилей в описаниях, ссылки механизма на подсистему."""

    def __init__(self, spec, valid):
        self.valid = valid
        self.schemas = (spec.get("components") or {}).get("schemas") or {}
        self.marked = {n: s["x-layer"] for n, s in self.schemas.items() if isinstance(s, dict) and "x-layer" in s}
        self.allowed = set()      # id() узлов, где x-layer стоит законно (S1)
        self.leaks = {}           # путь поля → слой (пометки внутри непомеченных схем)
        self.mentions = set()     # пути полей, в описании которых есть id профиля
        self.problems = []
        self._mark(spec)

    def _value(self, where, node):
        self.allowed.add(id(node))
        v = node["x-layer"]
        if not isinstance(v, str) or v not in self.valid:
            self.problems.append(f"{where}: x-layer {v} — нет такого профиля")

    def _mark(self, spec):
        for name, schema in self.schemas.items():
            if not isinstance(schema, dict):
                continue
            if "x-layer" in schema:
                self._value(name, schema)
            else:
                self._field(schema, name, True)
        for path, item in (spec.get("paths") or {}).items():
            if not isinstance(item, dict):
                continue
            if "x-layer" in item:
                self._value(path, item)
                continue
            self._refs(item.get("parameters"), path)
            for method, op in item.items():
                if method in ("get", "put", "post", "delete", "patch", "options", "head", "trace"):
                    self._refs(op, f"{method.upper()} {path}")
        for group, items in (spec.get("components") or {}).items():
            if group != "schemas" and isinstance(items, dict):
                for name, node in items.items():
                    self._refs(node, f"components.{group}.{name}")

    def _field(self, node, path, root=False):
        """Узел непомеченной схемы: пометка поля, ссылка на схему подсистемы, id профиля в описании, вглубь."""
        if not isinstance(node, dict):
            return
        if not root and "x-layer" in node:
            self._value(path, node)
            self.leaks[path] = node["x-layer"]
            return
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.rsplit("/", 1)[-1] in self.marked:
            self._ref_problem(path, ref.rsplit("/", 1)[-1])
        desc = node.get("description")
        if isinstance(desc, str) and _PROFILE_MENTION.search(desc):
            self.mentions.add(path)
            if path not in EXAMPLE_MENTIONS:
                self.problems.append(f"{path}: в описании {_PROFILE_MENTION.search(desc).group(0)} — пометь поле x-layer или внеси в EXAMPLE_MENTIONS")
        for child_path, child in _children(node, path):
            self._field(child, child_path)

    def _refs(self, node, where):
        """Путь или раздел components механизма: любой $ref на схему подсистемы — отказ."""
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.rsplit("/", 1)[-1] in self.marked:
                self._ref_problem(where, ref.rsplit("/", 1)[-1])
            for v in node.values():
                self._refs(v, where)
        elif isinstance(node, list):
            for v in node:
                self._refs(v, where)

    def _ref_problem(self, where, name):
        self.problems.append(f"{where} ссылается на схему подсистемы {name} (x-layer {self.marked[name]}): вынеси поле в схему вида или пометь его x-layer")


def _scan(spec, ids):
    return _Scan(spec, set(ids) | set(LAYER_EXTRA))


def leak_marks(spec):
    """Пометки x-layer внутри непомеченных схем: путь поля (Схема.поле.подполе, [] — items, {} — additionalProperties,
    |N — вариант anyOf/oneOf/allOf) → слой."""
    return dict(_scan(spec, set()).leaks)


def _unplaced(node, where, allowed, out, names=False):
    """S1: любой x-layer (какого угодно типа) вне допустимых мест. names — node это перечень properties: его ключи — имена полей."""
    if isinstance(node, dict):
        if not names and "x-layer" in node and id(node) not in allowed:
            out.append(f"{where}: x-layer только у схемы, пути или поля общей схемы")
        for k, v in node.items():
            _unplaced(v, f"{where}.{k}" if where else k, allowed, out, names=(k == "properties" and isinstance(v, dict) and not names))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _unplaced(v, f"{where}[{i}]", allowed, out)


def static_problems(spec, ids):
    """Границу слоёв проверяет по контракту: S1 — где стоит x-layer, S2 — значение, S3 — механизм не ссылается
    на подсистему, S4 — пометки полей = KNOWN_LEAKS, S5 — id профиля в описании поля общей схемы.
    Пустой список — граница цела."""
    scan = _scan(spec, ids)
    out = list(scan.problems)
    _unplaced(spec, "", scan.allowed, out)
    for path in sorted(set(scan.leaks) - set(KNOWN_LEAKS)):
        out.append(f"{path}: новое поле подсистемы в общей схеме — его нет в KNOWN_LEAKS")
    for path in sorted(set(KNOWN_LEAKS) - set(scan.leaks)):
        out.append(f"{path}: в KNOWN_LEAKS, а пометки нет — убери из KNOWN_LEAKS")
    for path in sorted(set(EXAMPLE_MENTIONS) - scan.mentions):
        out.append(f"{path}: в EXAMPLE_MENTIONS, а id профиля в описании нет — убери из EXAMPLE_MENTIONS")
    return out


# ── таблица версий по слоям ──

_VERSION = r"\d+\.\d+\.\d+"
_README_VERSION = re.compile(rf"^## (?:Что добавлено|Ломающие изменения) в ({_VERSION})\s*$", re.M)
_ROW = re.compile(rf"^\|\s*({_VERSION})\s*\|(.*)$", re.M)


def versions_table_problems(readme, table_md, current, ids):
    """Таблица docs/contract-layers/versions-by-layer.md: строка у каждой версии README и у текущей,
    в столбце «Слой» — «механизм» или значение x-layer в обратных кавычках (id профиля из ids, video, vms)."""
    problems = []
    want = set(_README_VERSION.findall(readme)) | {current}
    rows = {}
    for m in _ROW.finditer(table_md):
        ver, cells = m.group(1), [c.strip() for c in m.group(2).split("|")]
        if ver in rows:
            problems.append(f"версия {ver}: строка есть дважды")
        if len(cells) < 3:
            problems.append(f"версия {ver}: в строке меньше четырёх столбцов")
            continue
        rows[ver] = cells[1]
    for ver in sorted(want - rows.keys(), key=lambda v: [int(x) for x in v.split(".")]):
        problems.append(f"версия {ver}: нет строки в таблице версий по слоям")
    for ver in sorted(rows.keys() - want, key=lambda v: [int(x) for x in v.split(".")]):
        problems.append(f"версия {ver}: строка есть, а раздела в api/README.md и текущей версии с таким номером нет")
    for ver, layer in rows.items():
        for tok in (t.strip() for t in layer.split(";")):
            val = tok[1:-1] if len(tok) > 2 and tok.startswith("`") and tok.endswith("`") else None
            if tok == "механизм" or val in LAYER_EXTRA or val in ids:
                continue
            if val is not None:
                problems.append(f"версия {ver}: слой `{val}` — нет такого профиля, video и vms")
            else:
                problems.append(f"версия {ver}: слой «{tok}» — нужно «механизм» или значение x-layer в обратных кавычках")
    return problems


# ── слои правки против origin/main ──
# Классификатор читает git: чем рабочая папка (или коммит head) отличается от общего предка с base.
# Чистые функции classify_specs и classify_fixture работают с уже прочитанными словарями.

import subprocess
import sys

MECHANISM_FILES = ("api/server.js", "api/units.js", "api/kinds.js", "api/rule-engine.js", "api/contract.js", "api/client.js")
GENERATED = ("api/openapi.js", "api/fixture.js", "api/fixtures/one-domain.json", "api/fixtures/large.json", "api/fixtures/xl.json")
OWNER_ADDRESS = "владелец контракта"
SUBSYSTEM_NOTE = "api/profiles.js — назови профиль в уведомлении"
_TEXT_KEYS = ("description", "summary", "example", "examples")
_METHODS = ("get", "put", "post", "delete", "patch", "options", "head", "trace")
_TOKEN = re.compile(r"\.([^.\[\]{}|]+)|(\[\])|(\{\})|\|(\d+)")


def git_out(root, *args):
    """Вывод git (без перевода строки в конце) или None, если git нет или команда не прошла."""
    try:
        res = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, encoding="utf-8")
    except OSError:
        return None
    return res.stdout if res.returncode == 0 else None


def merge_base(base, root, head):
    out = git_out(root, "merge-base", head or "HEAD", base)
    return out.strip() if out and out.strip() else None


def changed_files(base, root, head=None):
    """Файлы, которые правка меняет против общего предка head (или HEAD) и base. Без head — ещё новые файлы
    api/ и tests/, которых нет в git. None — нет git или ссылки."""
    mb = merge_base(base, root, head)
    if mb is None:
        return None
    args = ["diff", "--name-only", mb] + ([head] if head else [])
    out = git_out(root, *args)
    if out is None:
        return None
    files = [l for l in out.splitlines() if l]
    if not head:
        extra = git_out(root, "ls-files", "--others", "--exclude-standard", "api", "tests")
        files += [l for l in (extra or "").splitlines() if l and l not in files]
    return files


def _json_at(root, rev, rel):
    """JSON файла в коммите rev; {} — файла там нет или он не читается."""
    out = git_out(root, "show", f"{rev}:{rel}")
    try:
        return json.loads(out) if out else {}
    except ValueError:
        return {}


def _json_work(root, rel):
    path = os.path.join(root, rel)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _strip(node, names=False, keys=_TEXT_KEYS):
    """Копия без ключей keys (по умолчанию description, summary, example, examples). names — node это перечень
    properties: его ключи — имена полей."""
    if isinstance(node, dict):
        return {k: _strip(v, k == "properties" and not names and isinstance(v, dict), keys) for k, v in node.items()
                if names or k not in keys}
    if isinstance(node, list):
        return [_strip(v, False, keys) for v in node]
    return node


def _nox(node):
    """Копия без пометок x-layer."""
    return _strip(node, False, ("x-layer",))


def _node_at(schema, path):
    """Узел схемы по пути поля (leak_marks: .имя, [] — items, {} — additionalProperties, |N — вариант); None — нет."""
    node = schema
    for m in _TOKEN.finditer(path):
        if not isinstance(node, dict):
            return None
        name, items, addl, var = m.groups()
        if name is not None:
            node = (node.get("properties") or {}).get(name)
        elif items:
            node = node.get("items")
        elif addl:
            node = node.get("additionalProperties")
        else:
            variants = [v for k in _VARIANTS for v in (node.get(k) or [])]
            node = variants[int(var)] if int(var) < len(variants) else None
    return node


def _without(schema, paths):
    """Копия схемы, где узлы по путям paths заменены пустыми."""
    out = copy_deep(schema)
    for p in paths:
        ms = list(_TOKEN.finditer(p))
        parent = _node_at(out, p[:ms[-1].start()]) if len(ms) > 1 else out
        if not isinstance(parent, dict) or not ms:
            continue
        name, items, addl, var = ms[-1].groups()
        # узел заменяем и там, где его нет: снятое поле не должно считаться правкой остальной схемы
        if name is not None:
            parent.setdefault("properties", {})[name] = {}
        elif items:
            parent["items"] = {}
        elif addl:
            parent["additionalProperties"] = {}
    return out


def copy_deep(x):
    return json.loads(json.dumps(x))


def _add(bucket, key, text):
    bucket.setdefault(key, [])
    if text not in bucket[key]:
        bucket[key].append(text)


def classify_specs(old, new, marks):
    """Две версии api/openapi.json → {"mechanism": [...], "layers": {слой: [...]}, "descriptions": [...]}.
    marks — спецификация, по которой ищут x-layer. Схема или путь с пометкой — слой пометки; без неё — механизм;
    изменились только описания и примеры — descriptions."""
    mech, lay, desc, marked = [], {}, [], []
    # слой снятого имени есть только в старой спецификации: ищем в новой, потом в старой, потом в рабочей
    order = (new, old, marks)
    leaks = {**leak_marks(marks), **leak_marks(old), **leak_marks(new)}

    def of_schema(name):
        return next((l for l in (layer_of_schema(sp, name) for sp in order) if l), None)

    def of_path(path):
        return next((l for l in (layer_of_path(sp, path) for sp in order) if l), None)

    def put(layer, text):
        if layer:
            _add(lay, layer, text)
        elif text not in mech:
            mech.append(text)

    osch = (old.get("components") or {}).get("schemas") or {}
    nsch = (new.get("components") or {}).get("schemas") or {}
    for name in sorted(set(osch) | set(nsch)):
        a, b = osch.get(name), nsch.get(name)
        layer = of_schema(name)
        if a is None or b is None:
            put(layer, f"{'+' if a is None else '-'} схема {name}")
            continue
        if a == b:
            continue
        if _nox(a) == _nox(b):
            marked.append(f"схема {name}")
            continue
        mine = sorted(p for p in leaks if p.split(".")[0] == name and p.startswith(name + "."))
        rest_a, rest_b = (_without(a, [p[len(name):] for p in mine]), _without(b, [p[len(name):] for p in mine])) if mine else (a, b)
        for p in mine:
            fa, fb = _node_at(a, p[len(name):]), _node_at(b, p[len(name):])
            if fa != fb:
                if _nox(fa) == _nox(fb):
                    marked.append(f"поле {p}")
                elif _strip(fa) == _strip(fb):
                    desc.append(f"поле {p}")
                else:
                    _add(lay, leaks[p], f"~ поле {p}")
        if rest_a == rest_b:
            continue
        if _strip(rest_a) == _strip(rest_b):
            desc.append(f"схема {name}")
        else:
            put(layer, f"~ схема {name}")

    opaths, npaths = old.get("paths") or {}, new.get("paths") or {}
    for path in sorted(set(opaths) | set(npaths)):
        a, b = opaths.get(path), npaths.get(path)
        layer = of_path(path)
        if a is None or b is None:
            put(layer, f"{'+' if a is None else '-'} путь {path}")
        elif a != b:
            if _nox(a) == _nox(b):
                marked.append(f"путь {path}")
            elif _strip(a) == _strip(b):
                desc.append(f"путь {path}")
            else:
                put(layer, f"~ путь {path}")

    oc, nc = old.get("components") or {}, new.get("components") or {}
    for group in sorted((set(oc) | set(nc)) - {"schemas"}):
        if oc.get(group) != nc.get(group):
            if _strip(oc.get(group)) == _strip(nc.get(group)):
                desc.append(f"components.{group}")
            else:
                put(None, f"~ components.{group}")
    skip = {"paths", "components", "info"}
    for key in sorted((set(old) | set(new)) - skip):
        if old.get(key) != new.get(key):
            put(None, f"~ {key}")
    oi, ni = dict(old.get("info") or {}), dict(new.get("info") or {})
    for i in (oi, ni):
        i.pop("version", None)
    if oi != ni:
        if _strip(oi) == _strip(ni):
            desc.append("info")
        else:
            put(None, "~ info")
    return {"mechanism": mech, "layers": lay, "descriptions": desc, "marks": marked}


def _by(items, key):
    return {x[key]: x for x in items if isinstance(x, dict) and key in x} if isinstance(items, list) else {}


def classify_fixture(old, new, spec, api_dir):
    """Две версии api/fixtures/demo.json → {"layers": {...}, "kinds": [...], "stand": [...]}.
    Свойство вида, которое есть в properties или status профиля из implements, — слой профиля; иначе — только вид.
    Справочник — слой пометки Reference.<ключ> в spec; без пометки и прочие разделы — стенд."""
    lay, kinds, stand = {}, [], []
    profs = {**_by(old.get("profiles"), "id"), **_by(new.get("profiles"), "id")}
    for pid in sorted(set(_by(old.get("profiles"), "id")) | set(_by(new.get("profiles"), "id"))):
        if _by(old.get("profiles"), "id").get(pid) != _by(new.get("profiles"), "id").get(pid):
            _add(lay, pid, f"профиль {pid}")
    ok_, nk = _by(old.get("kinds"), "kind"), _by(new.get("kinds"), "kind")
    if not isinstance(old.get("kinds", []), list) or not isinstance(new.get("kinds", []), list):
        if old.get("kinds") != new.get("kinds"):
            kinds.append("kinds: другой формат")
    for kind in sorted(set(ok_) | set(nk)):
        a, b = ok_.get(kind), nk.get(kind)
        if a == b:
            continue
        if a is None or b is None:
            kinds.append(f"{'+' if a is None else '-'} вид {kind}")
            continue
        implements = list(dict.fromkeys((b.get("implements") or []) + (a.get("implements") or [])))
        pa = (a.get("schema") or {}).get("properties") or {}
        pb = (b.get("schema") or {}).get("properties") or {}
        for prop in sorted(set(pa) | set(pb)):
            if pa.get(prop) == pb.get(prop):
                continue
            owners = [pid for pid in implements if prop in (profs.get(pid, {}).get("properties") or []) + (profs.get(pid, {}).get("status") or [])]
            if owners:
                for pid in owners:
                    _add(lay, pid, f"вид {kind}: свойство {prop}")
            else:
                kinds.append(f"вид {kind}: свойство {prop} — вне профилей")
        rest = [k for k in sorted(set(a) | set(b)) if k != "schema" and a.get(k) != b.get(k)]
        if (_strip({k: v for k, v in a.items() if k != "schema"}) != _strip({k: v for k, v in b.items() if k != "schema"})):
            kinds.append(f"вид {kind}: {', '.join(rest)}")
        sa = {k: v for k, v in (a.get("schema") or {}).items() if k != "properties"}
        sb = {k: v for k, v in (b.get("schema") or {}).items() if k != "properties"}
        if _strip(sa) != _strip(sb):
            kinds.append(f"вид {kind}: schema")
    leaks = leak_marks(spec)
    oref, nref = old.get("reference") or {}, new.get("reference") or {}
    for key in sorted(set(oref) | set(nref)):
        a, b = oref.get(key), nref.get(key)
        if a == b:
            continue
        sub = [p for p in leaks if p.startswith(f"Reference.{key}.")]
        if f"Reference.{key}" in leaks:
            _add(lay, leaks[f"Reference.{key}"], f"справочник {key}")
        elif sub and isinstance(a, dict) and isinstance(b, dict):
            for s in sorted(set(a) | set(b)):
                if a.get(s) != b.get(s):
                    layer = leaks.get(f"Reference.{key}.{s}")
                    if layer:
                        _add(lay, layer, f"справочник {key}.{s}")
                    else:
                        stand.append(f"справочник {key}.{s} — данные справочника механизма")
        else:
            stand.append(f"справочник {key} — данные справочника механизма")
    for key in sorted((set(old) | set(new)) - {"kinds", "profiles", "reference"}):
        if old.get(key) != new.get(key):
            stand.append(f"раздел {key}")
    return {"layers": lay, "kinds": kinds, "stand": stand}


def _merge(dst, src):
    for k, v in src.items():
        for t in v:
            _add(dst, k, t)


def _notify(mechanism, lay, api_dir, marks=()):
    out = {}
    if marks:
        _add(out, OWNER_ADDRESS, "пометки")
    if mechanism:
        _add(out, OWNER_ADDRESS, "механизм")
    for layer in lay:
        if "/" in layer:
            for who in reviewers_of(layer, api_dir):
                _add(out, who, layer)
        else:
            _add(out, OWNER_ADDRESS, layer)
    return out


def classify(base="origin/main", root=ROOT, api_dir="api", head=None):
    """Слои правки: рабочая папка (или head) против общего предка с base. None — нет git или ссылки.
    Ответ: base (sha общего предка), files, mechanism, layers (все слои правки), contract_layers (слои, которые
    задела правка openapi.json: ей нужна новая версия контракта), file_layers (слои из остальных файлов:
    профили, demo.json, profiles.js: у них своя версия), kinds, stand, descriptions, marks (схемы и пути,
    где изменился только x-layer), version, notify."""
    files = changed_files(base, root, head)
    if files is None:
        return None
    mb = merge_base(base, root, head)
    new_of = (lambda rel: _json_at(root, head, rel)) if head else (lambda rel: _json_work(root, rel))
    mechanism, lay, kinds, stand, desc, marks_only = [], {}, [], [], [], []
    contract_mech = []  # механизм из правок openapi.json: ему нужна новая версия контракта
    contract_lay, file_lay = {}, {}  # слои из правок openapi.json; слои из остальных файлов (профили, demo.json, profiles.js)
    version = (None, None)
    skip = set(GENERATED)
    for rel in files:
        if rel in skip or rel.startswith("api/requests/"):
            continue
        prof = re.fullmatch(rf"{re.escape(api_dir)}/profiles/([^/]+)\.json", rel)
        if prof and prof.group(1).upper() != "README":
            # id профиля — поле id его файла; нет файла или он не читается — demo.json; иначе <имя>/1
            own = new_of(rel)
            pid = own.get("id") if isinstance(own, dict) and isinstance(own.get("id"), str) else None
            if pid is None:
                ids = [p["id"] for p in (new_of(f"{api_dir}/fixtures/demo.json").get("profiles") or []) if isinstance(p, dict) and "id" in p]
                pid = next((i for i in ids if profile_files.file_name(i) == prof.group(1) + ".json"), profile_files.id_of_file(prof.group(1) + ".json"))
            _add(lay, pid, rel)
            _add(file_lay, pid, rel)
        elif rel.startswith(f"{api_dir}/profiles/"):
            continue  # README.md и прочее, что не файл профиля
        elif rel in MECHANISM_FILES:
            mechanism.append(rel)
        elif rel == "api/profiles.js":
            _add(lay, "подсистема", SUBSYSTEM_NOTE)
            _add(file_lay, "подсистема", SUBSYSTEM_NOTE)
        elif rel == f"{api_dir}/openapi.json":
            old, new = _json_at(root, mb, rel), new_of(rel)
            version = ((old.get("info") or {}).get("version"), (new.get("info") or {}).get("version"))
            marks = copy_deep(_json_work(root, rel) or new)
            msch = marks.setdefault("components", {}).setdefault("schemas", {})
            for n, sch in ((new.get("components") or {}).get("schemas") or {}).items():
                if isinstance(sch, dict) and "x-layer" in sch:
                    msch.setdefault(n, {})["x-layer"] = sch["x-layer"]
            for p, item in (new.get("paths") or {}).items():
                if isinstance(item, dict) and "x-layer" in item:
                    marks.setdefault("paths", {}).setdefault(p, {})["x-layer"] = item["x-layer"]
            c = classify_specs(old, new, marks)
            mechanism += [m for m in c["mechanism"] if m not in mechanism]
            contract_mech += c["mechanism"]
            _merge(lay, c["layers"])
            _merge(contract_lay, c["layers"])
            desc += c["descriptions"]
            marks_only += c["marks"]
        elif rel == f"{api_dir}/fixtures/demo.json":
            spec = _json_work(root, f"{api_dir}/openapi.json") or {}
            c = classify_fixture(_json_at(root, mb, rel), new_of(rel), spec, api_dir)
            _merge(lay, c["layers"])
            _merge(file_lay, c["layers"])
            kinds += c["kinds"]
            stand += c["stand"]
        elif rel.startswith(f"{api_dir}/fixtures/") and rel.endswith(".json"):
            stand.append(f"файл {rel} — набор стенда, слой не определён")
    return {"base": mb, "files": files, "mechanism": mechanism, "layers": lay, "contract_layers": contract_lay,
            "contract_mechanism": contract_mech,
            "file_layers": file_lay, "kinds": kinds, "stand": stand,
            "descriptions": desc, "marks": marks_only, "version": version, "notify": _notify(mechanism, lay, os.path.join(root, api_dir), marks_only)}


def version_problems(cls, profiles_active):
    """V1: механизм или openapi.json (путь, схема профиля) изменён, а версия контракта та же. V2 (только при
    profiles_active): версию контракта подняла правка подсистемы вне openapi.json (файл профиля, demo.json)
    без механизма и без правки openapi.json — у подсистемы своя версия в файле профиля."""
    old, new = cls.get("version") or (None, None)
    same = old == new
    mech = cls["contract_mechanism"] if "contract_mechanism" in cls else (cls.get("mechanism") or [])
    contract = cls.get("contract_layers") or {}
    lay = cls["file_layers"] if "file_layers" in cls else (cls.get("layers") or {})
    out = []
    if mech and same:
        out.append(f"механизм изменён без новой версии контракта: {'; '.join(mech)}")
    if contract and same:
        out.append(f"openapi.json изменён без новой версии контракта (слой {', '.join(contract)}): правка пути или схемы профиля поднимает версию контракта")
    if profiles_active and not same and lay and not (cls.get("mechanism") or mech) and not contract:
        out.append(f"версию контракта подняла правка подсистемы ({', '.join(lay)}): у неё своя версия — version в файле профиля")
    return out


def version_notes(cls):
    """Строки INFO: правка файлов механизма (server.js…) без правки openapi.json и без новой версии — не отказ
    (решение владельца 2026-11-18), владелец контракта получает уведомление."""
    old, new = cls.get("version") or (None, None)
    files = [m for m in cls.get("mechanism") or [] if m in MECHANISM_FILES]
    if files and old == new:
        return [f"правка файлов механизма без правки openapi.json — версия контракта не нужна: {', '.join(files)}"]
    return []


def version_text(cls):
    old, new = cls.get("version") or (None, None)
    if old is None or new is None or old == new:
        return "версия не менялась"
    return f"версия контракта: {old} → {new}"


def format_report(cls):
    lines = [f"общий предок {cls['base'][:10]}, файлов: {len(cls['files'])}, {version_text(cls)}"]
    for title, items in (("механизм", cls["mechanism"]), ("вид вне профилей", cls["kinds"]), ("стенд", cls["stand"]),
                         ("только описания", cls["descriptions"])):
        if items:
            lines.append(f"{title}: {len(items)}")
            lines += [f"  {s}" for s in items]
    if cls["marks"]:
        lines.append(f"только пометки x-layer: {len(cls['marks'])}")
        lines += [f"  {s}" for s in cls["marks"]]
    for layer, items in cls["layers"].items():
        lines.append(f"слой {layer}: {len(items)}")
        lines += [f"  {s}" for s in items]
    for who, what in cls["notify"].items():
        lines.append(f"уведомить {who}: {', '.join(what)}")
    return "\n".join(lines)


def main(argv=None):
    """python3 tools/layers.py [--base REF] [--head REF] [--api DIR]: печатает разбор и адресатов; код 1 — version_problems."""
    argv = list(sys.argv[1:] if argv is None else argv)
    opts = {"--base": "origin/main", "--head": None, "--api": "api"}
    while argv:
        k = argv.pop(0)
        if k not in opts or not argv:
            print(f"неизвестный параметр {k}; можно --base REF, --head REF, --api DIR")
            return 2
        opts[k] = argv.pop(0)
    cls = classify(opts["--base"], ROOT, opts["--api"], opts["--head"])
    if cls is None:
        print(f"нет git или ссылки {opts['--base']} — разбор пропущен")
        return 0
    if not cls["files"]:
        print("нет правок")
        return 0
    print(format_report(cls))
    active = os.path.isdir(_abs(f"{opts['--api']}/profiles")) and any(n.endswith(".json") for n in os.listdir(_abs(f"{opts['--api']}/profiles")))
    problems = version_problems(cls, active)
    for n in version_notes(cls):
        print("INFO " + n)
    for p in problems:
        print("ОТКАЗ " + p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
