#!/usr/bin/env python3
"""Самопроверка модуля файлов профиля (tools/profile_files.py): разбор версий, формат одного файла,
запись профиля для GET /kinds, тип словами и таблица для людей.

Каждая порча — копия образца GOOD с одной правкой. Запуск из корня репозитория:
  python3 tools/check_profile_files.py
Код выхода 1, если хоть одна проверка не прошла.
"""
import copy
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from profile_files import (load_profiles, major_of, parse_version, profile_name, profile_problems,  # noqa: E402
                           profile_wire, render_md, type_text)

failed = 0


def ok(cond, what):
    global failed
    print(("PASS " if cond else "FAIL ") + what)
    if not cond:
        failed += 1


def raises(exc, fn, *args):
    try:
        fn(*args)
    except exc:
        return True
    return False


def says(problems, word):
    return any(word in p for p in problems)


GOOD = {
    "id": "vms.camera/1", "version": "1.5", "label": "Камера", "owner": "mockup", "reviewers": ["w2c"],
    "uses": [{"id": "vms.archive/1", "version": "1.0"}],
    "properties": {
        "archiveId": {"schema": {"type": ["string", "null"], "x-ref": {"implements": ["vms.archive/1"]}},
                      "meaning": "Архив, в который камера пишет видео.", "since": "1.0"},
        "privacyMasks": {"schema": {"type": "array", "maxItems": 16, "items": {"type": "object"}},
                         "meaning": "Маски приватности: до 16 зон.", "since": "1.3"},
    },
    "status": {"recordState": {"schema": {"type": "string", "enum": ["off", "on"]},
                               "meaning": "Идёт ли запись.", "since": "1.0"}},
    "apis": ["recording-target", "recording-days"],
    "changes": [{"version": "1.5", "what": "Описание поля archiveId уточнено."},
                {"version": "1.3", "what": "Добавлено поле privacyMasks."},
                {"version": "1.0", "what": "Профиль перенесён в файл."}],
    "_file": "vms.camera.json",
}


def bad(**kw):
    d = copy.deepcopy(GOOD)
    d.update(kw)
    return d


def bad_prop(name, **kw):
    d = copy.deepcopy(GOOD)
    d["properties"][name].update(kw)
    return d


ok(parse_version("1.5") == (1, 5) and parse_version("1.10") > parse_version("1.9"), "версия — числа")
ok(raises(ValueError, parse_version, "1") and raises(ValueError, parse_version, "1.x"), "версия не M.m — ошибка")
ok(major_of("vms.camera/1") == 1 and profile_name("vms.camera/1") == "vms.camera", "имя и старшая версия из id")
ok(profile_problems(GOOD) == [], "образец без ошибок")
ok(says(profile_problems(bad(_file="vms.cam.json")), "имя файла"), "файл не по имени профиля")
ok(says(profile_problems(bad(version="2.0")), "старшая"), "старшая в version не та, что в id")
ok(says(profile_problems(bad_prop("archiveId", since="1.6")), "since"), "since новее version")
ok(says(profile_problems(bad_prop("privacyMasks", since="1.2")), "changes"), "since без строки changes")
ok(says(profile_problems(bad(changes=[{"version": "1.4", "what": "…"}])), "changes"), "первая строка changes — не version")
ok(says(profile_problems(bad_prop("archiveId", meaning="")), "meaning"), "пустой смысл")
ok(says(profile_problems(bad(owners="mockup")), "owners"), "незнакомый ключ")
ok(says(profile_problems(bad(uses=[{"id": "vms.camera/1", "version": "1.0"}])), "сам"), "профиль использует сам себя")
ok(says(profile_problems(bad(uses=[{"id": "vms.archive/1", "version": "2.0"}])), "vms.archive/1"), "версия зависимости не своей старшей")

