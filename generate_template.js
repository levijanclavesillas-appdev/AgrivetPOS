const fs = require('fs');
const xlsx = require('./src/config/xlsx');
const openingData = require('./src/services/openingDataService');
const workbookService = require('./src/services/openingWorkbookService');

const buffer = fs.readFileSync('docs/Item-Data-2024.3.9_10.37.48.xlsx');
const book = xlsx.readWorkbook(buffer);
const sheet = book.sheets[0];
const rows = sheet.rows;

const productsExample = [['sku', 'name', 'category', 'base_unit', 'retail_price', 'barcode']];
const stockExample = [['sku', 'quantity', 'unit_cost']];
const categoriesSet = new Set();
const suppliersSet = new Set();

for (let i = 1; i < rows.length; i++) {
    const r = rows[i].cells.map(c => c.text);
    if (r.length < 7) continue;
    
    let rawSku = r[0] || ('SKU-' + i);
    let sku = rawSku.replace(/[^A-Z0-9._-]/ig, '_').substring(0, 40).toUpperCase();
    
    let rawName = r[1] || 'Unknown';
    let name = rawName.trim().substring(0, 120);
    if (name.length < 2) name += ' Item';
    
    let category = r[3] || 'Default Category';
    category = category.trim().substring(0, 120);
    
    let price = r[4] || '0';
    let cost = r[5] || '0';
    let qty = r[6] || '0';
    let vendor = r[7] || '';
    
    let barcode = rawSku; // Original SKU was used as barcode
    barcode = barcode.replace(/\s+/g, '').replace(/[^0-9A-Za-z._-]/g, ''); // Remove invalid characters
    
    if (barcode.length < 4 || /^(02|2[0-9])/.test(barcode)) {
        barcode = ''; // Omit invalid barcodes
    }
    
    productsExample.push([sku, name, category, 'PC', price, barcode]);
    
    let parsedQty = parseFloat(qty) || 0;
    if (parsedQty > 0) {
        stockExample.push([sku, qty, cost]);
    }
    
    if (category) categoriesSet.add(category);
    if (vendor) suppliersSet.add(vendor);
}

// Ensure the related sheets are populated
const categoriesExample = [['name', 'max_discount_percent']];
for (const cat of categoriesSet) {
    categoriesExample.push([cat, '']);
}

const suppliersExample = [['name', 'code', 'contact_person', 'contact_no', 'terms_days', 'address']];
for (const sup of suppliersSet) {
    if (sup.trim() !== '') {
        suppliersExample.push([sup, '', '', '', '', '']);
    }
}

// Units must have PC
const unitsExample = [['code', 'name', 'fractions'], ['PC', 'Piece', '']];

openingData.KINDS.products.example = productsExample;
openingData.KINDS.stock.example = stockExample;
openingData.KINDS.categories.example = categoriesExample;
openingData.KINDS.units.example = unitsExample;
openingData.KINDS.suppliers.example = suppliersExample;

// Clear unused tabs
openingData.KINDS.brands.example = [openingData.KINDS.brands.example[0]];
openingData.KINDS.packs.example = [openingData.KINDS.packs.example[0]];
openingData.KINDS.balances.example = [openingData.KINDS.balances.example[0]];

const outPath = 'docs/Sari-Sari-Opening-Data-Filled.xlsx';
const wbBuffer = workbookService.workbook({ industry: 'RETAIL' });
fs.writeFileSync(outPath, wbBuffer);

console.log("Successfully generated", outPath);
