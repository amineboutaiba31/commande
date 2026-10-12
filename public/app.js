const roleNames = {
  developer: "Développeur",
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
    if (response.status === 401 || response.status === 403) {
      await reloadIfAccountChanged();
    }
    throw new Error(data.error || "La requête a échoué.");
  }
  return data;
}

// All tabs of a browser share one login. If someone signed in with another account in another
// tab, this tab still shows the old account: warn and reload so it shows who is really signed in.
async function reloadIfAccountChanged() {
  if (!currentUser) {
    return;
  }
  let signedIn = null;
  try {
    const response = await fetch("/api/auth/me");
    signedIn = response.ok ? (await response.json()).user : null;
  } catch {
    return;
  }
  if (signedIn?.id === currentUser.id) {
    return;
  }
  window.alert(signedIn
    ? `Ce navigateur est maintenant connecté avec un autre compte (${signedIn.email}). La page va se recharger.\n\nPour utiliser deux comptes en même temps, ouvrez le deuxième dans une fenêtre de navigation privée (Ctrl+Maj+N).`
    : "Vous avez été déconnecté. La page va se recharger.");
  window.location.reload();
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
  renderAdminTables();
  const list = document.getElementById("productList");
  list.replaceChildren();
  const isAdmin = currentUser?.role === "admin";
  const filterSelect = document.getElementById("productFilter");
  // Show each department's product count in the admin's department list.
  [...filterSelect.options].forEach((option) => {
    const department = departments.find((candidate) => String(candidate.id) === option.value);
    if (department) {
      const count = products.filter((product) => product.department_id === department.id).length;
      option.textContent = `${department.name} (${count})`;
    }
  });
  const filter = filterSelect.value;
  if (isAdmin && !filter) {
    const prompt = document.createElement("p");
    prompt.className = "muted";
    prompt.textContent = "Choisissez un département dans la liste ci-dessus pour afficher ses produits.";
    list.append(prompt);
    return;
  }
  const visible = filter
    ? products.filter((product) => product.department_id === Number(filter))
    : products;
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucun produit pour ce département. Ajoutez le premier produit ci-dessus.";
    list.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "budget-table product-table";
  const header = table.createTHead().insertRow();
  ["Produit", "Description", "Fournisseur", "Prix", "État", ""].forEach((label, index) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    if (index === 3) {
      cell.className = "num";
    }
    header.append(cell);
  });
  const body = table.createTBody();

  visible.forEach((product) => {
    const row = body.insertRow();
    row.insertCell().textContent = product.name;
    const description = row.insertCell();
    description.className = "muted";
    description.textContent = product.description || "—";
    row.insertCell().textContent = product.supplier_name || "—";
    const price = row.insertCell();
    price.className = "num";
    price.textContent = money(product.price_cents);
    const availability = document.createElement("span");
    availability.className = `availability ${product.is_active ? "active" : "inactive"}`;
    availability.textContent = product.is_active ? "Disponible" : "Inactif";
    row.insertCell().append(availability);

    const actions = document.createElement("div");
    actions.className = "product-actions";
    row.insertCell().append(actions);
    const edit = document.createElement("button");
    edit.className = "button button-secondary button-small";
    edit.type = "button";
    edit.textContent = "Modifier";
    edit.addEventListener("click", () => beginProductEdit(product));
    actions.append(edit);
    if (currentUser.role === "admin") {
      const remove = document.createElement("button");
      remove.className = "button button-danger button-small";
      remove.type = "button";
      remove.textContent = "Supprimer";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Supprimer « ${product.name} » du catalogue ? Les commandes passées restent dans l’historique.`)) {
          return;
        }
        remove.disabled = true;
        try {
          await apiRequest(`/api/products/${product.id}`, "DELETE");
          await loadProducts();
        } catch (error) {
          window.alert(error.message);
          remove.disabled = false;
        }
      });
      actions.append(remove);
    }
  });
  list.append(table);
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

function renderOrders(list, orders, emptyMessage) {
  list.replaceChildren();
  if (!orders.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = emptyMessage;
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
  renderOrderLists(result.orders);
}

let lastOrderSignature = "";

function orderSignature(orders) {
  return orders.map((order) => `${order.id}:${order.status}`).join(",");
}

function renderOrderLists(orders) {
  // Pending requests stay under "Commandes"; approved and rejected ones are only in the
  // "Historique" table and its CSV export.
  renderOrders(
    document.getElementById("orderList"),
    orders.filter((order) => order.status === "pending"),
    currentUser.role === "admin" ? "Aucune demande en attente." : "Vous n’avez aucune demande en attente."
  );
  lastOrderSignature = orderSignature(orders);
  historyOrders = orders.filter((order) => order.status !== "pending");
  if (!document.getElementById("historyPreview").hidden) {
    renderHistoryPreview();
  }
  updateNotifications(orders);
}

// --- History export ------------------------------------------------------

let historyOrders = [];

const HISTORY_COLUMNS = [
  "N° demande", "Date de la demande", "Département", "Responsable", "Courriel", "Produit",
  "Quantité", "Prix unitaire", "Sous-total", "Total de la demande", "Statut", "Décidé par",
  "Date de décision", "Note de la demande", "Note de décision"
];

function csvDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// French Excel expects a comma as the decimal separator.
const csvAmount = (cents) => (cents / 100).toFixed(2).replace(".", ",");

// One row per ordered product, rebuilt from the latest history every time.
function historyRows() {
  return historyOrders.flatMap((order) => order.items.map((item) => [
    order.id,
    csvDate(order.createdAt),
    order.departmentName,
    order.createdByName || "",
    order.createdByEmail,
    item.productName,
    item.quantity,
    csvAmount(item.priceCents),
    csvAmount(item.priceCents * item.quantity),
    csvAmount(order.totalCents),
    statusNames[order.status] || order.status,
    order.decidedByEmail || "",
    csvDate(order.decidedAt),
    order.notes || "",
    order.decisionNote || ""
  ]));
}

function renderHistoryPreview() {
  const container = document.getElementById("historyPreview");
  container.replaceChildren();
  const rows = historyRows();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "L’historique est vide.";
    container.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "budget-table history-table";
  const header = table.createTHead().insertRow();
  HISTORY_COLUMNS.forEach((label) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    header.append(cell);
  });
  const body = table.createTBody();
  rows.forEach((values) => {
    const row = body.insertRow();
    values.forEach((value) => {
      row.insertCell().textContent = value;
    });
  });
  container.append(table);
}

document.getElementById("historyPreviewButton").addEventListener("click", (event) => {
  const preview = document.getElementById("historyPreview");
  preview.hidden = !preview.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!preview.hidden));
  event.currentTarget.textContent = preview.hidden ? "Visualiser" : "Masquer l’aperçu";
  if (!preview.hidden) {
    renderHistoryPreview();
  }
});

document.getElementById("historyDownloadButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    // Fetch first so the file always contains the latest decisions.
    renderOrderLists((await apiRequest("/api/orders")).orders);
    const escape = (value) => {
      const text = String(value);
      return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [HISTORY_COLUMNS, ...historyRows()]
      .map((row) => row.map(escape).join(";"))
      .join("\r\n");
    // The byte-order mark makes Excel read the accents correctly.
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `historique-commandes-${csvDate(new Date()).slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
  }
});

// Checks for new orders (admin) or decisions (employee) without disturbing a decision being typed.
async function refreshOrders() {
  try {
    const { orders } = await apiRequest("/api/orders");
    if (orderSignature(orders) === lastOrderSignature) {
      return;
    }
    if (document.activeElement?.closest?.("#orderList, #orderForm")) {
      updateNotifications(orders);
      return;
    }
    renderOrderLists(orders);
    if (currentUser.role === "admin") {
      await loadDashboard();
    }
  } catch {
    // A failed background check is retried on the next interval.
  }
}

// --- Notification bell ---------------------------------------------------

const NOTIFICATION_POLL_MS = 30000;
let knownOrderStatuses = null;

function seenDecisionsKey() {
  return `promographe.seenDecisions.${currentUser.id}`;
}

// Per-browser memory of which decisions an employee has already seen.
function readSeenDecisions() {
  try {
    const stored = window.localStorage.getItem(seenDecisionsKey());
    return stored === null ? null : new Set(JSON.parse(stored));
  } catch {
    return null;
  }
}

function writeSeenDecisions(ids) {
  try {
    window.localStorage.setItem(seenDecisionsKey(), JSON.stringify([...ids]));
  } catch {
    // Storage unavailable (private mode): the badge simply resets on reload.
  }
}

let sessionSeenDecisions = new Set();

function seenDecisions(orders) {
  let seen = readSeenDecisions();
  if (seen === null) {
    // First visit in this browser: past decisions are not news.
    seen = new Set(orders.filter((order) => order.status !== "pending").map((order) => order.id));
    writeSeenDecisions(seen);
  }
  sessionSeenDecisions.forEach((id) => seen.add(id));
  return seen;
}

function playNotificationSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    [880, 1320].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * 0.18;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.4);
    });
    setTimeout(() => context.close(), 1000);
  } catch {
    // Sound is a bonus; browsers may block it until the page has been clicked.
  }
}

