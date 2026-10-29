#!/usr/bin/env python3
"""Собрать эталонный набор api/fixtures/demo.json из прототипа 09.

Разовый перенос: до переделки данные макета жили константами в HTML и
достраивались демо-генерацией при старте. Скрипт открывает
index_09_one-psim.html в headless Chrome с остановленными часами
(CAPTURED_AT), после старта забирает из памяти всё, что в продукте хранит
бэкенд, и приводит к виду контракта api/openapi.json: идентификаторы — UUID,
коды вместо русских строк, числа вместо «4 ТБ», связи — id.

Так набор совпадает с тем, что прототип показывал до переделки. Дальше набор
правят руками: этот скрипт перезапишет правки, поэтому без --force он
отказывается писать поверх существующего файла.

Запуск из корня репозитория:
  python3 tools/extract_fixture.py --raw /tmp/raw.json   только снимок памяти
  python3 tools/extract_fixture.py --force               перезаписать набор
  python3 tools/extract_fixture.py --source index.html --raw /tmp/raw.json
                                                         снимок другого макета
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "index_09_one-psim.html")
OUT = os.path.join(ROOT, "api", "fixtures", "demo.json")
# Момент снимка: 12:00 по Москве. Демо-данные прав считают сроки от «сегодня»
CAPTURED_AT = "2026-10-29T09:00:00Z"

# Часы страницы стоят: new Date() и Date.now() — момент снимка
FREEZE = """<script>(()=>{const FIX=Date.parse("%s"),R=Date;
class D extends R{constructor(...a){if(a.length)super(...a);else super(FIX)}static now(){return FIX}}
window.Date=D;})();</script>""" % CAPTURED_AT

# Снимок памяти после старта: верхнеуровневые const прототипа видны из
# следующего <script>. Ссылки на объекты (домен → серверы) — id
DUMP = r"""<script>(()=>{
const refs={DEVICE_MODELS,WIZ,IPSUB,SYS:[...SYS],ARCH_KINDS,CLOUD_PROVIDERS,ARCH_STORAGE,VOL_STATES,REC_MODES,
  CLOUD_REGIONS,DEV_PARAMS,DET_TYPES,IP_SCAN_LIMIT,TRIGGER_KINDS,ACTION_KINDS,ACC_FEATURES,ACC_LV,ACC_DEFS,ACC_GF,
  ACC_GF_DEF,ACC_VIS,ACC_GLOB,ACC_RESTR,ACC_PLUGINS,ACC_TPL,ACC_TZ,ACC_TZN,ACC_STALE,ACC_SOON,DEVICE_STATUS_LABELS};
const out={
  capturedAt:new Date().toISOString(),
  domains:domains.map(d=>({...d,servers:(d.servers||[]).map(s=>s.id),unallocServers:(d.unallocServers||[]).map(s=>s.id)})),
  servers,devicePool,folders,arch,gpu:SERVER_GPU,
  disks:Object.fromEntries(servers.map(s=>[s.id,serverDisks(s.id)])),
  deviceDomain:DEVICE_DOMAIN,serverDomain:SERVER_DOMAIN,
  rules,ruleFires,access:accData().srv,cellLog:accData().cellLog||[],me:ACC_ME,
  settings:SETTINGS,journal:LOG_ROWS,
  discoverySeed:DEVICE_DISCOVERY_SEED,foundPlan:FOUND_PLAN,found,
  refs
};
// Данные, которых в прототипе 09 нет: «Автоматизация» основного макета
const extra={};
if(typeof SCHEDS!=="undefined")Object.assign(extra,{scheds:SCHEDS,dayGroups:DAY_GROUPS,objModes:OBJ_MODES,
  objModeElse,maintWindows:MAINT_WINDOWS,ruleHist,ruleLayouts:RULE_LAYOUTS,ruleMonitors:RULE_MONS});
if(Object.keys(extra).length)out.extra=extra;
const el=document.createElement("script");el.type="text/plain";el.id="__dump";
el.textContent=JSON.stringify(out).replace(/</g,"\\u003c");
document.body.appendChild(el);
})();</script>"""


def snapshot(source=SOURCE):
    with open(source, encoding="utf-8") as f:
        page = f.read()
    base = '<base href="file://%s/">' % ROOT
    page = page.replace("<head>", "<head>" + base + FREEZE, 1)
    page = page.replace("</body>", DUMP + "</body>", 1)
    tmp = tempfile.mkdtemp(prefix="consolem-fixture-")
    try:
        path = os.path.join(tmp, "page.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(page)
        chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
        res = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
             "--allow-file-access-from-files", f"--user-data-dir={tmp}/profile", "--dump-dom", "file://" + path],
            capture_output=True, text=True, timeout=120)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    m = re.search(r'<script type="text/plain" id="__dump">(.*?)</script>', res.stdout, re.S)
    if not m:
        sys.exit("Снимок не получен: страница не дошла до конца старта\n" + res.stderr[-2000:])
    return json.loads(html.unescape(m.group(1)) if "&quot;" in m.group(1) else m.group(1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", help="записать снимок памяти как есть и выйти")
    ap.add_argument("--force", action="store_true", help="перезаписать существующий набор")
    ap.add_argument("--source", default=os.path.relpath(SOURCE, ROOT),
                    help="макет, из которого снимать данные (по умолчанию %(default)s)")
    args = ap.parse_args()
    raw = snapshot(os.path.join(ROOT, args.source))
    if args.raw:
        with open(args.raw, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, indent=1)
        print(f"Снимок: {args.raw}")
        return 0
    if os.path.exists(OUT) and not args.force:
        sys.exit(f"{OUT} уже есть и мог быть поправлен руками; перезаписать — --force")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from fixture_normalize import normalize

    fixture = normalize(raw, CAPTURED_AT)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"Набор: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
