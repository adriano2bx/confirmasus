-- Atendimento humano WhatsApp (ADR-18). Migração ADITIVA: nenhuma coluna/tabela existente é removida ou alterada.
-- Backfill de contatos/conversas é feito por script separado (packages/database/scripts/backfill-inbox.ts), com dry-run.

-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('AGENT', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'WAITING_CONTACT', 'SNOOZED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ConversationMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ConversationMessageKind" AS ENUM ('INBOUND', 'CAMPAIGN_REF', 'HUMAN_TEXT');

-- CreateEnum
CREATE TYPE "ConversationMessageStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'SUBMITTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ReplyEligibility" AS ENUM ('ELIGIBLE_TEMPLATE_REPLY', 'NOT_ELIGIBLE');

-- CreateEnum
CREATE TYPE "ConversationActivityType" AS ENUM ('CONVERSATION_OPENED', 'CONVERSATION_REOPENED', 'ASSIGNED', 'UNASSIGNED', 'TRANSFERRED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'CONTEXT_LINKED', 'CONTEXT_UNLINKED', 'AUTOMATION_PAUSED', 'AUTOMATION_RESUMED', 'HUMAN_SEND_BLOCKED', 'HUMAN_SEND_UNKNOWN', 'CONTACT_OPTED_OUT', 'CONTACT_OPTED_IN', 'NOTE_ADDED');

-- CreateEnum
CREATE TYPE "ConversationContextSource" AS ENUM ('TEMPLATE_REPLY', 'MANUAL');

-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'QUARANTINED', 'AVAILABLE', 'REJECTED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "ProcessingStatus" ADD VALUE 'DEAD_LETTER';

-- AlterTable
ALTER TABLE "convocations" ADD COLUMN     "human_hold_at" TIMESTAMPTZ(3),
ADD COLUMN     "human_hold_conversation_id" UUID;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "sender_phone_number_id" TEXT;

-- AlterTable
ALTER TABLE "message_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dead_lettered_at" TIMESTAMPTZ(3),
ADD COLUMN     "dispatch_lease_until" TIMESTAMPTZ(3),
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN     "phone_number_id" TEXT,
ADD COLUMN     "wa_id" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_contacts" (
    "id" UUID NOT NULL,
    "wa_id" TEXT NOT NULL,
    "profile_name" TEXT,
    "opted_out_at" TIMESTAMPTZ(3),
    "blocked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TeamMemberRole" NOT NULL DEFAULT 'AGENT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "team_id" UUID,
    "assignee_id" UUID,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_eligible_inbound_at" TIMESTAMPTZ(3),
    "last_outbound_at" TIMESTAMPTZ(3),
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozed_until" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "ConversationMessageDirection" NOT NULL,
    "kind" "ConversationMessageKind" NOT NULL,
    "status" "ConversationMessageStatus" NOT NULL,
    "content_type" TEXT NOT NULL,
    "body" TEXT,
    "campaign_message_id" UUID,
    "wa_message_id" TEXT,
    "context_wa_message_id" TEXT,
    "replied_campaign_message_id" UUID,
    "reply_eligibility" "ReplyEligibility",
    "eligibility_reason" TEXT,
    "author_id" UUID,
    "idempotency_key" TEXT,
    "source_event_id" UUID,
    "provider_timestamp" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_code" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_activities" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" "ConversationActivityType" NOT NULL,
    "from_team_id" UUID,
    "to_team_id" UUID,
    "from_user_id" UUID,
    "to_user_id" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_read_states" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ(3) NOT NULL,
    "last_read_message_id" UUID,

    CONSTRAINT "conversation_read_states_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "conversation_contexts" (
    "conversation_id" UUID NOT NULL,
    "convocation_id" UUID NOT NULL,
    "source" "ConversationContextSource" NOT NULL,
    "linked_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_contexts_pkey" PRIMARY KEY ("conversation_id","convocation_id")
);

-- CreateTable
CREATE TABLE "inbox_events" (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" UUID NOT NULL,
    "team_id" UUID,
    "type" TEXT NOT NULL,
    "entity_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "conversation_message_id" UUID NOT NULL,
    "provider_media_id" TEXT NOT NULL,
    "declared_mime_type" TEXT,
    "detected_mime_type" TEXT,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "storage_key" TEXT,
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING',
    "reject_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_wa_id_key" ON "whatsapp_contacts"("wa_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_slug_key" ON "teams"("slug");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_protocol_key" ON "conversations"("protocol");

-- CreateIndex
CREATE INDEX "conversations_team_id_status_last_activity_at_id_idx" ON "conversations"("team_id", "status", "last_activity_at" DESC, "id");

-- CreateIndex
CREATE INDEX "conversations_assignee_id_status_last_activity_at_id_idx" ON "conversations"("assignee_id", "status", "last_activity_at" DESC, "id");

-- CreateIndex
CREATE INDEX "conversations_status_last_activity_at_id_idx" ON "conversations"("status", "last_activity_at" DESC, "id");

-- CreateIndex
CREATE INDEX "conversations_contact_id_phone_number_id_idx" ON "conversations"("contact_id", "phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_campaign_message_id_key" ON "conversation_messages"("campaign_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_wa_message_id_key" ON "conversation_messages"("wa_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_idempotency_key_key" ON "conversation_messages"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_source_event_id_key" ON "conversation_messages"("source_event_id");

-- CreateIndex
CREATE INDEX "conversation_messages_conversation_id_created_at_id_idx" ON "conversation_messages"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "conversation_messages_kind_status_created_at_idx" ON "conversation_messages"("kind", "status", "created_at");

-- CreateIndex
CREATE INDEX "conversation_notes_conversation_id_created_at_id_idx" ON "conversation_notes"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "conversation_activities_conversation_id_created_at_id_idx" ON "conversation_activities"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "conversation_contexts_convocation_id_idx" ON "conversation_contexts"("convocation_id");

-- CreateIndex
CREATE INDEX "inbox_events_team_id_id_idx" ON "inbox_events"("team_id", "id");

-- CreateIndex
CREATE INDEX "inbox_events_created_at_idx" ON "inbox_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_provider_media_id_key" ON "media_assets"("provider_media_id");

-- CreateIndex
CREATE INDEX "media_assets_status_created_at_idx" ON "media_assets"("status", "created_at");

-- CreateIndex
CREATE INDEX "media_assets_expires_at_idx" ON "media_assets"("expires_at");

-- CreateIndex
CREATE INDEX "convocations_human_hold_conversation_id_idx" ON "convocations"("human_hold_conversation_id");

-- CreateIndex
CREATE INDEX "message_events_processing_status_next_attempt_at_idx" ON "message_events"("processing_status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "whatsapp_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_campaign_message_id_fkey" FOREIGN KEY ("campaign_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_replied_campaign_message_id_fkey" FOREIGN KEY ("replied_campaign_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_activities" ADD CONSTRAINT "conversation_activities_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_activities" ADD CONSTRAINT "conversation_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_contexts" ADD CONSTRAINT "conversation_contexts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_contexts" ADD CONSTRAINT "conversation_contexts_convocation_id_fkey" FOREIGN KEY ("convocation_id") REFERENCES "convocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_contexts" ADD CONSTRAINT "conversation_contexts_linked_by_id_fkey" FOREIGN KEY ("linked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_events" ADD CONSTRAINT "inbox_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_conversation_message_id_fkey" FOREIGN KEY ("conversation_message_id") REFERENCES "conversation_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Protocolo sequencial sem PII.
CREATE SEQUENCE IF NOT EXISTS "conversation_protocol_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Uma única conversa ativa (não resolvida) por contato + número empresarial.
CREATE UNIQUE INDEX "conversations_one_active_per_contact_number"
  ON "conversations" ("contact_id", "phone_number_id")
  WHERE "status" <> 'RESOLVED';

-- No máximo uma fila padrão.
CREATE UNIQUE INDEX "teams_single_default" ON "teams" ("is_default") WHERE "is_default" = true;

-- Despachante de outbox: eventos pendentes/falhos aguardando publicação.
CREATE INDEX "message_events_outbox_due"
  ON "message_events" ("next_attempt_at", "received_at")
  WHERE "processing_status" IN ('PENDING', 'FAILED');

-- Sender humano: mensagens humanas aguardando envio.
CREATE INDEX "conversation_messages_human_outbox"
  ON "conversation_messages" ("created_at")
  WHERE "kind" = 'HUMAN_TEXT' AND "status" = 'QUEUED';

-- Scheduler: convocações sob atendimento humano.
CREATE INDEX "convocations_human_hold" ON "convocations" ("human_hold_at") WHERE "human_hold_at" IS NOT NULL;
