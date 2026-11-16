CREATE TABLE `station_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dest_station` text NOT NULL,
	`origin_station` text NOT NULL,
	`fare_ic_yen` integer,
	`duration_min` integer,
	`transfers` integer DEFAULT 0 NOT NULL,
	`source_label` text DEFAULT '' NOT NULL,
	`source_url` text,
	`legs_json` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `station_routes_dest_station_unique` ON `station_routes` (`dest_station`);
