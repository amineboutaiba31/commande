-- Unit of measure of each product (unité, boîte, caisse, rouleau, litre, kilogramme…), kept on
-- each request line as it was when the request was made.
IF COL_LENGTH(N'dbo.PromographeProducts', N'Unit') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeProducts ADD
    Unit nvarchar(20) NOT NULL CONSTRAINT DF_PromographeProducts_Unit DEFAULT N'unité';
END;

IF COL_LENGTH(N'dbo.PromographeOrderItems', N'Unit') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrderItems ADD Unit nvarchar(20) NULL;
END;

EXEC(N'
  UPDATE i SET i.Unit = COALESCE(p.Unit, N''unité'')
  FROM dbo.PromographeOrderItems i
  LEFT JOIN dbo.PromographeProducts p ON p.Id = i.ProductId
  WHERE i.Unit IS NULL;
');