# добавлено сверх плана (Н12, Н13 и пробелы плана)
no_owner = copy.deepcopy(GOOD)
del no_owner["owner"]
ok(says(profile_problems(no_owner), "owner"), "нет обязательного ключа")
ok(says(profile_problems(bad(id="vms.camera")), "id"), "id без старшей версии")
ok(says(profile_problems(bad(reviewers=[])), "reviewers"), "пустой список проверяющих")
ok(says(profile_problems(bad(changes=[{"version": "1.3", "what": "a"}, {"version": "1.5", "what": "b"}])), "убыв"), "changes не по убыванию")
ok(says(profile_problems(bad(uses=GOOD["uses"] * 2)), "повтор"), "uses с повтором")
ok(says(profile_problems(bad(apis=["a", "a"])), "повтор"), "apis с повтором")
ok(says(profile_problems(bad_prop("archiveId", schema={"x": 1})), "schema"), "schema без type")
with_removed = bad(changes=[{"version": "1.5", "what": "Поле снято.", "removed": ["oldField"]}] + GOOD["changes"][1:])
ok(profile_problems(with_removed) == [], "строка changes с removed проходит")
ok(says(profile_problems(bad(changes=[{"version": "1.5", "what": "x", "removed": "a"}] + GOOD["changes"][1:])), "removed"), "removed не списком — ошибка")

w = profile_wire(GOOD)
ok(w == {"id": "vms.camera/1", "label": {"key": "profile.vms.camera/1", "text": "Камера", "lang": "ru"}, "version": "1.5",
         "uses": [{"id": "vms.archive/1", "version": "1.0"}], "properties": ["archiveId", "privacyMasks"],
         "status": ["recordState"], "apis": ["recording-target", "recording-days"]}, "запись GET /kinds")
ok("uses" not in profile_wire(bad(uses=[])) and "status" not in profile_wire(bad(status={})), "пустые uses и status не выводятся")
ok("apis" not in profile_wire({k: v for k, v in GOOD.items() if k != "apis"}), "без apis поле не выводится")

ok(type_text({"type": ["string", "null"], "x-ref": {"implements": ["vms.archive/1"]}}) == "string | null — uid (`vms.archive/1`)", "тип ссылки")
ok(type_text({"type": "array", "items": {"type": "string"}}) == "массив string", "массив")
ok(type_text({"type": "string", "enum": ["a", "b"]}) == "string: `a`, `b`", "перечень")
ok(type_text({"type": "boolean", "readOnly": True}) == "boolean (только чтение)", "только чтение")
ok(type_text({"type": "string", "writeOnly": True}) == "string (секрет)", "секрет")
ok(type_text({"type": "array", "maxItems": 16, "items": {"type": "object"}}) == "массив object, до 16", "массив с maxItems")
ok(type_text({"type": "string", "x-ref": {"kinds": ["camera"]}}) == "string — uid (camera)", "ссылка на вид")

md = render_md(GOOD, ["camera"])
ok(md.startswith("<!-- Собрано tools/build_api.py из api/profiles/vms.camera.json — руками не править -->\n# `vms.camera/1` — Камера\n"), "шапка таблицы")
ok("| `privacyMasks` |" in md and "| 1.3 |" in md and "## Состояние (`status.observed`)" in md and "## Изменения" in md, "разделы таблицы")
ok("Версия 1.5 · ведёт: mockup · смотрят правку: w2c" in md, "строка версии и хозяина")
ok("Использует: `vms.archive/1` с 1.0" in md, "строка зависимостей")
ok("Виды эталонного набора: `camera`. Предметные пути: `/units/{uid}/recording-target`, `/units/{uid}/recording-days`" in md, "виды и пути")
md2 = render_md(bad(uses=[], status={}, apis=[]), ["camera"])
ok("Использует: —" in md2 and "Своих свойств нет." in md2 and "Предметные пути" not in md2, "пустые разделы")

with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, "profiles"))
    for name, data in (("vms.b.json", {"id": "vms.b/1"}), ("vms.a.json", {"id": "vms.a/1"})):
        with open(os.path.join(d, "profiles", name), "w", encoding="utf-8") as f:
            json.dump(data, f)
    with open(os.path.join(d, "profiles", "README.md"), "w", encoding="utf-8") as f:
        f.write("не профиль")
    docs = load_profiles(d)
    ok([x["_file"] for x in docs] == ["vms.a.json", "vms.b.json"] and docs[0]["id"] == "vms.a/1", "load_profiles: по имени файла, _file проставлен, README пропущен")
    with open(os.path.join(d, "profiles", "vms.c.json"), "w", encoding="utf-8") as f:
        f.write("{")
    try:
        load_profiles(d)
        named = False
    except ValueError as e:
        named = "vms.c.json" in str(e)
    ok(named, "load_profiles: сломанный JSON — ValueError с именем файла")
    ok(load_profiles(os.path.join(d, "nope")) == [], "load_profiles: нет папки — пустой список")

