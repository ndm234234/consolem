#!/usr/bin/env python3
"""Замок index.html: одна сессия за раз переносит в основной макет или правит его.

Над репозиторием работают несколько сессий Claude, каждая в своём рабочем каталоге (worktree). Две сессии, которые
правят index.html одновременно, потом сводят конфликт в файле на 45 000 строк. Замок говорит, кто сейчас правит.

Замок — файл <git-common-dir>/consolem/index.lock: его видят все рабочие каталоги этой машины (в git он не попадает).
Другие машины и люди (altumur) замок не видят: от них защищают rebase перед push и перенос правкой, а не копией
(скилл proto-promote).

    python3 tools/index_lock.py status      кто держит замок; в каких рабочих каталогах есть правки index.html без push
    python3 tools/index_lock.py take [что]  взять замок («прототип 109» — что переносим); занят другим — отказ, код 1
    python3 tools/index_lock.py release     снять свой замок (после push)
    python3 tools/index_lock.py release --force   снять чужой замок — только пользователь, в своём терминале
    python3 tools/index_lock.py --selftest  проверить сам скрипт на временном репозитории

Замок свободен, если:
- его нет или он свой (тот же рабочий каталог);
- рабочего каталога владельца больше нет;
- владелец не трогал замок больше LOCK_TTL_H часов (брошенный): каждая правка index.html через хук обновляет время;
- владелец сделал push и забыл снять замок: index.html в origin/main изменился с базы замка, HEAD владельца уже
  в origin/main, а его index.html совпадает с origin/main.

Хук .claude/hooks/index_lock.py зовёт эти же функции перед правкой index.html и после неё.
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

LOCK_TTL_H = 2          # часов без правки: старше — замок брошен
RECENT_H = 24           # часов: правка index.html без push свежее этого — показываем
TARGET = "index.html"


def git(cwd, *args, check=False):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=20)
    if check and r.returncode:
        raise RuntimeError(r.stderr.strip() or f"git {' '.join(args)}: код {r.returncode}")
    return r


def toplevel(cwd):
    r = git(cwd, "rev-parse", "--show-toplevel")
    return os.path.realpath(r.stdout.strip()) if r.returncode == 0 else None


def lock_path(cwd):
    r = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", check=True)
    return os.path.join(r.stdout.strip(), "consolem", "index.lock")


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def stamp():
    return now().isoformat(timespec="seconds")


def read_lock(cwd):
    try:
        with open(lock_path(cwd), encoding="utf-8") as f:
            lk = json.load(f)
        return lk if isinstance(lk, dict) else None
    except (OSError, ValueError):
        return None


def write_lock(cwd, data):
    """Атомарная замена: читатель видит старый или новый файл, не половину."""
    p = lock_path(cwd)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, p)


def create_lock(cwd, data):
    """Новый замок: O_EXCL — из двух сессий, взявших его в одну миллисекунду, выигрывает одна."""
    p = lock_path(cwd)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def rev(cwd, ref):
    r = git(cwd, "rev-parse", "--verify", "-q", ref)
    return r.stdout.strip() if r.returncode == 0 else None


def pushed(lk, cwd):
    """Владелец сделал push своей правки index.html и не снял замок."""
    owner, base = lk.get("owner") or "", lk.get("base")
    if not base or not rev(cwd, "origin/main"):
        return False
    if git(cwd, "diff", "--quiet", base, "origin/main", "--", TARGET).returncode == 0:
        return False                                  # index.html в origin/main с базы не менялся
    head = rev(owner, "HEAD")
    if not head or git(cwd, "merge-base", "--is-ancestor", head, "origin/main").returncode:
        return False                                  # у владельца есть коммиты без push
    return git(owner, "diff", "--quiet", "origin/main", "--", TARGET).returncode == 0


def expired(lk, cwd):
    """Почему замок больше не действует, или None."""
    owner = lk.get("owner") or ""
    if not os.path.isdir(owner):
        return "рабочего каталога владельца больше нет"
    try:
        at = datetime.datetime.fromisoformat(lk.get("at", ""))
    except (TypeError, ValueError):
        at = None
    if at is None or at.tzinfo is None or now() - at > datetime.timedelta(hours=LOCK_TTL_H):
        return f"владелец не правил index.html больше {LOCK_TTL_H} ч — замок брошен"
    if pushed(lk, cwd):
        return "владелец уже сделал push"
    return None


def lock_state(cwd):
    """(замок или None, свободен ли он для cwd, почему)."""
    lk = read_lock(cwd)
    if not lk:
        return None, True, "замка нет"
    if lk.get("owner") == toplevel(cwd):
        return lk, True, "замок свой"
    why = expired(lk, cwd)
    if why:
        return lk, True, why
    return lk, False, "замок держит другая сессия"


def pending_elsewhere(cwd):
    """Другие рабочие каталоги, где index.html изменён против общей с origin/main базы (коммит без push или правка
    без коммита) и файл тронут за последние RECENT_H часов. Старые брошенные каталоги не показываем."""
    me = toplevel(cwd)
    r = git(cwd, "worktree", "list", "--porcelain")
    paths = [os.path.realpath(l[9:]) for l in r.stdout.splitlines() if l.startswith("worktree ")]
    out = []
    for p in paths:
        f = os.path.join(p, TARGET)
        if p == me or not os.path.isfile(f):
            continue
        if now().timestamp() - os.path.getmtime(f) > RECENT_H * 3600:
            continue
        mb = git(p, "merge-base", "HEAD", "origin/main")
        if mb.returncode:
            continue
        if git(p, "diff", "--quiet", mb.stdout.strip(), "--", TARGET).returncode:
            br = git(p, "branch", "--show-current").stdout.strip()
            out.append({"path": p, "branch": br})
    return out


def describe(lk):
    at = (lk.get("since") or lk.get("at") or "?")[:16].replace("T", " ")
    return f"{lk.get('what') or 'правка index.html'} — {lk.get('owner')} ({lk.get('branch') or 'без ветки'}), с {at} UTC"


def take(cwd, what=""):
    """Взять замок или продлить свой. (успех, сообщение)."""
    me = toplevel(cwd)
    for _ in range(3):
        lk = read_lock(cwd)
        if lk and lk.get("owner") == me and not expired(lk, cwd):
            data = {**lk, "at": stamp(), "what": what or lk.get("what", "")}      # продлить свой
            write_lock(cwd, data)
            return True, f"Замок index.html свой, продлён: {describe(data)}."
        if lk and lk.get("owner") != me and not expired(lk, cwd):
            return False, f"Замок index.html занят: {describe(lk)}."
        p = lock_path(cwd)
        if lk:                                        # брошенный: убрать его, кто первый
            try:
                os.rename(p, f"{p}.{os.getpid()}.stale")
                os.remove(f"{p}.{os.getpid()}.stale")
            except FileNotFoundError:
                continue                              # его уже убрала другая сессия
        t = stamp()
        data = {"owner": me, "branch": git(me, "branch", "--show-current").stdout.strip(), "what": what,
                "since": t, "at": t, "base": rev(cwd, "origin/main")}
        try:
            create_lock(cwd, data)
        except FileExistsError:
            continue                                  # другая сессия успела раньше
        return True, f"Замок index.html взят: {describe(data)}."
    lk = read_lock(cwd) or {}
    return False, f"Замок index.html занят: {describe(lk)}."


def release(cwd, force=False):
    lk = read_lock(cwd)
    if not lk:
        return True, "Замка нет."
    if lk.get("owner") != toplevel(cwd) and not force:
        return False, f"Замок чужой, его не снимаю: {describe(lk)}."
    os.remove(lock_path(cwd))
    return True, "Замок index.html снят."


def status(cwd):
    lk, free, why = lock_state(cwd)
    lines = [f"Замок: {describe(lk)} — {why}." if lk else "Замок: нет."]
    other = pending_elsewhere(cwd)
    if other:
        lines.append("Правки index.html без push в других рабочих каталогах:")
        lines += [f"  {o['path']} ({o['branch'] or 'без ветки'})" for o in other]
    else:
        lines.append("Других рабочих каталогов с правками index.html без push нет.")
    return lines


def selftest():
    ok = True

    def check(name, cond):
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + name)
        ok = ok and cond

    def age(cwd, hours):
        lk = read_lock(cwd)
        lk["at"] = (now() - datetime.timedelta(hours=hours)).isoformat(timespec="seconds")
        write_lock(cwd, lk)

    def commit_push(cwd, name, text):
        with open(os.path.join(cwd, name), "w") as f:
            f.write(text)
        git(cwd, "add", name, check=True); git(cwd, "commit", "-qm", text, check=True)
        git(cwd, "push", "-q", "origin", "HEAD:main", check=True); git(cwd, "fetch", "-q", "origin", check=True)

    with tempfile.TemporaryDirectory() as d:
        d = os.path.realpath(d)
        origin, a, b = (os.path.join(d, n) for n in ("origin.git", "a", "b"))
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        subprocess.run(["git", "clone", "-q", origin, a], check=True, capture_output=True)
        for k, v in (("user.name", "t"), ("user.email", "t@t")):
            git(a, "config", k, v, check=True)
        commit_push(a, TARGET, "v1\n")
        git(a, "worktree", "add", "-q", "-b", "wb", b, "origin/main", check=True)
        check("свободен без замка", lock_state(a)[1])
        check("a берёт замок", take(a, "прототип 1")[0])
        check("a видит свой замок свободным", lock_state(a)[1])
        check("b получает отказ", not take(b, "прототип 2")[0])
        check("b не снимает чужой замок", not release(b)[0])
        check("--force снимает чужой замок", release(b, force=True)[0] and read_lock(a) is None)
        take(a, "прототип 1")
        lk = read_lock(a); lk["seen"] = ["x"]; write_lock(a, lk)
        take(a)
        check("продление сохраняет отметки и что", read_lock(a).get("seen") == ["x"] and read_lock(a)["what"] == "прототип 1")
        commit_push(b, "protos.html", "other\n")
        check("чужой push без index.html не освобождает замок", not lock_state(b)[1])
        with open(os.path.join(a, TARGET), "w") as f:
            f.write("v2\n")
        check("b видит правку a без push", any(o["path"] == a for o in pending_elsewhere(b)))
        git(a, "commit", "-qam", "v2", check=True)
        check("коммит a без push держит замок", not lock_state(b)[1])
        git(a, "pull", "-q", "--rebase", "origin", "main", check=True)
        git(a, "push", "-q", "origin", "HEAD:main", check=True); git(a, "fetch", "-q", "origin", check=True)
        check("после push a замок свободен для b", lock_state(b)[1])
        check("после push правки a не видны", not any(o["path"] == a for o in pending_elsewhere(b)))
        take(a, "прототип 3")
        check("после своего push take даёт новый замок", read_lock(a)["what"] == "прототип 3" and read_lock(a)["base"] == rev(a, "origin/main"))
        check("a снимает свой замок", release(a)[0] and read_lock(a) is None)
        take(a, "прототип 4"); age(a, LOCK_TTL_H - 0.5); take(a)
        check("правка продлевает замок", not lock_state(b)[1])
        age(a, LOCK_TTL_H + 1)
        check("замок без правок дольше срока брошен", lock_state(b)[1])
        check("b забирает брошенный замок без чужого «что»", take(b)[0] and read_lock(b)["owner"] == b and read_lock(b)["what"] == "")
        lk = read_lock(b); lk["at"] = "2026-01-01T00:00:00"; write_lock(b, lk)
        check("время без часового пояса — брошен", lock_state(a)[1])
        release(b, force=True)
        create_lock(a, {"owner": a, "at": stamp()})
        try:
            create_lock(b, {"owner": b, "at": stamp()}); excl = False
        except FileExistsError:
            excl = True
        check("второй create_lock получает отказ", excl)
    print("RESULT " + ("pass" if ok else "fail"))
    return 0 if ok else 1


def main(argv):
    cwd = os.getcwd()
    if not argv or argv[0] == "status":
        print("\n".join(status(cwd)))
        return 0
    if argv[0] == "--selftest":
        return selftest()
    if argv[0] == "take":
        good, msg = take(cwd, " ".join(argv[1:]))
        print(msg)
        if good:
            other = pending_elsewhere(cwd)
            if other:
                print("Внимание: правки index.html без push в других рабочих каталогах — скажи пользователю:")
                print("\n".join(f"  {o['path']} ({o['branch'] or 'без ветки'})" for o in other))
        return 0 if good else 1
    if argv[0] == "release":
        good, msg = release(cwd, "--force" in argv[1:])
        print(msg)
        return 0 if good else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
