CREATE TABLE `pr_flags` (
	`pr_id` integer PRIMARY KEY NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`manual_stage` text,
	`manual_stage_basis` text,
	FOREIGN KEY (`pr_id`) REFERENCES `prs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `prs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`node_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`author` text NOT NULL,
	`author_avatar` text,
	`is_draft` integer NOT NULL,
	`state` text NOT NULL,
	`head_ref` text NOT NULL,
	`head_oid` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_oid` text NOT NULL,
	`review_decision` text,
	`ci_state` text NOT NULL,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`additions` integer NOT NULL,
	`deletions` integer NOT NULL,
	`changed_files` integer NOT NULL,
	`unresolved_threads` integer DEFAULT 0 NOT NULL,
	`review_requested` integer NOT NULL,
	`requested_team` text,
	`my_review_state` text,
	`my_review_oid` text,
	`my_review_at` integer,
	`my_role` text NOT NULL,
	`derived_stage` text NOT NULL,
	`stage_since` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prs_node_id_unique` ON `prs` (`node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prs_repo_number` ON `prs` (`repo_id`,`number`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`repo_id` integer NOT NULL,
	`day` text NOT NULL,
	`open_prs` integer NOT NULL,
	`open_issues` integer NOT NULL,
	`awaiting_me` integer NOT NULL,
	`my_open` integer NOT NULL,
	`opened` integer NOT NULL,
	`merged` integer NOT NULL,
	`closed` integer NOT NULL,
	`latency_median_s` integer,
	`taken_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `day`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
