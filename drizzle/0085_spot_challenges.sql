CREATE TABLE `spot_whitelist_versions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `version` text NOT NULL,
  `status` text DEFAULT 'DRAFT' NOT NULL,
  `source` text DEFAULT 'BINANCE_SPOT_EXCHANGE_INFO' NOT NULL,
  `notes` text,
  `published_by` text,
  `published_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `spot_whitelist_versions_owner_version_uidx` ON `spot_whitelist_versions` (`owner_email`,`version`);--> statement-breakpoint
CREATE INDEX `spot_whitelist_versions_owner_status_idx` ON `spot_whitelist_versions` (`owner_email`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `spot_whitelist_symbols` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `version_id` integer NOT NULL,
  `symbol` text NOT NULL,
  `base_asset` text NOT NULL,
  `quote_asset` text DEFAULT 'USDT' NOT NULL,
  `trading_status` text NOT NULL,
  `price_tick_size` real NOT NULL,
  `quantity_step` real NOT NULL,
  `min_order_qty` real NOT NULL,
  `min_notional_usdt` real NOT NULL,
  `quote_volume_24h` real,
  `spread_bps` real,
  `volatility_24h` real,
  `depth_usdt` real,
  `risk_tier` text DEFAULT 'NORMAL' NOT NULL,
  `operator_selected` integer DEFAULT false NOT NULL,
  `eligible` integer DEFAULT false NOT NULL,
  `rejection_reason` text,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `spot_whitelist_symbols_version_symbol_uidx` ON `spot_whitelist_symbols` (`version_id`,`symbol`);--> statement-breakpoint
CREATE INDEX `spot_whitelist_symbols_version_eligible_idx` ON `spot_whitelist_symbols` (`version_id`,`eligible`,`operator_selected`);--> statement-breakpoint
CREATE TABLE `challenge_instances` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `account_id` text NOT NULL,
  `credential_id` integer NOT NULL,
  `whitelist_version_id` integer NOT NULL,
  `capital_usdt` real NOT NULL,
  `fee_rate_bps` real DEFAULT 4 NOT NULL,
  `status` text DEFAULT 'DRAFT' NOT NULL,
  `equity_usdt` real,
  `net_pnl_usdt` real,
  `success_probability` real,
  `failure_probability` real,
  `stress_failure_probability` real,
  `risk_used_percent` real,
  `started_at` integer,
  `terminal_at` integer,
  `terminal_reason` text,
  `trigger_equity_usdt` real,
  `final_equity_usdt` real,
  `total_fees_usdt` real DEFAULT 0 NOT NULL,
  `total_slippage_usdt` real DEFAULT 0 NOT NULL,
  `model_version` text DEFAULT 'spot-challenge-v1' NOT NULL,
  `risk_config_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `challenge_instances_owner_status_idx` ON `challenge_instances` (`owner_email`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `challenge_instances_account_idx` ON `challenge_instances` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `challenge_risk_snapshots` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `challenge_id` integer NOT NULL,
  `equity_usdt` real NOT NULL,
  `net_pnl_usdt` real NOT NULL,
  `success_probability` real,
  `failure_probability` real,
  `stress_failure_probability` real,
  `pressure_loss_usdt` real,
  `var95_usdt` real,
  `risk_state` text NOT NULL,
  `metrics_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `challenge_risk_snapshots_challenge_time_idx` ON `challenge_risk_snapshots` (`challenge_id`,`created_at`);
