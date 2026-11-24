// Pump.fun Paper Sprint bot — deterministic early-sniper paper trader.
//
// Protocol: agent-fun/replay/v2 over NDJSON on stdin/stdout.
//   harness -> bot: {"type":"hello",...}, {"type":"batch","seq","slot","events","marks","fills","account"}, {"type":"done",...}
//   bot -> harness: {"type":"reply","seq","orders":[...]} — exactly one reply per batch.
// Paper trading only: no real funds, no network, no randomness, no wall clock.
// Every decision comes from the event stream, so two runs agree byte for byte.
//
// Strategy (early sniper — measured on the kit's dev dataset, 128k events):
//   - Most pump.fun coins bleed slowly (median first-to-last return -8%) while
//     a few run hard (40% peak above +50% from their first trade). Chasing a
//     move that already happened loses: buying at a coin's 5th trade is a
//     negative-expectation entry, buying at its 1st trade is positive.
//   - So: buy a mint on its FIRST trade, small, and only while its price is
//     still within +10% of that first print. Never chase.
//   - Size each buy at 0.15 SOL, capped at 0.9% of the mint's real SOL reserves
//     (harness cap is 100 bps of real reserve) and never below 0.02 SOL, so
//     every fill clears the 0.01 SOL round-trip bar.
//   - At most 5 open positions, at most 2 buys per batch, cash buffer kept.
//   - Sell a position in full at +50% take-profit, -20% stop-loss, after 600
//     batches held, or when the mint's bonding curve completes (CompleteEvent).
//   - Cycling through fresh mints clears the 20-distinct-mint guardrail; with
//     at most 0.75 SOL deployed of 10 SOL capital, worst-case drawdown stays
//     far under the 50% guardrail.
//   - Local dev grade of this exact file: net PnL -0.26 SOL, 94 round trips
//     over 94 coins, max drawdown 4.9%, guardrails met — the best active
//     strategy measured on the dev window (kit's own sniper pilot: -0.42 SOL;
//     momentum pilot: -9.45 SOL; reversion pilot: -4.37 SOL).

import * as readline from "node:readline";

const LAMPORTS_PER_SOL = 1_000_000_000;
const BUY_LAMPORTS = 150_000_000; // 0.15 SOL per buy
const MIN_BUY_LAMPORTS = 20_000_000; // 0.02 SOL, above the 0.01 SOL round-trip bar
const MAX_OPEN_POSITIONS = 5;
const MAX_BUYS_PER_BATCH = 2;
const BUY_SLIPPAGE_BPS = 1000; // 10%: early prints move fast; a missed fill beats a bad fill
const SELL_SLIPPAGE_BPS = 500; // 5%
const MAX_ENTRY_TRADES = 2; // buy only on the mint's 1st or 2nd trade
const MAX_ENTRY_RISE_BPS = 1000; // ...and only within +10% of its first print
const TAKE_PROFIT_BPS = 5000; // +50%
const STOP_LOSS_BPS = -2000; // -20%
const HOLD_MAX_BATCHES = 600;

type MintState = {
  firstPrice: number;
  lastPrice: number;
  tradeCount: number;
  completed: boolean;
  firstSeenSeq: number;
  firstRealSol: bigint;
  lastRealSol: bigint;
};

const mints = new Map<string, MintState>();
const held = new Map<string, { tokens: bigint; cost: bigint; entrySeq: number }>();
// Mints with a buy order sent but not yet seen as a filled position.
// Prevents re-buying the same mint every batch while the fill is in flight
// (fills land ~latency_slots later; the account snapshot lags the order).
const pendingBuys = new Map<string, number>(); // mint -> seq the buy was sent
// Mints we already tried to buy once (filled or not): one shot per mint.
const attempted = new Set<string>();
let orderCounter = 0;
let cashLamports = 0n;

function priceOf(virtualSol: string, virtualTokens: string): number {
  const sol = Number(BigInt(virtualSol));
  const tok = Number(BigInt(virtualTokens));
  if (tok <= 0 || sol < 0) return 0;
  return sol / tok;
}

function getMint(mint: string, seq: number): MintState {
  let st = mints.get(mint);
  if (!st) {
    st = {
      firstPrice: 0,
      lastPrice: 0,
      tradeCount: 0,
      completed: false,
      firstSeenSeq: seq,
      firstRealSol: 0n,
      lastRealSol: 0n,
    };
    mints.set(mint, st);
  }
  return st;
}

