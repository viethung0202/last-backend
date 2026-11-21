-- Stores created before payment settings existed keep working checkout: COD on.
INSERT INTO "StorePaymentMethod" ("storeId", "method", "enabled")
SELECT "id", 'COD', true FROM "Store"
ON CONFLICT DO NOTHING;
