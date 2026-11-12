#!/usr/bin/env python3
"""PreToolUse (Edit|Write|MultiEdit): напомнить Claude о правиле проекта.

Правка файла из области правила (таблица RULES) добавляет в контекст напоминание:
загрузи скилл (`skill`) или сделай шаг (`note`). Claude видит напоминание рядом с
результатом правки, поэтому текст просит сверить правку, а не сделать что-то до неё.
Один раз за сессию на правило, у субагента — свой раз. Для скилла, который главная
сессия уже загрузила (вызов Skill, чтение SKILL.md или /команда в транскрипте),
напоминания нет. Хук ничего не запрещает. Правки через shell (`cp`, `sed`) хук не видит.
"""
import fnmatch
import json
import os
import re
import sys
import tempfile

# Поля правила: id; paths — шаблоны от корня репозитория (fnmatch: * ловит и «/»);
# except — исключения; new_only — только новый файл; skip_new — пропустить новый файл
# по этим шаблонам; skill + why — напомнить о скилле; note — напомнить о шаге.
RULES = [
    {
        "id": "api-contract",
        "skill": "api-contract",
        "paths": ["api/*", "tests/api-*.js"],
        "except": ["api/requests/*"],
        "why": "правка контракта, сервера, наборов или тестов API",
    },
    {
        "id": "api-contract-request",
        "skill": "api-contract",
        "paths": ["api/requests/*-request.md"],
        "new_only": True,
        "why": "новый запрос к API или уведомление владельцу контракта",
    },
    {
        "id": "vms-requests",
        "skill": "vms-requests",
        "paths": ["api/requests/*"],
        "skip_new": ["api/requests/*-request.md"],
        "why": "работа по запросу команды VMS: статус, ответ, таблица запросов",
    },
    {
        "id": "gaps-proto",
        "paths": ["index_[0-9][0-9]*.html"],
        "note": "это прототип. Если прототип делает функцию из отчёта о пробелах против Axxon One "
                "(docs/axxon-one-gaps.html), добавь строку в PROTO по docs/axxon-one-gaps.md, "
                "раздел «Прототипы», шаг 1, — сам, без просьбы, в том же push, что и прототип.",
    },
]

WORKTREE = re.compile(r"^\.claude/worktrees/[^/]+/")


def file_path(data):
    tin = data.get("tool_input")
    if not isinstance(tin, dict):
        return ""
    path = tin.get("file_path") or tin.get("path") or ""
    return path if isinstance(path, str) else ""


def rel_path(path, data):
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    root = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root, path))
    rel = os.path.relpath(path, root).replace(os.sep, "/")
    if rel.startswith(".."):
        return ""
    # сессия открыта в основной копии, а правка — в её worktree
    return WORKTREE.sub("", rel)


def skill_loaded(transcript, skill):
    """Скилл загружен в этой сессии: вызов Skill, чтение его SKILL.md или /команда.

    Смотрит только вызовы инструментов ассистента и команды пользователя: путь к
    SKILL.md встречается и в тексте хуков, выводе git и файлах — это не загрузка.
    """
    if not transcript or not os.path.isfile(transcript):
        return False
    tail = f"/skills/{skill}/SKILL.md"
    commands = (f"<command-name>/{skill}</command-name>", f"<command-name>{skill}</command-name>")
    try:
        with open(transcript, encoding="utf-8", errors="replace") as f:
            for line in f:
                if skill not in line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                content = (obj.get("message") or {}).get("content")
                if obj.get("type") == "user" and isinstance(content, str):
                    if any(c in content for c in commands):
                        return True
                    continue
                if obj.get("type") != "assistant" or not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "tool_use":
                        continue
                    inp = block.get("input") or {}
                    if block.get("name") == "Skill" and inp.get("skill") == skill:
                        return True
                    if block.get("name") == "Read" and str(inp.get("file_path", "")).endswith(tail):
                        return True
    except OSError:
        return False
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict):
        return
    path = file_path(data)
    if not path:
        return
    rel = rel_path(path, data)
    if not rel:
        return
    exists = os.path.exists(os.path.join(os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd(), path))
    clean = lambda s: "".join(c for c in str(s) if c.isalnum() or c in "-_")
    session = clean(data.get("session_id") or "")
    agent = clean(data.get("agent_id") or "")
    notes, done = [], set()
    for rule in RULES:
        if not any(fnmatch.fnmatch(rel, p) for p in rule["paths"]):
            continue
        if any(fnmatch.fnmatch(rel, p) for p in rule.get("except", [])):
            continue
        if rule.get("new_only") and exists:
            continue
        if not exists and any(fnmatch.fnmatch(rel, p) for p in rule.get("skip_new", [])):
            continue
        skill = rule.get("skill")
        if skill in done:
            continue
        marker = None
        if session:
            marker = os.path.join(tempfile.gettempdir(),
                                  f"consolem-skill-{rule['id']}-{session}" + (f"-{agent}" if agent else ""))
            if os.path.exists(marker):
                continue
        # транскрипт в данных хука — главной сессии; субагент скилл сам не загружал
        if skill and (agent or not skill_loaded(data.get("transcript_path"), skill)):
            notes.append(
                f"Файл {rel}: {rule['why']}. Загрузи скилл проекта `{skill}` "
                f"(.claude/skills/{skill}/SKILL.md) сейчас, если ещё не загрузил, и сверь с ним эту "
                "правку и следующие шаги. Напоминание приходит один раз за сессию."
            )
            done.add(skill)
        elif not skill:
            notes.append(f"Файл {rel}: {rule['note']} Напоминание приходит один раз за сессию.")
        if marker:
            try:
                open(marker, "w").close()
            except OSError:
                pass
    if notes:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": "\n".join(notes),
            }
        }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # хук не должен мешать правке
        pass
