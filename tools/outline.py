#!/usr/bin/env python3
"""Карта кода макета: где что лежит в index.html, прототипе или файле api/*.js.

Файл макета — больше 30 000 строк. Вместо десятка grep/sed этот скрипт за один
вызов говорит, в какой функции и рядом с каким заголовком лежит нужное место,
и даёт диапазон строк для `sed -n`.

  python3 tools/outline.py [ФАЙЛ]               обзор: разделы «// ── … ──», разделы приложения,
                                                вкладки карточки и функции, которые их рисуют
  python3 tools/outline.py [ФАЙЛ] СЛОВО…        где встречаются слова: попадания по функциям
                                                верхнего уровня и блокам CSS, с диапазонами
  python3 tools/outline.py [ФАЙЛ] -d ИМЯ…       диапазоны строк функций и констант с этими именами
  python3 tools/outline.py ФАЙЛ -- --СЛОВО      слово с «-» в начале (CSS-переменная --fg, -webkit)
  python3 tools/outline.py [ФАЙЛ] --check       опоры карты на месте? Код выхода 1, если код
                                                макета ушёл от соглашений, на которые опирается
                                                карта. Его запускает tools/check_ui.py.

ФАЙЛ — index.html по умолчанию; можно index_NN_*.html, .js или .mjs. Слова ищутся
без учёта регистра, как подстроки; строка подходит, если в ней есть хоть одно слово.
Сначала идут функции с именем, равным слову, потом — где нашлись все слова, потом —
где больше попаданий. -n N — сколько групп показать (по умолчанию 25).

Границы функций карта берёт из лексера: он считает глубину скобок и пропускает
строки, шаблонные строки, комментарии и регулярные выражения. Единица верхнего
уровня — строка на глубине модуля (в api/*.js — внутри обёртки «(() => { … })()»).
Метка ‹…› у попадания — ближайший заголовок раздела выше этой строки.
После правки этого файла: python3 tools/check_outline.py.
"""
import bisect
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SECTION = re.compile(r"^\s*// ── (.*?)\s*─*\s*$")
# В api/*.js разделы помечены иначе: /* ===== Заголовок ===== */ или /* ----- Заголовок ----- */
SECTION_JS = re.compile(r"^\s*/\*\s*(?:={3,}|-{3,})\s*(.*?)\s*(?:={3,}|-{3,})\s*\*/\s*$")
# Похоже на заголовок раздела, но не того вида — карта его не увидит
HEADER_LIKE = re.compile(r"^\s*(?://|/\*)\s*(?:─|-{3,}|={2,}|#{2,}|\*{3,})|^\s*//\s*#+\s")
DECL = re.compile(r"(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|(?:export\s+)?(?:const|let|var|class)\s+([\w$]+)")
CSS_COMMENT = re.compile(r"^\s*/\*\s*(.*?)(?:\*/)?\s*$")
# Строка на глубине модуля, которая продолжает прошлую инструкцию, а не начинает новую
CONTINUES = re.compile(r"^(?:[})\].?:,+\-*/%&|=<>!^~]|else\b|catch\b|finally\b|//|\*)")
# Конец кода строки (по лексеру, без комментариев, строк и регулярных выражений), после которого
# инструкция продолжается на следующей строке: «const f = x =>», «a = b ||», «x,». «n++» — не продолжение.
OPEN_END = re.compile(r"(?:=>|&&|\|\||(?<![+\-])[+\-]|[=,?:*%&|^(\[/])$")


def is_js(path):
    return path.endswith((".js", ".mjs"))


def load(path):
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n").split("\n")


def regions(lines, path):
    """Номера строк (с 1) блоков <style> и встроенных <script> без src."""
    if is_js(path):
        return [], [(1, len(lines))]
    css, js, open_css, open_js = [], [], None, None
    for i, s in enumerate(lines, 1):
        t = s.strip()
        if open_css is None and open_js is None:
            if re.match(r"<style[\s>]", t) and "</style>" not in t:
                open_css = i
            elif re.match(r"<script(\s[^>]*)?>", t) and "src=" not in t and "</script>" not in t:
                open_js = i
        elif open_css is not None and t.startswith("</style>"):
            css.append((open_css + 1, i - 1))
            open_css = None
        elif open_js is not None and t.startswith("</script>"):
            js.append((open_js + 1, i - 1))
            open_js = None
    return css, js


