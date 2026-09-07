# Product Requirements Document (PRD)

# Agrivet Store POS & Inventory Management System

**Document Version:** 1.1
**Date:** September 7, 2026
**System Type:** Internal Business Operations System
**Target Market:** Philippines
**Primary Business:** Agrivet Store / Veterinary Supply / Feeds Retail
**Initial Database:** SQLite
**Future Database:** PostgreSQL
**Platforms:** Desktop and Mobile
**Architecture:** Local-first / Offline-capable
**Document Status:** Product Requirements

---

# 1. Product Overview

The Agrivet Store POS & Inventory Management System is an internal business management application designed for an agrivet store that purchases products wholesale and sells them primarily at retail.

The store sells products including:

* Animal feeds
* Veterinary medicines
* Animal supplements
* Vitamins
* Agricultural and veterinary supplies
* Other related products

The system will manage the complete operational flow:

```text
Supplier
   ↓
Wholesale Purchasing
   ↓
Goods Receiving
   ↓
Inventory
   ↓
Retail / Wholesale Sales
   ↓
Payment
   ↓
Customer Credit / Accounts Receivable
   ↓
Collection
   ↓
Reporting
```

The system is intended for **internal business operations**.

It is not initially intended to be:

* A public e-commerce platform
* A full accounting system
* A banking/payment wallet
* A BIR tax filing system
* A system for issuing Official Receipts

The application may generate internal transaction records or sales receipts for operational purposes. These must not be represented as BIR Official Receipts or tax invoices unless the system is later expanded to support the applicable Philippine invoicing requirements.

---

# 2. Product Vision

Provide the agrivet store with a simple, reliable, offline-capable system that allows the business owner and staff to control:

> **Purchasing → Inventory → Pricing → Sales → Payments → Customer Credit → Collections**

while maintaining complete and portable business data.

The initial system should be lightweight enough to operate using SQLite while being architected for eventual migration to PostgreSQL when the business requires centralized multi-device or multi-branch operation.

---

# 3. Business Objectives

## 3.1 Improve Sales Processing

The system should allow staff to process transactions quickly using:

* Barcode scanning
* Product search
* Quantity entry
* Customer selection
* Automatic pricing
* Transaction-based discounts
* Manual authorized discounts
* Cash payments
* GCash payments
* QR Ph payments
* Credit sales

---

## 3.2 Improve Inventory Control

The system should provide accurate visibility of:

* Current stock
* Stock received
* Stock sold
* Stock returned
* Damaged stock
* Expired stock
* Inventory adjustments
* Stock value
* Low-stock products
* Near-expiry products

---

## 3.3 Improve Purchasing

The system should allow the business to track wholesale purchases from suppliers.

The purchasing workflow should be:

```text
Supplier
   ↓
Purchase Order
   ↓
Goods Received
   ↓
Inventory Updated
```

---

## 3.4 Manage Customer Credit

The system should allow selected customers to purchase products on credit.

It should manage:

* Credit limits
* Credit sales
* Outstanding balances
* Partial payments
* Payment history
* Due dates
* Customer statements
* Overdue accounts

---

## 3.5 Improve Pricing and Discounts

The system should allow the owner to configure different pricing strategies.

Examples:

* Retail price
* Wholesale price
* Dealer price
* Customer-specific price
* Quantity-based price
* Transaction-based discount
* Promotional discount

---

## 3.6 Improve Business Visibility

The owner should be able to see:

* Daily sales
* Monthly sales
* Sales by product
* Sales by category
* Sales by cashier
* Payment breakdown
* Credit sales
* Outstanding customer balances
* Inventory levels
* Estimated gross profit
* Fast-moving products
* Slow-moving products
* Near-expiry products

---

# 4. Target Users

## 4.1 Owner / Administrator

Full system access.

Responsibilities:

* Manage users
* Manage products
* Manage prices
* Manage suppliers
* Manage customers
* Manage credit limits
* Manage discounts
* Manage inventory
* Review purchases
* Review sales
* Review collections
* View reports
* Configure system settings
* Perform data backup/export
* Restore/import data

---

## 4.2 Manager

Operational management access.

Can:

* Process or supervise sales
* Approve discounts
* Manage customers
* Manage credit
* Receive inventory
* Perform stock adjustments
* Process returns
* View reports
* Review cashier closing

Cannot normally:

* Delete transactions
* Modify critical system configuration
* Manage administrator accounts

---

## 4.3 Cashier / Sales Staff

Primary responsibilities:

* Process POS transactions
* Search products
* Scan products
* Select customers
* Accept payments
* Record GCash payments
* Record QR Ph payments
* Process credit sales
* Receive customer credit payments
* Apply authorized discounts

Cannot normally:

* Change product cost
* Change standard selling prices
* Delete completed sales
* Modify inventory directly
* Change credit limits
* Configure system settings

---

## 4.4 Inventory Staff

Responsibilities:

