#!/usr/bin/env python3
"""Проверка карты кода (tools/outline.py): верны ли её границы и видит ли --check, что макет ушёл
от соглашений.

Карта опирается на лексер (глубина скобок, строки, шаблоны, комментарии, регулярные выражения) и на
соглашения index.html: заголовки «// ── … ──», paint() с «const ui={…}», вкладки в tabsFor/tabsForHand
и проверки tab==="id". Скрипт портит копию index.html так, как может измениться код, и требует,
чтобы --check упал с нужными словами; добавляет законный код, которого карта не должна пугаться, и
требует, чтобы --check прошёл, а диапазоны остались верными; сверяет диапазоны функций с исходником.

Запуск из корня репозитория, после правки tools/outline.py:
  python3 tools/check_outline.py
Код выхода 1, если хоть одна проверка не прошла.
"""
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTLINE = os.path.join(ROOT, "tools", "outline.py")
sys.path.insert(0, os.path.join(ROOT, "tools"))
import outline  # noqa: E402

# Прототипы, на которых карта обещана (сделаны с нынешнего index.html); старые 01–03 — до соглашений
PROTOS = ["index_33_rezhimy-i-osobye-dni.html", "index_35_pos-titry.html", "index_37_vstroennoe-hranilishche.html"]
failed = 0


def ok(cond, what):
    global failed
    print(("PASS " if cond else "FAIL ") + what)
    if not cond:
        failed += 1


def run(path, *args):
    res = subprocess.run([sys.executable, OUTLINE, path, *args], capture_output=True, text=True, timeout=60)
    return res.returncode, res.stdout + res.stderr


def with_copy(text, fn):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "index.html")
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return fn(p)


def broken(text, name, must_say):
    """Копия index.html с порчей → --check должен упасть и сказать must_say."""
    code, out = with_copy(text, lambda p: run(p, "--check"))
    ok(code == 1 and must_say in out, f"--check замечает: {name} (код {code}, ждали «{must_say}»)")
    if code != 1 or must_say not in out:
        print("     " + out.strip().replace("\n", "\n     "))


def fine(text, name, fn_name, n_lines):
    """Копия с законной правкой → --check проходит, у функции fn_name ровно n_lines строк."""
    def go(p):
        code, out = run(p, "--check")
        _, d = run(p, "-d", fn_name)
        return code, out, d
    code, out, d = with_copy(text, go)
    m = re.search(r"\((\d+) строк\)", d)
    got = int(m.group(1)) if m else None
    ok(code == 0 and got == n_lines, f"не пугается: {name} (код {code}; {fn_name} — {got} строк, ждали {n_lines})")
    if code != 0 or got != n_lines:
        print("     " + (out + d).strip().replace("\n", "\n     "))


def before_paint(text, block):
    return text.replace("\nfunction paint(){", "\n" + block + "\nfunction paint(){", 1)


def ends_on_brace(lines, a, b):
    """Функция кончается своей скобкой: последняя строка кончается «}» (можно с «)», «;»), а следующая
    строка кода стоит не правее начала функции — то есть тело не продолжается за границей."""
    ind = lambda s: len(s) - len(s.lstrip())
    if not re.search(r"\}[)\];,]*\s*(//.*)?$", lines[b - 1]):
        return False
    in_cmt = False
    for s in lines[b:]:
        t = s.strip()
        if in_cmt:
            in_cmt = "*/" not in t
            continue
        if t.startswith("/*"):
            in_cmt = "*/" not in t
            continue
        if t and not t.startswith("//"):
            return ind(s) <= ind(lines[a - 1])
    return True


