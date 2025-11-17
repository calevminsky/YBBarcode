const express = require('express');
const cors = require('cors');
const app = express();
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

// ----- Shopify config -----
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'yakirabella.myshopify.com';
const ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;

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

// ----- Caches / helpers -----
let locationsCache = null;

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
app.post('/lookup', async (req, res) => {
  try {
    const rawBarcode = req.body.barcode;
    const barcode = rawBarcode?.trim();
    if (!barcode) return res.status(400).json({ error: 'Barcode is required' });

    console.log(`Looking up barcode: ${barcode}`);
    const queriesToTry = [`barcode:"${barcode}"`, `barcode:${barcode}`, barcode];
    let variants = [];

    for (const queryStr of queriesToTry) {
      console.log(`Trying query: ${queryStr}`);
      const result = await shopifyGraphQL(SEARCH_PRODUCT_BY_BARCODE, { query: queryStr });
      if (result.errors) {
        console.error('GraphQL errors:', result.errors);
        continue;
      }
      variants = result.data.productVariants.edges;
      if (variants.length > 0) break;
    }

    if (variants.length === 0) {
      console.log(`No variant found for barcode: ${barcode}`);
      return res.status(404).json({ error: 'Product not found' });
    }

    const variant = variants[0].node;
    const product = variant.product;
    const productId = product.id;

    const image = product.images.edges.length > 0
      ? product.images.edges[0].node.url
      : 'https://via.placeholder.com/150';

    // Full product inventory by variant/location
    const productResult = await shopifyGraphQL(GET_PRODUCT_VARIANTS_WITH_INVENTORY, { productId });
    if (productResult.errors) {
      console.error('GraphQL error loading full product:', productResult.errors);
      return res.status(500).json({ error: 'Failed to load product inventory' });
    }

    const productVariants = productResult.data.product.variants.edges.map(edge => edge.node);

    // Stores to show (adjust names as you like)
    const targetLocationNames = ['Bogota', 'Teaneck Store', 'Toms River', 'Cedarhurst'];

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
    const upsells  = await getUpsellProducts(productId);
    const siblings = await getSiblingsFromCollectionHandleMetafield(productId);

    // Response
    const response = {
      title: product.title,
      image,
      vendor: product.vendor,
      productType: product.productType,
      productId: product.id,
      variants: inventoryMatrix,
      upsells,
      siblings
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

// ----- Start -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shopify store: ${SHOPIFY_STORE}`);
});