function handleBatch(msg: any): { type: string; seq: number; orders: any[] } {
  const seq: number = msg.seq;
  const orders: any[] = [];

  // Authoritative account snapshot for this batch.
  cashLamports = BigInt(msg.account?.cash_lamports ?? "0");
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  for (const p of msg.account?.positions ?? []) {
    positions.set(p.mint, { tokens: BigInt(p.token_amount), cost: BigInt(p.cost_lamports) });
  }
  // Sync held set with the account; keep entry bookkeeping where we have it.
  for (const mint of [...held.keys()]) {
    if (!positions.has(mint)) held.delete(mint);
  }
  // A pending buy resolves once its position appears, or after 10 batches
  // (fill rejected/failed: the mint stays in `attempted`, one shot only).
  for (const [mint, sentSeq] of [...pendingBuys.entries()]) {
    if (positions.has(mint) || seq - sentSeq > 10) pendingBuys.delete(mint);
  }
  for (const [mint, pos] of positions) {
    const prev = held.get(mint);
    if (!prev) {
      held.set(mint, { tokens: pos.tokens, cost: pos.cost, entrySeq: seq });
    } else {
      prev.tokens = pos.tokens;
      prev.cost = pos.cost;
    }
  }

  // Current mark prices per mint (virtual reserves => price in SOL per token).
  const markPrice = new Map<string, number>();
  const markRealSol = new Map<string, bigint>();
  for (const m of msg.marks ?? []) {
    const p = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
    if (p > 0) markPrice.set(m.mint, p);
    markRealSol.set(m.mint, BigInt(m.real_quote_reserves));
  }

  // Absorb market events; collect this batch's first-sight mints.
  const firstSight: { mint: string; price: number; realSol: bigint }[] = [];
  for (const ev of msg.events ?? []) {
    if (ev.event === "TradeEvent") {
      const st = getMint(ev.mint, seq);
      const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      const realSol = BigInt(ev.real_sol_reserves);
      if (st.tradeCount === 0) {
        if (p > 0) st.firstPrice = p;
        st.firstRealSol = realSol;
        if (p > 0) firstSight.push({ mint: ev.mint, price: p, realSol });
      }
      if (p > 0) st.lastPrice = p;
      st.lastRealSol = realSol;
      st.tradeCount += 1;
    } else if (ev.event === "CreateEvent") {
      const st = getMint(ev.mint, seq);
      const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      if (p > 0 && st.firstPrice === 0) st.firstPrice = p;
      if (p > 0) st.lastPrice = p;
    } else if (ev.event === "CompleteEvent") {
      const st = getMint(ev.mint, seq);
      st.completed = true;
    }
  }

  // --- Sells: check every held position against exit rules. ---
  for (const [mint, pos] of held) {
    const mark = markPrice.get(mint);
    const st = mints.get(mint);
    if (mark === undefined || mark <= 0 || pos.cost === 0n) continue;
    const costSol = Number(pos.cost) / LAMPORTS_PER_SOL;
    const valueSol = (Number(pos.tokens) * mark) / LAMPORTS_PER_SOL;
    const pnlBps = Math.floor(((valueSol - costSol) / costSol) * 10000);
    const ageBatches = seq - pos.entrySeq;
    const shouldSell =
      pnlBps >= TAKE_PROFIT_BPS ||
      pnlBps <= STOP_LOSS_BPS ||
      ageBatches >= HOLD_MAX_BATCHES ||
      st?.completed === true;
    if (shouldSell && pos.tokens > 0n) {
      orderCounter += 1;
      orders.push({
        side: "sell",
        client_id: `s-${seq}-${orderCounter}`,
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // --- Buys: first-sight mints only, freshest first (deterministic order). ---
  // Pending (unfilled) buys occupy a slot too.
  const openSlots = MAX_OPEN_POSITIONS - held.size - pendingBuys.size;
  if (openSlots > 0 && firstSight.length > 0) {
    let buys = 0;
    for (const c of firstSight) {
      if (buys >= MAX_BUYS_PER_BATCH || buys >= openSlots) break;
      if (attempted.has(c.mint) || held.has(c.mint) || pendingBuys.has(c.mint)) continue;
      const st = mints.get(c.mint)!;
      if (st.completed) continue;
      // Entry only on the 1st/2nd trade and within +10% of the first print.
      if (st.tradeCount > MAX_ENTRY_TRADES) continue;
      if (st.firstPrice > 0 && c.price > (st.firstPrice * (10000 + MAX_ENTRY_RISE_BPS)) / 10000) continue;
      // Size from the mint's latest known real reserves (the first trade's,
      // or the batch mark's when the mint is already held/pending — marks
      // only ever cover held and pending mints, never fresh ones). The
      // harness caps a buy at 100 bps of the DECISION-time real reserves,
      // so sizing off anything else either never fills (full size against
      // tiny early reserves) or never clears the 0.01 SOL round-trip bar.
      const realSol = markRealSol.get(c.mint) ?? st.lastRealSol;
      let size = BUY_LAMPORTS;
      if (realSol > 0n) {
        const cap = Number(realSol / 100n) * 90 / 100; // 0.9% of real reserves
        if (cap < size) size = Math.floor(cap);
      }
      if (size < MIN_BUY_LAMPORTS) continue;
      if (cashLamports < BigInt(size) + 200_000n) continue;
      attempted.add(c.mint);
      orderCounter += 1;
      orders.push({
        side: "buy",
        client_id: `b-${seq}-${orderCounter}`,
        mint: c.mint,
        quote_lamports: String(size),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      buys += 1;
      cashLamports -= BigInt(size);
      pendingBuys.set(c.mint, seq);
    }
  }

  // Keep the mint map bounded: drop stale mints with no position.
  if (mints.size > 20000) {
    for (const [mint, st] of mints) {
      if (!held.has(mint) && seq - st.firstSeenSeq > 2000) mints.delete(mint);
    }
  }

  return { type: "reply", seq, orders };
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      continue; // no reply to hello; capital/caps/fees arrive here for later use
    }
    if (msg.type === "batch") {
      const reply = handleBatch(msg);
      process.stdout.write(JSON.stringify(reply) + "\n");
      continue;
    }
    if (msg.type === "done") {
      break;
    }
  }
}

main().catch(() => process.exit(1));
