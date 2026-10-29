#!/usr/bin/env python3
"""Внешний режим целиком: клиент по HTTP и SSE, CORS со страницы с диска, прототип против стенда.

Поднимает образец тестового стенда (node tools/serve_api.mjs — встроенный сервер за HTTP с CORS и SSE),
открывает в headless Chrome с диска (Origin: null) tests/api.html?api=<стенд> и
index_10_api-server.html?api=<стенд>&selftest и ждёт отчёты: страницы присылают их POST-запросом.
Это те же критерии готовности, что у бэкенда (api/BACKEND.md, «Когда готово»).

Без флагов прогоняются: тесты API на эталонном наборе с остановленными часами, они же на профиле
one-domain на настоящих часах (так, как их гоняет система, которая умеет часть контракта), самопроверка
прототипа. С --fixture и --clock — только тесты API с ними; самопроверка — если набор demo.

Запуск из корня репозитория:
  python3 tools/check_stand.py                       против образца стенда
  python3 tools/check_stand.py https://адрес-стенда  против стенда бэкенда (отчёты — на локальный приёмник)
  python3 tools/check_stand.py https://адрес-стенда --fixture one-domain --clock real
                                                     стенд с набором профиля и часами, которые не остановить
Код выхода 1, если что-то не прошло или отчёт не пришёл.
"""
import http.server
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAIT_SEC = 400


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def receiver():
    """Приёмник отчётов: страница с диска шлёт отчёт POST-запросом сюда (CORS — для Origin: null)."""
    got = []
    done = threading.Event()

    class H(http.server.BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_POST(self):
            got.append(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8"))
            self.send_response(204)
            self._cors()
            self.end_headers()
            done.set()

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, got, done


def run_page(page, stand, report):
    srv, got, done = report
    got.clear()
    done.clear()
    to = f"http://127.0.0.1:{srv.server_address[1]}/report"
    sep = "&" if "?" in page else "?"
    url = "file://" + os.path.join(ROOT, page) + f"{sep}api={urllib.parse.quote(stand, safe=':/')}&report={urllib.parse.quote(to, safe=':/')}"
    profile = tempfile.mkdtemp(prefix="consolem-stand-")
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
    browser = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files",
         f"--user-data-dir={profile}", "--window-size=1600,1000", "--remote-debugging-port=0", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started = time.time()
    try:
        done.wait(WAIT_SEC)
    finally:
        browser.kill()
        browser.wait()
        shutil.rmtree(profile, ignore_errors=True)
    if not got:
        return False, f"отчёт не пришёл за {WAIT_SEC} с"
    text = got[-1].rstrip()
    lines = [l for l in text.splitlines() if not l.startswith("PASS")]
    return text.endswith("RESULT pass"), "\n".join(lines[-12:]) + f"\n({time.time() - started:.0f} с)"


def main():
    args = sys.argv[1:]
    flags = {}
    for flag in ("fixture", "clock"):
        if f"--{flag}" in args:
            i = args.index(f"--{flag}")
            flags[flag] = args[i + 1]
            del args[i:i + 2]
    stand = args[0] if args else None
    node = None
    if not stand:
        port = free_port()
        node = subprocess.Popen(["node", os.path.join(ROOT, "tools", "serve_api.mjs"), str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stand = f"http://127.0.0.1:{port}"
        time.sleep(1)
    report = receiver()
    ok = True
    try:
        if flags:
            pages = [(f"Тесты API ({', '.join(f'{k} {v}' for k, v in flags.items())})", "tests/api.html?" + urllib.parse.urlencode(flags))]
            if flags.get("fixture", "demo") == "demo":
                pages.append(("Прототип ?selftest", "index_10_api-server.html?selftest"))
        else:
            pages = [
                ("Тесты API", "tests/api.html"),
                ("Тесты API (профиль one-domain, часы идут)", "tests/api.html?fixture=one-domain&clock=real"),
                ("Прототип ?selftest", "index_10_api-server.html?selftest"),
            ]
        for name, page in pages:
            passed, text = run_page(page, stand, report)
            ok &= passed
            print(f"== {name} против {stand}: {'pass' if passed else 'fail'}\n{text}")
    finally:
        report[0].shutdown()
        if node:
            node.kill()
    print(f"RESULT {'pass' if ok else 'fail'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
