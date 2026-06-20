CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY,
	"email" varchar(255) NOT NULL UNIQUE,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "accounts_email_check" CHECK ("email" ~ '^[^@]+@[^@]+\.[^@]+$')
);
--> statement-breakpoint
CREATE TABLE "instance_members" (
	"instanceId" uuid PRIMARY KEY,
	"accountId" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY,
	"slug" varchar(100) NOT NULL UNIQUE,
	"expires" timestamp with time zone NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "instances_slug_check" CHECK ("slug" ~ '^[a-z0-9-]{4,100}$'),
	CONSTRAINT "instances_expires_check" CHECK ("expires" < ("created" + INTERVAL '1 year'))
);
--> statement-breakpoint
ALTER TABLE "instance_members" ADD CONSTRAINT "instance_members_instanceId_instances_id_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id");--> statement-breakpoint
ALTER TABLE "instance_members" ADD CONSTRAINT "instance_members_accountId_accounts_id_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id");