CREATE INDEX `live_order_events_owner_created_idx` ON `live_order_events` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `live_order_events_owner_id_idx` ON `live_order_events` (`owner_email`,`id`);--> statement-breakpoint
CREATE INDEX `live_order_events_active_idx` ON `live_order_events` (`owner_email`,`test_only`,`status`,`account_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `live_positions_owner_status_idx` ON `live_positions` (`owner_email`,`status`,`account_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `live_position_reductions_owner_time_idx` ON `live_position_reductions` (`owner_email`,`created_at`,`account_id`);--> statement-breakpoint
CREATE TABLE `live_order_metric_buckets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`account_id` text NOT NULL,
	`strategy_id` integer DEFAULT 0 NOT NULL,
	`config_version` integer DEFAULT 0 NOT NULL,
	`bucket_started_at` integer NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`pending_order_count` integer DEFAULT 0 NOT NULL,
	`submitted_order_count` integer DEFAULT 0 NOT NULL,
	`filled_order_count` integer DEFAULT 0 NOT NULL,
	`canceled_order_count` integer DEFAULT 0 NOT NULL,
	`rejected_order_count` integer DEFAULT 0 NOT NULL,
	`execution_unknown_order_count` integer DEFAULT 0 NOT NULL,
	`order_notional` real DEFAULT 0 NOT NULL,
	`filled_order_notional` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `live_order_metric_buckets_key_uidx` ON `live_order_metric_buckets` (`owner_email`,`account_id`,`strategy_id`,`config_version`,`bucket_started_at`);--> statement-breakpoint
CREATE INDEX `live_order_metric_buckets_owner_time_idx` ON `live_order_metric_buckets` (`owner_email`,`bucket_started_at`);--> statement-breakpoint
CREATE INDEX `live_order_metric_buckets_account_time_idx` ON `live_order_metric_buckets` (`owner_email`,`account_id`,`bucket_started_at`);--> statement-breakpoint
INSERT INTO `live_order_metric_buckets` (
	`owner_email`,`account_id`,`strategy_id`,`config_version`,`bucket_started_at`,
	`order_count`,`pending_order_count`,`submitted_order_count`,`filled_order_count`,
	`canceled_order_count`,`rejected_order_count`,`execution_unknown_order_count`,
	`order_notional`,`filled_order_notional`,`updated_at`
)
SELECT
	o.`owner_email`,
	o.`account_id`,
	coalesce(t.`strategy_id`, 0),
	coalesce(t.`config_version`, 0),
	(o.`created_at` / 60000) * 60000,
	count(*),
	sum(CASE WHEN o.`status` = 'PENDING' THEN 1 ELSE 0 END),
	sum(CASE WHEN o.`status` = 'SUBMITTED' THEN 1 ELSE 0 END),
	sum(CASE WHEN o.`status` = 'FILLED' THEN 1 ELSE 0 END),
	sum(CASE WHEN o.`status` = 'CANCELED' THEN 1 ELSE 0 END),
	sum(CASE WHEN o.`status` = 'REJECTED' THEN 1 ELSE 0 END),
	sum(CASE WHEN o.`status` = 'EXECUTION_UNKNOWN' THEN 1 ELSE 0 END),
	sum(o.`estimated_notional`),
	sum(CASE WHEN o.`status` IN ('FILLED','SUBMITTED') THEN o.`estimated_notional` ELSE 0 END),
	max(o.`updated_at`)
FROM `live_order_events` o
LEFT JOIN `strategy_execution_traces` t ON t.`id` = CASE
	WHEN o.`client_order_id` GLOB 'nq[lsip]_[0-9]*_*'
	THEN cast(substr(o.`client_order_id`, 5, instr(substr(o.`client_order_id`, 5), '_') - 1) AS integer)
	ELSE NULL
END AND t.`owner_email` = o.`owner_email`
WHERE o.`test_only` = 0
GROUP BY o.`owner_email`,o.`account_id`,coalesce(t.`strategy_id`,0),coalesce(t.`config_version`,0),(o.`created_at` / 60000) * 60000;--> statement-breakpoint
CREATE TRIGGER `live_order_metric_buckets_insert`
AFTER INSERT ON `live_order_events`
WHEN NEW.`test_only` = 0
BEGIN
	INSERT INTO `live_order_metric_buckets` (
		`owner_email`,`account_id`,`strategy_id`,`config_version`,`bucket_started_at`,
		`order_count`,`pending_order_count`,`submitted_order_count`,`filled_order_count`,
		`canceled_order_count`,`rejected_order_count`,`execution_unknown_order_count`,
		`order_notional`,`filled_order_notional`,`updated_at`
	)
	SELECT
		NEW.`owner_email`,NEW.`account_id`,coalesce(t.`strategy_id`,0),coalesce(t.`config_version`,0),
		(NEW.`created_at` / 60000) * 60000,1,
		CASE WHEN NEW.`status` = 'PENDING' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'SUBMITTED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'FILLED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'CANCELED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'REJECTED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'EXECUTION_UNKNOWN' THEN 1 ELSE 0 END,
		NEW.`estimated_notional`,
		CASE WHEN NEW.`status` IN ('FILLED','SUBMITTED') THEN NEW.`estimated_notional` ELSE 0 END,
		NEW.`updated_at`
	FROM (SELECT 1) seed
	LEFT JOIN `strategy_execution_traces` t ON t.`id` = CASE
		WHEN NEW.`client_order_id` GLOB 'nq[lsip]_[0-9]*_*'
		THEN cast(substr(NEW.`client_order_id`, 5, instr(substr(NEW.`client_order_id`, 5), '_') - 1) AS integer)
		ELSE NULL
	END AND t.`owner_email` = NEW.`owner_email`
	WHERE true
	ON CONFLICT (`owner_email`,`account_id`,`strategy_id`,`config_version`,`bucket_started_at`)
	DO UPDATE SET
		`order_count` = `order_count` + 1,
		`pending_order_count` = `pending_order_count` + excluded.`pending_order_count`,
		`submitted_order_count` = `submitted_order_count` + excluded.`submitted_order_count`,
		`filled_order_count` = `filled_order_count` + excluded.`filled_order_count`,
		`canceled_order_count` = `canceled_order_count` + excluded.`canceled_order_count`,
		`rejected_order_count` = `rejected_order_count` + excluded.`rejected_order_count`,
		`execution_unknown_order_count` = `execution_unknown_order_count` + excluded.`execution_unknown_order_count`,
		`order_notional` = `order_notional` + excluded.`order_notional`,
		`filled_order_notional` = `filled_order_notional` + excluded.`filled_order_notional`,
		`updated_at` = excluded.`updated_at`;
END;--> statement-breakpoint
CREATE TRIGGER `live_order_metric_buckets_update_subtract`
AFTER UPDATE OF `owner_email`,`account_id`,`client_order_id`,`status`,`estimated_notional`,`test_only`,`created_at` ON `live_order_events`
WHEN OLD.`test_only` = 0
BEGIN
	UPDATE `live_order_metric_buckets` SET
		`order_count` = `order_count` - 1,
		`pending_order_count` = `pending_order_count` - CASE WHEN OLD.`status` = 'PENDING' THEN 1 ELSE 0 END,
		`submitted_order_count` = `submitted_order_count` - CASE WHEN OLD.`status` = 'SUBMITTED' THEN 1 ELSE 0 END,
		`filled_order_count` = `filled_order_count` - CASE WHEN OLD.`status` = 'FILLED' THEN 1 ELSE 0 END,
		`canceled_order_count` = `canceled_order_count` - CASE WHEN OLD.`status` = 'CANCELED' THEN 1 ELSE 0 END,
		`rejected_order_count` = `rejected_order_count` - CASE WHEN OLD.`status` = 'REJECTED' THEN 1 ELSE 0 END,
		`execution_unknown_order_count` = `execution_unknown_order_count` - CASE WHEN OLD.`status` = 'EXECUTION_UNKNOWN' THEN 1 ELSE 0 END,
		`order_notional` = `order_notional` - OLD.`estimated_notional`,
		`filled_order_notional` = `filled_order_notional` - CASE WHEN OLD.`status` IN ('FILLED','SUBMITTED') THEN OLD.`estimated_notional` ELSE 0 END,
		`updated_at` = NEW.`updated_at`
	WHERE `owner_email` = OLD.`owner_email`
		AND `account_id` = OLD.`account_id`
		AND `strategy_id` = coalesce((SELECT `strategy_id` FROM `strategy_execution_traces` WHERE `id` = CASE WHEN OLD.`client_order_id` GLOB 'nq[lsip]_[0-9]*_*' THEN cast(substr(OLD.`client_order_id`,5,instr(substr(OLD.`client_order_id`,5),'_')-1) AS integer) ELSE NULL END AND `owner_email` = OLD.`owner_email`),0)
		AND `config_version` = coalesce((SELECT `config_version` FROM `strategy_execution_traces` WHERE `id` = CASE WHEN OLD.`client_order_id` GLOB 'nq[lsip]_[0-9]*_*' THEN cast(substr(OLD.`client_order_id`,5,instr(substr(OLD.`client_order_id`,5),'_')-1) AS integer) ELSE NULL END AND `owner_email` = OLD.`owner_email`),0)
		AND `bucket_started_at` = (OLD.`created_at` / 60000) * 60000;
END;--> statement-breakpoint
CREATE TRIGGER `live_order_metric_buckets_update_add`
AFTER UPDATE OF `owner_email`,`account_id`,`client_order_id`,`status`,`estimated_notional`,`test_only`,`created_at` ON `live_order_events`
WHEN NEW.`test_only` = 0
BEGIN
	INSERT INTO `live_order_metric_buckets` (
		`owner_email`,`account_id`,`strategy_id`,`config_version`,`bucket_started_at`,
		`order_count`,`pending_order_count`,`submitted_order_count`,`filled_order_count`,
		`canceled_order_count`,`rejected_order_count`,`execution_unknown_order_count`,
		`order_notional`,`filled_order_notional`,`updated_at`
	)
	SELECT
		NEW.`owner_email`,NEW.`account_id`,coalesce(t.`strategy_id`,0),coalesce(t.`config_version`,0),
		(NEW.`created_at` / 60000) * 60000,1,
		CASE WHEN NEW.`status` = 'PENDING' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'SUBMITTED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'FILLED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'CANCELED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'REJECTED' THEN 1 ELSE 0 END,
		CASE WHEN NEW.`status` = 'EXECUTION_UNKNOWN' THEN 1 ELSE 0 END,
		NEW.`estimated_notional`,
		CASE WHEN NEW.`status` IN ('FILLED','SUBMITTED') THEN NEW.`estimated_notional` ELSE 0 END,
		NEW.`updated_at`
	FROM (SELECT 1) seed
	LEFT JOIN `strategy_execution_traces` t ON t.`id` = CASE
		WHEN NEW.`client_order_id` GLOB 'nq[lsip]_[0-9]*_*'
		THEN cast(substr(NEW.`client_order_id`, 5, instr(substr(NEW.`client_order_id`, 5), '_') - 1) AS integer)
		ELSE NULL
	END AND t.`owner_email` = NEW.`owner_email`
	WHERE true
	ON CONFLICT (`owner_email`,`account_id`,`strategy_id`,`config_version`,`bucket_started_at`)
	DO UPDATE SET
		`order_count` = `order_count` + 1,
		`pending_order_count` = `pending_order_count` + excluded.`pending_order_count`,
		`submitted_order_count` = `submitted_order_count` + excluded.`submitted_order_count`,
		`filled_order_count` = `filled_order_count` + excluded.`filled_order_count`,
		`canceled_order_count` = `canceled_order_count` + excluded.`canceled_order_count`,
		`rejected_order_count` = `rejected_order_count` + excluded.`rejected_order_count`,
		`execution_unknown_order_count` = `execution_unknown_order_count` + excluded.`execution_unknown_order_count`,
		`order_notional` = `order_notional` + excluded.`order_notional`,
		`filled_order_notional` = `filled_order_notional` + excluded.`filled_order_notional`,
		`updated_at` = excluded.`updated_at`;
END;
