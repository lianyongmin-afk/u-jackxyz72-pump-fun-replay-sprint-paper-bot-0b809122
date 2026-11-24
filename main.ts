// Pump.fun Replay Sprint — traction sniper entry.
// Run by the grader as `node /bot/main.ts`. The strategy lives in strategy.ts, the protocol in the
// vendored SDK shim (vendor/makefun-bot.ts, a copy of the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello(state) {
    // Guard: refuse a harness whose caps cannot fit this strategy (a buy needs at least the
    // guardrail's 0.01 SOL and a reply slot for exits). Failing here is louder than silently
    // trading nothing for a whole window.
    const caps = state.hello.caps;
    if (caps.max_open_positions < 1 || caps.max_orders_per_batch < 1) {
      throw new Error(`unusable caps: max_open_positions=${caps.max_open_positions} max_orders_per_batch=${caps.max_orders_per_batch}`);
    }
    if (caps.max_order_bps_of_real_reserve < 1) {
      throw new Error(`unusable caps: max_order_bps_of_real_reserve=${caps.max_order_bps_of_real_reserve}`);
    }
    console.error(
      `traction-sniper up: capital=${state.hello.capital.lamports} maxPositions=${caps.max_open_positions} ` +
        `maxOrderBps=${caps.max_order_bps_of_real_reserve} latency=${state.hello.latency_slots}`,
    );
  },
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
