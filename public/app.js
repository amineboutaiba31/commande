const roleNames = {
  developer: "Développeur",
  admin: "Directeur",
  accountant: "Comptable",
  purchaser: "Administration",
  employee: "Employé"
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

// A plain employee (not a department responsable) never sees prices; the server does not send them.
const UNITS = {
  "unité": ["unités", "Pièces, articles à l’unité"],
  "boîte": ["boîtes", "Articles vendus à la boîte"],
  "caisse": ["caisses", "Plusieurs boîtes ou paquets"],
  "paquet": ["paquets", "Feuilles, sacs, petites fournitures"],
  "rouleau": ["rouleaux", "Rubans, films, papier"],
  "litre": ["litres", "Liquides, produits chimiques"],
  "kilogramme": ["kilogrammes", "Encres, matières en vrac"],
  "gallon": ["gallons", "Encres, solvants"],
  "cône": ["cônes", "Fil de broderie"],
  "verge": ["verges", "Films, tissus"],
  "mètre": ["mètres", "Films, tissus"],
  "ensemble": ["ensembles", "Kits et regroupements"],
  "heure": ["heures", "Services"]
};

function quantityWithUnit(quantity, unit) {
  const name = UNITS[unit] ? unit : "unité";
  return `${quantity} ${quantity > 1 ? UNITS[name][0] : name}`;
}

document.getElementById("productUnit").replaceChildren(...Object.entries(UNITS).map(([unit, [, usage]]) => (
  new Option(usage ? `${unit} (${usage.toLowerCase()})` : unit, unit)
)));

function seesPrices() {
  return !(currentUser?.role === "employee" && !(currentUser.managedDepartments || []).length);
}

// Budgets and spending: the director for every department, a responsable for theirs.
function seesBudgets() {
  return currentUser?.role === "admin" || (currentUser?.role === "employee" && (currentUser.managedDepartments || []).length > 0);
}

function money(cents) {
  return currency.format(cents / 100);
}

// A product of a request or a purchase order, with its SKU when it has one.
function withSku(productName, sku) {
  return sku ? `${productName} · SKU ${sku}` : productName;
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

// A product sold by several suppliers is one catalogue line per supplier, under the same
// name: the request shows the name once, then lets the person pick the supplier.
// The whole catalogue, grouped by department (section) in the product list.
function orderableProductsByName() {
  const byName = new Map();
  products.filter((product) => product.is_active &&
    (product.supplier_authorized !== false || currentUser.role === "admin")).forEach((product) => {
    const key = `${product.department_id}:${product.name.trim().toLocaleLowerCase("fr")}`;
    if (!byName.has(key)) {
      byName.set(key, { name: product.name.trim(), departmentName: product.department_name || "Autres", offers: [] });
    }
    byName.get(key).offers.push(product);
  });
  return byName;
}

function addOrderItemRow() {
  const row = document.createElement("div");
  row.className = "order-item-row";
  const byName = orderableProductsByName();

  const productLabel = document.createElement("label");
  productLabel.textContent = "Produit";
  // Search by name, code, supplier or section; the list below keeps only what matches.
  const search = document.createElement("input");
  search.type = "search";
  search.className = "product-search";
  search.placeholder = "Rechercher : nom, code, fournisseur…";
  search.setAttribute("aria-label", "Rechercher un produit");
  const select = document.createElement("select");
  select.name = "productName";
  select.required = true;
  const plain = (text) => String(text || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const searchText = new Map([...byName].map(([key, entry]) => [key, plain([
    entry.name, entry.departmentName, ...entry.offers.flatMap((offer) => [offer.sku, offer.description, offer.supplier_name])
  ].join(" "))]));
  const fillProducts = () => {
    const words = plain(search.value).split(/\s+/).filter(Boolean);
    const previous = select.value;
    const matches = [...byName].filter(([key]) => words.every((word) => searchText.get(key).includes(word)));
    select.replaceChildren(new Option(
      !words.length ? "Choisir un produit" : matches.length ? `${matches.length} produit${matches.length > 1 ? "s" : ""} trouvé${matches.length > 1 ? "s" : ""}` : "Aucun produit trouvé",
      ""
    ));
    const sections = new Map();
    matches.forEach(([key, entry]) => {
      if (!sections.has(entry.departmentName)) {
        const group = document.createElement("optgroup");
        group.label = entry.departmentName;
        sections.set(entry.departmentName, group);
        select.append(group);
      }
      sections.get(entry.departmentName).append(
        new Option(entry.offers.length > 1 ? `${entry.name} (${entry.offers.length} fournisseurs)` : entry.name, key)
      );
    });
    // Keeps the chosen product when it still matches; a single match is chosen for you.
    const keep = matches.some(([key]) => key === previous) ? previous : matches.length === 1 ? matches[0][0] : "";
    select.value = keep;
    if (keep !== previous) {
      select.dispatchEvent(new Event("change"));
    }
  };
  search.addEventListener("input", fillProducts);
  productLabel.append(search, select);

  // The chosen supplier decides which catalogue line (and price) is ordered.
  const supplierLabel = document.createElement("label");
  supplierLabel.textContent = "Fournisseur";
  const supplier = document.createElement("select");
  supplier.name = "productId";
  supplier.required = true;
  supplier.disabled = true;
  supplier.add(new Option("Choisir d’abord un produit", ""));
  supplierLabel.append(supplier);
  // The product list is filled once the supplier menu exists (a single match picks its supplier).
  queueMicrotask(fillProducts);
  select.addEventListener("change", () => {
    const offers = byName.get(select.value)?.offers || [];
    supplier.replaceChildren();
    if (offers.length !== 1) {
      supplier.add(new Option(offers.length ? "Choisir un fournisseur" : "Choisir d’abord un produit", ""));
    }
    offers.forEach((offer) => {
      // Same supplier twice (two codes): the description tells them apart.
      const sameSupplier = offers.filter((candidate) => candidate.supplier_name === offer.supplier_name).length > 1;
      const supplierName = `${offer.supplier_name || "Fournisseur non précisé"}${offer.sku ? ` · SKU ${offer.sku}` : ""}${sameSupplier && offer.description ? ` – ${offer.description}` : ""}${offer.supplier_authorized === false ? " (non autorisé)" : ""}`;
      supplier.add(new Option(seesPrices() ? `${supplierName} · ${money(offer.price_cents)}` : supplierName, offer.id));
    });
    supplier.disabled = !offers.length;
    supplier.dispatchEvent(new Event("change"));
  });

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

  // Unit of the line: the product's own unit is suggested, any unit of the list can be chosen.
  const unitLabel = document.createElement("label");
  unitLabel.textContent = "Unité";
  const unit = document.createElement("select");
  unit.name = "unit";
  Object.keys(UNITS).forEach((name) => unit.add(new Option(name, name)));
  // What the unit is used for, as in the units table (kilogramme: encres, matières en vrac…).
  const unitUsage = document.createElement("span");
  unitUsage.className = "unit-usage";
  unitLabel.append(unit, unitUsage);
  const unitNote = document.createElement("p");
  unitNote.className = "unit-note";
  unitNote.hidden = true;
  const catalogueProduct = () => products.find((candidate) => candidate.id === Number(supplier.value));
  const checkUnit = () => {
    unitUsage.textContent = UNITS[unit.value]?.[1] || "";
    const product = catalogueProduct();
    const differs = Boolean(product && product.unit && unit.value !== product.unit);
    unitNote.hidden = !differs;
    if (differs) {
      unitNote.textContent = seesPrices()
        ? `Le catalogue vend ce produit à l’unité « ${product.unit} » (${money(product.price_cents)} / ${product.unit}) : le prix réel sera confirmé à l’achat.`
        : `Le catalogue vend ce produit à l’unité « ${product.unit} ».`;
    }
  };
  supplier.addEventListener("change", () => {
    const product = catalogueProduct();
    if (product?.unit) {
      unit.value = product.unit;
    }
    checkUnit();
  });
  unit.addEventListener("change", checkUnit);
  checkUnit();

  const remove = document.createElement("button");
  remove.className = "remove-item";
  remove.type = "button";
  remove.textContent = "Retirer";
  remove.setAttribute("aria-label", "Retirer ce produit");
  remove.addEventListener("click", () => {
    row.remove();
    updateOrderShipping();
  });

  row.append(productLabel, supplierLabel, quantityLabel, unitLabel, remove, unitNote);
  document.getElementById("orderItems").append(row);
}

// --- Free shipping (responsables, director, accountant) ---------------------

let supplierShipping = [];

async function loadSupplierShipping() {
  supplierShipping = (await apiRequest("/api/suppliers/shipping")).suppliers;
  renderShippingCard();
  updateOrderShipping();
}

function renderShippingCard() {
  const card = document.getElementById("shippingCard");
  const rows = supplierShipping
    .filter((supplier) => supplier.freeThresholdCents !== null)
    .map((supplier) => {
      const remaining = supplier.freeThresholdCents - supplier.openCents;
      const status = document.createElement("span");
      status.className = remaining <= 0 ? "shipping-ok" : "shipping-missing";
      status.textContent = remaining <= 0 ? "Atteinte" : `Encore ${money(remaining)}`;
      return [supplier.name, money(supplier.freeThresholdCents), money(supplier.openCents), status];
    });
  card.hidden = false;
  document.getElementById("shippingTable").replaceChildren(buildTable(
    ["Fournisseur", "Livraison gratuite dès", "Bon en cours", "Livraison gratuite"],
    rows,
    "Aucun seuil de livraison gratuite n’est encore enregistré pour les fournisseurs."
  ));
}

// Under the request form: per supplier, this request plus the open purchase order against
// the free shipping threshold.
function updateOrderShipping() {
  const box = document.getElementById("orderShipping");
  if (!supplierShipping.length) {
    box.hidden = true;
    return;
  }
  const totals = new Map();
  document.querySelectorAll(".order-item-row").forEach((row) => {
    const product = products.find((candidate) => candidate.id === Number(row.querySelector('[name="productId"]').value));
    const quantity = Number(row.querySelector('[name="quantity"]').value) || 0;
    if (product && product.supplier_name) {
      totals.set(product.supplier_name, (totals.get(product.supplier_name) || 0) + product.price_cents * quantity);
    }
  });
  const lines = [...totals].map(([name, requestCents]) => {
    const supplier = supplierShipping.find((candidate) => candidate.name === name);
    const line = document.createElement("p");
    if (!supplier || supplier.freeThresholdCents === null) {
      line.textContent = `${name} : aucun seuil de livraison gratuite enregistré.`;
      return line;
    }
    const total = supplier.openCents + requestCents;
    const remaining = supplier.freeThresholdCents - total;
    line.className = remaining <= 0 ? "shipping-ok" : "shipping-missing";
    line.textContent = `${name} : livraison gratuite dès ${money(supplier.freeThresholdCents)} · bon en cours ${money(supplier.openCents)} + cette demande ${money(requestCents)} = ${money(total)}${
      remaining <= 0 ? " → livraison gratuite atteinte." : ` → encore ${money(remaining)}.`}`;
    return line;
  });
  box.replaceChildren(...lines);
  box.hidden = !lines.length;
}

["change", "input"].forEach((type) => {
  document.getElementById("orderItems").addEventListener(type, updateOrderShipping);
});

function renderProducts() {
  renderAdminTables();
  const list = document.getElementById("productList");
  list.replaceChildren();
  // Everyone sees the whole catalogue and picks a department to list.
  const isAdmin = true;
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
  (seesPrices() ? ["Produit", "SKU", "Description", "Fournisseur", "Unité", "Prix", "État", ""] : ["Produit", "SKU", "Description", "Fournisseur", "Unité", "État"]).forEach((label, index) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    if (seesPrices() && index === 5) {
      cell.className = "num";
    }
    header.append(cell);
  });
  const body = table.createTBody();

  visible.forEach((product) => {
    const row = body.insertRow();
    row.insertCell().textContent = product.name;
    row.insertCell().textContent = product.sku || "—";
    const description = row.insertCell();
    description.className = "muted";
    description.textContent = product.description || "—";
    row.insertCell().textContent = product.supplier_name || "—";
    row.insertCell().textContent = product.unit || "unité";
    if (seesPrices()) {
      const price = row.insertCell();
      price.className = "num";
      price.textContent = money(product.price_cents);
    }
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
    if (canEditProduct(product)) {
      actions.append(edit);
    }
    if (canEditProduct(product)) {
      const remove = document.createElement("button");
      remove.className = "button button-danger button-small";
      remove.type = "button";
      remove.textContent = "Supprimer";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        if (!await deleteProduct(product)) {
          remove.disabled = false;
        }
      });
      actions.append(remove);
    }
  });
  list.append(table);
}

// The director and the purchasing administration edit and delete every product; a
// responsable, the products of the departments they lead.
function canEditProduct(product) {
  return ["admin", "purchaser"].includes(currentUser.role) ||
    (currentUser.role === "employee" && managedDepartmentIds().includes(product.department_id));
}

async function deleteProduct(product) {
  if (!window.confirm(`Supprimer « ${product.name} » du catalogue ? Les commandes passées restent dans l’historique.`)) {
    return false;
  }
  try {
    await apiRequest(`/api/products/${product.id}`, "DELETE");
    await loadProducts();
    return true;
  } catch (error) {
    window.alert(error.message);
    return false;
  }
}

