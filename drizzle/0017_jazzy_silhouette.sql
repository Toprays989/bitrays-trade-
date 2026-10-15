CREATE TABLE `position_reductions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`source_order_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`position_side` text NOT NULL,
	`quantity` real NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real NOT NULL,
	`realized_pnl` real NOT NULL,
	`reason` text DEFAULT 'MANUAL_PARTIAL' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `position_reductions_owner_idx` ON `position_reductions` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `position_reductions_position_idx` ON `position_reductions` (`position_id`,`created_at`);