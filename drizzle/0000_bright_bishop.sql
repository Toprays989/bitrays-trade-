CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_auth_routing_idx` ON `audit_events` (`account_id`,`resource_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `contract_symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`display_name` text NOT NULL,
	`source` text NOT NULL,
	`min_order_qty` real NOT NULL,
	`min_volume_24h` real DEFAULT 500000000 NOT NULL,
	`is_protected` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_symbols_symbol_uidx` ON `contract_symbols` (`symbol`);--> statement-breakpoint
CREATE TABLE `shadow_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`client_order_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`position_side` text NOT NULL,
	`order_type` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real,
	`stop_loss_rate` real,
	`take_profit_rate` real,
	`is_shadow_stop` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'SHADOW_WATCHING' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shadow_orders_client_order_uidx` ON `shadow_orders` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `shadow_orders_owner_idx` ON `shadow_orders` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `shadow_orders_auth_routing_idx` ON `shadow_orders` (`account_id`,`symbol`,`created_at`);--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`strategy_type` text NOT NULL,
	`symbol_scope` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `strategies_owner_idx` ON `strategies` (`owner_email`,`updated_at`);--> statement-breakpoint
CREATE INDEX `strategies_auth_routing_idx` ON `strategies` (`account_id`,`symbol_scope`,`created_at`);