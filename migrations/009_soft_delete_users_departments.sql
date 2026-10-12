-- Deleted managers and departments are hidden but kept, so order history still names them.
IF COL_LENGTH(N'dbo.PromographeUsers', N'DeletedAt') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeUsers ADD DeletedAt datetime2(0) NULL;
END;

IF COL_LENGTH(N'dbo.PromographeDepartments', N'DeletedAt') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeDepartments ADD DeletedAt datetime2(0) NULL;
END;
