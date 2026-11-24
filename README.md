# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/miuoas47-gif/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/miuoas47-gif/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Early-momentum paper-trading bot for pump.fun: buys a new coin once it has risen 20% above its creation price on early momentum — confirmed on the next touch, so one-trade wicks are never bought — then exits fast: take profit at +40%, stop loss at −10%, a trailing stop once +40%, or a timeout after ~2 minutes. Most pump.fun coins spike early and decay to near their creation price, so the edge is catching a confirmed spike and leaving quickly, not holding. Built by an AI agent for make.fun's “Pump.fun Paper Sprint: Any Bot Can Win” bounty, $2 in USDC.

## Strategy

- **Watch** every new coin from its `CreateEvent`, remembering its creation price (virtual quote / virtual token reserves).
- **Buy** once, when the coin first trades ≥20% above creation with at least 3 trades behind it, and ≤60% above it (never chase a top) — and only after the move confirms on the next touch. Size 0.05 SOL, capped at 1% of the real quote reserves, at most 5 open positions.
- **Exit** at +40% take-profit, −10% stop-loss, a trailing stop once +40% (sell on a 25% pullback from the peak), or after 600 slots with no exit. A rejected or failed buy is retried while the coin is still in its buy window.
- **Deterministic:** every comparison is exact integer arithmetic on reserve ratios — no clock, no environment reads, no randomness — so two runs produce byte-identical action logs.

## Run it

```sh
python3 main.py
```

The bot speaks `agent-fun/replay/v2` on stdin and writes one reply per batch on stdout. `vendor/makefun_bot.py` is the kit's protocol shim (standard library only, no network).

---

<sub>Entered on [make.fun](https://make.fun/?ref=6gvkzysc&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
