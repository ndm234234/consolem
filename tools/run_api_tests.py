#!/usr/bin/env python3
"""Прогнать тесты API без человека: tests/api.html в headless Chrome, отчёт — в консоль.

Страница открывается с диска, как двойным кликом, и проверяет встроенный сервер прототипа.
Итог берётся из data-apitest у <html> и текста отчёта. Петля по HTTP — tools/check_loopback.py.

Запуск из корня репозитория: python3 tools/run_api_tests.py [--only "имя теста"]
Код выхода 1, если тесты не прошли или отчёт не получен.
"""
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    url = "file://" + os.path.join(ROOT, "tests", "api.html")
    if "--only" in sys.argv:
        url += "?only=" + urllib.parse.quote(sys.argv[sys.argv.index("--only") + 1])
    profile = tempfile.mkdtemp(prefix="consolem-apitest-")
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
    try:
        # Виртуальное время: таймеры страницы идут без ожидания, отчёт снимается, когда прогон закончился
        res = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", f"--user-data-dir={profile}",
             "--virtual-time-budget=120000", "--dump-dom", url],
            capture_output=True, text=True, timeout=300)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    state = re.search(r'<html[^>]*data-apitest="(\w+)"', res.stdout)
    log = re.search(r'<pre id="apitest-log">(.*?)</pre>', res.stdout, re.S)
    summary = re.search(r'<strong id="apitest-summary">(.*?)</strong>', res.stdout, re.S)
    if log:
        print(html.unescape(log.group(1)))
    if summary:
        print(html.unescape(summary.group(1)))
    if not state:
        print("Отчёт не получен: прогон не закончился за отведённое время")
        return 1
    print(f"RESULT {state.group(1)}")
    return 0 if state.group(1) == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
