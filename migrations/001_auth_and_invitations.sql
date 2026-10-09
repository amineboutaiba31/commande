IF OBJECT_ID(N'dbo.PromographeDepartments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeDepartments (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographeDepartments PRIMARY KEY,
    Name nvarchar(100) NOT NULL CONSTRAINT UQ_PromographeDepartments_Name UNIQUE,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeDepartments_CreatedAt DEFAULT SYSUTCDATETIME()
  );
END;

IF OBJECT_ID(N'dbo.PromographeUsers', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeUsers (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographeUsers PRIMARY KEY,
    Email nvarchar(254) NOT NULL,
    PasswordHash nvarchar(255) NOT NULL,
    Role nvarchar(32) NOT NULL,
    DepartmentId int NULL,
    IsActive bit NOT NULL CONSTRAINT DF_PromographeUsers_IsActive DEFAULT 1,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeUsers_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_PromographeUsers_Email UNIQUE (Email),
    CONSTRAINT FK_PromographeUsers_Department FOREIGN KEY (DepartmentId)
      REFERENCES dbo.PromographeDepartments(Id),
    CONSTRAINT CK_PromographeUsers_Role CHECK (Role IN (N'admin', N'department_manager')),
    CONSTRAINT CK_PromographeUsers_ManagerDepartment
      CHECK (Role <> N'department_manager' OR DepartmentId IS NOT NULL)
  );
END;

IF OBJECT_ID(N'dbo.PromographeInvitations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeInvitations (
    Id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographeInvitations PRIMARY KEY,
    UserId int NOT NULL,
    TokenHash char(64) NOT NULL,
    ExpiresAt bigint NOT NULL,
    UsedAt bigint NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeInvitations_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_PromographeInvitations_TokenHash UNIQUE (TokenHash),
    CONSTRAINT FK_PromographeInvitations_User FOREIGN KEY (UserId)
      REFERENCES dbo.PromographeUsers(Id) ON DELETE CASCADE
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_PromographeInvitations_UserId'
    AND object_id = OBJECT_ID(N'dbo.PromographeInvitations')
)
BEGIN
  CREATE INDEX IX_PromographeInvitations_UserId
    ON dbo.PromographeInvitations(UserId, UsedAt, ExpiresAt);
END;

IF OBJECT_ID(N'dbo.PromographeSessions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeSessions (
    Sid nvarchar(256) NOT NULL CONSTRAINT PK_PromographeSessions PRIMARY KEY,
    SessionData nvarchar(max) NOT NULL,
    ExpiresAt bigint NOT NULL
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_PromographeSessions_ExpiresAt'
    AND object_id = OBJECT_ID(N'dbo.PromographeSessions')
)
BEGIN
  CREATE INDEX IX_PromographeSessions_ExpiresAt
    ON dbo.PromographeSessions(ExpiresAt);
END;

IF OBJECT_ID(N'dbo.PromographeSchemaMigrations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographeSchemaMigrations (
    Version int NOT NULL CONSTRAINT PK_PromographeSchemaMigrations PRIMARY KEY,
    AppliedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeSchemaMigrations_AppliedAt DEFAULT SYSUTCDATETIME()
  );
END;
