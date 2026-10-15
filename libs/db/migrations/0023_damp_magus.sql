ALTER TABLE `external_accounts` ADD `auth_failed_at` integer;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD `auth_failure_message` text;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD `reauth_notified_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `reauth_alerts_enabled` integer DEFAULT true NOT NULL;