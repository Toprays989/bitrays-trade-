import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const contractSymbols = sqliteTable(
  "contract_symbols",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(),
    instrumentId: text("instrument_id"),
    venue: text("venue").notNull().default("BINANCE"),
    environment: text("environment").notNull().default("LIVE"),
    market: text("market").notNull().default("USDT_M"),
    contractType: text("contract_type").notNull().default("PERPETUAL"),
    listingGeneration: text("listing_generation").notNull().default("CURRENT"),
    ruleVersion: integer("rule_version").notNull().default(1),
    displayName: text("display_name").notNull(),
    source: text("source", {
      enum: [
        "MANUAL_INCLUDE",
        "MANUAL_PROTECT",
        "AUTO_FILTER",
        "MANUAL_EXCLUDE",
        "AUTO_VOLUME_EXCLUDE",
      ],
    }).notNull(),
    minOrderQty: real("min_order_qty").notNull(),
    quantityStep: real("quantity_step").notNull().default(0.00000001),
    minNotionalUsdt: real("min_notional_usdt").notNull().default(5),
    priceTickSize: real("price_tick_size").notNull().default(0.00000001),
    maxLeverage: integer("max_leverage"),
    leverageSyncedAt: integer("leverage_synced_at", { mode: "timestamp_ms" }),
    minVolume24h: real("min_volume_24h").notNull().default(15_000_000),
    lastPrice: real("last_price"),
    priceChangePercent: real("price_change_percent"),
    highPrice: real("high_price"),
    lowPrice: real("low_price"),
    quoteVolume24h: real("quote_volume_24h"),
    marketSyncedAt: integer("market_synced_at", { mode: "timestamp_ms" }),
    isProtected: integer("is_protected", { mode: "boolean" })
      .notNull()
      .default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("contract_symbols_symbol_uidx").on(table.symbol),
    uniqueIndex("contract_symbols_instrument_uidx").on(table.instrumentId),
  ],
);

export const strategies = sqliteTable(
  "strategies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainKey: text("brain_key"),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    brainTemplate: text("brain_template", {
      enum: [
        "LEGACY_LIQUIDATION",
        "NEXUS_MARKET_BRAIN",
        "TREND_BREAKOUT",
        "SUPPORT_REVERSAL",
        "DOWNTREND_CONTINUATION",
      ],
    })
      .notNull()
      .default("NEXUS_MARKET_BRAIN"),
    runtimeMode: text("runtime_mode", {
      enum: ["SHADOW", "CONFIRM_REQUIRED", "LIVE"],
    })
      .notNull()
      .default("LIVE"),
    strategyType: text("strategy_type", {
      enum: [
        "GRID",
        "LIQ_CHASE",
        "SHORT_CONTINUATION",
        "SENTINEL",
        "BREAKOUT",
        "SIMPLE_REBOUND",
      ],
    }).notNull(),
    symbolScope: text("symbol_scope").notNull(),
    configJson: text("config_json").notNull().default("{}"),
    configVersion: integer("config_version").notNull().default(1),
    publishedVersion: integer("published_version").notNull().default(1),
    draftName: text("draft_name"),
    draftAccountId: text("draft_account_id"),
    draftSymbolScope: text("draft_symbol_scope"),
    draftConfigJson: text("draft_config_json"),
    draftVersion: integer("draft_version").notNull().default(0),
    draftUpdatedAt: integer("draft_updated_at", { mode: "timestamp_ms" }),
    status: text("status", {
      enum: [
        "DRAFT",
        "READY",
        "RUNNING",
        "PAUSED",
        "DRAINING",
        "BLOCKED",
        "ERROR",
        "ARCHIVED",
      ],
    })
      .notNull()
      .default("DRAFT"),
    lastHealthyAt: integer("last_healthy_at", { mode: "timestamp_ms" }),
    backtestLeaseToken: text("backtest_lease_token"),
    backtestLeaseUntil: integer("backtest_lease_until", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategies_brain_key_uidx").on(table.brainKey),
    index("strategies_owner_idx").on(table.ownerEmail, table.updatedAt),
    index("strategies_auth_routing_idx").on(
      table.accountId,
      table.symbolScope,
      table.createdAt,
    ),
  ],
);

/**
 * Simple Rebound owns its five-seat lifecycle independently from legacy
 * strategy traces.  Rows only exist for occupied seats; releasing a seat
 * deletes the row, so restart recovery is deterministic and bounded.
 */
export const simpleReboundSlots = sqliteTable(
  "simple_rebound_slots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    strategyId: integer("strategy_id").notNull(),
    slotId: integer("slot_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    symbol: text("symbol").notNull(),
    entryPrice: real("entry_price").notNull(),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }).notNull(),
    traceId: text("trace_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("simple_rebound_slots_strategy_slot_uidx").on(
      table.strategyId,
      table.slotId,
    ),
    uniqueIndex("simple_rebound_slots_strategy_symbol_uidx").on(
      table.strategyId,
      table.symbol,
    ),
    index("simple_rebound_slots_strategy_idx").on(
      table.strategyId,
      table.updatedAt,
    ),
  ],
);

export const strategyConfigVersions = sqliteTable(
  "strategy_config_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    strategyId: integer("strategy_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    version: integer("version").notNull(),
    sourceVersion: integer("source_version"),
    versionLabel: text("version_label"),
    note: text("note"),
    isBaseline: integer("is_baseline", { mode: "boolean" })
      .notNull()
      .default(false),
    lifecycle: text("lifecycle", {
      enum: ["DRAFT", "PUBLISHED", "RETIRED"],
    })
      .notNull()
      .default("PUBLISHED"),
    strategyType: text("strategy_type", {
      enum: [
        "GRID",
        "LIQ_CHASE",
        "SHORT_CONTINUATION",
        "SENTINEL",
        "BREAKOUT",
        "SIMPLE_REBOUND",
      ],
    }).notNull(),
    symbolScope: text("symbol_scope").notNull(),
    configJson: text("config_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_config_versions_strategy_version_uidx").on(
      table.strategyId,
      table.version,
    ),
    index("strategy_config_versions_owner_idx").on(
      table.ownerEmail,
      table.createdAt,
    ),
  ],
);

