#!/usr/bin/env python3
"""Собрать WebUI для консоли VMS из index.html: файлами, без встроенного кода, со списком MANIFEST.json.

Консоль отдаёт страницу под CSP «script-src 'self'; object-src 'none'; base-uri 'none'» (запрос w2c,
api/requests/2026-10-29-w2c-webui-csp-request.md): код — только файлами со своего адреса, встроенный
<script> и атрибуты onclick="…" не выполняются. Поэтому:
  - главный встроенный <script> index.html → app.js, встроенный <style> и assets/one-psim/bridge.css
    (с его @import) → app.css;
  - встроенного сервера и наборов в сборке нет (api/server.js, fixture.js, contract.js, rule-engine.js):
    интерфейс работает с бэкендом консоли по адресу из <meta name="consolem-api" content="api">
    (относительно страницы: страница /backend/, API /backend/api/…), по 401 уходит на
    <meta name="consolem-login" content="../">;
  - у ссылок на файлы — ?v=<начало SHA-256>, чтобы браузер не взял старый файл из кэша.
Сборка повторяема: из одного index.html — одни и те же байты. Проверки — в tools/check_webui.py.

Запуск из корня репозитория:
  python3 tools/build_webui.py               собрать в build/webui/
  python3 tools/build_webui.py --out DIR     собрать в DIR
"""
import hashlib
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "build", "webui")
API_URL = "api"
LOGIN_URL = "../"

# Подключаемые скрипты index.html: что из них идёт в сборку и под каким именем
SCRIPTS = {
    "assets/i18n-en.js": ("i18n-en.js", "английские подписи интерфейса"),
    "api/openapi.js": ("openapi.js", "контракт API: интерфейс берёт из него, какие поля записи можно менять и какую операцию требует каждая кнопка"),
    "api/client.js": ("client.js", "клиент API: запросы, If-Match, поток событий SSE, 401 → вход"),
    # только для макета: встроенный тестовый сервер и его данные
    "api/fixture.js": None,
    "api/contract.js": None,
    "api/rule-engine.js": None,
    "api/server.js": None,
}
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2"}


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def inline_css(rel, seen=()):
    """CSS-файл с @import, развёрнутыми на место; пути url() — относительно корня сборки."""
    css = read(rel)
    folder = os.path.dirname(rel)

    def imp(m):
        sub = os.path.normpath(os.path.join(folder, m.group(1)))
        if sub in seen:
            sys.exit(f"{rel}: @import по кругу — {sub}")
        return f"/* ── {sub} ── */\n" + inline_css(sub, seen + (sub,))

    css = re.sub(r'@import\s+url\("([^"]+)"\)\s*;', imp, css)
    fonts = []

    def url(m):
        u = m.group(1)
        if u.startswith(("data:", "#")):
            return m.group(0)
        src = os.path.normpath(os.path.join(folder, u))
        fonts.append(src)
        return f'url("fonts/{os.path.basename(src)}")'

    css = re.sub(r'url\("([^"]+)"\)', url, css)
    inline_css.files.update(fonts)
    return css


inline_css.files = set()


