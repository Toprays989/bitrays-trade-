ALTER TABLE `trading_accounts` ADD `max_open_positions` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_accounts` ADD `max_pending_orders` integer DEFAULT 20 NOT NULL;