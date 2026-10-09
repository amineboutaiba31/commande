const roleNames = {
  admin: "Administrateur",
  department_manager: "Responsable de département"
};
const statusNames = {
  pending: "En attente",
  approved: "Approuvée",
  rejected: "Refusée"
};
const currency = new Intl.NumberFormat("fr-CA", {
  style: "currency",
  currency: "CAD"
});
const dateTime = new Intl.DateTimeFormat("fr-CA", {
  dateStyle: "medium",
  timeStyle: "short"
});

let currentUser;
let products = [];
let departments = [];

function money(cents) {
  return currency.format(cents / 100);
}

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
}

async function getCsrfToken() {
  const response = await fetch("/api/auth/csrf");
  if (!response.ok) {
    throw new Error("La session a expiré. Reconnecte-toi.");
  }
  return (await response.json()).csrfToken;
}

async function apiRequest(url, method = "GET", body) {
  const headers = {};
  const options = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  if (method !== "GET") {
    headers["X-CSRF-Token"] = await getCsrfToken();
  }
  const response = await fetch(url, options);
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    throw new Error(data.error || "La requête a échoué.");
  }
  return data;
}

function addOrderItemRow() {
  const row = document.createElement("div");
  row.className = "order-item-row";

  const productLabel = document.createElement("label");
  productLabel.textContent = "Produit";
  const select = document.createElement("select");
  select.name = "productId";
  select.required = true;
  select.add(new Option("Choisir un produit", ""));
  products.filter((product) => product.is_active).forEach((product) => {
    select.add(new Option(`${product.name} · ${money(product.price_cents)}`, product.id));
  });
  productLabel.append(select);

  const quantityLabel = document.createElement("label");
  quantityLabel.textContent = "Quantité";
  const quantity = document.createElement("input");
  quantity.name = "quantity";
  quantity.type = "number";
  quantity.min = "1";
  quantity.max = "10000";
  quantity.step = "1";
  quantity.value = "1";
  quantity.required = true;
  quantityLabel.append(quantity);

  const remove = document.createElement("button");
  remove.className = "remove-item";
  remove.type = "button";
  remove.textContent = "Retirer";
  remove.setAttribute("aria-label", "Retirer ce produit");
  remove.addEventListener("click", () => row.remove());

  row.append(productLabel, quantityLabel, remove);
  document.getElementById("orderItems").append(row);
}

function renderProducts() {
  renderDepartmentList();
  const list = document.getElementById("productList");
  list.replaceChildren();
  const filter = document.getElementById("productFilter").value;
  const visible = filter
    ? products.filter((product) => product.department_id === Number(filter))
    : products;
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = filter || currentUser?.role !== "admin"
      ? "Aucun produit pour ce département. Ajoutez le premier produit ci-dessus."
      : "Aucun produit au catalogue. Ajoutez le premier produit ci-dessus.";
    list.append(empty);
    return;
  }

  visible.forEach((product) => {
    const card = document.createElement("article");
    card.className = "product-card";
    const topline = document.createElement("div");
    topline.className = "product-topline";
    const name = document.createElement("h3");
    name.textContent = product.name;
    const availability = document.createElement("span");
    availability.className = `availability ${product.is_active ? "active" : "inactive"}`;
    availability.textContent = product.is_active ? "Disponible" : "Inactif";
    topline.append(name, availability);

    const department = document.createElement("p");
    department.className = "product-department";
    department.textContent = [
      product.department_name || "Sans département",
      product.supplier_name && `Fournisseur : ${product.supplier_name}`
    ].filter(Boolean).join(" · ");

    const description = document.createElement("p");
    description.className = "product-description";
    description.textContent = product.description || "Aucune description.";
    const price = document.createElement("p");
    price.className = "product-price";
    price.textContent = money(product.price_cents);

    const actions = document.createElement("div");
    actions.className = "product-actions";
    const edit = document.createElement("button");
    edit.className = "button button-secondary";
    edit.type = "button";
    edit.textContent = "Modifier";
    edit.addEventListener("click", () => beginProductEdit(product));
    actions.append(edit);
    card.append(topline, department, description, price, actions);
    list.append(card);
  });
}

