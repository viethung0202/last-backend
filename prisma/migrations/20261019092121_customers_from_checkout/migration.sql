-- AlterTable
ALTER TABLE "Customer" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- Backfill: one customer per (store, guest email) from existing guest orders.
INSERT INTO "Customer" ("id", "storeId", "email", "name", "createdAt")
SELECT 'cus_' || md5("storeId" || lower("guestEmail")), "storeId", lower("guestEmail"), max("guestName"), min("createdAt")
FROM "Order"
WHERE "customerId" IS NULL AND "guestEmail" IS NOT NULL
GROUP BY "storeId", lower("guestEmail")
ON CONFLICT ("storeId", "email") DO NOTHING;

UPDATE "Order" o SET "customerId" = c."id"
FROM "Customer" c
WHERE o."customerId" IS NULL AND c."storeId" = o."storeId" AND c."email" = lower(o."guestEmail");
