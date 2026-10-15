CREATE INDEX `strategy_learning_cycles_trace_idx` ON `strategy_learning_cycles` (`trace_id`);--> statement-breakpoint
CREATE TABLE `nexus_eye_fact_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fact_id` text NOT NULL,
	`symbol` text NOT NULL,
	`kind` text NOT NULL,
	`interval` text,
	`source` text NOT NULL,
	`event_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`fact_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `nexus_eye_fact_snapshots_fact_uidx` ON `nexus_eye_fact_snapshots` (`fact_id`);--> statement-breakpoint
CREATE INDEX `nexus_eye_fact_snapshots_symbol_time_idx` ON `nexus_eye_fact_snapshots` (`symbol`,`event_at`);--> statement-breakpoint
CREATE INDEX `nexus_eye_fact_snapshots_kind_time_idx` ON `nexus_eye_fact_snapshots` (`kind`,`event_at`);--> statement-breakpoint
CREATE TABLE `strategy_execution_event_rollups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`config_version` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`event_type` text NOT NULL,
	`stage` text NOT NULL,
	`outcome` text NOT NULL,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`first_event_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_execution_event_rollups_key_uidx` ON `strategy_execution_event_rollups` (`trace_id`,`event_type`,`outcome`);--> statement-breakpoint
CREATE INDEX `strategy_execution_event_rollups_strategy_time_idx` ON `strategy_execution_event_rollups` (`owner_email`,`strategy_id`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `strategy_execution_event_rollups_event_time_idx` ON `strategy_execution_event_rollups` (`owner_email`,`event_type`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `strategy_execution_event_rollups_owner_time_idx` ON `strategy_execution_event_rollups` (`owner_email`,`last_event_at`);--> statement-breakpoint
CREATE TABLE `strategy_event_retention_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`rollup_started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `strategy_event_retention_state` (`id`,`rollup_started_at`,`updated_at`)
VALUES (1,strftime('%s','now') * 1000,strftime('%s','now') * 1000);--> statement-breakpoint
CREATE TABLE `strategy_execution_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`trace_database_id` integer NOT NULL,
	`strategy_id` integer NOT NULL,
	`config_version` integer NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`terminal_state` text NOT NULL,
	`result_code` text,
	`result_message` text,
	`event_time` integer NOT NULL,
	`completed_at` integer NOT NULL,
	`had_order` integer DEFAULT false NOT NULL,
	`had_position` integer DEFAULT false NOT NULL,
	`learning_status` text NOT NULL,
	`eye_decision_json` text DEFAULT '{}' NOT NULL,
	`market_fact_ids_json` text DEFAULT '[]' NOT NULL,
	`key_events_json` text DEFAULT '[]' NOT NULL,
	`raw_event_count` integer DEFAULT 0 NOT NULL,
	`raw_event_bytes` integer DEFAULT 0 NOT NULL,
	`raw_evidence_bytes` integer DEFAULT 0 NOT NULL,
	`compact_evidence_bytes` integer DEFAULT 0 NOT NULL,
	`source_checksum` text NOT NULL,
	`archive_version` integer DEFAULT 1 NOT NULL,
	`raw_events_deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_execution_summaries_trace_uidx` ON `strategy_execution_summaries` (`trace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_execution_summaries_trace_db_uidx` ON `strategy_execution_summaries` (`trace_database_id`);--> statement-breakpoint
CREATE INDEX `strategy_execution_summaries_cleanup_idx` ON `strategy_execution_summaries` (`raw_events_deleted_at`,`completed_at`,`learning_status`);--> statement-breakpoint
CREATE INDEX `strategy_execution_summaries_strategy_time_idx` ON `strategy_execution_summaries` (`owner_email`,`strategy_id`,`completed_at`);--> statement-breakpoint
CREATE TRIGGER `strategy_execution_event_rollups_insert`
AFTER INSERT ON `strategy_execution_events`
BEGIN
	INSERT INTO `strategy_execution_event_rollups` (
		`trace_id`,`strategy_id`,`config_version`,`owner_email`,`account_id`,
		`event_type`,`stage`,`outcome`,`occurrence_count`,`first_event_at`,
		`last_event_at`,`created_at`,`updated_at`
	)
	SELECT
		NEW.`trace_id`,NEW.`strategy_id`,t.`config_version`,t.`owner_email`,
		t.`account_id`,NEW.`event_type`,NEW.`stage`,NEW.`outcome`,1,
		NEW.`event_at`,NEW.`event_at`,NEW.`created_at`,NEW.`created_at`
	FROM `strategy_execution_traces` t
	WHERE t.`trace_id` = NEW.`trace_id`
		AND t.`strategy_id` = NEW.`strategy_id`
	ON CONFLICT (`trace_id`,`event_type`,`outcome`) DO UPDATE SET
		`occurrence_count` = `occurrence_count` + 1,
		`first_event_at` = min(`first_event_at`, excluded.`first_event_at`),
		`last_event_at` = max(`last_event_at`, excluded.`last_event_at`),
		`stage` = excluded.`stage`,
		`updated_at` = excluded.`updated_at`;
END;
