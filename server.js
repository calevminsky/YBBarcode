const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

// ----- Shopify config -----
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'yakirabella.myshopify.com';
const ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const TARGET_LOCATION_NAMES = ['Warehouse', 'Bogota', 'Teaneck Store', 'Toms River', 'Cedarhurst'];

// Helper to call Shopify Admin GraphQL
async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw new Error(`Shopify API error: ${response.status}`);
  return response.json();
}

// ----- GraphQL queries -----
// 1) Find productVariant by barcode
const SEARCH_PRODUCT_BY_BARCODE = `
  query searchProduct($query: String!) {
    productVariants(first: 10, query: $query) {
      edges {
        node {
          id
          title
          sku
          barcode
          price
          inventoryItem { id }
          product {
            id
            title
            vendor
            productType
            images(first: 1) { edges { node { url } } }
          }
        }
      }
    }
  }
`;

// 2) Get full product variants with per-location inventory
const GET_PRODUCT_VARIANTS_WITH_INVENTORY = `
  query getProductInventory($productId: ID!) {
    product(id: $productId) {
      title
      vendor
      productType
      images(first: 1) { edges { node { url } } }
      variants(first: 50) {
        edges {
          node {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            selectedOptions { name value }
            inventoryItem {
              inventoryLevels(first: 20) {
                edges {
                  node {
                    location { id name }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// 3) Upsells metafield (theme.upsell_list) supporting product refs or text list
const GET_PRODUCT_UPSELLS = `
  query getUpsells($productId: ID!) {
    product(id: $productId) {
      id
      metafield(namespace: "theme", key: "upsell_list") {
        type
        value
        references(first: 30) {
          nodes {
            __typename
            ... on Product {
              id
              title
              handle
              images(first: 1) { edges { node { url } } }
              variants(first: 1) { edges { node { price } } }
            }
          }
        }
      }
    }
  }
`;

// 4) Generic product search (used for upsells text mode)
const SEARCH_PRODUCTS = `
  query searchProducts($query: String!) {
    products(first: 30, query: $query) {
      edges {
        node {
          id
          title
          handle
          images(first: 1) { edges { node { url } } }
          variants(first: 1) { edges { node { price } } }
        }
      }
    }
  }
`;

// 5) Locations (optional: used for logging / health)
const GET_LOCATIONS = `
  query {
    locations(first: 20) {
      edges { node { id name } }
    }
  }
`;

// 6) Siblings: product metafield theme.siblings = *collection handle* (single-line text)
const GET_PRODUCT_SIBLINGS_HANDLE = `
  query getSiblingsHandle($productId: ID!) {
    product(id: $productId) {
      id
      handle
      metafield(namespace: "theme", key: "siblings") { value }
    }
  }
`;

// 7) Fetch collection products by handle
const GET_COLLECTION_PRODUCTS_BY_HANDLE = `
  query collectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
      handle
      title
      products(first: 100) {
        edges {
          node {
            id
            title
            handle
            images(first: 1) { edges { node { url } } }
            variants(first: 1) { edges { node { price } } }
          }
        }
      }
    }
  }
`;

// 8) Fallback search if collectionByHandle fails/empty
const SEARCH_PRODUCTS_FALLBACK = `
  query searchProducts($query: String!) {
    products(first: 100, query: $query) {
      edges {
        node {
          id
          title
          handle
          images(first: 1) { edges { node { url } } }
          variants(first: 1) { edges { node { price } } }
        }
      }
    }
  }
`;

// 9) Locations with fulfillment flag (for kiosk online inventory)
const GET_LOCATIONS_WITH_FULFILLMENT = `
  query {
    locations(first: 20) {
      edges { node { id name fulfillsOnlineOrders } }
    }
  }