# ── Лексер ─────────────────────────────────────────────────────────────────
TOK = re.compile(r"//|/\*|\$\{|[\\'\"`/{}()\[\]\n]")
STR = {q: re.compile(r"%s(?:[^%s\\\n]|\\.)*%s" % (q, q, q), re.S) for q in "'\""}
TMPL_STOP = re.compile(r"[\\`\n]|\$\{")
REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^\n")
REGEX_WORDS = {"return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"}
WORD_END = re.compile(r"[\w$]+$")
RE_BODY = re.compile(r"(?:[^\\/\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])*/")


def scan(text):
    """Состояние в начале каждой строки текста: [(глубина скобок, 'code'|'tmpl'|'cmt')],
    и список проблем [(строка, что)] — признак, что лексер сбился."""
    n, info, problems = len(text), [(0, "code")], []
    depth, stack, state, i, line = 0, [], "code", 0, 1
    # ends[k] — последние знаки кода к концу строки k (с нуля); «a» — строка, шаблон или рег. выражение
    ends, last = [], ""

    def newlines(a, b, st):
        nonlocal line
        for _ in range(text.count("\n", a, b)):
            line += 1
            info.append((depth, st))
            ends.append(last)

    def gap(j):
        nonlocal last
        seg = text[i:j].rstrip()
        if seg.strip():
            last = seg[-2:]

    while i < n:
        if state == "tmpl":
            m = TMPL_STOP.search(text, i)
            if not m:
                problems.append((line, "шаблонная строка не закрыта"))
                break
            t, j = m.group(0), m.start()
            if t == "\n":
                line += 1
                info.append((depth, "tmpl"))
                ends.append(last)
                i = j + 1
            elif t == "\\":
                newlines(j, j + 2, "tmpl")
                i = j + 2
            elif t == "`":
                state, i, last = "code", j + 1, "a"
            else:
                stack.append(depth)
                state, i = "code", j + 2
            continue
        m = TOK.search(text, i)
        if not m:
            break
        t, j = m.group(0), m.start()
        gap(j)
        if t == "\n":
            line += 1
            info.append((depth, "code"))
            ends.append(last)
            i = j + 1
        elif t == "//":
            k = text.find("\n", j)
            i = n if k < 0 else k
        elif t == "/*":
            k = text.find("*/", j + 2)
            if k < 0:
                problems.append((line, "комментарий /* не закрыт"))
                break
            newlines(j, k, "cmt")
            i = k + 2
        elif t in "'\"":
            s = STR[t].match(text, j)
            if not s:
                problems.append((line, "строка в кавычках не закрыта"))
                k = text.find("\n", j)
                i = n if k < 0 else k
            else:
                newlines(j, s.end(), "code")  # перенос строки после «\»
                i, last = s.end(), "a"
        elif t == "`":
            state, i = "tmpl", j + 1
        elif t == "/":
            p = j - 1
            while p >= 0 and text[p] in " \t":
                p -= 1
            prev = text[p] if p >= 0 else "\n"
            w = WORD_END.search(text, max(0, p - 12), p + 1) if p >= 0 else None
            if prev in REGEX_PREV or (w and w.group(0) in REGEX_WORDS):
                r = RE_BODY.match(text, j + 1)
                if not r:
                    problems.append((line, "регулярное выражение не закрыто"))
                    i = j + 1
                else:
                    i, last = r.end(), "a"
            else:
                i, last = j + 1, "/"
        elif t == "\\":
            i, last = j + 2, "a"
        elif t in "{([" or t == "${":
            depth += 1
            i, last = j + len(t), t[-1]
        else:  # } ) ]
            last = t
            if t == "}" and stack and depth == stack[-1]:
                stack.pop()
                state = "tmpl"
            else:
                depth -= 1
                if depth < 0:
                    problems.append((line, f"лишняя «{t}»"))
                    depth = 0
            i = j + 1
    if not problems and (depth or stack or state != "code"):
        problems.append((line, f"в конце глубина {depth}, открытых шаблонов {len(stack)}"))
    gap(n)
    ends.append(last)
    return info, problems, ends


