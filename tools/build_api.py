#!/usr/bin/env python3
"""Собрать раздел profiles в api/fixtures/demo.json, затем таблицы api/profiles/*.md, наборы, api/openapi.js, api/fixture.js
и api/setup-ui.schema.js (схема сообщений своей страницы подсистемы).

Источник раздела profiles — файлы api/profiles/*.json (формат — tools/profile_files.py): demo.json и agents.json правят руками
во всём, кроме этого раздела (у agents — только профили, которые называют его виды). Наборы one-domain, large, xl собирает tools/profile_fixture.py из demo.json.

Страница прототипа и тесты открываются и с диска (file://), а там fetch JSON не
работает. Поэтому контракт и наборы подключаются обычным <script>: window.CONSOLEM_OPENAPI,
window.CONSOLEM_FIXTURES (набор по имени) и window.CONSOLEM_FIXTURE (эталонный demo).
Собранные файлы руками не правят.

Запуск из корня репозитория:
  python3 tools/build_api.py          собрать
  python3 tools/build_api.py --check  собранное не отстало от JSON (код выхода 1, если отстало)
  --api DIR                           папка API вместо api (копия папки API)
"""
import json
import os
import subprocess
import sys

import cli_paths
import profile_files

API = cli_paths.opt("api", "api")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = ["demo", "one-domain", "large", "agents"]
# Наборы, чей раздел profiles собирается из файлов api/profiles/*.json: только профили, которые объявляют виды набора
PROFILE_FIXTURES = ["demo", "agents"]
# Наборы-наложения: в файле "$base" (имя целого набора) и поля поверх него. В fixture.js — Object.assign поверх базы,
# а не вторая копия: xl — тот же large с другими числами stand.large (tools/profile_fixture.py)
OVERLAYS = ["xl"]


