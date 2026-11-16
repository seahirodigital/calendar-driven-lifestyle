CREATE TABLE `station_cafes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station` text NOT NULL,
	`name` text NOT NULL,
	`chain_name` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`map_url` text DEFAULT '' NOT NULL,
	`photo_url` text,
	`source_label` text DEFAULT '' NOT NULL,
	`source_url` text,
	`note` text DEFAULT '' NOT NULL,
	`rank` integer DEFAULT 0 NOT NULL,
	`researched_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `station_cafes_station_name_unique` ON `station_cafes` (`station`, `name`);
--> statement-breakpoint
CREATE INDEX `station_cafes_station_idx` ON `station_cafes` (`station`);
--> statement-breakpoint
CREATE TABLE `cafe_stations` (
	`station` text PRIMARY KEY NOT NULL,
	`registered` integer DEFAULT 0 NOT NULL,
	`source_label` text DEFAULT '' NOT NULL,
	`researched_at` integer
);
