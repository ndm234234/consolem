#!/usr/bin/env python3
"""PreToolUse (Edit|Write|MultiEdit): напомнить Claude загрузить скилл проекта.

Правка файла из области скилла (таблица RULES) добавляет в контекст напоминание:
загрузи скилл. Один раз за сессию на скилл; если скилл уже загружен в этой
сессии (видно в транскрипте), напоминания нет. Хук ничего не запрещает.
"""
import fnmatch
import json
import os
import sys
import tempfile

# скилл → шаблоны путей от корня репозитория (fnmatch: * ловит и «/») и исключения
RULES = [
    {
        "skill": "api-contract",
        "paths": ["api/*", "tests/api-*.js"],
        "except": ["api/requests/*"],
        "why": "правка контракта, сервера, наборов или тестов API",
    },
]


def rel_path(data):
    tin = data.get("tool_input") or {}
    path = tin.get("file_path") or tin.get("path") or ""
    if not path:
        return ""
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    path = os.path.normpath(os.path.join(root, path))
    rel = os.path.relpath(path, os.path.normpath(root))
    return "" if rel.startswith("..") else rel.replace(os.sep, "/")


def skill_loaded(transcript, skill):
    """Скилл уже загружен: в транскрипте есть вызов Skill или чтение его SKILL.md."""
    if not transcript or not os.path.isfile(transcript):
        return False
    marks = (f'"skill":"{skill}"', f'"skill": "{skill}"', f"skills/{skill}/SKILL.md")
    try:
        with open(transcript, encoding="utf-8", errors="replace") as f:
            for line in f:
                if any(m in line for m in marks):
                    return True
    except OSError:
        return False
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    rel = rel_path(data)
    if not rel:
        return
    session = "".join(c for c in str(data.get("session_id") or "nosession") if c.isalnum() or c in "-_")
    notes = []
    for rule in RULES:
        if not any(fnmatch.fnmatch(rel, p) for p in rule["paths"]):
            continue
        if any(fnmatch.fnmatch(rel, p) for p in rule.get("except", [])):
            continue
        marker = os.path.join(tempfile.gettempdir(), f"consolem-skill-{rule['skill']}-{session}")
        if os.path.exists(marker):
            continue
        if not skill_loaded(data.get("transcript_path"), rule["skill"]):
            notes.append(
                f"Файл {rel}: {rule['why']}. Загрузи скилл проекта `{rule['skill']}` "
                f"(.claude/skills/{rule['skill']}/SKILL.md) до этой правки и работай по нему, "
                "если ещё не загрузил. Напоминание приходит один раз за сессию."
            )
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
    main()
