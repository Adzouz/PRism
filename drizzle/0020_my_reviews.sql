CREATE TABLE `my_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` integer NOT NULL,
	`pr_node_id` text NOT NULL,
	`approved` integer NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `my_reviews_submitted` ON `my_reviews` (`submitted_at`);--> statement-breakpoint
ALTER TABLE `repos` ADD `reviews_fetched_at` integer;