let currentNotifications = [];

function updateNotifications(orders) {
  const isAdmin = currentUser.role === "admin";
  if (knownOrderStatuses) {
    const arrived = isAdmin
      ? orders.some((order) => order.status === "pending" && !knownOrderStatuses.has(order.id))
      : orders.some((order) => order.status !== "pending" && knownOrderStatuses.get(order.id) === "pending");
    if (arrived) {
      playNotificationSound();
    }
  }
  knownOrderStatuses = new Map(orders.map((order) => [order.id, order.status]));

  if (isAdmin) {
    currentNotifications = orders.filter((order) => order.status === "pending").map((order) => ({
      id: order.id,
      text: `Demande n° ${order.id} en attente · ${order.departmentName}`,
      detail: `${order.createdByName || order.createdByEmail} · ${money(order.totalCents)}`,
      panel: "ordersPanel"
    }));
  } else {
    const seen = seenDecisions(orders);
    currentNotifications = orders
      .filter((order) => order.status !== "pending" && !seen.has(order.id))
      .map((order) => ({
        id: order.id,
        text: `Votre demande n° ${order.id} a été ${order.status === "approved" ? "approuvée" : "refusée"}`,
        detail: order.decisionNote ? `Note : ${order.decisionNote}` : money(order.totalCents),
        panel: "historyPanel"
      }));
  }
  renderNotifications();
}