export const strategyConfigValidations = sqliteTable(
  "strategy_config_validations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    strategyId: integer("strategy_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    brainKey: text("brain_key").notNull(),
    candidateVersion: integer("candidate_version").notNull(),
    baselineVersion: integer("baseline_version").notNull(),
    suggestionIdsJson: text("suggestion_ids_json").notNull().default("[]"),
    status: text("status", {
      enum: [
        "COLLECTING",
        "PROMOTION_READY",
        "PROMOTED",
        "ROLLBACK_REQUIRED",
        "ROLLED_BACK",
        "RELEARNING",
      ],
    })
      .notNull()
      .default("COLLECTING"),
    evaluationJson: text("evaluation_json").notNull().default("{}"),
    lastEvaluatedAt: integer("last_evaluated_at", {
      mode: "timestamp_ms",
    }),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_config_validations_candidate_uidx").on(
      table.strategyId,
      table.candidateVersion,
    ),
    index("strategy_config_validations_status_idx").on(
      table.status,
      table.updatedAt,
    ),
    index("strategy_config_validations_owner_idx").on(
      table.ownerEmail,
      table.updatedAt,
    ),
  ],
);

export const strategyExecutionTraces = sqliteTable(
  "strategy_execution_traces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    traceId: text("trace_id").notNull(),
    strategyId: integer("strategy_id").notNull(),
    strategyRunId: text("strategy_run_id").notNull(),
    configVersion: integer("config_version").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    symbol: text("symbol").notNull(),
    /** Authoritative trigger identity. Legacy liquidation columns below remain
     * populated for old rows but must not be used to infer a new trigger. */
    triggerKind: text("trigger_kind").notNull().default("LIQUIDATION_WINDOW"),
    triggerVersion: text("trigger_version")
      .notNull()
      .default("liquidation-window-trigger-v1"),
    triggerDirection: text("trigger_direction", {
      enum: ["LONG", "SHORT"],
    })
      .notNull()
      .default("LONG"),
    triggerReferencePrice: real("trigger_reference_price")
      .notNull()
      .default(0),
    triggerFactSnapshotId: text("trigger_fact_snapshot_id"),
    triggerSourceId: text("trigger_source_id"),
    liquidationSide: text("liquidation_side", {
      enum: ["BUY", "SELL"],
    }).notNull(),
    liquidationPrice: real("liquidation_price").notNull(),
    liquidationNotional: real("liquidation_notional").notNull(),
    eventTime: integer("event_time", { mode: "timestamp_ms" }).notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    state: text("state", {
      enum: [
        "TRIGGERED",
        "ANALYZING",
        "ARMED",
        "ORDER_READY",
        "ORDER_PENDING",
        "POSITION_OPEN",
        "TRAILING_ARMED",
        "TRAILING_ACTIVE",
        "EXIT_PENDING",
        "MONITOR_READY",
        "CLOSED",
        "EXPIRED",
        "REJECTED",
        "CANCELED",
        "DATA_STALE",
        "EXECUTION_UNKNOWN",
      ],
    })
      .notNull()
      .default("TRIGGERED"),
    resultCode: text("result_code"),
    resultMessage: text("result_message"),
    configSnapshotJson: text("config_snapshot_json").notNull().default("{}"),
    entryEvidenceJson: text("entry_evidence_json").notNull().default("{}"),
    exchangeOrderId: text("exchange_order_id"),
    positionId: text("position_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("strategy_execution_traces_trace_uidx").on(table.traceId),
    index("strategy_execution_traces_strategy_idx").on(
      table.strategyId,
      table.createdAt,
    ),
    index("strategy_execution_traces_lock_idx").on(
      table.accountId,
      table.strategyId,
      table.symbol,
      table.state,
    ),
    index("strategy_execution_traces_result_idx").on(
      table.strategyId,
      table.resultCode,
      table.createdAt,
    ),
    index("strategy_execution_traces_runtime_state_idx").on(
      table.state,
      table.expiresAt,
      table.updatedAt,
    ),
  ],
);

export const strategyExecutionEvents = sqliteTable(
  "strategy_execution_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    traceId: text("trace_id").notNull(),
    strategyId: integer("strategy_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    stage: text("stage", {
      enum: [
        "SIGNAL",
        "POSITION",
        "TREND_1H",
        "STRUCTURE_30M",
        "LIQUIDITY_SWEEP_5M",
        "RECLAIM_5M",
        "ENTRY_3M",
        "ORDER",
        "POSITION_MANAGEMENT",
      ],
    }).notNull(),
    outcome: text("outcome", {
      enum: ["PASSED", "PENDING", "REJECTED", "INFO", "ERROR"],
    }).notNull(),
    message: text("message").notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
    eventAt: integer("event_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_execution_events_trace_sequence_uidx").on(
      table.traceId,
      table.sequence,
    ),
    index("strategy_execution_events_strategy_idx").on(
      table.strategyId,
      table.createdAt,
    ),
  ],
);

/**
 * Deduplicated full eye facts. Terminal traces replace repeated embedded fact
 * payloads with these immutable fact ids only after this snapshot exists.
 */
export const nexusEyeFactSnapshots = sqliteTable(
  "nexus_eye_fact_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    factId: text("fact_id").notNull(),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    interval: text("interval"),
    source: text("source").notNull(),
    eventAt: integer("event_at", { mode: "timestamp_ms" }).notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    factJson: text("fact_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("nexus_eye_fact_snapshots_fact_uidx").on(table.factId),
    index("nexus_eye_fact_snapshots_symbol_time_idx").on(
      table.symbol,
      table.eventAt,
    ),
    index("nexus_eye_fact_snapshots_kind_time_idx").on(
      table.kind,
      table.eventAt,
    ),
  ],
);

/** Compact, exact occurrence rollup for verbose strategy event history. */
export const strategyExecutionEventRollups = sqliteTable(
  "strategy_execution_event_rollups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    traceId: text("trace_id").notNull(),
    strategyId: integer("strategy_id").notNull(),
    configVersion: integer("config_version").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    eventType: text("event_type").notNull(),
    stage: text("stage").notNull(),
    outcome: text("outcome").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    firstEventAt: integer("first_event_at", { mode: "timestamp_ms" })
      .notNull(),
    lastEventAt: integer("last_event_at", { mode: "timestamp_ms" })
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_execution_event_rollups_key_uidx").on(
      table.traceId,
      table.eventType,
      table.outcome,
    ),
    index("strategy_execution_event_rollups_strategy_time_idx").on(
      table.ownerEmail,
      table.strategyId,
      table.lastEventAt,
    ),
    index("strategy_execution_event_rollups_event_time_idx").on(
      table.ownerEmail,
      table.eventType,
      table.lastEventAt,
    ),
    index("strategy_execution_event_rollups_owner_time_idx").on(
      table.ownerEmail,
      table.lastEventAt,
    ),
  ],
);

