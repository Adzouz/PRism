CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`local_path` text,
	`worktree_root` text,
	`skill_source_id` integer,
	`auto_run` integer DEFAULT false NOT NULL,
	`ignored_checks_json` text DEFAULT '[]' NOT NULL,
	`qa_labels_json` text DEFAULT '[]' NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`skill_source_id`) REFERENCES `skill_sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_name` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `skill_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url_or_path` text NOT NULL,
	`local_path` text,
	`manifest_json` text,
	`identity` text,
	`setup_at` integer,
	`last_synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_sources_url_or_path_unique` ON `skill_sources` (`url_or_path`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`mode` text NOT NULL,
	`path` text NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `skill_sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `stage_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`repo_id` integer DEFAULT 0 NOT NULL,
	`stage` text NOT NULL,
	`skill_id` integer NOT NULL,
	`validated_at` integer,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stage_bindings_scope` ON `stage_bindings` (`repo_id`,`stage`);