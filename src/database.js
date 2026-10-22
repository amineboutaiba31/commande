const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { useIdentityPlugin } = require("@azure/identity");

// Pending request lines grouped per supplier (by id, or by saved name when the supplier is gone).
function groupBySupplier(items) {
  const groups = new Map();
  for (const item of items) {
    const supplierId = item.supplier_id === null || item.supplier_id === undefined ? null : Number(item.supplier_id);
    const supplierName = item.supplier_name ?? null;
    const key = supplierId === null ? `name:${supplierName || ""}` : `id:${supplierId}`;
    if (!groups.has(key)) {
      groups.set(key, { supplierId, supplierName, itemIds: [] });
    }
    groups.get(key).itemIds.push(Number(item.id));
  }
  return [...groups.values()];
}

// Optional supplier card fields, in column order.
function supplierDetailValues(details) {
  return [
    details.phoneExtension || "",
    details.note || "",
    details.reducedThresholdCents ?? null,
    details.freeThresholdCents ?? null,
    details.accountNumber || "",
    details.currency || "CAD",
    details.paymentTerms || "",
    details.isAuthorized !== false,
    details.category || ""
  ];
}

// Day of a request's number, in Quebec time: DEM-AAAA-MMJJ.
function orderNumberBase(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `DEM-${parts.year}-${parts.month}${parts.day}`;
}

// Counter of the day: DEM-2026-1015-1, -2, … -10; it starts again at 1 the next day.
function nextOrderNumber(base, existingNumbers) {
  const used = existingNumbers
    .filter((number) => number && number.startsWith(`${base}-`))
    .map((number) => number.slice(base.length + 1))
    .filter((suffix) => /^\d+$/.test(suffix))
    .map(Number);
  return `${base}-${used.length ? Math.max(...used) + 1 : 1}`;
}

// Year of a purchase order's number, in Quebec time: PG-AAAA.
function purchaseOrderNumberBase(date) {
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric" }).format(date);
  return `PG-${year}`;
}

// Counter of the year on five digits: PG-202600001, PG-202600002, …; it starts again at
// 00001 each year.
function nextPurchaseOrderNumber(base, existingNumbers) {
  const used = existingNumbers
    .filter((number) => number && number.startsWith(base))
    .map((number) => number.slice(base.length))
    .filter((suffix) => /^\d{5,}$/.test(suffix))
    .map(Number);
  return `${base}${String(used.length ? Math.max(...used) + 1 : 1).padStart(5, "0")}`;
}

// Turns flat purchase-order rows into one object per purchase order: quantities summed per
// product and price, the detail per request, and the requests included.
function groupPurchaseOrders(rows) {
  const purchaseOrders = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!purchaseOrders.has(id)) {
      purchaseOrders.set(id, {
        id,
        number: row.number,
        supplierName: row.supplier_name || null,
        status: row.status,
        createdAt: row.created_at,
        purchasedAt: row.purchased_at,
        purchasedByEmail: row.purchased_by_email || null,
        sentAt: row.sent_at || null,
        sentByEmail: row.sent_by_email || null,
        sentMethod: row.sent_method || null,
        sentNote: row.sent_note || null,
        supplier: {
          contactName: row.supplier_contact || "",
          email: row.supplier_email || "",
          phone: row.supplier_phone || "",
          website: row.supplier_website || "",
          orderMethod: row.supplier_order_method || "",
          phoneExtension: row.supplier_phone_extension || "",
          note: row.supplier_note || "",
          reducedThresholdCents: row.supplier_reduced_threshold_cents == null ? null : Number(row.supplier_reduced_threshold_cents),
          freeThresholdCents: row.supplier_free_threshold_cents == null ? null : Number(row.supplier_free_threshold_cents),
          accountNumber: row.supplier_account_number || "",
          currency: row.supplier_currency || "CAD",
          paymentTerms: row.supplier_payment_terms || "",
          isAuthorized: row.supplier_is_authorized == null ? true : Boolean(row.supplier_is_authorized),
          category: row.supplier_category || ""
        },
        isUrgent: false,
        lines: [],
        orders: [],
        totalCents: 0
      });
    }
    const purchaseOrder = purchaseOrders.get(id);
    const productId = Number(row.product_id);
    const priceCents = Number(row.price_cents);
    const quantity = Number(row.quantity);
    const orderId = Number(row.order_id);
    const unit = row.unit || "unité";
    const sku = row.sku || "";
    let line = purchaseOrder.lines.find((candidate) => candidate.productId === productId &&
      candidate.priceCents === priceCents && candidate.unit === unit && candidate.sku === sku);
    if (!line) {
      line = { productId, productName: row.product_name, sku, description: row.product_description || "", priceCents, unit, quantity: 0, detail: [] };
      purchaseOrder.lines.push(line);
    }
    line.quantity += quantity;
    const orderNumber = row.order_number || `DEM-${orderId}`;
    line.detail.push({ orderId, orderNumber, requester: row.requester, quantity });
    purchaseOrder.totalCents += priceCents * quantity;
    purchaseOrder.isUrgent = purchaseOrder.isUrgent || Boolean(row.is_urgent);
    if (!purchaseOrder.orders.some((order) => order.id === orderId)) {
      purchaseOrder.orders.push({
        id: orderId,
        number: orderNumber,
        requester: row.requester,
        departmentName: row.department_name,
        isUrgent: Boolean(row.is_urgent),
        clientName: row.client_name || null,
        approvedBy: row.approved_by || null,
        approvedByDirector: row.approved_by_role === "admin"
      });
    }
  }
  return [...purchaseOrders.values()];
}

