CREATE TABLE `user_access` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'VIEWER' NOT NULL,
	`data_scope` text DEFAULT 'OWN' NOT NULL,
	`permissions_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_access_email_uidx` ON `user_access` (`email`);