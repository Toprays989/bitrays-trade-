CREATE TABLE `paper_accounts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `account_id` text NOT NULL,
  `name` text NOT NULL,
  `initial_balance_usdt` real NOT NULL,
  `balance_usdt` real NOT NULL,
  `available_balance_usdt` real NOT NULL,
  `fee_rate_bps` real DEFAULT 4 NOT NULL,
  `status` text DEFAULT 'ACTIVE' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `paper_accounts_owner_account_uidx` ON `paper_accounts` (`owner_email`,`account_id`);--> statement-breakpoint
CREATE INDEX `paper_accounts_owner_status_idx` ON `paper_accounts` (`owner_email`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `paper_orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `paper_account_id` integer NOT NULL,
  `symbol` text NOT NULL,
  `direction` text NOT NULL,
  `order_type` text NOT NULL,
  `quantity` real NOT NULL,
  `limit_price` real,
  `filled_quantity` real DEFAULT 0 NOT NULL,
  `average_price` real,
  `status` text DEFAULT 'NEW' NOT NULL,
  `source_business` text DEFAULT 'PAPER_TRADING' NOT NULL,
  `strategy_id` integer,
  `brain_key` text,
  `config_version` integer,
  `analysis_record_id` integer,
  `client_order_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `paper_orders_client_uidx` ON `paper_orders` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `paper_orders_account_status_idx` ON `paper_orders` (`paper_account_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `paper_orders_owner_time_idx` ON `paper_orders` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE TABLE `paper_fills` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `paper_account_id` integer NOT NULL,
  `paper_order_id` integer NOT NULL,
  `symbol` text NOT NULL,
  `direction` text NOT NULL,
  `quantity` real NOT NULL,
  `price` real NOT NULL,
  `fee_usdt` real DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `paper_fills_account_time_idx` ON `paper_fills` (`paper_account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `paper_fills_order_idx` ON `paper_fills` (`paper_order_id`);--> statement-breakpoint
CREATE TABLE `paper_positions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `paper_account_id` integer NOT NULL,
  `symbol` text NOT NULL,
  `direction` text NOT NULL,
  `quantity` real NOT NULL,
  `entry_price` real NOT NULL,
  `realized_pnl_usdt` real DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'OPEN' NOT NULL,
  `opened_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `paper_positions_account_symbol_status_idx` ON `paper_positions` (`paper_account_id`,`symbol`,`status`);--> statement-breakpoint
CREATE INDEX `paper_positions_owner_status_idx` ON `paper_positions` (`owner_email`,`status`,`updated_at`);