def main():
    src = os.path.join(ROOT, "index.html")
    text = open(src, encoding="utf-8").read()
    code, out = run(src, "--check")
    ok(code == 0, "index.html: опоры карты на месте")
    if code:
        print(out)

    # ── Порча: --check должен упасть ──
    broken(text.replace("// ── ", "// == "), "все заголовки разделов другого вида", "заголовков")
    n = [0]

    def third(m):
        n[0] += 1
        return f"// --- {m.group(1)} ---" if n[0] % 3 == 0 else m.group(0)
    broken(re.sub(r"// ── (.*?) ─+", third, text), "каждый третий заголовок другого вида", "похожих на заголовок")
    n[0] = 0
    broken(re.sub(r"// ── (.*?) ─+", lambda m: third(m).replace("// --- ", "// == ").replace(" ---", " =="), text),
           "каждый третий заголовок вида «// == X ==»", "похожих на заголовок")
    broken(text.replace("function tabsForHand(", "function tabsByType(").replace("tabsForHand(n)", "tabsByType(n)"),
           "переименована tabsForHand", "нет объявлений верхнего уровня: tabsForHand")
    broken(re.sub(r"const ui=\{", "const screens={", text, count=1), "paint() без const ui", "paint()")
    broken(text.replace("function learnUI(", "function learnUi("), "paint() ссылается на переименованную функцию",
           "paint() ссылается на функции")
    broken(re.sub(r'\["([\w-]+)","', r"['\1','", text), "вкладки в одинарных кавычках", "вкладок")
    broken(re.sub(r"\btab(\s*===?\s*[\"'])", r"curTab\1", text), "вкладки проверяются не через tab===",
           "где рисуется, только")
    t = re.sub(r'(if\(n\.type==="(camera|domain)"\)return)\[\[.*', r'\1 TAB_TABLE.\2(n);', text)
    broken(t, "вкладки камеры и домена ушли в таблицу", "без списка")
    broken(before_paint(text, "function zzOpen(){return `<div>${x}</div>;}"), "незакрытая шаблонная строка",
           "лексер сбился")

    # ── Законный код: --check проходит, границы верны ──
    css = "\n".join(f".zz-ov{k}{{margin:{k}px}}" for k in range(40))
    fine(before_paint(text, "function zzCss(){\n  const st=document.createElement('style');\n  st.textContent=`\n"
                      + css + "\ninput[type=checkbox]{accent-color:red}\n`;\n  return st;\n}"),
         "40 строк CSS в шаблоне с нулевым отступом", "zzCss", 47)
    fine(before_paint(text, "function zzFlat(a){\nconst v=a*2;\nif(v>3)\nreturn v;\nreturn 0;\n}"),
         "тело функции без отступа", "zzFlat", 6)
    fine(re.sub(r"^function ", "  function ", text, flags=re.M), "все функции с отступом", "gear",
         int(re.search(r"\((\d+) строк\)", run(src, "-d", "gear")[1]).group(1)))
    fine(before_paint(text, "const zzRe=/[{(`'\"]/g, zzDiv=10/2/1;\nfunction zzAfterRe(){\n  return 1;\n}"),
         "регулярное выражение со скобками и деление", "zzAfterRe", 3)
    fine(before_paint(text, "const zzArrow = x =>\n  x + 1;\nfunction zzNext(){\n  return 2;\n}"),
         "инструкция продолжается на следующей строке", "zzArrow", 2)
    glued = ("let zzN = 0;\nzzN++\nfunction zzAa(){\n  return 1;\n}\nconst zzRe2 = /ab/\nfunction zzBb(){\n  return 2;\n}\n"
             "let zzMode = 1; // режимы: a, b,\nfunction zzCc(){\n  return 3;\n}\n/*\n  итог:\n*/\nfunction zzDd(){\n  return 4;\n}")
    for fn in ("zzAa", "zzBb", "zzCc", "zzDd"):
        fine(before_paint(text, glued), f"после «n++», рег. выражения, комментария с «,» и «:» — новая инструкция ({fn})", fn, 3)
    fine(before_paint(text, "</script>\n<script>\nfunction zzFirst(){\n  return 1;\n}"),
         "функция — первая строка нового <script>", "zzFirst", 3)

    # ── Диапазоны на настоящих файлах ──
    lines = text.split("\n")
    mp = outline.Map(src, lines)
    for name in outline.MUST_DEFINE:
        u = mp.named().get(name)
        ok(bool(u) and re.match(r"(?:async\s+)?function\s+%s\b" % name, lines[u[0] - 1].lstrip())
           and ends_on_brace(lines, u[0], u[1]), f"-d {name}: начинается объявлением и кончается своей скобкой"
           + (f" ({u[0]}-{u[1]})" if u else ""))
    fns = [u for u in mp.units if u[2] and re.match(r"(?:async\s+)?function", lines[u[0] - 1].lstrip())]
    bad = [u for u in fns if not ends_on_brace(lines, u[0], u[1])]
    ok(not bad, f"index.html: все {len(fns)} функций верхнего уровня кончаются своей скобкой"
       + (f"; нет: {', '.join(f'{u[2]} {u[0]}-{u[1]}' for u in bad[:5])}" if bad else ""))

    # Поиск: строка попадает в функцию, в диапазоне которой лежит; имя функции — первым
    a, b = mp.named()["gear"][:2]
    probe = next(i for i in range(a + 1, b) if re.search(r"[A-Za-z_$][\w$]{5,}", lines[i - 1]))
    word = re.search(r"[A-Za-z_$][\w$]{5,}", lines[probe - 1]).group(0)
    code, out = run(src, word, "-n", "300")
    ok(re.search(r"\b%d-%d\s+gear\b" % (a, b), out) is not None, f"поиск «{word}» (строка {probe}) кладёт её в gear {a}-{b}")
    res = subprocess.run([sys.executable, OUTLINE, "-d", "create", os.path.join(ROOT, "api", "server.js")],
                         capture_output=True, text=True, timeout=60)
    code, out = res.returncode, res.stdout + res.stderr
    ok(code == 0 and re.search(r"create: \d+-\d+", out) is not None, "файл после -d ИМЯ: «-d create api/server.js»")
    code, out = run(src, "--", "--accent")
    ok(code == 0 and "--accent" in out, "поиск слова с «-» в начале после «--»")
    code, out = run(src, "drow", "-n", "1")
    ok(re.search(r"\d+-\d+\s+drow\s", out) is not None, "поиск «drow»: функция с этим именем — первой")

    # Живые прототипы — копии index.html: опоры на месте. Прототипа нет (удалён после переноса) — пропуск.
    for f in PROTOS:
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            code, out = run(p, "--check")
            ok(code == 0, f"{f}: --check проходит")
            if code:
                print("     " + out.strip().replace("\n", "\n     "))

    # api/*.js: лексер проходит, функции модуля и вложенные в create() — со своими границами
    for f in sorted(os.listdir(os.path.join(ROOT, "api"))):
        if f.endswith(".js"):
            p = os.path.join(ROOT, "api", f)
            code, out = run(p, "--check")
            ok(code == 0, f"api/{f}: --check проходит")
            sl = open(p, encoding="utf-8").read().split("\n")
            m = outline.Map(p, sl)
            all_fn = [u for u in m.units + m.subs if u[2] and re.match(r"(?:async\s+)?function", sl[u[0] - 1].lstrip())]
            bad = [u for u in all_fn if not ends_on_brace(sl, u[0], u[1])]
            if all_fn:
                ok(not bad, f"api/{f}: {len(all_fn)} функций кончаются своей скобкой"
                   + (f"; нет: {', '.join(f'{u[2]} {u[0]}-{u[1]}' for u in bad[:5])}" if bad else ""))

    print(f"RESULT {'fail' if failed else 'pass'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
