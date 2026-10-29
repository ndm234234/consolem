#!/usr/bin/env python3
"""Внешний вид не изменился: прототип 10 (через API) рисует то же, что прототип 09 (константы).

Оба прототипа открываются в headless Chrome с остановленными часами (как при сборке набора), проходят
одни и те же экраны — разделы, срезы, карточки с вкладками, светлая и тёмная тема, RU и EN — и после
каждого шага снимается разметка страницы. В разметке прототипа 10 UUID заменяются старыми id
прототипа 09 (по выгрузке tools/extract_fixture.py), затем снимки сравниваются построчно.

Запуск из корня репозитория:
  python3 tools/compare_screens.py              все экраны, расхождения — в консоль
  python3 tools/compare_screens.py --diff DIR   ещё и снимки обоих прототипов в DIR
Код выхода 1, если хоть один экран отличается.
"""
import difflib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_fixture  # noqa: E402
from fixture_normalize import normalize  # noqa: E402

# Известные расхождения: строка разметки, которая может отличаться, и почему. Всё остальное — ошибка
KNOWN = [
    (r'data-orig="(AxxonNet|Облачный AxxonNet)"|<option value="Облачный AxxonNet"( selected="")?>',
     "режим email-оповещателя: в данных 09 записано «AxxonNet», которого нет в списке; в 10 — код axxonnet, "
     "показан пунктом «Облачный AxxonNet». Внешне то же: браузер и в 09 показывал первый пункт"),
    (r'<span class="sub">идёт поиск в сети \d+%</span>',
     "поиск в сети, который карточка запускает сама: в 09 первая находка появлялась в тот же миг, в 10 — с ответом "
     "сервера, через мгновение; снимок снят до ответа"),
    (r'^<input type="text" value="[^"]*" oninput="setD\(true\)"( onchange="settingSet\(\'[\w.]+\',this\.value\)")?>$|'
     r'^<select onchange="(setD\(true\)|settingSet\(\'[\w.]+\',this\.value\))">$|^<option( value="[^"]*")?( selected="")?>[^<]*</option>$',
     "опции: поле сохраняется на сервер при смене (раньше только помечало «есть изменения»), у списка отмечен вариант, "
     "который хранит сервер; внешне то же"),
]

BEFORE = "index_09_one-psim.html"
AFTER = "index_10_api-server.html"

# Экраны: [раздел, id объекта прототипа 09 или null, вкладка или null, действия до показа]
SCREENS = [
    ["hw", None, None, []],
    ["hw", "d1", None, []],
    ["hw", "su1", None, []],
    ["hw", "s1", "gen", []], ["hw", "s1", "disk", []], ["hw", "s1", "net", []], ["hw", "s1", "svc", []],
    ["hw", "c1", "gen", []], ["hw", "c1", "vid", []], ["hw", "c1", "rec", []], ["hw", "c1", "det", []], ["hw", "c1", "io", []],
    ["hw", "c2r", "gen", []],
    ["hw", "ips1", "gen", []], ["hw", "nc3", "gen", []], ["hw", "ch1", "gen", []],
    ["hw", "a1", "gen", []], ["hw", "a11", "gen", []], ["hw", "a1:v1", "gen", []],
    ["hw", "f1", None, []], ["hw", "t1", None, []], ["hw", "acfa1", None, []], ["hw", "em1", None, []], ["hw", "pos1", None, []],
    ["hw", None, None, ["setSlice('cam')"]], ["hw", None, None, ["setSlice('acfa')"]], ["hw", None, None, ["setSlice('srv')"]],
    ["hw", None, None, ["setSlice('arch')"]], ["hw", None, None, ["setSlice('det')"]],
    ["hw", "c1", "gen", ["setTheme('light')"]],
    ["hw", "c1", "gen", ["setUiLang('en')"]],
    ["hw", "s1", "gen", ["setUiLang('en')", "setTheme('dark')"]],
    ["rules", None, None, []],
    ["rules", None, None, ["rule=id('r2')"]],
    ["rules", None, None, ["rule=id('r3')"]],
    ["sys", None, None, ["sys='ntp'"]],
    ["sys", None, None, ["sys='sec'"]],
    ["sys", None, None, ["sys='mail'"]],
    ["sys", None, None, ["sys='lic'"]],
    ["log", None, None, ["logFilt='all'"]],
    ["log", None, None, ["logFilt='alarm'"]],
    ["acc", None, None, []],
    ["rules", None, None, ["setUiLang('en')"]],
]

