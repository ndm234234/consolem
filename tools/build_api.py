#!/usr/bin/env python3
"""Собрать api/openapi.js и api/fixture.js из api/openapi.json и api/fixtures/demo.json.

Страница прототипа и тесты открываются и с диска (file://), а там fetch JSON не
работает. Поэтому контракт и эталонный набор подключаются обычным <script>:
window.CONSOLEM_OPENAPI и window.CONSOLEM_FIXTURE. Собранные файлы руками не правят.

Запуск из корня репозитория:
  python3 tools/build_api.py          собрать
  python3 tools/build_api.py --check  собранное не отстало от JSON (код выхода 1, если отстало)
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = [
    ("api/openapi.json", "api/openapi.js", "CONSOLEM_OPENAPI"),
    ("api/fixtures/demo.json", "api/fixture.js", "CONSOLEM_FIXTURE"),
]


def render(src, name):
    with open(os.path.join(ROOT, src), encoding="utf-8") as f:
        data = json.load(f)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"/* Собрано tools/build_api.py из {src} — руками не править */\nwindow.{name}={body};\n"


def main():
    check = "--check" in sys.argv[1:]
    stale = []
    for src, dst, name in TARGETS:
        text = render(src, name)
        path = os.path.join(ROOT, dst)
        if check:
            try:
                with open(path, encoding="utf-8") as f:
                    if f.read() == text:
                        continue
            except FileNotFoundError:
                pass
            stale.append(f"{dst} отстал от {src}")
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"{dst} ← {src}")
    if stale:
        print("\n".join(stale) + "\nСоберите: python3 tools/build_api.py")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
