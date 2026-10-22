-- The director transmits each purchase order to its supplier (email, text message, website
-- or phone) before the accountant marks it bought: open → sent → purchased.
IF COL_LENGTH(N'dbo.PromographeSuppliers', N'Website') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeSuppliers ADD
    Website nvarchar(300) NOT NULL CONSTRAINT DF_PromographeSuppliers_Website DEFAULT N'',
    OrderMethod nvarchar(16) NOT NULL CONSTRAINT DF_PromographeSuppliers_OrderMethod DEFAULT N'';
END;

IF COL_LENGTH(N'dbo.PromographePurchaseOrders', N'SentAt') IS NULL
BEGIN
  ALTER TABLE dbo.PromographePurchaseOrders ADD
    SentAt datetime2(0) NULL,
    SentByUserId int NULL,
    SentByEmailSnapshot nvarchar(254) NULL,
    SentMethod nvarchar(16) NULL,
    SentNote nvarchar(1000) NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'FK_PromographePurchaseOrders_SentBy'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographePurchaseOrders')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographePurchaseOrders ADD CONSTRAINT FK_PromographePurchaseOrders_SentBy
    FOREIGN KEY (SentByUserId) REFERENCES dbo.PromographeUsers(Id);');
END;

IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographePurchaseOrders_Status'
    AND definition NOT LIKE N'%sent%'
)
BEGIN
  ALTER TABLE dbo.PromographePurchaseOrders DROP CONSTRAINT CK_PromographePurchaseOrders_Status;
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_PromographePurchaseOrders_Status')
BEGIN
  ALTER TABLE dbo.PromographePurchaseOrders ADD CONSTRAINT CK_PromographePurchaseOrders_Status
    CHECK (Status IN (N'open', N'sent', N'purchased'));
END;
