// Accountant dashboard: purchase orders, spending, most ordered products and price increases,
// computed from the requests (their lines keep the price at the time of the request).

const yearFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit" });

function yearMonth(value) {
  const parts = Object.fromEntries(yearFormat.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month) };
}

function buildAccountingDashboard({ orders, purchaseOrders, products, suppliers = [], year }) {
  const categoryOf = new Map(suppliers.map((supplier) => [supplier.name, supplier.category || ""]));
  const inYear = (value) => value && yearMonth(value).year === year;
  const yearOrders = orders.filter((order) => inYear(order.createdAt));
  const approved = yearOrders.filter((order) => order.status === "approved");
  const clientApproved = approved.filter((order) => order.isExternal);
  const pending = yearOrders.filter((order) => order.status === "pending");
  const sum = (list, value) => list.reduce((total, entry) => total + value(entry), 0);

  const openPurchaseOrders = purchaseOrders.filter((purchaseOrder) => purchaseOrder.status !== "purchased");
  const boughtPurchaseOrders = purchaseOrders.filter((purchaseOrder) => purchaseOrder.status === "purchased" && inYear(purchaseOrder.purchasedAt));

  // Spending per month: approved requests (request date) and bought purchase orders (purchase date).
  const months = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, approvedCents: 0, purchasedCents: 0 }));
  approved.forEach((order) => {
    months[yearMonth(order.createdAt).month - 1].approvedCents += order.totalCents;
  });
  boughtPurchaseOrders.forEach((purchaseOrder) => {
    months[yearMonth(purchaseOrder.purchasedAt).month - 1].purchasedCents += purchaseOrder.totalCents;
  });

  // Most ordered products and suppliers, from the approved requests of the year.
  const productTotals = new Map();
  const supplierTotals = new Map();
  const categoryTotals = new Map();
  approved.forEach((order) => {
    order.items.forEach((item) => {
      const key = `${item.productId}`;
      if (!productTotals.has(key)) {
        productTotals.set(key, {
          productName: item.productName,
          supplierName: item.supplierName || null,
          unit: item.unit || "unité",
          quantity: 0,
          orderIds: new Set(),
          totalCents: 0
        });
      }
      const product = productTotals.get(key);
      product.quantity += item.quantity;
      product.orderIds.add(order.id);
      product.totalCents += item.priceCents * item.quantity;

      const supplierName = item.supplierName || "Fournisseur non précisé";
      if (!supplierTotals.has(supplierName)) {
        supplierTotals.set(supplierName, { supplierName, quantity: 0, totalCents: 0 });
      }
      supplierTotals.get(supplierName).quantity += item.quantity;
      supplierTotals.get(supplierName).totalCents += item.priceCents * item.quantity;

      const category = categoryOf.get(item.supplierName) || "Sans catégorie";
      if (!categoryTotals.has(category)) {
        categoryTotals.set(category, { category, quantity: 0, totalCents: 0 });
      }
      categoryTotals.get(category).quantity += item.quantity;
      categoryTotals.get(category).totalCents += item.priceCents * item.quantity;
    });
  });
  const topProducts = [...productTotals.values()]
    .map(({ orderIds, ...product }) => ({ ...product, orderCount: orderIds.size }))
    .sort((a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents)
    .slice(0, 10);
  const supplierSpending = [...supplierTotals.values()]
    .map((supplier) => ({ ...supplier, category: categoryOf.get(supplier.supplierName) || "" }))
    .sort((a, b) => b.totalCents - a.totalCents);
  const categories = [...categoryTotals.values()].sort((a, b) => b.totalCents - a.totalCents);

  // Price increases: the first price paid for a product compared with its current catalogue
  // price (or the last price paid when it left the catalogue).
  const catalogue = new Map(products.map((product) => [Number(product.id), product]));
  const history = new Map();
  [...orders]
    .filter((order) => order.status !== "rejected")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .forEach((order) => {
      order.items.forEach((item) => {
        if (!history.has(item.productId)) {
          history.set(item.productId, {
            productName: item.productName,
            supplierName: item.supplierName || null,
            firstPriceCents: item.priceCents,
            firstDate: order.createdAt,
            lastPriceCents: item.priceCents
          });
        }
        history.get(item.productId).lastPriceCents = item.priceCents;
      });
    });
  const priceIncreases = [...history.entries()]
    .map(([productId, entry]) => {
      const current = catalogue.get(Number(productId));
      const currentPriceCents = current ? current.price_cents : entry.lastPriceCents;
      const changeCents = currentPriceCents - entry.firstPriceCents;
      return {
        productName: current ? current.name : entry.productName,
        supplierName: current ? current.supplier_name || entry.supplierName : entry.supplierName,
        firstPriceCents: entry.firstPriceCents,
        firstDate: entry.firstDate,
        currentPriceCents,
        changeCents,
        changePercent: entry.firstPriceCents > 0 ? Math.round((changeCents / entry.firstPriceCents) * 1000) / 10 : null
      };
    })
    .filter((entry) => entry.changeCents > 0)
    .sort((a, b) => (b.changePercent ?? Infinity) - (a.changePercent ?? Infinity) || b.changeCents - a.changeCents);

  return {
    year,
    requests: {
      count: yearOrders.length,
      approvedCount: approved.length,
      approvedCents: sum(approved, (order) => order.totalCents),
      pendingCount: pending.length,
      pendingCents: sum(pending, (order) => order.totalCents),
      rejectedCount: yearOrders.filter((order) => order.status === "rejected").length,
      clientApprovedCount: clientApproved.length,
      clientApprovedCents: sum(clientApproved, (order) => order.totalCents)
    },
    purchaseOrders: {
      openCount: openPurchaseOrders.length,
      openCents: sum(openPurchaseOrders, (purchaseOrder) => purchaseOrder.totalCents),
      purchasedCount: boughtPurchaseOrders.length,
      purchasedCents: sum(boughtPurchaseOrders, (purchaseOrder) => purchaseOrder.totalCents)
    },
    months,
    topProducts,
    suppliers: supplierSpending,
    categories,
    priceIncreases
  };
}

// The part of each purchase order that comes from the given requests (a responsable's
// departments): its lines and requests limited to those requests, its total recomputed.
function purchaseOrderShares(purchaseOrders, orders) {
  const orderIds = new Set(orders.map((order) => Number(order.id)));
  return purchaseOrders
    .map((purchaseOrder) => {
      const lines = purchaseOrder.lines
        .map((line) => ({ ...line, detail: line.detail.filter((part) => orderIds.has(Number(part.orderId))) }))
        .filter((line) => line.detail.length)
        .map((line) => ({ ...line, quantity: line.detail.reduce((total, part) => total + part.quantity, 0) }));
      const included = purchaseOrder.orders.filter((order) => orderIds.has(Number(order.id)));
      return {
        ...purchaseOrder,
        lines,
        orders: included,
        isUrgent: included.some((order) => order.isUrgent),
        totalCents: lines.reduce((total, line) => total + line.priceCents * line.quantity, 0)
      };
    })
    .filter((purchaseOrder) => purchaseOrder.lines.length);
}

module.exports = { buildAccountingDashboard, purchaseOrderShares };
