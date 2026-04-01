# Command Reference

## Trading

| Command | Description | Example |
|---------|-------------|---------|
| `long <market> <lev>x <collateral>` | Open long position | `long sol 10x 100` |
| `short <market> <lev>x <collateral>` | Open short position | `short eth 5x 50` |
| `close <market>` | Close full position | `close sol` |
| `close <market> <pct>%` | Partial close | `close sol 50%` |
| `add $<amt> to <market>` | Add collateral | `add $50 to sol` |
| `remove $<amt> from <market>` | Remove collateral | `remove $50 from sol` |
| `reverse <market>` | Flip position direction | `reverse sol` |

Flexible word order supported: `open 2x sol long 10` also works.

## Orders

| Command | Description |
|---------|-------------|
| `set tp <market> <price>` | Set take profit |
| `set sl <market> <price>` | Set stop loss |
| `cancel <market> <side>` | Cancel trigger orders |

## Portfolio

| Command | Description |
|---------|-------------|
| `dashboard` / `dash` | Full portfolio overview |
| `positions` / `pos` | Open positions table |
| `portfolio` / `pf` | Portfolio value summary |
| `tokens` | Token holdings + allocation % |
| `wallet tokens` | Full token balance scan |
| `token <symbol>` | Token detail + position + wallet |
| `allocation` / `alloc` | Visual portfolio breakdown |
| `balance` / `bal` | SOL + USDC balance |

## Analytics

| Command | Description |
|---------|-------------|
| `pnl` | PnL report (unrealized + session history) |
| `exposure` | Exposure by market and direction |
| `risk` | Risk assessment with liquidation distances |
| `analyze <market>` | Deep market analysis + position risk |

## Earn

| Command | Description |
|---------|-------------|
| `earn` | All 9 pools with TVL, LP price, stable % |
| `pool <name>` | Pool detail: assets, ratios, utilization |
| `earn best` | Pools ranked by TVL |

## FAF Token

| Command | Description |
|---------|-------------|
| `faf` | FAF staking dashboard |
| `faf stake <amount>` | Stake FAF tokens |
| `faf unstake <amount>` | Request unstake |
| `faf claim` | Claim rewards |
| `faf tier` | VIP tier info |
| `faf rewards` | Pending rewards |

## Data

| Command | Description |
|---------|-------------|
| `markets` | 33 live markets with prices |
| `market <symbol>` | Single market detail |
| `orders` | Open trigger orders |
| `trades` / `history` | Trade audit history |
| `stats` | Execution metrics |

## Protocol

| Command | Description |
|---------|-------------|
| `inspect protocol` | Protocol overview |
| `inspect pool <name>` | Pool inspection |
| `inspect market <symbol>` | Market inspection |
| `doctor` | System diagnostic |

## System

| Command | Description |
|---------|-------------|
| `health` | API + RPC + wallet status |
| `rpc` | RPC endpoint status |
| `config` | Settings display |
| `help` | Full command reference |

## Natural Language

The parser understands conversational queries:

| Input | Maps To |
|-------|---------|
| "how is my portfolio doing?" | `dashboard` |
| "what are my positions?" | `positions` |
| "what's the price of SOL?" | `price SOL` |
| "where can I earn?" | `earn` |
| "is the system healthy?" | `health` |

## Flags

| Flag | Description |
|------|-------------|
| `--tp <price>` | Set take profit with open |
| `--sl <price>` | Set stop loss with open |
| `--degen` | Enable degen mode (up to 500x) |