class Map:
    """Разбор файла: области CSS и скриптов, единицы верхнего уровня, заголовки, проблемы лексера."""

    def __init__(self, path, lines):
        self.path, self.lines = path, lines
        self.css, self.js = regions(lines, path)
        self.units, self.subs, self.problems = [], [], []
        for a, b in self.js:
            self._units(a, b)
        self.units.sort()
        self.starts = [u[0] for u in self.units]
        self.subs.sort()
        self.sub_starts = [u[0] for u in self.subs]
        self.heads = []  # (строка, заголовок)
        for a, b in self.js:
            for i in range(a, b + 1):
                h = section_of(lines[i - 1])
                if h:
                    self.heads.append((i, h))
        self.head_lines = [h[0] for h in self.heads]
        self.css_heads = []  # (строка, текст, номер области)
        for k, (a, b) in enumerate(self.css):
            for i in range(a, b + 1):
                m = CSS_COMMENT.match(lines[i - 1])
                if m and m.group(1):
                    self.css_heads.append((i, m.group(1), k))

    def _units(self, a, b):
        text = "\n".join(self.lines[a - 1 : b])
        info, problems, ends = scan(text)
        # строка k области продолжает инструкцию прошлой строки кода
        cont = lambda k: k > 0 and OPEN_END.search(ends[k - 1]) is not None
        self.problems += [(a + ln - 1, what) for ln, what in problems]
        # Глубина модуля: файл .js целиком в обёртке «(() => {» — его верхний уровень внутри неё
        top, wrap = 0, None
        code = [k for k, (d, st) in enumerate(info) if d == 0 and st == "code" and self.lines[a + k - 1].strip()
                and not self.lines[a + k - 1].lstrip().startswith(("//", "/*", "*"))]
        if is_js(self.path) and code and len(code) <= 3 and len(info) > 20 and code[0] + 1 < len(info):
            wrap = code[0]
            top = info[wrap + 1][0]
        cur, mine = None, []
        for k, (d, st) in enumerate(info):
            if k == wrap:
                continue  # строка самой обёртки
            i = a + k
            s = self.lines[i - 1].strip()
            if d != top or st != "code" or not s or CONTINUES.match(s) or cont(k):
                continue
            m = DECL.match(s)
            if cur:
                cur[1] = i - 1
            cur = [i, b, (m.group(1) or m.group(2)) if m else None]
            mine.append(cur)
        if wrap is not None and cur:
            # Последняя единица кончается до закрытия обёртки
            last = max(k for k, (d, st) in enumerate(info) if d >= top and k > wrap)
            cur[1] = min(cur[1], a + last - 1)
        for u in mine:
            u[1] = trim_tail(self.lines, u[0], u[1])
        self.units += mine
        # Внутри большой единицы (create() сервера, длинная обёртка) — объявления следующего уровня:
        # подъединица длится до следующей инструкции на своей глубине
        for u in mine:
            if u[1] - u[0] <= BIG_UNIT:
                continue
            sub = None
            for i in range(u[0] + 1, u[1] + 1):
                d, st = info[i - a]
                s = self.lines[i - 1].strip()
                if d != top + 1 or st != "code" or not s or CONTINUES.match(s) or cont(i - a):
                    continue
                if sub:
                    sub[1] = trim_tail(self.lines, sub[0], i - 1)
                m = DECL.match(s)
                sub = [i, u[1], m.group(1) or m.group(2), u] if m else None
                if sub:
                    self.subs.append(sub)
            if sub:
                sub[1] = trim_tail(self.lines, sub[0], u[1] - 1)

    def kind(self, i):
        if any(a <= i <= b for a, b in self.css):
            return "css"
        if any(a <= i <= b for a, b in self.js):
            return "js"
        return "html"

    def sub_at(self, i):
        """Подъединица большой единицы, где лежит строка i (с комментарием перед ней), или None."""
        k = bisect.bisect_right(self.sub_starts, i) - 1
        if k >= 0 and self.subs[k][0] <= i <= self.subs[k][1]:
            return self.subs[k]
        if k + 1 < len(self.subs):
            nxt = self.subs[k + 1]
            if all(not self.lines[j - 1].strip() or self.lines[j - 1].lstrip().startswith(("//", "/*", "*"))
                   for j in range(i, nxt[0])):
                return nxt
        return None

    def unit_at(self, i):
        """Единица, к которой относится строка i; комментарий перед единицей — к ней."""
        k = bisect.bisect_right(self.starts, i) - 1
        u = self.units[k] if k >= 0 else None
        if u and u[0] <= i <= u[1]:
            return u
        nxt = self.units[k + 1] if k + 1 < len(self.units) else None
        if nxt and self.same_js(i, nxt[0]) and all(
                not self.lines[j - 1].strip() or self.lines[j - 1].lstrip().startswith(("//", "/*", "*"))
                for j in range(i, nxt[0])):
            return nxt
        return None

    def same_js(self, i, j):
        return any(a <= i <= b and a <= j <= b for a, b in self.js)

    def head_at(self, i):
        k = bisect.bisect_right(self.head_lines, i) - 1
        return self.heads[k][1] if k >= 0 else ""

    def css_block(self, i):
        """Блок CSS строки i: от комментария над ней до следующего комментария своей области."""
        reg = next(k for k, (a, b) in enumerate(self.css) if a <= i <= b)
        a, b = self.css[reg]
        mine = [h for h in self.css_heads if h[2] == reg]
        before = [h for h in mine if h[0] <= i]
        start, title = (before[-1][0], before[-1][1]) if before else (a, "")
        after = [h[0] for h in mine if h[0] > i]
        end = trim_tail(self.lines, start, (after[0] - 1) if after else b)
        return start, max(end, i), title

    def named(self):
        return {u[2]: u for u in self.units if u[2]}


