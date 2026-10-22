// Units of measure for products, with their plural for quantities ("3 rouleaux").
const UNITS = {
  "unité": "unités",
  "boîte": "boîtes",
  "caisse": "caisses",
  "paquet": "paquets",
  "rouleau": "rouleaux",
  "litre": "litres",
  "kilogramme": "kilogrammes",
  "gallon": "gallons",
  "cône": "cônes",
  "verge": "verges",
  "mètre": "mètres",
  "ensemble": "ensembles",
  "heure": "heures"
};

function quantityWithUnit(quantity, unit) {
  const name = UNITS[unit] ? unit : "unité";
  return `${quantity} ${quantity > 1 ? UNITS[name] : name}`;
}

module.exports = { UNITS, quantityWithUnit };
