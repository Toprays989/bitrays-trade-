"use client";

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Workspace hydration and server refresh effects are intentionally keyed to explicit page/session transitions. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  alignOrderQuantityUp,
  canonicalizeOrderQuantity,
  effectiveMarketMinimumOrderQuantity,
  effectiveMinimumOrderQuantity,
  isOrderQuantityLessThanOrEqual,
  normalizeReduceQuantity,
  quantityStepTolerance,
} from "../lib/order-quantity";
import { buildRiskGrid } from "../lib/risk-grid";
import { buildManualOrderRiskAdvisory } from "../lib/manual-order-risk-advisory";
import { SIMPLE_REBOUND_CONFIG } from "../lib/simple-rebound-config";
import {
  hasCompleteNetProfitPath,
  strategyPayoffProfile,
} from "../lib/strategy-payoff";
import {
  AUTOMATED_STRATEGY_MAX_LEVERAGE,
  ENTRY_ORDER_TTL_MAX_SECONDS,
  ENTRY_ORDER_TTL_MIN_SECONDS,
  LIQUIDATION_LIMIT_ORDER_TTL_DEFAULT_MS,
  LIQUIDATION_LIMIT_ORDER_TTL_MAX_MS,
  LIQUIDATION_LIMIT_ORDER_TTL_MIN_MS,
} from "../lib/liquidation-trend-config";
import {
  STRATEGY_TRIGGER_CATALOG,
  isNewStrategyTriggerKind,
  strategyTriggerCatalogEntry,
  type StrategyTriggerKind,
} from "../lib/strategy-trigger-catalog";
import { STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION } from "../lib/strategy-default-parameters";
import {
  STRATEGY_PLUGIN_CATALOG,
  type StrategyPluginId,
} from "../lib/strategy-plugins/registry";
import {
  evaluateStrategyEntryFundingCoherence,
  strategyEntryFundingCoherenceView,
} from "../lib/strategy-entry-funding-coherence";
import {
  addStrategyScopeSymbol,
  removeStrategyScopeSymbol,
  searchStrategyScopeSymbols,
} from "../lib/strategy-symbol-scope";
import {
  strategyAssetClassScopeLabel,
  type StrategyAssetClassScope,
} from "../lib/strategy-asset-scope";
import {
  broadcastApplicationLogout,
  clientRequestErrorMessage,
  clearStoredWorkspace,
  createClientRequestId,
  fetchWithTransientRetry,
  readJsonResponse,
} from "./client/runtime";
import { formatCompactDecimal } from "./client/display-number";
import {
  submittedOrderIsVisible,
  upsertSubmittedPosition,
} from "./client/submitted-order-sync";
import {
  APPLYABLE_STRATEGY_SUGGESTION_PATHS,
  MANUAL_DEFAULT_LEVERAGE,
  applyStrategySuggestionValue,
  liquidationConfigShape,
  liquidationDirection,
  liquidationExecutionUi,
  liquidationFactorUi,
  liquidationLargeTraderUi,
  liquidationMarketPositionUi,
  gridPriceLevelTriggerUi,
  scheduledScanTriggerUi,
  breakoutRetestTriggerUi,
  lowPositionTriggerUi,
  threeMinuteProbabilityTriggerUi,
  nexusProbabilityPolicyUi,
  liquidationRiskUi,
  liquidationShortTrendUi,
  strategyDirectionDecisionUi,
  strategyPluginId,
  strategyTriggerKind,
  liquidationTrendUi,
  liquidationTriggerUi,
  withLiquidationDirection,
  withLiquidationExecution,
  withLiquidationFactor,
  withLiquidationLargeTrader,
  withLiquidationMarketPosition,
  withGridPriceLevelTrigger,
  withScheduledScanTrigger,
  withBreakoutRetestTrigger,
  withLowPositionTrigger,
  withThreeMinuteProbabilityTrigger,
  withNexusProbabilityPolicy,
  withLiquidationPositionManagement,
  withLiquidationRisk,
  withLiquidationShortTrend,
  withStrategyDirectionDecision,
  withStrategyPlugin,
  withLiquidationTakeProfitStep,
  withLiquidationTrend,
  withLiquidationTrigger,
  withStrategyTriggerKind,
  type LiquidationTrendUi,
  type StrategyDirection,
} from "./client/strategy-config";
import {
  STRATEGY_SESSION_LOG_LIMIT,
  defaultLiquidationStrategyConfig,
  formatPercentRatio,
  formatSignedPercent,
  formatStrategySuggestionValue,
  globalLiquidationTrendLabel,
  liquidationFactorLearningPhaseLabel,
  nexusBrainLifecycleBlockerLabel,
  strategyBreakdownObservation,
  strategyExecutionBranch,
  strategyExecutionDirectionLabel,
  strategyExecutionTriggerLabel,
  strategyExecutionEventDetailSummary,
  strategyExecutionModelProgress,
  strategyExecutionStageLabel,
  strategyExecutionStateLabel,
  strategyEditorConfig,
  strategyMarketRegime,
  strategyPositionEvidenceStatusLabel,
  strategySymbolScopeSummary,
  strategyTypeLabel,
  strategyWaveStructure,
  type ConfiguredStrategy,
  type StoredStrategyParameterSuggestion,
  type StrategyConfigVersion,
  type StrategyExecutionDetail,
  type StrategyExecutionEvent,
  type StrategyExecutionTrace,
  type StrategyLearningProgress,
  type StrategyMonitorStatus,
  type StrategyPositionEvidence,
  type StrategyPostEntryAnalysis,
} from "./client/strategy-view";
import {
  credentialVerifiedRecently,
  liveRiskPlanSummary,
  type ExchangeCredential,
  type GlobalSearchResult,
  type LiveOrderEvent,
  type LivePosition,
  type LivePositionReduction,
  type NotificationItem,
  type OverviewData,
  type TradingAccount,
} from "./client/workspace-model";
import { NumberStepper } from "./components/number-stepper";
import { SecurityGate } from "./components/security-gate";
import {
  ContractPoolView,
  type ContractCatalogItem,
  type ContractPoolItem,
} from "./components/contract-pool-view";
import { OrdersView } from "./components/orders-view";
import { PositionsView } from "./components/positions-view";
import { AccountDirectoryRow } from "./components/account-directory-row";
import {
  CredentialActionDialog,
  CredentialEditorDialog,
} from "./components/exchange-credential-dialogs";
import {
  AccountDeleteDialog,
  AccountDisableDialog,
  AccountPauseDialog,
} from "./components/account-action-dialogs";
import { AddTradingAccountDialog } from "./components/add-trading-account-dialog";
import { AccountRiskPanel } from "./components/account-risk-panel";
import { StrategyBusinessLogView } from "./components/strategy-business-log-view";
import {
  ManualMarketHistoryChart,
  type ManualMarketHistoryPoint,
} from "./components/manual-market-history-chart";
import { MarketHistoryView } from "./components/market-history-view";
import { ProfitView } from "./components/profit-view";
import { QuoteShadowView } from "./components/quote-shadow-view";
import { SemiAutoOpportunityView } from "./components/semi-auto-opportunity-view";
import { MovingProtectionReviewCard } from "./components/moving-protection-review-card";
import { DailyOperationsView } from "./components/daily-operations-view";
import { ManualOrderBoard } from "./components/manual-order-board";

type Market = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  high: number;
  low: number;
  volume: string | number;
  min: string;
};

type ManualContractMarket = Market & {
  protected: boolean;
  enabled: boolean;
  source: "BINANCE_LIVE";
  minOrderQty: number;
  effectiveMinOrderQty: number | null;
  effectiveMarketMinOrderQty: number | null;
  quantityStep: number;
  minNotionalUsdt: number;
  priceTickSize: number;
  maxLeverage: number | null;
  updatedAt: string;
};

function isUrgentToast(message: string) {
  return /失败|错误|阻断|无权|不可|未找到|断开|熔断|失效|请先|请检查|failed|error|rejected|restricted|could not|not available/i.test(
    message,
  );
}

type AccessMember = {
  id: number;
  email: string;
  displayName?: string | null;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  dataScope: "ALL" | "OWN";
  isActive: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  lockedUntil?: string | number | null;
  lastLoginAt?: string | number | null;
  updatedAt: string | number;
};
type AuditEvent = {
  id: number;
  ownerEmail: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: unknown;
  createdAt: string | number;
};
const alignQuantityUp = alignOrderQuantityUp;

// 生产环境禁止使用示例价格。合约池只能由实时行情接口填充；
// 行情不可达时保持为空并阻止新增订单。
const initialMarkets: Market[] = [];

const menuGroups = [
  {
    label: "交易运营",
    items: [
      ["overview", "⌁", "运营总览"],
      ["market", "⌇", "行情中心"],
      ["manual", "↗", "人工下单"],
      ["semiAuto", "◉", "半自动下单"],
      ["position", "◫", "仓位管理"],
      ["orders", "≡", "订单状态"],
      ["profit", "↗", "收益列表"],
      ["dailyOperations", "▦", "每日运营数据报表"],
    ],
  },
  {
    label: "策略与配置",
    items: [
      ["pool", "◈", "合约池管理"],
      ["auto", "⌘", "策略自动下单"],
      ["strategyLogs", "≋", "策略运行日志"],
      ["quoteShadow", "≈", "报价对比"],
    ],
  },
  {
    label: "账户与审计",
    items: [
      ["accounts", "♙", "子账号管理"],
      ["system", "⚙", "安全与操作审计"],
    ],
  },
];

const hiddenPageLabels: Record<string, string> = {};

const allPageIds = () => [
  ...menuGroups.flatMap((group) => group.items.map(([id]) => id)),
  ...Object.keys(hiddenPageLabels),
];

const pagePermissions: Record<string, string> = {
  overview: "trade:dashboard:view",
  market: "trade:dashboard:view",
  manual: "trade:manual:create",
  semiAuto: "trade:manual:create",
  pool: "trade:symbol_pool:view",
  auto: "trade:strategy:edit",
  position: "trade:dashboard:view",
  orders: "trade:dashboard:view",
  profit: "trade:dashboard:view",
  dailyOperations: "trade:dashboard:view",
  quoteShadow: "trade:dashboard:view",
  accounts: "sys:account:view",
  system: "sys:access:view",
  strategyLogs: "trade:dashboard:view",
};

function WorkspacePage({
  active,
  setActive,
  setToast,
  marketRefreshVersion,
  workspaceRefreshVersion,
  strategyFocusId,
  strategyFocusMode,
  marketFocus,
  strategyLogTabOpen,
}: {
  active: string;
  setActive: (page: string) => void;
  setToast: (text: string) => void;
  marketRefreshVersion: number;
  workspaceRefreshVersion: number;
  strategyFocusId?: number | null;
  strategyFocusMode?: "EDIT" | "LEARNING";
  marketFocus?: { symbol: string; requestId: number } | null;
  strategyLogTabOpen: boolean;
}) {
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [orderType, setOrderType] = useState<"市价单" | "限价单">("市价单");
  const [orderAccountId, setOrderAccountId] = useState("");
  const [symbol, setSymbol] = useState("");
  const symbolRef = useRef(symbol);
  const orderTypeRef = useRef(orderType);
  const [manualSymbolSuggestionsOpen, setManualSymbolSuggestionsOpen] =
    useState(false);
  const [orderPrice, setOrderPrice] = useState(0);
  const [orderQuantity, setOrderQuantity] = useState(0);
  const [leverage, setLeverage] = useState(MANUAL_DEFAULT_LEVERAGE);
  const [manualAccountLeverageCaps, setManualAccountLeverageCaps] = useState<
    Record<string, number>
  >({});
  const [manualLimitTtlMinutes, setManualLimitTtlMinutes] = useState(3);
  const [takeProfitGrid, setTakeProfitGrid] = useState({
    startPercent: 2,
    endPercent: 8,
    requestedGrids: 3,
  });
  const [stopLossGrid, setStopLossGrid] = useState({
    startPercent: 2,
    endPercent: 5,
    requestedGrids: 2,
  });
  const [trailingEnabled, setTrailingEnabled] = useState(true);
  const [trailingActivationPercent, setTrailingActivationPercent] = useState(2);
  const [manualTrailingStopPercent, setManualTrailingStopPercent] = useState(1);
  const [pool, setPool] = useState<ContractPoolItem[]>(() =>
    initialMarkets.map((m) => ({
      ...m,
      enabled: true,
      minOrderQty: Number(m.min),
      effectiveMinOrderQty: Number(m.min),
      effectiveMarketMinOrderQty: Number(m.min),
      quantityStep: Number(m.min),
      minNotionalUsdt: 5,
      priceTickSize: 0.00000001,
      maxLeverage: null as number | null,
      updatedAt: new Date().toISOString(),
    })),
  );
  const [poolQuery, setPoolQuery] = useState("");
  const [poolStatus, setPoolStatus] = useState("ALL");
  const [poolSort, setPoolSort] = useState<
    "SYMBOL" | "VOLUME_DESC" | "CHANGE_DESC" | "CHANGE_ASC"
  >("VOLUME_DESC");
  const [poolBusy, setPoolBusy] = useState("");
  const [marketStatus, setMarketStatus] = useState<{
    reachable: boolean;
    error: string | null;
    updatedAt: string;
    thresholdUsdt: number;
  } | null>(null);
  const [manualContractMarket, setManualContractMarket] =
    useState<ManualContractMarket | null>(null);
  const [manualContractError, setManualContractError] = useState<string | null>(
    null,
  );
  const [manualContractLoading, setManualContractLoading] = useState(false);
  const [manualMarketHistory, setManualMarketHistory] = useState<{
    symbol: string;
    points: ManualMarketHistoryPoint[];
    loading: boolean;
    error: string | null;
    updatedAt: string | null;
  }>({
    symbol: "",
    points: [],
    loading: false,
    error: null,
    updatedAt: null,
  });
  const symbolPoolRequestRef = useRef(0);
  const positionRequestRef = useRef(0);
  const positionCoreRequestRef = useRef(0);
  const liveOrderRequestRef = useRef(0);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [manualOrderConfirmation, setManualOrderConfirmation] = useState<{
    credentialId: number;
    accountId: string;
    symbol: string;
    positionSide: "LONG" | "SHORT";
    orderType: "MARKET" | "LIMIT";
    orderTypeLabel: "市价单" | "限价单";
    price?: number;
    referencePrice: number;
    quantity: number;
    leverage: number;
    takeProfitPlan: Array<{
      triggerPercent: number;
      closePercent: number;
      closeQuantity: number;
    }>;
    stopLossPlan: Array<{
      triggerPercent: number;
      closePercent: number;
      closeQuantity: number;
    }>;
    capitalPreservationStopRoePercent: number;
    trailingActivationPercent: number;
    trailingStopPercent: number;
    cancelAfterMinutes?: number;
    confirmation: string;
    idempotencyKey: string;
    riskAdvisory: ReturnType<typeof buildManualOrderRiskAdvisory>;
  } | null>(null);
  const [showAddSymbol, setShowAddSymbol] = useState(false);
  const [contractCatalog, setContractCatalog] = useState<ContractCatalogItem[]>([]);
  const [orderQuery, setOrderQuery] = useState("");
  const [orderStatus, setOrderStatus] = useState("ALL");
  const [orderDateRange, setOrderDateRange] = useState("1");
  const [portfolioAccountFilter, setPortfolioAccountFilter] = useState("ALL");
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [livePositions, setLivePositions] = useState<LivePosition[]>([]);
  const [livePositionReductions, setLivePositionReductions] = useState<
    LivePositionReduction[]
  >([]);
  const [liveOrders, setLiveOrders] = useState<LiveOrderEvent[]>([]);
  const [liveCancelOrderTarget, setLiveCancelOrderTarget] =
    useState<LiveOrderEvent | null>(null);
  const [liveCancelBusy, setLiveCancelBusy] = useState(false);
  const [liveRiskEditTarget, setLiveRiskEditTarget] =
    useState<LivePosition | null>(null);
  const [liveCloseTarget, setLiveCloseTarget] = useState<{
    position: LivePosition;
    orderType: "MARKET" | "LIMIT";
  } | null>(null);
  const [liveCloseQuantity, setLiveCloseQuantity] = useState(0);
  const [liveClosePrice, setLiveClosePrice] = useState(0);
  const [liveCloseSubmitting, setLiveCloseSubmitting] = useState(false);
  const [liveAddTarget, setLiveAddTarget] = useState<{
    position: LivePosition;
    orderType: "MARKET" | "LIMIT";
  } | null>(null);
  const [liveAddQuantity, setLiveAddQuantity] = useState(0);
  const [liveAddPrice, setLiveAddPrice] = useState(0);
  const [liveAddSubmitting, setLiveAddSubmitting] = useState(false);
  const [liveRiskEditForm, setLiveRiskEditForm] = useState({
    takeStart: 2,
    takeEnd: 8,
    takeGrids: 3,
    stopStart: 2,
    stopEnd: 5,
    stopGrids: 2,
    minimumObservationMinutes: 60,
    liquidationGuardBufferPercent: 5,
    trailingActivation: 2,
    trailingCallback: 1,
  });
  const [positionsBusy, setPositionsBusy] = useState(false);
  const [positionsLoaded, setPositionsLoaded] = useState(false);
  const [tradingAccounts, setTradingAccounts] = useState<TradingAccount[]>([]);
  const [tradingAccountBusy, setTradingAccountBusy] = useState("");
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [addAccountError, setAddAccountError] = useState("");
  const [deleteAccountTarget, setDeleteAccountTarget] =
    useState<TradingAccount | null>(null);
  const [deleteAccountConfirmation, setDeleteAccountConfirmation] =
    useState("");
  const [disableAccountTarget, setDisableAccountTarget] =
    useState<TradingAccount | null>(null);
  const [pauseAccountTarget, setPauseAccountTarget] =
    useState<TradingAccount | null>(null);
  const [tradingAccountForm, setTradingAccountForm] = useState({
    accountId: "",
    name: "",
    accountType: "STRATEGY" as "MAIN" | "STRATEGY",
    operatorName: "管理员",
    note: "",
    apiKey: "",
    secretKey: "",
  });
  const [exchangeCredentials, setExchangeCredentials] = useState<
    ExchangeCredential[]
  >([]);
  const [serverLiveTradingAllowed, setServerLiveTradingAllowed] =
    useState(false);
  const [serverLiveControlBusy, setServerLiveControlBusy] = useState(false);
  const [serverLiveControlAction, setServerLiveControlAction] = useState<
    "ENABLE" | "DISABLE" | null
  >(null);
  const [serverLiveControlConfirmation, setServerLiveControlConfirmation] =
    useState("");
  const [credentialModalOpen, setCredentialModalOpen] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState("");
  const [credentialForm, setCredentialForm] = useState({
    accountId: "bys-main",
    label: "Binance 账户密钥",
    apiKey: "",
    secretKey: "",
  });
  const [credentialAction, setCredentialAction] = useState<{
    credential: ExchangeCredential;
    action: "ENABLE" | "DISABLE" | "DELETE" | "HEDGE" | "ONE_WAY";
  } | null>(null);
  const [credentialConfirmation, setCredentialConfirmation] = useState("");
  const [accessProfile, setAccessProfile] = useState<{
    email: string;
    role: string;
    dataScope: string;
    permissions: string[];
  } | null>(null);
  const [accessMembers, setAccessMembers] = useState<AccessMember[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditQuery, setAuditQuery] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("ALL");
  const [auditOwnerFilter, setAuditOwnerFilter] = useState("ALL");
  const [auditCursor, setAuditCursor] = useState<number | null>(null);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditDetailTarget, setAuditDetailTarget] = useState<AuditEvent | null>(
    null,
  );
  const [savingAccess, setSavingAccess] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmChangedPassword, setConfirmChangedPassword] = useState("");
  const [showSecurityPasswords, setShowSecurityPasswords] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [accountForm, setAccountForm] = useState({
    email: "",
    displayName: "",
    role: "VIEWER" as AccessMember["role"],
    dataScope: "OWN" as AccessMember["dataScope"],
    temporaryPassword: "",
    confirmTemporaryPassword: "",
  });
  const [showAccountPasswords, setShowAccountPasswords] = useState(false);
  const [resetTarget, setResetTarget] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [confirmResetPassword, setConfirmResetPassword] = useState("");
  const [showResetPasswords, setShowResetPasswords] = useState(false);
  const [preflight, setPreflight] = useState<{
    ready: boolean;
    checkedAt: string;
    checks: Array<{
      key: string;
      label: string;
      passed: boolean;
      detail: string;
    }>;
  } | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const strategyLifecyclePolling = useRef(false);
  const strategyLifecycleEpochRef = useRef(0);
  const strategyLogOpenedAtRef = useRef(0);
  const strategyLogSinceRef = useRef(0);
  const strategyLogPollingRef = useRef(false);
  const strategyLearningAnalysisPollingRef = useRef(false);
  const strategyLearningAnalysisPendingRef = useRef(false);
  const strategyLearningTerminalRefreshRef = useRef(new Set<string>());
  const [showStrategyConfig, setShowStrategyConfig] = useState(false);
  const [strategyConfigStep, setStrategyConfigStep] = useState(1);
  const [strategyTypeDraft, setStrategyTypeDraft] = useState<
    "LIQ_CHASE" | "SIMPLE_REBOUND"
  >("LIQ_CHASE");
  const showStrategyConfigRef = useRef(false);
  const creatingStrategyRef = useRef(false);
  const configuredStrategyRef = useRef<ConfiguredStrategy | null>(null);
  const [strategyScopeQuery, setStrategyScopeQuery] = useState("");
  const [strategyScopeFocused, setStrategyScopeFocused] = useState(false);
  const [strategyConfig, setStrategyConfig] = useState(() =>
    defaultLiquidationStrategyConfig("bys-main", "", "BOTH"),
  );
  const [acceptedStrategySuggestionIds, setAcceptedStrategySuggestionIds] =
    useState<number[]>([]);
  const [configuredStrategy, setConfiguredStrategy] =
    useState<ConfiguredStrategy | null>(null);
  const strategyConfigRef = useRef(strategyConfig);
  const [configuredStrategies, setConfiguredStrategies] = useState<
    ConfiguredStrategy[]
  >([]);
  const visibleConfiguredStrategies = useMemo(
    () =>
      configuredStrategies.filter(
        (strategy) =>
          portfolioAccountFilter === "ALL" ||
          strategy.accountId === portfolioAccountFilter,
      ),
    [configuredStrategies, portfolioAccountFilter],
  );
  const strategyFundingById = useMemo(() => {
    const credentialsByAccount = new Map(
      exchangeCredentials.map((credential) => [credential.accountId, credential]),
    );
    return new Map(
      visibleConfiguredStrategies.flatMap((strategy) => {
        const execution = liquidationExecutionUi(strategy.config);
        if (!execution) return [];
        const result = evaluateStrategyEntryFundingCoherence({
          availableBalanceUsdt:
            credentialsByAccount.get(strategy.accountId)?.availableBalance,
          leverage: execution.leverage,
          equityAllocationPercent: execution.equityAllocationPercent ?? 5,
          quantitySizingMode: execution.quantitySizingMode ?? "FIXED",
          fixedMultiplier: execution.minimumOrderQuantityMultiplier ?? 1,
          minimumPositionNotionalUsdt:
            execution.minimumPositionNotionalUsdt ?? 15,
          maxOrderMarginUsdt: execution.maxOrderMarginUsdt ?? 6,
        });
        return [[strategy.id, {
          result,
          view: strategyEntryFundingCoherenceView(result),
        }] as const];
      }),
    );
  }, [visibleConfiguredStrategies, exchangeCredentials]);
  const executableRunningStrategyCount = visibleConfiguredStrategies.filter(
    (strategy) =>
      strategy.status === "RUNNING" &&
      strategyFundingById.get(strategy.id)?.view.executable === true,
  ).length;
  const fundingWaitingStrategyCount = visibleConfiguredStrategies.filter(
    (strategy) =>
      strategy.status === "RUNNING" &&
      strategyFundingById.get(strategy.id)?.view.executable === false,
  ).length;
  const tradingAccountNames = useMemo(
    () =>
      Object.fromEntries(
        tradingAccounts.map((account) => [account.accountId, account.name]),
      ),
    [tradingAccounts],
  );
  const [deleteStrategyTarget, setDeleteStrategyTarget] =
    useState<ConfiguredStrategy | null>(null);
  const [deleteStrategyBusy, setDeleteStrategyBusy] = useState(false);
  const [strategyVersions, setStrategyVersions] = useState<
    StrategyConfigVersion[]
  >([]);
  const [rollbackVersionTarget, setRollbackVersionTarget] =
    useState<StrategyConfigVersion | null>(null);
  const [versionMetadataTarget, setVersionMetadataTarget] =
    useState<StrategyConfigVersion | null>(null);
  const [versionMetadataForm, setVersionMetadataForm] = useState({
    versionLabel: "",
    note: "",
    isBaseline: false,
  });
  const [compareBaseVersion, setCompareBaseVersion] = useState(0);
  const [compareTargetVersion, setCompareTargetVersion] = useState(0);
  const [creatingStrategy, setCreatingStrategy] = useState(false);
  const [strategyExecutionTarget, setStrategyExecutionTarget] =
    useState<ConfiguredStrategy | null>(null);
  const [strategyExecutions, setStrategyExecutions] = useState<
    StrategyExecutionTrace[]
  >([]);
  const [strategyLearningProgress, setStrategyLearningProgress] =
    useState<StrategyLearningProgress | null>(null);
  const [strategyMonitorStatus, setStrategyMonitorStatus] =
    useState<StrategyMonitorStatus | null>(null);
  const [strategyExecutionDetail, setStrategyExecutionDetail] =
    useState<StrategyExecutionDetail | null>(null);
  const [strategyExecutionPanelOpen, setStrategyExecutionPanelOpen] =
    useState(false);
  const [strategyExecutionViewMode, setStrategyExecutionViewMode] = useState<
    "LOGS" | "LEARNING"
  >("LOGS");
  const [strategyExecutionsBusy, setStrategyExecutionsBusy] = useState(false);
  const [strategyLogRealtime, setStrategyLogRealtime] = useState<{
    status: "IDLE" | "CONNECTING" | "LIVE" | "DELAYED";
    lastSyncAt: number | null;
  }>({ status: "IDLE", lastSyncAt: null });
  const [strategyExecutionDetailBusy, setStrategyExecutionDetailBusy] =
    useState(false);
  function clearStrategyLogSession() {
    setStrategyExecutionPanelOpen(false);
    setStrategyExecutionTarget(null);
    setStrategyExecutions([]);
    setStrategyExecutionDetail(null);
    setStrategyLearningProgress(null);
    setStrategyMonitorStatus(null);
    strategyLogOpenedAtRef.current = 0;
    strategyLogSinceRef.current = 0;
    strategyLogPollingRef.current = false;
    strategyLearningAnalysisPollingRef.current = false;
    strategyLearningAnalysisPendingRef.current = false;
    strategyLearningTerminalRefreshRef.current.clear();
    setStrategyLogRealtime({
      status: "IDLE",
      lastSyncAt: null,
    });
  }
  const can = (permission: string) =>
    Boolean(accessProfile?.permissions.includes(permission));
  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);
  useEffect(() => {
    orderTypeRef.current = orderType;
  }, [orderType]);
  const filteredPool = useMemo(
    () => {
      const toNumber = (value: string | number | null | undefined) =>
        typeof value === "number"
          ? value
          : Number(String(value ?? "0").replace(/,/g, "")) || 0;
      return pool
        .filter((item) => {
        const matchesQuery =
          !poolQuery ||
          item.symbol.includes(poolQuery.trim().toUpperCase()) ||
          item.name.toLowerCase().includes(poolQuery.trim().toLowerCase());
        const matchesStatus =
          poolStatus === "ALL" ||
          (poolStatus === "ACTIVE" ? item.enabled : !item.enabled);
        return matchesQuery && matchesStatus;
        })
        .sort((left, right) => {
          if (poolSort === "VOLUME_DESC")
            return toNumber(right.volume) - toNumber(left.volume);
          if (poolSort === "CHANGE_DESC") return right.change - left.change;
          if (poolSort === "CHANGE_ASC") return left.change - right.change;
          return left.symbol.localeCompare(right.symbol);
        });
    },
    [pool, poolQuery, poolStatus, poolSort],
  );
  const selectedMarket = useMemo(
    () =>
      (manualContractMarket?.symbol === symbol
        ? manualContractMarket
        : null) ??
      pool.find((item) => item.symbol === symbol) ??
      null,
    [pool, symbol, manualContractMarket],
  );
  const selectedPoolContract = useMemo(
    () => pool.find((item) => item.symbol === symbol && item.enabled) ?? null,
    [pool, symbol],
  );
  const manualSymbolSuggestions = useMemo(() => {
    const query = symbol.trim().toUpperCase();
    return pool
      .filter(
        (item) =>
          item.enabled &&
          (!query ||
            item.symbol.includes(query) ||
            item.name.toUpperCase().includes(query)),
      )
      .slice(0, 12);
  }, [pool, symbol]);
  const strategySymbolSuggestions = useMemo(() => {
    return searchStrategyScopeSymbols(
      pool,
      strategyScopeQuery,
      strategyConfig.selectedSymbols,
      12,
    );
  }, [pool, strategyScopeQuery, strategyConfig.selectedSymbols]);
  const generatedTakeProfitGrid = useMemo(
    () =>
      buildRiskGrid(
        takeProfitGrid,
        orderQuantity,
        selectedMarket?.minOrderQty ?? 0.00000001,
        selectedMarket?.quantityStep ??
          selectedMarket?.minOrderQty ??
          0.00000001,
        selectedMarket
          ? {
              referencePrice:
                orderType === "限价单" && orderPrice > 0
                  ? orderPrice
                  : selectedMarket.price,
              minNotionalUsdt: selectedMarket.minNotionalUsdt,
            }
          : undefined,
      ),
    [takeProfitGrid, orderQuantity, selectedMarket, orderType, orderPrice],
  );
  const generatedStopLossGrid = useMemo(
    () =>
      buildRiskGrid(
        stopLossGrid,
        orderQuantity,
        selectedMarket?.minOrderQty ?? 0.00000001,
        selectedMarket?.quantityStep ??
          selectedMarket?.minOrderQty ??
          0.00000001,
        selectedMarket
          ? {
              referencePrice:
                orderType === "限价单" && orderPrice > 0
                  ? orderPrice
                  : selectedMarket.price,
              minNotionalUsdt: selectedMarket.minNotionalUsdt,
            }
          : undefined,
      ),
    [stopLossGrid, orderQuantity, selectedMarket, orderType, orderPrice],
  );
  const takeProfitPlan = generatedTakeProfitGrid.levels;
  const stopLossPlan = generatedStopLossGrid.levels;
  const orderQuantityStep =
    selectedMarket?.quantityStep ?? selectedMarket?.minOrderQty ?? 0.00000001;
  const orderReferencePrice =
    orderType === "限价单" && orderPrice > 0
      ? orderPrice
      : selectedMarket?.price ?? 0;
  const orderQuantityMinimum = selectedMarket
    ? orderType === "市价单"
      ? effectiveMarketMinimumOrderQuantity(
          selectedMarket.minOrderQty,
          orderQuantityStep,
          selectedMarket.minNotionalUsdt,
          orderReferencePrice,
        )
      : effectiveMinimumOrderQuantity(
          selectedMarket.minOrderQty,
          orderQuantityStep,
          selectedMarket.minNotionalUsdt,
          orderReferencePrice,
        )
    : 0.00000001;
  const orderQuantitySteps = orderQuantity / orderQuantityStep;
  const orderQuantityValid =
    Number.isFinite(orderQuantity) &&
    orderQuantity >= orderQuantityMinimum &&
    Math.abs(orderQuantitySteps - Math.round(orderQuantitySteps)) <= 1e-8;
  const manualLeverageCapKey = `${orderAccountId}:${selectedMarket?.symbol ?? symbol.trim().toUpperCase()}`;
  const learnedManualLeverageCap =
    manualAccountLeverageCaps[manualLeverageCapKey] ?? null;
  const manualLeverageMaximum = Math.min(
    selectedMarket?.maxLeverage ?? Number.POSITIVE_INFINITY,
    learnedManualLeverageCap ?? Number.POSITIVE_INFINITY,
  );
  useEffect(() => {
    if (!selectedMarket || orderReferencePrice <= 0) return;
    if (orderQuantity < orderQuantityMinimum || !orderQuantityValid)
      setOrderQuantity(orderQuantityMinimum);
  }, [selectedMarket?.symbol, orderReferencePrice, orderQuantityMinimum]);

  useEffect(() => {
    setLeverage((current) =>
      Math.min(Math.max(1, current), manualLeverageMaximum)
    );
  }, [manualLeverageMaximum]);
  const orderPriceValid =
    orderType === "市价单" ||
    (Number.isFinite(orderPrice) &&
      orderPrice > 0 &&
      (
        !selectedMarket ||
        (
          Boolean(selectedMarket.price) &&
          Boolean(selectedMarket.priceTickSize) &&
          Math.abs(
            orderPrice / selectedMarket.priceTickSize -
              Math.round(orderPrice / selectedMarket.priceTickSize),
          ) <= 1e-8 &&
          Math.abs(orderPrice - selectedMarket.price) /
              selectedMarket.price <=
            0.2
        )
      ));
  const riskRangesValid =
    takeProfitGrid.startPercent > 0 &&
    takeProfitGrid.endPercent >= takeProfitGrid.startPercent &&
    stopLossGrid.startPercent > 0 &&
    stopLossGrid.endPercent >= stopLossGrid.startPercent;
  const liveRiskMarket = liveRiskEditTarget
    ? pool.find((item) => item.symbol === liveRiskEditTarget.symbol)
    : null;
  const liveRiskQuantityMinimum =
    liveRiskEditTarget?.executionRule?.minOrderQty ??
    liveRiskMarket?.minOrderQty ??
    0.00000001;
  const liveRiskQuantityStep =
    liveRiskEditTarget?.executionRule?.quantityStep ??
    liveRiskMarket?.quantityStep ??
    liveRiskQuantityMinimum;
  const liveCloseMarket = liveCloseTarget
    ? pool.find((item) => item.symbol === liveCloseTarget.position.symbol)
    : null;
  const liveCloseQuantityMinimum = liveCloseTarget
    ? Math.min(
        liveCloseTarget.position.quantity,
        liveCloseTarget.position.executionRule?.minOrderQty ??
          liveCloseMarket?.minOrderQty ??
          0.00000001,
      )
    : 0.00000001;
  const liveCloseQuantityStep =
    liveCloseTarget?.position.executionRule?.quantityStep ??
    liveCloseMarket?.quantityStep ??
    0.00000001;
  const liveCloseNormalizedQuantity = liveCloseTarget
    ? normalizeReduceQuantity({
        requestedQuantity: liveCloseQuantity,
        positionQuantity: liveCloseTarget.position.quantity,
        minimum: liveCloseQuantityMinimum,
        step: liveCloseQuantityStep,
      })
    : Number.NaN;
  const liveCloseQuantityAdjusted =
    Number.isFinite(liveCloseNormalizedQuantity) &&
    Math.abs(liveCloseNormalizedQuantity - liveCloseQuantity) >
      quantityStepTolerance(liveCloseQuantityStep);
  const liveCloseRemainingQuantity = liveCloseTarget &&
      Number.isFinite(liveCloseNormalizedQuantity)
    ? Number(
        (
          canonicalizeOrderQuantity(
            liveCloseTarget.position.quantity,
            liveCloseQuantityStep,
          ) - liveCloseNormalizedQuantity
        ).toPrecision(15),
      )
    : 0;
  const liveCloseLeavesDust =
    liveCloseRemainingQuantity > 1e-12 &&
    liveCloseRemainingQuantity < liveCloseQuantityMinimum - 1e-12;
  const liveCloseAll = Boolean(
    liveCloseTarget &&
      Number.isFinite(liveCloseNormalizedQuantity) &&
      Math.abs(liveCloseRemainingQuantity) <=
        quantityStepTolerance(liveCloseQuantityStep),
  );
  const liveCloseQuantityValid = Boolean(
    liveCloseTarget &&
      Number.isFinite(liveCloseQuantity) &&
      Number.isFinite(liveCloseNormalizedQuantity) &&
      liveCloseNormalizedQuantity >= liveCloseQuantityMinimum &&
      isOrderQuantityLessThanOrEqual(
        liveCloseNormalizedQuantity,
        liveCloseTarget.position.quantity,
        liveCloseQuantityStep,
      ) &&
      !liveCloseLeavesDust,
  );
  const liveAddMarket = liveAddTarget
    ? pool.find((item) => item.symbol === liveAddTarget.position.symbol)
    : null;
  const liveAddReferencePrice =
    liveAddTarget?.orderType === "LIMIT" && liveAddPrice > 0
      ? liveAddPrice
      : liveAddTarget?.position.markPrice || liveAddTarget?.position.entryPrice || 0;
  const liveAddQuantityStep =
    liveAddTarget?.position.executionRule?.quantityStep ??
    liveAddMarket?.quantityStep ??
    liveAddTarget?.position.executionRule?.minOrderQty ??
    liveAddMarket?.minOrderQty ??
    0.00000001;
  const liveAddRuleMinimum =
    liveAddTarget?.position.executionRule?.minOrderQty ??
    liveAddMarket?.minOrderQty ??
    0.00000001;
  const liveAddMinNotionalUsdt =
    liveAddTarget?.position.executionRule?.minNotionalUsdt ??
    liveAddMarket?.minNotionalUsdt ??
    0;
  const liveAddExactQuantityMinimum =
    liveAddReferencePrice > 0
      ? effectiveMinimumOrderQuantity(
          liveAddRuleMinimum,
          liveAddQuantityStep,
          liveAddMinNotionalUsdt,
          liveAddReferencePrice,
        )
      : liveAddRuleMinimum;
  const liveAddQuantityMinimum =
    liveAddTarget?.orderType === "MARKET" && liveAddReferencePrice > 0
      ? effectiveMarketMinimumOrderQuantity(
          liveAddRuleMinimum,
          liveAddQuantityStep,
          liveAddMinNotionalUsdt,
          liveAddReferencePrice,
        )
      : liveAddExactQuantityMinimum;
  const liveAddQuantityValid = Boolean(
    liveAddTarget &&
      Number.isFinite(liveAddQuantity) &&
      liveAddQuantity >= liveAddQuantityMinimum &&
      Math.abs(
        liveAddQuantity / liveAddQuantityStep -
          Math.round(liveAddQuantity / liveAddQuantityStep),
      ) <= 1e-8,
  );
  const liveTakeProfitPlan = liveRiskEditTarget
    ? buildRiskGrid(
        {
          startPercent: liveRiskEditForm.takeStart,
          endPercent: liveRiskEditForm.takeEnd,
          requestedGrids: liveRiskEditForm.takeGrids,
        },
        liveRiskEditTarget.quantity,
        liveRiskQuantityMinimum,
        liveRiskQuantityStep,
        {
          referencePrice: liveRiskEditTarget.markPrice,
          minNotionalUsdt:
            liveRiskEditTarget.executionRule?.minNotionalUsdt ?? 0,
        },
      ).levels
    : [];
  const liveStopLossPlan = liveRiskEditTarget
    ? buildRiskGrid(
        {
          startPercent: liveRiskEditForm.stopStart,
          endPercent: liveRiskEditForm.stopEnd,
          requestedGrids: liveRiskEditForm.stopGrids,
        },
        liveRiskEditTarget.quantity,
        liveRiskQuantityMinimum,
        liveRiskQuantityStep,
        {
          referencePrice: liveRiskEditTarget.markPrice,
          minNotionalUsdt:
            liveRiskEditTarget.executionRule?.minNotionalUsdt ?? 0,
        },
      ).levels
    : [];
  const selectedTradingAccount = useMemo(
    () =>
      tradingAccounts.find((item) => item.accountId === orderAccountId) ?? null,
    [tradingAccounts, orderAccountId],
  );
  const selectedExchangeCredential = useMemo(
    () =>
      exchangeCredentials.find((item) => item.accountId === orderAccountId) ??
      null,
    [exchangeCredentials, orderAccountId],
  );
  const strategyTradingAccount = useMemo(
    () =>
      tradingAccounts.find(
        (item) => item.accountId === strategyConfig.accountId,
      ) ?? null,
    [tradingAccounts, strategyConfig.accountId],
  );
  const strategyExchangeCredential = useMemo(
    () =>
      exchangeCredentials.find(
        (item) => item.accountId === strategyConfig.accountId,
      ) ?? null,
    [exchangeCredentials, strategyConfig.accountId],
  );
  const strategyEntryFundingCoherence = useMemo(() => {
    const execution = liquidationExecutionUi(strategyConfig);
    if (!execution) return null;
    return evaluateStrategyEntryFundingCoherence({
      availableBalanceUsdt: strategyExchangeCredential?.availableBalance,
      leverage: execution.leverage,
      equityAllocationPercent: execution.equityAllocationPercent ?? 5,
      quantitySizingMode: execution.quantitySizingMode ?? "FIXED",
      fixedMultiplier: execution.minimumOrderQuantityMultiplier ?? 1,
      minimumPositionNotionalUsdt:
        execution.minimumPositionNotionalUsdt ?? 15,
      maxOrderMarginUsdt: execution.maxOrderMarginUsdt ?? 6,
    });
  }, [strategyConfig, strategyExchangeCredential]);
  const strategyFundingConfigurationReady =
    strategyEntryFundingCoherence?.status !== "CONFIG_IMPOSSIBLE";
  const strategyPayoff = useMemo(() => {
    const risk = liquidationRiskUi(strategyConfig);
    const execution = liquidationExecutionUi(strategyConfig);
    return risk
      ? strategyPayoffProfile({
          stopLossRoePercent: risk.stopLossPercent ?? 0,
          takeProfitSteps: risk.takeProfitSteps ?? [],
          leverage: execution?.leverage ?? strategyConfig.leverage,
        })
      : null;
  }, [strategyConfig]);
  const strategyNetProfitPathReady =
    !liquidationConfigShape(strategyConfig) ||
    strategyTriggerKind(strategyConfig) === "THREE_MINUTE_PROBABILITY" ||
    hasCompleteNetProfitPath(strategyPayoff);

  useEffect(() => {
    showStrategyConfigRef.current = showStrategyConfig;
  }, [showStrategyConfig]);

  useEffect(() => {
    creatingStrategyRef.current = creatingStrategy;
  }, [creatingStrategy]);

  useEffect(() => {
    configuredStrategyRef.current = configuredStrategy;
  }, [configuredStrategy]);

  useEffect(() => {
    strategyConfigRef.current = strategyConfig;
  }, [strategyConfig]);

  function openStrategyConfigDialog() {
    showStrategyConfigRef.current = true;
    setStrategyConfigStep(1);
    setShowStrategyConfig(true);
  }

  function closeStrategyConfigDialog() {
    showStrategyConfigRef.current = false;
    setShowStrategyConfig(false);
  }

  useEffect(() => {
    if (!marketFocus) return;
    selectManualSymbol(marketFocus.symbol);
  }, [marketFocus?.requestId]);

  useEffect(() => {
    // Data refreshes are intentionally triggered by the selected workspace page.
    if (active === "orders") void loadLiveOrders(true);
    if (active === "position") {
      void (async () => {
        const coreLoaded = await loadPositions(true, false);
        if (coreLoaded) await loadPositions(true, true);
      })();
    }
    if (active === "profit") void loadPositions();
    if (["auto", "semiAuto", "strategyLogs"].includes(active) && accessProfile) {
      void loadStrategyLifecycle(true);
      void loadSymbolPool(true);
    }
    if (["pool", "market", "manual"].includes(active) && accessProfile)
      void loadSymbolPool(true);
    if (["accounts", "manual", "semiAuto", "auto"].includes(active) && accessProfile) {
      void loadTradingAccounts(true);
      void loadExchangeCredentials(true);
    }
    if (
      ["position", "profit", "orders"].includes(active) &&
      accessProfile
    ) {
      void loadTradingAccounts(true);
      void loadExchangeCredentials(true);
    }
  }, [active, accessProfile]);

  useEffect(() => {
    if (workspaceRefreshVersion === 0 || !accessProfile) return;
    if (active === "orders") void loadLiveOrders();
    if (["position", "profit"].includes(active)) void loadPositions();
    if (["auto", "semiAuto", "strategyLogs"].includes(active)) {
      void loadStrategyLifecycle();
      void loadSymbolPool(true);
    }
    if (["pool", "market", "manual"].includes(active)) void loadSymbolPool();
    if (["accounts", "manual", "semiAuto", "auto"].includes(active)) {
      void loadTradingAccounts();
      void loadExchangeCredentials(true);
    }
  }, [workspaceRefreshVersion]);

  useEffect(() => {
    if (active !== "profit" || !accessProfile) return;
    const timer = window.setInterval(
      () => void loadExchangeCredentials(true),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, [active, accessProfile]);

  useEffect(() => {
    if (!["pool", "market", "manual"].includes(active) || !accessProfile) return;
    const timer = window.setInterval(() => void loadSymbolPool(true), 30_000);
    return () => window.clearInterval(timer);
  }, [active, accessProfile]);

  useEffect(() => {
    const normalized = symbol.trim().toUpperCase();
    if (
      active !== "manualLegacy" ||
      !accessProfile ||
      !/^[A-Z0-9]{2,30}USDT$/.test(normalized)
    ) {
      setManualContractMarket(null);
      setManualContractError(null);
      setManualContractLoading(false);
      return;
    }
    let disposed = false;
    let running = false;
    const refresh = async () => {
      if (running || disposed) return;
      running = true;
      setManualContractLoading(true);
      try {
        const response = await fetch(
          `/api/control/live-contract?symbol=${encodeURIComponent(normalized)}`,
          { cache: "no-store" },
        );
        const result = (await readJsonResponse(response)) as {
          error?: string;
          updatedAt?: string;
          contract?: {
            symbol: string;
            displayName: string;
            minOrderQty: number;
            quantityStep: number;
            minNotionalUsdt: number;
            priceTickSize: number;
            maxLeverage: number | null;
            price: number;
            change: number;
            high: number;
            low: number;
            quoteVolume: number;
          };
        };
        if (!response.ok || !result.contract)
          throw new Error(
            result.error ?? `${normalized} Binance 实时合约数据不可用`,
          );
        if (disposed || symbolRef.current.trim().toUpperCase() !== normalized)
          return;
        const contract = result.contract;
        const market: ManualContractMarket = {
          symbol: contract.symbol,
          name: contract.displayName,
          price: contract.price,
          change: contract.change,
          high: contract.high,
          low: contract.low,
          volume: contract.quoteVolume,
          min: String(contract.minOrderQty),
          protected: false,
          enabled: true,
          source: "BINANCE_LIVE",
          minOrderQty: contract.minOrderQty,
          effectiveMinOrderQty: effectiveMinimumOrderQuantity(
            contract.minOrderQty,
            contract.quantityStep,
            contract.minNotionalUsdt,
            contract.price,
          ),
          effectiveMarketMinOrderQty: effectiveMarketMinimumOrderQuantity(
            contract.minOrderQty,
            contract.quantityStep,
            contract.minNotionalUsdt,
            contract.price,
          ),
          quantityStep: contract.quantityStep,
          minNotionalUsdt: contract.minNotionalUsdt,
          priceTickSize: contract.priceTickSize,
          maxLeverage: contract.maxLeverage,
          updatedAt: result.updatedAt ?? new Date().toISOString(),
        };
        setManualContractMarket(market);
        setManualContractError(null);
        if (orderTypeRef.current === "市价单")
          setOrderPrice(contract.price);
      } catch (error) {
        if (disposed) return;
        setManualContractError(
          error instanceof Error
            ? error.message
            : `${normalized} Binance 实时合约数据不可用`,
        );
      } finally {
        if (!disposed) setManualContractLoading(false);
        running = false;
      }
    };
    const initialTimer = window.setTimeout(() => void refresh(), 200);
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      disposed = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [active, accessProfile, symbol]);

  useEffect(() => {
    if (
      active !== "manualLegacy" ||
      !accessProfile ||
      !selectedMarket?.enabled
    ) {
      setManualMarketHistory({
        symbol: selectedMarket?.symbol ?? "",
        points: [],
        loading: false,
        error: null,
        updatedAt: null,
      });
      return;
    }
    const selectedSymbol = selectedMarket.symbol;
    const controller = new AbortController();
    setManualMarketHistory({
      symbol: selectedSymbol,
      points: [],
      loading: true,
      error: null,
      updatedAt: null,
    });
    void fetch(
      `/api/control/symbols/history?symbol=${encodeURIComponent(selectedSymbol)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await readJsonResponse(response)) as {
          error?: string;
          symbol?: string;
          points?: ManualMarketHistoryPoint[];
          updatedAt?: string;
        };
        if (!response.ok)
          throw new Error(result.error ?? "96小时合约走势加载失败");
        setManualMarketHistory({
          symbol: result.symbol ?? selectedSymbol,
          points: result.points ?? [],
          loading: false,
          error: null,
          updatedAt: result.updatedAt ?? new Date().toISOString(),
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setManualMarketHistory({
          symbol: selectedSymbol,
          points: [],
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "96小时合约走势加载失败",
          updatedAt: null,
        });
      });
    return () => controller.abort();
  }, [
    active,
    accessProfile,
    selectedMarket?.symbol,
    selectedMarket?.enabled,
    marketRefreshVersion,
  ]);

  useEffect(() => {
    if (
      marketRefreshVersion === 0 ||
      !["pool", "market", "manual", "semiAuto", "auto"].includes(active) ||
      !accessProfile
    )
      return;
    void loadSymbolPool();
  }, [marketRefreshVersion]);

  useEffect(() => {
    if (!["position", "profit"].includes(active) || !accessProfile) return;
    let running = false;
    const refreshLivePositions = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await loadPositions(true);
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void refreshLivePositions(), 5_000);
    document.addEventListener("visibilitychange", refreshLivePositions);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshLivePositions);
    };
  }, [active, accessProfile]);

  useEffect(() => {
    if (!["orders", "profit"].includes(active) || !accessProfile) return;
    let running = false;
    const refreshLedger = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        if (active === "orders") await loadLiveOrders(true);
        else await loadPositions(true);
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(
      () => void refreshLedger(),
      active === "orders" ? 5_000 : 10_000,
    );
    document.addEventListener("visibilitychange", refreshLedger);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshLedger);
    };
  }, [active, accessProfile]);

  useEffect(() => {
    if (active !== "position" || !accessProfile) return;
    let running = false;
    const refreshLivePositionMarks = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const response = await fetch("/api/control/live-position-marks", {
          cache: "no-store",
        });
        const result = (await readJsonResponse(response)) as {
          rows?: Array<{
            symbol: string;
            markPrice: number;
            fundingRate?: number | null;
            nextFundingTime?: number | null;
            time?: number | null;
            receivedAt?: number | null;
          }>;
        };
        if (!response.ok || !Array.isArray(result.rows)) return;
        const marks = new Map(
          result.rows
            .filter(
              (row) =>
                typeof row.symbol === "string" &&
                Number.isFinite(row.markPrice) &&
                row.markPrice > 0,
            )
            .map((row) => [row.symbol, row]),
        );
        if (!marks.size) return;
        setLivePositions((current) =>
          current.map((position) => {
            const mark = marks.get(position.symbol);
            return mark
              ? {
                  ...position,
                  markPrice: mark.markPrice,
                  liveMarket: {
                    fundingRate:
                      Number.isFinite(mark.fundingRate) ? mark.fundingRate! : null,
                    nextFundingTime:
                      Number.isFinite(mark.nextFundingTime) && mark.nextFundingTime! > 0
                        ? mark.nextFundingTime!
                        : null,
                    observedAt:
                      Number.isFinite(mark.receivedAt) && mark.receivedAt! > 0
                        ? mark.receivedAt!
                        : Number.isFinite(mark.time) && mark.time! > 0
                          ? mark.time!
                          : null,
                  },
                }
              : position;
          }),
        );
      } catch {
        // Keep the last proven position snapshot. The backend risk service
        // independently rejects stale WebSocket marks for execution.
      } finally {
        running = false;
      }
    };
    void refreshLivePositionMarks();
    const timer = window.setInterval(
      () => void refreshLivePositionMarks(),
      1_000,
    );
    document.addEventListener("visibilitychange", refreshLivePositionMarks);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener(
        "visibilitychange",
        refreshLivePositionMarks,
      );
    };
  }, [active, accessProfile]);

  useEffect(() => {
    void loadAccessProfile();
  }, []);

  useEffect(() => {
    setCurrentTime(Date.now());
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!["auto", "strategyLogs"].includes(active) || !accessProfile) return;
    const refresh = () => {
      if (document.visibilityState === "visible")
        void loadStrategyLifecycle(true);
    };
    const timer = window.setInterval(refresh, 5_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active, accessProfile]);

  useEffect(() => {
    if (
      !strategyExecutionPanelOpen ||
      !strategyExecutionTarget
    )
      return;
    const refreshChanges = () => {
      if (document.visibilityState === "visible")
        void loadStrategyExecutionChanges(strategyExecutionTarget.id);
    };
    const refreshMonitor = () => {
      if (document.visibilityState === "visible")
        void loadStrategyMonitorStatus(strategyExecutionTarget.id);
    };
    refreshChanges();
    refreshMonitor();
    const realtimeTimer = window.setInterval(refreshChanges, 1_000);
    const monitorTimer = window.setInterval(refreshMonitor, 2_000);
    const refreshVisible = () => {
      refreshChanges();
      refreshMonitor();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(realtimeTimer);
      window.clearInterval(monitorTimer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [
    strategyExecutionPanelOpen,
    strategyExecutionTarget?.id,
  ]);

  useEffect(() => {
    if (strategyLogTabOpen || !strategyExecutionPanelOpen) return;
    clearStrategyLogSession();
  }, [strategyLogTabOpen, strategyExecutionPanelOpen]);

  useEffect(() => {
    if (
      active !== "strategyLogs" ||
      !strategyExecutionPanelOpen ||
      !strategyExecutionTarget
    )
      return;
    void Promise.all([
      loadStrategyExecutionChanges(strategyExecutionTarget.id),
      loadStrategyMonitorStatus(strategyExecutionTarget.id),
    ]);
  }, [
    active,
    strategyExecutionPanelOpen,
    strategyExecutionTarget?.id,
  ]);

  useEffect(() => {
    if (!strategyExecutionPanelOpen) return;
    const compactSessionCache = () =>
      setStrategyExecutions((current) => {
        const unique = new Map(
          current.map((execution) => [execution.traceId, execution]),
        );
        const compacted = [...unique.values()]
          .sort(
            (left, right) =>
              new Date(right.updatedAt).getTime() -
                new Date(left.updatedAt).getTime() ||
              right.id - left.id,
          )
          .slice(0, STRATEGY_SESSION_LOG_LIMIT);
        if (
          compacted.length === current.length &&
          compacted.every(
            (execution, index) => execution === current[index],
          )
        )
          return current;
        return compacted;
      });
    compactSessionCache();
    const timer = window.setInterval(compactSessionCache, 60_000);
    return () => window.clearInterval(timer);
  }, [strategyExecutionPanelOpen]);

  useEffect(() => {
    if (
      !strategyExecutionPanelOpen ||
      strategyExecutionDetailBusy ||
      strategyExecutions.length === 0
    )
      return;
    const selectedTraceId = strategyExecutionDetail?.execution.traceId;
    const selectedExecution = selectedTraceId
      ? strategyExecutions.find(
          (execution) => execution.traceId === selectedTraceId,
        )
      : null;
    if (!selectedTraceId) {
      void loadStrategyExecutionDetail(strategyExecutions[0].traceId);
      return;
    }
    if (
      selectedExecution &&
      new Date(selectedExecution.updatedAt).getTime() >
        new Date(strategyExecutionDetail.execution.updatedAt).getTime()
    )
      void loadStrategyExecutionDetail(selectedTraceId);
  }, [
    strategyExecutionPanelOpen,
    strategyExecutions,
    strategyExecutionDetail?.execution.traceId,
    strategyExecutionDetail?.execution.updatedAt,
    strategyExecutionDetailBusy,
  ]);

  useEffect(() => {
    if (!configuredStrategy) return;
    const versions = strategyVersions
      .filter((version) => version.strategyId === configuredStrategy.id)
      .sort((a, b) => b.version - a.version);
    setCompareTargetVersion(versions[0]?.version ?? 0);
    setCompareBaseVersion(
      versions.find((version) => version.isBaseline)?.version ??
        versions[1]?.version ??
        versions[0]?.version ??
        0,
    );
  }, [configuredStrategy?.id, strategyVersions.length]);

  useEffect(() => {
    if (
      portfolioAccountFilter !== "ALL" &&
      !tradingAccounts.some(
        (account) =>
          account.accountType === "STRATEGY" &&
          account.accountId === portfolioAccountFilter,
      )
    ) {
      setPortfolioAccountFilter("ALL");
    }
  }, [portfolioAccountFilter, tradingAccounts]);

  useEffect(() => {
    if (active !== "auto" || !strategyFocusId) return;
    const strategy = configuredStrategies.find(
      (item) => item.id === strategyFocusId,
    );
    if (strategy) {
      setPortfolioAccountFilter(strategy.accountId);
      if (strategyFocusMode === "LEARNING")
        void openStrategyExecutionLog(strategy, "LEARNING");
      else openManagedStrategy(strategy);
    }
  }, [active, strategyFocusId, strategyFocusMode, configuredStrategies.length]);

  async function loadPositions(
    silent = false,
    enrichOpenPositions = false,
  ) {
    const historyOnly = active === "profit";
    const coreOnly = !historyOnly && !enrichOpenPositions;
    const requestRef = coreOnly
      ? positionCoreRequestRef
      : positionRequestRef;
    const requestId = ++requestRef.current;
    if (!silent) setPositionsBusy(true);
    try {
      const positionsEndpoint = historyOnly
        ? "/api/control/live-positions?scope=history"
        : coreOnly
          ? "/api/control/live-positions?scope=open&detail=core"
          : "/api/control/live-positions?scope=open";
      const response = await fetchWithTransientRetry(
        positionsEndpoint,
        {
        cache: "no-store",
        },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        detail?: "CORE" | "LEDGER";
        positions?: LivePosition[];
        reductions?: LivePositionReduction[];
      };
      if (!response.ok) throw new Error(result.error ?? "实盘持仓加载失败");
      if (requestId !== requestRef.current) return;
      const nextPositions = result.positions ?? [];
      if (result.detail === "CORE") {
        setLivePositions((current) => {
          const currentById = new Map(
            current.map((position) => [position.id, position]),
          );
          return nextPositions.map((position) => {
            const previous = currentById.get(position.id);
            if (!previous) return position;
            return {
              ...previous,
              ...position,
              executionRule:
                previous.executionRule ?? position.executionRule,
              additionSummary:
                previous.additionSummary ?? position.additionSummary,
              learning: previous.learning
                ? {
                    ...previous.learning,
                    source:
                      position.learning?.source ?? previous.learning.source,
                    traceId:
                      position.learning?.traceId ?? previous.learning.traceId,
                    strategyId:
                      position.learning?.strategyId ??
                      previous.learning.strategyId,
                  }
                : position.learning,
            };
          });
        });
      } else if (historyOnly) {
        setLivePositions(nextPositions);
        setLivePositionReductions(result.reductions ?? []);
      } else {
        // The core ledger is the only authority for OPEN-position membership.
        // A slower enrichment request may have started before a new Binance
        // fill was materialized, so it must never replace the newer core list
        // and make a just-opened hedge leg disappear from the page.
        const enrichmentById = new Map(
          nextPositions.map((position) => [position.id, position]),
        );
        setLivePositions((current) =>
          current.map((position) => {
            const enrichment = enrichmentById.get(position.id);
            if (!enrichment) return position;
            return {
              ...position,
              allocationEntryPrice: enrichment.allocationEntryPrice,
              exchangeEntryPrice: enrichment.exchangeEntryPrice,
              executionRule: enrichment.executionRule,
              additionSummary: enrichment.additionSummary,
              learning: enrichment.learning,
            };
          }),
        );
        setLivePositionReductions(result.reductions ?? []);
      }
      setPositionsLoaded(true);
      return nextPositions;
    } catch (error) {
      if (!silent && requestId === requestRef.current)
        setToast(
          error instanceof TypeError
            ? "服务正在恢复，已保留当前列表并自动重试；请稍后再次刷新"
            : error instanceof Error
              ? error.message
              : "持仓加载失败，已保留当前列表",
        );
      return false;
    } finally {
      // A silent five-second refresh may supersede this request id while the
      // visible refresh is still in flight. The visible busy state belongs to
      // this request and must always be released when it settles.
      if (!silent) setPositionsBusy(false);
    }
  }

  async function loadLiveOrders(silent = false) {
    const requestId = ++liveOrderRequestRef.current;
    if (!silent) setLoadingOrders(true);
    try {
      const response = await fetchWithTransientRetry("/api/control/live-orders", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        orders?: LiveOrderEvent[];
      };
      if (!response.ok) throw new Error(result.error ?? "实盘订单加载失败");
      if (requestId !== liveOrderRequestRef.current) return;
      const nextOrders = (result.orders ?? []).filter((order) => !order.testOnly);
      setLiveOrders(nextOrders);
      return nextOrders;
    } catch (error) {
      if (!silent && requestId === liveOrderRequestRef.current)
        setToast(clientRequestErrorMessage(error, "实盘订单加载失败"));
      return false;
    } finally {
      // A silent poll may supersede a visible refresh while it is in flight.
      // The visible request still owns its loading indicator and must release it.
      if (!silent) setLoadingOrders(false);
    }
  }

  async function synchronizeSubmittedOrderLists(clientOrderId: string) {
    const delays = [0, 500, 1_000, 2_000, 3_000, 5_000, 5_000, 5_000, 5_000];
    for (const delay of delays) {
      if (delay > 0)
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      const [, orders] = await Promise.all([
        loadPositions(true),
        loadLiveOrders(true),
      ]);
      if (orders && submittedOrderIsVisible({ clientOrderId, orders }))
        return true;
    }
    return false;
  }

  async function syncReductionSettlements() {
    if (positionsBusy) return;
    setPositionsBusy(true);
    try {
      const response = await fetch(
        "/api/control/live-positions/settlements",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        scanned?: number;
        exact?: number;
        pending?: number;
        errors?: number;
      };
      if (!response.ok)
        throw new Error(result.error ?? "成交明细核对失败");
      await loadPositions(true);
      setToast(
        result.scanned
          ? `已核对 ${result.scanned} 笔：补齐 ${result.exact ?? 0} 笔，仍待交易所明细 ${result.pending ?? 0} 笔${result.errors ? `，失败 ${result.errors} 笔` : ""}`
          : "当前没有需要补齐的成交明细；资金费共享记录已单独标识",
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "成交明细核对失败");
    } finally {
      setPositionsBusy(false);
    }
  }

  async function cancelLivePendingOrder() {
    if (!liveCancelOrderTarget || liveCancelBusy) return;
    setLiveCancelBusy(true);
    try {
      const response = await fetch("/api/control/live-orders", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: liveCancelOrderTarget.id,
          action: "CANCEL",
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        clearedPendingState?: boolean;
        reconciliationRequired?: boolean;
      };
      if (!response.ok) throw new Error(result.error ?? "撤单失败");
      setLiveCancelOrderTarget(null);
      setToast(
        result.reconciliationRequired
          ? "剩余委托已撤，检测到部分成交，后台正在核对并恢复实际仓位"
          : result.clearedPendingState
          ? "撤单成功，系统待执行状态已清除，审计记录已保留"
          : "撤单成功",
      );
      await loadLiveOrders();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "撤单失败");
      await loadLiveOrders();
    } finally {
      setLiveCancelBusy(false);
    }
  }

  function openLiveRiskEditor(position: LivePosition) {
    const plan = liveRiskPlanSummary(position.riskPlanJson);
    setLiveCloseTarget(null);
    setLiveRiskEditTarget(position);
    setLiveRiskEditForm({
      takeStart: plan.takeProfits[0]?.triggerPercent ?? 2,
      takeEnd: plan.takeProfits.at(-1)?.triggerPercent ?? 8,
      takeGrids: Math.max(1, plan.takeProfits.length || 3),
      stopStart: plan.stopLosses[0]?.triggerPercent ?? 2,
      stopEnd: plan.stopLosses.at(-1)?.triggerPercent ?? 5,
      stopGrids: Math.max(1, plan.stopLosses.length || 2),
      minimumObservationMinutes: plan.minimumObservationMinutes,
      liquidationGuardBufferPercent: plan.liquidationGuardBufferPercent,
      trailingActivation: position.trailingActivationPercent || 2,
      trailingCallback: position.trailingStopPercent,
    });
  }

  async function saveLivePositionRisk() {
    if (!liveRiskEditTarget) return;
    setPositionsBusy(true);
    const updateRequestId = createClientRequestId().replaceAll("-", "");
    try {
      const response = await fetchWithTransientRetry(
        "/api/control/live-positions",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: liveRiskEditTarget.id,
            requestId: updateRequestId,
            takeProfitPlan: liveTakeProfitPlan,
            stopLossPlan: liveStopLossPlan,
            minimumObservationMinutes:
              liveRiskEditForm.minimumObservationMinutes,
            liquidationGuardBufferPercent:
              liveRiskEditForm.liquidationGuardBufferPercent,
            trailingActivationPercent:
              liveRiskEditForm.trailingCallback > 0
                ? liveRiskEditForm.trailingActivation
                : 0,
            trailingStopPercent: liveRiskEditForm.trailingCallback,
          }),
        },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        position?: LivePosition;
        idempotentReplay?: boolean;
      };
      if (!response.ok) throw new Error(result.error ?? "实盘风控参数保存失败");
      if (!result.position)
        throw new Error("服务器未返回生效后的仓位参数，当前窗口已保留");
      setLiveRiskEditTarget(null);
      const refreshed = await loadPositions(true);
      setToast(
        refreshed
          ? `${liveRiskEditTarget.symbol} 止盈止损参数已保存并核对生效`
          : `${liveRiskEditTarget.symbol} 参数已在后台生效，列表正在自动恢复同步`,
      );
    } catch (error) {
      setToast(
        error instanceof TypeError
          ? "服务暂时不可用，未确认参数是否生效；窗口已保留，请稍后用同一参数重新保存"
          : error instanceof Error
            ? error.message
            : "实盘风控参数保存失败",
      );
    } finally {
      setPositionsBusy(false);
    }
  }

  function openLiveCloseConfirmation(
    position: LivePosition,
    orderType: "MARKET" | "LIMIT",
  ) {
    setLiveRiskEditTarget(null);
    setLiveAddTarget(null);
    setLiveCloseQuantity(position.quantity);
    setLiveClosePrice(position.markPrice);
    setLiveCloseTarget({ position, orderType });
  }

  function openLiveAddConfirmation(position: LivePosition) {
    setLiveRiskEditTarget(null);
    setLiveCloseTarget(null);
    const market = pool.find((item) => item.symbol === position.symbol);
    const referencePrice = position.markPrice || position.entryPrice || market?.price || 0;
    const ruleMinimum = position.executionRule?.minOrderQty ?? market?.minOrderQty ?? 0.00000001;
    const step = position.executionRule?.quantityStep ?? market?.quantityStep ?? ruleMinimum;
    const minNotionalUsdt =
      position.executionRule?.minNotionalUsdt ?? market?.minNotionalUsdt ?? 0;
    const minimum = referencePrice > 0
      ? effectiveMarketMinimumOrderQuantity(
          ruleMinimum,
          step,
          minNotionalUsdt,
          referencePrice,
        )
      : ruleMinimum;
    setLiveAddQuantity(minimum);
    setLiveAddPrice(referencePrice);
    setLiveAddTarget({ position, orderType: "MARKET" });
  }

  async function synchronizePendingLiveClose(positionId: number) {
    const delays = [1_000, 2_000, 3_000, 5_000, 5_000, 5_000];
    for (const delay of delays) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      const positions = await loadPositions(true);
      if (!positions) continue;
      const position = positions.find((item) => item.id === positionId);
      if (!position) {
        setToast("平仓成交已完成对账，仓位列表已更新");
        return;
      }
      if (
        position.status === "OPEN" &&
        !position.pendingCloseClientOrderId
      ) {
        setToast("部分平仓成交已完成对账，剩余仓位可以继续操作");
        return;
      }
    }
    setToast("Binance 成交已确认，成交明细仍在后台按订单号核对；系统不会重复平仓");
  }

  async function confirmLivePositionAdd() {
    const draft = liveAddTarget;
    if (!draft || liveAddSubmitting) return;
    if (!liveAddQuantityValid) {
      setToast(
        `补仓数量需不低于 ${liveAddQuantityMinimum}，并按 ${liveAddQuantityStep} 步长填写`,
      );
      return;
    }
    if (
      draft.orderType === "LIMIT" &&
      (!Number.isFinite(liveAddPrice) || liveAddPrice <= 0)
    ) {
      setToast("请输入有效的限价补仓价格");
      return;
    }
    setLiveAddSubmitting(true);
    try {
      const response = await fetch("/api/control/live-positions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "ADD",
          id: draft.position.id,
          orderType: draft.orderType,
          quantity: liveAddQuantity,
          price: draft.orderType === "LIMIT" ? liveAddPrice : undefined,
          confirmation: "CONFIRM_LIVE_ADD",
          idempotencyKey: createClientRequestId().replaceAll("-", ""),
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        executedQuantity?: number;
        additionEntryPrice?: number;
        entryPrice?: number;
        liquidationPrice?: number | null;
      };
      if (!response.ok) throw new Error(result.error ?? "实盘补仓失败");
      setLiveAddTarget(null);
      await Promise.all([loadPositions(), loadLiveOrders()]);
      setToast(
        `${draft.position.symbol} 已补仓 ${formatCompactDecimal(result.executedQuantity ?? liveAddQuantity, 8, "--")}，成交价 ${formatCompactDecimal(result.additionEntryPrice, 8, "--")}，新均价 ${formatCompactDecimal(result.entryPrice, 8, "--")}，强平价 ${formatCompactDecimal(result.liquidationPrice, 8, "--")}`,
      );
    } catch (error) {
      await Promise.allSettled([loadPositions(), loadLiveOrders()]);
      setToast(error instanceof Error ? error.message : "实盘补仓失败");
    } finally {
      setLiveAddSubmitting(false);
    }
  }

  async function confirmLivePositionClose() {
    const draft = liveCloseTarget;
    if (!draft || liveCloseSubmitting) return;
    if (!liveCloseQuantityValid) {
      if (liveCloseLeavesDust) {
        setToast(
          `本次平仓会留下低于最小下单量 ${liveCloseQuantityMinimum} 的尾仓，请减少平仓数量或直接全部平仓`,
        );
        return;
      }
      setToast(
        `平仓数量需在 ${liveCloseQuantityMinimum} 至 ${draft.position.quantity} 之间，并按 ${liveCloseQuantityStep} 步长填写`,
      );
      return;
    }
    if (
      draft.orderType === "LIMIT" &&
      (!Number.isFinite(liveClosePrice) || liveClosePrice <= 0)
    ) {
      setToast("请输入有效的限价平仓价格");
      return;
    }
    setLiveCloseSubmitting(true);
    try {
      const response = await fetch("/api/control/live-positions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: draft.position.id,
          orderType: draft.orderType,
          quantity: liveCloseNormalizedQuantity,
          closeAll: liveCloseAll,
          price: draft.orderType === "LIMIT" ? liveClosePrice : undefined,
          confirmation: "CONFIRM_LIVE_CLOSE",
          idempotencyKey: createClientRequestId().replaceAll("-", ""),
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        code?: string | number;
        executionUnknown?: boolean;
        executedQuantity?: number;
        exitPrice?: number;
        realizedPnl?: number;
        netRealizedPnl?: number | null;
        exactNetAvailable?: boolean;
        remainingQuantity?: number;
        closed?: boolean;
        protectionRebalanced?: boolean;
        takeProfitGrids?: { requested: number; actual: number; reduced: boolean } | null;
        stopLossGrids?: { requested: number; actual: number; reduced: boolean } | null;
      };
      if (!response.ok) {
        if (result.executionUnknown) {
          setLiveCloseTarget(null);
          setToast("Binance 已确认平仓成交，正在进行秒级订单号对账，请勿重复提交");
          void synchronizePendingLiveClose(draft.position.id);
          return;
        }
        throw new Error(result.error ?? "实盘平仓失败");
      }
      setLiveCloseTarget(null);
      await Promise.all([loadPositions(), loadLiveOrders()]);
      const displayPnl = result.exactNetAvailable && result.netRealizedPnl !== null && result.netRealizedPnl !== undefined
        ? result.netRealizedPnl
        : result.realizedPnl ?? 0;
      const protectionSummary = result.protectionRebalanced
        ? `；剩余 ${result.remainingQuantity ?? "--"}，保护计划已重排为止盈 ${result.takeProfitGrids?.actual ?? 0} 格 / 止损 ${result.stopLossGrids?.actual ?? 0} 格`
        : "";
      setToast(`${draft.position.symbol} 已平仓 ${formatCompactDecimal(result.executedQuantity ?? liveCloseQuantity, 8, "--")}，成交价 ${formatCompactDecimal(result.exitPrice, 8, "--")}，${result.exactNetAvailable ? "净盈亏" : "毛盈亏（交易成本待补）"} ${displayPnl.toFixed(2)} USDT${protectionSummary}`);
    } catch (error) {
      await Promise.allSettled([loadPositions(), loadLiveOrders()]);
      setToast(error instanceof Error ? error.message : "实盘平仓失败");
    } finally {
      setLiveCloseSubmitting(false);
    }
  }

  useEffect(() => {
    if (active !== "system" || !accessProfile) return;
    if (can("sys:audit:view")) void loadAuditEvents();
    if (can("sys:access:manage")) void loadAccessMembers();
  }, [active, accessProfile]);

  async function loadAccessProfile() {
    try {
      const response = await fetch("/api/control/access", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        email?: string;
        role?: string;
        dataScope?: string;
        permissions?: string[];
      };
      if (!response.ok) throw new Error(result.error ?? "权限信息加载失败");
      setAccessProfile({
        email: result.email!,
        role: result.role!,
        dataScope: result.dataScope!,
        permissions: result.permissions ?? [],
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "权限信息加载失败");
    }
  }

  async function loadSymbolPool(quiet = false) {
    const requestId = ++symbolPoolRequestRef.current;
    try {
      const response = await fetchWithTransientRetry("/api/control/symbols", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        marketStatus?: {
          reachable: boolean;
          error: string | null;
          updatedAt: string;
          thresholdUsdt: number;
        };
        symbols?: Array<{
          symbol: string;
          displayName: string;
          minOrderQty: number;
          effectiveMinOrderQty: number | null;
          effectiveMarketMinOrderQty: number | null;
          quantityStep: number;
          minNotionalUsdt: number;
          priceTickSize: number;
          maxLeverage: number | null;
          isActive: boolean;
          updatedAt: string | number;
          market?: {
            price: number;
            change: number;
            high: number;
            low: number;
            quoteVolume: number;
          } | null;
        }>;
        catalog?: Array<{
          symbol: string;
          displayName: string;
          source:
            | "MANUAL_INCLUDE"
            | "MANUAL_PROTECT"
            | "AUTO_FILTER"
            | "MANUAL_EXCLUDE"
            | "AUTO_VOLUME_EXCLUDE";
          isIncluded: boolean;
          minOrderQty: number;
          effectiveMinOrderQty: number | null;
          effectiveMarketMinOrderQty: number | null;
          quantityStep: number;
          minNotionalUsdt: number;
          priceTickSize: number;
          maxLeverage: number | null;
          market?: {
            price: number;
            change: number;
            high: number;
            low: number;
            quoteVolume: number;
          } | null;
        }>;
      };
      if (!response.ok) throw new Error(result.error ?? "合约池加载失败");
      if (requestId !== symbolPoolRequestRef.current) return;
      const nextPool = (result.symbols ?? []).map((item) => {
        return {
          symbol: item.symbol,
          name: item.displayName,
          price: item.market?.price ?? 0,
          change: item.market?.change ?? 0,
          high: item.market?.high ?? 0,
          low: item.market?.low ?? 0,
          volume: item.market?.quoteVolume ?? "待同步",
          min: String(item.minOrderQty),
          enabled: item.isActive,
          minOrderQty: item.minOrderQty,
          effectiveMinOrderQty: item.effectiveMinOrderQty,
          effectiveMarketMinOrderQty: item.effectiveMarketMinOrderQty,
          quantityStep: item.quantityStep,
          minNotionalUsdt: item.minNotionalUsdt,
          priceTickSize: item.priceTickSize,
          maxLeverage: item.maxLeverage,
          updatedAt: String(item.updatedAt),
        };
      });
      setPool(nextPool);
      setContractCatalog(
        (result.catalog ?? []).map((item) => ({
          symbol: item.symbol,
          name: item.displayName,
          included: item.isIncluded,
          price: item.market?.price ?? 0,
          change: item.market?.change ?? 0,
          volume: item.market?.quoteVolume ?? 0,
          minOrderQty: item.minOrderQty,
          effectiveMinOrderQty: item.effectiveMinOrderQty,
          effectiveMarketMinOrderQty: item.effectiveMarketMinOrderQty,
          quantityStep: item.quantityStep,
          minNotionalUsdt: item.minNotionalUsdt,
          maxLeverage: item.maxLeverage,
        })),
      );
      setMarketStatus(result.marketStatus ?? null);
      // A market refresh must never replace the symbol the trader is editing.
      // If the selected contract leaves the pool, retain the value and let the
      // normal validation block submission instead of silently switching assets.
      const currentSymbol = symbolRef.current.trim().toUpperCase();
      const nextQuote =
        nextPool.find((item) => item.symbol === currentSymbol)?.price ?? 0;
      if (active === "manual" && nextQuote > 0)
        setOrderPrice((currentPrice) =>
          orderTypeRef.current === "市价单" || currentPrice <= 0
            ? nextQuote
            : currentPrice,
        );
    } catch (error) {
      if (requestId === symbolPoolRequestRef.current) {
        const message = clientRequestErrorMessage(error, "合约池加载失败");
        // Keep exchange quantity rules cached for symbol validation, but never
        // let a failed refresh leave an old quote looking tradable.
        setPool((current) =>
          current.map((item) => ({
            ...item,
            price: 0,
            change: 0,
            high: 0,
            low: 0,
            volume: "行情断开",
          })),
        );
        setMarketStatus((current) => ({
          reachable: false,
          error: message,
          updatedAt: new Date().toISOString(),
          thresholdUsdt: current?.thresholdUsdt ?? 15_000_000,
        }));
        if (orderTypeRef.current === "市价单") setOrderPrice(0);
        if (!quiet) setToast(message);
      }
    }
  }

  async function updateSymbolPool(
    symbol: string,
    changes: { isActive: boolean },
  ) {
    setPoolBusy(symbol);
    try {
      const response = await fetch("/api/control/symbols", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol, ...changes }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "合约状态更新失败");
      await loadSymbolPool();
      setToast(`${symbol} 白名单状态已保存`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "合约状态更新失败");
    } finally {
      setPoolBusy("");
    }
  }

  async function synchronizeSymbolPool() {
    setPoolBusy("SYNC");
    try {
      const response = await fetch("/api/control/symbols", { method: "PUT" });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        qualifiedCount?: number;
        scannedCount?: number;
      };
      if (!response.ok)
        throw new Error(result.error ?? "Binance 合约池同步失败");
      await loadSymbolPool();
      setToast(
        `合约池已更新：已同步 ${result.qualifiedCount ?? 0}/${result.scannedCount ?? 0} 个 Binance USDT 永续合约`,
      );
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "Binance 合约池同步失败",
      );
    } finally {
      setPoolBusy("");
    }
  }

  async function createSymbol(symbol: string) {
    setPoolBusy("CREATE");
    try {
      const response = await fetch("/api/control/symbols", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "新增合约失败");
      setShowAddSymbol(false);
      await loadSymbolPool();
      setToast(`${symbol} 已加入合约池并开始参与策略扫描`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "新增合约失败");
    } finally {
      setPoolBusy("");
    }
  }

  async function removeSymbol(symbol: string) {
    setPoolBusy(symbol);
    try {
      const response = await fetch(
        `/api/control/symbols?symbol=${encodeURIComponent(symbol)}`,
        { method: "DELETE" },
      );
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "移除合约失败");
      await loadSymbolPool();
      setToast(`${symbol} 已移出合约池；停止新扫描和新交易，已有仓位继续保护`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "移除合约失败");
    } finally {
      setPoolBusy("");
    }
  }

  async function changePassword() {
    if (
      newPassword.length < 12 ||
      newPassword.length > 128 ||
      confirmChangedPassword !== newPassword
    ) {
      setToast("请确认新密码为 12 至 128 位且两次输入一致");
      return;
    }
    if (currentPassword === newPassword)
      return setToast("新密码不能与当前密码相同");
    setAuthBusy(true);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "密码设置失败");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmChangedPassword("");
      setShowSecurityPasswords(false);
      setToast("密码已安全更新");
      await loadAccessProfile();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "密码设置失败");
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredWorkspace();
    broadcastApplicationLogout();
    window.location.reload();
  }

  async function createUser() {
    if (!/^\S+@\S+\.\S+$/.test(accountForm.email.trim()))
      return setToast("请输入有效的成员邮箱");
    if (
      accountForm.temporaryPassword.length < 12 ||
      accountForm.temporaryPassword.length > 128 ||
      accountForm.confirmTemporaryPassword !== accountForm.temporaryPassword
    )
      return setToast("请确认临时密码为 12 至 128 位且两次输入一致");
    setSavingAccess(accountForm.email);
    try {
      const response = await fetch("/api/control/access/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...accountForm,
          email: accountForm.email.trim().toLowerCase(),
          confirmTemporaryPassword: undefined,
        }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "新增用户失败");
      setToast(`${accountForm.email} 已创建，请安全发送临时密码`);
      setAccountForm({
        email: "",
        displayName: "",
        role: "VIEWER",
        dataScope: "OWN",
        temporaryPassword: "",
        confirmTemporaryPassword: "",
      });
      setShowAccountPasswords(false);
      await Promise.all([loadAccessMembers(), loadAuditEvents()]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "新增用户失败");
    } finally {
      setSavingAccess("");
    }
  }

  async function resetUserPassword() {
    if (
      resetPassword.length < 12 ||
      resetPassword.length > 128 ||
      confirmResetPassword !== resetPassword
    )
      return setToast("请确认新临时密码为 12 至 128 位且两次输入一致");
    setSavingAccess(resetTarget);
    try {
      const response = await fetch("/api/control/access/admin", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: resetTarget,
          temporaryPassword: resetPassword,
        }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "密码重置失败");
      setToast(`${resetTarget} 的临时密码已重置`);
      setResetTarget("");
      setResetPassword("");
      setConfirmResetPassword("");
      setShowResetPasswords(false);
      await Promise.all([loadAccessMembers(), loadAuditEvents()]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "密码重置失败");
    } finally {
      setSavingAccess("");
    }
  }

  async function loadAccessMembers() {
    try {
      const response = await fetch("/api/control/access/admin", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        users?: AccessMember[];
      };
      if (!response.ok) throw new Error(result.error ?? "成员权限加载失败");
      setAccessMembers(result.users ?? []);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "成员权限加载失败");
    }
  }

  async function loadAuditEvents(append = false) {
    if (auditBusy) return;
    setAuditBusy(true);
    try {
      const cursor = append ? auditCursor : null;
      const response = await fetch(
        `/api/control/audit${cursor ? `?cursor=${cursor}` : ""}`,
        { cache: "no-store" },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        events?: AuditEvent[];
        hasMore?: boolean;
        nextCursor?: number | null;
      };
      if (!response.ok) throw new Error(result.error ?? "审计日志加载失败");
      const rows = result.events ?? [];
      setAuditEvents((current) =>
        append
          ? [
              ...current,
              ...rows.filter(
                (row) => !current.some((item) => item.id === row.id),
              ),
            ]
          : rows,
      );
      setAuditHasMore(Boolean(result.hasMore));
      setAuditCursor(result.nextCursor ?? null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "审计日志加载失败");
    } finally {
      setAuditBusy(false);
    }
  }

  async function copyAuditDetail() {
    if (!auditDetailTarget) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(auditDetailTarget.detail, null, 2),
      );
      setToast("审计详情已复制");
    } catch {
      setToast("复制失败，请在详情区域手动选择复制");
    }
  }

  async function updateMember(
    member: AccessMember,
    next: Partial<Pick<AccessMember, "role" | "dataScope" | "isActive">>,
  ) {
    setSavingAccess(member.email);
    try {
      const response = await fetch("/api/control/access/admin", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: member.email,
          role: next.role ?? member.role,
          dataScope: next.dataScope ?? member.dataScope,
          isActive: next.isActive ?? member.isActive,
        }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "角色更新失败");
      setToast(`${member.email} 的权限已更新`);
      await Promise.all([
        loadAccessMembers(),
        loadAuditEvents(),
        member.email === accessProfile?.email
          ? loadAccessProfile()
          : Promise.resolve(),
      ]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "角色更新失败");
    } finally {
      setSavingAccess("");
    }
  }

  async function loadTradingAccounts(quiet = false) {
    try {
      const response = await fetchWithTransientRetry("/api/control/accounts", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        accounts?: TradingAccount[];
      };
      if (!response.ok) throw new Error(result.error ?? "资金账户加载失败");
      setTradingAccounts(result.accounts ?? []);
      const firstActiveStrategyAccount =
        result.accounts?.find(
          (account) => account.isActive && account.accountType === "STRATEGY",
        )?.accountId ?? "";
      setOrderAccountId((current) =>
        result.accounts?.some(
          (account) =>
            account.accountId === current &&
            account.isActive &&
            account.accountType === "STRATEGY",
        )
          ? current
          : firstActiveStrategyAccount,
      );
      setStrategyConfig((current) => ({
        ...current,
        accountId: result.accounts?.some(
          (account) =>
            account.accountId === current.accountId &&
            account.isActive &&
            account.accountType === "STRATEGY",
        )
          ? current.accountId
          : firstActiveStrategyAccount,
      }));
    } catch (error) {
      if (!quiet)
        setToast(clientRequestErrorMessage(error, "资金账户加载失败"));
    }
  }

  async function loadExchangeCredentials(quiet = false) {
    try {
      const response = await fetchWithTransientRetry(
        "/api/control/exchange-credentials",
        {
        cache: "no-store",
        },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        credentials?: ExchangeCredential[];
        serverLiveTradingAllowed?: boolean;
      };
      if (!response.ok) throw new Error(result.error ?? "实盘账户密钥加载失败");
      setExchangeCredentials(result.credentials ?? []);
      setServerLiveTradingAllowed(result.serverLiveTradingAllowed === true);
    } catch (error) {
      if (!quiet)
        setToast(clientRequestErrorMessage(error, "实盘账户密钥加载失败"));
    }
  }

  async function applyServerLiveControl() {
    if (!serverLiveControlAction || serverLiveControlBusy) return;
    const enabled = serverLiveControlAction === "ENABLE";
    const expected = enabled ? "ENABLE SERVER LIVE" : "DISABLE SERVER LIVE";
    if (serverLiveControlConfirmation !== expected) return;
    setServerLiveControlBusy(true);
    try {
      const response = await fetch("/api/control/live-trading-control", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          confirmation: serverLiveControlConfirmation,
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        enabled?: boolean;
      };
      if (!response.ok) throw new Error(result.error ?? "服务器实盘开关更新失败");
      setServerLiveTradingAllowed(result.enabled === true);
      setServerLiveControlAction(null);
      setServerLiveControlConfirmation("");
      await Promise.all([loadTradingAccounts(), loadExchangeCredentials(true)]);
      setToast(enabled ? "服务器实盘总控已开启；策略仍需人工逐个启动" : "服务器实盘总控已关闭；不会再提交新的实盘开仓订单");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "服务器实盘开关更新失败");
    } finally {
      setServerLiveControlBusy(false);
    }
  }

  async function saveExchangeCredential() {
    setCredentialBusy("SAVE");
    try {
      const payload = { ...credentialForm };
      const response = await fetch("/api/control/exchange-credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "实盘密钥保存失败");
      setCredentialForm((current) => ({
        ...current,
        apiKey: "",
        secretKey: "",
      }));
      setCredentialModalOpen(false);
      await Promise.all([loadTradingAccounts(), loadExchangeCredentials()]);
      setToast("实盘密钥已加密保存；请立即执行账户校验");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "实盘密钥保存失败");
    } finally {
      setCredentialBusy("");
    }
  }

  async function verifyExchangeCredential(credential: ExchangeCredential) {
    setCredentialBusy(String(credential.id));
    try {
      const response = await fetch("/api/control/exchange-credentials", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: credential.id, action: "VERIFY" }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        canTrade?: boolean;
        hedgeMode?: boolean;
        availableBalance?: string;
        totalMarginBalance?: string;
        latencyMs?: number;
      };
      if (!response.ok) throw new Error(result.error ?? "实盘账户校验失败");
      await Promise.all([loadTradingAccounts(), loadExchangeCredentials()]);
      setToast(
        `校验完成：${result.hedgeMode ? "双向持仓" : "单向持仓"}，保证金权益 ${result.totalMarginBalance ?? "--"} USDT，可再开仓 ${result.availableBalance ?? "--"} USDT`,
      );
    } catch (error) {
      await loadExchangeCredentials();
      setToast(error instanceof Error ? error.message : "实盘账户校验失败");
    } finally {
      setCredentialBusy("");
    }
  }

  async function applyCredentialAction() {
    if (!credentialAction) return;
    const action = credentialAction.action;
    const credential = credentialAction.credential;
    setCredentialBusy(String(credential.id));
    try {
      const positionModeAction =
        action === "HEDGE" || action === "ONE_WAY";
      const patchAction =
        positionModeAction || action === "ENABLE" || action === "DISABLE";
      const response = await fetch("/api/control/exchange-credentials", {
        method: patchAction ? "PATCH" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: credential.id,
          action:
            action === "HEDGE"
              ? "SET_HEDGE"
              : action === "ONE_WAY"
                ? "SET_ONE_WAY"
                : action === "ENABLE"
                  ? "ENABLE_LIVE"
                  : action === "DISABLE"
                    ? "DISABLE_LIVE"
                  : undefined,
          confirmation: credentialConfirmation,
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        positionMode?: "ONE_WAY" | "HEDGE";
        credential?: ExchangeCredential;
      };
      if (!response.ok) throw new Error(result.error ?? "实盘账户操作失败");

      if (positionModeAction) {
        const positionMode =
          result.positionMode ?? (action === "HEDGE" ? "HEDGE" : "ONE_WAY");
        setExchangeCredentials((current) =>
          current.map((item) =>
            item.id === credential.id
              ? (result.credential ?? { ...item, positionMode })
              : item,
          ),
        );
      }
      setCredentialAction(null);
      setCredentialConfirmation("");
      setToast(
        positionModeAction
          ? `切换成功：Binance 当前为${action === "HEDGE" ? "双向" : "单向"}持仓`
          : action === "ENABLE"
            ? "账户实盘授权已启用"
            : action === "DISABLE"
              ? "账户实盘授权已关闭"
              : "实盘密钥已永久移除",
      );
      await Promise.all([loadExchangeCredentials(), loadTradingAccounts()]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "实盘账户操作失败");
    } finally {
      setCredentialBusy("");
    }
  }

  async function createTradingAccount() {
    setAddAccountError("");
    setTradingAccountBusy("CREATE");
    try {
      const response = await fetch("/api/control/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tradingAccountForm),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "子账号创建失败");
      if (tradingAccountForm.apiKey && tradingAccountForm.secretKey) {
        const credentialResponse = await fetch(
          "/api/control/exchange-credentials",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accountId: tradingAccountForm.accountId,
              label: `${tradingAccountForm.name} AppKey`,
              apiKey: tradingAccountForm.apiKey,
              secretKey: tradingAccountForm.secretKey,
            }),
          },
        );
        const credentialResult = (await readJsonResponse(credentialResponse)) as {
          error?: string;
        };
        if (!credentialResponse.ok)
          throw new Error(
            `账户已创建，但 AppKey 保存失败：${credentialResult.error ?? "请稍后单独配置"}`,
          );
      }
      const createdType = tradingAccountForm.accountType;
      setTradingAccountForm({
        accountId: "",
        name: "",
        accountType: "STRATEGY",
        operatorName: "管理员",
        note: "",
        apiKey: "",
        secretKey: "",
      });
      setShowAddAccount(false);
      await Promise.all([loadTradingAccounts(), loadExchangeCredentials()]);
      setToast(
        createdType === "MAIN"
          ? "主账户已创建（禁止下单）"
          : "交易子账户已创建",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "子账号创建失败";
      setAddAccountError(message);
      setToast(message);
    } finally {
      setTradingAccountBusy("");
    }
  }

  async function deleteTradingAccount() {
    if (!deleteAccountTarget) return;
    setTradingAccountBusy(deleteAccountTarget.accountId);
    try {
      const response = await fetch("/api/control/accounts", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: deleteAccountTarget.id,
          confirmation: deleteAccountConfirmation,
        }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "子账户删除失败");
      setDeleteAccountTarget(null);
      setDeleteAccountConfirmation("");
      await Promise.all([loadTradingAccounts(), loadExchangeCredentials()]);
      setToast("子账户及其未使用的密钥已删除");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "子账户删除失败");
    } finally {
      setTradingAccountBusy("");
    }
  }

  async function saveTradingAccount(
    account: TradingAccount,
    isActive = account.isActive,
    disableConfirmed = false,
  ) {
    if (!isActive && account.isActive && !disableConfirmed) {
      setDisableAccountTarget(account);
      return false;
    }
    setTradingAccountBusy(account.accountId);
    try {
      const response = await fetch("/api/control/accounts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: account.id,
          name: account.name,
          operatorName: account.operatorName,
          note: account.note,
          executionMode: account.executionMode,
          confirmation:
            isActive && !account.isActive
              ? `LIVE ${account.accountId}`
              : undefined,
          isActive,
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        safetyActions?: {
          pausedStrategies: number;
          canceledOrders: number;
          openPositionsKept: number;
        };
      };
      if (!response.ok) throw new Error(result.error ?? "账户设置保存失败");
      await Promise.all([loadTradingAccounts(), loadExchangeCredentials()]);
      if (isActive)
        setToast(
          account.executionMode === "LIVE"
            ? "账户实盘已启用"
            : "账户设置已保存，尚未启用实盘",
        );
      else
        setToast(
          `子账号已停用：暂停 ${result.safetyActions?.pausedStrategies ?? 0} 个策略，撤销 ${result.safetyActions?.canceledOrders ?? 0} 笔等待订单；已有仓位继续受风控管理`,
        );
      setDisableAccountTarget(null);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "账户设置保存失败");
      return false;
    } finally {
      setTradingAccountBusy("");
    }
  }

  async function pauseAccountAutomation() {
    if (!pauseAccountTarget) return;
    setTradingAccountBusy(pauseAccountTarget.accountId);
    try {
      const response = await fetch("/api/control/accounts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: pauseAccountTarget.id,
          confirmation: "PAUSE_ACCOUNT_AUTOMATION",
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        safetyActions?: {
          pausedStrategies: number;
          canceledOrders: number;
          openPositionsKept: number;
        };
      };
      if (!response.ok) throw new Error(result.error ?? "账户安全暂停失败");
      await Promise.all([loadTradingAccounts(), loadLiveOrders(true)]);
      setToast(
        `账户自动化已暂停：暂停 ${result.safetyActions?.pausedStrategies ?? 0} 个策略，撤销 ${result.safetyActions?.canceledOrders ?? 0} 笔等待订单；保留 ${result.safetyActions?.openPositionsKept ?? 0} 个仓位`,
      );
      setPauseAccountTarget(null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "账户安全暂停失败");
    } finally {
      setTradingAccountBusy("");
    }
  }

  async function runAutomationPreflight() {
    setPreflightBusy(true);
    try {
      const response = await fetch("/api/control/automation/preflight", {
        method: "POST",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        ready?: boolean;
        checkedAt?: string;
        checks?: Array<{
          key: string;
          label: string;
          passed: boolean;
          detail: string;
        }>;
      };
      if (!response.ok) throw new Error(result.error ?? "运行前检查失败");
      setPreflight({
        ready: Boolean(result.ready),
        checkedAt: result.checkedAt!,
        checks: result.checks ?? [],
      });
      setToast(
        result.ready
          ? "全部检查通过，专用策略监听运行条件正常"
          : "检查未通过，专用策略监听保持阻断",
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "运行前检查失败");
    } finally {
      setPreflightBusy(false);
    }
  }

  async function loadStrategyLifecycle(quiet = false) {
    if (strategyLifecyclePolling.current) return;
    strategyLifecyclePolling.current = true;
    const requestEpoch = strategyLifecycleEpochRef.current;
    try {
      const strategyResponse = await fetchWithTransientRetry("/api/control/strategies", {
        cache: "no-store",
      });
      const strategyResult = (await readJsonResponse(strategyResponse)) as {
        error?: string;
        strategies?: ConfiguredStrategy[];
        versions?: StrategyConfigVersion[];
      };
      if (!strategyResponse.ok)
        throw new Error(strategyResult.error ?? "策略状态同步失败");
      if (requestEpoch !== strategyLifecycleEpochRef.current) return;
      const nextStrategies = strategyResult.strategies ?? [];
      setConfiguredStrategies(nextStrategies);
      setStrategyVersions(strategyResult.versions ?? []);
      const editingConfig = showStrategyConfigRef.current;
      const currentStrategy = configuredStrategyRef.current;
      const currentConfig = strategyConfigRef.current;
      const strategy = creatingStrategyRef.current
        ? null
        : (nextStrategies.find(
            (item) => item.id === currentStrategy?.id,
          ) ??
          nextStrategies.find(
            (item) => item.name === currentConfig.name,
          ) ??
          nextStrategies[0] ??
          null);
      if (!editingConfig) setConfiguredStrategy(strategy);
      else if (currentStrategy?.id) {
        const latestEditingStrategy =
          nextStrategies.find((item) => item.id === currentStrategy.id) ?? null;
        if (latestEditingStrategy) setConfiguredStrategy(latestEditingStrategy);
      }
      if (strategy && !editingConfig)
        setStrategyConfig(strategyEditorConfig(strategy));
    } catch (error) {
      if (!quiet)
        setToast(clientRequestErrorMessage(error, "策略状态同步失败"));
    } finally {
      strategyLifecyclePolling.current = false;
    }
  }

  async function loadStrategyExecutions(
    strategyId: number,
    quiet = false,
    replaceSessionLogs = true,
  ) {
    if (quiet && strategyLearningAnalysisPollingRef.current) {
      strategyLearningAnalysisPendingRef.current = true;
      return [];
    }
    strategyLearningAnalysisPollingRef.current = true;
    if (!quiet) setStrategyExecutionsBusy(true);
    try {
      const response = await fetch(
        `/api/control/strategies/executions?strategyId=${strategyId}&limit=100`,
        { cache: "no-store" },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        executions?: StrategyExecutionTrace[];
        learningProgress?: StrategyLearningProgress;
        monitorStatus?: StrategyMonitorStatus | null;
      };
      if (!response.ok)
        throw new Error(result.error ?? "策略运行日志加载失败");
      const executions = result.executions ?? [];
      if (replaceSessionLogs) {
        setStrategyExecutions(executions);
        for (const execution of executions) {
          if (
            Boolean(execution.completedAt) ||
            ["CLOSED", "REJECTED", "EXPIRED", "CANCELED", "DATA_STALE"].includes(
              execution.state,
            )
          )
            strategyLearningTerminalRefreshRef.current.add(execution.traceId);
        }
      }
      setStrategyLearningProgress(result.learningProgress ?? null);
      setStrategyMonitorStatus(result.monitorStatus ?? null);
      return executions;
    } catch (error) {
      if (!quiet)
        setToast(error instanceof Error ? error.message : "策略运行日志加载失败");
    } finally {
      strategyLearningAnalysisPollingRef.current = false;
      if (!quiet) setStrategyExecutionsBusy(false);
      if (strategyLearningAnalysisPendingRef.current) {
        strategyLearningAnalysisPendingRef.current = false;
        void loadStrategyExecutions(strategyId, true, false);
      }
    }
    return [];
  }

  async function loadStrategyExecutionChanges(strategyId: number) {
    if (strategyLogPollingRef.current || !strategyLogSinceRef.current) return;
    strategyLogPollingRef.current = true;
    const updatedAfter = strategyLogSinceRef.current;
    try {
      const response = await fetch(
        `/api/control/strategies/executions?strategyId=${strategyId}&mode=changes&updatedAfter=${updatedAfter}&limit=${STRATEGY_SESSION_LOG_LIMIT}`,
        { cache: "no-store" },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        executions?: StrategyExecutionTrace[];
        syncStartedAt?: number;
        monitorStatus?: StrategyMonitorStatus | null;
      };
      if (!response.ok)
        throw new Error(result.error ?? "实时日志同步失败");
      const openedAt = strategyLogOpenedAtRef.current;
      const changes = (result.executions ?? []).filter(
        (execution) =>
          new Date(execution.updatedAt).getTime() >= openedAt,
      );
      if (changes.length)
        setStrategyExecutions((current) => {
          const merged = new Map(
            current.map((execution) => [execution.traceId, execution]),
          );
          for (const execution of changes)
            merged.set(execution.traceId, execution);
          return [...merged.values()]
            .sort(
              (left, right) =>
                new Date(right.updatedAt).getTime() -
                  new Date(left.updatedAt).getTime() ||
                right.id - left.id,
            )
            .slice(0, STRATEGY_SESSION_LOG_LIMIT);
        });
      const newlyTerminal = changes.filter(
        (execution) =>
          !strategyLearningTerminalRefreshRef.current.has(execution.traceId) &&
          (Boolean(execution.completedAt) ||
            ["CLOSED", "REJECTED", "EXPIRED", "CANCELED", "DATA_STALE"].includes(
              execution.state,
            )),
      );
      for (const execution of newlyTerminal)
        strategyLearningTerminalRefreshRef.current.add(execution.traceId);
      if (newlyTerminal.length)
        void loadStrategyExecutions(strategyId, true, false);
      strategyLogSinceRef.current = Math.max(
        updatedAfter,
        Number(result.syncStartedAt) || Date.now(),
      );
      setStrategyLogRealtime({
        status: "LIVE",
        lastSyncAt: Date.now(),
      });
    } catch {
      setStrategyLogRealtime((current) => ({
        status: "DELAYED",
        lastSyncAt: current.lastSyncAt,
      }));
    } finally {
      strategyLogPollingRef.current = false;
    }
  }

  async function loadStrategyMonitorStatus(strategyId: number) {
    try {
      const response = await fetch(
        `/api/control/strategies/executions?strategyId=${strategyId}&mode=monitor`,
        { cache: "no-store" },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        monitorStatus?: StrategyMonitorStatus | null;
      };
      if (!response.ok)
        throw new Error(result.error ?? "实时监听快照读取失败");
      setStrategyMonitorStatus(result.monitorStatus ?? null);
    } catch {
      setStrategyLogRealtime((current) => ({
        status: "DELAYED",
        lastSyncAt: current.lastSyncAt,
      }));
    }
  }

  async function loadStrategyExecutionDetail(traceId: string) {
    setStrategyExecutionDetailBusy(true);
    try {
      const response = await fetch(
        `/api/control/strategies/executions/${encodeURIComponent(traceId)}`,
        { cache: "no-store" },
      );
      const result = (await readJsonResponse(response)) as {
        error?: string;
        execution?: StrategyExecutionTrace;
        events?: StrategyExecutionEvent[];
        evidence?: StrategyPositionEvidence[];
        postEntryAnalysis?: StrategyPostEntryAnalysis | null;
        configValidation?: StrategyExecutionDetail["configValidation"];
        suggestions?: StoredStrategyParameterSuggestion[];
      };
      if (!response.ok || !result.execution)
        throw new Error(result.error ?? "执行链路详情加载失败");
      setStrategyExecutionDetail({
        execution: result.execution,
        events: result.events ?? [],
        evidence: result.evidence ?? [],
        postEntryAnalysis: result.postEntryAnalysis ?? null,
        configValidation: result.configValidation,
        suggestions: result.suggestions ?? [],
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "执行链路详情加载失败");
    } finally {
      setStrategyExecutionDetailBusy(false);
    }
  }

  async function openStrategyExecutionLog(
    strategy: ConfiguredStrategy,
    viewMode: "LOGS" | "LEARNING" = "LOGS",
  ) {
    const openedAt = Date.now();
    setCreatingStrategy(false);
    setConfiguredStrategy(strategy);
    setStrategyExecutionTarget(strategy);
    setStrategyExecutions([]);
    setStrategyExecutionDetail(null);
    setStrategyLearningProgress(null);
    setStrategyMonitorStatus(null);
    setStrategyExecutionViewMode(viewMode);
    strategyLogOpenedAtRef.current = openedAt;
    strategyLogSinceRef.current = openedAt;
    setStrategyLogRealtime({ status: "CONNECTING", lastSyncAt: null });
    setStrategyExecutionPanelOpen(true);
    setActive("strategyLogs");
    // Seed the page with the latest durable business records first. Realtime
    // polling then merges changes produced after the page was opened.
    const executions = await loadStrategyExecutions(strategy.id, false, true);
    if (viewMode === "LEARNING") {
      const reviewExecution =
        executions.find(
          (execution) =>
            execution.state === "CLOSED" &&
            Boolean(execution.positionId || execution.exchangeOrderId),
        ) ??
        executions.find((execution) =>
          Boolean(execution.positionId || execution.exchangeOrderId),
        ) ??
        executions[0];
      if (reviewExecution)
        await loadStrategyExecutionDetail(reviewExecution.traceId);
    }
  }

  async function saveConfiguredStrategy(publishAfterSave = false) {
    if (!strategyConfig.name.trim()) {
      setToast("请先填写策略名称");
      return;
    }
    if (!strategyNetProfitPathReady) {
      setToast("分批止盈必须覆盖全部仓位，并形成手续费后的有效净获利路径");
      return;
    }
    if (!strategyFundingConfigurationReady) {
      setToast("当前最低名义价值超过保证金额度与杠杆能够支持的上限，请先调整资金参数");
      return;
    }
    setAutomationBusy(true);
    try {
      const latestConfiguredStrategy = !creatingStrategy && configuredStrategy
        ? configuredStrategies.find((item) => item.id === configuredStrategy.id) ??
          configuredStrategy
        : null;
      const configPayload = strategyTypeDraft === "SIMPLE_REBOUND"
        ? { ...SIMPLE_REBOUND_CONFIG, triggerKind: "SIMPLE_REBOUND" as const }
        : {
            ...strategyConfig,
            accountId: undefined,
            name: undefined,
            maxSymbols: strategyConfig.selectedSymbols.length,
          };
      const response = await fetch("/api/control/strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategyId: latestConfiguredStrategy?.id,
          expectedConfigVersion: latestConfiguredStrategy
            ? latestConfiguredStrategy.configVersion
            : undefined,
          expectedDraftVersion: latestConfiguredStrategy
            ? latestConfiguredStrategy.draftVersion
            : undefined,
          accountId: strategyConfig.accountId,
          name: strategyConfig.name,
          strategyType: latestConfiguredStrategy?.strategyType ?? strategyTypeDraft,
          symbolScope:
            strategyTypeDraft === "SIMPLE_REBOUND"
              ? "TOP_VOLUME_30"
              : strategyConfig.selectedSymbols.join(",") || "POOL",
          config: configPayload,
          acceptedSuggestionIds: latestConfiguredStrategy
            ? acceptedStrategySuggestionIds
            : [],
          clientParameterProfileVersion:
            STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION,
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        strategy?: ConfiguredStrategy;
      };
      if (!response.ok || !result.strategy)
        throw new Error(result.error ?? "策略创建失败");
      let savedStrategy = result.strategy;
      if (publishAfterSave) {
        const publishResponse = await fetch("/api/control/strategies", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: savedStrategy.id,
            action: "PUBLISH_DRAFT",
            expectedDraftVersion:
              savedStrategy.draft?.version ??
              savedStrategy.draftVersion,
          }),
        });
        const publishResult = (await readJsonResponse(
          publishResponse,
        )) as {
          error?: string;
          strategy?: ConfiguredStrategy;
          strategyRisk?: {
            dailyLossLimitUsdt?: number;
          };
        };
        if (!publishResponse.ok || !publishResult.strategy)
          throw new Error(
            publishResult.error ?? "策略草稿发布失败",
          );
        savedStrategy = publishResult.strategy;
        const requestedDailyLossLimit =
          liquidationRiskUi(configPayload)?.dailyLossLimitUsdt;
        const publishedDailyLossLimit =
          liquidationRiskUi(savedStrategy.config)?.dailyLossLimitUsdt;
        if (
          Number.isFinite(requestedDailyLossLimit) &&
          (publishedDailyLossLimit !== requestedDailyLossLimit ||
            publishResult.strategyRisk?.dailyLossLimitUsdt !==
              requestedDailyLossLimit)
        )
          throw new Error(
            "策略已保存但运行参数核对不一致，系统已阻止显示成功，请刷新后重试",
          );
      }
      strategyLifecycleEpochRef.current += 1;
      setConfiguredStrategies((current) => {
        const next = current.filter((item) => item.id !== savedStrategy.id);
        return [savedStrategy, ...next];
      });
      setCreatingStrategy(false);
      setConfiguredStrategy(savedStrategy);
      setStrategyConfig(strategyEditorConfig(savedStrategy));
      setAcceptedStrategySuggestionIds([]);
      closeStrategyConfigDialog();
      setPreflight(null);
      setToast(
        publishAfterSave
          ? `V${savedStrategy.publishedVersion ?? savedStrategy.configVersion} 已保存并生效；新订单使用最新参数，已有仓位继续使用原绑定版本`
          : "仅保存为草稿，当前实盘参数不会改变",
      );
      await loadStrategyLifecycle();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "策略创建失败");
    } finally {
      setAutomationBusy(false);
    }
  }

  async function changeStrategyStatus(
    strategy: ConfiguredStrategy,
    status: "RUNNING" | "PAUSED",
  ) {
    setAutomationBusy(true);
    try {
      const response = await fetch("/api/control/strategies", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: strategy.id, status }),
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "策略状态更新失败");
      setToast(`${strategy.name}${status === "RUNNING" ? "已启动" : "已暂停"}`);
      await loadStrategyLifecycle();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "策略状态更新失败");
    } finally {
      setAutomationBusy(false);
    }
  }

  async function deleteStrategy() {
    if (!deleteStrategyTarget || deleteStrategyBusy) return;
    setDeleteStrategyBusy(true);
    try {
      const response = await fetch("/api/control/strategies", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: deleteStrategyTarget.id,
          confirmation: "DELETE_STRATEGY_AND_RELATED_RECORDS",
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        name?: string;
        purged?: {
          versions: number;
          executionTraces: number;
          executionEvents: number;
          positionEvidence: number;
          parameterSuggestions: number;
        };
      };
      if (!response.ok) throw new Error(result.error ?? "策略删除失败");
      const deletedId = deleteStrategyTarget.id;
      const deletedName = result.name ?? deleteStrategyTarget.name;
      setDeleteStrategyTarget(null);
      if (configuredStrategy?.id === deletedId) setConfiguredStrategy(null);
      if (strategyExecutionTarget?.id === deletedId) {
        setStrategyExecutionTarget(null);
        setStrategyExecutionPanelOpen(false);
        setStrategyExecutionDetail(null);
        setStrategyExecutions([]);
      }
      await loadStrategyLifecycle();
      const cleared = result.purged
        ? Object.values(result.purged).reduce((sum, count) => sum + count, 0)
        : 0;
      setToast(`${deletedName} 已删除，已清理 ${cleared} 条关联记录`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "策略删除失败");
    } finally {
      setDeleteStrategyBusy(false);
    }
  }

  async function rollbackStrategyVersion() {
    if (!rollbackVersionTarget || !configuredStrategy) return;
    setAutomationBusy(true);
    try {
      const response = await fetch("/api/control/strategies", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: configuredStrategy.id,
          rollbackVersion: rollbackVersionTarget.version,
          confirmation: "ROLLBACK_STRATEGY_CONFIG",
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        strategy?: ConfiguredStrategy;
        sourceVersion?: number;
      };
      if (!response.ok) throw new Error(result.error ?? "策略版本回滚失败");
      setRollbackVersionTarget(null);
      setPreflight(null);
      await loadStrategyLifecycle();
      setToast(
        `已基于 V${result.sourceVersion ?? rollbackVersionTarget.version} 创建回滚草稿；发布前不会影响实盘和已有仓位`,
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "策略版本回滚失败");
    } finally {
      setAutomationBusy(false);
    }
  }

  function openVersionMetadataEditor(version: StrategyConfigVersion) {
    setVersionMetadataTarget(version);
    setVersionMetadataForm({
      versionLabel: version.versionLabel ?? "",
      note: version.note ?? "",
      isBaseline: version.isBaseline,
    });
  }

  async function saveStrategyVersionMetadata() {
    if (!versionMetadataTarget || !configuredStrategy) return;
    setAutomationBusy(true);
    try {
      const response = await fetch("/api/control/strategies", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: configuredStrategy.id,
          versionMetadata: {
            version: versionMetadataTarget.version,
            ...versionMetadataForm,
          },
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        version?: StrategyConfigVersion;
      };
      if (!response.ok || !result.version)
        throw new Error(result.error ?? "版本标记保存失败");
      setVersionMetadataTarget(null);
      await loadStrategyLifecycle();
      setToast(
        `V${result.version.version} 标记已保存${result.version.isBaseline ? "，并设为对比基准" : ""}`,
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "版本标记保存失败");
    } finally {
      setAutomationBusy(false);
    }
  }

  function buildStrategyVersionDiff(
    base: StrategyConfigVersion | undefined,
    target: StrategyConfigVersion | undefined,
  ) {
    if (!base || !target) return [];
    const fields: Array<{
      key: string;
      label: string;
      read: (version: StrategyConfigVersion) => unknown;
    }> = [
      {
        key: "accountId",
        label: "运行账户",
        read: (version) => version.accountId,
      },
      {
        key: "symbolScope",
        label: "合约范围",
        read: (version) => version.symbolScope,
      },
      {
        key: "triggerNotional",
        label: "爆仓触发金额",
        read: (version) =>
          liquidationTriggerUi(version.config)?.minLiquidationNotionalUsdt ??
          "—",
      },
      {
        key: "clusterEvents",
        label: "连续事件",
        read: (version) =>
          liquidationTriggerUi(version.config)?.minClusterEvents ?? "—",
      },
      {
        key: "minimumPositionNotionalUsdt",
        label: "最低开仓名义价值",
        read: (version) =>
          liquidationExecutionUi(version.config)
            ?.minimumPositionNotionalUsdt ?? 15,
      },
      {
        key: "equityAllocationPercent",
        label: "单笔可用资金分配",
        read: (version) =>
          liquidationExecutionUi(version.config)
            ?.equityAllocationPercent ?? 5,
      },
      {
        key: "maxOrderMarginUsdt",
        label: "单笔最大保证金",
        read: (version) =>
          liquidationExecutionUi(version.config)?.maxOrderMarginUsdt ?? "—",
      },
      {
        key: "leverage",
        label: "策略杠杆",
        read: (version) =>
          liquidationExecutionUi(version.config)?.leverage ??
          version.config.leverage,
      },
      {
        key: "stopLossPercent",
        label: "止损 ROE",
        read: (version) =>
          liquidationRiskUi(version.config)?.stopLossPercent ??
          version.config.stopLossPercent,
      },
      {
        key: "takeProfitSteps",
        label: "分批止盈",
        read: (version) =>
          strategyVersionTakeProfitSummary(version.config),
      },
      {
        key: "direction",
        label: "交易方向",
        read: (version) =>
          liquidationConfigShape(version.config)
            ? liquidationDirection(version.config)
            : version.config.direction,
      },
    ];
    return fields.map((field) => {
      const before = String(field.read(base) ?? "—");
      const after = String(field.read(target) ?? "—");
      return {
        key: field.key,
        label: field.label,
        before,
        after,
        changed: before !== after,
      };
    });
  }

  function strategyVersionTakeProfitSummary(config: Record<string, unknown>) {
    const steps = liquidationRiskUi(config)?.takeProfitSteps;
    if (steps?.length) {
      return steps
        .map((step) => `${step.profitPercent}%/${step.closePercent}%`)
        .join("，");
    }
    return config.takeProfitPercent ?? "—";
  }

  function strategyVersionTriggerSummary(config: Record<string, unknown>) {
    const trigger = liquidationTriggerUi(config);
    if (!trigger) {
      return `${String(config.lookback ?? "—")} 根`;
    }
    return `${trigger.minLiquidationNotionalUsdt ?? "—"} USDT · ${trigger.minClusterEvents ?? "—"} 次`;
  }

  function strategyVersionFundingSummary(config: Record<string, unknown>) {
    const execution = liquidationExecutionUi(config);
    if (!execution) {
      return `${String(config.momentumThresholdPercent ?? "—")}%`;
    }
    return `可用资金 ${execution.equityAllocationPercent ?? 5}% · 最低名义 ${execution.minimumPositionNotionalUsdt ?? 15} USDT · ${execution.leverage}倍杠杆 · 单笔保证金上限 ${execution.maxOrderMarginUsdt ?? "—"} USDT · 并行仓位由 Binance 可用保证金决定`;
  }

  function strategyVersionRiskSummary(config: Record<string, unknown>) {
    const risk = liquidationRiskUi(config);
    const stopLoss = risk?.stopLossPercent ?? config.stopLossPercent ?? "—";
    return `${String(stopLoss)}% / ${String(strategyVersionTakeProfitSummary(config))}`;
  }

  function exportStrategyVersionDiff(
    rows: ReturnType<typeof buildStrategyVersionDiff>,
    baseVersion: number,
    targetVersion: number,
  ) {
    const csvRows = rows.map((row) => [
      row.label,
      row.before,
      row.after,
      row.changed ? "已变化" : "未变化",
    ]);
    const csv = [
      ["参数", `V${baseVersion}`, `V${targetVersion}`, "结果"],
      ...csvRows,
    ]
      .map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nexus-quant-strategy-version-diff-v${baseVersion}-v${targetVersion}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportStrategyVersionVerification(
    versions: StrategyConfigVersion[],
  ) {
    const rows = versions.map((version) => [
      `V${version.version}`,
      version.versionLabel ?? "",
      version.isBaseline ? "是" : "否",
      new Date(version.createdAt).toLocaleString("zh-CN", {
        hour12: false,
      }),
      version.note ?? "",
    ]);
    const csv = [
      ["版本", "标签", "对比基准", "保存时间", "备注"],
      ...rows,
    ]
      .map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nexus-quant-strategy-version-verification-${configuredStrategy?.id ?? "all"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function addStrategyScopeContract(symbol: string) {
    const plugin = STRATEGY_PLUGIN_CATALOG.find(
      (entry) => entry.id === strategyPluginId(strategyConfig),
    );
    if (
      plugin &&
      !strategyConfig.selectedSymbols.includes(symbol.trim().toUpperCase()) &&
      strategyConfig.selectedSymbols.length >= plugin.maximumSymbols
    ) {
      setToast(`${plugin.label}最多选择 ${plugin.maximumSymbols} 个固定合约`);
      return;
    }
    setStrategyConfig((current) => {
      const selectedSymbols = addStrategyScopeSymbol(
        current.selectedSymbols,
        symbol,
      );
      return {
        ...current,
        assetClassScope: "CUSTOM" as StrategyAssetClassScope,
        selectedSymbols,
        maxSymbols: selectedSymbols.length,
      };
    });
    setStrategyScopeQuery("");
  }

  function removeStrategyScopeContract(symbol: string) {
    setStrategyConfig((current) => {
      const selectedSymbols = removeStrategyScopeSymbol(
        current.selectedSymbols,
        symbol,
      );
      return {
        ...current,
        selectedSymbols,
        maxSymbols: selectedSymbols.length,
      };
    });
  }

  function openManagedStrategy(
    strategy: ConfiguredStrategy,
    openConfig = false,
  ) {
    const nextConfig = strategyEditorConfig(strategy);
    setCreatingStrategy(false);
    setConfiguredStrategy(strategy);
    setAcceptedStrategySuggestionIds([]);
    setStrategyConfig(nextConfig);
    setActive("auto");
    setStrategyScopeQuery("");
    if (openConfig) {
      showStrategyConfigRef.current = true;
      window.setTimeout(openStrategyConfigDialog, 0);
    }
  }

  function applyAggregateSuggestionToDraft(
    suggestion: StoredStrategyParameterSuggestion,
  ) {
    if (!strategyExecutionTarget) return;
    if (
      !strategyExecutionDetail ||
      strategyExecutionDetail.execution.configVersion !==
        strategyExecutionTarget.configVersion
    ) {
      setToast("该建议来自历史参数版本，仅供复盘，不能带入当前策略");
      return;
    }
    const base = strategyEditorConfig(strategyExecutionTarget);
    const next = applyStrategySuggestionValue(
      base,
      suggestion.parameterName,
      suggestion.suggestedValue,
    );
    if (!next) {
      setToast("该建议属于观察项，不能直接带入交易参数");
      return;
    }
    setCreatingStrategy(false);
    setConfiguredStrategy(strategyExecutionTarget);
    setAcceptedStrategySuggestionIds([suggestion.id]);
    setStrategyConfig(next);
    setStrategyScopeQuery("");
    setActive("auto");
    showStrategyConfigRef.current = true;
    window.setTimeout(openStrategyConfigDialog, 0);
    setToast("建议值已带入参数草稿；检查并发布后，新订单才会使用");
  }

  function beginNewStrategy() {
    setStrategyTypeDraft("LIQ_CHASE");
    setCreatingStrategy(true);
    setConfiguredStrategy(null);
    setAcceptedStrategySuggestionIds([]);
    const account = tradingAccounts.find((item) => item.isActive) ?? null;
    setStrategyConfig(
      defaultLiquidationStrategyConfig(
        account?.accountId ?? "bys-main",
        "",
        "BOTH",
      ),
    );
    setActive("auto");
    setStrategyScopeQuery("");
    showStrategyConfigRef.current = true;
    window.setTimeout(openStrategyConfigDialog, 0);
  }

  function beginNewSimpleReboundStrategy() {
    setStrategyTypeDraft("SIMPLE_REBOUND");
    setCreatingStrategy(true);
    setConfiguredStrategy(null);
    setAcceptedStrategySuggestionIds([]);
    const account = tradingAccounts.find((item) => item.isActive) ?? null;
    setStrategyConfig(
      defaultLiquidationStrategyConfig(
        account?.accountId ?? "bys-main",
        "",
        "LONG_ONLY",
      ),
    );
    setActive("auto");
    setStrategyScopeQuery("");
    showStrategyConfigRef.current = true;
    window.setTimeout(openStrategyConfigDialog, 0);
  }

  async function fetchCurrentManualMarkPrice(targetSymbol: string) {
    const normalized = targetSymbol.trim().toUpperCase();
    const response = await fetch(
      `/api/control/live-position-marks?symbol=${encodeURIComponent(normalized)}`,
      { cache: "no-store" },
    );
    const result = (await readJsonResponse(response)) as {
      error?: string;
      rows?: Array<{
        symbol: string;
        markPrice: number;
        receivedAt?: number;
        time?: number;
      }>;
    };
    if (!response.ok)
      throw new Error(result.error ?? "Binance 实时标记价格读取失败");
    const row = result.rows?.find(
      (item) =>
        item.symbol === normalized &&
        Number.isFinite(item.markPrice) &&
        item.markPrice > 0,
    );
    if (!row) throw new Error(`${normalized} 实时标记价格暂不可用，未创建订单`);
    const receivedAt = Number(row.receivedAt ?? row.time ?? 0);
    if (
      !Number.isFinite(receivedAt) ||
      receivedAt <= 0 ||
      Date.now() - receivedAt > 2_000
    )
      throw new Error(`${normalized} 实时标记价格已过期，未创建订单`);
    return row.markPrice;
  }

  async function submitOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTradingAccount)
      return setToast("请先在子账号管理新增并启用子账户");
    if (selectedTradingAccount.executionMode !== "LIVE")
      return setToast(
        "生产环境仅允许实盘交易，请先到账户管理完成密钥校验并启用实盘",
      );
    if (
      selectedTradingAccount.executionMode === "LIVE" &&
      !selectedTradingAccount.tradeReadiness.liveReady
    )
      return setToast(
        `该账户尚未达到实盘就绪条件：${selectedTradingAccount.tradeReadiness.blockers.join("；")}。请到账户管理处理`,
      );
    try {
      if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol.trim().toUpperCase()))
        throw new Error("请输入有效的 Binance USDT 永续合约代码");
      const currentMarkPrice = await fetchCurrentManualMarkPrice(symbol);
      if (!orderQuantityValid)
        throw new Error(
          `下单数量不能低于 ${orderQuantityMinimum}，且必须按 ${orderQuantityStep} 的步长递增`,
        );
      if (!Number.isInteger(leverage) || leverage < 1)
        throw new Error("人工下单杠杆必须为大于等于 1 的整数，由 Binance 按合约档位校验上限");
      if (
        orderType === "限价单" &&
        (
          !Number.isFinite(orderPrice) ||
          orderPrice <= 0 ||
          Math.abs(orderPrice - currentMarkPrice) / currentMarkPrice > 0.2
        )
      )
        throw new Error("限价无效或偏离 Binance 实时价格超过 20%");
      if (
        orderType === "限价单" &&
        (!Number.isInteger(manualLimitTtlMinutes) ||
          manualLimitTtlMinutes < 1 ||
          manualLimitTtlMinutes > 3)
      )
        throw new Error("限价自动撤单时间需为 1–3 分钟");
      if (!riskRangesValid)
        throw new Error("止盈和止损必须大于 0，结束幅度不能小于起始幅度");
      const credential = exchangeCredentials.find(
        (item) => item.accountId === orderAccountId,
      );
      if (!credential?.liveTradingEnabled)
        throw new Error("该子账户实盘密钥未校验或实盘开关未启用");
      const confirmationText =
        orderType === "限价单"
          ? `LIVE ${orderAccountId} ${symbol} ${side === "LONG" ? "BUY" : "SELL"} ${orderQuantity} LIMIT ${orderPrice}`
          : `LIVE ${orderAccountId} ${symbol} ${side === "LONG" ? "BUY" : "SELL"} ${orderQuantity}`;
      const normalizedSymbol = symbol.trim().toUpperCase();
      const sameSymbolMarginUsdt = livePositions
        .filter(
          (position) =>
            position.accountId === orderAccountId &&
            position.symbol === normalizedSymbol &&
            ["OPEN", "EXECUTION_UNKNOWN"].includes(position.status),
        )
        .reduce(
          (sum, position) =>
            sum +
            position.quantity *
              (position.markPrice > 0 ? position.markPrice : position.entryPrice) /
              Math.max(1, position.leverage),
          0,
        );
      const riskAdvisory = buildManualOrderRiskAdvisory({
        entryPrice:
          orderType === "限价单" ? orderPrice : currentMarkPrice,
        quantity: orderQuantity,
        leverage,
        stopLossRoePercents:
          stopLossPlan.map((level) => level.triggerPercent),
        trailingEnabled,
        accountUsableEquityUsdt: selectedTradingAccount.stats.usableEquity,
        currentCommittedMarginUsdt:
          selectedTradingAccount.stats.committedMargin,
        sameSymbolMarginUsdt,
      });
      setManualOrderConfirmation({
        credentialId: credential.id,
        accountId: orderAccountId,
        symbol,
        positionSide: side,
        orderType: orderType === "限价单" ? "LIMIT" : "MARKET",
        orderTypeLabel: orderType,
        price: orderType === "限价单" ? orderPrice : undefined,
        referencePrice: currentMarkPrice,
        quantity: orderQuantity,
        leverage,
        takeProfitPlan: takeProfitPlan.map((level) => ({ ...level })),
        stopLossPlan: trailingEnabled
          ? []
          : stopLossPlan.map((level) => ({ ...level })),
        capitalPreservationStopRoePercent: Math.max(
          ...stopLossPlan.map((level) => level.triggerPercent),
        ),
        trailingActivationPercent: trailingEnabled
          ? trailingActivationPercent
          : 0,
        trailingStopPercent: trailingEnabled ? manualTrailingStopPercent : 0,
        cancelAfterMinutes:
          orderType === "限价单" ? manualLimitTtlMinutes : undefined,
        confirmation: confirmationText,
        idempotencyKey: createClientRequestId().replaceAll("-", ""),
        riskAdvisory,
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "订单参数检查失败");
    }
  }

  async function confirmManualOrder() {
    const draft = manualOrderConfirmation;
    if (!draft || orderSubmitting) return;
    setOrderSubmitting(true);
    try {
      const currentMarkPrice = await fetchCurrentManualMarkPrice(draft.symbol);
      if (
        draft.orderType === "LIMIT" &&
        (
          !Number.isFinite(draft.price) ||
          Number(draft.price) <= 0 ||
          Math.abs(Number(draft.price) - currentMarkPrice) /
              currentMarkPrice >
            0.2
        )
      )
        throw new Error("确认时限价已偏离 Binance 实时价格超过 20%，未提交订单");
      const response = await fetch("/api/control/live-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId: draft.credentialId,
          symbol: draft.symbol,
          positionSide: draft.positionSide,
          orderType: draft.orderType,
          price: draft.price,
          quantity: draft.quantity,
          leverage: draft.leverage,
          takeProfitPlan: draft.takeProfitPlan,
          stopLossPlan: draft.stopLossPlan,
          capitalPreservationStopRoePercent:
            draft.capitalPreservationStopRoePercent,
          trailingActivationPercent: draft.trailingActivationPercent,
          trailingStopPercent: draft.trailingStopPercent,
          cancelAfterMinutes: draft.cancelAfterMinutes,
          confirmation: draft.confirmation,
          idempotencyKey: draft.idempotencyKey,
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        pending?: boolean;
        maximumLeverage?: number | null;
        effectiveLeverage?: number;
        leverageAdjusted?: boolean;
        order?: { clientOrderId: string };
        position?: LivePosition;
      };
      if (!response.ok) {
        if (
          Number.isInteger(result.maximumLeverage) &&
          Number(result.maximumLeverage) >= 1
        )
          setManualAccountLeverageCaps((current) => ({
            ...current,
            [`${draft.accountId}:${draft.symbol.trim().toUpperCase()}`]:
              Number(result.maximumLeverage),
          }));
        throw new Error(result.error ?? "实盘订单提交失败");
      }
      const clientOrderId =
        result.order?.clientOrderId ?? draft.symbol;
      if (result.position) {
        setLivePositions((current) =>
          upsertSubmittedPosition(current, result.position!),
        );
        setPositionsLoaded(true);
      }
      const leverageMessage = result.leverageAdjusted
        ? `；Binance 实际采用 ${result.effectiveLeverage}× 杠杆`
        : "";
      const successMessage = result.position
        ? `实盘${draft.orderTypeLabel}已成交：${clientOrderId}${leverageMessage}`
        : result.pending && draft.orderType === "LIMIT"
          ? `${draft.symbol} 限价单已挂入 Binance；${draft.cancelAfterMinutes} 分钟未成交将自动撤单${leverageMessage}`
          : `${draft.symbol} 订单已提交 Binance，成交结果和仓位正在确认：${clientOrderId}${leverageMessage}`;
      setToast(`${successMessage}；正在同步订单与仓位列表`);
      void synchronizeSubmittedOrderLists(clientOrderId).then((synchronized) => {
        setToast(
          synchronized
            ? `${successMessage}；列表已同步`
            : `${successMessage}；成交已确认，列表仍在后台核对，请勿重复下单`,
        );
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "订单保存失败");
    } finally {
      setOrderSubmitting(false);
      setManualOrderConfirmation(null);
    }
  }

  function selectManualSymbol(nextSymbol: string) {
    const normalized = nextSymbol.trim().toUpperCase();
    setSymbol(normalized);
    const target = pool.find(
      (item) => item.enabled && item.symbol === normalized,
    );
    if (target) {
      setOrderQuantity(
        alignQuantityUp(
          orderType === "市价单"
            ? effectiveMarketMinimumOrderQuantity(
                target.minOrderQty,
                target.quantityStep,
                target.minNotionalUsdt,
                target.price,
              )
            : effectiveMinimumOrderQuantity(
                target.minOrderQty,
                target.quantityStep,
                target.minNotionalUsdt,
                target.price,
              ),
          target.minOrderQty,
          target.quantityStep,
        ),
      );
      if (target.price > 0)
        setOrderPrice(
          Number(
            (Math.round(target.price / target.priceTickSize) * target.priceTickSize)
              .toPrecision(15),
          ),
        );
    }
    setManualSymbolSuggestionsOpen(false);
  }

  if (active === "market")
    return (
      <MarketHistoryView
        markets={pool}
        refreshVersion={workspaceRefreshVersion}
        marketStatus={marketStatus}
      />
    );

  if (active === "manual")
    return (
      <ManualOrderBoard
        tradingAccounts={tradingAccounts}
        exchangeCredentials={exchangeCredentials}
        selectedAccountId={orderAccountId}
        setSelectedAccountId={setOrderAccountId}
        pool={pool}
        setToast={setToast}
      />
    );

  if (active === "manualLegacy")
    return (
      <>
        <div className="work-page manual-layout">
          <form className="panel order-ticket" onSubmit={submitOrder}>
            <div className="panel-head">
              <div>
                <h2>人工下单</h2>
                <p>合约、账户、方向和风控参数在同一工作区完成</p>
              </div>
            </div>
            <section className="manual-basic-zone" aria-label="下单参数">
              <div className="manual-zone-heading">
                <b>下单参数</b>
                <small>先选合约、账户和方向，再设置数量、委托价格与杠杆</small>
              </div>
              <div className="manual-step-title">
                <i>1</i>
                <div>
                  <b>账户与方向</b>
                  <small>选择交易子账户后，立即确定做多或做空</small>
                </div>
              </div>
              <section className="manual-account-bar">
              <div className="manual-account-cluster">
                <label className="field">
                  <span>交易子账户</span>
                  <select
                    value={orderAccountId}
                    onChange={(event) => {
                      setOrderAccountId(event.target.value);
                    }}
                  >
                    {tradingAccounts
                      .filter(
                        (account) =>
                          account.isActive && account.accountType === "STRATEGY",
                      )
                      .map((account) => (
                        <option key={account.id} value={account.accountId}>
                          {account.accountId} · {account.name} ·{" "}
                          生产实盘
                        </option>
                      ))}
                  </select>
                </label>
                <p
                  className={`manual-account-status ${selectedTradingAccount?.executionMode !== "LIVE" || selectedTradingAccount?.tradeReadiness.blockers.length ? "is-blocked" : ""}`}
                >
                  <span>
                    {!selectedTradingAccount
                      ? "请先选择交易子账户"
                      : selectedTradingAccount.executionMode !== "LIVE"
                        ? "账户未就绪：请到账户管理完成密钥校验与实盘授权。"
                        : selectedTradingAccount.tradeReadiness.blockers.length
                          ? `账户未就绪：${selectedTradingAccount.tradeReadiness.blockers.join("；")}。`
                          : "账户就绪 · Binance 实盘"}
                  </span>
                  {selectedTradingAccount?.executionMode !== "LIVE" ||
                  selectedTradingAccount?.tradeReadiness.blockers.length ? (
                    <button type="button" onClick={() => setActive("accounts")}>
                      去处理
                    </button>
                  ) : null}
                </p>
              </div>
              <div className="manual-direction-field">
                <span>交易方向</span>
                <div className="segmented">
                  <button
                    type="button"
                    className={side === "LONG" ? "selected long-side" : ""}
                    onClick={() => setSide("LONG")}
                  >
                    多
                  </button>
                  <button
                    type="button"
                    className={side === "SHORT" ? "selected short-side" : ""}
                    onClick={() => setSide("SHORT")}
                  >
                    空
                  </button>
                </div>
              </div>
              </section>
              <div className="manual-step-title">
                <i>2</i>
                <div>
                  <b>合约、数量与杠杆</b>
                  <small>选择交易标的后，系统自动带出最小下单量</small>
                </div>
              </div>
              <section className="manual-entry-grid">
              <label className="field contract-symbol-field">
                <span>永续合约</span>
                <div
                  className="contract-symbol-picker"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                      setManualSymbolSuggestionsOpen(false);
                  }}
                >
                  <input
                    value={symbol}
                    onFocus={() => setManualSymbolSuggestionsOpen(true)}
                    onChange={(event) => {
                      setSymbol(event.target.value.toUpperCase());
                      setManualSymbolSuggestionsOpen(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setManualSymbolSuggestionsOpen(false);
                        return;
                      }
                      if (
                        event.key === "Enter" &&
                        manualSymbolSuggestionsOpen &&
                        manualSymbolSuggestions.length > 0
                      ) {
                        event.preventDefault();
                        selectManualSymbol(manualSymbolSuggestions[0].symbol);
                      }
                    }}
                    placeholder="输入字母，例如 ETH"
                    autoComplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={manualSymbolSuggestionsOpen}
                    aria-controls="manual-contract-suggestions"
                  />
                  {manualSymbolSuggestionsOpen && (
                    <div
                      id="manual-contract-suggestions"
                      className="contract-symbol-suggestions"
                      role="listbox"
                    >
                      {manualSymbolSuggestions.map((item) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={item.symbol === symbol}
                          key={item.symbol}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectManualSymbol(item.symbol)}
                        >
                          <span>
                            <b>{item.symbol}</b>
                            <small>{item.name}</small>
                          </span>
                          <span>
                            <b>
                              {item.price
                                ? item.price.toLocaleString("en-US", {
                                    maximumFractionDigits: 8,
                                  })
                                : "--"}
                            </b>
                            <small>
                              24h额{" "}
                              {typeof item.volume === "number"
                                ? `${Math.round(item.volume).toLocaleString("en-US")} USDT`
                                : "--"}
                            </small>
                          </span>
                        </button>
                      ))}
                      {manualSymbolSuggestions.length === 0 && (
                        <div className="contract-symbol-empty">
                          未找到符合条件的实盘合约
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <small>
                  {manualContractMarket?.symbol === symbol
                    ? `${symbol} Binance 可交易 · 实时标记价 ${manualContractMarket.price || "--"}`
                    : manualContractLoading
                      ? "正在直接校验 Binance 合约规则与实时标记价"
                      : manualContractError
                        ? manualContractError
                        : "请从合约池选择；未加入合约池的币种不会创建新订单"}
                </small>
              </label>
              <label className="field quantity-field">
                <span>下单数量</span>
                <NumberStepper
                  label="下单数量"
                  value={orderQuantity}
                  onChange={setOrderQuantity}
                  min={orderQuantityMinimum}
                  step={orderQuantityStep}
                  unit={symbol.replace("USDT", "") || "币"}
                />
                <div className="quantity-presets">
                  {[1, 2, 5, 10].map((multiple) => (
                    <button
                      type="button"
                      key={multiple}
                      onClick={() =>
                        setOrderQuantity(
                          alignQuantityUp(
                            orderQuantityMinimum * multiple,
                            orderQuantityMinimum,
                            orderQuantityStep,
                          ),
                        )
                      }
                    >
                      {multiple === 1 ? "最小量" : `${multiple}×`}
                    </button>
                  ))}
                </div>
                <small className={!orderQuantityValid ? "quantity-error" : ""}>
                  {orderType === "市价单" ? "市价安全最小量" : "限价实际最小量"}{" "}
                  {selectedMarket ? orderQuantityMinimum : "--"} · 交易所数量下限{" "}
                  {selectedMarket?.minOrderQty ?? "--"} · 最小名义金额{" "}
                  {selectedMarket?.minNotionalUsdt ?? "--"} USDT · 步长{" "}
                  {selectedMarket?.quantityStep ?? "--"}
                </small>
              </label>
              <label className="field manual-leverage-field">
                <span>杠杆倍数</span>
                <NumberStepper
                  label="杠杆倍数"
                  value={leverage}
                  onChange={setLeverage}
                  min={1}
                  max={manualLeverageMaximum}
                  step={1}
                  unit="×"
                />
                <small>
                  合约理论上限 {selectedMarket?.maxLeverage ? `${selectedMarket.maxLeverage}×` : "待同步"}；
                  {learnedManualLeverageCap
                    ? ` 当前账户已确认上限 ${learnedManualLeverageCap}×；`
                    : " 当前账户限制由 Binance 提交前确认；"}
                  本次上限 {Number.isFinite(manualLeverageMaximum) ? `${manualLeverageMaximum}×` : "由 Binance 提交前确认"}
                </small>
              </label>
              </section>
              <div className="manual-step-title">
                <i>3</i>
                <div>
                  <b>委托方式与价格</b>
                  <small>市价立即成交；限价进入订单簿，成交或到期撤单后由系统接管</small>
                </div>
              </div>
              <section className="manual-order-grid">
              <div className="manual-order-type-field">
                <span>委托类型</span>
                <div className="compact-choice">
                  {(["市价单", "限价单"] as const).map((type) => (
                    <button
                      type="button"
                      key={type}
                      className={orderType === type ? "active" : ""}
                      onClick={() => {
                        setOrderType(type);
                        if (selectedMarket?.price)
                          setOrderPrice(
                            type === "限价单"
                              ? Number(
                                  (
                                    Math.round(
                                      selectedMarket.price /
                                        selectedMarket.priceTickSize,
                                    ) * selectedMarket.priceTickSize
                                  ).toPrecision(15),
                                )
                              : selectedMarket.price,
                          );
                      }}
                    >
                      {type === "市价单" ? "市价" : "限价"}
                    </button>
                  ))}
                </div>
                <small>
                  {orderType === "限价单"
                    ? "GTC：等待成交，到期自动撤单释放资金"
                    : "按 Binance 实时价格成交"}
                </small>
              </div>
              <label className="field manual-order-price-field">
                <span>
                  {orderType === "限价单" ? "委托价格" : "实时参考价"}
                </span>
                <NumberStepper
                  label={orderType === "限价单" ? "委托价格" : "实时参考价"}
                  value={orderPrice}
                  onChange={setOrderPrice}
                  min={0.00000001}
                  step={Math.max(
                    selectedMarket?.priceTickSize ?? 0,
                    0.00000001,
                  )}
                  unit="USDT"
                  readOnly={orderType === "市价单"}
                />
                <small className={!orderPriceValid ? "quantity-error" : ""}>
                  {orderType === "限价单"
                    ? `价格步长 ${selectedMarket?.priceTickSize ?? "--"} · 最多偏离实时价 20%`
                    : "提交时再次获取最新价"}
                </small>
              </label>
              {orderType === "限价单" && (
                <label className="field manual-order-ttl-field">
                  <span>自动撤单时间</span>
                  <NumberStepper
                    label="自动撤单时间"
                    value={manualLimitTtlMinutes}
                    onChange={setManualLimitTtlMinutes}
                    min={1}
                    max={3}
                    step={1}
                    unit="分钟"
                  />
                  <small>最长挂单 3 分钟，为 Binance 撤单确认预留时间；部分成交先撤余量再按真实成交量建仓</small>
                </label>
              )}
              </section>
            </section>
            <div className="manual-step-title">
              <i>4</i>
              <div>
                <b>止盈、止损与移动止损</b>
                <small>全部按仓位收益率 ROE 计算，已包含杠杆影响</small>
              </div>
            </div>
            <section className="manual-protection-zone">
              <div className="manual-zone-heading">
                <b>止盈止损</b>
                <small>分批止盈、分批止损和移动保护统一按仓位 ROE 管理</small>
              </div>
              <div className="manual-risk-pair">
              <section className="manual-risk-plan">
                <div className="risk-plan-head">
                  <div>
                    <b>分批止盈区间网格</b>
                    <small>区间等距拆分；每格数量按 Binance 步长对齐</small>
                  </div>
                  <span>
                    期望 {takeProfitGrid.requestedGrids} / 实际{" "}
                    {generatedTakeProfitGrid.actualGrids} 格
                  </span>
                </div>
                <div className="risk-grid-controls">
                  <label>
                    <span>起始盈利 ROE</span>
                    <NumberStepper
                      label="止盈起始比例"
                      value={takeProfitGrid.startPercent}
                      onChange={(value) =>
                        setTakeProfitGrid({
                          ...takeProfitGrid,
                          startPercent: value,
                        })
                      }
                      min={0.00000001}
                      step={0.1}
                      nativeStep="any"
                      unit="%"
                    />
                  </label>
                  <label>
                    <span>结束盈利 ROE</span>
                    <NumberStepper
                      label="止盈结束比例"
                      value={takeProfitGrid.endPercent}
                      onChange={(value) =>
                        setTakeProfitGrid({
                          ...takeProfitGrid,
                          endPercent: value,
                        })
                      }
                      min={0.00000001}
                      step={0.1}
                      nativeStep="any"
                      unit="%"
                    />
                  </label>
                  <label>
                    <span>期望格数</span>
                    <NumberStepper
                      label="止盈格数"
                      value={takeProfitGrid.requestedGrids}
                      onChange={(value) =>
                        setTakeProfitGrid({
                          ...takeProfitGrid,
                          requestedGrids: value,
                        })
                      }
                      min={1}
                      max={10}
                      step={1}
                    />
                  </label>
                </div>
                <div className="risk-grid-preview">
                  {takeProfitPlan.map((level, index) => (
                    <span key={`tp-${index}`}>
                      <b>+{level.triggerPercent}% ROE</b>
                      <small>
                        {level.closeQuantity} {symbol.replace("USDT", "")}
                      </small>
                    </span>
                  ))}
                </div>
                {generatedTakeProfitGrid.reduced && (
                  <small className="grid-adjustment">
                    {generatedTakeProfitGrid.exitPolicy.mode === "SINGLE_FULL_EXIT"
                      ? `当前名义价值不足以安全拆分，实际将在首档整仓退出（分档门槛 ${generatedTakeProfitGrid.exitPolicy.stagedThresholdUsdt?.toFixed(2)} USDT）。`
                      : `单格低于最小可成交量 ${generatedTakeProfitGrid.minimum}，已自动减格并合并数量。`}
                  </small>
                )}
              </section>
              <section className="manual-risk-plan stop-plan">
                <div className="risk-plan-head">
                  <div>
                    <b>分批止损区间网格</b>
                    <small>亏损区间等距拆分；最后一格自动接收全部余量</small>
                  </div>
                  <span>
                    期望 {stopLossGrid.requestedGrids} / 实际{" "}
                    {generatedStopLossGrid.actualGrids} 格
                  </span>
                </div>
                <div className="risk-grid-controls">
                  <label>
                    <span>起始亏损 ROE</span>
                    <NumberStepper
                      label="止损起始比例"
                      value={stopLossGrid.startPercent}
                      onChange={(value) =>
                        setStopLossGrid({
                          ...stopLossGrid,
                          startPercent: value,
                        })
                      }
                      min={0.00000001}
                      step={0.1}
                      nativeStep="any"
                      unit="%"
                      readOnly={trailingEnabled}
                    />
                  </label>
                  <label>
                    <span>结束亏损 ROE</span>
                    <NumberStepper
                      label="止损结束比例"
                      value={stopLossGrid.endPercent}
                      onChange={(value) =>
                        setStopLossGrid({ ...stopLossGrid, endPercent: value })
                      }
                      min={0.00000001}
                      step={0.1}
                      nativeStep="any"
                      unit="%"
                      readOnly={trailingEnabled}
                    />
                  </label>
                  <label>
                    <span>期望格数</span>
                    <NumberStepper
                      label="止损格数"
                      value={stopLossGrid.requestedGrids}
                      onChange={(value) =>
                        setStopLossGrid({
                          ...stopLossGrid,
                          requestedGrids: value,
                        })
                      }
                      min={1}
                      max={10}
                      step={1}
                      readOnly={trailingEnabled}
                    />
                  </label>
                </div>
                <div className="risk-grid-preview">
                  {stopLossPlan.map((level, index) => (
                    <span key={`sl-${index}`}>
                      <b>-{level.triggerPercent}% ROE</b>
                      <small>
                        {level.closeQuantity} {symbol.replace("USDT", "")}
                      </small>
                    </span>
                  ))}
                </div>
                {generatedStopLossGrid.reduced && (
                  <small className="grid-adjustment">
                    单格低于最小量 {generatedStopLossGrid.minimum}
                    ，已自动减格并合并数量。
                  </small>
                )}
              </section>
              </div>
              <section
                className={`manual-trailing-plan ${trailingEnabled ? "enabled" : ""}`}
              >
              <div>
                <b>移动止损</b>
                <small>
                  开启后固定止损网格不参与执行；系统按净成本、ATR与峰值ROE保护利润，保护线只收紧
                </small>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={trailingEnabled}
                  onChange={(event) => setTrailingEnabled(event.target.checked)}
                />
                <i></i>
              </label>
              {trailingEnabled && (
                <div className="form-grid">
                  <label className="field">
                    <span>盈利启动 ROE</span>
                    <NumberStepper
                      label="移动止损启动阈值"
                      value={trailingActivationPercent}
                      onChange={setTrailingActivationPercent}
                      min={0.1}
                      max={100}
                      step={0.1}
                      unit="%"
                    />
                    <small>仓位ROE达到该值前不启用</small>
                  </label>
                  <label className="field">
                    <span>峰值ROE回撤</span>
                    <NumberStepper
                      label="移动止损峰值回撤"
                      value={manualTrailingStopPercent}
                      onChange={setManualTrailingStopPercent}
                      min={0.1}
                      max={50}
                      step={0.1}
                      unit="%"
                    />
                    <small>从峰值ROE回撤该百分点时触发</small>
                  </label>
                </div>
              )}
              </section>
            </section>
            <div className="security-note live-risk-disclosure">
              <b>实盘自动风控</b>
              <span>
                ROE = 未实现盈亏 ÷ 初始保证金，已包含杠杆影响。参数随实盘仓位保存，后台按 Binance
                标记价格计算ROE并执行只减仓；浏览器关闭后仍持续运行。
              </span>
            </div>
            <button
              className={`${side === "LONG" ? "submit-order long-order" : "submit-order short-order"} live-submit-order`}
              disabled={
                !can("trade:manual:create") ||
                orderSubmitting ||
                selectedTradingAccount?.executionMode !== "LIVE" ||
                Boolean(
                  selectedTradingAccount?.tradeReadiness.blockers.length,
                ) ||
                !selectedPoolContract ||
                !orderQuantityValid ||
                !orderPriceValid ||
                !riskRangesValid
              }
            >
              {!can("trade:manual:create")
                ? "当前角色为只读"
                : selectedTradingAccount?.executionMode !== "LIVE"
                  ? "请到账户管理启用实盘"
                  : selectedTradingAccount?.tradeReadiness.blockers.length
                    ? "账户未就绪，请到账户管理处理"
                    : !selectedPoolContract
                      ? "请先到合约池搜索添加该合约"
                    : orderSubmitting
                      ? "正在向 Binance 核对合约规则和实时价格…"
                      : !orderQuantityValid
                            ? "数量不符合最小量或步长"
                            : !orderPriceValid
                              ? "限价无效或偏离实时价格超过 20%"
                              : !riskRangesValid
                                ? "止盈止损区间设置无效"
                                : `提交实盘${side === "LONG" ? "做多" : "做空"}${orderType}`}
            </button>
          </form>
          <aside className="order-context">
            <article className="panel">
              <div className="panel-head">
                <div>
                  <h2>{symbol || "未选择合约"} 行情</h2>
                  <p>
                    {manualContractMarket?.symbol === symbol &&
                    manualContractMarket.price > 0
                      ? `Binance 当前合约 · ${new Date(manualContractMarket.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                      : manualContractLoading
                        ? "正在核对 Binance 当前合约与实时价格"
                        : manualContractError ||
                          "先从合约池选择，再核对 Binance 实时规则和价格"}
                  </p>
                </div>
                <span className="market-change-24h">
                  <small>24h涨跌</small>
                  <b
                    className={
                      (selectedMarket?.change ?? 0) >= 0
                        ? "positive"
                        : "negative"
                    }
                  >
                    {selectedMarket
                      ? `${selectedMarket.change >= 0 ? "+" : ""}${selectedMarket.change.toFixed(2)}%`
                      : "--"}
                  </b>
                </span>
              </div>
              <strong className="quote">
                {selectedMarket?.price
                  ? selectedMarket.price.toLocaleString("en-US", {
                      maximumFractionDigits: 8,
                    })
                  : "--"}
              </strong>
              <div className="quote-grid">
                <span>
                  24h 最高
                  <b>
                    {selectedMarket?.high
                      ? selectedMarket.high.toLocaleString("en-US")
                      : "--"}
                  </b>
                </span>
                <span>
                  24h 最低
                  <b>
                    {selectedMarket?.low
                      ? selectedMarket.low.toLocaleString("en-US")
                      : "--"}
                  </b>
                </span>
                <span>
                  24h 成交额
                  <b>
                    {typeof selectedMarket?.volume === "number"
                      ? `${selectedMarket.volume.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDT`
                      : "--"}
                  </b>
                </span>
                <span>
                  行情状态
                  <b
                    className={
                      manualContractMarket?.symbol === symbol &&
                      manualContractMarket.price > 0
                        ? "positive"
                        : "negative"
                    }
                  >
                    {manualContractMarket?.symbol === symbol &&
                    manualContractMarket.price > 0
                      ? "Binance 可交易"
                      : manualContractLoading
                        ? "核对中"
                        : "等待 Binance 核对"}
                  </b>
                </span>
              </div>
            </article>
            <article className="panel order-summary">
              <h2>委托预估</h2>
              {[
                ["名义价值", `${(orderPrice * orderQuantity).toFixed(2)} USDT`],
                [
                  "预计保证金",
                  `${((orderPrice * orderQuantity) / leverage).toFixed(2)} USDT`,
                ],
                [
                  "参考强平价",
                  orderPrice > 0
                    ? (side === "LONG"
                        ? orderPrice * (1 - 0.9 / leverage)
                        : orderPrice * (1 + 0.9 / leverage)
                      ).toLocaleString("en-US", { maximumFractionDigits: 4 })
                    : "--",
                ],
                [
                  "风险等级",
                  leverage >= 10 ? "较高" : leverage >= 5 ? "中等" : "较低",
                ],
              ].map(([a, b]) => (
                <div key={a}>
                  <span>{a}</span>
                  <b>{b}</b>
                </div>
              ))}
              <p>
                {selectedTradingAccount?.executionMode === "LIVE"
                  ? "当前为实盘：提交后核对订单摘要，点击确认即可立即发送至 Binance。"
                  : "该账户尚未启用实盘，系统会阻止提交订单。"}
              </p>
            </article>
            <article className="panel order-summary">
              <h2>账户密钥状态</h2>
              {selectedExchangeCredential ? (
                <>
                  <div>
                    <span>密钥状态</span>
                    <b
                      className={
                        credentialVerifiedRecently(selectedExchangeCredential)
                          ? "positive"
                          : "negative"
                      }
                    >
                      {credentialVerifiedRecently(selectedExchangeCredential)
                        ? "已校验"
                        : "待校验"}
                    </b>
                  </div>
                  <div>
                    <span>人工下单资金</span>
                    <b>按本页数量 × 价格执行</b>
                  </div>
                  <div>
                    <span>实盘开关</span>
                    <b
                      className={
                        selectedExchangeCredential.liveTradingEnabled
                          ? "positive"
                          : "negative"
                      }
                    >
                      {selectedExchangeCredential.liveTradingEnabled
                        ? "已启用"
                        : "未启用"}
                    </b>
                  </div>
                  <p>
                    账户密钥不再设置单笔/每日资金限额；人工下单由本页数量、价格和杠杆控制。策略下单由每个策略自己的资金配置控制。
                  </p>
                </>
              ) : (
                <p>
                  当前账户尚未配置 Binance 实盘密钥。请到账户管理配置并校验密钥。
                </p>
              )}
            </article>
          </aside>
          <ManualMarketHistoryChart
            symbol={selectedMarket?.symbol ?? ""}
            points={
              manualMarketHistory.symbol === selectedMarket?.symbol
                ? manualMarketHistory.points
                : []
            }
            loading={
              manualMarketHistory.symbol === selectedMarket?.symbol &&
              manualMarketHistory.loading
            }
            error={
              manualMarketHistory.symbol === selectedMarket?.symbol
                ? manualMarketHistory.error
                : null
            }
            updatedAt={
              manualMarketHistory.symbol === selectedMarket?.symbol
                ? manualMarketHistory.updatedAt
                : null
            }
          />
        </div>
        {manualOrderConfirmation && (
          <div
            className="modal-backdrop manual-confirm-backdrop"
            role="alertdialog"
            aria-labelledby="manual-order-confirm-title"
          >
            <section
              className="modal manual-order-confirm-modal"
            >
              <div className="config-title">
                <div>
                  <h2 id="manual-order-confirm-title">下单确认</h2>
                  <p>Binance 实盘 · 参数已冻结，确认后立即提交</p>
                </div>
                <button
                  type="button"
                  aria-label="关闭确认弹窗"
                  disabled={orderSubmitting}
                  onClick={() => setManualOrderConfirmation(null)}
                >
                  ×
                </button>
              </div>
              <div className="manual-order-summary-table">
                <span>合约</span>
                <b>{manualOrderConfirmation.symbol}</b>
                <span>方向</span>
                <b
                  className={
                    manualOrderConfirmation.positionSide === "LONG"
                      ? "positive"
                      : "negative"
                  }
                >
                  {manualOrderConfirmation.positionSide === "LONG"
                    ? "做多"
                    : "做空"}
                </b>
                <span>交易账户</span>
                <b>{manualOrderConfirmation.accountId}</b>
                <span>委托方式</span>
                <b>{manualOrderConfirmation.orderTypeLabel}</b>
                <span>下单数量</span>
                <b>{manualOrderConfirmation.quantity}</b>
                <span>
                  {manualOrderConfirmation.orderType === "LIMIT"
                    ? "委托价格"
                    : "参考价格"}
                </span>
                <b>
                  {(
                    manualOrderConfirmation.price ??
                    manualOrderConfirmation.referencePrice
                  ).toLocaleString("en-US", { maximumFractionDigits: 8 })}
                </b>
                <span>杠杆</span>
                <b>{manualOrderConfirmation.leverage}×</b>
                {manualOrderConfirmation.orderType === "LIMIT" && (
                  <>
                    <span>自动撤单</span>
                    <b>{manualOrderConfirmation.cancelAfterMinutes} 分钟</b>
                  </>
                )}
                <span>名义价值</span>
                <b>
                  {(
                    (manualOrderConfirmation.price ??
                      manualOrderConfirmation.referencePrice) *
                    manualOrderConfirmation.quantity
                  ).toFixed(2)}{" "}
                  USDT
                </b>
              </div>
              <div className="manual-confirm-risk-line">
                <span>
                  止盈 <b>{manualOrderConfirmation.takeProfitPlan.length} 档</b>
                </span>
                <span>
                  止损{" "}
                  <b>
                    {manualOrderConfirmation.trailingStopPercent > 0
                      ? "动态"
                      : `${manualOrderConfirmation.stopLossPlan.length} 档`}
                  </b>
                </span>
                <span>
                  移动止损{" "}
                  <b>
                    {manualOrderConfirmation.trailingStopPercent > 0
                      ? `${manualOrderConfirmation.trailingActivationPercent}% / ${manualOrderConfirmation.trailingStopPercent}%`
                      : "关闭"}
                  </b>
                </span>
                <span>
                  本金保护{" "}
                  <b>
                    -{manualOrderConfirmation.capitalPreservationStopRoePercent}% ROE
                  </b>
                </span>
              </div>
              <p className="manual-confirm-warning">
                <b>风险提示：</b> {manualOrderConfirmation.riskAdvisory.summary}
                {" "}预计占用保证金 {manualOrderConfirmation.riskAdvisory.initialMarginUsdt.toFixed(2)} USDT
                {manualOrderConfirmation.riskAdvisory.plannedMaximumLossUsdt !== null
                  ? `，按最深固定止损估算损失 ${manualOrderConfirmation.riskAdvisory.plannedMaximumLossUsdt.toFixed(2)} USDT。`
                  : "。"}
              </p>
              <div className="config-actions">
                <button
                  type="button"
                  disabled={orderSubmitting}
                  onClick={() => setManualOrderConfirmation(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary-btn manual-order-submit"
                  disabled={orderSubmitting}
                  onClick={() => void confirmManualOrder()}
                >
                  {orderSubmitting ? "正在下单…" : "确认下单"}
                </button>
              </div>
            </section>
          </div>
        )}
      </>
    );

  if (active === "pool")
    return (
      <ContractPoolView
        pool={pool}
        filteredPool={filteredPool}
        poolQuery={poolQuery}
        setPoolQuery={setPoolQuery}
        poolStatus={poolStatus}
        setPoolStatus={setPoolStatus}
        poolSort={poolSort}
        setPoolSort={setPoolSort}
        poolBusy={poolBusy}
        marketStatus={marketStatus}
        can={can}
        synchronizeSymbolPool={synchronizeSymbolPool}
        updateSymbolPool={updateSymbolPool}
        removeSymbol={removeSymbol}
        showAddSymbol={showAddSymbol}
        setShowAddSymbol={setShowAddSymbol}
        catalog={contractCatalog}
        createSymbol={createSymbol}
      />
    );
  const currentStrategyVersions = configuredStrategy
    ? strategyVersions
        .filter((version) => version.strategyId === configuredStrategy.id)
        .sort((a, b) => b.version - a.version)
    : [];
  const filteredStrategyVersions = currentStrategyVersions;
  const compareBaseSnapshot = currentStrategyVersions.find(
    (version) => version.version === compareBaseVersion,
  );
  const compareTargetSnapshot = currentStrategyVersions.find(
    (version) => version.version === compareTargetVersion,
  );
  const strategyVersionDiff = buildStrategyVersionDiff(
    compareBaseSnapshot,
    compareTargetSnapshot,
  );
  const accountFilterControl = (
    <label className="account-filter">
      <span>资金账户</span>
      <select
        value={portfolioAccountFilter}
        onChange={(event) => setPortfolioAccountFilter(event.target.value)}
      >
        <option value="ALL">全部账户</option>
        {tradingAccounts
          .filter((account) => account.accountType === "STRATEGY")
          .map((account) => (
            <option key={account.id} value={account.accountId}>
              {account.accountId} · {account.name}
            </option>
          ))}
      </select>
    </label>
  );

  if (active === "semiAuto")
    return (
      <SemiAutoOpportunityView
        strategies={visibleConfiguredStrategies}
        markets={pool}
        credentials={exchangeCredentials}
        positions={livePositions}
        canCreate={
          can("trade:manual:create") &&
          can("trade:live_order:create")
        }
        onExecuted={(message) => {
          setToast(message);
          void Promise.all([loadPositions(true), loadLiveOrders(true)]);
        }}
      />
    );

  if (active === "strategyLogs")
    return (
      <div className="work-page strategy-log-page">
        <StrategyBusinessLogView
          key={`${strategyExecutionTarget?.id ?? "none"}:${strategyExecutionViewMode}`}
          target={strategyExecutionTarget}
          executions={strategyExecutions}
          detail={strategyExecutionDetail}
          monitorStatus={strategyMonitorStatus}
          realtime={strategyLogRealtime}
          loading={strategyExecutionsBusy}
          detailLoading={strategyExecutionDetailBusy}
          initialTab={
            strategyExecutionViewMode === "LEARNING"
              ? "LEARNING"
              : "LIQUIDATIONS"
          }
          onRefresh={() => {
            if (!strategyExecutionTarget) return;
            void loadStrategyExecutionChanges(strategyExecutionTarget.id);
            void loadStrategyMonitorStatus(strategyExecutionTarget.id);
            void loadStrategyExecutions(
              strategyExecutionTarget.id,
              true,
              false,
            );
          }}
          onSelect={(traceId) => void loadStrategyExecutionDetail(traceId)}
          onApplySuggestion={applyAggregateSuggestionToDraft}
          onBack={() => setActive("auto")}
        />
      </div>
    );

  if (active === "auto")
    return (
      <div className="work-page">
        <section className="panel brain-status-strip" aria-label="NEXUS大脑运行摘要">
          <span>
            大脑 <b>{visibleConfiguredStrategies.length}</b>
          </span>
          <span>
            运行 <b className="positive">
              {visibleConfiguredStrategies.filter((strategy) => strategy.status === "RUNNING").length}
            </b>
          </span>
          <span>
            资金可执行 <b className="positive">{executableRunningStrategyCount}</b>
          </span>
          <span>
            资金待命 <b className="warning-text">{fundingWaitingStrategyCount}</b>
          </span>
          <span>
            草稿 <b className="warning-text">
              {visibleConfiguredStrategies.filter((strategy) => strategy.hasUnpublishedDraft).length}
            </b>
          </span>
          <span>
            数据 <b className="positive">WebSocket 实时</b>
          </span>
          <span>
            执行 <b className={serverLiveTradingAllowed ? "positive" : "warning-text"}>
              {serverLiveTradingAllowed ? "页面人工授权" : "服务器总控关闭"}
            </b>
          </span>
          <span>
            哨兵 <b className="positive">全局观察</b>
          </span>
          <small>服务器常驻监听；策略是否执行只由页面人工启停，关闭页面不影响已启用策略和仓位保护</small>
        </section>
        <section className="panel control-panel">
          <div className="panel-head">
            <div>
              <h2>NEXUS 大脑</h2>
              <p>每个大脑独立配置、独立学习；已有仓位始终绑定开仓时版本</p>
            </div>
            <div className="inline-actions strategy-create-actions">
              {accountFilterControl}
              <button
                className="primary-btn strategy-create-button"
                onClick={beginNewStrategy}
                disabled={!can("trade:strategy:edit")}
              >
                ＋ 新建策略
              </button>
              <button
                className="secondary-btn strategy-create-button"
                onClick={beginNewSimpleReboundStrategy}
                disabled={!can("trade:strategy:edit")}
              >
                ＋ 新建3分钟反弹策略
              </button>
            </div>
          </div>
          <div className="strategy-cards">
            {visibleConfiguredStrategies.map((strategy, index) => (
              <article key={strategy.id}>
                <div className="strategy-card-top">
                  <span
                    className={`strategy-symbol ${index % 2 ? "cyan" : "purple"}`}
                  >
                    ϟ
                  </span>
                  <div>
                    <h3>
                      {strategy.displayName ?? strategy.name}
                      <span className="strategy-id-badge">#{strategy.id}</span>
                    </h3>
                    <small
                      className="strategy-card-summary"
                      title={strategy.symbolScope}
                    >
                      {strategyTypeLabel(strategy.strategyType, strategy.config)}
                      {" · "}
                      {strategyTriggerCatalogEntry(
                        strategyTriggerKind(strategy.config),
                      ).label}
                      {" · "}
                      {strategy.runtimeMode === "SHADOW"
                        ? "影子观察"
                        : strategy.runtimeMode === "CONFIRM_REQUIRED"
                          ? "确认执行"
                          : "自动执行"}
                      {" · "}
                      {strategySymbolScopeSummary(strategy.symbolScope)}
                      {" · "}
                      {strategy.accountId} · {tradingAccountNames[strategy.accountId] ?? "历史账户"}
                    </small>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={strategy.status === "RUNNING"}
                      disabled={
                        !can("trade:strategy:edit") ||
                        automationBusy ||
                        (strategy.publishedVersion ?? strategy.configVersion) < 1
                      }
                      onChange={() =>
                        void changeStrategyStatus(
                          strategy,
                          strategy.status === "RUNNING" ? "PAUSED" : "RUNNING",
                        )
                      }
                    />
                    <i></i>
                  </label>
                </div>
                <div className="strategy-kpis">
                  <span>
                    身份
                    <b title={strategy.brainKey ?? ""}>
                      {strategy.brainKey
                        ? strategy.brainKey.slice(0, 12)
                        : `NEXUS-${strategy.id}`}
                    </b>
                  </span>
                  <span>
                    版本
                    <b>
                      V{strategy.publishedVersion ?? strategy.configVersion}
                    </b>
                  </span>
                  {strategy.hasUnpublishedDraft && (
                    <span>
                      待发布草稿
                      <b className="warning-text">
                        V{strategy.draft?.version ?? strategy.draftVersion}
                      </b>
                    </span>
                  )}
                  <span>
                    最后更新
                    <b>
                      {new Date(strategy.updatedAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </b>
                  </span>
                  <span>
                    状态
                    <b
                      className={
                        strategy.status === "RUNNING"
                          ? "positive"
                          : strategy.status === "BLOCKED"
                            ? "negative"
                            : "muted"
                      }
                    >
                      {strategy.status === "RUNNING"
                        ? "运行中"
                        : strategy.status === "PAUSED"
                          ? "已暂停"
                        : strategy.status === "BLOCKED"
                            ? "已阻断"
                            : "待配置"}
                    </b>
                  </span>
                  {strategyFundingById.has(strategy.id) && (
                    <span>
                      资金
                      <b
                        className={strategyFundingById.get(strategy.id)!.view.tone}
                        title={strategyFundingById.get(strategy.id)!.view.detail}
                      >
                        {strategyFundingById.get(strategy.id)!.view.label}
                      </b>
                    </span>
                  )}
                </div>
                <div className="strategy-card-actions">
                  <button
                    onClick={() => openManagedStrategy(strategy, true)}
                    disabled={!can("trade:strategy:edit")}
                  >
                    配置
                    {strategy.liquidationFactorLearning?.attentionRequired && (
                      <span
                        className="strategy-learning-action-badge"
                        title="爆仓因子学习状态需要处理"
                      >
                        1
                      </span>
                    )}
                  </button>
                  <button onClick={() => void openStrategyExecutionLog(strategy)}>
                    日志
                  </button>
                  <button
                    onClick={() =>
                      void openStrategyExecutionLog(strategy, "LEARNING")
                    }
                  >
                    学习
                    {(strategy.learningReview?.readyForReview ?? 0) > 0 && (
                      <span className="strategy-learning-action-badge">
                        {strategy.learningReview?.readyForReview}
                      </span>
                    )}
                  </button>
                  <button
                    className="danger-btn"
                    disabled={!can("trade:strategy:edit") || automationBusy}
                    onClick={() => setDeleteStrategyTarget(strategy)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
          {visibleConfiguredStrategies.length === 0 && (
            <div className="empty">
              {configuredStrategies.length === 0
                ? "暂无 NEXUS 大脑。新建后先保存草稿，核对无误再发布。"
                : "当前资金账户尚未配置 NEXUS 大脑。"}
            </div>
          )}
        </section>
        {deleteStrategyTarget && (
          <div
            className="modal-backdrop"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-strategy-title"
          >
            <div className="modal strategy-delete-modal">
              <span className="modal-icon">!</span>
              <h2 id="delete-strategy-title">确认删除策略？</h2>
              <p>
                将永久删除 <b>{deleteStrategyTarget.name}</b> 及其参数版本、历史验证记录、运行日志、持仓分析证据和参数建议。
              </p>
              <p className="config-safety">
                实盘订单与成交记录依法保留；若仍有执行中信号、挂单或持仓监控，系统会拒绝删除。删除操作仅保留一条安全审计记录，无法恢复。
              </p>
              <div>
                <button
                  disabled={deleteStrategyBusy}
                  onClick={() => setDeleteStrategyTarget(null)}
                >
                  取消
                </button>
                <button
                  className="danger-btn"
                  disabled={deleteStrategyBusy}
                  onClick={() => void deleteStrategy()}
                >
                  {deleteStrategyBusy ? "删除中…" : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        )}
        {strategyExecutionPanelOpen && strategyExecutionTarget && (
          <section className="panel strategy-execution-panel">
            <div className="panel-head strategy-execution-head">
              <div>
                <h2>策略独立运行日志</h2>
                <p>
                  {strategyExecutionTarget.name} · {strategyExecutionTarget.accountId} · V
                  {strategyExecutionTarget.configVersion} · 触发、趋势判断、下单与持仓验证全链路
                </p>
              </div>
              <div className="panel-actions">
                <span
                  className={`source-tag ${strategyExecutionTarget.status === "RUNNING" ? "auto" : "protect"}`}
                >
                  {strategyExecutionTarget.status === "RUNNING"
                    ? "策略监听中"
                    : "已暂停"}
                </span>
                <span
                  className={`source-tag ${strategyLogRealtime.status === "LIVE" ? "auto" : strategyLogRealtime.status === "DELAYED" ? "danger-source" : "protect"}`}
                  title={
                    strategyLogRealtime.lastSyncAt
                      ? `最近同步 ${new Date(strategyLogRealtime.lastSyncAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                      : "等待首次实时同步"
                  }
                >
                  {strategyLogRealtime.status === "LIVE"
                    ? "业务日志 1秒 · 实时判断 2秒"
                    : strategyLogRealtime.status === "DELAYED"
                      ? "日志同步延迟"
                      : "正在连接日志"}
                </span>
                <button
                  disabled={strategyExecutionsBusy}
                  onClick={() => {
                    void loadStrategyExecutionChanges(
                      strategyExecutionTarget.id,
                    );
                    void loadStrategyMonitorStatus(
                      strategyExecutionTarget.id,
                    );
                    void loadStrategyExecutions(
                      strategyExecutionTarget.id,
                      true,
                      false,
                    );
                  }}
                >
                  {strategyExecutionsBusy ? "刷新中…" : "刷新分析"}
                </button>
                <button
                  aria-label="关闭策略运行日志"
                  onClick={clearStrategyLogSession}
                >
                  关闭
                </button>
              </div>
            </div>
            {strategyMonitorStatus && (
              <div className="strategy-monitor-status-line">
                <span>
                  触发器 <b>{strategyMonitorStatus.triggerLabel ?? "未识别"}</b>
                </span>
                <span>
                  新鲜候选 <b>{strategyMonitorStatus.freshCandidateCount}</b> / 候选{" "}
                  <b>{strategyMonitorStatus.candidateCount}</b>
                </span>
                <span>
                  运行中链路 <b>{strategyMonitorStatus.activeAnalysisCount ?? 0}</b>
                </span>
                {(strategyMonitorStatus.activeAnalyses?.[0]) && (
                  <span
                    className="strategy-monitor-status-active"
                    title={strategyMonitorStatus.activeAnalyses
                      .map((item) =>
                        `${item.symbol} ${strategyExecutionStateLabel(item.state)} · ${item.resultMessage ?? item.resultCode ?? "处理中"} · 已运行 ${item.ageSeconds.toFixed(1)}s`,
                      )
                      .join("；")}
                  >
                    当前{" "}
                    <b>{strategyMonitorStatus.activeAnalyses[0].symbol}</b>{" "}
                    {strategyExecutionStateLabel(strategyMonitorStatus.activeAnalyses[0].state)}
                    {strategyMonitorStatus.activeAnalyses[0].resultMessage
                      ? `：${strategyMonitorStatus.activeAnalyses[0].resultMessage}`
                      : ""}
                  </span>
                )}
                {strategyMonitorStatus.triggerKind ===
                "THREE_MINUTE_PROBABILITY" ? (
                  <>
                    <span>
                      观察窗口 <b>{strategyMonitorStatus.threeMinuteRound?.roundId ?? "同步中"}</b>
                    </span>
                    <span>
                      持仓计时 <b>{strategyMonitorStatus.threeMinutePosition?.remainingSeconds ?? "未建仓"}{strategyMonitorStatus.threeMinutePosition ? "s" : ""}</b>
                    </span>
                    <span>
                      多 / 空 <b>{strategyMonitorStatus.threeMinuteRound?.pLongPercent?.toFixed(1) ?? "—"}% / {strategyMonitorStatus.threeMinuteRound?.pShortPercent?.toFixed(1) ?? "—"}%</b>
                    </span>
                    <span>
                      净优势 <b>{strategyMonitorStatus.threeMinuteRound?.netEdgeBps?.toFixed(2) ?? "—"}bp</b>
                    </span>
                    <span>
                      学习 <b>{strategyMonitorStatus.threeMinuteLearning?.learnedRounds ?? 0}</b> 轮 · {strategyMonitorStatus.threeMinuteLearning?.mode ?? "等待"}
                    </span>
                    <span>
                      精确净收益 <b>{strategyMonitorStatus.threeMinuteLearning?.exactNetPnlUsdt?.toFixed(4) ?? "—"} USDT</b>
                    </span>
                    <span>
                      最近批次 <b>{strategyMonitorStatus.threeMinuteLearning?.recentExactBatchSampleCount ?? 0}/{strategyMonitorStatus.threeMinuteLearning?.batchSize ?? "—"}</b> · {strategyMonitorStatus.threeMinuteLearning?.recentExactBatchPnlUsdt?.toFixed(4) ?? "—"} USDT
                    </span>
                    <span>
                      60/120/180秒证据{" "}
                      <b>
                        {[60, 120, 180].map((elapsedSeconds) => {
                          const checkpoint = strategyMonitorStatus.threeMinuteCheckpoints
                            ?.find((item) => item.elapsedSeconds === elapsedSeconds);
                          return checkpoint
                            ? `${elapsedSeconds}s ${checkpoint.roePercent === null ? checkpoint.status : `${checkpoint.roePercent >= 0 ? "+" : ""}${checkpoint.roePercent.toFixed(2)}%${checkpoint.counterfactual ? "(理论)" : ""}`}`
                            : `${elapsedSeconds}s 等待`;
                        }).join(" / ")}
                      </b>
                    </span>
                  </>
                ) : strategyMonitorStatus.triggerKind === "LOW_POSITION_WINDOW" ? (
                  <>
                    <span>
                      低位阈值 <b>{strategyMonitorStatus.lowPositionThreshold?.maxPosition72hPercent ?? "—"}%</b>
                    </span>
                    <span>
                      扫描间隔 <b>{strategyMonitorStatus.lowPositionThreshold?.scanIntervalSeconds ?? "—"}s</b>
                    </span>
                    <span>
                      每轮候选 <b>{strategyMonitorStatus.lowPositionThreshold?.maxWakeCandidatesPerCycle ?? "—"}</b>
                    </span>
                  </>
                ) : strategyMonitorStatus.threshold ? (
                  <>
                    <span>
                      监听侧 <b>{strategyMonitorStatus.triggerSide}</b>
                    </span>
                    <span>
                      单笔{" "}
                      <b>
                        {strategyMonitorStatus.strongestSingle?.symbol ?? "—"}{" "}
                        {(strategyMonitorStatus.strongestSingle?.notional ?? 0).toFixed(0)}
                      </b>
                      /{strategyMonitorStatus.threshold.minSingleEventNotionalUsdt.toFixed(0)}
                    </span>
                    <span>
                      {strategyMonitorStatus.threshold.maxSpanSeconds}s窗口{" "}
                      <b>
                        {strategyMonitorStatus.bestConfiguredWindow?.symbol ?? "—"}{" "}
                        {(strategyMonitorStatus.bestConfiguredWindow?.notional ?? 0).toFixed(0)}
                      </b>
                      /{strategyMonitorStatus.threshold.minWindowNotionalUsdt.toFixed(0)}
                    </span>
                    <span>
                      120s观察{" "}
                      <b>
                        {strategyMonitorStatus.best120SecondWindow?.symbol ?? "—"}{" "}
                        {(strategyMonitorStatus.best120SecondWindow?.notional ?? 0).toFixed(0)}
                      </b>
                    </span>
                  </>
                ) : null}
                <span className="strategy-monitor-status-reason" title={strategyMonitorStatus.reason}>
                  {strategyMonitorStatus.reason}
                </span>
                {strategyMonitorStatus.suggestion?.message && (
                  <span className="strategy-monitor-status-suggestion">
                    建议：{strategyMonitorStatus.suggestion.message}
                  </span>
                )}
              </div>
            )}
            <div className="strategy-execution-summary">
              <article>
                <span>已记录链路</span>
                <b>{strategyExecutions.length}</b>
                <small>
                  本次进入后记录 · 最多1000条，超出替换最旧记录
                </small>
              </article>
              <article>
                <span>分析 / 等待</span>
                <b className="warning-text">
                  {
                    strategyExecutions.filter((item) =>
                      [
                        "TRIGGERED",
                        "ANALYZING",
                        "ARMED",
                        "ORDER_READY",
                        "ORDER_PENDING",
                      ].includes(item.state),
                    ).length
                  }
                </b>
                <small>尚未形成最终结果</small>
              </article>
              <article>
                <span>已进入持仓</span>
                <b className="positive">
                  {
                    strategyExecutions.filter(
                      (item) => item.exchangeOrderId || item.positionId,
                    ).length
                  }
                </b>
                <small>含已结束的策略仓位</small>
              </article>
              <article>
                <span>拒绝 / 过期</span>
                <b className="negative">
                  {
                    strategyExecutions.filter((item) =>
                      ["REJECTED", "EXPIRED", "DATA_STALE"].includes(
                        item.state,
                      ),
                    ).length
                  }
                </b>
                <small>详情中展示具体证据</small>
              </article>
              <article>
                <span>启动额度 / 学习阶段</span>
                <b className={strategyLearningProgress?.modelPhase === "VALIDATION" ? "positive" : "warning-text"}>
                  {strategyLearningProgress
                    ? strategyLearningProgress.modelPhase === "EXPLORATION_10"
                      ? `${Math.min(strategyLearningProgress.committedEntryOrders, strategyLearningProgress.explorationTargetOrders)}/${strategyLearningProgress.explorationTargetOrders} 个启动探针`
                      : `${strategyLearningProgress.completedExactNetOrders}/${strategyLearningProgress.learningTargetOrders ?? 150} 个完整周期`
                    : "—"}
                </b>
                <small title={strategyLearningProgress?.isolationMessage}>
                  {strategyLearningProgress
                    ? strategyLearningProgress.modelPhase === "EXPLORATION_10"
                      ? `终身先下单额度还剩 ${strategyLearningProgress.remainingExplorationOrders} 个 · 第 11 单起必须由眼睛确认`
                      : strategyLearningProgress.modelPhase === "DAILY_REINFORCEMENT"
                        ? `今日强化样本 ${strategyLearningProgress.dailyCommittedEntryOrders ?? 0}/${strategyLearningProgress.dailyReinforcementTargetOrders ?? 150} · 仅眼睛确认信号可执行`
                      : strategyLearningProgress.modelPhase === "EVIDENCE_COLLECTION"
                        ? `启动额度已终身关闭 · 精确结算 ${strategyLearningProgress.completedExactNetOrders}/${strategyLearningProgress.learningTargetOrders ?? 150}`
                        : "150 个完整周期已完成，后续仍须眼睛确认"
                    : "只统计同配置、同引擎的真实完整订单"}
                </small>
              </article>
              <article>
                <span>本批真实资金结果</span>
                <b
                  className={
                    (strategyLearningProgress?.cohortPerformance
                      ?.exactNetRealizedPnlUsdt ?? 0) >= 0
                      ? "positive"
                      : "negative"
                  }
                >
                  {strategyLearningProgress?.cohortPerformance
                    ? `净结算 ${strategyLearningProgress.cohortPerformance.exactNetRealizedPnlUsdt >= 0 ? "+" : ""}${strategyLearningProgress.cohortPerformance.exactNetRealizedPnlUsdt.toFixed(3)} USDT`
                    : "—"}
                </b>
                <small title="已平仓只使用可核对的手续费、资金费后精确净收益；未平仓单独显示毛浮盈亏，二者不混成净收益。">
                  {strategyLearningProgress?.cohortPerformance
                    ? `精确平仓 ${strategyLearningProgress.cohortPerformance.exactNetClosedOrders} 单 · 净胜率 ${strategyLearningProgress.cohortPerformance.exactNetWinRatePercent === null ? "—" : `${strategyLearningProgress.cohortPerformance.exactNetWinRatePercent.toFixed(1)}%`}（观察目标 ${strategyLearningProgress.explorationTargetWinRatePercent}%） · 持仓毛浮 ${strategyLearningProgress.cohortPerformance.openGrossPnlUsdt >= 0 ? "+" : ""}${strategyLearningProgress.cohortPerformance.openGrossPnlUsdt.toFixed(3)} USDT · ${strategyLearningProgress.cohortPerformance.openWinningPositions} 盈/${strategyLearningProgress.cohortPerformance.openLosingPositions} 亏`
                    : "已结算净收益与未结算毛浮盈亏分别统计"}
                </small>
              </article>
              {strategyLearningProgress?.inverseDirectionEvaluation && (
                <article>
                  <span>反人性双路径（独立结算）</span>
                  <b className={
                    strategyLearningProgress.inverseDirectionEvaluation
                        .bothLanesReady
                      ? "positive"
                      : "warning-text"
                  }>
                    原多→实空 {strategyLearningProgress.inverseDirectionEvaluation.lanes.LONG_TO_SHORT.settledSamples}/{strategyLearningProgress.inverseDirectionEvaluation.minimumSettledSamples} · 原空→实多 {strategyLearningProgress.inverseDirectionEvaluation.lanes.SHORT_TO_LONG.settledSamples}/{strategyLearningProgress.inverseDirectionEvaluation.minimumSettledSamples}
                  </b>
                  <small title={strategyLearningProgress.inverseDirectionEvaluation.summary}>
                    净结算 {strategyLearningProgress.inverseDirectionEvaluation.lanes.LONG_TO_SHORT.exactNetPnlUsdt >= 0 ? "+" : ""}{strategyLearningProgress.inverseDirectionEvaluation.lanes.LONG_TO_SHORT.exactNetPnlUsdt.toFixed(3)} / {strategyLearningProgress.inverseDirectionEvaluation.lanes.SHORT_TO_LONG.exactNetPnlUsdt >= 0 ? "+" : ""}{strategyLearningProgress.inverseDirectionEvaluation.lanes.SHORT_TO_LONG.exactNetPnlUsdt.toFixed(3)} USDT · 持仓毛浮 {strategyLearningProgress.inverseDirectionEvaluation.lanes.LONG_TO_SHORT.openGrossPnlUsdt >= 0 ? "+" : ""}{strategyLearningProgress.inverseDirectionEvaluation.lanes.LONG_TO_SHORT.openGrossPnlUsdt.toFixed(3)} / {strategyLearningProgress.inverseDirectionEvaluation.lanes.SHORT_TO_LONG.openGrossPnlUsdt >= 0 ? "+" : ""}{strategyLearningProgress.inverseDirectionEvaluation.lanes.SHORT_TO_LONG.openGrossPnlUsdt.toFixed(3)} · 仅观察，不自动调参
                  </small>
                </article>
              )}
              <article>
                <span>观察证据（不等于订单）</span>
                <b className={strategyLearningProgress?.readyForActualSuggestion ? "positive" : "warning-text"}>
                  {strategyLearningProgress
                    ? `${strategyLearningProgress.actualSamples}/${strategyLearningProgress.minimumSamples} 组`
                    : "—"}
                </b>
                <small title={strategyLearningProgress?.modelPhaseMessage}>
                  {strategyLearningProgress
                    ? `完整因果 ${strategyLearningProgress.causalActualSamples} · 仅价格/不完整 ${strategyLearningProgress.incompleteCausalActualSamples} · 拒绝对照 ${strategyLearningProgress.rejectedSamples} · 破位影子 ${strategyLearningProgress.postBreakShadowSamples}/${strategyLearningProgress.minimumPostBreakShadowSamples} · 共识30分钟 ${strategyLearningProgress.consensus30Samples}/${strategyLearningProgress.minimumConsensusSamples}`
                    : "用于1/3/5/15/30/60分钟学习闭环；探索期允许受控限价探针"}
                </small>
              </article>
              <article>
                <span>同波段选币对照</span>
                <b
                  className={
                    strategyLearningProgress?.waveSymbolSelection.verdict ===
                    "OBSERVATION_READY"
                      ? "positive"
                      : "warning-text"
                  }
                >
                  {strategyLearningProgress
                    ? `${strategyLearningProgress.waveSymbolSelection.entryComparableClusters}/${strategyLearningProgress.waveSymbolSelection.minimumClusters} 个波段`
                    : "—"}
                </b>
                <small
                  title={
                    strategyLearningProgress?.waveSymbolSelection.summary
                  }
                >
                  {strategyLearningProgress
                    ? `已识别 ${strategyLearningProgress.waveSymbolSelection.totalMultiSymbolClusters} 组 · 60分钟可比 ${strategyLearningProgress.waveSymbolSelection.selectedPairs.length} 对 · 证据不足 ${strategyLearningProgress.waveSymbolSelection.excludedIncompleteEntryEvidenceClusters} 组` +
                      (strategyLearningProgress.waveSymbolSelection
                          .selectedPairs[0]
                        ? ` · 本轮 ${strategyLearningProgress.waveSymbolSelection.selectedPairs[0].winnerSymbol ?? "—"} ${formatSignedPercent(strategyLearningProgress.waveSymbolSelection.selectedPairs[0].winnerRoe60mPercent)} / ${strategyLearningProgress.waveSymbolSelection.selectedPairs[0].loserSymbol ?? "—"} ${formatSignedPercent(strategyLearningProgress.waveSymbolSelection.selectedPairs[0].loserRoe60mPercent)}`
                        : "")
                    : "比较同一轮不同合约的60分钟表现，不重复计算独立胜率"}
                </small>
              </article>
              <article>
                <span>NEXUS 大脑主链</span>
                <b
                  className={
                    (
                      strategyLearningProgress?.nexusBrainLifecycle
                        ?.learningEligible ?? 0
                    ) > 0
                      ? "positive"
                      : "warning-text"
                  }
                >
                  {strategyLearningProgress?.nexusBrainLifecycle
                    ? `${strategyLearningProgress.nexusBrainLifecycle.learningEligible}/${strategyLearningProgress.nexusBrainLifecycle.totalTraces} 完整闭环`
                    : "—"}
                </b>
                <small
                  title={
                    strategyLearningProgress?.nexusBrainLifecycle
                      ?.topBlockers
                      .map(
                        (item) =>
                          `${nexusBrainLifecycleBlockerLabel(item.code)} ${item.traces}条`,
                      )
                      .join(" · ")
                  }
                >
                  {strategyLearningProgress?.nexusBrainLifecycle
                    ? `眼睛 ${strategyLearningProgress.nexusBrainLifecycle.eyesComplete} → 大脑 ${strategyLearningProgress.nexusBrainLifecycle.decisionComplete} → 持仓 ${strategyLearningProgress.nexusBrainLifecycle.positionManagementObserved} → 学习 ${strategyLearningProgress.nexusBrainLifecycle.learningEligible}` +
                      (strategyLearningProgress.nexusBrainShadowComparison
                        ? ` · 独立波段 多 ${strategyLearningProgress.nexusBrainShadowComparison.byDirection.LONG.comparableSamples}（保守准确率 ${formatPercentRatio(strategyLearningProgress.nexusBrainShadowComparison.byDirection.LONG.accuracyWilsonLower)}）/ 空 ${strategyLearningProgress.nexusBrainShadowComparison.byDirection.SHORT.comparableSamples}（保守准确率 ${formatPercentRatio(strategyLearningProgress.nexusBrainShadowComparison.byDirection.SHORT.accuracyWilsonLower)}）`
                        : "")
                    : "眼睛事实、大脑判断、持仓证据和1/3/5/15/30/60分钟结果完整后才进入学习"}
                </small>
              </article>
              <article>
                <span>当前配置终态吸收</span>
                <b
                  className={
                    (strategyLearningProgress?.learningObservability.currentConfig
                      .pendingTerminalReceipts ?? 0) === 0
                      ? "positive"
                      : "warning-text"
                  }
                >
                  {strategyLearningProgress?.learningObservability
                    ? `V${strategyLearningProgress.learningObservability.currentConfig.version} · ${strategyLearningProgress.learningObservability.currentConfig.absorbedCycles}/${strategyLearningProgress.learningObservability.currentConfig.terminalTraces}`
                    : "—"}
                </b>
                <small title="只统计当前配置版本；旧版本样本不会混入当前参数学习。">
                  {strategyLearningProgress?.learningObservability
                    ? `精确净结算 ${strategyLearningProgress.learningObservability.currentConfig.exactNetCycles} · 可学习 ${strategyLearningProgress.learningObservability.currentConfig.eligibleCycles} · 待吸收 ${strategyLearningProgress.learningObservability.currentConfig.pendingTerminalReceipts} · 中位延迟 ${strategyLearningProgress.learningObservability.currentConfig.medianAbsorptionLatencyMs === null ? "待记录" : `${(strategyLearningProgress.learningObservability.currentConfig.medianAbsorptionLatencyMs / 1_000).toFixed(1)}秒`}`
                    : "当前配置终态、学习回执和精确结算分别核对"}
                </small>
              </article>
              <article>
                <span>参数候选版本隔离</span>
                <b
                  className={
                    (strategyLearningProgress?.learningObservability.candidates
                      .stalePending ?? 0) > 0
                      ? "warning-text"
                      : "positive"
                  }
                >
                  {strategyLearningProgress?.learningObservability
                    ? `当前待确认 ${strategyLearningProgress.learningObservability.candidates.currentPending}`
                    : "—"}
                </b>
                <small title="旧配置待确认项和已过期项只用于复盘，不能修改当前实盘参数。">
                  {strategyLearningProgress?.learningObservability
                    ? `旧配置待确认 ${strategyLearningProgress.learningObservability.candidates.stalePending} · 已过期 ${strategyLearningProgress.learningObservability.candidates.expired} · 已接受 ${strategyLearningProgress.learningObservability.candidates.accepted} · 已拒绝 ${strategyLearningProgress.learningObservability.candidates.rejected} · 禁止自动发布`
                    : "候选必须由运营人工确认；恶化时按验证规则回退"}
                </small>
              </article>
              <article>
                <span>触发器学习覆盖</span>
                <b
                  className={
                    (strategyLearningProgress?.learningObservability.triggerCoverage
                      .find((item) => item.currentConfig)?.absorbedCycles ?? 0) > 0
                      ? "positive"
                      : "warning-text"
                  }
                >
                  {strategyLearningProgress?.learningObservability.triggerCoverage[0]
                    ? `${strategyLearningProgress.learningObservability.triggerCoverage.filter((item) => item.currentConfig).length} 个当前范围`
                    : "待首个终态"}
                </b>
                <small
                  title={strategyLearningProgress?.learningObservability.triggerCoverage
                    .map((item) =>
                      `${item.currentConfig ? "当前" : "历史"} ${item.triggerKind} ${item.triggerVersion}：终态 ${item.terminalTraces}，吸收 ${item.absorbedCycles}，精确 ${item.exactNetCycles}，P90 ${item.p90AbsorptionLatencyMs === null ? "—" : `${(item.p90AbsorptionLatencyMs / 1_000).toFixed(1)}秒`}`,
                    )
                    .join("；")}
                >
                  {strategyLearningProgress?.learningObservability.triggerCoverage.length
                    ? strategyLearningProgress.learningObservability.triggerCoverage
                        .slice(0, 3)
                        .map((item) =>
                          `${item.currentConfig ? "当前" : "历史"} ${item.triggerKind} ${item.absorbedCycles}/${item.terminalTraces}`,
                        )
                        .join(" · ")
                    : "每类触发器按配置版本、触发器版本和大脑证据版本分别统计"}
                </small>
              </article>
              <article>
                <span>眼睛近期可信度</span>
                <b
                  className={
                    strategyLearningProgress?.evidenceConfidenceDecayCapability
                      .state === "ACTIVE"
                      ? "positive"
                      : "warning-text"
                  }
                >
                  {strategyLearningProgress?.evidenceConfidenceDecayCapability
                    .state === "ACTIVE"
                    ? strategyLearningProgress.evidenceConfidenceDecayCapability
                        .latestStatus ?? "已形成结论"
                    : strategyLearningProgress?.evidenceConfidenceDecayCapability
                          .state === "PAUSED_WAITING"
                      ? "策略暂停 · 待新周期"
                      : strategyLearningProgress
                            ?.evidenceConfidenceDecayCapability.state ===
                          "WAITING_CURRENT_VERSION"
                        ? "当前版本待首轮"
                        : strategyLearningProgress
                              ?.evidenceConfidenceDecayCapability.state ===
                            "COLLECTING_CURRENT_VERSION"
                          ? "当前版本采集中"
                          : "—"}
                </b>
                <small
                  title={
                    strategyLearningProgress?.evidenceConfidenceDecayCapability
                      .latestSummary ?? undefined
                  }
                >
                  {strategyLearningProgress?.evidenceConfidenceDecayCapability
                    .message ??
                    "近期证据可信度只用于复盘，不参与订单、仓位或实盘参数修改"}
                </small>
              </article>
              <article>
                <span>持仓判断后验</span>
                <b
                  className={
                    strategyLearningProgress?.positionManagementValidation
                      ?.verdict === "REVIEW_DECISION_THRESHOLDS"
                      ? "negative"
                      : (
                            strategyLearningProgress
                              ?.positionManagementValidation?.sampleCount ?? 0
                          ) >=
                          (
                            strategyLearningProgress
                              ?.positionManagementValidation?.minimumSamples ??
                              Number.POSITIVE_INFINITY
                          )
                        ? "positive"
                        : "warning-text"
                  }
                >
                  {strategyLearningProgress?.positionManagementValidation
                    ? `${strategyLearningProgress.positionManagementValidation.sampleCount}/${strategyLearningProgress.positionManagementValidation.minimumSamples} 组`
                    : "—"}
                </b>
                <small>
                  {strategyLearningProgress?.positionManagementValidation
                    ? `支持 ${strategyLearningProgress.positionManagementValidation.supportedCount} · 反证 ${strategyLearningProgress.positionManagementValidation.contradictedCount} · 待验 ${strategyLearningProgress.positionManagementValidation.pendingCount} · 证据不足 ${strategyLearningProgress.positionManagementValidation.incompleteEvidenceCount} · 不明确 ${strategyLearningProgress.positionManagementValidation.inconclusiveCount}`
                    : "只统计判断发生时因果证据完整且有后续样本的真实仓位"}
                </small>
              </article>
              <article>
                <span>补仓效果学习</span>
                <b
                  className={
                    strategyLearningProgress?.positionAdditionLearning?.verdict ===
                    "KEEP_PARAMETERS"
                      ? "positive"
                      : strategyLearningProgress?.positionAdditionLearning
                            ?.verdict === "REVIEW_DISABLE"
                        ? "negative"
                        : "warning-text"
                  }
                >
                  {strategyLearningProgress?.positionAdditionLearning
                    ? `${strategyLearningProgress.positionAdditionLearning.completedAdditions}/${strategyLearningProgress.positionAdditionLearning.minimumCompletedAdditions} 组`
                    : "—"}
                </b>
                <small
                  title={
                    strategyLearningProgress?.positionAdditionLearning?.message
                  }
                >
                  {strategyLearningProgress?.positionAdditionLearning
                    ? strategyLearningProgress.positionAdditionLearning
                        .verdict === "COLLECTING"
                      ? `继续收集 · 已成交 ${strategyLearningProgress.positionAdditionLearning.observedAdditions} 次 · 历史补齐 ${strategyLearningProgress.positionAdditionLearning.backfilledSamples} 点 · 终局 ${strategyLearningProgress.positionAdditionLearning.terminalSamples} 点`
                      : strategyLearningProgress.positionAdditionLearning
                            .verdict === "KEEP_PARAMETERS"
                        ? "数据支持维持当前补仓参数"
                        : strategyLearningProgress.positionAdditionLearning
                              .verdict === "REVIEW_DISABLE"
                          ? "结果不利，建议人工复核并暂停"
                          : "结果分化，建议复核补仓参数"
                    : "按同配置、同模型的实时或闭合K线补齐样本隔离统计"}
                </small>
              </article>
            </div>
            <div className="data-table strategy-execution-table">
              <table>
                <thead>
                  <tr>
                    <th>触发时间</th>
                    <th>合约</th>
                    <th>机会方向</th>
                    <th>触发事实</th>
                    <th>状态</th>
                    <th>判断结果</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyExecutions.map((execution) => (
                    <tr
                      key={execution.traceId}
                      className={
                        strategyExecutionDetail?.execution.traceId ===
                        execution.traceId
                          ? "selected"
                          : ""
                      }
                    >
                      <td>
                        {new Date(execution.eventTime).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                        <small className="mono">
                          {execution.traceId.slice(-10)}
                        </small>
                      </td>
                      <td>
                        <b>
                          {execution.resultCode === "SHORT_MONITOR_STATUS"
                            ? "全市场监听"
                            : execution.resultCode === "THREE_MINUTE_ROUND_STATUS"
                              ? `${execution.symbol} 滚动评估`
                            : execution.symbol}
                        </b>
                        <small>V{execution.configVersion}</small>
                      </td>
                      <td>
                        <span
                          className={`source-tag ${execution.tradeDirection === "SHORT" ? "danger-source" : "auto"}`}
                        >
                          {execution.resultCode === "SHORT_MONITOR_STATUS"
                            ? "做空门槛"
                            : execution.resultCode === "THREE_MINUTE_ROUND_STATUS"
                              ? "概率门槛"
                            : strategyExecutionDirectionLabel(execution)}
                        </span>
                          {![
                            "SHORT_MONITOR_STATUS",
                            "THREE_MINUTE_ROUND_STATUS",
                          ].includes(execution.resultCode ?? "") && (
                            <small>
                              {strategyExecutionBranch(execution) ===
                              "CONTRARIAN_PROBE"
                                ? "分支：反向探针"
                                : "分支：正常方向"}
                              {" · "}来源：
                              {strategyExecutionTriggerLabel(execution)}
                            </small>
                          )}
                      </td>
                      <td>
                        {execution.resultCode === "SHORT_MONITOR_STATUS" ? (
                          <>
                            持续滚动
                            <small>仅保留最新一条状态</small>
                          </>
                        ) : execution.resultCode === "THREE_MINUTE_ROUND_STATUS" ? (
                          <>
                            持续滚动判断
                            <small>新事实随时进入统一大脑复核</small>
                          </>
                        ) : (
                          execution.triggerKind === "LOW_POSITION_WINDOW" ? (
                            <>
                              {formatCompactDecimal(
                                Number(
                                  (
                                    execution.entryEvidence.lowPositionWindow as
                                      | { position72hPercent?: unknown }
                                      | undefined
                                  )?.position72hPercent,
                                ),
                                2,
                                "--",
                              )}% 区间位置
                              <small>
                                标记价 {formatCompactDecimal(
                                  execution.triggerReferencePrice ??
                                    execution.liquidationPrice,
                                  8,
                                  "--",
                                )}
                              </small>
                            </>
                          ) : execution.triggerKind &&
                            execution.triggerKind !== "LIQUIDATION_WINDOW" ? (
                            <>
                              {strategyExecutionTriggerLabel(execution)}
                              <small>
                                参考价 {formatCompactDecimal(
                                  Number(execution.triggerReferencePrice) > 0
                                    ? execution.triggerReferencePrice
                                    : execution.liquidationPrice,
                                  8,
                                  "--",
                                )}
                              </small>
                            </>
                          ) : (
                            <>
                              {execution.liquidationNotional.toLocaleString("en-US", {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}{" "}
                              USDT
                              <small>
                                价格 {execution.liquidationPrice.toLocaleString("en-US", {
                                  maximumFractionDigits: 8,
                                })}
                              </small>
                            </>
                          )
                        )}
                      </td>
                      <td>
                        <span
                          className={`source-tag ${[
                            "REJECTED",
                            "EXPIRED",
                            "DATA_STALE",
                            "EXECUTION_UNKNOWN",
                          ].includes(execution.state) ? "danger-source" : execution.state === "CLOSED" ? "protect" : "auto"}`}
                        >
                          {strategyExecutionStateLabel(execution.state)}
                        </span>
                      </td>
                      <td>
                        <b>{execution.resultMessage ?? "正在等待下一阶段"}</b>
                        <small>{execution.resultCode ?? "IN_PROGRESS"}</small>
                        {strategyExecutionModelProgress(execution) && (
                          <small title={strategyExecutionModelProgress(execution)?.message}>
                            {strategyExecutionModelProgress(execution)?.phase === "VALIDATION"
                              ? `${strategyExecutionModelProgress(execution)?.learningTargetOrders ?? 150} 单学习周期已完成 · 数据验证期`
                              : strategyExecutionModelProgress(execution)?.phase === "EXPLORATION_10"
                                ? `启动探索 · ${strategyExecutionModelProgress(execution)?.committedEntryOrders ?? 0}/${strategyExecutionModelProgress(execution)?.targetOrders ?? 10} · 完整结算 ${strategyExecutionModelProgress(execution)?.completedExactNetOrders ?? 0}/${strategyExecutionModelProgress(execution)?.learningTargetOrders ?? 150}`
                                : `完整眼睛门槛 · 完整结算 ${strategyExecutionModelProgress(execution)?.completedExactNetOrders ?? 0}/${strategyExecutionModelProgress(execution)?.learningTargetOrders ?? 150}`}
                          </small>
                        )}
                      </td>
                      <td>
                        <button
                          className="text-action"
                          disabled={strategyExecutionDetailBusy}
                          onClick={() =>
                            void loadStrategyExecutionDetail(execution.traceId)
                          }
                        >
                          查看详情
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!strategyExecutionsBusy && strategyExecutions.length === 0 && (
                <div className="empty">
                  尚无策略触发记录。上方“当前判断”仍会持续显示监听门槛、最强候选与等待原因。
                </div>
              )}
              {strategyExecutionsBusy && strategyExecutions.length === 0 && (
                <div className="empty">正在读取策略运行日志…</div>
              )}
            </div>
            {strategyExecutionDetail && (
              <div className="strategy-execution-detail">
                <div className="strategy-execution-detail-head">
                  <div>
                    <b>
                      {strategyExecutionDetail.execution.symbol} · 执行链路详情
                    </b>
                    <small className="mono">
                      {strategyExecutionDetail.execution.traceId}
                    </small>
                    <small>
                      {strategyExecutionBranch(
                        strategyExecutionDetail.execution,
                      ) === "CONTRARIAN_PROBE"
                        ? "反向探针独立样本"
                        : "正常方向样本"}
                    </small>
                  </div>
                  <span>
                    {strategyExecutionModelProgress(strategyExecutionDetail.execution)?.phase === "VALIDATION"
                      ? "数据验证期"
                      : strategyExecutionModelProgress(strategyExecutionDetail.execution)?.phase === "EXPLORATION_10"
                        ? `启动探索 · ${strategyExecutionModelProgress(strategyExecutionDetail.execution)?.committedEntryOrders ?? 0}/${strategyExecutionModelProgress(strategyExecutionDetail.execution)?.targetOrders ?? 10} · 完整结算 ${strategyExecutionModelProgress(strategyExecutionDetail.execution)?.completedExactNetOrders ?? 0}/${strategyExecutionModelProgress(strategyExecutionDetail.execution)?.learningTargetOrders ?? 150}`
                      : strategyExecutionModelProgress(strategyExecutionDetail.execution)
                        ? `完整眼睛门槛 · 完整结算 ${strategyExecutionModelProgress(strategyExecutionDetail.execution)?.completedExactNetOrders ?? 0}/${strategyExecutionModelProgress(strategyExecutionDetail.execution)?.learningTargetOrders ?? 150}`
                        : strategyExecutionStateLabel(
                            strategyExecutionDetail.execution.state,
                          )}
                  </span>
                </div>
                <div className="strategy-execution-detail-grid">
                  <div className="execution-timeline">
                    <h3>判断与执行过程</h3>
                    {strategyExecutionDetail.events.map((event) => (
                      <article
                        key={event.id}
                        className={event.outcome.toLowerCase()}
                      >
                        <i></i>
                        <div>
                          <span>
                            {event.sequence}. {strategyExecutionStageLabel(event.stage)}
                          </span>
                          <b>{event.message}</b>
                          <small>
                            {new Date(event.eventAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}{" "}
                            · {event.outcome}
                          </small>
                          {strategyExecutionEventDetailSummary(event) && (
                            <small className="execution-event-evidence">
                              {strategyExecutionEventDetailSummary(event)}
                            </small>
                          )}
                        </div>
                      </article>
                    ))}
                    {strategyExecutionDetail.events.length === 0 && (
                      <div className="empty">
                        该历史链路产生于详细事件记录启用之前。
                      </div>
                    )}
                  </div>
                  <div className="execution-evidence">
                    <h3>持仓后波段结构与收益验证</h3>
                    <p>成交后第 1、3、5、15、30、60 分钟形成统一学习周期；继续持仓时按 2/3/4/8/12/24 小时稀疏记录趋势延续与利润回撤。第 1–10 分钟执行路径仍独立保留。</p>
                    <div className="execution-evidence-grid">
                      {strategyExecutionDetail.evidence
                        .filter((sample) =>
                          sample.detail.modelCheckpoint === true ||
                          sample.detail.longHoldObservation === true ||
                          [1, 3, 5, 15, 30, 60].includes(sample.minuteOffset)
                        )
                        .map((sample) => {
                        const marketRegime = strategyMarketRegime(sample.detail);
                        const breakdown = strategyBreakdownObservation(sample.detail);
                        const waveStructure = strategyWaveStructure(sample.detail);
                        return <article key={sample.id}>
                          <span>第 {sample.minuteOffset} 分钟</span>
                          <b
                            className={
                              (sample.roePercent ?? 0) >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {sample.roePercent == null
                              ? "待采样"
                              : `${sample.roePercent >= 0 ? "+" : ""}${sample.roePercent.toFixed(2)}% ROE`}
                          </b>
                          <small>
                            {strategyPositionEvidenceStatusLabel(sample)} · 标记价{" "}
                            {sample.markPrice?.toLocaleString("en-US", {
                              maximumFractionDigits: 8,
                            }) ?? "—"}
                          </small>
                          {marketRegime && (
                            <small className={`market-regime ${marketRegime.status?.toLowerCase() ?? "unavailable"}`} title={marketRegime.reason}>
                              {marketRegime.label ?? "大盘状态未知"} · BTC {marketRegime.btcChangePercent24h?.toFixed(2) ?? "—"}% · ETH {marketRegime.ethChangePercent24h?.toFixed(2) ?? "—"}% · 上涨广度 {marketRegime.positiveBreadthPercent?.toFixed(0) ?? "—"}%
                            </small>
                          )}
                          {breakdown && (
                            <small
                              className={`breakdown-observation ${(breakdown.status ?? "unavailable").toLowerCase()}`}
                              title={breakdown.reason}
                            >
                              {breakdown.label ?? "破位状态未知"} · 连续失守{" "}
                              {breakdown.consecutiveClosedMinutesBelowBoundary ?? 0} 分钟 · SELL强平{" "}
                              {(breakdown.sellLiquidationNotional ?? 0).toLocaleString("en-US", {
                                maximumFractionDigits: 2,
                              })} USDT
                            </small>
                          )}
                          {waveStructure && (
                            <small
                              className={`breakdown-observation ${(waveStructure.state ?? "unavailable").toLowerCase()}`}
                              title={waveStructure.summary}
                            >
                              {waveStructure.state === "NORMAL_RANGE"
                                ? "正常区间波动"
                                : waveStructure.state === "UPSIDE_BREAKOUT"
                                  ? "突破前高·波段延续"
                                  : waveStructure.state === "SUPPORT_BREAK"
                                    ? "5分钟收盘跌破支撑"
                                    : "波段结构待补"}
                            </small>
                          )}
                        </article>;
                      })}
                    </div>
                    {strategyExecutionDetail.evidence.length === 0 && (
                      <div className="empty">
                        该链路未进入持仓，因此没有持仓后验证样本。
                      </div>
                    )}
                    {strategyExecutionDetail.postEntryAnalysis && (
                      <div className="post-entry-analysis">
                        <div className="post-entry-analysis-head">
                          <div>
                            <h3>{strategyExecutionDetail.postEntryAnalysis.observationMode === "REJECTED_COUNTERFACTUAL" ? "拒绝信号反事实复盘" : "下单证据对比与参数建议"}</h3>
                            <p>{strategyExecutionDetail.postEntryAnalysis.summary}</p>
                          </div>
                          <span className={`analysis-quality ${strategyExecutionDetail.postEntryAnalysis.quality.toLowerCase()}`}>
                            {strategyExecutionDetail.postEntryAnalysis.quality === "MISSED_WIN" ? "潜在错失" :
                              strategyExecutionDetail.postEntryAnalysis.quality === "AVOIDED_LOSS" ? "避免亏损" :
                                strategyExecutionDetail.postEntryAnalysis.quality === "NO_TRIGGER" ? "无触发" :
                                  strategyExecutionDetail.postEntryAnalysis.quality === "AMBIGUOUS" ? "路径不明" :
                                  strategyExecutionDetail.postEntryAnalysis.quality === "GOOD" ? "入场良好" :
                              strategyExecutionDetail.postEntryAnalysis.quality === "GIVEBACK" ? "利润回撤" :
                                strategyExecutionDetail.postEntryAnalysis.quality === "LATE" ? "入场偏晚" :
                                  strategyExecutionDetail.postEntryAnalysis.quality === "WEAK" ? "确认偏弱" : "样本积累中"}
                          </span>
                        </div>
                        <div className="post-entry-metrics">
                          <article>
                            <span>主导波段假设</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "FOLLOW_THROUGH"
                                ? "positive"
                                : strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "FAILED_STRUCTURE"
                                  ? "negative"
                                  : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "FOLLOW_THROUGH"
                                ? "走势跟随"
                                : strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "FAILED_STRUCTURE"
                                  ? "结构失败"
                                  : strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "CAPITAL_WITHDRAWAL"
                                    ? "承接资金撤退"
                                  : strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "PROFIT_GIVEBACK"
                                    ? "方向对·保护不足"
                                    : strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "UNRESOLVED"
                                      ? "尚未确认"
                                      : strategyExecutionDetail.postEntryAnalysis.waveThesisOutcome === "INSUFFICIENT"
                                        ? "样本积累中"
                                        : "旧版无假设"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.waveThesisId ?? ""}>
                              {strategyExecutionDetail.postEntryAnalysis.waveThesisSummary}
                            </small>
                          </article>
                          <article>
                            <span>方向 / 入场时机归因</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis.waveDirectionVerdict === "INVALIDATED"
                                ? "negative"
                                : strategyExecutionDetail.postEntryAnalysis.waveDirectionVerdict === "VALIDATED_EARLY" ||
                                    strategyExecutionDetail.postEntryAnalysis.waveDirectionVerdict === "VALIDATED_LATE"
                                  ? "positive"
                                  : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis.waveDirectionVerdict === "VALIDATED_EARLY"
                                ? "方向及时验证"
                                : strategyExecutionDetail.postEntryAnalysis.waveDirectionVerdict === "VALIDATED_LATE"
                                  ? strategyExecutionDetail.postEntryAnalysis.waveEntryTimingVerdict === "TOO_EARLY"
                                    ? "方向正确·入场偏早"
                                    : "方向延迟验证"
                                  : strategyExecutionDetail.postEntryAnalysis.waveDirectionVerdict === "INVALIDATED"
                                    ? strategyExecutionDetail.postEntryAnalysis.waveEntryTimingVerdict === "CHASED"
                                      ? "方向失败·存在追价"
                                      : "方向判断失败"
                                    : strategyExecutionDetail.postEntryAnalysis.waveDirectionVerdict === "INSUFFICIENT"
                                      ? "样本积累中"
                                      : "尚未归因"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.waveEntryAttributionSummary}>
                              {strategyExecutionDetail.postEntryAnalysis.waveEntryAttributionSummary}
                            </small>
                          </article>
                          <article>
                            <span>更深限价影子对照</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual30m.status === "FILLED" &&
                                  (strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual30m.advantageRoePercent ?? 0) > 0
                                ? "positive"
                                : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual30m.status === "FILLED"
                                ? `第 ${strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual30m.fillMinute} 分钟可成交`
                                : strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual30m.status === "NOT_FILLED"
                                  ? "更深价格会错失"
                                  : "证据不足"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual60m.summary}>
                              额外偏移 {strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual30m.extraOffsetPercent.toFixed(3)}% · ROE改善 30/60分钟 {strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual30m.advantageRoePercent?.toFixed(2) ?? "—"}% / {strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual60m.evaluationMinute === 60 ? `${strategyExecutionDetail.postEntryAnalysis.deeperLimitCounterfactual60m.advantageRoePercent?.toFixed(2) ?? "—"}%` : "待采样"}
                            </small>
                          </article>
                          <article>
                            <span>延迟收回影子对照</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.status === "ENTERED" &&
                                  (strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.advantageRoePercent ?? 0) > 0
                                ? "positive"
                                : strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.status === "NO_CONFIRMATION"
                                  ? "negative"
                                  : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.status === "ENTERED"
                                ? `第 ${strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.confirmationMinute} 分钟确认`
                                : strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.status === "NO_CONFIRMATION"
                                  ? "未收回·跳过"
                                  : strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.status === "NOT_APPLICABLE"
                                    ? "无需延迟"
                                    : "证据不足"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual60m.summary}>
                              逆向触发 {strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.adverseTriggerRoePercent.toFixed(2)}% ROE · 改善 30/60分钟 {strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual30m.advantageRoePercent?.toFixed(2) ?? "—"}% / {strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual60m.evaluationMinute === 60 ? `${strategyExecutionDetail.postEntryAnalysis.delayedReclaimCounterfactual60m.advantageRoePercent?.toFixed(2) ?? "—"}%` : "待采样"}
                            </small>
                          </article>
                          <article>
                            <span>持仓后聚合仓位</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis.latestPostEntryLargeTraderStatus === "SUPPORT_CONTINUES"
                                ? "positive"
                                : strategyExecutionDetail.postEntryAnalysis.latestPostEntryLargeTraderStatus === "CAPITAL_WITHDRAWAL"
                                  ? "negative"
                                  : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis.latestPostEntryLargeTraderStatus === "SUPPORT_CONTINUES"
                                ? "承接延续"
                                : strategyExecutionDetail.postEntryAnalysis.latestPostEntryLargeTraderStatus === "CAPITAL_WITHDRAWAL"
                                  ? "资金撤退"
                                  : strategyExecutionDetail.postEntryAnalysis.latestPostEntryLargeTraderStatus === "MIXED"
                                    ? "信号分歧"
                                    : strategyExecutionDetail.postEntryAnalysis.latestPostEntryLargeTraderStatus === "UNAVAILABLE"
                                      ? "数据不足"
                                      : "等待5/30/60分钟"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.postEntryLargeTraderContextSummary}>
                              延续 {strategyExecutionDetail.postEntryAnalysis.postEntryLargeTraderSupportRatio === null ? "—" : `${(strategyExecutionDetail.postEntryAnalysis.postEntryLargeTraderSupportRatio * 100).toFixed(0)}%`} · 撤退 {strategyExecutionDetail.postEntryAnalysis.postEntryLargeTraderWithdrawalRatio === null ? "—" : `${(strategyExecutionDetail.postEntryAnalysis.postEntryLargeTraderWithdrawalRatio * 100).toFixed(0)}%`}
                            </small>
                          </article>
                          <article>
                            <span>资金撤退退出影子</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.status === "PROTECTIVE"
                                ? "positive"
                                : strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.status === "MISSED_RECOVERY"
                                  ? "negative"
                                  : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.status === "PROTECTIVE"
                                ? "提前退出可保护"
                                : strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.status === "MISSED_RECOVERY"
                                  ? "可能错失恢复"
                                  : strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.status === "INCOMPLETE"
                                    ? "等待后续样本"
                                    : strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.status === "NEUTRAL"
                                      ? "差异不足"
                                      : "暂无撤退信号"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.summary}>
                              信号第 {strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.signalMinute ?? "—"} 分钟 · 相对后续 {strategyExecutionDetail.postEntryAnalysis.capitalExitShadow.advantageVsLatestRoePercent?.toFixed(2) ?? "—"}% ROE
                            </small>
                          </article>
                          <article>
                            <span>持仓判断后验</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis
                                  .positionManagementDecisionOutcome.status ===
                                  "SUPPORTED"
                                ? "positive"
                                : strategyExecutionDetail.postEntryAnalysis
                                      .positionManagementDecisionOutcome
                                      .status === "CONTRADICTED"
                                  ? "negative"
                                  : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis
                                  .positionManagementDecisionOutcome.status ===
                                  "SUPPORTED"
                                ? "后续路径支持"
                                : strategyExecutionDetail.postEntryAnalysis
                                      .positionManagementDecisionOutcome
                                      .status === "CONTRADICTED"
                                  ? "后续路径反证"
                                  : strategyExecutionDetail.postEntryAnalysis
                                        .positionManagementDecisionOutcome
                                        .status === "INCOMPLETE"
                                    ? "等待后续样本"
                                    : strategyExecutionDetail.postEntryAnalysis
                                          .positionManagementDecisionOutcome
                                          .status === "INCONCLUSIVE"
                                      ? "差异不足"
                                      : "暂无可验证判断"}
                            </b>
                            <small title={
                              strategyExecutionDetail.postEntryAnalysis
                                .positionManagementDecisionOutcome.summary
                            }>
                              判断第 {strategyExecutionDetail.postEntryAnalysis
                                .positionManagementDecisionOutcome
                                .signalMinute ?? "—"} 分钟 · 对照第{" "}
                              {strategyExecutionDetail.postEntryAnalysis
                                .positionManagementDecisionOutcome
                                .comparisonMinute ?? "—"} 分钟 ·{" "}
                              {strategyExecutionDetail.postEntryAnalysis
                                  .positionManagementDecisionOutcome
                                  .signalCausalEvidenceReady
                                ? "判断证据完整"
                                : "仅价格复盘"}
                            </small>
                          </article>
                          {strategyExecutionDetail.postEntryAnalysis.observationMode === "REJECTED_COUNTERFACTUAL" && (
                            <article>
                              <span>哨兵影子入场验证</span>
                              <b className={
                                strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.status === "FILTER_VALIDATED"
                                  ? "positive"
                                  : strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.status === "MISSED_ENTRY"
                                    ? "warning"
                                    : ""
                              }>
                                {strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.status === "FILTER_VALIDATED"
                                  ? "过滤有效"
                                  : strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.status === "MISSED_ENTRY"
                                    ? "潜在错失"
                                    : strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.status === "MIXED_PATH"
                                      ? "分钟路径不明"
                                      : strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.status === "NO_EDGE"
                                        ? "未发现优势"
                                        : "采样中"}
                              </b>
                              <small title={strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.summary}>
                                已观察 {strategyExecutionDetail.postEntryAnalysis.sentinelShadowEntryValidation.observedHorizons.join("/") || "—"} 分钟 · 只读验证，不影响下单
                              </small>
                            </article>
                          )}
                          <article><span>最新ROE</span><b>{strategyExecutionDetail.postEntryAnalysis.latestRoePercent?.toFixed(2) ?? "—"}%</b><small>第 {strategyExecutionDetail.postEntryAnalysis.latestMinute ?? "—"} 分钟</small></article>
                          <article><span>最高 / 最低ROE</span><b>{strategyExecutionDetail.postEntryAnalysis.bestRoePercent?.toFixed(2) ?? "—"}% / {strategyExecutionDetail.postEntryAnalysis.worstRoePercent?.toFixed(2) ?? "—"}%</b><small>{strategyExecutionDetail.postEntryAnalysis.observationMode === "REJECTED_COUNTERFACTUAL" ? "决策后的反事实波动" : "实际有利与不利波动"}</small></article>
                          <article><span>正收益分钟占比</span><b>{strategyExecutionDetail.postEntryAnalysis.positiveMinuteRatio === null ? "—" : `${(strategyExecutionDetail.postEntryAnalysis.positiveMinuteRatio * 100).toFixed(0)}%`}</b><small>{strategyExecutionDetail.postEntryAnalysis.sampleCount} 个有效样本</small></article>
                          <article>
                            <span>学习证据完整性</span>
                            <b className={strategyExecutionDetail.postEntryAnalysis.causalAttributionReady ? "positive" : "warning"}>
                              {strategyExecutionDetail.postEntryAnalysis.causalAttributionReady
                                ? "可做因果对比"
                                : "仅观察，不改参数"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.evidenceCompletenessSummary}>
                              完整 {strategyExecutionDetail.postEntryAnalysis.causalEvidenceSampleCount} · 不完整 {strategyExecutionDetail.postEntryAnalysis.incompleteCausalSampleCount} · 仅价格 {strategyExecutionDetail.postEntryAnalysis.priceOnlySampleCount}
                            </small>
                          </article>
                          <article><span>入场滑点</span><b>{strategyExecutionDetail.postEntryAnalysis.entrySlippagePercent?.toFixed(3) ?? "—"}%</b><small>{strategyExecutionDetail.postEntryAnalysis.observationMode === "REJECTED_COUNTERFACTUAL" ? "未成交，不计算滑点" : "实际成交价对比判断价"}</small></article>
                          <article>
                            <span>自适应委托选择</span>
                            <b>
                              {strategyExecutionDetail.postEntryAnalysis.entryConfiguredOrderMode === "ADAPTIVE"
                                ? strategyExecutionDetail.postEntryAnalysis.entrySelectedOrderType === "MARKET"
                                  ? "市价跟随"
                                  : strategyExecutionDetail.postEntryAnalysis.entrySelectedOrderType === "LIMIT"
                                    ? "限价承接"
                                    : "证据待补"
                                : "固定委托"}
                            </b>
                            <small>
                              距确认位 {strategyExecutionDetail.postEntryAnalysis.entryAdaptiveDistanceAtr?.toFixed(2) ?? "—"} ATR · 边界 {strategyExecutionDetail.postEntryAnalysis.entryAdaptiveThresholdAtr?.toFixed(2) ?? "—"} ATR
                            </small>
                          </article>
                          <article><span>72h执行位置 / 24h观察</span><b>{strategyExecutionDetail.postEntryAnalysis.entryPosition72hPercent?.toFixed(1) ?? "—"}% / {strategyExecutionDetail.postEntryAnalysis.entryPosition24hPercent?.toFixed(1) ?? "—"}%</b><small>仅72小时位置参与入场判断</small></article>
                          <article><span>量能 / 入场距离</span><b>{strategyExecutionDetail.postEntryAnalysis.entryVolumeRatio3m?.toFixed(2) ?? "—"}× / {strategyExecutionDetail.postEntryAnalysis.entryDistanceAtr?.toFixed(2) ?? "—"} ATR</b><small>下单时证据</small></article>
                          <article>
                            <span>异构证据共识影子</span>
                            <b className={
                              strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "STRICT_CONSENSUS" ||
                                strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "RECOVERY_CONSENSUS"
                                ? "positive"
                                : strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "CONFLICT"
                                  ? "negative"
                                  : ""
                            }>
                              {strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "STRICT_CONSENSUS"
                                ? "严格共识"
                                : strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "RECOVERY_CONSENSUS"
                                  ? "恢复共识"
                                  : strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "CONFLICT"
                                    ? "关键冲突"
                                    : strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "MIXED"
                                      ? "证据分歧"
                                      : strategyExecutionDetail.postEntryAnalysis.entryConsensusVerdict === "INCOMPLETE"
                                        ? "证据不足"
                                        : "旧版无数据"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.consensusContextSummary}>
                              支持 {strategyExecutionDetail.postEntryAnalysis.entryConsensusSupportCount ?? "—"}/7 · 冲突 {strategyExecutionDetail.postEntryAnalysis.entryConsensusConflictCount ?? "—"} · ROE 5/30/60分钟 {strategyExecutionDetail.postEntryAnalysis.consensusRoe5mPercent?.toFixed(2) ?? "—"}% / {strategyExecutionDetail.postEntryAnalysis.consensusRoe30mPercent?.toFixed(2) ?? "—"}% / {strategyExecutionDetail.postEntryAnalysis.consensusRoe60mPercent?.toFixed(2) ?? "—"}%
                            </small>
                          </article>
                          <article>
                            <span>大户聚合入场确认</span>
                            <b>{strategyExecutionDetail.postEntryAnalysis.entryLargeTraderConfirmationMode === "CAPITAL_CONCENTRATION_LONG" ? "少数大户集中增多" : strategyExecutionDetail.postEntryAnalysis.entryLargeTraderConfirmationMode === "BROAD_LONG" ? "大户普遍增多" : strategyExecutionDetail.postEntryAnalysis.entryLargeTraderStatus === "CONFLICTS_LONG" ? "加空冲突" : strategyExecutionDetail.postEntryAnalysis.entryLargeTraderStatus === "NEUTRAL" ? "方向中性" : strategyExecutionDetail.postEntryAnalysis.entryLargeTraderStatus === "UNAVAILABLE" ? "数据不可用" : "旧版无数据"}</b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.largeTraderContextSummary}>
                              OI {strategyExecutionDetail.postEntryAnalysis.entryOpenInterestChangePercent == null ? "—" : `${strategyExecutionDetail.postEntryAnalysis.entryOpenInterestChangePercent >= 0 ? "+" : ""}${strategyExecutionDetail.postEntryAnalysis.entryOpenInterestChangePercent.toFixed(2)}%`} · 持仓比 {strategyExecutionDetail.postEntryAnalysis.entryTopPositionRatioChangePercent == null ? "—" : `${strategyExecutionDetail.postEntryAnalysis.entryTopPositionRatioChangePercent >= 0 ? "+" : ""}${strategyExecutionDetail.postEntryAnalysis.entryTopPositionRatioChangePercent.toFixed(2)}%`} · 账户比 {strategyExecutionDetail.postEntryAnalysis.entryTopAccountRatioChangePercent == null ? "—" : `${strategyExecutionDetail.postEntryAnalysis.entryTopAccountRatioChangePercent >= 0 ? "+" : ""}${strategyExecutionDetail.postEntryAnalysis.entryTopAccountRatioChangePercent.toFixed(2)}%`} · 主动买卖 {strategyExecutionDetail.postEntryAnalysis.entryTakerBuySellRatio?.toFixed(2) ?? "—"}
                            </small>
                          </article>
                          <article>
                            <span>局部流动性扫盘</span>
                            <b>{strategyExecutionDetail.postEntryAnalysis.entryLiquiditySweepStatus === "RECLAIMED" ? "扫破后收回" : strategyExecutionDetail.postEntryAnalysis.entryLiquiditySweepStatus ?? "旧版无数据"}</b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.liquiditySweepContextSummary}>
                              扫破 {strategyExecutionDetail.postEntryAnalysis.entrySweepDepthAtr?.toFixed(2) ?? "—"} ATR · 前区间 {strategyExecutionDetail.postEntryAnalysis.entryPriorRangeAtr?.toFixed(2) ?? "—"} ATR · {strategyExecutionDetail.postEntryAnalysis.entryPriorRangeState === "COMPRESSED" ? "震荡压缩" : strategyExecutionDetail.postEntryAnalysis.entryPriorRangeState === "BROAD" ? "宽幅区间" : "—"}
                            </small>
                          </article>
                          <article>
                            <span>破位后1/3/5分钟影子验证</span>
                            <b className={strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryOutcome === "TAKE_PROFIT_FIRST" ? "positive" : strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryOutcome === "STOP_LOSS_FIRST" ? "negative" : ""}>
                              {strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryStatus === "QUALIFIED"
                                ? strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryOutcome === "TAKE_PROFIT_FIRST"
                                  ? "通过 · 先止盈"
                                  : strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryOutcome === "STOP_LOSS_FIRST"
                                    ? "通过 · 先止损"
                                    : strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryOutcome === "AMBIGUOUS"
                                      ? "通过 · 路径不明"
                                      : "通过 · 未触发"
                                : strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryStatus === "REJECTED"
                                  ? "未通过影子条件"
                                  : strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryStatus === "INCOMPLETE"
                                    ? "数据不足"
                                    : "不适用"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoverySummary}>
                              {strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryStatus === "QUALIFIED"
                                ? `影子入场 ${formatCompactDecimal(strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryEntryPrice, 8)} · 量能 ${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryVolumeRatio3m?.toFixed(2) ?? "—"}×/${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryVolumeRatio5m?.toFixed(2) ?? "—"}× · MFE ${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryMfeRoePercent?.toFixed(2) ?? "—"}% / MAE ${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryMaeRoePercent?.toFixed(2) ?? "—"}% · 止盈第 ${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryTakeProfitMinute ?? "—"} 分钟 / 止损第 ${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryStopLossMinute ?? "—"} 分钟 · 退出估算 ${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent?.toFixed(2) ?? "—"}%～${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryEstimatedGrossRoePercent?.toFixed(2) ?? "—"}% ROE（${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryEstimatedExitReason ?? "—"} / 第 ${strategyExecutionDetail.postEntryAnalysis.postBreakLocalRecoveryEstimatedExitMinute ?? "—"} 分钟）`
                                : "仅验证假设，未真实下单；按完整1分钟反转、3分钟量价和5分钟局部收回判断"}
                            </small>
                          </article>
                          <article>
                            <span>{strategyExecutionDetail.postEntryAnalysis.entryTriggerKind === "LOW_POSITION_WINDOW" ? "72小时低位触发" : "单币连续爆仓"}</span>
                            <b>{strategyExecutionDetail.postEntryAnalysis.entryTriggerKind === "LOW_POSITION_WINDOW"
                              ? `${strategyExecutionDetail.postEntryAnalysis.entryPosition72hPercent?.toFixed(1) ?? "—"}% 区间位置`
                              : strategyExecutionDetail.postEntryAnalysis.entryLiquidationClusterCount == null
                                ? "旧版无数据"
                                : `${strategyExecutionDetail.postEntryAnalysis.entryLiquidationClusterCount} 簇 / ${strategyExecutionDetail.postEntryAnalysis.entryLiquidationEventCount ?? strategyExecutionDetail.postEntryAnalysis.entryLiquidationClusterCount} 事件`}</b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.liquidationClusterContextSummary}>
                              {strategyExecutionDetail.postEntryAnalysis.entryTriggerKind === "LOW_POSITION_WINDOW"
                                ? "独立价格位置事实唤醒；爆仓金额和爆仓次数不参与本次归因"
                                : `本合约累计 ${strategyExecutionDetail.postEntryAnalysis.entryLiquidationClusterNotional?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "—"} USDT · ${strategyExecutionDetail.postEntryAnalysis.entryLiquidationClusterSpanMs == null ? "—" : (strategyExecutionDetail.postEntryAnalysis.entryLiquidationClusterSpanMs / 1000).toFixed(1)} 秒 · ${strategyExecutionDetail.postEntryAnalysis.entrySymbolLiquidationSharePercent == null || strategyExecutionDetail.postEntryAnalysis.entrySymbolLiquidationSharePercent === 100 ? "单币独立触发" : `旧版市场簇贡献 ${strategyExecutionDetail.postEntryAnalysis.entrySymbolLiquidationSharePercent.toFixed(2)}% / #${strategyExecutionDetail.postEntryAnalysis.entrySymbolContributionRank ?? "—"}`}`}
                            </small>
                          </article>
                          <article>
                            <span>入场并发暴露</span>
                            <b className={strategyExecutionDetail.postEntryAnalysis.entryIndependentOpportunity === false ? "negative" : ""}>
                              {strategyExecutionDetail.postEntryAnalysis.entryOpenPositionCount === null
                                ? "旧版无数据"
                                : strategyExecutionDetail.postEntryAnalysis.entryIndependentOpportunity
                                  ? "独立波段机会"
                                  : "重复波段暴露"}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.concurrentExposureSummary}>
                              入场已有 {strategyExecutionDetail.postEntryAnalysis.entryOpenPositionCount ?? "—"} 仓 · 同一触发事实 {strategyExecutionDetail.postEntryAnalysis.entrySameMarketClusterOpenPositions ?? "—"} 仓
                            </small>
                          </article>
                          <article>
                            <span>最终平仓结果</span>
                            <b className={strategyExecutionDetail.postEntryAnalysis.finalOutcome === "WIN" ? "positive" : strategyExecutionDetail.postEntryAnalysis.finalOutcome === "LOSS" ? "negative" : ""}>
                              {strategyExecutionDetail.postEntryAnalysis.finalRealizedPnl == null ? "待确认" : `${strategyExecutionDetail.postEntryAnalysis.finalRealizedPnl >= 0 ? "+" : ""}${strategyExecutionDetail.postEntryAnalysis.finalRealizedPnl.toFixed(4)} USDT ${strategyExecutionDetail.postEntryAnalysis.finalPnlBasis === "NET_EXACT" ? "净" : "毛·待补"}`}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.finalOutcomeSummary}>
                              {strategyExecutionDetail.postEntryAnalysis.finalOutcome === "OPEN" ? "仓位尚未结束" : strategyExecutionDetail.postEntryAnalysis.finalExitReason ?? "最终结果暂不可归因"}
                            </small>
                          </article>
                          <article>
                            <span>大盘环境归因</span>
                            <b>{strategyExecutionDetail.postEntryAnalysis.favorableMarketRatio === null ? "—" : `${(strategyExecutionDetail.postEntryAnalysis.favorableMarketRatio * 100).toFixed(0)}% 顺风`} / {strategyExecutionDetail.postEntryAnalysis.adverseMarketRatio === null ? "—" : `${(strategyExecutionDetail.postEntryAnalysis.adverseMarketRatio * 100).toFixed(0)}% 逆风`}</b>
                            <small title={`${strategyExecutionDetail.postEntryAnalysis.entryMarketTransitionSummary}；${strategyExecutionDetail.postEntryAnalysis.marketContextSummary}`}>
                              {strategyExecutionDetail.postEntryAnalysis.entryMarketTransitionSummary}
                            </small>
                          </article>
                          <article>
                            <span>长持波段验证</span>
                            <b className={strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.status === "RECOVERED" || strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.status === "PROFIT_EXTENDING" ? "positive" : strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.status === "GIVEBACK" || strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.status === "WEAKENING" ? "negative" : ""}>
                              {strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.latestMinute === null
                                ? "等待 120 分钟"
                                : `第 ${strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.latestMinute} 分钟`}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.summary}>
                              {strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.latestRoePercent === null
                                ? "与 5/30/60 分钟入场质量分开统计"
                                : `ROE ${strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.latestRoePercent >= 0 ? "+" : ""}${strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.latestRoePercent.toFixed(2)}% · 较60分钟 ${strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.recoveryFrom60mRoePercent === null ? "—" : `${strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.recoveryFrom60mRoePercent >= 0 ? "+" : ""}${strategyExecutionDetail.postEntryAnalysis.longHoldAnalysis.recoveryFrom60mRoePercent.toFixed(2)}%`}`}
                            </small>
                          </article>
                          <article>
                            <span>全市场爆仓背景</span>
                            <b className={strategyExecutionDetail.postEntryAnalysis.globalLiquidationTrendChanged ? "warning" : ""}>
                              {globalLiquidationTrendLabel(strategyExecutionDetail.postEntryAnalysis.latestGlobalLiquidationTrend)}
                            </b>
                            <small title={strategyExecutionDetail.postEntryAnalysis.globalLiquidationContextSummary}>
                              {globalLiquidationTrendLabel(strategyExecutionDetail.postEntryAnalysis.latestGlobalLiquidationSwing)} · {strategyExecutionDetail.postEntryAnalysis.globalLiquidationTrendChanged === null ? "样本不足" : strategyExecutionDetail.postEntryAnalysis.globalLiquidationTrendChanged ? "持仓期间背景切换" : "持仓期间背景延续"}
                            </small>
                          </article>
                        </div>
                        <div className="post-entry-suggestions">
                          {strategyExecutionDetail.postEntryAnalysis.suggestions.map((suggestion, index) => (
                            <article key={`${suggestion.parameterName}-${index}`} className={suggestion.action.toLowerCase()}>
                              <div>
                                <b>{suggestion.label}</b>
                                <span>{suggestion.action === "KEEP" ? "保持" : suggestion.action === "TIGHTEN" ? "收紧" : suggestion.action === "LOOSEN" ? "放宽" : "继续观察"}</span>
                              </div>
                              <p>{suggestion.reason}</p>
                              <small>当前 {formatStrategySuggestionValue(suggestion.currentValue)} → 建议 {formatStrategySuggestionValue(suggestion.suggestedValue)} · 可信度 {(suggestion.confidence * 100).toFixed(0)}%</small>
                            </article>
                          ))}
                        </div>
                        <div className="strategy-suggestion-safety">
                          仅每个策略终身前 10 个真实入场允许先下单后分析；第 11 单起必须先由眼睛 CONFIRMED。系统继续积累 150 个可核对净收益的完整周期用于学习和参数建议，每日强化只分析当日环境，不恢复先下单权限，也不会自动修改实盘参数。
                        </div>
                      </div>
                    )}
                    <MovingProtectionReviewCard
                      suggestion={strategyExecutionDetail.suggestions.find(
                        (suggestion) =>
                          suggestion.parameterName ===
                          "risk.movingProtectionReview",
                      )}
                    />
                    {strategyExecutionDetail.suggestions.some(
                      (suggestion) =>
                        suggestion.parameterName !==
                        "risk.movingProtectionReview",
                    ) && (
                      <div className="aggregate-strategy-suggestions">
                        <h3>跨订单参数建议</h3>
                        {strategyExecutionDetail.suggestions
                          .filter(
                            (suggestion) =>
                              suggestion.parameterName !==
                              "risk.movingProtectionReview",
                          )
                          .map((suggestion) => (
                          <article key={suggestion.id}>
                            <div>
                              <b>{suggestion.evidence.label ?? suggestion.parameterName}</b>
                              {suggestion.evidence.action !== "KEEP" &&
                                suggestion.evidence.action !== "OBSERVE" &&
                                suggestion.evidence.proposalMode === "DRAFT_ONLY" &&
                                suggestion.evidence.learningEligible === true &&
                                suggestion.evidence.automaticPublishAllowed === false &&
                                strategyExecutionDetail.execution.configVersion ===
                                  strategyExecutionTarget.configVersion &&
                                APPLYABLE_STRATEGY_SUGGESTION_PATHS.has(suggestion.parameterName) &&
                                (typeof suggestion.suggestedValue === "number" ||
                                  (suggestion.parameterName === "liquidationFactors.mode" &&
                                    suggestion.suggestedValue === "LIVE") ||
                                  (suggestion.parameterName === "execution.orderType" &&
                                    (suggestion.suggestedValue === "MARKET" ||
                                      suggestion.suggestedValue === "LIMIT_OFFSET"))) && (
                                  <button
                                    type="button"
                                    onClick={() => applyAggregateSuggestionToDraft(suggestion)}
                                  >
                                    带入参数草稿
                                  </button>
                                )}
                            </div>
                            <span>{formatStrategySuggestionValue(suggestion.currentValue)} → {formatStrategySuggestionValue(suggestion.suggestedValue)}</span>
                            <p>{suggestion.evidence.reason ?? "基于持仓后短周期与延长波段观察生成"}</p>
                            <small>{suggestion.sampleCount} 笔完整订单 · 可信度 {((suggestion.evidence.confidence ?? 0) * 100).toFixed(0)}%</small>
                          </article>
                          ))}
                        <div className="strategy-suggestion-safety">
                          只有完成 10 个真实完整订单周期并进入验证期，跨订单建议才可以带入草稿；带入不会自动保存或下单。
                        </div>
                      </div>
                    )}
                    {strategyExecutionDetail.configValidation &&
                      strategyExecutionDetail.configValidation.status !== "NOT_APPLICABLE" && (
                        <div className="strategy-suggestion-safety">
                          人工建议版本 V{strategyExecutionDetail.configValidation.configVersion}：
                          {strategyExecutionDetail.configValidation.status === "COLLECTING"
                            ? `小样本验证中 ${strategyExecutionDetail.configValidation.completedCycles}/${strategyExecutionDetail.configValidation.targetCycles}`
                            : strategyExecutionDetail.configValidation.status === "PROMOTION_READY"
                              ? `已完成 ${strategyExecutionDetail.configValidation.completedCycles} 个费用后完整周期，达到晋升规则，等待人工确认`
                              : strategyExecutionDetail.configValidation.status === "ROLLED_BACK"
                                ? "候选已恶化回退，失败样本进入重新学习"
                                : strategyExecutionDetail.configValidation.status === "PROMOTED"
                                  ? "已人工晋升为稳定基线"
                                  : "候选已触发恶化线，禁止继续开仓并回退"}
                          {strategyExecutionDetail.configValidation.exactNetPnlUsdt !== null
                            ? ` · 净收益 ${strategyExecutionDetail.configValidation.exactNetPnlUsdt.toFixed(4)} USDT`
                            : ""}
                          ；晋升不自动执行，恶化会自动恢复上一稳定版本。
                        </div>
                      )}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
        {active === "auto" && (
          <section className="panel strategy-account-bar">
            <div>
              <b>策略运行子账户</b>
              <small>交易币种由策略扫描范围控制，账户页不限制币种</small>
            </div>
            <label className="field">
              <span>交易子账户</span>
              <select
                value={strategyConfig.accountId}
                onChange={(event) => {
                  const accountId = event.target.value;
                  setStrategyConfig((current) => ({
                    ...current,
                    accountId,
                  }));
                  setPreflight(null);
                }}
              >
                {tradingAccounts
                  .filter(
                    (account) =>
                      account.isActive && account.accountType === "STRATEGY",
                  )
                  .map((account) => (
                    <option key={account.id} value={account.accountId}>
                      {account.accountId} · {account.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>策略杠杆</span>
              <select
                value={liquidationExecutionUi(strategyConfig)?.leverage ?? 10}
                onChange={(event) =>
                  setStrategyConfig((current) =>
                    withLiquidationExecution(current, {
                      leverage: Number(event.target.value),
                    }),
                  )
                }
              >
                {Array.from(
                  { length: AUTOMATED_STRATEGY_MAX_LEVERAGE },
                  (_, index) => index + 1,
                ).map((leverage) => (
                  <option key={leverage} value={leverage}>{leverage}×</option>
                ))}
              </select>
              <small>
                由当前策略参数控制，范围 1–{AUTOMATED_STRATEGY_MAX_LEVERAGE}×；实际仍受 Binance 合约上限约束
              </small>
            </label>
            <div className="strategy-account-limit">
              <span>执行模式</span>
              <b
                className={
                  strategyTradingAccount?.executionMode === "LIVE"
                    ? "negative"
                    : "positive"
                }
              >
                {strategyTradingAccount?.executionMode === "LIVE"
                  ? "实盘"
                  : "待启用"}
              </b>
              <small>仅可在账户管理切换 · 主账户禁止交易</small>
            </div>
            <div className="strategy-account-limit strategy-dynamic-margin">
              <span>今日策略开仓保证金</span>
              <b className="positive">
                {configuredStrategy?.runtimeMargin
                  ? `${configuredStrategy.runtimeMargin.usedMarginUsdt.toFixed(2)} USDT`
                  : "待同步"}
              </b>
              <small>仅作运营统计，不再限制新开仓或缩小订单</small>
            </div>
          </section>
        )}
        {active === "auto" && (
          <>
            <section className="panel strategy-runtime-toolbar">
              <div className="strategy-runtime-summary">
                <b>{configuredStrategy?.name ?? "尚未选择策略"}</b>
                <span>
                  V
                  {configuredStrategy?.publishedVersion ??
                    configuredStrategy?.configVersion ??
                    0}
                </span>
                <span
                  className={
                    configuredStrategy?.status === "RUNNING"
                      ? "positive"
                      : "warning-text"
                  }
                >
                  {configuredStrategy?.status === "RUNNING"
                    ? "运行中"
                    : "已暂停"}
                </span>
                {configuredStrategy?.hasUnpublishedDraft && (
                  <span className="warning-text">
                    草稿 V
                    {configuredStrategy.draft?.version ??
                      configuredStrategy.draftVersion}{" "}
                    待发布
                  </span>
                )}
                <span
                  className={
                    preflight
                      ? preflight.ready
                        ? "positive"
                        : "negative"
                      : "muted"
                  }
                >
                  {preflight
                    ? preflight.ready
                      ? "运行条件正常"
                      : "运行条件被阻断"
                    : "服务器持续监听"}
                </span>
                <small title="发布后仅新订单使用新版本，已有仓位继续由开仓时绑定版本管理。">
                  已有仓位版本隔离
                </small>
              </div>
              <div className="strategy-runtime-actions">
                <button
                  onClick={openStrategyConfigDialog}
                  disabled={!can("trade:strategy:edit")}
                >
                  配置
                </button>
                <button
                  onClick={() =>
                    configuredStrategy &&
                    void changeStrategyStatus(
                      configuredStrategy,
                      configuredStrategy.status === "RUNNING"
                        ? "PAUSED"
                        : "RUNNING",
                    )
                  }
                  disabled={
                    !configuredStrategy ||
                    automationBusy ||
                    !can("trade:strategy:edit")
                  }
                >
                  {configuredStrategy?.status === "RUNNING" ? "暂停" : "恢复"}
                </button>
                <button
                  onClick={() =>
                    configuredStrategy &&
                    void openStrategyExecutionLog(configuredStrategy)
                  }
                  disabled={!configuredStrategy}
                >
                  运行日志
                </button>
                <button
                  disabled={
                    preflightBusy ||
                    configuredStrategy?.status !== "RUNNING" ||
                    !can("trade:automation:run")
                  }
                  onClick={() => void runAutomationPreflight()}
                >
                  {preflightBusy ? "检查中…" : "检查状态"}
                </button>
              </div>
              {preflight && !preflight.ready && (
                <div className="strategy-runtime-blockers">
                  {preflight.checks
                    .filter((check) => !check.passed)
                    .map((check) => (
                      <span key={check.key}>
                        <b>{check.label}：</b>
                        {check.detail}
                      </span>
                    ))}
                </div>
              )}
            </section>
            {showStrategyConfig && (
              <div
                className="modal-backdrop"
                role="dialog"
                aria-modal="true"
                aria-labelledby="strategy-config-title"
              >
                <section className="modal strategy-config-modal strategy-flow-modal strategy-parameter-modal">
                  <div className="config-title">
                    <div>
                      <h2 id="strategy-config-title">
                        {creatingStrategy
                          ? strategyTypeDraft === "SIMPLE_REBOUND"
                            ? "新建3分钟独立反弹策略"
                            : "新建策略"
                          : "修改策略"}
                      </h2>
                      <p>
                        {strategyTypeDraft === "SIMPLE_REBOUND"
                          ? "独立规则、独立运行入口；保存草稿不影响实盘"
                          : "做多、做空、双向共用同一模板；保存草稿不影响实盘，发布后新订单生效"}
                      </p>
                    </div>
                    <button aria-label="关闭策略参数弹窗" onClick={closeStrategyConfigDialog}>
                      ×
                    </button>
                  </div>
                  {creatingStrategy && strategyTypeDraft === "SIMPLE_REBOUND" && (
                    <div className="config-safety strategy-scope-summary">
                      <b>独立策略：Simple Rebound · 独立反弹</b>
                      <span>
                        仅使用共享行情缓存、账户/合约校验与统一执行基础设施；不读取旧策略的概率、学习样本、趋势、候选队列或冷却参数。
                      </span>
                      <span>
                        固定规则：成交量前 30 → 2 秒连续下跌 10 次 → 1 分钟连续下跌 2–3 根 → 首次回升做多 → 最多 5 席位 → 3 分钟退出，继续恶化立即止损。
                      </span>
                      <span>
                        固定参数：20 USDT / 5× 杠杆 / 180 秒持有窗口。保存时由服务端写入 SIMPLE_REBOUND 固定配置。
                      </span>
                    </div>
                  )}
                  <nav className="strategy-config-step-tabs" aria-label="策略参数分组">
                    {[
                      { step: 1, label: "基础与合约" },
                      {
                        step: 2,
                        label: strategyTriggerCatalogEntry(
                          strategyTriggerKind(strategyConfig),
                        ).stepLabel,
                      },
                      { step: 3, label: "大户确认" },
                      { step: 4, label: "资金与执行" },
                      { step: 5, label: "持仓智能" },
                      { step: 6, label: "退出与方向" },
                    ].map(({ step, label }) => (
                      <button
                        key={step}
                        type="button"
                        className={strategyConfigStep === step ? "active" : ""}
                        aria-current={strategyConfigStep === step ? "step" : undefined}
                        onClick={() => setStrategyConfigStep(step)}
                      >
                        <b>{step}</b>
                        <span>{label}</span>
                      </button>
                    ))}
                  </nav>
                  {strategyConfigStep === 1 && (
                    <>
                  {strategyTriggerKind(strategyConfig) ===
                  "THREE_MINUTE_PROBABILITY" ? (
                    <div className="config-safety strategy-scope-summary">
                      <b>系统固定：全部币安当前在架合约轮转扫描</b>
                      <span>
                        每轮只做64个合约的WebSocket粗筛，完整K线分析仅落在少量候选；无需人工选择合约，也不会因扩大扫描直接放大K线权重。
                      </span>
                    </div>
                  ) : (
                    <>
                  <div className="strategy-config-section-title strategy-integrated-section-title">
                    <b>扫描合约</b>
                    <span>范围由当前策略独立控制，并在读取 K 线前完成筛选</span>
                  </div>
                  <div
                    className="strategy-asset-scope-options"
                    aria-label="策略资产范围"
                  >
                    {([
                      "CRYPTO_NATIVE",
                      "TRADFI",
                      "ALL",
                      "CUSTOM",
                    ] as StrategyAssetClassScope[]).map((scope) => (
                      <button
                        key={scope}
                        type="button"
                        disabled={
                          Boolean(strategyPluginId(strategyConfig)) &&
                          scope !== "CUSTOM"
                        }
                        className={
                          strategyConfig.assetClassScope === scope
                            ? "active"
                            : ""
                        }
                        onClick={() => {
                          setStrategyScopeQuery("");
                          setStrategyConfig((current) => ({
                            ...current,
                            assetClassScope: scope,
                            selectedSymbols:
                              scope === "CUSTOM"
                                ? current.selectedSymbols
                                : [],
                            maxSymbols:
                              scope === "CUSTOM"
                                ? current.selectedSymbols.length
                                : 0,
                          }));
                        }}
                      >
                        {strategyAssetClassScopeLabel(scope)}
                      </button>
                    ))}
                  </div>
                  <div className="strategy-scope-toolbar">
                    <label className="strategy-symbol-search">
                      <span>选择合约</span>
                      <input
                        value={strategyScopeQuery}
                        placeholder="输入 BTC、ETH 或合约名称搜索"
                        onChange={(event) =>
                          setStrategyScopeQuery(event.target.value)
                        }
                        onFocus={() => setStrategyScopeFocused(true)}
                        onBlur={() => {
                          setStrategyScopeFocused(false);
                          setStrategyScopeQuery("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setStrategyScopeFocused(false);
                            setStrategyScopeQuery("");
                            event.currentTarget.blur();
                            return;
                          }
                          if (
                            event.key === "Enter" &&
                            strategySymbolSuggestions[0]
                          ) {
                            event.preventDefault();
                            addStrategyScopeContract(
                              strategySymbolSuggestions[0].symbol,
                            );
                          }
                        }}
                        role="combobox"
                        aria-expanded={strategyScopeFocused}
                        aria-controls="strategy-symbol-suggestions"
                        aria-autocomplete="list"
                      />
                      <span
                        className="strategy-dropdown-chevron"
                        aria-hidden="true"
                      >
                        ⌄
                      </span>
                      {strategyScopeFocused && (
                        <div
                          id="strategy-symbol-suggestions"
                          className="strategy-symbol-dropdown"
                          role="listbox"
                        >
                          {strategySymbolSuggestions.length === 0 ? (
                            <div className="strategy-symbol-empty">
                              未找到匹配合约，请确认代码或刷新合约池
                            </div>
                          ) : (
                            strategySymbolSuggestions.map((item) => {
                              return (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected="false"
                                  key={item.symbol}
                                  onMouseDown={(event) =>
                                    event.preventDefault()
                                  }
                                  onClick={() =>
                                    addStrategyScopeContract(item.symbol)
                                  }
                                >
                                  <span className="strategy-symbol-copy">
                                    <b>{item.symbol}</b>
                                    <small>{item.name}</small>
                                  </span>
                                  <em>
                                    {item.price
                                      ? `${item.price.toLocaleString("en-US", {
                                          maximumFractionDigits: 8,
                                        })} · 添加`
                                      : "添加"}
                                  </em>
                                </button>
                              );
                            })
                          )}
                        </div>
                      )}
                    </label>
                    <div>
                      <span>
                        {strategyConfig.selectedSymbols.length
                          ? "已选择"
                          : "扫描范围"}
                      </span>
                      <b>
                        {strategyConfig.selectedSymbols.length ||
                          strategyAssetClassScopeLabel(
                            strategyConfig.assetClassScope,
                          )}
                      </b>
                      {strategyConfig.selectedSymbols.length > 0 && (
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setStrategyScopeQuery("");
                            setStrategyConfig((current) => ({
                              ...current,
                              assetClassScope: strategyPluginId(current)
                                ? "CUSTOM"
                                : "CRYPTO_NATIVE",
                              selectedSymbols: [],
                              maxSymbols: 0,
                            }));
                          }}
                        >
                          清空
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="strategy-symbol-search-hint">
                    输入后点击结果或按 Enter 添加会切换为自定义范围；候选来自系统合约池，不会额外请求 Binance。
                  </p>
                  {pool.filter((item) => item.enabled).length === 0 && (
                    <div className="empty">
                      暂无激活合约，请先到合约池启用至少一个合约。
                    </div>
                  )}
                  <div className="config-safety strategy-scope-summary">
                    <b>
                      {strategyConfig.selectedSymbols.length
                        ? `已选择 ${strategyConfig.selectedSymbols.length} 个`
                        : strategyAssetClassScopeLabel(
                            strategyConfig.assetClassScope,
                          )}
                    </b>
                    <div className="strategy-selected-symbols">
                      {strategyConfig.selectedSymbols.length ? (
                        strategyConfig.selectedSymbols.map((selectedSymbol) => (
                          <span key={selectedSymbol}>
                            <b>{selectedSymbol}</b>
                            <button
                              type="button"
                              aria-label={`移除 ${selectedSymbol}`}
                              onClick={() =>
                                removeStrategyScopeContract(selectedSymbol)
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))
                      ) : (
                        <em>
                          {strategyConfig.assetClassScope === "CUSTOM"
                            ? "请至少选择一个自定义合约"
                            : `监听${strategyAssetClassScopeLabel(
                                strategyConfig.assetClassScope,
                              )}中的已启用合约`}
                        </em>
                      )}
                    </div>
                  </div>
                    </>
                  )}
                    </>
                  )}
                  <div className="config-grid strategy-parameter-grid">
                    <div
                      className="strategy-config-step-panel"
                      hidden={strategyConfigStep !== 1}
                    >
                    <div className="strategy-config-section-title">
                      <b>1. 基础设置</b>
                      <span>先选择执行方向，再按对应趋势参数判断并自动管理实盘仓位</span>
                    </div>
                    <label>
                      <span>交易子账户</span>
                      <select
                        value={strategyConfig.accountId}
                        onChange={(event) => {
                          setStrategyConfig({
                            ...strategyConfig,
                            accountId: event.target.value,
                          });
                        }}
                      >
                        {tradingAccounts
                          .filter(
                            (account) =>
                              account.isActive && account.accountType === "STRATEGY",
                          )
                          .map((account) => (
                            <option key={account.accountId} value={account.accountId}>
                              {account.name} · {account.accountId}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="strategy-name-field">
                      <span>策略名称</span>
                      <input
                        value={strategyConfig.name}
                        onChange={(event) =>
                          setStrategyConfig({
                            ...strategyConfig,
                            name: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="strategy-trigger-field">
                      <span>策略插件</span>
                      <select
                        value={strategyPluginId(strategyConfig) ?? ""}
                        disabled={!creatingStrategy}
                        onChange={(event) =>
                          setStrategyConfig((current) =>
                            withStrategyPlugin(
                              current,
                              event.target.value
                                ? event.target.value as StrategyPluginId
                                : null,
                            )
                          )
                        }
                      >
                        <option value="">标准策略（自行选择触发器）</option>
                        {STRATEGY_PLUGIN_CATALOG.map((plugin) => (
                          <option key={plugin.id} value={plugin.id}>
                            {plugin.label}
                          </option>
                        ))}
                      </select>
                      <small>
                        {STRATEGY_PLUGIN_CATALOG.find(
                          (plugin) =>
                            plugin.id === strategyPluginId(strategyConfig),
                        )?.description ??
                          "插件只组合现有触发、大脑、执行和持仓能力；标准策略继续按原方式配置。"}
                      </small>
                    </label>
                    <label className="strategy-trigger-field">
                      <span>策略触发器</span>
                      <select
                        value={strategyTriggerKind(strategyConfig)}
                        disabled={
                          !creatingStrategy ||
                          Boolean(strategyPluginId(strategyConfig))
                        }
                        onChange={(event) =>
                          setStrategyConfig((current) =>
                            withStrategyTriggerKind(
                              current,
                              event.target.value as StrategyTriggerKind,
                            ),
                          )
                        }
                      >
                        {STRATEGY_TRIGGER_CATALOG.map((entry) => (
                          <option
                            key={entry.kind}
                            value={entry.kind}
                            disabled={!isNewStrategyTriggerKind(entry.kind)}
                          >
                            {entry.label}
                            {entry.availability === "EXISTING_ONLY"
                              ? "（现有策略兼容）"
                              : entry.availability === "PLANNED"
                                ? "（待开放）"
                                : ""}
                          </option>
                        ))}
                      </select>
                      <small>
                        {
                          strategyTriggerCatalogEntry(
                            strategyTriggerKind(strategyConfig),
                          ).description
                        }
                      </small>
                    </label>
                    <label>
                      <span>杠杆</span>
                      <NumberStepper
                        label="策略杠杆"
                        value={liquidationExecutionUi(strategyConfig)?.leverage ?? 10}
                        min={1}
                        max={AUTOMATED_STRATEGY_MAX_LEVERAGE}
                        step={1}
                        unit="×"
                        onChange={(value) =>
                          setStrategyConfig((current) =>
                            withLiquidationExecution(current, { leverage: value }),
                          )
                        }
                      />
                      <small>
                        新订单按该版本参数执行；已有仓位保留原绑定倍数
                      </small>
                    </label>
                    <p className="strategy-config-inline-note strategy-trigger-note">
                      触发器只负责唤醒分析，不直接决定方向或下单；同一触发器可创建多条策略，各自保存独立窗口、参数和版本。
                    </p>
                    </div>
                    {liquidationConfigShape(strategyConfig) && (
                      <>
                        <div
                          className="strategy-config-step-panel"
                          hidden={strategyConfigStep !== 2}
                        >
                        {strategyTriggerKind(strategyConfig) ===
                        "THREE_MINUTE_PROBABILITY" ? (
                          <>
                            <div className="strategy-config-section-title">
                              <b>2. 滚动概率直接执行</b>
                              <span>
                                连续扫描全市场并用最新统一行情直接计算做多、做空概率；较高一侧达到策略门槛即进入统一下单
                              </span>
                            </div>
                            <label>
                              <span>观察时间尺度</span>
                              <input value="180 秒（3 分钟）" disabled readOnly />
                              <small>用于概率特征与学习分组；不会等待自然边界才下单</small>
                            </label>
                            <label>
                              <span>滚动重评估</span>
                              <NumberStepper
                                label="3分钟策略滚动重评估"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.evaluationCadenceSeconds ?? 9}
                                min={3}
                                max={60}
                                step={1}
                                unit="秒"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      evaluationCadenceSeconds: Math.round(value),
                                    }),
                                  )
                                }
                              />
                              <small>每次只用最新事实重评估；同一事实不会重复下单</small>
                            </label>
                            <label>
                              <span>执行方式</span>
                              <input value="概率达标直接执行" disabled readOnly />
                              <small>不再等待15至30秒热观察，不使用历史期望或费用优势拦截；新鲜行情、订单幂等和交易所规则仍强制执行</small>
                            </label>
                            <label>
                              <span>成交后固定退出</span>
                              <NumberStepper
                                label="成交后固定退出"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.timeExitSeconds ?? 300}
                                min={60}
                                max={900}
                                step={30}
                                unit="秒"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      timeExitSeconds: Math.round(value),
                                    }),
                                  )
                                }
                              />
                              <small>真实成交后按此时长统一市价退出，不影响下一笔滚动判断</small>
                            </label>
                            <label>
                              <span>最低方向概率</span>
                              <NumberStepper
                                label="3分钟最低方向概率"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.minimumProbabilityPercent ?? 52}
                                min={50}
                                max={99}
                                step={0.5}
                                unit="%"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      minimumProbabilityPercent: value,
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>费用后净优势参考</span>
                              <NumberStepper
                                label="3分钟费用后净优势参考"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.minimumNetEdgeBps ?? 1}
                                min={0}
                                max={1000}
                                step={0.5}
                                unit="bp"
                                readOnly
                                onChange={() => {}}
                              />
                              <small>仅用于收益诊断和运营展示，不影响3分钟策略下单</small>
                            </label>
                            <label>
                              <span>每次入队候选（系统固定）</span>
                              <NumberStepper
                                label="每次入队候选数"
                                value={3}
                                min={3}
                                max={3}
                                step={1}
                                unit="个"
                                readOnly
                                onChange={() => {}}
                              />
                            </label>
                            <label>
                              <span>预估双边手续费</span>
                              <NumberStepper
                                label="预估双边手续费"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.estimatedRoundTripFeeBps ?? 8}
                                min={0}
                                max={100}
                                step={0.5}
                                unit="bp"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      estimatedRoundTripFeeBps: value,
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>预估滑点</span>
                              <NumberStepper
                                label="预估双边滑点"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.estimatedSlippageBps ?? 5}
                                min={0}
                                max={100}
                                step={0.5}
                                unit="bp"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      estimatedSlippageBps: value,
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>初始校准轮次</span>
                              <NumberStepper
                                label="初始校准轮次"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.calibrationRounds ?? 10}
                                min={0}
                                max={100}
                                step={1}
                                unit="轮"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      calibrationRounds: Math.round(value),
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>校准期执行方式</span>
                              <select
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.calibrationMode ?? "MINIMUM_ORDER"}
                                onChange={(event) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      calibrationMode: event.target.value as "MINIMUM_ORDER" | "OBSERVE_ONLY",
                                    }),
                                  )
                                }
                              >
                                <option value="MINIMUM_ORDER">满足概率门槛后按交易所最小有效量验证</option>
                                <option value="OBSERVE_ONLY">暂停实盘校准（不会增加真实周期样本）</option>
                              </select>
                            </label>
                            <label>
                              <span>负期望批次处理</span>
                              <select
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.negativeExpectancyMode ?? "OBSERVE_ONLY"}
                                onChange={(event) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      negativeExpectancyMode: event.target.value as "MINIMUM_ORDER" | "OBSERVE_ONLY",
                                    }),
                                  )
                                }
                              >
                                <option value="OBSERVE_ONLY">自动停实盘，等待人工复核新版本</option>
                                <option value="MINIMUM_ORDER">继续最小量校准</option>
                              </select>
                            </label>
                            <label>
                              <span>学习批次</span>
                              <NumberStepper
                                label="学习批次样本数"
                                value={threeMinuteProbabilityTriggerUi(strategyConfig)?.batchSize ?? 10}
                                min={5}
                                max={100}
                                step={1}
                                unit="轮"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withThreeMinuteProbabilityTrigger(current, {
                                      batchSize: Math.round(value),
                                    }),
                                  )
                                }
                              />
                            </label>
                            <p className="strategy-config-inline-note">
                              系统会同时计算做多、做空和不交易三种费用后期望；胜率未超过盈亏平衡点，或净优势不足时，本轮不下单。
                            </p>
                          </>
                        ) : strategyTriggerKind(strategyConfig) ===
                        "LOW_POSITION_WINDOW" ? (
                          <>
                            <div className="strategy-config-section-title">
                              <b>2. 低位价格触发与趋势确认</b>
                              <span>
                                72小时位置只负责唤醒；最终仍需完成闭合趋势、成交量和入场距离确认
                              </span>
                            </div>
                            <label>
                              <span>72小时价格位置上限</span>
                              <NumberStepper
                                label="低位触发72小时价格位置上限"
                                value={
                                  lowPositionTriggerUi(strategyConfig)
                                    ?.maxPosition72hPercent ?? 35
                                }
                                min={1}
                                max={60}
                                step={0.5}
                                unit="%"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLowPositionTrigger(current, {
                                      maxPosition72hPercent: value,
                                    }),
                                  )
                                }
                              />
                              <small>必须严格低于该位置才唤醒做多分析</small>
                            </label>
                            <label>
                              <span>标记价格最大延迟</span>
                              <NumberStepper
                                label="低位触发标记价格最大延迟"
                                value={
                                  lowPositionTriggerUi(strategyConfig)
                                    ?.maxFactAgeMs ?? 5000
                                }
                                min={1000}
                                max={30000}
                                step={500}
                                unit="ms"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLowPositionTrigger(current, {
                                      maxFactAgeMs: Math.round(value),
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>扫描间隔</span>
                              <NumberStepper
                                label="低位价格扫描间隔"
                                value={
                                  lowPositionTriggerUi(strategyConfig)
                                    ?.scanIntervalSeconds ?? 60
                                }
                                min={5}
                                max={3600}
                                step={5}
                                unit="秒"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLowPositionTrigger(current, {
                                      scanIntervalSeconds: Math.round(value),
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>每轮候选上限</span>
                              <NumberStepper
                                label="低位价格每轮候选上限"
                                value={
                                  lowPositionTriggerUi(strategyConfig)
                                    ?.maxWakeCandidatesPerCycle ?? 2
                                }
                                min={1}
                                max={10}
                                step={1}
                                unit="个"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLowPositionTrigger(current, {
                                      maxWakeCandidatesPerCycle:
                                        Math.round(value),
                                    }),
                                  )
                                }
                              />
                            </label>
                            <p className="strategy-config-inline-note">
                              本触发器不读取爆仓金额、爆仓次数或爆仓价格；候选合约由上方搜索范围决定，0 表示系统合约池。
                            </p>
                          </>
                        ) : strategyTriggerKind(strategyConfig) ===
                        "GRID_PRICE_LEVEL" ? (
                          <>
                            <div className="strategy-config-section-title">
                              <b>2. 网格价位触发</b>
                              <span>价格接近指定网格线时只唤醒分析，方向和下单仍由共享大脑复核</span>
                            </div>
                            <label>
                              <span>网格下沿价格</span>
                              <NumberStepper
                                label="网格下沿价格"
                                value={gridPriceLevelTriggerUi(strategyConfig)?.lowerPrice ?? 1}
                                min={0.00000001}
                                max={1_000_000_000}
                                step={0.00000001}
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withGridPriceLevelTrigger(current, { lowerPrice: value })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>网格上沿价格</span>
                              <NumberStepper
                                label="网格上沿价格"
                                value={gridPriceLevelTriggerUi(strategyConfig)?.upperPrice ?? 2}
                                min={0.00000001}
                                max={1_000_000_000}
                                step={0.00000001}
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withGridPriceLevelTrigger(current, { upperPrice: value })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>网格数量</span>
                              <NumberStepper
                                label="网格数量"
                                value={gridPriceLevelTriggerUi(strategyConfig)?.gridCount ?? 10}
                                min={2}
                                max={100}
                                step={1}
                                unit="格"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withGridPriceLevelTrigger(current, { gridCount: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>触发容差</span>
                              <NumberStepper
                                label="网格触发容差"
                                value={gridPriceLevelTriggerUi(strategyConfig)?.activationToleranceBps ?? 10}
                                min={1}
                                max={500}
                                step={1}
                                unit="bp"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withGridPriceLevelTrigger(current, { activationToleranceBps: value })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>标记价格最大延迟</span>
                              <NumberStepper
                                label="网格标记价格最大延迟"
                                value={gridPriceLevelTriggerUi(strategyConfig)?.maxFactAgeMs ?? 5000}
                                min={1000}
                                max={30000}
                                step={500}
                                unit="ms"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withGridPriceLevelTrigger(current, { maxFactAgeMs: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>扫描间隔</span>
                              <NumberStepper
                                label="网格扫描间隔"
                                value={gridPriceLevelTriggerUi(strategyConfig)?.scanIntervalSeconds ?? 5}
                                min={1}
                                max={3600}
                                step={1}
                                unit="秒"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withGridPriceLevelTrigger(current, { scanIntervalSeconds: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <p className="strategy-config-inline-note">
                              网格策略必须且只能选择 1 个合约；双向模式下，下半区给出做多候选、上半区给出做空候选，最终仍需通过统一趋势和量能确认。
                            </p>
                          </>
                        ) : strategyTriggerKind(strategyConfig) ===
                        "SCHEDULED_SCAN" ? (
                          <>
                            <div className="strategy-config-section-title">
                              <b>2. 定时扫描触发</b>
                              <span>到达周期边界后轮转扫描合约范围，复用统一闭合行情缓存</span>
                            </div>
                            <label>
                              <span>扫描周期</span>
                              <NumberStepper
                                label="定时扫描周期"
                                value={scheduledScanTriggerUi(strategyConfig)?.intervalSeconds ?? 300}
                                min={60}
                                max={86400}
                                step={60}
                                unit="秒"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withScheduledScanTrigger(current, { intervalSeconds: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>闭合行情最大延迟</span>
                              <NumberStepper
                                label="定时扫描闭合行情最大延迟"
                                value={scheduledScanTriggerUi(strategyConfig)?.maxFactAgeMs ?? 600000}
                                min={60000}
                                max={900000}
                                step={60000}
                                unit="ms"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withScheduledScanTrigger(current, { maxFactAgeMs: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>每轮合约上限</span>
                              <NumberStepper
                                label="定时扫描每轮合约上限"
                                value={scheduledScanTriggerUi(strategyConfig)?.maxWakeCandidatesPerCycle ?? 2}
                                min={1}
                                max={10}
                                step={1}
                                unit="个"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withScheduledScanTrigger(current, { maxWakeCandidatesPerCycle: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <p className="strategy-config-inline-note">
                              可指定一个或多个合约；0 表示轮转系统合约池。双向配置会把做多、做空分别交给大脑判断；定时到点本身不会决定方向或直接下单。
                            </p>
                          </>
                        ) : strategyTriggerKind(strategyConfig) ===
                        "BREAKOUT_RETEST" ? (
                          <>
                            <div className="strategy-config-section-title">
                              <b>2. 突破回踩触发</b>
                              <span>使用已闭合 5 分钟 K 线识别放量突破，并等待限定窗口内回踩</span>
                            </div>
                            <label>
                              <span>结构回看</span>
                              <NumberStepper
                                label="突破结构回看K线"
                                value={breakoutRetestTriggerUi(strategyConfig)?.lookbackCandles ?? 20}
                                min={10}
                                max={80}
                                step={1}
                                unit="根"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { lookbackCandles: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>最大回踩窗口</span>
                              <NumberStepper
                                label="突破后最大回踩K线"
                                value={breakoutRetestTriggerUi(strategyConfig)?.maximumRetestCandles ?? 3}
                                min={1}
                                max={6}
                                step={1}
                                unit="根"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { maximumRetestCandles: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>最小突破距离</span>
                              <NumberStepper
                                label="最小突破距离"
                                value={breakoutRetestTriggerUi(strategyConfig)?.minimumBreakoutBps ?? 10}
                                min={1}
                                max={1000}
                                step={1}
                                unit="bp"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { minimumBreakoutBps: value })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>回踩容差</span>
                              <NumberStepper
                                label="突破回踩容差"
                                value={breakoutRetestTriggerUi(strategyConfig)?.retestToleranceBps ?? 20}
                                min={1}
                                max={1000}
                                step={1}
                                unit="bp"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { retestToleranceBps: value })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>突破成交量倍数</span>
                              <NumberStepper
                                label="突破成交量倍数"
                                value={breakoutRetestTriggerUi(strategyConfig)?.minimumBreakoutVolumeRatio ?? 1.2}
                                min={0.5}
                                max={10}
                                step={0.1}
                                unit="×"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { minimumBreakoutVolumeRatio: value })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>闭合行情最大延迟</span>
                              <NumberStepper
                                label="突破回踩闭合行情最大延迟"
                                value={breakoutRetestTriggerUi(strategyConfig)?.maxFactAgeMs ?? 600000}
                                min={60000}
                                max={900000}
                                step={60000}
                                unit="ms"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { maxFactAgeMs: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>扫描间隔</span>
                              <NumberStepper
                                label="突破回踩扫描间隔"
                                value={breakoutRetestTriggerUi(strategyConfig)?.scanIntervalSeconds ?? 60}
                                min={5}
                                max={3600}
                                step={5}
                                unit="秒"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { scanIntervalSeconds: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>每轮候选上限</span>
                              <NumberStepper
                                label="突破回踩每轮候选上限"
                                value={breakoutRetestTriggerUi(strategyConfig)?.maxWakeCandidatesPerCycle ?? 2}
                                min={1}
                                max={10}
                                step={1}
                                unit="个"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withBreakoutRetestTrigger(current, { maxWakeCandidatesPerCycle: Math.round(value) })
                                  )
                                }
                              />
                            </label>
                            <p className="strategy-config-inline-note">
                              突破和回踩都必须来自已闭合 K 线；触发器只提供方向候选，最终方向、入场距离和成交量仍由统一大脑裁决。
                            </p>
                          </>
                        ) : [
                          "PRICE_VOLUME_STRUCTURE",
                          "RELATIVE_STRENGTH_CONTINUATION",
                          "HIGH_POSITION_PRICE_VOLUME_STRUCTURE",
                        ].includes(strategyTriggerKind(strategyConfig)) ? (
                          <>
                            <div className="strategy-config-section-title">
                              <b>
                                2. {
                                  strategyTriggerCatalogEntry(
                                    strategyTriggerKind(strategyConfig),
                                  ).stepLabel
                                }
                              </b>
                              <span>
                                {
                                  strategyTriggerCatalogEntry(
                                    strategyTriggerKind(strategyConfig),
                                  ).description
                                }
                              </span>
                            </div>
                            <p className="strategy-config-inline-note">
                              本触发器直接复用统一行情眼睛和成熟专用运行参数，不读取爆仓窗口字段；合约范围、趋势、执行和仓位保护仍按后续步骤独立配置。
                            </p>
                          </>
                        ) : (
                          <>
                        <div className="strategy-config-section-title">
                          <b>2. 单币爆仓触发与扫盘回收</b>
                          <span>每个合约独立累计；其他币种爆仓不计入本合约触发金额</span>
                        </div>
                        <section className="liquidation-factor-learning-card">
                          <div className="liquidation-factor-learning-head">
                            <div>
                              <b>爆仓后数据决策闭环</b>
                              <span>
                                {configuredStrategy?.liquidationFactorLearning
                                  ? `${liquidationFactorLearningPhaseLabel(configuredStrategy.liquidationFactorLearning.phase)} · V${configuredStrategy.liquidationFactorLearning.configVersion}`
                                  : "新策略从 SHADOW 开始积累"}
                              </span>
                            </div>
                            {configuredStrategy?.liquidationFactorLearning
                              ?.attentionRequired && (
                              <span className="liquidation-factor-attention">
                                待处理
                              </span>
                            )}
                          </div>
                          {configuredStrategy?.liquidationFactorLearning && (
                            <div className="liquidation-factor-learning-progress">
                              <span>
                                成熟事件段 {configuredStrategy.liquidationFactorLearning.matureEpisodes}/
                                {configuredStrategy.liquidationFactorLearning.targetEpisodes}
                              </span>
                              <span>
                                精确闭环 {configuredStrategy.liquidationFactorLearning.exactSupportedCycles}/
                                {configuredStrategy.liquidationFactorLearning.minimumExactCycles}
                              </span>
                              <span>
                                支持/拦截 {configuredStrategy.liquidationFactorLearning.supportedEpisodes}/
                                {configuredStrategy.liquidationFactorLearning.blockedEpisodes}
                              </span>
                              <span>
                                样本外净收益 {configuredStrategy.liquidationFactorLearning.holdout.netPnlUsdt >= 0 ? "+" : ""}
                                {configuredStrategy.liquidationFactorLearning.holdout.netPnlUsdt.toFixed(4)} USDT
                              </span>
                            </div>
                          )}
                          {configuredStrategy?.liquidationFactorLearning?.missing
                            .length ? (
                            <small>
                              尚缺：{configuredStrategy.liquidationFactorLearning.missing.join("；")}
                            </small>
                          ) : (
                            <small>
                              已达到学习和样本外验证规则；系统将生成待人工确认的 LIVE 候选建议。
                            </small>
                          )}
                          <div className="liquidation-factor-learning-controls">
                            <label>
                              <span>当前参与方式</span>
                              <select
                                value={liquidationFactorUi(strategyConfig)?.mode ?? "SHADOW"}
                                onChange={(event) => {
                                  const mode = event.target.value as "SHADOW" | "LIVE";
                                  const confirmed = window.confirm(
                                    mode === "LIVE"
                                      ? "切换到LIVE后，爆仓后衍生因子将参与新订单授权；发布后生效，已有仓位不变。是否继续？"
                                      : "退回SHADOW后，因子继续学习但不再限制新订单；发布后开启新的配置学习批次。是否继续？",
                                  );
                                  if (!confirmed) return;
                                  setStrategyConfig((current) =>
                                    withLiquidationFactor(current, { mode }),
                                  );
                                }}
                              >
                                <option value="SHADOW">SHADOW 学习观察</option>
                                <option value="LIVE">LIVE 参与下单判断</option>
                              </select>
                            </label>
                            <label className="check-line">
                              <input
                                type="checkbox"
                                checked={
                                  liquidationFactorUi(strategyConfig)
                                    ?.automaticModeSwitch !== false
                                }
                                onChange={(event) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationFactor(current, {
                                      automaticModeSwitch: event.target.checked,
                                    }),
                                  )
                                }
                              />
                              <span>学习达标后生成 LIVE 候选建议；人工发布验证，恶化自动回退</span>
                            </label>
                            <label>
                              <span>成熟事件段目标</span>
                              <NumberStepper
                                label="爆仓因子成熟事件段目标"
                                value={
                                  liquidationFactorUi(strategyConfig)
                                    ?.learningTargetEpisodes ?? 30
                                }
                                min={10}
                                max={1000}
                                step={5}
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationFactor(current, {
                                      learningTargetEpisodes: Math.round(value),
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>精确闭环目标</span>
                              <NumberStepper
                                label="爆仓因子精确闭环目标"
                                value={
                                  liquidationFactorUi(strategyConfig)
                                    ?.learningMinimumExactCycles ?? 8
                                }
                                min={6}
                                max={100}
                                step={1}
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationFactor(current, {
                                      learningMinimumExactCycles: Math.round(value),
                                    }),
                                  )
                                }
                              />
                            </label>
                          </div>
                        </section>
                        <label>
                          <span>单笔爆仓金额</span>
                          <NumberStepper
                            label="单币单笔爆仓触发金额"
                            value={
                              liquidationTriggerUi(strategyConfig)?.minSingleLiquidationNotionalUsdt ??
                              liquidationTriggerUi(strategyConfig)?.minLiquidationNotionalUsdt ??
                              6000
                            }
                            min={0.01}
                            step={100}
                            unit="USDT"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  minSingleLiquidationNotionalUsdt: value,
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>单币窗口累计金额</span>
                          <NumberStepper
                            label="单币窗口累计爆仓金额"
                            value={liquidationTriggerUi(strategyConfig)?.minLiquidationNotionalUsdt ?? 6000}
                            min={0.01}
                            step={100}
                            unit="USDT"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  minLiquidationNotionalUsdt: value,
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>单币连续次数</span>
                          <NumberStepper
                            label="单币窗口最少爆仓事件数"
                            value={Math.max(1, liquidationTriggerUi(strategyConfig)?.minClusterEvents ?? 3)}
                            min={1}
                            max={20}
                            step={1}
                            unit="次"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  minClusterEvents: value,
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>单币累计窗口</span>
                          <NumberStepper
                            label="单币连续爆仓累计窗口"
                            value={liquidationTriggerUi(strategyConfig)?.maxClusterSpanSeconds ?? 120}
                            min={1}
                            max={300}
                            step={1}
                            unit="秒"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  maxClusterSpanSeconds: value,
                                  maxClusterEventGapSeconds: Math.min(
                                    liquidationTriggerUi(current)?.maxClusterEventGapSeconds ??
                                      value,
                                    value,
                                  ),
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>相邻事件最大间隔</span>
                          <NumberStepper
                            label="单币连续爆仓相邻事件最大间隔"
                            value={
                              liquidationTriggerUi(strategyConfig)?.maxClusterEventGapSeconds ??
                              liquidationTriggerUi(strategyConfig)?.maxClusterSpanSeconds ??
                              30
                            }
                            min={1}
                            max={Math.min(
                              300,
                              liquidationTriggerUi(strategyConfig)?.maxClusterSpanSeconds ?? 3,
                            )}
                            step={1}
                            unit="秒"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  maxClusterEventGapSeconds: value,
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>最低爆仓价</span>
                          <NumberStepper
                            label="最低爆仓价格"
                            value={liquidationTriggerUi(strategyConfig)?.minLiquidationPrice ?? 0}
                            min={0}
                            step={0.000001}
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  minLiquidationPrice: value,
                                }),
                              )
                            }
                          />
                          <small>0 表示不限制最低价格</small>
                        </label>
                        <label>
                          <span>最高爆仓价</span>
                          <NumberStepper
                            label="最高爆仓价格"
                            value={liquidationTriggerUi(strategyConfig)?.maxLiquidationPrice ?? 0}
                            min={0}
                            step={0.000001}
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  maxLiquidationPrice: value,
                                }),
                              )
                            }
                          />
                          <small>0 表示不限制最高价格</small>
                        </label>
                        <label>
                          <span>信号最大延迟</span>
                          <NumberStepper
                            label="单币爆仓信号最大延迟"
                            value={liquidationTriggerUi(strategyConfig)?.maxSignalDelayMs ?? 1500}
                            min={100}
                            max={10000}
                            step={100}
                            unit="ms"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  maxSignalDelayMs: value,
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>分析有效期</span>
                          <NumberStepper
                            label="信号分析有效期"
                            value={liquidationTriggerUi(strategyConfig)?.analysisValiditySeconds ?? 900}
                            min={300}
                            max={1800}
                            step={60}
                            unit="秒"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, { analysisValiditySeconds: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>同合约冷却</span>
                          <NumberStepper
                            label="同合约冷却时间"
                            value={liquidationTriggerUi(strategyConfig)?.cooldownMinutes ?? 10}
                            min={0}
                            max={1440}
                            step={1}
                            unit="分钟"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, { cooldownMinutes: value }),
                              )
                            }
                          />
                          <small>完全由当前策略控制；0 表示新鲜独立信号无需等待冷却</small>
                        </label>
                        <label>
                          <span>并行分析上限</span>
                          <NumberStepper
                            label="当前策略并行分析上限"
                            value={liquidationTriggerUi(strategyConfig)?.maxConcurrentAnalyses ?? 0}
                            min={0}
                            max={10000}
                            step={1}
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrigger(current, {
                                  maxConcurrentAnalyses: Math.round(value),
                                }),
                              )
                            }
                          />
                          <small>0 表示不设策略级上限；系统不再使用固定 12 条分析上限</small>
                        </label>
                        <label>
                          <span>72小时价格位置上限</span>
                          <NumberStepper
                            label="72小时价格位置上限"
                            value={liquidationMarketPositionUi(strategyConfig)?.maxPosition72hPercent ?? 35}
                            min={5}
                            max={50}
                            step={0.5}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationMarketPosition(current, { maxPosition72hPercent: value }),
                              )
                            }
                          />
                        </label>
                          </>
                        )}
                        <label>
                          <span>1小时破位处理</span>
                          <select
                            value={liquidationTrendUi(strategyConfig)?.trend1hBreakHandling ?? "REJECT"}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrend(current, {
                                  trend1hBreakHandling: event.target.value as LiquidationTrendUi["trend1hBreakHandling"],
                                }),
                              )
                            }
                          >
                            <option value="REJECT">直接拒绝</option>
                            <option value="WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM">等待局部反转确认</option>
                          </select>
                        </label>
                        <label>
                          <span>30分钟破位处理</span>
                          <select
                            value={liquidationTrendUi(strategyConfig)?.structure30mBreakHandling ?? "REJECT"}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrend(current, {
                                  structure30mBreakHandling: event.target.value as LiquidationTrendUi["structure30mBreakHandling"],
                                }),
                              )
                            }
                          >
                            <option value="REJECT">直接拒绝</option>
                            <option value="WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM">等待局部反转确认</option>
                          </select>
                        </label>
                        <label>
                          <span>扫盘前震荡宽度</span>
                          <NumberStepper
                            label="扫盘前震荡区间上限"
                            value={liquidationTrendUi(strategyConfig)?.maxPriorRangeAtr ?? 4}
                            min={1}
                            max={12}
                            step={0.1}
                            unit="ATR"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrend(current, { maxPriorRangeAtr: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>3分钟成交量确认</span>
                          <NumberStepper
                            label="3分钟成交量倍数"
                            value={liquidationTrendUi(strategyConfig)?.volumeRatio3m ?? 1.2}
                            min={1}
                            max={10}
                            step={0.1}
                            unit="×"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrend(current, { volumeRatio3m: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>最大回踩距离</span>
                          <NumberStepper
                            label="最大入场距离"
                            value={liquidationTrendUi(strategyConfig)?.maxEntryDistanceAtr ?? 1}
                            min={0.1}
                            max={5}
                            step={0.1}
                            unit="ATR"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrend(current, { maxEntryDistanceAtr: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>5分钟 ATR 周期</span>
                          <NumberStepper
                            label="5分钟ATR周期"
                            value={liquidationTrendUi(strategyConfig)?.atrPeriod5m ?? 14}
                            min={2}
                            max={100}
                            step={1}
                            unit="根"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationTrend(current, { atrPeriod5m: value }),
                              )
                            }
                          />
                        </label>
                        </div>
                        <div
                          className="strategy-config-step-panel"
                          hidden={strategyConfigStep !== 3}
                        >
                        <div className="strategy-config-section-title">
                          <b>3. 大户聚合入场确认</b>
                          <span>交易所聚合持仓，不是钱包地址；阈值与快照写入每次下单日志</span>
                        </div>
                        <label>
                          <span>最低 OI 变化</span>
                          <NumberStepper
                            label="最低未平仓量变化"
                            value={liquidationLargeTraderUi(strategyConfig)?.minOpenInterestChangePercent ?? -1}
                            min={-20}
                            max={20}
                            step={0.1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationLargeTrader(current, { minOpenInterestChangePercent: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>大户持仓比变化</span>
                          <NumberStepper
                            label="大户持仓比变化"
                            value={liquidationLargeTraderUi(strategyConfig)?.minTopPositionRatioChangePercent ?? 0}
                            min={-20}
                            max={20}
                            step={0.1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationLargeTrader(current, { minTopPositionRatioChangePercent: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>大户账户比变化</span>
                          <NumberStepper
                            label="大户账户比变化"
                            value={liquidationLargeTraderUi(strategyConfig)?.minTopAccountRatioChangePercent ?? -3}
                            min={-20}
                            max={20}
                            step={0.1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationLargeTrader(current, { minTopAccountRatioChangePercent: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>最低主动买卖比</span>
                          <NumberStepper
                            label="最低主动买卖比"
                            value={liquidationLargeTraderUi(strategyConfig)?.minTakerBuySellRatio ?? 1}
                            min={0.5}
                            max={2}
                            step={0.01}
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationLargeTrader(current, { minTakerBuySellRatio: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>数据最大延迟</span>
                          <NumberStepper
                            label="大户聚合数据最大延迟"
                            value={liquidationLargeTraderUi(strategyConfig)?.maxDataAgeMinutes ?? 12}
                            min={5}
                            max={30}
                            step={1}
                            unit="分钟"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationLargeTrader(current, { maxDataAgeMinutes: value }),
                              )
                            }
                          />
                        </label>
                        </div>
                        <div
                          className="strategy-config-step-panel"
                          hidden={strategyConfigStep !== 4}
                        >
                        <div className="strategy-config-section-title">
                          <b>4. 本策略资金配置</b>
                          <span>单笔参数决定下单量，风险预算负责缩量和记录；只有每日最大亏损属于本地停止底线</span>
                        </div>
                        <label>
                          <span>委托类型</span>
                          <select
                            value={liquidationExecutionUi(strategyConfig)?.orderType ?? "MARKET"}
                            onChange={(event) => {
                              const selectedOrderType = event.target.value as "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, {
                                  orderType: selectedOrderType,
                                  entryDistanceExecutionMode:
                                    selectedOrderType === "ADAPTIVE"
                                      ? "LIVE"
                                      : liquidationExecutionUi(current)?.entryDistanceExecutionMode ?? "SHADOW",
                                }),
                              );
                            }}
                          >
                            <option value="MARKET">市价立即成交</option>
                            <option value="LIMIT_OFFSET">分析承接价限价挂单</option>
                            <option value="ADAPTIVE">按结构自适应</option>
                          </select>
                        </label>
                        <label>
                          <span>远离确认位保护</span>
                          <select
                            disabled={
                              strategyTriggerKind(strategyConfig) ===
                              "LOW_POSITION_WINDOW"
                            }
                            value={
                              liquidationExecutionUi(strategyConfig)
                                ?.entryDistanceExecutionMode ??
                              (liquidationExecutionUi(strategyConfig)?.orderType === "ADAPTIVE"
                                ? "LIVE"
                                : "SHADOW")
                            }
                            onChange={(event) => {
                              const selectedMode = event.target.value as "SHADOW" | "LIVE";
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, {
                                  entryDistanceExecutionMode: selectedMode,
                                  orderType:
                                    selectedMode === "SHADOW" &&
                                    liquidationExecutionUi(current)?.orderType === "ADAPTIVE"
                                      ? "MARKET"
                                      : liquidationExecutionUi(current)?.orderType,
                                }),
                              );
                            }}
                          >
                            <option value="SHADOW">观察对照（不改变真实委托）</option>
                            <option value="LIVE">实盘执行（近处市价、远处限价）</option>
                          </select>
                          <small className="config-field-note">
                            {strategyTriggerKind(strategyConfig) ===
                            "LOW_POSITION_WINDOW"
                              ? "低位触发器直接使用正式距离保护，不建立影子运行阶段。"
                              : "只在大脑批准下单后选择成交方式；不改变眼睛、方向、数量、杠杆或风控。"}
                          </small>
                        </label>
                        {(liquidationExecutionUi(strategyConfig)?.orderType === "ADAPTIVE" ||
                          liquidationExecutionUi(strategyConfig)?.entryDistanceExecutionMode === "LIVE" ||
                          liquidationExecutionUi(strategyConfig)?.entryDistanceExecutionMode === "SHADOW") && (
                          <label>
                            <span>市价跟随最大距离</span>
                            <NumberStepper
                              label="距确认位最大市价跟随距离"
                              value={liquidationExecutionUi(strategyConfig)?.adaptiveMarketMaxDistanceAtr ?? 0.2}
                              min={0.05}
                              max={1}
                              step={0.05}
                              unit="ATR"
                              onChange={(value) =>
                                setStrategyConfig((current) =>
                                  withLiquidationExecution(current, { adaptiveMarketMaxDistanceAtr: value }),
                                )
                              }
                            />
                          </label>
                        )}
                        {liquidationExecutionUi(strategyConfig)?.orderType !== "MARKET" && (
                          <>
                            <label>
                              <span>限价偏移量</span>
                              <NumberStepper
                                label="限价偏移量"
                                value={liquidationExecutionUi(strategyConfig)?.limitOffsetPercent ?? 0.1}
                                min={0}
                                max={5}
                                step={0.01}
                                unit="%"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationExecution(current, { limitOffsetPercent: value }),
                                  )
                                }
                              />
                            </label>
                            {strategyTriggerKind(strategyConfig) === "LIQUIDATION_WINDOW" ? (
                              <label>
                                <span>接针限价有效期</span>
                                <NumberStepper
                                  label="爆仓接针限价有效期"
                                  value={
                                    liquidationExecutionUi(strategyConfig)?.liquidationLimitOrderTtlMs ??
                                    LIQUIDATION_LIMIT_ORDER_TTL_DEFAULT_MS
                                  }
                                  min={LIQUIDATION_LIMIT_ORDER_TTL_MIN_MS}
                                  max={LIQUIDATION_LIMIT_ORDER_TTL_MAX_MS}
                                  step={100}
                                  unit="ms"
                                  onChange={(value) =>
                                    setStrategyConfig((current) =>
                                      withLiquidationExecution(current, {
                                        liquidationLimitOrderTtlMs: Math.round(value),
                                      }),
                                    )
                                  }
                                />
                                <small>仅控制爆仓接针限价；到期立即撤单并核对成交，不影响其他触发器</small>
                              </label>
                            ) : (
                              <label>
                                <span>限价有效期</span>
                                <NumberStepper
                                  label="策略限价委托有效期"
                                  value={liquidationExecutionUi(strategyConfig)?.orderTtlSeconds ?? ENTRY_ORDER_TTL_MIN_SECONDS}
                                  min={ENTRY_ORDER_TTL_MIN_SECONDS}
                                  max={Math.max(
                                    ENTRY_ORDER_TTL_MIN_SECONDS,
                                    Math.min(
                                      ENTRY_ORDER_TTL_MAX_SECONDS,
                                      (liquidationTriggerUi(strategyConfig)?.analysisValiditySeconds ?? 900) - 1,
                                    ),
                                  )}
                                  step={30}
                                  unit="秒"
                                  onChange={(value) =>
                                    setStrategyConfig((current) =>
                                      withLiquidationExecution(current, { orderTtlSeconds: Math.round(value) }),
                                    )
                                  }
                                />
                                <small>由当前大脑参数决定；系统只按该版本执行到期撤单和成交核对</small>
                              </label>
                            )}
                          </>
                        )}
                        <label className="check-row strategy-second-order-toggle">
                          <input
                            type="checkbox"
                            checked={Boolean(liquidationExecutionUi(strategyConfig)?.allowSecondOrder)}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, { allowSecondOrder: event.target.checked }),
                              )
                            }
                          />
                          <span>原委托确认零成交并终结后，重新读取行情并最多委托一次；自适应模式重新选择市价或限价</span>
                        </label>
                        {strategyTriggerKind(strategyConfig) !== "THREE_MINUTE_PROBABILITY" && (
                          <label>
                            <span>大脑探索下单名额</span>
                            <NumberStepper
                              label="当前大脑允许的终身探索下单名额"
                              value={liquidationExecutionUi(strategyConfig)?.explorationOrderTarget ?? 10}
                              min={0}
                              max={150}
                              step={1}
                              unit="笔"
                              onChange={(value) =>
                                setStrategyConfig((current) =>
                                  withLiquidationExecution(current, {
                                    explorationOrderTarget: Math.round(value),
                                  }),
                                )
                              }
                            />
                            <small>0表示只执行眼睛明确确认的订单；非0时是否探索及名额完全属于当前策略版本</small>
                          </label>
                        )}
                        <label>
                          <span>下单数量方式</span>
                          <select
                            value={liquidationExecutionUi(strategyConfig)?.quantitySizingMode ?? "FIXED"}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, {
                                  quantitySizingMode: event.target.value as "FIXED" | "EVIDENCE_1_TO_2",
                                }),
                              )
                            }
                          >
                            <option value="EVIDENCE_1_TO_2">证据选择 1× / 2×权益额度</option>
                            <option value="FIXED">固定权益额度倍数</option>
                          </select>
                          <small>强证据必须同时满足眼睛确认、当前量能接力和委托前时机复核；否则按 1 倍权益额度执行</small>
                        </label>
                        {(liquidationExecutionUi(strategyConfig)?.quantitySizingMode ?? "FIXED") === "FIXED" && (
                          <label>
                            <span>固定权益额度倍数</span>
                            <NumberStepper
                              label="自动下单固定权益额度倍数"
                              value={liquidationExecutionUi(strategyConfig)?.minimumOrderQuantityMultiplier ?? 1}
                              min={1}
                              max={5}
                              step={1}
                              unit="倍"
                              onChange={(value) =>
                                setStrategyConfig((current) =>
                                  withLiquidationExecution(current, {
                                    minimumOrderQuantityMultiplier: Math.round(value),
                                  }),
                                )
                              }
                            />
                            <small>固定模式按“账户权益 × 单笔分配比例”计算，再受单笔最大保证金约束</small>
                          </label>
                        )}
                        <label>
                          <span>最低开仓名义价值</span>
                          <NumberStepper
                            label="策略最低开仓名义价值"
                            value={liquidationExecutionUi(strategyConfig)?.minimumPositionNotionalUsdt ?? 15}
                            min={5}
                            step={1}
                            unit="USDT"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, {
                                  minimumPositionNotionalUsdt: value,
                                }),
                              )
                            }
                          />
                          <small>实际门槛取本参数与 Binance 合约最低名义价值的较高者；不足时放弃开仓，不自动放大风险</small>
                        </label>
                        <label>
                          <span>单笔可用资金分配</span>
                          <NumberStepper
                            label="单笔可再开仓资金分配比例"
                            value={liquidationExecutionUi(strategyConfig)?.equityAllocationPercent ?? 5}
                            min={0.1}
                            max={100}
                            step={0.1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, {
                                  equityAllocationPercent: value,
                                }),
                              )
                            }
                          />
                          <small>目标名义价值 = 账户保证金权益 × 本比例 × 杠杆；证据倍数可放大，但不能突破单笔最大保证金，提交前再核对 Binance 可用保证金</small>
                        </label>
                        <label>
                          <span>同方向挂单处理</span>
                          <select
                            value={liquidationExecutionUi(strategyConfig)?.sameLegWorkingOrderPolicy ?? "BLOCK"}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, {
                                  sameLegWorkingOrderPolicy: event.target.value as "BLOCK" | "ALLOW",
                                }),
                              )
                            }
                          >
                            <option value="BLOCK">已有同方向挂单时不再下单</option>
                            <option value="ALLOW">允许多个同方向挂单</option>
                          </select>
                          <small>执行状态未知的订单仍须先完成交易所核对，防止重复成交</small>
                        </label>
                        <label>
                          <span>已有同向仓位处理</span>
                          <select
                            value={liquidationExecutionUi(strategyConfig)?.existingPositionPolicy ?? "BLOCK"}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, {
                                  existingPositionPolicy: event.target.value as "BLOCK" | "ALLOW_SAME_DIRECTION",
                                }),
                              )
                            }
                          >
                            <option value="BLOCK">已有仓位时不再开同向仓</option>
                            <option value="ALLOW_SAME_DIRECTION">允许同方向继续加仓</option>
                          </select>
                          <small>单向模式的反方向仓位不会被误当作加仓；反向执行仍走独立策略判断</small>
                        </label>
                        <label>
                          <span>单笔最大保证金</span>
                          <NumberStepper
                            label="单笔最大保证金"
                            value={liquidationExecutionUi(strategyConfig)?.maxOrderMarginUsdt ?? 6}
                            min={0.1}
                            step={0.1}
                            unit="USDT"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationExecution(current, { maxOrderMarginUsdt: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>保证金占用参考</span>
                          <NumberStepper
                            label="保证金占用参考"
                            value={liquidationRiskUi(strategyConfig)?.maxMarginUsagePercent ?? 50}
                            min={1}
                            max={100}
                            step={1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { maxMarginUsagePercent: value }),
                              )
                            }
                          />
                          <small>仅展示预计占用，不在本地阻断；最终以 Binance 实际可用保证金为准</small>
                        </label>
                        <label>
                          <span>单日亏损熔断线</span>
                          <NumberStepper
                            label="策略单日亏损熔断线"
                            value={liquidationRiskUi(strategyConfig)?.dailyLossLimitUsdt ?? 15}
                            min={0.1}
                            step={0.5}
                            unit="USDT"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { dailyLossLimitUsdt: value }),
                              )
                            }
                          />
                          <small>仅在异常累计亏损达到阈值时熔断新开仓，不参与常规仓位计算</small>
                        </label>
                        {strategyEntryFundingCoherence && (
                          <div
                            className={`strategy-payoff-note ${
                              [
                                "CONFIG_IMPOSSIBLE",
                                "CURRENT_BALANCE_BLOCKED",
                              ].includes(strategyEntryFundingCoherence.status)
                                ? "warning"
                                : ""
                            }`}
                          >
                            <b>开仓资金联动校验</b>
                            <span>
                              {strategyEntryFundingCoherence.status === "CONFIG_IMPOSSIBLE"
                                ? `配置不可执行：当前杠杆及单笔保证金额度最多支持 ${strategyEntryFundingCoherence.configuredMaximumNotionalUsdt.toFixed(2)} USDT，低于最低开仓 ${strategyEntryFundingCoherence.minimumPositionNotionalUsdt.toFixed(2)} USDT。`
                                : strategyEntryFundingCoherence.status === "CURRENT_BALANCE_BLOCKED"
                                  ? `按最近账户可用余额，普通证据约 ${strategyEntryFundingCoherence.baseTargetNotionalUsdt?.toFixed(2) ?? "--"} USDT、强证据最高约 ${strategyEntryFundingCoherence.maximumTargetNotionalUsdt?.toFixed(2) ?? "--"} USDT，均低于最低开仓 ${strategyEntryFundingCoherence.minimumPositionNotionalUsdt.toFixed(2)} USDT；当前信号只会被资金计算拒绝。`
                                  : strategyEntryFundingCoherence.status === "STRONG_EVIDENCE_ONLY"
                                    ? `普通证据约 ${strategyEntryFundingCoherence.baseTargetNotionalUsdt?.toFixed(2) ?? "--"} USDT，只有通过 2× 强证据门禁后才可能达到最低开仓 ${strategyEntryFundingCoherence.minimumPositionNotionalUsdt.toFixed(2)} USDT。`
                                    : strategyEntryFundingCoherence.status === "READY"
                                      ? `按最近账户可用余额，普通证据目标约 ${strategyEntryFundingCoherence.baseTargetNotionalUsdt?.toFixed(2) ?? "--"} USDT，已达到最低开仓 ${strategyEntryFundingCoherence.minimumPositionNotionalUsdt.toFixed(2)} USDT。`
                                      : `账户可用余额尚未同步；静态配置最多支持 ${strategyEntryFundingCoherence.configuredMaximumNotionalUsdt.toFixed(2)} USDT，发布后运行时仍会按 Binance 最新余额复核。`}
                            </span>
                          </div>
                        )}
                        </div>
                        <div
                          className="strategy-config-step-panel"
                          hidden={
                            strategyConfigStep !== 5 ||
                            strategyTriggerKind(strategyConfig) !==
                              "THREE_MINUTE_PROBABILITY"
                          }
                        >
                          <div className="strategy-config-section-title">
                            <b>5. 动态保护与最终兜底</b>
                            <span>正负收益分别进入不可回退保护；所有动态止盈止损均优先于最长持仓时间</span>
                          </div>
                          <div className="strategy-config-notice">
                            <b>系统固定动态保护</b>
                            <span>
                              盈利大于0开始观察，达到+2%锁住+2%保护线，达到+4%立即整仓止盈；亏损达到-0.8%锁住止损线且不再放宽，再次跌破即退出，达到-1.2%立即硬止损。最长持仓时间仅作最后兜底。
                            </span>
                          </div>
                          <label>
                            <span>最长持仓时间</span>
                            <input
                              value={`${threeMinuteProbabilityTriggerUi(strategyConfig)?.timeExitSeconds ?? 300} 秒`}
                              disabled
                              readOnly
                            />
                            <small>挂单等待时间不计入持仓；成交回报是唯一计时起点，费用后盈利封顶可提前退出</small>
                          </label>
                          <label>
                            <span>费用后盈利封顶</span>
                            <NumberStepper
                              label="3分钟策略费用后盈利封顶"
                              value={
                                threeMinuteProbabilityTriggerUi(strategyConfig)
                                  ?.profitCaptureNetRoePercent ?? 4
                              }
                              min={0.1}
                              max={100}
                              step={0.1}
                              nativeStep="any"
                              unit="% ROE"
                              onChange={(value) =>
                                setStrategyConfig((current) =>
                                  withThreeMinuteProbabilityTrigger(current, {
                                    profitCaptureNetRoePercent: value,
                                  }),
                                )
                              }
                            />
                            <small>达到该费用后 ROE 即整仓平仓，不等待固定持仓时间；与分档提前止盈互不替代</small>
                          </label>
                          <label className="check-row strategy-second-order-toggle">
                            <input
                              type="checkbox"
                              checked={Boolean(
                                threeMinuteProbabilityTriggerUi(strategyConfig)
                                  ?.earlyStopEnabled,
                              )}
                              onChange={(event) =>
                                setStrategyConfig((current) =>
                                  withThreeMinuteProbabilityTrigger(current, {
                                    earlyStopEnabled: event.target.checked,
                                  }),
                                )
                              }
                            />
                            <span>允许提前硬止损（默认关闭）</span>
                          </label>
                          {threeMinuteProbabilityTriggerUi(strategyConfig)
                            ?.earlyStopEnabled && (
                            <label>
                              <span>提前硬止损 ROE</span>
                              <NumberStepper
                                label="3分钟轮次提前硬止损ROE"
                                value={liquidationRiskUi(strategyConfig)?.stopLossPercent ?? 20}
                                min={0.00000001}
                                step={0.1}
                                nativeStep="any"
                                unit="%"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationRisk(current, {
                                      stopLossPercent: value,
                                    }),
                                  )
                                }
                              />
                              <small>达到该亏损ROE时整仓提前退出；关闭开关后该值仅保留、不执行</small>
                            </label>
                          )}
                          <label className="check-row strategy-second-order-toggle">
                            <input
                              type="checkbox"
                              checked={Boolean(
                                threeMinuteProbabilityTriggerUi(strategyConfig)
                                  ?.earlyTakeProfitEnabled,
                              )}
                              onChange={(event) =>
                                setStrategyConfig((current) =>
                                  withThreeMinuteProbabilityTrigger(current, {
                                    earlyTakeProfitEnabled: event.target.checked,
                                  }),
                                )
                              }
                            />
                            <span>允许提前止盈（默认关闭）</span>
                          </label>
                          {threeMinuteProbabilityTriggerUi(strategyConfig)
                            ?.earlyTakeProfitEnabled && (
                            <div className="strategy-three-minute-early-takes">
                              {(liquidationRiskUi(strategyConfig)?.takeProfitSteps ?? []).map((step, index) => (
                                <div className="strategy-take-profit-step" key={`three-minute-take-profit-${index}`}>
                                  <label>
                                    <span>第 {index + 1} 档提前止盈 ROE</span>
                                    <NumberStepper
                                      label={`第${index + 1}档提前止盈ROE`}
                                      value={step.profitPercent}
                                      min={0.00000001}
                                      step={0.1}
                                      nativeStep="any"
                                      unit="%"
                                      onChange={(value) =>
                                        setStrategyConfig((current) =>
                                          withLiquidationTakeProfitStep(current, index, {
                                            profitPercent: value,
                                          }),
                                        )
                                      }
                                    />
                                  </label>
                                  <label>
                                    <span>本档平仓比例</span>
                                    <NumberStepper
                                      label={`第${index + 1}档提前平仓比例`}
                                      value={step.closePercent}
                                      min={0.1}
                                      max={100}
                                      step={0.1}
                                      unit="%"
                                      onChange={(value) =>
                                        setStrategyConfig((current) =>
                                          withLiquidationTakeProfitStep(current, index, {
                                            closePercent: value,
                                          }),
                                        )
                                      }
                                    />
                                  </label>
                                </div>
                              ))}
                              <small>各档比例沿用统一仓位保护规则；到达最长持仓时间会退出全部剩余仓位</small>
                            </div>
                          )}
                          <p className="strategy-config-inline-note">
                            默认只执行费用后盈利封顶、固定时长退出和交易所强平安全边界；轮内概率翻转只记录反事实，不反手、不对冲、不加仓。若开启分档提前退出，将使用本策略下方的止损或止盈参数，并仍补记理论到时结果。
                          </p>
                        </div>
                        <div
                          className="strategy-config-step-panel"
                          hidden={
                            strategyConfigStep !== 5 ||
                            strategyTriggerKind(strategyConfig) ===
                              "THREE_MINUTE_PROBABILITY"
                          }
                        >
                        <div className="strategy-config-section-title">
                          <b>5. 持仓延续与触底反弹</b>
                          <span>盈利判断是否仍有延续证据；亏损必须先触底再反弹，禁止下跌途中摊薄成本</span>
                        </div>
                        <label className="check-row strategy-second-order-toggle">
                          <input
                            type="checkbox"
                            checked={liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.enabled ?? true}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  evidenceRisk: { enabled: event.target.checked },
                                }),
                              )
                            }
                          />
                          <span>启用入场后证据恶化减险（正常波动不减仓）</span>
                        </label>
                        <label>
                          <span>恶化预警节点</span>
                          <NumberStepper
                            label="证据恶化预警节点"
                            value={liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.warningMinute ?? 3}
                            min={1}
                            max={10}
                            step={1}
                            unit="分钟"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  evidenceRisk: { warningMinute: value },
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>部分减险节点</span>
                          <NumberStepper
                            label="证据恶化部分减险节点"
                            value={liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.reductionMinute ?? 5}
                            min={2}
                            max={30}
                            step={1}
                            unit="分钟"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  evidenceRisk: { reductionMinute: value },
                                }),
                              )
                            }
                          />
                        </label>
                        <label className="check-row strategy-second-order-toggle">
                          <input
                            type="checkbox"
                            checked={liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.exitRemainingOnPersistentInvalidation ?? false}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  evidenceRisk: {
                                    exitRemainingOnPersistentInvalidation:
                                      event.target.checked,
                                  },
                                }),
                              )
                            }
                          />
                          <span>减险后持续失效可退出余仓（默认关闭）</span>
                        </label>
                        {liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.exitRemainingOnPersistentInvalidation === true ? (
                          <label>
                            <span>持续失效退出节点</span>
                            <NumberStepper
                              label="持续失效退出节点"
                              value={liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.exitMinute ?? 15}
                              min={3}
                              max={120}
                              step={1}
                              unit="分钟"
                              onChange={(value) =>
                                setStrategyConfig((current) =>
                                  withLiquidationPositionManagement(current, {
                                    evidenceRisk: { exitMinute: value },
                                  }),
                                )
                              }
                            />
                          </label>
                        ) : null}
                        <label>
                          <span>首次减险比例</span>
                          <NumberStepper
                            label="证据恶化首次减险比例"
                            value={liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.reductionPercent ?? 30}
                            min={1}
                            max={99}
                            step={1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  evidenceRisk: { reductionPercent: value },
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>亏损扩大确认</span>
                          <NumberStepper
                            label="费用后亏损扩大确认"
                            value={liquidationRiskUi(strategyConfig)?.positionManagement?.evidenceRisk?.minimumDeteriorationRoePoints ?? 0.5}
                            min={0.1}
                            max={100}
                            step={0.1}
                            unit="ROE点"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  evidenceRisk: {
                                    minimumDeteriorationRoePoints: value,
                                  },
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>盈利回吐判断</span>
                          <NumberStepper
                            label="盈利峰值回吐判断"
                            value={liquidationRiskUi(strategyConfig)?.positionManagement?.profitGivebackRoePoints ?? 3}
                            min={0.1}
                            step={0.1}
                            unit="ROE点"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, { profitGivebackRoePoints: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>触底反弹确认</span>
                          <NumberStepper
                            label="从阶段低点修复幅度"
                            value={liquidationRiskUi(strategyConfig)?.positionManagement?.bottomRecoveryRoePoints ?? 2}
                            min={0.1}
                            step={0.1}
                            unit="ROE点"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, { bottomRecoveryRoePoints: value }),
                              )
                            }
                          />
                        </label>
                        <label className="check-row strategy-second-order-toggle">
                          <input
                            type="checkbox"
                            checked={Boolean(liquidationRiskUi(strategyConfig)?.positionManagement?.addOnEnabled)}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  addOnEnabled: event.target.checked,
                                }),
                              )
                            }
                          />
                          <span>策略仓位确认触底反弹后允许自动补仓</span>
                        </label>
                        <label className="check-row strategy-second-order-toggle">
                          <input
                            type="checkbox"
                            checked={Boolean(liquidationRiskUi(strategyConfig)?.positionManagement?.profitScaleInEnabled)}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  profitScaleInEnabled: event.target.checked,
                                }),
                              )
                            }
                          />
                          <span>策略仓位盈利延续确认后允许自动加仓</span>
                        </label>
                        {(liquidationRiskUi(strategyConfig)?.positionManagement?.addOnEnabled ||
                          liquidationRiskUi(strategyConfig)?.positionManagement?.profitScaleInEnabled) && (
                          <>
                            <label>
                              <span>单次补仓保证金</span>
                              <NumberStepper
                                label="触底反弹单次补仓保证金"
                                value={liquidationRiskUi(strategyConfig)?.positionManagement?.addOnNotionalUsdt ?? 5.1}
                                min={0.1}
                                step={0.1}
                                unit="USDT"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationPositionManagement(current, {
                                      addOnNotionalUsdt: value,
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>单仓最多补仓</span>
                              <NumberStepper
                                label="单个策略仓位最多自动补仓次数"
                                value={liquidationRiskUi(strategyConfig)?.positionManagement?.maxAddOnsPerPosition ?? 1}
                                min={1}
                                max={10}
                                step={1}
                                unit="次"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationPositionManagement(current, {
                                      maxAddOnsPerPosition: value,
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>补仓最短间隔</span>
                              <NumberStepper
                                label="自动补仓最短间隔"
                                value={liquidationRiskUi(strategyConfig)?.positionManagement?.minMinutesBetweenAddOns ?? 30}
                                min={1}
                                max={1440}
                                step={1}
                                unit="分钟"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationPositionManagement(current, {
                                      minMinutesBetweenAddOns: value,
                                    }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>最大亏损补仓范围</span>
                              <NumberStepper
                                label="允许自动补仓的最大亏损 ROE"
                                value={liquidationRiskUi(strategyConfig)?.positionManagement?.maxAddOnLossRoePercent ?? 20}
                                min={0.1}
                                step={0.1}
                                unit="% ROE"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationPositionManagement(current, {
                                      maxAddOnLossRoePercent: value,
                                    }),
                                  )
                                }
                              />
                            </label>
                            <p className="strategy-config-inline-note">
                              仅策略自动下单形成的仓位可触发，人工单与半自动单不参与。触底反弹补仓必须先形成阶段低点，再出现反弹、支撑未破、资金未撤退和两份独立确认；盈利延续加仓仅在独立开关开启后，凭两份独立延续证据且提交前仍为盈利时执行。两个方向均受次数、间隔、保证金额度、最小量和幂等校验约束。
                            </p>
                          </>
                        )}
                        <label className="check-row strategy-second-order-toggle">
                          <input
                            type="checkbox"
                            checked={false}
                            disabled
                          />
                          <span>同账户同合约已有仓位后禁止继续开仓</span>
                        </label>
                        <label className="check-row strategy-second-order-toggle">
                          <input
                            type="checkbox"
                            checked={Boolean(liquidationRiskUi(strategyConfig)?.positionManagement?.contrarianFallbackEnabled)}
                            disabled={liquidationDirection(strategyConfig) !== "BOTH"}
                            onChange={(event) =>
                              setStrategyConfig((current) =>
                                withLiquidationPositionManagement(current, {
                                  contrarianFallbackEnabled: event.target.checked,
                                }),
                              )
                            }
                          />
                          <span>
                            双向策略主方向被趋势/结构拒绝时，允许唯一反向小额探针
                          </span>
                        </label>
                        {liquidationRiskUi(strategyConfig)?.positionManagement?.contrarianFallbackEnabled && (
                          <>
                            <label>
                              <span>反向试单保证金</span>
                              <NumberStepper
                                label="反向试单保证金"
                                value={liquidationRiskUi(strategyConfig)?.positionManagement?.contrarianProbeNotionalUsdt ?? 5.1}
                                min={0.1}
                                step={0.1}
                                unit="USDT"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationPositionManagement(current, {
                                      contrarianProbeNotionalUsdt: value,
                                    }),
                                  )
                                }
                              />
                              <small>只在当前方向判断不适合、且不是账户/保证金/挂单等安全拒绝时触发。</small>
                            </label>
                            <label>
                              <span>探针利润保护阈值</span>
                              <NumberStepper
                                label="反向试单利润保护阈值"
                                value={liquidationRiskUi(strategyConfig)?.positionManagement?.contrarianProfitRoeBeforeHedge ?? 3}
                                min={0.1}
                                step={0.1}
                                unit="ROE点"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationPositionManagement(current, {
                                      contrarianProfitRoeBeforeHedge: value,
                                    }),
                                  )
                                }
                              />
                              <small>
                                达到该 ROE 后转入利润保护；不自动开另一方向，必须等待探针退出和新的独立信号。
                              </small>
                            </label>
                          </>
                        )}
                        </div>
                        <div
                          className="strategy-config-step-panel"
                          hidden={
                            strategyConfigStep !== 6 ||
                            strategyTriggerKind(strategyConfig) !==
                              "THREE_MINUTE_PROBABILITY"
                          }
                        >
                          <div className="strategy-config-section-title">
                            <b>6. N→N+1学习边界</b>
                            <span>每轮终局立即形成下一轮可读标签；精确手续费到账后只升级同一样本</span>
                          </div>
                          <div className="strategy-payoff-note strategy-probability-policy">
                            <b>晋升与回退</b>
                            <span>
                              初始 {threeMinuteProbabilityTriggerUi(strategyConfig)?.calibrationRounds ?? 10} 轮按校准方式运行；每 {threeMinuteProbabilityTriggerUi(strategyConfig)?.batchSize ?? 10} 个精确结算样本检查费用后净收益。负期望按“{threeMinuteProbabilityTriggerUi(strategyConfig)?.negativeExpectancyMode === "MINIMUM_ORDER" ? "继续最小量校准" : "转观察"}”执行，正式参数候选必须人工确认，恶化时回到已确认稳定版本。
                            </span>
                          </div>
                          <div className="strategy-payoff-note">
                            <b>数据隔离</b>
                            <span>
                              学习只读取本策略、本配置版本、本合约与实际方向的完整轮次；历史版本只用于复盘，不自动改变当前参数或下单方向。
                            </span>
                          </div>
                          <p className="strategy-config-inline-note">
                            运营页会显示当前轮次、倒计时、双向概率、费用后净优势、60/120/180秒检查点、精确净收益和候选版本状态。
                          </p>
                        </div>
                        <div
                          className="strategy-config-step-panel"
                          hidden={
                            strategyConfigStep !== 6 ||
                            strategyTriggerKind(strategyConfig) ===
                              "THREE_MINUTE_PROBABILITY"
                          }
                        >
                        <div className="strategy-config-section-title">
                          <b>6. 风险退出参数</b>
                          <span>分批止盈始终执行；固定止损与动态移动止损二选一；距强平价 5% 保护始终独立执行</span>
                        </div>
                        {nexusProbabilityPolicyUi(strategyConfig)?.mode === "NET_EXPECTANCY" && (
                          <div className="strategy-payoff-note strategy-probability-policy">
                            <b>净期望概率门禁</b>
                            <span>
                              眼睛确认后才计算；可比完整周期决定胜率，止盈止损决定预期盈亏，实时盘口价差、手续费和滑点计入成本。
                            </span>
                            <label>
                              <span>最低净期望 ROE</span>
                              <NumberStepper
                                label="最低净期望ROE"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.minimumNetExpectancyRoePercent ?? 0}
                                min={-100}
                                max={100}
                                step={0.1}
                                unit="%"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { minimumNetExpectancyRoePercent: value }))}
                              />
                            </label>
                            <label>
                              <span>冷启动先验胜率</span>
                              <NumberStepper
                                label="冷启动先验胜率"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.priorWinProbabilityPercent ?? 55}
                                min={1}
                                max={99}
                                step={1}
                                unit="%"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { priorWinProbabilityPercent: value }))}
                              />
                            </label>
                            <label>
                              <span>先验等效样本</span>
                              <NumberStepper
                                label="先验等效样本"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.priorEquivalentSamples ?? 4}
                                min={1}
                                max={100}
                                step={1}
                                unit="个"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { priorEquivalentSamples: value }))}
                              />
                            </label>
                            <label>
                              <span>最低可比样本</span>
                              <NumberStepper
                                label="最低可比样本"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.minimumComparableSamples ?? 5}
                                min={1}
                                max={100}
                                step={1}
                                unit="个"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { minimumComparableSamples: value }))}
                              />
                            </label>
                            <label>
                              <span>最多可比样本</span>
                              <NumberStepper
                                label="最多可比样本"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.maximumComparableSamples ?? 120}
                                min={10}
                                max={500}
                                step={10}
                                unit="个"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { maximumComparableSamples: value }))}
                              />
                            </label>
                            <label>
                              <span>样本有效期</span>
                              <NumberStepper
                                label="概率样本有效期"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.maximumSampleAgeDays ?? 30}
                                min={1}
                                max={365}
                                step={1}
                                unit="天"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { maximumSampleAgeDays: value }))}
                              />
                            </label>
                            <label>
                              <span>往返手续费率</span>
                              <NumberStepper
                                label="往返手续费率"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.estimatedRoundTripFeePercent ?? 0.08}
                                min={0}
                                max={2}
                                step={0.01}
                                unit="%"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { estimatedRoundTripFeePercent: value }))}
                              />
                            </label>
                            <label>
                              <span>退出滑点估算</span>
                              <NumberStepper
                                label="退出滑点估算"
                                value={nexusProbabilityPolicyUi(strategyConfig)?.estimatedExitSlippageBps ?? 5}
                                min={0}
                                max={100}
                                step={1}
                                unit="bp"
                                onChange={(value) => setStrategyConfig((current) =>
                                  withNexusProbabilityPolicy(current, { estimatedExitSlippageBps: value }))}
                              />
                            </label>
                          </div>
                        )}
                        <label>
                          <span>固定止损提醒 ROE</span>
                          <NumberStepper
                            label="爆仓策略止损ROE"
                            value={liquidationRiskUi(strategyConfig)?.stopLossPercent ?? 20}
                            min={0.00000001}
                            step={0.1}
                            nativeStep="any"
                            unit="%"
                            readOnly={
                              liquidationRiskUi(strategyConfig)
                                ?.dynamicTrailingEnabled ?? true
                            }
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { stopLossPercent: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>完整周期观察时长</span>
                          <NumberStepper
                            label="完整周期观察时长"
                            value={liquidationRiskUi(strategyConfig)?.minimumObservationMinutes ?? 60}
                            min={0}
                            max={1440}
                            step={5}
                            unit="分钟"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { minimumObservationMinutes: value }),
                              )
                            }
                          />
                           <small>只控制何时生成参数优化结论；强平保护持续运行，其他退出信号通知运营确认。</small>
                        </label>
                        <label>
                          <span>距强平价保护缓冲</span>
                          <NumberStepper
                            label="距强平价保护缓冲"
                            value={liquidationRiskUi(strategyConfig)?.liquidationGuardBufferPercent ?? 5}
                            min={0.1}
                            max={50}
                            step={0.1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { liquidationGuardBufferPercent: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>ATR 止损缓冲</span>
                          <NumberStepper
                            label="ATR止损缓冲"
                            value={liquidationRiskUi(strategyConfig)?.atrStopBuffer ?? 1}
                            min={0}
                            max={10}
                            step={0.1}
                            unit="ATR"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { atrStopBuffer: value }),
                              )
                            }
                          />
                        </label>
                        <label className="strategy-dynamic-trailing-toggle">
                          <span>动态移动止损</span>
                          <span className="inline-toggle-control">
                            <label className="switch">
                              <input
                                type="checkbox"
                                checked={
                                  liquidationRiskUi(strategyConfig)
                                    ?.dynamicTrailingEnabled ?? true
                                }
                                onChange={(event) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationRisk(current, {
                                      dynamicTrailingEnabled:
                                        event.target.checked,
                                    }),
                                  )
                                }
                              />
                              <i></i>
                            </label>
                            <small>
                              开启后按净成本、ATR和峰值ROE动态收紧；关闭时仅执行固定网格
                            </small>
                          </span>
                        </label>
                        <label>
                          <span>动态保护最低启动 ROE</span>
                          <NumberStepper
                            label="移动止损启动ROE"
                            value={liquidationRiskUi(strategyConfig)?.trailingActivationPercent ?? 2}
                            min={0.1}
                            step={0.1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { trailingActivationPercent: value }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>动态保护最小回撤空间</span>
                          <NumberStepper
                            label="移动止损回撤ROE"
                            value={liquidationRiskUi(strategyConfig)?.trailingDrawdownPercent ?? 3}
                            min={0.1}
                            step={0.1}
                            unit="%"
                            onChange={(value) =>
                              setStrategyConfig((current) =>
                                withLiquidationRisk(current, { trailingDrawdownPercent: value }),
                              )
                            }
                          />
                        </label>
                        {(liquidationRiskUi(strategyConfig)
                          ?.dynamicTrailingEnabled ?? true) && (
                          <div className="strategy-risk-mode-note">
                            动态移动止损已开启：固定止损参数暂不参与执行；分步止盈与距强平价保护继续有效。
                          </div>
                        )}
                        {(liquidationRiskUi(strategyConfig)?.takeProfitSteps ?? []).map((step, index) => (
                          <div className="strategy-take-profit-step" key={`take-profit-${index}`}>
                            <label>
                               <span>第 {index + 1} 档止盈提醒 ROE</span>
                              <NumberStepper
                                label={`第${index + 1}档止盈ROE`}
                                value={step.profitPercent}
                                min={0.00000001}
                                step={0.1}
                                nativeStep="any"
                                unit="%"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationTakeProfitStep(current, index, { profitPercent: value }),
                                  )
                                }
                              />
                            </label>
                            <label>
                              <span>本档平仓比例</span>
                              <NumberStepper
                                label={`第${index + 1}档平仓比例`}
                                value={step.closePercent}
                                min={0.1}
                                max={100}
                                step={0.1}
                                unit="%"
                                onChange={(value) =>
                                  setStrategyConfig((current) =>
                                    withLiquidationTakeProfitStep(current, index, { closePercent: value }),
                                  )
                                }
                              />
                            </label>
                            {(liquidationRiskUi(strategyConfig)?.takeProfitSteps?.length ?? 0) > 1 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setStrategyConfig((current) => {
                                    const risk = liquidationRiskUi(current);
                                    return withLiquidationRisk(current, {
                                      takeProfitSteps: (risk?.takeProfitSteps ?? []).filter((_, stepIndex) => stepIndex !== index),
                                    });
                                  })
                                }
                              >
                                删除本档
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          className="strategy-add-take-profit"
                          type="button"
                          disabled={(liquidationRiskUi(strategyConfig)?.takeProfitSteps?.length ?? 0) >= 20}
                          onClick={() =>
                            setStrategyConfig((current) => {
                              const risk = liquidationRiskUi(current);
                              const steps = risk?.takeProfitSteps ?? [];
                              const previous = steps.at(-1)?.profitPercent ?? 0;
                              return withLiquidationRisk(current, {
                                takeProfitSteps: [
                                  ...steps,
                                  { profitPercent: previous + 5, closePercent: 10 },
                                ],
                              });
                            })
                          }
                        >
                          ＋ 添加止盈档位
                        </button>
                        {strategyPayoff && (
                          <div className={`strategy-payoff-note ${
                            strategyPayoff.netRiskRewardRatio !== null &&
                            strategyPayoff.netRiskRewardRatio < 1
                              ? "warning"
                              : ""
                          }`}>
                            <b>参数收益结构</b>
                            <span>
                              配置目标 +{strategyPayoff.grossRewardRoePercent.toFixed(2)}% ROE / 止损 -{strategyPayoff.netLossRoePercent.toFixed(2)}% ROE
                              {strategyPayoff.completeExitConfigured && strategyPayoff.netRiskRewardRatio !== null
                                ? ` · 扣双边 0.08% 估算成本后盈亏比 ${strategyPayoff.netRiskRewardRatio.toFixed(2)} · 保本胜率 ${strategyPayoff.breakEvenWinRatePercent?.toFixed(1)}%`
                                : ` · 仅覆盖 ${strategyPayoff.configuredClosePercent.toFixed(1)}% 仓位，不能保存为实盘策略`}
                            </span>
                          </div>
                        )}
                        <div className="strategy-payoff-note">
                          <b>执行边界</b>
                          <span>
                            当前止盈档位合计覆盖 {(
                              liquidationRiskUi(strategyConfig)?.takeProfitSteps ?? []
                            ).reduce((sum, step) => sum + step.closePercent, 0).toFixed(1)}% 仓位；移动保护仅跟踪尚未退出的仓位。除距强平价保护线外，系统只通知、不自主平仓。
                          </span>
                        </div>
                        </div>
                      </>
                    )}
                    <div
                      className="strategy-config-step-panel"
                      hidden={strategyConfigStep !== 6}
                    >
                    <label className="strategy-direction-field">
                      <span>允许方向</span>
                      <select
                        disabled={
                          Boolean(strategyPluginId(strategyConfig)) ||
                          [
                            "RELATIVE_STRENGTH_CONTINUATION",
                            "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE",
                            "HIGH_POSITION_PRICE_VOLUME_STRUCTURE",
                            "LOW_POSITION_WINDOW",
                            "THREE_MINUTE_PROBABILITY",
                          ].includes(strategyTriggerKind(strategyConfig))
                        }
                        value={
                          liquidationConfigShape(strategyConfig)
                            ? liquidationDirection(strategyConfig)
                            : strategyConfig.direction
                        }
                        onChange={(event) =>
                          setStrategyConfig((current) =>
                            liquidationConfigShape(current)
                              ? withLiquidationDirection(
                                  current,
                                  event.target.value as StrategyDirection,
                                )
                              : {
                                  ...current,
                                  direction:
                                    event.target.value as StrategyDirection,
                                }
                          )
                        }
                      >
                        <option value="BOTH">双向</option>
                        <option value="LONG_ONLY">仅做多</option>
                        <option value="SHORT_ONLY">仅做空</option>
                      </select>
                      {liquidationConfigShape(strategyConfig) && (
                        <small>
                          {strategyTriggerKind(strategyConfig) ===
                          "LOW_POSITION_WINDOW"
                            ? "低位价格触发器固定仅做多；价格位置只负责唤醒，统一大脑仍可因趋势证据不足而等待或拒绝。"
                            : strategyTriggerKind(strategyConfig) ===
                                "THREE_MINUTE_PROBABILITY"
                              ? "固定为双向候选；每个合约每轮只执行费用后净期望较高的一侧，轮内不反手。"
                              : strategyTriggerKind(strategyConfig) ===
                                  "RELATIVE_STRENGTH_CONTINUATION"
                                ? "固定为双向配对；强腿做多、弱腿做空，两腿分别进入统一仓位生命周期。"
                                : strategyTriggerKind(strategyConfig) ===
                                    "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
                                  ? "固定为双向；唤醒后由共享大脑根据闭合趋势选择方向。"
                                  : strategyTriggerKind(strategyConfig) ===
                                      "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
                                    ? "固定仅做空；高位和卖量转弱只负责唤醒，仍需统一入场确认。"
                                    : "方向先路由：仅做多/仅做空严格禁止反向；双向策略才可启用反向探针，同一策略与合约一次只允许一个分支下单。"}
                        </small>
                      )}
                    </label>
                    {liquidationConfigShape(strategyConfig) &&
                      strategyTriggerKind(strategyConfig) ===
                        "SCHEDULED_SCAN" &&
                      liquidationDirection(strategyConfig) === "BOTH" && (
                        <>
                          <label className="strategy-direction-field">
                            <span>多空裁决方式</span>
                            <select
                              disabled={Boolean(strategyPluginId(strategyConfig))}
                              value={
                                strategyDirectionDecisionUi(strategyConfig).mode
                              }
                              onChange={(event) =>
                                setStrategyConfig((current) =>
                                  withStrategyDirectionDecision(current, {
                                    mode: event.target.value as
                                      | "TRIGGER_DIRECTED"
                                      | "COMPETING_DIRECTIONS",
                                  })
                                )
                              }
                            >
                              <option value="TRIGGER_DIRECTED">
                                分方向独立等待
                              </option>
                              <option value="COMPETING_DIRECTIONS">
                                同快照多空择优
                              </option>
                            </select>
                            <small>
                              同快照择优会让多空使用同一批闭合行情分别判断；只有一侧同时通过结构、费用后净期望和不确定性边界时，才进入原统一授权和发单流程。
                            </small>
                          </label>
                          {strategyDirectionDecisionUi(strategyConfig).mode ===
                            "COMPETING_DIRECTIONS" && (
                              <>
                                <label>
                                  <span>最低收益风险比</span>
                                  <NumberStepper
                                    label="方向最低收益风险比"
                                    value={
                                      strategyDirectionDecisionUi(strategyConfig)
                                        .minimumRewardRiskRatio
                                    }
                                    min={1}
                                    max={20}
                                    step={0.1}
                                    nativeStep="any"
                                    onChange={(value) =>
                                      setStrategyConfig((current) =>
                                        withStrategyDirectionDecision(current, {
                                          minimumRewardRiskRatio: value,
                                        })
                                      )
                                    }
                                  />
                                  <small>胜出方向的配置盈利空间必须覆盖风险</small>
                                </label>
                                <label>
                                  <span>最小方向优势</span>
                                  <NumberStepper
                                    label="多空最小净期望差"
                                    value={
                                      strategyDirectionDecisionUi(strategyConfig)
                                        .minimumDirectionAdvantageRoePercent
                                    }
                                    min={0}
                                    max={100}
                                    step={0.05}
                                    nativeStep="any"
                                    unit="% ROE"
                                    onChange={(value) =>
                                      setStrategyConfig((current) =>
                                        withStrategyDirectionDecision(current, {
                                          minimumDirectionAdvantageRoePercent:
                                            value,
                                        })
                                      )
                                    }
                                  />
                                  <small>多空都合格时，差距不足则继续等待</small>
                                </label>
                                <label>
                                  <span>最大结构不确定性</span>
                                  <NumberStepper
                                    label="最大结构不确定性"
                                    value={
                                      strategyDirectionDecisionUi(strategyConfig)
                                        .maximumUncertaintyRoePercent
                                    }
                                    min={0}
                                    max={100}
                                    step={0.1}
                                    nativeStep="any"
                                    unit="% ROE"
                                    onChange={(value) =>
                                      setStrategyConfig((current) =>
                                        withStrategyDirectionDecision(current, {
                                          maximumUncertaintyRoePercent: value,
                                        })
                                      )
                                    }
                                  />
                                  <small>1/2/3/4小时方向冲突会占用该边界</small>
                                </label>
                              </>
                            )}
                        </>
                      )}
                    {liquidationConfigShape(strategyConfig) &&
                      ["SHORT_ONLY", "BOTH"].includes(
                        liquidationDirection(strategyConfig),
                      ) && (
                        <>
                          <label>
                            <span>1小时多头爆仓占比</span>
                            <NumberStepper
                              label="做空所需多头爆仓占比"
                              value={
                                liquidationShortTrendUi(strategyConfig)
                                  ?.minimumLongLiquidationSharePercent ?? 65
                              }
                              min={50}
                              max={100}
                              step={1}
                              unit="%"
                              onChange={(value) =>
                                setStrategyConfig((current) =>
                                  withLiquidationShortTrend(current, {
                                    minimumLongLiquidationSharePercent: value,
                                  }),
                                )
                              }
                            />
                            <small>达到后才进入做空趋势、破位和反抽失败判断</small>
                          </label>
                          <label>
                            <span>60分钟最小跌幅</span>
                            <NumberStepper
                              label="做空所需60分钟最小跌幅"
                              value={
                                liquidationShortTrendUi(strategyConfig)
                                  ?.minimumMarket60mDropPercent ?? 0.2
                              }
                              min={0.01}
                              step={0.01}
                              nativeStep="any"
                              unit="%"
                              onChange={(value) =>
                                setStrategyConfig((current) =>
                                  withLiquidationShortTrend(current, {
                                    minimumMarket60mDropPercent: value,
                                  }),
                                )
                              }
                            />
                            <small>同时要求60分钟形成更低高点和更低低点</small>
                          </label>
                        </>
                      )}
                    <div className="strategy-timeframe-field strategy-timeframe-field-wide">
                      <span>分析周期</span>
                      <div className="strategy-timeframe-list" aria-label="固定分析周期">
                        <b>1分钟</b>
                        <b>3分钟</b>
                        <b>5分钟</b>
                        <b>30分钟</b>
                        <b>1小时</b>
                        <b>4小时</b>
                      </div>
                    </div>
                    {!liquidationConfigShape(strategyConfig) && <div className="strategy-config-section-title">
                      <b>2. 信号与执行</b>
                      <span>1分钟触发，3分钟与5分钟确认，30分钟、1小时、4小时过滤趋势</span>
                    </div>}
                    {!liquidationConfigShape(strategyConfig) && <label>
                      <span>回看 K 线</span>
                      <NumberStepper
                        label="回看K线"
                        value={strategyConfig.lookback}
                        min={5}
                        max={100}
                        step={1}
                        unit="根"
                        onChange={(value) =>
                          setStrategyConfig({ ...strategyConfig, lookback: value })
                        }
                      />
                    </label>}
                    {!liquidationConfigShape(strategyConfig) && <label>
                      <span>动量阈值</span>
                      <NumberStepper
                        label="动量阈值"
                        value={strategyConfig.momentumThresholdPercent}
                        min={0.1}
                        max={10}
                        step={0.1}
                        unit="%"
                        onChange={(value) =>
                          setStrategyConfig({
                            ...strategyConfig,
                            momentumThresholdPercent: value,
                          })
                        }
                      />
                    </label>}
                    {!liquidationConfigShape(strategyConfig) && <label>
                      <span>订单上限</span>
                      <NumberStepper
                        label="单轮订单上限"
                        value={strategyConfig.maxOrdersPerRun}
                        min={1}
                        step={1}
                        unit="笔"
                        onChange={(value) =>
                          setStrategyConfig({ ...strategyConfig, maxOrdersPerRun: value })
                        }
                      />
                    </label>}
                    {!liquidationConfigShape(strategyConfig) && (
                      <div className="strategy-config-section-title">
                        <b>3. 风控参数</b>
                        <span>系统命中条件后按策略执行保护</span>
                      </div>
                    )}
                    {!liquidationConfigShape(strategyConfig) && <label className="strategy-risk-field">
                      <span>止损 ROE</span>
                      <NumberStepper
                        label="策略止损ROE"
                        value={strategyConfig.stopLossPercent}
                        min={0.00000001}
                        step={0.1}
                        nativeStep="any"
                        unit="%"
                        onChange={(value) =>
                          setStrategyConfig({ ...strategyConfig, stopLossPercent: value })
                        }
                      />
                    </label>}
                    {!liquidationConfigShape(strategyConfig) && <label className="strategy-risk-field">
                      <span>止盈 ROE</span>
                      <NumberStepper
                        label="策略止盈ROE"
                        value={strategyConfig.takeProfitPercent}
                        min={0.00000001}
                        step={0.1}
                        nativeStep="any"
                        unit="%"
                        onChange={(value) =>
                          setStrategyConfig({ ...strategyConfig, takeProfitPercent: value })
                        }
                      />
                    </label>}
                    </div>
                  </div>
                  <div className="config-safety">
                    <b>执行边界</b>
                    <span>
                      生产环境仅允许实盘；所选子账户必须先在账户管理完成密钥校验并启用实盘。
                    </span>
                  </div>
                  <div className="config-actions">
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={closeStrategyConfigDialog}
                    >
                      取消
                    </button>
                    <button
                      onMouseDown={(event) => event.preventDefault()}
                      disabled={
                        automationBusy ||
                        !strategyNetProfitPathReady ||
                        !strategyFundingConfigurationReady
                      }
                      onClick={() => void saveConfiguredStrategy(false)}
                    >
                      {automationBusy ? "保存中…" : "仅保存草稿（不生效）"}
                    </button>
                    <button
                      className="primary-btn"
                      onMouseDown={(event) => event.preventDefault()}
                      disabled={
                        automationBusy ||
                        !strategyNetProfitPathReady ||
                        !strategyFundingConfigurationReady
                      }
                      onClick={() => void saveConfiguredStrategy(true)}
                    >
                      {automationBusy ? "发布中…" : "保存并立即生效"}
                    </button>
                  </div>
                </section>
              </div>
            )}
          </>
        )}
        {configuredStrategy && (
          <section className="panel control-panel strategy-version-history">
            <div className="panel-head">
              <div>
                <h2>策略参数版本历史</h2>
                <p>
                  {configuredStrategy.name} · 当前 V
                  {configuredStrategy.publishedVersion ??
                    configuredStrategy.configVersion}
                  {configuredStrategy.hasUnpublishedDraft
                    ? ` · 草稿 V${configuredStrategy.draft?.version ?? configuredStrategy.draftVersion}`
                    : ""}
                  ；保存只更新草稿，发布后新订单才使用新版本
                </p>
              </div>
              <div className="panel-actions">
                <button
                  onClick={() =>
                    exportStrategyVersionVerification(filteredStrategyVersions)
                  }
                  disabled={filteredStrategyVersions.length === 0}
                >
                  导出版本报告 CSV
                </button>
                <span className="guard">
                  {currentStrategyVersions.length} 个快照
                </span>
              </div>
            </div>
            <div className="data-table">
              <table>
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>保存时间</th>
                    <th>运行账户</th>
                    <th>合约范围</th>
                    <th>周期 / 触发</th>
                    <th>策略资金</th>
                    <th>杠杆</th>
                    <th>止损 / 止盈</th>
                    <th>方向</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStrategyVersions.map((version) => (
                    <tr key={version.id}>
                      <td>
                        <div className="version-identity">
                          <span
                            className={`version-badge ${version.version === (configuredStrategy.publishedVersion ?? configuredStrategy.configVersion) ? "current" : ""}`}
                          >
                            V{version.version}
                          </span>
                          <span
                            className={`source-tag ${
                              version.lifecycle === "DRAFT"
                                ? "warning"
                                : version.lifecycle === "PUBLISHED"
                                  ? "protect"
                                  : ""
                            }`}
                          >
                            {version.lifecycle === "DRAFT"
                              ? "草稿"
                              : version.lifecycle === "PUBLISHED"
                                ? "已发布"
                                : "历史发布"}
                          </span>
                          {version.isBaseline && (
                            <span className="source-tag protect">对比基准</span>
                          )}
                        </div>
                        {version.versionLabel && (
                          <b className="version-label">
                            {version.versionLabel}
                          </b>
                        )}
                        {version.note && (
                          <small title={version.note}>{version.note}</small>
                        )}
                        {version.sourceVersion ? (
                          <small>源自 V{version.sourceVersion}</small>
                        ) : null}
                      </td>
                      <td>
                        {new Date(version.createdAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </td>
                      <td className="mono">{version.accountId}</td>
                      <td>{version.symbolScope}</td>
                      <td>
                        1m / 3m / 5m / 30m / 1h / 4h ·{" "}
                        {strategyVersionTriggerSummary(version.config)}
                      </td>
                      <td>
                        {strategyVersionFundingSummary(version.config)}
                      </td>
                      <td>
                        {String(
                          liquidationExecutionUi(version.config)?.leverage ??
                            version.config.leverage ??
                            "—",
                        )}
                        ×
                      </td>
                      <td>
                        {strategyVersionRiskSummary(version.config)}
                      </td>
                      <td>
                        {(liquidationConfigShape(version.config)
                          ? liquidationDirection(version.config)
                          : version.config.direction) === "LONG_ONLY"
                          ? "仅做多"
                          : (liquidationConfigShape(version.config)
                                ? liquidationDirection(version.config)
                                : version.config.direction) === "SHORT_ONLY"
                            ? "仅做空"
                            : "多空择时"}
                      </td>
                      <td>
                        <div className="member-actions">
                          <button
                            className="text-action"
                            disabled={
                              !can("trade:strategy:edit") || automationBusy
                            }
                            onClick={() => openVersionMetadataEditor(version)}
                          >
                            标签与备注
                          </button>
                          <button
                            className="text-action"
                            disabled={
                              !can("trade:strategy:edit") ||
                              automationBusy ||
                              version.version ===
                                (configuredStrategy.publishedVersion ??
                                  configuredStrategy.configVersion)
                            }
                            onClick={() => setRollbackVersionTarget(version)}
                          >
                            {version.version ===
                            (configuredStrategy.publishedVersion ??
                              configuredStrategy.configVersion)
                              ? "当前版本"
                              : "基于此版本回滚"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredStrategyVersions.length === 0 && (
                <div className="empty">当前筛选条件下没有策略版本</div>
              )}
            </div>
            <div className="security-note">
              <b>版本生效规则</b>
              <span>
                保存和回滚只生成草稿；人工发布后新订单使用新版本，已有仓位继续使用开仓时绑定的版本。
              </span>
            </div>
          </section>
        )}
        {versionMetadataTarget && configuredStrategy && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-metadata-title"
          >
            <div className="modal strategy-config-modal version-metadata-modal">
              <div className="config-title">
                <div>
                  <h2 id="version-metadata-title">
                    标记策略 V{versionMetadataTarget.version}
                  </h2>
                  <p>为历史快照补充用途说明，便于后续对比和回滚</p>
                </div>
                <button
                  aria-label="关闭"
                  onClick={() => setVersionMetadataTarget(null)}
                >
                  ×
                </button>
              </div>
              <div className="version-metadata-fields">
                <label>
                  <span>版本标签</span>
                  <input
                    maxLength={40}
                    value={versionMetadataForm.versionLabel}
                    onChange={(event) =>
                      setVersionMetadataForm({
                        ...versionMetadataForm,
                        versionLabel: event.target.value,
                      })
                    }
                    placeholder="例如：稳健参数、运营基准"
                  />
                  <small>{versionMetadataForm.versionLabel.length}/40</small>
                </label>
                <label>
                  <span>版本备注</span>
                  <textarea
                    maxLength={200}
                    rows={4}
                    value={versionMetadataForm.note}
                    onChange={(event) =>
                      setVersionMetadataForm({
                        ...versionMetadataForm,
                        note: event.target.value,
                      })
                    }
                    placeholder="记录本次配置目的、适用行情或注意事项"
                  />
                  <small>{versionMetadataForm.note.length}/200</small>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={versionMetadataForm.isBaseline}
                    onChange={(event) =>
                      setVersionMetadataForm({
                        ...versionMetadataForm,
                        isBaseline: event.target.checked,
                      })
                    }
                  />
                  <span>设为该策略的默认对比基准</span>
                  <small>每个策略只能保留一个基准版本</small>
                </label>
              </div>
              <div className="config-safety">
                <b>只修改说明信息</b>
                <span>
                  保存不会改变策略参数、运行状态、历史验证记录或实盘仓位。
                </span>
              </div>
              <div className="config-actions">
                <button onClick={() => setVersionMetadataTarget(null)}>
                  取消
                </button>
                <button
                  className="primary-btn"
                  disabled={automationBusy}
                  onClick={() => void saveStrategyVersionMetadata()}
                >
                  {automationBusy ? "保存中…" : "保存版本标记"}
                </button>
              </div>
            </div>
          </div>
        )}


        {rollbackVersionTarget && configuredStrategy && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rollback-version-title"
          >
            <div className="modal">
              <span className="modal-icon">!</span>
              <h2 id="rollback-version-title">
                确认基于 V{rollbackVersionTarget.version} 回滚？
              </h2>
              <p>
                系统将复制该版本参数并创建 V
                {configuredStrategy.configVersion + 1}{" "}
                草稿。当前版本和所有历史快照都会保留，策略不会自动启动。
              </p>
              <div>
                <button onClick={() => setRollbackVersionTarget(null)}>
                  取消
                </button>
                <button
                  className="danger-btn"
                  disabled={automationBusy}
                  onClick={() => void rollbackStrategyVersion()}
                >
                  {automationBusy ? "创建版本中…" : "确认回滚并创建新版本"}
                </button>
              </div>
            </div>
          </div>
        )}
        {configuredStrategy && currentStrategyVersions.length > 0 && (
          <section className="panel control-panel strategy-version-compare">
            <div className="panel-head">
              <div>
                <h2>策略版本差异对比</h2>
                <p>
                  回滚前逐项核对两个历史参数快照；已标记的基准版本会自动优先选用
                </p>
              </div>
              <div className="panel-actions">
                <button
                  onClick={() =>
                    exportStrategyVersionDiff(
                      strategyVersionDiff,
                      compareBaseVersion,
                      compareTargetVersion,
                    )
                  }
                  disabled={!compareBaseSnapshot || !compareTargetSnapshot}
                >
                  导出差异 CSV
                </button>
                <span className="guard">
                  {strategyVersionDiff.filter((row) => row.changed).length}{" "}
                  项变化
                </span>
              </div>
            </div>
            <div className="version-compare-selectors">
              <label>
                <span>基准版本</span>
                <select
                  value={compareBaseVersion}
                  onChange={(event) =>
                    setCompareBaseVersion(Number(event.target.value))
                  }
                >
                  {currentStrategyVersions.map((version) => (
                    <option key={version.id} value={version.version}>
                      V{version.version}
                      {version.versionLabel ? ` · ${version.versionLabel}` : ""}
                      {version.isBaseline
                        ? "（基准）"
                        : version.version === configuredStrategy.configVersion
                          ? "（当前）"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
              <span>→</span>
              <label>
                <span>目标版本</span>
                <select
                  value={compareTargetVersion}
                  onChange={(event) =>
                    setCompareTargetVersion(Number(event.target.value))
                  }
                >
                  {currentStrategyVersions.map((version) => (
                    <option key={version.id} value={version.version}>
                      V{version.version}
                      {version.versionLabel ? ` · ${version.versionLabel}` : ""}
                      {version.isBaseline
                        ? "（基准）"
                        : version.version === configuredStrategy.configVersion
                          ? "（当前）"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="data-table">
              <table>
                <thead>
                  <tr>
                    <th>参数</th>
                    <th>V{compareBaseVersion}</th>
                    <th>V{compareTargetVersion}</th>
                    <th>对比结果</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyVersionDiff.map((row) => (
                    <tr
                      key={row.key}
                      className={row.changed ? "diff-changed" : ""}
                    >
                      <td>
                        <b>{row.label}</b>
                      </td>
                      <td>{row.before}</td>
                      <td>{row.after}</td>
                      <td>
                        <span
                          className={`source-tag ${row.changed ? "protect" : "auto"}`}
                        >
                          {row.changed ? "已变化" : "未变化"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {strategyVersionDiff.length === 0 && (
                <div className="empty">请选择两个可用版本进行比较</div>
              )}
            </div>
            <div className="analytics-note">
              版本差异只比较可执行参数；版本标签、备注、保存时间、版本来源和历史验证记录不参与参数差异判定。
            </div>
          </section>
        )}
















      </div>
    );
  if (active === "position")
    return (
      <PositionsView
        livePositions={livePositions}
        positionsLoaded={positionsLoaded}
        strategyNames={Object.fromEntries(
          configuredStrategies.map((strategy) => [strategy.id, strategy.name]),
        )}
        portfolioAccountFilter={portfolioAccountFilter}
        accountFilterControl={accountFilterControl}
        positionsBusy={positionsBusy}
        loadPositions={async () => {
          await Promise.all([
            loadPositions(),
            loadExchangeCredentials(true),
          ]);
        }}
        can={can}
        openLiveRiskEditor={openLiveRiskEditor}
        openLiveCloseConfirmation={openLiveCloseConfirmation}
        openLiveAddConfirmation={openLiveAddConfirmation}
        liveRiskEditTarget={liveRiskEditTarget}
        setLiveRiskEditTarget={setLiveRiskEditTarget}
        liveRiskEditForm={liveRiskEditForm}
        setLiveRiskEditForm={setLiveRiskEditForm}
        liveTakeProfitPlan={liveTakeProfitPlan}
        liveStopLossPlan={liveStopLossPlan}
        saveLivePositionRisk={saveLivePositionRisk}
        liveAddTarget={liveAddTarget}
        setLiveAddTarget={setLiveAddTarget}
        liveAddSubmitting={liveAddSubmitting}
        liveAddQuantity={liveAddQuantity}
        setLiveAddQuantity={setLiveAddQuantity}
        liveAddQuantityMinimum={liveAddQuantityMinimum}
        liveAddExactQuantityMinimum={liveAddExactQuantityMinimum}
        liveAddQuantityStep={liveAddQuantityStep}
        liveAddPrice={liveAddPrice}
        setLiveAddPrice={setLiveAddPrice}
        liveAddQuantityValid={liveAddQuantityValid}
        liveAddMarket={liveAddMarket ?? null}
        liveAddPoolBusy={poolBusy === "CREATE"}
        addLiveAddSymbolToPool={createSymbol}
        confirmLivePositionAdd={confirmLivePositionAdd}
        liveCloseTarget={liveCloseTarget}
        setLiveCloseTarget={setLiveCloseTarget}
        liveCloseSubmitting={liveCloseSubmitting}
        liveCloseQuantity={liveCloseQuantity}
        setLiveCloseQuantity={setLiveCloseQuantity}
        liveCloseQuantityMinimum={liveCloseQuantityMinimum}
        liveCloseQuantityStep={liveCloseQuantityStep}
        liveClosePrice={liveClosePrice}
        setLiveClosePrice={setLiveClosePrice}
        liveCloseQuantityValid={liveCloseQuantityValid}
        liveCloseLeavesDust={liveCloseLeavesDust}
        liveCloseAll={liveCloseAll}
        liveCloseRemainingQuantity={liveCloseRemainingQuantity}
        liveCloseQuantityAdjusted={liveCloseQuantityAdjusted}
        liveCloseNormalizedQuantity={liveCloseNormalizedQuantity}
        confirmLivePositionClose={confirmLivePositionClose}
      />
    );
  if (active === "profit")
    return (
      <ProfitView
        livePositionReductions={livePositionReductions}
        livePositions={livePositions}
        tradingAccounts={tradingAccounts}
        exchangeCredentials={exchangeCredentials}
        strategyNames={Object.fromEntries(
          configuredStrategies.map((strategy) => [strategy.id, strategy.name]),
        )}
        portfolioAccountFilter={portfolioAccountFilter}
        accountFilterControl={accountFilterControl}
        positionsBusy={positionsBusy}
        loadPositions={async () => {
          await loadPositions();
        }}
        syncReductionSettlements={syncReductionSettlements}
        openCurrentPositions={() => setActive("position")}
      />
    );
  if (active === "dailyOperations")
    return <DailyOperationsView refreshSignal={workspaceRefreshVersion} />;
  if (active === "orders")
    return (
      <OrdersView
        liveOrders={liveOrders}
        strategyNames={Object.fromEntries(
          configuredStrategies.map((strategy) => [strategy.id, strategy.name]),
        )}
        portfolioAccountFilter={portfolioAccountFilter}
        orderStatus={orderStatus}
        orderDateRange={orderDateRange}
        orderQuery={orderQuery}
        setOrderQuery={setOrderQuery}
        setOrderStatus={setOrderStatus}
        setOrderDateRange={setOrderDateRange}
        accountFilterControl={accountFilterControl}
        loadLiveOrders={async () => {
          await loadLiveOrders();
        }}
        loadingOrders={loadingOrders}
        currentTime={currentTime}
        liveCancelBusy={liveCancelBusy}
        can={can}
        liveCancelOrderTarget={liveCancelOrderTarget}
        setLiveCancelOrderTarget={setLiveCancelOrderTarget}
        cancelLivePendingOrder={cancelLivePendingOrder}
      />
    );
  if (active === "quoteShadow")
    return (
      <QuoteShadowView
        tradingAccounts={tradingAccounts}
        canReview={can("trade:strategy:edit")}
        setToast={setToast}
      />
    );
  if (active === "accounts")
    return (
      <div className="work-page">
        <section className="panel control-panel account-directory">
          <div className="panel-head">
            <div>
              <h2>账户管理</h2>
              <p>
                生产环境仅支持实盘；主账户只查看资产，交易子账户需通过密钥校验后启用
              </p>
            </div>
            <div className="panel-actions">
              <span className="guard">
                {
                  tradingAccounts.filter(
                    (item) => item.accountType === "STRATEGY" && item.isActive,
                  ).length
                }{" "}
                个交易子账户
              </span>
              <button
                className="primary-btn"
                disabled={!can("sys:account:manage")}
                onClick={() => setShowAddAccount(true)}
              >
                ＋ 新增
              </button>
            </div>
          </div>
          <div className="config-safety account-server-live-control">
            <div>
              <b>服务器实盘总控</b>
              <span>
                {serverLiveTradingAllowed
                  ? "已开启；策略是否执行只由策略卡片上的人工开关决定"
                  : "已关闭；不会提交新的实盘开仓订单"}
              </span>
            </div>
            <button
              className={serverLiveTradingAllowed ? "danger-btn" : "primary-btn"}
              disabled={!can("sys:account:manage") || serverLiveControlBusy}
              onClick={() => {
                setServerLiveControlAction(
                  serverLiveTradingAllowed ? "DISABLE" : "ENABLE",
                );
                setServerLiveControlConfirmation("");
              }}
            >
              {serverLiveTradingAllowed ? "关闭服务器实盘" : "开启服务器实盘"}
            </button>
          </div>
          <div className="data-table account-directory-table">
            <table>
              <thead>
                <tr>
                  <th>账户ID / 名称</th>
                  <th>交易所</th>
                  <th>运营账号</th>
                  <th>状态</th>
                  <th>账户余额 / 可用余额</th>
                  <th>AppKey / 校验</th>
                  <th>交易模式</th>
                  <th>备注</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {[...tradingAccounts]
                  .sort((a, b) =>
                    a.accountType === b.accountType
                      ? a.id - b.id
                      : a.accountType === "MAIN"
                        ? -1
                        : 1,
                  )
                  .map((account) => {
                    const credential = exchangeCredentials.find(
                      (item) => item.accountId === account.accountId,
                    );
                    return (
                      <AccountDirectoryRow
                        key={account.id}
                        account={account}
                        credential={credential}
                        canManageAccount={can("sys:account:manage")}
                        canManageExchange={can("sys:exchange:manage")}
                        credentialBusy={
                          credentialBusy === String(credential?.id)
                        }
                        accountBusy={
                          tradingAccountBusy === account.accountId
                        }
                        onChange={(nextAccount) =>
                          setTradingAccounts((current) =>
                            current.map((item) =>
                              item.id === nextAccount.id ? nextAccount : item,
                            ),
                          )
                        }
                        onConfigureCredential={(accountId, promptForSave) => {
                          setCredentialForm((current) => ({
                            ...current,
                            accountId,
                            apiKey: "",
                            secretKey: "",
                          }));
                          setCredentialModalOpen(true);
                          if (promptForSave)
                            setToast("请先保存密钥，再执行校验");
                        }}
                        onVerifyCredential={(target) =>
                          void verifyExchangeCredential(target)
                        }
                        onToggleLive={(target) => {
                          setCredentialAction({
                            credential: target,
                            action: target.liveTradingEnabled ? "DISABLE" : "ENABLE",
                          });
                          setCredentialConfirmation("");
                        }}
                        onChangePositionMode={(target) => {
                          setCredentialAction({
                            credential: target,
                            action:
                              target.positionMode === "HEDGE"
                                ? "ONE_WAY"
                                : "HEDGE",
                          });
                          setCredentialConfirmation("");
                        }}
                        onSave={(target) =>
                          void saveTradingAccount(target)
                        }
                        onToggleAvailability={(target) =>
                          void saveTradingAccount(target, !target.isActive)
                        }
                        onDelete={(target) => {
                          setDeleteAccountTarget(target);
                          setDeleteAccountConfirmation("");
                        }}
                      />
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
        <AddTradingAccountDialog
          open={showAddAccount}
          form={tradingAccountForm}
          error={addAccountError}
          busy={tradingAccountBusy === "CREATE"}
          onChange={setTradingAccountForm}
          onClose={() => {
            setShowAddAccount(false);
            setAddAccountError("");
          }}
          onSubmit={() => void createTradingAccount()}
        />
        <AccountDeleteDialog
          target={deleteAccountTarget}
          confirmation={deleteAccountConfirmation}
          busy={
            deleteAccountTarget !== null &&
            tradingAccountBusy === deleteAccountTarget.accountId
          }
          onConfirmationChange={setDeleteAccountConfirmation}
          onClose={() => {
            setDeleteAccountTarget(null);
            setDeleteAccountConfirmation("");
          }}
          onConfirm={() => void deleteTradingAccount()}
        />

        <AccountRiskPanel
          accounts={tradingAccounts}
          canManage={can("sys:account:manage")}
          busyAccountId={tradingAccountBusy}
          onPause={setPauseAccountTarget}
        />
        <CredentialEditorDialog
          open={credentialModalOpen}
          form={credentialForm}
          accounts={tradingAccounts}
          saving={credentialBusy === "SAVE"}
          onChange={setCredentialForm}
          onClose={() => setCredentialModalOpen(false)}
          onSave={() => void saveExchangeCredential()}
        />
        <CredentialActionDialog
          target={credentialAction}
          confirmation={credentialConfirmation}
          busy={
            credentialAction !== null &&
            credentialBusy === String(credentialAction.credential.id)
          }
          onConfirmationChange={setCredentialConfirmation}
          onClose={() => {
            setCredentialAction(null);
            setCredentialConfirmation("");
          }}
          onConfirm={() => void applyCredentialAction()}
        />
        {serverLiveControlAction && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="server-live-control-title"
          >
            <div className="modal">
              <span className="modal-icon">!</span>
              <h2 id="server-live-control-title">
                {serverLiveControlAction === "ENABLE"
                  ? "确认开启服务器实盘？"
                  : "确认关闭服务器实盘？"}
              </h2>
              <p>
                {serverLiveControlAction === "ENABLE"
                  ? "只解除服务器总控；账户密钥仍须校验并单独启用，策略仍需人工启动。"
                  : "关闭后不会提交新的实盘开仓订单；已有仓位保护与平仓链路仍保留。"}
                <br />请输入 <b className="mono">{serverLiveControlAction === "ENABLE" ? "ENABLE SERVER LIVE" : "DISABLE SERVER LIVE"}</b> 确认。
              </p>
              <input
                className="modal-confirm-input"
                value={serverLiveControlConfirmation}
                onChange={(event) => setServerLiveControlConfirmation(event.target.value)}
                autoFocus
              />
              <div>
                <button
                  onClick={() => {
                    setServerLiveControlAction(null);
                    setServerLiveControlConfirmation("");
                  }}
                >
                  取消
                </button>
                <button
                  className={serverLiveControlAction === "ENABLE" ? "danger-btn" : "primary-btn"}
                  disabled={serverLiveControlBusy || serverLiveControlConfirmation !== (serverLiveControlAction === "ENABLE" ? "ENABLE SERVER LIVE" : "DISABLE SERVER LIVE")}
                  onClick={() => void applyServerLiveControl()}
                >
                  {serverLiveControlBusy ? "提交中…" : "确认"}
                </button>
              </div>
            </div>
          </div>
        )}
        <AccountDisableDialog
          target={disableAccountTarget}
          busy={
            disableAccountTarget !== null &&
            tradingAccountBusy === disableAccountTarget.accountId
          }
          onClose={() => setDisableAccountTarget(null)}
          onConfirm={() => {
            if (disableAccountTarget)
              void saveTradingAccount(disableAccountTarget, false, true);
          }}
        />
        <AccountPauseDialog
          target={pauseAccountTarget}
          busy={
            pauseAccountTarget !== null &&
            tradingAccountBusy === pauseAccountTarget.accountId
          }
          onClose={() => setPauseAccountTarget(null)}
          onConfirm={() => void pauseAccountAutomation()}
        />
      </div>
    );

  if (active === "system") {
    const permissionRows = [
      ["运营总览", "trade:dashboard:view", ["ADMIN", "OPERATOR", "VIEWER"]],
      ["创建实盘订单", "trade:manual:create", ["ADMIN", "OPERATOR"]],
      ["撤销等待订单", "trade:order:cancel", ["ADMIN", "OPERATOR"]],
      ["查看合约池", "trade:symbol_pool:view", ["ADMIN", "OPERATOR", "VIEWER"]],
      ["管理合约池", "trade:symbol_pool:edit", ["ADMIN", "OPERATOR"]],
      ["编辑策略", "trade:strategy:edit", ["ADMIN", "OPERATOR"]],
      ["运行自动化检查", "trade:automation:run", ["ADMIN", "OPERATOR"]],
      ["运行对账", "trade:reconcile:run", ["ADMIN", "OPERATOR"]],
      ["单笔实盘平仓", "trade:position:close", ["ADMIN", "OPERATOR"]],
      ["修改仓位止盈止损", "trade:position:risk_edit", ["ADMIN", "OPERATOR"]],
      ["运行仓位风控巡检", "trade:position:risk_run", ["ADMIN", "OPERATOR"]],
      ["校验合约下单权限", "trade:test_order:validate", ["ADMIN", "OPERATOR"]],
      ["紧急全局熔断", "trade:position:close_all", ["ADMIN"]],
      ["重新武装交易", "trade:risk:rearm", ["ADMIN"]],
      ["账户权限校验", "sys:account:validate", ["ADMIN", "OPERATOR"]],
      ["管理实盘资金账户", "sys:account:manage", ["ADMIN"]],
      ["查看自身权限", "sys:access:view", ["ADMIN", "OPERATOR", "VIEWER"]],
      ["管理成员角色", "sys:access:manage", ["ADMIN"]],
      ["查看操作审计", "sys:audit:view", ["ADMIN", "OPERATOR", "VIEWER"]],
    ] as const;
    const actionLabels: Record<string, string> = {
      CREATE_SIMULATED_ORDER: "历史订单创建记录",
      CANCEL_SIMULATED_ORDER: "历史订单撤销记录",
      AUTOMATION_CREATE_SIMULATED_POSITION: "历史策略开仓记录",
      RECONCILE_FILL_SIMULATED_ORDER: "历史挂单成交记录",
      PARTIAL_CLOSE_SIMULATED_POSITION: "历史部分减仓记录",
      CLOSE_SIMULATED_POSITION: "历史平仓记录",
      BATCH_UPDATE_POSITION_RISK: "批量修改止盈止损",
      UPDATE_POSITION_RISK: "修改仓位止盈止损",
      POSITION_RISK_TRIGGERED: "止盈止损自动触发",
      TRIGGER_GLOBAL_CIRCUIT_BREAKER: "触发全局熔断",
      RUN_RECONCILIATION: "订单成交巡检",
      RECONCILE_ORDERS: "订单对账",
      EMERGENCY_CLOSE_ALL: "触发全局熔断",
      REARM_TRADING: "重新武装交易",
      UPDATE_STRATEGY: "更新策略",
      CREATE_SYMBOL: "新增白名单合约",
      RESTORE_SYMBOL: "恢复合约池合约",
      REMOVE_SYMBOL: "移除合约池合约",
      UPDATE_SYMBOL: "更新合约池状态",
      VALIDATE_EXCHANGE_ACCOUNT: "校验合约账户",
      VALIDATE_TEST_ORDER: "验证合约下单权限",
      UPDATE_USER_ACCESS: "调整成员权限",
      CREATE_USER: "新增用户",
      RESET_USER_PASSWORD: "重置用户密码",
      CHANGE_USER_PASSWORD: "修改本人密码",
      AUTOMATION_PREFLIGHT: "自动执行安全检查",
      CREATE_TRADING_ACCOUNT: "新增实盘资金账户",
      UPDATE_TRADING_ACCOUNT: "更新实盘资金账户",
    };
    const auditActions = [
      ...new Set(auditEvents.map((event) => event.action)),
    ].sort();
    const auditOwners = [
      ...new Set(auditEvents.map((event) => event.ownerEmail)),
    ].sort();
    const normalizedAuditQuery = auditQuery.trim().toLowerCase();
    const filteredAuditEvents = auditEvents.filter((event) => {
      if (auditActionFilter !== "ALL" && event.action !== auditActionFilter)
        return false;
      if (auditOwnerFilter !== "ALL" && event.ownerEmail !== auditOwnerFilter)
        return false;
      if (!normalizedAuditQuery) return true;
      return [
        event.ownerEmail,
        actionLabels[event.action] ?? event.action,
        event.resourceType,
        event.resourceId,
        JSON.stringify(event.detail),
      ].some((value) => value.toLowerCase().includes(normalizedAuditQuery));
    });

    function exportFilteredAuditCsv() {
      const csvCell = (value: unknown) => {
        const text = String(value ?? "");
        const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const rows = filteredAuditEvents.map((event) => [
        new Date(event.createdAt).toLocaleString("zh-CN", { hour12: false }),
        event.ownerEmail,
        actionLabels[event.action] ?? event.action,
        event.action,
        event.resourceType,
        event.resourceId,
        JSON.stringify(event.detail),
      ]);
      const csv = [
        ["时间", "操作者", "操作", "事件代码", "资源类型", "资源编号", "详情"],
        ...rows,
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\n");
      const url = URL.createObjectURL(
        new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `nexus-quant-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setToast(`已导出 ${filteredAuditEvents.length} 条审计记录`);
    }
    return (
      <div className="work-page">
        <section className="mini-metrics">
          <article>
            <span>当前角色</span>
            <b>{accessProfile?.role ?? "加载中"}</b>
            <small>{accessProfile?.email ?? "读取身份"}</small>
          </article>
          <article>
            <span>数据范围</span>
            <b>
              {accessProfile?.dataScope === "ALL" ? "全部数据" : "本人数据"}
            </b>
            <small>服务端强制过滤</small>
          </article>
          <article>
            <span>已授予权限</span>
            <b>{accessProfile?.permissions.length ?? 0}</b>
            <small>按钮与接口双重拦截</small>
          </article>
          <article>
            <span>已加载审计事件</span>
            <b>{auditEvents.length}</b>
            <small>
              {auditHasMore ? "还有更早记录可加载" : "已到当前历史末尾"}
            </small>
          </article>
        </section>
        <section className="panel security-panel">
          <div>
            <h2>我的安全</h2>
            <p>修改当前账号的应用密码，更新后其他会话将自动失效</p>
          </div>
          <div className="security-password-stack">
            <div className="security-password-inputs">
              <input
                type={showSecurityPasswords ? "text" : "password"}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder="当前密码"
                autoComplete="current-password"
              />
              <input
                type={showSecurityPasswords ? "text" : "password"}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="新密码（至少 12 位）"
                autoComplete="new-password"
              />
              <input
                type={showSecurityPasswords ? "text" : "password"}
                value={confirmChangedPassword}
                onChange={(event) =>
                  setConfirmChangedPassword(event.target.value)
                }
                placeholder="再次输入新密码"
                autoComplete="new-password"
              />
              <button
                type="button"
                aria-pressed={showSecurityPasswords}
                onClick={() => setShowSecurityPasswords((current) => !current)}
              >
                {showSecurityPasswords ? "隐藏" : "显示"}
              </button>
            </div>
            <small
              className={
                confirmChangedPassword.length > 0 &&
                confirmChangedPassword !== newPassword
                  ? "mismatch"
                  : confirmChangedPassword && newPassword.length >= 12
                    ? "met"
                    : ""
              }
            >
              {!newPassword
                ? "新密码至少 12 位"
                : newPassword.length < 12
                  ? `还差 ${12 - newPassword.length} 个字符`
                  : !confirmChangedPassword
                    ? "请再次输入新密码"
                    : confirmChangedPassword === newPassword
                      ? "✓ 两次输入一致"
                      : "两次输入不一致"}
            </small>
          </div>
          <button
            className="primary-btn"
            disabled={
              authBusy ||
              !currentPassword ||
              newPassword.length < 12 ||
              confirmChangedPassword !== newPassword
            }
            onClick={() => void changePassword()}
          >
            {authBusy ? "修改中…" : "修改密码"}
          </button>
          <button className="danger-btn" onClick={() => void logout()}>
            退出应用会话
          </button>
        </section>
        {can("sys:access:manage") && (
          <section className="panel control-panel">
            <div className="panel-head">
              <div>
                <h2>成员账号与密码</h2>
                <p>新增用户后会要求使用临时密码登录，并在首次进入时强制修改</p>
              </div>
              <span className="guard">管理员专属</span>
            </div>
            <div className="credential-form member-create-form">
              <input
                value={accountForm.email}
                onChange={(event) =>
                  setAccountForm({ ...accountForm, email: event.target.value })
                }
                placeholder="成员邮箱"
              />
              <input
                value={accountForm.displayName}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    displayName: event.target.value,
                  })
                }
                placeholder="姓名（可选）"
              />
              <select
                value={accountForm.role}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    role: event.target.value as AccessMember["role"],
                  })
                }
              >
                <option value="ADMIN">管理员</option>
                <option value="OPERATOR">操盘手</option>
                <option value="VIEWER">只读审计员</option>
              </select>
              <select
                value={accountForm.dataScope}
                disabled={accountForm.role === "ADMIN"}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    dataScope: event.target.value as AccessMember["dataScope"],
                  })
                }
              >
                <option value="ALL">全部数据</option>
                <option value="OWN">本人数据</option>
              </select>
              <div className="member-password-stack">
                <div className="member-password-fields">
                  <input
                    type={showAccountPasswords ? "text" : "password"}
                    value={accountForm.temporaryPassword}
                    onChange={(event) =>
                      setAccountForm({
                        ...accountForm,
                        temporaryPassword: event.target.value,
                      })
                    }
                    placeholder="临时密码（至少 12 位）"
                    autoComplete="new-password"
                  />
                  <input
                    type={showAccountPasswords ? "text" : "password"}
                    value={accountForm.confirmTemporaryPassword}
                    onChange={(event) =>
                      setAccountForm({
                        ...accountForm,
                        confirmTemporaryPassword: event.target.value,
                      })
                    }
                    placeholder="再次输入临时密码"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    aria-pressed={showAccountPasswords}
                    onClick={() =>
                      setShowAccountPasswords((current) => !current)
                    }
                  >
                    {showAccountPasswords ? "隐藏" : "显示"}
                  </button>
                </div>
                <small
                  className={
                    accountForm.confirmTemporaryPassword.length > 0 &&
                    accountForm.confirmTemporaryPassword !==
                      accountForm.temporaryPassword
                      ? "mismatch"
                      : accountForm.confirmTemporaryPassword &&
                          accountForm.temporaryPassword.length >= 12
                        ? "met"
                        : ""
                  }
                >
                  {!accountForm.temporaryPassword
                    ? "临时密码至少 12 位"
                    : accountForm.temporaryPassword.length < 12
                      ? `还差 ${12 - accountForm.temporaryPassword.length} 个字符`
                      : !accountForm.confirmTemporaryPassword
                        ? "请再次输入临时密码"
                        : accountForm.confirmTemporaryPassword ===
                            accountForm.temporaryPassword
                          ? "✓ 两次输入一致"
                          : "两次输入不一致"}
                </small>
              </div>
              <button
                className="primary-btn"
                disabled={
                  !accountForm.email ||
                  accountForm.temporaryPassword.length < 12 ||
                  accountForm.confirmTemporaryPassword !==
                    accountForm.temporaryPassword ||
                  Boolean(savingAccess)
                }
                onClick={() => void createUser()}
              >
                新增用户
              </button>
            </div>
            {resetTarget && (
              <div className="reset-strip">
                <b>重置 {resetTarget}</b>
                <div className="member-password-stack">
                  <div className="member-password-fields">
                    <input
                      type={showResetPasswords ? "text" : "password"}
                      value={resetPassword}
                      onChange={(event) => setResetPassword(event.target.value)}
                      placeholder="新临时密码（至少 12 位）"
                      autoComplete="new-password"
                    />
                    <input
                      type={showResetPasswords ? "text" : "password"}
                      value={confirmResetPassword}
                      onChange={(event) =>
                        setConfirmResetPassword(event.target.value)
                      }
                      placeholder="再次输入新临时密码"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      aria-pressed={showResetPasswords}
                      onClick={() =>
                        setShowResetPasswords((current) => !current)
                      }
                    >
                      {showResetPasswords ? "隐藏" : "显示"}
                    </button>
                  </div>
                  <small
                    className={
                      confirmResetPassword.length > 0 &&
                      confirmResetPassword !== resetPassword
                        ? "mismatch"
                        : confirmResetPassword && resetPassword.length >= 12
                          ? "met"
                          : ""
                    }
                  >
                    {!resetPassword
                      ? "新临时密码至少 12 位"
                      : resetPassword.length < 12
                        ? `还差 ${12 - resetPassword.length} 个字符`
                        : !confirmResetPassword
                          ? "请再次输入新临时密码"
                          : confirmResetPassword === resetPassword
                            ? "✓ 两次输入一致"
                            : "两次输入不一致"}
                  </small>
                </div>
                <button
                  className="primary-btn"
                  disabled={
                    resetPassword.length < 12 ||
                    confirmResetPassword !== resetPassword ||
                    Boolean(savingAccess)
                  }
                  onClick={() => void resetUserPassword()}
                >
                  确认重置
                </button>
                <button
                  onClick={() => {
                    setResetTarget("");
                    setResetPassword("");
                    setConfirmResetPassword("");
                    setShowResetPasswords(false);
                  }}
                >
                  取消
                </button>
              </div>
            )}
            <div className="data-table member-table">
              <table>
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>角色</th>
                    <th>数据范围</th>
                    <th>密码状态</th>
                    <th>最近登录</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accessMembers.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <b>{member.displayName || member.email}</b>
                        <small>
                          {member.email}
                          {member.email === accessProfile?.email
                            ? " · 当前用户"
                            : ""}
                        </small>
                      </td>
                      <td>
                        <select
                          value={member.role}
                          disabled={
                            savingAccess === member.email || !member.isActive
                          }
                          onChange={(event) =>
                            void updateMember(member, {
                              role: event.target.value as AccessMember["role"],
                            })
                          }
                        >
                          <option value="ADMIN">管理员</option>
                          <option value="OPERATOR">操盘手</option>
                          <option value="VIEWER">只读审计员</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={member.dataScope}
                          disabled={
                            member.role === "ADMIN" ||
                            savingAccess === member.email ||
                            !member.isActive
                          }
                          onChange={(event) =>
                            void updateMember(member, {
                              dataScope: event.target
                                .value as AccessMember["dataScope"],
                            })
                          }
                        >
                          <option value="ALL">全部数据</option>
                          <option value="OWN">本人数据</option>
                        </select>
                      </td>
                      <td>
                        <span
                          className={`source-tag ${!member.isActive || member.mustChangePassword ? "danger-source" : "auto"}`}
                        >
                          {!member.isActive
                            ? "已停用"
                            : !member.hasPassword
                              ? "未设置"
                              : member.mustChangePassword
                                ? "待首次修改"
                                : "安全"}
                        </span>
                      </td>
                      <td>
                        {member.lastLoginAt
                          ? new Date(member.lastLoginAt).toLocaleString(
                              "zh-CN",
                              { hour12: false },
                            )
                          : "从未登录"}
                      </td>
                      <td>
                        <div className="member-actions">
                          {member.email !== accessProfile?.email && (
                            <button
                              className="text-action"
                              onClick={() =>
                                void updateMember(member, {
                                  isActive: !member.isActive,
                                })
                              }
                            >
                              {member.isActive ? "停用" : "启用"}
                            </button>
                          )}
                          {member.email !== accessProfile?.email && (
                            <button
                              className="text-action"
                              onClick={() => {
                                setResetTarget(member.email);
                                setResetPassword("");
                                setConfirmResetPassword("");
                                setShowResetPasswords(false);
                              }}
                            >
                              重置密码
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {accessMembers.length === 0 && (
                <div className="empty">当前仅有初始化管理员</div>
              )}
            </div>
          </section>
        )}
        <section className="panel control-panel">
          <div className="panel-head">
            <div>
              <h2>操作审计中心</h2>
              <p>记录关键交易、风控、账户验证与权限变更</p>
            </div>
            <div className="panel-actions">
              <button
                className="refresh-btn"
                disabled={auditBusy}
                onClick={() => void loadAuditEvents()}
              >
                {auditBusy ? "加载中…" : "刷新日志"}
              </button>
              <button
                onClick={exportFilteredAuditCsv}
                disabled={filteredAuditEvents.length === 0}
              >
                导出当前结果 CSV
              </button>
            </div>
          </div>
          <div className="filterbar audit-filterbar">
            <label>
              <span>搜索</span>
              <input
                value={auditQuery}
                onChange={(event) => setAuditQuery(event.target.value)}
                placeholder="操作、资源编号或详情"
              />
            </label>
            <select
              aria-label="审计事件类型"
              value={auditActionFilter}
              onChange={(event) => setAuditActionFilter(event.target.value)}
            >
              <option value="ALL">全部事件</option>
              {auditActions.map((action) => (
                <option key={action} value={action}>
                  {actionLabels[action] ?? action}
                </option>
              ))}
            </select>
            <select
              aria-label="审计操作者"
              value={auditOwnerFilter}
              onChange={(event) => setAuditOwnerFilter(event.target.value)}
            >
              <option value="ALL">全部操作者</option>
              {auditOwners.map((owner) => (
                <option key={owner} value={owner}>
                  {owner}
                </option>
              ))}
            </select>
            <button
              disabled={
                !auditQuery &&
                auditActionFilter === "ALL" &&
                auditOwnerFilter === "ALL"
              }
              onClick={() => {
                setAuditQuery("");
                setAuditActionFilter("ALL");
                setAuditOwnerFilter("ALL");
              }}
            >
              重置筛选
            </button>
            <span>
              显示 {filteredAuditEvents.length} / 已加载 {auditEvents.length} 条
            </span>
          </div>
          <div className="data-table audit-table">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>操作</th>
                  <th>资源</th>
                  <th>资源编号</th>
                  <th>详情摘要</th>
                  <th>查看</th>
                </tr>
              </thead>
              <tbody>
                {filteredAuditEvents.map((event) => (
                  <tr key={event.id}>
                    <td>
                      {new Date(event.createdAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </td>
                    <td>{event.ownerEmail}</td>
                    <td>
                      <span className="source-tag protect">
                        {actionLabels[event.action] ?? event.action}
                      </span>
                    </td>
                    <td>{event.resourceType}</td>
                    <td className="mono">{event.resourceId}</td>
                    <td
                      className="audit-detail"
                      title={JSON.stringify(event.detail)}
                    >
                      {JSON.stringify(event.detail)}
                    </td>
                    <td>
                      <button
                        className="text-action"
                        aria-label={`查看审计记录 ${event.id} 详情`}
                        onClick={() => setAuditDetailTarget(event)}
                      >
                        完整详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {auditEvents.length === 0 && !auditBusy && (
              <div className="empty">暂无关键操作记录</div>
            )}
            {auditEvents.length > 0 && filteredAuditEvents.length === 0 && (
              <div className="empty">当前筛选范围暂无审计记录</div>
            )}
          </div>
          {auditHasMore && (
            <div className="audit-load-more">
              <button
                disabled={auditBusy}
                onClick={() => void loadAuditEvents(true)}
              >
                {auditBusy ? "正在加载…" : "加载更早的 100 条记录"}
              </button>
              <small>筛选与导出会自动覆盖已加载的全部记录</small>
            </div>
          )}
        </section>
        {auditDetailTarget && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-detail-title"
          >
            <div className="modal strategy-config-modal audit-detail-modal">
              <div className="config-title">
                <div>
                  <h2 id="audit-detail-title">
                    审计记录 #{auditDetailTarget.id}
                  </h2>
                  <p>
                    {actionLabels[auditDetailTarget.action] ??
                      auditDetailTarget.action}{" "}
                    · 完整只读记录
                  </p>
                </div>
                <button
                  aria-label="关闭审计详情"
                  onClick={() => setAuditDetailTarget(null)}
                >
                  ×
                </button>
              </div>
              <div className="audit-detail-grid">
                <article>
                  <span>发生时间</span>
                  <b>
                    {new Date(auditDetailTarget.createdAt).toLocaleString(
                      "zh-CN",
                      { hour12: false },
                    )}
                  </b>
                </article>
                <article>
                  <span>操作者</span>
                  <b>{auditDetailTarget.ownerEmail}</b>
                </article>
                <article>
                  <span>事件代码</span>
                  <b className="mono">{auditDetailTarget.action}</b>
                </article>
                <article>
                  <span>资源定位</span>
                  <b>
                    {auditDetailTarget.resourceType} ·{" "}
                    <span className="mono">{auditDetailTarget.resourceId}</span>
                  </b>
                </article>
              </div>
              <section className="audit-json-panel">
                <div>
                  <b>完整参数</b>
                  <small>
                    仅展示服务端已持久化的审计详情，不会执行其中任何内容
                  </small>
                </div>
                <pre>{JSON.stringify(auditDetailTarget.detail, null, 2)}</pre>
              </section>
              <div className="config-actions">
                <button onClick={() => setAuditDetailTarget(null)}>关闭</button>
                <button
                  className="primary-btn"
                  onClick={() => void copyAuditDetail()}
                >
                  复制详情
                </button>
              </div>
            </div>
          </div>
        )}
        <section className="panel control-panel">
          <div className="panel-head">
            <div>
              <h2>角色权限矩阵</h2>
              <p>界面显隐不能替代服务端鉴权；所有写接口均再次校验权限标识</p>
            </div>
            <span className="guard">RBAC 生效</span>
          </div>
          <div className="data-table permission-table">
            <table>
              <thead>
                <tr>
                  <th>业务能力</th>
                  <th>权限标识</th>
                  <th>管理员</th>
                  <th>操盘手</th>
                  <th>只读审计员</th>
                  <th>当前用户</th>
                </tr>
              </thead>
              <tbody>
                {permissionRows.map(([label, tag, roles]) => (
                  <tr key={tag}>
                    <td>
                      <b>{label}</b>
                    </td>
                    <td className="mono">{tag}</td>
                    {["ADMIN", "OPERATOR", "VIEWER"].map((role) => {
                      const allowed = (roles as readonly string[]).includes(
                        role,
                      );
                      return (
                        <td key={role}>
                          <span className={allowed ? "perm-yes" : "perm-no"}>
                            {allowed ? "✓" : "—"}
                          </span>
                        </td>
                      );
                    })}
                    <td>
                      <span
                        className={
                          accessProfile?.permissions.includes(tag)
                            ? "source-tag auto"
                            : "source-tag danger-source"
                        }
                      >
                        {accessProfile?.permissions.includes(tag)
                          ? "已授权"
                          : "已拦截"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  }

  return null;
}

export default function Home() {
  const [active, setActive] = useState("overview");
  const [workspaceRefreshVersion, setWorkspaceRefreshVersion] = useState(0);
  const [openTabs, setOpenTabs] = useState<string[]>(["overview"]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const [dark, setDark] = useState(true);
  const [uiScale, setUiScale] = useState<"SMALL" | "STANDARD" | "LARGE">(
    "STANDARD",
  );
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const [marketFocus, setMarketFocus] = useState<{
    symbol: string;
    requestId: number;
  } | null>(null);
  const [connected, setConnected] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const [toast, setToast] = useState("");
  const [lastClosedTab, setLastClosedTab] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState("等待同步");
  const [lastOverviewSyncAt, setLastOverviewSyncAt] = useState<number | null>(
    null,
  );
  const [syncClock, setSyncClock] = useState(() => Date.now());
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [overviewAccountFilter, setOverviewAccountFilter] = useState("ALL");
  const [marketRefreshVersion, setMarketRefreshVersion] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsLoaded, setNotificationsLoaded] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notificationReadThrough, setNotificationReadThrough] = useState(0);
  const [notificationReadBusy, setNotificationReadBusy] = useState(false);
  const [notificationDetail, setNotificationDetail] =
    useState<NotificationItem | null>(null);
  const [notificationFilter, setNotificationFilter] = useState<
    "ALL" | "UNREAD" | "CRITICAL" | "WARNING" | "INFO"
  >("ALL");
  const [strategyFocusId, setStrategyFocusId] = useState<number | null>(null);
  const [strategyFocusMode, setStrategyFocusMode] = useState<
    "EDIT" | "LEARNING"
  >("EDIT");
  const [currentUser, setCurrentUser] = useState<{
    email: string;
    displayName?: string | null;
    role: "ADMIN" | "OPERATOR" | "VIEWER";
    dataScope: "ALL" | "OWN";
    permissions: string[];
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const historyReadyRef = useRef(false);
  const popNavigationRef = useRef(false);
  const overviewRequestRef = useRef(0);
  const overviewRequestActiveRef = useRef(false);
  const notificationRequestRef = useRef(0);
  const notificationPopupSeenRef = useRef(new Set<number>());

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const syncViewport = () => setMobileViewport(media.matches);
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    try {
      const savedTheme = window.localStorage.getItem("nexus-quant-theme");
      const savedScale = window.localStorage.getItem("nexus-quant-ui-scale");
      const savedCollapsed = window.localStorage.getItem(
        "nexus-quant-sidebar-collapsed",
      );
      const savedActivePage = window.localStorage.getItem(
        "nexus-quant-active-page",
      );
      const savedOpenTabs = window.localStorage.getItem(
        "nexus-quant-open-tabs",
      );
      const validPages = new Set(allPageIds());
      const requestedViewValue = new URL(window.location.href).searchParams.get(
        "view",
      );
      const requestedView =
        requestedViewValue === "strategies" ? "auto" : requestedViewValue;
      const normalizedSavedActivePage =
        savedActivePage === "strategies" ? "auto" : savedActivePage;
      if (savedTheme === "light" || savedTheme === "dark")
        setDark(savedTheme === "dark");
      if (
        savedScale === "SMALL" ||
        savedScale === "STANDARD" ||
        savedScale === "LARGE"
      )
        setUiScale(savedScale);
      if (
        !window.matchMedia("(max-width: 760px)").matches &&
        (savedCollapsed === "true" || savedCollapsed === "false")
      )
        setCollapsed(savedCollapsed === "true");
      if (requestedView && validPages.has(requestedView))
        setActive(requestedView);
      else if (
        normalizedSavedActivePage &&
        validPages.has(normalizedSavedActivePage)
      )
        setActive(normalizedSavedActivePage);
      if (savedOpenTabs) {
        const parsedTabs = JSON.parse(savedOpenTabs);
        if (Array.isArray(parsedTabs)) {
          const restoredTabs = [
            ...new Set(
              parsedTabs
                .map((id) => (id === "strategies" ? "auto" : id))
                .filter(
                  (id): id is string =>
                    typeof id === "string" && validPages.has(id),
                ),
            ),
          ].slice(-6);
          if (restoredTabs.length) setOpenTabs(restoredTabs);
        }
      }
    } catch {
      /* 隐私模式禁用本地存储时继续使用默认显示设置 */
    } finally {
      setPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    try {
      window.localStorage.setItem("nexus-quant-theme", dark ? "dark" : "light");
      window.localStorage.setItem("nexus-quant-ui-scale", uiScale);
      if (!window.matchMedia("(max-width: 760px)").matches)
        window.localStorage.setItem(
          "nexus-quant-sidebar-collapsed",
          String(collapsed),
        );
      window.localStorage.setItem("nexus-quant-active-page", active);
      window.localStorage.setItem(
        "nexus-quant-open-tabs",
        JSON.stringify(openTabs),
      );
    } catch {
      /* 本地存储不可用不影响核心交易控制功能 */
    }
  }, [preferencesLoaded, dark, uiScale, collapsed, active, openTabs]);

  useEffect(() => {
    const syncFullscreen = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      setBrowserOnline(false);
      setConnected(false);
      setToast("网络连接已断开，实时行情和提交操作已暂停");
    };
    const handleOnline = () => {
      setBrowserOnline(true);
      setToast("网络连接已恢复，正在重新同步最新数据");
      void loadOverview(true);
    };
    setBrowserOnline(window.navigator.onLine);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  useEffect(() => {
    const updateSyncClock = () => setSyncClock(Date.now());
    const timer = window.setInterval(updateSyncClock, 10_000);
    const resumeClock = () => {
      if (document.visibilityState === "visible") updateSyncClock();
    };
    document.addEventListener("visibilitychange", resumeClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resumeClock);
    };
  }, []);

  useEffect(() => {
    const handleCrossTabLogout = (event: StorageEvent) => {
      if (event.key !== "nexus-quant-logout-at" || !event.newValue) return;
      clearStoredWorkspace();
      window.location.reload();
    };
    window.addEventListener("storage", handleCrossTabLogout);
    return () => window.removeEventListener("storage", handleCrossTabLogout);
  }, []);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const validPages = new Set(allPageIds());
      const stateView =
        typeof event.state?.nexusView === "string"
          ? event.state.nexusView
          : null;
      const requestedViewValue =
        stateView ?? new URL(window.location.href).searchParams.get("view");
      const requestedView =
        requestedViewValue === "strategies" ? "auto" : requestedViewValue;
      const nextPage =
        requestedView && validPages.has(requestedView)
          ? requestedView
          : "overview";
      popNavigationRef.current = true;
      setActive((current) => {
        if (current === nextPage) popNavigationRef.current = false;
        return nextPage;
      });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    if (popNavigationRef.current) {
      popNavigationRef.current = false;
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("view", active);
    const state = { ...(window.history.state ?? {}), nexusView: active };
    if (historyReadyRef.current) window.history.pushState(state, "", url);
    else {
      window.history.replaceState(state, "", url);
      historyReadyRef.current = true;
    }
  }, [preferencesLoaded, active]);

  useEffect(() => {
    setOpenTabs((current) =>
      current.includes(active) ? current : [...current, active].slice(-6),
    );
  }, [active]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      window.scrollTo({ top: 0, left: 0, behavior: "auto" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!currentUser) return;
    const allowed = (pageId: string) =>
      !pagePermissions[pageId] ||
      currentUser.permissions.includes(pagePermissions[pageId]);
    setOpenTabs((current) => current.filter(allowed));
    if (!allowed(active)) {
      setActive("overview");
      setToast("当前角色无权访问该页面，已返回运营总览");
    }
  }, [currentUser, active]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => {
        setToast("");
        setLastClosedTab(null);
      },
      isUrgentToast(toast) ? 6000 : 3600,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (window.matchMedia("(max-width: 1100px)").matches)
          setMobileSearchOpen(true);
        else searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setShowHelp(false);
        setShowDisplayMenu(false);
        setShowNotifications(false);
        setNotificationDetail(null);
        setShowUserMenu(false);
        setSearchOpen(false);
        setMobileSearchOpen(false);
        if (window.matchMedia("(max-width: 760px)").matches)
          setCollapsed(false);
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!mobileSearchOpen) return;
    const frame = window.requestAnimationFrame(() =>
      mobileSearchRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [mobileSearchOpen]);

  const activeLabel =
    menuGroups.flatMap((g) => g.items).find((i) => i[0] === active)?.[2] ??
    hiddenPageLabels[active] ??
    "运营总览";

  useEffect(() => {
    document.title = `${activeLabel} · NexusQuant 实盘交易`;
  }, [activeLabel]);

  const canOpenPage = (pageId: string) =>
    !currentUser ||
    !pagePermissions[pageId] ||
    currentUser.permissions.includes(pagePermissions[pageId]);
  const visibleMenuGroups = menuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(([id]) => canOpenPage(id)),
    }))
    .filter((group) => group.items.length > 0);
  const activeGroupLabel =
    visibleMenuGroups.find((group) =>
      group.items.some(([id]) => id === active),
    )?.label ?? "交易运营";
  const normalizedSearch = query.trim().toLowerCase();
  const searchResults: GlobalSearchResult[] = normalizedSearch
    ? [
        ...visibleMenuGroups
          .flatMap((group) => group.items)
          .filter(
            ([id, , label]) =>
              id.toLowerCase().includes(normalizedSearch) ||
              label.toLowerCase().includes(normalizedSearch),
          )
          .map(([id, , label]) => ({
            type: "PAGE" as const,
            id,
            label,
            description: "功能页面",
          })),
        ...(canOpenPage("manual")
          ? markets
              .filter(
                (market) =>
                  market.symbol.toLowerCase().includes(normalizedSearch) ||
                  market.name.toLowerCase().includes(normalizedSearch),
              )
              .map((market) => ({
                type: "MARKET" as const,
                id: market.symbol,
                label: market.symbol,
                description: `${market.name} · 白名单合约`,
              }))
          : []),
      ].slice(0, 8)
    : [];
  const tabLabels = Object.fromEntries(
    [
      ...menuGroups.flatMap((group) =>
        group.items.map(([id, , label]) => [id, label] as const),
      ),
      ...Object.entries(hiddenPageLabels),
    ],
  ) as Record<string, string>;
  const activeHelp =
    (
      {
        overview: "查看账户盈亏、保证金、API 权重、风险状态与运行策略总览。",
        market:
          "通过独立行情卡片查询和切换多个已启用合约的最近48小时价格、持仓价值与成交额。",
        manual:
          "使用合约池和已启用实盘的交易子账户提交 Binance 正式订单，提交前会经过完整风险检查。",
        pool: "维护允许参与实盘下单和自动策略扫描的合约池。",
        auto: "配置策略参数与扫描合约；先保存草稿再发布，新旧仓位严格隔离版本。",
        strategyLogs: "独立查看策略触发、趋势判断、下单和持仓验证日志。",
        position: "查看实盘仓位，修改分批止盈止损和移动止损参数。",
        orders: "查看发送至 Binance 正式环境的订单及交易所返回状态。",
        profit: "按账户查看实盘已实现盈亏和分批减仓明细。",
        dailyOperations: "按时间、下单类型、具体策略和版本对比每日下单、平仓、盈亏及当前持仓表现。",
        quoteShadow: "对比现有真实委托与动态影子报价，查看开仓、补仓和退出的价格执行差异。",
        accounts: "管理主账户、交易子账户、实盘密钥、余额与交易开关。",
        system: "管理用户密码、角色权限、数据范围和完整操作审计。",
      } as Record<string, string>
    )[active] ?? "查看并管理当前实盘交易功能。";
  const currentUserName =
    currentUser?.displayName?.trim() ||
    currentUser?.email.split("@")[0] ||
    "当前用户";
  const currentUserInitial =
    Array.from(currentUserName)[0]?.toUpperCase() ?? "用";
  const currentUserRoleLabel = currentUser
    ? (
        {
          ADMIN: "系统管理员",
          OPERATOR: "操盘手",
          VIEWER: "只读审计员",
        } as const
      )[currentUser.role]
    : "身份读取中";
  const overviewMetrics = overview?.metrics ?? {
    hourOrders: 0,
    hourOrderNotional: 0,
    hourFilledOrders: 0,
    hourFilledNotional: 0,
    todayOrders: 0,
    todayOrderNotional: 0,
    todayNewPositions: 0,
    todayClosedPositions: 0,
    todayStrategyOrders: 0,
    todayManualOrders: 0,
    todayAutomaticReductions: 0,
    todayAutomaticReductionPnl: 0,
    todayProfitableRecords: 0,
    todayLosingRecords: 0,
    todayBreakevenRecords: 0,
    todayRealizedPnl: 0,
    monthRealizedPnl: 0,
    accountBalance: 0,
    accountAvailableBalance: 0,
    accountBalanceComplete: false,
    accountBalanceAvailable: false,
    eligibleAccountCount: 0,
    freshAccountCount: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    unrealizedPnlAvailable: false,
    positionEstimatedUnrealizedPnl: 0,
    unrealizedPnlDifference: null,
    positionPricesComplete: false,
    notionalValue: 0,
    marginUsed: 0,
    marginIsEstimate: true,
    openPositions: 0,
    closedPositions: 0,
    partialReductions: 0,
    realizedRecords: 0,
    profitableRecords: 0,
    losingRecords: 0,
    breakevenRecords: 0,
    closedTradeWins: 0,
    closedTradeLosses: 0,
    closedTradeBreakeven: 0,
    totalOrders: 0,
    pendingOrders: 0,
    filledOrders: 0,
    rejectedOrders: 0,
    executionUnknownOrders: 0,
    runningStrategies: 0,
    totalStrategies: 0,
    activeSymbols: 0,
    todayFilledOrders: 0,
    todayFilledNotional: 0,
  };
  const profitFunnel = overview?.profitFunnel ?? {
    grossRealizedPnl: 0,
    knownTradingCosts: 0,
    knownFundingPnl: 0,
    accountedRealizedPnl: 0,
    exactCohortGrossRealizedPnl: 0,
    exactCohortTradingCosts: 0,
    exactCohortFundingPnl: 0,
    exactNetRealizedPnl: 0,
    pendingEstimatedRealizedPnl: 0,
    unrealizedPnl: null,
    portfolioPnl: null,
    accountEquity: null,
    realizedRecords: 0,
    exactNetRecords: 0,
    pendingNetRecords: 0,
    exactNetCoveragePercent: 100,
    resultBasis: "UNAVAILABLE" as const,
    realizedProfitOffsetPercent: null,
    status: "UNAVAILABLE" as const,
  };
  const profitFunnelStatusText =
    profitFunnel.status === "PROFIT_FULLY_OFFSET"
      ? "当前浮亏已覆盖全部已实现收益"
      : profitFunnel.status === "PROFIT_PARTLY_OFFSET"
        ? `当前浮亏抵消已实现收益 ${Math.min(profitFunnel.realizedProfitOffsetPercent ?? 0, 999).toFixed(1)}%`
        : profitFunnel.status === "NET_LOSS"
          ? "已实现与未实现合并后为净亏损"
          : profitFunnel.status === "PROFIT_RETAINED"
            ? "已实现与未实现合并后仍保留净收益"
            : profitFunnel.status === "BREAKEVEN"
              ? "当前组合结果接近持平"
              : "账户资金快照待同步，暂不推导组合结果";
  const overviewAgeSeconds =
    lastOverviewSyncAt === null
      ? null
      : Math.max(0, Math.floor((syncClock - lastOverviewSyncAt) / 1000));
  const overviewSyncPending = lastOverviewSyncAt === null;
  const overviewStale = overviewAgeSeconds !== null && overviewAgeSeconds >= 90;
  const weightPercent = overview?.rateLimit
    ? Math.min(
        100,
        (overview.rateLimit.usedWeight /
          Math.max(overview.rateLimit.limitWeight, 1)) *
          100,
      )
    : 0;
  const unreadNotifications = notifications.filter(
    (item) => new Date(item.createdAt).getTime() > notificationReadThrough,
  ).length;
  const notificationCounts = {
    ALL: notifications.length,
    UNREAD: unreadNotifications,
    CRITICAL: notifications.filter((item) => item.severity === "CRITICAL")
      .length,
    WARNING: notifications.filter((item) => item.severity === "WARNING").length,
    INFO: notifications.filter((item) => item.severity === "INFO").length,
  };
  const visibleNotifications = notifications.filter((item) => {
    if (notificationFilter === "UNREAD")
      return new Date(item.createdAt).getTime() > notificationReadThrough;
    if (notificationFilter === "ALL") return true;
    return item.severity === notificationFilter;
  });
  const notificationFilters = [
    ["ALL", "全部"],
    ["UNREAD", "未读"],
    ["CRITICAL", "紧急"],
    ["WARNING", "警告"],
    ["INFO", "提示"],
  ] as const;
  const eventLabels: Record<string, string> = {
    CREATE_SIMULATED_ORDER: "历史订单创建记录",
    CANCEL_SIMULATED_ORDER: "历史订单撤销记录",
    AUTOMATION_CREATE_SIMULATED_POSITION: "策略自动开仓",
    RECONCILE_FILL_SIMULATED_ORDER: "历史挂单成交记录",
    PARTIAL_CLOSE_SIMULATED_POSITION: "历史部分减仓记录",
    CLOSE_SIMULATED_POSITION: "历史平仓记录",
    BATCH_UPDATE_POSITION_RISK: "批量修改止盈止损",
    UPDATE_POSITION_RISK: "修改止盈止损",
    POSITION_RISK_TRIGGERED: "止盈止损触发",
    TRIGGER_GLOBAL_CIRCUIT_BREAKER: "全局熔断触发",
    RECONCILE_ORDERS: "订单对账完成",
    EMERGENCY_CLOSE_ALL: "紧急全部平仓",
    REARM_TRADING: "重新武装交易",
    UPDATE_STRATEGY: "策略配置更新",
    CREATE_SYMBOL: "新增白名单合约",
    RESTORE_SYMBOL: "恢复合约池合约",
    REMOVE_SYMBOL: "移除合约池合约",
    UPDATE_SYMBOL: "合约池状态更新",
  };

  async function loadOverview(
    showSuccess = false,
    background = false,
    accountId = overviewAccountFilter,
  ) {
    if (background && overviewRequestActiveRef.current) return;
    const requestId = ++overviewRequestRef.current;
    overviewRequestActiveRef.current = true;
    const abortController = new AbortController();
    const timeoutId = window.setTimeout(() => abortController.abort(), 25_000);
    if (!background) setOverviewBusy(true);
    try {
      const response = await fetchWithTransientRetry(
        accountId === "ALL"
          ? "/api/control/overview"
          : `/api/control/overview?accountId=${encodeURIComponent(accountId)}`,
        {
          cache: "no-store",
          signal: abortController.signal,
        },
      );
      const result = (await readJsonResponse(response)) as OverviewData & {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "总览同步失败");
      if (requestId !== overviewRequestRef.current) return;
      setOverview(result);
      setMarkets(result.markets ?? []);
      const syncedAt = Date.now();
      setLastOverviewSyncAt(syncedAt);
      setSyncClock(syncedAt);
      setRefreshedAt(
        new Date(syncedAt).toLocaleTimeString("zh-CN", { hour12: false }),
      );
      setConnected(result.marketStatus?.reachable ?? false);
      if (showSuccess)
        setToast(
          result.marketStatus?.reachable
            ? "总览与实盘合约池行情已同步"
            : (result.marketStatus?.error ??
                "持久化数据已同步，Binance 实盘合约行情暂不可用"),
        );
    } catch (error) {
      if (requestId === overviewRequestRef.current) {
        if (!background)
          setToast(
            error instanceof DOMException && error.name === "AbortError"
              ? "总览同步超时，已保留当前数据；系统将在下一轮自动重试"
              : error instanceof TypeError
              ? "服务正在恢复，已保留当前数据并自动重试；行情连接状态以最后一次成功同步为准"
              : error instanceof Error
                ? error.message
                : "总览同步失败，已保留当前数据",
          );
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === overviewRequestRef.current) {
        overviewRequestActiveRef.current = false;
        if (!background) setOverviewBusy(false);
      }
    }
  }

  async function loadCurrentUser() {
    try {
      const response = await fetch("/api/control/access", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        email?: string;
        displayName?: string | null;
        role?: "ADMIN" | "OPERATOR" | "VIEWER";
        dataScope?: "ALL" | "OWN";
        permissions?: string[];
      };
      if (!response.ok || !result.email || !result.role || !result.dataScope)
        throw new Error(result.error ?? "用户身份读取失败");
      setCurrentUser({
        email: result.email,
        displayName: result.displayName,
        role: result.role,
        dataScope: result.dataScope,
        permissions: result.permissions ?? [],
      });
    } catch {
      setCurrentUser(null);
    }
  }

  async function logoutCurrentUser() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredWorkspace();
    broadcastApplicationLogout();
    setActive("overview");
    setOpenTabs(["overview"]);
    setQuery("");
    setSearchOpen(false);
    setMobileSearchOpen(false);
    window.location.reload();
  }

  async function loadNotifications(showError = false) {
    const requestId = ++notificationRequestRef.current;
    try {
      const response = await fetch("/api/control/notifications", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        notifications?: NotificationItem[];
        readThrough?: string | number | null;
      };
      if (!response.ok) throw new Error(result.error ?? "安全通知加载失败");
      if (requestId !== notificationRequestRef.current) return;
      const nextNotifications = result.notifications ?? [];
      const readThrough = result.readThrough
        ? new Date(result.readThrough).getTime()
        : 0;
      const safeReadThrough = Number.isFinite(readThrough) ? readThrough : 0;
      setNotifications(nextNotifications);
      // A late polling response must never turn an already-read notification
      // back into unread on the current device.
      setNotificationReadThrough((current) =>
        Math.max(current, safeReadThrough),
      );
      const popup = nextNotifications.find((item) => {
        const createdAt = new Date(item.createdAt).getTime();
        return (
          ["CRITICAL", "WARNING"].includes(item.severity) &&
          createdAt > safeReadThrough &&
          createdAt >= Date.now() - 10 * 60_000 &&
          !notificationPopupSeenRef.current.has(item.id)
        );
      });
      if (popup) {
        notificationPopupSeenRef.current.add(popup.id);
        setToast(`${popup.title}：${popup.message}`);
      }
      setNotificationsLoaded(true);
    } catch (error) {
      if (showError && requestId === notificationRequestRef.current)
        setToast(error instanceof Error ? error.message : "安全通知加载失败");
    }
  }

  async function saveNotificationReadThrough(
    readThrough: number,
    quiet = false,
  ) {
    // Invalidate an older GET request before persisting the newer cursor.
    notificationRequestRef.current += 1;
    try {
      const response = await fetch("/api/control/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readThrough }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        readThrough?: string | number;
      };
      if (!response.ok || !result.readThrough)
        throw new Error(result.error ?? "通知已读状态保存失败");
      const savedReadThrough = new Date(result.readThrough).getTime();
      if (!Number.isFinite(savedReadThrough))
        throw new Error("通知已读状态返回无效");
      setNotificationReadThrough((current) =>
        Math.max(current, savedReadThrough),
      );
      return true;
    } catch (error) {
      if (!quiet)
        setToast(
          error instanceof Error ? error.message : "通知已读状态保存失败",
        );
      return false;
    }
  }

  async function markAllNotificationsRead() {
    if (notificationReadBusy || unreadNotifications === 0) return;
    const previousReadThrough = notificationReadThrough;
    const optimisticReadThrough = Math.max(
      Date.now(),
      ...notifications.map((item) => {
        const createdAt = new Date(item.createdAt).getTime();
        return Number.isFinite(createdAt) ? createdAt : 0;
      }),
    );
    setNotificationReadBusy(true);
    setNotificationReadThrough((current) =>
      Math.max(current, optimisticReadThrough),
    );
    const saved = await saveNotificationReadThrough(optimisticReadThrough);
    if (saved) {
      setToast("安全通知已全部标记为已读，并同步到其他设备");
    } else {
      setNotificationReadThrough((current) =>
        current === optimisticReadThrough ? previousReadThrough : current,
      );
    }
    setNotificationReadBusy(false);
  }

  function openNotification(item: NotificationItem) {
    const openedAt = new Date(item.createdAt).getTime();
    if (Number.isFinite(openedAt)) {
      setNotificationReadThrough((current) => Math.max(current, openedAt));
      void saveNotificationReadThrough(openedAt, true);
    }
    setNotificationDetail(item);
    setShowNotifications(false);
  }

  function navigateFromNotification(item: NotificationItem) {
    setStrategyFocusId(item.strategyId ?? null);
    setStrategyFocusMode(
      item.action === "STRATEGY_LEARNING_SAMPLE_READY" ? "LEARNING" : "EDIT",
    );
    setActive(item.destination === "strategies" ? "auto" : item.destination);
    setNotificationDetail(null);
    setShowNotifications(false);
  }

  useEffect(() => {
    if (!overview) return;
    const refreshOverview = () => {
      if (document.visibilityState === "visible") void loadOverview(false, true);
    };
    const timer = window.setInterval(refreshOverview, 30_000);
    document.addEventListener("visibilitychange", refreshOverview);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOverview);
    };
  }, [Boolean(overview), overviewAccountFilter]);

  useEffect(() => {
    if (
      overviewAccountFilter !== "ALL" &&
      overview &&
      !overview.accountOptions.some(
        (account) => account.accountId === overviewAccountFilter,
      )
    ) {
      setOverviewAccountFilter("ALL");
      void loadOverview(false, false, "ALL");
    }
  }, [overview, overviewAccountFilter]);

  useEffect(() => {
    if (!notificationsLoaded) return;
    const refreshNotifications = () => {
      if (document.visibilityState === "visible") void loadNotifications();
    };
    const timer = window.setInterval(refreshNotifications, 10_000);
    document.addEventListener("visibilitychange", refreshNotifications);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshNotifications);
    };
  }, [notificationsLoaded]);

  async function refresh() {
    setOverviewBusy(true);
    try {
      const response = await fetch("/api/control/symbols?refresh=1", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "实盘合约池刷新失败");
      setMarketRefreshVersion((current) => current + 1);
      await loadOverview(true);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "实盘合约池刷新失败");
      setOverviewBusy(false);
    }
  }

  function refreshCurrentPage() {
    if (active === "overview") {
      void refresh();
      return;
    }
    setWorkspaceRefreshVersion((current) => current + 1);
    void loadOverview(false, true);
  }

  async function executeEmergencyStop() {
    try {
      const response = await fetch("/api/control/emergency", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmation: "PAUSE_AND_FLATTEN",
          reason: "MANUAL_OPERATOR_REQUEST",
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        pausedStrategies?: number;
        canceledOrders?: number;
        closedPositions?: number;
      };
      if (!response.ok) throw new Error(result.error ?? "熔断执行失败");
      setConnected(false);
      setConfirmClose(false);
      setToast(
        `模拟熔断完成：平仓 ${result.closedPositions ?? 0} 笔，暂停 ${result.pausedStrategies ?? 0} 个策略，撤销 ${result.canceledOrders ?? 0} 笔订单`,
      );
      void loadOverview();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "熔断执行失败");
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setToast("当前浏览器未允许全屏，请检查窗口权限");
    }
  }

  async function copyCurrentPageLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("view", active);
    try {
      await window.navigator.clipboard.writeText(url.toString());
      setToast(`${activeLabel}页面链接已复制`);
    } catch {
      setToast("页面链接复制失败，请从浏览器地址栏手动复制");
    }
  }

  function closeWorkspaceTab(tabId: string) {
    if (openTabs.length <= 1) {
      setToast("至少保留一个工作页签");
      return;
    }
    const closingIndex = openTabs.indexOf(tabId);
    const nextTabs = openTabs.filter((id) => id !== tabId);
    setOpenTabs(nextTabs);
    setLastClosedTab(tabId);
    setToast(`已关闭${tabLabels[tabId] ?? tabId}页签`);
    if (tabId === active)
      setActive(
        nextTabs[Math.min(Math.max(closingIndex, 0), nextTabs.length - 1)] ??
          "overview",
      );
  }

  function reopenClosedWorkspaceTab() {
    if (!lastClosedTab) return;
    const tabId = lastClosedTab;
    if (!canOpenPage(tabId)) {
      setLastClosedTab(null);
      setToast("当前角色无权重新打开该页面");
      return;
    }
    setOpenTabs((current) =>
      [...current.filter((id) => id !== tabId), tabId].slice(-6),
    );
    setActive(tabId);
    setLastClosedTab(null);
    setToast(`${tabLabels[tabId] ?? tabId}页签已重新打开`);
  }

  function focusWorkspaceTab(tabId: string) {
    setActive(tabId);
    window.requestAnimationFrame(() =>
      document.getElementById(`workspace-tab-${tabId}`)?.focus(),
    );
  }

  function handleWorkspaceTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    tabId: string,
  ) {
    const currentIndex = openTabs.indexOf(tabId);
    if (currentIndex < 0) return;
    let targetId: string | null = null;
    if (event.key === "ArrowRight")
      targetId = openTabs[(currentIndex + 1) % openTabs.length];
    else if (event.key === "ArrowLeft")
      targetId =
        openTabs[(currentIndex - 1 + openTabs.length) % openTabs.length];
    else if (event.key === "Home") targetId = openTabs[0];
    else if (event.key === "End") targetId = openTabs[openTabs.length - 1];
    else if (event.key === "Delete") {
      event.preventDefault();
      const nextId =
        openTabs[currentIndex + 1] ?? openTabs[currentIndex - 1] ?? "overview";
      closeWorkspaceTab(tabId);
      window.requestAnimationFrame(() =>
        document.getElementById(`workspace-tab-${nextId}`)?.focus(),
      );
      return;
    }
    if (!targetId) return;
    event.preventDefault();
    focusWorkspaceTab(targetId);
  }

  function openSearchResult(result: GlobalSearchResult) {
    if (result.type === "MARKET") {
      setMarketFocus({ symbol: result.id, requestId: Date.now() });
      setActive("manual");
      setToast(`已打开 ${result.id} 实盘下单参数页`);
    } else setActive(result.id);
    setQuery("");
    setSearchOpen(false);
    setMobileSearchOpen(false);
    setSearchIndex(0);
  }

  function openNavigationPage(pageId: string) {
    if (!canOpenPage(pageId)) {
      setToast("当前角色无权访问该页面");
      return;
    }
    setActive(pageId);
    if (window.matchMedia("(max-width: 760px)").matches) setCollapsed(false);
  }

  function toggleUserMenu() {
    setShowUserMenu((current) => !current);
    setShowNotifications(false);
    setShowDisplayMenu(false);
    setShowHelp(false);
    setMobileSearchOpen(false);
    setSearchOpen(false);
  }

  function toggleHeaderOverlay(kind: "help" | "display" | "notifications") {
    const nextOpen =
      kind === "help"
        ? !showHelp
        : kind === "display"
          ? !showDisplayMenu
          : !showNotifications;
    setShowHelp(kind === "help" && nextOpen);
    setShowDisplayMenu(kind === "display" && nextOpen);
    setShowNotifications(kind === "notifications" && nextOpen);
    setShowUserMenu(false);
    setMobileSearchOpen(false);
    setSearchOpen(false);
  }

  return (
    <SecurityGate
      setToast={setToast}
      onAuthenticated={() => {
        void loadOverview();
        void loadNotifications();
        void loadCurrentUser();
      }}
    >
      <main
        className={`${dark ? "app dark" : "app light"} ui-scale-${uiScale.toLowerCase()}`}
      >
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          已进入{activeLabel}，生产实盘环境
        </div>
        <aside
          id="primary-sidebar"
          className={collapsed ? "sidebar collapsed" : "sidebar"}
          aria-hidden={mobileViewport && !collapsed}
          inert={mobileViewport && !collapsed}
        >
          <div className="brand">
            <span className="brand-mark">N</span>
            <span className="brand-name">
              NEXUS<span>QUANT</span>
            </span>
          </div>
          <div className="account-card">
            <span className="avatar">BY</span>
            <span className="account-copy">
              <b>主交易账户</b>
              <small>Binance Futures</small>
            </span>
            <button
              aria-label="切换账户并打开账户管理"
              disabled={!canOpenPage("accounts")}
              onClick={() => openNavigationPage("accounts")}
            >
              ⌄
            </button>
          </div>
          <nav aria-label="主导航">
            {visibleMenuGroups.map((group) => (
              <div className="nav-group" key={group.label}>
                <p>{group.label}</p>
                {group.items.map(([id, icon, label]) => (
                  <button
                    key={id}
                    className={active === id ? "active" : ""}
                    onClick={() => openNavigationPage(id)}
                    title={label}
                  >
                    <span className="nav-icon">{icon}</span>
                    <span className="nav-label">{label}</span>
                    {id === "orders" && overviewMetrics.pendingOrders > 0 && (
                      <em>{overviewMetrics.pendingOrders}</em>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div
            className="sidebar-foot"
            role="status"
            aria-live="polite"
          >
            <span
              className={
                !connected ? "status-dot off" : "status-dot"
              }
            ></span>
            <span className="nav-label">
              {overviewSyncPending
                ? "正在确认行情"
                : connected
                  ? "实盘账户在线"
                  : "行情连接异常"}
            </span>
            <small>{refreshedAt}</small>
          </div>
        </aside>
        {mobileViewport && collapsed && (
          <button
            className="mobile-nav-backdrop"
            aria-label="关闭移动导航"
            onClick={() => setCollapsed(false)}
          />
        )}

        <section className="workspace">
          <header className="topbar">
            <div className="top-left">
              <button
                className="icon-btn"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={
                  (mobileViewport ? collapsed : !collapsed)
                    ? "收起导航"
                    : "展开导航"
                }
                aria-controls="primary-sidebar"
                aria-expanded={mobileViewport ? collapsed : !collapsed}
              >
                ☰
              </button>
              <span className="breadcrumb">
                {activeGroupLabel} <b>/</b> {activeLabel}
              </span>
            </div>
            <div className="top-actions">
              <div className="global-search-shell">
                <label className="global-search">
                  <span>⌕</span>
                  <input
                    ref={searchRef}
                    role="combobox"
                    aria-label="搜索"
                    aria-autocomplete="list"
                    aria-expanded={searchOpen && Boolean(normalizedSearch)}
                    aria-controls="global-search-results"
                    aria-activedescendant={
                      searchResults[searchIndex]
                        ? `global-search-result-${searchIndex}`
                        : undefined
                    }
                    placeholder="搜索有权限的功能或合约"
                    value={query}
                    onFocus={() => setSearchOpen(true)}
                    onBlur={() =>
                      window.setTimeout(() => setSearchOpen(false), 120)
                    }
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setSearchOpen(true);
                      setSearchIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && searchResults.length) {
                        event.preventDefault();
                        setSearchIndex(
                          (current) => (current + 1) % searchResults.length,
                        );
                      } else if (
                        event.key === "ArrowUp" &&
                        searchResults.length
                      ) {
                        event.preventDefault();
                        setSearchIndex(
                          (current) =>
                            (current - 1 + searchResults.length) %
                            searchResults.length,
                        );
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        const selected = searchResults[searchIndex];
                        if (selected) openSearchResult(selected);
                        else setToast("未找到可访问的匹配功能或白名单合约");
                      } else if (event.key === "Escape") setSearchOpen(false);
                    }}
                  />
                  <kbd>⌘ K</kbd>
                </label>
                {searchOpen && normalizedSearch && (
                  <div
                    className="global-search-results"
                    id="global-search-results"
                    role="listbox"
                  >
                    {searchResults.map((result, index) => (
                      <button
                        id={`global-search-result-${index}`}
                        role="option"
                        aria-selected={searchIndex === index}
                        className={searchIndex === index ? "active" : ""}
                        key={`${result.type}-${result.id}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => openSearchResult(result)}
                      >
                        <span>{result.type === "PAGE" ? "⌘" : "◈"}</span>
                        <div>
                          <b>{result.label}</b>
                          <small>{result.description}</small>
                        </div>
                        <em>
                          {result.type === "PAGE" ? "打开页面" : "打开下单"} →
                        </em>
                      </button>
                    ))}
                    {searchResults.length === 0 && (
                      <div className="global-search-empty">
                        未找到可访问的功能或白名单合约
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button
                className="icon-btn mobile-search-trigger"
                aria-label="打开全局搜索"
                aria-expanded={mobileSearchOpen}
                onClick={() => {
                  setMobileSearchOpen(true);
                  setSearchOpen(false);
                  setShowHelp(false);
                  setShowDisplayMenu(false);
                  setShowNotifications(false);
                  setShowUserMenu(false);
                }}
              >
                ⌕
              </button>
              <button
                className="icon-btn"
                aria-label="打开帮助中心"
                aria-expanded={showHelp}
                onClick={() => toggleHeaderOverlay("help")}
              >
                ?
              </button>
              <button
                className="icon-btn"
                onClick={() => setDark(!dark)}
                aria-label={`切换为${dark ? "浅色" : "深色"}主题`}
              >
                {dark ? "☼" : "☾"}
              </button>
              <button
                className="icon-btn"
                aria-label="显示字号设置"
                aria-expanded={showDisplayMenu}
                onClick={() => toggleHeaderOverlay("display")}
              >
                Aa
              </button>
              {showDisplayMenu && (
                <aside
                  className="display-menu"
                  role="dialog"
                  aria-label="显示字号设置"
                >
                  <div>
                    <b>界面字号</b>
                    <small>设置仅保存在当前设备</small>
                  </div>
                  <div className="display-scale-options">
                    {[
                      ["SMALL", "较小", "紧凑显示"],
                      ["STANDARD", "标准", "推荐"],
                      ["LARGE", "较大", "更易阅读"],
                    ].map(([value, label, hint]) => (
                      <button
                        key={value}
                        className={uiScale === value ? "active" : ""}
                        aria-pressed={uiScale === value}
                        onClick={() => setUiScale(value as typeof uiScale)}
                      >
                        <b>{label}</b>
                        <small>{hint}</small>
                      </button>
                    ))}
                  </div>
                  <button
                    className="display-reset"
                    disabled={uiScale === "STANDARD"}
                    onClick={() => setUiScale("STANDARD")}
                  >
                    恢复标准字号
                  </button>
                </aside>
              )}
              <button
                className="icon-btn"
                onClick={() => void toggleFullscreen()}
                aria-label={isFullscreen ? "退出全屏" : "进入全屏"}
              >
                {isFullscreen ? "↙" : "□"}
              </button>
              <button
                className="icon-btn notice"
                aria-label={`安全通知${unreadNotifications ? `，${unreadNotifications} 条未读` : ""}`}
                aria-expanded={showNotifications}
                onClick={() => toggleHeaderOverlay("notifications")}
              >
                ♢
                {unreadNotifications > 0 && (
                  <i>{unreadNotifications > 9 ? "9+" : unreadNotifications}</i>
                )}
              </button>
              {showNotifications && (
                <aside
                  className="notification-center"
                  role="dialog"
                  aria-label="安全通知中心"
                >
                  <div className="notification-head">
                    <div>
                      <b>安全通知</b>
                      <small>
                        {unreadNotifications
                          ? `${unreadNotifications} 条未读`
                          : "已全部阅读"}{" "}
                        · 跨设备同步 · 点击即标为已读
                      </small>
                    </div>
                    <button
                      aria-label="关闭通知"
                      onClick={() => setShowNotifications(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="notification-filters" aria-label="通知分类">
                    {notificationFilters.map(([value, label]) => (
                      <button
                        key={value}
                        aria-pressed={notificationFilter === value}
                        className={notificationFilter === value ? "active" : ""}
                        onClick={() => setNotificationFilter(value)}
                      >
                        <span>{label}</span>
                        <b>{notificationCounts[value]}</b>
                      </button>
                    ))}
                  </div>
                  <div className="notification-list">
                    {visibleNotifications.map((item) => (
                      <button
                        key={item.id}
                        className={
                          new Date(item.createdAt).getTime() >
                          notificationReadThrough
                            ? "unread"
                            : ""
                        }
                        onClick={() => openNotification(item)}
                      >
                        <span
                          className={`notification-dot ${item.severity.toLowerCase()}`}
                        ></span>
                        <div>
                          <b>{item.title}</b>
                          <p>{item.message}</p>
                          <small>
                            {new Date(item.createdAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </small>
                        </div>
                      </button>
                    ))}
                    {notificationsLoaded && notifications.length === 0 && (
                      <div className="notification-empty">
                        暂无需要关注的安全事件
                      </div>
                    )}
                    {notificationsLoaded &&
                      notifications.length > 0 &&
                      visibleNotifications.length === 0 && (
                        <div className="notification-empty">
                          当前分类暂无通知
                        </div>
                      )}
                    {!notificationsLoaded && (
                      <div className="notification-empty">
                        正在读取安全事件…
                      </div>
                    )}
                  </div>
                  <div className="notification-foot">
                    <button onClick={() => void loadNotifications(true)}>
                      刷新
                    </button>
                    <button
                      onClick={() => void markAllNotificationsRead()}
                      disabled={!unreadNotifications || notificationReadBusy}
                    >
                      {notificationReadBusy ? "同步中…" : "全部标为已读"}
                    </button>
                  </div>
                </aside>
              )}
              {notificationDetail && (
                <div
                  className="modal-backdrop notification-detail-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="notification-detail-title"
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget)
                      setNotificationDetail(null);
                  }}
                >
                  <div className="modal compact-modal notification-detail-modal">
                    <button
                      className="modal-close"
                      aria-label="关闭通知详情"
                      onClick={() => setNotificationDetail(null)}
                    >
                      ×
                    </button>
                    <div className="notification-detail-heading">
                      <span
                        className={`notification-dot ${notificationDetail.severity.toLowerCase()}`}
                      ></span>
                      <div>
                        <small>
                          {notificationDetail.severity === "CRITICAL"
                            ? "紧急通知"
                            : notificationDetail.severity === "WARNING"
                              ? "警告通知"
                              : "业务提示"}
                        </small>
                        <h2 id="notification-detail-title">
                          {notificationDetail.title}
                        </h2>
                      </div>
                    </div>
                    <p className="notification-detail-message">
                      {notificationDetail.message}
                    </p>
                    <div className="notification-detail-meta">
                      <span>发生时间</span>
                      <b>
                        {new Date(notificationDetail.createdAt).toLocaleString(
                          "zh-CN",
                          { hour12: false },
                        )}
                      </b>
                      <span>事件代码</span>
                      <b className="mono">{notificationDetail.action}</b>
                      <span>资源定位</span>
                      <b className="mono">
                        {notificationDetail.resourceId || "--"}
                      </b>
                    </div>
                    <div className="modal-actions">
                      <button onClick={() => setNotificationDetail(null)}>
                        关闭
                      </button>
                      <button
                        className="primary-btn"
                        onClick={() =>
                          navigateFromNotification(notificationDetail)
                        }
                      >
                        前往处理
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <span className="divider"></span>
              <button
                className="user-avatar user-avatar-button"
                aria-label="打开当前用户菜单"
                aria-expanded={showUserMenu}
                aria-controls="current-user-menu"
                onClick={toggleUserMenu}
              >
                {currentUserInitial}
              </button>
              <span className="user-copy">
                <b>{currentUserName}</b>
                <small>{currentUserRoleLabel}</small>
              </span>
              <button
                className="plain-btn"
                aria-label="当前用户菜单"
                aria-expanded={showUserMenu}
                aria-controls="current-user-menu"
                onClick={toggleUserMenu}
              >
                ⌄
              </button>
              {showUserMenu && (
                <aside
                  id="current-user-menu"
                  className="user-menu"
                  role="dialog"
                  aria-label="当前用户菜单"
                >
                  <div className="user-menu-profile">
                    <span className="user-avatar">{currentUserInitial}</span>
                    <div>
                      <b>{currentUserName}</b>
                      <small>{currentUser?.email ?? "正在读取登录身份"}</small>
                    </div>
                  </div>
                  <div className="user-menu-badges">
                    <span>{currentUserRoleLabel}</span>
                    <span>
                      {currentUser?.dataScope === "ALL"
                        ? "全部数据范围"
                        : currentUser?.dataScope === "OWN"
                          ? "本人数据范围"
                          : "数据范围读取中"}
                    </span>
                  </div>
                  {canOpenPage("system") && (
                    <button
                      onClick={() => {
                        openNavigationPage("system");
                        setShowUserMenu(false);
                      }}
                    >
                      安全与操作审计 <span>→</span>
                    </button>
                  )}
                  <button
                    className="user-menu-logout"
                    onClick={() => void logoutCurrentUser()}
                  >
                    退出应用会话 <span>↗</span>
                  </button>
                </aside>
              )}
            </div>
          </header>

          {!browserOnline && (
            <section
              className="connection-banner"
              role="alert"
              aria-live="assertive"
            >
              <span aria-hidden="true">!</span>
              <div>
                <b>设备网络已断开</b>
                <p>
                  实时行情、账户同步和所有提交操作当前不可用；系统已阻止新增实盘订单。
                </p>
              </div>
              <button onClick={refresh}>重新连接</button>
            </section>
          )}
          {browserOnline && overviewStale && (
            <section
              className="connection-banner stale-banner"
              role="alert"
              aria-live="assertive"
            >
              <span aria-hidden="true">!</span>
              <div>
                <b>交易数据可能已经过期</b>
                <p>
                  已 {overviewAgeSeconds}{" "}
                  秒未成功刷新本页面总览；服务器自动策略、持仓风控和订单处理继续运行。人工操作前请先同步页面数据。
                </p>
              </div>
              <button
                disabled={overviewBusy}
                onClick={() => void loadOverview(true)}
              >
                {overviewBusy ? "同步中…" : "立即同步"}
              </button>
            </section>
          )}

          {mobileSearchOpen && (
            <div
              className="modal-backdrop mobile-search-backdrop"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mobile-search-title"
            >
              <div className="modal mobile-search-modal">
                <div className="config-title">
                  <div>
                    <h2 id="mobile-search-title">全局搜索</h2>
                    <p>只展示当前账号有权限的功能和白名单合约</p>
                  </div>
                  <button
                    aria-label="关闭全局搜索"
                    onClick={() => setMobileSearchOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <label className="global-search mobile-search-field">
                  <span>⌕</span>
                  <input
                    ref={mobileSearchRef}
                    role="combobox"
                    aria-label="移动端全局搜索"
                    aria-autocomplete="list"
                    aria-expanded={Boolean(normalizedSearch)}
                    aria-controls="mobile-global-search-results"
                    aria-activedescendant={
                      searchResults[searchIndex]
                        ? `mobile-global-search-result-${searchIndex}`
                        : undefined
                    }
                    placeholder="搜索功能或合约"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setSearchIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && searchResults.length) {
                        event.preventDefault();
                        setSearchIndex(
                          (current) => (current + 1) % searchResults.length,
                        );
                      } else if (
                        event.key === "ArrowUp" &&
                        searchResults.length
                      ) {
                        event.preventDefault();
                        setSearchIndex(
                          (current) =>
                            (current - 1 + searchResults.length) %
                            searchResults.length,
                        );
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        const selected = searchResults[searchIndex];
                        if (selected) openSearchResult(selected);
                        else setToast("未找到可访问的匹配功能或白名单合约");
                      } else if (event.key === "Escape")
                        setMobileSearchOpen(false);
                    }}
                  />
                </label>
                {normalizedSearch ? (
                  <div
                    className="global-search-results mobile-search-results"
                    id="mobile-global-search-results"
                    role="listbox"
                  >
                    {searchResults.map((result, index) => (
                      <button
                        id={`mobile-global-search-result-${index}`}
                        role="option"
                        aria-selected={searchIndex === index}
                        className={searchIndex === index ? "active" : ""}
                        key={`${result.type}-${result.id}`}
                        onClick={() => openSearchResult(result)}
                      >
                        <span>{result.type === "PAGE" ? "⌘" : "◈"}</span>
                        <div>
                          <b>{result.label}</b>
                          <small>{result.description}</small>
                        </div>
                        <em>
                        {result.type === "PAGE" ? "打开页面" : "打开下单"} →
                        </em>
                      </button>
                    ))}
                    {searchResults.length === 0 && (
                      <div className="global-search-empty">
                        未找到可访问的功能或白名单合约
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mobile-search-hint">
                    输入页面名称、功能名称或合约代码，例如“仓位”或“BTCUSDT”。
                  </div>
                )}
                <div className="mobile-search-safety">
                  <b>实盘交易保护</b>
                  <span>
                    打开合约后只进入参数填写页面，仍需确认文字才会提交真实订单。
                  </span>
                </div>
              </div>
            </div>
          )}

          {showHelp && (
            <div
              className="modal-backdrop help-backdrop"
              role="dialog"
              aria-modal="true"
              aria-labelledby="help-center-title"
            >
              <div className="modal help-modal">
                <div className="config-title">
                  <div>
                    <h2 id="help-center-title">NexusQuant 帮助中心</h2>
                    <p>
                      当前页面：{activeLabel} · 生产环境仅使用 Binance 实盘数据
                    </p>
                  </div>
                  <button
                    aria-label="关闭帮助中心"
                    onClick={() => setShowHelp(false)}
                  >
                    ×
                  </button>
                </div>
                <section className="help-current">
                  <span>当前页面说明</span>
                  <b>{activeLabel}</b>
                  <p>{activeHelp}</p>
                </section>
                <div className="help-safety-grid">
                  <article>
                    <span>01</span>
                    <div>
                      <b>生产实盘</b>
                      <p>
                        行情、订单、仓位与盈亏均来自 Binance
                        正式环境；提交订单会真实成交。
                      </p>
                    </div>
                  </article>
                  <article>
                    <span>02</span>
                    <div>
                      <b>风险安全门</b>
                      <p>
                        当前账户状态、委托参数、行情新鲜度和交易所规则会在服务端再次检查；历史演练不参与下单门槛。
                      </p>
                    </div>
                  </article>
                  <article>
                    <span>03</span>
                    <div>
                      <b>关键操作留痕</b>
                      <p>
                        下单、平仓、策略、账户、权限与熔断等操作均进入审计记录。
                      </p>
                    </div>
                  </article>
                </div>
                <section className="help-troubleshooting">
                  <h3>常见处理</h3>
                  <div>
                    <article>
                      <b>数据暂未更新</b>
                      <p>
                        先点击顶部刷新；Binance
                        实盘行情不可达时系统会阻止新增订单。
                      </p>
                    </article>
                    <article>
                      <b>策略无法启动</b>
                      <p>
                        核对参数有效、账户已启用且策略状态为运行中，再执行策略页面的运行检查。
                      </p>
                    </article>
                    <article>
                      <b>账户处于熔断</b>
                      <p>
                        前往子账号管理核对亏损原因，满足条件后由管理员复核解锁。
                      </p>
                    </article>
                    <article>
                      <b>等待订单未变化</b>
                      <p>
                        前往订单状态刷新交易所回执；状态未知时立即登录 Binance
                        人工核对。
                      </p>
                    </article>
                  </div>
                </section>
                <section className="help-shortcuts">
                  <b>键盘操作</b>
                  <span>
                    <kbd>Ctrl / ⌘</kbd> + <kbd>K</kbd> 聚焦全局搜索
                  </span>
                  <span>
                    <kbd>Esc</kbd> 关闭帮助、通知或显示设置
                  </span>
                </section>
                <div className="help-quick-actions">
                  {canOpenPage("auto") && (
                    <button
                      onClick={() => {
                        setActive("auto");
                        setShowHelp(false);
                      }}
                    >
                      策略安全检查
                    </button>
                  )}
                  {canOpenPage("orders") && (
                    <button
                      onClick={() => {
                        setActive("orders");
                        setShowHelp(false);
                      }}
                    >
                      订单对账
                    </button>
                  )}
                  {canOpenPage("accounts") && (
                    <button
                      onClick={() => {
                        setActive("accounts");
                        setShowHelp(false);
                      }}
                    >
                      账户风险
                    </button>
                  )}
                </div>
                <div className="config-actions">
                  <button
                    className="primary-btn"
                    onClick={() => setShowHelp(false)}
                  >
                    我知道了
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="tabbar">
            <button
              className="home-tab"
              aria-label="返回总览"
              onClick={() => setActive("overview")}
            >
              ⌂
            </button>
            <div
              className="tab-scroll"
              role="tablist"
              aria-label="已打开页面，可用左右方向键切换，Delete 键关闭"
              aria-orientation="horizontal"
            >
              {openTabs.map((tabId) => (
                <div
                  className={`workspace-tab ${active === tabId ? "active" : ""}`}
                  key={tabId}
                >
                  <button
                    id={`workspace-tab-${tabId}`}
                    className="tab-select"
                    role="tab"
                    aria-selected={active === tabId}
                    aria-controls="main-content"
                    tabIndex={active === tabId ? 0 : -1}
                    onKeyDown={(event) =>
                      handleWorkspaceTabKeyDown(event, tabId)
                    }
                    onClick={() => setActive(tabId)}
                  >
                    {tabLabels[tabId] ?? tabId}
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`关闭${tabLabels[tabId] ?? tabId}页签`}
                    onClick={() => closeWorkspaceTab(tabId)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              className="icon-btn"
              onClick={() => void copyCurrentPageLink()}
              title="复制当前页面链接"
              aria-label={`复制${activeLabel}页面链接`}
            >
              ⌁
            </button>
            <button
              className="icon-btn"
              onClick={refreshCurrentPage}
              title="强制刷新"
              aria-label="刷新当前页面"
            >
              ↻
            </button>
            <button
              className="icon-btn"
              aria-label="关闭其他页签"
              title="关闭其他页签"
              disabled={openTabs.length <= 1}
              onClick={() => {
                setOpenTabs([active]);
                setToast("已关闭其他工作页签");
              }}
            >
              ⋯
            </button>
          </div>

          <div id="main-content" className="content" tabIndex={-1}>
            <div className="page-title-row">
              <div>
                <h1>{active === "overview" ? "运营总览" : activeLabel}</h1>
                <p>{activeHelp}</p>
              </div>
              <div className="live-row">
                <span
                  className={
                    overviewSyncPending || overviewStale
                      ? "live-pill stale"
                      : connected
                        ? "live-pill"
                        : "live-pill offline"
                  }
                >
                  <i></i>
                  {overviewSyncPending
                    ? "连接状态待确认"
                    : overviewStale
                    ? "数据已过期"
                    : connected
                      ? "行情实时连接"
                      : "连接已断开"}
                </span>
                <span>最后同步 {refreshedAt}</span>
                <button
                  className="refresh-btn"
                  disabled={overviewBusy}
                  onClick={refreshCurrentPage}
                >
                  {overviewBusy ? "同步中…" : "↻ 刷新数据"}
                </button>
              </div>
            </div>

            {active === "overview" && (
              <>
                <section className="panel overview-account-scope">
                  <div>
                    <b>运营数据范围</b>
                    <small>
                      {overview?.accountScope.mode === "SINGLE"
                        ? `${overview.accountScope.accountId} · ${overview.accountScope.name}`
                        : "全部交易子账户汇总；主账户不计入交易数据"}
                    </small>
                  </div>
                  <label className="account-filter">
                    <span>资金账户</span>
                    <select
                      value={overviewAccountFilter}
                      disabled={overviewBusy}
                      onChange={(event) => {
                        const nextAccountId = event.target.value;
                        setOverviewAccountFilter(nextAccountId);
                        void loadOverview(false, false, nextAccountId);
                      }}
                    >
                      <option value="ALL">全部账户</option>
                      {(overview?.accountOptions ?? []).map((account) => (
                        <option key={account.accountId} value={account.accountId}>
                          {account.accountId} · {account.name}
                          {account.isActive ? "" : "（已停用）"}
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
                <section
                  className={`panel overview-order-health ${overview?.orderHealth.status === "ATTENTION" ? "attention" : "healthy"}`}
                  aria-label="工作订单健康"
                >
                  <div className="overview-order-health-summary">
                    <div>
                      <span className="overview-module-kicker">ORDER HEALTH</span>
                      <h2>工作订单健康</h2>
                      <small>覆盖待提交、已提交、新挂单、部分成交、撤单中和执行未知状态</small>
                    </div>
                    <b>{overview?.orderHealth.status === "ATTENTION" ? "需要核对" : "状态一致"}</b>
                  </div>
                  <div className="overview-order-health-grid">
                    <article><span>当前工作订单</span><b>{overview?.orderHealth.workingCount ?? 0}</b></article>
                    <article>
                      <span>最老等待</span>
                      <b>
                        {(overview?.orderHealth.oldestWorkingAgeMs ?? 0) <= 0
                          ? "--"
                          : (overview?.orderHealth.oldestWorkingAgeMs ?? 0) >= 60_000
                            ? `${((overview?.orderHealth.oldestWorkingAgeMs ?? 0) / 60_000).toFixed(1)} 分钟`
                            : `${Math.ceil((overview?.orderHealth.oldestWorkingAgeMs ?? 0) / 1_000)} 秒`}
                      </b>
                    </article>
                    <article><span>终态轨迹仍挂单</span><b>{overview?.orderHealth.terminalTraceWorkingCount ?? 0}</b></article>
                    <article><span>过期意图仍挂单</span><b>{overview?.orderHealth.expiredIntentWorkingCount ?? 0}</b></article>
                    <article><span>执行状态未知</span><b>{overview?.orderHealth.executionUnknownCount ?? 0}</b></article>
                  </div>
                  {(overview?.orderHealth.details.length ?? 0) > 0 && (
                    <details className="overview-order-health-details">
                      <summary>查看当前工作订单</summary>
                      <div>
                        {(overview?.orderHealth.details ?? []).map((order) => (
                          <p key={order.id}>
                            <b>#{order.id} {order.symbol} {order.positionSide === "LONG" ? "多" : "空"}</b>
                            <span>{order.accountId} · {order.status} · 轨迹 {order.traceState ?? "未绑定"} · 意图 {order.intentStatus ?? "未绑定"}</span>
                          </p>
                        ))}
                      </div>
                    </details>
                  )}
                </section>
                <section className="overview-daily-activity panel" aria-label="今日交易流程与运营核心指标">
                  <div className="overview-daily-activity-head">
                    <div>
                      <span className="overview-module-kicker">TODAY</span>
                      <h2>今日交易流程</h2>
                    </div>
                    <small>北京时间自然日 · 委托、成交、建仓和完整平仓分别统计</small>
                  </div>
                  <div className="overview-daily-summary-grid">
                    <article className="overview-kpi-card hour-order-kpi">
                      <span>今日委托</span>
                      <b>{overviewMetrics.todayOrders}</b>
                      <small>策略 {overviewMetrics.todayStrategyOrders} / 人工 {overviewMetrics.todayManualOrders}</small>
                    </article>
                    <article className="overview-kpi-card order-kpi">
                      <span>今日成交</span>
                      <b>{overviewMetrics.todayFilledOrders}</b>
                      <small>成交名义价值 {overviewMetrics.todayFilledNotional.toFixed(2)} USDT</small>
                    </article>
                    <article className="overview-kpi-card position-open-kpi">
                      <span>今日新增仓位</span>
                      <b>{overviewMetrics.todayNewPositions}</b>
                      <small>按实盘仓位 openedAt 统计</small>
                    </article>
                    <article className="overview-kpi-card position-closed-kpi">
                      <span>今日已平仓</span>
                      <b>{overviewMetrics.todayClosedPositions}</b>
                      <small>完整平仓；自动减仓/平仓动作 {overviewMetrics.todayAutomaticReductions}</small>
                    </article>
                    <article className="overview-kpi-card result-kpi">
                      <span>盈亏单对比</span>
                      <b>
                        <em className="positive">{overviewMetrics.todayProfitableRecords} 盈</em>
                        <i>/</i>
                        <em className="negative">{overviewMetrics.todayLosingRecords} 亏</em>
                        <i>/</i>
                        <em className="muted">{overviewMetrics.todayBreakevenRecords} 平</em>
                      </b>
                      <small>按今日完整平仓交易</small>
                    </article>
                    <article className="overview-kpi-card profit-kpi">
                      <span>今日盈利</span>
                      <b className={overviewMetrics.todayRealizedPnl >= 0 ? "positive" : "negative"}>
                        {overviewMetrics.todayRealizedPnl >= 0 ? "+" : ""}{overviewMetrics.todayRealizedPnl.toFixed(2)}
                      </b>
                      <small>USDT · 已实现</small>
                    </article>
                    <article className="overview-kpi-card month-kpi">
                      <span>本月盈利</span>
                      <b className={overviewMetrics.monthRealizedPnl >= 0 ? "positive" : "negative"}>
                        {overviewMetrics.monthRealizedPnl >= 0 ? "+" : ""}{overviewMetrics.monthRealizedPnl.toFixed(2)}
                      </b>
                      <small>USDT · 已实现</small>
                    </article>
                    <article className="overview-kpi-card balance-kpi">
                      <span>交易账户资产</span>
                      <b>{overviewMetrics.accountBalanceAvailable ? overviewMetrics.accountBalance.toFixed(2) : "--"}</b>
                      <small className={overviewMetrics.accountBalanceComplete ? "" : "warning-text"}>
                        {overviewMetrics.eligibleAccountCount === 0
                          ? "暂无已启用且验证通过的实盘子账户"
                          : `可用 ${overviewMetrics.accountBalanceAvailable ? overviewMetrics.accountAvailableBalance.toFixed(2) : "--"} · ${overviewMetrics.freshAccountCount}/${overviewMetrics.eligibleAccountCount} 个账户实时同步${overviewMetrics.accountBalanceComplete ? "" : " · 当前展示最近快照"}`}
                      </small>
                    </article>
                    <article className="overview-kpi-card unrealized-kpi">
                      <span>未实现盈亏</span>
                      <b className={overviewMetrics.unrealizedPnl >= 0 ? "positive" : "negative"}>
                        {overviewMetrics.unrealizedPnlAvailable
                          ? `${overviewMetrics.unrealizedPnl >= 0 ? "+" : ""}${overviewMetrics.unrealizedPnl.toFixed(2)}`
                          : "--"}
                      </b>
                      <small className={overviewMetrics.unrealizedPnlAvailable ? "" : "warning-text"}>
                        USDT · {overviewMetrics.unrealizedPnlAvailable ? "Binance 账户快照" : "账户资金快照待同步"}
                      </small>
                    </article>
                  </div>
                </section>

                <section className="overview-strategy-funnel panel" aria-label="各策略今日成交漏斗">
                  <div className="overview-strategy-funnel-head">
                    <div>
                      <span className="overview-module-kicker">STRATEGY FUNNEL</span>
                      <h2>各策略今日成交漏斗</h2>
                    </div>
                    <small>结构通过不等于执行授权；净期望拒绝与真实执行交接分别统计</small>
                  </div>
                  <div className="overview-strategy-funnel-table">
                    <table>
                      <thead>
                        <tr>
                          <th>策略</th>
                          <th>眼睛确认</th>
                          <th>大脑结构通过</th>
                          <th>净期望拒绝</th>
                          <th>执行授权</th>
                          <th>分析过期</th>
                          <th>方向冲突</th>
                          <th>价格过远</th>
                          <th>执行到期</th>
                          <th>行情暂不可用</th>
                          <th>额度不足</th>
                          <th>策略风控</th>
                          <th>已有仓位</th>
                          <th>有委托</th>
                          <th>成交轨迹</th>
                          <th>仍工作</th>
                          <th>撤单</th>
                          <th>未委托</th>
                          <th>尝试 / 重试</th>
                          <th>授权→成交</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(overview?.strategyFunnels ?? []).map((funnel) => (
                          <tr key={funnel.strategyId}>
                            <td>
                              <b>#{funnel.strategyId} {funnel.displayName || funnel.name}</b>
                              <small className={funnel.status === "RUNNING" ? "positive" : "muted"}>
                                {funnel.status === "RUNNING" ? "运行中" : "已暂停"}
                              </small>
                              {funnel.inverseLanes && (
                                <small>
                                  原多→实空 {funnel.inverseLanes.LONG_TO_SHORT.orders}/{funnel.inverseLanes.LONG_TO_SHORT.filled} · 原空→实多 {funnel.inverseLanes.SHORT_TO_LONG.orders}/{funnel.inverseLanes.SHORT_TO_LONG.filled}
                                </small>
                              )}
                            </td>
                            <td>{funnel.eyeConfirmed}</td>
                            <td>{funnel.confirmed}</td>
                            <td>{funnel.netExpectancyRejected}</td>
                            <td>{funnel.authorized}</td>
                            <td>{funnel.analysisExpired}</td>
                            <td>{funnel.directionConflict}</td>
                            <td>{funnel.priceTooFar}</td>
                            <td>{funnel.expired}</td>
                            <td>
                              {funnel.marketDataWait}
                              {funnel.marketDataWait > 0 && (
                                <small>
                                  盘口新鲜度 {funnel.marketDataWaitBreakdown.bookFreshness} · 分析时钟暂停 {funnel.marketDataWaitBreakdown.analysisClockPaused} · 非核心周期降级 {funnel.marketDataWaitBreakdown.degradedContext} · 上游读取 {funnel.marketDataWaitBreakdown.upstreamFetch}
                                </small>
                              )}
                            </td>
                            <td>{funnel.capacityInsufficient}</td>
                            <td>{funnel.strategyRiskRejected}</td>
                            <td>{funnel.existingPosition}</td>
                            <td>{funnel.orders}</td>
                            <td><b className="positive">{funnel.filled}</b></td>
                            <td>{funnel.working}</td>
                            <td>{funnel.canceled}</td>
                            <td>{funnel.noOrder}</td>
                            <td>{funnel.orderAttempts} / {funnel.retryAttempts}</td>
                            <td>
                              {funnel.authorized > 0 ? `${funnel.conversionPercent.toFixed(1)}%` : "--"}
                              <small>
                                发单前等待 P50 {funnel.confirmationToOrderMedianMs === null ? "待记录" : `${(funnel.confirmationToOrderMedianMs / 1_000).toFixed(2)}秒`} / P90 {funnel.confirmationToOrderP90Ms === null ? "待记录" : `${(funnel.confirmationToOrderP90Ms / 1_000).toFixed(2)}秒`}
                                {funnel.marketOrderToTerminalP50Ms === null ? "" : ` · Binance市价执行 P50 ${(funnel.marketOrderToTerminalP50Ms / 1_000).toFixed(2)}秒 / P90 ${((funnel.marketOrderToTerminalP90Ms ?? funnel.marketOrderToTerminalP50Ms) / 1_000).toFixed(2)}秒`}
                                {funnel.limitOrderToTerminalP50Ms === null ? "" : ` · 限价成交等待 P50 ${(funnel.limitOrderToTerminalP50Ms / 1_000).toFixed(2)}秒 / P90 ${((funnel.limitOrderToTerminalP90Ms ?? funnel.limitOrderToTerminalP50Ms) / 1_000).toFixed(2)}秒`}
                                {funnel.directionMode === "INVERSE_BRAIN" && funnel.priceDeviationMedianBps !== null ? ` · 偏离 ${funnel.priceDeviationMedianBps.toFixed(1)}bp` : ""}
                                {funnel.slowConfirmedOrders > 0 ? ` · 超3秒 ${funnel.slowConfirmedOrders}` : ""}
                                {funnel.unknownInverseDirectionOrders > 0 ? ` · 方向待补 ${funnel.unknownInverseDirectionOrders}` : ""}
                              </small>
                            </td>
                          </tr>
                        ))}
                        {(overview?.strategyFunnels ?? []).length === 0 && (
                          <tr>
                            <td colSpan={20} className="empty-cell">今日暂无策略漏斗数据</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <p>眼睛确认表示量价事实成立，大脑结构通过表示方向与时机初审成立；只有费用后净期望通过并取得执行授权，才进入委托漏斗。右侧“成交、仍工作、撤单、未委托”仅按执行授权轨迹互斥归类；“行情暂不可用”只统计基础设施与数据新鲜度问题，正常等待闭合K线或证据不足不再混入系统卡点。</p>
                </section>

                <section className="overview-profit-funnel panel" aria-label="真实利润漏斗">
                  <div className="overview-profit-funnel-head">
                    <div>
                      <span className="overview-module-kicker">PROFIT FUNNEL</span>
                      <h2>真实利润漏斗</h2>
                      <small>系统记录期内，将已平仓结果与当前持仓浮盈亏放在同一条线上观察</small>
                    </div>
                    <div className={`profit-funnel-basis ${profitFunnel.resultBasis.toLowerCase()}`}>
                      <b>{profitFunnelStatusText}</b>
                      <small>
                        {profitFunnel.resultBasis === "EXACT_NET"
                          ? `${profitFunnel.exactNetRecords} 笔已实现记录均完成费用核对`
                          : profitFunnel.resultBasis === "MIXED_ESTIMATE"
                            ? `${profitFunnel.exactNetRecords}/${profitFunnel.realizedRecords} 笔完成净收益核对 · ${profitFunnel.pendingNetRecords} 笔待补`
                            : "组合结果不可用"}
                        {profitFunnel.accountEquity !== null
                          ? ` · 当前权益 ${profitFunnel.accountEquity.toFixed(2)} USDT`
                          : ""}
                      </small>
                    </div>
                  </div>
                  <div className="overview-profit-funnel-flow">
                    <article>
                      <span>已实现毛盈亏</span>
                      <b className={profitFunnel.grossRealizedPnl >= 0 ? "positive" : "negative"}>
                        {profitFunnel.grossRealizedPnl >= 0 ? "+" : ""}{profitFunnel.grossRealizedPnl.toFixed(2)}
                      </b>
                      <small>{profitFunnel.realizedRecords} 笔总记录；其中精确样本毛盈亏 {profitFunnel.exactCohortGrossRealizedPnl >= 0 ? "+" : ""}{profitFunnel.exactCohortGrossRealizedPnl.toFixed(2)} USDT</small>
                    </article>
                    <article className="cost-stage">
                      <span>精确样本交易成本</span>
                      <b className={profitFunnel.exactCohortTradingCosts > 0 ? "negative" : ""}>
                        {profitFunnel.exactCohortTradingCosts > 0 ? "−" : ""}{profitFunnel.exactCohortTradingCosts.toFixed(2)}
                      </b>
                      <small>仅与已完成净收益核对的记录同口径</small>
                    </article>
                    <article>
                      <span>精确样本资金费</span>
                      <b className={profitFunnel.exactCohortFundingPnl >= 0 ? "positive" : "negative"}>
                        {profitFunnel.exactCohortFundingPnl >= 0 ? "+" : ""}{profitFunnel.exactCohortFundingPnl.toFixed(2)}
                      </b>
                      <small>正数为收入，负数为支出；与净收益同批</small>
                    </article>
                    <article className="accounted-stage">
                      <span>费用后精确净收益</span>
                      <b className={profitFunnel.exactNetRealizedPnl >= 0 ? "positive" : "negative"}>
                        {profitFunnel.exactNetRealizedPnl >= 0 ? "+" : ""}{profitFunnel.exactNetRealizedPnl.toFixed(2)}
                      </b>
                      <small>{profitFunnel.exactNetRecords} 笔精确记录；不混入待补样本</small>
                    </article>
                    <article>
                      <span>待补样本入账估值</span>
                      <b className={profitFunnel.pendingEstimatedRealizedPnl >= 0 ? "positive" : "negative"}>
                        {profitFunnel.pendingEstimatedRealizedPnl >= 0 ? "+" : ""}{profitFunnel.pendingEstimatedRealizedPnl.toFixed(2)}
                      </b>
                      <small>{profitFunnel.pendingNetRecords} 笔尚未完成费用核对，不作为精确净收益</small>
                    </article>
                    <article className="unrealized-stage">
                      <span>当前未实现盈亏</span>
                      <b className={(profitFunnel.unrealizedPnl ?? 0) >= 0 ? "positive" : "negative"}>
                        {profitFunnel.unrealizedPnl === null
                          ? "--"
                          : `${profitFunnel.unrealizedPnl >= 0 ? "+" : ""}${profitFunnel.unrealizedPnl.toFixed(2)}`}
                      </b>
                      <small>Binance 实时账户快照</small>
                    </article>
                    <article className="portfolio-stage">
                      <span>当前组合结果</span>
                      <b className={(profitFunnel.portfolioPnl ?? 0) >= 0 ? "positive" : "negative"}>
                        {profitFunnel.portfolioPnl === null
                          ? "--"
                          : `${profitFunnel.portfolioPnl >= 0 ? "+" : ""}${profitFunnel.portfolioPnl.toFixed(2)}`}
                      </b>
                      <small>已实现入账口径 + 当前未实现</small>
                    </article>
                  </div>
                  <div className="overview-profit-funnel-foot">
                    <span>净收益核对覆盖率 <b>{profitFunnel.exactNetCoveragePercent.toFixed(1)}%</b></span>
                    <small>待补记录不会伪装成精确净收益；漏斗不参与自动交易判断。</small>
                  </div>
                </section>

                <section className="overview-account-breakdown panel" aria-label="交易子账户资产明细">
                    <div className="overview-account-breakdown-head">
                      <div>
                        <span>交易子账户资产</span>
                        <small>主账户不计入交易资金，余额只使用 90 秒内同步成功的数据</small>
                      </div>
                      <b className={overviewMetrics.accountBalanceComplete ? "positive" : "warning-text"}>
                        {overviewMetrics.accountBalanceComplete ? "数据完整" : "数据不完整"}
                      </b>
                    </div>
                    {(overview?.accountBalances?.length ?? 0) > 0 ? <div className="overview-account-balance-list">
                      {(overview?.accountBalances ?? []).map((account) => (
                        <article key={account.accountId} className={account.status.toLowerCase()}>
                          <div>
                            <b>{account.name}</b>
                            <small>{account.accountId}</small>
                          </div>
                          <div>
                            <span>钱包余额</span>
                            <strong>{account.status === "FRESH" && account.totalWalletBalance !== null ? account.totalWalletBalance.toFixed(2) : "--"}</strong>
                          </div>
                          <div>
                            <span>保证金权益</span>
                            <strong>{account.status === "FRESH" && account.totalMarginBalance !== null ? account.totalMarginBalance.toFixed(2) : "--"}</strong>
                          </div>
                          <div>
                            <span>可再开仓</span>
                            <strong>{account.status === "FRESH" && account.availableBalance !== null ? account.availableBalance.toFixed(2) : "--"}</strong>
                          </div>
                          <div>
                            <span>持仓 / 挂单占用</span>
                            <strong>{account.status === "FRESH" && account.totalPositionInitialMargin !== null && account.totalOpenOrderInitialMargin !== null ? `${account.totalPositionInitialMargin.toFixed(2)} / ${account.totalOpenOrderInitialMargin.toFixed(2)}` : "--"}</strong>
                          </div>
                          <div className="account-balance-sync">
                            <span className={account.status === "FRESH" ? "positive" : "warning-text"}>
                              {account.status === "FRESH" ? "已同步" : account.status === "ERROR" ? "同步失败" : "数据过期"}
                            </span>
                            <small>{account.syncedAt ? new Date(account.syncedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "尚未同步"}</small>
                          </div>
                        </article>
                      ))}
                    </div> : <div className="overview-account-balance-empty">暂无已启用、已验证并允许实盘交易的子账户；主账户不参与下单和资金汇总。</div>}
                  </section>

                <section className="overview-live-grid">
                  <article className="panel overview-live-module position-module">
                    <div className="overview-module-head">
                      <div>
                        <span className="overview-module-kicker">POSITION</span>
                        <h2>实盘仓位</h2>
                      </div>
                      {canOpenPage("position") && (
                        <button onClick={() => setActive("position")}>仓位管理 →</button>
                      )}
                    </div>
                    <div className="overview-module-stats">
                      <div className="overview-stat primary">
                        <span>当前持仓</span>
                        <b>{overviewMetrics.openPositions}</b>
                        <small>个仓位</small>
                      </div>
                      <div className="overview-stat">
                        <span>持仓名义价值</span>
                        <b>{overviewMetrics.positionPricesComplete ? overviewMetrics.notionalValue.toFixed(2) : "--"}</b>
                        <small>USDT</small>
                      </div>
                      <div className="overview-stat">
                        <span>估算保证金</span>
                        <b>{overviewMetrics.positionPricesComplete ? overviewMetrics.marginUsed.toFixed(2) : "--"}</b>
                        <small>USDT</small>
                      </div>
                      <div className="overview-stat">
                        <span>未实现盈亏</span>
                        <b className={overviewMetrics.unrealizedPnl >= 0 ? "positive" : "negative"}>
                          {overviewMetrics.unrealizedPnlAvailable
                            ? `${overviewMetrics.unrealizedPnl >= 0 ? "+" : ""}${overviewMetrics.unrealizedPnl.toFixed(2)}`
                            : "--"}
                        </b>
                        <small>USDT</small>
                      </div>
                    </div>
                    <div className="overview-module-foot">
                      <span className={overview?.systemStatus?.riskHeartbeatHealthy ? "positive" : "warning-text"}><i></i>{overview?.systemStatus?.riskHeartbeatHealthy ? "后台风控运行中" : "后台风控心跳异常"}</span>
                      <small>{overviewMetrics.positionPricesComplete ? "标记价格已统一" : "仓位价格数据不完整"}</small>
                    </div>
                  </article>

                  <article className="panel overview-live-module order-module">
                    <div className="overview-module-head">
                      <div>
                        <span className="overview-module-kicker">ORDER</span>
                        <h2>实盘订单</h2>
                      </div>
                      {canOpenPage("orders") && (
                        <button onClick={() => setActive("orders")}>订单状态 →</button>
                      )}
                    </div>
                    <div className="overview-module-stats">
                      <div className="overview-stat primary">
                        <span>订单总数</span>
                        <b>{overviewMetrics.totalOrders}</b>
                        <small>正式订单</small>
                      </div>
                      <div className="overview-stat">
                        <span>已确认成交</span>
                        <b className="positive">{overviewMetrics.filledOrders}</b>
                        <small>已取得成交数量和均价</small>
                      </div>
                      <div className="overview-stat">
                        <span>已拒绝</span>
                        <b className="negative">{overviewMetrics.rejectedOrders}</b>
                        <small>未成交</small>
                      </div>
                      <div className="overview-stat">
                        <span>状态待核对</span>
                        <b className={overviewMetrics.executionUnknownOrders ? "warning-text" : ""}>{overviewMetrics.executionUnknownOrders}</b>
                        <small>禁止重复提交</small>
                      </div>
                    </div>
                    <div className="overview-module-foot">
                      <span className={overviewMetrics.pendingOrders ? "warning-text" : "positive"}><i></i>{overviewMetrics.pendingOrders} 笔处理中</span>
                      <small>不含密钥验证记录</small>
                    </div>
                  </article>

                  <article className="panel overview-live-module profit-module">
                    <div className="overview-module-head">
                      <div>
                        <span className="overview-module-kicker">PROFIT</span>
                        <h2>实盘收益</h2>
                      </div>
                      {canOpenPage("profit") && (
                        <button onClick={() => setActive("profit")}>收益明细 →</button>
                      )}
                    </div>
                    <div className="overview-module-stats">
                      <div className="overview-stat primary">
                        <span>已实现盈亏</span>
                        <b className={overviewMetrics.realizedPnl >= 0 ? "positive" : "negative"}>
                          {overviewMetrics.realizedPnl >= 0 ? "+" : ""}{overviewMetrics.realizedPnl.toFixed(2)}
                        </b>
                        <small>USDT</small>
                      </div>
                      <div className="overview-stat">
                        <span>已实现记录</span>
                        <b>{overviewMetrics.realizedRecords}</b>
                        <small>完整及分批平仓</small>
                      </div>
                      <div className="overview-stat">
                        <span>盈利 / 亏损 / 持平</span>
                        <b><em className="positive">{overviewMetrics.closedTradeWins}</em> / <em className="negative">{overviewMetrics.closedTradeLosses}</em> / <em>{overviewMetrics.closedTradeBreakeven}</em></b>
                        <small>完整平仓交易</small>
                      </div>
                      <div className="overview-stat">
                        <span>胜率</span>
                        <b>{overviewMetrics.closedTradeWins + overviewMetrics.closedTradeLosses ? ((overviewMetrics.closedTradeWins / (overviewMetrics.closedTradeWins + overviewMetrics.closedTradeLosses)) * 100).toFixed(1) : "0.0"}%</b>
                        <small>持平交易不计入分母</small>
                      </div>
                    </div>
                    <div className="overview-module-foot">
                      <span>{overviewMetrics.closedPositions} 笔完整平仓</span>
                      <small>{overviewMetrics.partialReductions} 次真实部分减仓</small>
                    </div>
                  </article>
                </section>

                <section className="overview-system-strip panel">
                  <div>
                    <span>交易系统权重</span>
                    <b>{overview?.rateLimit?.projectUsedWeight ?? overview?.rateLimit?.usedWeight ?? 0} / {overview?.rateLimit?.limitWeight ?? 800}</b>
                  </div>
                  <div className="progress"><i style={{ width: `${weightPercent}%` }}></i></div>
                  <span>
                    眼睛观测 {overview?.rateLimit?.observationUsedWeight ?? 0} / {overview?.rateLimit?.observationLimitWeight ?? 500}
                    {" · "}Binance/IP {overview?.rateLimit?.binanceObservedWeight ?? 0} / {overview?.rateLimit?.globalIpLimitWeight ?? 2200}
                    {" · "}预留交易权重 {overview?.rateLimit?.reservedTradingWeight ?? 40}
                    {" · "}{overview?.rateLimit?.source === "BINANCE_PROXY" ? "统一代理实时值" : "备用计数"}
                  </span>
                  <span className={overview?.systemStatus?.healthy ? "positive" : "warning-text"}>{overviewBusy ? "同步中" : overview?.systemStatus?.healthy ? "系统运行正常" : "系统状态待检查"}</span>
                  <div className="overview-system-traffic">
                    <span>大户接口 5分钟 <b>{overview?.traffic?.futuresData?.upstreamRequests ?? 0} / {overview?.traffic?.futuresData?.requestLimit ?? 800}</b></span>
                    <span>
                      近1小时爆仓{" "}
                      <b>{overview?.traffic?.liquidationNotionalDistribution?.eventCount ?? 0} 次</b>
                      {" · "}单秒≥6000{" "}
                      <b>
                        {overview?.traffic?.liquidationNotionalDistribution
                          ?.threshold6000?.eventCount ?? 0} 次 /{" "}
                        {(
                          (overview?.traffic?.liquidationNotionalDistribution
                            ?.threshold6000?.eventShare ?? 0) * 100
                        ).toFixed(1)}%
                      </b>
                      {" · "}P90{" "}
                      <b>
                        {(
                          overview?.traffic?.liquidationNotionalDistribution
                            ?.p90Notional ?? 0
                        ).toLocaleString("en-US", {
                          maximumFractionDigits: 0,
                        })} USDT
                      </b>
                    </span>
                    <span>
                      SELL 120秒累计{" "}
                      <b>
                        {(
                          overview?.traffic?.liquidationNotionalDistribution
                            ?.marketWindow120s?.sell?.currentNotional ?? 0
                        ).toLocaleString("en-US", {
                          maximumFractionDigits: 0,
                        })} USDT
                      </b>
                      {" · "}近1小时峰值{" "}
                      <b>
                        {(
                          overview?.traffic?.liquidationNotionalDistribution
                            ?.marketWindow120s?.sell?.peakNotional ?? 0
                        ).toLocaleString("en-US", {
                          maximumFractionDigits: 0,
                        })}
                      </b>
                      {" · "}触发{" "}
                      <b>
                        {overview?.traffic?.liquidationNotionalDistribution
                          ?.marketWindow120s?.sell?.triggerCount ?? 0} 次
                      </b>
                    </span>
                    <span>内部访问最多 <b>{overview?.traffic?.topInternalRequest?.method ?? "—"} {overview?.traffic?.topInternalRequest?.pathname ?? "—"}</b> · {overview?.traffic?.topInternalRequest?.internalRequests ?? 0} 次</span>
                    <span>上游访问最多 <b>{overview?.traffic?.topUpstreamRequest?.method ?? "—"} {overview?.traffic?.topUpstreamRequest?.pathname ?? "—"}</b> · {overview?.traffic?.topUpstreamRequest?.upstreamRequests ?? 0} 次</span>
                    <span>
                      K线最近1分钟 <b>{overview?.traffic?.klineWeightAudit?.estimatedWeight ?? 0} 权重 / {overview?.traffic?.klineWeightAudit?.upstreamRequests ?? 0} 次上游</b>
                      {" · "}观测额度 {overview?.traffic?.klineWeightAudit?.observationUtilizationPercent ?? 0}%
                      {" · "}连续高权重 {overview?.traffic?.klineWeightAudit?.continuousHighWeightMinutes ?? 0}/5 分钟
                      {" · "}连续高频K线 {overview?.traffic?.klineWeightAudit?.continuousHighKlineMinutes ?? 0}/5 分钟
                      {" · "}429/418 {overview?.traffic?.klineWeightAudit?.recent429Count ?? 0}/{overview?.traffic?.klineWeightAudit?.recent418Count ?? 0}
                      {" · "}重复上游 {overview?.traffic?.klineWeightAudit?.duplicateRequestGroupCount ?? 0} 组
                      {" · "}{overview?.traffic?.klineWeightAudit?.scheduleReviewRequired ? "达到证据门槛，需人工复核调度" : "仅观察，不调整调度"}
                    </span>
                  </div>
                </section>

                <section className="two-col">
                  <article className="panel strategy-panel">
                    <div className="panel-head">
                      <div>
                        <h2>策略运行状态</h2>
                        <p>
                          {overviewMetrics.runningStrategies} 个运行中 · 共{" "}
                          {overviewMetrics.totalStrategies} 个持久化策略
                        </p>
                      </div>
                      {canOpenPage("auto") && (
                        <button onClick={() => setActive("auto")}>
                          管理策略 →
                        </button>
                      )}
                    </div>
                    <div className="strategy-list">
                      {(overview?.strategies ?? []).map((strategy) => (
                        <div className="strategy-item" key={strategy.id}>
                          <span
                            className={`strategy-symbol ${strategy.status === "RUNNING" ? "cyan" : strategy.status === "BLOCKED" ? "red" : "amber"}`}
                          >
                            {strategy.strategyType === "GRID" ? "▦" : "ϟ"}
                          </span>
                          <div>
                            <b>{strategy.displayName ?? strategy.name}</b>
                            <small className="overview-strategy-summary">
                              {strategy.accountId} · {strategySymbolScopeSummary(strategy.symbolScope)} · 参数版本 v
                              {strategy.configVersion}
                            </small>
                          </div>
                          <span
                            className={
                              strategy.status === "RUNNING"
                                ? "running"
                                : "waiting"
                            }
                          >
                            <i></i>
                            {strategy.status === "RUNNING"
                              ? "运行中"
                              : strategy.status === "PAUSED"
                                ? "已暂停"
                                : strategy.status === "BLOCKED"
                                  ? "已阻断"
                                  : "草稿"}
                          </span>
                          {canOpenPage("auto") && (
                            <button
                              className="text-action"
                              onClick={() => setActive("auto")}
                            >
                              配置
                            </button>
                          )}
                        </div>
                      ))}
                      {!overviewBusy &&
                        overviewMetrics.totalStrategies === 0 && (
                          <div className="empty">
                            暂无策略，请前往策略自动下单创建
                          </div>
                        )}
                    </div>
                  </article>
                </section>

                <section className="bottom-row">
                  <article className="panel event-panel">
                    <div className="panel-head">
                      <div>
                        <h2>系统动态</h2>
                        <p>最近持久化的关键审计事件</p>
                      </div>
                      {canOpenPage("system") && (
                        <button onClick={() => setActive("system")}>
                          查看全部
                        </button>
                      )}
                    </div>
                    {(overview?.events ?? []).map((event) => (
                      <div className="event" key={event.id}>
                        <span
                          className={`event-dot ${event.action.includes("EMERGENCY") || event.action.includes("CIRCUIT") ? "warn" : "ok"}`}
                        ></span>
                        <time>
                          {new Date(event.createdAt).toLocaleTimeString(
                            "zh-CN",
                            { hour12: false },
                          )}
                        </time>
                        <div>
                          <b>{eventLabels[event.action] ?? event.action}</b>
                          <small>
                            {event.resourceType} · {event.resourceId}
                          </small>
                        </div>
                      </div>
                    ))}
                    {!overviewBusy && (overview?.events.length ?? 0) === 0 && (
                      <div className="empty">暂无关键操作记录</div>
                    )}
                  </article>
                  <article className="panel safety-panel">
                    <div className="panel-head">
                      <div>
                        <h2>交易控制权</h2>
                        <p>账户负责可用性，业务门禁由各策略版本参数决定</p>
                      </div>
                      <span
                        className="guard"
                      >
                        策略参数
                      </span>
                    </div>
                    <div className="safety-stat">
                      <span>下单限制来源</span>
                      <b>当前策略版本</b>
                    </div>
                    <div className="threshold">
                      <i
                        style={{
                          width: "100%",
                        }}
                      ></i>
                      <em
                        style={{
                          left: "100%",
                        }}
                      ></em>
                    </div>
                    <div className="safety-actions">
                      {canOpenPage("system") && (
                        <button onClick={() => setActive("system")}>
                          查看审计记录
                        </button>
                      )}
                      <button
                        className="danger-btn"
                    onClick={() => setToast("专用实盘全平通道尚未启用，请在仓位管理逐笔确认平仓")}
                      >
                        紧急全部平仓
                      </button>
                    </div>
                  </article>
                </section>
              </>
            )}
            <WorkspacePage
              active={active}
              setActive={setActive}
              setToast={setToast}
              marketRefreshVersion={marketRefreshVersion}
              workspaceRefreshVersion={workspaceRefreshVersion}
              strategyFocusId={strategyFocusId}
              strategyFocusMode={strategyFocusMode}
              marketFocus={marketFocus}
              strategyLogTabOpen={
                active === "strategyLogs" ||
                openTabs.includes("strategyLogs")
              }
            />
          </div>
        </section>

        {toast && (
          <div
            className={`toast ${isUrgentToast(toast) ? "error" : "success"}`}
            role={isUrgentToast(toast) ? "alert" : "status"}
            aria-live={isUrgentToast(toast) ? "assertive" : "polite"}
            aria-atomic="true"
          >
            <span aria-hidden="true">{isUrgentToast(toast) ? "!" : "✓"}</span>
            <p>{toast}</p>
            {lastClosedTab &&
              toast ===
                `已关闭${tabLabels[lastClosedTab] ?? lastClosedTab}页签` && (
                <button
                  className="toast-undo"
                  onClick={reopenClosedWorkspaceTab}
                >
                  重新打开
                </button>
              )}
            <button
              aria-label="关闭操作提示"
              onClick={() => {
                setToast("");
                setLastClosedTab(null);
              }}
            >
              ×
            </button>
          </div>
        )}
        {confirmClose && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="modal">
              <span className="modal-icon">!</span>
              <h2 id="modal-title">确认执行紧急平仓？</h2>
              <p>
                专用实盘全平通道尚未启用。请关闭本弹窗并前往仓位管理，逐笔核对 Binance 实际持仓后执行平仓。
              </p>
              <div>
                <button onClick={() => setConfirmClose(false)}>取消</button>
                <button className="danger-btn" onClick={executeEmergencyStop}>
                  确认执行
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </SecurityGate>
  );
}
