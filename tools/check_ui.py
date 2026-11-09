#!/usr/bin/env python3
"""Сценарии интерфейса прототипа API: действия пользователя → запросы API → то, что видно на экране.

Каждый сценарий tests/ui-*.js выполняется на свежей странице index.html в headless
Chrome: страница загружает данные со встроенного сервера, сценарий жмёт кнопки и вызывает те же
функции, что и клики, и сверяет кэш интерфейса, разметку и ответы сервера. Виртуальное время:
отсчёты удаления и шаги операций идут без ожидания.

Запуск из корня репозитория:
  python3 tools/check_ui.py                       все сценарии
  python3 tools/check_ui.py --latency 300         с задержкой ответа, как по медленной сети
  python3 tools/check_ui.py tests/ui-domains.js   один сценарий
  python3 tools/check_ui.py --selftest            самопроверка прототипа (?selftest): те же сценарии изнутри страницы
  python3 tools/check_ui.py --page FILE.html      другой файл (прототип, скопированный с index.html)
  python3 tools/check_ui.py --tests DIR           сценарии и помощники из другой папки (по умолчанию tests)
Перед сценариями — опоры карты кода (`tools/outline.py --check`): на index.html их потеря — отказ.
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

import cli_paths

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Chrome — в часовом поясе системы: в нём сервер считает расписания и время, в нём же макет на константах
TZ = "Europe/Moscow"
PAGE = cli_paths.opt("page", "index.html")
TESTS = cli_paths.opt("tests", "tests")
cli_paths.opt("api", "api")  # страница сама подключает свой API; параметр принят, чтобы одна строка параметров шла во все инструменты

# Помощники сценариев — те же, что у самопроверки прототипа (?selftest)
HELPERS = '<script src="%s/ui-harness.js"></script>' % TESTS
# Самопроверка: виртуальный срок больше срока сценариев в tests/selftest.js, настоящий — с запасом на занятую машину
SELFTEST_BUDGET_SEC = 800
SELFTEST_WAIT_SEC = 900
# Без этого ключа Chrome иногда зависает навсегда при виртуальном времени: scrollIntoView ждёт поток компоновщика,
# а тот ждёт срока кадра по виртуальным часам, которые стоят, пока занят главный поток. Со страницей это не связано.
NO_COMPOSITOR_THREAD = "--disable-threaded-compositing"


def fixture_of():
    """Сценарии не на эталонном наборе — FIXTURE_OF в tests/selftest.js: одно место на оба запуска."""
    with open(os.path.join(ROOT, TESTS, "selftest.js"), encoding="utf-8") as f:
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
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files", NO_COMPOSITOR_THREAD,
             f"--user-data-dir={tmp}/profile", "--window-size=1600,1000", "--virtual-time-budget=180000", "--dump-dom", "file://" + path + query],
            capture_output=True, text=True, timeout=300, env=dict(os.environ, TZ=TZ))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    m = re.search(r'<script type="text/plain" id="__ui">(.*?)</script>', res.stdout, re.S)
    return json.loads(m.group(1)) if m else ["FAIL  сценарий не дошёл до конца"]


def selftest_missing(log):
    """Отчёта нет: что успела сказать страница. log — вывод Chrome с --enable-logging=stderr, selftest.js пишет туда каждый итог."""
    done = set(re.findall(r"SELFTEST done ([\w.-]+)", log))
    with open(os.path.join(ROOT, TESTS, "selftest.js"), encoding="utf-8") as f:
        names = re.findall(r'"(ui-[\w-]+\.js)"', re.search(r"const SCENARIOS = \[(.*?)\];", f.read()).group(1))
    left = [n for n in names if n not in done]
    if left:
        return f"не отчитались: {', '.join(left)}"
    return "все сценарии отчитались, итог страницы не пришёл" + (": страница его написала, отчёт потерян" if re.search(r"SELFTEST (pass|fail) ", log) else "")


def selftest(query):
    """Прототип с ?selftest: сценарии гоняет сама страница, итог — data-selftest у <html>."""
    tmp = tempfile.mkdtemp(prefix="consolem-selftest-")
    try:
        chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
        url = "file://" + os.path.join(ROOT, PAGE) + "?selftest" + query.replace("?", "&")
        res = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files", NO_COMPOSITOR_THREAD,
             f"--user-data-dir={tmp}/profile", "--window-size=1600,1000", "--virtual-time-budget=" + str(SELFTEST_BUDGET_SEC * 1000), "--dump-dom", "--enable-logging=stderr", url],
            capture_output=True, text=True, timeout=SELFTEST_WAIT_SEC, env=dict(os.environ, TZ=TZ))
    except subprocess.TimeoutExpired as e:
        log = e.stderr.decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        print(f"Самопроверка не кончилась за {SELFTEST_WAIT_SEC} с: {selftest_missing(log)}")
        print("RESULT fail")
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    state = re.search(r'data-selftest="(\w+)"', res.stdout)
    head = re.search(r'<div id="selftest"[^>]*><b[^>]*>(.*?)</b>', res.stdout, re.S)
    print(head.group(1) if head else "Самопроверка не дошла до конца")
    print(f"RESULT {state.group(1) if state else 'fail'}")
    return 0 if state and state.group(1) == "pass" else 1


def outline_check():
    """Карта кода (tools/outline.py) опирается на соглашения страницы. Ушли — говорим сразу.
    Основной макет без опор — отказ; прототип — только предупреждение: старые прототипы
    сделаны до нынешних соглашений, и карта для них не обещана."""
    page = os.path.join(ROOT, PAGE)
    res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "outline.py"), page, "--check"],
                         capture_output=True, text=True)
    print((res.stdout + res.stderr).rstrip())
    main_page = os.path.realpath(page) == os.path.realpath(os.path.join(ROOT, "index.html"))
    if res.returncode and not main_page:
        print("   (прототип: предупреждение, не отказ)")
    return 1 if res.returncode and main_page else 0


def main():
    args = sys.argv[1:]
    query = ""
    if "--latency" in args:
        i = args.index("--latency")
        query = f"?latency={int(args[i + 1])}"
        del args[i:i + 2]
    outline_bad = outline_check()
    if "--selftest" in args:
        res = selftest(query)
        if outline_bad:  # самопроверка уже напечатала свой RESULT — последняя строка должна сказать правду
            print("RESULT fail (карта кода: tools/outline.py --check)")
        return max(res, outline_bad)
    # Сценарии — tests/ui-*.js, кроме самих помощников
    files = args or sorted(f for f in glob.glob(os.path.join(ROOT, TESTS, "ui-*.js")) if not f.endswith("ui-harness.js"))
    fixtures = fixture_of()
    failed = outline_bad
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
