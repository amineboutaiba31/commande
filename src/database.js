const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { useIdentityPlugin } = require("@azure/identity");

const MIGRATIONS = [
  { version: 1, path: path.join(__dirname, "..", "migrations", "001_auth_and_invitations.sql") },
  { version: 2, path: path.join(__dirname, "..", "migrations", "002_products_and_orders.sql") },
  { version: 3, path: path.join(__dirname, "..", "migrations", "003_product_departments.sql") },
  { version: 4, path: path.join(__dirname, "..", "migrations", "004_suppliers.sql") },
  { version: 5, path: path.join(__dirname, "..", "migrations", "005_department_budgets.sql") },
  { version: 6, path: path.join(__dirname, "..", "migrations", "006_user_full_names.sql") },
  { version: 7, path: path.join(__dirname, "..", "migrations", "007_password_resets.sql") },
  { version: 8, path: path.join(__dirname, "..", "migrations", "008_product_deletion.sql") },
  { version: 9, path: path.join(__dirname, "..", "migrations", "009_soft_delete_users_departments.sql") },
  { version: 10, path: path.join(__dirname, "..", "migrations", "010_developer_role.sql") }
];

// VS Code sign-in is for local development only; its keychain library is absent on App Service,
// where the managed identity is used instead.
if (process.env.NODE_ENV !== "production") {
  useIdentityPlugin(require("@azure/identity-vscode").vsCodePlugin);
}

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
      SELECT Id AS id, Email AS email, FullName AS full_name, PasswordHash AS password_hash,
        Role AS role, DepartmentId AS department_id, IsActive AS is_active,
        SessionVersion AS session_version
      FROM dbo.PromographeUsers WHERE Email = ?
    `, [email]);
    return result.recordset[0];
  }

  async getUserById(id) {
    const result = await this.query(`
      SELECT Id AS id, Email AS email, FullName AS full_name, PasswordHash AS password_hash,
        Role AS role, DepartmentId AS department_id, IsActive AS is_active,
        SessionVersion AS session_version
      FROM dbo.PromographeUsers WHERE Id = ?
    `, [id]);
    return result.recordset[0];
  }

  async updateUserFullName(userId, fullName) {
    await this.query("UPDATE dbo.PromographeUsers SET FullName = ? WHERE Id = ?", [fullName, userId]);
  }

  // Bumping SessionVersion signs out every other session of this user.
  async updatePassword(userId, passwordHash, executor = this.pool) {
    const result = await this.query(`
      UPDATE dbo.PromographeUsers
      SET PasswordHash = ?, SessionVersion = SessionVersion + 1
      OUTPUT INSERTED.SessionVersion AS session_version
      WHERE Id = ? AND IsActive = 1
    `, [passwordHash, userId], executor);
    const row = result.recordset[0];
    return row ? Number(row.session_version) : null;
  }

  // A Microsoft sign-in proves the invited email, so it can stand in for the invitation link.
  async activateInvitedUser(userId, now) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const invitation = await this.query(`
        SELECT TOP (1) i.Id AS id
        FROM dbo.PromographeInvitations i WITH (UPDLOCK, ROWLOCK)
        JOIN dbo.PromographeUsers u ON u.Id = i.UserId
        WHERE i.UserId = ? AND i.UsedAt IS NULL AND i.ExpiresAt > ? AND u.IsActive = 0
      `, [userId, now], transaction);
      if (!invitation.recordset.length) {
        await transaction.rollback();
        return false;
      }
      await this.query(
        "UPDATE dbo.PromographeUsers SET IsActive = 1 WHERE Id = ? AND IsActive = 0",
        [userId],
        transaction
      );
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

  async createPasswordReset(userId, tokenHash, expiresAt, now) {
    await this.query(`
      UPDATE dbo.PromographePasswordResets SET UsedAt = ?
      WHERE UserId = ? AND UsedAt IS NULL
    `, [now, userId]);
    await this.query(`
      INSERT INTO dbo.PromographePasswordResets (UserId, TokenHash, ExpiresAt)
      VALUES (?, ?, ?)
    `, [userId, tokenHash, expiresAt]);
  }

  async getPasswordReset(tokenHash, now) {
    const result = await this.query(`
      SELECT u.Email AS email
      FROM dbo.PromographePasswordResets r
      JOIN dbo.PromographeUsers u ON u.Id = r.UserId
      WHERE r.TokenHash = ? AND r.UsedAt IS NULL AND r.ExpiresAt > ? AND u.IsActive = 1
    `, [tokenHash, now]);
    return result.recordset[0];
  }

  async completePasswordReset(tokenHash, passwordHash, now) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const reset = await this.query(`
        SELECT r.Id AS id, r.UserId AS user_id
        FROM dbo.PromographePasswordResets r WITH (UPDLOCK, ROWLOCK)
        JOIN dbo.PromographeUsers u ON u.Id = r.UserId
        WHERE r.TokenHash = ? AND r.UsedAt IS NULL AND r.ExpiresAt > ? AND u.IsActive = 1
      `, [tokenHash, now], transaction);
      if (!reset.recordset.length) {
        await transaction.rollback();
        return false;
      }
      const userId = Number(reset.recordset[0].user_id);
      if (await this.updatePassword(userId, passwordHash, transaction) === null) {
        await transaction.rollback();
        return false;
      }
      await this.query(`
        UPDATE dbo.PromographePasswordResets SET UsedAt = ?
        WHERE UserId = ? AND UsedAt IS NULL
      `, [now, userId], transaction);
      await transaction.commit();
      return true;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listUsers() {
    const result = await this.query(`
      SELECT Id AS id, Email AS email, FullName AS full_name, Role AS role,
        DepartmentId AS department_id, IsActive AS is_active, CreatedAt AS created_at
      FROM dbo.PromographeUsers WHERE DeletedAt IS NULL ORDER BY Id
    `);
    return result.recordset;
  }

  async updateManager(id, fullName, departmentId) {
    const result = await this.query(`
      UPDATE dbo.PromographeUsers SET FullName = ?, DepartmentId = ?
      WHERE Id = ? AND Role = N'department_manager' AND DeletedAt IS NULL
    `, [fullName, departmentId, id]);
    return result.rowsAffected[0] > 0;
  }

  async listAdmins() {
    const result = await this.query(`
      SELECT Id AS id, Email AS email, FullName AS full_name, IsActive AS is_active
      FROM dbo.PromographeUsers WHERE Role = N'admin' AND DeletedAt IS NULL ORDER BY Id
    `);
    return result.recordset.map((admin) => ({ ...admin, id: Number(admin.id), is_active: Boolean(admin.is_active) }));
  }

  async createPendingAdmin(email, passwordHash, fullName) {
    const result = await this.query(`
      INSERT INTO dbo.PromographeUsers (Email, PasswordHash, Role, DepartmentId, IsActive, FullName)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, N'admin', NULL, 0, ?)
    `, [email, passwordHash, fullName]);
    return Number(result.recordset[0].id);
  }

  // Re-inviting a pending or deleted administrator reuses the account.
  async updatePendingAdmin(userId, fullName) {
    await this.query(`
      UPDATE dbo.PromographeUsers SET FullName = ?, DeletedAt = NULL
      WHERE Id = ? AND Role = N'admin' AND IsActive = 0
    `, [fullName, userId]);
  }

  async deleteManager(id) {
    return this.deleteUserWithRole(id, "department_manager");
  }

  async deleteAdmin(id) {
    return this.deleteUserWithRole(id, "admin");
  }

  // Signs the user out and blocks the account; their orders stay in the history.
  // Inviting the same email again brings the account back.
  async deleteUserWithRole(id, role) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();
    try {
      const result = await this.query(`
        UPDATE dbo.PromographeUsers
        SET IsActive = 0, DeletedAt = SYSUTCDATETIME(), SessionVersion = SessionVersion + 1
        WHERE Id = ? AND Role = ? AND DeletedAt IS NULL
      `, [id, role], transaction);
      await this.query("DELETE FROM dbo.PromographeInvitations WHERE UserId = ?", [id], transaction);
      await this.query("DELETE FROM dbo.PromographePasswordResets WHERE UserId = ?", [id], transaction);
      await transaction.commit();
      return result.rowsAffected[0] > 0;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listDepartments() {
    const result = await this.query(
      "SELECT Id AS id, Name AS name FROM dbo.PromographeDepartments WHERE DeletedAt IS NULL ORDER BY Name"
    );
    return result.recordset;
  }

  async getDepartment(id) {
    const result = await this.query(
      "SELECT Id AS id, Name AS name FROM dbo.PromographeDepartments WHERE Id = ? AND DeletedAt IS NULL",
      [id]
    );
    return result.recordset[0];
  }

  // Re-creating a deleted department's name brings that department back.
  async createDepartment(name) {
    const revived = await this.query(`
      UPDATE dbo.PromographeDepartments SET DeletedAt = NULL
      OUTPUT INSERTED.Id AS id
      WHERE Name = ? AND DeletedAt IS NOT NULL
    `, [name]);
    if (revived.recordset.length) {
      return Number(revived.recordset[0].id);
    }
    const result = await this.query(
      "INSERT INTO dbo.PromographeDepartments (Name) OUTPUT INSERTED.Id AS id VALUES (?)",
      [name]
    );
    return Number(result.recordset[0].id);
  }

  async renameDepartment(id, name) {
    const result = await this.query(
      "UPDATE dbo.PromographeDepartments SET Name = ? WHERE Id = ? AND DeletedAt IS NULL",
      [name, id]
    );
    return result.rowsAffected[0] > 0;
  }

  // Returns "not_found", "has_managers", "has_pending_orders" or "deleted".
  async deleteDepartment(id) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const blockers = (await this.query(`
        SELECT
          (SELECT COUNT(*) FROM dbo.PromographeDepartments WHERE Id = ? AND DeletedAt IS NULL) AS found,
          (SELECT COUNT(*) FROM dbo.PromographeUsers WHERE DepartmentId = ? AND DeletedAt IS NULL) AS managers,
          (SELECT COUNT(*) FROM dbo.PromographeOrders WHERE DepartmentId = ? AND Status = N'pending') AS pending
      `, [id, id, id], transaction)).recordset[0];
      let outcome = "deleted";
      if (!blockers.found) {
        outcome = "not_found";
      } else if (blockers.managers) {
        outcome = "has_managers";
      } else if (blockers.pending) {
        outcome = "has_pending_orders";
      } else {
        await this.query(`
          UPDATE dbo.PromographeProducts SET DeletedAt = SYSUTCDATETIME(), IsActive = 0
          WHERE DepartmentId = ? AND DeletedAt IS NULL
        `, [id], transaction);
        await this.query(
          "UPDATE dbo.PromographeDepartments SET DeletedAt = SYSUTCDATETIME() WHERE Id = ?",
          [id],
          transaction
        );
      }
      await transaction.commit();
      return outcome;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
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
      WHERE d.DeletedAt IS NULL
      GROUP BY d.Id, d.Name, d.BudgetCents
      ORDER BY d.Name
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

  async updateSupplier(id, name, contactName, email, phone) {
    const result = await this.query(`
      UPDATE dbo.PromographeSuppliers SET Name = ?, ContactName = ?, Email = ?, Phone = ?
      WHERE Id = ?
    `, [name, contactName, email, phone, id]);
    return result.rowsAffected[0] > 0;
  }

  // Products that used the supplier are kept and become "sans fournisseur".
  async deleteSupplier(id) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();
    try {
      await this.query("UPDATE dbo.PromographeProducts SET SupplierId = NULL WHERE SupplierId = ?", [id], transaction);
      const result = await this.query("DELETE FROM dbo.PromographeSuppliers WHERE Id = ?", [id], transaction);
      await transaction.commit();
      return result.rowsAffected[0] > 0;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
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
      UPDATE dbo.PromographeUsers SET DepartmentId = ?, FullName = ?, DeletedAt = NULL
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
        u.Email AS email, u.Role AS role, d.Name AS department_name
      FROM dbo.PromographeInvitations i
      JOIN dbo.PromographeUsers u ON u.Id = i.UserId
      LEFT JOIN dbo.PromographeDepartments d ON d.Id = u.DepartmentId
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
    const departmentFilter = user.role === "admin" ? "" : "AND p.DepartmentId = ?";
    const parameters = user.role === "admin" ? [] : [user.department_id];
    const result = await this.query(`
      SELECT p.Id AS id, p.Name AS name, p.Description AS description,
        p.UnitPriceCents AS price_cents, p.IsActive AS is_active,
        p.DepartmentId AS department_id, d.Name AS department_name,
        p.SupplierId AS supplier_id, s.Name AS supplier_name
      FROM dbo.PromographeProducts p
      LEFT JOIN dbo.PromographeDepartments d ON d.Id = p.DepartmentId
      LEFT JOIN dbo.PromographeSuppliers s ON s.Id = p.SupplierId
      WHERE p.DeletedAt IS NULL ${departmentFilter}
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
      FROM dbo.PromographeProducts WHERE Id = ? AND DeletedAt IS NULL
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
      WHERE Id = ? AND DeletedAt IS NULL
    `, [name, description, priceCents, departmentId, supplierId, isActive, id]);
    return result.rowsAffected[0] > 0;
  }

  async deleteProduct(id) {
    const result = await this.query(`
      UPDATE dbo.PromographeProducts
      SET DeletedAt = SYSUTCDATETIME(), IsActive = 0
      WHERE Id = ? AND DeletedAt IS NULL
    `, [id]);
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
