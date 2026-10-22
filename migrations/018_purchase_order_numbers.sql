-- Purchase orders numbered like requests: PO-AAAA-MMJJ-HHMM (Eastern time) from their
-- opening time, with -2, -3… when several open in the same minute. Renames the first
-- BC-AAAA-NNNN numbers.
EXEC(N'
  WITH numbered AS (
    SELECT po.Id,
      N''PO-'' + FORMAT(CAST(po.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy-MMdd-HHmm'') AS base
    FROM dbo.PromographePurchaseOrders po
    WHERE po.Number LIKE N''BC-%''
  ),
  ranked AS (
    SELECT Id, base, ROW_NUMBER() OVER (PARTITION BY base ORDER BY Id) AS position
    FROM numbered
  )
  UPDATE po SET po.Number = r.base + CASE WHEN r.position > 1 THEN N''-'' + CAST(r.position AS nvarchar(5)) ELSE N'''' END
  FROM dbo.PromographePurchaseOrders po JOIN ranked r ON r.Id = po.Id;
');
