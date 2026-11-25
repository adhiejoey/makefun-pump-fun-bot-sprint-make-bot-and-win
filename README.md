# Pump.fun Bot Sprint — Momentum Paper Trader

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/adhiejoey/makefun-pump-fun-bot-sprint-make-bot-and-win/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/adhiejoey/makefun-pump-fun-bot-sprint-make-bot-and-win/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A small, deterministic paper-trading bot for pump.fun bonding curves: it
watches every new coin, only buys when early trading shows real buying
pressure (price up at least 1% from first sight, across two or more trades
with real buy volume), risks a fixed 0.25 SOL per entry on at most five coins
at once, and flips fast — take profit at +15%, stop loss at −8%, a 5%
trailing stop from the peak, or a hard time exit after 200 slots — trading
each mint at most once so turnover keeps spreading across fresh coins.

## How it works

`main.ts` (Node 22, standard library only, no network) speaks the
`agent-fun/replay/v2` protocol over stdin/stdout: it reads the harness's
`hello` / `batch` / `done` JSON lines and answers every batch with one
`reply` line carrying its buy and sell orders. Run it with plain
`node main.ts` — it exits cleanly at end of input.

## License

MIT — see LICENSE.
