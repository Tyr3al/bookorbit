CREATE TABLE "abs_listening_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"library_id" integer NOT NULL,
	"source" varchar(10) DEFAULT 'live' NOT NULL,
	"display_title" varchar(1000) NOT NULL,
	"display_author" varchar(1000) DEFAULT '' NOT NULL,
	"cover_path" text,
	"duration" real,
	"play_method" integer DEFAULT 0 NOT NULL,
	"media_player" varchar(100) DEFAULT 'unknown' NOT NULL,
	"device_info" jsonb,
	"server_version" varchar(20) NOT NULL,
	"date" date NOT NULL,
	"day_of_week" varchar(10) NOT NULL,
	"time_listening" integer DEFAULT 0 NOT NULL,
	"start_time" real DEFAULT 0 NOT NULL,
	"current_time" real DEFAULT 0 NOT NULL,
	"media_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abs_listening_sessions_source_chk" CHECK ("abs_listening_sessions"."source" in ('live', 'local')),
	CONSTRAINT "abs_listening_sessions_time_listening_nonnegative_chk" CHECK ("abs_listening_sessions"."time_listening" >= 0),
	CONSTRAINT "abs_listening_sessions_start_time_nonnegative_chk" CHECK ("abs_listening_sessions"."start_time" >= 0),
	CONSTRAINT "abs_listening_sessions_current_time_nonnegative_chk" CHECK ("abs_listening_sessions"."current_time" >= 0)
);
--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "enable_audiobookshelf_api" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "abs_listening_sessions" ADD CONSTRAINT "abs_listening_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abs_listening_sessions" ADD CONSTRAINT "abs_listening_sessions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abs_listening_sessions" ADD CONSTRAINT "abs_listening_sessions_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abs_listening_sessions_user_updated_idx" ON "abs_listening_sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "abs_listening_sessions_user_book_updated_idx" ON "abs_listening_sessions" USING btree ("user_id","book_id","updated_at");--> statement-breakpoint
CREATE INDEX "abs_listening_sessions_book_id_idx" ON "abs_listening_sessions" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "abs_listening_sessions_library_id_idx" ON "abs_listening_sessions" USING btree ("library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abs_listening_sessions_live_uidx" ON "abs_listening_sessions" USING btree ("user_id","book_id") WHERE "abs_listening_sessions"."source" = 'live';