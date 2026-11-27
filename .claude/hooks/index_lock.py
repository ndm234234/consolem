#!/usr/bin/env python3
"""Замок index.html: одна сессия за раз правит основной макет. Хук PreToolUse и PostToolUse (аргумент `post`).

До правки index.html (Edit, Write, MultiEdit или команда shell, которая пишет в него):
- замок держит другая живая сессия — отказ: подожди её push или спроси пользователя; идёт rebase или merge —
  вопрос пользователю (свести конфликт своей правки);
- в других рабочих каталогах есть правки index.html без push, о которых пользователь ещё не ответил, — вопрос
  пользователю; замок хук пока не берёт;
- иначе хук берёт свободный замок или продлевает свой.
После правки (инструмент отработал, значит пользователь разрешил):
- хук берёт или продлевает замок и запоминает каталоги, о которых пользователь ответил «да»;
- index.html изменился командой, которую хук до правки не узнал (патч из файла и т. п.), — то же; замок чужой —
  предупреждение в ответе инструмента.
Снять замок «насильно» (`index_lock.py release --force`) может только пользователь в своём терминале: хук
отказывает такой команде сессии.

Логика замка — в tools/index_lock.py. Нет файла или ошибка — хук правке не мешает.
"""
import importlib.util
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "index_lock.py")

# index.html, но не index_NN_….html; путь может начинаться с ./ или каталога
TARGET = r"(?<![\w.-])(?:[\w./-]*/)?index\.html(?![\w.-])"
SEG = r"[^;&|\n]*"                                         # внутри одной команды конвейера
WRITES = [                                                  # на команде, где кавычки обезврежены (bare)
    rf">{{1,2}}\|?\s*['\"]?{TARGET}",                       # > index.html, >> index.html, >| index.html
    rf"\btee\b{SEG}\s['\"]?{TARGET}",                       # … | tee index.html
    rf"\b(?:cp|mv|install|rsync)\b{SEG}\s['\"]?{TARGET}['\"]?\s*(?:$|[;&|\n])",   # cp X index.html
    rf"\bgit\s+checkout\b{SEG}{TARGET}",                    # git checkout … -- index.html
    rf"\bgit\s+restore\b(?!{SEG}--staged(?!{SEG}(?:--worktree|-W\b))){SEG}{TARGET}",   # не только --staged
]
PATCHERS = r"\bgit\s+(?:apply|am|merge-file)\b|(?:^|[;&|\n(]\s*)patch\b"      # могут задеть index.html всегда
INPLACE = r"(?:^|[;&|\n(]\s*)(?:sudo\s+)?(?:sed|perl)\b" + SEG + r"\s-\w*i"     # sed -i, perl -pi
PYWRITE = rf"['\"]{TARGET}['\"]\s*\)\s*\.write_(?:text|bytes)|open\s*\(\s*['\"]{TARGET}['\"]\s*,\s*['\"][wa+]"
FORCE = r"(?:^|[;&|\n(]\s*)(?:python3?\s+)?\S*index_lock\.py\s+release\b" + SEG + r"--force"


def load_tool():
    spec = importlib.util.spec_from_file_location("index_lock", os.path.realpath(TOOL))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bare(cmd):
    """Команда, где внутри кавычек ; & | < > заменены: скрипт sed или текст коммита не режут команду на части."""
    out, q = [], None
    for c in cmd:
        if q:
            if c == q:
                q = None
            elif c in ";&|<>\n":
                c = "_"
        elif c in "'\"":
            q = c
        out.append(c)
    return "".join(out)


def root_of(path):
    """Каталог consolem, где лежит этот index.html (рядом protos.html), или None."""
    d = os.path.dirname(path)
    return d if os.path.basename(path) == "index.html" and os.path.isfile(os.path.join(d, "protos.html")) else None


