CREATE TABLE `strategy_backtests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`config_version` integer NOT NULL,
	`status` text NOT NULL,
	`symbols_tested` integer DEFAULT 0 NOT NULL,
	`sample_candles` integer DEFAULT 0 NOT NULL,
	`trade_count` integer DEFAULT 0 NOT NULL,
	`win_rate` real DEFAULT 0 NOT NULL,
	`net_return_percent` real DEFAULT 0 NOT NULL,
	`max_drawdown_percent` real DEFAULT 0 NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `strategy_backtests_strategy_idx` ON `strategy_backtests` (`strategy_id`,`config_version`,`created_at`);--> statement-breakpoint
CREATE INDEX `strategy_backtests_owner_idx` ON `strategy_backtests` (`owner_email`,`created_at`);--> statement-breakpoint
ALTER TABLE `strategies` ADD `config_version` integer DEFAULT 1 NOT NULL;