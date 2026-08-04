ALTER TABLE `feeds` ADD `routed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_decisions` ADD `kind` text DEFAULT 'exception' NOT NULL;