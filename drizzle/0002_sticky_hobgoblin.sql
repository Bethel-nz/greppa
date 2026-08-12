ALTER TABLE "documents" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder_id" text;--> statement-breakpoint
CREATE INDEX "documents_placement_idx" ON "documents" USING btree ("workspace_id","folder_id");