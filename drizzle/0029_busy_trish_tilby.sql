ALTER TABLE `live_positions` ADD `pending_close_client_order_id` text;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `pending_close_reason` text;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `pending_close_quantity` real;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `pending_close_plan_json` text;