* Receive products
* Record goods received
* Manage stock
* Perform stock counts
* Record damaged products
* Record expired products
* Perform authorized stock adjustments

---

# 5. Platform Requirements

The application shall support:

* Desktop devices
* Tablets
* Mobile devices

The UI shall be responsive and adapt to different screen sizes.

## 5.1 Operating Systems

* **Desktop:** Windows 10 / Windows 11
* **Mobile/Tablet:** Android 12+ (iOS support is optional for the MVP)

## 5.2 Hardware Integrations

The system shall support the following POS hardware:

* **Receipt Printers:** Thermal printers (58mm and 80mm) connected via USB, Bluetooth, or LAN.
* **Cash Drawers:** Standard RJ11 cash drawers driven by the receipt printer. The system should automatically trigger the drawer to open upon completing a cash sale.
* **Barcode Scanners:** USB and Bluetooth 1D/2D scanners. Scanning a barcode should automatically add the item to the cart.
* **Weighing Scales:** Manual entry for the MVP. Future versions may support direct RS232/USB integration.

## 5.3 Desktop Priorities

Desktop interface should prioritize:

* POS
* Inventory
* Purchasing
* Reports
* Administration

## 5.4 Mobile Priorities

Mobile interface should prioritize:

* POS
* Product lookup
* Inventory lookup
* Stock receiving
* Stock counting
* Customer lookup
* Credit collection
* Sales monitoring

---

# 6. Local-First Architecture

The initial version shall use SQLite as its primary database.

The application should remain functional for core business operations when internet connectivity is unavailable.

```text
                 DEVICE
                    │
             Application
                    │
                 SQLite
                    │
          Local Business Data
```

Internet access should not be required for:

* Cash sales
* Product lookup
* Inventory lookup
* Credit sales
* Customer lookup
* Stock management
* Sales history
* Reporting

Internet may be required for:

* External payment verification
* Cloud backup, if implemented
* Future synchronization
* Future centralized PostgreSQL deployment

---

# 7. Future PostgreSQL Architecture

The system must be designed so SQLite can eventually be replaced or synchronized with PostgreSQL.

Future architecture:

```text
 Desktop
    │
 Mobile
    │
 Tablet
    │
    ▼
 Application / API
    │
    ▼
 PostgreSQL
```

This future architecture will support:

* Multiple devices
* Centralized data
* Multiple cashiers
* Multiple branches
* Centralized reporting
* Cloud backup
* Multi-location inventory

---

# 8. Database Portability Requirements

The application must not become permanently dependent on SQLite.

Business logic must be separated from database implementation.

Recommended structure:

```text
UI
 ↓
Business Logic
 ↓
Repository / Data Access Layer
 ↓
Database Provider
```

Initial implementation:

```text
Repository
    ↓
SQLite
```

Future implementation:

```text
Repository
    ↓
PostgreSQL
```

---

# 9. Unique Identifiers

Core business entities should use globally unique identifiers.

Recommended approach:

* UUID
* ULID
* Another globally unique identifier

This is important for future:

* Data migration
* Device synchronization
* PostgreSQL migration
* Multi-branch support

Entities requiring stable IDs include:

* Products
* Customers
* Suppliers
* Sales
* Sale items
* Payments
* Purchases
* Inventory movements
* Credit transactions
* Users

---

# 10. Data Export

The application shall provide complete data export functionality.

Users with appropriate permission can export:

* Products
* Categories
* Customers
* Suppliers
* Purchases
* Sales
* Payments
* Inventory
* Inventory movements
* Credit accounts
* Credit payments
* Discounts
* Users
* Audit logs

---

# 11. Export Formats

The preferred migration format is:

**JSON**

Secondary formats:

* CSV
* Database backup

Example:

```text
agrivet_backup_2026-09-07.zip

├── manifest.json
├── products.json
├── categories.json
├── customers.json
├── suppliers.json
├── purchases.json
├── purchase_items.json
├── sales.json
├── sale_items.json
├── payments.json
├── inventory.json
├── inventory_movements.json
├── credit_accounts.json
├── credit_transactions.json
├── credit_payments.json
└── audit_logs.json
```

---

# 12. Data Import / Restore

The system shall support importing a previously exported backup.

Workflow:

```text
Import Backup
      ↓
Validate File
      ↓
Validate Data
      ↓
Show Import Summary
      ↓
Create Current Backup
      ↓
Confirm
      ↓
Import
```

The system should automatically create a backup before replacing or modifying existing data.

---

# 13. Product Management

Each product shall have:

| Field           | Requirement  |
| --------------- | ------------ |
| Product ID      | Required     |
| SKU             | Required     |
| Barcode         | Optional     |
| Product Name    | Required     |
| Category        | Required     |
| Brand           | Optional     |
| Description     | Optional     |
| Unit            | Required     |
| Purchase Cost   | Required     |
| Retail Price    | Required     |
| Wholesale Price | Optional     |
| Dealer Price    | Optional     |
| Minimum Stock   | Required     |
| Expiry Tracking | Configurable |
| Batch Tracking  | Configurable |
| Active Status   | Required     |

