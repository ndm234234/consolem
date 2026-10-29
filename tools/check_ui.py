#!/usr/bin/env python3
"""Сценарии интерфейса прототипа 10: действия пользователя → запросы API → то, что видно на экране.

Каждый сценарий tests/ui-*.js выполняется на свежей странице index_10_api-server.html в headless
Chrome: страница загружает данные со встроенного сервера, сценарий жмёт кнопки и вызывает те же
функции, что и клики, и сверяет кэш интерфейса, разметку и ответы сервера. Виртуальное время:
отсчёты удаления и шаги операций идут без ожидания.

Запуск из корня репозитория:
  python3 tools/check_ui.py                       все сценарии
  python3 tools/check_ui.py --latency 300         с задержкой ответа, как по медленной сети
  python3 tools/check_ui.py tests/ui-domains.js   один сценарий
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
PAGE = "index_10_api-server.html"

HELPERS = r"""<script>(()=>{
const log=[];
const ok=(c,m)=>log.push((c?"PASS  ":"FAIL  ")+m);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Ждать условия: ответ сервера и событие потока приходят не сразу
async function until(fn,ms=20000){const t=Date.now();while(Date.now()-t<ms){try{if(fn())return true}catch(e){}await sleep(25)}return false}
// Подтвердить диалог: ввести число удаляемых объектов (если спрашивают) и нажать кнопку
async function confirmWith(n){const inp=document.getElementById("confirmCountInp");if(inp&&n!=null){inp.value=String(n);inp.dispatchEvent(new Event("input"))}document.getElementById("confirmOk").click()}
window.UiCheck=(fn)=>window.appReady.then(()=>fn({ok,until,sleep,confirmWith})).catch(e=>ok(false,"исключение: "+e.message+" "+(e.stack||"").split("\n")[1])).then(()=>{
  const el=document.createElement("script");el.type="text/plain";el.id="__ui";el.textContent=JSON.stringify(log).replace(/</g,"\\u003c");document.body.appendChild(el);
});
})();</script>"""


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
            capture_output=True, text=True, timeout=300)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    m = re.search(r'<script type="text/plain" id="__ui">(.*?)</script>', res.stdout, re.S)
    return json.loads(m.group(1)) if m else ["FAIL  сценарий не дошёл до конца"]


def main():
    args = sys.argv[1:]
    query = ""
    if "--latency" in args:
        i = args.index("--latency")
        query = f"?latency={int(args[i + 1])}"
        del args[i:i + 2]
    files = args or sorted(glob.glob(os.path.join(ROOT, "tests", "ui-*.js")))
    failed = 0
    for f in files:
        lines = run(f, query)
        bad = [x for x in lines if not x.startswith("PASS")]
        failed += len(bad)
        print(f"== {os.path.relpath(f, ROOT)}{' ' + query if query else ''}: {len(lines) - len(bad)} из {len(lines)}")
        for x in lines:
            print("   " + x)
    print(f"RESULT {'fail' if failed else 'pass'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
