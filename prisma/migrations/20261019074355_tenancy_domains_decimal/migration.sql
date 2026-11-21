-- Hand-edited to keep existing data: money columns are converted (cents / 100),
-- Store.ownerId becomes an OWNER membership, every store gets <slug>.localhost.

-- CreateEnum
CREATE TYPE "StoreRole" AS ENUM ('OWNER', 'STAFF');

-- Money: Int cents -> Decimal(12,2)
ALTER TABLE "ProductVariant" ALTER COLUMN "priceCents" TYPE DECIMAL(12,2) USING "priceCents" / 100.0;
ALTER TABLE "ProductVariant" RENAME COLUMN "priceCents" TO "price";
ALTER TABLE "Order" ALTER COLUMN "totalCents" TYPE DECIMAL(12,2) USING "totalCents" / 100.0;
ALTER TABLE "Order" RENAME COLUMN "totalCents" TO "total";
ALTER TABLE "OrderItem" ALTER COLUMN "unitPriceCents" TYPE DECIMAL(12,2) USING "unitPriceCents" / 100.0;
ALTER TABLE "OrderItem" RENAME COLUMN "unitPriceCents" TO "unitPrice";
ALTER TABLE "Payment" ALTER COLUMN "amountCents" TYPE DECIMAL(12,2) USING "amountCents" / 100.0;
ALTER TABLE "Payment" RENAME COLUMN "amountCents" TO "amount";

-- CreateTable
CREATE TABLE "StoreMember" (
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "role" "StoreRole" NOT NULL DEFAULT 'STAFF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreMember_pkey" PRIMARY KEY ("userId","storeId")
);

-- CreateTable
CREATE TABLE "StoreDomain" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreDomain_pkey" PRIMARY KEY ("id")
);

-- Backfill
INSERT INTO "StoreMember" ("userId", "storeId", "role") SELECT "ownerId", "id", 'OWNER' FROM "Store";
INSERT INTO "StoreDomain" ("id", "storeId", "hostname", "isPrimary") SELECT 'dom_' || "id", "id", "slug" || '.localhost', true FROM "Store";

-- Store: drop owner + marketplace flag, add currency
ALTER TABLE "Store" DROP CONSTRAINT "Store_ownerId_fkey";
DROP INDEX "Store_ownerId_idx";
ALTER TABLE "Store" DROP COLUMN "isListedOnMarketplace",
DROP COLUMN "ownerId",
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'VND';

-- DropTable
DROP TABLE "MarketplaceAccount";

-- CreateIndex
CREATE INDEX "StoreMember_storeId_idx" ON "StoreMember"("storeId");
CREATE UNIQUE INDEX "StoreDomain_hostname_key" ON "StoreDomain"("hostname");
CREATE INDEX "StoreDomain_storeId_idx" ON "StoreDomain"("storeId");

-- AddForeignKey
ALTER TABLE "StoreMember" ADD CONSTRAINT "StoreMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreMember" ADD CONSTRAINT "StoreMember_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreDomain" ADD CONSTRAINT "StoreDomain_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
