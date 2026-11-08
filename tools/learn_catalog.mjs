#!/usr/bin/env node
/* Каталог учебных глав раздела «Обучение» — JSON для UI и бэкенда VMS (запрос w2c, ADR-VMS-0004, п. 1).

Источник один — темы показа: assets/tour.js (движок, Tour.catalog) и assets/tour-demos.js (темы и главы). Инструмент
исполняет их без страницы и печатает Tour.catalog() — тот же каталог, что страница строит у себя: те же ID, тексты
и отпечаток version. Руками каталог не правят: его собирает tools/build_webui.py в learn-catalog.json сборки.

Запуск из корня репозитория:
  node tools/learn_catalog.mjs                       каталог в stdout
  node tools/learn_catalog.mjs --out FILE            каталог в файл
  node tools/learn_catalog.mjs --demos FILE[,FILE]   темы из других файлов (по порядку; прототип со своими главами)
  node tools/learn_catalog.mjs --without-learn       каталог сборки без обучения: available:false, тем нет
Код выхода 1, если темы не исполнились или у темы, главы нет устойчивого ID. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const out = arg("--out", null);
const tourFile = path.resolve(ROOT, arg("--tour", "assets/tour.js"));
const demoFiles = arg("--demos", "assets/tour-demos.js").split(",").map((f) => path.resolve(ROOT, f));

function build() {
  // Страницы нет: адрес без ?demo, разметки нет. Движку этого хватает, чтобы зарегистрировать темы; показ он не запускает
  const errors = [];
  const ctx = {
    location: { search: "", href: "http://localhost/index.html", hash: "" },
    document: { querySelector: () => null },
    console: { error: (...a) => errors.push(a.join(" ")), warn: () => {}, log: () => {} },
    TextEncoder, URL, URLSearchParams,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(tourFile, "utf8"), ctx, { filename: tourFile });
  ctx.Tour.start = () => {};
  for (const f of demoFiles) vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
  if (errors.length) throw new Error(errors.join("\n"));
  return ctx.Tour.catalog({ available: true });
}

let catalog;
if (args.includes("--without-learn")) {
  catalog = { format: "consolem-learn-catalog/1", version: null, available: false, reason: "сборка без раздела «Обучение» (--without-learn)", topics: [] };
} else {
  try {
    catalog = build();
  } catch (e) {
    console.error(`learn_catalog: ${e.message}`);
    process.exit(1);
  }
}
// Обычный объект: каталог собран в другом контексте vm
const text = JSON.stringify(JSON.parse(JSON.stringify(catalog)), null, 2) + "\n";
if (out) fs.writeFileSync(out, text);
else process.stdout.write(text);
