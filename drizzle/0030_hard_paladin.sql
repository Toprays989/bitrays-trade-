PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`mode` text DEFAULT 'LIVE' NOT NULL,
	`status` text DEFAULT 'RUNNING' NOT NULL,
	`symbols_scanned` integer DEFAULT 0 NOT NULL,
	`signals_found` integer DEFAULT 0 NOT NULL,
	`orders_created` integer DEFAULT 0 NOT NULL,
	`summary_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_automation_runs`("id", "owner_email", "account_id", "mode", "status", "symbols_scanned", "signals_found", "orders_created", "summary_json", "created_at", "completed_at") SELECT "id", "owner_email", "account_id", "mode", "status", "symbols_scanned", "signals_found", "orders_created", "summary_json", "created_at", "completed_at" FROM `automation_runs`;--> statement-breakpoint
DROP TABLE `automation_runs`;--> statement-breakpoint
ALTER TABLE `__new_automation_runs` RENAME TO `automation_runs`;--> statement-breakpoint
UPDATE `automation_runs` SET `mode` = 'LIVE' WHERE `mode` = 'SIMULATION';--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `automation_runs_owner_idx` ON `automation_runs` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_trading_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`account_type` text DEFAULT 'STRATEGY' NOT NULL,
	`execution_mode` text DEFAULT 'LIVE' NOT NULL,
	`operator_name` text DEFAULT '管理员' NOT NULL,
	`note` text,
	`equity_limit` real DEFAULT 10000 NOT NULL,
	`reserve_percent` real DEFAULT 10 NOT NULL,
	`daily_loss_limit_percent` real DEFAULT 5 NOT NULL,
	`max_symbol_margin_percent` real DEFAULT 35 NOT NULL,
	`max_open_positions` integer DEFAULT 10 NOT NULL,
	`max_pending_orders` integer DEFAULT 20 NOT NULL,
	`risk_locked` integer DEFAULT false NOT NULL,
	`risk_lock_reason` text,
	`risk_locked_at` integer,
	`max_leverage` integer DEFAULT 5 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_trading_accounts`("id", "owner_email", "account_id", "name", "account_type", "execution_mode", "operator_name", "note", "equity_limit", "reserve_percent", "daily_loss_limit_percent", "max_symbol_margin_percent", "max_open_positions", "max_pending_orders", "risk_locked", "risk_lock_reason", "risk_locked_at", "max_leverage", "is_active", "created_at", "updated_at") SELECT "id", "owner_email", "account_id", "name", "account_type", "execution_mode", "operator_name", "note", "equity_limit", "reserve_percent", "daily_loss_limit_percent", "max_symbol_margin_percent", "max_open_positions", "max_pending_orders", "risk_locked", "risk_lock_reason", "risk_locked_at", "max_leverage", "is_active", "created_at", "updated_at" FROM `trading_accounts`;--> statement-breakpoint
DROP TABLE `trading_accounts`;--> statement-breakpoint
ALTER TABLE `__new_trading_accounts` RENAME TO `trading_accounts`;--> statement-breakpoint
UPDATE `trading_accounts` SET `execution_mode` = 'LIVE' WHERE `execution_mode` = 'SIMULATION';--> statement-breakpoint
CREATE UNIQUE INDEX `trading_accounts_owner_account_uidx` ON `trading_accounts` (`owner_email`,`account_id`);--> statement-breakpoint
CREATE INDEX `trading_accounts_owner_idx` ON `trading_accounts` (`owner_email`,`updated_at`);
