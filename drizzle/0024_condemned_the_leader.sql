ALTER TABLE `trading_accounts` ADD `execution_mode` text DEFAULT 'SIMULATION' NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_accounts` ADD `operator_name` text DEFAULT '管理员' NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_accounts` ADD `note` text;