function beginProductEdit(product) {
  const form = document.getElementById("productForm");
  form.elements.productId.value = product.id;
  form.elements.name.value = product.name;
  form.elements.description.value = product.description || "";
  form.elements.price.value = (product.price_cents / 100).toFixed(2);
  form.elements.departmentId.value = product.department_id ?? "";
  form.elements.supplierName.value = product.supplier_name || "";
  form.elements.isActive.checked = product.is_active;
  document.getElementById("productFormTitle").textContent = "Modifier le produit";
  document.getElementById("saveProductButton").textContent = "Enregistrer les modifications";
  document.getElementById("cancelProductEdit").hidden = false;
  showMessage(document.getElementById("productMessage"), "");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetProductForm() {
  const form = document.getElementById("productForm");
  form.reset();
  form.elements.productId.value = "";
  form.elements.isActive.checked = true;
  document.getElementById("productFormTitle").textContent = "Ajouter un produit";
  document.getElementById("saveProductButton").textContent = "Ajouter au catalogue";
  document.getElementById("cancelProductEdit").hidden = true;
}

function renderOrders(orders) {
  const list = document.getElementById("orderList");
  list.replaceChildren();
  if (!orders.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = currentUser.role === "admin"
      ? "Aucune demande de commande pour le moment."
      : "Vous n’avez pas encore soumis de demande.";
    list.append(empty);
    return;
  }

  orders.forEach((order) => {
    const card = document.createElement("article");
    card.className = "order-card";
    const topline = document.createElement("div");
    topline.className = "order-topline";
    const title = document.createElement("h3");
    title.textContent = `Demande no ${order.id}`;
    const badge = document.createElement("span");
    badge.className = `status-badge status-${order.status}`;
    badge.textContent = statusNames[order.status] || order.status;
    topline.append(title, badge);

    const origin = document.createElement("dl");
    origin.className = "order-origin";
    const addOrigin = (label, value) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      origin.append(term, detail);
    };
    addOrigin("Département", order.departmentName);
    addOrigin(
      "Responsable",
      order.createdByName ? `${order.createdByName} (${order.createdByEmail})` : order.createdByEmail
    );
    const meta = document.createElement("p");
    meta.className = "order-meta";
    const createdAt = new Date(order.createdAt);
    meta.textContent = `Soumise le ${dateTime.format(createdAt)}`;

    const lines = document.createElement("ul");
    lines.className = "order-lines";
    order.items.forEach((item) => {
      const line = document.createElement("li");
      const itemText = document.createElement("span");
      itemText.textContent = `${item.quantity} × ${item.productName} (${money(item.priceCents)} / unité)`;
      const subtotal = document.createElement("strong");
      subtotal.textContent = money(item.quantity * item.priceCents);
      line.append(itemText, subtotal);
      lines.append(line);
    });

    const total = document.createElement("div");
    total.className = "order-total";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "Total";
    const totalValue = document.createElement("span");
    totalValue.textContent = money(order.totalCents);
    total.append(totalLabel, totalValue);
    card.append(topline, origin, meta, lines, total);

    if (order.notes) {
      const note = document.createElement("p");
      note.className = "order-note";
      note.textContent = `Note : ${order.notes}`;
      card.append(note);
    }
    if (order.decidedAt) {
      const decision = document.createElement("p");
      decision.className = "order-meta";
      const decidedAt = new Date(order.decidedAt);
      decision.textContent = `${order.decidedByEmail || "Administrateur"} · décision le ${dateTime.format(decidedAt)}`;
      card.append(decision);
    }
    if (order.decisionNote) {
      const note = document.createElement("p");
      note.className = "order-note";
      note.textContent = `Note de décision : ${order.decisionNote}`;
      card.append(note);
    }
    if (currentUser.role === "admin" && order.status === "pending") {
      const decisionForm = document.createElement("form");
      decisionForm.className = "decision-form";
      const label = document.createElement("label");
      label.textContent = "Note de décision (facultatif)";
      const note = document.createElement("textarea");
      note.name = "decisionNote";
      note.maxLength = 1000;
      note.rows = 1;
      const approve = document.createElement("button");
      approve.className = "button";
      approve.type = "button";
      approve.textContent = "Approuver";
      const reject = document.createElement("button");
      reject.className = "button button-danger";
      reject.type = "button";
      reject.textContent = "Refuser";
      const decide = async (status) => {
        approve.disabled = true;
        reject.disabled = true;
        try {
          await apiRequest(`/api/admin/orders/${order.id}`, "PATCH", {
            status,
            decisionNote: note.value
          });
          await Promise.all([loadOrders(), loadDashboard()]);
        } catch (error) {
          window.alert(error.message);
          approve.disabled = false;
          reject.disabled = false;
        }
      };
      approve.addEventListener("click", () => decide("approved"));
      reject.addEventListener("click", () => decide("rejected"));
      decisionForm.append(label, note, approve, reject);
      card.append(decisionForm);
    }
    list.append(card);
  });
}

