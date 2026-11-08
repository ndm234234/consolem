#!/usr/bin/env python3
"""Собрать WebUI для консоли VMS из index.html (или --page FILE; --api и --tests — папки API и тестов): файлами, без встроенного кода, со списком MANIFEST.json.

Консоль отдаёт страницу под CSP «script-src 'self'; object-src 'none'; base-uri 'none'» (запрос w2c,
api/requests/2026-10-29-184430Z-w2c-webui-csp-request.md): код — только файлами со своего адреса, встроенный
<script> и атрибуты onclick="…" не выполняются. Поэтому:
  - главный встроенный <script> index.html → app.js, встроенный <style> и assets/one-psim/bridge.css
    (с его @import) → app.css;
  - обычная страница работает без встроенного сервера и наборов (api/server.js, fixture.js, contract.js, rule-engine.js):
    они лежат в demo/ и грузятся только в учебном режиме раздела «Обучение» (?demo, assets/tour.js);
    интерфейс работает с бэкендом консоли по адресу из <meta name="consolem-api" content="api">
    (относительно страницы: страница /backend/, API /backend/api/…), по 401 уходит на
    <meta name="consolem-login" content="../">;
  - у ссылок на файлы — ?v=<начало SHA-256>, чтобы браузер не взял старый файл из кэша;
  - learn-catalog.json — каталог учебных глав для бэкенда VMS (запрос w2c, ADR-VMS-0004): его пишет
    node tools/learn_catalog.mjs из тех же tour.js и tour-demos.js, что идут в сборку (нужен Node.js). Без обучения —
    тот же файл с available:false и пустым topics: потребитель видит, что запустить материал здесь нельзя.
Сборка повторяема: из одного index.html — одни и те же байты. Сборка падает, если во входной странице
остался встроенный код или страница, стили, код ссылаются на свой файл, которого в сборке нет (новое
подключение в index.html — строкой в SCRIPTS). Проверка под CSP — tools/check_webui.py.

Запуск из корня репозитория:
  python3 tools/build_webui.py               собрать в build/webui/
  python3 tools/build_webui.py --out DIR     собрать в DIR
  python3 tools/build_webui.py --without-learn  без раздела «Обучение»: без движка показа и файлов demo/
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

import cli_paths

API = cli_paths.opt("api", "api")
TESTS = cli_paths.opt("tests", "tests")
PAGE = cli_paths.opt("page", "index.html")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "build", "webui")
API_URL = "api"
LOGIN_URL = "../"

# Подключаемые скрипты index.html: что из них идёт в сборку и под каким именем
SCRIPTS = {
    "assets/i18n-en.js": ("i18n-en.js", "английские подписи интерфейса"),
    f"{API}/openapi.js": ("openapi.js", "контракт API: интерфейс берёт из него, какие поля записи можно менять и какую операцию требует каждая кнопка"),
    f"{API}/client.js": ("client.js", "клиент API: запросы, If-Match, поток событий SSE, 401 → вход"),
    f"{API}/whep-stub.js": ("whep-stub.js", "подставной WHEP стенда: отвечает только на адрес stub://, настоящий бэкенд такого адреса не выдаёт"),
    # только для макета: встроенный тестовый сервер и его данные
    f"{API}/fixture.js": None,
    f"{API}/contract.js": None,
    f"{API}/rule-engine.js": None,
    f"{API}/server.js": None,
}
# Реестр видов, склад объектов и хуки профилей встроенного сервера — тоже только для макета
for _name in ("kinds.js", "units.js", "profiles.js"):
    SCRIPTS[f"{API}/{_name}"] = None
# Обучение идёт только на встроенном сервере: в сборке он лежит в demo/, с --without-learn раздела нет (build, learn=False)
SCRIPTS["assets/tour.js"] = None
SCRIPTS["assets/tour-demos.js"] = None
LEARN_SCRIPTS = {
    "assets/tour.js": ("tour.js", "раздел «Обучение»: движок показа и учебный режим"),
    "assets/tour-demos.js": ("tour-demos.js", "раздел «Обучение»: темы и главы"),
}
# Сервер показа в порядке подключения; грузится только при ?demo (assets/tour.js)
DEMO_FILES = ["fixture.js", "contract.js", "rule-engine.js", "kinds.js", "units.js", "profiles.js", "server.js"]
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".mp4": "video/mp4", ".json": "application/json"}
CATALOG_FORMAT = "consolem-learn-catalog/1"


def learn_catalog(learn):
    """Каталог учебных глав: из тех же тем, что исполняет показ (tools/learn_catalog.mjs), без обучения — пустой с признаком."""
    if not learn:
        empty = {"format": CATALOG_FORMAT, "version": None, "available": False, "reason": "сборка без раздела «Обучение» (--without-learn)", "topics": []}
        return (json.dumps(empty, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    node = shutil.which("node")
    if not node:
        sys.exit("Каталог учебных глав собирает Node.js (tools/learn_catalog.mjs): установите node или соберите с --without-learn")
    res = subprocess.run([node, os.path.join(ROOT, "tools", "learn_catalog.mjs"), "--tour", "assets/tour.js", "--demos", "assets/tour-demos.js"], capture_output=True, text=True, cwd=ROOT)
    if res.returncode:
        sys.exit("Каталог учебных глав не собрался:\n" + res.stderr.strip())
    return res.stdout.encode("utf-8")


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


def build(out, learn=True):
    scripts = {**SCRIPTS, **LEARN_SCRIPTS} if learn else SCRIPTS
    page = read(PAGE)
    m = re.search(r"\n<style>\n(.*?)\n</style>\n", page, re.S)
    if not m or page.count("<style>") != 1:
        sys.exit(f"{PAGE}: ждали один встроенный <style>")
    style = m.group(1)
    starts = [x.start() for x in re.finditer(r"<script>", page)]
    if len(starts) != 1:
        sys.exit(f"{PAGE}: ждали один встроенный <script>, их {len(starts)}")
    s0 = starts[0]
    s1 = page.index("</script>", s0)
    app = page[s0 + len("<script>"):s1].lstrip("\n")

    files = {}  # имя → (байты, назначение)
    link = '<link rel="stylesheet" href="assets/one-psim/bridge.css">'
    if page.count(link) != 1:
        sys.exit(f"{PAGE}: не нашли подключение assets/one-psim/bridge.css")
    css = f"/* Собрано tools/build_webui.py из {PAGE} и assets/one-psim — руками не править */\n" + style + "\n/* ── assets/one-psim/bridge.css ── */\n" + inline_css("assets/one-psim/bridge.css")
    files["app.css"] = (css.encode("utf-8"), "стили: встроенный <style> index.html и дизайн-система assets/one-psim")
    files["app.js"] = ((f"/* Собрано tools/build_webui.py из {PAGE} — руками не править */\n" + app).encode("utf-8"), "интерфейс: код index.html")
    for src in sorted(inline_css.files):
        with open(os.path.join(ROOT, src), "rb") as f:
            files["fonts/" + os.path.basename(src)] = (f.read(), "шрифт интерфейса (Inter)")

    with open(os.path.join(ROOT, "assets", "stub-piece.mp4"), "rb") as f:
        files["assets/stub-piece.mp4"] = (f.read(), "подставной кусок стенда: 60 с тестовой картинки, отдаётся только по адресу stub://")

    def ver(name):
        return hashlib.sha256(files[name][0]).hexdigest()[:12]

    head_scripts = []
    for src, target in scripts.items():
        tag = f'<script src="{src}"></script>'
        if page.count(tag) != 1:
            # Прототип, скопированный до раздела «Обучение», собирается без него
            if src in LEARN_SCRIPTS:
                continue
            sys.exit(f"{PAGE}: не нашли {tag}")
        if target:
            name, why = target
            files[name] = (read(src).encode("utf-8"), why)
            head_scripts.append(name)
    demo_files = []
    files["learn-catalog.json"] = (learn_catalog("tour.js" in files), "каталог учебных глав для бэкенда VMS: ID тем и глав, название, цель, язык, учебный набор, отпечаток; без обучения — available:false")
    if "tour.js" in files:
        for name in DEMO_FILES:
            files["demo/" + name] = (read(f"{API}/{name}").encode("utf-8"), "сервер показа раздела «Обучение»: только в учебном режиме, с API консоли не работает")
            demo_files.append("demo/" + name)
    # Шапка: подключения файлов сборки вместо макетных, адреса API и входа
    page = page[:s0] + f'<script src="app.js?v={ver("app.js")}"></script>' + page[s1 + len("</script>"):]
    page = page.replace(m.group(0), "\n", 1)
    page = page.replace(link, f'<link rel="stylesheet" href="app.css?v={ver("app.css")}">', 1)
    page = re.sub(r"<!-- API: контракт.*?-->\n", "", page)
    for src, target in scripts.items():
        tag = f'<script src="{src}"></script>'
        if target and target[0] not in files:
            continue
        page = page.replace(tag + "\n", (f'<script src="{target[0]}?v={ver(target[0])}"></script>\n' if target else ""), 1)
    meta = (f'<meta name="consolem-api" content="{API_URL}">\n<meta name="consolem-login" content="{LOGIN_URL}">\n')
    if demo_files:
        meta += '<meta name="consolem-demo-files" content="' + ",".join(f"{n}?v={ver(n)}" for n in demo_files) + '">\n'
    page = page.replace('<meta name="viewport"', meta + '<meta name="viewport"', 1)
    page = page.replace("<!doctype html>\n", f"<!doctype html>\n<!-- Собрано tools/build_webui.py из {PAGE} — руками не править -->\n", 1)
    files["index.html"] = (page.encode("utf-8"), "входная страница: разметка index.html, подключает файлы сборки")

    problems = check_page(page) + check_refs(files)
    if problems:
        sys.exit("Сборка не годится для консоли:\n  " + "\n  ".join(problems))

    if os.path.isdir(out):
        shutil.rmtree(out)
    order = ["index.html", "app.js", "app.css", "client.js", "whep-stub.js", "openapi.js", "i18n-en.js", "assets/stub-piece.mp4"] + sorted(n for n in files if n.startswith("fonts/"))
    order += [n for n in ("tour.js", "tour-demos.js") if n in files] + ["learn-catalog.json"] + demo_files
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


# Файлы, на которые код ссылается, но в сборку они не идут: самопроверка ?selftest (в консоли её нет)
NOT_IN_BUILD = {f"{TESTS}/selftest.js"}
FILE = r"[\w./-]+\.(?:js|css|png|svg|jpe?g|gif|webp|ico|woff2?|ttf|json|html)"
LOCAL_FILE = r"(?![a-z][a-z0-9+.-]*:|//|#)" + FILE  # не http:, data:, blob:, //…, #…


def check_refs(files):
    """Свои файлы, на которые ссылается сборка, — все в сборке: новое подключение в index.html
    (<script src>, <link href>, картинка) без строки в SCRIPTS собралось бы молча, а в консоли не загрузилось."""
    out = []

    def need(where, ref):
        name = os.path.normpath(re.split(r"[?#]", ref)[0]).replace(os.sep, "/")
        if name not in files and name not in NOT_IN_BUILD:
            out.append(f"{where} ссылается на {ref}, его нет в сборке — добавьте его в tools/build_webui.py (скрипт — в SCRIPTS) или уберите ссылку")

    page = files["index.html"][0].decode("utf-8")
    for m in re.finditer(r"""\s(?:src|href|poster|data)\s*=\s*["']?(%s(?:\?[^"'\s>]*)?)""" % LOCAL_FILE, page, re.I):
        need("index.html", m.group(1))
    css = files["app.css"][0].decode("utf-8")
    for m in re.finditer(r"""url\(\s*["']?(%s)""" % LOCAL_FILE, css, re.I):
        need("app.css", m.group(1))
    app = files["app.js"][0].decode("utf-8")
    for m in re.finditer(r"""["'`]((?:assets|%s|%s|fonts)/%s)["'`]""" % (re.escape(API), re.escape(TESTS), FILE), app):
        need("app.js", m.group(1))
    return out


def main():
    args = sys.argv[1:]
    out = os.path.abspath(args[args.index("--out") + 1]) if "--out" in args else DEFAULT_OUT
    manifest = build(out, learn="--without-learn" not in args)
    total = sum(x["size"] for x in manifest)
    for x in manifest:
        print(f"{x['name']:28} {x['size']:>9}  {x['sha256'][:16]}…")
    print(f"Собрано в {os.path.relpath(out, ROOT)}: {len(manifest)} файлов, {total // 1024} КБ, список — MANIFEST.json")


if __name__ == "__main__":
    main()
