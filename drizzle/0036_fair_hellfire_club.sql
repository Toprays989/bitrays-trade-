CREATE TABLE `live_position_additions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`client_order_id` text NOT NULL,
	`exchange_order_id` text,
	`symbol` text NOT NULL,
	`position_side` text NOT NULL,
	`quantity` real NOT NULL,
	`entry_price` real,
	`notional_usdt` real NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`decision_json` text DEFAULT '{}' NOT NULL,
	`response_json` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_position_additions_client_uidx` ON `live_position_additions` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `live_position_additions_position_idx` ON `live_position_additions` (`position_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `live_position_additions_status_idx` ON `live_position_additions` (`status`,`updated_at`);