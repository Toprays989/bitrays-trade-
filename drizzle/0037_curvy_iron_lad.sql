ALTER TABLE `live_positions` ADD `addition_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `last_addition_client_order_id` text;