async function loadProducts() {
  const result = await apiRequest("/api/products");
  products = result.products;
  renderProducts();
}

async function loadOrders() {
  const result = await apiRequest("/api/orders");
  renderOrders(result.orders);
}

function renderDepartmentList() {
  const list = document.getElementById("departmentList");
  list.replaceChildren();
  if (!departments.length) {
    const item = document.createElement("li");
    item.textContent = "Aucun département. Créez le premier ci-dessus.";
    list.append(item);
    return;
  }
  departments.forEach((department) => {
    const count = products.filter((product) => product.department_id === department.id).length;
    const item = document.createElement("li");
    item.textContent = `${department.name} · ${count} produit${count > 1 ? "s" : ""}`;
    list.append(item);
  });
}

function fillDepartmentSelect(select, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  departments.forEach((department) => {
    select.add(new Option(department.name, department.id));
  });
  select.value = previous;
}

function renderSuppliers(suppliers) {
  document.getElementById("supplierOptions").replaceChildren(
    ...suppliers.map((supplier) => new Option(supplier.name))
  );

  const list = document.getElementById("supplierList");
  list.replaceChildren();
  if (!suppliers.length) {
    const item = document.createElement("li");
    item.textContent = "Aucun fournisseur. Ajoutez le premier ci-contre.";
    list.append(item);
    return;
  }
  suppliers.forEach((supplier) => {
    const item = document.createElement("li");
    const details = [supplier.contact_name, supplier.email, supplier.phone].filter(Boolean);
    item.textContent = details.length
      ? `${supplier.name} · ${details.join(" · ")}`
      : supplier.name;
    list.append(item);
  });
}

async function loadAdminPanel() {
  const [departmentsResult, usersResult, suppliersResult] = await Promise.all([
    apiRequest("/api/admin/departments"),
    apiRequest("/api/admin/users"),
    apiRequest("/api/admin/suppliers")
  ]);
  departments = departmentsResult.departments.map((department) => ({
    ...department,
    id: Number(department.id)
  }));
  fillDepartmentSelect(document.getElementById("departmentId"), "Choisir un département");
  fillDepartmentSelect(document.getElementById("productDepartment"), "Choisir un département");
  fillDepartmentSelect(document.getElementById("productFilter"), "Tous les départements");
  renderSuppliers(suppliersResult.suppliers);
  renderProducts();

  const list = document.getElementById("userList");
  list.replaceChildren();
  usersResult.users.filter((user) => user.role === "department_manager").forEach((user) => {
    const item = document.createElement("li");
    const department = departments.find((candidate) => candidate.id === Number(user.department_id));
    item.textContent = [
      user.full_name || "Nom non renseigné",
      user.email,
      department ? department.name : "Sans département",
      user.is_active ? "Actif" : "Invitation en attente"
    ].join(" · ");
    list.append(item);
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === tab);
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.panel;
    });
  });
});

