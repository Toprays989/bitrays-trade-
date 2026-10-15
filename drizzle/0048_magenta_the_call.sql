CREATE TABLE `background_repair_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`task_type` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error_code` text,
	`last_error` text,
	`result_json` text DEFAULT '{}' NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_repair_tasks_resource_uidx` ON `background_repair_tasks` (`task_type`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `background_repair_tasks_due_idx` ON `background_repair_tasks` (`task_type`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `background_repair_tasks_owner_idx` ON `background_repair_tasks` (`owner_email`,`updated_at`);