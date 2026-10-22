-- Numbers become a counter of the day (Eastern time): DEM-AAAA-MMJJ-1, -2, … and
-- PO-AAAA-MMJJ-1, -2, … in order of creation. Renumbers the existing ones.
EXEC(N'
  WITH ranked AS (
    SELECT o.Id,
      N''DEM-'' + FORMAT(CAST(o.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy-MMdd'') AS base,
      ROW_NUMBER() OVER (
        PARTITION BY FORMAT(CAST(o.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy-MMdd'')
        ORDER BY o.CreatedAt, o.Id
      ) AS position
    FROM dbo.PromographeOrders o
  )
  UPDATE o SET o.OrderNumber = r.base + N''-'' + CAST(r.position AS nvarchar(10))
  FROM dbo.PromographeOrders o JOIN ranked r ON r.Id = o.Id;
');

EXEC(N'
  WITH ranked AS (
    SELECT po.Id,
      N''PO-'' + FORMAT(CAST(po.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy-MMdd'') AS base,
      ROW_NUMBER() OVER (
        PARTITION BY FORMAT(CAST(po.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy-MMdd'')
        ORDER BY po.CreatedAt, po.Id
      ) AS position
    FROM dbo.PromographePurchaseOrders po
  )
  UPDATE po SET po.Number = r.base + N''-'' + CAST(r.position AS nvarchar(10))
  FROM dbo.PromographePurchaseOrders po JOIN ranked r ON r.Id = po.Id;
');
