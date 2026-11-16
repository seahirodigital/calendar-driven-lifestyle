CREATE TABLE `shop_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shop_name` text NOT NULL,
	`tabelog_url` text NOT NULL,
	`rating` real NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`area` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_feedback_tabelog_url_unique` ON `shop_feedback` (`tabelog_url`);