def compact(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return json.dumps(json.load(f), ensure_ascii=False, separators=(",", ":"))


def render_fixture_profiles(name):
    """Текст набора из PROFILE_FIXTURES: файл как есть, раздел profiles — из api/profiles/*.json (profile_wire).
    У demo — все профили; у остальных — только те, которые называют виды набора в implements, а uses — только из них."""
    path = os.path.join(ROOT, f"{API}/fixtures/{name}.json")
    with open(path, encoding="utf-8") as f:
        fx = json.load(f)
    docs = profile_files.load_profiles(os.path.join(ROOT, API))
    if docs and name != "demo":
        used = {p for k in fx.get("kinds") or [] for p in k.get("implements") or []}
        docs = [d for d in docs if d["id"] in used]
    if docs or name != "demo":
        wires = [profile_files.profile_wire(d) for d in docs]
        present = {w["id"] for w in wires}
        for w in wires:
            if "uses" in w:
                w["uses"] = [u for u in w["uses"] if u["id"] in present]
                if not w["uses"]:
                    del w["uses"]
        fx["profiles"] = wires
    return json.dumps(fx, ensure_ascii=False, indent=1) + "\n"


def render_demo():
    return render_fixture_profiles("demo")


def render_profile_tables():
    """Таблицы профилей для людей: {путь: текст} для каждого api/profiles/<имя>.json и <имя>.<N>.json (profile_files.render_md).
    Виды — коды видов demo.json с этим профилем в implements."""
    with open(os.path.join(ROOT, f"{API}/fixtures/demo.json"), encoding="utf-8") as f:
        kinds = json.load(f)["kinds"]
    out = {}
    for d in profile_files.load_profiles(os.path.join(ROOT, API)):
        codes = [k["kind"] for k in kinds if d["id"] in (k.get("implements") or [])]
        out[f"{API}/profiles/{profile_files.table_name(d['id'])}"] = profile_files.render_md(d, codes)
    return out


def stray_tables(expected):
    """Файлы api/profiles/*.md, которым не отвечает файл профиля (README.md — рукописный, его не считаем)."""
    folder = os.path.join(ROOT, API, "profiles")
    names = sorted(n for n in os.listdir(folder) if n.endswith(".md") and n != "README.md") if os.path.isdir(folder) else []
    return [f"{API}/profiles/{n}" for n in names if f"{API}/profiles/{n}" not in expected]


def render_openapi():
    return f"/* Собрано tools/build_api.py из {API}/openapi.json — руками не править */\nwindow.CONSOLEM_OPENAPI={compact(f'{API}/openapi.json')};\n"


def render_setup_ui_schema():
    """Схема сообщений протокола setup/1 для сценариев интерфейса: с file:// JSON через fetch не загрузить (api/SETUP-UI.md)."""
    return (f"/* Собрано tools/build_api.py из {API}/setup-ui.schema.json — руками не править */\n"
            f"window.CONSOLEM_SETUP_UI_SCHEMA={compact(f'{API}/setup-ui.schema.json')};\n")


def deep_merge(base, over):
    """Поля наложения поверх базы: объекты сливаются по ключам (новый ключ базы не теряется), остальное заменяется."""
    if not isinstance(base, dict) or not isinstance(over, dict):
        return over
    return {**base, **{k: deep_merge(base.get(k), v) for k, v in over.items()}}


def render_overlay(name):
    with open(os.path.join(ROOT, f"{API}/fixtures/{name}.json"), encoding="utf-8") as f:
        over = json.load(f)
    base = over.pop("$base")
    if base not in FIXTURES:
        raise SystemExit(f"{API}/fixtures/{name}.json: $base {base} — не целый набор ({', '.join(FIXTURES)})")
    with open(os.path.join(ROOT, f"{API}/fixtures/{base}.json"), encoding="utf-8") as f:
        whole = json.load(f)
    # В fixture.js — только поля наложения, уже слитые с базой (stand базы с новым ключом остаётся): копии базы нет
    text = json.dumps({k: deep_merge(whole.get(k), v) for k, v in over.items()}, ensure_ascii=False, separators=(",", ":"))
    return f"window.CONSOLEM_FIXTURES[{json.dumps(name)}]=Object.assign({{}},window.CONSOLEM_FIXTURES[{json.dumps(base)}],{text});\n"


def render_fixtures():
    body = ",".join(f"{json.dumps(n)}:{compact(f'{API}/fixtures/{n}.json')}" for n in FIXTURES)
    return (f"/* Собрано tools/build_api.py из {API}/fixtures/{{{','.join(FIXTURES + OVERLAYS)}}}.json — руками не править */\n"
            f"window.CONSOLEM_FIXTURES={{{body}}};\n" + "".join(render_overlay(n) for n in OVERLAYS)
            + "window.CONSOLEM_FIXTURE=window.CONSOLEM_FIXTURES.demo;\n"
            # Метки absent знакомых профилей: особый экран прячет поле без значения (profile_files.profile_absent)
            + profile_files.profile_absent_js(profile_files.load_profiles(os.path.join(ROOT, API))))


# Порядок важен: demo.json ← профили, затем наборы из demo.json (profile_fixture.py), затем openapi.js и fixture.js;
# схема сообщений setup/1 от остального не зависит — последней
TARGETS = [(f"{API}/profiles/*.json", f"{API}/fixtures/demo.json", render_demo, "раздел profiles отстал от api/profiles/"),
           (f"{API}/profiles/*.json", f"{API}/fixtures/agents.json", lambda: render_fixture_profiles("agents"), "раздел profiles отстал от api/profiles/"),
           (None, None, None, None),  # наборы one-domain, large, xl — profile_fixture.py (в --check не запускается)
           (f"{API}/openapi.json", f"{API}/openapi.js", render_openapi, None),
           (f"{API}/fixtures/*.json", f"{API}/fixture.js", render_fixtures, None),
           (f"{API}/setup-ui.schema.json", f"{API}/setup-ui.schema.js", render_setup_ui_schema, None)]


def main():
    check = "--check" in sys.argv[1:]
    stale = []
    for src, dst, render, why in TARGETS:
        if src is None:
            if not check:
                res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "profile_fixture.py"), "--api", API], text=True, capture_output=True)
                sys.stdout.write(res.stdout)
                if res.returncode:
                    sys.stderr.write(res.stderr)
                    return res.returncode
            continue
        text = render()
        path = os.path.join(ROOT, dst)
        if check:
            try:
                with open(path, encoding="utf-8") as f:
                    if f.read() == text:
                        continue
            except FileNotFoundError:
                pass
            stale.append(f"{dst}: {why}" if why else f"{dst} отстал от {src}")
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"{dst} ← {src}")
    tables = render_profile_tables()
    for dst, text in tables.items():
        path = os.path.join(ROOT, dst)
        src = dst[:-3] + ".json"
        if check:
            try:
                with open(path, encoding="utf-8") as f:
                    if f.read() == text:
                        continue
            except FileNotFoundError:
                pass
            stale.append(f"{dst} отстал от {os.path.basename(src)}")
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"{dst} ← {src}")
    for dst in stray_tables(tables):
        if check:
            stale.append(f"{dst} — нет файла {os.path.basename(dst)[:-3]}.json")
        else:
            os.remove(os.path.join(ROOT, dst))
            print(f"{dst} удалён: нет файла {os.path.basename(dst)[:-3]}.json")
    if stale:
        print("\n".join(stale) + "\nСоберите: python3 tools/build_api.py")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
