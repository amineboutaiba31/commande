const {
  groupBySupplier, groupPurchaseOrders, nextOrderNumber, orderNumberBase, nextPurchaseOrderNumber, purchaseOrderNumberBase
} = require("../../src/database");

const supplierDetails = (details) => ({
  phone_extension: details.phoneExtension || "",
  note: details.note || "",
  reduced_threshold_cents: details.reducedThresholdCents ?? null,
  free_threshold_cents: details.freeThresholdCents ?? null,
  account_number: details.accountNumber || "",
  currency: details.currency || "CAD",
  payment_terms: details.paymentTerms || "",
  is_authorized: details.isAuthorized !== false,
  category: details.category || ""
});

class MemoryDatabase {
  constructor() {
    this.nextDepartmentId = 1;
    this.nextUserId = 1;
    this.nextInvitationId = 1;
    this.nextProductId = 1;
    this.nextOrderId = 1;
    this.nextSupplierId = 1;
    this.suppliers = new Map();
    this.passwordResets = [];
    this.departments = new Map();
    this.users = new Map();
    this.invitations = new Map();
    this.products = new Map();
    this.orders = new Map();
    this.userFunctions = new Map();
    this.nextItemId = 1;
    this.nextPurchaseOrderId = 1;
    this.purchaseOrders = new Map();
  }

  async getUserByEmail(email) {
    return [...this.users.values()].find((user) => user.email === email);
  }

  async getUserById(id) {
    return this.users.get(Number(id));
  }

  async updateUserFullName(userId, fullName) {
    this.users.get(Number(userId)).full_name = fullName;
  }

  async updatePassword(userId, passwordHash) {
    const user = this.users.get(Number(userId));
    if (!user || !user.is_active) {
      return null;
    }
    user.password_hash = passwordHash;
    user.session_version = (user.session_version || 0) + 1;
    return user.session_version;
  }

  async activateInvitedUser(userId, now) {
    const user = this.users.get(Number(userId));
    const invitations = [...this.invitations.values()]
      .filter((invitation) => invitation.user_id === Number(userId) && invitation.used_at === null);
    if (!user || user.is_active || !invitations.some((invitation) => invitation.expires_at > now)) {
      return false;
    }
    user.is_active = true;
    invitations.forEach((invitation) => { invitation.used_at = now; });
    return true;
  }