document.getElementById("newOrderButton").addEventListener("click", () => {
  document.getElementById("orderForm").hidden = false;
  if (!document.getElementById("orderItems").children.length) {
    addOrderItemRow();
  }
  document.getElementById("orderForm").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("addOrderItem").addEventListener("click", addOrderItemRow);

document.getElementById("orderForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("orderMessage");
  const button = form.querySelector('button[type="submit"]');
  const items = [...document.querySelectorAll(".order-item-row")].map((row) => ({
    productId: Number(row.querySelector('[name="productId"]').value),
    quantity: Number(row.querySelector('[name="quantity"]').value)
  }));
  if (items.some((item) => !item.productId || !item.quantity) ||
      new Set(items.map((item) => item.productId)).size !== items.length) {
    showMessage(message, "Choisissez un produit différent pour chaque ligne.", true);
    return;
  }
  button.disabled = true;
  showMessage(message, "");
  try {
    await apiRequest("/api/orders", "POST", {
      items,
      notes: form.elements.notes.value
    });
    form.reset();
    document.getElementById("orderItems").replaceChildren();
    form.hidden = true;
    await loadOrders();
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("productMessage");
  const button = document.getElementById("saveProductButton");
  const productId = form.elements.productId.value;
  const priceText = form.elements.price.value;
  if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) {
    showMessage(message, "Saisissez un prix avec au maximum deux décimales.", true);
    return;
  }
  const [wholeDollars, cents = ""] = priceText.split(".");
  const priceCents = Number(wholeDollars) * 100 + Number(cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(priceCents) || priceCents > 2147483647) {
    showMessage(message, "Saisissez un prix valide en dollars canadiens.", true);
    return;
  }
  const body = {
    name: form.elements.name.value,
    description: form.elements.description.value,
    priceCents,
    isActive: form.elements.isActive.checked
  };
  if (currentUser.role === "admin") {
    body.departmentId = Number(form.elements.departmentId.value);
    body.supplierName = form.elements.supplierName.value.trim();
  }
  button.disabled = true;
  showMessage(message, "");
  try {
    await apiRequest(
      productId ? `/api/products/${productId}` : "/api/products",
      productId ? "PATCH" : "POST",
      body
    );
    resetProductForm();
    showMessage(message, productId ? "Produit mis à jour." : "Produit ajouté au catalogue.");
    await loadProducts();
    if (currentUser.role === "admin") {
      await loadAdminPanel();
    }
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("cancelProductEdit").addEventListener("click", resetProductForm);
document.getElementById("productFilter").addEventListener("change", renderProducts);

document.getElementById("supplierForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("supplierMessage");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await apiRequest("/api/admin/suppliers", "POST", {
      name: form.elements.name.value,
      contactName: form.elements.contactName.value,
      email: form.elements.email.value,
      phone: form.elements.phone.value
    });
    form.reset();
    showMessage(message, "Fournisseur ajouté.");
    await loadAdminPanel();
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("departmentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("departmentMessage");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await apiRequest("/api/admin/departments", "POST", { name: form.elements.name.value });
    form.reset();
    showMessage(message, "Département ajouté.");
    await Promise.all([loadAdminPanel(), loadDashboard()]);
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("invitationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("invitationMessage");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await apiRequest("/api/admin/invitations", "POST", {
      fullName: form.elements.fullName.value,
      email: form.elements.email.value,
      departmentId: Number(form.elements.departmentId.value)
    });
    showMessage(message, result.message);
    form.reset();
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("logoutButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await apiRequest("/api/auth/logout", "POST");
    window.location.assign("/login.html");
  } catch (error) {
    document.getElementById("accountInfo").textContent = error.message;
    button.disabled = false;
  }
});

function kpiTile(label, value, detail, detailIsOver = false) {
  const tile = document.createElement("div");
  tile.className = "kpi";
  const labelElement = document.createElement("p");
  labelElement.className = "kpi-label";
  labelElement.textContent = label;
  const valueElement = document.createElement("p");
  valueElement.className = "kpi-value";
  valueElement.textContent = value;
  tile.append(labelElement, valueElement);
  if (detail) {
    const detailElement = document.createElement("p");
    detailElement.className = `kpi-detail${detailIsOver ? " over" : ""}`;
    detailElement.textContent = detail;
    tile.append(detailElement);
  }
  return tile;
}

function percent(part, whole) {
  return `${Math.round((part / whole) * 100)} %`;
}

function renderKpis(dashboard) {
  const budgeted = dashboard.departments.filter((department) => department.budgetCents !== null);
  const budgetCents = budgeted.reduce((sum, department) => sum + department.budgetCents, 0);
  const approvedCents = dashboard.departments.reduce((sum, department) => sum + department.approvedCents, 0);
  const pendingCents = dashboard.departments.reduce((sum, department) => sum + department.pendingCents, 0);
  const budgetedSpent = budgeted.reduce((sum, department) => sum + department.approvedCents, 0);
  const remainingCents = budgetCents - budgetedSpent;
  const pendingOrders = dashboard.orderCounts.pending || 0;
  const totalOrders = Object.values(dashboard.orderCounts).reduce((sum, count) => sum + count, 0);

  document.getElementById("kpiRow").replaceChildren(
    kpiTile(
      "Budget total",
      budgetCents ? money(budgetCents) : "—",
      `${budgeted.length} / ${dashboard.departments.length} départements avec budget`
    ),
    kpiTile(
      "Coût total des achats",
      money(approvedCents),
      budgetCents ? `${percent(budgetedSpent, budgetCents)} du budget utilisé` : "Demandes approuvées"
    ),
    kpiTile(
      "En attente d’approbation",
      money(pendingCents),
      `${pendingOrders} demande${pendingOrders > 1 ? "s" : ""} à traiter`
    ),
    kpiTile(
      "Budget restant",
      budgetCents ? money(remainingCents) : "—",
      remainingCents < 0 ? "Budget dépassé" : `${totalOrders} demande${totalOrders > 1 ? "s" : ""} cette année`,
      remainingCents < 0
    )
  );
}

function usageCell(department) {
  const cell = document.createElement("td");
  const usage = document.createElement("div");
  usage.className = "usage";
  const bar = document.createElement("div");
  bar.className = "usage-bar";
  const label = document.createElement("span");
  label.className = "usage-label";
  if (department.budgetCents) {
    const over = department.approvedCents > department.budgetCents;
    const scale = Math.max(department.budgetCents, department.approvedCents + department.pendingCents);
    const spent = document.createElement("span");
    spent.className = "usage-spent";
    spent.style.width = `${(department.approvedCents / scale) * 100}%`;
    const pending = document.createElement("span");
    pending.className = "usage-pending";
    pending.style.width = `${(department.pendingCents / scale) * 100}%`;
    bar.append(spent, pending);
    bar.classList.toggle("over", over);
    bar.title = `${department.name} · dépensé ${money(department.approvedCents)} · en attente ${money(department.pendingCents)} · budget ${money(department.budgetCents)}`;
    label.textContent = over
      ? `${percent(department.approvedCents, department.budgetCents)} · dépassé`
      : percent(department.approvedCents, department.budgetCents);
    label.classList.toggle("over", over);
  } else {
    label.textContent = "Aucun budget";
  }
  usage.append(bar, label);
  cell.append(usage);
  return cell;
}

function budgetEditCell(department) {
  const cell = document.createElement("td");
  const form = document.createElement("form");
  form.className = "budget-edit";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "0.01";
  input.placeholder = "Aucun";
  input.value = department.budgetCents === null ? "" : (department.budgetCents / 100).toFixed(2);
  input.setAttribute("aria-label", `Budget annuel de ${department.name} (CAD)`);
  const save = document.createElement("button");
  save.className = "button button-secondary";
  save.type = "submit";
  save.textContent = "Enregistrer";
  form.append(input, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.getElementById("budgetMessage");
    const text = input.value.trim();
    if (text && !/^\d+(?:\.\d{1,2})?$/.test(text)) {
      showMessage(message, "Saisissez un budget avec au maximum deux décimales.", true);
      return;
    }
    const [whole, cents = ""] = text.split(".");
    const budgetCents = text ? Number(whole) * 100 + Number(cents.padEnd(2, "0")) : null;
    save.disabled = true;
    try {
      await apiRequest(`/api/admin/departments/${department.id}/budget`, "PATCH", { budgetCents });
      showMessage(message, `Budget de ${department.name} enregistré.`);
      await loadDashboard();
    } catch (error) {
      showMessage(message, error.message, true);
      save.disabled = false;
    }
  });
  cell.append(form);
  return cell;
}

