ALTER TABLE `live_order_events` ADD `lifecycle_id` text;--> statement-breakpoint
ALTER TABLE `live_order_events` ADD `entry_decision_handoff_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `live_order_events_lifecycle_idx` ON `live_order_events` (`lifecycle_id`);--> statement-breakpoint
ALTER TABLE `live_positions` ADD `lifecycle_id` text;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `entry_decision_handoff_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `live_positions_lifecycle_idx` ON `live_positions` (`lifecycle_id`);--> statement-breakpoint
ALTER TABLE `live_position_reductions` ADD `lifecycle_id` text;--> statement-breakpoint
CREATE INDEX `live_position_reductions_lifecycle_idx` ON `live_position_reductions` (`lifecycle_id`);--> statement-breakpoint
ALTER TABLE `live_position_additions` ADD `lifecycle_id` text;--> statement-breakpoint
CREATE INDEX `live_position_additions_lifecycle_idx` ON `live_position_additions` (`lifecycle_id`);
