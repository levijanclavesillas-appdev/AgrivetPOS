const fs = require('fs');
const xlsx = require('./src/config/xlsx');
const ExcelJS = require('./scratch/node_modules/exceljs');

async function run() {
    const buffer = fs.readFileSync('docs/Item-Data-2024.3.9_10.37.48.xlsx');
    const book = xlsx.readWorkbook(buffer);
    const sheet = book.sheets[0];
    const rows = sheet.rows;

    const productsExample = [['sku', 'name', 'category', 'base_unit', 'retail_price', 'barcode']];
    productsExample.push(['required', 'required', 'required', 'required', 'required', 'optional']);
    
    const stockExample = [['sku', 'quantity', 'unit_cost']];
    stockExample.push(['required', 'required', 'required']);
    
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

    const categoriesExample = [['name', 'max_discount_percent'], ['required', 'optional']];
    for (const cat of categoriesSet) {
        categoriesExample.push([cat, '']);
    }

    const suppliersExample = [['name', 'code', 'contact_person', 'contact_no', 'terms_days', 'address'], ['required', 'optional', 'optional', 'optional', 'optional', 'optional']];
    for (const sup of suppliersSet) {
        if (sup.trim() !== '') {
            suppliersExample.push([sup, '', '', '', '', '']);
        }
    }

    const unitsExample = [['code', 'name', 'fractions'], ['required', 'required', 'optional'], ['PC', 'Piece', '']];
    const brandsExample = [['name'], ['required']];
    const packsExample = [['sku', 'unit', 'contains', 'default_sell', 'barcode', 'retail_price', 'wholesale_price'], ['required', 'required', 'required', 'optional', 'optional', 'optional', 'optional']];
    const balancesExample = [['name', 'balance_centavos'], ['required', 'required']];

    const outWb = new ExcelJS.Workbook();
    
    function addSheet(name, data) {
        const ws = outWb.addWorksheet(name);
        ws.addRows(data);
    }

    addSheet('Categories', categoriesExample);
    addSheet('Units', unitsExample);
    addSheet('Brands', brandsExample);
    addSheet('Suppliers', suppliersExample);
    addSheet('Products', productsExample);
    addSheet('Packs', packsExample);
    addSheet('Opening stock', stockExample);
    addSheet('Credit balances', balancesExample);
    
    const outPath = 'docs/Sari-Sari-Opening-Data-Filled.xlsx';
    await outWb.xlsx.writeFile(outPath);
    console.log("Successfully generated", outPath);
}

run().catch(console.error);