BIG_UNIT = 300  # строк: длиннее — карта раскладывает единицу на подъединицы и разделы


def section_of(s):
    m = SECTION.match(s) or SECTION_JS.match(s)
    return m.group(1) if m else None


def trim_tail(lines, a, e):
    """Конец единицы без пустых строк и комментариев (// и /* … */), что стоят перед следующей."""
    while e > a:
        t = lines[e - 1].strip()
        if not t or t.startswith("//"):
            e -= 1
        elif t.endswith("*/"):
            j = e
            while j > a and "/*" not in lines[j - 1]:
                j -= 1
            if j <= a or not lines[j - 1].strip().startswith("/*"):
                break
            e = j - 1
        else:
            break
    return e


def short(s, n):
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def rel(path):
    return os.path.relpath(path, ROOT)


# ── Вкладки карточки ───────────────────────────────────────────────────────
def card_tabs(mp):
    """Вкладки из tabsForHand() и tabsFor(): [(типы, условие, [(id, подпись)])], {id: [подписи]},
    и строки tabsForHand с «return», где карта не нашла списка вкладок."""
    by_type, tabs, blind = [], {}, []
    names = mp.named()
    for name in ("tabsForHand", "tabsFor"):
        u = names.get(name)
        if not u:
            continue
        for i in range(u[0], u[1] + 1):
            s = mp.lines[i - 1]
            lst = re.findall(r'\["([\w-]+)","([^"]+)"', s)
            for k, lab in lst:
                tabs.setdefault(k, [])
                if lab not in tabs[k]:
                    tabs[k].append(lab)
            if name != "tabsForHand" or "return" not in s:
                continue
            if not lst:
                if not re.search(r"return\s*\[\s*\]", s):
                    blind.append(i)
                continue
            types = re.findall(r'n\.type==="(\w+)"', s) or (["(хранилище)"] if "archScope" in s else ["(прочие)"])
            cond = re.search(r"if\((.*?)\)\s*return", s)
            extra = re.sub(r'n\.type==="\w+"', "", cond.group(1)) if cond else ""
            extra = re.sub(r"(\|\||&&)\s*(\|\||&&)", r"\1", extra)
            extra = re.sub(r"^[\s&|]+|[\s&|]+$", "", extra)
            while extra.startswith("(") and extra.count("(") > extra.count(")"):
                extra = extra[1:].strip()
            while extra.endswith(")") and extra.count(")") > extra.count("("):
                extra = extra[:-1].strip()
            notes = []
            if extra and "archScope" not in extra:
                notes.append(extra)
            if re.search(r"\?\s*\[\[|can\(", s):
                notes.append("часть вкладок — по условию")
            seen, uniq = set(), []
            for k, lab in lst:
                if k not in seen:
                    seen.add(k)
                    uniq.append((k, lab))
            by_type.append((types, "; ".join(notes), uniq))
    return by_type, tabs, blind