export const strategyEventRetentionState = sqliteTable(
  "strategy_event_retention_state",
  {
    id: integer("id").primaryKey(),
    rollupStartedAt: integer("rollup_started_at", {
      mode: "timestamp_ms",
    }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
);

/**
 * Permanent lifecycle receipt used before verbose no-order events may leave
 * the hot database. Real order/position lifecycles never use the delete lane.
 */
export const strategyExecutionSummaries = sqliteTable(
  "strategy_execution_summaries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    traceId: text("trace_id").notNull(),
    traceDatabaseId: integer("trace_database_id").notNull(),
    strategyId: integer("strategy_id").notNull(),
    configVersion: integer("config_version").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    symbol: text("symbol").notNull(),
    triggerKind: text("trigger_kind").notNull().default("LIQUIDATION_WINDOW"),
    triggerVersion: text("trigger_version")
      .notNull()
      .default("liquidation-window-trigger-v1"),
    triggerFactSnapshotId: text("trigger_fact_snapshot_id"),
    terminalState: text("terminal_state").notNull(),
    resultCode: text("result_code"),
    resultMessage: text("result_message"),
    eventTime: integer("event_time", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
    hadOrder: integer("had_order", { mode: "boolean" }).notNull().default(false),
    hadPosition: integer("had_position", { mode: "boolean" }).notNull().default(false),
    learningStatus: text("learning_status", {
      enum: ["NOT_REQUIRED", "MISSING", "INCOMPLETE", "FINALIZED"],
    }).notNull(),
    eyeDecisionJson: text("eye_decision_json").notNull().default("{}"),
    marketFactIdsJson: text("market_fact_ids_json").notNull().default("[]"),
    keyEventsJson: text("key_events_json").notNull().default("[]"),
    archiveJson: text("archive_json").notNull().default("{}"),
    rawEventCount: integer("raw_event_count").notNull().default(0),
    rawEventBytes: integer("raw_event_bytes").notNull().default(0),
    rawEvidenceBytes: integer("raw_evidence_bytes").notNull().default(0),
    compactEvidenceBytes: integer("compact_evidence_bytes").notNull().default(0),
    sourceChecksum: text("source_checksum").notNull(),
    archiveVersion: integer("archive_version").notNull().default(1),
    rawEventsDeletedAt: integer("raw_events_deleted_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_execution_summaries_trace_uidx").on(table.traceId),
    uniqueIndex("strategy_execution_summaries_trace_db_uidx").on(
      table.traceDatabaseId,
    ),
    index("strategy_execution_summaries_cleanup_idx").on(
      table.rawEventsDeletedAt,
      table.completedAt,
      table.learningStatus,
    ),
    index("strategy_execution_summaries_strategy_time_idx").on(
      table.ownerEmail,
      table.strategyId,
      table.completedAt,
    ),
  ],
);

export const semiAutoAnalyses = sqliteTable(
  "semi_auto_analyses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    strategyId: integer("strategy_id").notNull(),
    brainKey: text("brain_key").notNull(),
    configVersion: integer("config_version").notNull(),
    symbol: text("symbol").notNull(),
    positionSide: text("position_side", {
      enum: ["LONG", "SHORT"],
    }).notNull(),
    horizon: text("horizon", {
      enum: ["SCALP", "INTRADAY", "SWING"],
    }).notNull(),
    thesis: text("thesis").notNull(),
    verdict: text("verdict", {
      enum: ["EXECUTABLE", "WAIT", "REJECTED", "INSUFFICIENT"],
    }).notNull(),
    summary: text("summary").notNull(),
    analysisVersion: text("analysis_version").notNull(),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    planJson: text("plan_json"),
    liveOrderEventId: integer("live_order_event_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("semi_auto_analyses_owner_created_idx").on(
      table.ownerEmail,
      table.createdAt,
    ),
    index("semi_auto_analyses_strategy_idx").on(
      table.strategyId,
      table.createdAt,
    ),
    index("semi_auto_analyses_order_idx").on(table.liveOrderEventId),
  ],
);

export const executionIntents = sqliteTable(
  "execution_intents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    intentKey: text("intent_key").notNull(),
    strategyId: integer("strategy_id").notNull(),
    brainKey: text("brain_key").notNull(),
    configVersion: integer("config_version").notNull(),
    traceId: text("trace_id").notNull(),
    intentPurpose: text("intent_purpose", {
      enum: [
        "OPEN_POSITION",
        "INCREASE_POSITION",
        "REDUCE_POSITION",
        "CLOSE_POSITION",
      ],
    }).notNull().default("OPEN_POSITION"),
    authoritySource: text("authority_source", {
      enum: [
        "ENTRY_BRAIN",
        "POSITION_BRAIN",
        "EMERGENCY_PROTECTION",
        "MANUAL_OPERATOR",
      ],
    }).notNull().default("ENTRY_BRAIN"),
    positionHandoffKey: text("position_handoff_key"),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    symbol: text("symbol").notNull(),
    positionSide: text("position_side", {
      enum: ["LONG", "SHORT"],
    }).notNull(),
    orderType: text("order_type", {
      enum: ["MARKET", "LIMIT"],
    }).notNull(),
    quantity: real("quantity").notNull(),
    limitPrice: real("limit_price"),
    requiredMarginUsdt: real("required_margin_usdt").notNull(),
    riskBudgetUsdt: real("risk_budget_usdt").notNull().default(0),
    reservedMarginUsdt: real("reserved_margin_usdt").notNull().default(0),
    priority: real("priority").notNull().default(0),
    status: text("status", {
      enum: [
        "PROPOSED",
        "SELECTED",
        "RESERVED",
        "SUBMITTING",
        "SUBMITTED",
        "PARTIALLY_FILLED",
        "FILLED",
        "CANCEL_REQUESTED",
        "CANCELED",
        "REJECTED",
        "EXECUTION_UNKNOWN",
        "CONFLICTED",
        "EXPIRED",
      ],
    })
      .notNull()
      .default("PROPOSED"),
    reasonCode: text("reason_code"),
    reasonMessage: text("reason_message"),
    conflictKey: text("conflict_key").notNull(),
    reservationKey: text("reservation_key"),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    liveOrderEventId: integer("live_order_event_id"),
    livePositionId: integer("live_position_id"),
    filledQuantity: real("filled_quantity").notNull().default(0),
    observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("execution_intents_key_uidx").on(table.intentKey),
    uniqueIndex("execution_intents_reservation_uidx").on(table.reservationKey),
    index("execution_intents_conflict_idx").on(
      table.accountId,
      table.symbol,
      table.status,
    ),
    index("execution_intents_strategy_idx").on(
      table.strategyId,
      table.createdAt,
    ),
    index("execution_intents_recovery_idx").on(
      table.status,
      table.leaseUntil,
    ),
    index("execution_intents_domain_idx").on(
      table.intentPurpose,
      table.authoritySource,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const portfolioRiskStates = sqliteTable(
  "portfolio_risk_states",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    peakAccountEquityUsdt: real("peak_account_equity_usdt")
      .notNull()
      .default(0),
    lastAccountEquityUsdt: real("last_account_equity_usdt")
      .notNull()
      .default(0),
    lastDrawdownPercent: real("last_drawdown_percent").notNull().default(0),
    accountDrawdownPhase: text("account_drawdown_phase", {
      enum: ["NORMAL", "DEFENSIVE", "HARD_STOP"],
    })
      .notNull()
      .default("NORMAL"),
    accountDrawdownAnalysisJson: text("account_drawdown_analysis_json")
      .notNull()
      .default("{}"),
    accountDrawdownActionPositionIdsJson: text(
      "account_drawdown_action_position_ids_json",
    )
      .notNull()
      .default("[]"),
    accountDrawdownTriggeredAt: integer("account_drawdown_triggered_at", {
      mode: "timestamp_ms",
    }),
    accountDrawdownLastActionAt: integer("account_drawdown_last_action_at", {
      mode: "timestamp_ms",
    }),
    operatorRearmRequired: integer("operator_rearm_required", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    dailyWindowStartedAt: integer("daily_window_started_at", {
      mode: "timestamp_ms",
    }),
    dailyStartUnrealizedPnl: real("daily_start_unrealized_pnl"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("portfolio_risk_states_account_uidx").on(
      table.ownerEmail,
      table.accountId,
    ),
  ],
);

export const strategyPositionEvidence = sqliteTable(
  "strategy_position_evidence",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    traceId: text("trace_id").notNull(),
    strategyId: integer("strategy_id").notNull(),
    minuteOffset: integer("minute_offset").notNull(),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }).notNull(),
    sampledAt: integer("sampled_at", { mode: "timestamp_ms" }),
    sampleDelayMs: integer("sample_delay_ms"),
    status: text("status", {
      enum: ["OPEN", "CLOSED", "MISSED", "DATA_STALE"],
    }).notNull(),
    markPrice: real("mark_price"),
    entryPrice: real("entry_price").notNull(),
    remainingQty: real("remaining_qty").notNull(),
    unrealizedPnl: real("unrealized_pnl"),
    netPnlEstimate: real("net_pnl_estimate"),
    roePercent: real("roe_percent"),
    mfeRoePercent: real("mfe_roe_percent"),
    maeRoePercent: real("mae_roe_percent"),
    volumeRatio3m: real("volume_ratio_3m"),
    atr5m: real("atr_5m"),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_position_evidence_trace_minute_uidx").on(
      table.traceId,
      table.minuteOffset,
    ),
    index("strategy_position_evidence_strategy_idx").on(
      table.strategyId,
      table.createdAt,
    ),
  ],
);

