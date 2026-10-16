ALTER TABLE `feeds` ADD `suspicious_sweep_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `suspicious_since` integer;