---

# 14. Product Categories

The system shall support configurable product categories.

Initial categories may include:

* Animal Feeds
* Veterinary Medicine
* Vitamins
* Supplements
* Dewormers
* Antibiotics
* Vaccines
* Pet Food
* Farm Supplies
* Veterinary Supplies
* Other

The administrator may create additional categories.

---

# 15. Product Units

The system shall support units such as:

* Piece
* Bottle
* Box
* Sack
* Bag
* Kilogram
* Gram
* Liter
* Milliliter
* Pack
* Case

---

# 16. Packaging and Unit Conversion

The system should support product packaging conversions.

Example:

```text
1 Sack = 50 KG
```

A product may be configured to sell by:

* Sack
* KG

Example:

```text
Inventory:
10 sacks
=
500 KG
```

The conversion factor must be configurable.

---

# 17. Product Pricing

Products should support multiple pricing levels.

Example:

| Price Type |  Price |
| ---------- | -----: |
| Retail     | ₱1,650 |
| Wholesale  | ₱1,600 |
| Dealer     | ₱1,550 |

The administrator can configure which price level applies to a customer.

---

# 18. Customer-Specific Pricing

Selected customers may have special prices.

Example:

```text
Customer:
ABC Farm

Hog Feed:
Standard: ₱1,650
Customer Price: ₱1,580
```

Customer-specific pricing should take precedence over the standard price when applicable.

---

# 19. Inventory Management

Inventory must be updated automatically based on business transactions.

## Inventory Increases

* Purchase receiving
* Customer return
* Stock adjustment
* Stock transfer

## Inventory Decreases

* POS sale
* Supplier return
* Damaged goods
* Expired goods
* Internal use
* Stock adjustment
* Stock transfer

---

# 20. Inventory Movement Ledger

Every inventory movement should be recorded.

Example:

| Date   | Type     | Qty | Reference | Balance |
| ------ | -------- | --: | --------- | ------: |
| Sept 1 | Purchase | +50 | GRN-001   |      50 |
| Sept 2 | Sale     |  -5 | SALE-001  |      45 |
| Sept 3 | Sale     | -10 | SALE-002  |      35 |
| Sept 4 | Damage   |  -2 | ADJ-001   |      33 |

The inventory ledger should be auditable.

---

# 21. Batch Tracking

Batch tracking should be available for products where required or useful.

Batch information may include:

* Batch number
* Product
* Supplier
* Purchase date
* Expiry date
* Quantity
* Unit cost

---

# 22. Expiry Management

The system shall support expiry monitoring.

Statuses:

```text
NORMAL
NEAR_EXPIRY
EXPIRED
```

The owner should be able to configure the near-expiry threshold.

Default:

**90 days**

---

# 23. FEFO

For medicines and supplements, the system should support:

**First Expired, First Out**

The system should prioritize batches with the earliest expiry date.

Expired products should normally be prevented from sale.

An authorized manager/owner may override this only where business rules permit.

---

# 24. Purchasing

The purchasing module shall manage wholesale procurement.

Workflow:

```text
Supplier
 ↓
Purchase Order
 ↓
Goods Received
 ↓
Inventory
```

---

# 25. Purchase Order

Purchase orders should contain:

* PO number
* Supplier
* Date
* Expected delivery date
* Products
* Quantity
* Unit cost
* Total cost
* Notes
* Status

Statuses:

```text
DRAFT
PENDING
PARTIALLY_RECEIVED
RECEIVED
CANCELLED
```

---

# 26. Goods Receiving

Staff shall be able to receive products against a purchase order.

The receiving process should allow staff to record:

* Ordered quantity
* Received quantity
* Damaged quantity
* Batch
* Expiry
* Unit cost
* Supplier reference

Only the actual received quantity should increase inventory.

---

# 27. Supplier Management

Supplier records shall include:

* Supplier ID
* Supplier name
* Contact person
* Phone
* Email
* Address
* Payment terms
* Notes
* Active status

The system should maintain supplier purchase history.

---

# 28. Supplier Payables

Supplier accounts payable may be included as a Phase 2 feature.

The system should eventually support:

* Purchase on account
* Supplier payment
* Outstanding balance
* Partial payment
* Supplier statement

---

# 29. Point of Sale

The POS shall be optimized for fast transaction processing.

Primary workflow:

```text
Open POS
 ↓
Search / Scan Product
 ↓
Enter Quantity
 ↓
Select Customer
 ↓
Apply Price
 ↓
Apply Discount
 ↓
Select Payment
 ↓
Confirm
 ↓
Complete Sale
 ↓
Update Inventory
```

---

# 30. Barcode Scanning

The system shall support:

* USB barcode scanners
* Bluetooth barcode scanners
* Camera-based scanning where supported

Scanning a valid barcode should automatically add the corresponding product to the transaction.

