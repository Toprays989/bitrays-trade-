CREATE TABLE `app_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `app_sessions_email_expiry_idx` ON `app_sessions` (`email`,`expires_at`);--> statement-breakpoint
ALTER TABLE `user_access` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `user_access` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `user_access` ADD `password_salt` text;--> statement-breakpoint
ALTER TABLE `user_access` ADD `password_iterations` integer;--> statement-breakpoint
ALTER TABLE `user_access` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_access` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_access` ADD `failed_login_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_access` ADD `locked_until` integer;--> statement-breakpoint
ALTER TABLE `user_access` ADD `last_login_at` integer;