export const strategyLearningCycles = sqliteTable(
  "strategy_learning_cycles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    learningKey: text("learning_key").notNull(),
    strategyId: integer("strategy_id").notNull(),
    brainKey: text("brain_key").notNull(),
    configVersion: integer("config_version").notNull(),
    traceId: text("trace_id").notNull(),
    path: text("path", {
      enum: [
        "ACTUAL_POSITION",
        "REJECTED_COUNTERFACTUAL",
        "MANUAL_INTERVENTION",
      ],
    }).notNull(),
    orderSource: text("order_source", {
      enum: ["STRATEGY", "SEMI_AUTO", "MANUAL"],
    }).notNull(),
    manualIntervention: integer("manual_intervention", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    preTradeFactsComplete: integer("pre_trade_facts_complete", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    checkpointMinutesJson: text("checkpoint_minutes_json")
      .notNull()
      .default("[]"),
    terminalStatus: text("terminal_status", {
      enum: ["OPEN", "CLOSED", "REJECTED"],
    })
      .notNull()
      .default("OPEN"),
    exactNetAvailable: integer("exact_net_available", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    exactNetPnlUsdt: real("exact_net_pnl_usdt"),
    eligibility: text("eligibility", {
      enum: ["ELIGIBLE", "OBSERVATION_ONLY", "INCOMPLETE"],
    })
      .notNull()
      .default("INCOMPLETE"),
    blockedReasonsJson: text("blocked_reasons_json")
      .notNull()
      .default("[]"),
    sourceSampleKeysJson: text("source_sample_keys_json")
      .notNull()
      .default("[]"),
    detailJson: text("detail_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_learning_cycles_key_uidx").on(table.learningKey),
    index("strategy_learning_cycles_strategy_idx").on(
      table.strategyId,
      table.configVersion,
      table.eligibility,
    ),
    index("strategy_learning_cycles_brain_idx").on(
      table.brainKey,
      table.configVersion,
      table.updatedAt,
    ),
    index("strategy_learning_cycles_trace_idx").on(table.traceId),
  ],
);

export const strategyLearningReviews = sqliteTable(
  "strategy_learning_reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    learningKey: text("learning_key").notNull(),
    strategyId: integer("strategy_id").notNull(),
    brainKey: text("brain_key").notNull(),
    configVersion: integer("config_version").notNull(),
    traceId: text("trace_id").notNull(),
    decision: text("decision", {
      enum: ["CONFIRMED", "NOISE", "DEFERRED"],
    }).notNull(),
    promotionStatus: text("promotion_status", {
      enum: ["PROVISIONAL", "PROMOTED", "IGNORED", "DEFERRED"],
    }).notNull(),
    memoryVersion: integer("memory_version"),
    sampleUpdatedAt: integer("sample_updated_at", {
      mode: "timestamp_ms",
    }).notNull(),
    exactNetAvailable: integer("exact_net_available", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    exactNetPnlUsdt: real("exact_net_pnl_usdt"),
    outcome: text("outcome", {
      enum: ["WIN", "LOSS", "BREAKEVEN", "UNAVAILABLE"],
    })
      .notNull()
      .default("UNAVAILABLE"),
    evidenceComplete: integer("evidence_complete", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    reviewComment: text("review_comment"),
    reviewedBy: text("reviewed_by").notNull(),
    experienceJson: text("experience_json").notNull().default("{}"),
    capabilityBeforeJson: text("capability_before_json")
      .notNull()
      .default("{}"),
    capabilityAfterJson: text("capability_after_json")
      .notNull()
      .default("{}"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("strategy_learning_reviews_key_uidx").on(table.learningKey),
    index("strategy_learning_reviews_strategy_idx").on(
      table.strategyId,
      table.configVersion,
      table.decision,
      table.updatedAt,
    ),
    uniqueIndex("strategy_learning_reviews_brain_version_uidx").on(
      table.brainKey,
      table.configVersion,
      table.memoryVersion,
    ),
  ],
);

export const backgroundRepairTasks = sqliteTable(
  "background_repair_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    taskType: text("task_type", {
      enum: ["ACTUAL_POSITION_EVIDENCE"],
    }).notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    status: text("status", {
      enum: ["PENDING", "RETRY_WAIT", "COMPLETED", "TERMINAL"],
    })
      .notNull()
      .default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", {
      mode: "timestamp_ms",
    }).notNull(),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    resultJson: text("result_json").notNull().default("{}"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("background_repair_tasks_resource_uidx").on(
      table.taskType,
      table.resourceType,
      table.resourceId,
    ),
    index("background_repair_tasks_due_idx").on(
      table.taskType,
      table.status,
      table.nextAttemptAt,
    ),
    index("background_repair_tasks_owner_idx").on(
      table.ownerEmail,
      table.updatedAt,
    ),
  ],
);

