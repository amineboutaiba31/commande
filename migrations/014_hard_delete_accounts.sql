-- Deleting an account removes it from the database for good. Purchase history stays: each request
-- keeps a copy of who made it and who decided it, and the account links become optional.
IF COL_LENGTH(N'dbo.PromographeOrders', N'CreatedByEmailSnapshot') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrders ADD
    CreatedByEmailSnapshot nvarchar(254) NULL,
    CreatedByNameSnapshot nvarchar(150) NULL,
    DecidedByEmailSnapshot nvarchar(254) NULL;
END;

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.PromographeOrders') AND name = N'CreatedByUserId' AND is_nullable = 0
)
BEGIN
  ALTER TABLE dbo.PromographeOrders ALTER COLUMN CreatedByUserId int NULL;
END;

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.PromographeProducts') AND name = N'CreatedByUserId' AND is_nullable = 0
)
BEGIN
  ALTER TABLE dbo.PromographeProducts ALTER COLUMN CreatedByUserId int NULL;
END;

-- Accounts that were only deactivated before this change are now deleted for good.
EXEC(N'
  UPDATE o SET o.CreatedByEmailSnapshot = u.Email, o.CreatedByNameSnapshot = u.FullName, o.CreatedByUserId = NULL
  FROM dbo.PromographeOrders o JOIN dbo.PromographeUsers u ON u.Id = o.CreatedByUserId
  WHERE u.DeletedAt IS NOT NULL;
  UPDATE o SET o.DecidedByEmailSnapshot = u.Email, o.DecidedByUserId = NULL
  FROM dbo.PromographeOrders o JOIN dbo.PromographeUsers u ON u.Id = o.DecidedByUserId
  WHERE u.DeletedAt IS NOT NULL;
  UPDATE p SET p.CreatedByUserId = NULL
  FROM dbo.PromographeProducts p JOIN dbo.PromographeUsers u ON u.Id = p.CreatedByUserId
  WHERE u.DeletedAt IS NOT NULL;
  UPDATE d SET d.ManagerUserId = NULL
  FROM dbo.PromographeDepartments d JOIN dbo.PromographeUsers u ON u.Id = d.ManagerUserId
  WHERE u.DeletedAt IS NOT NULL;
  DELETE FROM dbo.PromographeUsers WHERE DeletedAt IS NOT NULL;
');
