<!-- Собрано tools/build_api.py из api/profiles/vms.discovery.json — руками не править -->
# `vms.discovery/1` — Поиск устройств в сети области

Версия 1.1 · ведёт: mockup · смотрят правку: w2c

Использует: —

Виды эталонного набора: `domain`. Предметные пути: `/units/{uid}/discovery`.

## Свойства

Своих свойств нет.

## Состояние (`status.observed`)

Своих свойств нет.

## Изменения

| Версия | Что |
|---|---|
| 1.1 | Контракт 0.36.0: необязательное тело DiscoveryStart у startDiscovery — serverId (поиск с одного сервера области) и category (ip, acfa, textEvent); без тела — как раньше: все серверы области, IP-устройства. Discovery отвечает serverId и category последнего поиска, находка — category и serverId (сервер, который её видит). Чужой serverId или неизвестная category — 422 VALIDATION_FAILED. Пробел F1 отчёта против Axxon One |
| 1.0 | Новый профиль, контракт 0.29.0: путь профиля /units/{uid}/discovery (GET, POST, DELETE — getDiscovery, startDiscovery, stopDiscovery) у объекта области (у VMS — домен) вместо пути /domains/{domainId}/discovery. Свойств нет: профиль объявляет только путь |
