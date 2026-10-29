#!/usr/bin/env python3
"""Тесты API по сети: клиент api/client.js говорит со встроенным сервером через fetch и SSE.

Поднимает раздачу репозитория на 127.0.0.1, открывает в headless Chrome tests/api.html?api=loopback —
там Service Worker (tests/loopback-sw.js) отвечает на запросы встроенным сервером по HTTP — и ждёт отчёт:
страница присылает его POST-запросом на /__report. Проверяется сетевой путь клиента, которым он говорит с
настоящим бэкендом: заголовки If-Match и ETag, тела ошибок, поток событий. Не проверяются CORS и вход.

Режим --dump-dom, которым идут остальные проверки, тут не годится: в нём Service Worker не регистрируется.

Запуск из корня репозитория: python3 tools/check_loopback.py
Код выхода 1, если тесты не прошли или отчёт не пришёл.
"""
import functools
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAIT_SEC = 300


def main():
    reports = []
    done = threading.Event()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/__report":
                self.send_response(404)
                self.end_headers()
                return
            reports.append(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8"))
            done.set()
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=ROOT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/tests/api.html?api=loopback&report=/__report"
    profile = tempfile.mkdtemp(prefix="consolem-loopback-")
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
    browser = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", f"--user-data-dir={profile}", "--remote-debugging-port=0", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started = time.time()
    try:
        done.wait(WAIT_SEC)
    finally:
        browser.kill()
        browser.wait()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    if not reports:
        print(f"Отчёт не пришёл за {WAIT_SEC} с: {url}")
        return 1
    print(reports[-1])
    print(f"({time.time() - started:.0f} с)")
    return 0 if reports[-1].rstrip().endswith("RESULT pass") else 1


if __name__ == "__main__":
    sys.exit(main())
