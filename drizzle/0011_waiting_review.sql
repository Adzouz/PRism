UPDATE `prs` SET `derived_stage` = 'waiting-review' WHERE `derived_stage` = 'to-review' AND `my_role` <> 'reviewer';--> statement-breakpoint
UPDATE `pr_flags` SET `manual_stage` = 'waiting-review' WHERE `manual_stage` = 'to-review' AND `pr_id` IN (SELECT `id` FROM `prs` WHERE `my_role` <> 'reviewer');