# ── Проверки профилей 1–3: чистые функции (Н5: у kind_problems нет параметра whole) ──
def with_prop(kind, name, schema):
    k = copy.deepcopy(kind)
    k["schema"]["properties"][name] = schema
    return k


def prop_type(doc, name, t):
    d = copy.deepcopy(doc)
    d["properties"][name]["schema"]["type"] = t
    return d


def prop_since(doc, name, since):
    d = copy.deepcopy(doc)
    d["properties"][name]["since"] = since
    return d


def add_prop(doc, name, since):
    d = copy.deepcopy(doc)
    d["properties"][name] = {"schema": {"type": "string"}, "meaning": "Новое поле.", "since": since}
    return d


def drop_prop(doc, name):
    d = copy.deepcopy(doc)
    del d["properties"][name]
    return d


def bump(doc, version):
    d = copy.deepcopy(doc)
    d["version"] = version
    d["changes"].insert(0, {"version": version, "what": "Правка."})
    return d


def as_major2(doc):
    d = copy.deepcopy(doc)
    d["id"] = profile_name(d["id"]) + "/2"
    d["version"] = "2.0"
    for sec in ("properties", "status"):
        for f in d.get(sec, {}).values():
            f["since"] = "2.0"
    d["changes"] = [{"version": "2.0", "what": "Новая старшая версия."}]
    return d


def profile(pid, version, uses=()):
    return {"id": pid, "version": version, "label": "Профиль", "owner": "mockup", "reviewers": ["w2c"],
            "uses": list(uses), "properties": {}, "changes": [{"version": version, "what": "Профиль создан."}]}


from profile_files import (file_name, fixture_profile_problems, history_problems, kind_problems, removed_file_problems,  # noqa: E402
                           table_name, type_fits, uses_problems)

cam = {"kind": "camera", "implements": ["vms.camera/1"], "schema": {"type": "object", "properties": {"archiveId": {"type": ["string", "null"], "x-ref": {"implements": ["vms.archive/1"]}}}}}
ok(kind_problems([GOOD], [cam]) == [], "вид несёт поле того же типа")
ok(says(kind_problems([GOOD], [with_prop(cam, "archiveId", {"type": "integer"})]), "archiveId"), "другой тип — ошибка")
ok(kind_problems([GOOD], [with_prop(cam, "archiveId", {"type": "null", "x-ref": {"implements": ["vms.archive/1"]}})]) == [], "вид сужает тип")
ok(says(kind_problems([prop_type(GOOD, "archiveId", "string")], [cam]), "archiveId"), "вид расширяет тип — ошибка")
ok(says(kind_problems([GOOD], [with_prop(cam, "archiveId", {"type": ["string", "null"], "x-ref": {"implements": ["vms.camera/1"]}})]), "x-ref"), "ссылка на другой профиль — ошибка")
ok(kind_problems([GOOD], [dict(cam, implements=["vms.other/1"], schema={"type": "object", "properties": {"archiveId": {"type": "integer"}}})]) == [], "вид без этого профиля не проверяется")
# Набор без целевых видов ссылки (one-domain без mic) снимает x-ref и ставит readOnly (profile_fixture.gone_ref):
# только для ссылки по kinds, чьих видов в наборе нет, и только в наборе, не в эталоне
mic = {"type": "string", "x-ref": {"kinds": ["mic"]}}
mic_cam = dict(cam, schema={"type": "object", "properties": {"audioDeviceId": {"type": "string", "readOnly": True}}})
mic_doc = copy.deepcopy(GOOD)
mic_doc["properties"]["audioDeviceId"] = {"schema": mic, "meaning": "Микрофон.", "since": "1.0"}
ok(kind_problems([mic_doc], [mic_cam], cut_refs=True, kind_codes={"camera"}) == [], "набор без вида mic: ссылка снята, поле readOnly — можно")
ok(says(kind_problems([mic_doc], [mic_cam], cut_refs=False, kind_codes={"camera"}), "x-ref"), "эталон снятую ссылку не прощает")
ok(says(kind_problems([mic_doc], [mic_cam], cut_refs=True, kind_codes={"camera", "mic"}), "x-ref"), "вид mic в наборе есть, а ссылку сняли — ошибка")
ok(says(kind_problems([mic_doc], [with_prop(mic_cam, "audioDeviceId", {"type": "string"})], cut_refs=True, kind_codes={"camera"}), "x-ref"), "ссылку сняли без readOnly — ошибка")
imp_cam = with_prop(cam, "archiveId", {"type": ["string", "null"], "readOnly": True})
ok(says(kind_problems([GOOD], [imp_cam], cut_refs=True, kind_codes={"camera"}), "x-ref"), "ссылку по implements сняли и поставили readOnly — ошибка")
ok(type_fits({"type": "array", "items": {"type": "string"}}, {"type": "array", "items": {"type": ["string", "null"]}})
   and not type_fits({"type": "array", "items": {"type": "integer"}}, {"type": "array", "items": {"type": "string"}}), "type_fits: у массива сравниваются items")
