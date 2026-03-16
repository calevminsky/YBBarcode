# Store Kiosk View - Implementation Plan

Customer-facing iPad kiosk for each retail store. Completely separate from existing internal views (Inventory, Stores, Matching, Returns, Client all stay untouched).

---

## Phase 1: Backend - Fulfillment Locations & Enhanced Data

### 1a. Add fulfillment locations cache (`server.js`)
- New GraphQL query `GET_LOCATIONS_WITH_FULFILLMENT` that fetches `fulfillsOnlineOrders` flag per location
- New cache `fulfillmentLocationsCache` with a `lastFetched` timestamp, refreshes every 24 hours
- New helper `getOnlineFulfillmentLocations()` returns array of location names where `fulfillsOnlineOrders === true`
- New endpoint `GET /api/fulfillment-locations` returns the cached list

### 1b. Modify product queries for multiple images
- Update `GET_PRODUCT_VARIANTS_WITH_INVENTORY` to fetch `images(first: 10)` instead of `images(first: 1)` — this change is safe since existing code only uses `edges[0]`
- Also update `SEARCH_PRODUCT_BY_BARCODE` to fetch `images(first: 10)` on the product

### 1c. New kiosk-specific lookup endpoint
- New endpoint `POST /kiosk/lookup` that:
  - Accepts `{ barcode, query, productId, store }`
  - Returns sanitized data (no SKU, no barcode, no vendor in response)
  - Returns ALL product images (not just first)
  - Returns product `handle` for "View Online" link
  - Returns inventory split into: `storeInventory` (just this store, per-size) and `onlineInventory` (sum of fulfillment locations, per-size)
  - Returns upsells & siblings with same store/online inventory split
  - Returns siblings from the sibling collection

### 1d. New kiosk product-detail endpoint
- `GET /kiosk/product/:productId?store=StoreName` — for when user clicks a match/sibling in the kiosk
  - Returns same structure as kiosk lookup but for a specific product
  - This is what the "product title links to product in the webapp" requirement maps to

### 1e. Serve the kiosk HTML
- `GET /store` and `GET /store/:storeName` — serve `public/kiosk.html`

---

## Phase 2: Frontend - Kiosk HTML (`public/kiosk.html`)

New standalone HTML file (like `returns.html` is separate from `index.html`). Does NOT touch `index.html`.

### 2a. Store Selection Screen
- Shown on first visit or if no store saved in localStorage
- Clean, full-screen grid of store buttons (Teaneck Store, Toms River, Cedarhurst)
  - Only show retail stores, not Warehouse/Bogota
- On selection: save `{ store, date }` to localStorage, redirect to `/store/storename`
- On return visit same day: auto-load saved store, skip selector
- Next day: clear localStorage, show selector again
- No view toggle, no way to switch to other internal modes

### 2b. Kiosk Home Screen (idle state)
- Store name displayed in header
- Large, prominent search bar (centered)
- Large "Scan Barcode" button below (full-width, tall, touch-friendly)
- Clean branding — "Yakira Bella" with store name
- This is what the kiosk returns to after idle timeout

### 2c. Product Detail (PDP-style)
When a product is looked up:

**Image Carousel:**
- Large product images, swipeable left/right on iPad
- Dot indicators below showing current image
- Touch/swipe support via simple CSS scroll-snap (no library needed)

**Product Info:**
- Product title (large, tappable — links to same product within the kiosk app: `/store/storename?product=PRODUCT_ID`)
- Price with sale price strikethrough if applicable
- "View Online" button linking to `https://yakirabella.com/products/{handle}`

**Store Availability (primary):**
- Section: "Available in {Store Name}"
- Grid/list of sizes with stock status for THIS store only
- Each size shows: size label + quantity (color-coded: green=in stock, red=out of stock)
- Clear visual: checkmark for in-stock, X for out-of-stock, with quantity

**Online Availability (expandable):**
- Collapsed by default: "Available Online" with total count
- On expand: shows per-size online availability (sum of fulfillment locations)

**Siblings ("Other Colors"):**
- Horizontal scrollable row of product cards
- Each card: image, title, price
- Tapping a sibling navigates to that product's PDP within the kiosk

**Matches ("Goes Well With"):**
- Grid of matching product cards below siblings
- Each card: image, title, price, store availability (in-stock/out-of-stock badge)
- Tapping a match navigates to that product's PDP within the kiosk
- Same expandable online availability

### 2d. Idle Timeout & Reset
- After 2 minutes of no interaction (no touch, no scan), reset to home screen
- Fade-to-home animation
- Clear any product display
- Refocus on search/scan

### 2e. PWA Support
- Add `manifest.json` with app name, icons, `display: standalone`
- Meta tags for iOS standalone mode (`apple-mobile-web-app-capable`, status bar style)
- This removes browser chrome when "Added to Home Screen" on iPad

---

## Phase 3: Kiosk CSS & iPad UX

### 3a. Design System
- Large font sizes (base 18px+ for readability)
- Minimum touch target size: 48px height
- Generous padding and spacing
- Clean color palette: white background, brand accent color for CTAs
- Card-based layouts with subtle shadows
- No hover states (touch only) — use active/pressed states instead

### 3b. Responsive Layout
- Optimized for iPad landscape (1024x768) and portrait (768x1024)
- CSS Grid for product cards
- Flexbox for size availability grid
- Full-width on tablet, centered on larger screens

### 3c. Image Carousel
- CSS scroll-snap for native-feeling swipe
- `overflow-x: scroll; scroll-snap-type: x mandatory;` on container
- Each image as `scroll-snap-align: center; width: 100%;`
- No JavaScript library needed

---

## Phase 4: Security & Rate Limiting

### 4a. Kiosk endpoint sanitization
- `/kiosk/lookup` and `/kiosk/product/:id` strip: SKU, barcode, vendor, productType from response
- No access to `/debug`, `/locations`, or internal `/lookup` from kiosk context (handled by kiosk using its own endpoints)

### 4b. Basic rate limiting
- Simple in-memory rate limiter on kiosk endpoints
- 30 requests per minute per IP (generous enough for normal use, blocks abuse)

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `server.js` | Modify | Add fulfillment cache, kiosk endpoints, multi-image queries |
| `public/kiosk.html` | Create | Full kiosk UI (HTML + CSS + JS, self-contained like index.html) |
| `public/manifest.json` | Create | PWA manifest for standalone iPad mode |

**Files NOT touched:** `public/index.html`, `public/returns.html` — all existing functionality remains identical.

---

## Implementation Order

1. Backend: fulfillment locations cache + query
2. Backend: update image queries to fetch multiple
3. Backend: kiosk lookup + product endpoints
4. Backend: serve kiosk HTML + rate limiting
5. Frontend: store selector + persistence
6. Frontend: home screen + barcode scanner integration
7. Frontend: PDP layout (carousel, sizing grid, pricing)
8. Frontend: store inventory + online inventory (expandable)
9. Frontend: siblings row + matches grid
10. Frontend: in-app navigation (clicking products stays in kiosk)
11. Frontend: idle timeout + reset
12. PWA manifest + iOS meta tags
13. Testing & polish
