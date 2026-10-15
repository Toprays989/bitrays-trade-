CREATE TABLE `daily_operations_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`trading_date` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL,
	`generated_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_operations_snapshots_owner_date_uidx` ON `daily_operations_snapshots` (`owner_email`,`trading_date`);