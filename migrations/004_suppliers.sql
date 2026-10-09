IF OBJECT_ID(N'dbo.PromographeSuppliers', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeSuppliers (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographeSuppliers PRIMARY KEY,
    Name nvarchar(150) NOT NULL CONSTRAINT UQ_PromographeSuppliers_Name UNIQUE,
    ContactName nvarchar(150) NOT NULL CONSTRAINT DF_PromographeSuppliers_ContactName DEFAULT N'',
    Email nvarchar(254) NOT NULL CONSTRAINT DF_PromographeSuppliers_Email DEFAULT N'',
    Phone nvarchar(50) NOT NULL CONSTRAINT DF_PromographeSuppliers_Phone DEFAULT N'',
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeSuppliers_CreatedAt DEFAULT SYSUTCDATETIME()
  );
END;

IF COL_LENGTH(N'dbo.PromographeProducts', N'SupplierId') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeProducts ADD SupplierId int NULL;
END;

-- Dynamic SQL so the new column is resolved after the ALTER above has run.
IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'FK_PromographeProducts_Supplier'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeProducts')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographeProducts ADD CONSTRAINT FK_PromographeProducts_Supplier
    FOREIGN KEY (SupplierId) REFERENCES dbo.PromographeSuppliers(Id);');
END;
