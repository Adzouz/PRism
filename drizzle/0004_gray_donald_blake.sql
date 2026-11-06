CREATE TABLE `asks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`prompt` text NOT NULL,
	`schema_json` text DEFAULT '{}' NOT NULL,
	`answer_json` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asks_run` ON `asks` (`run_id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pr_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`anchor_path` text NOT NULL,
	`anchor_line` integer,
	`side` text NOT NULL,
	`hunk_hash` text,
	`severity` text NOT NULL,
	`nit_decision` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`suggestion` text,
	`prior_finding_id` integer,
	`included` integer DEFAULT true NOT NULL,
	`edited_body` text,
	`status` text DEFAULT 'open' NOT NULL,
	`gh_comment_id` text,
	FOREIGN KEY (`pr_id`) REFERENCES `prs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `findings_run` ON `findings` (`run_id`);--> statement-breakpoint
CREATE INDEX `findings_pr` ON `findings` (`pr_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run` ON `run_events` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pr_id` integer NOT NULL,
	`stage` text NOT NULL,
	`skill_id` integer,
	`skill_name` text,
	`agent` text NOT NULL,
	`model` text NOT NULL,
	`session_id` text,
	`worktree_path` text,
	`status` text NOT NULL,
	`progress` text,
	`reviewed_head_oid` text,
	`reviewed_base_oid` text,
	`report_json` text,
	`changes_json` text,
	`replies_json` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`dismissed_at` integer,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`pr_id`) REFERENCES `prs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_pr` ON `runs` (`pr_id`);--> statement-breakpoint
CREATE INDEX `runs_status` ON `runs` (`status`);