def tab_checks(mp):
    """{id вкладки: [(единица, строка, функция из «return имя(» или None)]} по строкам tab==="id"."""
    out = {}
    pat = re.compile(r'\btab\s*===?\s*["\']([\w-]+)["\'](?=(.*))')
    names = mp.named()
    for u in mp.units:
        if not u[2]:
            continue
        for i in range(u[0], u[1] + 1):
            for m in pat.finditer(mp.lines[i - 1]):
                # «if(tab==="x"…) return имя(» или «tab==="x"… ? имя(»: вкладку рисует функция имя
                r = re.match(r"[^;{]*?\)\s*return\s+([\w$]+)\(|[^;{?]*\?\s*([\w$]+)\(", m.group(2))
                f = names.get(r.group(1) or r.group(2)) if r else None
                out.setdefault(m.group(1), []).append((u, i, f if f and f[1] > f[0] else None))
    return out


def dispatcher(checks):
    """Функция, где больше всего разных вкладок проверяется строкой tab==="id"."""
    cnt = {}
    for k, hits in checks.items():
        for u, i, f in hits:
            cnt.setdefault(u[0], [u, set()])[1].add(k)
    return max(cnt.values(), key=lambda x: len(x[1]))[0] if cnt else None


# Групповая карточка (выбрано несколько объектов) проверяет те же вкладки, но рисует свой вид
GROUP_CARD = "bulkCardHtml"


def tab_places(checks, k):
    """Где рисуется вкладка k: сначала функции экрана, потом строки проверок (по одной на функцию).
    Места из групповой карточки — отдельно, с пометкой."""
    hits = [h for h in checks.get(k, []) if h[0][2] != GROUP_CARD]
    group = [h for h in checks.get(k, []) if h[0][2] == GROUP_CARD]
    out, seen = [], set()
    for f in [f for u, i, f in hits if f]:
        if f[2] not in seen:
            seen.add(f[2])
            out.append(f"{f[2]} {f[0]}-{f[1]}")
    for u, i, f in hits:
        if not f and u[2] not in seen:
            seen.add(u[2])
            out.append(f"{u[2]}:{i}")
    gf = sorted({f"{f[2]} {f[0]}-{f[1]}" if f else f"{u[2]}:{i}" for u, i, f in group})
    if gf:
        out.append("групповая: " + ", ".join(gf))
    return out


