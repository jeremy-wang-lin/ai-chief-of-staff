CREATE TABLE `briefings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`summary` text NOT NULL,
	`body_md` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `briefings_kind_date` ON `briefings` (`kind`,`date`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`title` text,
	`date` text NOT NULL,
	`type` text DEFAULT 'Scratch' NOT NULL,
	`attendees` text,
	`project_id` integer,
	`processed_at` text,
	`body_md` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`name` text NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`team` text,
	`risk` text,
	`next_milestone` text,
	`elevator_pitch` text,
	`body_md` text
);
--> statement-breakpoint
CREATE TABLE `radar` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`title` text NOT NULL,
	`severity` text DEFAULT 'P2' NOT NULL,
	`status` text DEFAULT 'Open' NOT NULL,
	`source` text,
	`owner` text,
	`project_id` integer,
	`note_id` integer,
	`body_md` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`row_id` integer NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`actor` text NOT NULL,
	`workflow` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revisions_target` ON `revisions` (`table_name`,`row_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'To-do' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`due_date` text,
	`source` text DEFAULT 'Self' NOT NULL,
	`origin` text DEFAULT 'human' NOT NULL,
	`owner` text,
	`project_id` integer,
	`radar_id` integer,
	`note_id` integer,
	`body_md` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`radar_id`) REFERENCES `radar`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE no action
);
