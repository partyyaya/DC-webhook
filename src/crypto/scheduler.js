/**
 * 常駐排程入口（npm run crypto:schedule）：每天在指定時間發送一次新聞，預設每天 08:00（台灣時間）。
 * 排程在 env/crypto.js 的 schedule 調整（days、time、timeZone）；補發與重試規則見 ../shared/digest-scheduler.js。
 */
import { runDigestScheduler } from '../shared/digest-scheduler.js';

await runDigestScheduler({
  topic: 'crypto',
  load: async () => ({ config: (await import('./config.js')).config, run: await import('./run.js') }),
});
