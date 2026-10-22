// The purchase order as sent to the supplier: a plain text version (text message, copy,
// website form), an HTML version (email, preview, print) and a PDF file (download). Internal
// details (who asked, departments) stay out of it.


const PDFDocument = require("pdfkit");
const { quantityWithUnit } = require("./units");

const dateFormat = new Intl.DateTimeFormat("fr-CA", { dateStyle: "long", timeZone: "America/Toronto" });

// What every version of the purchase order shows.
function documentFacts(purchaseOrder, sender) {
  const supplier = purchaseOrder.supplier || {};
  const currencyCode = supplier.currency || "CAD";
  return {
    supplierName: purchaseOrder.supplierName || "Fournisseur",
    supplier,
    money: new Intl.NumberFormat("fr-CA", { style: "currency", currency: currencyCode }),
    terms: [
      supplier.accountNumber ? ["N° de compte client", supplier.accountNumber] : null,
      supplier.paymentTerms ? ["Conditions de paiement", supplier.paymentTerms] : null,
      ["Devise", currencyCode]
    ].filter(Boolean),
    // Prices are shown only once the catalogue has them.
    showPrices: purchaseOrder.totalCents > 0,
    date: dateFormat.format(new Date()),
    contact: [sender.name, sender.email].filter(Boolean).join(" · ")
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function purchaseOrderDocument(purchaseOrder, { note = "", sender = {} } = {}) {
  const { supplierName, supplier, money, terms, showPrices, date, contact } = documentFacts(purchaseOrder, sender);
  const subject = `Bon de commande ${purchaseOrder.number} – Promographe`;

  const text = [
    `BON DE COMMANDE ${purchaseOrder.number}`,
    `Promographe – ${date}`,
    `Fournisseur : ${supplierName}`,
    ...terms.map(([label, value]) => `${label} : ${value}`),
    "",
    ...purchaseOrder.lines.map((line) => {
      const sku = line.sku ? `SKU ${line.sku} – ` : "";
      const code = line.description ? ` (${line.description})` : "";
      const price = showPrices ? ` – ${money.format(line.priceCents / 100)} / ${line.unit || "unité"}` : "";
      return `- ${quantityWithUnit(line.quantity, line.unit)} – ${sku}${line.productName}${code}${price}`;
    }),
    ...(showPrices ? ["", `Total : ${money.format(purchaseOrder.totalCents / 100)}`] : []),
    ...(note ? ["", `Note : ${note}`] : []),
    "",
    `Merci de confirmer la commande${contact ? ` à ${contact}` : ""}.`
  ].join("\n");

  const cell = "padding:8px;border-bottom:1px solid #d8dee6;text-align:left";
  const number = `${cell};text-align:right`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;max-width:720px">
  <h1 style="font-size:22px;margin:0 0 4px">Bon de commande ${escapeHtml(purchaseOrder.number)}</h1>
  <p style="margin:0 0 16px;color:#596879">Promographe · ${escapeHtml(date)}</p>
  <p style="margin:0 0 16px"><strong>Fournisseur :</strong> ${escapeHtml(supplierName)}${supplier.contactName ? `<br>À l’attention de ${escapeHtml(supplier.contactName)}` : ""}</p>
  <p style="margin:0 0 16px">${terms.map(([label, value]) => `<strong>${escapeHtml(label)} :</strong> ${escapeHtml(value)}`).join("<br>")}</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <thead><tr>
      <th style="${cell}">SKU</th><th style="${cell}">Produit</th><th style="${number}">Quantité</th><th style="${cell}">Unité</th>
      ${showPrices ? `<th style="${number}">Prix unitaire</th><th style="${number}">Sous-total</th>` : ""}
    </tr></thead>
    <tbody>
      ${purchaseOrder.lines.map((line) => `<tr>
        <td style="${cell}">${escapeHtml(line.sku || "—")}</td>
        <td style="${cell}">${escapeHtml(line.productName)}${line.description ? `<br><span style="color:#596879;font-size:12px">${escapeHtml(line.description)}</span>` : ""}</td>
        <td style="${number}">${line.quantity}</td>
        <td style="${cell}">${escapeHtml(line.unit || "unité")}</td>
        ${showPrices ? `<td style="${number}">${money.format(line.priceCents / 100)}</td><td style="${number}">${money.format((line.priceCents * line.quantity) / 100)}</td>` : ""}
      </tr>`).join("")}
    </tbody>
    ${showPrices ? `<tfoot><tr><td style="${cell}" colspan="5"><strong>Total</strong></td><td style="${number}"><strong>${money.format(purchaseOrder.totalCents / 100)}</strong></td></tr></tfoot>` : ""}
  </table>
  ${note ? `<p style="margin:16px 0 0"><strong>Note :</strong> ${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : ""}
  <p style="margin:16px 0 0">Merci de confirmer la commande${contact ? ` à ${escapeHtml(contact)}` : ""}.</p>
</div>`;

  return { subject, text, html };
}

// The same purchase order as a PDF file (letter size), resolved as a Buffer.
function purchaseOrderPdf(purchaseOrder, { note = "", sender = {} } = {}) {
  const { supplierName, supplier, money, terms, showPrices, date, contact } = documentFacts(purchaseOrder, sender);
  // The standard PDF fonts have no narrow no-break space (French number formatting).
  const clean = (value) => String(value ?? "").replace(/ /g, " ");
  const amount = (cents) => clean(money.format(cents / 100));
  const pdf = new PDFDocument({
    size: "LETTER",
    margin: 50,
    info: { Title: `Bon de commande ${purchaseOrder.number}`, Author: "Promographe" }
  });
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  const ink = "#1f2933";
  const left = pdf.page.margins.left;
  const width = pdf.page.width - left - pdf.page.margins.right;
  const labelled = (label, value) => {
    pdf.font("Helvetica-Bold").text(clean(`${label} : `), { continued: true }).font("Helvetica").text(clean(value));
  };

  pdf.font("Helvetica-Bold").fontSize(18).fillColor(ink).text(clean(`Bon de commande ${purchaseOrder.number}`));
  pdf.font("Helvetica").fontSize(10).fillColor("#596879").text(clean(`Promographe · ${date}`));
  pdf.moveDown().fontSize(11).fillColor(ink);
  labelled("Fournisseur", supplierName);
  if (supplier.contactName) {
    pdf.text(clean(`À l’attention de ${supplier.contactName}`));
  }
  pdf.moveDown(0.5);
  terms.forEach(([label, value]) => labelled(label, value));
  pdf.moveDown();

  // The table: column widths as shares of the page, header repeated on each new page.
  const columns = (showPrices
    ? [["SKU", 0.15], ["Produit", 0.33], ["Quantité", 0.1, "right"], ["Unité", 0.1],
      ["Prix unitaire", 0.15, "right"], ["Sous-total", 0.17, "right"]]
    : [["SKU", 0.2], ["Produit", 0.5], ["Quantité", 0.15, "right"], ["Unité", 0.15]]
  ).map(([label, share, align = "left"]) => ({ label, width: width * share, align }));
  const padding = 4;
  const row = (cells, bold = false) => {
    pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
    const height = padding * 2 + Math.max(...cells.map((cell, index) => (
      pdf.heightOfString(clean(cell), { width: columns[index].width - padding * 2 })
    )));
    if (pdf.y + height > pdf.page.height - pdf.page.margins.bottom) {
      pdf.addPage();
      if (cells !== header) {
        row(header, true);
      }
      pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
    }
    const top = pdf.y;
    let x = left;
    cells.forEach((cell, index) => {
      const { width: cellWidth, align } = columns[index];
      pdf.fillColor(ink).text(clean(cell), x + padding, top + padding, { width: cellWidth - padding * 2, align });
      x += cellWidth;
    });
    pdf.moveTo(left, top + height).lineTo(left + width, top + height).lineWidth(0.5).strokeColor("#d8dee6").stroke();
    pdf.x = left;
    pdf.y = top + height;
  };
  const header = columns.map((column) => column.label);
  row(header, true);
  purchaseOrder.lines.forEach((line) => {
    row([
      line.sku || "—",
      line.description ? `${line.productName}\n${line.description}` : line.productName,
      String(line.quantity),
      line.unit || "unité",
      ...(showPrices ? [amount(line.priceCents), amount(line.priceCents * line.quantity)] : [])
    ]);
  });
  if (showPrices) {
    row(["Total", "", "", "", "", amount(purchaseOrder.totalCents)], true);
  }

  pdf.moveDown().fontSize(11).fillColor(ink);
  if (note) {
    labelled("Note", note);
    pdf.moveDown(0.5);
  }
  pdf.font("Helvetica").text(clean(`Merci de confirmer la commande${contact ? ` à ${contact}` : ""}.`));
  pdf.end();
  return finished;
}

module.exports = { purchaseOrderDocument, purchaseOrderPdf };