---

# 31. POS Cart

The cart should display:

* Product
* Quantity
* Unit price
* Discount
* Line total
* Stock availability

## 31.1 Fractional Quantities

Because the store sells feeds and supplies by weight, the system must fully support **fractional and decimal quantities** (e.g., selling 1.25 KG of feed). The UI and database must accommodate decimal values for quantities and accurately calculate totals and inventory deductions based on these fractional amounts.

The system should calculate:

```text
Subtotal
- Discount
= Total
```

---

# 32. Payment Methods

The system shall support:

1. Cash
2. GCash
3. QR Ph
4. Credit
5. Other configurable payment methods

---

# 33. Cash Payment

Cash transaction should record:

* Amount due
* Amount received
* Change

Example:

```text
Amount Due: ₱3,750
Cash: ₱4,000
Change: ₱250
```

---

# 34. Till / Cash Management (Cash In / Out)

The POS system shall support recording non-sale cash movements to maintain accurate drawer balances.

*   **Cash In:** Adding cash to the till (e.g., initial float, additional change provided).
*   **Cash Out:** Removing cash from the till (e.g., owner withdrawals, petty cash for store supplies, paying delivery fees).

Each entry must record:
* Amount
* Reason / Description
* User/Cashier
* Date/Time

---

# 35. GCash Payment

For the initial version, GCash payments may be recorded manually.

Required information:

* Payment method
* Amount
* Reference number
* Date/time
* Cashier

Example:

```text
Payment Method: GCash
Amount: ₱2,500
Reference: 123456789
```

The application does not need direct GCash API integration for the MVP.

---

# 36. QR Ph Payment

The system shall support recording QR Ph payments.

Required information:

* Payment method
* Amount
* Reference number
* Date/time
* Cashier

Future versions may support direct payment-provider integration if the selected payment provider provides an appropriate API.

---

# 37. Offline Payment Handling

Cash payments shall work fully offline.

GCash and QR Ph transactions may be recorded offline if the cashier can verify the payment externally.

The system should mark such transactions as:

```text
RECORDED
```

rather than claiming automatic payment verification unless an actual payment API confirms the transaction.

---

# 38. Customer Management

Customer records should include:

* Customer ID
* Customer name
* Contact number
* Address
* Customer type
* Price level
* Credit eligibility
* Credit limit
* Payment terms
* Notes
* Active status

---

# 39. Customer Types

Initial customer types:

* Walk-in
* Retail Customer
* Regular Customer
* Credit Customer
* Wholesale Customer
* Dealer
* Farm / Business

---

# 40. Customer Credit

Credit functionality shall be integrated directly into POS.

At checkout:

```text
Payment Method:

○ Cash
○ GCash
○ QR Ph
● Credit
```

The system shall verify the customer's credit status.

---

# 41. Credit Limit

Each credit customer may have:

* Credit limit
* Current balance
* Available credit
* Payment terms
* Due date

Example:

```text
Credit Limit:       ₱20,000
Current Balance:     ₱8,500
Available Credit:   ₱11,500
```

---

# 42. Credit Sale Validation

Before approving a credit transaction:

```text
Current Outstanding Balance
+
New Credit Sale
≤
Credit Limit
```

If the transaction exceeds the credit limit:

> Manager/Owner approval required.

---

# 43. Credit Payment

Customers may make:

* Full payments
* Partial payments

Example:

```text
Outstanding: ₱10,000

Payment: ₱3,000

Remaining: ₱7,000
```

Every payment must be recorded separately.

---

# 44. Customer Statement

The system shall generate customer statements.

Example:

```text
CUSTOMER STATEMENT

Customer: Juan Dela Cruz

Date       Transaction       Debit    Credit   Balance
--------------------------------------------------------
Sept 1     Feed Purchase     5,000             5,000
Sept 5     Feed Purchase     3,000             8,000
Sept 10    Payment                     3,000    5,000
--------------------------------------------------------

Outstanding Balance: ₱5,000
```

---

# 45. Credit Due Dates

Credit transactions should support due dates.

Examples:

* COD / immediate
* 7 days
* 15 days
* 30 days
* custom date

The system should identify:

```text
CURRENT
DUE_SOON
OVERDUE
PAID
```

---

# 46. Credit Collection

The collection screen should show:

* Customer
* Outstanding balance
* Due amount
* Due date
* Days overdue
* Payment history

Users should be able to record a payment directly from the customer account.

---

# 47. Transaction-Based Discounts

The system shall support configurable transaction-based discounts.

Example:

| Transaction Total | Discount |
| ----------------: | -------: |
|         ₱0–₱4,999 |       0% |
|     ₱5,000–₱9,999 |       2% |
|   ₱10,000–₱19,999 |       3% |
|          ₱20,000+ |       5% |

The owner can change these rules.

---

# 48. Quantity-Based Discounts

Optional quantity-based discounts should be supported.

Example:

