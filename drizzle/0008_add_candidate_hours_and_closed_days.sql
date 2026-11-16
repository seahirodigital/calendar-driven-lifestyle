ALTER TABLE `candidates` ADD COLUMN `hours_text` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `candidates` ADD COLUMN `closed_days` text DEFAULT '' NOT NULL;
