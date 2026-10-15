CREATE TABLE `strategy_config_validations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`brain_key` text NOT NULL,
	`candidate_version` integer NOT NULL,
	`baseline_version` integer NOT NULL,
	`suggestion_ids_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'COLLECTING' NOT NULL,
	`evaluation_json` text DEFAULT '{}' NOT NULL,
	`last_evaluated_at` integer,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_config_validations_candidate_uidx` ON `strategy_config_validations` (`strategy_id`,`candidate_version`);--> statement-breakpoint
CREATE INDEX `strategy_config_validations_status_idx` ON `strategy_config_validations` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `strategy_config_validations_owner_idx` ON `strategy_config_validations` (`owner_email`,`updated_at`);