function renderNotifications() {
  const badge = document.getElementById("notificationBadge");
  badge.hidden = !currentNotifications.length;
  badge.textContent = currentNotifications.length > 99 ? "99+" : String(currentNotifications.length);

  const list = document.getElementById("notificationList");
  list.replaceChildren();
  if (!currentNotifications.length) {
    const empty = document.createElement("li");
    empty.className = "notification-empty";
    empty.textContent = currentUser.role === "admin"
      ? "Aucune demande en attente."
      : "Aucune nouvelle réponse à vos demandes.";
    list.append(empty);
    return;
  }
  currentNotifications.forEach((notification) => {
    const item = document.createElement("li");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "notification-item";
    const text = document.createElement("strong");
    text.textContent = notification.text;
    const detail = document.createElement("span");
    detail.textContent = notification.detail;
    link.append(text, detail);
    link.addEventListener("click", () => {
      closeNotificationPanel();
      document.querySelector(`.tab[data-panel="${notification.panel}"]`)?.click();
    });
    item.append(link);
    list.append(item);
  });
}

function closeNotificationPanel() {
  document.getElementById("notificationPanel").hidden = true;
  document.getElementById("notificationButton").setAttribute("aria-expanded", "false");
}

document.getElementById("notificationButton").addEventListener("click", (event) => {
  event.stopPropagation();
  const panel = document.getElementById("notificationPanel");
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden && currentUser.role !== "admin" && currentNotifications.length) {
    // Opening the bell marks the employee's decisions as read; the list stays until it closes.
    currentNotifications.forEach((notification) => sessionSeenDecisions.add(notification.id));
    const seen = readSeenDecisions() || new Set();
    sessionSeenDecisions.forEach((id) => seen.add(id));
    writeSeenDecisions(seen);
    document.getElementById("notificationBadge").hidden = true;
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".notifications")) {
    closeNotificationPanel();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeNotificationPanel();
  }
});

