CREATE TABLE `notification_read_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`read_through` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_read_states_owner_uidx` ON `notification_read_states` (`owner_email`);