ok(fixture_profile_problems([profile_wire(GOOD)], [GOOD], whole=True) == [], "эталон — запись как из файла")
ok(says(fixture_profile_problems([dict(profile_wire(GOOD), version="1.4")], [GOOD], whole=True), "vms.camera/1"), "эталон отстал от файла")
ok(says(fixture_profile_problems([], [GOOD], whole=True), "vms.camera/1"), "эталон без профиля из файла")
part = dict(profile_wire(GOOD), properties=["archiveId"], uses=[])  # в наборе нет vms.archive/1
ok(fixture_profile_problems([part], [GOOD], whole=False) == [], "набор с частью полей")
ok(says(fixture_profile_problems([dict(part, properties=["archiveId", "fps"])], [GOOD], whole=False), "fps"), "лишнее имя — ошибка")
ok(says(fixture_profile_problems([dict(part, version="1.4")], [GOOD], whole=False), "version"), "другая версия — ошибка")
ok(says(fixture_profile_problems([dict(part, id="vms.nope/1")], [GOOD], whole=False), "vms.nope/1"), "профиля нет среди файлов")
arch0 = profile("vms.archive/1", "1.2")
withu = dict(part, uses=profile_wire(GOOD)["uses"])  # в наборе есть vms.archive/1
ok(fixture_profile_problems([withu, profile_wire(arch0)], [GOOD, arch0], whole=False) == [], "набор: uses как в файле")
ok(says(fixture_profile_problems([dict(withu, uses=[]), profile_wire(arch0)], [GOOD, arch0], whole=False), "uses"), "набор: uses меньше, чем в файле — ошибка")
ok(says(fixture_profile_problems([dict(part, uses=[{"id": "vms.pos/1", "version": "1.0"}])], [GOOD], whole=False), "uses"), "набор: лишний uses — ошибка")
ok(fixture_profile_problems([dict(part, uses=[])], [GOOD], whole=False) == [], "набор без профиля из uses: зависимость на отсутствующий профиль в записи не нужна")
ok(says(fixture_profile_problems([withu], [GOOD], whole=False), "uses"), "набор без профиля из uses, а запись его называет — ошибка")
ok(says(fixture_profile_problems([dict(part, label={"key": "profile.vms.camera/1", "text": "Другое", "lang": "ru"})], [GOOD], whole=False), "label"), "набор: другая подпись — ошибка")

base = GOOD
ok(history_problems(GOOD, None) == [], "нового профиля в origin/main нет")
ok(history_problems(GOOD, base) == [], "без правок")
ok(says(history_problems(add_prop(GOOD, "noiseReduction", since="1.5"), base), "noiseReduction"), "новое поле без новой младшей версии")
ok(history_problems(bump(add_prop(GOOD, "noiseReduction", since="1.6"), "1.6"), base) == [], "новое поле с версией 1.6")
ok(says(history_problems(bump(add_prop(GOOD, "noiseReduction", since="1.5"), "1.6"), base), "since"), "since нового поля — не новее версии в origin/main")
ok(says(history_problems(drop_prop(GOOD, "privacyMasks"), base), "privacyMasks"), "О2 (а): поле снято без removed")
ok(says(history_problems(drop_prop(GOOD, "privacyMasks"), base), "без записи removed"), "О2 (а): сообщение называет removed")
def with_removed(doc, version, names):
    d = bump(doc, version)
    d["changes"] = [{"version": version, "what": "Поле снято.", "removed": names}] + d["changes"]
    return d