function renderBudgetRows(dashboard) {
  const body = document.getElementById("budgetRows");
  body.replaceChildren();
  if (!dashboard.departments.length) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 6;
    cell.className = "muted";
    cell.textContent = "Aucun département. Créez-en un dans l’onglet Administration.";
    return;
  }
  dashboard.departments.forEach((department) => {
    const row = document.createElement("tr");
    const name = document.createElement("th");
    name.scope = "row";
    name.textContent = department.name;
    const amount = (cents, isNegative = false) => {
      const cell = document.createElement("td");
      cell.className = `num${isNegative ? " negative" : ""}`;
      cell.textContent = cents === null ? "—" : money(cents);
      return cell;
    };
    const remaining = department.budgetCents === null
      ? null
      : department.budgetCents - department.approvedCents;
    row.append(
      name,
      budgetEditCell(department),
      amount(department.approvedCents),
      amount(department.pendingCents),
      amount(remaining, remaining !== null && remaining < 0),
      usageCell(department)
    );
    body.append(row);
  });
}

function renderSupplierBars(dashboard) {
  const container = document.getElementById("supplierBars");
  container.replaceChildren();
  if (!dashboard.suppliers.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucun achat approuvé pour cette année.";
    container.append(empty);
    return;
  }
  const max = Math.max(...dashboard.suppliers.map((supplier) => supplier.approvedCents));
  dashboard.suppliers.forEach((supplier) => {
    const row = document.createElement("div");
    row.className = "supplier-bar";
    const name = document.createElement("span");
    name.textContent = supplier.name || "Sans fournisseur";
    const track = document.createElement("div");
    track.className = "supplier-bar-track";
    const fill = document.createElement("div");
    fill.className = "supplier-bar-fill";
    fill.style.width = `${max ? (supplier.approvedCents / max) * 100 : 0}%`;
    fill.title = `${name.textContent} · ${money(supplier.approvedCents)}`;
    track.append(fill);
    const value = document.createElement("span");
    value.className = "supplier-bar-value";
    value.textContent = money(supplier.approvedCents);
    row.append(name, track, value);
    container.append(row);
  });
}

