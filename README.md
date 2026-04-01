# Flash Terminal Pro

Production-grade CLI for [Flash Trade](https://flash.trade) — a perpetual futures DEX on Solana.

Trade perpetuals, manage orders, analyze risk, and monitor pools — all from the terminal.

```
flash●> long sol 10x 100

  TRADE PREVIEW
  ────────────────────────────────────────────────
  Action:      OPEN POSITION
  Market:      SOL-LONG
  Leverage:    10x
  Collateral:  $100.00 (USDC)
  Size:        $1.00K
  Est. Fee:    $0.51 (0.051%)
  ────────────────────────────────────────────────

  ✓ Trade executed: 4XTAfcjRk8hR...
  Duration: 2264ms
  https://solscan.io/tx/4XTAfcjRk8hR...
  Position SOL LONG: size=$1000, entry=$83.50, liq=$41.83

  Next: positions │ set tp SOL <price> │ risk │ dashboard
```

## Features

**Trading** — Open, close, reverse perpetual positions with leverage up to 100x (500x degen). TP/SL orders. Collateral management. All through Flash Trade's on-chain program.

**Analytics** — PnL reports, exposure breakdown by market/direction, risk assessment with liquidation distance, position analysis.

**Portfolio** — Dashboard with positions + PnL + allocation. Token holdings with USD values. Wallet balance tracking.

**Earn** — View all 9 Flash Trade liquidity pools with TVL, LP price, asset ratios, and utilization. Pool ranking by TVL.

**Safety** — 13-gate hardened transaction pipeline. Instruction whitelist, signer verification, simulation, slippage protection, replay prevention, timeout guards. Every trade audited.

## Architecture

```
User Input → Parser (regex + intent + AI) → Router → ExecutionEngine
                                                          │
                                          ┌───────────────┤
                                          ▼               ▼
                                    Flash API       SDK Service
                                    (primary)       (isolated)
                                          │               │
                                          └───────┬───────┘
                                                  ▼
                                           TxPipeline
                                           (13 gates)
                                                  │
                                                  ▼
                                           Solana RPC
```

**API-first** — Perps, orders, and data use Flash Trade's REST API exclusively.

**SDK isolated** — Flash SDK used only for LP operations that the API doesn't support. Wrapped in a dedicated service module. No SDK types leak into the core system.

**Pipeline** — Every transaction passes through 13 validation gates: replay protection, signature dedup, trade mutex, deserialization, instruction validation, signer verification, account integrity, message freeze, signing, simulation, send, confirm, retry.

## Installation

```bash
git clone https://github.com/yourname/flash-terminal-pro.git
cd flash-terminal-pro
npm install
npm run build
```

## Configuration

Create `.env` in the project root:

```env
RPC_URL=https://api.mainnet-beta.solana.com
KEYPAIR_PATH=~/.config/solana/id.json
```

Or use the interactive wallet setup on first launch.

## Usage

```bash
# Interactive mode (recommended)
node dist/index.js

# Single command mode
node dist/index.js "long sol 10x 100"
node dist/index.js dashboard
node dist/index.js positions
```

### Mode Selection

On startup, choose between:
- **Simulation** — preview trades, no execution (default)
- **Live** — real on-chain trading (requires wallet + CONFIRM)

## Commands

### Trading
```
long SOL 10x $100          Open long position
short ETH 5x $50           Open short position
close SOL                  Close position
close SOL 50%              Partial close
add $50 to SOL             Add collateral
remove $50 from SOL        Remove collateral
reverse SOL                Flip position direction
```

### Orders
```
set tp SOL 200             Set take profit
set sl SOL 170             Set stop loss
cancel SOL long            Cancel trigger orders
```

### Portfolio
```
dashboard                  Full portfolio overview
positions                  Open positions with PnL
portfolio                  Portfolio summary
tokens                     Token holdings + allocation
allocation                 Visual portfolio breakdown
balance                    Wallet balance (SOL + USDC)
```

### Analytics
```
pnl                        PnL report (unrealized + session)
exposure                   Exposure by market + direction
risk                       Risk assessment per position
analyze SOL                Deep market analysis
```

### Earn
```
earn                       All pools (TVL, LP price, stable %)
pool Crypto.1              Pool detail (assets, ratios, utilization)
earn best                  Pools ranked by TVL
```

### Data
```
markets                    33 live markets with prices
market SOL                 Single market detail
orders                     Open trigger orders
trades                     Trade audit history
stats                      Execution metrics
```

### System
```
health                     API + RPC + wallet status
doctor                     System diagnostic
help                       Full command reference
```

### Natural Language
```
"how is my portfolio?"     → dashboard
"what are my positions?"   → positions view
"what's the price of SOL?" → price lookup
```

## Safety Model

| Layer | What It Checks |
|-------|---------------|
| Replay guard | SHA-256 intent hash, 30s dedup window |
| Signature dedup | Prevent double-send (90s TTL) |
| Trade mutex | One trade at a time per market |
| Program whitelist | Only Flash Trade + Solana system programs |
| Signer validation | User must be required signer |
| Account integrity | No program ID spoofing |
| Simulation | Full on-chain simulation before send |
| Timeout protection | 15s sim, 15s send, 45s confirm |
| Blockhash retry | Auto-rebuild on expiry (max 2 cycles) |
| Cross-validation | API quote vs local estimate comparison |
| Post-verification | On-chain state check after confirmation |
| State consistency | Pre vs post balance comparison |
| Audit logging | Every trade recorded to persistent log |

## Tech Stack

- **TypeScript** — strict mode, ESM
- **Solana web3.js** — RPC + transaction handling
- **Flash Trade API** — `https://flashapi.trade`
- **Flash SDK** — isolated, LP operations only
- **Node.js 20+**

## Project Structure

```
src/
├── cli/           Terminal interface, REPL, display, dashboard
├── parser/        3-layer command parser (regex, intent, AI)
├── core/          Execution engine, risk engine, state, metrics
├── services/      API client, SDK service, RPC manager, pool resolver
├── tx/            Transaction pipeline, post-verification, quote guard
├── wallet/        Wallet manager, wallet store
├── security/      Audit logging
├── config/        Configuration loader
├── types/         Type definitions, error codes
└── utils/         Formatting, logging, market aliases
```

## License

MIT
