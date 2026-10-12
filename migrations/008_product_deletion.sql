-- Deleted products are hidden but kept, so existing order lines still reference them.
IF COL_LENGTH(N'dbo.PromographeProducts', N'DeletedAt') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeProducts ADD DeletedAt datetime2(0) NULL;
END;
