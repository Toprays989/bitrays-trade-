CREATE TABLE `strategy_learning_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`learning_key` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`brain_key` text NOT NULL,
	`config_version` integer NOT NULL,
	`trace_id` text NOT NULL,
	`path` text NOT NULL,
	`order_source` text NOT NULL,
	`manual_intervention` integer DEFAULT false NOT NULL,
	`pre_trade_facts_complete` integer DEFAULT false NOT NULL,
	`checkpoint_minutes_json` text DEFAULT '[]' NOT NULL,
	`terminal_status` text DEFAULT 'OPEN' NOT NULL,
	`exact_net_available` integer DEFAULT false NOT NULL,
	`exact_net_pnl_usdt` real,
	`eligibility` text DEFAULT 'INCOMPLETE' NOT NULL,
	`blocked_reasons_json` text DEFAULT '[]' NOT NULL,
	`source_sample_keys_json` text DEFAULT '[]' NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_learning_cycles_key_uidx` ON `strategy_learning_cycles` (`learning_key`);--> statement-breakpoint
CREATE INDEX `strategy_learning_cycles_strategy_idx` ON `strategy_learning_cycles` (`strategy_id`,`config_version`,`eligibility`);--> statement-breakpoint
CREATE INDEX `strategy_learning_cycles_brain_idx` ON `strategy_learning_cycles` (`brain_key`,`config_version`,`updated_at`);