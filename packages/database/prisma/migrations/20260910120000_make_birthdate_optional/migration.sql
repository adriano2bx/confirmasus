-- Make birth_date optional to allow imports without dataNascimento
ALTER TABLE "patients" ALTER COLUMN "birth_date" DROP NOT NULL;
