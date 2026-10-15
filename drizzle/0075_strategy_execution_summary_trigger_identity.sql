ALTER TABLE `strategy_execution_summaries` ADD `trigger_kind` text DEFAULT 'LIQUIDATION_WINDOW' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_execution_summaries` ADD `trigger_version` text DEFAULT 'liquidation-window-trigger-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_execution_summaries` ADD `trigger_fact_snapshot_id` text;--> statement-breakpoint
UPDATE `strategy_execution_summaries`
SET `trigger_kind` = COALESCE(
      (SELECT `trigger_kind`
       FROM `strategy_execution_traces`
       WHERE `strategy_execution_traces`.`trace_id` = `strategy_execution_summaries`.`trace_id`
       LIMIT 1),
      `trigger_kind`
    ),
    `trigger_version` = COALESCE(
      (SELECT `trigger_version`
       FROM `strategy_execution_traces`
       WHERE `strategy_execution_traces`.`trace_id` = `strategy_execution_summaries`.`trace_id`
       LIMIT 1),
      `trigger_version`
    ),
    `trigger_fact_snapshot_id` = COALESCE(
      (SELECT `trigger_fact_snapshot_id`
       FROM `strategy_execution_traces`
       WHERE `strategy_execution_traces`.`trace_id` = `strategy_execution_summaries`.`trace_id`
       LIMIT 1),
      `trigger_fact_snapshot_id`
    );
