-- Purchase orders are numbered PG- then the year (Eastern time) and a counter of the year on
-- five digits: PG-202600001, PG-202600002, … in order of creation. Renumbers the existing ones.
EXEC(N'
  WITH ranked AS (
    SELECT po.Id,
      N''PG-'' + FORMAT(CAST(po.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy'') AS base,
      ROW_NUMBER() OVER (
        PARTITION BY FORMAT(CAST(po.CreatedAt AS datetime2) AT TIME ZONE ''UTC'' AT TIME ZONE ''Eastern Standard Time'', ''yyyy'')
        ORDER BY po.CreatedAt, po.Id
      ) AS position
    FROM dbo.PromographePurchaseOrders po
  )
  UPDATE po SET po.Number = r.base + FORMAT(r.position, ''D5'')
  FROM dbo.PromographePurchaseOrders po JOIN ranked r ON r.Id = po.Id;
');
