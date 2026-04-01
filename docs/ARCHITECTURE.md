# Architecture

## Overview

Flash Terminal Pro uses a hybrid API + SDK architecture with a hardened transaction pipeline.

```
Input → Parser → Router → ExecutionEngine → Service Layer → TxPipeline → Solana
```

## Service Layer

### API Service (Primary)

All perps and order operations use the Flash Trade REST API:

| Operation | Endpoint |
|-----------|----------|
| Open position | `POST /transaction-builder/open-position` |
| Close position | `POST /transaction-builder/close-position` |
| Add collateral | `POST /transaction-builder/add-collateral` |
| Remove collateral | `POST /transaction-builder/remove-collateral` |
| Reverse position | `POST /transaction-builder/reverse-position` |
| Place TP/SL | `POST /transaction-builder/place-trigger-order` |
| Cancel order | `POST /transaction-builder/cancel-trigger-order` |
| Positions | `GET /positions/owner/{owner}` |
| Prices | `GET /prices` |
| Pool data | `GET /pool-data` |
| Health | `GET /health` |

The API returns co-signed base64 transactions. The CLI deserializes, validates, signs with the local wallet, and sends via RPC.

### SDK Service (Isolated)

Flash SDK is used **only** for operations the API doesn't support:

- LP deposit / withdraw (requires `setLpTokenPrice` prerequisite)
- FAF staking / unstake / claim

The SDK service is a single file (`src/services/sdk-service.ts`) that imports `flash-sdk`. No other file in the system imports it. All SDK outputs are base64 transactions that pass through the same TxPipeline as API-built transactions.

## Transaction Pipeline (13 Gates)

Every transaction passes through these gates in strict order:

```
 1. Replay protection     — SHA-256 intent hash, 30s dedup window
 2. Signature dedup       — Prevent re-sending confirmed transactions
 3. Trade mutex           — One trade per market at a time
 4. Deserialize           — base64 → VersionedTransaction
 5. Instruction validation — Program whitelist, bounds, CU params
 6. Signer validation     — User wallet must be a required signer
 7. Account integrity     — No program ID spoofing
 8. Message freeze        — Object.freeze() after validation
 9. Sign                  — Local keypair signing
10. Simulate              — On-chain simulation (15s timeout)
11. Send                  — sendRawTransaction (15s timeout)
12. Confirm               — Polling + periodic resend (45s timeout)
13. Blockhash retry       — Rebuild + re-sign on expiry (max 2 cycles)
```

If ANY gate fails, execution halts immediately.

## Parser (3 Layers)

1. **Regex** — Deterministic pattern matching. Handles structured commands like `long sol 10x 100`. Confidence: 1.0.

2. **Intent Mapper** — Keyword extraction for natural language. Maps "how is my portfolio?" to dashboard. Confidence: 0.5-0.9.

3. **AI Fallback** — LLM classification via Groq API. Only called when regex and intent both fail. Confidence: 0.6. Always requires user confirmation.

## Risk Engine

Evaluates every trade intent before execution:

- Leverage limits (per-pool from protocol)
- Position sizing (min $10, configurable max)
- Portfolio exposure limits
- Liquidation proximity (blocks if <1%)
- Market hours verification
- Balance sufficiency (with SOL→USD price conversion)
- Duplicate position detection

DEV_MODE bypasses balance checks only. All structural checks always enforced.

## State Engine

Centralized cached state with TTL expiry:

- Positions: 10s TTL
- Prices: 5s TTL
- Markets: 30s TTL
- Pools: 60s TTL
- Balances: 15s TTL

Data sources: Flash API for positions/prices/markets, RPC for balances.

## Audit System

Every trade attempt is recorded to `~/.flash-x/audit.log` as JSON lines:

```json
{
  "timestamp": "2026-04-01T15:30:16.123Z",
  "action": "open_position",
  "market": "SOL",
  "side": "LONG",
  "leverage": 2,
  "collateral": 10,
  "txHash": "4XTAfcjRk8hR...",
  "status": "confirmed",
  "durationMs": 2264
}
```

File rotates at 10MB. Queryable via `trades` command.
