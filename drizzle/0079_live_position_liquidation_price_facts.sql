ALTER TABLE `live_positions` ADD `liquidation_price_raw` real;
--> statement-breakpoint
ALTER TABLE `live_positions` ADD `liquidation_price_status` text DEFAULT 'UNKNOWN' NOT NULL;
--> statement-breakpoint
ALTER TABLE `live_positions` ADD `liquidation_price_observed_at` integer;
