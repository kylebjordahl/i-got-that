DROP INDEX `invites_token_unique`;--> statement-breakpoint
ALTER TABLE `invites` ADD `token_hash` text;--> statement-breakpoint
UPDATE `invites` SET `status` = 'revoked' WHERE `status` = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
ALTER TABLE `invites` DROP COLUMN `token`;