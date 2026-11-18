CREATE TABLE "exam_automation" (
	"exam_config_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"version" integer NOT NULL,
	"device_ids" jsonb NOT NULL,
	"activation_command_ids" jsonb NOT NULL,
	"stop_command_id" uuid NOT NULL,
	"public_origin" text NOT NULL,
	"prepare_at" timestamp with time zone NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"stop_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"last_error" text,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exam_automation" ADD CONSTRAINT "exam_automation_exam_config_id_exam_config_id_fk" FOREIGN KEY ("exam_config_id") REFERENCES "public"."exam_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_automation" ADD CONSTRAINT "exam_automation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exam_automation_due_idx" ON "exam_automation" USING btree ("status","prepare_at");