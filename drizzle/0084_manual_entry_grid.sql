CREATE TABLE `manual_entry_grid_plans` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `account_id` text NOT NULL,
  `credential_id` integer NOT NULL,
  `symbol` text NOT NULL,
  `position_side` text NOT NULL,
  `lower_price` real NOT NULL,
  `upper_price` real NOT NULL,
  `grid_count` integer NOT NULL,
  `total_quantity` real NOT NULL,
  `quantity_step` real NOT NULL,
  `leverage` integer DEFAULT 1 NOT NULL,
  `take_profit_plan_json` text DEFAULT '[]' NOT NULL,
  `stop_loss_plan_json` text DEFAULT '[]' NOT NULL,
  `trailing_activation_percent` real DEFAULT 0 NOT NULL,
  `trailing_stop_percent` real DEFAULT 0 NOT NULL,
  `capital_preservation_stop_roe_percent` real,
  `hysteresis_bps` real DEFAULT 5 NOT NULL,
  `levels_json` text DEFAULT '[]' NOT NULL,
  `position_id` integer,
  `position_version` integer,
  `status` text DEFAULT 'DRAFT' NOT NULL,
  `expires_at` integer,
  `last_price` real,
  `last_price_at` integer,
  `lease_until` integer,
  `last_block_reason` text,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `manual_entry_grid_plans_owner_status_idx` ON `manual_entry_grid_plans` (`owner_email`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `manual_entry_grid_plans_runner_idx` ON `manual_entry_grid_plans` (`status`,`lease_until`,`updated_at`);--> statement-breakpoint
CREATE INDEX `manual_entry_grid_plans_account_symbol_idx` ON `manual_entry_grid_plans` (`account_id`,`symbol`,`status`);--> statement-breakpoint
CREATE INDEX `manual_entry_grid_plans_position_idx` ON `manual_entry_grid_plans` (`position_id`,`position_version`,`status`);--> statement-breakpoint
CREATE TABLE `manual_entry_grid_levels` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `plan_id` integer NOT NULL,
  `level_index` integer NOT NULL,
  `level_price` real NOT NULL,
  `quantity` real NOT NULL,
  `state` text DEFAULT 'ARMED' NOT NULL,
  `trigger_count` integer DEFAULT 0 NOT NULL,
  `client_order_id` text,
  `position_addition_id` integer,
  `last_order_event_id` integer,
  `last_trigger_price` real,
  `last_triggered_at` integer,
  `last_error` text,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `manual_entry_grid_levels_plan_index_uidx` ON `manual_entry_grid_levels` (`plan_id`,`level_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `manual_entry_grid_levels_client_order_uidx` ON `manual_entry_grid_levels` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `manual_entry_grid_levels_plan_state_idx` ON `manual_entry_grid_levels` (`plan_id`,`state`,`updated_at`);