# Случайность в разметке (разброс шагов очереди, подсказки) — одна и та же в обоих прототипах
RANDOM = "<script>Math.random=(()=>{let s=1;return()=>((s=s*16807%2147483647)-1)/2147483646})();</script>"

RUN = r"""<script>(()=>{
const IDS=__IDS__, SCREENS=__SCREENS__, out=[];
const id=(x)=>x==null?null:(IDS[x]||x);
const snap=()=>{const b=document.body.cloneNode(true);b.querySelectorAll("script").forEach(s=>s.remove());return b.innerHTML};
// Путь в шапке сворачивается по ширине: снимать — когда шрифты загружены, иначе ширина плавает
const ready=Promise.all([window.appReady||Promise.resolve(),document.fonts.ready]);
ready.then(()=>{
  for(const [app,obj,tab,acts] of SCREENS){
    try{
      acts.forEach(a=>eval(a));
      goApp(app);
      if(obj)pick(id(obj));
      if(tab)goTab(tab);
      out.push(snap());
    }catch(e){out.push("ОШИБКА: "+e.message)}
  }
  const el=document.createElement("script");el.type="text/plain";el.id="__screens";
  el.textContent=JSON.stringify(out).replace(/</g,"\\u003c");document.body.appendChild(el);
});
})();</script>"""


def capture(page_name, ids):
    with open(os.path.join(ROOT, page_name), encoding="utf-8") as f:
        page = f.read()
    run = RUN.replace("__IDS__", json.dumps(ids)).replace("__SCREENS__", json.dumps(SCREENS))
    page = page.replace("<head>", '<head><base href="file://%s/">' % ROOT + extract_fixture.FREEZE + RANDOM, 1)
    page = page.replace("</body>", run + "</body>", 1)
    tmp = tempfile.mkdtemp(prefix="consolem-screens-")
    try:
        path = os.path.join(tmp, "page.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(page)
        chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
        res = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files",
             f"--user-data-dir={tmp}/profile", "--window-size=1600,1000", "--virtual-time-budget=20000", "--dump-dom", "file://" + path],
            capture_output=True, text=True, timeout=300)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    m = re.search(r'<script type="text/plain" id="__screens">(.*?)</script>', res.stdout, re.S)
    if not m:
        sys.exit(f"{page_name}: снимки не получены\n" + res.stderr[-1500:])
    return json.loads(m.group(1))


def lines(markup):
    # Разметка по тегам — так расхождение видно строкой, а не одной длинной строкой страницы
    return [x for x in re.sub(r">\s*<", ">\n<", markup).split("\n") if x.strip()]


def main():
    out_dir = sys.argv[sys.argv.index("--diff") + 1] if "--diff" in sys.argv else None
    raw = extract_fixture.snapshot()
    normalize(raw, extract_fixture.CAPTURED_AT)
    ids = normalize.ids
    back = {uid: old for old, uid in ids.items()}
    uuid_re = re.compile(r"[0-9a-f]{8}-0000-4000-8000-000000000000")
    before = capture(BEFORE, {})
    after = [uuid_re.sub(lambda m: back.get(m.group(0), m.group(0)), s) for s in capture(AFTER, ids)]
    bad = 0
    for i, (screen, a, b) in enumerate(zip(SCREENS, before, after)):
        name = " · ".join(str(x) for x in screen[:3] if x) + (f" · {', '.join(screen[3])}" if screen[3] else "")
        if a == b:
            print(f"PASS  {name}")
            continue
        diff = list(difflib.unified_diff(lines(a), lines(b), "09", "10", n=0, lineterm=""))
        changed = [d[1:] for d in diff if d[:1] in "+-" and d[:3] not in ("+++", "---")]
        why = {note for pattern, note in KNOWN for d in changed if re.search(pattern, d)}
        if all(any(re.search(pattern, d) for pattern, _ in KNOWN) for d in changed):
            print(f"KNOWN {name} — {'; '.join(sorted(why))}")
            continue
        bad += 1
        print(f"FAIL  {name} — {sum(1 for d in diff if d[:1] in '+-' and d[:3] not in ('+++', '---'))} строк отличается:")
        for d in diff[2:14]:
            print("      " + html.unescape(d)[:220])
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            for tag, s in (("09", a), ("10", b)):
                with open(os.path.join(out_dir, f"{i:02d}-{tag}.html"), "w", encoding="utf-8") as f:
                    f.write("\n".join(lines(s)))
    print(f"RESULT {'fail' if bad else 'pass'} — экранов {len(SCREENS)}, отличаются {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
