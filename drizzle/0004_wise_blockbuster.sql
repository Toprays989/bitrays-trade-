CREATE TABLE `automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`mode` text DEFAULT 'SIMULATION' NOT NULL,
	`status` text DEFAULT 'RUNNING' NOT NULL,
	`symbols_scanned` integer DEFAULT 0 NOT NULL,
	`signals_found` integer DEFAULT 0 NOT NULL,
	`orders_created` integer DEFAULT 0 NOT NULL,
	`summary_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `automation_runs_owner_idx` ON `automation_runs` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE TABLE `trade_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`score` real NOT NULL,
	`market_price` real NOT NULL,
	`momentum_percent` real NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trade_signals_run_idx` ON `trade_signals` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `trade_signals_owner_idx` ON `trade_signals` (`owner_email`,`created_at`);