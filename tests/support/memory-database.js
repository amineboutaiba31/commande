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
      .map(({ password_hash, deleted, ...user }) => user);
  }

  async updateManager(id, fullName, departmentId) {
    const user = this.users.get(Number(id));
    if (!user || user.role !== "department_manager" || user.deleted) {
      return false;
    }
    Object.assign(user, { full_name: fullName, department_id: Number(departmentId) });
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

  async deleteManager(id) {
    return this.deleteUserWithRole(id, "department_manager");
  }

  async deleteAdmin(id) {
    return this.deleteUserWithRole(id, "admin");
  }

  async deleteUserWithRole(id, role) {
    const user = this.users.get(Number(id));
    if (!user || user.role !== role || user.deleted) {
      return false;
    }
    Object.assign(user, {
      deleted: true,
      is_active: false,
      session_version: (user.session_version || 0) + 1
    });
    for (const [invitationId, invitation] of this.invitations) {
      if (invitation.user_id === user.id) {
        this.invitations.delete(invitationId);
      }
    }
    this.passwordResets = this.passwordResets.filter((reset) => reset.user_id !== user.id);
    return true;
  }

  async listDepartments() {
    return [...this.departments.values()].filter((department) => !department.deleted);
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
    const orders = [...this.orders.values()]
      .filter((order) => new Date(order.created_at).getFullYear() === year);
    const total = (order) => order.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
    const orderCounts = {};
    orders.forEach((order) => {
      orderCounts[order.status] = (orderCounts[order.status] || 0) + 1;
    });
    return {
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

  async createSupplier(name, contactName, email, phone) {
    if ([...this.suppliers.values()].some((supplier) => supplier.name === name)) {
      throw Object.assign(new Error("duplicate supplier"), { number: 2627 });
    }
    const id = this.nextSupplierId++;
    this.suppliers.set(id, { id, name, contact_name: contactName, email, phone });
    return id;
  }

  async updateSupplier(id, name, contactName, email, phone) {
    const supplier = this.suppliers.get(Number(id));
    if (!supplier) {
      return false;
    }
    if ([...this.suppliers.values()].some((other) => other.name === name && other.id !== supplier.id)) {
      throw Object.assign(new Error("duplicate supplier"), { number: 2627 });
    }
    Object.assign(supplier, { name, contact_name: contactName, email, phone });
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

  async createPendingManager(email, passwordHash, departmentId, fullName = "") {
    if (await this.getUserByEmail(email)) {
      throw Object.assign(new Error("duplicate user"), { number: 2627 });
    }
    const id = this.nextUserId++;
    this.users.set(id, {
      id,
      email,
      password_hash: passwordHash,
      role: "department_manager",
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
      .filter((product) => user.role === "admin" || product.department_id === Number(user.department_id))
      .map(({ deleted, ...product }) => ({
        ...product,
        department_name: this.departments.get(product.department_id)?.name ?? null,
        supplier_name: this.suppliers.get(product.supplier_id)?.name ?? null
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

  async createProduct(name, description, priceCents, departmentId, supplierId, createdByUserId, isActive = true) {
    const id = this.nextProductId++;
    this.products.set(id, {
      id,
      name,
      description,
      price_cents: priceCents,
      department_id: Number(departmentId),
      supplier_id: supplierId,
      is_active: isActive,
      created_by_user_id: createdByUserId
    });
    return id;
  }

  async updateProduct(id, name, description, priceCents, departmentId, supplierId, isActive) {
    const product = this.products.get(Number(id));
    if (!product || product.deleted) {
      return false;
    }
    Object.assign(product, {
      name,
      description,
      price_cents: priceCents,
      department_id: Number(departmentId),
      supplier_id: supplierId,
      is_active: isActive
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
    return this.suppliers.delete(Number(id));
  }

  async createOrder(departmentId, userId, notes, items) {
    const orderItems = [];
    for (const item of items) {
      const product = this.products.get(Number(item.productId));
      if (!product || !product.is_active || product.department_id !== Number(departmentId)) {
        return null;
      }
      orderItems.push({
        productId: product.id,
        productName: product.name,
        priceCents: product.price_cents,
        quantity: item.quantity
      });
    }
    const id = this.nextOrderId++;
    this.orders.set(id, {
      id,
      department_id: Number(departmentId),
      created_by_user_id: Number(userId),
      status: "pending",
      notes,
      decision_note: null,
      decided_by_user_id: null,
      created_at: new Date().toISOString(),
      decided_at: null,
      items: orderItems
    });
    return id;
  }

  async listOrders(user) {
    return [...this.orders.values()]
      .filter((order) => user.role === "admin" || order.department_id === Number(user.department_id))
      .sort((a, b) => b.id - a.id)
      .map((order) => {
        const department = this.departments.get(order.department_id);
        const creator = this.users.get(order.created_by_user_id);
        const decider = this.users.get(order.decided_by_user_id);
        return {
          id: order.id,
          departmentId: order.department_id,
          departmentName: department.name,
          createdByEmail: creator.email,
          createdByName: creator.full_name || null,
          status: order.status,
          notes: order.notes,
          decisionNote: order.decision_note,
          createdAt: order.created_at,
          decidedAt: order.decided_at,
          decidedByEmail: decider && decider.email,
          items: order.items.map((item) => ({ ...item })),
          totalCents: order.items.reduce((total, item) => (
            total + item.priceCents * item.quantity
          ), 0)
        };
      });
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
