CREATE TABLE `live_position_structure_exit_intents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`lifecycle_id` text,
	`status` text DEFAULT 'NONE' NOT NULL,
	`trace_id` text,
	`opportunity_id` text,
	`observed_minute` integer,
	`observed_at` integer,
	`authorized_at` integer,
	`rule_version` integer,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_position_structure_exit_intents_position_uidx` ON `live_position_structure_exit_intents` (`position_id`);
--> statement-breakpoint
CREATE INDEX `live_position_structure_exit_intents_runtime_idx` ON `live_position_structure_exit_intents` (`status`,`position_id`,`updated_at`);
