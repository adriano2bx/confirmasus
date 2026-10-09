DROP INDEX IF EXISTS "convocations_campaign_id_patient_id_key";

CREATE UNIQUE INDEX "convocations_campaign_id_patient_id_selected_phone_id_key"
ON "convocations"("campaign_id", "patient_id", "selected_phone_id");
