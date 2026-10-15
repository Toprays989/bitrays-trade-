CREATE TABLE `simulated_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`source_order_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`position_side` text NOT NULL,
	`quantity` real NOT NULL,
	`entry_price` real NOT NULL,
	`mark_price` real NOT NULL,
	`leverage` integer DEFAULT 5 NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `simulated_positions_source_order_uidx` ON `simulated_positions` (`source_order_id`);--> statement-breakpoint
CREATE INDEX `simulated_positions_owner_status_idx` ON `simulated_positions` (`owner_email`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `simulated_positions_auth_routing_idx` ON `simulated_positions` (`account_id`,`symbol`,`opened_at`);