```text
1–4 sacks      ₱1,650
5–9 sacks      ₱1,620
10+ sacks      ₱1,580
```

---

# 49. Product-Level Discounts

Products may have maximum discount limits.

Example:

```text
Feed:
Maximum discount: 5%

Medicine:
Maximum discount: 2%

Supplement:
Maximum discount: 5%
```

---

# 50. Discount Authorization

Discount authority shall depend on user role.

Example:

| Role    | Maximum Discount |
| ------- | ---------------: |
| Cashier |               2% |
| Manager |               5% |
| Owner   |     Configurable |

Manual discounts must be logged.

---

# 51. Discount Audit

Every manual discount should record:

* Transaction
* Product/transaction affected
* Original amount
* Discount
* User
* Date/time
* Reason
* Approver where applicable

---

# 52. Sales Returns

The system shall support product returns.

Workflow:

```text
Original Sale
 ↓
Select Item
 ↓
Enter Return Quantity
 ↓
Select Reason
 ↓
Approve
 ↓
Inventory Adjustment
 ↓
Refund / Customer Credit
```

Return reasons:

* Wrong product
* Damaged product
* Defective product
* Customer cancellation
* Other

Medicine return handling should follow store policy and applicable requirements before returning products to sellable inventory.

---

# 53. Sales Voiding

Completed sales must not simply be deleted.

Authorized users may:

* Void
* Return
* Correct through an adjustment

Voided transactions must remain in the audit trail.

---

# 54. Inventory Adjustments

Authorized users may adjust inventory.

Reasons:

* Damaged
* Expired
* Lost
* Physical count variance
* Internal use
* Sample
* Other

Example:

```text
System Stock: 50
Physical Stock: 48

Adjustment: -2
Reason: Damaged
```

---

# 55. Stock Counting

The system shall support physical inventory counts.

Workflow:

```text
Create Stock Count
 ↓
Count Physical Products
 ↓
Enter Actual Quantity
 ↓
Calculate Variance
 ↓
Review
 ↓
Approve
 ↓
Update Inventory
```

---

# 56. Low Stock

Each product shall have a minimum stock threshold.

Example:

```text
Product:
Dog Food 10kg

Current Stock: 5
Minimum Stock: 10

Status:
LOW STOCK
```

The dashboard should show low-stock products.

---

# 57. Sales Reports

Reports should include:

## Daily Sales

* Gross sales
* Discounts
* Returns
* Net sales
* Payment breakdown

## Monthly Sales

* Sales by day
* Sales by category
* Sales by product

## Sales by Cashier

* Transactions
* Sales amount
* Discounts
* Returns
* Cash variance

---

# 58. Payment Reports

Payment reports should include:

* Cash
* GCash
* QR Ph
* Credit
* Other

Example:

| Payment Method |  Amount |
| -------------- | ------: |
| Cash           | ₱25,000 |
| GCash          | ₱10,500 |
| QR Ph          |  ₱5,000 |
| Credit         |  ₱8,000 |

---

# 59. Inventory Reports

Reports should include:

* Current stock
* Stock valuation
* Stock movement
* Low stock
* Near expiry
* Expired products
* Damaged products
* Inventory variance

---

# 60. Profitability Reports

The system should calculate estimated gross profit.

Example:

```text
Selling Price: ₱1,650
Cost:          ₱1,500

Gross Profit:  ₱150
```

Reports:

* Sales
* Cost of goods sold
* Gross profit
* Gross margin
* Discounts

Profit calculations should use the configured inventory costing method.

---

# 61. Inventory Costing

The initial system should support a defined costing method.

Recommended:

**FIFO / Batch-based costing**

For products with expiry:

**FEFO for stock rotation**

The costing method must be documented before implementation of the financial reports.

---

# 62. Cashier Shift

Cashiers should be able to:

```text
Open Shift
 ↓
Process Transactions
 ↓
Close Shift
```

Opening information may include:

* Cashier
* Date
* Opening cash

---

# 63. End-of-Day Closing

Cashier closing should calculate expected totals.

Example:

```text
Expected Cash: ₱25,500
Actual Cash:   ₱25,300

Variance: -₱200
```

The system should record:

* Cash sales
* GCash sales
* QR Ph sales
* Credit sales
* Returns
* Discounts
* Cash In / Cash Out (Petty Cash)
* Expected cash
* Actual cash
* Variance

---

# 64. Payment Reconciliation

The system should provide a reconciliation report.

Example:

| Method | Recorded |  Actual | Variance |
| ------ | -------: | ------: | -------: |
| Cash   |  ₱25,000 | ₱25,000 |       ₱0 |
| GCash  |  ₱10,500 | ₱10,500 |       ₱0 |
| QR Ph  |   ₱5,000 |  ₱4,500 |    -₱500 |

---

# 65. Internal Transaction Receipt

The system may generate an internal sales receipt.

It should include:

