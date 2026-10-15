CREATE TABLE `strategy_learning_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`learning_key` text NOT NULL,
	`strategy_id` integer NOT NULL,
	`brain_key` text NOT NULL,
	`config_version` integer NOT NULL,
	`trace_id` text NOT NULL,
	`decision` text NOT NULL,
	`promotion_status` text NOT NULL,
	`memory_version` integer,
	`sample_updated_at` integer NOT NULL,
	`exact_net_available` integer DEFAULT false NOT NULL,
	`exact_net_pnl_usdt` real,
	`outcome` text DEFAULT 'UNAVAILABLE' NOT NULL,
	`evidence_complete` integer DEFAULT false NOT NULL,
	`review_comment` text,
	`reviewed_by` text NOT NULL,
	`experience_json` text DEFAULT '{}' NOT NULL,
	`capability_before_json` text DEFAULT '{}' NOT NULL,
	`capability_after_json` text DEFAULT '{}' NOT NULL,
	`reviewed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_learning_reviews_key_uidx` ON `strategy_learning_reviews` (`learning_key`);--> statement-breakpoint
CREATE INDEX `strategy_learning_reviews_strategy_idx` ON `strategy_learning_reviews` (`strategy_id`,`config_version`,`decision`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_learning_reviews_brain_version_uidx` ON `strategy_learning_reviews` (`brain_key`,`config_version`,`memory_version`);