export const strategyParameterSuggestions = sqliteTable(
  "strategy_parameter_suggestions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    strategyId: integer("strategy_id").notNull(),
    configVersion: integer("config_version").notNull(),
    sampleCount: integer("sample_count").notNull(),
    parameterName: text("parameter_name").notNull(),
    currentValueJson: text("current_value_json").notNull().default("null"),
    suggestedValueJson: text("suggested_value_json").notNull().default("null"),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    status: text("status", {
      enum: ["PENDING", "ACCEPTED", "REJECTED", "EXPIRED"],
    })
      .notNull()
      .default("PENDING"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("strategy_parameter_suggestions_strategy_idx").on(
      table.strategyId,
      table.configVersion,
      table.createdAt,
    ),
  ],
);

export const positionReductions = sqliteTable(
  "position_reductions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    positionId: integer("position_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    sourceOrderId: integer("source_order_id").notNull(),
    symbol: text("symbol").notNull(),
    positionSide: text("position_side", { enum: ["LONG", "SHORT"] }).notNull(),
    quantity: real("quantity").notNull(),
    entryPrice: real("entry_price").notNull(),
    exitPrice: real("exit_price").notNull(),
    realizedPnl: real("realized_pnl").notNull(),
    reason: text("reason", {
      enum: ["MANUAL_PARTIAL", "TAKE_PROFIT_PARTIAL", "STOP_LOSS_PARTIAL"],
    })
      .notNull()
      .default("MANUAL_PARTIAL"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("position_reductions_owner_idx").on(
      table.ownerEmail,
      table.createdAt,
    ),
    index("position_reductions_position_idx").on(
      table.positionId,
      table.createdAt,
    ),
  ],
);

