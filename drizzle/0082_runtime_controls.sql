CREATE TABLE `runtime_controls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`control_key` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_controls_key_uidx` ON `runtime_controls` (`control_key`);
