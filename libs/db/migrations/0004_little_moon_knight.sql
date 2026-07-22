ALTER TABLE `family_member_feeds` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `family_member_feeds` SET `position` = (
  SELECT COUNT(*) FROM `family_member_feeds` AS `f2`
  WHERE `f2`.`family_member_id` = `family_member_feeds`.`family_member_id`
    AND (
      `f2`.`created_at` < `family_member_feeds`.`created_at`
      OR (`f2`.`created_at` = `family_member_feeds`.`created_at` AND `f2`.`id` < `family_member_feeds`.`id`)
    )
);--> statement-breakpoint
CREATE INDEX `fmf_member_position_idx` ON `family_member_feeds` (`family_member_id`,`position`);