export const exchangeOrders = sqliteTable(
  "exchange_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    shadowOrderId: integer("shadow_order_id").notNull(),
    clientOrderId: text("client_order_id").notNull(),
    exchangeOrderId: text("exchange_order_id"),
    status: text("status", {
      enum: [
        "PENDING",
        "TEST_ACCEPTED",
        "SUBMITTED",
        "PARTIAL",
        "FILLED",
        "REJECTED",
        "CANCELED",
      ],
    })
      .notNull()
      .default("PENDING"),
    cumulativeQty: real("cumulative_qty").notNull().default(0),
    averagePrice: real("average_price").notNull().default(0),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    terminalAt: integer("terminal_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("exchange_orders_client_order_uidx").on(table.clientOrderId),
    index("exchange_orders_shadow_idx").on(table.shadowOrderId),
    index("exchange_orders_auth_routing_idx").on(
      table.accountId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const rateLimitBuckets = sqliteTable(
  "rate_limit_buckets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    exchange: text("exchange").notNull().default("BINANCE"),
    usedWeight: integer("used_weight").notNull().default(0),
    limitWeight: integer("limit_weight").notNull().default(2350),
    reservedTradingWeight: integer("reserved_trading_weight")
      .notNull()
      .default(470),
    windowStartedAt: integer("window_started_at", {
      mode: "timestamp_ms",
    }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("rate_limit_bucket_account_uidx").on(
      table.ownerEmail,
      table.accountId,
      table.exchange,
    ),
  ],
);

export const tradingAccounts = sqliteTable(
  "trading_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    accountType: text("account_type", { enum: ["MAIN", "STRATEGY"] })
      .notNull()
      .default("STRATEGY"),
    executionMode: text("execution_mode", { enum: ["SIMULATION", "LIVE"] })
      .notNull()
      .default("LIVE"),
    operatorName: text("operator_name").notNull().default("管理员"),
    note: text("note"),
    equityLimit: real("equity_limit").notNull().default(10_000),
    reservePercent: real("reserve_percent").notNull().default(10),
    dailyLossLimitPercent: real("daily_loss_limit_percent")
      .notNull()
      .default(5),
    maxSymbolMarginPercent: real("max_symbol_margin_percent")
      .notNull()
      .default(35),
    maxOpenPositions: integer("max_open_positions").notNull().default(10),
    maxPendingOrders: integer("max_pending_orders").notNull().default(20),
    riskLocked: integer("risk_locked", { mode: "boolean" })
      .notNull()
      .default(false),
    riskLockReason: text("risk_lock_reason"),
    riskLockedAt: integer("risk_locked_at", { mode: "timestamp_ms" }),
    maxLeverage: integer("max_leverage").notNull().default(5),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("trading_accounts_owner_account_uidx").on(
      table.ownerEmail,
      table.accountId,
    ),
    index("trading_accounts_owner_idx").on(table.ownerEmail, table.updatedAt),
  ],
);

export const exchangeCredentials = sqliteTable(
  "exchange_credentials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    exchange: text("exchange", { enum: ["BINANCE_USDM"] })
      .notNull()
      .default("BINANCE_USDM"),
    environment: text("environment", { enum: ["LIVE"] })
      .notNull()
      .default("LIVE"),
    label: text("label").notNull(),
    apiKeyCiphertext: text("api_key_ciphertext").notNull(),
    apiKeyIv: text("api_key_iv").notNull(),
    secretKeyCiphertext: text("secret_key_ciphertext").notNull(),
    secretKeyIv: text("secret_key_iv").notNull(),
    apiKeyMask: text("api_key_mask").notNull(),
    allowedSymbolsJson: text("allowed_symbols_json")
      .notNull()
      .default('["BTCUSDT"]'),
    maxOrderNotionalUsdt: real("max_order_notional_usdt").notNull().default(20),
    maxDailyNotionalUsdt: real("max_daily_notional_usdt")
      .notNull()
      .default(100),
    maxLeverage: integer("max_leverage").notNull().default(2),
    liveTradingEnabled: integer("live_trading_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    connectionStatus: text("connection_status", {
      enum: ["UNVERIFIED", "VERIFIED", "FAILED"],
    })
      .notNull()
      .default("UNVERIFIED"),
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    totalWalletBalance: real("total_wallet_balance"),
    totalUnrealizedProfit: real("total_unrealized_profit"),
    totalMarginBalance: real("total_margin_balance"),
    totalPositionInitialMargin: real("total_position_initial_margin"),
    totalOpenOrderInitialMargin: real("total_open_order_initial_margin"),
    availableBalance: real("available_balance"),
    balanceSyncedAt: integer("balance_synced_at", { mode: "timestamp_ms" }),
    positionMode: text("position_mode", { enum: ["ONE_WAY", "HEDGE"] }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("exchange_credentials_owner_account_uidx").on(
      table.ownerEmail,
      table.accountId,
    ),
    index("exchange_credentials_owner_idx").on(
      table.ownerEmail,
      table.updatedAt,
    ),
  ],
);

export const liveOrderEvents = sqliteTable(
  "live_order_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    credentialId: integer("credential_id").notNull(),
    clientOrderId: text("client_order_id").notNull(),
    exchangeOrderId: text("exchange_order_id"),
    symbol: text("symbol").notNull(),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    positionSide: text("position_side", { enum: ["LONG", "SHORT"] }).notNull(),
    orderType: text("order_type", { enum: ["MARKET", "LIMIT"] })
      .notNull()
      .default("MARKET"),
    quantity: real("quantity").notNull(),
    referencePrice: real("reference_price").notNull(),
    estimatedNotional: real("estimated_notional").notNull(),
    testOnly: integer("test_only", { mode: "boolean" }).notNull().default(true),
    status: text("status", {
      enum: [
        "PENDING",
        "TEST_ACCEPTED",
        "SUBMITTED",
        "NEW",
        "PARTIALLY_FILLED",
        "FILLED",
        "CANCEL_PENDING",
        "CANCELED",
        "EXPIRED",
        "REJECTED",
        "EXECUTION_UNKNOWN",
      ],
    })
      .notNull()
      .default("PENDING"),
    responseJson: text("response_json").notNull().default("{}"),
    lifecycleId: text("lifecycle_id"),
    entryDecisionHandoffJson: text("entry_decision_handoff_json")
      .notNull()
      .default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("live_order_events_client_uidx").on(table.clientOrderId),
    index("live_order_events_daily_limit_idx").on(
      table.ownerEmail,
      table.accountId,
      table.createdAt,
    ),
    index("live_order_events_owner_created_idx").on(
      table.ownerEmail,
      table.createdAt,
    ),
    index("live_order_events_owner_id_idx").on(
      table.ownerEmail,
      table.id,
    ),
    index("live_order_events_active_idx").on(
      table.ownerEmail,
      table.testOnly,
      table.status,
      table.accountId,
      table.updatedAt,
    ),
    index("live_order_events_lifecycle_idx").on(table.lifecycleId),
  ],
);

/**
 * Exact minute-level order read model maintained by SQLite triggers. High
 * volume dashboards and reports aggregate these compact rows instead of
 * repeatedly loading the immutable order ledger and response payloads.
 */
export const liveOrderMetricBuckets = sqliteTable(
  "live_order_metric_buckets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    strategyId: integer("strategy_id").notNull().default(0),
    configVersion: integer("config_version").notNull().default(0),
    bucketStartedAt: integer("bucket_started_at", { mode: "timestamp_ms" })
      .notNull(),
    orderCount: integer("order_count").notNull().default(0),
    pendingOrderCount: integer("pending_order_count").notNull().default(0),
    submittedOrderCount: integer("submitted_order_count").notNull().default(0),
    filledOrderCount: integer("filled_order_count").notNull().default(0),
    canceledOrderCount: integer("canceled_order_count").notNull().default(0),
    rejectedOrderCount: integer("rejected_order_count").notNull().default(0),
    executionUnknownOrderCount: integer("execution_unknown_order_count")
      .notNull()
      .default(0),
    orderNotional: real("order_notional").notNull().default(0),
    filledOrderNotional: real("filled_order_notional").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("live_order_metric_buckets_key_uidx").on(
      table.ownerEmail,
      table.accountId,
      table.strategyId,
      table.configVersion,
      table.bucketStartedAt,
    ),
    index("live_order_metric_buckets_owner_time_idx").on(
      table.ownerEmail,
      table.bucketStartedAt,
    ),
    index("live_order_metric_buckets_account_time_idx").on(
      table.ownerEmail,
      table.accountId,
      table.bucketStartedAt,
    ),
  ],
);

/**
 * Read-only execution-price counterfactuals. These rows never enter an order
 * coordinator and cannot change quantity, direction, leverage or risk plans.
 */