ok(history_problems(with_removed(drop_prop(GOOD, "privacyMasks"), "1.6", ["privacyMasks"]), base) == [], "О2 (б): снято, версия выше, removed — проходит")
ok(says(history_problems(with_removed(GOOD, "1.6", ["privacyMasks"]), base), "осталось в профиле"), "О2 (в): в removed, а поле осталось")
ok(says(history_problems(with_removed(drop_prop(GOOD, "privacyMasks"), GOOD["version"], ["privacyMasks"]), base), "новой младшей версии"), "О2 (г): removed без подъёма версии")
other = with_removed(drop_prop(GOOD, "privacyMasks"), "1.6", ["privacyMasks"])
other["changes"][0]["version"] = "1.5"
ok(says(history_problems(other, base), "без записи removed"), "О2: запись removed не с версией файла — поле снято без записи")
ok(history_problems(as_major2(drop_prop(GOOD, "privacyMasks")), None) == [], "поле снято в vms.camera/2 (новый файл рядом)")
ok(says(history_problems(prop_type(GOOD, "archiveId", "string"), base), "archiveId"), "тип поменялся в той же старшей")
ok(says(history_problems(bump(GOOD, "1.4"), base), "1.4"), "версия ниже, чем в origin/main")
ok(says(history_problems(prop_since(GOOD, "archiveId", "1.3"), base), "archiveId"), "since старого поля поменялся")
ok(says(history_problems(dict(GOOD, apis=["recording-target"]), base), "recording-days"), "путь снят в той же старшей")
ok(says(history_problems(dict(GOOD, apis=["recording-target", "recording-days", "x"]), base), "x"), "новый путь без новой младшей версии")
ok(says(history_problems(dict(GOOD, id="vms.camera/0"), dict(GOOD)), "старш"), "старшая версия уменьшилась")

arch = profile("vms.archive/1", "1.2")
pos = profile("vms.pos/1", "1.0", uses=[{"id": "vms.camera/1", "version": "1.5"}])
ok(uses_problems([GOOD, arch, pos]) == [], "зависимости есть, версии не ниже")
ok(says(uses_problems([GOOD, arch, dict(pos, uses=[{"id": "vms.camera/1", "version": "1.6"}])]), "1.6"), "зависимость младше указанной")
ok(says(uses_problems([as_major2(GOOD), arch, pos]), "vms.camera/2"), "у зависимости новая старшая — касса задета")
ok(says(uses_problems([GOOD, pos]), "vms.archive/1"), "зависимости нет среди профилей")
ok(says(uses_problems([dict(GOOD, uses=[]), arch]), "x-ref"), "x-ref на профиль без строки в uses")
det = profile("vms.detector/1", "1.0", uses=[{"id": "vms.camera/1", "version": "1.0"}])
cam2 = dict(GOOD, uses=GOOD["uses"] + [{"id": "vms.detector/1", "version": "1.0"}])
ok(uses_problems([cam2, arch, det]) == [], "взаимные зависимости разрешены")

