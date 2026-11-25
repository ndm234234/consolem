/* RTSP-камера с несколькими потоками (пробел AX1): свойство rtspUrl вида stream, профиль vms.stream/1 1.3.
   Поле RTSP формы «По адресу» принимает до трёх адресов через «;»: первый — адрес камеры, остальные — потоки камеры
   со своим адресом. На вкладке «Видео» у потока — поле «Адрес RTSP»; пустое поле — поток идёт по адресу камеры.
   На странице без свойства rtspUrl у вида stream сценарий ничего не проверяет.
   Запуск: python3 tools/check_ui.py tests/ui-rtsp-potoki.js */
UiCheck(async ({ ok, until }) => {
  if (typeof rtspUrlsSplit !== "function" || !cvSrvOk("rtspUrl")) { ok(true, "адресов RTSP у потоков на странице нет: страница скопирована с index.html до пробела AX1"); return; }
  const CAM = "30000041-0000-4000-8000-000000000000"; // «Запасной вход»: потоки «Основной» и «Второй» (…/102)
  const main = () => document.getElementById("main");
  const btnIn = (el, t) => [...(el || document).querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(t));
  // until проверяет условие без await: для ответа сервера — свой цикл
  const untilA = async (fn, n = 320) => { for (let i = 0; i < n; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
  const streams = async () => { const r = await API.get(`/units?parentId=${CAM}&kind=stream`); return (r.items || r).map((u) => [u.name, u.properties.rtspUrl || ""]); };

  // Форма и строка плана: деление по «;», предел три адреса
  ok(JSON.stringify(rtspUrlsSplit(" a ; b;;c ")) === '["a","b","c"]', "адреса через «;»: пробелы и пустые части отброшены");
  ok(/потоками: 3/.test(rtspUrlsHintHtml("a;b;c")) && /rtsp-urls-bad/.test(rtspUrlsHintHtml("a;b;c;d")), "подсказка формы: три адреса — три потока, четыре — ошибка");
  const row = { source: "manual", r: { type: "camera", vendor: "RTSP", rtspUrl: "a", rtsp: "a", rtspMore: [], channels: 1 } };
  planSetField(row, "rtspUrl", "x; y; z");
  ok(row.r.rtspUrl === "x" && row.r.rtspMore.join() === "y,z" && /потоки: y, z/.test(planRowTitle(row).sub), "правка адреса в строке плана: первый — камере, остальные — потокам");
  planSetField(row, "vendor", "Axis");
  ok(!row.r.rtspMore.length, "производитель не RTSP — дополнительных потоков нет");

  // Карточка камеры: адрес основного — адрес камеры, у второго — свой
  goApp("hw");
  await hwEnsure([CAM]);
  openNode(CAM, { app: "hw", tab: "vid" });
  ok(await until(() => main().querySelector("[data-cv-streams]") && /Streaming\/Channels\/102/.test(main().querySelector("[data-cv-streams]").textContent)), "вкладка «Видео»: адрес второго потока с сервера");
  ok(/Адрес RTSP[\s\S]*Channels\/101/.test(main().querySelector("[data-cv-streams]").textContent), "у основного потока — адрес камеры");

  // Правка: «Изменить» → поле → «Добавить в план» → «Применить»
  btnIn(main().querySelector("[data-cv-streams]"), "Изменить").click();
  ok(await until(() => main().querySelector("[data-cv-url]")), "поле «Адрес RTSP» у второго потока");
  const inp = main().querySelector("[data-cv-url]");
  inp.value = " rtsp://192.168.1.26:554/Streaming/Channels/103 "; inp.dispatchEvent(new Event("change", { bubbles: true }));
  btnIn(main().querySelector("[data-cv-streams]"), "Добавить в план").click();
  ok(await until(() => btnIn(document, "Показать план")), "подвал карточки: «Показать план»");
  btnIn(document, "Показать план").click();
  ok(await until(() => /«Второй»: адрес RTSP/.test(document.body.innerText)), "строка плана «Второй»: адрес RTSP");
  [...document.querySelectorAll("button")].filter((b) => /^Применить/.test(b.textContent.trim())).pop().click();
  ok(await untilA(async () => (await streams()).some(([n, u]) => n === "Второй" && u === "rtsp://192.168.1.26:554/Streaming/Channels/103")), "сервер принял адрес потока, пробелы убраны");

  // После добавления камеры: потоки по остальным адресам (второй поток с адресом не правится — новый)
  const cam = await API.get(`/units/${CAM}`);
  planRtspStreams([{ r: { rtspMore: ["rtsp://h/sub", "rtsp://h/third"] } }], [{ index: 0, units: [cam] }]);
  ok(await untilA(async () => (await streams()).length === 4), "консоль создала два потока");
  const s = await streams();
  ok(s.some(([n, u]) => n === "Поток 2" && u === "rtsp://h/sub") && s.some(([n, u]) => n === "Поток 3" && u === "rtsp://h/third"), "«Поток 2» и «Поток 3» со своими адресами");
});
