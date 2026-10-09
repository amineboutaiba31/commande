IF COL_LENGTH(N'dbo.PromographeDepartments', N'BudgetCents') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeDepartments ADD BudgetCents bigint NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographeDepartments_BudgetCents'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeDepartments')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographeDepartments ADD CONSTRAINT CK_PromographeDepartments_BudgetCents
    CHECK (BudgetCents IS NULL OR BudgetCents >= 0);');
END;
