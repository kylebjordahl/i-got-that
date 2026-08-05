CREATE TABLE `apple_notification_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apple_notification_receipts_digest_unique` ON `apple_notification_receipts` (`digest`);