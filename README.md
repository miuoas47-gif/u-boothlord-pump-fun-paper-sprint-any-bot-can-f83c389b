# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/miuoas47-gif/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/miuoas47-gif/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic paper-trading bot for pump.fun, built for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It speaks the `agent-fun/replay/v2` protocol (newline-delimited JSON on stdin/stdout) and trades a 6-hour replay of real pump.fun bonding-curve data with paper money only — no real funds, no network, no randomness.

## Strategy

Most pump.fun coins bleed slowly (median first-to-last return −8%) while a few run hard (mean +33%, max +1369% on the dev window). Chasing a move that already happened loses; buying at a coin's 5th trade is a negative-expectation entry, buying at its 1st trade is positive. So the bot:

- Buys a mint on its **first trade**, small, only while its price is still within +10% of that first print. Never chases.
- Sizes each buy at 0.15 SOL, capped at 0.9% of the mint's latest known real SOL reserves (the harness caps a buy at 100 bps of decision-time real reserves), never below 0.02 SOL, so every fill clears the 0.01 SOL round-trip bar.
- Holds at most 5 open positions, at most 2 buys per batch.
- Sells in full at +50% take-profit, −20% stop-loss, after 600 batches held, or when the mint's bonding curve completes.

Local dev grade of this entry: net PnL −0.23 SOL over 116 round trips across 116 coins, max drawdown 5.2%, guardrails met — the best active strategy measured on the dev window (the kit's own sniper pilot scored −0.42 SOL, momentum −9.45 SOL, reversion −4.37 SOL).

## Run it

```sh
node main.ts
```

The bot reads `hello` / `batch` / `done` messages on stdin and writes one `{"type":"reply","seq","orders":[...]}` per batch on stdout. It needs Node 22 (type stripping) and nothing else — no dependencies, no arguments, no environment.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6gvkzysc&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
