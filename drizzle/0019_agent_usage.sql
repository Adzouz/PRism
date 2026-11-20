CREATE TABLE `agent_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`stage` text NOT NULL,
	`model` text NOT NULL,
	`at` integer NOT NULL,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`cost_usd` real NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_usage_at` ON `agent_usage` (`at`);--> statement-breakpoint
INSERT INTO `agent_usage` (`repo_id`, `run_id`, `stage`, `model`, `at`, `tokens_in`, `tokens_out`, `cost_usd`)
SELECT `prs`.`repo_id`, `runs`.`id`, `runs`.`stage`, `runs`.`model`, coalesce(`runs`.`ended_at`, `runs`.`started_at`, `runs`.`created_at`), `runs`.`tokens_in`, `runs`.`tokens_out`, `runs`.`cost_usd`
FROM `runs` INNER JOIN `prs` ON `prs`.`id` = `runs`.`pr_id`
WHERE `runs`.`cost_usd` > 0 OR `runs`.`tokens_in` > 0 OR `runs`.`tokens_out` > 0;
