IF COL_LENGTH(N'dbo.PromographeUsers', N'SessionVersion') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeUsers ADD SessionVersion int NOT NULL
    CONSTRAINT DF_PromographeUsers_SessionVersion DEFAULT 0;
END;

IF OBJECT_ID(N'dbo.PromographePasswordResets', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromographePasswordResets (
    Id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_PromographePasswordResets PRIMARY KEY,
    UserId int NOT NULL,
    TokenHash char(64) NOT NULL,
    ExpiresAt bigint NOT NULL,
    UsedAt bigint NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographePasswordResets_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_PromographePasswordResets_TokenHash UNIQUE (TokenHash),
    CONSTRAINT FK_PromographePasswordResets_User FOREIGN KEY (UserId)
      REFERENCES dbo.PromographeUsers(Id) ON DELETE CASCADE
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'IX_PromographePasswordResets_UserId'
    AND object_id = OBJECT_ID(N'dbo.PromographePasswordResets')
)
BEGIN
  CREATE INDEX IX_PromographePasswordResets_UserId
    ON dbo.PromographePasswordResets(UserId, UsedAt, ExpiresAt);
END;
