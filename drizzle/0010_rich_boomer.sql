CREATE TABLE `automation_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`interval_seconds` integer DEFAULT 60 NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`lease_until` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_schedules_owner_uidx` ON `automation_schedules` (`owner_email`,`account_id`);