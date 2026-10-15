CREATE TABLE `semi_auto_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`brain_key` text NOT NULL,
	`config_version` integer NOT NULL,
	`symbol` text NOT NULL,
	`position_side` text NOT NULL,
	`horizon` text NOT NULL,
	`thesis` text NOT NULL,
	`verdict` text NOT NULL,
	`summary` text NOT NULL,
	`analysis_version` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`plan_json` text,
	`live_order_event_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `semi_auto_analyses_owner_created_idx` ON `semi_auto_analyses` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `semi_auto_analyses_strategy_idx` ON `semi_auto_analyses` (`strategy_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `semi_auto_analyses_order_idx` ON `semi_auto_analyses` (`live_order_event_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_strategies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brain_key` text,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`brain_template` text DEFAULT 'NEXUS_MARKET_BRAIN' NOT NULL,
	`runtime_mode` text DEFAULT 'LIVE' NOT NULL,
	`strategy_type` text NOT NULL,
	`symbol_scope` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`published_version` integer DEFAULT 1 NOT NULL,
	`draft_name` text,
	`draft_account_id` text,
	`draft_symbol_scope` text,
	`draft_config_json` text,
	`draft_version` integer DEFAULT 0 NOT NULL,
	`draft_updated_at` integer,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`last_healthy_at` integer,
	`backtest_lease_token` text,
	`backtest_lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_strategies`("id", "brain_key", "owner_email", "account_id", "name", "brain_template", "runtime_mode", "strategy_type", "symbol_scope", "config_json", "config_version", "published_version", "draft_name", "draft_account_id", "draft_symbol_scope", "draft_config_json", "draft_version", "draft_updated_at", "status", "last_healthy_at", "backtest_lease_token", "backtest_lease_until", "created_at", "updated_at") SELECT "id", "brain_key", "owner_email", "account_id", "name", "brain_template", "runtime_mode", "strategy_type", "symbol_scope", "config_json", "config_version", "published_version", "draft_name", "draft_account_id", "draft_symbol_scope", "draft_config_json", "draft_version", "draft_updated_at", "status", "last_healthy_at", "backtest_lease_token", "backtest_lease_until", "created_at", "updated_at" FROM `strategies`;--> statement-breakpoint
DROP TABLE `strategies`;--> statement-breakpoint
ALTER TABLE `__new_strategies` RENAME TO `strategies`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `strategies_brain_key_uidx` ON `strategies` (`brain_key`);--> statement-breakpoint
CREATE INDEX `strategies_owner_idx` ON `strategies` (`owner_email`,`updated_at`);--> statement-breakpoint
CREATE INDEX `strategies_auth_routing_idx` ON `strategies` (`account_id`,`symbol_scope`,`created_at`);