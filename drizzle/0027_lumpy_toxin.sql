ALTER TABLE `contract_symbols` ADD `quantity_step` real DEFAULT 1e-8 NOT NULL;--> statement-breakpoint
ALTER TABLE `shadow_orders` ADD `risk_plan_json` text DEFAULT '{"takeProfits":[],"stopLosses":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `shadow_orders` ADD `trailing_activation_percent` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shadow_orders` ADD `trailing_stop_percent` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `simulated_positions` ADD `trailing_activation_percent` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `simulated_positions` ADD `risk_plan_json` text DEFAULT '{"takeProfits":[],"stopLosses":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `simulated_positions` ADD `executed_risk_plan_json` text DEFAULT '{"takeProfits":[],"stopLosses":[]}' NOT NULL;