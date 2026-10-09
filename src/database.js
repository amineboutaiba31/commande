const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { useIdentityPlugin } = require("@azure/identity");
const { vsCodePlugin } = require("@azure/identity-vscode");

const MIGRATIONS = [
  { version: 1, path: path.join(__dirname, "..", "migrations", "001_auth_and_invitations.sql") },
  { version: 2, path: path.join(__dirname, "..", "migrations", "002_products_and_orders.sql") },
  { version: 3, path: path.join(__dirname, "..", "migrations", "003_product_departments.sql") },
  { version: 4, path: path.join(__dirname, "..", "migrations", "004_suppliers.sql") },
  { version: 5, path: path.join(__dirname, "..", "migrations", "005_department_budgets.sql") },
  { version: 6, path: path.join(__dirname, "..", "migrations", "006_user_full_names.sql") }
];

useIdentityPlugin(vsCodePlugin);

function createSqlConfig(env) {
  const required = ["DB_SERVER", "DB_NAME"];
  const missing = required.filter((key) => !env[key] || !env[key].trim());
  if (missing.length) {
    throw new Error(`Missing Azure SQL configuration: ${missing.join(", ")}.`);
  }

  const port = env.DB_PORT ? Number(env.DB_PORT) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("DB_PORT must be a valid port number.");
  }

  return {
    server: env.DB_SERVER,
    database: env.DB_NAME,
    authentication: {
      type: "azure-active-directory-default",
      options: env.DB_AUTH_CLIENT_ID ? { clientId: env.DB_AUTH_CLIENT_ID } : {}
    },
    ...(port ? { port } : {}),
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true
    },
    pool: { min: 0, max: 10, idleTimeoutMillis: 30000 },
    connectionTimeout: 60000,
    requestTimeout: 30000
  };
}

class AzureDatabase {
  constructor(pool) {
    this.pool = pool;
  }

  static async connect(env) {
    const pool = await new sql.ConnectionPool(createSqlConfig(env)).connect();
    const database = new AzureDatabase(pool);
    try {
      await database.applyMigrations();
      return database;
    } catch (error) {
      await pool.close();
      throw error;
    }
  }

  async query(statement, parameters = [], executor = this.pool) {
    let index = 0;
    const parameterizedStatement = statement.replace(/\?/g, () => `@p${index++}`);
    if (index !== parameters.length) {
      throw new Error("SQL statement parameter count does not match supplied values.");
    }
    const request = executor.request();
    parameters.forEach((value, parameterIndex) => {
      const name = `p${parameterIndex}`;
      if (typeof value === "string") {
        request.input(name, sql.NVarChar(sql.MAX), value);
      } else if (typeof value === "boolean") {
        request.input(name, sql.Bit, value);
      } else if (typeof value === "number" && Number.isSafeInteger(value)) {
        request.input(name, sql.BigInt, BigInt(value));
      } else if (value === null) {
        request.input(name, sql.NVarChar(sql.MAX), null);
      } else {
        throw new TypeError(`Unsupported SQL parameter at position ${parameterIndex}.`);
      }
    });
    return request.query(parameterizedStatement);
  }

