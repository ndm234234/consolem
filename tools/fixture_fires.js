/* Демо-запуски правил эталонного набора — движком сервера (api/rule-engine.js).
   Вызывает tools/extract_fixture.py: на вход (stdin) — { fixture, rules: { старый id правила → UUID } },
   на выход (stdout) — ruleFires набора. Исходы те же, что у демо-запусков основного макета (ruleFiresInit):
   сколько запусков и когда, где превышен лимит, где прежний запуск ещё шёл, где реле не ответило. */
const engine = require("../api/rule-engine.js");

const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
const fx = input.fixture, R = input.rules;
const e = engine.forDb(() => fx);
const fires = [];
// Стенный момент (местное время системы) → момент
const at = (y, m, d, h, mi, s) => e.fromWall(new Date(Date.UTC(y, m, d, h, mi, s)));
function mk(old, n, from) {
  const r = fx.rules.find((x) => x.id === R[old]);
  for (let i = 0; i < n; i++) {
    let m = from - i * 17;
    if (old === "r2" && i >= 9) m = 170 - (i - 9) * 20; // старшие записи — в ночь на среду 21 октября: три первые попадают в окно обслуживания 02:00–03:00
    const ms = r.start === "schedule" ? at(2026, 9, 19 - 7 * i, 10, 0, i + 1) : at(2026, 9, old === "r2" && i >= 9 ? 21 : 23, Math.floor(m / 60), m % 60, (i * 7 + 11) % 60);
    const f = e.fire(r, {
      at: ms, i, rateN: 1 + ((i * 2) % r.ratePerMinute),
      rateHit: old === "r1" && i % 7 === 6, busy: old === "r3" && (i === 3 || i === 8),
      flaky: old === "r1" ? (key) => key === "1" && (i + 1) % 5 === 0 : null,
    });
    fires.push(f);
  }
}
mk("r1", 16, 470); // ночное правило — запуски ночью
mk("r2", 13, 1400);
mk("r3", 12, 1310);
mk("r5", 3, 905);
mk("r6", 2, 600);
mk("r7", 1, 545);
mk("r9", 4, 520);
fires.sort((a, b) => b.at.localeCompare(a.at) || a.ruleId.localeCompare(b.ruleId));
fires.forEach((f, i) => (f.id = `d${String(i + 1).padStart(7, "0")}-0000-4000-8000-000000000000`));
process.stdout.write(JSON.stringify(fires.map((f) => Object.assign({ id: f.id }, f))));