async function loadDashboard() {
  const year = document.getElementById("dashboardYear").value || new Date().getFullYear();
  const dashboard = await apiRequest(`/api/admin/dashboard?year=${encodeURIComponent(year)}`);
  renderKpis(dashboard);
  renderBudgetRows(dashboard);
  renderSupplierBars(dashboard);
}

function setupDashboard() {
  const select = document.getElementById("dashboardYear");
  const currentYear = new Date().getFullYear();
  for (let year = currentYear; year >= currentYear - 3; year -= 1) {
    select.add(new Option(String(year), String(year)));
  }
  select.addEventListener("change", () => {
    loadDashboard().catch((error) => showMessage(document.getElementById("budgetMessage"), error.message, true));
  });
  document.getElementById("homeTab").hidden = false;
  document.getElementById("homeTab").click();
}

async function initialize() {
  const health = document.getElementById("status");
  try {
    const healthResponse = await fetch("/api/health");
    if (!healthResponse.ok) {
      throw new Error("Le serveur ne répond pas.");
    }
    const healthData = await healthResponse.json();
    health.textContent = `Serveur connecté · ${healthData.status}`;
  } catch {
    health.textContent = "Le serveur ne répond pas.";
  }

  try {
    const { user } = await apiRequest("/api/auth/me");
    currentUser = user;
    document.getElementById("accountInfo").textContent =
      `${user.email} · ${roleNames[user.role] || user.role}`;
    if (user.role === "department_manager") {
      document.getElementById("newOrderButton").hidden = false;
    } else if (user.role === "admin") {
      document.getElementById("adminTab").hidden = false;
      document.getElementById("productDepartmentField").hidden = false;
      document.getElementById("productDepartment").required = true;
      document.getElementById("productFilterField").hidden = false;
    }
    await Promise.all([loadProducts(), loadOrders()]);
    if (user.role === "admin") {
      setupDashboard();
      await Promise.all([loadAdminPanel(), loadDashboard()]);
    }
  } catch (error) {
    if (error.message === "Authentification requise.") {
      window.location.assign("/login.html");
      return;
    }
    document.getElementById("accountInfo").textContent = error.message;
    showMessage(
      document.getElementById("orderList").firstElementChild || document.getElementById("orderList"),
      error.message,
      true
    );
  }
}

initialize();
