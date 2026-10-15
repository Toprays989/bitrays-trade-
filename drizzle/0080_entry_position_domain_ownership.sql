ALTER TABLE `execution_intents` ADD `intent_purpose` text DEFAULT 'OPEN_POSITION' NOT NULL;--> statement-breakpoint
ALTER TABLE `execution_intents` ADD `authority_source` text DEFAULT 'ENTRY_BRAIN' NOT NULL;--> statement-breakpoint
ALTER TABLE `execution_intents` ADD `position_handoff_key` text;--> statement-breakpoint
CREATE INDEX `execution_intents_domain_idx` ON `execution_intents` (`intent_purpose`,`authority_source`,`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `live_positions` ADD `position_handoff_key` text;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `position_handoff_version` text;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `position_handoff_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `live_positions_handoff_key_uidx` ON `live_positions` (`position_handoff_key`);
