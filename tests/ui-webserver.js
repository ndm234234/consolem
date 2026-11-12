/* Сценарии интерфейса: вкладка «Веб-сервер» сервера (профиль vms.webserver/1, контракт 0.11.0). Плитка на «Общих», порты
   с ошибками у полей и запрет плана при ошибке, выбор сертификата и ключа файлами (проверка пары сервером — webcert.set с
   check), план с предупреждением о перезапуске и новым адресом, «Применить»: сертификат — отдельным запросом, порты —
   операцией; ключ не попадает в кэш и ответы. «Убрать сертификат». Запуск — tools/check_ui.py */
UiCheck(async ({ ok, until }) => {
  const id = (n) => `${n}-0000-4000-8000-000000000000`;
  const S = id(20000002);
  const main = () => document.getElementById("main");
  const text = () => main().textContent;
  const err = (k) => main().querySelector(`[data-web-err="${k}"]`)?.textContent || "";
  const modal = () => document.getElementById("bmodal")?.classList.contains("open");
  const type = (k, v) => { const el = document.getElementById(`web-${k}`); el.value = v; el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); };
  const file = (k, name, body) => webFile(S, k, [new File([body], name)]);
  const day = 86400000, now = Date.now();
  const gmt = (ms) => new Date(ms).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$2 $1 $4 $3 GMT");
  const CERT = `Issuer: CN = R11\nNot Before: ${gmt(now - day)}\nNot After : ${gmt(now + 90 * day)}\nSubject: CN = *.store.test\nDNS:*.store.test, DNS:store.test\n`
    + "-----BEGIN CERTIFICATE-----\nMIIA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const KEY = "-----BEGIN PRIVATE KEY-----\nMIIEuiSecretKeyBody\n-----END PRIVATE KEY-----\n";
  const rec = () => API.get(`/units/${S}`);

  goApp("hw");
  pick(S, { force: true });
  goTab("gen");
  ok(await until(() => main().querySelector("[data-web-tile]")), "плитка «Веб-сервер» на «Общих»");
  ok(/HTTP/.test(main().querySelector("[data-web-tile]").textContent) && !/HTTPS/.test(main().querySelector("[data-web-tile]").textContent), "у Склада сертификата нет: плитка — HTTP");
  main().querySelector("[data-web-tile]").click();
  ok(await until(() => tab === "web" && main().querySelector(".web-tab")), "плитка открывает вкладку «Веб-сервер»");
  ok(!/заглушк/i.test(text()), "ярлыков «заглушка» нет");
  ok(/работает только по HTTP/.test(text()) && /http:\/\/10\.20\.2\.10\//.test(main().querySelector("[data-web-addr]").textContent), "без сертификата — только HTTP, адрес http://IP/");

  // Порт: два одинаковых — ошибка у поля, план не открывается
  type("http", "443");
  ok(/уже занимает поле «Порт HTTPS»/.test(err("http")), "одинаковые порты: ошибка у поля HTTP — " + err("http"));
  cardPlan();
  ok(!modal(), "с ошибкой план не открывается");
  type("http", "9003");
  ok(/9001–9009/.test(err("http")), "порт из диапазона видео — ошибка: " + err("http"));
  type("http", "8080");
  ok(!err("http") && /http:\/\/10\.20\.2\.10:8080\//.test(main().querySelector("[data-web-addr]").textContent), "порт исправлен: ошибки нет, адрес с портом 8080");

  // Только сертификат: ключа нет — ошибка, HTTPS нет
  file("cert", "fullchain.pem", CERT);
  ok(await until(() => /Без ключа HTTPS не работает/.test(err("key"))), "только сертификат: «Указать файл ключа»");
  ok(!/https:/.test(main().querySelector("[data-web-addr]").textContent), "без ключа адреса HTTPS нет");
  // Ключ не подходит — ошибка сервера у поля ключа
  file("key", "other.key", "mismatch\n" + KEY);
  ok(await until(() => /не подходит к сертификату/.test(err("key"))), "сервер проверил пару: ключ не подходит — " + err("key"));
  file("key", "privkey.pem", KEY);
  ok(await until(() => main().querySelector("[data-web-cert]")), "сервер проверил пару: сведения о сертификате");
  ok(/\*\.store\.test/.test(main().querySelector("[data-web-cert]").textContent) && /ключ подходит/.test(main().querySelector("[data-web-cert]").textContent) && /полная/.test(main().querySelector("[data-web-cert]").textContent), "кому выдан, ключ подходит, цепочка полная");
  ok(/https:\/\/10\.20\.2\.10\//.test(main().querySelector("[data-web-addr]").textContent), "с парой файлов — адрес HTTPS");
  ok((await rec()).status.observed.webCertificate === null, "до «Применить» сервер сертификат не сохранил");

  // План: две строки, перезапуск и новый адрес; «Применить»
  const rows = cardDiff().map((r) => r.label);
  ok(rows.length === 2 && rows.some((l) => /Порт HTTP/.test(l)) && rows.some((l) => /Сертификат HTTPS/.test(l)), "план: порт и сертификат — " + rows.join(", "));
  cardPlan();
  ok(await until(() => modal() && document.querySelector("#bmBody [data-plan-web]")), "план открыт");
  const note = document.querySelector("#bmBody [data-plan-web]").textContent;
  ok(/перезапустит веб-сервер/.test(note) && /Новый адрес/.test(note) && /10\.20\.2\.10:8080/.test(note), "предупреждение: перезапуск и новый адрес — " + note.replace(/\s+/g, " "));
  ok(!!document.querySelector("#bmBody [data-plan-webcert]"), "сертификат — отдельным запросом до операции");
  [...document.querySelectorAll("#bmFoot button")].find((b) => /Применить/.test(b.textContent)).click();
  ok(await until(() => bq && bq.finished) && bq.fail === 0, "применено без отказов: ok " + bq?.ok);
  const u = await rec();
  ok(u.properties.webServer.httpPort === 8080 && u.status.observed.webCertificate?.subject === "*.store.test", "на сервере: порт 8080 и сертификат");
  ok(await until(() => find(S).n.webCert?.subject === "*.store.test"), "кэш обновлён: сертификат сервера");
  ok(!JSON.stringify(find(S).n).includes("uiSecretKeyBody") && !JSON.stringify(u).includes("uiSecretKeyBody"), "ключа нет ни в кэше, ни в ответе");
  ok(!webStore.get(S)?.key, "после «Применить» консоль ключ забыла");
  pick(S, { force: true });
  goTab("web");
  ok(await until(() => /сервер хранит ключ/.test(main().querySelector('[data-web-file="key"]')?.textContent || "")), "поле ключа: «сервер хранит ключ»");

  // «Убрать сертификат» и порт обратно
  webClearCert(S);
  ok(/уберёт сертификат после «Применить»/.test(text()), "консоль предупреждает: сертификат уйдёт после «Применить»");
  type("http", "80");
  cardPlan();
  ok(await until(() => modal()), "план открыт");
  [...document.querySelectorAll("#bmFoot button")].find((b) => /Применить/.test(b.textContent)).click();
  ok(await until(() => bq && bq.finished) && bq.fail === 0, "применено без отказов");
  const back = await rec();
  ok(back.status.observed.webCertificate === null && back.properties.webServer.httpPort === 80, "на сервере: сертификата нет, порт 80");
  closeBulkModal();
});
