// Нейтральный пример долгоживущего процесса: раз в WORKER_EVERY_MS пишет строку в stdout и пульс в worker.hb.
// Берёт замок worker.lock: второй экземпляр выходит с кодом 3, и run-forever.sh его не перезапускает.
//   node worker.js            — работать
//   node worker.js --once     — один шаг и выход
//   DRY=1 node worker.js      — сухой прогон: без замка и без пульса, только печать
//   WORKER_HANG_AFTER=3       — после 3 шагов перестать писать пульс (проверить, что сторож снимет)
import path from 'node:path';
import { writeHeartbeat } from '../src/heartbeat.ts';
import { lockOrExit } from '../src/lock.ts';

const dir = import.meta.dirname;
const once = process.argv.includes('--once');
const dry = process.env.DRY === '1' || process.argv.includes('--dry-run');
const everyMs = Number(process.env.WORKER_EVERY_MS ?? 5000);
const hangAfter = Number(process.env.WORKER_HANG_AFTER ?? 0);
const hbFile = path.join(dir, 'worker.hb');

if (!dry) lockOrExit(path.join(dir, 'worker.lock'), { match: /worker\.js/ });

let step = 0;
function work() {
  step++;
  const hung = hangAfter > 0 && step > hangAfter;
  console.log(`${new Date().toISOString()} ${dry ? '[DRY] ' : ''}шаг ${step}${hung ? ' (пульс не пишу)' : ''}`);
  if (!dry && !hung) writeHeartbeat(hbFile);
}

work();
if (!once && !dry) setInterval(work, everyMs);
