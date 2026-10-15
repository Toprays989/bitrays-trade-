CREATE TABLE `exchange_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`exchange` text DEFAULT 'BINANCE_USDM' NOT NULL,
	`environment` text DEFAULT 'LIVE' NOT NULL,
	`label` text NOT NULL,
	`api_key_ciphertext` text NOT NULL,
	`api_key_iv` text NOT NULL,
	`secret_key_ciphertext` text NOT NULL,
	`secret_key_iv` text NOT NULL,
	`api_key_mask` text NOT NULL,
	`allowed_symbols_json` text DEFAULT '["BTCUSDT"]' NOT NULL,
	`max_order_notional_usdt` real DEFAULT 20 NOT NULL,
	`max_daily_notional_usdt` real DEFAULT 100 NOT NULL,
	`max_leverage` integer DEFAULT 2 NOT NULL,
	`live_trading_enabled` integer DEFAULT false NOT NULL,
	`connection_status` text DEFAULT 'UNVERIFIED' NOT NULL,
	`last_verified_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_credentials_owner_account_uidx` ON `exchange_credentials` (`owner_email`,`account_id`);--> statement-breakpoint
CREATE INDEX `exchange_credentials_owner_idx` ON `exchange_credentials` (`owner_email`,`updated_at`);--> statement-breakpoint
CREATE TABLE `live_order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`credential_id` integer NOT NULL,
	`client_order_id` text NOT NULL,
	`exchange_order_id` text,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`position_side` text NOT NULL,
	`order_type` text DEFAULT 'MARKET' NOT NULL,
	`quantity` real NOT NULL,
	`reference_price` real NOT NULL,
	`estimated_notional` real NOT NULL,
	`test_only` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`response_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_order_events_client_uidx` ON `live_order_events` (`client_order_id`);--> statement-breakpoint
CREATE INDEX `live_order_events_daily_limit_idx` ON `live_order_events` (`owner_email`,`account_id`,`created_at`);