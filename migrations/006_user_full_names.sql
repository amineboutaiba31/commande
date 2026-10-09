IF COL_LENGTH(N'dbo.PromographeUsers', N'FullName') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeUsers ADD FullName nvarchar(150) NOT NULL
    CONSTRAINT DF_PromographeUsers_FullName DEFAULT N'';
END;