export const executionQuoteShadows = sqliteTable(
  "execution_quote_shadows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recordKey: text("record_key").notNull(),
    quoteRole: text("quote_role", {
      enum: ["ENTRY", "ADD", "EXIT"],
    }).notNull(),
    liveOrderEventId: integer("live_order_event_id"),
    positionId: integer("position_id"),
    positionAdditionId: integer("position_addition_id"),
    clientOrderId: text("client_order_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    strategyId: integer("strategy_id"),
    traceId: text("trace_id"),
    origin: text("origin", {
      enum: ["MANUAL", "SEMI_AUTO", "STRATEGY_LONG", "STRATEGY_SHORT"],
    }).notNull(),
    symbol: text("symbol").notNull(),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    positionSide: text("position_side", {
      enum: ["LONG", "SHORT"],
    }).notNull(),
    actualOrderType: text("actual_order_type", {
      enum: ["MARKET", "LIMIT"],
    }).notNull(),
    actualRequestedPrice: real("actual_requested_price").notNull(),
    decisionMarkPrice: real("decision_mark_price").notNull(),
    executableReferencePrice: real("executable_reference_price").notNull(),
    atr5m: real("atr_5m"),
    priceTickSize: real("price_tick_size").notNull(),
    shadowReservationPrice: real("shadow_reservation_price").notNull(),
    shadowQuotePrice: real("shadow_quote_price").notNull(),
    actualDistanceBps: real("actual_distance_bps").notNull(),
    shadowDistanceBps: real("shadow_distance_bps").notNull(),
    theoreticalImprovementBps: real("theoretical_improvement_bps").notNull(),
    shadowImmediatelyMarketable: integer("shadow_immediately_marketable", {
      mode: "boolean",
    }).notNull().default(false),
    modelVersion: text("model_version").notNull(),
    modelJson: text("model_json").notNull().default("{}"),
    operatorVerdict: text("operator_verdict", {
      enum: [
        "UNREVIEWED",
        "KEEP_EXISTING",
        "PREFER_SHADOW",
        "NEEDS_INVESTIGATION",
      ],
    }).notNull().default("UNREVIEWED"),
    operatorComment: text("operator_comment"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("execution_quote_shadows_record_uidx").on(
      table.recordKey,
    ),
    index("execution_quote_shadows_owner_created_idx").on(
      table.ownerEmail,
      table.createdAt,
    ),
    index("execution_quote_shadows_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
  ],
);

export const livePositions = sqliteTable(
  "live_positions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    credentialId: integer("credential_id").notNull(),
    sourceEventId: integer("source_event_id").notNull(),
    symbol: text("symbol").notNull(),
    instrumentId: text("instrument_id"),
    instrumentRuleVersion: integer("instrument_rule_version").notNull().default(1),
    positionVersion: integer("position_version").notNull().default(1),
    protectionVersion: integer("protection_version").notNull().default(1),
    protectionState: text("protection_state", {
      enum: ["ACTIVE", "POST_ADD_REVALIDATION", "ERROR"],
    }).notNull().default("ACTIVE"),
    protectionUpdatedAt: integer("protection_updated_at", {
      mode: "timestamp_ms",
    }),
    positionSide: text("position_side", { enum: ["LONG", "SHORT"] }).notNull(),
    quantity: real("quantity").notNull(),
    entryPrice: real("entry_price").notNull(),
    markPrice: real("mark_price").notNull(),
    liquidationPrice: real("liquidation_price"),
    liquidationPriceRaw: real("liquidation_price_raw"),
    liquidationPriceStatus: text("liquidation_price_status", {
      enum: [
        "AVAILABLE",
        "EXCHANGE_NOT_PROVIDED",
        "DIRECTION_INVALID",
        "MARK_PRICE_INVALID",
        "POSITION_NOT_FOUND",
        "UNKNOWN",
      ],
    }).notNull().default("UNKNOWN"),
    liquidationPriceObservedAt: integer("liquidation_price_observed_at", {
      mode: "timestamp_ms",
    }),
    leverage: integer("leverage").notNull(),
    riskPlanJson: text("risk_plan_json")
      .notNull()
      .default('{"takeProfits":[],"stopLosses":[]}'),
    executedRiskPlanJson: text("executed_risk_plan_json")
      .notNull()
      .default('{"takeProfits":[],"stopLosses":[]}'),
    trailingActivationPercent: real("trailing_activation_percent")
      .notNull()
      .default(0),
    trailingStopPercent: real("trailing_stop_percent").notNull().default(0),
    favorablePrice: real("favorable_price"),
    status: text("status", {
      enum: ["OPEN", "CLOSED", "EXECUTION_UNKNOWN", "ERROR"],
    })
      .notNull()
      .default("OPEN"),
    exitReason: text("exit_reason", {
      enum: ["STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP", "TIME_EXIT", "MANUAL", "EXTERNAL"],
    }),
    realizedPnl: real("realized_pnl").notNull().default(0),
    lifecycleId: text("lifecycle_id"),
    entryDecisionHandoffJson: text("entry_decision_handoff_json")
      .notNull()
      .default("{}"),
    positionHandoffKey: text("position_handoff_key"),
    positionHandoffVersion: text("position_handoff_version"),
    positionHandoffJson: text("position_handoff_json")
      .notNull()
      .default("{}"),
    marketMicrostructureJson: text("market_microstructure_json")
      .notNull()
      .default("{}"),
    riskLeaseUntil: integer("risk_lease_until", { mode: "timestamp_ms" }),
    pendingCloseClientOrderId: text("pending_close_client_order_id"),
    pendingCloseReason: text("pending_close_reason", {
      enum: ["STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP", "TIME_EXIT", "MANUAL"],
    }),
    pendingCloseQuantity: real("pending_close_quantity"),
    pendingClosePlanJson: text("pending_close_plan_json"),
    additionCount: integer("addition_count").notNull().default(0),
    lastAdditionClientOrderId: text("last_addition_client_order_id"),
    lastError: text("last_error"),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }).notNull(),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("live_positions_source_event_uidx").on(table.sourceEventId),
    index("live_positions_risk_idx").on(
      table.status,
      table.riskLeaseUntil,
      table.updatedAt,
    ),
    index("live_positions_account_idx").on(
      table.ownerEmail,
      table.accountId,
      table.updatedAt,
    ),
    index("live_positions_owner_status_idx").on(
      table.ownerEmail,
      table.status,
      table.accountId,
      table.updatedAt,
    ),
    index("live_positions_lifecycle_idx").on(table.lifecycleId),
    uniqueIndex("live_positions_handoff_key_uidx").on(
      table.positionHandoffKey,
    ),
  ],
);

