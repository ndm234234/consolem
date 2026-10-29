#!/usr/bin/env python3
"""Сценарии интерфейса прототипа API: действия пользователя → запросы API → то, что видно на экране.

Каждый сценарий tests/ui-*.js выполняется на свежей странице index_api_server.html в headless
Chrome: страница загружает данные со встроенного сервера, сценарий жмёт кнопки и вызывает те же
функции, что и клики, и сверяет кэш интерфейса, разметку и ответы сервера. Виртуальное время:
отсчёты удаления и шаги операций идут без ожидания.

Запуск из корня репозитория:
  python3 tools/check_ui.py                       все сценарии
  python3 tools/check_ui.py --latency 300         с задержкой ответа, как по медленной сети
  python3 tools/check_ui.py tests/ui-domains.js   один сценарий
  python3 tools/check_ui.py --selftest            самопроверка прототипа (?selftest): те же сценарии изнутри страницы
  python3 tools/check_ui.py --page index.html                 другой файл (например, макет на константах)
Код выхода 1, если хоть одна проверка не прошла.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Chrome — в часовом поясе системы: в нём сервер считает расписания и время, в нём же макет на константах
TZ = "Europe/Moscow"
PAGE = "index_api_server.html"

# Помощники сценариев — те же, что у самопроверки прототипа (?selftest)
HELPERS = '<script src="tests/ui-harness.js"></script>'


def fixture_of():
    """Сценарии не на эталонном наборе — FIXTURE_OF в tests/selftest.js: одно место на оба запуска."""
    with open(os.path.join(ROOT, "tests", "selftest.js"), encoding="utf-8") as f:
        m = re.search(r"const FIXTURE_OF = \{(.*?)\};", f.read())
    return dict(re.findall(r'"([\w.-]+)":\s*"([\w-]+)"', m.group(1))) if m else {}


def run(scenario, query):
    with open(os.path.join(ROOT, PAGE), encoding="utf-8") as f:
        page = f.read()
    with open(scenario, encoding="utf-8") as f:
        code = f.read()
    page = page.replace("<head>", '<head><base href="file://%s/">' % ROOT, 1)
    page = page.replace("</body>", HELPERS + "<script>" + code + "</script></body>", 1)
    tmp = tempfile.mkdtemp(prefix="consolem-ui-")
    try:
        path = os.path.join(tmp, "page.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(page)
        chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
        res = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files",
             f"--user-data-dir={tmp}/profile", "--window-size=1600,1000", "--virtual-time-budget=180000", "--dump-dom", "file://" + path + query],
            capture_output=True, text=True, timeout=300, env=dict(os.environ, TZ=TZ))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    m = re.search(r'<script type="text/plain" id="__ui">(.*?)</script>', res.stdout, re.S)
    return json.loads(m.group(1)) if m else ["FAIL  сценарий не дошёл до конца"]


def selftest(query):
    """Прототип с ?selftest: сценарии гоняет сама страница, итог — data-selftest у <html>."""
    tmp = tempfile.mkdtemp(prefix="consolem-selftest-")
    try:
        chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
        url = "file://" + os.path.join(ROOT, PAGE) + "?selftest" + query.replace("?", "&")
        res = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files",
             f"--user-data-dir={tmp}/profile", "--window-size=1600,1000", "--virtual-time-budget=300000", "--dump-dom", url],
            capture_output=True, text=True, timeout=400, env=dict(os.environ, TZ=TZ))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    state = re.search(r'data-selftest="(\w+)"', res.stdout)
    head = re.search(r'<div id="selftest"[^>]*><b[^>]*>(.*?)</b>', res.stdout, re.S)
    print(head.group(1) if head else "Самопроверка не дошла до конца")
    print(f"RESULT {state.group(1) if state else 'fail'}")
    return 0 if state and state.group(1) == "pass" else 1


def main():
    global PAGE
    args = sys.argv[1:]
    query = ""
    if "--page" in args:
        i = args.index("--page")
        PAGE = args[i + 1]
        del args[i:i + 2]
    if "--latency" in args:
        i = args.index("--latency")
        query = f"?latency={int(args[i + 1])}"
        del args[i:i + 2]
    if "--selftest" in args:
        return selftest(query)
    # Сценарии — tests/ui-*.js, кроме самих помощников
    files = args or sorted(f for f in glob.glob(os.path.join(ROOT, "tests", "ui-*.js")) if not f.endswith("ui-harness.js"))
    fixtures = fixture_of()
    failed = 0
    for f in files:
        fx = fixtures.get(os.path.basename(f))
        lines = run(f, query + (("&" if query else "?") + "fixture=" + fx if fx else ""))
        bad = [x for x in lines if not x.startswith("PASS")]
        failed += len(bad)
        print(f"== {os.path.relpath(f, ROOT)}{' ' + query if query else ''}: {len(lines) - len(bad)} из {len(lines)}")
        for x in lines:
            print("   " + x)
    print(f"RESULT {'fail' if failed else 'pass'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
