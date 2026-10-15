ALTER TABLE `strategy_execution_traces` ADD `trigger_kind` text DEFAULT 'LIQUIDATION_WINDOW' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_execution_traces` ADD `trigger_version` text DEFAULT 'liquidation-window-trigger-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_execution_traces` ADD `trigger_direction` text DEFAULT 'LONG' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_execution_traces` ADD `trigger_reference_price` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_execution_traces` ADD `trigger_fact_snapshot_id` text;--> statement-breakpoint
ALTER TABLE `strategy_execution_traces` ADD `trigger_source_id` text;--> statement-breakpoint
UPDATE `strategy_execution_traces`
SET `trigger_reference_price` = `liquidation_price`
WHERE `trigger_reference_price` = 0;
--> statement-breakpoint
UPDATE `strategy_execution_traces`
SET `trigger_kind` = 'RELATIVE_STRENGTH_CONTINUATION',
    `trigger_version` = 'relative-strength-continuation-v1'
WHERE `entry_evidence_json` LIKE '%"relativeStrengthPair"%';
--> statement-breakpoint
UPDATE `strategy_execution_traces`
SET `trigger_kind` = 'HIGH_POSITION_PRICE_VOLUME_STRUCTURE',
    `trigger_version` = 'high-position-price-volume-structure-v1'
WHERE `entry_evidence_json` LIKE '%"strategyFamily":"HIGH_POSITION_PRICE_VOLUME_SHORT"%'
   OR `config_snapshot_json` LIKE '%"mode":"HIGH_POSITION_SHORT"%';
--> statement-breakpoint
UPDATE `strategy_execution_traces`
SET `trigger_kind` = 'PRICE_VOLUME_STRUCTURE',
    `trigger_version` = 'price-volume-structure-v1'
WHERE `entry_evidence_json` LIKE '%"strategyFamily":"TRADFI_PRICE_VOLUME_SHORT"%'
   OR (`config_snapshot_json` LIKE '%"mode":"TRADFI"%'
       AND `config_snapshot_json` LIKE '%"triggerPolicy":"PRICE_VOLUME_STRUCTURE"%');
--> statement-breakpoint
UPDATE `strategy_execution_traces`
SET `trigger_kind` = 'LIQUIDATION_OR_PRICE_MOMENTUM_WAKE',
    `trigger_version` = 'liquidation-or-price-momentum-wake-v1'
WHERE `config_snapshot_json` LIKE '%"mode":"TREND_PULLBACK"%';
--> statement-breakpoint
UPDATE `strategy_execution_traces`
SET `trigger_direction` = 'SHORT'
WHERE `entry_evidence_json` LIKE '%"tradeDirection":"SHORT"%'
   OR `entry_evidence_json` LIKE '%"pairLeg":"SHORT"%';
--> statement-breakpoint
UPDATE `strategy_execution_traces`
SET `trigger_source_id` = `trace_id`
WHERE `trigger_source_id` IS NULL;
