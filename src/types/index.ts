/**
 * flash-x Core Type System
 *
 * Every type flows through the pipeline:
 *   Input → ParsedCommand → TradeIntent → RiskAssessment → TxResult
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export enum Action {
  // Trading
  OpenPosition = 'open_position',
  ClosePosition = 'close_position',
  IncreaseSize = 'increase_size',
  DecreaseSize = 'decrease_size',
  AddCollateral = 'add_collateral',
  RemoveCollateral = 'remove_collateral',
  ReversePosition = 'reverse_position',

  // Orders
  LimitOrder = 'limit_order',
  TakeProfit = 'take_profit',
  StopLoss = 'stop_loss',
  EditOrder = 'edit_order',
  CancelOrder = 'cancel_order',
  CancelAllOrders = 'cancel_all_orders',

  // Swap
  Swap = 'swap',

  // LP / Earn
  AddLiquidity = 'add_liquidity',
  RemoveLiquidity = 'remove_liquidity',
  StakeLp = 'stake_lp',
  UnstakeLp = 'unstake_lp',
  CollectFees = 'collect_fees',

  // FAF
  FafStatus = 'faf_status',
  FafStake = 'faf_stake',
  FafUnstake = 'faf_unstake',
  FafClaim = 'faf_claim',

  // View
  ViewPositions = 'view_positions',
  ViewPosition = 'view_position',
  ViewPortfolio = 'view_portfolio',
  ViewMarkets = 'view_markets',
  ViewMarket = 'view_market',
  ViewPrices = 'view_prices',
  ViewPools = 'view_pools',
  ViewPool = 'view_pool',
  ViewOrders = 'view_orders',
  ViewFunding = 'view_funding',
  ViewOI = 'view_oi',
  ViewFees = 'view_fees',
  ViewHours = 'view_hours',
  ViewBalance = 'view_balance',
  ViewTrades = 'view_trades',
  ViewStats = 'view_stats',
  ViewEarn = 'view_earn',
  ViewPoolDetail = 'view_pool_detail',
  ViewTokens = 'view_tokens',
  ViewToken = 'view_token',
  ViewAllocation = 'view_allocation',
  ViewDashboard = 'view_dashboard',
  ViewWalletTokens = 'view_wallet_tokens',
  ViewPnl = 'view_pnl',
  ViewExposure = 'view_exposure',
  ViewRisk = 'view_risk',

  // FAF advanced
  FafTier = 'faf_tier',
  FafRewards = 'faf_rewards',
  FafReferral = 'faf_referral',
  FafPoints = 'faf_points',
  FafRequests = 'faf_requests',

  // Analytics
  Analyze = 'analyze',
  ViewVolume = 'view_volume',
  ViewLiquidations = 'view_liquidations',
  ViewDepth = 'view_depth',

  // Protocol
  InspectProtocol = 'inspect_protocol',
  InspectPool = 'inspect_pool',
  InspectMarket = 'inspect_market',
  ProtocolStatus = 'protocol_status',

  // Earn advanced
  EarnDashboard = 'earn_dashboard',
  EarnBest = 'earn_best',
  EarnInfo = 'earn_info',
  EarnSimulate = 'earn_simulate',
  EarnDemand = 'earn_demand',
  EarnRotate = 'earn_rotate',
  EarnPnl = 'earn_pnl',
  EarnPositions = 'earn_positions',
  EarnHistory = 'earn_history',
  EarnDeposit = 'earn_deposit',
  EarnWithdraw = 'earn_withdraw',
  EarnStake = 'earn_stake',
  EarnUnstake = 'earn_unstake',
  EarnClaim = 'earn_claim',

  // Utilities
  RpcStatus = 'rpc_status',
  SystemAudit = 'system_audit',
  Doctor = 'doctor',
  Monitor = 'monitor',

  // Wallet
  WalletCreate = 'wallet_create',
  WalletImport = 'wallet_import',
  WalletList = 'wallet_list',
  WalletUse = 'wallet_use',
  WalletBalance = 'wallet_balance',
  WalletDisconnect = 'wallet_disconnect',

  // System
  Health = 'health',
  Help = 'help',
  Config = 'config',

  // Unknown — AI fallback candidate
  Unknown = 'unknown',
}

export enum Side {
  Long = 'LONG',
  Short = 'SHORT',
}

export enum RiskLevel {
  Safe = 'SAFE',
  Warning = 'WARNING',
  Critical = 'CRITICAL',
  Blocked = 'BLOCKED',
}

export enum ParseSource {
  FastDispatch = 'fast_dispatch',
  Regex = 'regex',
  Intent = 'intent',
  AIFallback = 'ai_fallback',
}

export enum LpMode {
  Stake = 'stake',       // sFLP — hourly USDC payouts
  Compound = 'compound', // FLP — auto-compounding
}

// ─── Parsed Command (output of parser) ──────────────────────────────────────

export interface ParsedCommand {
  action: Action;
  source: ParseSource;
  confidence: number;       // 0-1, how confident the parser is
  params: CommandParams;
  raw: string;              // original input
}

export interface CommandParams {
  // Trading
  market?: string;
  side?: Side;
  leverage?: number;
  collateral?: number;
  collateralToken?: string;
  amount?: number;          // USD amount for close/decrease
  percent?: number;         // percentage for partial close

  // Orders
  triggerPrice?: number;
  limitPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  orderId?: number;
  isStopLoss?: boolean;

  // Swap
  inputToken?: string;
  outputToken?: string;
  minOut?: number;

  // LP
  pool?: string;
  token?: string;
  lpMode?: LpMode;

  // View
  symbol?: string;
  owner?: string;
  watch?: boolean;
  detailed?: boolean;

  // Wallet
  name?: string;
  path?: string;

  // Config
  key?: string;
  value?: string;

  // Flags
  degen?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

// ─── Trade Intent (validated, ready for risk check) ─────────────────────────

export interface TradeIntent {
  action: Action;
  market: string;
  side: Side;
  leverage: number;
  collateral: number;
  collateralToken: string;
  sizeUsd: number;          // collateral * leverage
  takeProfit?: number;
  stopLoss?: number;
  degen: boolean;
  pool: string;             // resolved pool name
}

// ─── Risk Assessment ────────────────────────────────────────────────────────

export interface RiskCheck {
  name: string;
  status: RiskLevel;
  message: string;
  value?: number;
  limit?: number;
}

export interface RiskAssessment {
  allowed: boolean;
  mustConfirm: boolean;     // has warnings that need user acknowledgment
  level: RiskLevel;
  checks: RiskCheck[];
  summary: string;
}


// ─── API Quote (from transaction builder) ───────────────────────────────────

export interface ApiQuote {
  transactionBase64: string;
  newEntryPrice: number;
  newLeverage: number;
  newLiquidationPrice: number;
  entryFee: number;
  entryFeeBeforeDiscount: number;
  openPositionFeePercent: number;
  availableLiquidity: number;
  youPayUsdUi: string;
  youReceiveUsdUi: string;
  outputAmount: string;
  outputAmountUi: string;
  err: string | null;
  // TP/SL quotes (if requested)
  takeProfitQuote?: unknown;
  stopLossQuote?: unknown;
}

// ─── Transaction Result ─────────────────────────────────────────────────────

export interface TxResult {
  success: boolean;
  signature?: string;
  error?: string;
  // Enriched post-trade data
  entryPrice?: number;
  liquidationPrice?: number;
  sizeUsd?: number;
  collateralUsd?: number;
  fees?: number;
  pnl?: number;
}

// ─── Position ───────────────────────────────────────────────────────────────

export interface Position {
  pubkey: string;
  market: string;
  side: Side;
  leverage: number;
  sizeUsd: number;
  collateralUsd: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  pnl: number;
  pnlPercent: number;
  fees: number;
  fundingRate: number;
  openTime: number;
  pool: string;
}

// ─── Market ─────────────────────────────────────────────────────────────────

export interface Market {
  symbol: string;
  pool: string;
  price: number;
  change24h: number;
  oiLong: number;
  oiShort: number;
  maxLeverage: number;
  maxDegenLeverage: number;
  fundingRate: number;
  isOpen: boolean;           // market hours
}

// ─── Pool ───────────────────────────────────────────────────────────────────

export interface Pool {
  name: string;
  address: string;
  tvl: number;
  assets: string[];
  markets: number;
  utilization: number;
  lpPrice: number;
  sflpPrice: number;
  flpPrice: number;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface FlashXConfig {
  // Network
  rpcUrl: string;
  rpcBackupUrl?: string;
  network: 'mainnet-beta' | 'devnet';
  flashApiUrl: string;

  // Wallet
  keypairPath?: string;
  simulationMode: boolean;

  // Dev mode — bypasses risk blocks for testing
  devMode: boolean;

  // Risk limits
  maxLeverage: number;
  maxCollateralPerTrade: number;
  maxPositionSize: number;
  maxTotalExposure: number;

  // Trading safety
  maxTradesPerMinute: number;
  minDelayBetweenTradesMs: number;
  defaultSlippageBps: number;

  // Compute
  computeUnitLimit: number;
  computeUnitPrice: number;

  // AI
  groqApiKey?: string;
}

// ─── Engine Interfaces ──────────────────────────────────────────────────────

export interface IExecutionEngine {
  execute(command: ParsedCommand): Promise<TxResult>;
}

export interface IRiskEngine {
  evaluate(intent: TradeIntent): Promise<RiskAssessment>;
}

export interface IStateEngine {
  getPositions(): Promise<Position[]>;
  getPosition(market: string, side?: Side): Promise<Position | null>;
  getMarkets(): Promise<Market[]>;
  getMarket(symbol: string): Promise<Market | null>;
  getPools(): Promise<Pool[]>;
  getPrice(symbol: string): Promise<number>;
  getBalance(token?: string): Promise<number>;
  refresh(): Promise<void>;
}

// ─── Service Interfaces ─────────────────────────────────────────────────────

export interface IApiClient {
  health(): Promise<{ status: string }>;
  getMarkets(): Promise<unknown[]>;
  getPrices(): Promise<Record<string, unknown>>;
  getPrice(symbol: string): Promise<unknown>;
  getPositions(owner: string): Promise<unknown[]>;
  getOrders(owner: string): Promise<unknown[]>;
  getPoolData(poolPubkey?: string): Promise<unknown>;

  // Transaction builders
  buildOpenPosition(params: Record<string, unknown>): Promise<ApiQuote>;
  buildClosePosition(params: Record<string, unknown>): Promise<unknown>;
  buildAddCollateral(params: Record<string, unknown>): Promise<unknown>;
  buildRemoveCollateral(params: Record<string, unknown>): Promise<unknown>;
  buildReversePosition(params: Record<string, unknown>): Promise<unknown>;
}

export interface IRpcManager {
  sendTransaction(txBase64: string): Promise<string>;
  confirmTransaction(signature: string, timeout?: number): Promise<boolean>;
  getSlotHealth(): Promise<{ slot: number; lag: number }>;
}
