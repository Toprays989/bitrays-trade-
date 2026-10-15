ALTER TABLE `simulated_positions` ADD `stop_loss_percent` real DEFAULT 12.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `simulated_positions` ADD `take_profit_percent` real DEFAULT 8 NOT NULL;