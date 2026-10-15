CREATE TABLE `execution_intents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`intent_key` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`brain_key` text NOT NULL,
	`config_version` integer NOT NULL,
	`trace_id` text NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`position_side` text NOT NULL,
	`order_type` text NOT NULL,
	`quantity` real NOT NULL,
	`limit_price` real,
	`required_margin_usdt` real NOT NULL,
	`reserved_margin_usdt` real DEFAULT 0 NOT NULL,
	`priority` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'PROPOSED' NOT NULL,
	`reason_code` text,
	`reason_message` text,
	`conflict_key` text NOT NULL,
	`reservation_key` text,
	`lease_token` text,
	`lease_until` integer,
	`live_order_event_id` integer,
	`live_position_id` integer,
	`filled_quantity` real DEFAULT 0 NOT NULL,
	`observed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_intents_key_uidx` ON `execution_intents` (`intent_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_intents_reservation_uidx` ON `execution_intents` (`reservation_key`);--> statement-breakpoint
CREATE INDEX `execution_intents_conflict_idx` ON `execution_intents` (`account_id`,`symbol`,`status`);--> statement-breakpoint
CREATE INDEX `execution_intents_strategy_idx` ON `execution_intents` (`strategy_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `execution_intents_recovery_idx` ON `execution_intents` (`status`,`lease_until`);
