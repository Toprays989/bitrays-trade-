ALTER TABLE `contract_symbols` ADD `instrument_id` text;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `venue` text DEFAULT 'BINANCE' NOT NULL;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `environment` text DEFAULT 'LIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `market` text DEFAULT 'USDT_M' NOT NULL;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `contract_type` text DEFAULT 'PERPETUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `listing_generation` text DEFAULT 'CURRENT' NOT NULL;--> statement-breakpoint
ALTER TABLE `contract_symbols` ADD `rule_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `contract_symbols`
SET `instrument_id` =
  'BINANCE:LIVE:USDT_M:PERPETUAL:' || upper(`symbol`) || ':CURRENT'
WHERE `instrument_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `contract_symbols_instrument_uidx` ON `contract_symbols` (`instrument_id`);--> statement-breakpoint
ALTER TABLE `live_position_additions` ADD `base_position_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `live_position_additions` ADD `applied_position_version` integer;--> statement-breakpoint
ALTER TABLE `live_position_additions` ADD `protection_version` integer;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `instrument_id` text;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `instrument_rule_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `position_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `protection_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `protection_state` text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `protection_updated_at` integer;--> statement-breakpoint
UPDATE `live_positions`
SET
  `instrument_id` =
    'BINANCE:LIVE:USDT_M:PERPETUAL:' || upper(`symbol`) || ':CURRENT',
  `protection_updated_at` = coalesce(`updated_at`, unixepoch('now') * 1000)
WHERE `instrument_id` IS NULL;