// Roles that see every department's catalogue and requests.
const SEES_ALL_ROLES = ["admin", "accountant"];

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
  { version: 10, path: path.join(__dirname, "..", "migrations", "010_developer_role.sql") },
  { version: 11, path: path.join(__dirname, "..", "migrations", "011_employees_and_functions.sql") },
  { version: 12, path: path.join(__dirname, "..", "migrations", "012_manager_requests.sql") },
  { version: 13, path: path.join(__dirname, "..", "migrations", "013_accountant_role.sql") },
  { version: 14, path: path.join(__dirname, "..", "migrations", "014_hard_delete_accounts.sql") },
  { version: 15, path: path.join(__dirname, "..", "migrations", "015_urgent_and_purchase.sql") },
  { version: 16, path: path.join(__dirname, "..", "migrations", "016_purchase_orders.sql") },
  { version: 17, path: path.join(__dirname, "..", "migrations", "017_order_numbers.sql") },
  { version: 18, path: path.join(__dirname, "..", "migrations", "018_purchase_order_numbers.sql") },
  { version: 19, path: path.join(__dirname, "..", "migrations", "019_daily_numbers.sql") },
  { version: 20, path: path.join(__dirname, "..", "migrations", "020_purchase_order_sending.sql") },
  { version: 21, path: path.join(__dirname, "..", "migrations", "021_supplier_details.sql") },
  { version: 22, path: path.join(__dirname, "..", "migrations", "022_supplier_terms.sql") },
  { version: 23, path: path.join(__dirname, "..", "migrations", "023_external_orders.sql") },
  { version: 24, path: path.join(__dirname, "..", "migrations", "024_units.sql") },
  { version: 25, path: path.join(__dirname, "..", "migrations", "025_purchaser_role.sql") },
  { version: 26, path: path.join(__dirname, "..", "migrations", "026_purchase_order_year_numbers.sql") },
  { version: 27, path: path.join(__dirname, "..", "migrations", "027_order_methods.sql") },
  { version: 28, path: path.join(__dirname, "..", "migrations", "028_product_sku.sql") }
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
    // The serverless database auto-pauses to stay on the free offer; waking it up can take
    // about a minute, longer than the 30-second pool defaults.
    pool: {
      min: 0,
      max: 10,
      idleTimeoutMillis: 30000,
      acquireTimeoutMillis: 120000,
      createTimeoutMillis: 120000
    },
    connectionTimeout: 120000,
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
        DepartmentId AS department_id, IsActive AS is_active, CreatedAt AS created_at,
        RequestedManagerDepartmentId AS requested_manager_department_id
      FROM dbo.PromographeUsers WHERE DeletedAt IS NULL ORDER BY Id
    `);
    const functions = await this.query("SELECT UserId AS user_id, FunctionCode AS code FROM dbo.PromographeUserFunctions");
    return result.recordset.map((user) => ({
      ...user,
      functions: functions.recordset
        .filter((row) => Number(row.user_id) === Number(user.id))
        .map((row) => row.code)
    }));
  }

  // Employees must keep a department; administrators may have one or none.
  async updateUserDetails(id, fullName, departmentId) {
    const result = await this.query(`
      UPDATE dbo.PromographeUsers SET FullName = ?, DepartmentId = ?
      WHERE Id = ? AND Role IN (N'employee', N'admin', N'accountant', N'purchaser') AND DeletedAt IS NULL
    `, [fullName, departmentId, id]);
    return result.rowsAffected[0] > 0;
  }

  // Switches a staff member between employee, accountant and purchaser (never to or from director).
  async updateStaffRole(id, role) {
    const result = await this.query(`
      UPDATE dbo.PromographeUsers SET Role = ?
      WHERE Id = ? AND Role IN (N'employee', N'accountant', N'purchaser') AND DeletedAt IS NULL
    `, [role, id]);
    return result.rowsAffected[0] > 0;
  }

  async getUserFunctions(userId) {
    const result = await this.query(
      "SELECT FunctionCode AS code FROM dbo.PromographeUserFunctions WHERE UserId = ? ORDER BY FunctionCode",
      [userId]
    );
    return result.recordset.map((row) => row.code);
  }

  async setUserFunctions(userId, codes) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();
    try {
      await this.query("DELETE FROM dbo.PromographeUserFunctions WHERE UserId = ?", [userId], transaction);
      for (const code of codes) {
        await this.query(
          "INSERT INTO dbo.PromographeUserFunctions (UserId, FunctionCode) VALUES (?, ?)",
          [userId, code],
          transaction
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async setManagerRequest(userId, departmentId) {
    await this.query(
      "UPDATE dbo.PromographeUsers SET RequestedManagerDepartmentId = ? WHERE Id = ?",
      [departmentId, userId]
    );
  }

  async getManagerRequest(userId) {
    const result = await this.query(`
      SELECT d.Id AS id, d.Name AS name
      FROM dbo.PromographeUsers u
      JOIN dbo.PromographeDepartments d ON d.Id = u.RequestedManagerDepartmentId AND d.DeletedAt IS NULL
      WHERE u.Id = ? AND u.DeletedAt IS NULL
    `, [userId]);
    const department = result.recordset[0];
    return department ? { id: Number(department.id), name: department.name } : null;
  }

  async getManagedDepartments(userId) {
    const result = await this.query(`
      SELECT Id AS id, Name AS name FROM dbo.PromographeDepartments
      WHERE ManagerUserId = ? AND DeletedAt IS NULL ORDER BY Name
    `, [userId]);
    return result.recordset.map((department) => ({ id: Number(department.id), name: department.name }));
  }

  async setDepartmentManager(departmentId, userId) {
    const result = await this.query(
      "UPDATE dbo.PromographeDepartments SET ManagerUserId = ? WHERE Id = ? AND DeletedAt IS NULL",
      [userId, departmentId]
    );
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

  async deleteEmployee(id) {
    return this.deleteUserWithRole(id, "employee");
  }

  async deleteAdmin(id) {
    return this.deleteUserWithRole(id, "admin");
  }

  // Removes the account from the database for good. Its purchase requests stay in the history
  // with a copy of the name and email; invitations, resets and functions go with the account.
  async deleteUserWithRole(id, role) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();
    try {
      const found = await this.query(
        "SELECT Id FROM dbo.PromographeUsers WITH (UPDLOCK) WHERE Id = ? AND Role = ?",
        [id, role],
        transaction
      );
      if (!found.recordset.length) {
        await transaction.rollback();
        return false;
      }
      await this.query(`
        UPDATE o SET o.CreatedByEmailSnapshot = u.Email, o.CreatedByNameSnapshot = u.FullName, o.CreatedByUserId = NULL
        FROM dbo.PromographeOrders o JOIN dbo.PromographeUsers u ON u.Id = o.CreatedByUserId
        WHERE u.Id = ?
      `, [id], transaction);
      await this.query(`
        UPDATE o SET o.DecidedByEmailSnapshot = u.Email, o.DecidedByUserId = NULL
        FROM dbo.PromographeOrders o JOIN dbo.PromographeUsers u ON u.Id = o.DecidedByUserId
        WHERE u.Id = ?
      `, [id], transaction);
      await this.query(`
        UPDATE o SET o.PurchasedByEmailSnapshot = u.Email, o.PurchasedByUserId = NULL
        FROM dbo.PromographeOrders o JOIN dbo.PromographeUsers u ON u.Id = o.PurchasedByUserId
        WHERE u.Id = ?
      `, [id], transaction);
      await this.query(`
        UPDATE po SET po.PurchasedByEmailSnapshot = u.Email, po.PurchasedByUserId = NULL
        FROM dbo.PromographePurchaseOrders po JOIN dbo.PromographeUsers u ON u.Id = po.PurchasedByUserId
        WHERE u.Id = ?
      `, [id], transaction);
      await this.query(`
        UPDATE po SET po.SentByEmailSnapshot = u.Email, po.SentByUserId = NULL
        FROM dbo.PromographePurchaseOrders po JOIN dbo.PromographeUsers u ON u.Id = po.SentByUserId
        WHERE u.Id = ?
      `, [id], transaction);
      await this.query("UPDATE dbo.PromographeProducts SET CreatedByUserId = NULL WHERE CreatedByUserId = ?", [id], transaction);
      await this.query("UPDATE dbo.PromographeDepartments SET ManagerUserId = NULL WHERE ManagerUserId = ?", [id], transaction);
      await this.query("DELETE FROM dbo.PromographeUsers WHERE Id = ?", [id], transaction);
      await transaction.commit();
      return true;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listDepartments() {
    const result = await this.query(`
      SELECT d.Id AS id, d.Name AS name, d.ManagerUserId AS manager_user_id,
        u.FullName AS manager_name, u.Email AS manager_email
      FROM dbo.PromographeDepartments d
      LEFT JOIN dbo.PromographeUsers u ON u.Id = d.ManagerUserId
      WHERE d.DeletedAt IS NULL ORDER BY d.Name
    `);
    return result.recordset.map((department) => ({
      ...department,
      manager_user_id: department.manager_user_id === null ? null : Number(department.manager_user_id)
    }));
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
      LEFT JOIN dbo.PromographeOrders o ON o.DepartmentId = d.Id AND YEAR(o.CreatedAt) = ? AND o.IsExternal = 0
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
    const external = (await this.query(`
      SELECT
        SUM(CASE WHEN o.Status = N'approved' THEN i.UnitPriceCents * CAST(i.Quantity AS bigint) END) AS approved_cents,
        SUM(CASE WHEN o.Status = N'pending' THEN i.UnitPriceCents * CAST(i.Quantity AS bigint) END) AS pending_cents,
        COUNT(DISTINCT CASE WHEN o.Status <> N'rejected' THEN o.Id END) AS orders
      FROM dbo.PromographeOrders o
      LEFT JOIN dbo.PromographeOrderItems i ON i.OrderId = o.Id
      WHERE o.IsExternal = 1 AND YEAR(o.CreatedAt) = ?
    `, [year])).recordset[0];
    return {
      external: {
        approvedCents: toNumber(external.approved_cents),
        pendingCents: toNumber(external.pending_cents),
        orders: toNumber(external.orders)
      },
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
      SELECT Id AS id, Name AS name, ContactName AS contact_name, Email AS email, Phone AS phone,
        Website AS website, OrderMethod AS order_method, PhoneExtension AS phone_extension, Note AS note,
        ReducedShippingThresholdCents AS reduced_threshold_cents, FreeShippingThresholdCents AS free_threshold_cents,
        AccountNumber AS account_number, Currency AS currency, PaymentTerms AS payment_terms,
        IsAuthorized AS is_authorized, Category AS category
      FROM dbo.PromographeSuppliers ORDER BY Name
    `);
    return result.recordset.map((supplier) => ({
      ...supplier,
      id: Number(supplier.id),
      is_authorized: Boolean(supplier.is_authorized),
      reduced_threshold_cents: supplier.reduced_threshold_cents === null ? null : Number(supplier.reduced_threshold_cents),
      free_threshold_cents: supplier.free_threshold_cents === null ? null : Number(supplier.free_threshold_cents)
    }));
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

  // details: phoneExtension, note, reducedThresholdCents, freeThresholdCents, accountNumber,
  // currency, paymentTerms, isAuthorized, category.
  async createSupplier(name, contactName, email, phone, website = "", orderMethod = "", details = {}) {
    const result = await this.query(`
      INSERT INTO dbo.PromographeSuppliers (Name, ContactName, Email, Phone, Website, OrderMethod,
        PhoneExtension, Note, ReducedShippingThresholdCents, FreeShippingThresholdCents,
        AccountNumber, Currency, PaymentTerms, IsAuthorized, Category)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, contactName, email, phone, website, orderMethod, ...supplierDetailValues(details)]);
    return Number(result.recordset[0].id);
  }

  async updateSupplier(id, name, contactName, email, phone, website = "", orderMethod = "", details = {}) {
    const result = await this.query(`
      UPDATE dbo.PromographeSuppliers
      SET Name = ?, ContactName = ?, Email = ?, Phone = ?, Website = ?, OrderMethod = ?,
        PhoneExtension = ?, Note = ?, ReducedShippingThresholdCents = ?, FreeShippingThresholdCents = ?,
        AccountNumber = ?, Currency = ?, PaymentTerms = ?, IsAuthorized = ?, Category = ?
      WHERE Id = ?
    `, [name, contactName, email, phone, website, orderMethod, ...supplierDetailValues(details), id]);
    return result.rowsAffected[0] > 0;
  }

  // Products that used the supplier are kept and become "sans fournisseur".
  async deleteSupplier(id) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();
    try {
      await this.query("UPDATE dbo.PromographeProducts SET SupplierId = NULL WHERE SupplierId = ?", [id], transaction);
      await this.query("UPDATE dbo.PromographePurchaseOrders SET SupplierId = NULL WHERE SupplierId = ?", [id], transaction);
      await this.query("UPDATE dbo.PromographeOrderItems SET SupplierId = NULL WHERE SupplierId = ?", [id], transaction);
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
      VALUES (?, ?, N'employee', ?, 0, ?)
    `, [email, passwordHash, departmentId, fullName]);
    return Number(result.recordset[0].id);
  }

  // Employee created on their first Microsoft sign-in; they never use a Promographe password.
  async createMicrosoftEmployee(email, passwordHash, departmentId, fullName) {
    const result = await this.query(`
      INSERT INTO dbo.PromographeUsers (Email, PasswordHash, Role, DepartmentId, IsActive, FullName)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, N'employee', ?, 1, ?)
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
    // The whole catalogue; server.js removes the prices for plain employees and keeps only
    // their department's products for a responsable.
    const departmentFilter = "";
    const parameters = [];
    const result = await this.query(`
      SELECT p.Id AS id, p.Name AS name, p.Description AS description, p.Sku AS sku,
        p.UnitPriceCents AS price_cents, p.IsActive AS is_active, p.Unit AS unit,
        p.DepartmentId AS department_id, d.Name AS department_name,
        p.SupplierId AS supplier_id, s.Name AS supplier_name, s.IsAuthorized AS supplier_authorized
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
      supplier_id: product.supplier_id === null ? null : Number(product.supplier_id),
      supplier_authorized: product.supplier_authorized === null ? true : Boolean(product.supplier_authorized)
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

  async createProduct(name, description, priceCents, departmentId, supplierId, createdByUserId, isActive = true, unit = "unité", sku = "") {
    const result = await this.query(`
      INSERT INTO dbo.PromographeProducts
        (Name, Description, UnitPriceCents, DepartmentId, SupplierId, CreatedByUserId, IsActive, Unit, Sku)
      OUTPUT INSERTED.Id AS id
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, description, priceCents, departmentId, supplierId, createdByUserId, isActive, unit, sku]);
    return Number(result.recordset[0].id);
  }

  async updateProduct(id, name, description, priceCents, departmentId, supplierId, isActive, unit = "unité", sku = "") {
    const result = await this.query(`
      UPDATE dbo.PromographeProducts
      SET Name = ?, Description = ?, UnitPriceCents = ?, DepartmentId = ?, SupplierId = ?, IsActive = ?, Unit = ?, Sku = ?
      WHERE Id = ? AND DeletedAt IS NULL
    `, [name, description, priceCents, departmentId, supplierId, isActive, unit, sku, id]);
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

  async peekNextOrderNumber() {
    const base = orderNumberBase(new Date());
    const sameDay = (await this.query(
      "SELECT OrderNumber AS number FROM dbo.PromographeOrders WHERE OrderNumber LIKE ?",
      [`${base}-%`]
    )).recordset.map((row) => row.number);
    return nextOrderNumber(base, sameDay);
  }

  // client: { name, reference } for a request made for a client (outside the budgets).
  async createOrder(departmentId, userId, notes, items, isUrgent = false, client = null) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const products = [];
      for (const item of items) {
        const result = await this.query(`
          SELECT p.Id AS id, p.Name AS name, p.UnitPriceCents AS price_cents, p.Unit AS unit, p.Sku AS sku,
            p.SupplierId AS supplier_id, s.Name AS supplier_name
          FROM dbo.PromographeProducts p WITH (UPDLOCK, HOLDLOCK)
          LEFT JOIN dbo.PromographeSuppliers s ON s.Id = p.SupplierId
          WHERE p.Id = ? AND p.IsActive = 1
        `, [item.productId], transaction);
        if (!result.recordset.length) {
          await transaction.rollback();
          return null;
        }
        products.push(result.recordset[0]);
      }

      const base = orderNumberBase(new Date());
      const sameDay = (await this.query(`
        SELECT OrderNumber AS number FROM dbo.PromographeOrders WITH (UPDLOCK, HOLDLOCK)
        WHERE OrderNumber LIKE ?
      `, [`${base}-%`], transaction)).recordset.map((row) => row.number);
      const created = await this.query(`
        INSERT INTO dbo.PromographeOrders
          (DepartmentId, CreatedByUserId, Notes, IsUrgent, OrderNumber, IsExternal, ClientName, ClientReference)
        OUTPUT INSERTED.Id AS id
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [departmentId, userId, notes, Boolean(isUrgent), nextOrderNumber(base, sameDay),
        Boolean(client), client?.name || null, client?.reference || null], transaction);
      const orderId = Number(created.recordset[0].id);
      for (let index = 0; index < items.length; index += 1) {
        await this.query(`
          INSERT INTO dbo.PromographeOrderItems
            (OrderId, ProductId, ProductName, UnitPriceCents, Quantity, SupplierId, SupplierName, Unit, Sku)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          orderId,
          items[index].productId,
          products[index].name,
          Number(products[index].price_cents),
          items[index].quantity,
          products[index].supplier_id === null ? null : Number(products[index].supplier_id),
          products[index].supplier_name ?? null,
          items[index].unit || products[index].unit || "unité",
          products[index].sku || ""
        ], transaction);
      }
      await transaction.commit();
      return orderId;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Director and accountant: every request. Responsable: every request of the departments
  // they lead. Everyone also sees their own requests; an employee sees only those.
  async listOrders(user, managedDepartmentIds = []) {
    const departmentIds = [...new Set(managedDepartmentIds.map(Number))];
    const seesAll = SEES_ALL_ROLES.includes(user.role);
    const departmentFilter = seesAll
      ? ""
      : departmentIds.length
        ? `WHERE (o.CreatedByUserId = ? OR o.DepartmentId IN (${departmentIds.map(() => "?").join(", ")}))`
        : "WHERE o.CreatedByUserId = ?";
    const parameters = seesAll ? [] : [Number(user.id), ...departmentIds];
    const result = await this.query(`
      SELECT o.Id AS id, o.OrderNumber AS order_number, o.DepartmentId AS department_id, d.Name AS department_name,
        o.CreatedByUserId AS created_by_user_id,
        COALESCE(u.Email, o.CreatedByEmailSnapshot) AS created_by_email,
        COALESCE(u.FullName, o.CreatedByNameSnapshot) AS created_by_name,
        o.Status AS status, o.Notes AS notes,
        o.DecisionNote AS decision_note, o.CreatedAt AS created_at,
        o.DecidedAt AS decided_at, COALESCE(reviewer.Email, o.DecidedByEmailSnapshot) AS decided_by_email,
        o.IsUrgent AS is_urgent, o.PurchasedAt AS purchased_at,
        o.IsExternal AS is_external, o.ClientName AS client_name, o.ClientReference AS client_reference,
        COALESCE(purchaser.Email, o.PurchasedByEmailSnapshot) AS purchased_by_email,
        i.Id AS item_id, i.ProductId AS product_id, i.ProductName AS product_name,
        i.UnitPriceCents AS price_cents, i.Quantity AS quantity, i.Unit AS unit, i.Sku AS sku,
        i.SupplierName AS supplier_name, po.Number AS purchase_order_number
      FROM dbo.PromographeOrders o
      JOIN dbo.PromographeDepartments d ON d.Id = o.DepartmentId
      LEFT JOIN dbo.PromographeUsers u ON u.Id = o.CreatedByUserId
      LEFT JOIN dbo.PromographeUsers reviewer ON reviewer.Id = o.DecidedByUserId
      LEFT JOIN dbo.PromographeUsers purchaser ON purchaser.Id = o.PurchasedByUserId
      LEFT JOIN dbo.PromographeOrderItems i ON i.OrderId = o.Id
      LEFT JOIN dbo.PromographePurchaseOrders po ON po.Id = i.PurchaseOrderId
      ${departmentFilter}
      ORDER BY o.CreatedAt DESC, o.Id DESC, i.Id
    `, parameters);
    const orders = new Map();
    for (const row of result.recordset) {
      let order = orders.get(Number(row.id));
      if (!order) {
        order = {
          id: Number(row.id),
          number: row.order_number || `DEM-${row.id}`,
          departmentId: Number(row.department_id),
          departmentName: row.department_name,
          createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
          createdByEmail: row.created_by_email,
          createdByName: row.created_by_name || null,
          status: row.status,
          notes: row.notes,
          decisionNote: row.decision_note,
          createdAt: row.created_at,
          decidedAt: row.decided_at,
          decidedByEmail: row.decided_by_email,
          isUrgent: Boolean(row.is_urgent),
          isExternal: Boolean(row.is_external),
          clientName: row.client_name || null,
          clientReference: row.client_reference || null,
          purchasedAt: row.purchased_at,
          purchasedByEmail: row.purchased_by_email || null,
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
          quantity,
          unit: row.unit || "unité",
          sku: row.sku || "",
          supplierName: row.supplier_name || null,
          purchaseOrderNumber: row.purchase_order_number || null
        });
        order.totalCents += priceCents * quantity;
      }
    }
    return [...orders.values()];
  }

  // Adds every approved, not yet bought request line to the open purchase order of its
  // supplier (one per supplier), creating it (numbered PG-AAAA00001) if needed.
  async assignApprovedItemsToPurchaseOrders() {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const pending = (await this.query(`
        SELECT i.Id AS id, i.SupplierId AS supplier_id, i.SupplierName AS supplier_name
        FROM dbo.PromographeOrderItems i WITH (UPDLOCK)
        JOIN dbo.PromographeOrders o ON o.Id = i.OrderId
        WHERE o.Status = N'approved' AND o.PurchasedAt IS NULL AND i.PurchaseOrderId IS NULL
      `, [], transaction)).recordset;
      for (const group of groupBySupplier(pending)) {
        const open = (await this.query(`
          SELECT TOP 1 Id AS id FROM dbo.PromographePurchaseOrders WITH (UPDLOCK, HOLDLOCK)
          WHERE Status = N'open' AND ${group.supplierId === null
            ? "SupplierId IS NULL AND ISNULL(SupplierName, N'') = ?"
            : "SupplierId = ?"}
          ORDER BY Id
        `, [group.supplierId === null ? group.supplierName || "" : group.supplierId], transaction)).recordset[0];
        let purchaseOrderId = open && Number(open.id);
        if (!purchaseOrderId) {
          const base = purchaseOrderNumberBase(new Date());
          const sameYear = (await this.query(`
            SELECT Number AS number FROM dbo.PromographePurchaseOrders WITH (UPDLOCK, HOLDLOCK)
            WHERE Number LIKE ?
          `, [`${base}%`], transaction)).recordset.map((row) => row.number);
          purchaseOrderId = Number((await this.query(`
            INSERT INTO dbo.PromographePurchaseOrders (Number, SupplierId, SupplierName)
            OUTPUT INSERTED.Id AS id VALUES (?, ?, ?)
          `, [nextPurchaseOrderNumber(base, sameYear), group.supplierId, group.supplierName], transaction)).recordset[0].id);
        }
        for (const itemId of group.itemIds) {
          await this.query("UPDATE dbo.PromographeOrderItems SET PurchaseOrderId = ? WHERE Id = ?", [purchaseOrderId, itemId], transaction);
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listPurchaseOrders() {
    const result = await this.query(`
      SELECT po.Id AS id, po.Number AS number, COALESCE(s.Name, po.SupplierName) AS supplier_name,
        po.Status AS status, po.CreatedAt AS created_at, po.PurchasedAt AS purchased_at,
        COALESCE(buyer.Email, po.PurchasedByEmailSnapshot) AS purchased_by_email,
        po.SentAt AS sent_at, COALESCE(sender.Email, po.SentByEmailSnapshot) AS sent_by_email,
        po.SentMethod AS sent_method, po.SentNote AS sent_note,
        s.ContactName AS supplier_contact, s.Email AS supplier_email, s.Phone AS supplier_phone,
        s.Website AS supplier_website, s.OrderMethod AS supplier_order_method,
        s.PhoneExtension AS supplier_phone_extension, s.Note AS supplier_note,
        s.ReducedShippingThresholdCents AS supplier_reduced_threshold_cents,
        s.FreeShippingThresholdCents AS supplier_free_threshold_cents,
        s.AccountNumber AS supplier_account_number, s.Currency AS supplier_currency,
        s.PaymentTerms AS supplier_payment_terms, s.IsAuthorized AS supplier_is_authorized, s.Category AS supplier_category,
        i.ProductId AS product_id, i.ProductName AS product_name, i.UnitPriceCents AS price_cents,
        i.Unit AS unit, i.Sku AS sku, p.Description AS product_description,
        i.Quantity AS quantity, o.Id AS order_id, o.OrderNumber AS order_number, o.IsUrgent AS is_urgent, d.Name AS department_name,
        o.ClientName AS client_name,
        COALESCE(u.FullName, o.CreatedByNameSnapshot, u.Email, o.CreatedByEmailSnapshot) AS requester,
        COALESCE(reviewer.FullName, reviewer.Email, o.DecidedByEmailSnapshot) AS approved_by,
        reviewer.Role AS approved_by_role
      FROM dbo.PromographePurchaseOrders po
      LEFT JOIN dbo.PromographeSuppliers s ON s.Id = po.SupplierId
      LEFT JOIN dbo.PromographeUsers buyer ON buyer.Id = po.PurchasedByUserId
      LEFT JOIN dbo.PromographeUsers sender ON sender.Id = po.SentByUserId
      JOIN dbo.PromographeOrderItems i ON i.PurchaseOrderId = po.Id
      LEFT JOIN dbo.PromographeProducts p ON p.Id = i.ProductId
      JOIN dbo.PromographeOrders o ON o.Id = i.OrderId
      JOIN dbo.PromographeDepartments d ON d.Id = o.DepartmentId
      LEFT JOIN dbo.PromographeUsers u ON u.Id = o.CreatedByUserId
      LEFT JOIN dbo.PromographeUsers reviewer ON reviewer.Id = o.DecidedByUserId
      ORDER BY po.Id DESC, i.ProductName, o.Id
    `);
    return groupPurchaseOrders(result.recordset);
  }

  // The director records how the purchase order was transmitted to the supplier. A sent
  // order takes no more lines: the next approvals open a new one.
  async markPurchaseOrderSent(id, userId, method, note) {
    const result = await this.query(`
      UPDATE dbo.PromographePurchaseOrders
      SET Status = N'sent', SentAt = SYSUTCDATETIME(), SentByUserId = ?, SentMethod = ?, SentNote = ?
      WHERE Id = ? AND Status = N'open'
    `, [userId, method, note || null, id]);
    return result.rowsAffected[0] > 0;
  }

  // Buying a purchase order closes it; a request counts as bought once all its lines are.
  async markPurchaseOrderPurchased(id, userId) {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const updated = await this.query(`
        UPDATE dbo.PromographePurchaseOrders
        SET Status = N'purchased', PurchasedAt = SYSUTCDATETIME(), PurchasedByUserId = ?
        WHERE Id = ? AND Status IN (N'open', N'sent')
      `, [userId, id], transaction);
      if (!updated.rowsAffected[0]) {
        await transaction.rollback();
        return false;
      }
      await this.query(`
        UPDATE o SET o.PurchasedAt = SYSUTCDATETIME(), o.PurchasedByUserId = ?
        FROM dbo.PromographeOrders o
        WHERE o.PurchasedAt IS NULL
          AND EXISTS (SELECT 1 FROM dbo.PromographeOrderItems i WHERE i.OrderId = o.Id AND i.PurchaseOrderId = ?)
          AND NOT EXISTS (
            SELECT 1 FROM dbo.PromographeOrderItems i
            LEFT JOIN dbo.PromographePurchaseOrders po ON po.Id = i.PurchaseOrderId
            WHERE i.OrderId = o.Id AND (po.Id IS NULL OR po.Status <> N'purchased')
          )
      `, [userId, id], transaction);
      await transaction.commit();
      return true;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // The accountant records that an approved request has been bought.
  async markOrderPurchased(id, userId) {
    const result = await this.query(`
      UPDATE dbo.PromographeOrders SET PurchasedAt = SYSUTCDATETIME(), PurchasedByUserId = ?
      WHERE Id = ? AND Status = N'approved' AND PurchasedAt IS NULL
    `, [userId, id]);
    return result.rowsAffected[0] > 0;
  }

  async getOrderOwner(id) {
    const result = await this.query(`
      SELECT o.DepartmentId AS department_id, o.CreatedByUserId AS created_by_user_id, o.Status AS status,
        o.OrderNumber AS order_number,
        (SELECT SUM(CAST(i.UnitPriceCents AS bigint) * i.Quantity)
          FROM dbo.PromographeOrderItems i WHERE i.OrderId = o.Id) AS total_cents
      FROM dbo.PromographeOrders o WHERE o.Id = ?
    `, [id]);
    const order = result.recordset[0];
    return order && {
      department_id: Number(order.department_id),
      created_by_user_id: Number(order.created_by_user_id),
      status: order.status,
      order_number: order.order_number || `DEM-${id}`,
      total_cents: Number(order.total_cents || 0)
    };
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

module.exports = {
  AzureDatabase, createSqlConfig, groupBySupplier, groupPurchaseOrders, nextOrderNumber, orderNumberBase,
  nextPurchaseOrderNumber, purchaseOrderNumberBase
};
