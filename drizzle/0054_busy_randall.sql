ALTER TABLE `portfolio_risk_states` ADD `account_drawdown_phase` text DEFAULT 'NORMAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `portfolio_risk_states` ADD `account_drawdown_analysis_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `portfolio_risk_states` ADD `account_drawdown_action_position_ids_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `portfolio_risk_states` ADD `account_drawdown_triggered_at` integer;--> statement-breakpoint
ALTER TABLE `portfolio_risk_states` ADD `account_drawdown_last_action_at` integer;--> statement-breakpoint
ALTER TABLE `portfolio_risk_states` ADD `operator_rearm_required` integer DEFAULT false NOT NULL;