export const livePositionStructureExitIntents = sqliteTable(
  "live_position_structure_exit_intents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    positionId: integer("position_id").notNull(),
    lifecycleId: text("lifecycle_id"),
    status: text("status", {
      enum: ["NONE", "ACTIVE", "EXECUTED", "CANCELED"],
    })
      .notNull()
      .default("NONE"),
    traceId: text("trace_id"),
    opportunityId: text("opportunity_id"),
    observedMinute: integer("observed_minute"),
    observedAt: integer("observed_at", { mode: "timestamp_ms" }),
    authorizedAt: integer("authorized_at", { mode: "timestamp_ms" }),
    ruleVersion: integer("rule_version"),
    source: text("source", {
      enum: ["POSITION_INTELLIGENCE", "EVIDENCE_BACKFILL"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("live_position_structure_exit_intents_position_uidx").on(
      table.positionId,
    ),
    index("live_position_structure_exit_intents_runtime_idx").on(
      table.status,
      table.positionId,
      table.updatedAt,
    ),
  ],
);

export const livePositionReductions = sqliteTable(
  "live_position_reductions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    positionId: integer("position_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    clientOrderId: text("client_order_id").notNull(),
    exchangeOrderId: text("exchange_order_id"),
    symbol: text("symbol").notNull(),
    positionSide: text("position_side", { enum: ["LONG", "SHORT"] }).notNull(),
    quantity: real("quantity").notNull(),
    exitPrice: real("exit_price").notNull(),
    realizedPnl: real("realized_pnl").notNull(),
    reason: text("reason", {
      enum: ["STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP", "TIME_EXIT", "MANUAL", "EXTERNAL"],
    }).notNull(),
    responseJson: text("response_json").notNull().default("{}"),
    lifecycleId: text("lifecycle_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("live_position_reductions_client_uidx").on(table.clientOrderId),
    index("live_position_reductions_position_idx").on(
      table.positionId,
      table.createdAt,
    ),
    index("live_position_reductions_owner_time_idx").on(
      table.ownerEmail,
      table.createdAt,
      table.accountId,
    ),
    index("live_position_reductions_lifecycle_idx").on(table.lifecycleId),
  ],
);

/**
 * Materialized daily operations read model. The immutable trading ledger stays
 * authoritative, while normal historical report reads use this compact table
 * instead of loading order/trace evidence JSON into the application heap.
 */
export const dailyOperationsSnapshots = sqliteTable(
  "daily_operations_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    tradingDate: text("trading_date").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    rowsJson: text("rows_json").notNull().default("[]"),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("daily_operations_snapshots_owner_date_uidx").on(
      table.ownerEmail,
      table.tradingDate,
    ),
  ],
);

export const livePositionAdditions = sqliteTable(
  "live_position_additions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    positionId: integer("position_id").notNull(),
    basePositionVersion: integer("base_position_version").notNull().default(1),
    appliedPositionVersion: integer("applied_position_version"),
    protectionVersion: integer("protection_version"),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    clientOrderId: text("client_order_id").notNull(),
    exchangeOrderId: text("exchange_order_id"),
    symbol: text("symbol").notNull(),
    positionSide: text("position_side", {
      enum: ["LONG", "SHORT"],
    }).notNull(),
    quantity: real("quantity").notNull(),
    entryPrice: real("entry_price"),
    notionalUsdt: real("notional_usdt").notNull(),
    status: text("status", {
      enum: [
        "PENDING",
        "SUBMITTED",
        "EXECUTION_UNKNOWN",
        "REJECTED",
      ],
    })
      .notNull()
      .default("PENDING"),
    decisionJson: text("decision_json").notNull().default("{}"),
    responseJson: text("response_json").notNull().default("{}"),
    lifecycleId: text("lifecycle_id"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("live_position_additions_client_uidx").on(table.clientOrderId),
    index("live_position_additions_position_idx").on(
      table.positionId,
      table.createdAt,
    ),
    index("live_position_additions_status_idx").on(
      table.status,
      table.updatedAt,
    ),
    index("live_position_additions_lifecycle_idx").on(table.lifecycleId),
  ],
);

export const livePositionAdditionEvidence = sqliteTable(
  "live_position_addition_evidence",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    additionId: integer("addition_id").notNull(),
    positionId: integer("position_id").notNull(),
    minuteOffset: integer("minute_offset").notNull(),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }).notNull(),
    sampledAt: integer("sampled_at", { mode: "timestamp_ms" }).notNull(),
    sampleDelayMs: integer("sample_delay_ms").notNull(),
    markPrice: real("mark_price").notNull(),
    additionEntryPrice: real("addition_entry_price").notNull(),
    additionRoePercent: real("addition_roe_percent").notNull(),
    compositeEntryPrice: real("composite_entry_price").notNull(),
    compositeRoePercent: real("composite_roe_percent").notNull(),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("live_position_addition_evidence_minute_uidx").on(
      table.additionId,
      table.minuteOffset,
    ),
    index("live_position_addition_evidence_position_idx").on(
      table.positionId,
      table.createdAt,
    ),
  ],
);

export const riskStates = sqliteTable(
  "risk_states",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    tradingEnabled: integer("trading_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    circuitBreakerStatus: text("circuit_breaker_status", {
      enum: ["ARMED", "TRIGGERED", "RECOVERING"],
    })
      .notNull()
      .default("ARMED"),
    drawdownThreshold: real("drawdown_threshold").notNull().default(75),
    reason: text("reason"),
    riskHeartbeatAt: integer("risk_heartbeat_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("risk_states_account_uidx").on(
      table.ownerEmail,
      table.accountId,
    ),
  ],
);

export const runtimeControls = sqliteTable(
  "runtime_controls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    controlKey: text("control_key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    updatedBy: text("updated_by").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_controls_key_uidx").on(table.controlKey),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    accountId: text("account_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("audit_events_auth_routing_idx").on(
      table.accountId,
      table.resourceType,
      table.createdAt,
    ),
  ],
);

export const notificationReadStates = sqliteTable(
  "notification_read_states",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    readThrough: integer("read_through", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("notification_read_states_owner_uidx").on(table.ownerEmail),
  ],
);

export const userAccess = sqliteTable(
  "user_access",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role", { enum: ["ADMIN", "OPERATOR", "VIEWER"] })
      .notNull()
      .default("VIEWER"),
    dataScope: text("data_scope", { enum: ["ALL", "OWN"] })
      .notNull()
      .default("OWN"),
    permissionsJson: text("permissions_json").notNull().default("[]"),
    passwordHash: text("password_hash"),
    passwordSalt: text("password_salt"),
    passwordIterations: integer("password_iterations"),
    mustChangePassword: integer("must_change_password", { mode: "boolean" })
      .notNull()
      .default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("user_access_email_uidx").on(table.email)],
);

export const appSessions = sqliteTable(
  "app_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    email: text("email").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("app_sessions_email_expiry_idx").on(table.email, table.expiresAt),
  ],
);
