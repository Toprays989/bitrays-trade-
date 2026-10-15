CREATE TABLE `live_position_reductions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`client_order_id` text NOT NULL,
	`exchange_order_id` text,
	`symbol` text NOT NULL,
	`position_side` text NOT NULL,
	`quantity` real NOT NULL,
	`exit_price` real NOT NULL,
	`realized_pnl` real NOT NULL,
	`reason` text NOT NULL,
	`response_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_position_reductions_client_uidx` ON `live_position_reductions` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `live_position_reductions_position_idx` ON `live_position_reductions` (`position_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `live_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`credential_id` integer NOT NULL,
	`source_event_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`position_side` text NOT NULL,
	`quantity` real NOT NULL,
	`entry_price` real NOT NULL,
	`mark_price` real NOT NULL,
	`leverage` integer NOT NULL,
	`risk_plan_json` text DEFAULT '{"takeProfits":[],"stopLosses":[]}' NOT NULL,
	`executed_risk_plan_json` text DEFAULT '{"takeProfits":[],"stopLosses":[]}' NOT NULL,
	`trailing_activation_percent` real DEFAULT 0 NOT NULL,
	`trailing_stop_percent` real DEFAULT 0 NOT NULL,
	`favorable_price` real,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`exit_reason` text,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`risk_lease_until` integer,
	`last_error` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_positions_source_event_uidx` ON `live_positions` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `live_positions_risk_idx` ON `live_positions` (`status`,`risk_lease_until`,`updated_at`);--> statement-breakpoint
CREATE INDEX `live_positions_account_idx` ON `live_positions` (`owner_email`,`account_id`,`updated_at`);