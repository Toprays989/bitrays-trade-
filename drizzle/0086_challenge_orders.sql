CREATE TABLE `challenge_orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `challenge_id` integer NOT NULL,
  `owner_email` text NOT NULL,
  `account_id` text NOT NULL,
  `credential_id` integer NOT NULL,
  `symbol` text NOT NULL,
  `side` text NOT NULL,
  `order_type` text NOT NULL,
  `quantity` real,
  `quote_order_qty` real,
  `limit_price` real,
  `reserved_notional_usdt` real NOT NULL,
  `client_order_id` text NOT NULL,
  `exchange_order_id` text,
  `status` text DEFAULT 'PENDING' NOT NULL,
  `executed_quantity` real DEFAULT 0 NOT NULL,
  `average_price` real,
  `fee_usdt` real DEFAULT 0 NOT NULL,
  `expires_at` integer,
  `response_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `challenge_orders_client_uidx` ON `challenge_orders` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `challenge_orders_challenge_status_idx` ON `challenge_orders` (`challenge_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `challenge_orders_account_symbol_idx` ON `challenge_orders` (`account_id`,`symbol`,`status`);