  async applyMigrations() {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await transaction.request().query(`
        IF OBJECT_ID(N'dbo.PromographeSchemaMigrations', N'U') IS NULL
        BEGIN
          CREATE TABLE dbo.PromographeSchemaMigrations (
            Version int NOT NULL CONSTRAINT PK_PromographeSchemaMigrations PRIMARY KEY,
            AppliedAt datetime2(0) NOT NULL CONSTRAINT DF_PromographeSchemaMigrations_AppliedAt
              DEFAULT SYSUTCDATETIME()
          );
        END;
      `);
      for (const migration of MIGRATIONS) {
        const applied = await transaction.request()
          .input("version", sql.Int, migration.version)
          .query("SELECT Version FROM dbo.PromographeSchemaMigrations WITH (UPDLOCK, HOLDLOCK) WHERE Version = @version");
        if (!applied.recordset.length) {
          await transaction.request().batch(fs.readFileSync(migration.path, "utf8"));
          await transaction.request()
            .input("version", sql.Int, migration.version)
            .query("INSERT INTO dbo.PromographeSchemaMigrations (Version) VALUES (@version)");
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getUserByEmail(email) {
    const result = await this.query(`
      SELECT Id AS id, Email AS email, PasswordHash AS password_hash,
        Role AS role, DepartmentId AS department_id, IsActive AS is_active
      FROM dbo.PromographeUsers WHERE Email = ?
    `, [email]);
    return result.recordset[0];
  }

  async getUserById(id) {
    const result = await this.query(`
      SELECT Id AS id, Email AS email, PasswordHash AS password_hash,
        Role AS role, DepartmentId AS department_id, IsActive AS is_active
      FROM dbo.PromographeUsers WHERE Id = ?
    `, [id]);
    return result.recordset[0];
  }

  async listUsers() {
    const result = await this.query(`
      SELECT Id AS id, Email AS email, FullName AS full_name, Role AS role,
        DepartmentId AS department_id, IsActive AS is_active, CreatedAt AS created_at
      FROM dbo.PromographeUsers ORDER BY Id
    `);
    return result.recordset;
  }

  async listDepartments() {
    const result = await this.query(
      "SELECT Id AS id, Name AS name FROM dbo.PromographeDepartments ORDER BY Name"
    );
    return result.recordset;
  }

  async getDepartment(id) {
    const result = await this.query(
      "SELECT Id AS id, Name AS name FROM dbo.PromographeDepartments WHERE Id = ?",
      [id]
    );
    return result.recordset[0];
  }

  async createDepartment(name) {
    const result = await this.query(
      "INSERT INTO dbo.PromographeDepartments (Name) OUTPUT INSERTED.Id AS id VALUES (?)",
      [name]
    );
    return Number(result.recordset[0].id);
  }

  async updateDepartmentBudget(id, budgetCents) {
    const result = await this.query(
      "UPDATE dbo.PromographeDepartments SET BudgetCents = ? WHERE Id = ?",
      [budgetCents, id]
    );
    return result.rowsAffected[0] > 0;
  }

  // Spending for one calendar year: approved orders count as spent, pending as committed.
  async getDashboard(year) {
    const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value));
    const departments = await this.query(`
      SELECT d.Id AS id, d.Name AS name, d.BudgetCents AS budget_cents,
        SUM(CASE WHEN o.Status = N'approved' THEN i.UnitPriceCents * CAST(i.Quantity AS bigint) END) AS approved_cents,
        SUM(CASE WHEN o.Status = N'pending' THEN i.UnitPriceCents * CAST(i.Quantity AS bigint) END) AS pending_cents,
        COUNT(DISTINCT CASE WHEN o.Status = N'pending' THEN o.Id END) AS pending_orders
      FROM dbo.PromographeDepartments d
      LEFT JOIN dbo.PromographeOrders o ON o.DepartmentId = d.Id AND YEAR(o.CreatedAt) = ?
      LEFT JOIN dbo.PromographeOrderItems i ON i.OrderId = o.Id
      GROUP BY d.Id, d.Name, d.BudgetCents
      ORDER BY d.Name
    `, [year]);
    const suppliers = await this.query(`
      SELECT s.Name AS name,
        SUM(i.UnitPriceCents * CAST(i.Quantity AS bigint)) AS approved_cents
      FROM dbo.PromographeOrders o
      JOIN dbo.PromographeOrderItems i ON i.OrderId = o.Id
      JOIN dbo.PromographeProducts p ON p.Id = i.ProductId
      LEFT JOIN dbo.PromographeSuppliers s ON s.Id = p.SupplierId
      WHERE o.Status = N'approved' AND YEAR(o.CreatedAt) = ?
      GROUP BY s.Name
      ORDER BY approved_cents DESC
    `, [year]);
    const statuses = await this.query(`
      SELECT Status AS status, COUNT(*) AS total
      FROM dbo.PromographeOrders WHERE YEAR(CreatedAt) = ?
      GROUP BY Status
    `, [year]);
    return {
      departments: departments.recordset.map((row) => ({
        id: Number(row.id),
        name: row.name,
        budgetCents: row.budget_cents === null ? null : Number(row.budget_cents),
        approvedCents: toNumber(row.approved_cents),
        pendingCents: toNumber(row.pending_cents),
        pendingOrders: toNumber(row.pending_orders)
      })),
      suppliers: suppliers.recordset.map((row) => ({
        name: row.name,
        approvedCents: toNumber(row.approved_cents)
      })),
      orderCounts: Object.fromEntries(statuses.recordset.map((row) => [row.status, toNumber(row.total)]))
    };
  }

  async listSuppliers() {
    const result = await this.query(`
      SELECT Id AS id, Name AS name, ContactName AS contact_name, Email AS email, Phone AS phone
      FROM dbo.PromographeSuppliers ORDER BY Name
    `);
    return result.recordset.map((supplier) => ({ ...supplier, id: Number(supplier.id) }));
  }

  async getSupplier(id) {
    const result = await this.query(
      "SELECT Id AS id, Name AS name FROM dbo.PromographeSuppliers WHERE Id = ?",
      [id]
    );
    return result.recordset[0];
  }

  async getSupplierByName(name) {
    const result = await this.query(
      "SELECT Id AS id, Name AS name FROM dbo.PromographeSuppliers WHERE Name = ?",
      [name]
    );
    const supplier = result.recordset[0];
    return supplier && { id: Number(supplier.id), name: supplier.name };
  }

  async createSupplier(name, contactName, email, phone) {
    const result = await this.query(`
      INSERT INTO dbo.PromographeSuppliers (Name, ContactName, Email, Phone)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, ?, ?)
    `, [name, contactName, email, phone]);
    return Number(result.recordset[0].id);
  }

  async getInviteUser(email) {
    const result = await this.query(`
      SELECT Id AS id, Role AS role, IsActive AS is_active
      FROM dbo.PromographeUsers WHERE Email = ?
    `, [email]);
    return result.recordset[0];
  }

  async createPendingManager(email, passwordHash, departmentId, fullName = "") {
    const result = await this.query(`
      INSERT INTO dbo.PromographeUsers (Email, PasswordHash, Role, DepartmentId, IsActive, FullName)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, N'department_manager', ?, 0, ?)
    `, [email, passwordHash, departmentId, fullName]);
    return Number(result.recordset[0].id);
  }

  async createInvitation(userId, tokenHash, expiresAt) {
    const result = await this.query(`
      INSERT INTO dbo.PromographeInvitations (UserId, TokenHash, ExpiresAt)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, ?)
    `, [userId, tokenHash, expiresAt]);
    return Number(result.recordset[0].id);
  }

  async invalidateInvitations(userId, exceptId, now) {
    await this.query(`
      UPDATE dbo.PromographeInvitations SET UsedAt = ?
      WHERE UserId = ? AND Id <> ? AND UsedAt IS NULL
    `, [now, userId, exceptId]);
  }

  async updatePendingManagerDepartment(userId, departmentId, fullName = "") {
    await this.query(`
      UPDATE dbo.PromographeUsers SET DepartmentId = ?, FullName = ?
      WHERE Id = ? AND IsActive = 0
    `, [departmentId, fullName, userId]);
  }

  async rollbackInvitation(invitationId, userId, createdUser) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();
    try {
      await this.query(
        "DELETE FROM dbo.PromographeInvitations WHERE Id = ?",
        [invitationId],
        transaction
      );
      if (createdUser) {
        await this.query(
          "DELETE FROM dbo.PromographeUsers WHERE Id = ? AND IsActive = 0",
          [userId],
          transaction
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async deletePendingManager(userId) {
    await this.query(
      "DELETE FROM dbo.PromographeUsers WHERE Id = ? AND IsActive = 0",
      [userId]
    );
  }

  async getInvitation(tokenHash) {
    const result = await this.query(`
      SELECT i.Id AS id, i.ExpiresAt AS expires_at, i.UsedAt AS used_at,
        u.Email AS email, d.Name AS department_name
      FROM dbo.PromographeInvitations i
      JOIN dbo.PromographeUsers u ON u.Id = i.UserId
      JOIN dbo.PromographeDepartments d ON d.Id = u.DepartmentId
      WHERE i.TokenHash = ? AND u.IsActive = 0
    `, [tokenHash]);
    return result.recordset[0];
  }

  async acceptInvitation(tokenHash, passwordHash, now) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const invitation = await this.query(`
        SELECT i.Id AS id, i.UserId AS user_id
        FROM dbo.PromographeInvitations i WITH (UPDLOCK, ROWLOCK)
        JOIN dbo.PromographeUsers u ON u.Id = i.UserId
        WHERE i.TokenHash = ? AND i.UsedAt IS NULL
          AND i.ExpiresAt > ? AND u.IsActive = 0
      `, [tokenHash, now], transaction);
      if (!invitation.recordset.length) {
        await transaction.rollback();
        return false;
      }
      const userId = invitation.recordset[0].user_id;
      const activated = await this.query(`
        UPDATE dbo.PromographeUsers SET PasswordHash = ?, IsActive = 1
        WHERE Id = ? AND IsActive = 0
      `, [passwordHash, userId], transaction);
      if (!activated.rowsAffected[0]) {
        await transaction.rollback();
        return false;
      }
      await this.query(`
        UPDATE dbo.PromographeInvitations SET UsedAt = ?
        WHERE UserId = ? AND UsedAt IS NULL
      `, [now, userId], transaction);
      await transaction.commit();
      return true;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listProducts(user) {
    const departmentFilter = user.role === "admin" ? "" : "WHERE p.DepartmentId = ?";
    const parameters = user.role === "admin" ? [] : [user.department_id];
    const result = await this.query(`
      SELECT p.Id AS id, p.Name AS name, p.Description AS description,
        p.UnitPriceCents AS price_cents, p.IsActive AS is_active,
        p.DepartmentId AS department_id, d.Name AS department_name,
        p.SupplierId AS supplier_id, s.Name AS supplier_name
      FROM dbo.PromographeProducts p
      LEFT JOIN dbo.PromographeDepartments d ON d.Id = p.DepartmentId
      LEFT JOIN dbo.PromographeSuppliers s ON s.Id = p.SupplierId
      ${departmentFilter}
      ORDER BY d.Name, p.Name
    `, parameters);
    return result.recordset.map((product) => ({
      ...product,
      price_cents: Number(product.price_cents),
      is_active: Boolean(product.is_active),
      department_id: product.department_id === null ? null : Number(product.department_id),
      supplier_id: product.supplier_id === null ? null : Number(product.supplier_id)
    }));
  }

  async getProduct(id) {
    const result = await this.query(`
      SELECT Id AS id, DepartmentId AS department_id, SupplierId AS supplier_id
      FROM dbo.PromographeProducts WHERE Id = ?
    `, [id]);
    const product = result.recordset[0];
    return product && {
      id: Number(product.id),
      department_id: product.department_id === null ? null : Number(product.department_id),
      supplier_id: product.supplier_id === null ? null : Number(product.supplier_id)
    };
  }

  async createProduct(name, description, priceCents, departmentId, supplierId, createdByUserId, isActive = true) {
    const result = await this.query(`
      INSERT INTO dbo.PromographeProducts
        (Name, Description, UnitPriceCents, DepartmentId, SupplierId, CreatedByUserId, IsActive)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [name, description, priceCents, departmentId, supplierId, createdByUserId, isActive]);
    return Number(result.recordset[0].id);
  }

  async updateProduct(id, name, description, priceCents, departmentId, supplierId, isActive) {
    const result = await this.query(`
      UPDATE dbo.PromographeProducts
      SET Name = ?, Description = ?, UnitPriceCents = ?, DepartmentId = ?, SupplierId = ?, IsActive = ?
      WHERE Id = ?
    `, [name, description, priceCents, departmentId, supplierId, isActive, id]);
    return result.rowsAffected[0] > 0;
  }

  async createOrder(departmentId, userId, notes, items) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const products = [];
      for (const item of items) {
        const result = await this.query(`
          SELECT Id AS id, Name AS name, UnitPriceCents AS price_cents
          FROM dbo.PromographeProducts WITH (UPDLOCK, HOLDLOCK)
          WHERE Id = ? AND IsActive = 1 AND DepartmentId = ?
        `, [item.productId, departmentId], transaction);
        if (!result.recordset.length) {
          await transaction.rollback();
          return null;
        }
        products.push(result.recordset[0]);
      }

      const created = await this.query(`
        INSERT INTO dbo.PromographeOrders (DepartmentId, CreatedByUserId, Notes)
        OUTPUT INSERTED.Id AS id
        VALUES (?, ?, ?)
      `, [departmentId, userId, notes], transaction);
      const orderId = Number(created.recordset[0].id);
      for (let index = 0; index < items.length; index += 1) {
        await this.query(`
          INSERT INTO dbo.PromographeOrderItems
            (OrderId, ProductId, ProductName, UnitPriceCents, Quantity)
          VALUES (?, ?, ?, ?, ?)
        `, [
          orderId,
          items[index].productId,
          products[index].name,
          Number(products[index].price_cents),
          items[index].quantity
        ], transaction);
      }
      await transaction.commit();
      return orderId;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listOrders(user) {
    const departmentFilter = user.role === "admin" ? "" : "WHERE o.DepartmentId = ?";
    const parameters = user.role === "admin" ? [] : [user.department_id];
    const result = await this.query(`
      SELECT o.Id AS id, o.DepartmentId AS department_id, d.Name AS department_name,
        u.Email AS created_by_email, u.FullName AS created_by_name,
        o.Status AS status, o.Notes AS notes,
        o.DecisionNote AS decision_note, o.CreatedAt AS created_at,
        o.DecidedAt AS decided_at, reviewer.Email AS decided_by_email,
        i.Id AS item_id, i.ProductId AS product_id, i.ProductName AS product_name,
        i.UnitPriceCents AS price_cents, i.Quantity AS quantity
      FROM dbo.PromographeOrders o
      JOIN dbo.PromographeDepartments d ON d.Id = o.DepartmentId
      JOIN dbo.PromographeUsers u ON u.Id = o.CreatedByUserId
      LEFT JOIN dbo.PromographeUsers reviewer ON reviewer.Id = o.DecidedByUserId
      LEFT JOIN dbo.PromographeOrderItems i ON i.OrderId = o.Id
      ${departmentFilter}
      ORDER BY o.CreatedAt DESC, o.Id DESC, i.Id
    `, parameters);
    const orders = new Map();
    for (const row of result.recordset) {
      let order = orders.get(Number(row.id));
      if (!order) {
        order = {
          id: Number(row.id),
          departmentId: Number(row.department_id),
          departmentName: row.department_name,
          createdByEmail: row.created_by_email,
          createdByName: row.created_by_name || null,
          status: row.status,
          notes: row.notes,
          decisionNote: row.decision_note,
          createdAt: row.created_at,
          decidedAt: row.decided_at,
          decidedByEmail: row.decided_by_email,
          items: [],
          totalCents: 0
        };
        orders.set(order.id, order);
      }
      if (row.item_id !== null) {
        const priceCents = Number(row.price_cents);
        const quantity = Number(row.quantity);
        order.items.push({
          productId: Number(row.product_id),
          productName: row.product_name,
          priceCents,
          quantity
        });
        order.totalCents += priceCents * quantity;
      }
    }
    return [...orders.values()];
  }

  async decideOrder(id, status, decisionNote, decidedByUserId) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const pending = await this.query(`
        SELECT Id FROM dbo.PromographeOrders WITH (UPDLOCK, ROWLOCK)
        WHERE Id = ? AND Status = N'pending'
      `, [id], transaction);
      if (!pending.recordset.length) {
        await transaction.rollback();
        return false;
      }
      await this.query(`
        UPDATE dbo.PromographeOrders
        SET Status = ?, DecisionNote = ?, DecidedByUserId = ?, DecidedAt = SYSUTCDATETIME()
        WHERE Id = ?
      `, [status, decisionNote, decidedByUserId, id], transaction);
      await transaction.commit();
      return true;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async createFirstAdmin(email, passwordHash) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const lockResult = await transaction.request().query(`
        DECLARE @lockResult int;
        EXEC @lockResult = sys.sp_getapplock
          @Resource = N'PromographeInitialAdmin',
          @LockMode = N'Exclusive',
          @LockOwner = N'Transaction',
          @LockTimeout = 10000;
        SELECT @lockResult AS result;
      `);
      if (lockResult.recordset[0].result < 0) {
        throw new Error("Could not acquire the administrator provisioning lock.");
      }
      const existing = await this.query(
        "SELECT TOP (1) Id FROM dbo.PromographeUsers WHERE Role = N'admin'",
        [],
        transaction
      );
      if (existing.recordset.length) {
        throw new Error("An administrator already exists; first-admin provisioning is disabled.");
      }
      await this.query(`
        INSERT INTO dbo.PromographeUsers (Email, PasswordHash, Role, IsActive)
        VALUES (?, ?, N'admin', 1)
      `, [email, passwordHash], transaction);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async close() {
    await this.pool.close();
  }
}

module.exports = { AzureDatabase, createSqlConfig };
