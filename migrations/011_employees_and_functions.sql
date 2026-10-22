-- Purchasing procedure roles: every staff member is an "employee" of one department, each
-- department names the employee who approves its purchases, and employees can hold the
-- procedure's functions (transmitter, receiving, accounting, general management).

-- 1. The ordering role becomes "employee".
IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographeUsers_Role'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeUsers')
    AND definition NOT LIKE N'%employee%'
)
BEGIN
  ALTER TABLE dbo.PromographeUsers DROP CONSTRAINT CK_PromographeUsers_Role;
END;

IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographeUsers_ManagerDepartment'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeUsers')
)
BEGIN
  ALTER TABLE dbo.PromographeUsers DROP CONSTRAINT CK_PromographeUsers_ManagerDepartment;
END;

UPDATE dbo.PromographeUsers SET Role = N'employee' WHERE Role = N'department_manager';

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographeUsers_Role'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeUsers')
)
BEGIN
  ALTER TABLE dbo.PromographeUsers ADD CONSTRAINT CK_PromographeUsers_Role
    CHECK (Role IN (N'developer', N'admin', N'employee'));
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = N'CK_PromographeUsers_EmployeeDepartment'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeUsers')
)
BEGIN
  ALTER TABLE dbo.PromographeUsers ADD CONSTRAINT CK_PromographeUsers_EmployeeDepartment
    CHECK (Role <> N'employee' OR DepartmentId IS NOT NULL);
END;

-- 2. Each department names its responsable (purchase approver); one person may lead several.
IF COL_LENGTH(N'dbo.PromographeDepartments', N'ManagerUserId') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeDepartments ADD ManagerUserId int NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'FK_PromographeDepartments_Manager'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeDepartments')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographeDepartments ADD CONSTRAINT FK_PromographeDepartments_Manager
    FOREIGN KEY (ManagerUserId) REFERENCES dbo.PromographeUsers(Id);');
END;

-- 3. Procedure functions held by a user (several per user).
IF OBJECT_ID(N'dbo.PromographeUserFunctions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeUserFunctions (
    UserId int NOT NULL,
    FunctionCode nvarchar(32) NOT NULL,
    CONSTRAINT PK_PromographeUserFunctions PRIMARY KEY (UserId, FunctionCode),
    CONSTRAINT FK_PromographeUserFunctions_User FOREIGN KEY (UserId)
      REFERENCES dbo.PromographeUsers(Id) ON DELETE CASCADE,
    CONSTRAINT CK_PromographeUserFunctions_Code CHECK (FunctionCode IN (
      N'transmitter_admin', N'transmitter_production', N'transmitter_sales',
      N'transmitter_backup', N'reception', N'accounting', N'general_management'
    ))
  );
END;
