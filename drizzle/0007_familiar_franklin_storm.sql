ALTER TABLE `pr_flags` ADD `approved_oid` text;--> statement-breakpoint
ALTER TABLE `pr_flags` ADD `approved_at` integer;--> statement-breakpoint
UPDATE `prs` SET `derived_stage` = CASE `derived_stage` WHEN 'waiting-on-author' THEN 'changes-requested' WHEN 'draft' THEN 'to-review' WHEN 'waiting-for-review' THEN 'to-review' WHEN 'verdict-ready' THEN 'to-review' WHEN 'ready-to-post' THEN 'changes-requested' ELSE `derived_stage` END;--> statement-breakpoint
UPDATE `pr_flags` SET `manual_stage` = NULL, `manual_stage_basis` = NULL WHERE `manual_stage` IN ('waiting-on-author', 'draft', 'waiting-for-review', 'verdict-ready', 'ready-to-post');
