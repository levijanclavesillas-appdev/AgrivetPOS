'use strict';

// The kinds of store Chachi POS is set up for — TASK-053.
//
// **One application, the industry chosen at setup.** Until TASK-053 there were two
// products on two branches, Chachi Agrivet POS (`main`) and Chachi Pharmacy POS
// (`pharmacy`), and a store installed whichever it was sold. A Play Store listing is one
// app, so the product is now one: Chachi POS, with the store's industry recorded in
// `store_profile.industry` by the setup wizard and fixed from then on (the owner's
// decision, 2026-09-15: a store set up as the wrong kind is set up again).
//
// **What an industry decides is small, and deliberately so.** Every feature — generic
// names, batches and expiry, pictures, packs, credit, the subscription — is in every
// store; a hardware store may never type a generic name, and the field costs it nothing.
// An industry decides only the *defaults* a store would otherwise have to find and
// change on day one, and the words the store sees:
//
//   settings        seeded at setup from here (settingsService.seedDefaults), and
//                   editable afterwards like any other setting
//   productDefaults the ticks a new product starts with in the editor (P-2) — the
//                   server default stays off, so the spreadsheet stays explicit
//   customerType    the type the opening balance load gives a customer
//   examples        the example beside each column of the opening spreadsheet
//
// `available: false` industries are shown in the wizard as coming soon and refused by
// the server; they are listed so the public site, the wizard and this file agree on
// what is coming.

