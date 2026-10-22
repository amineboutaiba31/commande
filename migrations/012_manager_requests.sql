-- An employee can ask, at their first sign-in, to be named responsable of a department.
-- The request waits for an administrator's decision; it grants nothing on its own.
IF COL_LENGTH(N'dbo.PromographeUsers', N'RequestedManagerDepartmentId') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeUsers ADD RequestedManagerDepartmentId int NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = N'FK_PromographeUsers_RequestedManagerDepartment'
    AND parent_object_id = OBJECT_ID(N'dbo.PromographeUsers')
)
BEGIN
  EXEC(N'ALTER TABLE dbo.PromographeUsers ADD CONSTRAINT FK_PromographeUsers_RequestedManagerDepartment
    FOREIGN KEY (RequestedManagerDepartmentId) REFERENCES dbo.PromographeDepartments(Id);');
END;