def cwd_root(cwd):
    """Корень consolem для cwd (cwd может быть подкаталогом)."""
    d = os.path.realpath(cwd)
    while True:
        if os.path.isfile(os.path.join(d, "protos.html")) and os.path.isfile(os.path.join(d, "index.html")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def target_dir(data):
    """Каталог, где правка пишет index.html основного макета, или None."""
    tool = data.get("tool_name") or ""
    inp = data.get("tool_input") or {}
    cwd = data.get("cwd") or os.getcwd()
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        p = inp.get("file_path") or inp.get("notebook_path") or ""
        return root_of(os.path.realpath(os.path.join(cwd, p))) if isinstance(p, str) and p else None
    if tool != "Bash":
        return None
    cmd = inp.get("command") or ""
    if not isinstance(cmd, str) or not cmd:
        return None
    b = bare(cmd)
    hit = any(re.search(w, b) for w in WRITES) or re.search(PYWRITE, cmd)
    hit = hit or (re.search(INPLACE, b) and re.search(TARGET, cmd))
    patcher = re.search(PATCHERS, b)
    if not (hit or patcher):
        return None
    for m in re.finditer(TARGET, cmd):                    # путь из команды, от cwd
        d = root_of(os.path.realpath(os.path.join(cwd, m.group(0))))
        if d:
            return d
    return cwd_root(cwd)


def in_merge(d):
    """Идёт rebase, merge или cherry-pick: index.html правят, чтобы свести конфликт."""
    il = load_tool()
    for name in ("rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"):
        r = il.git(d, "rev-parse", "--git-path", name)
        p = r.stdout.strip()
        if r.returncode == 0 and os.path.exists(p if os.path.isabs(p) else os.path.join(d, p)):
            return True
    return False


def out(event, **kw):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, **kw}}, ensure_ascii=False))


def busy_text(il, lk):
    return (f"Замок index.html держит другая сессия: {il.describe(lk)}. Правку index.html не делай другим путём. "
            "Подожди её push (потом `git fetch origin && git rebase origin/main`) или спроси пользователя; снять "
            "замок может только он (`python3 tools/index_lock.py release --force` в своём терминале). Пока "
            "работай в прототипе.")


def pre(data):
    inp = data.get("tool_input") or {}
    if data.get("tool_name") == "Bash" and re.search(FORCE, bare(str(inp.get("command", "")))):
        out("PreToolUse", permissionDecision="deny", permissionDecisionReason=(
            "Снять чужой замок index.html (`--force`) может только пользователь в своём терминале. Скажи "
            "пользователю, кто держит замок (`python3 tools/index_lock.py status`), и жди его решения."))
        return
    d = target_dir(data)
    if not d:
        return
    il = load_tool()
    lk, free, why = il.lock_state(d)
    if not free:
        if in_merge(d):
            out("PreToolUse", permissionDecision="ask", permissionDecisionReason=(
                f"Идёт rebase или merge, а замок index.html у другой сессии: {il.describe(lk)}. Правка сводит "
                "конфликт? Разрешить её здесь?"))
        else:
            out("PreToolUse", permissionDecision="deny", permissionDecisionReason=busy_text(il, lk))
        return
    seen = set((lk or {}).get("seen") or []) if lk and lk.get("owner") == il.toplevel(d) else set()
    new = [o for o in il.pending_elsewhere(d) if o["path"] not in seen]
    if new:
        names = "; ".join(f"{o['path']} ({o['branch'] or 'без ветки'})" for o in new)
        out("PreToolUse", permissionDecision="ask", permissionDecisionReason=(
            f"В других рабочих каталогах есть правки index.html без push: {names}. Возможно, там другая сессия "
            "переносит в основной. Разрешить правку здесь? Тогда эта сессия возьмёт замок, а обе правки сведёт "
            "rebase."))
        return
    il.take(d)


def post(data):
    d = target_dir(data)
    known = bool(d)
    if not d and data.get("tool_name") == "Bash":
        r = cwd_root(data.get("cwd") or os.getcwd())
        f = os.path.join(r, "index.html") if r else ""
        if r and time.time() - os.path.getmtime(f) < 120:       # команда только что тронула index.html
            il = load_tool()
            if il.git(r, "diff", "--quiet", "HEAD", "--", "index.html").returncode:
                d = r
    if not d:
        return
    il = load_tool()
    lk, free, why = il.lock_state(d)
    if not free:
        if not in_merge(d):
            out("PostToolUse", additionalContext=(
                "Эта команда изменила index.html, а замок держит другая сессия: " + il.describe(lk) + ". Дальше "
                "index.html не правь и ничего не возвращай сам: скажи пользователю, что изменилось, и жди его "
                "решения."))
        return
    ok, msg = il.take(d)
    if ok and known:                                       # пользователь ответил «да» на вопрос до правки
        lk = il.read_lock(d) or {}
        seen = set(lk.get("seen") or []) | {o["path"] for o in il.pending_elsewhere(d)}
        if seen != set(lk.get("seen") or []):
            il.write_lock(d, {**lk, "seen": sorted(seen)})


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if isinstance(data, dict):
        (post if sys.argv[1:] == ["post"] else pre)(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # хук не должен мешать правке
        pass
