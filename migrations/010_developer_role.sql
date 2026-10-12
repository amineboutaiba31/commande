-- The developer role can only invite and remove the company's administrators.
IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographeUsers_Role'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeUsers')
    AND definition NOT LIKE N'%developer%'
)
BEGIN
  ALTER TABLE dbo.PromographeUsers DROP CONSTRAINT CK_PromographeUsers_Role;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographeUsers_Role'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeUsers')
)
BEGIN
  ALTER TABLE dbo.PromographeUsers ADD CONSTRAINT CK_PromographeUsers_Role
    CHECK (Role IN (N'developer', N'admin', N'department_manager'));
END;
