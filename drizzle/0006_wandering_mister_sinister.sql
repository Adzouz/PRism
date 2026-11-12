CREATE TABLE `post_gates` (
	`run_id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mode` text,
	`event` text,
	`body` text,
	`commit_message` text,
	`committed_oid` text,
	`pushed_oid` text,
	`replies_json` text,
	`gh_review_id` text,
	`gh_review_url` text,
	`confirmed_at` integer,
	`posted_at` integer,
	`skipped_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `repos` ADD `post_mode` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `push_remote` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `push_ref` text;