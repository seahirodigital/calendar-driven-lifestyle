ALTER TABLE `cafes` ADD COLUMN `location_type` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `station_cafes` ADD COLUMN `location_type` text DEFAULT 'unknown' NOT NULL;
