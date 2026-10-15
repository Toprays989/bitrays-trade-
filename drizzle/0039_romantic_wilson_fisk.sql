ALTER TABLE `strategies` ADD `brain_key` text;--> statement-breakpoint
ALTER TABLE `strategies` ADD `brain_template` text DEFAULT 'LEGACY_LIQUIDATION' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `runtime_mode` text DEFAULT 'LIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `published_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `last_healthy_at` integer;--> statement-breakpoint
UPDATE `strategies`
SET
	`brain_key` = 'legacy-brain-' || `id`,
	`published_version` = `config_version`
WHERE `brain_key` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `strategies_brain_key_uidx` ON `strategies` (`brain_key`);
