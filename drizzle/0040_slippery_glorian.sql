ALTER TABLE `strategies` ADD `draft_name` text;--> statement-breakpoint
ALTER TABLE `strategies` ADD `draft_account_id` text;--> statement-breakpoint
ALTER TABLE `strategies` ADD `draft_symbol_scope` text;--> statement-breakpoint
ALTER TABLE `strategies` ADD `draft_config_json` text;--> statement-breakpoint
ALTER TABLE `strategies` ADD `draft_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `draft_updated_at` integer;--> statement-breakpoint
ALTER TABLE `strategy_config_versions` ADD `lifecycle` text DEFAULT 'PUBLISHED' NOT NULL;