`;

// 10) Full product for kiosk (multiple images, no vendor/sku/barcode)
const GET_PRODUCT_FOR_KIOSK = `
  query getProductForKiosk($productId: ID!) {
    product(id: $productId) {
      title
      handle
      productType
      images(first: 20) { edges { node { url altText } } }
      variants(first: 50) {
        edges {
          node {
            id
            title
            price
            compareAtPrice
            selectedOptions { name value }
            inventoryItem {
              inventoryLevels(first: 20) {
                edges {
                  node {
                    location { id name }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ----- Caches / helpers -----
let locationsCache = null;
let fulfillmentCache = { data: null, fetchedAt: 0 };
const FULFILLMENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getLocations() {
  if (!locationsCache) {
    try {
      const result = await shopifyGraphQL(GET_LOCATIONS);
      if (result.data?.locations) {
        locationsCache = result.data.locations.edges.map(edge => edge.node);
        console.log('Available locations:', locationsCache.map(l => l.name));
      }
    } catch (error) {
      console.error('Error fetching locations:', error);
      locationsCache = [];
    }
  }
  return locationsCache;
}

async function getFulfillmentLocations() {
  const now = Date.now();
  if (fulfillmentCache.data && (now - fulfillmentCache.fetchedAt) < FULFILLMENT_CACHE_TTL) {
    return fulfillmentCache.data;
  }
  try {
    const result = await shopifyGraphQL(GET_LOCATIONS_WITH_FULFILLMENT);
    const locations = (result.data?.locations?.edges || []).map(e => e.node);
    fulfillmentCache = { data: locations, fetchedAt: now };
    console.log('Fulfillment locations cached:', locations.filter(l => l.fulfillsOnlineOrders).map(l => l.name));
    return locations;
  } catch (err) {
    console.error('Error fetching fulfillment locations:', err);
    return fulfillmentCache.data || [];
  }
}

function findLocationQuantity(inventoryLevels, locationName) {
  const level = inventoryLevels.find(lvl => {
    const actual = (lvl.node.location.name || '').toLowerCase();
    const wanted = locationName.toLowerCase();
    return actual.includes(wanted) || wanted.includes(actual);
  });
  return level?.node?.quantities?.find(q => q.name === 'available')?.quantity || 0;
}

function extractSize(variant) {
  const sizeOption = variant.selectedOptions.find(opt =>
    opt.name.toLowerCase().includes('size') ||
    opt.name.toLowerCase() === 'title' ||
    opt.name === variant.selectedOptions[0]?.name
  );
  return sizeOption ? sizeOption.value : (variant.title || 'Unknown');
}

async function buildKioskProductData(productId, storeName) {
  const [productResult, fulfillmentLocations] = await Promise.all([
    shopifyGraphQL(GET_PRODUCT_FOR_KIOSK, { productId }),
    getFulfillmentLocations()
  ]);

  if (productResult.errors || !productResult?.data?.product) return null;

  const product = productResult.data.product;
  const variants = product.variants.edges.map(e => e.node);
  const onlineLocationNames = fulfillmentLocations
    .filter(l => l.fulfillsOnlineOrders)
    .map(l => l.name);

  const kioskVariants = variants.map(v => {
    const size = extractSize(v);
    const levels = v.inventoryItem.inventoryLevels.edges;
    const storeQty = findLocationQuantity(levels, storeName);

    // Sum inventory across all online fulfillment locations
    let onlineQty = 0;
    onlineLocationNames.forEach(locName => {
      onlineQty += findLocationQuantity(levels, locName);
    });

    return { size, price: v.price, compareAtPrice: v.compareAtPrice, storeQuantity: storeQty, onlineQuantity: onlineQty };
  });

  // Upsells & siblings (parallel)
  const [upsellsRaw, siblingsRaw] = await Promise.all([
    getUpsellProducts(productId),
    getSiblingsFromCollectionHandleMetafield(productId)
  ]);

  // Attach store-specific per-size inventory to upsells/siblings
  async function attachKioskInventory(products) {
    const unique = [];
    const seen = new Set();
    for (const p of products) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      unique.push(p);
    }
    return Promise.all(unique.map(async (p) => {
      const prodResult = await shopifyGraphQL(GET_PRODUCT_FOR_KIOSK, { productId: p.id });
      const prodData = prodResult?.data?.product;
      let storeTotal = 0;
      let sizeInventory = [];
      if (prodData) {
        const pvariants = prodData.variants.edges.map(e => e.node);
        sizeInventory = pvariants.map(v => {
          const size = extractSize(v);
          const levels = v.inventoryItem.inventoryLevels.edges;
          const storeQty = findLocationQuantity(levels, storeName);
          storeTotal += storeQty;
          return { size, storeQuantity: storeQty };
        });
      }
      return { id: p.id, title: p.title, handle: p.handle, image: p.image, price: p.price, storeTotal, sizeInventory };
    }));
  }

  const [upsells, siblings] = await Promise.all([
    attachKioskInventory(upsellsRaw),
    attachKioskInventory(siblingsRaw)
  ]);

  return {
    title: product.title,
    handle: product.handle,
    productId,
    images: product.images.edges.map(e => e.node.url),
    variants: kioskVariants,
    upsells,
    siblings
  };
}

async function getUpsellProducts(productId) {
  try {
    const result = await shopifyGraphQL(GET_PRODUCT_UPSELLS, { productId });
    const mf = result?.data?.product?.metafield;
    if (!mf) return [];

    // Case 1: metafield holds product references
    const refs = mf.references?.nodes?.filter(n => n?.__typename === "Product") || [];
    if (refs.length) {
      return refs.map(p => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        image: p.images?.edges?.[0]?.node?.url || 'https://via.placeholder.com/150',
        price: p.variants?.edges?.[0]?.node?.price || null
      }));
    }

    // Case 2: metafield holds text (handles or titles)
    const raw = (mf.value || "").trim();
    if (!raw) return [];
    const tokens = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (!tokens.length) return [];

    const handlePart = tokens.map(t => `handle:${t}`).join(" OR ");
    const titlePart  = tokens.map(t => `title:"${t.replace(/"/g, '\\"')}"`).join(" OR ");
    const query = `(${handlePart}) OR (${titlePart})`;

    const search = await shopifyGraphQL(SEARCH_PRODUCTS, { query });
    const nodes = search?.data?.products?.edges?.map(e => e.node) || [];
    return nodes.map(p => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      image: p.images?.edges?.[0]?.node?.url || 'https://via.placeholder.com/150',
      price: p.variants?.edges?.[0]?.node?.price || null
    }));
  } catch (err) {
    console.error("getUpsellProducts error:", err);
    return [];
  }
}

function escapeSearchTerm(value = '') {
  return String(value).replace(/"/g, '\\"').trim();
}

async function getProductInventorySummary(productId, targetLocationNames = TARGET_LOCATION_NAMES) {
  if (!productId) return null;
  try {
    const productResult = await shopifyGraphQL(GET_PRODUCT_VARIANTS_WITH_INVENTORY, { productId });
    if (productResult.errors || !productResult?.data?.product?.variants?.edges) {
      return null;
    }

    const variants = productResult.data.product.variants.edges.map(edge => edge.node);
    const totals = Object.fromEntries(targetLocationNames.map(location => [location, 0]));

    variants.forEach(v => {
      const levels = v?.inventoryItem?.inventoryLevels?.edges || [];
      targetLocationNames.forEach(locationName => {
        const level = levels.find(lvl => {
          const actual = (lvl.node.location.name || '').toLowerCase();
          const wanted = locationName.toLowerCase();
          return actual.includes(wanted) || wanted.includes(actual);
        });
        const qtyEntry = level?.node?.quantities?.find(q => q.name === 'available');
        totals[locationName] += qtyEntry?.quantity || 0;
      });
    });

    const inventory = targetLocationNames.map(location => ({
      location,
      quantity: totals[location]
    }));

    return {
      inventory,
      totalAvailable: inventory.reduce((sum, row) => sum + row.quantity, 0)
    };
  } catch (err) {
    console.error('getProductInventorySummary error:', err);
    return null;
  }
}

async function attachInventoryToProducts(products = [], targetLocationNames = TARGET_LOCATION_NAMES) {
  const uniqueById = [];
  const seen = new Set();
  for (const item of products) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    uniqueById.push(item);
  }

  return Promise.all(uniqueById.map(async (product) => ({
    ...product,
    inventorySummary: await getProductInventorySummary(product.id, targetLocationNames)
  })));
}

// Siblings from product metafield theme.siblings (collection handle)
async function getSiblingsFromCollectionHandleMetafield(productId) {
  try {
    // a) Read metafield value from product
    const r1 = await shopifyGraphQL(GET_PRODUCT_SIBLINGS_HANDLE, { productId });
    const prod = r1?.data?.product;
    const currentHandle = prod?.handle;
    let colHandle = (prod?.metafield?.value || "").trim();

    if (!colHandle) {
      console.warn("theme.siblings metafield empty");
      return [];
    }

    // Allow full URL in metafield; extract last path segment
    try {
      if (colHandle.includes('http')) {
        const u = new URL(colHandle);
        const parts = u.pathname.split('/').filter(Boolean);
        colHandle = parts[parts.length - 1] || colHandle;
      }
    } catch (_) { /* ignore */ }

    // b) Try collectionByHandle
    let nodes = [];
    try {
      const r2 = await shopifyGraphQL(GET_COLLECTION_PRODUCTS_BY_HANDLE, { handle: colHandle });
      nodes = r2?.data?.collectionByHandle?.products?.edges?.map(e => e.node) || [];
    } catch (e) {
      console.warn("collectionByHandle failed:", e?.message || e);
    }

    // c) Fallback if needed: search by collection handle/title
    if (!nodes.length) {
      const qParts = [
        `collection_handle:${colHandle}`,
        `collection_title:"${colHandle.replace(/"/g, '\\"')}"`
      ];
      const r3 = await shopifyGraphQL(SEARCH_PRODUCTS_FALLBACK, { query: qParts.join(' OR ') });
      nodes = r3?.data?.products?.edges?.map(e => e.node) || [];
    }

    // d) Normalize, exclude current product, dedupe
    const seen = new Set();
    const siblings = [];
    for (const p of nodes) {
      if (!p || p.handle === currentHandle) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      siblings.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        image: p.images?.edges?.[0]?.node?.url || 'https://via.placeholder.com/150',
        price: p.variants?.edges?.[0]?.node?.price || null
      });
    }
    return siblings;
  } catch (err) {
    console.error("getSiblingsFromCollectionHandleMetafield error:", err);
    return [];
  }
}

// ----- Routes -----

// Search autocomplete: returns list of products matching a query
app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    const escaped = escapeSearchTerm(q);
    const query = `title:*${escaped}*`;
    const result = await shopifyGraphQL(SEARCH_PRODUCTS, { query });
    const products = (result?.data?.products?.edges || []).map(e => {
      const p = e.node;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        image: p.images?.edges?.[0]?.node?.url || null
      };
    });
    res.json(products);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Full inventory matrix for a product by Shopify product ID
app.get('/product-inventory/:productId', async (req, res) => {
  try {
    const rawId = req.params.productId;
    const productId = rawId.startsWith('gid://') ? rawId : `gid://shopify/Product/${rawId}`;

    const productResult = await shopifyGraphQL(GET_PRODUCT_VARIANTS_WITH_INVENTORY, { productId });
    if (productResult.errors || !productResult?.data?.product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.data.product;
    const productVariants = product.variants.edges.map(edge => edge.node);
    const targetLocationNames = TARGET_LOCATION_NAMES;

    const inventoryMatrix = productVariants.map(v => {
      const sizeOption = v.selectedOptions.find(opt =>
        opt.name.toLowerCase().includes('size') ||
        opt.name.toLowerCase() === 'title' ||
        opt.name === v.selectedOptions[0]?.name
      );
      const size = sizeOption ? sizeOption.value : (v.title || 'Unknown');
      const inventoryLevels = v.inventoryItem.inventoryLevels.edges;
      const quantities = targetLocationNames.map(locationName => {
        const level = inventoryLevels.find(lvl => {
          const actual = (lvl.node.location.name || '').toLowerCase();
          const wanted = locationName.toLowerCase();
          return actual.includes(wanted) || wanted.includes(actual);
        });
        const qtyEntry = level?.node?.quantities?.find(q => q.name === 'available');
        return { location: locationName, quantity: qtyEntry?.quantity || 0 };
      });

      return {
        variantTitle: v.title,
        size,
        sku: v.sku,
        barcode: v.barcode,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        inventory: quantities
      };
    });

    res.json({
      title: product.title,
      productId,
      variants: inventoryMatrix
    });
  } catch (err) {
    console.error('Product inventory error:', err);
    res.status(500).json({ error: 'Failed to load product inventory' });
  }
});

app.post('/lookup', async (req, res) => {
  try {
    const rawSearch = req.body.barcode || req.body.query || req.body.term;
    const rawProductId = req.body.productId; // direct product ID from search dropdown
    const searchTerm = rawSearch?.trim();
    if (!searchTerm && !rawProductId) return res.status(400).json({ error: 'Barcode or product lookup text is required' });

    let productId;
    let scannedVariantId = null;
    let scannedVariantBarcode = null;
    let image = 'https://via.placeholder.com/150';
    let productTitle, productVendor, productType;

    if (rawProductId) {
      // Direct product ID lookup (from search dropdown) - skip search phase
      productId = rawProductId.startsWith('gid://') ? rawProductId : `gid://shopify/Product/${rawProductId}`;
      console.log(`Direct product lookup: ${productId}`);
    } else {
      const escaped = escapeSearchTerm(searchTerm);

      console.log(`Looking up term: ${searchTerm}`);
      const queriesToTry = [
        `barcode:"${escaped}"`,
        `barcode:${escaped}`,
        `sku:"${escaped}"`,
        `sku:${escaped}`,
        `title:*${escaped}*`,
        escaped
      ];
      let variants = [];

      for (const queryStr of queriesToTry) {
        console.log(`Trying variant query: ${queryStr}`);
        const result = await shopifyGraphQL(SEARCH_PRODUCT_BY_BARCODE, { query: queryStr });
        if (result.errors) {
          console.error('GraphQL errors:', result.errors);
          continue;
        }
        variants = result.data.productVariants.edges;
        if (variants.length > 0) break;
      }

      if (variants.length === 0) {
        console.log(`No variant found for lookup term: ${searchTerm}`);
        return res.status(404).json({ error: 'Product not found' });
      }

      const variant = variants[0].node;
      const product = variant.product;
      productId = product.id;
      scannedVariantId = variant.id;
      scannedVariantBarcode = variant.barcode;
      image = product.images.edges.length > 0 ? product.images.edges[0].node.url : image;
    }

    // Full product inventory by variant/location
    const productResult = await shopifyGraphQL(GET_PRODUCT_VARIANTS_WITH_INVENTORY, { productId });
    if (productResult.errors || !productResult?.data?.product) {
      console.error('GraphQL error loading full product:', productResult.errors);
      return res.status(500).json({ error: 'Failed to load product inventory' });
    }

    const fullProduct = productResult.data.product;
    const productVariants = fullProduct.variants.edges.map(edge => edge.node);

    // For direct productId lookups, get image from full product data
    if (rawProductId) {
      image = fullProduct.images?.edges?.[0]?.node?.url || image;
    }

    // Stores to show (adjust names as you like)
    const targetLocationNames = TARGET_LOCATION_NAMES;

    const inventoryMatrix = productVariants.map(v => {
      // Extract size from selectedOptions (prefer the "Size" option)
      const sizeOption = v.selectedOptions.find(opt =>
        opt.name.toLowerCase().includes('size') ||
        opt.name.toLowerCase() === 'title' ||
        opt.name === v.selectedOptions[0]?.name
      );
      const size = sizeOption ? sizeOption.value : (v.title || 'Unknown');

      const inventoryLevels = v.inventoryItem.inventoryLevels.edges;

      const quantities = targetLocationNames.map(locationName => {
        const level = inventoryLevels.find(lvl => {
          const actual = (lvl.node.location.name || '').toLowerCase();
          const wanted = locationName.toLowerCase();
          return actual.includes(wanted) || wanted.includes(actual);
        });
        const qtyEntry = level?.node?.quantities?.find(q => q.name === 'available');
        return { location: locationName, quantity: qtyEntry?.quantity || 0 };
      });

      return {
        variantTitle: v.title,
        size,
        sku: v.sku,
        barcode: v.barcode,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        inventory: quantities
      };
    });

    // Upsells & Siblings
    const upsellsRaw  = await getUpsellProducts(productId);
    const siblingsRaw = await getSiblingsFromCollectionHandleMetafield(productId);
    const [upsells, siblings] = await Promise.all([
      attachInventoryToProducts(upsellsRaw, targetLocationNames),
      attachInventoryToProducts(siblingsRaw, targetLocationNames)
    ]);

    // Response
    const response = {
      title: fullProduct.title,
      image,
      vendor: fullProduct.vendor || '',
      productType: fullProduct.productType || '',
      productId,
      variants: inventoryMatrix,
      upsells,
      siblings,
      scannedVariantId,
      scannedVariantBarcode
    };

    res.json(response);
  } catch (error) {
    console.error('Error in /lookup:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/locations', async (req, res) => {
  try {
    const locations = await getLocations();
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching locations' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/debug', async (req, res) => {
  try {
    const query = `
      query {
        productVariants(first: 5) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              selectedOptions { name value }
              product { title }
            }
          }
        }
      }
    `;
    const result = await shopifyGraphQL(query);
    res.json({
      status: 'GraphQL working',
      variants: result.data.productVariants.edges.map(edge => ({
        product_title: edge.node.product.title,
        variant_title: edge.node.title,
        barcode: edge.node.barcode,
        sku: edge.node.sku,
        price: edge.node.price,
        options: edge.node.selectedOptions
      }))
    });
  } catch (error) {
    res.json({ status: 'GraphQL error', error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// NEW: dedicated returns page
app.get('/returns', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'returns.html'));
});

// ----- Kiosk (customer-facing store view) -----
const kioskLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });
app.use('/kiosk', kioskLimiter);

// Kiosk search: active products only, newest first
const KIOSK_SEARCH_PRODUCTS = `
  query searchProducts($query: String!) {
    products(first: 30, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          images(first: 1) { edges { node { url } } }
        }
      }
    }
  }
`;

app.get('/kiosk/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    const escaped = escapeSearchTerm(q);
    const query = `title:*${escaped}* AND status:active`;
    const result = await shopifyGraphQL(KIOSK_SEARCH_PRODUCTS, { query });
    const products = (result?.data?.products?.edges || []).map(e => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      image: e.node.images?.edges?.[0]?.node?.url || null
    }));
    res.json(products);
  } catch (err) {
    console.error('Kiosk search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/kiosk/lookup', async (req, res) => {
  try {
    const store = (req.body.store || '').trim();
    if (!store) return res.status(400).json({ error: 'Store name is required' });

    const rawSearch = req.body.barcode || req.body.query;
    const rawProductId = req.body.productId;
    const searchTerm = rawSearch?.trim();
    if (!searchTerm && !rawProductId) return res.status(400).json({ error: 'Barcode or search term required' });

    let productId;
    if (rawProductId) {
      productId = rawProductId.startsWith('gid://') ? rawProductId : `gid://shopify/Product/${rawProductId}`;
    } else {
      const escaped = escapeSearchTerm(searchTerm);
      const queriesToTry = [
        `barcode:"${escaped}"`, `barcode:${escaped}`,
        `sku:"${escaped}"`, `sku:${escaped}`,
        `title:*${escaped}*`, escaped
      ];
      let variants = [];
      for (const queryStr of queriesToTry) {
        const result = await shopifyGraphQL(SEARCH_PRODUCT_BY_BARCODE, { query: queryStr });
        if (result.errors) continue;
        variants = result.data.productVariants.edges;
        if (variants.length > 0) break;
      }
      if (!variants.length) return res.status(404).json({ error: 'Product not found' });
      productId = variants[0].node.product.id;
    }

    const data = await buildKioskProductData(productId, store);
    if (!data) return res.status(500).json({ error: 'Failed to load product' });
    res.json(data);
  } catch (err) {
    console.error('Kiosk lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/kiosk/product/:productId', async (req, res) => {
  try {
    const store = (req.query.store || '').trim();
    if (!store) return res.status(400).json({ error: 'Store name is required' });
    const rawId = req.params.productId;
    const productId = rawId.startsWith('gid://') ? rawId : `gid://shopify/Product/${rawId}`;
    const data = await buildKioskProductData(productId, store);
    if (!data) return res.status(404).json({ error: 'Product not found' });
    res.json(data);
  } catch (err) {
    console.error('Kiosk product error:', err);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

app.get('/store/:storeName', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});
app.get('/store', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// ----- Start -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shopify store: ${SHOPIFY_STORE}`);
});