// Product counts change with the catalogue, so the admin tables are redrawn with it.
function renderAdminTables() {
  if (currentUser?.role !== "admin") {
    return;
  }
  renderManagerTable();
  renderDepartmentTable();
  renderSupplierTable();
}

function fillDepartmentSelect(select, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  departments.forEach((department) => {
    select.add(new Option(department.name, department.id));
  });
  select.value = previous;
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
  adminUsers = usersResult.users;
  adminSuppliers = suppliersResult.suppliers;
  fillDepartmentSelect(document.getElementById("departmentId"), "Choisir un département");
  fillDepartmentSelect(document.getElementById("productDepartment"), "Choisir un département");
  fillDepartmentSelect(document.getElementById("productFilter"), "Choisir un département");
  document.getElementById("supplierOptions").replaceChildren(
    ...adminSuppliers.map((supplier) => new Option(supplier.name))
  );
  renderProducts();
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
    if (currentUser.role === "admin") {
      // Show the table of the department the product was saved in.
      document.getElementById("productFilter").value = String(body.departmentId);
    }
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

// --- Administration: left menu, tables, add / edit / delete --------------

let adminUsers = [];
let adminSuppliers = [];

document.querySelectorAll(".admin-menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".admin-menu-item").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === item);
    });
    document.querySelectorAll(".admin-section").forEach((section) => {
      section.hidden = section.id !== item.dataset.adminSection;
    });
  });
});

function buildTable(columns, rows, emptyText) {
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = emptyText;
    return empty;
  }
  const table = document.createElement("table");
  table.className = "budget-table admin-table";
  const header = table.createTHead().insertRow();
  columns.forEach((label) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    header.append(cell);
  });
  const body = table.createTBody();
  rows.forEach((values) => {
    const row = body.insertRow();
    values.forEach((value) => {
      const cell = row.insertCell();
      cell.append(value instanceof Node ? value : document.createTextNode(value ?? ""));
    });
  });
  return table;
}

function rowActions(onEdit, onDelete) {
  const actions = document.createElement("div");
  actions.className = "product-actions";
  const edit = document.createElement("button");
  edit.className = "button button-secondary button-small";
  edit.type = "button";
  edit.textContent = "Modifier";
  edit.addEventListener("click", onEdit);
  const remove = document.createElement("button");
  remove.className = "button button-danger button-small";
  remove.type = "button";
  remove.textContent = "Supprimer";
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      await onDelete();
    } finally {
      remove.disabled = false;
    }
  });
  actions.append(edit, remove);
  return actions;
}

function openAdminForm(formId, title, submitLabel) {
  const form = document.getElementById(formId);
  form.hidden = false;
  form.querySelector("h4").textContent = title;
  form.querySelector('button[type="submit"]').textContent = submitLabel;
  form.querySelector('input:not([type="hidden"]):not(:disabled)')?.focus();
  return form;
}

function closeAdminForm(form) {
  form.reset();
  form.querySelectorAll('input[type="hidden"]').forEach((input) => {
    input.value = "";
  });
  form.hidden = true;
}

document.querySelectorAll(".admin-form [data-cancel]").forEach((button) => {
  button.addEventListener("click", () => closeAdminForm(button.closest("form")));
});

// Runs an admin action and reports the outcome under the section's form.
async function runAdminAction(messageId, action, successText) {
  const message = document.getElementById(messageId);
  try {
    await action();
    showMessage(message, successText);
    return true;
  } catch (error) {
    showMessage(message, error.message, true);
    return false;
  }
}

// Développeur: the company's administrators

