IF OBJECT_ID(N'dbo.PromographeProducts', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeProducts (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographeProducts PRIMARY KEY,
    Name nvarchar(150) NOT NULL,
    Description nvarchar(500) NOT NULL CONSTRAINT DF_PromographeProducts_Description DEFAULT N'',
    UnitPriceCents int NOT NULL,
    IsActive bit NOT NULL CONSTRAINT DF_PromographeProducts_IsActive DEFAULT 1,
    CreatedByUserId int NOT NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeProducts_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_PromographeProducts_UnitPriceCents CHECK (UnitPriceCents >= 0),
    CONSTRAINT FK_PromographeProducts_CreatedBy FOREIGN KEY (CreatedByUserId)
      REFERENCES dbo.PromographeUsers(Id)
  );
END;

IF OBJECT_ID(N'dbo.PromographeOrders', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeOrders (
    Id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographeOrders PRIMARY KEY,
    DepartmentId int NOT NULL,
    CreatedByUserId int NOT NULL,
    Status nvarchar(16) NOT NULL CONSTRAINT DF_PromographeOrders_Status DEFAULT N'pending',
    Notes nvarchar(1000) NULL,
    DecisionNote nvarchar(1000) NULL,
    DecidedByUserId int NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeOrders_CreatedAt DEFAULT SYSUTCDATETIME(),
    DecidedAt datetime2(0) NULL,
    CONSTRAINT CK_PromographeOrders_Status CHECK (Status IN (N'pending', N'approved', N'rejected')),
    CONSTRAINT FK_PromographeOrders_Department FOREIGN KEY (DepartmentId)
      REFERENCES dbo.PromographeDepartments(Id),
    CONSTRAINT FK_PromographeOrders_CreatedBy FOREIGN KEY (CreatedByUserId)
      REFERENCES dbo.PromographeUsers(Id),
    CONSTRAINT FK_PromographeOrders_DecidedBy FOREIGN KEY (DecidedByUserId)
      REFERENCES dbo.PromographeUsers(Id)
  );
END;

IF OBJECT_ID(N'dbo.PromographeOrderItems', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeOrderItems (
    Id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographeOrderItems PRIMARY KEY,
    OrderId bigint NOT NULL,
    ProductId int NOT NULL,
    ProductName nvarchar(150) NOT NULL,
    UnitPriceCents int NOT NULL,
    Quantity int NOT NULL,
    CONSTRAINT CK_PromographeOrderItems_UnitPriceCents CHECK (UnitPriceCents >= 0),
    CONSTRAINT CK_PromographeOrderItems_Quantity CHECK (Quantity > 0),
    CONSTRAINT FK_PromographeOrderItems_Order FOREIGN KEY (OrderId)
      REFERENCES dbo.PromographeOrders(Id) ON DELETE CASCADE,
    CONSTRAINT FK_PromographeOrderItems_Product FOREIGN KEY (ProductId)
      REFERENCES dbo.PromographeProducts(Id)
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_PromographeOrders_Department_CreatedAt'
    AND object_id = OBJECT_ID(N'dbo.PromographeOrders')
)
BEGIN
  CREATE INDEX IX_PromographeOrders_Department_CreatedAt
    ON dbo.PromographeOrders(DepartmentId, CreatedAt DESC);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_PromographeOrderItems_OrderId'
    AND object_id = OBJECT_ID(N'dbo.PromographeOrderItems')
)
BEGIN
  CREATE INDEX IX_PromographeOrderItems_OrderId
    ON dbo.PromographeOrderItems(OrderId);
END;
