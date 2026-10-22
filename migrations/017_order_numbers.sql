-- Readable request numbers: DEM-AAAA-MMJJ-HHMM (Eastern time), with -2, -3… when
-- several requests are submitted in the same minute.
IF COL_LENGTH(N'dbo.PromographeOrders', N'OrderNumber') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeOrders ADD OrderNumber nvarchar(30) NULL;
END;

EXEC(N'
  WITH numbered AS (
    SELECT o.Id,
      N''DEM-'' + FORMAT(CAST(o.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy-MMdd-HHmm'') AS base
    FROM dbo.PromographeOrders o
    WHERE o.OrderNumber IS NULL
  ),
  ranked AS (
    SELECT Id, base, ROW_NUMBER() OVER (PARTITION BY base ORDER BY Id) AS position
    FROM numbered
  )
  UPDATE o SET o.OrderNumber = r.base + CASE WHEN r.position > 1 THEN N''-'' + CAST(r.position AS nvarchar(5)) ELSE N'''' END
  FROM dbo.PromographeOrders o JOIN ranked r ON r.Id = o.Id;
');

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_PromographeOrders_OrderNumber' AND object_id = OBJECT_ID(N'dbo.PromographeOrders')
)
BEGIN
  EXEC(N'CREATE UNIQUE INDEX UQ_PromographeOrders_OrderNumber ON dbo.PromographeOrders(OrderNumber) WHERE OrderNumber IS NOT NULL;');
END;