// From any product list: open the catalogue's form on that product.
function editProductFromList(product) {
  document.querySelector('.tab[data-panel="productsPanel"]').click();
  beginProductEdit(product);
}

function beginProductEdit(product) {
  const form = document.getElementById("productForm");
  form.hidden = false;
  form.elements.productId.value = product.id;
  form.elements.name.value = product.name;
  form.elements.sku.value = product.sku || "";
  form.elements.description.value = product.description || "";
  form.elements.price.value = (product.price_cents / 100).toFixed(2);
  form.elements.unit.value = product.unit || "unité";
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
  // The purchasing administration only edits: the form shows while a product is open.
  form.hidden = currentUser?.role === "purchaser" || form.hidden;
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
    title.textContent = `Demande ${order.number}`;
    const badge = document.createElement("span");
    badge.className = `status-badge status-${order.status}`;
    badge.textContent = statusNames[order.status] || order.status;
    topline.append(title, badge);
    if (order.isUrgent) {
      const urgent = document.createElement("span");
      urgent.className = "status-badge urgent-badge";
      urgent.textContent = "URGENT";
      title.append(" ", urgent);
    }

    const origin = document.createElement("dl");
    origin.className = "order-origin";
    const addOrigin = (label, value) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      origin.append(term, detail);
    };
    if (order.isExternal) {
      const client = document.createElement("span");
      client.className = "status-badge client-badge";
      client.textContent = "CLIENT";
      title.append(" ", client);
      addOrigin("Pour le client", `${order.clientName}${order.clientReference ? ` · ${order.clientReference}` : ""} (hors budget)`);
    }
    addOrigin("Département", order.departmentName);
    addOrigin(
      "Demandeur",
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
      itemText.textContent = seesPrices()
        ? `${quantityWithUnit(item.quantity, item.unit)} – ${withSku(item.productName, item.sku)} (${money(item.priceCents)} / ${item.unit || "unité"})`
        : `${quantityWithUnit(item.quantity, item.unit)} – ${withSku(item.productName, item.sku)}`;
      line.append(itemText);
      if (seesPrices()) {
        const subtotal = document.createElement("strong");
        subtotal.textContent = money(item.quantity * item.priceCents);
        line.append(subtotal);
      }
      lines.append(line);
    });

    const total = document.createElement("div");
    total.className = "order-total";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "Total";
    const totalValue = document.createElement("span");
    totalValue.textContent = money(order.totalCents);
    total.append(totalLabel, totalValue);
    card.append(topline, origin, meta, lines);
    if (seesPrices()) {
      card.append(total);
    }

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
      decision.textContent = `${order.decidedByEmail || "Direction"} · décision le ${dateTime.format(decidedAt)}`;
      card.append(decision);
    }
    if (order.purchasedAt) {
      const purchase = document.createElement("p");
      purchase.className = "order-meta";
      purchase.textContent = `Achetée le ${dateTime.format(new Date(order.purchasedAt))}${order.purchasedByEmail ? ` par ${order.purchasedByEmail}` : ""}`;
      card.append(purchase);
    }
    if (order.decisionNote) {
      const note = document.createElement("p");
      note.className = "order-note";
      note.textContent = `Note de décision : ${order.decisionNote}`;
      card.append(note);
    }
    if (order.status === "pending" && needsDirector(order)) {
      const notice = document.createElement("p");
      notice.className = "order-note director-notice";
      notice.textContent = "Demande du responsable de plus de 2 500 $ : approbation de la direction requise.";
      card.append(notice);
    } else if (order.status === "pending" && currentUser.role === "admin" && departmentHasResponsable(order.departmentId)) {
      const notice = document.createElement("p");
      notice.className = "order-note";
      notice.textContent = "Décidée par le responsable du département.";
      card.append(notice);
    }
    if (canDecide(order)) {
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
          await apiRequest(`/api/orders/${order.id}/decision`, "PATCH", {
            status,
            decisionNote: note.value
          });
          await Promise.all([loadOrders(), seesBudgets() ? loadDashboard() : null]);
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

function fillSupplierSuggestionsFromCatalogue() {
  if (currentUser?.role === "admin") {
    return;
  }
  const names = [...new Set(products.map((product) => product.supplier_name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "fr"));
  document.getElementById("supplierOptions").replaceChildren(...names.map((name) => new Option(name)));
}

async function loadProducts() {
  const result = await apiRequest("/api/products");
  products = result.products;
  fillSupplierSuggestionsFromCatalogue();
  renderProducts();
}

function managedDepartmentIds() {
  return (currentUser.managedDepartments || []).map((department) => Number(department.id));
}

// A request made by the responsable of its department.
function isResponsableOwnRequest(order) {
  if (currentUser.role === "admin") {
    const responsableId = departments.find((department) => department.id === order.departmentId)?.manager_user_id;
    return Boolean(responsableId) && Number(responsableId) === order.createdByUserId;
  }
  return order.createdByUserId === currentUser.id && managedDepartmentIds().includes(order.departmentId);
}

// Only a responsable's own request above the threshold ($2,500) goes to the director; the
// responsable decides their employees' requests whatever the amount (asked 2026-10-21).
function needsDirector(order) {
  return order.totalCents > (currentUser.directorApprovalThresholdCents ?? 250000) && isResponsableOwnRequest(order);
}

function departmentHasResponsable(departmentId) {
  return Boolean(departments.find((department) => department.id === departmentId)?.manager_user_id);
}

// Director: a responsable's own request above $2,500, or a department without a responsable.
// Responsable: every other request of their department.
function canDecide(order) {
  if (order.status !== "pending") {
    return false;
  }
  if (currentUser.role === "admin") {
    return needsDirector(order) || !departmentHasResponsable(order.departmentId);
  }
  return managedDepartmentIds().includes(order.departmentId) && !needsDirector(order);
}

let staffDirectory = null;
let latestOrders = [];

// A responsable invites new employees into the department(s) they lead, and moves people
// between them.
function setupTeamInvite() {
  const managed = currentUser.managedDepartments || [];
  ["teamInviteDepartment", "teamEditDepartment"].forEach((id) => {
    document.getElementById(id).replaceChildren(...managed.map((department) => new Option(department.name, department.id)));
  });
  document.getElementById("teamInviteDepartmentField").hidden = managed.length < 2;
  document.getElementById("teamEditDepartmentField").hidden = managed.length < 2;
}

function openTeamEdit(member) {
  const form = openAdminForm("teamEditForm", `Modifier ${member.fullName || member.email}`, "Enregistrer");
  form.elements.userId.value = member.id;
  form.elements.fullName.value = member.fullName || "";
  form.elements.departmentId.value = String(member.departmentId);
  form.elements.role.value = member.role;
  showMessage(document.getElementById("teamEditMessage"), "");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

document.getElementById("teamEditForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const done = await runAdminAction("teamEditMessage", () => apiRequest(`/api/team/${form.elements.userId.value}`, "PATCH", {
    fullName: form.elements.fullName.value,
    departmentId: Number(form.elements.departmentId.value),
    role: form.elements.role.value
  }), "Employé modifié.");
  button.disabled = false;
  if (done) {
    closeAdminForm(form);
    await loadStaff();
  }
});

document.getElementById("teamInviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("teamInviteMessage");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await apiRequest("/api/team/invitations", "POST", {
      fullName: form.elements.fullName.value,
      email: form.elements.email.value,
      departmentId: Number(form.elements.departmentId.value)
    });
    showMessage(message, `${result.message} La personne va recevoir un courriel pour activer son compte.`);
    form.elements.fullName.value = "";
    form.elements.email.value = "";
  } catch (error) {
    showMessage(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function loadStaff() {
  staffDirectory = (await apiRequest("/api/staff")).staff;
  renderTeam();
  renderGroupedDirectory(document.getElementById("staffTable"), staffDirectory);
}

// One block per department (A to Z): its name, its responsable, then its people; the people
// with no department (direction, accounting, purchasing) come last.
function renderGroupedDirectory(container, staff) {
  container.replaceChildren();
  if (!staff.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucun employé pour le moment.";
    container.append(empty);
    return;
  }
  const groups = new Map();
  staff.forEach((member) => {
    const name = member.departmentName || "";
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name).push(member);
  });
  const names = [...groups.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b, "fr"));
  names.forEach((name) => {
    const members = groups.get(name).sort((a, b) => Number(b.manages.includes(name)) - Number(a.manages.includes(name)) ||
      (a.fullName || a.email).localeCompare(b.fullName || b.email, "fr"));
    const section = document.createElement("section");
    section.className = "directory-group";
    const heading = document.createElement("h4");
    heading.textContent = name || "Sans département (direction, comptabilité, administration)";
    const leader = members.find((member) => member.manages.includes(name));
    const meta = document.createElement("p");
    meta.className = "muted directory-meta";
    meta.textContent = `${members.length} personne${members.length > 1 ? "s" : ""}${name ? ` · responsable : ${leader ? leader.fullName || leader.email : "à désigner"}` : ""}`;
    section.append(heading, meta, buildTable(
      ["Nom", "Courriel", "Accès"],
      members.map((member) => {
        const role = member.manages.length ? `Responsable de ${member.manages.join(", ")}` : roleNames[member.role] || member.role;
        return [member.fullName || "—", member.email, role];
      }),
      ""
    ));
    container.append(section);
  });
}

async function loadDirectory() {
  renderGroupedDirectory(document.getElementById("directoryGroups"), (await apiRequest("/api/staff")).staff);
}

// The responsable's own department(s): each employee with their requests.
function renderTeam() {
  const container = document.getElementById("teamList");
  if (!staffDirectory) {
    return;
  }
  const managed = managedDepartmentIds();
  const team = staffDirectory.filter((member) => managed.includes(member.departmentId));
  container.replaceChildren();
  if (!team.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucun employé dans ton département pour le moment.";
    container.append(empty);
    return;
  }
  team.forEach((member) => {
    const orders = latestOrders.filter((order) => order.createdByEmail === member.email);
    const count = (status) => orders.filter((order) => order.status === status).length;
    const approvedCents = orders
      .filter((order) => order.status === "approved")
      .reduce((sum, order) => sum + order.totalCents, 0);

    const card = document.createElement("details");
    card.className = "card team-card";
    const summary = document.createElement("summary");
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = member.fullName || member.email;
    const detail = document.createElement("span");
    detail.className = "muted";
    detail.textContent = `${member.email} · ${member.departmentName}${member.manages.length ? " · responsable" : ""}${
      member.role !== "employee" ? ` · ${roleNames[member.role] || member.role}` : ""}`;
    identity.append(name, detail);
    const stats = document.createElement("div");
    stats.className = "team-stats";
    [["pending", `${count("pending")} en attente`], ["approved", `${count("approved")} approuvées`],
      ["rejected", `${count("rejected")} refusées`]].forEach(([status, text]) => {
      const badge = document.createElement("span");
      badge.className = `status-badge status-${status}`;
      badge.textContent = text;
      stats.append(badge);
    });
    const total = document.createElement("strong");
    total.textContent = `Approuvé : ${money(approvedCents)}`;
    stats.append(total);
    summary.append(identity, stats);

    const status = (order) => {
      const badge = document.createElement("span");
      badge.className = `status-badge status-${order.status}`;
      badge.textContent = statusNames[order.status] || order.status;
      return badge;
    };
    card.append(summary, buildTable(
      ["N°", "Date", "Produits", "Total", "Statut"],
      orders.map((order) => [
        order.number,
        csvDate(order.createdAt),
        order.items.map((item) => `${quantityWithUnit(item.quantity, item.unit)} – ${withSku(item.productName, item.sku)}`).join(", "),
        money(order.totalCents),
        status(order)
      ]),
      "Aucune commande."
    ));
    // Never themselves, another responsable or the director.
    const editable = member.role !== "admin" && !member.manages.length && member.id !== currentUser.id;
    if (editable) {
      const edit = document.createElement("button");
      edit.className = "button button-secondary button-small team-remove";
      edit.type = "button";
      edit.textContent = "Modifier";
      edit.addEventListener("click", (event) => {
        // The button sits in the card header: do not open/close the card.
        event.preventDefault();
        event.stopPropagation();
        openTeamEdit(member);
      });
      stats.append(edit);
    }
    const removable = member.role === "employee" && editable;
    if (removable) {
      const remove = document.createElement("button");
      remove.className = "button button-danger button-small team-remove";
      remove.type = "button";
      remove.textContent = "Retirer de mon département";
      remove.addEventListener("click", async (event) => {
        // The button sits in the card header: do not open/close the card.
        event.preventDefault();
        event.stopPropagation();
        if (!window.confirm(`Retirer « ${member.fullName || member.email} » ? Son compte sera supprimé ; ses commandes restent dans l’historique.`)) {
          return;
        }
        remove.disabled = true;
        try {
          await apiRequest(`/api/team/${member.id}`, "DELETE");
          await loadStaff();
        } catch (error) {
          window.alert(error.message);
          remove.disabled = false;
        }
      });
      // On the card header, visible without opening the card.
      stats.append(remove);
    }
    container.append(card);
  });
}

// --- Purchase orders (accountant) ----------------------------------------

let boughtPurchaseOrders = [];

