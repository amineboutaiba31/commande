-- SKU of each product (the supplier's product code), kept on each request line as it was when
-- the request was made, and shown on requests and purchase orders.
IF COL_LENGTH(N'dbo.PromographeProducts', N'Sku') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeProducts ADD
    Sku nvarchar(50) NOT NULL CONSTRAINT DF_PromographeProducts_Sku DEFAULT N'';
END;

IF COL_LENGTH(N'dbo.PromographeOrderItems', N'Sku') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrderItems ADD Sku nvarchar(50) NULL;
END;
