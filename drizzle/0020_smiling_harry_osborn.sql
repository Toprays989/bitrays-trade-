ALTER TABLE `strategy_config_versions` ADD `version_label` text;--> statement-breakpoint
ALTER TABLE `strategy_config_versions` ADD `note` text;--> statement-breakpoint
ALTER TABLE `strategy_config_versions` ADD `is_baseline` integer DEFAULT false NOT NULL;