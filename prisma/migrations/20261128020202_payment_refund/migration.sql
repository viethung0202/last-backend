-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "payDate" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);