# ── Режимы ─────────────────────────────────────────────────────────────────
def overview(mp):
    lines, us = mp.lines, mp.units
    nfun = sum(1 for u in us if u[2])
    print(f"{rel(mp.path)}: {len(lines)} строк; CSS {', '.join(f'{a}-{b}' for a, b in mp.css) or '—'}; "
          f"скрипт {', '.join(f'{a}-{b}' for a, b in mp.js) or '—'}; объявлений верхнего уровня {nfun}")
    if mp.problems:
        print(f"  ! лексер сбился ({len(mp.problems)}): " + "; ".join(f"{i}: {w}" for i, w in mp.problems[:3])
              + " — границы функций ниже неточны")
    if mp.heads:
        print(f"\nРазделы ({len(mp.heads)}): строки, число объявлений, заголовок")
        ends = [h[0] - 1 for h in mp.heads[1:]] + [max(b for a, b in mp.js)]
        for (a, t), b in zip(mp.heads, ends):
            k = sum(1 for u in us if u[2] and a <= u[0] <= b)
            print(f"  {a:>6}-{b:<6} {k:>4}  {short(t, 100)}")
    if is_js(mp.path):
        print("\nДальше: outline.py ФАЙЛ СЛОВО… — где лежит код; outline.py ФАЙЛ -d ИМЯ — диапазон функции.")
        return
    names = mp.named()
    m = re.search(r"function paint\(\)\{.*?const ui=\{([^}]*)\}", "\n".join(lines), re.S)
    if m:
        pairs = re.findall(r"([\w$]+):([\w$]+)", m.group(1))
        print("\nРазделы приложения (app → функция, строки):")
        print("  " + "; ".join(f"{k}→{v} {names[v][0]}-{names[v][1]}" if v in names else f"{k}→{v}" for k, v in pairs))
    by_type, tabs, _ = card_tabs(mp)
    if by_type:
        t = names["tabsForHand"]
        print(f"\nВкладки карточки по типу объекта (tabsForHand {t[0]}-{t[1]}):")
        for types, note, lst in by_type:
            tail = f"  [{short(note, 60)}]" if note else ""
            print(f"  {', '.join(types):<16} {' · '.join(f'{k} «{lab}»' for k, lab in lst)}{tail}")
    checks = tab_checks(mp)
    disp = dispatcher(checks)
    if tabs:
        print("\nВкладка → где рисуется: «функция начало-конец» — её вызывает строка tab===\"id\"; "
              "«функция:строка» — сама проверка.")
        if disp:
            # Своей функции экрана нет и в самой форме проверки нет: вкладку рисует общая ветвь формы.
            # Проверки в других местах (групповая карточка bulkCardHtml) этого не меняют.
            free = [k for k in tabs if not any((f or u is disp) and u[2] != GROUP_CARD for u, i, f in checks.get(k, []))]
            print(f"  Карточку объекта рисует {disp[2]} {disp[0]}-{disp[1]}"
                  + (f"; вкладки без своей проверки ({', '.join(free)}) — его ветви по n.type." if free else "."))
        for k, labs in tabs.items():
            pl = ([f"{disp[2]} (ветвь по n.type)"] if disp and k in free else []) + tab_places(checks, k)
            more = f" … ещё {len(pl) - 6}" if len(pl) > 6 else ""
            print(f"  {k:<8} «{'», «'.join(labs)}» → {', '.join(pl[:6]) or '—'}{more}")
    print("\nДальше: outline.py ФАЙЛ СЛОВО… — где лежит код; outline.py ФАЙЛ -d ИМЯ — диапазон функции.")
    print("Прямая ссылка на карточку: ФАЙЛ#node=<id объекта>&tab=<id вкладки>.")


def defs(mp, names):
    lines = mp.lines
    for name in names:
        hit = [u for u in mp.units if u[2] == name]
        for a, b, n in hit:
            print(f"{n}: {a}-{b} ({b - a + 1} строк)  ‹{short(mp.head_at(a), 60) or 'без заголовка'}›  sed -n {a},{b}p")
        for a, b, n, p in [u for u in mp.subs if u[2] == name]:
            hit.append(n)
            print(f"{n}: {a}-{b} ({b - a + 1} строк), внутри {p[2] or 'единицы'} {p[0]}-{p[1]}  "
                  f"‹{short(mp.head_at(a), 50) or 'без заголовка'}›  sed -n {a},{b}p")
        if hit:
            continue
        decl = re.compile(r"^\s*(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*|(?:const|let|var|class)\s+)%s\b"
                          % re.escape(name))
        inner = [i for i, s in enumerate(lines, 1) if decl.match(s)]
        for i in inner:
            u = mp.unit_at(i)
            where = f"внутри {u[2] or 'единицы'} {u[0]}-{u[1]}" if u else "вне единиц верхнего уровня"
            print(f"{name}: строка {i} — вложенное объявление, {where}; его конец карта не считает")
        if not inner:
            print(f"{name}: не найдено")


