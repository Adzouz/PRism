CREATE TABLE `activity` (
	`repo_id` integer NOT NULL,
	`day` text NOT NULL,
	`opened` integer NOT NULL,
	`merged` integer NOT NULL,
	`closed` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `day`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `review_latency` (
	`repo_id` integer NOT NULL,
	`pr_node_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`reviewed_at` integer NOT NULL,
	PRIMARY KEY(`pr_node_id`, `requested_at`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_latency_reviewed` ON `review_latency` (`reviewed_at`);--> statement-breakpoint
ALTER TABLE `snapshots` DROP COLUMN `opened`;--> statement-breakpoint
ALTER TABLE `snapshots` DROP COLUMN `merged`;--> statement-breakpoint
ALTER TABLE `snapshots` DROP COLUMN `closed`;--> statement-breakpoint
ALTER TABLE `snapshots` DROP COLUMN `latency_median_s`;