* Store name
* Transaction number
* Date/time
* Cashier
* Customer
* Products
* Quantity
* Price
* Discount
* Total
* Payment method
* Reference number

The receipt should clearly be treated as an internal transaction record and should not be represented as an Official Receipt or tax invoice unless the system is later configured for the applicable legal requirements.

---

# 66. Transaction Numbering

Transactions shall have unique identifiers.

Examples:

```text
SALE-20260907-000123

PO-20260907-000021

GRN-20260907-000015

PAY-20260907-000034

RET-20260907-000008

ADJ-20260907-000005
```

The underlying database identifier should remain globally unique even if the human-readable transaction number is formatted separately.

---

# 67. Audit Trail

The system shall record important business actions.

Audit events include:

* Price changes
* Discount changes
* Inventory adjustments
* Sales voids
* Returns
* Credit limit changes
* Customer changes
* Product changes
* User changes
* Data imports
* Data exports

Audit record:

```text
Date/Time
User
Action
Entity
Entity ID
Old Value
New Value
Reason
```

---

# 68. User Permissions

| Feature     | Owner |    Manager | Cashier | Inventory |
| ----------- | ----: | ---------: | ------: | --------: |
| POS         |     ✓ |          ✓ |       ✓ |         - |
| Products    |     ✓ |          ✓ |    View |         ✓ |
| Purchasing  |     ✓ |          ✓ |       - |         ✓ |
| Inventory   |     ✓ |          ✓ |    View |         ✓ |
| Discounts   |     ✓ |          ✓ | Limited |         - |
| Customers   |     ✓ |          ✓ |       ✓ |      View |
| Credit      |     ✓ |          ✓ |  Create |      View |
| Collections |     ✓ |          ✓ |       ✓ |         - |
| Reports     |     ✓ |          ✓ | Limited | Inventory |
| Users       |     ✓ |          - |       - |         - |
| Settings    |     ✓ |    Limited |       - |         - |
| Data Export |     ✓ | Authorized |       - |         - |
| Data Import |     ✓ |          - |       - |         - |

---

# 69. Dashboard

The main dashboard should display:

## Sales

* Today's sales
* Today's transactions
* Monthly sales
* Average transaction

## Payments

* Cash
* GCash
* QR Ph
* Credit

## Credit

* Total outstanding
* Due soon
* Overdue

## Inventory

* Total products
* Low stock
* Near expiry
* Expired

## Purchasing

* Recent purchases
* Pending purchase orders

---

# 70. Search

The system should support fast search by:

* Product name
* SKU
* Barcode
* Brand
* Category

Customer search:

* Customer name
* Phone
* Customer ID

Supplier search:

* Supplier name
* Contact information

---

# 71. Notifications and Alerts

The system should provide internal alerts for:

* Low stock
* Near expiry
* Expired products
* Overdue credit
* Credit limit exceeded
* Pending purchase orders
* Unreconciled payments
* Cashier variance
* Backup overdue

---

# 72. Database Health

The system should provide:

```text
Database Status: Healthy

Database Size: 48 MB

Products: 1,250
Customers: 820
Transactions: 15,240

Last Backup:
Sept 7, 2026 08:30 AM

Last Export:
Sept 6, 2026 06:00 PM
```

Warnings should include:

> No backup created within the configured backup period.

---

# 73. Backup

The application should allow users to create local backups.

Backup should contain the complete operational database.

Recommended backup naming:

```text
agrivet_backup_YYYY-MM-DD_HH-mm.zip
```

Backups should be stored outside the application's primary database directory when possible.

---

# 74. Data Integrity

The system must prevent:

* Duplicate transaction IDs
* Duplicate product identifiers
* Negative inventory where not permitted
* Invalid payment amounts
* Invalid credit transactions
* Invalid stock adjustments
* Broken references between transactions and products

Database transactions should be used for operations that modify multiple related records.

For example:

```text
Complete Sale
   ↓
Create Sale
   ↓
Create Sale Items
   ↓
Create Payment
   ↓
Create Inventory Movements
   ↓
Update Inventory
   ↓
Commit
```

If any critical operation fails, the entire transaction should roll back.

---

# 75. Security

The application shall provide:

* User authentication
* Role-based permissions
* Secure password storage
* Session management
* Automatic logout
* Audit logging
* Restricted administrative actions

Passwords must never be stored as plaintext.

---

# 76. Offline Security

Because the application is local-first, the local database should be protected from casual unauthorized access.

Recommended measures:

* Application authentication
* OS-level access controls
* Database encryption where practical
* Protected backup files
* Restricted administrator functions

---

# 77. Data Privacy

Customer information should be limited to information necessary for business operations.

The system should avoid unnecessarily storing:

* Payment card information
* Banking credentials
* GCash credentials
* Sensitive authentication information

GCash/QR Ph transactions should store transaction/reference information rather than payment account credentials.

---

# 78. Business Rules

## BR-001 — Completed Sales

Completed sales cannot be deleted.

They can only be:

