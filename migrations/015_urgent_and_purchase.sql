-- Urgent requests, and the accountant's purchase of approved requests.
IF COL_LENGTH(N'dbo.PromographeOrders', N'IsUrgent') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrders ADD IsUrgent bit NOT NULL
    CONSTRAINT DF_PromographeOrders_IsUrgent DEFAULT 0;
END;

IF COL_LENGTH(N'dbo.PromographeOrders', N'PurchasedAt') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrders ADD
    PurchasedAt datetime2(0) NULL,
    PurchasedByUserId int NULL,
    PurchasedByEmailSnapshot nvarchar(254) NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'FK_PromographeOrders_PurchasedBy'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeOrders')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographeOrders ADD CONSTRAINT FK_PromographeOrders_PurchasedBy
    FOREIGN KEY (PurchasedByUserId) REFERENCES dbo.PromographeUsers(Id);');
END;