async function loadPurchaseOrders() {
  const { purchaseOrders } = await apiRequest("/api/purchase-orders");
  renderPurchaseOrders(
    document.getElementById("purchaseList"),
    sortUrgentFirst(purchaseOrders.filter((purchaseOrder) => purchaseOrder.status === "open")),
    "Aucun bon de commande à acheter pour le moment."
  );
  boughtPurchaseOrders = purchaseOrders.filter((purchaseOrder) => purchaseOrder.status !== "open");
  document.getElementById("purchaseExportSummary").textContent = boughtPurchaseOrders.length
    ? `${boughtPurchaseOrders.length} bon${boughtPurchaseOrders.length > 1 ? "s" : ""} acheté${boughtPurchaseOrders.length > 1 ? "s" : ""} · ${money(boughtPurchaseOrders.reduce((total, purchaseOrder) => total + purchaseOrder.totalCents, 0))}`
    : "Aucun bon acheté pour le moment.";
  if (!document.getElementById("purchasePreview").hidden) {
    renderTablePreview(document.getElementById("purchasePreview"), purchaseExportTable(), "Aucun bon acheté pour le moment.");
  }
}

// One row per product of each bought purchase order.
function purchaseExportTable(list = boughtPurchaseOrders) {
  return {
    columns: [
      "N° bon de commande", "Fournisseur", "Ouvert le", "Acheté le", "Acheté par", "SKU", "Produit", "Quantité", "Unité",
      "Prix unitaire", "Sous-total", "Total du bon", "Demandes"
    ],
    rows: list.flatMap((purchaseOrder) => purchaseOrder.lines.map((line) => [
      purchaseOrder.number,
      purchaseOrder.supplierName || "",
      csvDate(purchaseOrder.createdAt),
      csvDate(purchaseOrder.purchasedAt),
      purchaseOrder.purchasedByEmail || "",
      line.sku || "",
      line.productName,
      line.quantity,
      line.unit || "unité",
      csvAmount(line.priceCents),
      csvAmount(line.priceCents * line.quantity),
      csvAmount(purchaseOrder.totalCents),
      line.detail.map((part) => `${part.orderNumber} (${part.quantity})`).join(", ")
    ]))
  };
}

document.getElementById("purchasePreviewButton").addEventListener("click", (event) => {
  const preview = document.getElementById("purchasePreview");
  preview.hidden = !preview.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!preview.hidden));
  event.currentTarget.textContent = preview.hidden ? "Visualiser" : "Masquer l’aperçu";
  if (!preview.hidden) {
    renderTablePreview(preview, purchaseExportTable(), "Aucun bon acheté pour le moment.");
  }
});

document.getElementById("purchaseDownloadButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadPurchaseOrders();
    downloadCsv(`bons-de-commande-${csvDate(new Date()).slice(0, 10)}.csv`, purchaseExportTable());
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
  }
});

// Text message, phone and "other" are no longer offered, but older purchase orders and supplier
// cards may still name them.
const ORDER_METHOD_NAMES = {
  email: "Courriel", sms: "Texto", website: "Portail / site web", phone: "Téléphone", representative: "Représentant", other: "Autre"
};

// Amounts of a purchase order, in its supplier's billing currency.
function moneyIn(cents, currencyCode = "CAD") {
  return new Intl.NumberFormat("fr-CA", { style: "currency", currency: currencyCode || "CAD" }).format(cents / 100);
}
const PURCHASE_STATUS = {
  open: ["À transmettre", "status-pending"],
  sent: ["Transmis", "status-approved"],
  purchased: ["Acheté", "status-purchased"]
};

// "150", "149,99" or "149.99" → cents; empty → null; anything else → NaN.
function dollarsToCents(text) {
  const value = String(text || "").trim().replace(/\s/g, "").replace(",", ".");
  if (!value) {
    return null;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    return Number.NaN;
  }
  const [whole, cents = ""] = value.split(".");
  return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
}

function centsToDollars(cents) {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2).replace(".", ",");
}

function phoneWithExtension(phone, extension) {
  return phone ? `${phone}${extension ? ` poste ${extension}` : ""}` : "";
}

function shippingThresholds(reducedCents, freeCents) {
  return [
    reducedCents !== null && reducedCents !== undefined ? `réduite dès ${money(reducedCents)}` : "",
    freeCents !== null && freeCents !== undefined ? `gratuite dès ${money(freeCents)}` : ""
  ].filter(Boolean).join(" · ");
}

// Where an order stands against the supplier's shipping thresholds.
function shippingProgress(totalCents, details) {
  const free = details.freeThresholdCents;
  const reduced = details.reducedThresholdCents;
  if (free !== null && free !== undefined && totalCents >= free) {
    return { text: `Livraison gratuite atteinte (seuil ${money(free)}).`, reached: true };
  }
  const parts = [];
  if (reduced !== null && reduced !== undefined) {
    parts.push(totalCents >= reduced
      ? `Livraison réduite atteinte (seuil ${money(reduced)})`
      : `encore ${money(reduced - totalCents)} pour la livraison réduite (${money(reduced)})`);
  }
  if (free !== null && free !== undefined) {
    parts.push(`encore ${money(free - totalCents)} pour la livraison gratuite (${money(free)})`);
  }
  if (!parts.length) {
    return null;
  }
  const text = parts.join(" · ");
  return { text: `${text.charAt(0).toUpperCase()}${text.slice(1)}.`, reached: false };
}

function supplierWebsiteLink(website) {
  if (!website) {
    return "—";
  }
  const link = document.createElement("a");
  link.href = website;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = website.replace(/^https?:\/\//, "");
  return link;
}

// Contact, email, phone, website and preferred way to send orders.
function supplierDetails(name, details) {
  const list = document.createElement("dl");
  list.className = "order-origin supplier-details";
  const add = (label, value) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.append(value || "—");
    list.append(term, detail);
  };
  const link = (href, text) => {
    if (!text) {
      return "—";
    }
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = text;
    return anchor;
  };
  add("Fournisseur", name || "Fournisseur non précisé");
  if (details.isAuthorized === false) {
    add("Autorisé", authorizedBadge(false));
  }
  if (details.category) {
    add("Catégorie", details.category);
  }
  if (details.accountNumber) {
    add("N° de compte client", details.accountNumber);
  }
  add("Paiement", [details.paymentTerms, details.currency || "CAD"].filter(Boolean).join(" · "));
  add("Courriel", link(`mailto:${details.email}`, details.email));
  add("Téléphone", link(`tel:${(details.phone || "").replace(/[^+\d]/g, "")}`, phoneWithExtension(details.phone, details.phoneExtension)));
  add("Personne ressource", details.contactName);
  add("Mode de commande", ORDER_METHOD_NAMES[details.orderMethod] || "Non précisé");
  add("Site web", supplierWebsiteLink(details.website));
  add("Livraison", shippingThresholds(details.reducedThresholdCents, details.freeThresholdCents));
  if (details.note) {
    add("Note", details.note);
  }
  return list;
}

async function purchaseOrderDocumentFor(purchaseOrder, note = "") {
  const query = note ? `?note=${encodeURIComponent(note)}` : "";
  return (await apiRequest(`/api/purchase-orders/${purchaseOrder.id}/document${query}`)).document;
}