* Voided
* Returned
* Corrected through authorized adjustments

---

## BR-002 — Inventory

Every completed sale must generate inventory movement records.

---

## BR-003 — Credit Sales

Credit sales require a registered customer.

---

## BR-004 — Credit Limit

Customers exceeding their credit limit require authorized approval.

---

## BR-005 — Discounts

Users cannot exceed their configured discount authority.

---

## BR-006 — Price Changes

Cashiers cannot change standard product prices.

---

## BR-007 — Expired Products

Expired products should not normally be sold.

---

## BR-008 — Inventory Adjustment

Inventory adjustments require a reason and authorized user.

---

## BR-009 — GCash

GCash transactions should record a reference number when available.

---

## BR-010 — QR Ph

QR Ph transactions should record a reference number when available.

---

## BR-011 — Credit Payment

Every credit payment must be associated with a customer credit account.

---

## BR-012 — Audit

Critical modifications must create an audit record.

---

## BR-013 — Data Import

Imported data must be validated before being committed.

---

## BR-014 — Backup

A backup should be created before major data restoration/import operations.

---

# 79. Core Database Entities

Initial database entities should include:

```text
users
roles
permissions

products
categories
brands
units
product_barcodes
product_prices

suppliers
purchase_orders
purchase_order_items
goods_receipts
goods_receipt_items

inventory
inventory_batches
inventory_movements

customers
customer_credit_accounts
customer_credit_transactions
customer_payments

sales
sale_items
sale_payments
sale_discounts
sales_returns
sales_return_items

discount_rules

cashier_shifts
cashier_closings
till_cash_movements

audit_logs
system_settings
```

---

# 80. High-Level Entity Relationships

```text
CATEGORY
   │
   └── PRODUCTS
           │
           ├── PRODUCT PRICES
           ├── PRODUCT BARCODES
           ├── INVENTORY
           └── INVENTORY BATCHES

SUPPLIER
   │
   └── PURCHASE ORDER
           │
           └── PURCHASE ITEMS
                   │
                   ▼
              GOODS RECEIPT
                   │
                   ▼
               INVENTORY

CUSTOMER
   │
   ├── SALES
   │      └── SALE ITEMS
   │
   └── CREDIT ACCOUNT
           │
           ├── CREDIT TRANSACTIONS
           └── PAYMENTS

SALE
   │
   ├── SALE ITEMS
   ├── DISCOUNTS
   └── PAYMENTS
```

---

# 81. Main Business Process

Complete operational workflow:

```text
                         SUPPLIER
                            │
                            ▼
                     PURCHASE ORDER
                            │
                            ▼
                      GOODS RECEIVED
                            │
                            ▼
                        INVENTORY
                            │
               ┌────────────┴────────────┐
               │                         │
               ▼                         ▼
              POS                  INVENTORY CONTROL
               │
               ▼
            CUSTOMER
               │
       ┌───────┼────────┐
       │       │        │
       ▼       ▼        ▼
      CASH   GCASH     QR PH
       │
       └──────── CREDIT
                    │
                    ▼
             CREDIT ACCOUNT
                    │
                    ▼
               COLLECTION
```

---

# 82. MVP Scope

The first release should include:

## Core

* User management
* Roles and permissions
* Product management
* Category management
* Supplier management
* Customer management
* Inventory management
* Purchasing
* POS
* Barcode scanning
* Cash payment
* GCash payment recording
* QR Ph payment recording
* Credit sales
* Credit payments
* Customer balances
* Basic discounts
* Transaction-based discounts
* Sales returns
* Stock adjustments
* Stock counting
* Low-stock alerts
* Basic reports
* Till / Cash Management (Cash In/Out)
* Cashier closing
* Audit logs
* SQLite backup
* Data export
* Data import

---

# 83. Phase 2 Features

Potential Phase 2 features:

* Batch tracking
* FEFO
* Expiry management
* Customer-specific pricing
* Advanced quantity pricing
* Supplier payables
* Advanced credit collection
* Customer statements
* Advanced profitability reports
* Payment reconciliation
* Automated notifications
* Cloud backup

---

# 84. Phase 3 Features

Potential Phase 3:

* PostgreSQL backend
* Multi-device synchronization
* Multi-branch support
* Centralized inventory
* Online ordering
* Customer portal
* Mobile inventory application
* Payment API integration
* Automated payment reconciliation
* Accounting integration
* Advanced BIR/tax functionality where required

---

# 85. Non-Functional Requirements

## Performance

Normal POS operations should generally respond within approximately:

**2 seconds or less**

under normal local-device conditions.

---

## Reliability

The system should minimize:

* Duplicate transactions
* Data corruption
* Lost transactions
* Accidental deletion
* Inventory inconsistencies

---

## Offline Availability

Core operations should remain functional without internet connectivity.

---

## Maintainability

The system should use:

* Modular architecture
* Repository/data-access abstraction
* Centralized business rules
* Versioned database migrations
* Structured logging
* Automated testing

