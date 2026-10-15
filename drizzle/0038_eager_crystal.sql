CREATE TABLE `live_position_addition_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`addition_id` integer NOT NULL,
	`position_id` integer NOT NULL,
	`minute_offset` integer NOT NULL,
	`scheduled_at` integer NOT NULL,
	`sampled_at` integer NOT NULL,
	`sample_delay_ms` integer NOT NULL,
	`mark_price` real NOT NULL,
	`addition_entry_price` real NOT NULL,
	`addition_roe_percent` real NOT NULL,
	`composite_entry_price` real NOT NULL,
	`composite_roe_percent` real NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_position_addition_evidence_minute_uidx` ON `live_position_addition_evidence` (`addition_id`,`minute_offset`);--> statement-breakpoint
CREATE INDEX `live_position_addition_evidence_position_idx` ON `live_position_addition_evidence` (`position_id`,`created_at`);