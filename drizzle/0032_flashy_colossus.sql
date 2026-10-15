CREATE TABLE `strategy_execution_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`stage` text NOT NULL,
	`outcome` text NOT NULL,
	`message` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`event_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_execution_events_trace_sequence_uidx` ON `strategy_execution_events` (`trace_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `strategy_execution_events_strategy_idx` ON `strategy_execution_events` (`strategy_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `strategy_execution_traces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`strategy_run_id` text NOT NULL,
	`config_version` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`liquidation_side` text NOT NULL,
	`liquidation_price` real NOT NULL,
	`liquidation_notional` real NOT NULL,
	`event_time` integer NOT NULL,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text DEFAULT 'TRIGGERED' NOT NULL,
	`result_code` text,
	`result_message` text,
	`config_snapshot_json` text DEFAULT '{}' NOT NULL,
	`entry_evidence_json` text DEFAULT '{}' NOT NULL,
	`exchange_order_id` text,
	`position_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_execution_traces_trace_uidx` ON `strategy_execution_traces` (`trace_id`);--> statement-breakpoint
CREATE INDEX `strategy_execution_traces_strategy_idx` ON `strategy_execution_traces` (`strategy_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `strategy_execution_traces_lock_idx` ON `strategy_execution_traces` (`account_id`,`strategy_id`,`symbol`,`state`);--> statement-breakpoint
CREATE INDEX `strategy_execution_traces_result_idx` ON `strategy_execution_traces` (`strategy_id`,`result_code`,`created_at`);--> statement-breakpoint
CREATE TABLE `strategy_parameter_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`config_version` integer NOT NULL,
	`sample_count` integer NOT NULL,
	`parameter_name` text NOT NULL,
	`current_value_json` text DEFAULT 'null' NOT NULL,
	`suggested_value_json` text DEFAULT 'null' NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE INDEX `strategy_parameter_suggestions_strategy_idx` ON `strategy_parameter_suggestions` (`strategy_id`,`config_version`,`created_at`);--> statement-breakpoint
CREATE TABLE `strategy_position_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`minute_offset` integer NOT NULL,
	`scheduled_at` integer NOT NULL,
	`sampled_at` integer,
	`sample_delay_ms` integer,
	`status` text NOT NULL,
	`mark_price` real,
	`entry_price` real NOT NULL,
	`remaining_qty` real NOT NULL,
	`unrealized_pnl` real,
	`net_pnl_estimate` real,
	`roe_percent` real,
	`mfe_roe_percent` real,
	`mae_roe_percent` real,
	`volume_ratio_3m` real,
	`atr_5m` real,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_position_evidence_trace_minute_uidx` ON `strategy_position_evidence` (`trace_id`,`minute_offset`);--> statement-breakpoint
CREATE INDEX `strategy_position_evidence_strategy_idx` ON `strategy_position_evidence` (`strategy_id`,`created_at`);