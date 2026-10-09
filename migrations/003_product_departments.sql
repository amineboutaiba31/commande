IF COL_LENGTH(N'dbo.PromographeProducts', N'DepartmentId') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeProducts ADD DepartmentId int NULL;
END;

-- Dynamic SQL so the new column is resolved after the ALTER above has run.
IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'FK_PromographeProducts_Department'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeProducts')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographeProducts ADD CONSTRAINT FK_PromographeProducts_Department
    FOREIGN KEY (DepartmentId) REFERENCES dbo.PromographeDepartments(Id);');
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_PromographeProducts_DepartmentId'
    AND object_id = OBJECT_ID(N'dbo.PromographeProducts')
)
BEGIN
  EXEC(N'CREATE INDEX IX_PromographeProducts_DepartmentId
    ON dbo.PromographeProducts(DepartmentId, Name);');
END;