def search(mp, terms, limit):
    lines = mp.lines
    low = [t.lower() for t in terms]
    groups = {}
    for i, s in enumerate(lines, 1):
        sl = s.lower()
        found = [t for t in low if t in sl]
        if not found:
            continue
        kind, u, outer = mp.kind(i), None, None
        if kind == "js":
            u = mp.unit_at(i)
            if u is None:
                key, label = ("js", "loose", mp.head_at(i)), (None, None, None)
            elif u[1] - u[0] > BIG_UNIT and mp.sub_at(i):
                v = mp.sub_at(i)
                nm = f"{v[2]} (в {u[2] or 'единице'})"
                if v[1] - v[0] > BIG_UNIT:  # и подъединица большая (таблица маршрутов) — по заголовкам
                    key, label, outer = ("js", v[0], mp.head_at(i)), (nm, None, None), v
                else:
                    key, label = ("js", v[0]), (nm, v[0], v[1])
            elif u[1] - u[0] > BIG_UNIT:
                # Большая единица (длинная функция, обёртка) — по заголовкам внутри неё
                key, label, outer = ("js", u[0], mp.head_at(i)), (u[2], None, None), u
            else:
                key, label = ("js", u[0]), (u[2], u[0], u[1])
        elif kind == "css":
            a, b, title = mp.css_block(i)
            key, label = ("css", a), ("CSS «" + short(title, 40) + "»" if title else "CSS", a, b)
        else:
            key, label = ("html", i // 50), ("HTML", None, None)
        g = groups.setdefault(key, {"label": label, "lines": [], "terms": set(), "unit": u, "outer": outer})
        g["lines"].append(i)
        g["terms"].update(found)

    def exact(g):
        return g["unit"] is not None and bool(g["label"][0]) and g["label"][0].split(" (в ")[0].lower() in low

    order = sorted(groups.values(), key=lambda g: (not exact(g), -len(g["terms"]), -len(g["lines"]), g["lines"][0]))
    total = sum(len(g["lines"]) for g in order)
    print(f"{rel(mp.path)}: «{'», «'.join(terms)}» — {total} строк в {len(order)} местах"
          + (f"; показаны первые {limit} (-n N — больше)" if len(order) > limit else ""))
    for g in order[:limit]:
        name, a, b = g["label"]
        ls, u = g["lines"], g["unit"]
        if a is None:
            a, b = ls[0], ls[-1]
            o = g["outer"]
            if o and name:
                name = f"{name} {o[0]}-{o[1]}, здесь"
        a = min(a, ls[0])
        if not name:
            name = short(lines[u[0] - 1], 30) if u else "(вне функций)"
        pts = ", ".join(map(str, ls[:6])) + (f" … (+{len(ls) - 6})" if len(ls) > 6 else "")
        tl = "" if len(low) == 1 else f"  [{', '.join(t for t in low if t in g['terms'])}]"
        h = mp.head_at(ls[0]) if mp.kind(ls[0]) == "js" else ""
        sc = f"  ‹{short(h, 40)}›" if h else ""
        print(f"  {f'{a}-{b}':>13}  {short(name, 38):<38} {len(ls):>3}× строки {pts}{tl}{sc}")


# ── Проверка опор ──────────────────────────────────────────────────────────
# Если код макета перестал следовать соглашениям, карта врёт молча — поэтому --check
# падает и говорит, что изменилось. Его запускает tools/check_ui.py.
MUST_DEFINE = ["paint", "gear", "tabGo", "setApp", "tabsFor", "tabsForHand", "formBase", "find", "onEv"]
MIN_SECTIONS = 100
MIN_TABS = 10
MAX_HEADER_LIKE = 5      # строк «// ---- …» и подобных: сейчас 1
MIN_TABS_PLACED = 0.6    # доля вкладок, у которых карта нашла, где они рисуются


def check(mp):
    """Опоры карты; код выхода 1 и список нарушений, если опора ушла.
    Для .html — соглашения index.html; для .js — только лексер (границы функций)."""
    lines, bad = mp.lines, []
    names = mp.named()
    if is_js(mp.path) and not names and not mp.problems:
        print(f"outline: {rel(mp.path)} — в файле нет функций (данные), карта ему не нужна")
        return 0
    for i, what in mp.problems[:5]:
        bad.append(f"лексер сбился на строке {i}: {what} — границы функций дальше неверны. "
                   "Новый синтаксис? Поправь scan() в tools/outline.py")
    tabs, placed = {}, 0
    if not is_js(mp.path):
        if not mp.css:
            bad.append("нет блока <style> — обзор и поиск не различат CSS")
        if not mp.js or max(b - a for a, b in mp.js) < 1000:
            bad.append("нет большого встроенного <script> — карте нечего разбирать")
        if len(mp.heads) < MIN_SECTIONS:
            bad.append(f"заголовков «// ── … ──» {len(mp.heads)}, ждали не меньше {MIN_SECTIONS}: "
                       "сменился вид заголовков разделов? Поправь SECTION в tools/outline.py")
        like = [i for a, b in mp.js for i in range(a, b + 1)
                if HEADER_LIKE.match(lines[i - 1]) and not section_of(lines[i - 1])]
        if len(like) > MAX_HEADER_LIKE:
            ex = "; ".join(f"{i}: «{short(lines[i - 1], 40)}»" for i in like[-5:])
            bad.append(f"строк, похожих на заголовок раздела другого вида, {len(like)} (порог {MAX_HEADER_LIKE}): "
                       f"{ex}. Пиши заголовки как «// ── Заголовок ──» или поправь SECTION")
        miss = [n for n in MUST_DEFINE if n not in names]
        if miss:
            bad.append(f"нет объявлений верхнего уровня: {', '.join(miss)} — функции переименовали "
                       "или перенесли внутрь другой функции; поправь MUST_DEFINE и обзор")
        m = re.search(r"function paint\(\)\{.*?const ui=\{([^}]*)\}", "\n".join(lines), re.S)
        if not m:
            bad.append("в paint() нет «const ui={раздел:функция,…}» — обзор не покажет разделы приложения")
        else:
            lost = [v for k, v in re.findall(r"([\w$]+):([\w$]+)", m.group(1)) if v not in names]
            if lost:
                bad.append(f"paint() ссылается на функции, которых карта не нашла: {', '.join(lost)}")
        by_type, tabs, blind = card_tabs(mp)
        if len(tabs) < MIN_TABS:
            bad.append(f"вкладок в tabsFor/tabsForHand {len(tabs)}, ждали не меньше {MIN_TABS}: "
                       "сменился вид списка вкладок [\"id\",\"Подпись\"]?")
        elif not by_type:
            bad.append("в tabsForHand нет строк «if(n.type===…)return[[…]]» — обзор не покажет вкладки по типам")
        if blind:
            bad.append("в tabsForHand строки с return без списка [[\"id\",\"Подпись\"]]: "
                       + ", ".join(map(str, blind[:5])) + " — обзор не покажет их вкладки")
        checks = tab_checks(mp)
        placed = sum(1 for k in tabs if checks.get(k))
        if tabs and placed / len(tabs) < MIN_TABS_PLACED:
            bad.append(f"карта нашла, где рисуется, только {placed} вкладок из {len(tabs)}: вкладки больше "
                       "не проверяются строкой tab===\"id\"? Поправь tab_checks в tools/outline.py")
    if bad:
        print(f"outline: {rel(mp.path)} — карта кода устарела ({len(bad)}):")
        for b in bad:
            print("  - " + b)
        return 1
    tail = f", {len(tabs)} вкладок ({placed} с местом)" if tabs else ""
    print(f"outline: {rel(mp.path)} — опоры карты на месте: {len(mp.heads)} разделов, {len(names)} объявлений{tail}")
    return 0


def usage(msg):
    print(msg + "\n\n" + __doc__.split("\n\n")[1], file=sys.stderr)
    return 2


def main(argv):
    limit, args, mode = 25, [], "search"
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        if a == "-n":
            if i + 1 >= len(argv) or not argv[i + 1].isdigit() or int(argv[i + 1]) < 1:
                return usage("После -n нужно число больше нуля")
            limit, i = int(argv[i + 1]), i + 2
            continue
        if a == "--":
            args += argv[i + 1:]
            break
        if a == "--check":
            mode = "check"
        elif a == "-d":
            mode = "defs"
        elif a.startswith("-") and len(a) > 1:
            return usage(f"Неизвестный ключ {a}; слово с «-» в начале ищи после «--»: outline.py ФАЙЛ -- {a}")
        else:
            args.append(a)
        i += 1
    path = os.path.join(ROOT, "index.html")
    # Файл — первое слово; дальше по списку — только если такой файл есть («-d paint api/server.js»)
    at = lambda n: n if os.path.exists(n) else os.path.join(ROOT, n)
    k = next((j for j, w in enumerate(args) if re.search(r"\.(html?|m?js)$", w)
              and (j == 0 or os.path.exists(at(w)))), None)
    if k is not None:
        name = args.pop(k)
        path = at(name)
        if not os.path.exists(path):
            print(f"Нет файла {name}", file=sys.stderr)
            return 2
    mp = Map(path, load(path))
    if mode == "check":
        return check(mp)
    if mode == "defs":
        if not args:
            return usage("После -d нужны имена функций")
        defs(mp, args)
    elif not args:
        overview(mp)
    else:
        search(mp, args, limit)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
