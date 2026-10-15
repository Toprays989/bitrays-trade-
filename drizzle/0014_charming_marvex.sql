ALTER TABLE `trading_accounts` ADD `daily_loss_limit_percent` real DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_accounts` ADD `risk_locked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_accounts` ADD `risk_lock_reason` text;--> statement-breakpoint
ALTER TABLE `trading_accounts` ADD `risk_locked_at` integer;