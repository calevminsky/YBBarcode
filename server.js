// Updated backend code using Shopify REST API for inventory
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Your Shopify credentials
const SHOPIFY_STORE = 'yakirabella.myshopify.com';
const ACCESS_TOKEN = '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';

// Function to make REST API request to Shopify
async function shopifyREST(endpoint) {
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-01/${endpoint}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    }
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status}`);
  }

  return response.json();
}

// Get locations first (to map location IDs to names)
let locationsCache = null;

async function getLocations() {
  if (!locationsCache) {
    try {
      const data = await shopifyREST('locations.json');
      locationsCache = data.locations;
      console.log('Available locations:', locationsCache.map(l => l.name));
    } catch (error) {
      console.error('Error fetching locations:', error);
      locationsCache = [];
    }
  }
  return locationsCache;
}

// Function to get inventory levels for a specific inventory item
async function getInventoryLevels(inventoryItemId) {
  try {
    const data = await shopifyREST(`inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
    return data.inventory_levels || [];
  } catch (error) {
    console.error('Error fetching inventory levels:', error);
    return [];
  }
}

// Function to find product variant by barcode
async function findProductByBarcode(barcode) {
  try {
    // Search for products (REST API doesn't directly search by barcode)
    // We'll need to get products and check variants
    let allVariants = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 5) { // Limit to 5 pages to avoid timeout
      const data = await shopifyREST(`products.json?limit=250&page=${page}&fields=id,title,vendor,product_type,image,variants`);
      
      if (data.products && data.products.length > 0) {
        // Extract all variants from all products
        data.products.forEach(product => {
          if (product.variants) {
            product.variants.forEach(variant => {
              allVariants.push({
                ...variant,
                product_title: product.title,
                product_vendor: product.vendor,
                product_type: product.product_type,
                product_image: product.image ? product.image.src : null
              });
            });
          }
        });
        page++;
      } else {
        hasMore = false;
      }
    }

    // Find variant with matching barcode
    const matchingVariant = allVariants.find(variant => 
      variant.barcode === barcode || 
      variant.sku === barcode ||
      variant.id.toString() === barcode
    );

    return matchingVariant;
  } catch (error) {
    console.error('Error finding product by barcode:', error);
    return null;
  }
}

// Main lookup endpoint
app.post('/lookup', async (req, res) => {
  try {
    const { barcode } = req.body;

    if (!barcode) {
      return res.status(400).json({ error: 'Barcode is required' });
    }

    console.log(`Looking up barcode: ${barcode}`);

    // Find product variant by barcode
    const variant = await findProductByBarcode(barcode);
    
    if (!variant) {
      return res.status(404).json({ error: 'Product not found' });
    }

    console.log(`Found variant: ${variant.product_title} - ${variant.title}`);

    // Get locations
    const locations = await getLocations();
    
    // Get inventory levels for this variant
    const inventoryLevels = await getInventoryLevels(variant.inventory_item_id);
    
    // Your target locations
    const targetLocationNames = ['Bogota', 'Teaneck Store', 'Toms River', 'Cedarhurst'];
    
    // Format inventory data
    const locationInventory = targetLocationNames.map(targetName => {
      // Find matching location
      const location = locations.find(loc => 
        loc.name.toLowerCase().includes(targetName.toLowerCase()) ||
        targetName.toLowerCase().includes(loc.name.toLowerCase())
      );
      
      let quantity = 0;
      
      if (location) {
        // Find inventory level for this location
        const inventoryLevel = inventoryLevels.find(level => 
          level.location_id === location.id
        );
        
        if (inventoryLevel) {
          quantity = inventoryLevel.available || 0;
        }
      }
      
      return {
        name: targetName,
        quantity: quantity
      };
    });

    // Prepare response
    const response = {
      title: variant.product_title,
      image: variant.product_image || 'https://via.placeholder.com/150',
      price: variant.price,
      sku: variant.sku,
      barcode: variant.barcode,
      vendor: variant.product_vendor,
      productType: variant.product_type,
      inventory: {
        locations: locationInventory
      }
    };

    console.log('Inventory by location:', locationInventory);

    res.json(response);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Debug endpoint to see all locations
app.get('/locations', async (req, res) => {
  try {
    const locations = await getLocations();
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching locations' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

// Serve the frontend HTML file
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shopify store: ${SHOPIFY_STORE}`);
  console.log('Visit /locations to see available locations');
});

module.exports = app;
