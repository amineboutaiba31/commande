-- Requests for a client (external) are kept apart from the company's department budgets.
IF COL_LENGTH(N'dbo.PromographeOrders', N'IsExternal') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrders ADD
    IsExternal bit NOT NULL CONSTRAINT DF_PromographeOrders_IsExternal DEFAULT 0,
    ClientName nvarchar(150) NULL,
    ClientReference nvarchar(100) NULL;
END;
