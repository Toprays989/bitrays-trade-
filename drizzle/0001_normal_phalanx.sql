CREATE TABLE `exchange_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`shadow_order_id` integer NOT NULL,
	`client_order_id` text NOT NULL,
	`exchange_order_id` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`cumulative_qty` real DEFAULT 0 NOT NULL,
	`average_price` real DEFAULT 0 NOT NULL,
	`submitted_at` integer,
	`terminal_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_orders_client_order_uidx` ON `exchange_orders` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `exchange_orders_shadow_idx` ON `exchange_orders` (`shadow_order_id`);--> statement-breakpoint
CREATE INDEX `exchange_orders_auth_routing_idx` ON `exchange_orders` (`account_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limit_buckets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`exchange` text DEFAULT 'BINANCE' NOT NULL,
	`used_weight` integer DEFAULT 0 NOT NULL,
	`limit_weight` integer DEFAULT 2350 NOT NULL,
	`reserved_trading_weight` integer DEFAULT 470 NOT NULL,
	`window_started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_bucket_account_uidx` ON `rate_limit_buckets` (`owner_email`,`account_id`,`exchange`);--> statement-breakpoint
CREATE TABLE `risk_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`trading_enabled` integer DEFAULT true NOT NULL,
	`circuit_breaker_status` text DEFAULT 'ARMED' NOT NULL,
	`drawdown_threshold` real DEFAULT 75 NOT NULL,
	`reason` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `risk_states_account_uidx` ON `risk_states` (`owner_email`,`account_id`);--> statement-breakpoint
ALTER TABLE `shadow_orders` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `shadow_orders` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `shadow_orders` ADD `retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shadow_orders` ADD `last_error` text;--> statement-breakpoint
CREATE UNIQUE INDEX `shadow_orders_idempotency_uidx` ON `shadow_orders` (`owner_email`,`idempotency_key`);
