class MemoryDatabase {
  constructor() {
    this.nextDepartmentId = 1;
    this.nextUserId = 1;
    this.nextInvitationId = 1;
    this.nextProductId = 1;
    this.nextOrderId = 1;
    this.nextSupplierId = 1;
    this.suppliers = new Map();
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

  async listUsers() {
    return [...this.users.values()].map(({ password_hash, ...user }) => user);
  }

  async listDepartments() {
    return [...this.departments.values()];
  }

  async getDepartment(id) {
    return this.departments.get(Number(id));
  }

  async createDepartment(name) {
    if ([...this.departments.values()].some((department) => department.name === name)) {
      throw Object.assign(new Error("duplicate department"), { number: 2627 });
    }
    const id = this.nextDepartmentId++;
    this.departments.set(id, { id, name });
    return id;
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
    const supplierTotals = new Map();
    orders.filter((order) => order.status === "approved").forEach((order) => {
      order.items.forEach((item) => {
        const supplierId = this.products.get(item.productId)?.supplier_id;
        const name = this.suppliers.get(supplierId)?.name ?? null;
        supplierTotals.set(name, (supplierTotals.get(name) || 0) + item.priceCents * item.quantity);
      });
    });
    const orderCounts = {};
    orders.forEach((order) => {
      orderCounts[order.status] = (orderCounts[order.status] || 0) + 1;
    });
    return {
      departments: [...this.departments.values()].map((department) => {
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
      suppliers: [...supplierTotals].map(([name, approvedCents]) => ({ name, approvedCents }))
        .sort((a, b) => b.approvedCents - a.approvedCents),
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
    const department = user && this.departments.get(user.department_id);
    if (!invitation || !user || user.is_active || !department) {
      return undefined;
    }
    return {
      id: invitation.id,
      expires_at: invitation.expires_at,
      used_at: invitation.used_at,
      email: user.email,
      department_name: department.name
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
      .filter((product) => user.role === "admin" || product.department_id === Number(user.department_id))
      .map((product) => ({
        ...product,
        department_name: this.departments.get(product.department_id)?.name ?? null,
        supplier_name: this.suppliers.get(product.supplier_id)?.name ?? null
      }));
  }

  async getProduct(id) {
    const product = this.products.get(Number(id));
    return product && {
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
    if (!product) {
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