def build(out):
    page = read("index.html")
    m = re.search(r"\n<style>\n(.*?)\n</style>\n", page, re.S)
    if not m or page.count("<style>") != 1:
        sys.exit("index.html: ждали один встроенный <style>")
    style = m.group(1)
    starts = [x.start() for x in re.finditer(r"<script>", page)]
    if len(starts) != 1:
        sys.exit(f"index.html: ждали один встроенный <script>, их {len(starts)}")
    s0 = starts[0]
    s1 = page.index("</script>", s0)
    app = page[s0 + len("<script>"):s1].lstrip("\n")

    files = {}  # имя → (байты, назначение)
    link = '<link rel="stylesheet" href="assets/one-psim/bridge.css">'
    if page.count(link) != 1:
        sys.exit("index.html: не нашли подключение assets/one-psim/bridge.css")
    css = "/* Собрано tools/build_webui.py из index.html и assets/one-psim — руками не править */\n" + style + "\n/* ── assets/one-psim/bridge.css ── */\n" + inline_css("assets/one-psim/bridge.css")
    files["app.css"] = (css.encode("utf-8"), "стили: встроенный <style> index.html и дизайн-система assets/one-psim")
    files["app.js"] = (("/* Собрано tools/build_webui.py из index.html — руками не править */\n" + app).encode("utf-8"), "интерфейс: код index.html")
    for src in sorted(inline_css.files):
        with open(os.path.join(ROOT, src), "rb") as f:
            files["fonts/" + os.path.basename(src)] = (f.read(), "шрифт интерфейса (Inter)")

    def ver(name):
        return hashlib.sha256(files[name][0]).hexdigest()[:12]

    head_scripts = []
    for src, target in SCRIPTS.items():
        tag = f'<script src="{src}"></script>'
        if page.count(tag) != 1:
            sys.exit(f"index.html: не нашли {tag}")
        if target:
            name, why = target
            files[name] = (read(src).encode("utf-8"), why)
            head_scripts.append(name)
    # Шапка: подключения файлов сборки вместо макетных, адреса API и входа
    page = page[:s0] + f'<script src="app.js?v={ver("app.js")}"></script>' + page[s1 + len("</script>"):]
    page = page.replace(m.group(0), "\n", 1)
    page = page.replace(link, f'<link rel="stylesheet" href="app.css?v={ver("app.css")}">', 1)
    page = re.sub(r"<!-- API: контракт.*?-->\n", "", page)
    for src, target in SCRIPTS.items():
        tag = f'<script src="{src}"></script>'
        page = page.replace(tag + "\n", (f'<script src="{target[0]}?v={ver(target[0])}"></script>\n' if target else ""), 1)
    meta = (f'<meta name="consolem-api" content="{API_URL}">\n<meta name="consolem-login" content="{LOGIN_URL}">\n')
    page = page.replace('<meta name="viewport"', meta + '<meta name="viewport"', 1)
    page = page.replace("<!doctype html>\n", "<!doctype html>\n<!-- Собрано tools/build_webui.py из index.html — руками не править -->\n", 1)
    files["index.html"] = (page.encode("utf-8"), "входная страница: разметка index.html, подключает файлы сборки")

    problems = check_page(page)
    if problems:
        sys.exit("Сборка не годится для CSP:\n  " + "\n  ".join(problems))

    if os.path.isdir(out):
        shutil.rmtree(out)
    order = ["index.html", "app.js", "app.css", "client.js", "openapi.js", "i18n-en.js"] + sorted(n for n in files if n.startswith("fonts/"))
    assert sorted(order) == sorted(files), (order, sorted(files))
    manifest = []
    for name in order:
        data, why = files[name]
        path = os.path.join(out, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        manifest.append({"name": name, "type": TYPES[os.path.splitext(name)[1]], "purpose": why, "size": len(data),
                         "sha256": hashlib.sha256(data).hexdigest()})
    with open(os.path.join(out, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return manifest


def check_page(page):
    """Что не выполнится под «script-src 'self'»: встроенный код в входной странице."""
    out = []
    for m in re.finditer(r"<script\b([^>]*)>", page):
        if "src=" not in m.group(1):
            out.append(f"встроенный <script> на {page.count(chr(10), 0, m.start()) + 1}-й строке")
    for m in re.finditer(r"""<[a-zA-Z][^>]*?\s(on[a-z]+)\s*=""", page):
        out.append(f"атрибут {m.group(1)} на {page.count(chr(10), 0, m.start()) + 1}-й строке")
    if re.search(r"""(href|src)\s*=\s*["']?\s*javascript:""", page, re.I):
        out.append("ссылка javascript:")
    if "<base" in page:
        out.append("<base> (base-uri 'none')")
    return out


def main():
    args = sys.argv[1:]
    out = os.path.abspath(args[args.index("--out") + 1]) if "--out" in args else DEFAULT_OUT
    manifest = build(out)
    total = sum(x["size"] for x in manifest)
    for x in manifest:
        print(f"{x['name']:28} {x['size']:>9}  {x['sha256'][:16]}…")
    print(f"Собрано в {os.path.relpath(out, ROOT)}: {len(manifest)} файлов, {total // 1024} КБ, список — MANIFEST.json")


if __name__ == "__main__":
    main()