// The purchase order as a PDF file, built by the server.
async function downloadPurchaseOrderPdf(purchaseOrder, note = "") {
  try {
    const response = await fetch(`/api/purchase-orders/${purchaseOrder.id}/pdf${note ? `?note=${encodeURIComponent(note)}` : ""}`);
    if (!response.ok) {
      throw new Error((await response.json().catch(() => ({}))).error || "Le PDF n’a pas pu être créé.");
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `bon-de-commande-${purchaseOrder.number}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    window.alert(error.message);
  }
}

const poDocumentDialog = document.getElementById("poDocumentDialog");
let shownDocument = null;
let shownPurchaseOrder = null;

async function showPurchaseOrderDocument(purchaseOrder) {
  try {
    shownPurchaseOrder = purchaseOrder;
    shownDocument = await purchaseOrderDocumentFor(purchaseOrder, purchaseOrder.sentNote || "");
    // Built and escaped by the server.
    document.getElementById("poDocumentContent").innerHTML = shownDocument.html;
    poDocumentDialog.showModal();
  } catch (error) {
    window.alert(error.message);
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copié ✓";
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  } catch {
    window.prompt("Copiez le bon :", text);
  }
}

document.getElementById("poPrintButton").addEventListener("click", () => {
  document.body.classList.add("printing-po");
  window.print();
});
window.addEventListener("afterprint", () => document.body.classList.remove("printing-po"));
document.getElementById("poPdfButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  await downloadPurchaseOrderPdf(shownPurchaseOrder, shownPurchaseOrder.sentNote || "");
  button.disabled = false;
});
document.getElementById("poCopyDocument").addEventListener("click", (event) => {
  if (shownDocument) {
    copyText(shownDocument.text, event.currentTarget);
  }
});
document.getElementById("closePoDocument").addEventListener("click", () => poDocumentDialog.close());

// Transmission to the supplier (director).
const poSendDialog = document.getElementById("poSendDialog");
let sendingPurchaseOrder = null;

function openSendDialog(purchaseOrder) {
  sendingPurchaseOrder = purchaseOrder;
  const form = document.getElementById("poSendForm");
  form.reset();
  document.getElementById("poSendTitle").textContent = `Transmettre le bon ${purchaseOrder.number}`;
  document.getElementById("poSendSupplier").replaceChildren(supplierDetails(purchaseOrder.supplierName, purchaseOrder.supplier));
  // The supplier's preferred way when it is still offered (an older card may say text message or phone).
  const { orderMethod, email, website } = purchaseOrder.supplier;
  form.elements.method.value = [...form.elements.method.options].some((option) => option.value === orderMethod)
    ? orderMethod
    : email ? "email" : website ? "website" : "representative";
  showMessage(document.getElementById("poSendMessage"), "");
  updateSendHelp();
  poSendDialog.showModal();
}

function updateSendHelp() {
  const purchaseOrder = sendingPurchaseOrder;
  const { email, phone, website } = purchaseOrder.supplier;
  const method = document.getElementById("poSendMethod").value;
  const help = document.getElementById("poSendHelp");
  const tools = document.getElementById("poSendTools");
  const submit = document.getElementById("poSendSubmit");
  tools.replaceChildren();
  const toolButton = (label, action) => {
    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => action(button));
    tools.append(button);
  };
  const note = () => document.getElementById("poSendNote").value.trim();
  const copy = () => toolButton("Copier le bon", async (button) => {
    copyText((await purchaseOrderDocumentFor(purchaseOrder, note())).text, button);
  });
  toolButton("Voir le bon", () => showPurchaseOrderDocument({ ...purchaseOrder, sentNote: note() }));
  submit.textContent = "Confirmer la transmission";
  submit.disabled = false;
  if (method === "email") {
    help.textContent = email
      ? `Le site envoie le bon par courriel à ${email}. Les réponses du fournisseur arriveront à votre courriel (${currentUser.email}).`
      : "Ce fournisseur n’a pas de courriel : ajoutez-le dans la section Fournisseurs, ou choisissez une autre façon.";
    submit.textContent = "Envoyer le courriel";
    submit.disabled = !email;
  } else if (method === "website") {
    help.textContent = website
      ? "Ouvrez le site du fournisseur, passez la commande avec le bon (copiez-le au besoin), puis revenez confirmer la transmission."
      : "Ce fournisseur n’a pas de site web enregistré. Ajoutez-le dans la section Fournisseurs.";
    if (website) {
      toolButton("Ouvrir le site du fournisseur", () => window.open(website, "_blank", "noopener"));
    }
    copy();
  } else {
    const { contactName } = purchaseOrder.supplier;
    help.textContent = `Transmettez le bon à votre représentant${contactName ? ` (${contactName})` : ""}${phone ? ` au ${phone}` : ""}${email ? ` ou à ${email}` : ""}, puis confirmez la transmission.`;
    if (phone) {
      toolButton("Appeler", () => {
        window.location.href = `tel:${phone.replace(/[^+\d]/g, "")}`;
      });
    }
    copy();
  }
  help.textContent += " Une fois transmis, le bon passe à « Acheté » et va dans l’Historique des bons.";
}

document.getElementById("poSendMethod").addEventListener("change", updateSendHelp);
document.getElementById("closePoSend").addEventListener("click", () => poSendDialog.close());
document.getElementById("poSendForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.getElementById("poSendSubmit");
  const method = form.elements.method.value;
  submit.disabled = true;
  try {
    await apiRequest(`/api/purchase-orders/${sendingPurchaseOrder.id}/sent`, "PATCH", { method, note: form.elements.note.value.trim() });
    poSendDialog.close();
    showMessage(
      document.getElementById("adminPurchaseMessage"),
      `${method === "email"
        ? `Bon ${sendingPurchaseOrder.number} envoyé par courriel à ${sendingPurchaseOrder.supplier.email}`
        : `Bon ${sendingPurchaseOrder.number} transmis (${ORDER_METHOD_NAMES[method].toLowerCase()})`} : il est maintenant acheté et dans l’Historique des bons.`
    );
    document.getElementById("adminPurchaseMessage").classList.add("success");
    await loadAdminPurchaseOrders();
  } catch (error) {
    showMessage(document.getElementById("poSendMessage"), error.message, true);
    submit.disabled = false;
  }
});

// The director and the purchasing administration transmit purchase orders to the suppliers.
function canTransmitPurchaseOrders() {
  return ["admin", "purchaser"].includes(currentUser?.role);
}

function renderPurchaseOrders(list, purchaseOrders, emptyMessage) {
  list.replaceChildren();
  if (!purchaseOrders.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = emptyMessage;
    list.append(empty);
    return;
  }
  purchaseOrders.forEach((purchaseOrder) => {
    const card = document.createElement("article");
    card.className = "order-card purchase-order-card";
    const topline = document.createElement("div");
    topline.className = "order-topline";
    const title = document.createElement("h3");
    title.textContent = `${purchaseOrder.number} · ${purchaseOrder.supplierName || "Fournisseur non précisé"}`;
    if (purchaseOrder.status !== "purchased" && purchaseOrder.isUrgent) {
      const urgent = document.createElement("span");
      urgent.className = "status-badge urgent-badge";
      urgent.textContent = "URGENT";
      title.append(" ", urgent);
    }
    const [statusName, statusClass] = PURCHASE_STATUS[purchaseOrder.status] || [purchaseOrder.status, ""];
    const badge = document.createElement("span");
    badge.className = `status-badge ${statusClass}`;
    badge.textContent = statusName;
    topline.append(title, badge);

    const meta = document.createElement("p");
    meta.className = "order-meta";
    meta.textContent = `Ouvert le ${dateTime.format(new Date(purchaseOrder.createdAt))} · ${purchaseOrder.orders.length} demande${purchaseOrder.orders.length > 1 ? "s" : ""} regroupée${purchaseOrder.orders.length > 1 ? "s" : ""}`;

    // Quantities summed per product; the detail says who asked for what.
    const lines = document.createElement("ul");
    lines.className = "order-lines";
    purchaseOrder.lines.forEach((item) => {
      const line = document.createElement("li");
      const itemText = document.createElement("span");
      itemText.textContent = `${quantityWithUnit(item.quantity, item.unit)} – ${withSku(item.productName, item.sku)} (${moneyIn(item.priceCents, purchaseOrder.supplier.currency)} / ${item.unit || "unité"})`;
      const detail = document.createElement("small");
      detail.className = "purchase-line-detail";
      detail.textContent = item.detail.map((part) => `${quantityWithUnit(part.quantity, item.unit)} pour ${part.orderNumber} (${part.requester || "?"})`).join(" · ");
      itemText.append(document.createElement("br"), detail);
      const subtotal = document.createElement("strong");
      subtotal.textContent = moneyIn(item.quantity * item.priceCents, purchaseOrder.supplier.currency);
      line.append(itemText, subtotal);
      lines.append(line);
    });

    const total = document.createElement("div");
    total.className = "order-total";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "Total du bon";
    const totalValue = document.createElement("span");
    totalValue.textContent = moneyIn(purchaseOrder.totalCents, purchaseOrder.supplier.currency);
    total.append(totalLabel, totalValue);

    const included = document.createElement("p");
    included.className = "order-note";
    included.textContent = `Demandes incluses : ${purchaseOrder.orders.map((order) => (
      `${order.number} (${order.departmentName}, ${order.requester || "?"}${order.isUrgent ? ", urgente" : ""}${order.clientName ? `, client : ${order.clientName}` : ""}${
        order.approvedBy ? `, approuvée par ${order.approvedBy} – ${order.approvedByDirector ? "direction" : "responsable"}` : ""})`
    )).join(" ; ")}`;
    card.append(topline, meta);
    if (canTransmitPurchaseOrders()) {
      card.append(supplierDetails(purchaseOrder.supplierName, purchaseOrder.supplier));
    } else {
      const terms = [
        purchaseOrder.supplier.paymentTerms ? `Conditions : ${purchaseOrder.supplier.paymentTerms}` : "",
        `Devise : ${purchaseOrder.supplier.currency || "CAD"}`,
        purchaseOrder.supplier.accountNumber ? `Compte client : ${purchaseOrder.supplier.accountNumber}` : ""
      ].filter(Boolean).join(" · ");
      const termsLine = document.createElement("p");
      termsLine.className = "order-meta";
      termsLine.textContent = terms;
      card.append(termsLine);
    }
    if (purchaseOrder.supplier.isAuthorized === false) {
      const warning = document.createElement("p");
      warning.className = "order-note director-notice";
      warning.textContent = "Fournisseur non autorisé (hors entente négociée).";
      card.append(warning);
    }
    card.append(lines, total);
    const shipping = canTransmitPurchaseOrders() && purchaseOrder.status === "open"
      ? shippingProgress(purchaseOrder.totalCents, purchaseOrder.supplier)
      : null;
    if (shipping) {
      const notice = document.createElement("p");
      notice.className = `order-note shipping-note${shipping.reached ? " reached" : ""}`;
      notice.textContent = shipping.text;
      card.append(notice);
    }
    card.append(included);
    if (purchaseOrder.sentAt) {
      const sent = document.createElement("p");
      sent.className = "order-meta";
      sent.textContent = `Transmis au fournisseur le ${dateTime.format(new Date(purchaseOrder.sentAt))} (${(ORDER_METHOD_NAMES[purchaseOrder.sentMethod] || "").toLowerCase()})${purchaseOrder.sentByEmail ? ` par ${purchaseOrder.sentByEmail}` : ""}${purchaseOrder.sentNote ? ` · Note : ${purchaseOrder.sentNote}` : ""}`;
      card.append(sent);
    }

    const actions = document.createElement("div");
    actions.className = "form-actions purchase-actions";
    const view = document.createElement("button");
    view.className = "button button-secondary";
    view.type = "button";
    view.textContent = "Voir le bon";
    view.addEventListener("click", () => showPurchaseOrderDocument(purchaseOrder));
    const pdf = document.createElement("button");
    pdf.className = "button button-secondary";
    pdf.type = "button";
    pdf.textContent = "Télécharger le PDF";
    pdf.addEventListener("click", async () => {
      pdf.disabled = true;
      await downloadPurchaseOrderPdf(purchaseOrder, purchaseOrder.sentNote || "");
      pdf.disabled = false;
    });
    actions.append(view, pdf);
    if (canTransmitPurchaseOrders() && purchaseOrder.status === "open") {
      const send = document.createElement("button");
      send.className = "button";
      send.type = "button";
      send.textContent = "Transmettre au fournisseur";
      send.addEventListener("click", () => openSendDialog(purchaseOrder));
      actions.append(send);
    }
    card.append(actions);

    if (purchaseOrder.status === "purchased") {
      const purchase = document.createElement("p");
      purchase.className = "order-meta";
      purchase.textContent = `Acheté le ${dateTime.format(new Date(purchaseOrder.purchasedAt))}${purchaseOrder.purchasedByEmail ? ` par ${purchaseOrder.purchasedByEmail}` : ""}`;
      card.append(purchase);
    } else if (currentUser.role === "accountant") {
      // Only the accountant confirms the purchase (payment).
      const buy = document.createElement("button");
      buy.className = "button";
      buy.type = "button";
      buy.textContent = "Marquer comme acheté";
      buy.addEventListener("click", async () => {
        if (!window.confirm(`Confirmer l’achat du bon ${purchaseOrder.number} chez ${purchaseOrder.supplierName || "ce fournisseur"} ?`)) {
          return;
        }
        buy.disabled = true;
        try {
          await apiRequest(`/api/purchase-orders/${purchaseOrder.id}/purchased`, "PATCH");
          await loadOrders();
        } catch (error) {
          window.alert(error.message);
          buy.disabled = false;
        }
      });
      actions.append(buy);
    }
    list.append(card);
  });
}

async function loadOrders() {
  const result = await apiRequest("/api/orders");
  renderOrderLists(result.orders);
}

let lastOrderSignature = "";

function orderSignature(orders) {
  return orders.map((order) => `${order.id}:${order.status}:${order.purchasedAt ? 1 : 0}`).join(",");
}

function sortUrgentFirst(orders) {
  return [...orders].sort((a, b) => Number(b.isUrgent) - Number(a.isUrgent));
}

function renderOrderLists(orders) {
  // Pending requests stay under "Commandes"; approved and rejected ones are only in the
  // "Historique" table and its CSV export.
  renderOrders(
    document.getElementById("orderList"),
    sortUrgentFirst(orders.filter((order) => order.status === "pending")),
    currentUser.role === "admin" ? "Aucune demande en attente." : "Vous n’avez aucune demande en attente."
  );
  // The accountant receives one purchase order per supplier to buy.
  const purchaseSection = document.getElementById("purchaseSection");
  purchaseSection.hidden = currentUser.role !== "accountant";
  if (!purchaseSection.hidden) {
    loadPurchaseOrders().catch((error) => showMessage(document.getElementById("orderMessage"), error.message, "error"));
  }
  lastOrderSignature = orderSignature(orders);
  latestOrders = orders;
  renderTeam();
  historyOrders = orders.filter((order) => order.status !== "pending");
  if (!document.getElementById("historyPreview").hidden) {
    renderHistoryPreview();
  }
  updateNotifications(orders);
}

// --- History export ------------------------------------------------------

let historyOrders = [];

const HISTORY_COLUMNS = [
  "N° demande", "Date de la demande", "Type", "Client", "Département", "Demandeur", "Courriel", "Urgente", "SKU", "Produit",
  "Fournisseur", "Bon de commande", "Quantité", "Unité", "Prix unitaire", "Sous-total", "Total de la demande", "Statut", "Décidé par",
  "Date de décision", "Achetée le", "Note de la demande", "Note de décision"
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
    order.number,
    csvDate(order.createdAt),
    order.isExternal ? "Client (externe)" : "Entreprise",
    order.isExternal ? `${order.clientName}${order.clientReference ? ` (${order.clientReference})` : ""}` : "",
    order.departmentName,
    order.createdByName || "",
    order.createdByEmail,
    order.isUrgent ? "Oui" : "Non",
    item.sku || "",
    item.productName,
    item.supplierName || "",
    item.purchaseOrderNumber || "",
    item.quantity,
    item.unit || "unité",
    csvAmount(item.priceCents),
    csvAmount(item.priceCents * item.quantity),
    csvAmount(order.totalCents),
    statusNames[order.status] || order.status,
    order.decidedByEmail || "",
    csvDate(order.decidedAt),
    csvDate(order.purchasedAt),
    order.notes || "",
    order.decisionNote || ""
  ]));
}

const HISTORY_PRICE_COLUMNS = ["Prix unitaire", "Sous-total", "Total de la demande"];

function historyTable() {
  const keep = HISTORY_COLUMNS.map((column) => seesPrices() || !HISTORY_PRICE_COLUMNS.includes(column));
  return {
    columns: HISTORY_COLUMNS.filter((column, index) => keep[index]),
    rows: historyRows().map((row) => row.filter((value, index) => keep[index]))
  };
}

function renderHistoryPreview() {
  renderTablePreview(document.getElementById("historyPreview"), historyTable(), "L’historique est vide.");
}

function renderTablePreview(container, { columns, rows }, emptyText) {
  container.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "budget-table history-table";
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
    downloadCsv(`historique-commandes-${csvDate(new Date()).slice(0, 10)}.csv`, historyTable());
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
  }
});

// A semicolon-separated file that Excel opens directly (French settings).
function downloadCsv(fileName, { columns, rows }) {
  const escape = (value) => {
    const text = String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [columns, ...rows]
    .map((row) => row.map(escape).join(";"))
    .join("\r\n");
  // The byte-order mark makes Excel read the accents correctly.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Checks for new orders (admin) or decisions (employee) without disturbing a decision being typed.
async function refreshOrders() {
  try {
    const { orders } = await apiRequest("/api/orders");
    if (orderSignature(orders) === lastOrderSignature) {
      return;
    }
    // Only an approver typing a decision note keeps the list as it is (their words would be lost);
    // otherwise a decided request leaves the pending list right away.
    const typing = document.activeElement;
    if (typing?.closest?.("#orderList") && typing.tagName === "TEXTAREA" && typing.value.trim()) {
      updateNotifications(orders);
      return;
    }
    renderOrderLists(orders);
    if (seesBudgets()) {
      await loadDashboard();
    }
  } catch {
    // A failed background check is retried on the next interval.
  }
}

// --- Notification bell ---------------------------------------------------

// Every check wakes the database (billed by usage): not too often, and never for a hidden tab.
const NOTIFICATION_POLL_MS = 60000;
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

// Requests waiting for this user's decision (approvers), and decisions on their own requests.
function updateNotifications(orders) {
  const own = (order) => order.createdByUserId === currentUser.id;
  const toBuy = () => false;
  if (knownOrderStatuses) {
    const arrived = orders.some((order) => canDecide(order) && !knownOrderStatuses.has(order.id)) ||
      orders.some((order) => own(order) && order.status !== "pending" && knownOrderStatuses.get(order.id) === "pending") ||
      orders.some((order) => toBuy(order) && knownOrderStatuses.get(order.id) !== "approved");
    if (arrived) {
      playNotificationSound();
    }
  }
  knownOrderStatuses = new Map(orders.map((order) => [order.id, order.status]));

  const toDecide = sortUrgentFirst(orders.filter(canDecide)).map((order) => ({
    id: order.id,
    kind: "pending",
    text: `${order.isUrgent ? "URGENT · " : ""}Demande ${order.number} en attente · ${order.departmentName}`,
    detail: `${order.createdByName || order.createdByEmail} · ${money(order.totalCents)}`,
    panel: "ordersPanel"
  }));
  const ownOrders = orders.filter(own);
  const seen = seenDecisions(ownOrders);
  const decisions = ownOrders
    .filter((order) => order.status !== "pending" && !seen.has(order.id))
    .map((order) => ({
      id: order.id,
      kind: "decision",
      text: `Votre demande ${order.number} a été ${order.status === "approved" ? "approuvée" : "refusée"}`,
      detail: order.decisionNote ? `Note : ${order.decisionNote}` : (seesPrices() ? money(order.totalCents) : ""),
      panel: "historyPanel"
    }));
  const purchases = sortUrgentFirst(orders.filter(toBuy)).map((order) => ({
    id: order.id,
    kind: "purchase",
    text: `${order.isUrgent ? "URGENT · " : ""}Demande ${order.number} à acheter · ${order.departmentName}`,
    detail: `${order.createdByName || order.createdByEmail} · ${money(order.totalCents)}`,
    panel: "ordersPanel"
  }));
  currentNotifications = [...toDecide, ...purchases, ...decisions];
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
    empty.textContent = "Aucune nouvelle notification.";
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
  const decisions = currentNotifications.filter((notification) => notification.kind === "decision");
  if (!panel.hidden && decisions.length) {
    // Opening the bell marks decisions on one's own requests as read; the list stays until it closes.
    decisions.forEach((notification) => sessionSeenDecisions.add(notification.id));
    const seen = readSeenDecisions() || new Set();
    sessionSeenDecisions.forEach((id) => seen.add(id));
    writeSeenDecisions(seen);
    const stillPending = currentNotifications.length - decisions.length;
    const badge = document.getElementById("notificationBadge");
    badge.hidden = !stillPending;
    badge.textContent = String(stillPending);
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
  if (currentUser?.role === "purchaser") {
    renderAdminProductTable();
    return;
  }
  if (currentUser?.role === "employee" && managedDepartmentIds().length) {
    renderSupplierTable();
    return;
  }
  if (currentUser?.role !== "admin") {
    return;
  }
  renderManagerRequests();
  renderManagerTable();
  renderDepartmentTable();
  renderSupplierTable();
  renderAdminProductTable();
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
  fillDepartmentSelect(document.getElementById("orderDepartment"), "Choisir un département");
  document.getElementById("supplierOptions").replaceChildren(
    ...adminSuppliers.map((supplier) => new Option(supplier.name))
  );
  renderProducts();
  loadAdminPurchaseOrders();
  // Responsables may have changed, and with them who decides each request.
  if (latestOrders.length) {
    renderOrderLists(latestOrders);
  }
}

// --- Side menu: collapsible on large screens, a drawer on phones ----------

const MENU_STATE_KEY = "promographe.menuCollapsed";
const smallScreen = window.matchMedia("(max-width: 860px)");

function setMenuOpen(open) {
  if (smallScreen.matches) {
    document.body.classList.toggle("menu-open", open);
    document.getElementById("menuBackdrop").hidden = !open;
  } else {
    document.body.classList.toggle("menu-collapsed", !open);
    try {
      window.localStorage.setItem(MENU_STATE_KEY, open ? "0" : "1");
    } catch {
      // Storage unavailable: the menu simply opens by default next time.
    }
  }
  document.getElementById("menuToggle").setAttribute("aria-expanded", String(open));
}

function menuIsOpen() {
  return smallScreen.matches
    ? document.body.classList.contains("menu-open")
    : !document.body.classList.contains("menu-collapsed");
}

try {
  if (!smallScreen.matches && window.localStorage.getItem(MENU_STATE_KEY) === "1") {
    setMenuOpen(false);
  }
} catch {
  // Storage unavailable: keep the menu open.
}

document.getElementById("menuToggle").addEventListener("click", () => setMenuOpen(!menuIsOpen()));
document.getElementById("menuBackdrop").addEventListener("click", () => setMenuOpen(false));
smallScreen.addEventListener("change", () => {
  document.body.classList.remove("menu-open", "menu-collapsed");
  document.getElementById("menuBackdrop").hidden = true;
});

// Collapsed menu shows icons only: keep the section name as a tooltip.
document.querySelectorAll(".tab").forEach((tab) => {
  tab.title = tab.textContent.trim();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (smallScreen.matches) {
      setMenuOpen(false);
    }
    document.querySelectorAll(".tab").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === tab);
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.panel;
    });
  });
});

async function showNextOrderNumber() {
  const preview = document.getElementById("orderNumberPreview");
  try {
    const { number } = await apiRequest("/api/orders/next-number");
    preview.textContent = `Demande ${number}`;
  } catch {
    preview.textContent = "";
  }
}

// Company or client request: a client request needs the client's name.
function updateOrderType() {
  const form = document.getElementById("orderForm");
  const external = form.elements.orderType.value === "external";
  document.getElementById("clientFields").hidden = !external;
  form.elements.clientName.required = external;
}

document.querySelectorAll('input[name="orderType"]').forEach((radio) => {
  radio.addEventListener("change", updateOrderType);
});

document.getElementById("newOrderButton").addEventListener("click", () => {
  document.getElementById("orderForm").hidden = false;
  showNextOrderNumber();
  if (!document.getElementById("orderItems").children.length) {
    addOrderItemRow();
  }
  document.getElementById("orderForm").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("addOrderItem").addEventListener("click", addOrderItemRow);

// The director chooses the department of each request; everyone else orders for their own.
function orderDepartmentId() {
  return currentUser.role === "admin"
    ? Number(document.getElementById("orderDepartment").value) || null
    : Number(currentUser.departmentId) || null;
}

document.getElementById("orderDepartment").addEventListener("change", () => {
  document.getElementById("orderItems").replaceChildren();
  addOrderItemRow();
});

document.getElementById("orderForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("orderMessage");
  const button = form.querySelector('button[type="submit"]');
  const items = [...document.querySelectorAll(".order-item-row")].map((row) => ({
    productId: Number(row.querySelector('[name="productId"]').value),
    quantity: Number(row.querySelector('[name="quantity"]').value),
    unit: row.querySelector('[name="unit"]').value
  }));
  if (items.some((item) => !item.productId || !item.quantity) ||
      new Set(items.map((item) => item.productId)).size !== items.length) {
    showMessage(message, "Choisissez un produit et son fournisseur sur chaque ligne, sans répéter le même produit chez le même fournisseur.", true);
    return;
  }
  button.disabled = true;
  showMessage(message, "");
  try {
    const result = await apiRequest("/api/orders", "POST", {
      items,
      notes: form.elements.notes.value,
      urgent: form.elements.urgent.checked,
      ...(form.elements.orderType.value === "external" ? {
        external: true,
        clientName: form.elements.clientName.value,
        clientReference: form.elements.clientReference.value
      } : {}),
      ...(currentUser.role === "admin" ? { departmentId: orderDepartmentId() } : {})
    });
    form.reset();
    updateOrderType();
    document.getElementById("orderItems").replaceChildren();
    form.hidden = true;
    await loadOrders();
    if (seesPrices()) {
      // An approved request has just joined its supplier's open purchase order.
      loadSupplierShipping().catch(() => updateOrderShipping());
    }
    if (result.status === "approved") {
      window.alert(`Demande ${result.orderNumber} approuvée automatiquement. Elle est dans l’Historique.`);
    } else if (managedDepartmentIds().length) {
      window.alert(`Demande ${result.orderNumber} envoyée : au-delà de 2 500 $, elle doit être approuvée par la direction.`);
    }
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
    sku: form.elements.sku.value,
    description: form.elements.description.value,
    priceCents,
    unit: form.elements.unit.value,
    isActive: form.elements.isActive.checked
  };
  body.supplierName = form.elements.supplierName.value.trim();
  if (["admin", "purchaser"].includes(currentUser.role)) {
    body.departmentId = Number(form.elements.departmentId.value);
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

// Only the administration panel's menu and sections (the catalogue has its own menu, and a
// responsable's supplier cards live in the catalogue).
document.querySelectorAll("#adminPanel .admin-menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll("#adminPanel .admin-menu-item").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === item);
    });
    document.querySelectorAll("#adminPanel .admin-section").forEach((section) => {
      section.hidden = section.id !== item.dataset.adminSection;
    });
    if (["adminPurchaseSection", "adminPurchaseHistorySection"].includes(item.dataset.adminSection)) {
      loadAdminPurchaseOrders();
    }
  });
});

// A responsable's catalogue: their products, or the supplier cards.
document.querySelectorAll("#catalogueMenu .admin-menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll("#catalogueMenu .admin-menu-item").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === item);
    });
    ["catalogueProducts", "catalogueSuppliers"].forEach((id) => {
      document.getElementById(id).hidden = id !== item.dataset.catalogueView;
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
  if (!onDelete) {
    actions.append(edit);
    return actions;
  }
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
      if (!window.confirm(`Retirer l’accès du directeur « ${admin.full_name || admin.email} » ? Il ne pourra plus se connecter.`)) {
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
    "Aucun directeur. Cliquez sur « Inviter un directeur »."
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
  }), "Invitation envoyée. Le directeur va recevoir un courriel pour activer son compte.");
  button.disabled = false;
  if (done) {
    closeAdminForm(form);
    await loadDeveloperAdmins();
  }
});

// Responsables

const FUNCTION_LABELS = {
  transmitter_admin: "Transmetteur — administration",
  transmitter_production: "Transmetteur — production",
  transmitter_sales: "Transmetteur — ventes et graphisme",
  transmitter_backup: "Remplaçant(e) des transmetteurs",
  reception: "Réception",
  accounting: "Comptabilité",
  general_management: "Direction générale"
};

// Employees and administrators: everyone on staff can hold procedure functions.
const staffMembers = () => adminUsers.filter((user) => ["employee", "admin", "accountant"].includes(user.role));

function functionBadges(codes) {
  const container = document.createElement("div");
  container.className = "function-badges";
  if (!codes?.length) {
    container.textContent = "—";
    return container;
  }
  codes.forEach((code) => {
    const badge = document.createElement("span");
    badge.className = "function-badge";
    badge.textContent = FUNCTION_LABELS[code] || code;
    container.append(badge);
  });
  return container;
}

// Employees who said at their first sign-in that they lead a department.
function renderManagerRequests() {
  const box = document.getElementById("managerRequests");
  const requests = adminUsers.filter((user) => user.requested_manager_department_id);
  box.hidden = !requests.length;
  box.replaceChildren();
  if (!requests.length) {
    return;
  }
  const title = document.createElement("h3");
  title.textContent = `Demandes de responsable (${requests.length})`;
  const message = document.createElement("p");
  message.className = "form-message";
  message.setAttribute("role", "status");
  const rows = requests.map((user) => {
    const department = departments.find((candidate) => candidate.id === Number(user.requested_manager_department_id));
    const actions = document.createElement("div");
    actions.className = "product-actions";
    const decide = async (decision, button) => {
      if (decision === "accept" && department?.manager_user_id &&
          !window.confirm(`« ${department.name} » a déjà un responsable (${department.manager_name || department.manager_email}). Le remplacer ?`)) {
        return;
      }
      button.disabled = true;
      try {
        await apiRequest(`/api/admin/manager-requests/${user.id}`, "POST", { decision });
        await loadAdminPanel();
      } catch (error) {
        showMessage(message, error.message, true);
        button.disabled = false;
      }
    };
    [["accept", "Accepter", "button button-small"], ["reject", "Refuser", "button button-danger button-small"]]
      .forEach(([decision, label, className]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className;
        button.textContent = label;
        button.addEventListener("click", () => decide(decision, button));
        actions.append(button);
      });
    return [
      user.full_name || "—",
      user.email,
      department ? department.name : "—",
      department?.manager_user_id ? (department.manager_name || department.manager_email) : "aucun",
      actions
    ];
  });
  box.append(title, buildTable(["Nom", "Courriel", "Demande à diriger", "Responsable actuel", ""], rows, ""), message);
}

function fillAdminFilter(select, placeholder, options) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ""), ...options.map(([value, label]) => new Option(label, value)));
  select.value = [...select.options].some((option) => option.value === previous) ? previous : "";
}

function renderManagerTable() {
  const filter = document.getElementById("managerFilter");
  fillAdminFilter(filter, "Tous les départements", [
    ...departments.map((department) => [String(department.id), department.name]),
    ["none", "Sans département (direction, comptabilité)"]
  ]);
  const summary = document.getElementById("managerFilterSummary");
  const selected = departments.find((department) => String(department.id) === filter.value);
  summary.hidden = !selected;
  if (selected) {
    const manager = adminUsers.find((user) => Number(user.id) === selected.manager_user_id);
    summary.textContent = selected.manager_user_id
      ? `Responsable de ${selected.name} : ${selected.manager_name || selected.manager_email}${manager ? ` (${manager.email})` : ""}`
      : `${selected.name} n’a pas encore de responsable.`;
  }
  const members = staffMembers().filter((user) => {
    if (!filter.value) {
      return true;
    }
    if (filter.value === "none") {
      return !user.department_id;
    }
    // A responsable appears with the department they lead, even when attached elsewhere.
    return String(user.department_id) === filter.value || String(selected?.manager_user_id) === String(user.id);
  });
  const rows = members.map((user) => {
    const department = departments.find((candidate) => candidate.id === Number(user.department_id));
    const led = departments.filter((candidate) => candidate.manager_user_id === Number(user.id));
    const status = document.createElement("span");
    status.className = `availability ${user.is_active ? "active" : "inactive"}`;
    status.textContent = user.is_active ? "Actif" : "Invitation en attente";
    const isAdmin = user.role === "admin";
    return [
      user.full_name || "—",
      user.email,
      department ? department.name : "—",
      roleNames[user.role] || user.role,
      led.length ? led.map((candidate) => candidate.name).join(", ") : "—",
      functionBadges(user.functions),
      status,
      rowActions(
        () => {
          const form = openAdminForm("invitationForm", isAdmin ? "Modifier le directeur" : "Modifier l’employé", "Enregistrer");
          form.elements.userId.value = user.id;
          form.elements.fullName.value = user.full_name || "";
          form.elements.email.value = user.email;
          form.elements.email.disabled = true;
          form.elements.departmentId.value = user.department_id ? String(user.department_id) : "";
          // The director's role is managed from the developer account; others are employee or accountant.
          document.getElementById("staffRoleField").hidden = isAdmin;
          form.elements.role.value = isAdmin ? "employee" : user.role;
          // Only employees must have a department.
          form.elements.departmentId.required = !isAdmin && user.role === "employee";
          form.querySelectorAll('input[name="functions"]').forEach((box) => {
            box.checked = (user.functions || []).includes(box.value);
          });
        },
        // Administrators are added and removed by the developer account only.
        isAdmin ? null : async () => {
          if (!window.confirm(`Supprimer l’employé « ${user.full_name || user.email} » ? Il ne pourra plus se connecter. Ses commandes restent dans l’historique.`)) {
            return;
          }
          if (await runAdminAction("invitationMessage", () => apiRequest(`/api/admin/users/${user.id}`, "DELETE"), "Employé supprimé.")) {
            await loadAdminPanel();
          }
        }
      )
    ];
  });
  document.getElementById("managerTable").replaceChildren(buildTable(
    ["Nom", "Courriel", "Département", "Accès", "Responsable de", "Fonctions", "Statut", ""],
    rows,
    filter.value ? "Aucun employé dans ce département." : "Aucun employé. Cliquez sur « Ajouter un employé » pour en inviter un."
  ));
}

document.getElementById("managerFilter").addEventListener("change", renderManagerTable);

document.getElementById("staffRole").addEventListener("change", (event) => {
  event.currentTarget.form.elements.departmentId.required = event.currentTarget.value === "employee";
});

document.getElementById("addManagerButton").addEventListener("click", () => {
  const form = document.getElementById("invitationForm");
  closeAdminForm(form);
  form.elements.email.disabled = false;
  form.elements.departmentId.required = true;
  document.getElementById("staffRoleField").hidden = true;
  openAdminForm("invitationForm", "Inviter un employé", "Envoyer l’invitation");
});

document.getElementById("invitationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const userId = form.elements.userId.value;
  const fullName = form.elements.fullName.value;
  const departmentId = form.elements.departmentId.value ? Number(form.elements.departmentId.value) : null;
  const functions = [...form.querySelectorAll('input[name="functions"]:checked')].map((box) => box.value);
  button.disabled = true;
  const done = await runAdminAction("invitationMessage", () => (userId
    ? apiRequest(`/api/admin/users/${userId}`, "PATCH", {
      fullName,
      departmentId,
      functions,
      ...(document.getElementById("staffRoleField").hidden ? {} : { role: form.elements.role.value })
    })
    : apiRequest("/api/admin/invitations", "POST", { fullName, email: form.elements.email.value, departmentId, functions })
  ), userId ? "Employé modifié." : "Invitation envoyée.");
  button.disabled = false;
  if (done) {
    form.elements.email.disabled = false;
    closeAdminForm(form);
    await loadAdminPanel();
  }
});

// Départements

function fillManagerSelect(selectedId) {
  const select = document.getElementById("departmentManager");
  select.replaceChildren(new Option("Aucun pour l’instant", ""));
  // Only people who have accepted their invitation can approve purchases.
  staffMembers().filter((user) => user.is_active).forEach((user) => {
    select.add(new Option(user.full_name ? `${user.full_name} (${user.email})` : user.email, user.id));
  });
  select.value = selectedId ? String(selectedId) : "";
}

function renderDepartmentTable() {
  const rows = departments.map((department) => {
    const productCount = products.filter((product) => product.department_id === department.id).length;
    const employeeCount = adminUsers.filter((user) => Number(user.department_id) === department.id).length;
    return [
      department.name,
      department.manager_user_id ? (department.manager_name || department.manager_email) : "— à désigner",
      department.manager_user_id ? department.manager_email || "—" : "—",
      String(employeeCount),
      String(productCount),
      rowActions(
        () => {
          const form = openAdminForm("departmentForm", "Modifier le département", "Enregistrer");
          form.elements.departmentId.value = department.id;
          form.elements.name.value = department.name;
          fillManagerSelect(department.manager_user_id);
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
    ["Département", "Responsable", "Courriel du responsable", "Employés", "Produits", ""],
    rows,
    "Aucun département. Cliquez sur « Ajouter un département » pour en créer un."
  ));
}

document.getElementById("addDepartmentButton").addEventListener("click", () => {
  closeAdminForm(document.getElementById("departmentForm"));
  fillManagerSelect(null);
  openAdminForm("departmentForm", "Ajouter un département", "Ajouter");
});

document.getElementById("departmentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const departmentId = form.elements.departmentId.value;
  const name = form.elements.name.value;
  const managerUserId = form.elements.managerUserId.value ? Number(form.elements.managerUserId.value) : null;
  button.disabled = true;
  const done = await runAdminAction("departmentMessage", async () => {
    const id = departmentId || (await apiRequest("/api/admin/departments", "POST", { name })).department.id;
    if (departmentId || managerUserId) {
      await apiRequest(`/api/admin/departments/${id}`, "PATCH", { name, managerUserId });
    }
  }, departmentId ? "Département modifié." : "Département ajouté.");
  button.disabled = false;
  if (done) {
    closeAdminForm(form);
    await Promise.all([loadAdminPanel(), loadProducts(), loadDashboard()]);
  }
});

// Fournisseurs

function renderAdminProductTable() {
  const departmentFilter = document.getElementById("adminProductDepartment");
  const supplierFilter = document.getElementById("adminProductSupplier");
  fillAdminFilter(departmentFilter, "Tous les départements",
    departments.map((department) => [String(department.id), department.name]));
  fillAdminFilter(supplierFilter, "Tous les fournisseurs", [
    ...adminSuppliers.map((supplier) => [String(supplier.id), supplier.name]),
    ["none", "Sans fournisseur"]
  ]);
  const rows = products
    .filter((product) => !departmentFilter.value || String(product.department_id) === departmentFilter.value)
    .filter((product) => !supplierFilter.value ||
      (supplierFilter.value === "none" ? !product.supplier_id : String(product.supplier_id) === supplierFilter.value))
    .map((product) => {
      const status = document.createElement("span");
      status.className = `availability ${product.is_active ? "active" : "inactive"}`;
      status.textContent = product.is_active ? "Disponible" : "Indisponible";
      return [
        product.name,
        product.sku || "—",
        product.description || "—",
        departments.find((department) => department.id === Number(product.department_id))?.name || "—",
        product.supplier_name || "—",
        product.unit || "unité",
        money(product.price_cents),
        status,
        canEditProduct(product)
          ? rowActions(() => editProductFromList(product), () => deleteProduct(product))
          : ""
      ];
    });
  document.getElementById("adminProductTable").replaceChildren(buildTable(
    ["Produit", "SKU", "Description", "Département", "Fournisseur", "Unité", "Prix unitaire", "Statut", ""],
    rows,
    "Aucun produit pour ce choix."
  ));
}

["adminProductDepartment", "adminProductSupplier"].forEach((id) => {
  document.getElementById(id).addEventListener("change", renderAdminProductTable);
});

// Purchase orders for the director: one per supplier, with who approved each request.
let adminPurchaseOrders = [];

async function loadAdminPurchaseOrders() {
  try {
    adminPurchaseOrders = (await apiRequest("/api/purchase-orders")).purchaseOrders;
    renderAdminPurchaseOrders();
  } catch (error) {
    showMessage(document.getElementById("adminPurchaseMessage"), error.message, "error");
  }
}

function renderAdminPurchaseOrders() {
  // Every purchase order still to transmit, urgent ones first.
  const shown = adminPurchaseOrders.filter((purchaseOrder) => purchaseOrder.status === "open");
  renderPurchaseOrders(
    document.getElementById("adminPurchaseList"),
    sortUrgentFirst(shown),
    "Aucun bon à transmettre pour le moment."
  );
  renderAdminPurchaseHistory();
}

// Historique des bons: transmitted (bought) purchase orders, newest first.
function adminPurchaseHistory() {
  const supplier = document.getElementById("adminPurchaseHistorySupplier").value;
  return adminPurchaseOrders
    .filter((purchaseOrder) => purchaseOrder.status !== "open")
    .filter((purchaseOrder) => !supplier || (purchaseOrder.supplierName || "Fournisseur non précisé") === supplier)
    .sort((a, b) => new Date(b.purchasedAt || b.sentAt || b.createdAt) - new Date(a.purchasedAt || a.sentAt || a.createdAt));
}

function renderAdminPurchaseHistory() {
  const done = adminPurchaseOrders.filter((purchaseOrder) => purchaseOrder.status !== "open");
  fillAdminFilter(document.getElementById("adminPurchaseHistorySupplier"), "Tous les fournisseurs",
    [...new Set(done.map((purchaseOrder) => purchaseOrder.supplierName || "Fournisseur non précisé"))].sort().map((name) => [name, name]));
  const shown = adminPurchaseHistory();
  document.getElementById("adminPurchaseHistorySummary").textContent = shown.length
    ? `${shown.length} bon${shown.length > 1 ? "s" : ""} transmis et acheté${shown.length > 1 ? "s" : ""} · ${money(shown.reduce((total, purchaseOrder) => total + purchaseOrder.totalCents, 0))}`
    : "";
  renderPurchaseOrders(document.getElementById("adminPurchaseHistoryList"), shown, "Aucun bon dans l’historique pour le moment.");
}

document.getElementById("adminPurchaseHistorySupplier").addEventListener("change", renderAdminPurchaseHistory);
document.getElementById("adminPurchaseHistoryDownload").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadAdminPurchaseOrders();
    downloadCsv(`historique-bons-de-commande-${csvDate(new Date()).slice(0, 10)}.csv`, purchaseExportTable(adminPurchaseHistory()));
  } finally {
    button.disabled = false;
  }
});


// Several short values in one table cell, one per line (empty ones skipped).
function stackedCell(values, firstIsTitle = false) {
  const cell = document.createElement("div");
  cell.className = "stacked-cell";
  values.filter((value) => value && value !== "—").forEach((value, index) => {
    const line = document.createElement(firstIsTitle && index === 0 ? "strong" : "span");
    line.append(value);
    cell.append(line);
  });
  return cell.childElementCount ? cell : "—";
}

function authorizedBadge(authorized) {
  const badge = document.createElement("span");
  badge.className = `availability ${authorized ? "active" : "inactive"}`;
  badge.textContent = authorized ? "Oui" : "Non";
  return badge;
}

function renderSupplierTable() {
  document.getElementById("supplierCategoryOptions").replaceChildren(
    ...[...new Set(adminSuppliers.map((supplier) => supplier.category).filter(Boolean))].sort().map((category) => new Option(category))
  );
  const rows = adminSuppliers.map((supplier) => {
    const supplied = products.filter((product) => product.supplier_id === supplier.id);
    const productCount = supplied.length;
    // The departments this supplier serves, through their products.
    const served = [...new Set(supplied.map((product) => product.department_name).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "fr"));
    return [
      stackedCell([supplier.name, supplier.category], true),
      authorizedBadge(supplier.is_authorized !== false),
      stackedCell([supplier.contact_name, supplier.email, phoneWithExtension(supplier.phone, supplier.phone_extension)]),
      stackedCell([ORDER_METHOD_NAMES[supplier.order_method], supplierWebsiteLink(supplier.website)]),
      stackedCell([supplier.account_number ? `Compte : ${supplier.account_number}` : "", supplier.payment_terms, supplier.currency || "CAD"]),
      stackedCell([
        supplier.reduced_threshold_cents !== null ? `Réduite dès ${money(supplier.reduced_threshold_cents)}` : "",
        supplier.free_threshold_cents !== null ? `Gratuite dès ${money(supplier.free_threshold_cents)}` : ""
      ]),
      supplier.note || "—",
      stackedCell([String(productCount), ...served], true),
      rowActions(
        () => {
          const form = openAdminForm("supplierForm", "Modifier le fournisseur", "Enregistrer");
          form.elements.supplierId.value = supplier.id;
          form.elements.name.value = supplier.name;
          form.elements.contactName.value = supplier.contact_name || "";
          form.elements.email.value = supplier.email || "";
          form.elements.phone.value = supplier.phone || "";
          form.elements.website.value = supplier.website || "";
          form.elements.orderMethod.value = supplier.order_method || "";
          form.elements.phoneExtension.value = supplier.phone_extension || "";
          form.elements.note.value = supplier.note || "";
          form.elements.reducedThreshold.value = centsToDollars(supplier.reduced_threshold_cents);
          form.elements.freeThreshold.value = centsToDollars(supplier.free_threshold_cents);
          form.elements.accountNumber.value = supplier.account_number || "";
          form.elements.currency.value = supplier.currency || "CAD";
          form.elements.paymentTerms.value = supplier.payment_terms || "";
          form.elements.isAuthorized.checked = supplier.is_authorized !== false;
          form.elements.category.value = supplier.category || "";
        },
        async () => {
          if (!window.confirm(`Supprimer le fournisseur « ${supplier.name} » ? Ses produits resteront au catalogue, sans fournisseur.`)) {
            return;
          }
          if (await runAdminAction("supplierMessage", () => apiRequest(`/api/admin/suppliers/${supplier.id}`, "DELETE"), "Fournisseur supprimé.")) {
            await Promise.all([reloadSupplierPanel(), loadProducts()]);
          }
        }
      )
    ];
  });
  document.getElementById("supplierTable").replaceChildren(buildTable(
    ["Fournisseur", "Autorisé", "Contact", "Mode de commande", "Compte et paiement", "Seuils de livraison", "Note", "Produits", ""],
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
    phone: form.elements.phone.value,
    phoneExtension: form.elements.phoneExtension.value,
    website: form.elements.website.value,
    orderMethod: form.elements.orderMethod.value,
    note: form.elements.note.value,
    reducedThresholdCents: dollarsToCents(form.elements.reducedThreshold.value),
    freeThresholdCents: dollarsToCents(form.elements.freeThreshold.value),
    accountNumber: form.elements.accountNumber.value,
    currency: form.elements.currency.value,
    paymentTerms: form.elements.paymentTerms.value,
    isAuthorized: form.elements.isAuthorized.checked,
    category: form.elements.category.value
  };
  if (Number.isNaN(body.reducedThresholdCents) || Number.isNaN(body.freeThresholdCents)) {
    showMessage(document.getElementById("supplierMessage"), "Saisissez les seuils en dollars, par exemple 150 ou 149,99.", true);
    return;
  }
  button.disabled = true;
  const done = await runAdminAction("supplierMessage", () => (supplierId
    ? apiRequest(`/api/admin/suppliers/${supplierId}`, "PATCH", body)
    : apiRequest("/api/admin/suppliers", "POST", body)
  ), supplierId ? "Fournisseur modifié." : "Fournisseur ajouté.");
  button.disabled = false;
  if (done) {
    closeAdminForm(form);
    await Promise.all([reloadSupplierPanel(), loadProducts()]);
  }
});

// After a supplier change, reload the panel that shows the supplier cards for this account.
function reloadSupplierPanel() {
  if (currentUser.role === "admin") {
    return loadAdminPanel();
  }
  return currentUser.role === "purchaser" ? loadPurchaserPanel() : loadResponsableSuppliers();
}

// Purchasing administration: purchase orders, supplier cards, products and prices.
async function loadPurchaserPanel() {
  adminSuppliers = (await apiRequest("/api/admin/suppliers")).suppliers;
  document.getElementById("supplierOptions").replaceChildren(...adminSuppliers.map((supplier) => new Option(supplier.name)));
  renderSupplierTable();
  renderAdminProductTable();
  await loadAdminPurchaseOrders();
}

function setupPurchaserPanel() {
  document.getElementById("adminTab").hidden = false;
  document.getElementById("ordersTab").hidden = true;
  document.getElementById("historyTab").hidden = true;
  const directoryItem = document.querySelector('.admin-menu-item[data-admin-section="directorySection"]');
  directoryItem.hidden = false;
  directoryItem.addEventListener("click", () => {
    loadDirectory().catch((error) => {
      document.getElementById("directoryGroups").textContent = error.message;
    });
  });
  // Only the sections of their job; employees and departments stay with the director.
  ["managersSection", "departmentsSection"].forEach((id) => {
    document.querySelector(`.admin-menu-item[data-admin-section="${id}"]`).hidden = true;
  });
  document.querySelector('.admin-menu-item[data-admin-section="adminPurchaseSection"]').click();
}

// Department responsables: the supplier cards in the catalogue ("Fournisseurs", next to
// "Produits"). They have no "Achats" tab (removed 2026-10-21): the purchase orders are
// transmitted by the director and the purchasing administration.
async function loadResponsableSuppliers() {
  adminSuppliers = (await apiRequest("/api/admin/suppliers")).suppliers;
  document.getElementById("supplierOptions").replaceChildren(...adminSuppliers.map((supplier) => new Option(supplier.name)));
  renderSupplierTable();
}

function setupResponsableSuppliers() {
  const suppliers = document.getElementById("suppliersSection");
  suppliers.hidden = false;
  document.getElementById("catalogueSuppliers").append(suppliers);
  document.getElementById("catalogueMenu").hidden = false;
  // The director and the purchasing administration decide which suppliers are authorized.
  document.getElementById("supplierAuthorized").closest("label").hidden = true;
}

const profileDialog = document.getElementById("profileDialog");

// A department responsable is an employee who leads a department.
function displayedRole() {
  return currentUser.role === "employee" && (currentUser.managedDepartments || []).length
    ? "Responsable de département"
    : roleNames[currentUser.role] || currentUser.role;
}

function showAccountName() {
  const name = currentUser.fullName || currentUser.email;
  document.getElementById("accountInfo").textContent = name;
  document.getElementById("accountRole").textContent = displayedRole();
  document.getElementById("accountAvatar").textContent = name
    .split(/[s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

document.getElementById("profileButton").addEventListener("click", () => {
  const form = document.getElementById("profileForm");
  form.elements.fullName.value = currentUser.fullName || "";
  document.getElementById("profileEmail").textContent = currentUser.email;
  document.getElementById("profileRole").textContent = displayedRole();
  const hasDepartment = Boolean(currentUser.departmentName);
  document.getElementById("profileDepartmentLabel").hidden = !hasDepartment;
  document.getElementById("profileDepartment").hidden = !hasDepartment;
  document.getElementById("profileDepartment").textContent = currentUser.departmentName || "";
  const managed = (currentUser.managedDepartments || []).map((department) => department.name);
  if (currentUser.managerRequest) {
    managed.push(`${currentUser.managerRequest.name} (demande en attente de validation)`);
  }
  document.getElementById("profileManagedLabel").hidden = !managed.length;
  document.getElementById("profileManaged").hidden = !managed.length;
  document.getElementById("profileManaged").textContent = managed.join(", ");
  const functionNames = (currentUser.functions || []).map((code) => FUNCTION_LABELS[code] || code);
  document.getElementById("profileFunctionsLabel").hidden = !functionNames.length;
  document.getElementById("profileFunctions").hidden = !functionNames.length;
  document.getElementById("profileFunctions").textContent = functionNames.join(", ");
  showMessage(document.getElementById("profileMessage"), "");
  // Everyone on staff corrects their own department here.
  const departmentField = document.getElementById("profileDepartmentField");
  departmentField.hidden = currentUser.role === "developer";
  if (!departmentField.hidden) {
    const select = document.getElementById("profileDepartmentSelect");
    apiRequest("/api/departments").then(({ departments: list }) => {
      select.replaceChildren(new Option(currentUser.role === "employee" ? "Choisis ton département" : "Aucun", ""));
      list.forEach((department) => select.add(new Option(department.name, department.id)));
      select.value = currentUser.departmentId ? String(currentUser.departmentId) : "";
    }).catch(() => {
      departmentField.hidden = true;
    });
  }
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
    const select = document.getElementById("profileDepartmentSelect");
    const newDepartment = !document.getElementById("profileDepartmentField").hidden && select.value &&
      Number(select.value) !== Number(currentUser.departmentId) ? Number(select.value) : null;
    const { fullName } = await apiRequest("/api/auth/profile", "PATCH", {
      fullName: form.elements.fullName.value,
      ...(newDepartment ? { departmentId: newDepartment } : {})
    });
    currentUser.fullName = fullName;
    showAccountName();
    if (newDepartment) {
      // The catalogue and the requests depend on the department: reload them.
      showMessage(message, "Département modifié. La page va se recharger.");
      setTimeout(() => window.location.reload(), 1200);
      return;
    }
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

// --- Accountant: purchase orders by department, year and month -----------

let reportPurchaseOrders = [];
const REPORT_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

// One row per product line of each request inside each purchase order (a purchase order can
// mix departments; the line keeps the department of its request). Date = purchase date, or
// opening date while not bought yet. A responsable's report keeps only the departments they lead.
function purchaseReportRows() {
  const managed = currentUser.role === "employee"
    ? (currentUser.managedDepartments || []).map((department) => department.name)
    : null;
  return reportPurchaseOrders.flatMap((purchaseOrder) => purchaseOrder.lines.flatMap((line) => line.detail.map((part) => {
    const order = purchaseOrder.orders.find((candidate) => candidate.id === part.orderId) || {};
    const date = new Date(purchaseOrder.purchasedAt || purchaseOrder.createdAt);
    return {
      purchaseOrder,
      number: purchaseOrder.number,
      supplier: purchaseOrder.supplierName || "",
      status: purchaseOrder.status === "open" ? "À transmettre" : "Acheté",
      date,
      department: order.departmentName || "",
      orderNumber: part.orderNumber,
      requester: part.requester || "",
      sku: line.sku || "",
      product: line.productName,
      quantity: part.quantity,
      unit: line.unit || "unité",
      priceCents: line.priceCents,
      subtotalCents: line.priceCents * part.quantity
    };
  }))).filter((row) => !managed || managed.includes(row.department));
}

function filteredReportRows() {
  const department = document.getElementById("poReportDepartment").value;
  const year = document.getElementById("poReportYear").value;
  const month = document.getElementById("poReportMonth").value;
  return purchaseReportRows().filter((row) => (!department || row.department === department) &&
    (!year || row.date.getFullYear() === Number(year)) &&
    (!month || row.date.getMonth() + 1 === Number(month)));
}

function purchaseReportTable(rows) {
  return {
    columns: ["N° bon", "Fournisseur", "Statut", "Date", "Département", "N° demande", "Demandeur", "SKU", "Produit",
      "Quantité", "Unité", "Prix unitaire", "Sous-total"],
    rows: rows.map((row) => [
      row.number, row.supplier, row.status, csvDate(row.date), row.department, row.orderNumber, row.requester,
      row.sku, row.product, row.quantity, row.unit, csvAmount(row.priceCents), csvAmount(row.subtotalCents)
    ])
  };
}

async function loadPurchaseReport() {
  try {
    reportPurchaseOrders = (await apiRequest("/api/purchase-orders")).purchaseOrders;
    const rows = purchaseReportRows();
    fillAdminFilter(document.getElementById("poReportDepartment"), "Tous les départements",
      [...new Set(rows.map((row) => row.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr")).map((name) => [name, name]));
    const years = [...new Set([new Date().getFullYear(), ...rows.map((row) => row.date.getFullYear())])].sort((a, b) => b - a);
    fillAdminFilter(document.getElementById("poReportYear"), "Toutes les années", years.map((year) => [String(year), String(year)]));
    fillAdminFilter(document.getElementById("poReportMonth"), "Tous les mois", REPORT_MONTHS.map((name, index) => [String(index + 1), name]));
    renderPurchaseReport();
  } catch (error) {
    showMessage(document.getElementById("poReportMessage"), error.message, true);
  }
}

function renderPurchaseReport() {
  const rows = filteredReportRows();
  const total = rows.reduce((sum, row) => sum + row.subtotalCents, 0);
  const count = new Set(rows.map((row) => row.number)).size;
  document.getElementById("poReportSummary").textContent =
    `${count} bon${count > 1 ? "s" : ""} de commande · ${rows.length} ligne${rows.length > 1 ? "s" : ""} · ${money(total)}`;
  const groupBy = (key, label) => {
    const groups = new Map();
    rows.forEach((row) => {
      const name = key(row);
      if (!groups.has(name)) {
        groups.set(name, { label: label(row), numbers: new Set(), quantity: 0, totalCents: 0 });
      }
      const group = groups.get(name);
      group.numbers.add(row.number);
      group.totalCents += row.subtotalCents;
    });
    return groups;
  };
  const departments = [...groupBy((row) => row.department || "—", (row) => row.department || "—").values()]
    .sort((a, b) => b.totalCents - a.totalCents);
  document.getElementById("poReportByDepartment").replaceChildren(buildTable(
    ["Département", "Bons de commande", "Montant", "Part"],
    departments.map((group) => [group.label, String(group.numbers.size), money(group.totalCents), total ? `${Math.round((group.totalCents / total) * 100)} %` : "—"]),
    "Aucun bon de commande pour ce choix."
  ));
  const months = [...groupBy(
    (row) => row.date.getFullYear() * 100 + row.date.getMonth(),
    (row) => `${REPORT_MONTHS[row.date.getMonth()]} ${row.date.getFullYear()}`
  ).entries()].sort((a, b) => b[0] - a[0]).map(([, group]) => group);
  document.getElementById("poReportByMonth").replaceChildren(buildTable(
    ["Mois", "Bons de commande", "Montant"],
    months.map((group) => [group.label, String(group.numbers.size), money(group.totalCents)]),
    "Aucun bon de commande pour ce choix."
  ));
  const detail = document.getElementById("poReportDetail");
  if (!detail.hidden) {
    renderTablePreview(detail, purchaseReportTable(rows), "Aucun bon de commande pour ce choix.");
  }
}

["poReportDepartment", "poReportYear", "poReportMonth"].forEach((id) => {
  document.getElementById(id).addEventListener("change", renderPurchaseReport);
});
document.getElementById("poReportPreviewButton").addEventListener("click", (event) => {
  const detail = document.getElementById("poReportDetail");
  detail.hidden = !detail.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!detail.hidden));
  event.currentTarget.textContent = detail.hidden ? "Visualiser le détail" : "Masquer le détail";
  renderPurchaseReport();
});
document.getElementById("poReportDownload").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadPurchaseReport();
    const pick = (id) => document.getElementById(id).selectedOptions[0]?.value ? `-${document.getElementById(id).selectedOptions[0].textContent.toLowerCase().replace(/\s+/g, "-")}` : "";
    downloadCsv(`bons-de-commande${pick("poReportDepartment")}${pick("poReportYear")}${pick("poReportMonth")}.csv`, purchaseReportTable(filteredReportRows()));
  } finally {
    button.disabled = false;
  }
});

// --- Accountant dashboard ------------------------------------------------

const dateOnly = new Intl.DateTimeFormat("fr-CA", { dateStyle: "medium" });
const MONTH_NAMES = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

// The "Achats" part of the "Tableau de bord" tab, for the year chosen at the top.
async function loadAccountingDashboard() {
  const message = document.getElementById("accountingMessage");
  const year = document.getElementById("dashboardYear").value || new Date().getFullYear();
  try {
    const { dashboard } = await apiRequest(`/api/accounting/dashboard?year=${encodeURIComponent(year)}`);
    showMessage(message, "");
    renderAccountingDashboard(dashboard);
  } catch (error) {
    showMessage(message, error.message, true);
  }
}

function renderAccountingDashboard(dashboard) {
  const { requests, purchaseOrders } = dashboard;
  document.getElementById("accountingKpis").replaceChildren(
    kpiTile("Bons à acheter", String(purchaseOrders.openCount), money(purchaseOrders.openCents)),
    kpiTile("Bons achetés", String(purchaseOrders.purchasedCount), money(purchaseOrders.purchasedCents)),
    kpiTile("Demandes approuvées", String(requests.approvedCount), money(requests.approvedCents)),
    kpiTile("Demandes en attente", String(requests.pendingCount), money(requests.pendingCents)),
    kpiTile("Commandes clients", String(requests.clientApprovedCount), `${money(requests.clientApprovedCents)} · hors budget`),
    kpiTile("Demandes refusées", String(requests.rejectedCount), `sur ${requests.count} demande${requests.count > 1 ? "s" : ""}`)
  );

  // Simple bars: approved requests and bought purchase orders per month.
  const highest = Math.max(1, ...dashboard.months.flatMap((month) => [month.approvedCents, month.purchasedCents]));
  document.getElementById("accountingMonths").replaceChildren(...dashboard.months.map((month) => {
    const column = document.createElement("div");
    column.className = "month-column";
    const bars = document.createElement("div");
    bars.className = "month-bars";
    [["approvedCents", "month-bar-approved", "Demandes approuvées"], ["purchasedCents", "month-bar-purchased", "Bons achetés"]].forEach(([key, className, label]) => {
      const bar = document.createElement("span");
      bar.className = `month-bar ${className}`;
      bar.style.height = `${Math.round((month[key] / highest) * 100)}%`;
      bar.title = `${label} : ${money(month[key])}`;
      bars.append(bar);
    });
    const name = document.createElement("span");
    name.className = "month-name";
    name.textContent = MONTH_NAMES[month.month - 1];
    column.append(bars, name);
    column.title = `${MONTH_NAMES[month.month - 1]} : ${money(month.approvedCents)} approuvés, ${money(month.purchasedCents)} achetés`;
    return column;
  }));

  document.getElementById("accountingTopProducts").replaceChildren(buildTable(
    ["Produit", "Fournisseur", "Quantité", "Demandes", "Montant"],
    dashboard.topProducts.map((product) => [
      product.productName, product.supplierName || "—", quantityWithUnit(product.quantity, product.unit), String(product.orderCount), money(product.totalCents)
    ]),
    "Aucune demande approuvée cette année."
  ));
  document.getElementById("accountingSuppliers").replaceChildren(buildTable(
    ["Fournisseur", "Catégorie", "Quantité", "Montant"],
    dashboard.suppliers.map((supplier) => [supplier.supplierName, supplier.category || "—", String(supplier.quantity), money(supplier.totalCents)]),
    "Aucune dépense cette année."
  ));
  document.getElementById("accountingCategories").replaceChildren(buildTable(
    ["Catégorie", "Quantité", "Montant"],
    dashboard.categories.map((category) => [category.category, String(category.quantity), money(category.totalCents)]),
    "Aucune dépense cette année."
  ));
  document.getElementById("accountingPriceIncreases").replaceChildren(buildTable(
    ["Produit", "Fournisseur", "Premier prix", "Depuis le", "Prix actuel", "Hausse"],
    dashboard.priceIncreases.map((entry) => {
      const change = document.createElement("strong");
      change.className = "price-up";
      change.textContent = `+${money(entry.changeCents)}${entry.changePercent === null ? "" : ` (+${String(entry.changePercent).replace(".", ",")} %)`}`;
      return [
        entry.productName, entry.supplierName || "—", money(entry.firstPriceCents),
        dateOnly.format(new Date(entry.firstDate)), money(entry.currentPriceCents), change
      ];
    }),
    "Aucune hausse de prix pour le moment."
  ));
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

  // A responsable's dashboard covers only their department(s): no company totals or client orders.
  if (!dashboard.external) {
    document.getElementById("kpiRow").replaceChildren(
      kpiTile("Budget annuel", budgetCents ? money(budgetCents) : "—", budgetCents ? "Fixé pour l’année" : "Aucun budget fixé"),
      kpiTile(
        "Dépensé",
        money(approvedCents),
        budgetCents ? `${percent(budgetedSpent, budgetCents)} du budget utilisé` : "Demandes approuvées"
      ),
      kpiTile("En attente d’approbation", money(pendingCents), `${pendingOrders} demande${pendingOrders > 1 ? "s" : ""} à traiter`),
      kpiTile(
        "Budget restant",
        budgetCents ? money(remainingCents) : "—",
        remainingCents < 0 ? "Budget dépassé" : "Budget moins les achats approuvés",
        remainingCents < 0
      )
    );
    return;
  }

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
      "Commandes clients",
      money(dashboard.external?.approvedCents || 0),
      `Hors budget · ${dashboard.external?.orders || 0} demande${(dashboard.external?.orders || 0) > 1 ? "s" : ""}${dashboard.external?.pendingCents ? ` · ${money(dashboard.external.pendingCents)} en attente` : ""}`
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
    // A responsable renames their own department here (the director has the Départements section).
    if (currentUser.role === "employee") {
      const rename = document.createElement("button");
      rename.className = "button button-secondary button-small budget-rename";
      rename.type = "button";
      rename.textContent = "Renommer";
      rename.addEventListener("click", () => renameManagedDepartment(department));
      name.append(rename);
    }
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

async function renameManagedDepartment(department) {
  const typed = window.prompt("Nouveau nom du département :", department.name);
  const name = typed === null ? "" : typed.trim();
  if (!name || name === department.name) {
    return;
  }
  const message = document.getElementById("budgetMessage");
  try {
    await apiRequest(`/api/admin/departments/${department.id}`, "PATCH", { name });
    // The new name shows everywhere the department is listed.
    [currentUser.managedDepartments || [], departments].forEach((list) => {
      const entry = list.find((candidate) => Number(candidate.id) === department.id);
      if (entry) {
        entry.name = name;
      }
    });
    fillDepartmentSelect(document.getElementById("productFilter"), "Choisir un département");
    setupTeamInvite();
    showMessage(message, `Département renommé « ${name} ».`);
    await Promise.all([loadDashboard(), loadProducts(), loadStaff()]);
  } catch (error) {
    showMessage(message, error.message, true);
  }
}

async function loadDashboard() {
  const year = document.getElementById("dashboardYear").value || new Date().getFullYear();
  const dashboard = await apiRequest(`/api/admin/dashboard?year=${encodeURIComponent(year)}`);
  renderKpis(dashboard);
  renderBudgetRows(dashboard);
}

// Department responsables: the budget, the purchases and the purchase-order report of the
// department(s) they lead.
function setupResponsableDashboards() {
  setupDashboard(false);
  loadDashboard().catch((error) => showMessage(document.getElementById("budgetMessage"), error.message, true));
  document.getElementById("dashboardEyebrow").textContent = "MON DÉPARTEMENT";
  document.getElementById("purchaseDashboardNote").textContent =
    "Achats de votre département : demandes approuvées (date de la demande) et votre part des bons de commande achetés (date d’achat).";
  const reportTab = document.getElementById("purchaseTab");
  reportTab.hidden = false;
  reportTab.querySelector("span").textContent = "Rapport des bons";
  reportTab.title = "Rapport des bons";
  reportTab.addEventListener("click", loadPurchaseReport);
  document.querySelector("#purchasePanel .eyebrow").textContent = "MON DÉPARTEMENT";
  document.querySelector("#purchasePanel h2").textContent = "Rapport des bons de commande";
}

// The "Tableau de bord" tab: the budgets (director and responsables) and the purchases (also the
// accountant). The director and the accountant open on it; a responsable keeps "Commandes" as
// their first tab.
function setupDashboard(open = true) {
  const select = document.getElementById("dashboardYear");
  const currentYear = new Date().getFullYear();
  for (let year = currentYear; year >= currentYear - 3; year -= 1) {
    select.add(new Option(String(year), String(year)));
  }
  select.addEventListener("change", () => {
    if (seesBudgets()) {
      loadDashboard().catch((error) => showMessage(document.getElementById("budgetMessage"), error.message, true));
    }
    loadAccountingDashboard();
  });
  document.getElementById("budgetDashboard").hidden = !seesBudgets();
  const tab = document.getElementById("homeTab");
  tab.hidden = false;
  // Fresh purchase figures each time the tab is opened.
  tab.addEventListener("click", loadAccountingDashboard);
  if (open) {
    tab.click();
  }
}

async function initialize() {
  try {
    const { user } = await apiRequest("/api/auth/me");
    currentUser = user;
    showAccountName();
    if (user.role === "developer") {
      // The developer only sees the company's administrators.
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.hidden = true;
      });
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
    if (user.role === "accountant" || user.role === "purchaser") {
      // Read only: the whole catalogue; their own requests only with a department.
      document.getElementById("newOrderButton").hidden = !user.departmentId;
      document.getElementById("productForm").hidden = true;
      document.getElementById("productFilterField").hidden = false;
    }
    if (user.role === "employee") {
      document.getElementById("newOrderButton").hidden = false;
      document.getElementById("productForm").hidden = !managedDepartmentIds().length;
      if (managedDepartmentIds().length) {
        // Department responsables see the whole company's staff and manage their own team.
        document.getElementById("staffTab").hidden = false;
        setupTeamInvite();
        loadStaff().catch((error) => {
          document.getElementById("staffTable").textContent = error.message;
        });
        // They also keep the supplier cards, in the catalogue.
        setupResponsableSuppliers();
        loadResponsableSuppliers().catch((error) => {
          document.getElementById("supplierTable").textContent = error.message;
        });
        setupResponsableDashboards();
      }
    } else if (user.role === "admin") {
      document.getElementById("newOrderButton").hidden = false;
      document.getElementById("orderDepartmentField").hidden = false;
      document.getElementById("orderDepartment").required = true;
      document.getElementById("adminTab").hidden = false;
      document.getElementById("productDepartmentField").hidden = false;
      document.getElementById("productDepartment").required = true;
      document.getElementById("productFilterField").hidden = false;
    }
    await Promise.all([loadProducts(), loadOrders()]);
    if (seesPrices()) {
      loadSupplierShipping().catch(() => {
        // Optional help: the request form works without it.
      });
    }
    if (user.role !== "admin") {
      // The department list comes from the catalogue (the department settings are director-only).
      departments = [...new Map(products
        .filter((product) => product.department_id)
        .map((product) => [product.department_id, { id: product.department_id, name: product.department_name }]))
        .values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
      fillDepartmentSelect(document.getElementById("productFilter"), "Choisir un département");
      document.getElementById("productFilterField").hidden = false;
      if (user.role === "purchaser") {
        fillDepartmentSelect(document.getElementById("productDepartment"), "Choisir un département");
        document.getElementById("productDepartmentField").hidden = false;
        document.getElementById("productDepartment").required = true;
      }
      // Opens on the person's own department.
      if (user.departmentId) {
        document.getElementById("productFilter").value = String(user.departmentId);
      }
      renderProducts();
    }
    if (user.role === "accountant") {
      document.getElementById("ordersTab").hidden = true;
      document.getElementById("historyTab").hidden = true;
      document.querySelector('.tab[data-panel="productsPanel"]').hidden = true;
      document.getElementById("purchaseTab").hidden = false;
      document.getElementById("purchaseTab").addEventListener("click", loadPurchaseReport);
      document.getElementById("dashboardEyebrow").textContent = "COMPTABILITÉ";
      setupDashboard();
    }
    if (user.role === "purchaser") {
      setupPurchaserPanel();
      document.getElementById("adminTab").click();
      await loadPurchaserPanel();
    }
    if (user.role === "admin") {
      setupDashboard();
      await Promise.all([loadAdminPanel(), loadDashboard()]);
      // Who decides depends on which departments have a responsable: redraw once they are known.
      renderOrderLists(latestOrders);
    }
    setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshOrders();
      }
    }, NOTIFICATION_POLL_MS);
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        await reloadIfAccountChanged();
        refreshOrders();
      }
    });
    // Coming back to the window (another program, another browser window) checks at once.
    window.addEventListener("focus", () => refreshOrders());
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