---

# 86. Database Migration Requirements

The database schema should be designed from the beginning with PostgreSQL migration in mind.

Avoid unnecessary SQLite-specific database behavior.

Database migrations should be version-controlled.

Example:

```text
migration_001_initial_schema
migration_002_add_product_pricing
migration_003_add_customer_credit
migration_004_add_inventory_batches
```

The application should know which database schema version is currently installed.

---

# 87. Migration Strategy

When migrating to PostgreSQL:

```text
Existing SQLite
      │
      ▼
Create Full Backup
      │
      ▼
Export Data
      │
      ▼
Validate Export
      │
      ▼
Create PostgreSQL Database
      │
      ▼
Run Schema Migrations
      │
      ▼
Import Data
      │
      ▼
Validate Records
      │
      ▼
Reconcile Totals
      │
      ▼
Activate PostgreSQL
```

Validation should compare:

* Product count
* Customer count
* Supplier count
* Inventory quantity
* Sales count
* Sales totals
* Payment totals
* Credit balances
* Purchase totals

---

# 88. Future Synchronization Considerations

Although synchronization is not an MVP requirement, the system architecture should allow for future synchronization.

Potential future devices:

```text
Cashier 1
Cashier 2
Manager
Inventory Staff
Owner Mobile
```

Future centralized architecture:

```text
                  PostgreSQL
                      │
                Application API
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    Desktop        Tablet         Mobile
```

Globally unique IDs and timestamps should therefore be used from the beginning.

---

# 89. Important Scope Limitation — Official Receipts

The initial product is an internal operational system.

The system should not claim that an internally generated POS receipt is:

* An Official Receipt
* A BIR tax invoice
* A government-issued document

The system should maintain a clear distinction between:

```text
Internal Transaction Record
```

and

```text
Official / Tax Documentation
```

Any future BIR compliance implementation should be handled as a separate product requirement and validated against the applicable Philippine requirements at the time of implementation.

---

# 90. Success Criteria

The MVP will be considered successful when the store can perform the following complete workflow:

### Purchasing

```text
Create Purchase
 → Receive Products
 → Inventory Updated
```

### Retail Sale

```text
Scan Product
 → Add to Cart
 → Apply Price
 → Apply Discount
 → Receive Payment
 → Complete Sale
 → Inventory Deducted
```

### Credit Sale

```text
Select Customer
 → Check Credit Limit
 → Sell on Credit
 → Increase Customer Balance
```

### Collection

```text
Open Customer
 → View Balance
 → Record Payment
 → Reduce Balance
```

### Inventory

```text
View Stock
 → Identify Low Stock
 → Count Stock
 → Adjust Variance
```

### Reporting

```text
View Sales
 → View Payment Breakdown
 → View Inventory
 → View Credit Balances
 → View Estimated Profit
```

### Data Portability

```text
SQLite
 → Export Backup
 → Import Backup
 → Restore Successfully
```

---

# 91. Recommended Development Document Sequence

This PRD should be followed by the following documents:

```text
DOC 01 — Product Requirements Document
                ↓
DOC 02 — Complete Feature List
                ↓
DOC 03 — Business Rules
                ↓
DOC 04 — User Roles & Permissions
                ↓
DOC 05 — Business Process Flows
                ↓
DOC 06 — Sitemap / Screen List
                ↓
DOC 07 — UX / Wireframes
                ↓
DOC 08 — UI Design System
                ↓
DOC 09 — Database ERD
                ↓
DOC 10 — SQLite Database Schema
                ↓
DOC 11 — PostgreSQL Migration Specification
                ↓
DOC 12 — API Documentation
                ↓
DOC 13 — Technical Architecture
                ↓
DOC 14 — Security Requirements
                ↓
DOC 15 — Testing Plan
                ↓
DOC 16 — Deployment Plan
                ↓
DOC 17 — Backup / Restore Specification
```

---

# 92. Product Definition Summary

The final product can be summarized as:

> **A local-first, offline-capable Agrivet Store POS and Inventory Management System for managing wholesale purchasing, retail sales, inventory, animal feeds, veterinary medicines, supplements, customer credit, collections, payments, discounts, and operational reporting.**

The initial application will use **SQLite** for local storage and must provide **portable data export/import** so the system can later transition to **PostgreSQL** without requiring a complete rewrite.

The system will support:

```text
                    AGRIVET SYSTEM
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
   PURCHASING          INVENTORY             POS
       │                  │                  │
   Suppliers          Stock Control       Customers
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
                    TRANSACTIONS
                          │
             ┌────────────┼────────────┐
             │            │            │
            CASH         GCASH        QR PH
             │
             └──────── CREDIT ────────┐
                                      │
                               COLLECTIONS
                                      │
                               REPORTING
```

The primary objective is to provide the business owner with **accurate operational visibility and control**, while keeping the first version simple, offline-capable, portable, and ready for future PostgreSQL-based expansion.
