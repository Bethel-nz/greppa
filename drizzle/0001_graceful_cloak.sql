CREATE TABLE "scope_members" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scopes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scope_members" ADD CONSTRAINT "scope_members_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_members" ADD CONSTRAINT "scope_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scopes" ADD CONSTRAINT "scopes_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scopes" ADD CONSTRAINT "scopes_owner_org_id_organizations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scope_member_scope_user_unique" ON "scope_members" USING btree ("scope_id","user_id");--> statement-breakpoint
CREATE INDEX "scope_members_scope_idx" ON "scope_members" USING btree ("scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_owner_name_unique" ON "scopes" USING btree ("owner_user_id","name");--> statement-breakpoint
CREATE INDEX "scopes_owner_idx" ON "scopes" USING btree ("owner_user_id");