  async createPasswordReset(userId, tokenHash, expiresAt, now) {
    this.passwordResets
      .filter((reset) => reset.user_id === userId && reset.used_at === null)
      .forEach((reset) => { reset.used_at = now; });
    this.passwordResets.push({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
  }

  findUsablePasswordReset(tokenHash, now) {
    const reset = this.passwordResets.find((candidate) => (
      candidate.token_hash === tokenHash && candidate.used_at === null && candidate.expires_at > now
    ));
    const user = reset && this.users.get(reset.user_id);
    return reset && user && user.is_active ? { reset, user } : undefined;
  }

  async getPasswordReset(tokenHash, now) {
    const match = this.findUsablePasswordReset(tokenHash, now);
    return match && { email: match.user.email };
  }

  async completePasswordReset(tokenHash, passwordHash, now) {
    const match = this.findUsablePasswordReset(tokenHash, now);
    if (!match) {
      return false;
    }
    await this.updatePassword(match.user.id, passwordHash);
    this.passwordResets
      .filter((reset) => reset.user_id === match.user.id && reset.used_at === null)
      .forEach((reset) => { reset.used_at = now; });
    return true;
  }

  async listUsers() {
    return [...this.users.values()]
      .filter((user) => !user.deleted)
      .map(({ password_hash, deleted, ...user }) => ({
        ...user,
        requested_manager_department_id: user.requested_manager_department_id ?? null,
        functions: [...(this.userFunctions.get(user.id) || [])]
      }));
  }

  async updateUserDetails(id, fullName, departmentId) {
    const user = this.users.get(Number(id));
    if (!user || !["employee", "admin", "accountant", "purchaser"].includes(user.role) || user.deleted) {
      return false;
    }
    if (user.role === "employee" && departmentId === null) {
      // Same rule as the SQL constraint CK_PromographeUsers_EmployeeDepartment.
      throw Object.assign(new Error("employee requires a department"), { number: 547 });
    }
    Object.assign(user, { full_name: fullName, department_id: departmentId === null ? null : Number(departmentId) });
    return true;
  }

  async updateStaffRole(id, role) {
    const user = this.users.get(Number(id));
    if (!user || !["employee", "accountant", "purchaser"].includes(user.role) || user.deleted) {
      return false;
    }
    if (role === "employee" && !user.department_id) {
      throw Object.assign(new Error("employee requires a department"), { number: 547 });
    }
    user.role = role;
    return true;
  }

  async getUserFunctions(userId) {
    return [...(this.userFunctions.get(Number(userId)) || [])].sort();
  }

  async setUserFunctions(userId, codes) {
    this.userFunctions.set(Number(userId), new Set(codes));
  }

  async setManagerRequest(userId, departmentId) {
    this.users.get(Number(userId)).requested_manager_department_id = departmentId === null ? null : Number(departmentId);
  }

  async getManagerRequest(userId) {
    const user = this.users.get(Number(userId));
    const department = user && !user.deleted && (await this.getDepartment(user.requested_manager_department_id));
    return department ? { id: department.id, name: department.name } : null;
  }

  async getManagedDepartments(userId) {
    return [...this.departments.values()]
      .filter((department) => !department.deleted && department.manager_user_id === Number(userId))
      .map(({ id, name }) => ({ id, name }));
  }

  async setDepartmentManager(departmentId, userId) {
    const department = await this.getDepartment(departmentId);
    if (!department) {
      return false;
    }
    department.manager_user_id = userId === null ? null : Number(userId);
    return true;
  }

  async listAdmins() {
    return [...this.users.values()]
      .filter((user) => user.role === "admin" && !user.deleted)
      .map((user) => ({ id: user.id, email: user.email, full_name: user.full_name ?? "", is_active: user.is_active }));
  }

  async createPendingAdmin(email, passwordHash, fullName) {
    if (await this.getUserByEmail(email)) {
      throw Object.assign(new Error("duplicate user"), { number: 2627 });
    }
    const id = this.nextUserId++;
    this.users.set(id, {
      id, email, password_hash: passwordHash, role: "admin", department_id: null, full_name: fullName, is_active: false
    });
    return id;
  }

  async updatePendingAdmin(userId, fullName) {
    const user = this.users.get(Number(userId));
    if (user && user.role === "admin" && !user.is_active) {
      Object.assign(user, { full_name: fullName, deleted: false });
    }
  }

  async deleteEmployee(id) {
    return this.deleteUserWithRole(id, "employee");
  }

  async deleteAdmin(id) {
    return this.deleteUserWithRole(id, "admin");
  }

  async deleteUserWithRole(id, role) {
    const user = this.users.get(Number(id));
    if (!user || user.role !== role || user.deleted) {
      return false;
    }
    // Removed for good; the purchase history keeps a copy of the name and email.
    for (const order of this.orders.values()) {
      if (order.created_by_user_id === user.id) {
        Object.assign(order, {
          created_by_user_id: null,
          created_by_email_snapshot: user.email,
          created_by_name_snapshot: user.full_name || null
        });
      }
      if (order.decided_by_user_id === user.id) {
        Object.assign(order, { decided_by_user_id: null, decided_by_email_snapshot: user.email });
      }
      if (order.purchased_by_user_id === user.id) {
        Object.assign(order, { purchased_by_user_id: null, purchased_by_email_snapshot: user.email });
      }
    }
    for (const purchaseOrder of this.purchaseOrders.values()) {
      if (purchaseOrder.purchased_by_user_id === user.id) {
        Object.assign(purchaseOrder, { purchased_by_user_id: null, purchased_by_email_snapshot: user.email });
      }
      if (purchaseOrder.sent_by_user_id === user.id) {
        Object.assign(purchaseOrder, { sent_by_user_id: null, sent_by_email_snapshot: user.email });
      }
    }
    for (const product of this.products.values()) {
      if (product.created_by_user_id === user.id) {
        product.created_by_user_id = null;
      }
    }
    this.users.delete(user.id);
    for (const [invitationId, invitation] of this.invitations) {
      if (invitation.user_id === user.id) {
        this.invitations.delete(invitationId);
      }
    }
    this.passwordResets = this.passwordResets.filter((reset) => reset.user_id !== user.id);
    this.userFunctions.delete(user.id);
    for (const department of this.departments.values()) {
      if (department.manager_user_id === user.id) {
        department.manager_user_id = null;
      }
    }
    return true;
  }

  async listDepartments() {
    return [...this.departments.values()]
      .filter((department) => !department.deleted)
      .map((department) => {
        const manager = this.users.get(department.manager_user_id);
        return {
          ...department,
          manager_user_id: department.manager_user_id ?? null,
          manager_name: manager?.full_name ?? null,
          manager_email: manager?.email ?? null
        };
      });
  }

  async getDepartment(id) {
    const department = this.departments.get(Number(id));
    return department && !department.deleted ? department : undefined;
  }

  async createDepartment(name) {
    const existing = [...this.departments.values()].find((department) => department.name === name);
    if (existing?.deleted) {
      existing.deleted = false;
      return existing.id;
    }
    if (existing) {
      throw Object.assign(new Error("duplicate department"), { number: 2627 });
    }
    const id = this.nextDepartmentId++;
    this.departments.set(id, { id, name });
    return id;
  }

  async renameDepartment(id, name) {
    const department = await this.getDepartment(id);
    if (!department) {
      return false;
    }
    if ([...this.departments.values()].some((other) => other.name === name && other.id !== department.id)) {
      throw Object.assign(new Error("duplicate department"), { number: 2627 });
    }
    department.name = name;
    return true;
  }

  async deleteDepartment(id) {
    const department = await this.getDepartment(id);
    if (!department) {
      return "not_found";
    }
    if ([...this.users.values()].some((user) => user.department_id === department.id && !user.deleted)) {
      return "has_managers";
    }
    if ([...this.orders.values()].some((order) => order.department_id === department.id && order.status === "pending")) {
      return "has_pending_orders";
    }
    for (const product of this.products.values()) {
      if (product.department_id === department.id) {
        Object.assign(product, { deleted: true, is_active: false });
      }
    }
    department.deleted = true;
    return "deleted";
  }

  async updateDepartmentBudget(id, budgetCents) {
    const department = this.departments.get(Number(id));
    if (!department) {
      return false;
    }
    department.budget_cents = budgetCents;
    return true;
  }

  async getDashboard(year) {
    const yearOrders = [...this.orders.values()]
      .filter((order) => new Date(order.created_at).getFullYear() === year);
    const orders = yearOrders.filter((order) => !order.is_external);
    const clientOrders = yearOrders.filter((order) => order.is_external);
    const total = (order) => order.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
    const orderCounts = {};
    yearOrders.forEach((order) => {
      orderCounts[order.status] = (orderCounts[order.status] || 0) + 1;
    });
    const clientSum = (status) => clientOrders.filter((order) => order.status === status).reduce((sum, order) => sum + total(order), 0);
    return {
      external: {
        approvedCents: clientSum("approved"),
        pendingCents: clientSum("pending"),
        orders: clientOrders.filter((order) => order.status !== "rejected").length
      },
      departments: (await this.listDepartments()).map((department) => {
        const departmentOrders = orders.filter((order) => order.department_id === department.id);
        const sumFor = (status) => departmentOrders
          .filter((order) => order.status === status)
          .reduce((sum, order) => sum + total(order), 0);
        return {
          id: department.id,
          name: department.name,
          budgetCents: department.budget_cents ?? null,
          approvedCents: sumFor("approved"),
          pendingCents: sumFor("pending"),
          pendingOrders: departmentOrders.filter((order) => order.status === "pending").length
        };
      }),
      orderCounts
    };
  }

  async listSuppliers() {
    return [...this.suppliers.values()].map((supplier) => ({ ...supplier }));
  }

  async getSupplier(id) {
    return this.suppliers.get(Number(id));
  }

  async getSupplierByName(name) {
    const supplier = [...this.suppliers.values()]
      .find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    return supplier && { id: supplier.id, name: supplier.name };
  }

  async createSupplier(name, contactName, email, phone, website = "", orderMethod = "", details = {}) {
    if ([...this.suppliers.values()].some((supplier) => supplier.name === name)) {
      throw Object.assign(new Error("duplicate supplier"), { number: 2627 });
    }
    const id = this.nextSupplierId++;
    this.suppliers.set(id, { id, name, contact_name: contactName, email, phone, website, order_method: orderMethod, ...supplierDetails(details) });
    return id;
  }

  async updateSupplier(id, name, contactName, email, phone, website = "", orderMethod = "", details = {}) {
    const supplier = this.suppliers.get(Number(id));
    if (!supplier) {
      return false;
    }
    if ([...this.suppliers.values()].some((other) => other.name === name && other.id !== supplier.id)) {
      throw Object.assign(new Error("duplicate supplier"), { number: 2627 });
    }
    Object.assign(supplier, { name, contact_name: contactName, email, phone, website, order_method: orderMethod, ...supplierDetails(details) });
    return true;
  }

  async getInviteUser(email) {
    const user = await this.getUserByEmail(email);
    if (!user) {
      return undefined;
    }
    return { id: user.id, role: user.role, is_active: user.is_active };
  }

  async createFirstAdmin(email, passwordHash) {
    if ([...this.users.values()].some((user) => user.role === "admin")) {
      throw new Error("administrator exists");
    }
    const id = this.nextUserId++;
    this.users.set(id, {
      id,
      email,
      password_hash: passwordHash,
      role: "admin",
      department_id: null,
      is_active: true
    });
  }

  async createMicrosoftEmployee(email, passwordHash, departmentId, fullName) {
    const id = await this.createPendingManager(email, passwordHash, departmentId, fullName);
    this.users.get(id).is_active = true;
    return id;
  }

  async createPendingManager(email, passwordHash, departmentId, fullName = "") {
    if (await this.getUserByEmail(email)) {
      throw Object.assign(new Error("duplicate user"), { number: 2627 });
    }
    const id = this.nextUserId++;
    this.users.set(id, {
      id,
      email,
      password_hash: passwordHash,
      role: "employee",
      department_id: departmentId,
      full_name: fullName,
      is_active: false
    });
    return id;
  }

  async createInvitation(userId, tokenHash, expiresAt) {
    const id = this.nextInvitationId++;
    this.invitations.set(id, {
      id,
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      used_at: null
    });
    return id;
  }

  async invalidateInvitations(userId, exceptId, now) {
    for (const invitation of this.invitations.values()) {
      if (invitation.user_id === userId && invitation.id !== exceptId && invitation.used_at === null) {
        invitation.used_at = now;
      }
    }
  }

  async updatePendingManagerDepartment(userId, departmentId, fullName = "") {
    const user = this.users.get(Number(userId));
    if (user && !user.is_active) {
      user.department_id = departmentId;
      user.full_name = fullName;
      user.deleted = false;
    }
  }

  async rollbackInvitation(invitationId, userId, createdUser) {
    this.invitations.delete(Number(invitationId));
    if (createdUser) {
      this.users.delete(Number(userId));
    }
  }

  async deletePendingManager(userId) {
    const user = this.users.get(Number(userId));
    if (user && !user.is_active) {
      this.users.delete(Number(userId));
    }
  }

  async getInvitation(tokenHash) {
    const invitation = [...this.invitations.values()]
      .find((entry) => entry.token_hash === tokenHash);
    const user = invitation && this.users.get(invitation.user_id);
    if (!invitation || !user || user.is_active) {
      return undefined;
    }
    return {
      id: invitation.id,
      expires_at: invitation.expires_at,
      used_at: invitation.used_at,
      email: user.email,
      role: user.role,
      department_name: this.departments.get(user.department_id)?.name ?? null
    };
  }

  async acceptInvitation(tokenHash, passwordHash, now) {
    const invitation = [...this.invitations.values()]
      .find((entry) => entry.token_hash === tokenHash && entry.used_at === null && entry.expires_at > now);
    const user = invitation && this.users.get(invitation.user_id);
    if (!invitation || !user || user.is_active) {
      return false;
    }
    user.password_hash = passwordHash;
    user.is_active = true;
    for (const candidate of this.invitations.values()) {
      if (candidate.user_id === user.id && candidate.used_at === null) {
        candidate.used_at = now;
      }
    }
    return true;
  }

  async listProducts(user) {
    return [...this.products.values()]
      .filter((product) => !product.deleted)
      .map(({ deleted, ...product }) => ({
        ...product,
        department_name: this.departments.get(product.department_id)?.name ?? null,
        supplier_name: this.suppliers.get(product.supplier_id)?.name ?? null,
        supplier_authorized: this.suppliers.get(product.supplier_id)?.is_authorized ?? true
      }));
  }

  async getProduct(id) {
    const product = this.products.get(Number(id));
    return product && !product.deleted && {
      id: product.id,
      department_id: product.department_id,
      supplier_id: product.supplier_id
    };
  }

  async createProduct(name, description, priceCents, departmentId, supplierId, createdByUserId, isActive = true, unit = "unité", sku = "") {
    const id = this.nextProductId++;
    this.products.set(id, {
      id,
      name,
      description,
      sku,
      price_cents: priceCents,
      department_id: Number(departmentId),
      supplier_id: supplierId,
      is_active: isActive,
      unit,
      created_by_user_id: createdByUserId
    });
    return id;
  }

  async updateProduct(id, name, description, priceCents, departmentId, supplierId, isActive, unit = "unité", sku = "") {
    const product = this.products.get(Number(id));
    if (!product || product.deleted) {
      return false;
    }
    Object.assign(product, {
      name,
      description,
      sku,
      price_cents: priceCents,
      department_id: Number(departmentId),
      supplier_id: supplierId,
      is_active: isActive,
      unit
    });
    return true;
  }

  async deleteProduct(id) {
    const product = this.products.get(Number(id));
    if (!product || product.deleted) {
      return false;
    }
    Object.assign(product, { deleted: true, is_active: false });
    return true;
  }

  async deleteSupplier(id) {
    for (const product of this.products.values()) {
      if (product.supplier_id === Number(id)) {
        product.supplier_id = null;
      }
    }
    for (const purchaseOrder of this.purchaseOrders.values()) {
      if (purchaseOrder.supplier_id === Number(id)) {
        purchaseOrder.supplier_id = null;
      }
    }
    for (const order of this.orders.values()) {
      for (const item of order.items) {
        if (item.supplierId === Number(id)) {
          item.supplierId = null;
        }
      }
    }
    return this.suppliers.delete(Number(id));
  }

  async peekNextOrderNumber() {
    return nextOrderNumber(orderNumberBase(new Date()), [...this.orders.values()].map((order) => order.number));
  }

  async createOrder(departmentId, userId, notes, items, isUrgent = false, client = null) {
    const orderItems = [];
    for (const item of items) {
      const product = this.products.get(Number(item.productId));
      if (!product || !product.is_active) {
        return null;
      }
      orderItems.push({
        id: this.nextItemId++,
        productId: product.id,
        productName: product.name,
        priceCents: product.price_cents,
        quantity: item.quantity,
        unit: item.unit || product.unit || "unité",
        sku: product.sku || "",
        supplierId: product.supplier_id ?? null,
        supplierName: this.suppliers.get(product.supplier_id)?.name ?? null,
        purchaseOrderId: null
      });
    }
    const id = this.nextOrderId++;
    const base = orderNumberBase(new Date());
    this.orders.set(id, {
      id,
      number: nextOrderNumber(base, [...this.orders.values()].map((order) => order.number)),
      department_id: Number(departmentId),
      created_by_user_id: Number(userId),
      status: "pending",
      notes,
      decision_note: null,
      decided_by_user_id: null,
      created_at: new Date().toISOString(),
      decided_at: null,
      is_urgent: Boolean(isUrgent),
      is_external: Boolean(client),
      client_name: client?.name || null,
      client_reference: client?.reference || null,
      purchased_at: null,
      purchased_by_user_id: null,
      items: orderItems
    });
    return id;
  }

  async listOrders(user, managedDepartmentIds = []) {
    const departmentIds = managedDepartmentIds.map(Number);
    return [...this.orders.values()]
      .filter((order) => ["admin", "accountant"].includes(user.role) ||
        order.created_by_user_id === Number(user.id) || departmentIds.includes(order.department_id))
      .sort((a, b) => b.id - a.id)
      .map((order) => {
        const department = this.departments.get(order.department_id);
        const creator = this.users.get(order.created_by_user_id);
        const decider = this.users.get(order.decided_by_user_id);
        return {
          id: order.id,
          number: order.number,
          departmentId: order.department_id,
          departmentName: department.name,
          createdByUserId: order.created_by_user_id,
          createdByEmail: creator ? creator.email : order.created_by_email_snapshot,
          createdByName: (creator ? creator.full_name : order.created_by_name_snapshot) || null,
          status: order.status,
          notes: order.notes,
          decisionNote: order.decision_note,
          createdAt: order.created_at,
          decidedAt: order.decided_at,
          decidedByEmail: decider ? decider.email : order.decided_by_email_snapshot,
          isUrgent: Boolean(order.is_urgent),
          isExternal: Boolean(order.is_external),
          clientName: order.client_name || null,
          clientReference: order.client_reference || null,
          purchasedAt: order.purchased_at,
          purchasedByEmail: this.users.get(order.purchased_by_user_id)?.email ?? order.purchased_by_email_snapshot ?? null,
          items: order.items.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            priceCents: item.priceCents,
            quantity: item.quantity,
            unit: item.unit,
            sku: item.sku || "",
            supplierName: item.supplierName,
            purchaseOrderNumber: this.purchaseOrders.get(item.purchaseOrderId)?.number ?? null
          })),
          totalCents: order.items.reduce((total, item) => (
            total + item.priceCents * item.quantity
          ), 0)
        };
      });
  }

  async assignApprovedItemsToPurchaseOrders() {
    const pending = [];
    for (const order of this.orders.values()) {
      if (order.status === "approved" && !order.purchased_at) {
        for (const item of order.items) {
          if (!item.purchaseOrderId) {
            pending.push({ id: item.id, supplier_id: item.supplierId, supplier_name: item.supplierName, item });
          }
        }
      }
    }
    const itemsById = new Map(pending.map((entry) => [entry.id, entry.item]));
    for (const group of groupBySupplier(pending)) {
      let purchaseOrder = [...this.purchaseOrders.values()].find((candidate) => candidate.status === "open" && (
        group.supplierId === null
          ? candidate.supplier_id === null && (candidate.supplier_name || "") === (group.supplierName || "")
          : candidate.supplier_id === group.supplierId
      ));
      if (!purchaseOrder) {
        purchaseOrder = {
          id: this.nextPurchaseOrderId++,
          number: nextPurchaseOrderNumber(purchaseOrderNumberBase(new Date()), [...this.purchaseOrders.values()].map((candidate) => candidate.number)),
          supplier_id: group.supplierId,
          supplier_name: group.supplierName,
          status: "open",
          created_at: new Date().toISOString(),
          purchased_at: null,
          purchased_by_user_id: null
        };
        this.purchaseOrders.set(purchaseOrder.id, purchaseOrder);
      }
      for (const itemId of group.itemIds) {
        itemsById.get(itemId).purchaseOrderId = purchaseOrder.id;
      }
    }
  }

  async listPurchaseOrders() {
    const rows = [];
    for (const purchaseOrder of [...this.purchaseOrders.values()].sort((a, b) => b.id - a.id)) {
      const lines = [];
      for (const order of [...this.orders.values()].sort((a, b) => a.id - b.id)) {
        const creator = this.users.get(order.created_by_user_id);
        const reviewer = this.users.get(order.decided_by_user_id);
        for (const item of order.items.filter((candidate) => candidate.purchaseOrderId === purchaseOrder.id)) {
          lines.push({
            id: purchaseOrder.id,
            number: purchaseOrder.number,
            supplier_name: this.suppliers.get(purchaseOrder.supplier_id)?.name ?? purchaseOrder.supplier_name,
            status: purchaseOrder.status,
            created_at: purchaseOrder.created_at,
            purchased_at: purchaseOrder.purchased_at,
            purchased_by_email: this.users.get(purchaseOrder.purchased_by_user_id)?.email ?? purchaseOrder.purchased_by_email_snapshot ?? null,
            sent_at: purchaseOrder.sent_at ?? null,
            sent_by_email: this.users.get(purchaseOrder.sent_by_user_id)?.email ?? purchaseOrder.sent_by_email_snapshot ?? null,
            sent_method: purchaseOrder.sent_method ?? null,
            sent_note: purchaseOrder.sent_note ?? null,
            supplier_contact: this.suppliers.get(purchaseOrder.supplier_id)?.contact_name ?? "",
            supplier_email: this.suppliers.get(purchaseOrder.supplier_id)?.email ?? "",
            supplier_phone: this.suppliers.get(purchaseOrder.supplier_id)?.phone ?? "",
            supplier_website: this.suppliers.get(purchaseOrder.supplier_id)?.website ?? "",
            supplier_order_method: this.suppliers.get(purchaseOrder.supplier_id)?.order_method ?? "",
            supplier_phone_extension: this.suppliers.get(purchaseOrder.supplier_id)?.phone_extension ?? "",
            supplier_note: this.suppliers.get(purchaseOrder.supplier_id)?.note ?? "",
            supplier_reduced_threshold_cents: this.suppliers.get(purchaseOrder.supplier_id)?.reduced_threshold_cents ?? null,
            supplier_free_threshold_cents: this.suppliers.get(purchaseOrder.supplier_id)?.free_threshold_cents ?? null,
            supplier_account_number: this.suppliers.get(purchaseOrder.supplier_id)?.account_number ?? "",
            supplier_currency: this.suppliers.get(purchaseOrder.supplier_id)?.currency ?? "CAD",
            supplier_payment_terms: this.suppliers.get(purchaseOrder.supplier_id)?.payment_terms ?? "",
            supplier_is_authorized: this.suppliers.get(purchaseOrder.supplier_id)?.is_authorized ?? true,
            supplier_category: this.suppliers.get(purchaseOrder.supplier_id)?.category ?? "",
            product_description: this.products.get(item.productId)?.description ?? "",
            product_id: item.productId,
            product_name: item.productName,
            price_cents: item.priceCents,
            quantity: item.quantity,
            unit: item.unit,
            sku: item.sku || "",
            order_id: order.id,
            order_number: order.number,
            client_name: order.client_name || null,
            is_urgent: order.is_urgent,
            department_name: this.departments.get(order.department_id).name,
            requester: (creator ? creator.full_name || creator.email : order.created_by_name_snapshot || order.created_by_email_snapshot),
            approved_by: reviewer ? reviewer.full_name || reviewer.email : order.decided_by_email_snapshot ?? null,
            approved_by_role: reviewer ? reviewer.role : null
          });
        }
      }
      rows.push(...lines.sort((a, b) => a.product_name.localeCompare(b.product_name) || a.order_id - b.order_id));
    }
    return groupPurchaseOrders(rows);
  }

  async markPurchaseOrderSent(id, userId, method, note) {
    const purchaseOrder = this.purchaseOrders.get(Number(id));
    if (!purchaseOrder || purchaseOrder.status !== "open") {
      return false;
    }
    Object.assign(purchaseOrder, {
      status: "sent", sent_at: new Date().toISOString(), sent_by_user_id: Number(userId), sent_method: method, sent_note: note || null
    });
    return true;
  }

  async markPurchaseOrderPurchased(id, userId) {
    const purchaseOrder = this.purchaseOrders.get(Number(id));
    if (!purchaseOrder || !["open", "sent"].includes(purchaseOrder.status)) {
      return false;
    }
    const now = new Date().toISOString();
    Object.assign(purchaseOrder, { status: "purchased", purchased_at: now, purchased_by_user_id: Number(userId) });
    for (const order of this.orders.values()) {
      if (!order.purchased_at && order.items.some((item) => item.purchaseOrderId === purchaseOrder.id) &&
        order.items.every((item) => this.purchaseOrders.get(item.purchaseOrderId)?.status === "purchased")) {
        Object.assign(order, { purchased_at: now, purchased_by_user_id: Number(userId) });
      }
    }
    return true;
  }

  async markOrderPurchased(id, userId) {
    const order = this.orders.get(Number(id));
    if (!order || order.status !== "approved" || order.purchased_at) {
      return false;
    }
    Object.assign(order, { purchased_at: new Date().toISOString(), purchased_by_user_id: Number(userId) });
    return true;
  }

  async getOrderOwner(id) {
    const order = this.orders.get(Number(id));
    return order && {
      department_id: order.department_id,
      created_by_user_id: order.created_by_user_id,
      status: order.status,
      order_number: order.number,
      total_cents: order.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
    };
  }

  async decideOrder(id, status, decisionNote, decidedByUserId) {
    const order = this.orders.get(Number(id));
    if (!order || order.status !== "pending") {
      return false;
    }
    order.status = status;
    order.decision_note = decisionNote;
    order.decided_by_user_id = Number(decidedByUserId);
    order.decided_at = new Date().toISOString();
    return true;
  }

  async close() {}
}

module.exports = { MemoryDatabase };
