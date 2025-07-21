// Updated backend using Shopify GraphQL API
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Your Shopify credentials
const SHOPIFY_STORE = 'yakirabella.myshopify.com';
const ACCESS_TOKEN = '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';

// Function to make GraphQL request to Shopify
async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status}`);
  }

  return response.json();
}

// GraphQL query to search for product by barcode
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
          inventoryItem {
            id
            inventoryLevels(first: 20) {
              edges {
                node {
                  location {
                    id
                    name
                  }
                  quantities {
                    name
                    quantity
                  }
                }
              }
            }
          }
          product {
            id
            title
            vendor
            productType
            images(first: 1) {
              edges {
                node {
                  url
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Get locations query
const GET_LOCATIONS = `
  query {
    locations(first: 20) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

// Cache locations
let locationsCache = null;

async function getLocations() {
  if (!locationsCache) {
    try {
      const result = await shopifyGraphQL(GET_LOCATIONS);
      if (result.data && result.data.locations) {
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

app.post('/lookup', async (req, res) => {
  try {
    const rawBarcode = req.body.barcode;
    const barcode = rawBarcode?.trim();

    if (!barcode) {
      return res.status(400).json({ error: 'Barcode is required' });
    }

    console.log(`Looking up barcode: ${barcode}`);

    const queriesToTry = [
      `barcode:"${barcode}"`,
      `barcode:${barcode}`,
      barcode
    ];

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

    const image = product.images.edges.length > 0
      ? product.images.edges[0].node.url
      : 'https://via.placeholder.com/150';

    const targetLocationNames = ['Bogota', 'Teaneck Store', 'Toms River', 'Cedarhurst'];
    const inventoryLevels = variant.inventoryItem.inventoryLevels.edges;

    const locationInventory = targetLocationNames.map(targetName => {
      const inventoryLevel = inventoryLevels.find(level => {
        const locationName = level.node.location.name;
        return locationName.toLowerCase().includes(targetName.toLowerCase()) ||
               targetName.toLowerCase().includes(locationName.toLowerCase());
      });

      const quantityEntry = inventoryLevel?.node?.quantities?.find(q => q.name === 'available');
      const quantity = quantityEntry ? quantityEntry.quantity : 0;

      return {
        name: targetName,
        quantity: quantity
      };
    });

    const response = {
      title: product.title,
      image: image,
      price: variant.price,
      sku: variant.sku,
      barcode: variant.barcode,
      vendor: product.vendor,
      productType: product.productType,
      inventory: {
        locations: locationInventory
      }
    };

    console.log('Inventory by location:', locationInventory);

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
              product {
                title
              }
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
        price: edge.node.price
      }))
    });
  } catch (error) {
    res.json({
      status: 'GraphQL error',
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shopify store: ${SHOPIFY_STORE}`);
});

module.exports = app;
