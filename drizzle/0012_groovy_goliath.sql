CREATE TABLE `trading_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`account_type` text DEFAULT 'STRATEGY' NOT NULL,
	`equity_limit` real DEFAULT 10000 NOT NULL,
	`max_leverage` integer DEFAULT 5 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trading_accounts_owner_account_uidx` ON `trading_accounts` (`owner_email`,`account_id`);--> statement-breakpoint
CREATE INDEX `trading_accounts_owner_idx` ON `trading_accounts` (`owner_email`,`updated_at`);