const INDUSTRIES = Object.freeze({
  PHARMACY: Object.freeze({
    code: 'PHARMACY',
    label: 'Pharmacy',
    blurb: 'Over-the-counter drugstores and botika',
    icon: 'pill',
    available: true,
    settings: Object.freeze({
      // P-1: RA 9994 and RA 10754 name medicines for the beneficiary's own use first,
      // so for a drugstore the discount applies from the day it opens.
      statutory_discount_enabled: true,
      return_reasons: Object.freeze([
        'Wrong item sold',
        'Wrong item bought',
        'Damaged on arrival',
        'Expired stock',
        'Seal broken or packaging tampered',
        'Adverse reaction reported',
        'Duplicate purchase',
        'Customer changed their mind',
      ]),
      // POS-304: a medicine that left the counter is one whose storage nobody can vouch
      // for, so what is filed under these defaults to write-off on a return.
      return_write_off_categories: Object.freeze([
        'Medicines',
        'OTC Medicines',
        'Vitamins',
        'Supplements',
        'Vitamins & Supplements',
        'Vaccines',
        'Biologics',
      ]),
    }),
    // P-2: nearly everything on a drugstore shelf needs both, and forgetting batch
    // tracking cannot be undone once stock arrives (INV-207).
    productDefaults: Object.freeze({ isBatchTracked: true, statutoryDiscountEligible: true }),
    // A drugstore's account customers are regulars — a clinic, a health centre, a
    // family on a tab — not farms.
    customerType: 'REGULAR',
    // The Read me tab's examples, in the store's own stock.
    readme: Object.freeze({
      categories: 'Medicines, Vitamins, Personal Care',
      units: 'TAB, CAP, BOX, BOT, ML',
      fractions: 'only for units that can be sold in part, like millilitres. Tablets and boxes cannot.',
      generic: 'generic_name: the generic on the box — Paracetamol for Biogesic. Leave blank if it has none.',
      batch: ['batch_tracked: write yes for goods sold by expiry date — medicines, vitamins. Leave blank for',
        'goods with no expiry, like cotton balls. This cannot be changed once the stock is loaded.'],
      senior: ['senior_pwd: write yes for goods the senior citizen / PWD 20% discount covers — medicines and',
        'vitamins for the buyer’s own use. Leave blank for the rest.'],
      pack: 'One row per pack: PARA-500, BOX, 100 means one box holds 100 tablets. The product is still',
    }),
    examples: Object.freeze({
      categories: { name: 'Medicines' },
      units: { code: 'TAB', name: 'Tablet' },
      brands: { name: 'Sample Pharma' },
      suppliers: { name: 'Mindanao Pharma Supply', code: 'MPS', contact_person: 'Ana Cruz', contact_no: '09171234567', terms_days: '30', address: 'Koronadal City' },
      products: {
        sku: 'PARA-500', name: 'Paracetamol 500mg tablet', category: 'Medicines', base_unit: 'TAB', retail_price: '4.50',
        generic_name: 'Paracetamol', brand: 'Sample Pharma', tax_class: 'VATABLE', min_stock: '200', barcode: '4800012345678',
        batch_tracked: 'yes', senior_pwd: 'yes',
      },
      packs: { sku: 'PARA-500', unit: 'BOX', contains: '100', barcode: '4800012345685' },
      stock: { sku: 'PARA-500', quantity: '1000', unit_cost: '2.80', note: 'Counted 1 Sep', batch_no: 'P24091', expiry_date: '2027-08-31', supplier: 'Mindanao Pharma Supply' },
      balances: { customer: 'Barangay Health Center', balance: '12500.00', code: 'BHC', contact_no: '09171234567', credit_limit: '50000.00', terms_days: '30', note: 'From the blue notebook' },
    }),
  }),
  AGRIVET: Object.freeze({
    code: 'AGRIVET',
    label: 'Agrivet',
    blurb: 'Feed, seed, fertilizer and veterinary supply',
    icon: 'sprout',
    available: true,
    settings: Object.freeze({
      // TAX-004 is a question for the store's accountant here: feed for a farm is not
      // for the beneficiary's own use. Built and tested; turning it on is the owner's.
      statutory_discount_enabled: false,
      return_reasons: Object.freeze([
        'Wrong item sold',
        'Wrong item bought',
        'Damaged on arrival',
        'Expired stock',
        'Animal refused the feed',
        'Duplicate purchase',
        'Customer changed their mind',
      ]),
      return_write_off_categories: Object.freeze([
        'Veterinary',
        'Veterinary Medicines',
        'Medicines',
        'Vaccines',
        'Biologics',
      ]),
    }),
    productDefaults: Object.freeze({ isBatchTracked: false, statutoryDiscountEligible: false }),
    customerType: 'FARM',
    readme: Object.freeze({
      categories: 'Feeds, Veterinary, Seeds',
      units: 'KG, SACK, PC, L',
      fractions: 'only for units that can be sold in part, like kilograms and litres. Sacks and pieces cannot.',
      generic: 'generic_name: the active ingredient on the label — Ivermectin for a dewormer. Leave blank if none.',
      batch: ['batch_tracked: write yes for goods sold by expiry date — vaccines, veterinary medicines. Leave',
        'blank for goods with no expiry, like feed by the kilo. This cannot be changed once stock is loaded.'],
      senior: ['senior_pwd: write yes only for goods the senior citizen / PWD 20% discount covers. Feed for a',
        'farm is not for the buyer’s own use — ask the store’s accountant before writing yes.'],
      pack: 'One row per pack: HG-50, SACK, 50 means one sack holds 50 kilograms. The product is still',
    }),
    examples: Object.freeze({
      categories: { name: 'Feeds' },
      units: { code: 'KG', name: 'Kilogram', fractions: 'yes' },
      brands: { name: 'Sample Feeds' },
      suppliers: { name: 'Mindanao Feeds Supply', code: 'MFS', contact_person: 'Ben Reyes', contact_no: '09171234567', terms_days: '30', address: 'Koronadal City' },
      products: {
        sku: 'HG-50', name: 'Hog Grower Pellets', category: 'Feeds', base_unit: 'KG', retail_price: '52.00',
        brand: 'Sample Feeds', wholesale_price: '50.00', tax_class: 'VATABLE', min_stock: '100', barcode: '4800012345678',
      },
      packs: { sku: 'HG-50', unit: 'SACK', contains: '50', barcode: '4800098765432' },
      stock: { sku: 'HG-50', quantity: '1000', unit_cost: '45.00', note: 'Counted 1 Sep' },
      balances: { customer: 'Santos Farm', balance: '12500.00', code: 'SF', contact_no: '09171234567', credit_limit: '50000.00', terms_days: '30', note: 'From the blue notebook' },
    }),
  }),
  // TASK-066: the store owner, 2026-09-16 — "another type on set up as cafe/restaurant
  // beside agrivet, pharmacy". The first is a café that takes an order at the table,
  // sends it to the kitchen and is paid when the customer leaves.
  CAFE: Object.freeze({
    code: 'CAFE',
    label: 'Café / Restaurant',
    blurb: 'Cafés, restaurants, eateries and food stalls',
    icon: 'coffee',
    available: true,
    settings: Object.freeze({
      // TAX-004: RA 9994 and RA 10754 name restaurant meals for the beneficiary's own
      // use, so a café grants the 20% from the day it opens, as a drugstore does.
      statutory_discount_enabled: true,
      // POS-109 and POS-110: orders are taken before they are paid, and the kitchen is
      // told on the receipt printer until the owner gives it a printer of its own.
      open_orders_enabled: true,
      kitchen_printer: 'RECEIPT',
      return_reasons: Object.freeze([
        'Wrong order served',
        'Not as ordered',
        'Food spoiled or undercooked',
        'Foreign object found',
        'Served twice',
        'Customer changed their mind',
      ]),
      // POS-304: food that has left the kitchen is never put back on a shelf. A made-to-
      // order product moves no stock either way (INV-114); this covers a bottled drink or
      // a packed pastry filed under these.
      return_write_off_categories: Object.freeze([
        'Food',
        'Meals',
        'Pastries',
        'Desserts',
      ]),
    }),
    // INV-114: a menu item is cooked or poured when it is ordered, so a new product starts
    // made to order; a bottled drink is the one the owner unticks.
    productDefaults: Object.freeze({ isBatchTracked: false, statutoryDiscountEligible: true, isStocked: false }),
    // A café's account customers are regulars — an office that orders lunch on a tab.
    customerType: 'REGULAR',
    readme: Object.freeze({
      categories: 'Rice Bowls, Coffee, Pastries',
      units: 'SRV (serving), CUP, PC, BOT',
      fractions: 'only for units that can be sold in part, like kilograms. Servings and cups cannot.',
      generic: 'generic_name: leave blank. It is for medicines.',
      batch: ['batch_tracked: leave blank. It is for goods sold by expiry date, like medicines.'],
      senior: ['senior_pwd: write yes for food and drinks the senior citizen / PWD 20% discount covers —',
        'meals for the buyer’s own use. Leave blank for the rest.'],
      madeToOrder: ['made_to_order: write yes for what the kitchen makes when it is ordered — meals, coffee.',
        'The system keeps no stock of it. Leave blank for what you buy and sell as it is, like bottled drinks.'],
      pack: 'One row per pack: WATER-500, CASE, 24 means one case holds 24 bottles. The product is still',
    }),
    examples: Object.freeze({
      categories: { name: 'Rice Bowls' },
      units: { code: 'SRV', name: 'Serving' },
      brands: { name: 'House' },
      suppliers: { name: 'Mindanao Food Supply', code: 'MFS', contact_person: 'Carla Diaz', contact_no: '09171234567', terms_days: '15', address: 'Koronadal City' },
      products: {
        sku: 'BIBIMBAP', name: 'Bibimbap', category: 'Rice Bowls', base_unit: 'SRV', retail_price: '115.00',
        generic_name: '', brand: '', wholesale_price: '', dealer_price: '', tax_class: 'VATABLE', min_stock: '',
        barcode: '', batch_tracked: '', senior_pwd: 'yes', made_to_order: 'yes',
      },
      packs: { sku: 'WATER-500', unit: 'CASE', contains: '24', barcode: '4800098765432' },
      stock: { sku: 'WATER-500', quantity: '48', unit_cost: '12.00', note: 'Counted 1 Sep', batch_no: '', expiry_date: '', supplier: '' },
      balances: { customer: 'Koronadal Credit Office', balance: '3500.00', code: 'KCO', contact_no: '09171234567', credit_limit: '10000.00', terms_days: '15', note: 'From the blue notebook' },
    }),
  }),
  MOTORCYCLE: Object.freeze({
    code: 'MOTORCYCLE', label: 'Motorcycle shop', blurb: 'Parts, accessories and service shops',
    icon: 'motorbike', available: false,
  }),
  RETAIL: Object.freeze({
    code: 'RETAIL', label: 'Wholesale & retail', blurb: 'Groceries, general merchandise and distributors',
    icon: 'store', available: false,
  }),
});

