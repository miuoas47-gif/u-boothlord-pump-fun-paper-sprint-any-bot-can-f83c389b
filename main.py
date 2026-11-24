"""Pump.fun paper-trading bot for make.fun's "Pump.fun Paper Sprint" bounty.

Strategy: confirmed early-momentum scalper with tight exits.

  * Watch every new coin from its CreateEvent and remember its creation
    price (virtual quote reserves / virtual token reserves).
  * Buy once, when the coin first trades at least 20% above its creation
    price with at least 3 trades behind it, and not more than 60% above
    it (do not chase a top) -- but only after the move is confirmed: the
    price must still be at or above the trigger on the next batch that
    touches the coin, so a one-trade wick that instantly reverses is
    never bought. Size is 0.05 SOL, capped at 1% of the real quote
    reserves, at most 5 open positions.
  * Exit fast: take profit at +40% over the filled entry price, stop loss
    at -10%, a trailing stop once the coin is +40% (sell on a 25%
    pullback from the peak), or a timeout after 600 slots (~2 minutes)
    with no exit triggered. Dead coins are not held to zero.

Most pump.fun coins spike early and then decay to near their creation
price, so the edge is in catching a confirmed early spike and leaving
quickly, not in holding. Every comparison is exact integer arithmetic
on the reserve ratios, so the bot is fully deterministic: no clock, no
environment reads, no randomness. It only ever trades on the batches
the harness sends it.

Runs as ``python3 -P -s main.py`` (the grader's command) or plain
``python3 main.py``; reads agent-fun/replay/v2 on stdin, writes one
reply per batch on stdout, diagnostics on stderr.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bot  # noqa: E402  (after the sys.path line: -P leaves the script directory off sys.path)

LAMPORTS_PER_SOL = makefun_bot.LAMPORTS_PER_SOL

# --- strategy constants (lamports unless noted) ---------------------------
STAKE_LAMPORTS = LAMPORTS_PER_SOL // 20          # 0.05 SOL per coin
MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL // 100       # 0.01 SOL: the guardrail round-trip minimum
MAX_SLIPPAGE_BPS = 10_000                        # slippage left wide open, like the baseline

BUY_TRIGGER_NUM, BUY_TRIGGER_DEN = 6, 5          # buy at >= 1.20x creation price
BUY_CEILING_NUM, BUY_CEILING_DEN = 8, 5          # ... and <= 1.60x (do not chase)
MIN_TRADES = 3                                   # need a little tape before trusting the move

TAKE_PROFIT_NUM, TAKE_PROFIT_DEN = 7, 5          # sell at >= 1.40x entry price
STOP_LOSS_NUM, STOP_LOSS_DEN = 9, 10              # sell at <= 0.90x entry price
TRAIL_ARM_NUM, TRAIL_ARM_DEN = 7, 5              # arm the trailing stop at >= 1.40x entry
TRAIL_NUM, TRAIL_DEN = 3, 4                      # ... then sell at <= 0.75x the peak
MAX_HOLD_SLOTS = 600                             # give up after ~2 minutes with no exit

# --- per-coin memory -------------------------------------------------------
# mint -> [create_q, create_t, create_slot, decided, confirming]
COINS = {}
# mint -> [entry_q, entry_t, entry_slot, peak_q, peak_t, armed]
HELD = {}


def _at_least(q, t, q0, t0, num, den):
    """True when price q/t is at least num/den times price q0/t0 (exact ints)."""
    return q * t0 * den >= q0 * t * num


def _at_most(q, t, q0, t0, num, den):
    """True when price q/t is at most num/den times price q0/t0 (exact ints)."""
    return q * t0 * den <= q0 * t * num


def _price(curve):
    """Current (virtual quote, virtual token) reserves of a curve."""
    return curve.virtual_quote_reserves, curve.virtual_token_reserves


def _process_fills(state, batch):
    """Fold this batch's fills into HELD / COINS.

    A filled buy records its true execution price (quote paid per token
    received) as the entry; a rejected or failed buy un-decides the coin
    so it can be tried again while it is still in its buy window.
    """
    for f in batch["fills"]:
        cid = f["client_id"]
        if cid.startswith("_"):
            continue  # the harness's own closes (_complete_ / _flatten_ / _writeoff_)
        mint = f["mint"]
        if f["side"] == "buy":
            if f["status"] == "filled":
                quote = int(f["quote_lamports"])
                tokens = int(f["token_amount"])
                if tokens > 0:
                    HELD[mint] = [quote, tokens, int(f["slot"]), quote, tokens, False]
            else:
                coin = COINS.get(mint)
                if coin is not None:
                    coin[3] = False
        elif f["side"] == "sell" and f["status"] == "filled":
            HELD.pop(mint, None)
    # Positions the harness closed on its own (curve completed, window end)
    # are gone from the account; drop their exit bookkeeping too.
    for mint in list(HELD):
        if mint not in state.positions:
            HELD.pop(mint, None)


def _decide_sells(state, batch, orders):
    """Sell every holding whose exit rule fired, unless a sell is pending."""
    caps = state.hello["caps"]
    slot = state.slot
    pending_sells = set()
    for p in state.pending.values():
        if p.order["side"] == "sell":
            pending_sells.add(p.order["mint"])
    for mint, holding in list(state.positions.items()):
        if mint in pending_sells:
            continue
        curve = state.curves.get(mint)
        if curve is None or curve.complete:
            continue  # a complete curve is closed by the harness itself
        entry = HELD.get(mint)
        q, t = _price(curve)
        if entry is None:
            # Defensive: a position with no fill seen yet; anchor the exit
            # rules at the current price rather than selling blind.
            HELD[mint] = [q, t, slot, q, t, False]
            continue
        entry_q, entry_t, entry_slot, peak_q, peak_t, armed = entry
        if _at_least(q, t, peak_q, peak_t, 1, 1):
            entry[3], entry[4] = q, t
            peak_q, peak_t = q, t
        if _at_least(q, t, entry_q, entry_t, TRAIL_ARM_NUM, TRAIL_ARM_DEN):
            entry[5] = True
            armed = True
        sell = False
        if _at_least(q, t, entry_q, entry_t, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN):
            sell = True  # take profit: +40% over the filled entry price
        elif armed and _at_most(q, t, peak_q, peak_t, TRAIL_NUM, TRAIL_DEN):
            sell = True  # trailing stop: 25% pullback from the peak
        elif _at_most(q, t, entry_q, entry_t, STOP_LOSS_NUM, STOP_LOSS_DEN):
            sell = True  # stop loss: -10% under the filled entry price
        elif slot - entry_slot >= MAX_HOLD_SLOTS:
            sell = True  # timeout: the coin is going nowhere, free the slot
        if sell and len(orders) < caps["max_orders_per_batch"]:
            orders.append(
                {
                    "side": "sell",
                    "mint": mint,
                    "token_amount": holding.token_amount,
                    "max_slippage_bps": MAX_SLIPPAGE_BPS,
                }
            )


def _decide_buys(state, batch, orders):
    """Buy each touched candidate whose momentum just confirmed.

    A coin first arms confirmation when it crosses the buy trigger; the
    buy itself happens on the next batch that touches the coin while the
    price is still at or above the trigger, so a one-trade wick is never
    bought. A coin that runs past the ceiling, or whose price falls back
    below the trigger before confirming, is left alone (the latter stays
    undecided and may trigger again later).
    """
    caps = state.hello["caps"]
    tx = state.tx_fee_lamports()
    free = state.free_cash_lamports()
    slots = caps["max_open_positions"] - state.committed_position_count()
    seen = set()
    for source in (batch["events"], batch["marks"]):
        for item in source:
            mint = item["mint"]
            if mint in seen:
                continue
            seen.add(mint)
            coin = COINS.get(mint)
            if coin is None or coin[3]:
                continue  # unknown, or already decided (bought / skipped)
            curve = state.curves.get(mint)
            if curve is None or curve.complete:
                coin[3] = True  # completed before we could buy: done with it
                continue
            if curve.trades < MIN_TRADES:
                continue
            create_q, create_t = coin[0], coin[1]
            q, t = _price(curve)
            if not _at_least(q, t, create_q, create_t, BUY_TRIGGER_NUM, BUY_TRIGGER_DEN):
                coin[4] = False  # fell back below the trigger: cancel confirmation
                continue  # no early momentum yet
            if not _at_most(q, t, create_q, create_t, BUY_CEILING_NUM, BUY_CEILING_DEN):
                coin[3] = True  # already ran past the ceiling: do not chase
                continue
            if not coin[4]:
                coin[4] = True  # trigger crossed: arm confirmation, buy next touch
                continue
            cap = state.max_buy_lamports(mint)
            if cap < MIN_BUY_LAMPORTS:
                continue  # too small to count as a round trip; wait for depth
            amount = min(cap, STAKE_LAMPORTS)
            if len(orders) >= caps["max_orders_per_batch"] or slots <= 0:
                continue  # no room this batch; the coin stays undecided
            if free < amount + tx:
                continue  # not enough cash left; the coin stays undecided
            orders.append(
                {
                    "side": "buy",
                    "mint": mint,
                    "quote_lamports": amount,
                    "max_slippage_bps": MAX_SLIPPAGE_BPS,
                }
            )
            coin[3] = True
            free -= amount + tx
            slots -= 1


def on_batch(state, batch):
    # Register every coin created in this batch, with its creation price.
    for e in batch["events"]:
        if e["event"] == "CreateEvent" and e["mint"] not in COINS:
            COINS[e["mint"]] = [
                int(e["virtual_quote_reserves"]),
                int(e["virtual_token_reserves"]),
                int(e["slot"]),
                False,
                False,
            ]
    _process_fills(state, batch)
    orders = []
    _decide_sells(state, batch, orders)
    _decide_buys(state, batch, orders)
    return orders


def on_done(state, done):
    cash = state.cash
    print(
        f"done: batches={state.seq} cash={cash} "
        f"positions={len(state.positions)} coins_seen={len(COINS)}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    makefun_bot.run(on_batch, on_done=on_done)
