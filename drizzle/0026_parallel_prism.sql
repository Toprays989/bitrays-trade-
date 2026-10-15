ALTER TABLE `contract_symbols` ADD `last_price` real;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `price_change_percent` real;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `high_price` real;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `low_price` real;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `quote_volume_24h` real;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `market_synced_at` integer;