const CODES = Object.freeze(Object.keys(INDUSTRIES));
const AVAILABLE = Object.freeze(CODES.filter((code) => INDUSTRIES[code].available));

/** The one name the product has, and the industry beside it where a store is known. */
const PRODUCT_NAME = 'Chachi POS';

function get(code) {
  return INDUSTRIES[code] || null;
}

/** "Chachi POS (Pharmacy)" — the sign-in screen's line under the store's name. */
function displayName(code) {
  const industry = get(code);
  return industry ? `${PRODUCT_NAME} (${industry.label})` : PRODUCT_NAME;
}

/** What the renderer and the public setup status may know: never the settings. */
function describe(code) {
  const industry = get(code);
  if (!industry) return null;
  return {
    code: industry.code,
    label: industry.label,
    icon: industry.icon,
    display_name: displayName(code),
    product_defaults: industry.productDefaults || null,
  };
}

/** Every industry, as the setup wizard offers them — the unavailable ones marked. */
function catalogue() {
  return CODES.map((code) => {
    const i = INDUSTRIES[code];
    return { code, label: i.label, blurb: i.blurb, icon: i.icon, available: i.available };
  });
}

module.exports = { INDUSTRIES, CODES, AVAILABLE, PRODUCT_NAME, get, displayName, describe, catalogue };
