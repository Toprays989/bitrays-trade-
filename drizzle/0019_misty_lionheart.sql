CREATE TABLE `strategy_config_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`version` integer NOT NULL,
	`source_version` integer,
	`strategy_type` text NOT NULL,
	`symbol_scope` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_config_versions_strategy_version_uidx` ON `strategy_config_versions` (`strategy_id`,`version`);--> statement-breakpoint
CREATE INDEX `strategy_config_versions_owner_idx` ON `strategy_config_versions` (`owner_email`,`created_at`);--> statement-breakpoint
INSERT INTO `strategy_config_versions` (`strategy_id`, `owner_email`, `account_id`, `version`, `source_version`, `strategy_type`, `symbol_scope`, `config_json`, `created_at`)
SELECT `id`, `owner_email`, `account_id`, `config_version`, NULL, `strategy_type`, `symbol_scope`, `config_json`, `updated_at` FROM `strategies`;
