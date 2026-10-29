#!/usr/bin/env python3
"""Сборка WebUI работает в консоли VMS: под её CSP, с API по относительному адресу, без встроенного сервера.

Собирает WebUI (tools/build_webui.py) во временную папку и поднимает образец стенда в режиме консоли
(node tools/serve_api.mjs --webui): страница — /backend/ с заголовком
«Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'none'», API — /backend/api/…
Затем открывает в headless Chrome /backend/?selftest: самопроверка проходит сценарии интерфейса против
стенда по одному (как check_stand.py), адрес API берёт из <meta name="consolem-api">. Не прошло, если:
  - в самой сборке есть встроенный код (это проверяет и build_webui.py);
  - хоть один сценарий не прошёл, отчёт не пришёл;
  - браузер сообщил о нарушении политики (CSP-VIOLATION: заблокированный скрипт, атрибут on…, eval).

Запуск из корня репозитория:  python3 tools/check_webui.py
Код выхода 1, если что-то не так. Нужны Python 3, Node.js и Google Chrome.
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAIT_SEC = 600


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    tmp = tempfile.mkdtemp(prefix="consolem-webui-")
    out = os.path.join(tmp, "webui")
    build = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_webui.py"), "--out", out], capture_output=True, text=True)
    print(build.stdout.rstrip() or build.stderr.rstrip())
    if build.returncode:
        print("RESULT fail — сборка не собралась")
        return 1
    port = free_port()
    node = subprocess.Popen(["node", os.path.join(ROOT, "tools", "serve_api.mjs"), str(port), "--webui", out, "--exit-on-report"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    reader = threading.Thread(target=lambda: [lines.append(l.rstrip("\n")) for l in node.stdout], daemon=True)
    reader.start()
    time.sleep(1)
    url = f"http://127.0.0.1:{port}/backend/?selftest&report=/__report"
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
    browser = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", f"--user-data-dir={tmp}/profile",
         "--window-size=1600,1000", "--remote-debugging-port=0", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started = time.time()
    try:
        node.wait(WAIT_SEC)
    except subprocess.TimeoutExpired:
        node.kill()
    finally:
        browser.kill()
        browser.wait()
        reader.join(5)
        shutil.rmtree(tmp, ignore_errors=True)
    csp = sorted({l for l in lines if l.startswith("CSP-VIOLATION")})
    report = [l for l in lines if not l.startswith(("CSP-VIOLATION", "Стенд:"))]
    passed = bool(report) and report[-1].strip() == "RESULT pass"
    for l in [l for l in report if not l.startswith("PASS")][-15:]:
        print(l)
    if not report:
        print(f"отчёт самопроверки не пришёл за {WAIT_SEC} с")
    for l in csp[:20]:
        print(l)
    ok = passed and not csp
    print(f"== Сборка под CSP консоли против стенда: самопроверка {'pass' if passed else 'fail'}, нарушений политики {len(csp)} ({time.time() - started:.0f} с)")
    print(f"RESULT {'pass' if ok else 'fail'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
