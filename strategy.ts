// Traction sniper for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea: most new pump.fun coins die, a few run hard. Instead of guessing at launch, wait until a
// coin proves traction — its real SOL reserve reaches ENTRY_MIN_REAL_SOL — then buy one small fixed
// stake, take profit fast, cut the loss fast, never hold long, and rotate. One buy per coin, no
// adds, no partial exits, no splitting: every order is a single whole order, so the tx-fee cost
// stays minimal and the action log stays easy to reproduce.
//
// A round trip costs roughly 2.5% in curve fees (95 + 30 bps each way) plus two tx fees
// (105,000 lamports each), so the take-profit must clear that by a wide margin. The stop is tight
// enough that a dead coin costs little, and the hold cap frees the slot for the next coin. With at
// most 5 open positions of at most 0.05 SOL each, the worst-case drawdown from open positions is
// a small fraction of the 10 SOL capital.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O. Iteration order is the
// insertion order of the maps below, so the same input always yields the same orders.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Buy only once a coin's real SOL reserve reaches this (lamports): traction, not a guess. */
  entryMinRealSol: number;
  /** Buy only while the price is at most this far above the create price (bps, 10000 = create). */
  entryMaxRunupBps: number;
  /** Lamports to spend per coin (still capped at 1% of the real SOL reserve). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (also the guardrail's round-trip floor). */
  minBuyLamports: number;
  /** Sell once the position is worth this much over its cost (bps). */
  takeProfitBps: number;
  /** Sell once the position is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Sell after holding this many slots, whatever the price. */
  maxHoldSlots: number;
  /** Sell at once when the creator dumps while we hold. */
  exitOnCreatorSell: boolean;
  /** Trailing stop: once the position is worth this much over its cost (bps), arm it. */
  trailArmBps: number;
  /** Once armed, sell when the value falls this far (bps) below the best value seen. */
  trailBps: number;
  /** Slippage allowed on buys and sells (bps): 10000 means the fill is never refused for price. */
  slippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMinRealSol: 2_000_000_000,
  entryMaxRunupBps: 15_000,
  stakeLamports: 50_000_000,
  minBuyLamports: 10_000_000,
  takeProfitBps: 8_000,
  stopLossBps: 4_000,
  maxHoldSlots: 100_000,
  exitOnCreatorSell: true,
  trailArmBps: 4_000,
  trailBps: 2_000,
  slippageBps: 10_000,
};

/** Curve fees charged on every trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

interface WatchedCoin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time virtual reserves: the run-up is measured against them. */
  createVq: bigint;
  createVt: bigint;
  /** The creator sold at least once. */
  creatorSold: boolean;
  /** A buy was already sent for this coin (one buy per coin, ever). */
  bought: boolean;
  /** Never touch it again (exited, completed, or filtered out). */
  done: boolean;
  complete: boolean;
}

interface OpenPosition {
  openedSlot: number;
  /** Tx fees paid on the buy leg(s) of this position. */
  txPaid: bigint;
  /** Whether the creator had already sold when we opened. */
  creatorSoldAtOpen: boolean;
  /** Best net value seen while holding (for the trailing stop). */
  best: bigint;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return gross - fee;
}

/** Price now over the create price, in bps (10000 = unchanged). */
function runupBps(vq: bigint, vt: bigint, vq0: bigint, vt0: bigint): bigint {
  if (vt <= 0n || vq0 <= 0n || vt0 <= 0n) return 0n;
  return (vq * vt0 * BPS) / (vt * vq0);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const P = params;
  const coins = new Map<Pubkey, WatchedCoin>();
  const held = new Map<Pubkey, OpenPosition>();
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function noteEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          createVq: BigInt(e.virtual_quote_reserves),
          createVt: BigInt(e.virtual_token_reserves),
          creatorSold: false,
          bought: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        if (!e.is_buy && e.user === c.creator) c.creatorSold = true;
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  function settleFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // A harness close (complete / flatten / writeoff): the position is gone.
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
        held.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          creatorSoldAtOpen: coins.get(f.mint)?.creatorSold ?? false,
          best: 0n,
        });
      } else if (f.side === 'sell' && f.status === 'filled') {
        held.delete(f.mint);
        selling.delete(f.mint);
      } else {
        // A fill on a position we already track: its tx fee adds to the cost basis.
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') {
          h.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
    }
    for (const mint of [...selling]) {
      if (!hasPending(state, mint, 'sell')) selling.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
        held.delete(mint);
      }
    }
  }

  return {
    onBatch(state, batch) {
      noteEvents(batch);
      settleFills(state, batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();

      // Latest reserves for the coins we hold, from the batch marks (fall back to the curve map).
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return undefined;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // Exits first: take profit, cut loss, hold cap, creator dump.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const r = reservesOf(mint);
        if (r === undefined) continue;
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: txFee, creatorSoldAtOpen: coins.get(mint)?.creatorSold ?? false, best: 0n };
          held.set(mint, h);
        }
        const value = sellProceeds(pos.token_amount, r.vq, r.vt) - txFee;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.takeProfitBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.stopLossBps))) exit = true;
          // Trailing stop: once the position ran up enough, sell on a pullback from its best.
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= P.maxHoldSlots) exit = true;
        const c = coins.get(mint);
        if (c !== undefined && P.exitOnCreatorSell && c.creatorSold && !h.creatorSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.slippageBps });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one small buy per qualifying coin, while a position slot is free.
      let freeCash = state.freeCashLamports() - txFee * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.bought) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < BigInt(P.entryMinRealSol)) continue;
        if (c.creatorSold) {
          c.done = true;
          continue;
        }
        const runup = runupBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, c.createVq, c.createVt);
        if (runup > BigInt(P.entryMaxRunupBps)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (freeCash < amount + txFee) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.slippageBps });
        c.bought = true;
        freeCash -= amount + txFee;
        open += 1;
      }
      return orders;
    },
  };
}