# I1: старшая версия N>=2 лежит рядом со старой, в <имя>.<N>.json; файл <имя>.json — всегда старшая 1
ok(file_name("vms.camera/1") == "vms.camera.json" and file_name("vms.camera/2") == "vms.camera.2.json", "имя файла: /1 — <имя>.json, /N — <имя>.<N>.json")
ok(profile_problems(dict(as_major2(GOOD), _file="vms.camera.2.json")) == [], "I1: /2 в vms.camera.2.json проходит")
ok(says(profile_problems(dict(as_major2(GOOD), _file="vms.camera.json")), "имя файла"), "I1: /2 в файле /1 — ошибка имени")
ok(says(profile_problems(dict(GOOD, _file="vms.camera.1.json")), "имя файла"), "I1: /1 в vms.camera.1.json — ошибка имени")
ok(history_problems(dict(as_major2(GOOD), _file="vms.camera.2.json"), None) == [], "I1: /2 рядом с /1 — файл новый, проходит")
ok(says(history_problems(as_major2(GOOD), base), "рядом"), "I1: /2 вместо /1 в том же файле — «старшую версию кладут рядом»")
ok(says(history_problems(as_major2(GOOD), base), "vms.camera.2.json"), "I1: подсказка называет vms.camera.2.json")
ok(removed_file_problems(["vms.camera.json", "vms.camera.2.json"], ["vms.camera.json", "vms.camera.2.json"]) == [], "I1: все файлы базы на месте")
ok(says(removed_file_problems(["vms.camera.json", "vms.pos.json"], ["vms.pos.json"]), "запрос к reviewers"), "I1: файл базы пропал — «снять старшую — запрос к reviewers»")
ok(removed_file_problems(["vms.pos.json"], ["vms.pos.json", "vms.camera.json"]) == [], "I1: новый файл — не пропажа")
with tempfile.TemporaryDirectory() as _t:
    os.makedirs(os.path.join(_t, "profiles"))
    for _n, _d in (("vms.camera.json", GOOD), ("vms.camera.2.json", as_major2(GOOD))):
        with open(os.path.join(_t, "profiles", _n), "w", encoding="utf-8") as _f:
            json.dump({k: v for k, v in _d.items() if k != "_file"}, _f)
    _ids = [d["id"] for d in load_profiles(_t)]
    ok(sorted(_ids) == ["vms.camera/1", "vms.camera/2"], "I1: load_profiles читает обе формы имени")
ok("из api/profiles/vms.camera.2.json" in render_md(as_major2(GOOD), ["camera"]), "I1: шапка таблицы /2 называет vms.camera.2.json")
ok(table_name("vms.camera/1") == "vms.camera.md" and table_name("vms.camera/2") == "vms.camera.2.md", "I1: таблица /1 — <имя>.md, /N — <имя>.<N>.md")

# M6: uses поменялся при той же версии — нужна новая младшая
ok(says(history_problems(dict(GOOD, uses=[]), base), "uses"), "M6: uses изменён без новой младшей версии")
ok(history_problems(bump(dict(GOOD, uses=[]), "1.6"), base) == [], "M6: uses изменён с новой младшей версией")
ok(history_problems(dict(GOOD, uses=[dict(u) for u in reversed(GOOD["uses"])]), base) == [], "M6: тот же uses — без замечаний")

# Ключ absent у поля (ответ w2c на запрос 154325Z, п. 3.1): только "unsupported", меняется с новой младшей версией
from profile_files import profile_absent, profile_absent_js, render_md  # noqa: E402
ok(profile_problems(bad_prop("privacyMasks", absent="unsupported")) == [], "absent: unsupported — без ошибок")
ok(says(profile_problems(bad_prop("privacyMasks", absent="hide")), "absent"), "absent другого значения — ошибка")
ok(says(history_problems(bad_prop("privacyMasks", absent="unsupported"), base), "absent"), "absent без новой младшей версии — ошибка")
ok(history_problems(bump(bad_prop("privacyMasks", absent="unsupported"), "1.6"), base) == [], "absent с версией 1.6 — без замечаний")
marked = bad_prop("privacyMasks", absent="unsupported")
marked["status"]["recordState"]["absent"] = "unsupported"
ok(profile_absent(marked) == ["privacyMasks", "recordState"] and profile_absent(GOOD) == [], "profile_absent: свойства, затем состояние")
ok(profile_absent_js([GOOD, marked]) == 'window.CONSOLEM_PROFILE_ABSENT={"vms.camera/1":["privacyMasks","recordState"]};\n'
   and profile_absent_js([GOOD]) == "window.CONSOLEM_PROFILE_ABSENT={};\n", "profile_absent_js: только профили с метками")
ok("`absent`" in render_md(marked, ["camera"]) and "`absent`" not in render_md(GOOD, ["camera"]), "таблица .md называет absent у помеченного поля")

print(f"RESULT {'fail' if failed else 'pass'}")
sys.exit(1 if failed else 0)
