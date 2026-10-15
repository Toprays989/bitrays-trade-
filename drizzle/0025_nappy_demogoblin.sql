ALTER TABLE `exchange_credentials` ADD `total_wallet_balance` real;--> statement-breakpoint
ALTER TABLE `exchange_credentials` ADD `available_balance` real;--> statement-breakpoint
ALTER TABLE `exchange_credentials` ADD `balance_synced_at` integer;--> statement-breakpoint
ALTER TABLE `exchange_credentials` ADD `position_mode` text;