async function loadDeveloperAdmins() {
  const { admins } = await apiRequest("/api/developer/admins");
  const inviteAdmin = (fullName, email) => apiRequest("/api/developer/admins", "POST", { fullName, email });
  const rows = admins.map((admin) => {
    const status = document.createElement("span");
    status.className = `availability ${admin.is_active ? "active" : "inactive"}`;
    status.textContent = admin.is_active ? "Actif" : "Invitation en attente";
    const actions = document.createElement("div");
    actions.className = "product-actions";
    if (!admin.is_active) {
      const resend = document.createElement("button");
      resend.className = "button button-secondary button-small";
      resend.type = "button";
      resend.textContent = "Renvoyer l’invitation";
      resend.addEventListener("click", async () => {
        resend.disabled = true;
        await runAdminAction("adminInvitationMessage", () => inviteAdmin(admin.full_name || admin.email, admin.email), "Invitation renvoyée.");
        resend.disabled = false;
      });
      actions.append(resend);
    }
    const remove = document.createElement("button");
    remove.className = "button button-danger button-small";
    remove.type = "button";
    remove.textContent = "Supprimer";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Retirer l’accès de l’administrateur « ${admin.full_name || admin.email} » ? Il ne pourra plus se connecter.`)) {
        return;
      }
      remove.disabled = true;
      if (await runAdminAction("adminInvitationMessage", () => apiRequest(`/api/developer/admins/${admin.id}`, "DELETE"), "Administrateur supprimé.")) {
        await loadDeveloperAdmins();
      }
      remove.disabled = false;
    });
    actions.append(remove);
    return [admin.full_name || "—", admin.email, status, actions];
  });
  document.getElementById("adminTable").replaceChildren(buildTable(
    ["Nom", "Courriel", "Statut", ""],
    rows,
    "Aucun administrateur. Cliquez sur « Inviter un administrateur »."
  ));
}

document.getElementById("addAdminButton").addEventListener("click", () => {
  const form = document.getElementById("adminInvitationForm");
  form.reset();
  form.hidden = false;
  form.elements.fullName.focus();
});

document.getElementById("adminInvitationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const done = await runAdminAction("adminInvitationMessage", () => apiRequest("/api/developer/admins", "POST", {
    fullName: form.elements.fullName.value,
    email: form.elements.email.value
  }), "Invitation envoyée. L’administrateur va recevoir un courriel pour choisir son mot de passe.");
  button.disabled = false;
  if (done) {
    closeAdminForm(form);
    await loadDeveloperAdmins();
  }
});

// Responsables

function renderManagerTable() {
  const managers = adminUsers.filter((user) => user.role === "department_manager");
  const rows = managers.map((user) => {
    const department = departments.find((candidate) => candidate.id === Number(user.department_id));
    const status = document.createElement("span");
    status.className = `availability ${user.is_active ? "active" : "inactive"}`;
    status.textContent = user.is_active ? "Actif" : "Invitation en attente";
    return [
      user.full_name || "—",
      user.email,
      department ? department.name : "—",
      status,
      rowActions(
        () => {
          const form = openAdminForm("invitationForm", "Modifier le responsable", "Enregistrer");
          form.elements.userId.value = user.id;
          form.elements.fullName.value = user.full_name || "";
          form.elements.email.value = user.email;
          form.elements.email.disabled = true;
          form.elements.departmentId.value = String(user.department_id);
        },
        async () => {
          if (!window.confirm(`Supprimer le responsable « ${user.full_name || user.email} » ? Il ne pourra plus se connecter. Ses commandes restent dans l’historique.`)) {
            return;
          }
          if (await runAdminAction("invitationMessage", () => apiRequest(`/api/admin/users/${user.id}`, "DELETE"), "Responsable supprimé.")) {
            await loadAdminPanel();
          }
        }
      )
    ];
  });
  document.getElementById("managerTable").replaceChildren(buildTable(
    ["Nom", "Courriel", "Département", "Statut", ""],
    rows,
    "Aucun responsable. Cliquez sur « Ajouter un responsable » pour en inviter un."
  ));
}

document.getElementById("addManagerButton").addEventListener("click", () => {
  const form = document.getElementById("invitationForm");
  closeAdminForm(form);
  form.elements.email.disabled = false;
  openAdminForm("invitationForm", "Inviter un responsable", "Envoyer l’invitation");
});

document.getElementById("invitationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const userId = form.elements.userId.value;
  const fullName = form.elements.fullName.value;
  const departmentId = Number(form.elements.departmentId.value);
  button.disabled = true;
  const done = await runAdminAction("invitationMessage", () => (userId
    ? apiRequest(`/api/admin/users/${userId}`, "PATCH", { fullName, departmentId })
    : apiRequest("/api/admin/invitations", "POST", { fullName, email: form.elements.email.value, departmentId })
  ), userId ? "Responsable modifié." : "Invitation envoyée.");
  button.disabled = false;
  if (done) {
    form.elements.email.disabled = false;
    closeAdminForm(form);
    await loadAdminPanel();
  }
});

// Départements

function renderDepartmentTable() {
  const rows = departments.map((department) => {
    const productCount = products.filter((product) => product.department_id === department.id).length;
    const managerCount = adminUsers.filter((user) => Number(user.department_id) === department.id).length;
    return [
      department.name,
      String(productCount),
      String(managerCount),
      rowActions(
        () => {
          const form = openAdminForm("departmentForm", "Modifier le département", "Enregistrer");
          form.elements.departmentId.value = department.id;
          form.elements.name.value = department.name;
        },
        async () => {
          if (!window.confirm(`Supprimer le département « ${department.name} » et ses ${productCount} produits ? Les commandes passées restent dans l’historique.`)) {
            return;
          }
          if (await runAdminAction("departmentMessage", () => apiRequest(`/api/admin/departments/${department.id}`, "DELETE"), "Département supprimé.")) {
            await Promise.all([loadAdminPanel(), loadProducts(), loadDashboard()]);
          }
        }
      )
    ];
  });
  document.getElementById("departmentTable").replaceChildren(buildTable(
    ["Département", "Produits", "Responsables", ""],
    rows,
    "Aucun département. Cliquez sur « Ajouter un département » pour en créer un."
  ));
}

document.getElementById("addDepartmentButton").addEventListener("click", () => {
  closeAdminForm(document.getElementById("departmentForm"));
  openAdminForm("departmentForm", "Ajouter un département", "Ajouter");
});

document.getElementById("departmentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const departmentId = form.elements.departmentId.value;
  const name = form.elements.name.value;
  button.disabled = true;
  const done = await runAdminAction("departmentMessage", () => (departmentId
    ? apiRequest(`/api/admin/departments/${departmentId}`, "PATCH", { name })
    : apiRequest("/api/admin/departments", "POST", { name })
  ), departmentId ? "Département modifié." : "Département ajouté.");
  button.disabled = false;
  if (done) {
    closeAdminForm(form);
    await Promise.all([loadAdminPanel(), loadProducts(), loadDashboard()]);
  }
});

// Fournisseurs

function renderSupplierTable() {
  const rows = adminSuppliers.map((supplier) => {
    const productCount = products.filter((product) => product.supplier_id === supplier.id).length;
    return [
      supplier.name,
      supplier.contact_name || "—",
      supplier.email || "—",
      supplier.phone || "—",
      String(productCount),
      rowActions(
        () => {
          const form = openAdminForm("supplierForm", "Modifier le fournisseur", "Enregistrer");
          form.elements.supplierId.value = supplier.id;
          form.elements.name.value = supplier.name;
          form.elements.contactName.value = supplier.contact_name || "";
          form.elements.email.value = supplier.email || "";
          form.elements.phone.value = supplier.phone || "";
        },
        async () => {
          if (!window.confirm(`Supprimer le fournisseur « ${supplier.name} » ? Ses produits resteront au catalogue, sans fournisseur.`)) {
            return;
          }
          if (await runAdminAction("supplierMessage", () => apiRequest(`/api/admin/suppliers/${supplier.id}`, "DELETE"), "Fournisseur supprimé.")) {
            await Promise.all([loadAdminPanel(), loadProducts()]);
          }
        }
      )
    ];
  });
  document.getElementById("supplierTable").replaceChildren(buildTable(
    ["Fournisseur", "Contact", "Courriel", "Téléphone", "Produits", ""],
    rows,
    "Aucun fournisseur. Cliquez sur « Ajouter un fournisseur » pour en créer un."
  ));
}

document.getElementById("addSupplierButton").addEventListener("click", () => {
  closeAdminForm(document.getElementById("supplierForm"));
  openAdminForm("supplierForm", "Ajouter un fournisseur", "Ajouter");
});

document.getElementById("supplierForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const supplierId = form.elements.supplierId.value;
  const body = {
    name: form.elements.name.value,
    contactName: form.elements.contactName.value,
    email: form.elements.email.value,
    phone: form.elements.phone.value
  };
  button.disabled = true;
  const done = await runAdminAction("supplierMessage", () => (supplierId
    ? apiRequest(`/api/admin/suppliers/${supplierId}`, "PATCH", body)
    : apiRequest("/api/admin/suppliers", "POST", body)
  ), supplierId ? "Fournisseur modifié." : "Fournisseur ajouté.");
  button.disabled = false;
  if (done) {
    closeAdminForm(form);
    await Promise.all([loadAdminPanel(), loadProducts()]);
  }
});

const profileDialog = document.getElementById("profileDialog");

function showAccountName() {
  document.getElementById("accountInfo").textContent = currentUser.fullName || currentUser.email;
}

document.getElementById("profileButton").addEventListener("click", () => {
  const form = document.getElementById("profileForm");
  form.elements.fullName.value = currentUser.fullName || "";
  document.getElementById("profileEmail").textContent = currentUser.email;
  document.getElementById("profileRole").textContent = roleNames[currentUser.role] || currentUser.role;
  const hasDepartment = Boolean(currentUser.departmentName);
  document.getElementById("profileDepartmentLabel").hidden = !hasDepartment;
  document.getElementById("profileDepartment").hidden = !hasDepartment;
  document.getElementById("profileDepartment").textContent = currentUser.departmentName || "";
  showMessage(document.getElementById("profileMessage"), "");
  profileDialog.showModal();
});

document.getElementById("closeProfileDialog").addEventListener("click", () => profileDialog.close());

document.getElementById("profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("profileMessage");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { fullName } = await apiRequest("/api/auth/profile", "PATCH", { fullName: form.elements.fullName.value });
    currentUser.fullName = fullName;
    showAccountName();
    showMessage(message, "Profil enregistré.");
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

const passwordDialog = document.getElementById("passwordDialog");

document.getElementById("passwordButton").addEventListener("click", () => {
  profileDialog.close();
  document.getElementById("passwordForm").reset();
  showMessage(document.getElementById("passwordMessage"), "");
  passwordDialog.showModal();
});

document.getElementById("closePasswordDialog").addEventListener("click", () => passwordDialog.close());

document.getElementById("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("passwordMessage");
  const button = form.querySelector('button[type="submit"]');
  if (form.elements.newPassword.value !== form.elements.newPasswordConfirmation.value) {
    showMessage(message, "Les deux nouveaux mots de passe ne correspondent pas.", true);
    return;
  }
  button.disabled = true;
  try {
    await apiRequest("/api/auth/change-password", "POST", {
      currentPassword: form.elements.currentPassword.value,
      newPassword: form.elements.newPassword.value
    });
    form.reset();
    showMessage(message, "Mot de passe changé. Vos autres sessions ont été déconnectées.");
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

async function loadDashboard() {
  const year = document.getElementById("dashboardYear").value || new Date().getFullYear();
  const dashboard = await apiRequest(`/api/admin/dashboard?year=${encodeURIComponent(year)}`);
  renderKpis(dashboard);
  renderBudgetRows(dashboard);
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
    showAccountName();
    if (user.role === "developer") {
      // The developer only sees the company's administrators.
      document.querySelector(".tabs").hidden = true;
      document.querySelector(".notifications").hidden = true;
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.hidden = panel.id !== "developerPanel";
      });
      await loadDeveloperAdmins();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          reloadIfAccountChanged();
        }
      });
      return;
    }
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
    setInterval(async () => {
      await reloadIfAccountChanged();
      refreshOrders();
    }, NOTIFICATION_POLL_MS);
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        await reloadIfAccountChanged();
        refreshOrders();
      }
    });
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
