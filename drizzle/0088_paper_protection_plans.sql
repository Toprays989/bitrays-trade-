ALTER TABLE `paper_positions` ADD `take_profit_plan_json` text DEFAULT '[]' NOT NULL;
ALTER TABLE `paper_positions` ADD `stop_loss_plan_json` text DEFAULT '[]' NOT NULL;
ALTER TABLE `paper_positions` ADD `exit_reason` text;
