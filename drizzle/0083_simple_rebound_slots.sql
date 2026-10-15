CREATE TABLE `simple_rebound_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`slot_id` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`entry_price` real NOT NULL,
	`opened_at` integer NOT NULL,
	`trace_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `simple_rebound_slots_strategy_slot_uidx` ON `simple_rebound_slots` (`strategy_id`,`slot_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `simple_rebound_slots_strategy_symbol_uidx` ON `simple_rebound_slots` (`strategy_id`,`symbol`);
--> statement-breakpoint
CREATE INDEX `simple_rebound_slots_strategy_idx` ON `simple_rebound_slots` (`strategy_id`,`updated_at`);
