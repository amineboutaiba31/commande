-- Consolidated purchase orders: approved request lines are grouped by supplier into one
-- purchase order (BC-AAAA-NNNN) that the accountant buys at once.
IF OBJECT_ID(N'dbo.PromographePurchaseOrders', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographePurchaseOrders (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographePurchaseOrders PRIMARY KEY,
    Number nvarchar(20) NOT NULL CONSTRAINT UQ_PromographePurchaseOrders_Number UNIQUE,
    SupplierId int NULL,
    SupplierName nvarchar(150) NULL,
    Status nvarchar(16) NOT NULL CONSTRAINT DF_PromographePurchaseOrders_Status DEFAULT N'open',
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographePurchaseOrders_CreatedAt DEFAULT SYSUTCDATETIME(),
    PurchasedAt datetime2(0) NULL,
    PurchasedByUserId int NULL,
    PurchasedByEmailSnapshot nvarchar(254) NULL,
    CONSTRAINT CK_PromographePurchaseOrders_Status CHECK (Status IN (N'open', N'purchased')),
    CONSTRAINT FK_PromographePurchaseOrders_Supplier FOREIGN KEY (SupplierId)
      REFERENCES dbo.PromographeSuppliers(Id),
    CONSTRAINT FK_PromographePurchaseOrders_PurchasedBy FOREIGN KEY (PurchasedByUserId)
      REFERENCES dbo.PromographeUsers(Id)
  );
END;

-- Each request line remembers its supplier at the time of the request, and its purchase order.
IF COL_LENGTH(N'dbo.PromographeOrderItems', N'SupplierId') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrderItems ADD
    SupplierId int NULL,
    SupplierName nvarchar(150) NULL,
    PurchaseOrderId int NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'FK_PromographeOrderItems_PurchaseOrder'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeOrderItems')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographeOrderItems ADD CONSTRAINT FK_PromographeOrderItems_PurchaseOrder
    FOREIGN KEY (PurchaseOrderId) REFERENCES dbo.PromographePurchaseOrders(Id);');
END;

-- Existing lines take their product's current supplier.
EXEC(N'
  UPDATE i SET i.SupplierId = p.SupplierId, i.SupplierName = s.Name
  FROM dbo.PromographeOrderItems i
  JOIN dbo.PromographeProducts p ON p.Id = i.ProductId
  LEFT JOIN dbo.PromographeSuppliers s ON s.Id = p.SupplierId
  WHERE i.SupplierId IS NULL AND i.SupplierName IS NULL;
');
