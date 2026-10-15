CREATE TABLE `portfolio_risk_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`peak_account_equity_usdt` real DEFAULT 0 NOT NULL,
	`last_account_equity_usdt` real DEFAULT 0 NOT NULL,
	`last_drawdown_percent` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_risk_states_account_uidx` ON `portfolio_risk_states` (`owner_email`,`account_id`);