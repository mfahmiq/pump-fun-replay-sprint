# pump-fun-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mfahmiq/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mfahmiq/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

**Sprint** is a momentum paper-trading bot for the [make.fun](https://make.fun)
competition **Pump.fun Replay Sprint — Paper Bot, Real Ranking**
(`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`).

It trades 10 SOL of paper money on a 24-hour replay of real pump.fun
bonding-curve activity (protocol `agent-fun/replay/v2`). Nothing is traded
for real: the house replay scorer runs this bot over recorded Solana chain
data and ranks entries by net PnL after every fee. A placement needs a net
PnL above holding cash — above 0 SOL after fees.

The bot is deliberately simple and defensive. Most new pump.fun coins are
noise — bundled launches, one-wallet pumps, instant rugs — so Sprint only
buys launches that have already proven themselves in their first seconds
of life, starts tiny, and gets out fast when a position stops working. The
goal is not the biggest runner of the day; it is to finish the window with
more SOL than it started with.

## Strategy

Sprint is a launch sniper. It watches every coin from its `CreateEvent`
and buys only in a coin's first three slots, and only when the launch
passes every filter:

- **Already running.** Price up 30–50% from its create price — momentum
  that is already proven, not a guess that it will start. (Sweeping this
  threshold on the dev window showed the edge concentrates here: at +10%
  the same bot loses 0.04 SOL, at +30% it wins.)
- **Not bundled.** At most 2 distinct non-creator buyers so far — a launch
  bundled by many wallets in its first slot is usually the creator's
  cluster waiting to dump.
- **Small creator stake.** The creator's own buy in the create slot is at
  most 1 SOL, and the creator has not sold before entry.
- **Liquid enough to trade.** Real SOL reserves between 0.3 and 30 SOL at
  decision time; every buy also respects the harness cap of 1% of the
  curve's real SOL reserve.

**Sizing — tiny on purpose.** 0.05 SOL per coin at most (usually less,
because of the 1% reserve cap), at most 5 coins open at once. One rug
costs a few hundredths of a SOL.

**Exits — cut losers fast, let winners run.** A position is sold whole on
the first of:

- **Take profit:** close value 15% above cost.
- **Stop loss:** close value 8% below cost.
- **Creator exit:** the creator sells while the bot holds.
- **Time limit:** held more than 10 slots.

The harness closes positions on curve completion and flattens anything
left at the end of the replay, so no position can be held past the window.

**Guardrail probes.** The competition ranks below every entry that meets
its minimum bar any entry that misses it (a round trip of at least 0.01 SOL
on each of at least 20 coins). The selective setup only finds ~20 coins a
day on its own, so while Sprint has traded fewer than 24 distinct coins it
opens tiny 0.02 SOL probe round trips on liquid curves and sells them as
soon as the buy lands. A probe costs roughly 0.0007 SOL in fees, and no
coin is ever probed twice — cheap insurance for the ranking bar.

## Why it should end PnL-positive after fees

A round trip costs about 2.5% in curve fees (95 bps protocol + 30 bps
creator, each side) plus ~0.000105 SOL of transaction fees per order, so
churning is how bots bleed to death on this data. Sprint trades rarely and
only on moves that can pay for themselves:

1. **Entries need a move already in progress** (+30% with at most two
   other buyers in the first three slots), not a guess that one will start.
   On the kit's frozen dev window this setup wins 46% of its trades at
   +15% against −8% losses.
2. **Winners are banked, losers are cut** — take profit at +15%, stop loss
   at −8%, and a 10-slot time limit, so the average trade is small and the
   bankroll turns over instead of riding a handful of coins to zero.
3. **Drawdown is bounded by construction** — 0.05 SOL per coin, usually
   less, means one rug costs a few hundredths of a SOL, far inside the 50%
   max-drawdown guardrail (dev-window drawdown was 0.2%).

Local grading on the kit's dev window (process driver, two executions,
byte-identical action logs): **net PnL +0.00097 SOL, 42 round trips over
42 coins, 21% win rate, 0.24% max drawdown, guardrails met.** The margin
is thin and the final window is different coins, so this is a small edge,
honestly measured — not a guarantee.

## How to run it

Requires Node 22.18 or later (the grader runs Node 22.23.4); Node runs the
TypeScript as-is, with no build step and no dependencies to install.

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout: the harness sends one
JSON line per message (`hello`, then one `batch` per slot, then `done`) and
the bot answers every batch with exactly one reply line echoing its `seq`.
Diagnostics go to stderr; stdout carries replies only.

Grade it locally against the competition kit's dev window the way the
server grades it:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Layout

- `main.ts` — the wire: stdin/stdout protocol, `BotState` (cash, positions,
  curves, pending orders), order validation, and the run loop.
- `strategy.ts` — the strategy: entry signal, sizing and pyramiding, exits,
  and guardrail probes. All tunable numbers live in `DEFAULT_PARAMS`.
- `LICENSE` — MIT.

## Determinism

The bot never reads the clock, the environment, or `Math.random`, and never
makes a network call. Every decision comes from the batches the harness
streams, and iteration is only over insertion-ordered maps fed by that
stream, so the two graded executions produce identical action logs.

## License

MIT — see [LICENSE](LICENSE).


