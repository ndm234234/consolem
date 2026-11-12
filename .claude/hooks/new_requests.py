#!/usr/bin/env python3
"""При старте сессии Claude Code: запросы к API в api/requests/, которые ждут ответа, — отдельно те, что адресованы вам.

Подключён в .claude/settings.json (общий для всех). Кто «вы» — по `git config user.name`; кто за каким адресатом —
таблица «Кому» в api/requests/README.md. Адресат запроса — строка «Кому: …» в шапке; у старых запросов без неё —
«для …» в шапке, иначе владелец контракта.

Подтягивает origin (git fetch, рабочую копию не трогает) не чаще раза в FETCH_EVERY секунд и смотрит *-request.md
и на GitHub, и локально. Ждёт ответа — статус «новый» или «в работе», или статуса нет. Если таких нет — хук молчит.
"""
import json
import os
import re
import subprocess
import time

ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
DIR = "api/requests"
WAITING = ("новый", "в работе")
OWNER = "владелец контракта"
FETCH_EVERY = 600  # с: fetch по сети стоил до 16 с при каждом продолжении сессии


def git(*args, timeout=15):
    try:
        r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def fetch():
    """git fetch, если прошлый был давно. True — данные origin свежие (только что или в пределах FETCH_EVERY)."""
    gd = (git("rev-parse", "--git-dir") or "").strip()
    if not gd:
        return False
    stamp = os.path.join(gd if os.path.isabs(gd) else os.path.join(ROOT, gd), "consolem-requests-fetch")
    try:
        if time.time() - os.path.getmtime(stamp) < FETCH_EVERY:
            return True
    except OSError:
        pass
    if git("fetch", "-q", "origin") is None:
        return False
    try:
        with open(stamp, "w"):
            pass
    except OSError:
        pass
    return True


def cat_batch(specs):
    """Содержимое нескольких объектов git одним `git cat-file --batch`; None — объекта нет."""
    if not specs:
        return []
    try:
        r = subprocess.run(["git", "-C", ROOT, "cat-file", "--batch"], input="\n".join(specs).encode() + b"\n",
                           capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return [None] * len(specs)
    out, buf, i = [], r.stdout, 0
    for _ in specs:
        nl = buf.find(b"\n", i)
        head = buf[i:nl].split()
        if nl < 0 or len(head) < 3 or head[1] == b"missing":
            out.append(None); i = nl + 1; continue
        size = int(head[2]); start = nl + 1
        out.append(buf[start:start + size].decode("utf-8", "replace")); i = start + size + 1
    return out


def status_of(text):
    m = re.search(r"Статус:\s*\**\s*([^*·\n]+)", text or "")
    return m.group(1).strip().lower() if m else ""


def norm(label):
    """«владельца контракта» → «владелец контракта», «команды w2c» → «w2c»."""
    s = label.strip().strip("*`.").strip().lower()
    if "владел" in s:
        return OWNER
    s = re.sub(r"^(для\s+)?команд[аыеу]?\s+", "", s)
    return s.strip("`") or OWNER


def addressees(text):
    head = "\n".join((text or "").splitlines()[:12])
    m = re.search(r"^\s*[-*]?\s*\**Кому:?\**:?\s*(.+)$", head, re.M | re.I)
    if not m:
        m = re.search(r"\bдля\s+((?:команд[ыа]\s+\S+|владельц[аеу]\s+контракта)(?:\s*(?:,|\bи\b)\s*(?:команд[ыа]\s+\S+|владельц[аеу]\s+контракта))*)", head, re.I)
    if not m:
        return {OWNER}
    parts = re.split(r",|\s+и\s+", m.group(1).split("·")[0])
    return {norm(p) for p in parts if p.strip()} or {OWNER}


def who_is_who(readme):
    """Таблица под заголовком «## Кому»: | адресат | имена git через запятую |."""
    out = {}
    sec = re.search(r"^## Кому\s*$(.*?)(?=^## |\Z)", readme or "", re.M | re.S)
    for row in re.findall(r"^\|([^|\n]+)\|([^|\n]+)\|", sec.group(1) if sec else "", re.M):
        a, names = norm(row[0]), [n.strip().strip("`") for n in row[1].split(",")]
        if row[0].strip().startswith("---") or a in ("адресат", "кому"):
            continue
        for n in names:
            if n:
                out.setdefault(n.lower(), set()).add(a)
    return out


def main():
    fresh = fetch()
    have_origin = fresh or git("rev-parse", "-q", "--verify", "origin/main")
    texts = {}
    names = [n for n in (git("ls-tree", "--name-only", f"origin/main:{DIR}") or "").split()] if have_origin else []
    blobs = cat_batch([f"origin/main:{DIR}/{n}" for n in names])  # один вызов git вместо одного на файл
    for name, text in zip(names, blobs):
        if name.endswith("-request.md") and text is not None:
            texts[name] = (text, False)
    remote_readme = blobs[names.index("README.md")] if "README.md" in names else None
    path = os.path.join(ROOT, DIR)
    local = set()
    for name in sorted(os.listdir(path)) if os.path.isdir(path) else []:
        if name.endswith("-request.md"):
            local.add(name)
            if name not in texts:
                with open(os.path.join(path, name), encoding="utf-8") as f:
                    texts[name] = (f.read(), True)
    local_readme = None
    if os.path.exists(os.path.join(path, "README.md")):
        with open(os.path.join(path, "README.md"), encoding="utf-8") as f:
            local_readme = f.read()
    # таблица «Кому» — с GitHub, если она там есть (её могли дополнить), иначе из рабочей копии
    readme = remote_readme if remote_readme and "\n## Кому" in remote_readme else local_readme
    me = (git("config", "user.name") or "").strip()
    mine_as = who_is_who(readme).get(me.lower(), set())
    mine, other = [], []
    for name in sorted(texts):
        text = texts[name][0]
        st = status_of(text)
        if st and not st.startswith(WAITING):
            continue
        to = addressees(text)
        where = "" if name in local else " — только на GitHub, нужен git pull --rebase"
        line = f"- {DIR}/{name}: {st or 'статус не указан'}, кому: {', '.join(sorted(to))}{where}"
        (mine if to & mine_as else other).append(line)
    if not mine and not other:
        return
    note = "" if fresh else " (GitHub недоступен — список по локальной копии и последнему fetch)"
    parts = []
    if mine:
        parts.append(f"Запросы для вас ({me}: {', '.join(sorted(mine_as))}), ждут ответа{note}:\n" + "\n".join(mine))
    if other:
        parts.append(("Остальные запросы, ждут ответа" if mine_as else
                      f"Запросы, ждут ответа (имени «{me}» нет в таблице «Кому» api/requests/README.md)") + f"{note}:\n" + "\n".join(other))
    context = "\n\n".join(parts) + (
        "\nСообщи пользователю в начале ответа одной-двумя строками: сначала запросы для него. Сам не выполняй: "
        "работу по запросу начинай только по его просьбе, порядок — скилл vms-requests (.claude/skills/vms-requests/SKILL.md)."
    )
    msg = f"Запросы для вас: {len(mine)}" + (f", остальных ждут ответа: {len(other)}" if other else "") if mine else f"Запросы ждут ответа: {len(other)}"
    print(json.dumps({
        "systemMessage": msg,
        "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
